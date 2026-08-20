import type {
	CatalogV2MaterializedMemo,
	CatalogV2MaterializedState,
	CatalogV2StateAttention,
	IdentityEvidence,
	StateOperationEnvelope,
} from "../types/catalogV2";
import { canonicalJson, compareText } from "./CatalogV2Protocol";

interface MutableMemoState {
	identityOperationIds: Set<string>;
	identityBindings: Map<string, CatalogV2MaterializedMemo["identityBindings"][number]>;
	deleteOperationIds: Set<string>;
	deleteVersions: Map<string, CatalogV2MaterializedMemo["deleteVersions"][number]>;
	restoreVersions: Map<string, CatalogV2MaterializedMemo["restoreVersions"][number]>;
	restoredDeleteOperationIds: Set<string>;
	purgedDeleteOperationIds: Set<string>;
	relations: Map<string, string | null>;
	supersededRelationIds: Set<string>;
	reviewOperationIds: Set<string>;
	reviewedAt: string[];
	pendingCreateIntents: Map<string, CatalogV2MaterializedMemo["pendingCreateIntents"][number]>;
	redirectTargets: Map<string, string>;
	deleteBaseOperationIds: Map<string, Set<string>>;
	rebindBaseOperationIds: Map<string, Set<string>>;
	restoreEvidenceOperationIds: Map<string, Map<string, Set<string>>>;
}

export class CatalogV2StateReducer {
	async reduce(envelopes: readonly StateOperationEnvelope[]): Promise<CatalogV2MaterializedState> {
		const quarantine: CatalogV2StateAttention[] = [];
		const forkedWriterIds = new Set<string>();
		const rejectedDigests = new Set<string>();
		const byOpId = groupBy(envelopes, (item) => item.operation.opId);
		for (const [opId, items] of byOpId) {
			const digests = uniqueSorted(items.map((item) => item.digest));
			if (digests.length <= 1) continue;
			quarantine.push({ code: "op_id_collision", key: opId, digests });
			for (const item of items) rejectedDigests.add(item.digest);
		}

		const candidates = dedupeEnvelopes(envelopes);
		const byWriterSequence = groupBy(candidates, (item) => `${item.operation.writerId}\u0000${item.operation.sequence}`);
		for (const [key, items] of byWriterSequence) {
			const digests = uniqueSorted(items.map((item) => item.digest));
			if (digests.length <= 1) continue;
			quarantine.push({ code: "writer_sequence_fork", key, digests });
			forkedWriterIds.add(items[0]?.operation.writerId ?? "");
			for (const item of items) rejectedDigests.add(item.digest);
		}

		const accepted = candidates
			.filter((item) => !rejectedDigests.has(item.digest))
			.sort(compareEnvelopes);
		const awaitingWriterIds = findWritersWithSequenceGaps(candidates);
		const memos = new Map<string, MutableMemoState>();
		const abandonedCreateIds = new Map<string, Set<string>>();
		for (const item of accepted) {
			const operation = item.operation;
			const memo = getMutableMemo(memos, operation.memoId);
			switch (operation.type) {
				case "identity.claim":
					memo.identityOperationIds.add(operation.opId);
					memo.identityBindings.set(operation.opId, {
						entryId: operation.opId,
						source: "state",
						evidence: operation.payload.evidence,
						baseBindingId: null,
						baseEvidence: null,
					});
					break;
				case "identity.rebind":
					memo.identityOperationIds.add(operation.opId);
					memo.identityBindings.set(operation.opId, {
						entryId: operation.opId,
						source: "state",
						evidence: operation.payload.evidence,
						baseBindingId: operation.payload.baseBindingId,
						baseEvidence: operation.baseEvidence,
					});
					if (operation.payload.reason !== "restore") {
						getStringSet(memo.rebindBaseOperationIds, evidenceKey(operation.baseEvidence)).add(operation.opId);
					}
					break;
				case "identity.redirect":
					memo.redirectTargets.set(operation.opId, operation.payload.toMemoId);
					break;
				case "lifecycle.create_intent":
					memo.pendingCreateIntents.set(operation.opId, {
						entryId: operation.opId,
						evidence: operation.payload.evidence,
						sourceMemoId: operation.payload.sourceMemoId,
					});
					break;
				case "lifecycle.create_abandon":
					getStringSet(abandonedCreateIds, operation.memoId).add(operation.payload.createIntentOpId);
					break;
				case "lifecycle.delete":
					memo.deleteOperationIds.add(operation.payload.deleteOpId);
					memo.deleteVersions.set(operation.payload.deleteOpId, {
						deleteOpId: operation.payload.deleteOpId,
						entryId: operation.opId,
						payload: operation.payload.deletedPayload,
						baseEvidence: operation.baseEvidence,
						baseBindingId: operation.payload.baseBindingId,
					});
					getStringSet(memo.deleteBaseOperationIds, evidenceKey(operation.baseEvidence)).add(operation.opId);
					break;
				case "lifecycle.restore":
					memo.restoreVersions.set(operation.opId, {
						entryId: operation.opId,
						deleteOpId: operation.payload.deleteOpId,
						evidence: operation.payload.evidence,
						baseBindingId: operation.payload.baseBindingId,
					});
					break;
				case "lifecycle.purge":
					memo.purgedDeleteOperationIds.add(operation.payload.deleteOpId);
					break;
				case "relation.set_source":
					for (const relationId of operation.payload.supersedesRelationIds) {
						memo.supersededRelationIds.add(relationId);
					}
					memo.relations.set(operation.opId, operation.payload.sourceMemoId);
					break;
				case "review.record":
					memo.reviewOperationIds.add(operation.opId);
					memo.reviewedAt.push(operation.payload.reviewedAt);
					break;
			}
		}

		const materializedMemos: Record<string, CatalogV2MaterializedMemo> = {};
		for (const memoId of [...memos.keys()].sort(compareText)) {
			const memo = memos.get(memoId);
			if (memo === undefined) continue;
			for (const restore of memo.restoreVersions.values()) {
				if (!memo.deleteOperationIds.has(restore.deleteOpId)) {
					quarantine.push({
						code: "restore_missing_delete",
						key: memoId,
						digests: [restore.entryId, restore.deleteOpId],
					});
					continue;
				}
				memo.restoredDeleteOperationIds.add(restore.deleteOpId);
				memo.identityBindings.set(restore.entryId, {
					entryId: restore.entryId,
					source: "state",
					evidence: restore.evidence,
					baseBindingId: restore.baseBindingId ?? findRestoreBaseBindingId(memo, restore.deleteOpId),
					baseEvidence: null,
				});
				getNestedStringSet(
					memo.restoreEvidenceOperationIds,
					restore.deleteOpId,
					evidenceKey(restore.evidence),
				).add(restore.entryId);
			}
			const sourceMemoIds = uniqueSorted([...memo.relations.entries()]
				.flatMap(([relationId, sourceMemoId]) => !memo.supersededRelationIds.has(relationId) && sourceMemoId !== null
					? [sourceMemoId]
					: []));
			if (sourceMemoIds.length > 1) {
				quarantine.push({
					code: "relation_conflict",
					key: memoId,
					digests: sourceMemoIds,
				});
			}
			const redirectTargets = uniqueSorted([...memo.redirectTargets.values()]);
			if (redirectTargets.length > 1 || redirectTargets.includes(memoId)) {
				quarantine.push({ code: "redirect_conflict", key: memoId, digests: redirectTargets });
			}
			const reviewOperationIds = uniqueSorted([...memo.reviewOperationIds]);
			for (const [baseEvidence, deleteOperationIds] of memo.deleteBaseOperationIds) {
				const rebindOperationIds = memo.rebindBaseOperationIds.get(baseEvidence);
				if (rebindOperationIds !== undefined) {
					quarantine.push({
						code: "lifecycle_conflict",
						key: memoId,
						digests: uniqueSorted([...deleteOperationIds, ...rebindOperationIds]),
					});
				}
			}
			for (const [deleteOpId, byEvidence] of memo.restoreEvidenceOperationIds) {
				if (byEvidence.size > 1) {
					quarantine.push({
						code: "restore_conflict",
						key: memoId,
						digests: uniqueSorted([deleteOpId, ...[...byEvidence.values()].flatMap((values) => [...values])]),
					});
				}
			}
			const relationEntries = [...memo.relations.entries()]
				.map(([relationId, sourceMemoId]) => ({ relationId, sourceMemoId }))
				.sort((left, right) => compareText(left.relationId, right.relationId));
			const identityBindings = [...memo.identityBindings.values()]
				.sort((left, right) => compareText(left.entryId, right.entryId));
			const activeBindingHeads = resolveActiveBindings(memoId, identityBindings, quarantine);
			const pendingCreateIntents = [...memo.pendingCreateIntents.values()]
				.filter((intent) => !abandonedCreateIds.get(memoId)?.has(intent.entryId)
					&& !accepted.some((item) => item.operation.type === "identity.claim"
						&& item.operation.memoId === memoId
						&& item.operation.payload.createIntentOpId === intent.entryId))
				.sort((left, right) => compareText(left.entryId, right.entryId));
			materializedMemos[memoId] = {
				memoId,
				identityOperationIds: uniqueSorted([...memo.identityOperationIds]),
				activeBindingHeads,
				identityBindings,
				deleteOperationIds: uniqueSorted([...memo.deleteOperationIds]),
				deleteVersions: [...memo.deleteVersions.values()]
					.sort((left, right) => compareText(left.deleteOpId, right.deleteOpId)),
				restoreVersions: [...memo.restoreVersions.values()]
					.sort((left, right) => compareText(left.entryId, right.entryId)),
				restoredDeleteOperationIds: uniqueSorted([...memo.restoredDeleteOperationIds]),
				purgedDeleteOperationIds: uniqueSorted([...memo.purgedDeleteOperationIds]),
				relationEntries,
				supersededRelationIds: uniqueSorted([...memo.supersededRelationIds]),
				sourceMemoIds,
				reviewOperationIds,
				reviewCount: reviewOperationIds.length,
				lastReviewedAt: maxValidDateTime(memo.reviewedAt),
				pendingCreateIds: pendingCreateIntents.map((intent) => intent.entryId),
				pendingCreateIntents,
			};
		}
		isolateCrossMemoOwnership(materializedMemos, quarantine);
		for (const cycle of findRedirectCycles(memos)) {
			quarantine.push({
				code: "redirect_conflict",
				key: `cycle:${cycle.join("->")}`,
				digests: cycle,
			});
		}

		quarantine.sort((left, right) => compareText(`${left.code}\u0000${left.key}`, `${right.code}\u0000${right.key}`));
		return {
			schemaVersion: 1,
			memos: materializedMemos,
			quarantine,
			awaitingWriterIds,
			forkedWriterIds: uniqueSorted([...forkedWriterIds].filter(Boolean)),
			processedOperationCount: accepted.length,
		};
	}
}

function getStringSet(values: Map<string, Set<string>>, key: string): Set<string> {
	const existing = values.get(key);
	if (existing !== undefined) return existing;
	const created = new Set<string>();
	values.set(key, created);
	return created;
}

function getMutableMemo(memos: Map<string, MutableMemoState>, memoId: string): MutableMemoState {
	let memo = memos.get(memoId);
	if (memo !== undefined) return memo;
	memo = {
		identityOperationIds: new Set(),
		identityBindings: new Map(),
		deleteOperationIds: new Set(),
		deleteVersions: new Map(),
		restoreVersions: new Map(),
		restoredDeleteOperationIds: new Set(),
		purgedDeleteOperationIds: new Set(),
		relations: new Map(),
		supersededRelationIds: new Set(),
			reviewOperationIds: new Set(),
			reviewedAt: [],
		pendingCreateIntents: new Map(),
		redirectTargets: new Map(),
		deleteBaseOperationIds: new Map(),
		rebindBaseOperationIds: new Map(),
		restoreEvidenceOperationIds: new Map(),
	};
	memos.set(memoId, memo);
	return memo;
}

function getNestedStringSet(
	values: Map<string, Map<string, Set<string>>>,
	outerKey: string,
	innerKey: string,
): Set<string> {
	let nested = values.get(outerKey);
	if (nested === undefined) {
		nested = new Map();
		values.set(outerKey, nested);
	}
	return getStringSet(nested, innerKey);
}

function findRestoreBaseBindingId(memo: MutableMemoState, deleteOpId: string): string | null {
	const baseEvidence = memo.deleteVersions.get(deleteOpId)?.baseEvidence;
	if (baseEvidence === null || baseEvidence === undefined) return null;
	const matches = [...memo.identityBindings.values()]
		.filter((binding) => evidenceKey(binding.evidence as IdentityEvidence) === evidenceKey(baseEvidence))
		.sort((left, right) => compareText(left.entryId, right.entryId));
	return matches.length === 1 ? matches[0]?.entryId ?? null : null;
}

function resolveActiveBindings(
	memoId: string,
	bindings: readonly CatalogV2MaterializedMemo["identityBindings"][number][],
	quarantine: CatalogV2StateAttention[],
): CatalogV2MaterializedMemo["activeBindingHeads"] {
	const byId = new Map(bindings.map((binding) => [binding.entryId, binding]));
	const childrenByBase = new Map<string, CatalogV2MaterializedMemo["identityBindings"]>();
	const invalid = new Set<string>();
	for (const binding of bindings) {
		if (binding.baseBindingId === null) continue;
		const base = byId.get(binding.baseBindingId);
		if (base === undefined || (binding.baseEvidence !== null && binding.baseEvidence !== undefined
			&& evidenceKey(base.evidence) !== evidenceKey(binding.baseEvidence))) {
			invalid.add(binding.entryId);
			quarantine.push({
				code: "identity_ambiguous",
				key: memoId,
				digests: [binding.entryId, binding.baseBindingId].sort(compareText),
			});
			continue;
		}
		const children = childrenByBase.get(binding.baseBindingId) ?? [];
		children.push(binding);
		childrenByBase.set(binding.baseBindingId, children);
	}
	const superseded = new Set<string>();
	for (const [baseBindingId, children] of childrenByBase) {
		superseded.add(baseBindingId);
		const targets = new Map<string, string[]>();
		for (const child of children) {
			const key = canonicalJson(child.evidence);
			const ids = targets.get(key) ?? [];
			ids.push(child.entryId);
			targets.set(key, ids);
		}
		if (targets.size > 1) {
			quarantine.push({
				code: "identity_ambiguous",
				key: memoId,
				digests: uniqueSorted([baseBindingId, ...children.map((child) => child.entryId)]),
			});
		}
		for (const ids of targets.values()) {
			const sorted = uniqueSorted(ids);
			for (const duplicate of sorted.slice(1)) superseded.add(duplicate);
		}
	}
	const activeCandidates = bindings
		.filter((binding) => !invalid.has(binding.entryId) && !superseded.has(binding.entryId))
		.sort((left, right) => compareText(left.entryId, right.entryId));
	const activeByEvidence = new Map<string, CatalogV2MaterializedMemo["identityBindings"][number]>();
	for (const binding of activeCandidates) {
		const key = canonicalJson(binding.evidence);
		if (activeByEvidence.has(key)) superseded.add(binding.entryId);
		else activeByEvidence.set(key, binding);
	}
	const active = activeCandidates.filter((binding) => !superseded.has(binding.entryId));
	if (active.length > 1) {
		const targetCount = new Set(active.map((binding) => canonicalJson(binding.evidence))).size;
		if (targetCount > 1) {
			quarantine.push({
				code: "identity_ambiguous",
				key: memoId,
				digests: active.map((binding) => binding.entryId).sort(compareText),
			});
		}
	}
	return active.sort((left, right) => compareText(left.entryId, right.entryId));
}

function isolateCrossMemoOwnership(
	memos: Record<string, CatalogV2MaterializedMemo>,
	quarantine: CatalogV2StateAttention[],
): void {
	const owners = new Map<string, Array<{ memoId: string; entryId: string }>>();
	for (const memo of Object.values(memos)) {
		for (const binding of memo.activeBindingHeads) {
			const key = evidenceKey(binding.evidence);
			const current = owners.get(key) ?? [];
			current.push({ memoId: memo.memoId, entryId: binding.entryId });
			owners.set(key, current);
		}
	}
	for (const [key, entries] of owners) {
		const memoIds = uniqueSorted(entries.map((entry) => entry.memoId));
		if (memoIds.length <= 1) continue;
		quarantine.push({
			code: "identity_ownership_conflict",
			key,
			digests: uniqueSorted(entries.flatMap((entry) => [entry.memoId, entry.entryId])),
		});
		for (const memoId of memoIds) {
			const memo = memos[memoId];
			if (memo !== undefined) memo.activeBindingHeads = [];
		}
	}
}

function evidenceKey(evidence: IdentityEvidence | CatalogV2MaterializedMemo["identityBindings"][number]["evidence"]): string {
	return canonicalJson(evidence);
}

function dedupeEnvelopes(envelopes: readonly StateOperationEnvelope[]): StateOperationEnvelope[] {
	const byDigest = new Map<string, StateOperationEnvelope>();
	for (const envelope of envelopes) {
		byDigest.set(envelope.digest, envelope);
	}
	return [...byDigest.values()];
}

function findWritersWithSequenceGaps(envelopes: readonly StateOperationEnvelope[]): string[] {
	const byWriter = groupBy(envelopes, (item) => item.operation.writerId);
	const result: string[] = [];
	for (const [writerId, items] of byWriter) {
		const sequences = [...new Set(items.map((item) => item.operation.sequence))].sort((left, right) => left - right);
		if (sequences[0] !== 1 || sequences.some((sequence, index) => index > 0 && sequence !== (sequences[index - 1] ?? 0) + 1)) {
			result.push(writerId);
		}
	}
	return result.sort(compareText);
}

function compareEnvelopes(left: StateOperationEnvelope, right: StateOperationEnvelope): number {
	return compareText(left.operation.writerId, right.operation.writerId)
		|| left.operation.sequence - right.operation.sequence
		|| compareText(left.operation.opId, right.operation.opId)
		|| compareText(left.digest, right.digest);
}

function uniqueSorted(values: readonly string[]): string[] {
	return [...new Set(values)].sort(compareText);
}

function groupBy<T>(items: readonly T[], getKey: (item: T) => string): Map<string, T[]> {
	const groups = new Map<string, T[]>();
	for (const item of items) {
		const key = getKey(item);
		const group = groups.get(key) ?? [];
		group.push(item);
		groups.set(key, group);
	}
	return groups;
}

function maxValidDateTime(values: readonly string[]): string | null {
	let result: string | null = null;
	let resultTime = Number.NEGATIVE_INFINITY;
	for (const value of values) {
		const time = Date.parse(value);
		if (Number.isFinite(time) && time > resultTime) {
			result = value;
			resultTime = time;
		}
	}
	return result;
}

function findRedirectCycles(memos: ReadonlyMap<string, MutableMemoState>): string[][] {
	const targets = new Map<string, string>();
	for (const [memoId, memo] of memos) {
		const uniqueTargets = uniqueSorted([...memo.redirectTargets.values()]);
		if (uniqueTargets.length === 1 && uniqueTargets[0] !== memoId) targets.set(memoId, uniqueTargets[0] ?? "");
	}
	const cycles = new Map<string, string[]>();
	for (const start of [...targets.keys()].sort(compareText)) {
		const path: string[] = [];
		const position = new Map<string, number>();
		let current: string | undefined = start;
		while (current !== undefined && targets.has(current)) {
			const seenAt = position.get(current);
			if (seenAt !== undefined) {
				const cycle = path.slice(seenAt).sort(compareText);
				cycles.set(cycle.join("\u0000"), cycle);
				break;
			}
			position.set(current, path.length);
			path.push(current);
			current = targets.get(current);
		}
	}
	return [...cycles.values()].sort((left, right) => compareText(left.join("\u0000"), right.join("\u0000")));
}

import type {
	ArtifactRef,
	CatalogV2MaterializedMemo,
	CatalogV2MaterializedState,
	LegacyImportResult,
	MigrationCommit,
	MigrationCommitDomainCounts,
	MigrationCommitLegacySource,
	MigrationCommitRequiredArtifact,
	MigrationCommitVerification,
	MigrationPackage,
} from "../types/catalogV2";
import { getCatalogUpgradeCheckpointPath } from "../utils/path";
import { canonicalJson, canonicalJsonFileBytes, compareText, sha256Bytes, sha256Text } from "./CatalogV2Protocol";
import { createLegacyEntryId, createLegacyReviewOrdinalId } from "./CatalogV2LegacyImporter";

const WRITER_ID_PATTERN = /^w_[a-f0-9]{32}$/;

export interface BuildMigrationCommitInput {
	writerId: string;
	committedAt: string;
	results: LegacyImportResult[];
	verification: MigrationCommitVerification;
	baseCommits?: MigrationCommit[];
	basePackages?: MigrationPackage[];
}

export interface BuiltMigrationCommit {
	commit: MigrationCommit;
	bytes: Uint8Array;
	sha256: string;
	path: string;
}

export interface AvailableMigrationArtifact {
	path: string;
	bytes: Uint8Array;
}

export type MigrationCommitAvailability =
	| { status: "complete" }
	| { status: "awaiting_data"; missingPaths: string[] }
	| { status: "quarantined"; mismatchedPaths: string[] };

export type MigrationCommitSelection =
	| { status: "selected"; commit: MigrationCommit; attentionGenerationDigests: string[] }
	| { status: "awaiting_data"; generationDigests: string[] }
	| { status: "merge_required"; generationDigests: string[] }
	| { status: "quarantined"; generationDigests: string[] };

export async function buildMigrationCommit(input: BuildMigrationCommitInput): Promise<BuiltMigrationCommit> {
	if (!WRITER_ID_PATTERN.test(input.writerId) || !isDateTime(input.committedAt)) {
		throw new Error("Invalid migration commit writer or timestamp.");
	}
	const sourcesByKey = new Map<string, MigrationCommitLegacySource>();
	const requiredByKey = new Map<string, MigrationCommitRequiredArtifact>();
	const packages: MigrationPackage[] = [...(input.basePackages ?? [])];
	for (const commit of input.baseCommits ?? []) {
		for (const source of commit.legacySources) {
			addUnique(sourcesByKey, `${source.artifactKind}\u0000${source.artifactDigest}`, source);
		}
		for (const required of commit.requiredArtifacts) addRequired(requiredByKey, required);
	}
	for (const result of input.results) {
		if (result.kind === "imported") {
			const source: MigrationCommitLegacySource = {
				artifactDigest: result.receipt.sha256,
				artifactKind: result.receipt.artifactKind,
				disposition: "imported",
				receipt: requireArtifactRef(result.receipt.requiredArtifact),
			};
			addUnique(sourcesByKey, `${source.artifactKind}\u0000${source.artifactDigest}`, source);
			addRequired(requiredByKey, { artifactKind: "migration_package", ...source.receipt });
			for (const payload of result.deletedPayloads) {
				addRequired(requiredByKey, {
					artifactKind: "deleted_payload",
					path: payload.path,
					sha256: payload.sha256,
					byteLength: payload.bytes.byteLength,
				});
			}
			packages.push(result.package);
		} else {
			const required = requireArtifactRef(result.inventory.requiredArtifact);
			const source: MigrationCommitLegacySource = {
				artifactDigest: result.receipt.artifactDigest,
				artifactKind: result.receipt.artifactKind,
				disposition: "quarantined",
				receipt: required,
			};
			addUnique(sourcesByKey, `${source.artifactKind}\u0000${source.artifactDigest}`, source);
			addRequired(requiredByKey, { artifactKind: "quarantine_receipt", ...required });
		}
	}
	const legacySources = [...sourcesByKey.values()].sort((left, right) => compareText(
		`${left.artifactDigest}\u0000${left.artifactKind}\u0000${left.disposition}\u0000${left.receipt.sha256}`,
		`${right.artifactDigest}\u0000${right.artifactKind}\u0000${right.disposition}\u0000${right.receipt.sha256}`,
	));
	const requiredArtifacts = [...requiredByKey.values()].sort((left, right) => compareText(
		`${left.path}\u0000${left.artifactKind}\u0000${left.sha256}`,
		`${right.path}\u0000${right.artifactKind}\u0000${right.sha256}`,
	));
	if (legacySources.length === 0 || requiredArtifacts.length === 0) {
		throw new Error("Migration commit requires at least one inventoried legacy artifact.");
	}
	const domainCounts = await calculateMigrationDomainCounts(packages, legacySources);
	const descriptor = {
		schemaVersion: 1,
		importerVersion: 1,
		legacySources: legacySources.map((source) => ({
			artifactDigest: source.artifactDigest,
			artifactKind: source.artifactKind,
			disposition: source.disposition,
			receiptSha256: source.receipt.sha256,
		})),
		requiredArtifacts,
		domainCounts,
	};
	const generationDigest = await sha256Text(canonicalJson(descriptor));
	const commit: MigrationCommit = {
		kind: "knomo.catalog-v2.migration-commit",
		schemaVersion: 1,
		importerVersion: 1,
		generationDigest,
		writerId: input.writerId,
		committedAt: input.committedAt,
		legacySources,
		requiredArtifacts,
		domainCounts,
		verification: input.verification,
	};
	const bytes = canonicalJsonFileBytes(commit);
	return {
		commit,
		bytes,
		sha256: await sha256Bytes(bytes),
		path: getCatalogUpgradeCheckpointPath("", generationDigest, input.writerId),
	};
}

export async function evaluateMigrationCommit(
	commit: MigrationCommit,
	artifacts: readonly AvailableMigrationArtifact[],
): Promise<MigrationCommitAvailability> {
	const byPath = new Map(artifacts.map((artifact) => [artifact.path, artifact.bytes]));
	const missingPaths: string[] = [];
	const mismatchedPaths: string[] = [];
	for (const required of commit.requiredArtifacts) {
		const bytes = byPath.get(required.path);
		if (bytes === undefined) {
			missingPaths.push(required.path);
			continue;
		}
		if (bytes.byteLength !== required.byteLength || await sha256Bytes(bytes) !== required.sha256) {
			mismatchedPaths.push(required.path);
		}
	}
	if (mismatchedPaths.length > 0) return { status: "quarantined", mismatchedPaths: mismatchedPaths.sort(compareText) };
	if (missingPaths.length > 0) return { status: "awaiting_data", missingPaths: missingPaths.sort(compareText) };
	return { status: "complete" };
}

export async function selectMigrationCommit(
	commits: readonly MigrationCommit[],
	artifacts: readonly AvailableMigrationArtifact[],
): Promise<MigrationCommitSelection> {
	const evaluated = await Promise.all(commits.map(async (commit) => ({
		commit,
		availability: await evaluateMigrationCommit(commit, artifacts),
	})));
	const mismatched = evaluated.filter((item) => item.availability.status === "quarantined");
	const complete = evaluated.filter((item) => item.availability.status === "complete").map((item) => item.commit);
	if (complete.length === 0) {
		if (mismatched.length > 0) {
			return { status: "quarantined", generationDigests: uniqueSorted(mismatched.map((item) => item.commit.generationDigest)) };
		}
		return { status: "awaiting_data", generationDigests: uniqueSorted(commits.map((commit) => commit.generationDigest)) };
	}
	for (let leftIndex = 0; leftIndex < complete.length; leftIndex += 1) {
		for (let rightIndex = leftIndex + 1; rightIndex < complete.length; rightIndex += 1) {
			const left = complete[leftIndex];
			const right = complete[rightIndex];
			if (left === undefined || right === undefined) continue;
			if (sameSourceKeys(left, right) && sourceReceiptSignature(left) !== sourceReceiptSignature(right)) {
				return { status: "quarantined", generationDigests: uniqueSorted([left.generationDigest, right.generationDigest]) };
			}
		}
	}
	const maximal = complete.filter((candidate) => !complete.some((other) => isStrictSourceSuperset(other, candidate)));
	const maximalGenerations = uniqueSorted(maximal.map((commit) => commit.generationDigest));
	if (maximalGenerations.length > 1) {
		return { status: "merge_required", generationDigests: maximalGenerations };
	}
	const selected = maximal.sort((left, right) => compareText(
		`${left.generationDigest}\u0000${left.writerId}`,
		`${right.generationDigest}\u0000${right.writerId}`,
	))[0];
	if (selected === undefined) return { status: "awaiting_data", generationDigests: [] };
	return {
		status: "selected",
		commit: selected,
		attentionGenerationDigests: uniqueSorted(mismatched.map((item) => item.commit.generationDigest)),
	};
}

export class CatalogV2MigrationReducer {
	async reduce(
		packages: readonly MigrationPackage[],
		eventState?: CatalogV2MaterializedState,
	): Promise<CatalogV2MaterializedState> {
		const memos = cloneMemos(eventState?.memos ?? {});
		const processedIds = new Set<string>();
		for (const packageValue of [...packages].sort((left, right) => compareText(
			`${left.source.artifactKind}\u0000${left.source.artifactDigest}`,
			`${right.source.artifactKind}\u0000${right.source.artifactDigest}`,
		))) {
			for (const claim of packageValue.identityClaims) {
				const id = await createLegacyEntryId("identity", packageValue.source.artifactKind, packageValue.source.artifactDigest, claim.memoId, claim.legacyRecordDigest, null);
				const memo = getMemo(memos, claim.memoId);
				memo.identityOperationIds.push(id);
				const binding = { entryId: id, source: "migration" as const, evidence: claim.evidence, baseBindingId: null };
				memo.identityBindings.push(binding);
				memo.activeBindingHeads.push(binding);
				processedIds.add(id);
			}
			for (const deleted of packageValue.deletedRecords) {
				const memo = getMemo(memos, deleted.memoId);
				memo.deleteOperationIds.push(deleted.deleteOpId);
				memo.deleteVersions.push({
					deleteOpId: deleted.deleteOpId,
					entryId: deleted.deleteOpId,
					payload: deleted.payload,
					baseEvidence: null,
					baseBindingId: null,
				});
				processedIds.add(deleted.deleteOpId);
			}
			for (const relation of packageValue.relations) {
				const id = await createLegacyEntryId("relation", packageValue.source.artifactKind, packageValue.source.artifactDigest, relation.memoId, relation.legacyRecordDigest, null);
				getMemo(memos, relation.memoId).relationEntries.push({ relationId: id, sourceMemoId: relation.sourceMemoId });
				processedIds.add(id);
			}
			for (const review of packageValue.reviews) {
				const memo = getMemo(memos, review.memoId);
				for (let ordinal = 1; ordinal <= review.reviewCount; ordinal += 1) {
					const id = await createLegacyReviewOrdinalId(review.memoId, ordinal);
					memo.reviewOperationIds.push(id);
					processedIds.add(id);
				}
				memo.lastReviewedAt = maxDateTime(memo.lastReviewedAt, review.lastReviewedAt);
			}
			for (const pending of packageValue.pendingCreates) {
				const id = await createLegacyEntryId("pending", packageValue.source.artifactKind, packageValue.source.artifactDigest, pending.memoId, pending.legacyRecordDigest, null);
				getMemo(memos, pending.memoId).pendingCreateIds.push(id);
				processedIds.add(id);
			}
		}
		for (const memo of Object.values(memos)) {
			memo.restoreVersions = uniqueById(memo.restoreVersions, (item) => item.entryId);
			for (const restore of memo.restoreVersions) {
				if (!memo.deleteOperationIds.includes(restore.deleteOpId)) continue;
				memo.restoredDeleteOperationIds.push(restore.deleteOpId);
				const binding = { entryId: restore.entryId, source: "state" as const, evidence: restore.evidence, baseBindingId: null };
				memo.identityBindings.push(binding);
				memo.activeBindingHeads = [binding];
			}
			memo.identityOperationIds = uniqueSorted(memo.identityOperationIds);
			memo.identityBindings = uniqueById(memo.identityBindings, (item) => item.entryId);
			memo.activeBindingHeads = uniqueById(memo.activeBindingHeads, (item) => item.entryId);
			memo.deleteOperationIds = uniqueSorted(memo.deleteOperationIds);
			memo.deleteVersions = uniqueById(memo.deleteVersions, (item) => item.deleteOpId);
			memo.restoredDeleteOperationIds = uniqueSorted(memo.restoredDeleteOperationIds);
			memo.purgedDeleteOperationIds = uniqueSorted(memo.purgedDeleteOperationIds);
			memo.relationEntries = uniqueById(memo.relationEntries, (item) => item.relationId);
			memo.supersededRelationIds = uniqueSorted(memo.supersededRelationIds);
			memo.sourceMemoIds = uniqueSorted(memo.relationEntries.flatMap((entry) =>
				!memo.supersededRelationIds.includes(entry.relationId) && entry.sourceMemoId !== null ? [entry.sourceMemoId] : []));
			memo.reviewOperationIds = uniqueSorted(memo.reviewOperationIds);
			memo.reviewCount = memo.reviewOperationIds.length;
			memo.pendingCreateIds = uniqueSorted(memo.pendingCreateIds);
		}
		const quarantine = [...(eventState?.quarantine ?? [])]
			.filter((item) => item.code !== "restore_missing_delete");
		for (const memo of Object.values(memos)) {
			for (const restore of memo.restoreVersions) {
				if (!memo.deleteOperationIds.includes(restore.deleteOpId)) {
					quarantine.push({
						code: "restore_missing_delete",
						key: memo.memoId,
						digests: [restore.entryId, restore.deleteOpId],
					});
				}
			}
			const restoreEvidenceByDelete = new Map<string, Map<string, string[]>>();
			for (const restore of memo.restoreVersions.filter((item) => memo.deleteOperationIds.includes(item.deleteOpId))) {
				const byEvidence = restoreEvidenceByDelete.get(restore.deleteOpId) ?? new Map<string, string[]>();
				const key = canonicalJson(restore.evidence);
				byEvidence.set(key, [...(byEvidence.get(key) ?? []), restore.entryId]);
				restoreEvidenceByDelete.set(restore.deleteOpId, byEvidence);
			}
			for (const [deleteOpId, byEvidence] of restoreEvidenceByDelete) {
				if (byEvidence.size > 1 && !quarantine.some((item) => item.code === "restore_conflict" && item.key === memo.memoId)) {
					quarantine.push({
						code: "restore_conflict",
						key: memo.memoId,
						digests: uniqueSorted([deleteOpId, ...[...byEvidence.values()].flat()]),
					});
				}
			}
			if (memo.sourceMemoIds.length > 1 && !quarantine.some((item) => item.code === "relation_conflict" && item.key === memo.memoId)) {
				quarantine.push({ code: "relation_conflict", key: memo.memoId, digests: [...memo.sourceMemoIds] });
			}
		}
		quarantine.sort((left, right) => compareText(`${left.code}\u0000${left.key}`, `${right.code}\u0000${right.key}`));
		return {
			schemaVersion: 1,
			memos: Object.fromEntries(Object.entries(memos).sort(([left], [right]) => compareText(left, right))),
			...(eventState?.fileRevisionTransitions === undefined ? {} : {
				fileRevisionTransitions: eventState.fileRevisionTransitions,
			}),
			quarantine,
			awaitingWriterIds: eventState?.awaitingWriterIds ?? [],
			forkedWriterIds: eventState?.forkedWriterIds ?? [],
			processedOperationCount: (eventState?.processedOperationCount ?? 0) + processedIds.size,
		};
	}
}

export async function calculateMigrationDomainCounts(
	packages: readonly MigrationPackage[],
	sources: readonly MigrationCommitLegacySource[],
): Promise<MigrationCommitDomainCounts> {
	const identities = new Set<string>();
	const deleted = new Set<string>();
	const relations = new Set<string>();
	const reviews = new Set<string>();
	const pending = new Set<string>();
	const diagnostics = new Set<string>();
	for (const packageValue of packages) {
		for (const item of packageValue.identityClaims) identities.add(await createLegacyEntryId("identity", packageValue.source.artifactKind, packageValue.source.artifactDigest, item.memoId, item.legacyRecordDigest, null));
		for (const item of packageValue.deletedRecords) deleted.add(item.deleteOpId);
		for (const item of packageValue.relations) relations.add(await createLegacyEntryId("relation", packageValue.source.artifactKind, packageValue.source.artifactDigest, item.memoId, item.legacyRecordDigest, null));
		for (const item of packageValue.reviews) {
			for (let ordinal = 1; ordinal <= item.reviewCount; ordinal += 1) reviews.add(await createLegacyReviewOrdinalId(item.memoId, ordinal));
		}
		for (const item of packageValue.pendingCreates) pending.add(await createLegacyEntryId("pending", packageValue.source.artifactKind, packageValue.source.artifactDigest, item.memoId, item.legacyRecordDigest, null));
		for (const item of packageValue.diagnostics) diagnostics.add(`${item.entryKey}\u0000${item.code}\u0000${item.memoId ?? ""}`);
	}
	return {
		identityClaims: identities.size,
		deletedRecords: deleted.size,
		relations: relations.size,
		reviewOrdinals: reviews.size,
		pendingCreates: pending.size,
		diagnostics: diagnostics.size,
		quarantinedArtifacts: sources.filter((source) => source.disposition === "quarantined").length,
	};
}

function addRequired(
	values: Map<string, MigrationCommitRequiredArtifact>,
	value: MigrationCommitRequiredArtifact,
): void {
	addUnique(values, `${value.artifactKind}\u0000${value.path}`, value);
}

function addUnique<T>(values: Map<string, T>, key: string, value: T): void {
	const existing = values.get(key);
	if (existing !== undefined && canonicalJson(existing) !== canonicalJson(value)) {
		throw new Error(`Conflicting deterministic migration artifact: ${key}`);
	}
	values.set(key, value);
}

function requireArtifactRef(value: ArtifactRef | null): ArtifactRef {
	if (value === null) throw new Error("Migration receipt is missing its required artifact.");
	return value;
}

function cloneMemos(source: Record<string, CatalogV2MaterializedMemo>): Record<string, CatalogV2MaterializedMemo> {
	return Object.fromEntries(Object.entries(source).map(([memoId, memo]) => [memoId, {
		...memo,
		identityOperationIds: [...memo.identityOperationIds],
		activeBindingHeads: memo.activeBindingHeads.map((binding) => ({ ...binding, evidence: { ...binding.evidence } })),
		identityBindings: memo.identityBindings.map((binding) => ({ ...binding, evidence: { ...binding.evidence } })),
		deleteOperationIds: [...memo.deleteOperationIds],
		deleteVersions: memo.deleteVersions.map((version) => ({
			...version,
			payload: { ...version.payload },
			baseEvidence: version.baseEvidence === null ? null : { ...version.baseEvidence },
		})),
		restoreVersions: memo.restoreVersions.map((version) => ({ ...version, evidence: { ...version.evidence } })),
		restoredDeleteOperationIds: [...memo.restoredDeleteOperationIds],
		purgedDeleteOperationIds: [...memo.purgedDeleteOperationIds],
		relationEntries: memo.relationEntries.map((entry) => ({ ...entry })),
		supersededRelationIds: [...memo.supersededRelationIds],
		sourceMemoIds: [...memo.sourceMemoIds],
		reviewOperationIds: [...memo.reviewOperationIds],
		pendingCreateIds: [...memo.pendingCreateIds],
		pendingCreateIntents: memo.pendingCreateIntents.map((intent) => ({
			...intent,
			evidence: { ...intent.evidence },
		})),
	}]));
}

function getMemo(values: Record<string, CatalogV2MaterializedMemo>, memoId: string): CatalogV2MaterializedMemo {
	const existing = values[memoId];
	if (existing !== undefined) return existing;
	const created: CatalogV2MaterializedMemo = {
		memoId,
		identityOperationIds: [],
		activeBindingHeads: [],
		identityBindings: [],
		deleteOperationIds: [],
		deleteVersions: [],
		restoreVersions: [],
		restoredDeleteOperationIds: [],
		purgedDeleteOperationIds: [],
		relationEntries: [],
		supersededRelationIds: [],
		sourceMemoIds: [],
		reviewOperationIds: [],
		reviewCount: 0,
		lastReviewedAt: null,
		pendingCreateIds: [],
		pendingCreateIntents: [],
	};
	values[memoId] = created;
	return created;
}

function uniqueById<T>(values: readonly T[], getId: (value: T) => string): T[] {
	return [...new Map(values.map((value) => [getId(value), value])).values()]
		.sort((left, right) => compareText(getId(left), getId(right)));
}

function uniqueSorted(values: readonly string[]): string[] {
	return [...new Set(values)].sort(compareText);
}

function maxDateTime(left: string | null, right: string | null): string | null {
	if (right === null || !isDateTime(right)) return left;
	if (left === null || !isDateTime(left)) return right;
	return Date.parse(right) > Date.parse(left) ? right : left;
}

function isDateTime(value: string): boolean {
	return value.length > 0 && Number.isFinite(Date.parse(value));
}

function sourceKeys(commit: MigrationCommit): Set<string> {
	return new Set(commit.legacySources.map((source) => `${source.artifactKind}\u0000${source.artifactDigest}`));
}

function sameSourceKeys(left: MigrationCommit, right: MigrationCommit): boolean {
	const leftKeys = sourceKeys(left);
	const rightKeys = sourceKeys(right);
	return leftKeys.size === rightKeys.size && [...leftKeys].every((key) => rightKeys.has(key));
}

function isStrictSourceSuperset(left: MigrationCommit, right: MigrationCommit): boolean {
	const leftKeys = sourceKeys(left);
	const rightKeys = sourceKeys(right);
	return leftKeys.size > rightKeys.size && [...rightKeys].every((key) => leftKeys.has(key));
}

function sourceReceiptSignature(commit: MigrationCommit): string {
	return [...commit.legacySources].sort((left, right) => compareText(
		`${left.artifactKind}\u0000${left.artifactDigest}`,
		`${right.artifactKind}\u0000${right.artifactDigest}`,
	)).map((source) => `${source.artifactKind}\u0000${source.artifactDigest}\u0000${source.receipt.sha256}`).join("\u0001");
}

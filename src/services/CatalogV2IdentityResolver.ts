import type {
	CatalogFileRevisionBatch,
	IdentityCandidate,
	MemoObservation,
	ResolvedMemo,
	ResolvedMemoHandle,
} from "../types/catalog";
import type {
	CatalogV2MaterializedIdentityBinding,
	CatalogV2MaterializedState,
	IdentityEvidence,
	LegacyEvidence,
} from "../types/catalogV2";
import type { CatalogV2FileRevisionTransition } from "../types/catalogV2Protocol";
import { createResolvedMemoCapabilities } from "./MemoCapabilityModel";

export interface CatalogV2LocalIdentityIntent {
	memoId: string;
	createIntentOpId: string;
	targetPath: string;
	sourceRevision?: string;
	logicalDate: string;
	time: string;
	contentHash: string;
}

export interface CatalogV2IdentitySettlement {
	stateComplete: boolean;
	migrationComplete: boolean;
	revisionStable: boolean;
	historical: boolean;
	migrationRequired?: boolean;
	verifiedGenerationId?: string;
	contractDigest?: string;
	blockedMemoIds?: string[] | null;
}

export interface CatalogV2IdentityResolverInput {
	batch: CatalogFileRevisionBatch<MemoObservation>;
	state: CatalogV2MaterializedState;
	stateRevision: string;
	localIntents: readonly CatalogV2LocalIdentityIntent[];
	settlement: CatalogV2IdentitySettlement;
	identityIndex?: CatalogV2IdentityIndex;
}

export interface CatalogV2VaultIdentityResolverInput {
	batches: readonly CatalogFileRevisionBatch<MemoObservation>[];
	state: CatalogV2MaterializedState;
	stateRevision: string;
	localIntents: readonly CatalogV2LocalIdentityIntent[];
	settlement: CatalogV2IdentitySettlement;
}

interface ResolverCandidate extends IdentityCandidate {
	priority: number;
	score: number;
	durable: boolean;
	bindingId: string | null;
}

interface CandidateSelection {
	observation: MemoObservation;
	candidates: ResolverCandidate[];
}

export class CatalogV2IdentityResolver {
	resolveVault(input: CatalogV2VaultIdentityResolverInput): Map<string, ResolvedMemo> {
		for (const batch of input.batches) assertCompleteFileRevisionBatch(batch);
		const identityIndex = new CatalogV2IdentityIndex(input.state);
		const selections = input.batches.flatMap((batch) => batch.observations.map((observation) => ({
			observation,
			candidates: selectBestCandidates(buildCandidates(observation, {
				batch,
				state: input.state,
				stateRevision: input.stateRevision,
				localIntents: input.localIntents,
				settlement: input.settlement,
				identityIndex,
			}, identityIndex)),
		})));
		const resolved = resolveSelections(
			selections,
			input.state,
			input.stateRevision,
			input.settlement,
			input.localIntents,
		);
		return new Map(resolved.map((memo) => [observationKey(memo.observation), memo]));
	}

	resolveFile(input: CatalogV2IdentityResolverInput): ResolvedMemo[] {
		assertCompleteFileRevisionBatch(input.batch);
		const stateReady = isStateReady(input);
		const complete = stateReady && input.settlement.migrationComplete;
		const identityIndex = input.identityIndex ?? new CatalogV2IdentityIndex(input.state);
		const selections = input.batch.observations.map((observation) => ({
			observation,
			candidates: selectBestCandidates(buildCandidates(observation, input, identityIndex)),
		}));
		return resolveSelections(selections, input.state, input.stateRevision, input.settlement, input.localIntents);
	}
}

function resolveSelections(
	selections: readonly CandidateSelection[],
	state: CatalogV2MaterializedState,
	stateRevision: string,
	settlement: CatalogV2IdentitySettlement,
	localIntents: readonly CatalogV2LocalIdentityIntent[],
): ResolvedMemo[] {
		const assignments = assignForcedOneToOne(selections);
		const revisionTransitions = collectRevisionTransitions(state);
		const stateReady = settlement.stateComplete && settlement.revisionStable && state.awaitingWriterIds.length === 0;
		const complete = stateReady && settlement.migrationComplete;
		const resolved = selections.map((selection, index): ResolvedMemo => {
			const assigned = assignments.get(index);
			if (assigned !== undefined && assigned.durable && assigned.bindingId !== null
				&& !hasActiveDelete(state, assigned.memoId)) {
				const ready = isMemoReady(state, settlement, assigned.memoId) && assigned.durable
					&& !hasBlockingStateAttention(state, assigned.memoId);
				return {
					kind: "identified",
					bindingEvidence: getActiveBindingEvidence(state, assigned.memoId, assigned.bindingId),
					identityHandle: {
						memoId: assigned.memoId,
						activeBindingId: assigned.bindingId,
						identityRevision: stateRevision,
					},
					observation: selection.observation,
					capabilities: createResolvedMemoCapabilities(ready ? "ready" : "syncing"),
					stateRevision,
				};
			}
			const predecessor = findKnownPredecessor(selection.observation, state, revisionTransitions);
			if (predecessor !== null) {
				const binding = state.memos[predecessor]?.activeBindingHeads[0];
				return {
					kind: "ambiguous",
					identityHandle: null,
					observation: selection.observation,
					candidates: [{
						memoId: predecessor,
						source: "state",
						...(binding === undefined ? {} : { origin: evidenceOrigin(binding.evidence) }),
					}],
					reason: "known_predecessor",
					capabilities: createResolvedMemoCapabilities("syncing"),
					stateRevision,
				};
			}

			if (selection.candidates.length > 0) {
				const candidates = selection.candidates.map(toPublicCandidate);
				if (assigned !== undefined && hasActiveDelete(state, assigned.memoId)) {
					candidates.push({ memoId: assigned.memoId, source: "lifecycle_conflict" });
				}
				return {
					kind: "ambiguous",
					identityHandle: null,
					observation: selection.observation,
					candidates: dedupePublicCandidates(candidates),
					reason: selection.candidates.every((candidate) => candidate.source === "manual_successor")
						? "manual_successor" : "ambiguous",
					capabilities: createResolvedMemoCapabilities("conflicted"),
					stateRevision,
				};
			}

			const adoption = settlement.historical
				? "historical_readonly"
				: complete ? "eligible" : "settling";
			return {
				kind: "observed",
				identityHandle: null,
				observation: selection.observation,
				adoption,
				capabilities: createResolvedMemoCapabilities(adoption === "settling" ? "syncing" : "absent"),
				stateRevision,
			};
		});
		return blockDuplicateAssignments(resolved, selections, stateRevision);
}

function assertCompleteFileRevisionBatch(batch: CatalogFileRevisionBatch<MemoObservation>): void {
	if (batch.file.observationCount !== batch.observations.length) {
		throw new Error("Identity resolver requires every observation in the file revision.");
	}
	const positions = new Set<string>();
	for (const observation of batch.observations) {
		if (observation.sourcePath !== batch.file.sourcePath || observation.sourceRevision !== batch.file.sourceRevision) {
			throw new Error("Identity resolver received observations from different file revisions.");
		}
		const position = `${observation.startLine}\u0000${observation.endLine}`;
		if (positions.has(position)) throw new Error("Identity resolver received duplicate observation positions.");
		positions.add(position);
	}
}

function blockDuplicateAssignments(
	resolved: readonly ResolvedMemo[],
	selections: readonly CandidateSelection[],
	stateRevision: string,
): ResolvedMemo[] {
	const counts = new Map<string, number>();
	for (const memo of resolved) {
		if (memo.kind === "identified") {
			const memoId = memo.identityHandle.memoId;
			counts.set(memoId, (counts.get(memoId) ?? 0) + 1);
		}
	}
	return resolved.map((memo, index) => {
		if (memo.kind !== "identified" || counts.get(memo.identityHandle.memoId) === 1) return memo;
		return {
			kind: "ambiguous",
			identityHandle: null,
			observation: memo.observation,
			candidates: dedupePublicCandidates((selections[index]?.candidates ?? []).map(toPublicCandidate)),
			capabilities: createResolvedMemoCapabilities("conflicted"),
			stateRevision,
		};
	});
}

export class CatalogV2IdentityIndex {
	private readonly bindingsByBlockId = new Map<string, Array<{ memoId: string; binding: CatalogV2MaterializedIdentityBinding }>>();
	private readonly bindingsByTuple = new Map<string, Array<{ memoId: string; binding: CatalogV2MaterializedIdentityBinding }>>();
	private readonly bindingsBySourcePath = new Map<string, Array<{ memoId: string; binding: CatalogV2MaterializedIdentityBinding }>>();
	private readonly revisionTransitions: readonly CatalogV2FileRevisionTransition[];

	constructor(state: CatalogV2MaterializedState) {
		this.revisionTransitions = collectRevisionTransitions(state);
		for (const memo of Object.values(state.memos)) {
			for (const binding of memo.activeBindingHeads) {
				const entry = { memoId: memo.memoId, binding };
				if (binding.evidence.existingBlockId !== null) {
					pushMapValue(this.bindingsByBlockId, blockIdKey(binding.evidence), entry);
				}
				pushMapValue(this.bindingsByTuple, evidenceTupleKey(binding.evidence), entry);
				pushMapValue(this.bindingsBySourcePath, binding.evidence.sourcePath, entry);
			}
		}
	}

	find(observation: MemoObservation): ResolverCandidate[] {
		const entries = [
			...(observation.existingBlockId === null ? [] : this.bindingsByBlockId.get(blockIdKey(observation)) ?? []),
			...(this.bindingsByTuple.get(evidenceTupleKey(observation)) ?? []),
			...(this.bindingsBySourcePath.get(observation.sourcePath) ?? []),
		];
		const candidates: ResolverCandidate[] = [];
		for (const entry of entries) {
			const candidate = matchBinding(entry.memoId, entry.binding, observation, this.revisionTransitions);
			if (candidate !== null) candidates.push(candidate);
		}
		return dedupeCandidates(candidates);
	}
}

export function createResolvedMemoHandle(memo: ResolvedMemo | null): ResolvedMemoHandle | null {
	if (memo === null || memo.kind !== "identified"
		|| memo.capabilities.identity.crossDeviceIdentity !== "ready") return null;
	return {
		memoId: memo.identityHandle.memoId,
		activeBindingId: memo.identityHandle.activeBindingId,
		evidence: observationToIdentityEvidence(memo.observation),
		bindingEvidence: memo.bindingEvidence,
		stateRevision: memo.identityHandle.identityRevision,
	};
}

function getActiveBindingEvidence(
	state: CatalogV2MaterializedState,
	memoId: string,
	bindingId: string,
): IdentityEvidence {
	const binding = state.memos[memoId]?.activeBindingHeads.find((item) => item.entryId === bindingId);
	if (binding === undefined || !isIdentityEvidence(binding.evidence)) {
		throw new Error("Identified memo has no durable active binding evidence.");
	}
	return binding.evidence;
}

export function observationToIdentityEvidence(observation: MemoObservation): IdentityEvidence {
	return {
		sourcePath: observation.sourcePath,
		sourceRevision: observation.sourceRevision,
		logicalDate: observation.logicalDate,
		section: observation.section,
		startLine: observation.startLine,
		endLine: observation.endLine,
		time: observation.time,
		contentHash: observation.contentHash,
		existingBlockId: observation.existingBlockId,
	};
}

function buildCandidates(
	observation: MemoObservation,
	input: CatalogV2IdentityResolverInput,
	identityIndex: CatalogV2IdentityIndex,
): ResolverCandidate[] {
	const candidates: ResolverCandidate[] = [];
	for (const intent of input.localIntents) {
		if (intent.targetPath === observation.sourcePath
			&& (intent.sourceRevision === undefined || intent.sourceRevision === observation.sourceRevision)
			&& intent.logicalDate === observation.logicalDate
			&& intent.time === observation.time
			&& intent.contentHash === observation.contentHash) {
			candidates.push({
				memoId: intent.memoId,
				source: "local_intent",
				priority: 1,
				score: 0,
				durable: false,
				bindingId: null,
				origin: {
					sourcePath: intent.targetPath,
					logicalDate: intent.logicalDate,
					time: intent.time,
				},
			});
		}
	}
	candidates.push(...identityIndex.find(observation));
	return dedupeCandidates(candidates);
}

function matchBinding(
	memoId: string,
	binding: CatalogV2MaterializedIdentityBinding,
	observation: MemoObservation,
	revisionTransitions: readonly CatalogV2FileRevisionTransition[],
): ResolverCandidate | null {
	const evidence = binding.evidence;
	if (binding.source === "state" && isIdentityEvidence(evidence)
		&& sameEvidence(evidence, observation, revisionTransitions)) {
		return {
			memoId,
			source: "state",
			priority: 1,
			score: evidenceScore(evidence, observation),
			durable: true,
			bindingId: binding.entryId,
			origin: evidenceOrigin(evidence),
		};
	}
	if (evidence.sourcePath === observation.sourcePath && evidence.existingBlockId !== null
		&& evidence.existingBlockId === observation.existingBlockId) {
		return {
			memoId,
			source: "existing_block_id",
			priority: evidence.sourcePath === observation.sourcePath ? 2 : 3,
			score: evidenceScore(evidence, observation),
			durable: false,
			bindingId: binding.entryId,
			origin: evidenceOrigin(evidence),
		};
	}
	if (evidence.sourcePath === observation.sourcePath && sameTuple(evidence, observation)) {
		return {
			memoId,
			source: binding.source === "migration" ? "migration" : "tuple",
			priority: binding.source === "migration" ? 4 : 5,
			score: evidenceScore(evidence, observation),
			// 已有 state binding 的正文未变 observation 只跨越文件 revision/行号变化，
			// 不构成新的 claim 或 rebind；重复 tuple 仍由全 Vault 一对一分配保持 ambiguous。
			durable: binding.source === "state" && isIdentityEvidence(evidence)
				&& evidence.section === observation.section
				&& evidence.existingBlockId === observation.existingBlockId
				&& hasUniqueForwardRevisionLineage(evidence, observationToIdentityEvidence(observation), revisionTransitions),
			bindingId: binding.entryId,
			origin: evidenceOrigin(evidence),
		};
	}
	if (evidence.sourcePath === observation.sourcePath && evidence.logicalDate === observation.logicalDate) {
		return {
			memoId,
			source: "manual_successor",
			priority: 6,
			score: evidenceScore(evidence, observation),
			durable: false,
			bindingId: binding.entryId,
			origin: evidenceOrigin(evidence),
		};
	}
	return null;
}

function selectBestCandidates(candidates: readonly ResolverCandidate[]): ResolverCandidate[] {
	const priority = Math.min(...candidates.map((candidate) => candidate.priority));
	if (!Number.isFinite(priority)) return [];
	const prioritized = candidates.filter((candidate) => candidate.priority === priority);
	const score = Math.max(...prioritized.map((candidate) => candidate.score));
	return prioritized.filter((candidate) => candidate.score === score)
		.sort((left, right) => left.memoId.localeCompare(right.memoId));
}

function assignForcedOneToOne(selections: readonly CandidateSelection[]): Map<number, ResolverCandidate> {
	const remaining = new Map<number, ResolverCandidate[]>();
	selections.forEach((selection, index) => remaining.set(index, [...selection.candidates]));
	const assignments = new Map<number, ResolverCandidate>();
	for (;;) {
		const singles = [...remaining.entries()].filter(([, candidates]) => candidates.length === 1);
		const countByMemoId = new Map<string, number>();
		for (const [, [candidate]] of singles) {
			if (candidate !== undefined) countByMemoId.set(candidate.memoId, (countByMemoId.get(candidate.memoId) ?? 0) + 1);
		}
		const forced = singles.find(([, [candidate]]) => candidate !== undefined && countByMemoId.get(candidate.memoId) === 1);
		if (forced === undefined) break;
		const [index, [candidate]] = forced;
		if (candidate === undefined) break;
		assignments.set(index, candidate);
		remaining.delete(index);
		for (const [otherIndex, otherCandidates] of remaining) {
			remaining.set(otherIndex, otherCandidates.filter((item) => item.memoId !== candidate.memoId));
		}
	}
	return assignments;
}

function sameEvidence(
	evidence: IdentityEvidence,
	observation: MemoObservation,
	revisionTransitions: readonly CatalogV2FileRevisionTransition[],
): boolean {
	const target = observationToIdentityEvidence(observation);
	return sameIdentityEvidence(evidence, target)
		|| hasVerifiedRevisionLineage(evidence, target, revisionTransitions);
}

function hasVerifiedRevisionLineage(
	evidence: IdentityEvidence,
	target: IdentityEvidence,
	revisionTransitions: readonly CatalogV2FileRevisionTransition[],
): boolean {
	if (evidence.sourcePath !== target.sourcePath || evidence.logicalDate !== target.logicalDate) return false;
	const nextByRevision = new Map<string, CatalogV2FileRevisionTransition[]>();
	for (const transition of revisionTransitions) {
		if (transition.sourcePath !== evidence.sourcePath) continue;
		nextByRevision.set(transition.beforeRevision, [
			...(nextByRevision.get(transition.beforeRevision) ?? []),
			transition,
		]);
	}
	let current = evidence;
	const visited = new Set<string>();
	while (!visited.has(current.sourceRevision)) {
		if (sameIdentityEvidence(current, target)) return true;
		visited.add(current.sourceRevision);
		const transitions = nextByRevision.get(current.sourceRevision) ?? [];
		if (transitions.length !== 1) return false;
		const next = mapEvidenceAcrossTransition(current, transitions[0] as CatalogV2FileRevisionTransition);
		if (next === null) return false;
		current = next;
	}
	return false;
}

function hasUniqueForwardRevisionLineage(
	evidence: IdentityEvidence,
	target: IdentityEvidence,
	revisionTransitions: readonly CatalogV2FileRevisionTransition[],
): boolean {
	if (evidence.sourcePath !== target.sourcePath || evidence.logicalDate !== target.logicalDate) return false;
	const nextByRevision = new Map<string, Set<string>>();
	for (const transition of revisionTransitions) {
		if (transition.sourcePath !== evidence.sourcePath) continue;
		const next = nextByRevision.get(transition.beforeRevision) ?? new Set<string>();
		next.add(transition.afterRevision);
		nextByRevision.set(transition.beforeRevision, next);
	}
	let revision = evidence.sourceRevision;
	const visited = new Set<string>();
	while (!visited.has(revision)) {
		if (revision === target.sourceRevision) return true;
		visited.add(revision);
		const next = [...(nextByRevision.get(revision) ?? [])];
		if (next.length !== 1) return false;
		revision = next[0] as string;
	}
	return false;
}

function collectRevisionTransitions(state: CatalogV2MaterializedState): CatalogV2FileRevisionTransition[] {
	const transitions = [...(state.fileRevisionTransitions ?? [])];
	const explicitEdges = new Set(transitions.map((transition) => revisionEdgeKey(
		transition.sourcePath,
		transition.beforeRevision,
		transition.afterRevision,
	)));
	for (const memo of Object.values(state.memos)) {
		for (const binding of memo.identityBindings) {
			if (binding.source !== "state" || binding.baseBindingId === null
				|| !isIdentityEvidence(binding.evidence) || binding.baseEvidence === null
				|| binding.baseEvidence === undefined) continue;
			const before = binding.baseEvidence;
			const after = binding.evidence;
			if (before.sourcePath !== after.sourcePath || before.logicalDate !== after.logicalDate
				|| before.sourceRevision === after.sourceRevision) continue;
			const edge = revisionEdgeKey(before.sourcePath, before.sourceRevision, after.sourceRevision);
			if (explicitEdges.has(edge)) continue;
			explicitEdges.add(edge);
			transitions.push({
				sourcePath: before.sourcePath,
				logicalDate: before.logicalDate,
				headings: [],
				beforeRevision: before.sourceRevision,
				afterRevision: after.sourceRevision,
				beforeEvidence: before,
				afterEvidence: after,
				baseBindingId: binding.baseBindingId,
				baseEvidence: before,
				preservedEvidence: [],
			});
		}
	}
	return transitions;
}

function revisionEdgeKey(sourcePath: string, beforeRevision: string, afterRevision: string): string {
	return `${sourcePath}\u0000${beforeRevision}\u0000${afterRevision}`;
}

function mapEvidenceAcrossTransition(
	evidence: IdentityEvidence,
	transition: CatalogV2FileRevisionTransition,
): IdentityEvidence | null {
	const matches: IdentityEvidence[] = [];
	if (transition.beforeEvidence !== null && sameIdentityEvidence(evidence, transition.beforeEvidence)
		&& transition.afterEvidence !== null) {
		matches.push(transition.afterEvidence);
	}
	for (const preserved of transition.preservedEvidence) {
		if (sameIdentityEvidence(evidence, preserved.before)) matches.push(preserved.after);
	}
	const unique = [...new Map(matches.map((candidate) => [identityEvidenceKey(candidate), candidate])).values()];
	return unique.length === 1 ? unique[0] as IdentityEvidence : null;
}

function sameIdentityEvidence(left: IdentityEvidence, right: IdentityEvidence): boolean {
	return identityEvidenceKey(left) === identityEvidenceKey(right);
}

function identityEvidenceKey(evidence: IdentityEvidence): string {
	return [
		evidence.sourcePath,
		evidence.sourceRevision,
		evidence.logicalDate,
		evidence.section ?? "",
		evidence.startLine,
		evidence.endLine,
		evidence.time,
		evidence.contentHash,
		evidence.existingBlockId ?? "",
	].join("\u0000");
}

function sameTuple(evidence: IdentityEvidence | LegacyEvidence, observation: MemoObservation): boolean {
	return evidence.logicalDate === observation.logicalDate
		&& evidence.time === observation.time
		&& evidence.contentHash === observation.contentHash;
}

function evidenceScore(evidence: IdentityEvidence | LegacyEvidence, observation: MemoObservation): number {
	const line = "startLine" in evidence ? evidence.startLine : evidence.lineNumberHint;
	return (evidence.sourcePath === observation.sourcePath ? 1000 : 0)
		+ (evidence.section === observation.section ? 100 : 0)
		+ (evidence.time === observation.time ? 10 : 0)
		- (line === null ? 0 : Math.min(Math.abs(line - observation.startLine), 9));
}

function isIdentityEvidence(evidence: IdentityEvidence | LegacyEvidence): evidence is IdentityEvidence {
	return "sourceRevision" in evidence;
}

function hasActiveDelete(state: CatalogV2MaterializedState, memoId: string): boolean {
	const memo = state.memos[memoId];
	if (memo === undefined) return false;
	return memo.deleteOperationIds.some((deleteOpId) =>
		!memo.restoredDeleteOperationIds.includes(deleteOpId));
}

function hasBlockingStateAttention(state: CatalogV2MaterializedState, memoId: string): boolean {
	return state.quarantine.some((attention) =>
		attention.code === "op_id_collision"
		|| attention.code === "writer_sequence_fork"
		|| (attention.code === "identity_ownership_conflict" && attention.digests.includes(memoId))
		|| ((attention.code === "identity_ambiguous" || attention.code === "relation_conflict"
			|| attention.code === "redirect_conflict" || attention.code === "lifecycle_conflict"
			|| attention.code === "restore_conflict" || attention.code === "restore_missing_delete")
			&& attention.key === memoId));
}

function isSettlementComplete(input: CatalogV2IdentityResolverInput): boolean {
	return isStateReady(input) && input.settlement.migrationComplete;
}

function isStateReady(input: CatalogV2IdentityResolverInput): boolean {
	return input.settlement.stateComplete
		&& input.settlement.revisionStable
		&& input.state.awaitingWriterIds.length === 0;
}

function isMemoStateReady(input: CatalogV2IdentityResolverInput, memoId: string): boolean {
	return isMemoReady(input.state, input.settlement, memoId);
}

function isMemoReady(
	state: CatalogV2MaterializedState,
	settlement: CatalogV2IdentitySettlement,
	memoId: string,
): boolean {
	if (settlement.stateComplete && settlement.revisionStable && state.awaitingWriterIds.length === 0) return true;
	const blockedMemoIds = settlement.blockedMemoIds;
	return settlement.revisionStable
		&& blockedMemoIds !== undefined
		&& blockedMemoIds !== null
		&& !blockedMemoIds.includes(memoId)
		&& !state.forkedWriterIds.length
		&& !hasBlockingStateAttention(state, memoId);
}

function dedupeCandidates(candidates: readonly ResolverCandidate[]): ResolverCandidate[] {
	const result = new Map<string, ResolverCandidate>();
	for (const candidate of candidates) {
		const key = `${candidate.memoId}\u0000${candidate.source}`;
		const current = result.get(key);
		if (current === undefined || candidate.priority < current.priority || candidate.score > current.score) result.set(key, candidate);
	}
	return [...result.values()];
}

function toPublicCandidate(candidate: ResolverCandidate): IdentityCandidate {
	return {
		memoId: candidate.memoId,
		source: candidate.source,
		...(candidate.origin === undefined ? {} : { origin: candidate.origin }),
	};
}

function evidenceOrigin(evidence: IdentityEvidence | LegacyEvidence): NonNullable<IdentityCandidate["origin"]> {
	return {
		sourcePath: evidence.sourcePath,
		logicalDate: evidence.logicalDate,
		time: evidence.time,
	};
}

function dedupePublicCandidates(candidates: readonly IdentityCandidate[]): IdentityCandidate[] {
	return [...new Map(candidates.map((candidate) => [`${candidate.memoId}\u0000${candidate.source}`, candidate])).values()]
		.sort((left, right) => `${left.memoId}\u0000${left.source}`.localeCompare(`${right.memoId}\u0000${right.source}`));
}

function evidenceTupleKey(evidence: IdentityEvidence | LegacyEvidence | MemoObservation): string {
	return `${evidence.sourcePath}\u0000${evidence.logicalDate}\u0000${evidence.time}\u0000${evidence.contentHash}`;
}

function blockIdKey(evidence: IdentityEvidence | LegacyEvidence | MemoObservation): string {
	return `${evidence.sourcePath}\u0000${evidence.existingBlockId ?? ""}`;
}

function observationKey(observation: MemoObservation): string {
	return `${observation.sourcePath}\u0000${observation.startLine.toString().padStart(10, "0")}`;
}

function findKnownPredecessor(
	observation: MemoObservation,
	state: CatalogV2MaterializedState,
	revisionTransitions: readonly CatalogV2FileRevisionTransition[],
): string | null {
	const target = observationToIdentityEvidence(observation);
	const matches: string[] = [];
	for (const memo of Object.values(state.memos)) {
		for (const binding of memo.activeBindingHeads) {
			if (!isIdentityEvidence(binding.evidence)) continue;
			if (hasVerifiedRevisionLineage(target, binding.evidence, revisionTransitions)) {
				matches.push(memo.memoId);
			}
		}
	}
	const unique = [...new Set(matches)];
	return unique.length === 1 ? unique[0] as string : null;
}

function pushMapValue<T>(values: Map<string, T[]>, key: string, value: T): void {
	const current = values.get(key) ?? [];
	current.push(value);
	values.set(key, current);
}

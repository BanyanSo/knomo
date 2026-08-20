import type { ArtifactRef, StateOperation } from "../types/catalogV2";
import type {
	CatalogV2GenerationWriter,
	CatalogV2ImmutableStateSegment,
	CatalogV2StateGeneration,
	CatalogV2VerifiedStateGeneration,
	CatalogV2VerifiedVaultContext,
	CatalogV2WriterHead,
} from "../types/catalogV2Protocol";
import {
	getCatalogWriterHeadPath,
	getCatalogWriterSegmentPath,
} from "../utils/path";
import { canonicalJson, canonicalJsonFileBytes, sha256Bytes } from "./CatalogV2Protocol";
import { CatalogV2VaultProtocol } from "./CatalogV2VaultProtocol";

export type CatalogV2VaultContextProvider = () => CatalogV2VerifiedVaultContext | null | Promise<CatalogV2VerifiedVaultContext | null>;

export class CatalogV2ImmutableStateWriter {
	private appendQueue: Promise<void> = Promise.resolve();

	constructor(
		private readonly protocol: CatalogV2VaultProtocol,
		private readonly getContext: CatalogV2VaultContextProvider,
		private readonly now: () => string = () => new Date().toISOString(),
	) {}

	async getLastSequence(writerId: string, memoId?: string): Promise<number> {
		const context = await this.requireContext();
		const tips = await this.loadVerifiedTips(context, { writerId, memoId: memoId ?? null });
		const merged = mergeVerifiedTips(tips);
		return merged.writerHeads[writerId]?.lastSequence ?? 0;
	}

	async append(operation: StateOperation): Promise<ArtifactRef> {
		return this.runExclusive(() => this.appendExclusive(operation));
	}

	async reconcile(writerId: string): Promise<ArtifactRef | null> {
		return this.runExclusive(async () => {
			const context = await this.requireContext();
			const tips = await this.loadVerifiedTips(context);
			const registration = await this.protocol.ensureWriterRegistration(
				context,
				writerId,
				writerId === context.control.generation.authorityWriterId ? context.bootstrap.createdAt : this.now(),
			);
			const merged = mergeVerifiedTips(tips);
			const existing = merged.writers.find((writer) => writer.writerId === writerId);
			const onlyTip = tips.length === 1 ? tips[0] : undefined;
			if (onlyTip !== undefined && existing !== undefined && sameRef(existing.registration, registration)
				&& sameRef(onlyTip.generation.controlGeneration, context.control.generationRef)
				&& sameRef(onlyTip.generation.contract, context.control.generation.contract)) return null;
			let writers = upsertWriter(merged.writers, {
				writerId,
				registration,
				head: existing?.head ?? null,
				affectedMemoIds: existing?.affectedMemoIds ?? [],
			});
			writers = await this.ensureProjectionAuthority(context, writers);
			return this.protocol.writeGeneration(context, buildGeneration(
				context,
				writerId,
				tips,
				writers,
				merged.mutationCommits,
				merged.mutationMemoIds,
				merged.migrationCommit,
				merged.migrationGenerationDigest,
				merged.migrationMemoIds,
				this.now(),
			));
		});
	}

	async commitMigration(
		writerId: string,
		migrationCommit: ArtifactRef,
		migrationGenerationDigest: string,
		migrationMemoIds: readonly string[],
		supersedes: ArtifactRef | null = null,
	): Promise<ArtifactRef | null> {
		return this.runExclusive(async () => {
			const context = await this.requireContext();
			if (writerId !== context.control.generation.authorityWriterId) {
				throw new Error("Only the current control authority can finalize migration.");
			}
			await this.protocol.authorizeControlAction(context, writerId, {
				actionId: `o_${migrationGenerationDigest.slice(0, 32)}`,
				kind: "migration_finalize",
				inputDigest: migrationGenerationDigest,
				memoIds: migrationMemoIds,
			});
			const refreshed = await this.protocol.loadVaultContext();
			if (refreshed.kind !== "ready") throw new Error("Control commit is not available after migration authorization.");
			const activeContext = refreshed.context;
			const tips = await this.loadVerifiedTips(activeContext);
			const merged = mergeVerifiedTips(tips);
			if (merged.migrationCommit !== null) {
				if (sameRef(merged.migrationCommit, migrationCommit)
					&& merged.migrationGenerationDigest === migrationGenerationDigest) return null;
				if (merged.migrationGenerationDigest === migrationGenerationDigest) {
					if (compareRefs(merged.migrationCommit, migrationCommit) <= 0) return null;
				} else if (supersedes === null || !sameRef(merged.migrationCommit, supersedes)) {
					throw new Error("Migration generation changed before supersession.");
				}
				const nextMemoIds = new Set(migrationMemoIds);
				if (merged.migrationMemoIds.some((memoId) => !nextMemoIds.has(memoId))) {
					throw new Error("Migration generation supersession cannot remove memo scope.");
				}
			} else if (supersedes !== null) {
				throw new Error("Migration generation supersession target is unavailable.");
			}
			const registration = await this.protocol.ensureWriterRegistration(
				activeContext,
				writerId,
				writerId === activeContext.control.generation.authorityWriterId ? activeContext.bootstrap.createdAt : this.now(),
			);
			const current = merged.writers.find((writer) => writer.writerId === writerId);
			let writers = upsertWriter(merged.writers, {
				writerId,
				registration,
				head: current?.head ?? null,
				affectedMemoIds: current?.affectedMemoIds ?? [],
			});
			writers = await this.ensureProjectionAuthority(activeContext, writers);
			return this.protocol.writeGeneration(activeContext, buildGeneration(
				activeContext,
				writerId,
				tips,
				writers,
				merged.mutationCommits,
				merged.mutationMemoIds,
				migrationCommit,
				migrationGenerationDigest,
				[...new Set(migrationMemoIds)].sort(),
				this.now(),
			));
		});
	}

	async commitSharedMutation(
		writerId: string,
		commitRef: ArtifactRef,
		memoIds: readonly string[],
		controlled = false,
	): Promise<ArtifactRef | null> {
		return this.runExclusive(async () => {
			const context = await this.requireContext();
			if (controlled && writerId !== context.control.generation.authorityWriterId) {
				throw new Error("Only the current control authority can publish a shared mutation.");
			}
			const tips = await this.loadVerifiedTips(context);
			const merged = mergeVerifiedTips(tips);
			if (merged.mutationCommits.some((candidate) => sameRef(candidate, commitRef))) return null;
			const registration = await this.protocol.ensureWriterRegistration(context, writerId, this.now());
			const current = merged.writers.find((writer) => writer.writerId === writerId);
			let writers = upsertWriter(merged.writers, {
				writerId,
				registration,
				head: current?.head ?? null,
				affectedMemoIds: current?.affectedMemoIds ?? [],
			});
			writers = await this.ensureProjectionAuthority(context, writers);
			const mutationCommits = uniqueRefs([...merged.mutationCommits, commitRef]);
			const mutationMemoIds = [...new Set([...merged.mutationMemoIds, ...memoIds])].sort();
			return this.protocol.writeGeneration(context, buildGeneration(
				context,
				writerId,
				tips,
				writers,
				mutationCommits,
				mutationMemoIds,
				merged.migrationCommit,
				merged.migrationGenerationDigest,
				merged.migrationMemoIds,
				this.now(),
			));
		});
	}

	private async appendExclusive(operation: StateOperation): Promise<ArtifactRef> {
		if (isControlBoundIdentityOperation(operation)) {
			throw new Error("Controlled identity operations must be committed through a shared mutation.");
		}
		const context = await this.requireContext();
		const tips = await this.loadVerifiedTips(context, {
			writerId: operation.writerId,
			memoId: operation.memoId,
		});
		const merged = mergeVerifiedTips(tips);
		const duplicate = merged.operations.find((candidate) => candidate.opId === operation.opId);
		if (duplicate !== undefined) {
			if (canonicalJson(duplicate) !== canonicalJson(operation)) throw new Error(`State opId collision: ${operation.opId}`);
			return merged.generationRef ?? context.bootstrap.contract;
		}
		const currentHead = merged.writerHeads[operation.writerId] ?? null;
		const expectedSequence = (currentHead?.lastSequence ?? 0) + 1;
		if (operation.sequence !== expectedSequence) {
			throw new Error(`State operation sequence mismatch: expected ${expectedSequence}, received ${operation.sequence}.`);
		}
		const registration = await this.protocol.ensureWriterRegistration(
			context,
			operation.writerId,
			operation.writerId === context.control.generation.authorityWriterId
				? context.bootstrap.createdAt
				: this.now(),
		);
		const previousHeadRef = merged.writers.find((writer) => writer.writerId === operation.writerId)?.head ?? null;
		const segmentValue: CatalogV2ImmutableStateSegment = {
			kind: "knomo.catalog-v2.state-segment",
			schemaVersion: 2,
			vaultInstanceId: context.bootstrap.vaultInstanceId,
			writerId: operation.writerId,
			firstSequence: operation.sequence,
			lastSequence: operation.sequence,
			previousHeadSha256: previousHeadRef?.sha256 ?? null,
			operations: [operation],
		};
		const segmentBytes = canonicalJsonFileBytes(segmentValue);
		const segmentDigest = await sha256Bytes(segmentBytes);
		const segmentRef = await this.protocol.writeImmutable(
			getCatalogWriterSegmentPath(
				context.bootstrap.catalogDataRoot,
				operation.writerId,
				operation.sequence,
				operation.sequence,
				segmentDigest,
			),
			segmentBytes,
		);
		const headValue: CatalogV2WriterHead = {
			kind: "knomo.catalog-v2.writer-head",
			schemaVersion: 2,
			vaultInstanceId: context.bootstrap.vaultInstanceId,
			writerId: operation.writerId,
			firstSequence: operation.sequence,
			lastSequence: operation.sequence,
			previousHead: previousHeadRef,
			segment: segmentRef,
			affectedMemoIds: [operation.memoId],
			committedAt: operation.occurredAt,
		};
		const headBytes = canonicalJsonFileBytes(headValue);
		const headDigest = await sha256Bytes(headBytes);
		const headRef = await this.protocol.writeImmutable(
			getCatalogWriterHeadPath(
				context.bootstrap.catalogDataRoot,
				operation.writerId,
				operation.sequence,
				headDigest,
			),
			headBytes,
		);
		let writers = upsertWriter(merged.writers, {
			writerId: operation.writerId,
			registration,
			head: headRef,
			affectedMemoIds: [...new Set([
				...(merged.writers.find((writer) => writer.writerId === operation.writerId)?.affectedMemoIds ?? []),
				operation.memoId,
			])].sort(),
		});
		writers = await this.ensureProjectionAuthority(context, writers);
		await this.protocol.writeGeneration(
			context,
			buildGeneration(
				context,
				operation.writerId,
				tips,
				writers,
				merged.mutationCommits,
				merged.mutationMemoIds,
				merged.migrationCommit,
				merged.migrationGenerationDigest,
				merged.migrationMemoIds,
				operation.occurredAt,
			),
		);
		return segmentRef;
	}

	private async ensureProjectionAuthority(
		context: CatalogV2VerifiedVaultContext,
		writers: readonly CatalogV2GenerationWriter[],
	): Promise<CatalogV2GenerationWriter[]> {
		const authorityWriterId = context.control.generation.authorityWriterId;
		if (writers.some((writer) => writer.writerId === authorityWriterId)) return [...writers];
		const registration = await this.protocol.ensureWriterRegistration(
			context,
			authorityWriterId,
			context.bootstrap.createdAt,
		);
		return upsertWriter(writers, {
			writerId: authorityWriterId,
			registration,
			head: null,
			affectedMemoIds: [],
		});
	}

	private async loadVerifiedTips(
		context: CatalogV2VerifiedVaultContext,
		allowScopedAwaiting: { writerId: string; memoId: string | null } | null = null,
	): Promise<CatalogV2VerifiedStateGeneration[]> {
		const selection = await this.protocol.selectGeneration(context);
		switch (selection.kind) {
			case "empty":
				return [];
			case "verified":
				return [selection.value];
			case "forked": {
				const results = await Promise.all(selection.generationRefs.map((ref) => this.protocol.verifyGeneration(context, ref)));
				const verified = results.map((result) => {
					if (result.kind !== "verified") throw new Error("State generation changed while merging tips.");
					return result.value;
				});
				return this.filterCurrentControlTips(context, verified);
			}
			case "awaiting_data":
				if (allowScopedAwaiting !== null && selection.verifiedBase !== null
					&& selection.affectedWriterIds !== null && selection.affectedMemoIds !== null
					&& !selection.affectedWriterIds.includes(allowScopedAwaiting.writerId)
					&& (allowScopedAwaiting.memoId === null
						|| !selection.affectedMemoIds.includes(allowScopedAwaiting.memoId))) {
					return [selection.verifiedBase];
				}
				throw new Error(`State generation is awaiting data: ${selection.missingPaths.join(",")}`);
			case "invalid":
				throw new Error(`State generation is invalid: ${selection.reasons.join(",")}`);
		}
	}

	private async filterCurrentControlTips(
		context: CatalogV2VerifiedVaultContext,
		tips: readonly CatalogV2VerifiedStateGeneration[],
	): Promise<CatalogV2VerifiedStateGeneration[]> {
		const current = context.control.generationRef;
		const selected: CatalogV2VerifiedStateGeneration[] = [];
		for (const tip of tips) {
			const control = await this.protocol.findControlGeneration(context, tip.generation.controlGeneration);
			if (control === null) continue;
			if (sameRef(control.generationRef, current)
				|| await this.isControlAncestor(context, control.generationRef, current)) selected.push(tip);
		}
		return selected;
	}

	private async isControlAncestor(
		context: CatalogV2VerifiedVaultContext,
		ancestor: ArtifactRef,
		descendant: ArtifactRef,
	): Promise<boolean> {
		let current: ArtifactRef | null = descendant;
		const visited = new Set<string>();
		while (current !== null && !visited.has(current.sha256)) {
			if (sameRef(current, ancestor)) return true;
			visited.add(current.sha256);
			current = (await this.protocol.findControlGeneration(context, current))?.generation.parent ?? null;
		}
		return false;
	}

	private async requireContext(): Promise<CatalogV2VerifiedVaultContext> {
		const context = await this.getContext();
		if (context === null) throw new Error("Catalog v2 Vault bootstrap is not verified.");
		const selected = await this.protocol.refreshControl(context);
		if (selected.kind !== "verified") throw new Error(`Control generation is not writable: ${selected.kind}.`);
		return { ...context, control: selected.value };
	}

	private async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
		const previous = this.appendQueue;
		let release: () => void = () => undefined;
		this.appendQueue = new Promise<void>((resolve) => { release = resolve; });
		await previous;
		try {
			return await operation();
		} finally {
			release();
		}
	}
}

interface MergedTips {
	writers: CatalogV2GenerationWriter[];
	writerHeads: Record<string, CatalogV2WriterHead | null>;
	operations: StateOperation[];
	generationRef: ArtifactRef | null;
	migrationCommit: ArtifactRef | null;
	migrationGenerationDigest: string | null;
	migrationMemoIds: string[];
	mutationCommits: ArtifactRef[];
	mutationMemoIds: string[];
}

function mergeVerifiedTips(tips: readonly CatalogV2VerifiedStateGeneration[]): MergedTips {
	const writers = new Map<string, CatalogV2GenerationWriter>();
	const writerHeads: Record<string, CatalogV2WriterHead | null> = {};
	const operations = new Map<string, StateOperation>();
	let migrationCommit: ArtifactRef | null = null;
	let migrationGenerationDigest: string | null = null;
	let migrationMemoIds: string[] = [];
	const mutationCommits = new Map<string, ArtifactRef>();
	const mutationMemoIds = new Set<string>();
	for (const tip of tips) {
		for (const ref of tip.generation.mutationCommits ?? []) mutationCommits.set(refKey(ref), ref);
		for (const memoId of tip.generation.mutationMemoIds ?? []) mutationMemoIds.add(memoId);
		if (tip.generation.migrationCommit !== null) {
			if (migrationCommit !== null) {
				if (migrationGenerationDigest !== tip.generation.migrationGenerationDigest
					|| migrationMemoIds.join("\u0000") !== tip.generation.migrationMemoIds.join("\u0000")) {
					throw new Error("Migration generation fork requires manual attention.");
				}
				if (compareRefs(migrationCommit, tip.generation.migrationCommit) > 0) {
					migrationCommit = tip.generation.migrationCommit;
				}
			} else {
				migrationCommit = tip.generation.migrationCommit;
				migrationGenerationDigest = tip.generation.migrationGenerationDigest;
				migrationMemoIds = tip.generation.migrationMemoIds;
			}
		}
		for (const operation of tip.operations) {
			const existing = operations.get(operation.opId);
			if (existing !== undefined && canonicalJson(existing) !== canonicalJson(operation)) {
				throw new Error(`State opId collision while merging generations: ${operation.opId}`);
			}
			operations.set(operation.opId, operation);
		}
		for (const writer of tip.generation.writers) {
			const existing = writers.get(writer.writerId);
			if (existing === undefined) {
				writers.set(writer.writerId, writer);
				writerHeads[writer.writerId] = tip.writerHeads[writer.writerId] ?? null;
				continue;
			}
			if (!sameRef(existing.registration, writer.registration)) {
				throw new Error(`Writer registration fork: ${writer.writerId}`);
			}
			const existingHead = writerHeads[writer.writerId] ?? null;
			const candidateHead = tip.writerHeads[writer.writerId] ?? null;
			const chosen = chooseDescendantHead(writer.writerId, existing, existingHead, writer, candidateHead, operations);
			writers.set(writer.writerId, chosen.writer);
			writerHeads[writer.writerId] = chosen.head;
		}
	}
	return {
		writers: [...writers.values()].sort((left, right) => left.writerId.localeCompare(right.writerId)),
		writerHeads,
		operations: [...operations.values()].sort(compareOperations),
		generationRef: tips.length === 1 ? tips[0]?.generationRef ?? null : null,
		migrationCommit,
		migrationGenerationDigest,
		migrationMemoIds,
		mutationCommits: [...mutationCommits.values()].sort(compareRefs),
		mutationMemoIds: [...mutationMemoIds].sort(),
	};
}

function chooseDescendantHead(
	writerId: string,
	leftWriter: CatalogV2GenerationWriter,
	leftHead: CatalogV2WriterHead | null,
	rightWriter: CatalogV2GenerationWriter,
	rightHead: CatalogV2WriterHead | null,
	operations: ReadonlyMap<string, StateOperation>,
): { writer: CatalogV2GenerationWriter; head: CatalogV2WriterHead | null } {
	if (leftWriter.head === null) return { writer: rightWriter, head: rightHead };
	if (rightWriter.head === null || sameRef(leftWriter.head, rightWriter.head)) return { writer: leftWriter, head: leftHead };
	if (leftHead === null || rightHead === null) throw new Error(`Writer head is unavailable: ${writerId}`);
	const lower = leftHead.lastSequence <= rightHead.lastSequence
		? { writer: leftWriter, head: leftHead }
		: { writer: rightWriter, head: rightHead };
	const higher = leftHead.lastSequence <= rightHead.lastSequence
		? { writer: rightWriter, head: rightHead }
		: { writer: leftWriter, head: leftHead };
	for (let sequence = 1; sequence <= lower.head.lastSequence; sequence += 1) {
		const candidates = [...operations.values()].filter((operation) => operation.writerId === writerId && operation.sequence === sequence);
		if (new Set(candidates.map((operation) => canonicalJson(operation))).size > 1) {
			throw new Error(`Writer sequence fork: ${writerId}:${sequence}`);
		}
	}
	if (higher.head.lastSequence === lower.head.lastSequence) throw new Error(`Writer head fork: ${writerId}`);
	return higher;
}

function buildGeneration(
	context: CatalogV2VerifiedVaultContext,
	writerId: string,
	parents: readonly CatalogV2VerifiedStateGeneration[],
	writers: readonly CatalogV2GenerationWriter[],
	mutationCommits: readonly ArtifactRef[],
	mutationMemoIds: readonly string[],
	migrationCommit: ArtifactRef | null,
	migrationGenerationDigest: string | null,
	migrationMemoIds: readonly string[],
	createdAt: string,
): CatalogV2StateGeneration {
	return {
		kind: "knomo.catalog-v2.state-generation",
		schemaVersion: 2,
		vaultInstanceId: context.bootstrap.vaultInstanceId,
		contract: context.control.generation.contract,
		controlGeneration: context.control.generationRef,
		parents: parents.map((parent) => parent.generationRef).sort(compareRefs),
		writers: [...writers].sort((left, right) => left.writerId.localeCompare(right.writerId)),
		mutationCommits: uniqueRefs(mutationCommits),
		mutationMemoIds: [...new Set(mutationMemoIds)].sort(),
		migrationCommit,
		migrationGenerationDigest,
		migrationMemoIds: [...migrationMemoIds],
		retiredWriterIds: [],
		createdByWriterId: writerId,
		createdAt,
	};
}

function upsertWriter(
	writers: readonly CatalogV2GenerationWriter[],
	value: CatalogV2GenerationWriter,
): CatalogV2GenerationWriter[] {
	return [...writers.filter((writer) => writer.writerId !== value.writerId), value]
		.sort((left, right) => left.writerId.localeCompare(right.writerId));
}

function sameRef(left: ArtifactRef, right: ArtifactRef): boolean {
	return left.path === right.path && left.sha256 === right.sha256 && left.byteLength === right.byteLength;
}

function compareOperations(left: StateOperation, right: StateOperation): number {
	return left.writerId.localeCompare(right.writerId) || left.sequence - right.sequence || left.opId.localeCompare(right.opId);
}

function compareRefs(left: ArtifactRef, right: ArtifactRef): number {
	return left.sha256.localeCompare(right.sha256) || left.path.localeCompare(right.path);
}

function refKey(ref: ArtifactRef): string {
	return `${ref.sha256}\u0000${ref.path}\u0000${ref.byteLength}`;
}

function uniqueRefs(refs: readonly ArtifactRef[]): ArtifactRef[] {
	return [...new Map(refs.map((ref) => [refKey(ref), ref])).values()].sort(compareRefs);
}

function isControlBoundIdentityOperation(operation: StateOperation): boolean {
	return operation.type === "identity.claim" && operation.payload.origin === "manual_adoption"
		|| operation.type === "identity.rebind" && operation.payload.reason === "manual_resolution";
}

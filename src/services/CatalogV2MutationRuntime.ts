import { normalizePath, TFile } from "obsidian";

import type { MemoObservation, ResolvedMemoHandle } from "../types/catalog";
import type {
	ArtifactRef,
	CatalogV2MaterializedDeleteVersion,
	CatalogV2MaterializedState,
	DeletedMemoPayload,
	IdentityEvidence,
} from "../types/catalogV2";
import type {
	CatalogV2PendingTransaction,
	CatalogV2PendingMutationInspection,
	CatalogV2PendingMutationInspectionItem,
	CatalogV2PendingTransactionKind,
	StateOperationDraft,
} from "../types/catalogV2Runtime";
import type {
	CatalogV2ControlPermit,
	CatalogV2MutationPrepareArtifact,
	CatalogV2MutationReplay,
	CatalogV2SharedMutationRecord,
	CatalogV2SharedMutationKind,
	CatalogV2VerifiedVaultContext,
} from "../types/catalogV2Protocol";
import { observationToIdentityEvidence } from "./CatalogV2IdentityResolver";
import type { CatalogV2PreparedDailyWrite } from "./CatalogV2DailyWriteGateway";
import { CatalogV2DailyWriteGateway } from "./CatalogV2DailyWriteGateway";
import type { CatalogV2DeletedPayloadStore } from "./CatalogV2DeletedPayloadStore";
import type { CatalogV2OperationWriter } from "./CatalogV2OperationWriter";
import { createCatalogV2Id } from "./CatalogV2Protocol";
import type { IndexedDbCatalogV2TransactionStore } from "./IndexedDbCatalogV2TransactionStore";
import { deriveObservationMemoId } from "./CatalogV2SharedMutationStore";
import type { CatalogV2SharedMutationStore } from "./CatalogV2SharedMutationStore";

export interface CatalogV2RuntimeIdFactory {
	createMemoId(): string;
	createOperationId(): string;
}

export interface CatalogV2MutationResult {
	dailySaved: true;
	followUpPending: boolean;
}

export interface CatalogV2CreateResult extends CatalogV2MutationResult {
	memoId: string;
	handle: ResolvedMemoHandle | null;
	observation: MemoObservation;
}

export interface CatalogV2EditResult extends CatalogV2MutationResult {
	handle: ResolvedMemoHandle;
}

export interface CatalogV2ReferenceAnchorResult extends CatalogV2EditResult {
	blockId: string;
}

interface DailyMutationInput {
	file: TFile;
	logicalDate: string;
	headings: readonly string[];
}

export interface CatalogV2CreateInput extends DailyMutationInput {
	rawBlock: string;
	sourceMemoId: string | null;
	removeFileOnAbort?: (() => Promise<void>) | null;
	section?: string | null;
}

export interface CatalogV2CopyInput extends CatalogV2CreateInput {
	sourceMemoId: string;
}

export interface CatalogV2MoveInput extends DailyMutationInput {
	handle: ResolvedMemoHandle;
	targetFile: TFile;
	targetLogicalDate: string;
	targetHeadings: readonly string[];
	targetSection?: string | null;
}

export interface CatalogV2ManualRepairInput {
	memoId: string;
	baseBindingId: string;
	baseEvidence: IdentityEvidence;
	targetEvidence: IdentityEvidence;
	control: CatalogV2ControlPermit;
}

export interface CatalogV2AdoptionInput {
	memoId: string;
	evidence: IdentityEvidence;
	control: CatalogV2ControlPermit;
}

export interface CatalogV2EditInput extends DailyMutationInput {
	handle: ResolvedMemoHandle;
	rawBlock: string;
}

export interface CatalogV2TaskInput extends DailyMutationInput {
	handle: ResolvedMemoHandle;
	taskIndex: number;
	checked: boolean;
}

export interface CatalogV2DeleteInput extends DailyMutationInput {
	handle: ResolvedMemoHandle;
	sourceMemoId: string | null;
}

export interface CatalogV2RestoreInput extends DailyMutationInput {
	memoId: string;
	deleteVersion: CatalogV2MaterializedDeleteVersion;
}

export interface CatalogV2PurgeInput {
	memoId: string;
	deleteOpId: string;
	deletedPayload: ArtifactRef;
}

export interface CatalogV2VerifiedRecoveryState {
	state: CatalogV2MaterializedState;
	vaultInstanceId: string;
	contractDigest: string;
	verifiedGenerationId: string;
}

type CatalogV2DailyRevisionState = "before" | "after" | "mixed" | "attention";

export class CatalogV2MutationRuntime {
	constructor(
		private readonly dailyGateway: CatalogV2DailyWriteGateway,
		private readonly transactionStore: IndexedDbCatalogV2TransactionStore,
		private readonly operationWriter: CatalogV2OperationWriter,
		private readonly payloadStore: CatalogV2DeletedPayloadStore,
		private readonly resolveFile: (sourcePath: string) => TFile | null = () => null,
		private readonly ids: CatalogV2RuntimeIdFactory = defaultIdFactory,
		private readonly now: () => string = () => new Date().toISOString(),
		private readonly isCreateIntentDurable: (memoId: string, createIntentOpId: string) => Promise<boolean> = async () => false,
		private readonly sharedMutations: CatalogV2SharedMutationStore | null = null,
		private readonly getVaultContext: () => CatalogV2VerifiedVaultContext | null | Promise<CatalogV2VerifiedVaultContext | null> = () => null,
		private readonly getWriterId: () => Promise<string> = async () => { throw new Error("Catalog v2 writer identity is unavailable."); },
		private readonly bindSharedMutation: (
			writerId: string,
			commit: ArtifactRef,
			memoIds: readonly string[],
			controlled?: boolean,
		) => Promise<unknown> = async () => {
			throw new Error("Catalog v2 shared mutation generation writer is unavailable.");
		},
		private readonly loadVerifiedRecoveryState: () => Promise<CatalogV2VerifiedRecoveryState | null> = async () => null,
	) {}

	async create(input: CatalogV2CreateInput): Promise<CatalogV2CreateResult> {
		return this.createNew(input, "create", "plugin_create");
	}

	async copy(input: CatalogV2CopyInput): Promise<CatalogV2CreateResult> {
		return this.createNew(input, "copy", "explicit_copy");
	}

	private async createNew(
		input: CatalogV2CreateInput,
		kind: "create" | "copy",
		origin: "plugin_create" | "explicit_copy",
	): Promise<CatalogV2CreateResult> {
		let memoId = this.ids.createMemoId();
		const createIntentOpId = this.ids.createOperationId();
		const claimOpId = this.ids.createOperationId();
		const occurredAt = this.now();
		const targetSection = input.section !== undefined ? input.section : input.headings[0] ?? null;
		const prepared = await this.dailyGateway.prepare({
			file: input.file,
			logicalDate: input.logicalDate,
			headings: input.headings,
			expectedRevision: null,
			update: (content, before) => {
				const updated = insertRawBlock(content, input.rawBlock, targetSection);
				if (updated === content || before.observations.some((item) => getRawBlock(content, item) === input.rawBlock)) {
					throw new Error("Create requires one new Daily memo block.");
				}
				return updated;
			},
		});
		const created = findAddedObservation(prepared);
		if (created.existingBlockId !== null) {
			throw new Error("Catalog v2 create must not add a block ID to Daily content.");
		}
		const evidence = observationToIdentityEvidence(created);
		if (this.sharedMutations !== null) {
			const context = await this.getVaultContext();
			if (context === null) throw new Error("Catalog v2 Vault bootstrap is not verified.");
			memoId = await deriveObservationMemoId(
				context.bootstrap.vaultInstanceId,
				context.contractSha256,
				evidence,
			);
		}
		const createIntent: StateOperationDraft = {
			opId: createIntentOpId,
			memoId,
			occurredAt,
			type: "lifecycle.create_intent",
			baseEvidence: null,
			payload: {
				evidence,
				targetPath: normalizePath(input.file.path),
				logicalDate: input.logicalDate,
				time: created.time,
				contentHash: created.contentHash,
				sourceMemoId: input.sourceMemoId,
			},
		};
		const operationDrafts: StateOperationDraft[] = [createIntent, {
			opId: claimOpId,
			memoId,
			occurredAt,
			type: "identity.claim",
			baseEvidence: null,
			payload: { evidence, origin, createIntentOpId, control: null },
		}];
		if (input.sourceMemoId !== null) {
			operationDrafts.push({
				opId: this.ids.createOperationId(),
				memoId,
				occurredAt,
				type: "relation.set_source",
				baseEvidence: null,
				payload: { sourceMemoId: input.sourceMemoId, supersedesRelationIds: [] },
			});
		}
		const pending = createPending(kind, memoId, prepared, operationDrafts, occurredAt, {
			afterRawBlock: getRawBlock(prepared.afterContent, created),
			section: targetSection,
			createIntentOpId,
			createIntentDurable: false,
		});
		try {
			await this.transactionStore.putPending(pending);
		} catch (error) {
			await input.removeFileOnAbort?.().catch(() => undefined);
			throw error;
		}
		try {
			await this.publishSharedPrepare(pending, prepared, null, evidence);
		} catch (error) {
			await this.transactionStore.deletePending(pending.transactionId).catch(() => undefined);
			await input.removeFileOnAbort?.().catch(() => undefined);
			throw error;
		}
		let sharedIntentDurable = this.sharedMutations !== null && pending.sharedPrepare !== undefined;
		if (!sharedIntentDurable) {
			try {
				await this.operationWriter.queue(createIntent);
				const intentFlush = await this.operationWriter.flush();
				sharedIntentDurable = intentFlush.failed === 0;
			} catch {
				sharedIntentDurable = false;
			}
		}
		if (!sharedIntentDurable) {
			// 本机 IndexedDB 不能成为 memoId 的唯一主存；共享 intent 未提交时绝不修改 Daily。
			await this.operationWriter.queue({
				opId: this.ids.createOperationId(),
				memoId,
				occurredAt,
				type: "lifecycle.create_abandon",
				baseEvidence: null,
				payload: { createIntentOpId, reason: "intent_commit_failed" },
			}).catch(() => undefined);
			await this.transactionStore.deletePending(pending.transactionId).catch(() => undefined);
			await input.removeFileOnAbort?.().catch(() => undefined);
			throw new Error("Memo create intent is not durable; Daily was not changed.");
		}
		pending.createIntentDurable = true;
		try {
			if (pending.sharedPrepare === undefined) await this.transactionStore.putPending(pending);
			else await this.transactionStore.putPendingPointer(toPendingPointer(pending));
		} catch (error) {
			await this.abandonPending(pending, "user_cancelled");
			if (this.sharedMutations === null) {
				await this.abandonCreate(pending, createIntentOpId, memoId, occurredAt, "intent_commit_failed");
			}
			await input.removeFileOnAbort?.().catch(() => undefined);
			throw error;
		}
		try {
			await this.dailyGateway.commit(prepared);
		} catch (error) {
			await this.abandonPending(pending, "daily_write_failed");
			if (this.sharedMutations === null) await this.abandonCreate(pending, createIntentOpId, memoId, occurredAt);
			await input.removeFileOnAbort?.().catch(() => undefined);
			throw error;
		}
		const finalized = sharedIntentDurable && await this.finalizePending(pending);
		return {
			memoId,
			handle: null,
			observation: created,
			dailySaved: true,
			followUpPending: !finalized,
		};
	}

	async edit(input: CatalogV2EditInput): Promise<CatalogV2EditResult> {
		return this.replaceIdentifiedBlock(input, () => input.rawBlock);
	}

	async toggleTask(input: CatalogV2TaskInput): Promise<CatalogV2EditResult> {
		return this.replaceIdentifiedBlock(input, (rawBlock, observation) => {
			const task = observation.tasks.find((item) => item.taskIndex === input.taskIndex);
			if (task === undefined) throw new Error(`Task is not present in the current Daily revision: ${input.taskIndex}`);
			return toggleRawBlockTask(rawBlock, task.lineOffset, input.checked);
		});
	}

	async move(input: CatalogV2MoveInput): Promise<CatalogV2EditResult> {
		assertHandlePath(input.handle, input.file);
		if (normalizePath(input.file.path) === normalizePath(input.targetFile.path)) {
			throw new Error("Move target must be another Daily file.");
		}
		let rawBlock = "";
		const sourcePrepared = await this.dailyGateway.prepare({
			file: input.file,
			logicalDate: input.logicalDate,
			headings: input.headings,
			expectedRevision: input.handle.evidence.sourceRevision,
			update: (content, parsed) => {
				const observation = findHandleObservation(parsed.observations, input.handle.evidence);
				rawBlock = getRawBlock(content, observation);
				return replaceObservation(content, observation, "", true);
			},
		});
		const targetSection = input.targetSection !== undefined
			? input.targetSection
			: input.targetHeadings[0] ?? null;
		const targetPrepared = await this.dailyGateway.prepare({
			file: input.targetFile,
			logicalDate: input.targetLogicalDate,
			headings: input.targetHeadings,
			expectedRevision: null,
			update: (content, parsed) => {
				const blockId = input.handle.evidence.existingBlockId;
				if (blockId !== null && parsed.observations.some((observation) => observation.existingBlockId === blockId)) {
					throw new Error("Moved Obsidian block ID already exists in the target Daily file.");
				}
				return insertRawBlock(content, rawBlock, targetSection);
			},
		});
		const targetMatches = targetPrepared.after.observations.filter((observation) =>
			getRawBlock(targetPrepared.afterContent, observation) === rawBlock);
		if (targetMatches.length !== 1) throw new Error("Moved Daily block is not unique at the target.");
		const targetEvidence = observationToIdentityEvidence(targetMatches[0] as MemoObservation);
		const occurredAt = this.now();
		const rebindOpId = this.ids.createOperationId();
		const operationDrafts: StateOperationDraft[] = [{
			opId: rebindOpId,
			memoId: input.handle.memoId,
			occurredAt,
			type: "identity.rebind",
			baseEvidence: input.handle.bindingEvidence,
			payload: {
				baseBindingId: input.handle.activeBindingId,
				evidence: targetEvidence,
				reason: "move",
				control: null,
			},
		}];
		const pending = createPending("edit", input.handle.memoId, sourcePrepared, operationDrafts, occurredAt, {
			beforeRawBlock: rawBlock,
			afterRawBlock: rawBlock,
		});
		await this.transactionStore.putPending(pending);
		if (this.sharedMutations === null) throw new Error("Cross-file move requires shared mutation recovery.");
		const context = await this.getVaultContext();
		if (context === null) throw new Error("Catalog v2 Vault bootstrap is not verified.");
		const prepare: CatalogV2MutationPrepareArtifact = {
			kind: "knomo.catalog-v2.mutation-prepare",
			schemaVersion: 2,
			vaultInstanceId: context.bootstrap.vaultInstanceId,
			mutationId: mutationIdFromPending(pending),
			mutationKind: "move",
			memoId: input.handle.memoId,
			changes: [{
				transition: transitionFromPrepared(targetPrepared, null, targetEvidence, null, null),
				replay: { kind: "insert", rawBlock, section: targetSection },
			}, {
				transition: transitionFromPrepared(
					sourcePrepared,
					input.handle.evidence,
					null,
					input.handle.activeBindingId,
					input.handle.bindingEvidence,
				),
				replay: { kind: "remove", beforeRawBlock: rawBlock },
			}],
			effectDrafts: operationDrafts,
			preparedByWriterId: await this.getWriterId(),
			preparedAt: occurredAt,
		};
		try {
			pending.sharedPrepare = await this.sharedMutations.prepare(prepare);
			await this.transactionStore.putPendingPointer(toPendingPointer(pending));
		} catch (error) {
			await this.transactionStore.deletePending(pending.transactionId).catch(() => undefined);
			throw error;
		}
		try {
			await this.dailyGateway.commit(targetPrepared);
		} catch (error) {
			await this.abandonPending(pending, "daily_write_failed");
			throw error;
		}
		const movedHandle: ResolvedMemoHandle = {
			memoId: input.handle.memoId,
			activeBindingId: rebindOpId,
			evidence: targetEvidence,
			bindingEvidence: targetEvidence,
			stateRevision: targetEvidence.sourceRevision,
		};
		// 目标已落盘就是正文成功边界；来源删除失败保留 prepare，由恢复流程继续，不能向 UI 报整次移动失败。
		try {
			await this.dailyGateway.commit(sourcePrepared);
		} catch {
			return { handle: movedHandle, dailySaved: true, followUpPending: true };
		}
		return {
			handle: movedHandle,
			dailySaved: true,
			followUpPending: !await this.finalizePending(pending),
		};
	}

	async manualRepair(input: CatalogV2ManualRepairInput): Promise<void> {
		if (input.control.actionKind !== "identity_repair") throw new Error("Manual repair requires an identity repair control permit.");
		if (this.sharedMutations === null) throw new Error("Manual repair requires shared mutation recovery.");
		const context = await this.getVaultContext();
		if (context === null || input.control.vaultInstanceId !== context.bootstrap.vaultInstanceId) {
			throw new Error("Manual repair control permit belongs to another Vault.");
		}
		const mutationId = input.control.actionId;
		const draft: StateOperationDraft = {
			opId: mutationId,
			memoId: input.memoId,
			occurredAt: input.control.authorizedAt,
			type: "identity.rebind",
			baseEvidence: input.baseEvidence,
			payload: {
				baseBindingId: input.baseBindingId,
				evidence: input.targetEvidence,
				reason: "manual_resolution",
				control: null,
			},
		};
		const prepareRef = await this.sharedMutations.prepare({
			kind: "knomo.catalog-v2.mutation-prepare",
			schemaVersion: 2,
			vaultInstanceId: context.bootstrap.vaultInstanceId,
			mutationId,
			mutationKind: "manual_repair",
			memoId: input.memoId,
			changes: [],
			effectDrafts: [draft],
			preparedByWriterId: input.control.authorityWriterId,
			preparedAt: draft.occurredAt,
		});
		const commitRef = await this.sharedMutations.commit({
			kind: "knomo.catalog-v2.mutation-commit",
			schemaVersion: 2,
			vaultInstanceId: context.bootstrap.vaultInstanceId,
			mutationId,
			prepare: prepareRef,
			control: input.control,
		});
		await this.bindSharedMutation(await this.getWriterId(), commitRef, [input.memoId], true);
	}

	async adopt(input: CatalogV2AdoptionInput): Promise<void> {
		if (input.control.actionKind !== "identity_adoption") {
			throw new Error("Manual adoption requires an identity adoption control permit.");
		}
		if (this.sharedMutations === null) throw new Error("Manual adoption requires shared mutation recovery.");
		const context = await this.getVaultContext();
		if (context === null || input.control.vaultInstanceId !== context.bootstrap.vaultInstanceId) {
			throw new Error("Manual adoption control permit belongs to another Vault.");
		}
		const mutationId = input.control.actionId;
		const draft: StateOperationDraft = {
			opId: mutationId,
			memoId: input.memoId,
			occurredAt: input.control.authorizedAt,
			type: "identity.claim",
			baseEvidence: null,
			payload: {
				evidence: input.evidence,
				origin: "manual_adoption",
				createIntentOpId: null,
				control: null,
			},
		};
		const prepareRef = await this.sharedMutations.prepare({
			kind: "knomo.catalog-v2.mutation-prepare",
			schemaVersion: 2,
			vaultInstanceId: context.bootstrap.vaultInstanceId,
			mutationId,
			mutationKind: "adoption",
			memoId: input.memoId,
			changes: [],
			effectDrafts: [draft],
			preparedByWriterId: input.control.authorityWriterId,
			preparedAt: draft.occurredAt,
		});
		const commitRef = await this.sharedMutations.commit({
			kind: "knomo.catalog-v2.mutation-commit",
			schemaVersion: 2,
			vaultInstanceId: context.bootstrap.vaultInstanceId,
			mutationId,
			prepare: prepareRef,
			control: input.control,
		});
		await this.bindSharedMutation(await this.getWriterId(), commitRef, [input.memoId], true);
	}

	async ensureReferenceAnchor(input: CatalogV2EditInput, blockId: string): Promise<CatalogV2ReferenceAnchorResult> {
		if (!/^[A-Za-z0-9-]+$/u.test(blockId)) throw new Error("Reference block ID contains unsupported characters.");
		assertHandlePath(input.handle, input.file);
		let beforeRawBlock = "";
		let afterRawBlock = "";
		let afterObservation: MemoObservation | null = null;
		const prepared = await this.dailyGateway.prepare({
			file: input.file,
			logicalDate: input.logicalDate,
			headings: input.headings,
			expectedRevision: input.handle.evidence.sourceRevision,
			update: (content, parsed) => {
				const observation = findHandleObservation(parsed.observations, input.handle.evidence);
				if (observation.existingBlockId !== null) {
					beforeRawBlock = getRawBlock(content, observation);
					afterRawBlock = beforeRawBlock;
					return content;
				}
				if (new RegExp(`(?:^|[^A-Za-z0-9_-])\\^${escapeRegExp(blockId)}\\b`, "u").test(content)) {
					throw new Error("Reference block ID already exists in the Daily note.");
				}
				beforeRawBlock = getRawBlock(content, observation);
				afterRawBlock = appendReferenceBlockId(beforeRawBlock, blockId);
				return replaceObservation(content, observation, afterRawBlock, false);
			},
		});
		const beforeObservation = findHandleObservation(prepared.before.observations, input.handle.evidence);
		if (beforeObservation.existingBlockId !== null) {
			return {
				blockId: beforeObservation.existingBlockId,
				handle: input.handle,
				dailySaved: true,
				followUpPending: false,
			};
		}
		const candidates = prepared.after.observations.filter((item) =>
			item.startLine === beforeObservation.startLine
			&& item.contentHash === beforeObservation.contentHash
			&& item.existingBlockId === blockId);
		if (candidates.length !== 1) throw new Error("Referenced Daily block is not unique after adding its anchor.");
		afterObservation = candidates[0] ?? null;
		const evidence = observationToIdentityEvidence(afterObservation);
		const occurredAt = this.now();
		const rebindOpId = this.ids.createOperationId();
		const operationDrafts: StateOperationDraft[] = [{
			opId: rebindOpId,
			memoId: input.handle.memoId,
			occurredAt,
				type: "identity.rebind",
				baseEvidence: input.handle.bindingEvidence,
			payload: { baseBindingId: input.handle.activeBindingId, evidence, reason: "edit" },
		}];
		const pending = createPending("edit", input.handle.memoId, prepared, operationDrafts, occurredAt, {
			beforeRawBlock,
			afterRawBlock,
		});
		await this.transactionStore.putPending(pending);
		await this.publishSharedPrepare(pending, prepared, input.handle, evidence);
		await this.commitDaily(pending, prepared);
		return {
			blockId,
				handle: {
				memoId: input.handle.memoId,
				activeBindingId: rebindOpId,
				evidence,
				bindingEvidence: evidence,
				stateRevision: evidence.sourceRevision,
			},
			dailySaved: true,
			followUpPending: !await this.finalizePending(pending),
		};
	}

	async delete(input: CatalogV2DeleteInput): Promise<CatalogV2MutationResult> {
		assertHandlePath(input.handle, input.file);
		const deleteOpId = this.ids.createOperationId();
		const deletedAt = this.now();
		const prepared = await this.dailyGateway.prepare({
			file: input.file,
			logicalDate: input.logicalDate,
			headings: input.headings,
			expectedRevision: input.handle.evidence.sourceRevision,
			update: (content, parsed) => {
				const observation = findHandleObservation(parsed.observations, input.handle.evidence);
				return replaceObservation(content, observation, "", true);
			},
		});
		const deletedObservation = findHandleObservation(prepared.before.observations, input.handle.evidence);
		const deletedRawBlock = getRawBlock(prepared.beforeContent, deletedObservation);
		const payload: DeletedMemoPayload = {
			kind: "knomo.catalog-v2.deleted-payload",
			schemaVersion: 1,
			memoId: input.handle.memoId,
			deleteOpId,
			deletedAt,
			sourcePath: normalizePath(input.file.path),
			logicalDate: input.logicalDate,
			section: deletedObservation.section,
			rawBlock: deletedRawBlock,
			contentHash: deletedObservation.contentHash,
			sourceMemoId: input.sourceMemoId,
		};
		const deletedPayload = await this.payloadStore.write(payload);
		const operationDrafts: StateOperationDraft[] = [{
			opId: deleteOpId,
			memoId: input.handle.memoId,
			occurredAt: deletedAt,
			type: "lifecycle.delete",
			baseEvidence: input.handle.bindingEvidence,
			payload: {
				baseBindingId: input.handle.activeBindingId,
				deleteOpId,
				deletedPayload,
			},
		}];
		const pending = createPending("delete", input.handle.memoId, prepared, operationDrafts, deletedAt, {
			beforeRawBlock: deletedRawBlock,
		});
		await this.transactionStore.putPending(pending);
		await this.publishSharedPrepare(pending, prepared, input.handle, null);
		await this.commitDaily(pending, prepared);
		return { dailySaved: true, followUpPending: !await this.finalizePending(pending) };
	}

	async restore(input: CatalogV2RestoreInput): Promise<CatalogV2EditResult> {
		const payload = await this.payloadStore.read(input.deleteVersion.payload);
		if (payload.memoId !== input.memoId || payload.deleteOpId !== input.deleteVersion.deleteOpId) {
			throw new Error("Restore payload does not match the selected delete version.");
		}
		let restoredObservation: MemoObservation | null = null;
		const targetSection = payload.section ?? input.headings[0] ?? null;
		const prepared = await this.dailyGateway.prepare({
			file: input.file,
			logicalDate: input.logicalDate,
			headings: input.headings,
			expectedRevision: null,
			update: (content, parsed) => {
				const exact = parsed.observations.filter((item) => getRawBlock(content, item) === payload.rawBlock);
				if (exact.length > 1) throw new Error("Restore target is ambiguous.");
				return exact.length === 1 ? content : insertRawBlock(content, payload.rawBlock, targetSection);
			},
		});
		const matches = prepared.after.observations.filter((item) => (
			item.time === readRawBlockTime(payload.rawBlock) && item.contentHash === payload.contentHash
		));
		if (matches.length !== 1) throw new Error("Restored Daily block is not unique.");
		restoredObservation = matches[0] ?? null;
		const evidence = observationToIdentityEvidence(restoredObservation);
		const occurredAt = this.now();
		const restoreOpId = this.ids.createOperationId();
		const operationDrafts: StateOperationDraft[] = [{
			opId: restoreOpId,
			memoId: input.memoId,
			occurredAt,
			type: "lifecycle.restore",
			baseEvidence: null,
			payload: {
				baseBindingId: input.deleteVersion.baseBindingId,
				deleteOpId: input.deleteVersion.deleteOpId,
				evidence,
			},
		}];
		const pending = createPending("restore", input.memoId, prepared, operationDrafts, occurredAt, {
			afterRawBlock: getRawBlock(prepared.afterContent, restoredObservation),
			section: targetSection,
		});
		await this.transactionStore.putPending(pending);
		await this.publishSharedPrepare(pending, prepared, null, evidence);
		await this.commitDaily(pending, prepared);
		return {
				handle: {
				memoId: input.memoId,
				activeBindingId: restoreOpId,
				evidence,
				bindingEvidence: evidence,
				stateRevision: evidence.sourceRevision,
			},
			dailySaved: true,
			followUpPending: !await this.finalizePending(pending),
		};
	}

	async purge(input: CatalogV2PurgeInput): Promise<void> {
		await this.operationWriter.queue({
			opId: this.ids.createOperationId(),
			memoId: input.memoId,
			occurredAt: this.now(),
			type: "lifecycle.purge",
			baseEvidence: null,
			payload: { deleteOpId: input.deleteOpId },
		});
		await this.operationWriter.flush();
	}

	async setSource(handle: ResolvedMemoHandle, sourceMemoId: string | null, supersedesRelationIds: string[]): Promise<void> {
		await this.operationWriter.queue({
			opId: this.ids.createOperationId(),
			memoId: handle.memoId,
			occurredAt: this.now(),
			type: "relation.set_source",
			baseEvidence: null,
			payload: { sourceMemoId, supersedesRelationIds: [...supersedesRelationIds] },
		});
		await this.operationWriter.flush();
	}

	async recordReview(handle: ResolvedMemoHandle, reviewedAt = this.now()): Promise<void> {
		await this.operationWriter.queue({
			opId: this.ids.createOperationId(),
			memoId: handle.memoId,
			occurredAt: this.now(),
			type: "review.record",
			baseEvidence: null,
			payload: { reviewedAt },
		});
		await this.operationWriter.flush();
	}

	async inspectPending(): Promise<CatalogV2PendingMutationInspection> {
		const local = await this.transactionStore.listPending();
		const sharedInspection = this.sharedMutations === null ? null : await this.sharedMutations.inspect();
		const sharedByMutationId = new Map(sharedInspection?.records.map((record) => [record.mutationId, record]) ?? []);
		const localByMutationId = new Map(local.flatMap((pending) => {
			try {
				return [[mutationIdFromPending(pending), pending] as const];
			} catch {
				return [];
			}
		}));
		const items: CatalogV2PendingMutationInspectionItem[] = [];
		for (const pending of local) {
			let mutationId: string;
			try {
				mutationId = mutationIdFromPending(pending);
			} catch {
				items.push(toPendingInspectionItem(pending, null, "attention", ["legacy_pending"]));
				continue;
			}
			const record = sharedByMutationId.get(mutationId) ?? null;
			if (pending.sharedPrepare === undefined) {
				const localRevision = await this.inspectLocalPendingDailyRevision(pending);
				items.push(toPendingInspectionItem(
					pending,
					mutationId,
					localRevision === "after" ? "daily_after" : "attention",
					localRevision === "after" ? ["legacy_pending_readonly"] : ["legacy_pending_unverified"],
				));
				continue;
			}
			if (record === null) {
				items.push(toPendingInspectionItem(pending, mutationId, "attention", ["shared_prepare_unavailable"]));
				continue;
			}
			if (record.abandon !== null) {
				items.push(toPendingInspectionItem(pending, mutationId, "abandoned", []));
				continue;
			}
			const revisionState = await this.inspectDailyRevision(record.prepare);
			const status = revisionState === "after"
				? record.commitRef === null ? "daily_after" : "committed_unbound"
				: revisionState === "before" ? "prepared" : "attention";
			items.push(toPendingInspectionItem(
				pending,
				mutationId,
				status,
				revisionState === "mixed" ? ["daily_partial"]
					: revisionState === "attention" ? ["daily_revision_unknown"] : [],
			));
		}
		for (const record of sharedInspection?.records ?? []) {
			if (localByMutationId.has(record.mutationId)) continue;
			const revisionState = await this.inspectDailyRevision(record.prepare);
			items.push({
				mutationId: record.mutationId,
				transactionId: null,
				memoId: record.prepare.memoId,
				status: record.abandon !== null ? "abandoned"
					: revisionState === "after" && record.commitRef !== null ? "committed_unbound"
						: revisionState === "after" ? "daily_after"
							: revisionState === "before" ? "prepared" : "attention",
				paths: uniqueSorted(record.prepare.changes.map((change) => change.transition.sourcePath)),
				reasons: revisionState === "mixed" ? ["daily_partial"]
					: revisionState === "attention" ? ["daily_revision_unknown"] : [],
			});
		}
		for (const issue of sharedInspection?.issues ?? []) {
			if (items.some((item) => item.mutationId === issue.mutationId)) continue;
			items.push({
				mutationId: issue.mutationId,
				transactionId: null,
				memoId: issue.memoIds[0] ?? null,
				status: "attention",
				paths: [...issue.paths],
				reasons: [issue.kind],
			});
		}
		return {
			items: items.sort((left, right) => left.mutationId.localeCompare(right.mutationId)
				|| (left.transactionId ?? "").localeCompare(right.transactionId ?? "")),
			affectedPaths: uniqueSorted([
				...items.flatMap((item) => item.paths),
				...(sharedInspection?.affectedPaths ?? []),
			]),
			affectedMemoIds: uniqueSorted([
				...items.flatMap((item) => item.memoId === null ? [] : [item.memoId]),
				...(sharedInspection?.affectedMemoIds ?? []),
			]),
		};
	}

	async finishForeground(transactionId: string): Promise<boolean> {
		const pending = (await this.transactionStore.listPending())
			.find((candidate) => candidate.transactionId === transactionId);
		if (pending === undefined) return false;
		return this.finalizePending(pending);
	}

	async recoverExplicit(mutationId: string, action: "continue" | "abandon"): Promise<boolean> {
		if (this.sharedMutations === null) return false;
		const record = (await this.sharedMutations.inspect()).records.find((candidate) => candidate.mutationId === mutationId);
		if (record === undefined || record.abandon !== null) return false;
		const local = (await this.transactionStore.listPending()).find((pending) => {
			try {
				return mutationIdFromPending(pending) === mutationId;
			} catch {
				return false;
			}
		});
		if (action === "abandon") {
			if (record.commitRef !== null || await this.inspectDailyRevision(record.prepare) !== "before") return false;
			const context = await this.getVaultContext();
			if (context === null || context.bootstrap.vaultInstanceId !== record.prepare.vaultInstanceId) return false;
			await this.sharedMutations.abandon({
				kind: "knomo.catalog-v2.mutation-abandon",
				schemaVersion: 2,
				vaultInstanceId: context.bootstrap.vaultInstanceId,
				mutationId,
				prepare: record.prepareRef,
				reason: "user_cancelled",
			});
			if (local !== undefined) await this.transactionStore.deletePending(local.transactionId);
			return true;
		}
		if (!await this.validateExplicitRecovery(record.prepare)) return false;
		if (local !== undefined && await this.inspectDailyRevision(record.prepare) === "after") {
			return this.finalizePending(local);
		}
		return this.continueSharedMutation(record);
	}

	private async replaceIdentifiedBlock(
		input: CatalogV2EditInput | CatalogV2TaskInput,
		updateRawBlock: (rawBlock: string, observation: MemoObservation) => string,
	): Promise<CatalogV2EditResult> {
		assertHandlePath(input.handle, input.file);
		const prepared = await this.dailyGateway.prepare({
			file: input.file,
			logicalDate: input.logicalDate,
			headings: input.headings,
			expectedRevision: input.handle.evidence.sourceRevision,
			update: (content, parsed) => {
				const observation = findHandleObservation(parsed.observations, input.handle.evidence);
				const beforeRawBlock = getRawBlock(content, observation);
				const afterRawBlock = updateRawBlock(beforeRawBlock, observation);
				return replaceObservation(content, observation, afterRawBlock, false);
			},
		});
		const candidates = prepared.after.observations.filter((item) => item.startLine === input.handle.evidence.startLine);
		if (candidates.length !== 1) throw new Error("Edited Daily block is not unique.");
		const afterObservation = candidates[0] as MemoObservation;
		if (afterObservation.existingBlockId !== input.handle.evidence.existingBlockId) {
			throw new Error("Catalog v2 edits must preserve any pre-existing block ID without adding one.");
		}
		const evidence = observationToIdentityEvidence(afterObservation);
		const occurredAt = this.now();
		const rebindOpId = this.ids.createOperationId();
		const operationDrafts: StateOperationDraft[] = [{
			opId: rebindOpId,
			memoId: input.handle.memoId,
			occurredAt,
			type: "identity.rebind",
			baseEvidence: input.handle.bindingEvidence,
			payload: {
				baseBindingId: input.handle.activeBindingId,
				evidence,
				reason: "edit",
			},
		}];
		await this.dailyGateway.commit(prepared);
		let followUpPending = false;
		try {
			for (const draft of operationDrafts) await this.operationWriter.queue(draft);
			followUpPending = (await this.operationWriter.flush()).failed > 0;
		} catch {
			// Daily 已提交即为正文保存成功；identity evidence 可由 outbox 重试，失败时安全隔离。
			followUpPending = true;
		}
		return {
				handle: {
				memoId: input.handle.memoId,
				activeBindingId: rebindOpId,
				evidence,
				bindingEvidence: evidence,
				stateRevision: evidence.sourceRevision,
			},
			dailySaved: true,
			followUpPending,
		};
	}

	private async finalizePending(pending: CatalogV2PendingTransaction): Promise<boolean> {
		try {
			const sharedRecord = pending.sharedPrepare === undefined || this.sharedMutations === null
				? null
				: (await this.sharedMutations.inspect()).records.find((record) => record.mutationId === mutationIdFromPending(pending)) ?? null;
			if (pending.sharedPrepare !== undefined && this.sharedMutations !== null) {
				if (sharedRecord === null || sharedRecord.abandon !== null) throw new Error("Shared mutation prepare is unavailable or abandoned.");
				await this.assertSharedChangesCommitted(sharedRecord.prepare);
				const writerId = await this.getWriterId();
				let commitRef = sharedRecord.commitRef;
				if (commitRef === null) {
					const context = await this.getVaultContext();
					if (context === null) throw new Error("Catalog v2 Vault bootstrap is not verified.");
					commitRef = await this.sharedMutations.commit({
						kind: "knomo.catalog-v2.mutation-commit",
						schemaVersion: 2,
						vaultInstanceId: context.bootstrap.vaultInstanceId,
						mutationId: mutationIdFromPending(pending),
						prepare: pending.sharedPrepare,
						control: null,
					});
				}
				await this.bindSharedMutation(
					writerId,
					commitRef,
					mutationMemoIds(sharedRecord.prepare),
					isControlledMutation(sharedRecord.prepare),
				);
			} else {
				for (const draft of pending.operationDrafts) {
					if (pending.kind === "create" && draft.type === "lifecycle.create_intent") continue;
					await this.operationWriter.queue(draft);
				}
			}
			await this.transactionStore.deletePending(pending.transactionId);
			return true;
		} catch {
			return false;
		}
	}

	private async assertSharedChangesCommitted(prepare: CatalogV2MutationPrepareArtifact): Promise<void> {
		for (const change of prepare.changes) {
			const file = this.resolveFile(change.transition.sourcePath);
			if (!(file instanceof TFile)) throw new Error("Shared mutation Daily file is unavailable.");
			const current = await this.dailyGateway.prepare({
				file,
				logicalDate: change.transition.logicalDate,
				headings: change.transition.headings,
				expectedRevision: null,
				update: (content) => content,
			});
			if (current.before.sourceRevision !== change.transition.afterRevision) {
				throw new Error("Shared mutation Daily revision changed before commit.");
			}
		}
	}

	private async commitDaily(
		pending: CatalogV2PendingTransaction,
		prepared: CatalogV2PreparedDailyWrite,
	): Promise<void> {
		try {
			await this.dailyGateway.commit(prepared);
		} catch (error) {
			await this.abandonPending(pending, "daily_write_failed");
			throw error;
		}
	}

	private async publishSharedPrepare(
		pending: CatalogV2PendingTransaction,
		prepared: CatalogV2PreparedDailyWrite,
		handle: ResolvedMemoHandle | null,
		afterEvidence: IdentityEvidence | null,
	): Promise<void> {
		if (this.sharedMutations === null) return;
		const context = await this.getVaultContext();
		if (context === null) throw new Error("Catalog v2 Vault bootstrap is not verified.");
		const writerId = await this.getWriterId();
		const artifact: CatalogV2MutationPrepareArtifact = {
			kind: "knomo.catalog-v2.mutation-prepare",
			schemaVersion: 2,
			vaultInstanceId: context.bootstrap.vaultInstanceId,
			mutationId: mutationIdFromPending(pending),
			mutationKind: pending.kind as CatalogV2SharedMutationKind,
			memoId: pending.memoId,
			changes: [{
				transition: transitionFromPrepared(
					prepared,
					handle?.evidence ?? null,
					afterEvidence,
					handle?.activeBindingId ?? null,
					handle?.bindingEvidence ?? null,
				),
				replay: replayFromPending(pending),
			}],
			effectDrafts: pending.operationDrafts,
			preparedByWriterId: writerId,
			preparedAt: pending.createdAt,
		};
		try {
			pending.sharedPrepare = await this.sharedMutations.prepare(artifact);
			await this.transactionStore.putPendingPointer(toPendingPointer(pending));
		} catch (error) {
			await this.transactionStore.deletePending(pending.transactionId).catch(() => undefined);
			throw error;
		}
	}

	private async inspectDailyRevision(
		prepare: CatalogV2MutationPrepareArtifact,
	): Promise<CatalogV2DailyRevisionState> {
		if (prepare.changes.length === 0) return "after";
		const states: Array<"before" | "after"> = [];
		try {
			for (const change of prepare.changes) {
				const file = this.resolveFile(change.transition.sourcePath);
				if (!(file instanceof TFile)) return "attention";
				const current = await this.dailyGateway.prepare({
					file,
					logicalDate: change.transition.logicalDate,
					headings: change.transition.headings,
					expectedRevision: null,
					update: (content) => content,
				});
				if (current.before.sourceRevision === change.transition.beforeRevision) states.push("before");
				else if (current.before.sourceRevision === change.transition.afterRevision) states.push("after");
				else return "attention";
			}
		} catch {
			return "attention";
		}
		return states.every((state) => state === "before") ? "before"
			: states.every((state) => state === "after") ? "after" : "mixed";
	}

	private async inspectLocalPendingDailyRevision(
		pending: CatalogV2PendingTransaction,
	): Promise<"before" | "after" | "attention"> {
		try {
			const current = await this.dailyGateway.prepare({
				file: await this.getPendingFile(pending),
				logicalDate: pending.logicalDate,
				headings: pending.headings ?? [],
				expectedRevision: null,
				update: (content) => content,
			});
			return current.before.sourceRevision === pending.afterRevision ? "after"
				: current.before.sourceRevision === pending.beforeRevision ? "before" : "attention";
		} catch {
			return "attention";
		}
	}

	private async validateExplicitRecovery(prepare: CatalogV2MutationPrepareArtifact): Promise<boolean> {
		const context = await this.getVaultContext();
		if (context === null || context.bootstrap.vaultInstanceId !== prepare.vaultInstanceId) return false;
		if (await this.inspectDailyRevision(prepare) === "attention") return false;
		const recoveryState = await this.loadVerifiedRecoveryState();
		if (recoveryState === null
			|| recoveryState.vaultInstanceId !== context.bootstrap.vaultInstanceId
			|| recoveryState.contractDigest !== context.contractSha256
			|| recoveryState.verifiedGenerationId.length === 0) return false;
		const state = recoveryState.state;
		if (prepare.mutationKind === "create" || prepare.mutationKind === "copy") {
			const afterEvidence = prepare.changes.flatMap((change) =>
				change.transition.afterEvidence === null ? [] : [change.transition.afterEvidence]);
			if (afterEvidence.length !== 1 || await deriveObservationMemoId(
				context.bootstrap.vaultInstanceId,
				context.contractSha256,
				afterEvidence[0] as IdentityEvidence,
			) !== prepare.memoId) return false;
		}
		const memo = state.memos[prepare.memoId];
		for (const change of prepare.changes) {
			const transition = change.transition;
			if (transition.afterEvidence !== null && Object.values(state.memos).some((candidate) =>
				candidate.memoId !== prepare.memoId && candidate.activeBindingHeads.some((binding) =>
					isFullIdentityEvidence(binding.evidence)
					&& canonicalEvidence(binding.evidence) === canonicalEvidence(transition.afterEvidence as IdentityEvidence)))) {
				return false;
			}
			if (transition.baseBindingId !== null && (memo === undefined || !memo.activeBindingHeads.some((binding) =>
				binding.entryId === transition.baseBindingId
				&& isFullIdentityEvidence(binding.evidence)
				&& transition.baseEvidence !== null
				&& canonicalEvidence(binding.evidence) === canonicalEvidence(transition.baseEvidence)))) return false;
		}
		if (prepare.mutationKind === "restore") {
			const restore = prepare.effectDrafts.find((draft) => draft.type === "lifecycle.restore");
			if (restore === undefined || memo === undefined
				|| !memo.deleteVersions.some((version) => version.deleteOpId === restore.payload.deleteOpId)
				|| memo.restoredDeleteOperationIds.includes(restore.payload.deleteOpId)
				|| memo.purgedDeleteOperationIds.includes(restore.payload.deleteOpId)) return false;
		}
		return true;
	}

	private async continueSharedMutation(record: CatalogV2SharedMutationRecord): Promise<boolean> {
		if (this.sharedMutations === null || record.abandon !== null) return false;
		try {
			for (const change of record.prepare.changes) {
				const file = this.resolveFile(change.transition.sourcePath);
				if (!(file instanceof TFile)) return false;
				const current = await this.dailyGateway.prepare({
					file,
					logicalDate: change.transition.logicalDate,
					headings: change.transition.headings,
					expectedRevision: null,
					update: (content) => content,
				});
				if (current.before.sourceRevision === change.transition.afterRevision) continue;
				if (current.before.sourceRevision !== change.transition.beforeRevision) return false;
				const replay = await this.dailyGateway.prepare({
					file,
					logicalDate: change.transition.logicalDate,
					headings: change.transition.headings,
					expectedRevision: change.transition.beforeRevision,
					update: (content, parsed) => replaySharedContent(content, parsed.observations, change.replay),
				});
				if (replay.after.sourceRevision !== change.transition.afterRevision) return false;
				await this.dailyGateway.commit(replay);
			}
			const context = await this.getVaultContext();
			if (context === null) return false;
			let commitRef = record.commitRef;
			if (commitRef === null) {
				const control = isControlledMutation(record.prepare)
					? await this.sharedMutations.findControlPermit(record.prepare) : null;
				if (isControlledMutation(record.prepare) && control === null) return false;
				commitRef = await this.sharedMutations.commit({
					kind: "knomo.catalog-v2.mutation-commit",
					schemaVersion: 2,
					vaultInstanceId: context.bootstrap.vaultInstanceId,
					mutationId: record.mutationId,
					prepare: record.prepareRef,
					control,
				});
			}
			await this.bindSharedMutation(
				await this.getWriterId(),
				commitRef,
				mutationMemoIds(record.prepare),
				isControlledMutation(record.prepare),
			);
			return true;
		} catch {
			return false;
		}
	}

	private async abandonCreate(
		pending: CatalogV2PendingTransaction,
		createIntentOpId: string,
		memoId: string,
		occurredAt: string,
		reason: "daily_write_failed" | "intent_commit_failed" = "daily_write_failed",
	): Promise<void> {
		try {
			await this.operationWriter.queue({
				opId: this.ids.createOperationId(),
				memoId,
				occurredAt,
				type: "lifecycle.create_abandon",
				baseEvidence: null,
				payload: { createIntentOpId, reason },
			});
			await this.operationWriter.flush();
		} finally {
			await this.transactionStore.deletePending(pending.transactionId).catch(() => undefined);
		}
	}

	private async abandonPending(
		pending: CatalogV2PendingTransaction,
		reason: "daily_write_failed" | "stale_revision" | "user_cancelled",
	): Promise<void> {
		if (pending.sharedPrepare === undefined || this.sharedMutations === null) return;
		const context = await this.getVaultContext();
		if (context === null) return;
		await this.sharedMutations.abandon({
			kind: "knomo.catalog-v2.mutation-abandon",
			schemaVersion: 2,
			vaultInstanceId: context.bootstrap.vaultInstanceId,
			mutationId: mutationIdFromPending(pending),
			prepare: pending.sharedPrepare,
			reason,
		}).catch(() => undefined);
		await this.transactionStore.deletePending(pending.transactionId).catch(() => undefined);
	}

	private async getPendingFile(pending: CatalogV2PendingTransaction): Promise<TFile> {
		const file = this.resolveFile(pending.sourcePath);
		if (!(file instanceof TFile)) throw new Error(`Pending Daily file is unavailable: ${pending.sourcePath}`);
		return file;
	}
}

const defaultIdFactory: CatalogV2RuntimeIdFactory = {
	createMemoId: () => createCatalogV2Id("m"),
	createOperationId: () => createCatalogV2Id("o"),
};

function createPending(
	kind: CatalogV2PendingTransactionKind,
	memoId: string,
	prepared: CatalogV2PreparedDailyWrite,
	operationDrafts: StateOperationDraft[],
	createdAt: string,
	extra: Partial<CatalogV2PendingTransaction>,
): CatalogV2PendingTransaction {
	return {
		transactionId: `tx:${operationDrafts[0]?.opId ?? memoId}`,
		kind,
		memoId,
		sourcePath: normalizePath(prepared.file.path),
		logicalDate: prepared.logicalDate,
		beforeRevision: prepared.before.sourceRevision,
		afterRevision: prepared.after.sourceRevision,
		operationDrafts,
		createdAt,
		headings: [...prepared.headings],
		...extra,
	};
}

function mutationIdFromPending(pending: CatalogV2PendingTransaction): string {
	const id = pending.transactionId.replace(/^tx:/u, "");
	if (!/^o_[a-f0-9]{32}$/u.test(id)) throw new Error("Pending transaction has no protocol mutationId.");
	return id;
}

function toPendingPointer(pending: CatalogV2PendingTransaction) {
	if (pending.sharedPrepare === undefined) throw new Error("Shared mutation prepare pointer is unavailable.");
	return {
		transactionId: pending.transactionId,
		kind: pending.kind,
		memoId: pending.memoId,
		sourcePath: pending.sourcePath,
		logicalDate: pending.logicalDate,
		createdAt: pending.createdAt,
		sharedPrepare: pending.sharedPrepare,
	};
}

function transitionFromPrepared(
	prepared: CatalogV2PreparedDailyWrite,
	beforeEvidence: IdentityEvidence | null,
	afterEvidence: IdentityEvidence | null,
	baseBindingId: string | null,
	baseEvidence: IdentityEvidence | null,
) {
	return {
		sourcePath: normalizePath(prepared.file.path),
		logicalDate: prepared.logicalDate,
		headings: [...prepared.headings],
		beforeRevision: prepared.before.sourceRevision,
		afterRevision: prepared.after.sourceRevision,
		beforeEvidence,
		afterEvidence,
		baseBindingId,
		baseEvidence,
		preservedEvidence: collectPreservedEvidence(prepared, beforeEvidence, afterEvidence),
	};
}

function collectPreservedEvidence(
	prepared: CatalogV2PreparedDailyWrite,
	changedBefore: IdentityEvidence | null,
	changedAfter: IdentityEvidence | null,
): Array<{ before: IdentityEvidence; after: IdentityEvidence }> {
	const before = prepared.before.observations.filter((observation) =>
		changedBefore === null || !sameObservationEvidence(observation, changedBefore));
	const after = prepared.after.observations.filter((observation) =>
		changedAfter === null || !sameObservationEvidence(observation, changedAfter));
	const beforeByRaw = groupObservationsByRawBlock(prepared.beforeContent, before);
	const afterByRaw = groupObservationsByRawBlock(prepared.afterContent, after);
	const result: Array<{ before: IdentityEvidence; after: IdentityEvidence }> = [];
	for (const [rawBlock, beforeMatches] of beforeByRaw) {
		const afterMatches = afterByRaw.get(rawBlock) ?? [];
		if (beforeMatches.length !== 1 || afterMatches.length !== 1) continue;
		result.push({
			before: observationToIdentityEvidence(beforeMatches[0] as MemoObservation),
			after: observationToIdentityEvidence(afterMatches[0] as MemoObservation),
		});
	}
	return result.sort((left, right) => left.before.startLine - right.before.startLine
		|| left.after.startLine - right.after.startLine);
}

function groupObservationsByRawBlock(
	content: string,
	observations: readonly MemoObservation[],
): Map<string, MemoObservation[]> {
	const result = new Map<string, MemoObservation[]>();
	for (const observation of observations) {
		const rawBlock = getRawBlock(content, observation);
		result.set(rawBlock, [...(result.get(rawBlock) ?? []), observation]);
	}
	return result;
}

function sameObservationEvidence(observation: MemoObservation, evidence: IdentityEvidence): boolean {
	return observation.sourcePath === evidence.sourcePath
		&& observation.sourceRevision === evidence.sourceRevision
		&& observation.startLine === evidence.startLine
		&& observation.endLine === evidence.endLine
		&& observation.time === evidence.time
		&& observation.contentHash === evidence.contentHash;
}

function replayFromPending(pending: CatalogV2PendingTransaction): CatalogV2MutationReplay {
	if (pending.kind === "create" || pending.kind === "copy" || pending.kind === "restore") {
		if (pending.afterRawBlock === undefined) throw new Error("Shared append mutation has no memo block.");
		return { kind: "insert", rawBlock: pending.afterRawBlock, section: pending.section ?? null };
	}
	if (pending.beforeRawBlock === undefined) throw new Error("Shared mutation has no previous memo block.");
	if (pending.kind === "delete") return { kind: "remove", beforeRawBlock: pending.beforeRawBlock };
	if (pending.afterRawBlock === undefined) throw new Error("Shared replacement mutation has no next memo block.");
	return { kind: "replace", beforeRawBlock: pending.beforeRawBlock, afterRawBlock: pending.afterRawBlock };
}

function replaySharedContent(
	content: string,
	observations: readonly MemoObservation[],
	replay: CatalogV2MutationReplay,
): string {
	if (replay.kind === "insert") return insertRawBlock(content, replay.rawBlock, replay.section);
	const matches = observations.filter((item) => getRawBlock(content, item) === replay.beforeRawBlock);
	if (matches.length !== 1) throw new Error("Shared mutation Daily target is not unique.");
	return replay.kind === "remove"
		? replaceObservation(content, matches[0] as MemoObservation, "", true)
		: replaceObservation(content, matches[0] as MemoObservation, replay.afterRawBlock, false);
}

function mutationMemoIds(prepare: CatalogV2MutationPrepareArtifact): string[] {
	return [...new Set([prepare.memoId, ...prepare.effectDrafts.map((draft) => draft.memoId)])].sort();
}

function isControlledMutation(prepare: CatalogV2MutationPrepareArtifact): boolean {
	return prepare.mutationKind === "adoption" || prepare.mutationKind === "manual_repair";
}

function findAddedObservation(prepared: CatalogV2PreparedDailyWrite): MemoObservation {
	if (prepared.after.observations.length !== prepared.before.observations.length + 1) {
		throw new Error("Create must add exactly one parsed memo observation.");
	}
	const beforeKeys = new Set(prepared.before.observations.map(observationLocationKey));
	const added = prepared.after.observations.filter((item) => !beforeKeys.has(observationLocationKey(item)));
	if (added.length !== 1) throw new Error("Created Daily observation is not unique.");
	return added[0] as MemoObservation;
}

function observationLocationKey(observation: MemoObservation): string {
	return `${observation.startLine}\u0000${observation.endLine}\u0000${observation.time}\u0000${observation.contentHash}`;
}

function findHandleObservation(observations: readonly MemoObservation[], evidence: IdentityEvidence): MemoObservation {
	const matches = observations.filter((item) => item.sourceRevision === evidence.sourceRevision
		&& normalizePath(item.sourcePath) === normalizePath(evidence.sourcePath)
		&& item.logicalDate === evidence.logicalDate
		&& item.section === evidence.section
		&& item.startLine === evidence.startLine
		&& item.endLine === evidence.endLine
		&& item.time === evidence.time
		&& item.contentHash === evidence.contentHash
		&& item.existingBlockId === evidence.existingBlockId);
	if (matches.length !== 1) throw new Error("ResolvedMemoHandle is stale or ambiguous.");
	return matches[0] as MemoObservation;
}

function assertHandlePath(handle: ResolvedMemoHandle, file: TFile): void {
	if (normalizePath(handle.evidence.sourcePath) !== normalizePath(file.path)) {
		throw new Error("ResolvedMemoHandle belongs to another Daily file.");
	}
}

function getRawBlock(content: string, observation: MemoObservation): string {
	const range = getObservationRange(content, observation);
	return content.slice(range.start, range.end);
}

function replaceObservation(
	content: string,
	observation: MemoObservation,
	replacement: string,
	removeLineEnding: boolean,
): string {
	const range = getObservationRange(content, observation);
	const end = removeLineEnding ? range.nextLineStart : range.end;
	return `${content.slice(0, range.start)}${replacement}${content.slice(end)}`;
}

function getObservationRange(content: string, observation: MemoObservation): { start: number; end: number; nextLineStart: number } {
	const starts = getLineStarts(content);
	const start = starts[observation.startLine];
	if (start === undefined) throw new Error("Memo start line is outside the Daily content.");
	const nextLineStart = starts[observation.endLine + 1] ?? content.length;
	let end = nextLineStart;
	if (end > start && content.charAt(end - 1) === "\n") end -= 1;
	if (end > start && content.charAt(end - 1) === "\r") end -= 1;
	return { start, end, nextLineStart };
}

function getLineStarts(content: string): number[] {
	const starts = [0];
	for (let index = 0; index < content.length; index += 1) {
		if (content.charAt(index) === "\n") starts.push(index + 1);
	}
	return starts;
}

export function insertRawBlock(content: string, rawBlock: string, section: string | null): string {
	const firstLine = rawBlock.split(/\r\n|\r|\n/u, 1)[0] ?? "";
	if (!/^- (?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?(?: |$)/u.test(firstLine)) {
		throw new Error("A Daily memo raw block must start with a valid root-level time line.");
	}
	const eol = content.includes("\r\n") ? "\r\n" : "\n";
	const normalizedBlock = rawBlock.replace(/\r\n|\r|\n/gu, eol).replace(/(?:\r\n|\n)$/u, "");
	const headings = findHeadingOffsets(content);
	if (section === null) {
		return insertAtOffset(content, headings[0]?.start ?? content.length, normalizedBlock, eol);
	}
	const headingIndex = headings.findIndex((heading) => heading.text.trim() === section.trim());
	if (headingIndex === -1) {
		const sectionBlock = `${section.replace(/\r\n|\r|\n/gu, "").trim()}${eol}${normalizedBlock}`;
		return insertAtOffset(content, content.length, sectionBlock, eol);
	}
	return insertAtOffset(content, headings[headingIndex + 1]?.start ?? content.length, normalizedBlock, eol);
}

function insertAtOffset(content: string, offset: number, block: string, eol: string): string {
	let prefix = content.slice(0, offset);
	const suffix = content.slice(offset);
	if (prefix.length > 0 && !/(?:\r\n|\n)$/u.test(prefix)) prefix += eol;
	return `${prefix}${block}${eol}${suffix}`;
}

function findHeadingOffsets(content: string): Array<{ start: number; text: string }> {
	const starts = getLineStarts(content);
	const result: Array<{ start: number; text: string }> = [];
	let fence: { char: string; length: number } | null = null;
	let frontmatter = content.slice(0, getLineEnd(content, starts, 0)).trim() === "---";
	for (let lineIndex = 0; lineIndex < starts.length; lineIndex += 1) {
		const start = starts[lineIndex] ?? 0;
		const line = content.slice(start, getLineEnd(content, starts, lineIndex));
		if (frontmatter) {
			if (lineIndex > 0 && (line.trim() === "---" || line.trim() === "...")) frontmatter = false;
			continue;
		}
		const marker = /^ {0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
		if (marker !== undefined) {
			if (fence === null) fence = { char: marker.charAt(0), length: marker.length };
			else if (fence.char === marker.charAt(0) && marker.length >= fence.length) fence = null;
			continue;
		}
		if (fence === null && /^ {0,3}#{1,6}(?:\s|$)/u.test(line)) result.push({ start, text: line });
	}
	return result;
}

function getLineEnd(content: string, starts: readonly number[], lineIndex: number): number {
	let end = starts[lineIndex + 1] ?? content.length;
	if (end > 0 && content.charAt(end - 1) === "\n") end -= 1;
	if (end > 0 && content.charAt(end - 1) === "\r") end -= 1;
	return end;
}

function toggleRawBlockTask(rawBlock: string, lineOffset: number, checked: boolean): string {
	const parts = splitLinesWithSeparators(rawBlock);
	const target = parts[lineOffset];
	if (target === undefined || !/\[[ xX-]\]/u.test(target.text)) {
		throw new Error("Task marker is missing from the current Daily block.");
	}
	target.text = target.text.replace(/\[[ xX-]\]/u, checked ? "[x]" : "[ ]");
	return parts.map((part) => `${part.text}${part.separator}`).join("");
}

function splitLinesWithSeparators(content: string): Array<{ text: string; separator: string }> {
	const result: Array<{ text: string; separator: string }> = [];
	const pattern = /([^\r\n]*)(\r\n|\n|\r|$)/gu;
	let match = pattern.exec(content);
	while (match !== null && (match[0].length > 0 || result.length === 0)) {
		result.push({ text: match[1] ?? "", separator: match[2] ?? "" });
		if ((match[2] ?? "") === "") break;
		match = pattern.exec(content);
	}
	return result;
}

function appendReferenceBlockId(rawBlock: string, blockId: string): string {
	const parts = splitLinesWithSeparators(rawBlock);
	for (let index = parts.length - 1; index >= 0; index -= 1) {
		const part = parts[index];
		if (part === undefined || part.text.trim().length === 0) continue;
		part.text = `${part.text.replace(/\s+$/u, "")} ^${blockId}`;
		return parts.map((item) => `${item.text}${item.separator}`).join("");
	}
	throw new Error("Reference target has no effective content line.");
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function readRawBlockTime(rawBlock: string): string {
	const time = /^- ((?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?)(?: |$)/u.exec(rawBlock)?.[1];
	if (time === undefined) throw new Error("Deleted payload raw block has no valid memo time.");
	return time;
}

function replayPendingContent(
	content: string,
	observations: readonly MemoObservation[],
	pending: CatalogV2PendingTransaction,
): string {
	if (pending.kind === "create" || pending.kind === "copy" || pending.kind === "restore") {
		if (pending.afterRawBlock === undefined) throw new Error("Pending append has no raw block.");
		return insertRawBlock(content, pending.afterRawBlock, pending.section ?? null);
	}
	if (pending.beforeRawBlock === undefined) throw new Error("Pending mutation has no previous raw block.");
	const matches = observations.filter((item) => getRawBlock(content, item) === pending.beforeRawBlock);
	if (matches.length !== 1) throw new Error("Pending Daily target is not unique.");
	if (pending.kind === "delete") return replaceObservation(content, matches[0] as MemoObservation, "", true);
	if (pending.afterRawBlock === undefined) throw new Error("Pending replacement has no next raw block.");
	return replaceObservation(content, matches[0] as MemoObservation, pending.afterRawBlock, false);
}

function toPendingInspectionItem(
	pending: CatalogV2PendingTransaction,
	mutationId: string | null,
	status: CatalogV2PendingMutationInspectionItem["status"],
	reasons: readonly string[],
): CatalogV2PendingMutationInspectionItem {
	return {
		mutationId: mutationId ?? pending.transactionId,
		transactionId: pending.transactionId,
		memoId: pending.memoId,
		status,
		paths: uniqueSorted([pending.sourcePath]),
		reasons: uniqueSorted(reasons),
	};
}

function canonicalEvidence(evidence: IdentityEvidence): string {
	return JSON.stringify([
		normalizePath(evidence.sourcePath),
		evidence.sourceRevision,
		evidence.logicalDate,
		evidence.section,
		evidence.startLine,
		evidence.endLine,
		evidence.time,
		evidence.contentHash,
		evidence.existingBlockId,
	]);
}

function isFullIdentityEvidence(
	evidence: CatalogV2MaterializedState["memos"][string]["activeBindingHeads"][number]["evidence"],
): evidence is IdentityEvidence {
	return "sourceRevision" in evidence;
}

function uniqueSorted(values: readonly string[]): string[] {
	return [...new Set(values)].sort();
}

import { TFile } from "obsidian";
import type { App } from "obsidian";

import type {
	ResolvedMemo,
	ResolvedMemoHandle,
} from "../types/catalog";
import type {
	MarkdownMutationResult,
	MarkdownMutationService as MarkdownMutationContract,
} from "../types/memoOperations";
import type {
	IdentityLedgerBinding,
	IdentityLedgerCreatePlan,
	IdentityLedgerMutationService,
	IdentityLedgerRebindReason,
} from "../types/identityLedger";
import type { CatalogV2SharedMutationInspection, CatalogV2VerifiedVaultContext } from "../types/catalogV2Protocol";
import type {
	CatalogV2DeletedMemoItem,
	CatalogV2DailyMutationResult,
	CatalogV2FeatureQuery,
	CatalogV2MemoItem,
	CatalogV2MemoSaveResult,
	CatalogV2MutationFollowUpState,
	CatalogV2OperationalState,
	CatalogV2ProjectionState,
	CatalogV2ReadState,
} from "../types/catalogV2View";
import { formatDatePart, formatTimePart } from "../utils/date";
import { hashMemoContent } from "../utils/hash";
import { withCreatedAtAlias } from "../utils/references";
import { extractTimeBuoyDates } from "../utils/timeBuoyParser";
import { createResolvedMemoHandle, observationToIdentityEvidence } from "./CatalogV2IdentityResolver";
import type { CatalogV2MutationRuntime } from "./CatalogV2MutationRuntime";
import type { CatalogV2VaultProtocol } from "./CatalogV2VaultProtocol";
import type { CatalogV2StateShadowCoordinator } from "./CatalogV2StateShadowCoordinator";
import type { CatalogV2DeletedPayloadStore } from "./CatalogV2DeletedPayloadStore";
import type { IndexedDbCatalogV2StateStore } from "./IndexedDbCatalogV2StateStore";
import type { IndexedDbCatalogV2TransactionStore } from "./IndexedDbCatalogV2TransactionStore";
import type { MemoCatalogService } from "./MemoCatalogService";
import type { CatalogV2PendingMutationInspection } from "../types/catalogV2Runtime";
import { canonicalJson, sha256Text } from "./CatalogV2Protocol";
import { CatalogV2ReadService } from "./CatalogV2ReadService";

export interface CatalogV2FeatureServiceOptions {
	installMode?: import("../types/catalogV2").CatalogV2InstallMode;
	getInstallMode?: () => import("../types/catalogV2").CatalogV2InstallMode;
	getHeadings: () => readonly string[];
	getOrCreateDailyFile: (date: Date) => Promise<TFile>;
	removeEmptyCreatedDailyFile?: (file: TFile) => Promise<void>;
	getDailyFileForDate: (logicalDate: string) => Promise<TFile>;
	getDailyPathForDate?: (logicalDate: string) => Promise<string>;
	refreshCatalogPaths: (paths: readonly string[]) => Promise<void>;
	refreshLocalCatalog: () => Promise<void>;
	getProjectionState?: () => CatalogV2ProjectionState;
	getMemoTimeFormat: () => "HH:mm" | "HH:mm:ss";
	rebuildLocalCatalog: () => Promise<void>;
	getVaultContext?: () => CatalogV2VerifiedVaultContext | null | Promise<CatalogV2VerifiedVaultContext | null>;
	getWriterId?: () => Promise<string>;
	isControlAuthority?: () => boolean;
	vaultProtocol?: CatalogV2VaultProtocol;
	inspectSharedMutations?: () => Promise<CatalogV2SharedMutationInspection>;
	getLegacyImportStatus?: () => import("../types/legacyIdentityImport").LegacyIdentityImportStatus;
	now?: () => Date;
	random?: () => number;
}

function normalizeMemoInput(input: string): string {
	return input.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n");
}

export interface CatalogV2ReferenceResult extends CatalogV2MutationFollowUpState {
	text: string;
	memoId: string | null;
}

export class CatalogV2FeatureService {
	private readonly now: () => Date;
	private readonly readService: CatalogV2ReadService;

	constructor(
		private readonly app: App,
		catalog: MemoCatalogService,
		private readonly stateStore: IndexedDbCatalogV2StateStore | null,
		private readonly stateCoordinator: CatalogV2StateShadowCoordinator | null,
		private readonly transactionStore: IndexedDbCatalogV2TransactionStore | null,
		private readonly mutationRuntime: CatalogV2MutationRuntime | null,
		deletedPayloadStore: CatalogV2DeletedPayloadStore | null,
		private readonly options: CatalogV2FeatureServiceOptions,
		private readonly markdownMutations: MarkdownMutationContract | null = null,
		private readonly identityLedger: IdentityLedgerMutationService | null = null,
	) {
		this.now = options.now ?? (() => new Date());
		this.readService = new CatalogV2ReadService({
			catalog,
			stateStore,
			stateCoordinator,
			transactionStore,
			deletedPayloadStore,
			installMode: options.installMode,
			getInstallMode: options.getInstallMode,
			getVaultContext: options.getVaultContext,
			inspectSharedMutations: options.inspectSharedMutations,
			requestObservationScan: options.refreshLocalCatalog,
			getProjectionState: options.getProjectionState,
			identityLedger,
			getLegacyImportStatus: options.getLegacyImportStatus,
			now: options.now,
			random: options.random,
		});
	}

	getReadService(): CatalogV2ReadService {
		return this.readService;
	}

	async rebuildLocalCatalog(): Promise<void> {
		await this.options.rebuildLocalCatalog();
		await this.readService.materializeResolutionSnapshot();
	}

	async refreshLocalCatalog(): Promise<void> {
		await this.options.refreshLocalCatalog();
		await this.readService.materializeResolutionSnapshot();
	}

	async inspectPendingMutations(): Promise<CatalogV2PendingMutationInspection> {
		if (this.mutationRuntime === null) {
			return { items: [], affectedPaths: [], affectedMemoIds: [] };
		}
		return this.mutationRuntime.inspectPending();
	}

	async recoverPendingMutation(mutationId: string, action: "continue" | "abandon"): Promise<boolean> {
		if (this.mutationRuntime === null) return false;
		const inspection = await this.mutationRuntime.inspectPending();
		const item = inspection.items.find((candidate) => candidate.mutationId === mutationId);
		if (item === undefined) return false;
		const completed = await this.mutationRuntime.recoverExplicit(mutationId, action);
		if (!completed) return false;
		await this.finishMutation(item.paths).catch(() => undefined);
		return true;
	}

	getOperationalState(readState: CatalogV2ReadState = this.readService.getLastReadState() ?? "history_building"): CatalogV2OperationalState {
		return {
			readState,
			capabilities: {
				readKnown: true,
				createNew: this.markdownMutations !== null,
				adoptExisting: this.canAdoptIdentityLedgerObservation(),
				projectMonthly: false,
				physicalGc: false,
			},
		};
	}

	async adoptMemo(item: CatalogV2MemoItem): Promise<string> {
		if (!this.canAdoptIdentityLedgerObservation() || this.identityLedger === null) {
			throw new Error("Existing Daily memo adoption is unavailable.");
		}
		const refreshed = await this.refreshResolvedMemo(item.resolved);
		if (refreshed.kind !== "observed"
			|| this.identityLedger.resolveObservationState(refreshed.observation).kind !== "unbound") {
			throw new Error("Only a current historical observation without identity can be adopted.");
		}
		const binding = await this.identityLedger.adoptObservation(refreshed.observation);
		await this.readService.materializeResolutionSnapshot();
		return binding.memoId;
	}

	async create(contentInput: string, sourceMemoId: string | null = null): Promise<CatalogV2MemoSaveResult> {
		const content = normalizeMemoInput(contentInput);
		if (content.trim().length === 0) throw new Error("Memo content is empty.");
		const createdAt = this.now();
		const logicalDate = formatDatePart(createdAt);
		const plan = await this.beginIdentityCreate(content, logicalDate, createdAt, sourceMemoId);
		const result = await this.getMarkdownMutations().create({ content, targetLogicalDate: logicalDate, createdAt });
		const identityPending = await this.finishIdentityCreate(plan, result.observation);
		return this.finishMarkdownSavedMemo(result, result.observation?.timeBuoyDates ?? [], {
			memoId: plan?.memoId ?? null,
			pending: identityPending,
		});
	}

	async copy(item: CatalogV2MemoItem, logicalDate = formatDatePart(this.now())): Promise<CatalogV2MemoSaveResult> {
		const createdAt = this.now();
		const plan = await this.beginIdentityCreate(item.content, logicalDate, createdAt, item.memoId);
		const result = await this.getMarkdownMutations().copy({
			observation: item.observationHandle,
			targetLogicalDate: logicalDate,
			createdAt,
		});
		const identityPending = await this.finishIdentityCreate(plan, result.observation);
		return this.finishMarkdownSavedMemo(result, result.observation?.timeBuoyDates ?? item.timeBuoyDates, {
			memoId: plan?.memoId ?? null,
			pending: identityPending,
		});
	}

	async move(item: CatalogV2MemoItem, targetLogicalDate: string): Promise<CatalogV2MemoSaveResult> {
		const result = await this.getMarkdownMutations().move({
			observation: item.observationHandle,
			targetLogicalDate,
		});
		const identity = result.status === "committed_content_pending"
			? this.createPendingIdentityResult(item.memoId)
			: await this.finishIdentityRebind(item, result.observation, "move");
		return this.finishMarkdownSavedMemo(
			result,
			result.observation?.timeBuoyDates ?? item.timeBuoyDates,
			identity,
		);
	}

	async repairIdentity(target: CatalogV2MemoItem, candidateMemoId: string): Promise<void> {
		const ledgerMemo = this.identityLedger?.getSnapshot().memos[candidateMemoId];
		if (this.identityLedger !== null && ledgerMemo?.conflicted === true) {
			const refreshed = await this.refreshResolvedMemo(target.resolved);
			if (refreshed.kind !== "ambiguous"
				|| !refreshed.candidates.some((candidate) => candidate.memoId === candidateMemoId)) {
				throw new Error("The selected V3 identity conflict is no longer current.");
			}
			await this.identityLedger.repairConflict(candidateMemoId, refreshed.observation);
			await this.readService.materializeResolutionSnapshot();
			return;
		}
		this.assertSharedMutationReady();
		if (this.options.isControlAuthority?.() !== true) {
			throw new Error("Only the current Catalog control authority can repair memo identity.");
		}
		if (target.resolved.kind !== "ambiguous" || target.resolved.reason === "known_predecessor"
			|| !target.resolved.candidates.some((candidate) => candidate.memoId === candidateMemoId)) {
			throw new Error("Manual repair requires an ambiguous target and one of its identity candidates.");
		}
		if (this.options.getVaultContext === undefined || this.options.getWriterId === undefined
			|| this.options.vaultProtocol === undefined || this.stateStore === null) {
			throw new Error("Catalog control authority is unavailable for identity repair.");
		}
		const state = await this.stateStore.loadMaterializedState();
		const memo = state?.memos[candidateMemoId];
		if (memo === undefined || memo.activeBindingHeads.length !== 1) {
			throw new Error("The selected identity no longer has one active binding.");
		}
		const activeBinding = memo.activeBindingHeads[0];
		if (activeBinding === undefined || !("sourceRevision" in activeBinding.evidence)) {
			throw new Error("The selected identity binding cannot be repaired safely.");
		}
		const context = await this.options.getVaultContext();
		if (context === null) throw new Error("Catalog v2 Vault bootstrap is not verified.");
		const writerId = await this.options.getWriterId();
		const baseEvidence = activeBinding.evidence;
		const repairInputDigest = await sha256Text(canonicalJson({
			memoId: candidateMemoId,
			baseBindingId: activeBinding.entryId,
			baseEvidence,
			targetEvidence: observationToIdentityEvidence(target.resolved.observation),
		}));
		const control = await this.options.vaultProtocol.authorizeControlAction(context, writerId, {
			actionId: `o_${repairInputDigest.slice(0, 32)}`,
			kind: "identity_repair",
			inputDigest: repairInputDigest,
			memoIds: [candidateMemoId],
		});
		await this.getMutationRuntime().manualRepair({
			memoId: candidateMemoId,
			baseBindingId: activeBinding.entryId,
			baseEvidence,
			targetEvidence: observationToIdentityEvidence(target.resolved.observation),
			control,
		});
		await this.finishMutation([baseEvidence.sourcePath, target.sourcePath]);
	}

	async edit(item: CatalogV2MemoItem, contentInput: string): Promise<CatalogV2MemoSaveResult> {
		const content = normalizeMemoInput(contentInput);
		if (content.trim().length === 0) throw new Error("Memo content is empty.");
		const result = await this.getMarkdownMutations().edit({
			observation: item.observationHandle,
			content,
		});
		const identity = await this.finishIdentityRebind(item, result.observation, "edit");
		return this.finishMarkdownSavedMemo(result, extractTimeBuoyDates(content), identity);
	}

	async toggleTask(item: CatalogV2MemoItem, taskIndex: number, checked: boolean): Promise<CatalogV2MemoSaveResult> {
		const result = await this.getMarkdownMutations().toggleTask({
			observation: item.observationHandle,
			taskIndex,
			checked,
		});
		const identity = await this.finishIdentityRebind(item, result.observation, "edit");
		return this.finishMarkdownSavedMemo(
			result,
			result.observation?.timeBuoyDates ?? item.timeBuoyDates,
			identity,
		);
	}

	async removePermanently(item: CatalogV2MemoItem): Promise<CatalogV2DailyMutationResult> {
		const refreshed = await this.refreshResolvedMemo(item.resolved);
		if (refreshed.capabilities.identity.recoverableDelete !== "absent") {
			throw new Error("Permanent delete requires a current memo without recoverable identity.");
		}
		const result = await this.getMarkdownMutations().remove({ observation: refreshed.observation });
		const saved = await this.finishMarkdownSavedMemo(result, []);
		return {
			status: saved.status,
			memoId: saved.memoId,
			followUpPending: saved.followUpPending,
			localRefreshPending: saved.localRefreshPending,
		};
	}

	async delete(item: CatalogV2MemoItem): Promise<CatalogV2DailyMutationResult> {
		if (this.identityLedger?.recordDeletePayload === undefined
			|| this.identityLedger.recordDeleteCommit === undefined
			|| this.markdownMutations?.captureObservation === undefined) {
			throw new Error("Recoverable delete requires an available Identity Ledger.");
		}
		const refreshed = await this.refreshResolvedMemo(item.resolved);
		const ledgerState = this.identityLedger.resolveObservationState(refreshed.observation);
		if (ledgerState.kind !== "identified") {
			throw new Error("Recoverable delete requires one confirmed memo identity.");
		}
		const captured = await this.markdownMutations.captureObservation({ observation: refreshed.observation });
		const deleteRecord = await this.identityLedger.recordDeletePayload(ledgerState.binding, {
			deletedAt: this.now().toISOString(),
			sourcePath: captured.observation.sourcePath,
			deletedSourceRevision: captured.deletedSourceRevision,
			logicalDate: captured.observation.logicalDate,
			section: captured.observation.section,
			rawBlock: captured.rawBlock,
			contentHash: captured.observation.contentHash,
			sourceMemoId: item.sourceMemoId,
		});
		const result = await this.getMarkdownMutations().remove({ observation: captured.observation });
		let pending = true;
		try {
			await this.identityLedger.recordDeleteCommit(deleteRecord);
			pending = false;
		} catch {
			pending = true;
		}
		const saved = await this.finishMarkdownSavedMemo(result, [], {
			memoId: ledgerState.binding.memoId,
			pending,
		});
		return {
			status: saved.status,
			memoId: saved.memoId,
			followUpPending: saved.followUpPending,
			localRefreshPending: saved.localRefreshPending,
		};
	}

	async restore(item: CatalogV2DeletedMemoItem): Promise<CatalogV2MemoSaveResult> {
		if (item.identityDeleteEventId !== undefined) {
			if (this.identityLedger?.getActiveDeletes === undefined
				|| this.identityLedger.recordRestore === undefined
				|| this.markdownMutations?.restore === undefined) {
				throw new Error("Identity Ledger restore is unavailable.");
			}
			const record = this.identityLedger.getActiveDeletes()
				.find((candidate) => candidate.deleteEventId === item.identityDeleteEventId);
			if (record === undefined) throw new Error("Deleted memo payload is no longer active.");
			const result = await this.markdownMutations.restore({
				targetLogicalDate: record.evidence.logicalDate,
				rawBlock: record.evidence.rawBlock,
				section: record.evidence.section,
			});
			let pending = true;
			if (result.observation !== null) {
				try {
					await this.identityLedger.recordRestore(record, result.observation);
					pending = false;
				} catch {
					pending = true;
				}
			}
			return this.finishMarkdownSavedMemo(
				result,
				result.observation?.timeBuoyDates ?? [],
				{ memoId: item.memoId, pending },
			);
		}
		this.assertSharedMutationReady();
		if (!item.payloadAvailable) throw new Error("Deleted memo payload is unavailable and cannot be restored.");
		const existing = this.app.vault.getAbstractFileByPath(item.sourcePath);
		const file = existing instanceof TFile ? existing : await this.options.getDailyFileForDate(item.logicalDate);
		const result = await this.getMutationRuntime().restore({
			file,
			logicalDate: item.logicalDate,
			headings: this.options.getHeadings(),
			memoId: item.memoId,
			deleteVersion: item.deleteVersion,
		});
		return this.finishSavedMemo({
			memoId: item.memoId,
			sourcePath: file.path,
			timeBuoyDates: extractTimeBuoyDates(item.content),
			followUpPending: result.followUpPending,
			provisionalObservation: null,
		});
	}

	async purge(item: CatalogV2DeletedMemoItem): Promise<void> {
		if (item.identityDeleteEventId !== undefined) {
			throw new Error("Identity Ledger physical cleanup requires a future explicit cleanup operation.");
		}
		this.assertSharedMutationReady();
		await this.getMutationRuntime().purge({
			memoId: item.memoId,
			deleteOpId: item.deleteVersion.deleteOpId,
			deletedPayload: item.deleteVersion.payload,
		});
		await this.finishMutation([]);
	}

	async createReferenceText(item: CatalogV2MemoItem, sourcePath = ""): Promise<CatalogV2ReferenceResult> {
		const file = this.getFile(item.sourcePath);
		const anchored = await this.getMarkdownMutations().createBlockReference({
			observation: item.observationHandle,
			sourcePath,
		});
		const identity = await this.finishIdentityRebind(item, anchored.observation, "edit");
		const saved = await this.finishMarkdownSavedMemo(
			anchored,
			anchored.observation?.timeBuoyDates ?? item.timeBuoyDates,
			identity,
		);
		const link = this.app.fileManager.generateMarkdownLink(file, sourcePath, `#^${anchored.blockId}`);
		return {
			text: withCreatedAtAlias(link, item.createdAt),
			memoId: item.memoId,
			followUpPending: saved.followUpPending,
			localRefreshPending: saved.localRefreshPending,
		};
	}

	async recordReview(item: CatalogV2MemoItem): Promise<void> {
		const ledgerState = this.identityLedger?.resolveObservationState(item.observation);
		if (this.identityLedger !== null && ledgerState?.kind === "identified") {
			await this.identityLedger.recordReview(ledgerState.binding, this.now().toISOString());
			await this.readService.materializeResolutionSnapshot();
			return;
		}
		this.assertSharedMutationReady();
		const handle = await this.getWritableHandle(item, "review");
		await this.getMutationRuntime().recordReview(handle);
		await this.finishMutation([]);
	}

	private async getWritableHandle(
		item: CatalogV2MemoItem,
		capability: keyof CatalogV2MemoItem["capabilities"]["identity"],
		requireSharedReadiness = true,
	): Promise<ResolvedMemoHandle> {
		if (requireSharedReadiness && !this.isIdentityMutationReady()) {
			throw new Error("Knomo Vault identity is not ready; Daily was not changed.");
		}
		let resolved = await this.refreshResolvedMemo(item.resolved);
		const handle = createResolvedMemoHandle(resolved);
		if (handle !== null && resolved.capabilities.identity[capability] === "ready") return handle;
		throw new Error(resolved.kind === "ambiguous"
			? "This memo has multiple possible sources and cannot be changed automatically."
			: resolved.kind === "observed" && resolved.adoption === "eligible"
				? "This Daily memo must be explicitly adopted before it can be changed."
				: "This memo is still settling and cannot be changed yet.");
	}

	private async refreshResolvedMemo(memo: ResolvedMemo): Promise<ResolvedMemo> {
		await this.options.refreshCatalogPaths([memo.observation.sourcePath]);
		await this.readService.materializeResolutionSnapshot();
		return this.readService.resolveObservationInFile(memo.observation.sourcePath, memo.observation.startLine);
	}

	private async finishMutation(paths: readonly string[]): Promise<void> {
		if (paths.length > 0) await this.options.refreshCatalogPaths(paths);
		await this.stateCoordinator?.capture(false);
		await this.readService.materializeResolutionSnapshot();
	}

	private async finishSavedMemo(input: {
		memoId: string;
		sourcePath: string;
		additionalPaths?: readonly string[];
		timeBuoyDates: readonly string[];
		followUpPending: boolean;
		provisionalObservation: ResolvedMemo["observation"] | null;
	}): Promise<CatalogV2MemoSaveResult> {
		let memo: CatalogV2MemoItem | null = null;
		const result = await this.finishDailyMutation(
			input.memoId,
			[...(input.additionalPaths ?? []), input.sourcePath],
			input.followUpPending,
		);
		if (!result.localRefreshPending) {
			try {
				memo = await this.findMemoById(input.memoId, input.sourcePath);
				if (memo === null && input.followUpPending && input.provisionalObservation !== null) {
					const page = await this.readService.query({ sourcePaths: [input.sourcePath], limit: 150, cursor: null });
					memo = page.items.find((item) =>
						item.observation.sourceRevision === input.provisionalObservation?.sourceRevision
						&& item.observation.startLine === input.provisionalObservation.startLine
						&& item.observation.contentHash === input.provisionalObservation.contentHash) ?? null;
				}
			} catch {
				result.localRefreshPending = true;
			}
		}
		if (memo === null) result.localRefreshPending = true;
		return {
			...result,
			memo,
			timeBuoyDates: [...(memo?.timeBuoyDates ?? input.timeBuoyDates)],
		};
	}

	private async finishMarkdownSavedMemo(
		input: MarkdownMutationResult,
		timeBuoyDates: readonly string[],
		identity?: { memoId: string | null; pending: boolean },
	): Promise<CatalogV2MemoSaveResult> {
		let localRefreshPending = input.catalogUpdatePending;
		let memo: CatalogV2MemoItem | null = null;
		try {
			await this.stateCoordinator?.capture(false);
			await this.readService.materializeResolutionSnapshot();
		} catch {
			localRefreshPending = true;
		}
		if (!localRefreshPending && input.observation !== null) {
			try {
				memo = await this.findMemoByObservation(input.observation);
			} catch {
				localRefreshPending = true;
			}
		}
		if (input.observation !== null && memo === null) localRefreshPending = true;
		return {
			status: input.status === "committed_content_pending" ? "content_pending" : "saved",
			memoId: memo?.memoId ?? identity?.memoId ?? null,
			memo,
			timeBuoyDates: [...(memo?.timeBuoyDates ?? timeBuoyDates)],
			followUpPending: identity?.pending ?? true,
			localRefreshPending,
		};
	}

	private async beginIdentityCreate(
		content: string,
		logicalDate: string,
		createdAt: Date,
		sourceMemoId: string | null,
	): Promise<IdentityLedgerCreatePlan | null> {
		if (this.identityLedger === null) return null;
		let targetPath: string | null = null;
		try {
			targetPath = await this.options.getDailyPathForDate?.(logicalDate) ?? null;
		} catch {
			targetPath = null;
		}
		try {
			return await this.identityLedger.beginCreate({
				targetPath,
				logicalDate,
				time: formatTimePart(createdAt, this.options.getMemoTimeFormat()),
				contentHash: hashMemoContent(content),
				sourceMemoId,
			});
		} catch {
			return null;
		}
	}

	private async finishIdentityCreate(
		plan: IdentityLedgerCreatePlan | null,
		observation: ResolvedMemo["observation"] | null,
	): Promise<boolean> {
		if (plan === null || observation === null || this.identityLedger === null) return true;
		try {
			await this.identityLedger.finishCreate(plan, observation);
			return false;
		} catch {
			return true;
		}
	}

	private async finishIdentityRebind(
		item: CatalogV2MemoItem,
		observation: ResolvedMemo["observation"] | null,
		reason: IdentityLedgerRebindReason,
	): Promise<{ memoId: string | null; pending: boolean } | undefined> {
		if (this.identityLedger === null) return undefined;
		if (observation === null) return this.createPendingIdentityResult(item.memoId);
		try {
			const binding = await this.identityLedger.rebindObservation(item.observation, observation, reason);
			return binding === null
				? this.createPendingIdentityResult(item.memoId)
				: { memoId: binding.memoId, pending: false };
		} catch {
			return this.createPendingIdentityResult(item.memoId);
		}
	}

	private createPendingIdentityResult(memoId: string | null): { memoId: string | null; pending: true } | undefined {
		return this.identityLedger === null ? undefined : { memoId, pending: true };
	}

	private canAdoptIdentityLedgerObservation(): boolean {
		const status = this.identityLedger?.getStatus();
		return status === "ready" || status === "absent";
	}

	private async finishDailyMutation(
		memoId: string,
		paths: readonly string[],
		followUpPending: boolean,
	): Promise<CatalogV2DailyMutationResult> {
		let localRefreshPending = false;
		try {
			await this.finishMutation(paths);
		} catch {
			localRefreshPending = true;
		}
		return { status: "saved", memoId, followUpPending, localRefreshPending };
	}

	private async findMemoById(memoId: string, sourcePath: string): Promise<CatalogV2MemoItem | null> {
		let cursor: CatalogV2FeatureQuery["cursor"] = null;
		do {
			const page = await this.readService.query({ sourcePaths: [sourcePath], limit: 150, cursor });
			const found = page.items.find((item) => item.memoId === memoId);
			if (found !== undefined) return found;
			if (page.invalidated) return null;
			cursor = page.nextCursor;
		} while (cursor !== null);
		return null;
	}

	private async findMemoByObservation(observation: ResolvedMemo["observation"]): Promise<CatalogV2MemoItem | null> {
		let cursor: CatalogV2FeatureQuery["cursor"] = null;
		do {
			const page = await this.readService.query({ sourcePaths: [observation.sourcePath], limit: 150, cursor });
			const found = page.items.find((item) => item.observation.sourceRevision === observation.sourceRevision
				&& item.observation.startLine === observation.startLine
				&& item.observation.endLine === observation.endLine
				&& item.observation.rawBlockHash === observation.rawBlockHash);
			if (found !== undefined) return found;
			if (page.invalidated) return null;
			cursor = page.nextCursor;
		} while (cursor !== null);
		return null;
	}

	private getFile(path: string): TFile {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) throw new Error(`Daily file is unavailable: ${path}`);
		return file;
	}

	private getMutationRuntime(): CatalogV2MutationRuntime {
		if (this.mutationRuntime === null) throw new Error("Memo identity is still preparing.");
		return this.mutationRuntime;
	}

	private getMarkdownMutations(): MarkdownMutationContract {
		if (this.markdownMutations === null) throw new Error("Markdown mutation service is unavailable.");
		return this.markdownMutations;
	}

	private assertSharedMutationReady(): void {
		if (!this.isIdentityMutationReady()) {
			throw new Error("Knomo Vault identity is not ready; shared state was not changed.");
		}
	}

	private isIdentityMutationReady(): boolean {
		return this.mutationRuntime !== null
			&& this.stateStore?.isAuthoritative() === true
			&& this.transactionStore?.isAuthoritative() === true;
	}
}

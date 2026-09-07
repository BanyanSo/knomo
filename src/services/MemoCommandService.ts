import { TFile } from "obsidian";
import type { App } from "obsidian";
import { KnomoMutationBarrier } from "./KnomoMutationBarrier";

import type { CatalogRefreshResult, ObservationHandle, ResolvedMemo } from "../types/catalog";
import type {
	CatalogFeatureQuery,
	CatalogMemoItem,
	CatalogOperationalState,
	CatalogReadState,
	DailyMutationResult,
	MemoSaveOperation,
	MemoSaveResult,
	MonthlyProjectionState,
	MutationFollowUpState,
	TrashMemoItem,
} from "../types/catalogView";
import type {
	IdentityLedgerMutationService,
} from "../types/identityLedger";
import type {
	MarkdownMutationResult,
	MarkdownMutationService as MarkdownMutationContract,
} from "../types/memoOperations";
import type { KnomoSharedConfigStatus } from "../types/knomoConfig";
import type { KnomoSettingsLoadStatus } from "../types/settings";
import type { KnomoStartupBootstrapSnapshot } from "./KnomoStartupBootstrapService";
import { formatDatePart } from "../utils/date";
import { withCreatedAtAlias } from "../utils/references";
import { extractTimeBuoyDates } from "../utils/timeBuoyParser";
import { CatalogReadService } from "./CatalogReadService";
import type { MemoCatalogService } from "./MemoCatalogService";
import { MarkdownMutationStaleError } from "./MarkdownMutationService";
import { LocalMemoReviewStore } from "./LocalMemoReviewStore";
import { CatalogReferenceService } from "./CatalogReferenceService";

export interface MemoCommandServiceOptions {
	getDailyPathForDate?: (logicalDate: string) => Promise<string>;
	refreshCatalogPaths: (paths: readonly string[]) => Promise<void>;
	refreshLocalCatalog: () => Promise<CatalogRefreshResult>;
	getProjectionState?: () => MonthlyProjectionState;
	getMemoTimeFormat: () => "HH:mm" | "HH:mm:ss";
	rebuildLocalCatalog: () => Promise<void>;
	getLegacyImportStatus?: () => import("../types/legacyMigration").LegacyIdentityImportStatus;
	getHistoricalIdentityBootstrapStatus?: () => import("./HistoricalIdentityBootstrapService").HistoricalIdentityBootstrapStatus;
	getSharedConfigurationStatus?: () => KnomoSharedConfigStatus;
	getSettingsStatus?: () => KnomoSettingsLoadStatus;
	getStartupBootstrapSnapshot?: () => KnomoStartupBootstrapSnapshot;
	now?: () => Date;
	random?: () => number;
}

export interface MemoReferenceResult extends MutationFollowUpState {
	text: string;
	memoId: string | null;
}

export class MemoCommandService {
	private readonly mutationBarrier = new KnomoMutationBarrier();
	private readonly now: () => Date;
	private readonly readService: CatalogReadService;

	constructor(
		private readonly app: App,
		catalog: MemoCatalogService,
		private readonly options: MemoCommandServiceOptions,
		private readonly markdownMutations: MarkdownMutationContract,
		private readonly identityLedger: IdentityLedgerMutationService,
	) {
		this.now = options.now ?? (() => new Date());
		this.createInternal = this.mutationBarrier.wrap(this.createInternal.bind(this));
		this.copy = this.mutationBarrier.wrap(this.copy.bind(this));
		this.move = this.mutationBarrier.wrap(this.move.bind(this));
		this.repairIdentity = this.mutationBarrier.wrap(this.repairIdentity.bind(this));
		this.editInternal = this.mutationBarrier.wrap(this.editInternal.bind(this));
		this.toggleTask = this.mutationBarrier.wrap(this.toggleTask.bind(this));
		this.removePermanently = this.mutationBarrier.wrap(this.removePermanently.bind(this));
		this.prepareRecoverableDelete = this.mutationBarrier.wrap(this.prepareRecoverableDelete.bind(this));
		this.delete = this.mutationBarrier.wrap(this.delete.bind(this));
		this.restore = this.mutationBarrier.wrap(this.restore.bind(this));
		this.purge = this.mutationBarrier.wrap(this.purge.bind(this));
		this.createReferenceText = this.mutationBarrier.wrap(this.createReferenceText.bind(this));
		this.recordReview = this.mutationBarrier.wrap(this.recordReview.bind(this));
		this.readService = new CatalogReadService({
			references: new CatalogReferenceService(app, catalog),
			reviews: new LocalMemoReviewStore(app),
			catalog,
			identityLedger,
			requestObservationScan: async () => { await options.refreshLocalCatalog(); },
			getProjectionState: options.getProjectionState,
			getLegacyImportStatus: options.getLegacyImportStatus,
			getHistoricalIdentityBootstrapStatus: options.getHistoricalIdentityBootstrapStatus,
			getSharedConfigurationStatus: options.getSharedConfigurationStatus,
			getSettingsStatus: options.getSettingsStatus,
			getStartupBootstrapSnapshot: options.getStartupBootstrapSnapshot,
			now: options.now,
			random: options.random,
		});
	}

	getReadService(): CatalogReadService {
		return this.readService;
	}

	runWithMutationsPaused<T>(action: () => Promise<T>): Promise<T> {
		return this.mutationBarrier.runPaused(action);
	}

	async rebuildLocalCatalog(): Promise<void> {
		await this.options.rebuildLocalCatalog();
	}

	async refreshLocalCatalog(): Promise<CatalogRefreshResult> {
		return this.options.refreshLocalCatalog();
	}

	getOperationalState(readState: CatalogReadState = this.readService.getLastReadState() ?? "history_building"): CatalogOperationalState {
		return {
			readState,
			capabilities: {
				createNew: true,
			},
		};
	}

	startCreate(contentInput: string): MemoSaveOperation {
		return this.startSaveOperation((onDailyCommitted) => this.createInternal(
			contentInput,
			onDailyCommitted,
		));
	}

	async create(contentInput: string): Promise<MemoSaveResult> {
		return this.createInternal(contentInput);
	}

	private async createInternal(
		contentInput: string,
		onDailyCommitted?: () => void,
	): Promise<MemoSaveResult> {
		const content = normalizeMemoInput(contentInput);
		if (content.trim().length === 0) throw new Error("Memo content is empty.");
		const createdAt = this.now();
		const logicalDate = formatDatePart(createdAt);
		const result = await this.markdownMutations.create({
			content,
			targetLogicalDate: logicalDate,
			createdAt,
			onDailyCommitted,
		});
		return this.finishMarkdownSavedMemo(result, result.observation?.timeBuoyDates ?? []);
	}

	async copy(item: CatalogMemoItem, logicalDate = formatDatePart(this.now())): Promise<MemoSaveResult> {
		const createdAt = this.now();
		const result = await this.markdownMutations.copy({
			observation: item.observationHandle,
			targetLogicalDate: logicalDate,
			createdAt,
		});
		return this.finishMarkdownSavedMemo(result, result.observation?.timeBuoyDates ?? item.timeBuoyDates);
	}

	async move(item: CatalogMemoItem, targetLogicalDate: string): Promise<MemoSaveResult> {
		const result = await this.markdownMutations.move({
			observation: item.observationHandle,
			targetLogicalDate,
		});
		return this.finishMarkdownSavedMemo(result, result.observation?.timeBuoyDates ?? item.timeBuoyDates);
	}

	async repairIdentity(target: CatalogMemoItem, candidateMemoId: string): Promise<void> {
		const memo = this.identityLedger.getSnapshot().memos[candidateMemoId];
		if (memo?.conflicted !== true) throw new Error("The selected identity conflict is no longer current.");
		const refreshed = await this.refreshResolvedMemo(target.observationHandle);
		if (refreshed.kind !== "ambiguous"
			|| !refreshed.candidates.some((candidate) => candidate.memoId === candidateMemoId)) {
			throw new Error("The selected identity conflict is no longer current.");
		}
		await this.identityLedger.repairConflict(candidateMemoId, refreshed.observation);
	}

	startEdit(item: CatalogMemoItem, contentInput: string): MemoSaveOperation {
		return this.startSaveOperation((onDailyCommitted) => this.editInternal(item, contentInput, onDailyCommitted));
	}

	async edit(item: CatalogMemoItem, contentInput: string): Promise<MemoSaveResult> {
		return this.editInternal(item, contentInput);
	}

	private async editInternal(
		item: CatalogMemoItem,
		contentInput: string,
		onDailyCommitted?: () => void,
	): Promise<MemoSaveResult> {
		const content = normalizeMemoInput(contentInput);
		if (content.trim().length === 0) throw new Error("Memo content is empty.");
		const result = await this.markdownMutations.edit({
			observation: item.observationHandle,
			content,
			onDailyCommitted,
		});
		return this.finishMarkdownSavedMemo(result, extractTimeBuoyDates(content));
	}

	async toggleTask(item: CatalogMemoItem, taskIndex: number, checked: boolean): Promise<MemoSaveResult> {
		const result = await this.markdownMutations.toggleTask({
			observation: item.observationHandle,
			taskIndex,
			checked,
		});
		return this.finishMarkdownSavedMemo(result, result.observation?.timeBuoyDates ?? item.timeBuoyDates);
	}

	async removePermanently(item: CatalogMemoItem): Promise<DailyMutationResult> {
		const refreshed = await this.refreshResolvedMemo(item.observationHandle);
		if (refreshed.capabilities.identity.recoverableDelete !== "absent") {
			throw new Error("Permanent delete requires a current memo without recoverable identity.");
		}
		const result = await this.markdownMutations.remove({ observation: item.observationHandle });
		const saved = await this.finishMarkdownSavedMemo(result, []);
		return pickDailyMutationResult(saved);
	}

	async prepareRecoverableDelete(item: CatalogMemoItem): Promise<CatalogMemoItem | null> {
		const refreshed = await this.refreshResolvedMemo(item.observationHandle);
		const currentState = this.identityLedger.resolveObservationState(refreshed.observation);
		if (currentState.kind === "identified") {
			return this.requireRecoverableDeleteItem(item.observationHandle, currentState.binding.memoId);
		}
		if (currentState.kind !== "unbound") {
			throw new Error("Recoverable delete requires one confirmed memo identity.");
		}
		const status = this.identityLedger.getStatus();
		if (status !== "ready" && status !== "absent") {
			throw new Error("Recoverable delete identity preparation is unavailable.");
		}

		let memoId: string;
		try {
			memoId = (await this.identityLedger.adoptObservation(refreshed.observation)).memoId;
		} catch (error) {
			const latest = await this.refreshResolvedMemo(item.observationHandle);
			const latestState = this.identityLedger.resolveObservationState(latest.observation);
			if (latestState.kind === "identified") {
				return this.requireRecoverableDeleteItem(item.observationHandle, latestState.binding.memoId);
			}
			const latestStatus = this.identityLedger.getStatus();
			if (latestState.kind === "unbound" && (latestStatus === "ready" || latestStatus === "absent")) {
				return null;
			}
			throw error;
		}
		return this.requireRecoverableDeleteItem(item.observationHandle, memoId);
	}

	async delete(item: CatalogMemoItem): Promise<DailyMutationResult> {
		if (this.identityLedger.recordDeletePayload === undefined
			|| this.identityLedger.recordDeleteCommit === undefined
			|| this.markdownMutations.captureObservation === undefined) {
			throw new Error("Recoverable delete requires an available Identity Ledger.");
		}
		const refreshed = await this.refreshResolvedMemo(item.observationHandle);
		const state = this.identityLedger.resolveObservationState(refreshed.observation);
		if (state.kind !== "identified") throw new Error("Recoverable delete requires one confirmed memo identity.");
		const captured = await this.markdownMutations.captureObservation({ observation: item.observationHandle });
		const deleteRecord = await this.identityLedger.recordDeletePayload(state.binding, {
			deletedAt: this.now().toISOString(),
			sourcePath: captured.observation.sourcePath,
			deletedSourceRevision: captured.deletedSourceRevision,
			logicalDate: captured.observation.logicalDate,
			section: captured.observation.section,
			rawBlock: captured.rawBlock,
			contentHash: captured.observation.contentHash,
			sourceMemoId: item.sourceMemoId,
		});
		const result = await this.markdownMutations.remove({ observation: item.observationHandle });
		let pending = true;
		try {
			await this.identityLedger.recordDeleteCommit(deleteRecord);
			pending = false;
		} catch {
			pending = true;
		}
		const saved = await this.finishMarkdownSavedMemo(result, [], { memoId: state.binding.memoId, pending });
		return pickDailyMutationResult(saved);
	}

	async restore(item: TrashMemoItem): Promise<MemoSaveResult> {
		if (this.identityLedger.getActiveDeletes === undefined
			|| this.identityLedger.recordRestore === undefined
			|| this.markdownMutations.restore === undefined) {
			throw new Error("Identity Ledger restore is unavailable.");
		}
		const record = this.identityLedger.getActiveDeletes()
			.find((candidate) => candidate.deleteEventId === item.deleteEventId);
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
		return this.finishMarkdownSavedMemo(result, result.observation?.timeBuoyDates ?? [], {
			memoId: item.memoId,
			pending,
		});
	}

	async purge(item: TrashMemoItem): Promise<void> {
		if (this.identityLedger.getActiveDeletes === undefined
			|| this.identityLedger.recordPurge === undefined) {
			throw new Error("Identity Ledger permanent delete is unavailable.");
		}
		const record = this.identityLedger.getActiveDeletes()
			.find((candidate) => candidate.deleteEventId === item.deleteEventId
				&& candidate.memoId === item.memoId);
		if (record === undefined || record.deleteCommitEventId === null) {
			throw new Error("Deleted memo payload is no longer active.");
		}
		await this.identityLedger.recordPurge(record);
	}

	async createReferenceText(item: CatalogMemoItem, sourcePath = ""): Promise<MemoReferenceResult> {
		const file = this.getFile(item.sourcePath);
		const anchored = await this.markdownMutations.createBlockReference({
			observation: item.observationHandle,
			sourcePath,
		});
		const saved = await this.finishMarkdownSavedMemo(
			anchored,
			anchored.observation?.timeBuoyDates ?? item.timeBuoyDates,
		);
		const link = this.app.fileManager.generateMarkdownLink(file, sourcePath, `#^${anchored.blockId}`);
		return {
			text: withCreatedAtAlias(link, `${item.observation.logicalDate}T${item.observation.time}`),
			memoId: null,
			followUpPending: saved.followUpPending,
			localRefreshPending: saved.localRefreshPending,
		};
	}

	async recordReview(item: CatalogMemoItem): Promise<void> {
		await this.readService.recordReview(item);
	}

	private async refreshResolvedMemo(handle: ObservationHandle): Promise<ResolvedMemo> {
		await this.options.refreshCatalogPaths([handle.sourcePath]);
		const refreshed = await this.readService.resolveObservationInFile(handle.sourcePath, handle.startLine);
		// 行索引只用于查询；刷新不能为旧操作重新授权另一个 occurrence。
		assertSameObservation(handle, refreshed.observation);
		return refreshed;
	}

	private async requireRecoverableDeleteItem(handle: ObservationHandle, memoId: string): Promise<CatalogMemoItem> {
		const prepared = await this.readService.resolveMemoItemInFile(
			handle.sourcePath,
			handle.startLine,
		);
		assertSameObservation(handle, prepared.observationHandle);
		if (prepared.memoId !== memoId || prepared.capabilities.identity.recoverableDelete !== "ready") {
			throw new Error("Identity preparation did not produce a recoverable memo.");
		}
		return { ...prepared, observationHandle: handle };
	}

	private async finishMarkdownSavedMemo(
		input: MarkdownMutationResult,
		timeBuoyDates: readonly string[],
		identity?: { memoId: string | null; pending: boolean },
	): Promise<MemoSaveResult> {
		let localRefreshPending = input.catalogUpdatePending;
		let memo: CatalogMemoItem | null = null;
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
			followUpPending: identity?.pending ?? input.status === "committed_content_pending",
			localRefreshPending,
		};
	}

	private startSaveOperation(
		action: (onDailyCommitted: () => void) => Promise<MemoSaveResult>,
	): MemoSaveOperation {
		let committed = false;
		let resolveCommitted: () => void = () => undefined;
		let rejectCommitted: (error: unknown) => void = () => undefined;
		const dailyCommitted = new Promise<void>((resolve, reject) => {
			resolveCommitted = resolve;
			rejectCommitted = reject;
		});
		const markCommitted = (): void => {
			if (committed) return;
			committed = true;
			resolveCommitted();
		};
		const settled = Promise.resolve()
			.then(() => action(markCommitted))
			.then((result) => {
				// 兼容只实现最终结果的测试替身；真实链路会在 Daily 提交点先触发。
				markCommitted();
				return result;
			})
			.catch((error: unknown) => {
				if (!committed) rejectCommitted(error);
				throw error;
			});
		// 阶段 Promise 允许调用方只观察其中一个，不产生未处理拒绝。
		void dailyCommitted.catch(() => undefined);
		void settled.catch(() => undefined);
		return { dailyCommitted, settled };
	}

	private async findMemoByObservation(observation: ResolvedMemo["observation"]): Promise<CatalogMemoItem | null> {
		let cursor: CatalogFeatureQuery["cursor"] = null;
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
}

function assertSameObservation(expected: ObservationHandle, actual: ObservationHandle): void {
	if (actual.sourcePath !== expected.sourcePath
		|| actual.sourceRevision !== expected.sourceRevision
		|| actual.startLine !== expected.startLine
		|| actual.endLine !== expected.endLine
		|| actual.rawBlockHash !== expected.rawBlockHash) {
		throw new MarkdownMutationStaleError(expected.sourcePath);
	}
}

function normalizeMemoInput(input: string): string {
	return input.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n");
}

function pickDailyMutationResult(result: MemoSaveResult): DailyMutationResult {
	return {
		status: result.status,
		memoId: result.memoId,
		followUpPending: result.followUpPending,
		localRefreshPending: result.localRefreshPending,
	};
}

import type { App, TFile } from "obsidian";

import type { MarkdownSyncSource, MemoRecord } from "../types/memo";
import type { PendingMemoCreate } from "../types/pending";
import { KnomoError } from "../types/serviceError";
import type { KnomoSettings } from "../types/settings";
import { matchesDailyNotePath } from "../utils/dailyNotes";
import { getIndexFolderPath } from "../utils/path";
import { DailyNoteService } from "./DailyNoteService";
import type { DailyNotesStatus } from "./DailyNoteService";
import { MarkdownBlockService } from "./MarkdownBlockService";
import { MemoCommandService } from "./memoCommands";
import type { CreateMemoOptions, CreateMemoResult } from "./memoCommands";
import { MemoIndexStore } from "./MemoIndexStore";
import { MemoQueryService } from "./memoQueries";
import { MemoReferenceService } from "./memoReferences";
import { MemoRepairService } from "./memoRepair";
import { MemoRestoreService } from "./memoRestore";
import { MemoScanService } from "./MemoScanService";
import type {
	EstimateDailyMemosResult,
	LegacyDailyMemosImportOptions,
	LegacyDailyMemosImportResult,
	LegacyDailyMemosImportScope,
	LegacyDailyMemosPreview,
	ScanDailyMemosProgress,
	ScanDailyMemosResult,
} from "./MemoScanService";
import { getMonthlyArchivePath, isMonthlyArchivePath, MonthlyArchiveService } from "./MonthlyArchiveService";
import { MonthlyArchiveRebuildService } from "./MonthlyArchiveRebuildService";
import type { RebuildMonthlyArchiveResult } from "./MonthlyArchiveRebuildService";
import { MemoRebuildService } from "./memoRebuild";
import type { RebuildIndexMode, RebuildIndexResult, RebuildIndexScope } from "./memoRebuild";
import type { PendingMemoCreateStoreLike } from "./PendingMemoCreateStore";
import { SelfWriteTracker } from "./SelfWriteTracker";
import {
	createMemoId,
	createOperationId,
} from "./syncHelpers";

// 职责：编排创建、编辑、删除、扫描、修复和跨文件部分失败状态。
export type { CreateMemoOptions, CreateMemoResult } from "./memoCommands";
export type { RebuildIndexMode, RebuildIndexResult, RebuildIndexScope } from "./memoRebuild";
export { createMemoId, createOperationId, normalizeMemoInput } from "./syncHelpers";

export class SyncOrchestrator {
	private readonly memoScanService: MemoScanService;
	private readonly memoRebuildService: MemoRebuildService;
	private readonly memoQueryService: MemoQueryService;
	private readonly memoCommandService: MemoCommandService;
	private readonly memoRestoreService: MemoRestoreService;
	private readonly memoReferenceService: MemoReferenceService;
	private readonly memoRepairService: MemoRepairService;
	private readonly monthlyArchiveRebuildService: MonthlyArchiveRebuildService;

	constructor(
		private readonly app: App,
		private readonly getSettings: () => KnomoSettings,
		private readonly dailyNoteService: DailyNoteService,
		private readonly monthlyArchiveService: MonthlyArchiveService,
		private readonly memoIndexStore: MemoIndexStore,
		private readonly selfWriteTracker: SelfWriteTracker,
		private readonly markdownBlockService = new MarkdownBlockService(),
		pendingMemoCreateStore?: PendingMemoCreateStoreLike,
	) {
		const activePendingMemoCreateStore = pendingMemoCreateStore
			?? createTransientPendingMemoCreateStore();
		this.memoScanService = new MemoScanService(
			this.app,
			this.getSettings,
			this.dailyNoteService,
			this.monthlyArchiveService,
			this.memoIndexStore,
			this.selfWriteTracker,
			this.markdownBlockService,
		);
		this.memoRebuildService = new MemoRebuildService(
			this.getSettings,
			this.memoScanService,
			this.monthlyArchiveService,
			this.memoIndexStore,
		);
		this.memoQueryService = new MemoQueryService(this.getSettings, this.memoIndexStore);
		this.memoCommandService = new MemoCommandService(
			this.app,
			this.getSettings,
			this.dailyNoteService,
			this.monthlyArchiveService,
			this.memoIndexStore,
			this.selfWriteTracker,
			this.markdownBlockService,
			activePendingMemoCreateStore,
		);
		this.memoRestoreService = new MemoRestoreService(
			this.app,
			this.getSettings,
			this.dailyNoteService,
			this.monthlyArchiveService,
			this.memoIndexStore,
			this.selfWriteTracker,
			this.markdownBlockService,
		);
		this.memoReferenceService = new MemoReferenceService(
			this.app,
			this.getSettings,
			this.monthlyArchiveService,
			this.memoIndexStore,
			this.selfWriteTracker,
			this.markdownBlockService,
		);
		this.memoRepairService = new MemoRepairService(
			this.app,
			this.getSettings,
			this.monthlyArchiveService,
			this.memoIndexStore,
			this.selfWriteTracker,
			this.markdownBlockService,
		);
		this.monthlyArchiveRebuildService = new MonthlyArchiveRebuildService(
			this.app,
			this.getSettings,
			this.monthlyArchiveService,
			this.memoIndexStore,
			this.selfWriteTracker,
			this.markdownBlockService,
		);
	}

	async createMemo(input: string, options: CreateMemoOptions = {}): Promise<CreateMemoResult> {
		return this.memoCommandService.createMemo(input, options);
	}

	async updateMemo(memo: MemoRecord, input: string): Promise<MemoRecord> {
		return this.memoCommandService.updateMemo(memo, input);
	}

	async deleteMemo(memo: MemoRecord): Promise<MemoRecord> {
		return this.memoCommandService.deleteMemo(memo);
	}

	async scanDailyMemos(onProgress?: (progress: ScanDailyMemosProgress) => void | Promise<void>): Promise<ScanDailyMemosResult> {
		await this.memoCommandService.recoverPendingCreates();
		const now = new Date();
		return this.memoScanService.scanDailyMemos((date) => createMemoId(date), createOperationId(now), onProgress);
	}

	async previewLegacyDailyMemos(scope: LegacyDailyMemosImportScope): Promise<LegacyDailyMemosPreview> {
		return this.memoScanService.previewLegacyDailyMemos(scope);
	}

	async importLegacyDailyMemos(options: LegacyDailyMemosImportOptions): Promise<LegacyDailyMemosImportResult> {
		await this.memoCommandService.recoverPendingCreates();
		const now = new Date();
		return this.memoScanService.importLegacyDailyMemos((date) => createMemoId(date), createOperationId(now), options);
	}

	async scanRecentDailyMemos(days: number, source: MarkdownSyncSource = "startup_scan"): Promise<ScanDailyMemosResult> {
		await this.memoCommandService.recoverPendingCreates();
		const now = new Date();
		const since = new Date(now.getFullYear(), now.getMonth(), now.getDate() - Math.max(days - 1, 0));
		return this.memoScanService.scanDailyMemos((date) => createMemoId(date), createOperationId(now), undefined, {
			since,
			source,
			deleteSource: source,
		});
	}

	async estimateRebuildIndex(scope: RebuildIndexScope): Promise<EstimateDailyMemosResult> {
		return this.memoRebuildService.estimateRebuildIndex(scope);
	}

	async rebuildIndex(
		scope: RebuildIndexScope,
		mode: RebuildIndexMode,
		onProgress?: (progress: ScanDailyMemosProgress) => void | Promise<void>,
	): Promise<RebuildIndexResult> {
		await this.memoCommandService.recoverPendingCreates();
		return this.memoRebuildService.rebuildIndex(scope, mode, onProgress);
	}

	async recoverPendingMemoCreates(): Promise<number> {
		return this.memoCommandService.recoverPendingCreates();
	}

	getDailyNotesStatus(): DailyNotesStatus {
		return this.dailyNoteService.getStatus();
	}

	getTodayDailyNotePath(): string | null {
		const status = this.dailyNoteService.getStatus();
		if (!status.enabled || status.format === null) {
			return null;
		}
		return this.dailyNoteService.getTodayDailyNotePath(status);
	}

	getSyncDebounceMs(): number {
		return this.getSettings().syncDebounceMs;
	}

	isPotentialDailyFile(path: string): boolean {
		const status = this.dailyNoteService.getStatus();
		if (!status.enabled || status.format === null) {
			return false;
		}
		return matchesDailyNotePath(path, {
			folder: status.folder,
			format: status.format,
		});
	}

	isMemoIndexFile(path: string): boolean {
		const indexFolderPath = getIndexFolderPath(this.getSettings().monthlyMemoFolder);
		if (!path.startsWith(`${indexFolderPath}/`)) {
			return false;
		}
		const fileName = path.slice(indexFolderPath.length + 1);
		return /^memo-index-\d{4}-\d{2}\.json$/.test(fileName);
	}

	isMonthlyArchiveFile(path: string): boolean {
		return isMonthlyArchivePath(this.getSettings(), path);
	}

	async rebuildMonthlyArchive(period: string): Promise<RebuildMonthlyArchiveResult> {
		await this.memoCommandService.recoverPendingCreates();
		return this.monthlyArchiveRebuildService.rebuildPeriod(period, {
			replaceExisting: true,
			createBackup: true,
		});
	}

	async recoverDeletedMonthlyArchive(path: string): Promise<boolean> {
		const settings = this.getSettings();
		if (!isMonthlyArchivePath(settings, path)) {
			return false;
		}
		const periods = this.memoIndexStore.listExistingPeriods(settings.monthlyMemoFolder)
			.filter((period) => getMonthlyArchivePath(settings, period) === path);
		if (periods.length !== 1) {
			throw new KnomoError("monthly_archive_period_unresolved", { path });
		}
		await this.memoCommandService.recoverPendingCreates();
		const result = await this.monthlyArchiveRebuildService.rebuildPeriod(periods[0], {
			replaceExisting: false,
			createBackup: false,
		});
		return result.archiveChanged || result.indexChanged;
	}

	async listCurrentMonthMemos(): Promise<MemoRecord[]> {
		return this.memoQueryService.listCurrentMonthMemos();
	}

	async listRecentMemos(): Promise<MemoRecord[]> {
		return this.memoQueryService.listRecentMemos();
	}

	listMemoIndexPeriods(): string[] {
		return this.memoQueryService.listMemoIndexPeriods();
	}

	async listMemosInPeriods(periods: string[]): Promise<MemoRecord[]> {
		return this.memoQueryService.listMemosInPeriods(periods);
	}

	async listMemos(): Promise<MemoRecord[]> {
		return this.memoQueryService.listMemos();
	}

	async listDeletedMemos(): Promise<MemoRecord[]> {
		return this.memoQueryService.listDeletedMemos();
	}

	async restoreMemo(memoId: string): Promise<MemoRecord> {
		return this.memoRestoreService.restoreMemo(memoId);
	}

	async purgeDeletedMemo(memoId: string): Promise<void> {
		await this.memoRestoreService.purgeDeletedMemo(memoId);
	}

	async listIssueMemos(): Promise<MemoRecord[]> {
		return this.memoQueryService.listIssueMemos();
	}

	async retryMonthlyDelete(memo: MemoRecord): Promise<MemoRecord> {
		return this.memoRestoreService.retryMonthlyDelete(memo);
	}

	async retryMonthlySync(memo: MemoRecord): Promise<MemoRecord> {
		return this.memoRepairService.retryMonthlySync(memo);
	}

	async ensureReferenceBlockId(memo: MemoRecord): Promise<string> {
		return this.memoReferenceService.ensureReferenceBlockId(memo);
	}

	async syncExternalDailyFile(file: TFile): Promise<boolean> {
		if (!this.isPotentialDailyFile(file.path)) {
			return false;
		}
		await this.memoCommandService.recoverPendingCreates();
		const result = await this.memoScanService.syncDailyFile(file, (date) => createMemoId(date), createOperationId(new Date()));
		return result.created > 0 || result.updated > 0 || result.deleted > 0;
	}

	async syncRenamedDailyFile(file: TFile, oldPath: string): Promise<boolean> {
		const wasDailyFile = this.isPotentialDailyFile(oldPath);
		const isDailyFile = this.isPotentialDailyFile(file.path);
		if (!wasDailyFile && !isDailyFile) {
			return false;
		}
		await this.memoCommandService.recoverPendingCreates();
		const opId = createOperationId(new Date());
		const result = wasDailyFile && isDailyFile
			? await this.memoScanService.syncRenamedDailyFile(file, oldPath, (date) => createMemoId(date), opId)
			: wasDailyFile
				? await this.memoScanService.syncDeletedDailyPath(oldPath, opId)
				: await this.memoScanService.syncDailyFile(file, (date) => createMemoId(date), opId);
		return result.created > 0 || result.updated > 0 || result.deleted > 0;
	}

	async syncDeletedDailyFile(path: string): Promise<boolean> {
		if (!this.isPotentialDailyFile(path)) {
			return false;
		}
		await this.memoCommandService.recoverPendingCreates();
		const result = await this.memoScanService.syncDeletedDailyPath(path, createOperationId(new Date()));
		return result.deleted > 0 || result.updated > 0;
	}

}

function createTransientPendingMemoCreateStore(): PendingMemoCreateStoreLike {
	const operations = new Map<string, PendingMemoCreate>();
	return {
		list: async () => [...operations.values()],
		add: async (operation) => {
			if (operations.has(operation.memoId)) {
				throw new Error(`Pending memo create already exists: ${operation.memoId}`);
			}
			operations.set(operation.memoId, operation);
		},
		update: async (operation) => {
			if (!operations.has(operation.memoId)) {
				throw new Error(`Pending memo create does not exist: ${operation.memoId}`);
			}
			operations.set(operation.memoId, operation);
		},
		remove: async (memoId) => {
			operations.delete(memoId);
		},
	};
}

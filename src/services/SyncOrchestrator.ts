import type { App, TFile } from "obsidian";

import type { MarkdownSyncSource, MemoRecord } from "../types/memo";
import type { KnomoSettings } from "../types/settings";
import { matchesDailyNotePath } from "../utils/dailyNotes";
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
import { MonthlyArchiveService } from "./MonthlyArchiveService";
import { MemoRebuildService } from "./memoRebuild";
import type { RebuildIndexMode, RebuildIndexResult, RebuildIndexScope } from "./memoRebuild";
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

	constructor(
		private readonly app: App,
		private readonly getSettings: () => KnomoSettings,
		private readonly dailyNoteService: DailyNoteService,
		private readonly monthlyArchiveService: MonthlyArchiveService,
		private readonly memoIndexStore: MemoIndexStore,
		private readonly selfWriteTracker: SelfWriteTracker,
		private readonly markdownBlockService = new MarkdownBlockService(),
	) {
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
		const now = new Date();
		return this.memoScanService.scanDailyMemos((date) => createMemoId(date), createOperationId(now), onProgress);
	}

	async previewLegacyDailyMemos(scope: LegacyDailyMemosImportScope): Promise<LegacyDailyMemosPreview> {
		return this.memoScanService.previewLegacyDailyMemos(scope);
	}

	async importLegacyDailyMemos(options: LegacyDailyMemosImportOptions): Promise<LegacyDailyMemosImportResult> {
		const now = new Date();
		return this.memoScanService.importLegacyDailyMemos((date) => createMemoId(date), createOperationId(now), options);
	}

	async scanRecentDailyMemos(days: number, source: MarkdownSyncSource = "startup_scan"): Promise<ScanDailyMemosResult> {
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
		return this.memoRebuildService.rebuildIndex(scope, mode, onProgress);
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

	async listCurrentMonthMemos(): Promise<MemoRecord[]> {
		return this.memoQueryService.listCurrentMonthMemos();
	}

	async listRecentMemos(): Promise<MemoRecord[]> {
		return this.memoQueryService.listRecentMemos();
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
		const result = await this.memoScanService.syncDailyFile(file, (date) => createMemoId(date), createOperationId(new Date()));
		return result.created > 0 || result.updated > 0 || result.deleted > 0;
	}

}

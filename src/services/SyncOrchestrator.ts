import { TFile } from "obsidian";
import type { App } from "obsidian";

import type { MarkdownSyncSource, MemoMutation, MemoRecord } from "../types/memo";
import type { PendingMemoCreate } from "../types/pending";
import { KnomoError } from "../types/serviceError";
import type { SyncConflictFile } from "../types/syncConflict";
import type { KnomoSettings } from "../types/settings";
import { matchesDailyNotePath } from "../utils/dailyNotes";
import { formatMonthPeriod } from "../utils/date";
import { getIndexFolderPath, getTimeBuoyIndexFolderPath } from "../utils/path";
import { DailyNoteService } from "./DailyNoteService";
import type { DailyNotesStatus } from "./DailyNoteService";
import { MarkdownBlockService } from "./MarkdownBlockService";
import { MemoCommandService } from "./memoCommands";
import type { CreateMemoOptions, CreateMemoResult } from "./memoCommands";
import { MemoIndexStore } from "./MemoIndexStore";
import { MemoQueryService } from "./memoQueries";
import type { DeletedMemoSummary, MemoListPageOptions } from "./memoQueries";
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
import type { PreparedRecordStats } from "./RecordStatsService";
import { SelfWriteTracker } from "./SelfWriteTracker";
import { TimeBuoyService } from "./TimeBuoyService";
import type { TimeBuoyMaintenanceOutcome } from "./TimeBuoyService";
import type { TimeBuoyAllQueryResult, TimeBuoyQueryResult } from "./TimeBuoyQueryService";
import type { TimeBuoyRebuildOptions, TimeBuoyRebuildResult } from "./TimeBuoyRebuildService";
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
	private readonly timeBuoyService: TimeBuoyService;
	private readonly operationGate = new MaintenanceOperationGate();

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
		this.timeBuoyService = new TimeBuoyService(
			this.app,
			this.getSettings,
			this.memoIndexStore,
			this.selfWriteTracker,
		);
		this.memoScanService = new MemoScanService(
			this.app,
			this.getSettings,
			this.dailyNoteService,
			this.monthlyArchiveService,
			this.memoIndexStore,
			this.selfWriteTracker,
			this.markdownBlockService,
			(mutation) => this.syncTimeBuoyMutation(mutation),
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

	async createMemoWithTimeBuoyOutcome(
		input: string,
		options: CreateMemoOptions = {},
	): Promise<{ result: CreateMemoResult; timeBuoy: TimeBuoyMaintenanceOutcome }> {
		return this.operationGate.runOperation(async () => {
			const result = await this.memoCommandService.createMemo(input, options);
			const timeBuoy = await this.timeBuoyService.syncMemoRecords(null, result.memo);
			return { result, timeBuoy };
		});
	}

	async updateMemo(memo: MemoRecord, input: string): Promise<MemoRecord> {
		return this.operationGate.runOperation(async () => {
			const updatedMemo = await this.memoCommandService.updateMemo(memo, input);
			await this.timeBuoyService.syncMemoRecords(memo, updatedMemo);
			return updatedMemo;
		});
	}

	async updateMemoWithTimeBuoyOutcome(
		memo: MemoRecord,
		input: string,
	): Promise<{ memo: MemoRecord; timeBuoy: TimeBuoyMaintenanceOutcome }> {
		return this.operationGate.runOperation(async () => {
			const updatedMemo = await this.memoCommandService.updateMemo(memo, input);
			const timeBuoy = await this.timeBuoyService.syncMemoRecords(memo, updatedMemo);
			return { memo: updatedMemo, timeBuoy };
		});
	}

	async deleteMemo(memo: MemoRecord): Promise<MemoRecord> {
		return this.operationGate.runOperation(async () => {
			const currentMemo = await this.refreshDailyIssueBeforeDelete(memo);
			if (currentMemo.status === "deleted") {
				return currentMemo;
			}
			if (currentMemo.issue?.type === "daily_block_ambiguous") {
				throw new KnomoError("delete_daily_block_ambiguous");
			}
			const deletedMemo = await this.memoCommandService.deleteMemo(currentMemo);
			await this.timeBuoyService.syncMemoRecords(currentMemo, deletedMemo);
			return deletedMemo;
		});
	}

	private async refreshDailyIssueBeforeDelete(memo: MemoRecord): Promise<MemoRecord> {
		if (!hasDailyLocationIssue(memo)) {
			return memo;
		}
		const file = this.app.vault.getAbstractFileByPath(memo.dailyRef.path);
		const now = new Date();
		if (file instanceof TFile) {
			await this.memoScanService.syncDailyFile(
				file,
				(date) => createMemoId(date),
				createOperationId(now),
				"file_watch",
				"file_watch",
			);
		} else {
			await this.memoScanService.syncDeletedDailyPath(memo.dailyRef.path, createOperationId(now));
		}
		const currentMemo = await this.memoIndexStore.findMemoByIdInPeriod(
			this.getSettings().monthlyMemoFolder,
			formatMonthPeriod(new Date(memo.createdAt)),
			memo.id,
		);
		if (currentMemo === null) {
			throw new KnomoError("memo_not_found_or_cleaned");
		}
		return currentMemo;
	}

	async previewLegacyDailyMemos(scope: LegacyDailyMemosImportScope): Promise<LegacyDailyMemosPreview> {
		return this.memoScanService.previewLegacyDailyMemos(scope);
	}

	async importLegacyDailyMemos(options: LegacyDailyMemosImportOptions): Promise<LegacyDailyMemosImportResult> {
		return this.operationGate.runOperation(async () => {
			await this.memoCommandService.recoverPendingCreates();
			const now = new Date();
			return this.memoScanService.importLegacyDailyMemos((date) => createMemoId(date), createOperationId(now), options);
		});
	}

	async scanRecentDailyMemos(days: number, source: MarkdownSyncSource = "startup_scan"): Promise<ScanDailyMemosResult> {
		return this.operationGate.runOperation(async () => {
			await this.memoCommandService.recoverPendingCreates();
			const now = new Date();
			const since = new Date(now.getFullYear(), now.getMonth(), now.getDate() - Math.max(days - 1, 0));
			const existingMemos = await this.memoIndexStore.loadExistingPeriods(
				this.getSettings().monthlyMemoFolder,
				getMonthPeriodsInRange(since, now),
			);
			return this.memoScanService.scanDailyMemos((date) => createMemoId(date), createOperationId(now), undefined, {
				since,
				existingMemos,
				source,
				deleteSource: source,
			});
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
		const result = await this.operationGate.runOperation(async () => {
			await this.memoCommandService.recoverPendingCreates();
			return this.memoRebuildService.rebuildIndex(scope, mode, onProgress);
		});
		if (this.timeBuoyService.isEnabled()) {
			try {
				await this.rebuildTimeBuoyIndex();
			} catch {
				this.timeBuoyService.markRebuildRequired();
			}
		}
		return result;
	}

	async recoverPendingMemoCreates(): Promise<number> {
		return this.operationGate.runOperation(() => this.memoCommandService.recoverPendingCreates());
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

	isTimeBuoyIndexFile(path: string): boolean {
		const folderPath = getTimeBuoyIndexFolderPath(this.getSettings().monthlyMemoFolder);
		return path.startsWith(`${folderPath}/time-buoy-`) && path.endsWith(".json");
	}

	isMonthlyArchiveFile(path: string): boolean {
		return isMonthlyArchivePath(this.getSettings(), path);
	}

	async rebuildMonthlyArchive(period: string): Promise<RebuildMonthlyArchiveResult> {
		return this.operationGate.runOperation(async () => {
			await this.memoCommandService.recoverPendingCreates();
			return this.monthlyArchiveRebuildService.rebuildPeriod(period, {
				replaceExisting: true,
				createBackup: true,
			});
		});
	}

	async runMonthlyMemoFileFormatMigration<T>(migration: () => Promise<T>): Promise<T> {
		return this.operationGate.runMaintenance(migration);
	}

	async runMonthlyMemoFolderMigration<T>(migration: () => Promise<T>): Promise<T> {
		return this.operationGate.runMaintenance(async () => {
			await this.memoCommandService.recoverPendingCreates();
			return migration();
		});
	}

	async rebuildMonthlyArchivesForFileFormatMigration(
		periods: string[],
		trackGeneratedPath: (path: string) => void,
	): Promise<void> {
		await this.memoCommandService.recoverPendingCreates();
		for (const period of periods) {
			const path = getMonthlyArchivePath(this.getSettings(), period);
			const targetExisted = this.app.vault.getAbstractFileByPath(path) !== null;
			let result: RebuildMonthlyArchiveResult;
			try {
				result = await this.monthlyArchiveRebuildService.rebuildPeriod(period, {
					replaceExisting: true,
					createBackup: false,
				});
			} finally {
				if (!targetExisted && this.app.vault.getAbstractFileByPath(path) !== null) {
					trackGeneratedPath(path);
				}
			}
			if (result.issues > 0) {
				throw new Error(`Monthly archive rebuild has ${result.issues} unresolved memos for ${period}.`);
			}
		}
	}

	async recoverDeletedMonthlyArchive(path: string): Promise<boolean> {
		return this.operationGate.runOperation(async () => {
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
		});
	}

	async listRecentMemos(): Promise<MemoRecord[]> {
		return this.memoQueryService.listRecentMemos();
	}

	listMemoIndexPeriods(): string[] {
		return this.memoQueryService.listMemoIndexPeriods();
	}

	listStoredMemoIndexPeriods(): string[] {
		return this.memoQueryService.listStoredMemoIndexPeriods();
	}

	listPotentialSyncConflictFiles(): SyncConflictFile[] {
		const settings = this.getSettings();
		return [
			...this.memoIndexStore.listPotentialSyncConflictFiles(settings.monthlyMemoFolder),
			...this.monthlyArchiveService.listPotentialSyncConflictFiles(settings),
		].sort((left, right) => left.path.localeCompare(right.path));
	}

	async listMemosInPeriods(periods: string[]): Promise<MemoRecord[]> {
		return this.memoQueryService.listMemosInPeriods(periods);
	}

	async listMemos(): Promise<MemoRecord[]> {
		return this.memoQueryService.listMemos();
	}

	async getDeletedMemoSummary(): Promise<DeletedMemoSummary> {
		return this.memoQueryService.getDeletedMemoSummary();
	}

	async listDeletedMemos(options: MemoListPageOptions = {}): Promise<MemoRecord[]> {
		return this.memoQueryService.listDeletedMemos(options);
	}

	async restoreMemoRecord(memo: MemoRecord): Promise<MemoRecord> {
		return this.operationGate.runOperation(async () => {
			const restoredMemo = await this.memoRestoreService.restoreMemoRecord(memo);
			await this.timeBuoyService.syncMemoRecords(memo, restoredMemo);
			return restoredMemo;
		});
	}

	async purgeDeletedMemoRecord(memo: MemoRecord): Promise<void> {
		await this.operationGate.runOperation(async () => {
			await this.memoRestoreService.purgeDeletedMemoRecord(memo);
			await this.timeBuoyService.syncMemoRecords(memo, null);
		});
	}

	async listIssueMemos(options: MemoListPageOptions = {}): Promise<MemoRecord[]> {
		return this.memoQueryService.listIssueMemos(options);
	}

	async buildRecordStats(
		yieldToUi: () => Promise<void>,
		isCurrent: () => boolean,
	): Promise<PreparedRecordStats | null> {
		return this.memoQueryService.buildRecordStats(yieldToUi, isCurrent);
	}

	async retryMonthlyDelete(memo: MemoRecord): Promise<MemoRecord> {
		return this.operationGate.runOperation(() => this.memoRestoreService.retryMonthlyDelete(memo));
	}

	async retryMonthlySync(memo: MemoRecord): Promise<MemoRecord> {
		return this.operationGate.runOperation(() => this.memoRepairService.retryMonthlySync(memo));
	}

	async ensureReferenceBlockId(memo: MemoRecord): Promise<string> {
		return this.operationGate.runOperation(() => this.memoReferenceService.ensureReferenceBlockId(memo));
	}

	async syncExternalDailyFile(file: TFile): Promise<boolean> {
		return this.operationGate.runOperation(async () => {
			if (!this.isPotentialDailyFile(file.path)) {
				return false;
			}
			await this.memoCommandService.recoverPendingCreates();
			const result = await this.memoScanService.syncDailyFile(file, (date) => createMemoId(date), createOperationId(new Date()));
			return result.created > 0 || result.updated > 0 || result.deleted > 0;
		});
	}

	async syncRenamedDailyFile(file: TFile, oldPath: string): Promise<boolean> {
		return this.operationGate.runOperation(async () => {
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
		});
	}

	async syncDeletedDailyFile(path: string): Promise<boolean> {
		return this.operationGate.runOperation(async () => {
			if (!this.isPotentialDailyFile(path)) {
				return false;
			}
			await this.memoCommandService.recoverPendingCreates();
			const result = await this.memoScanService.syncDeletedDailyPath(path, createOperationId(new Date()));
			return result.deleted > 0 || result.updated > 0;
		});
	}

	async queryTimeBuoysForDate(targetDate: string): Promise<TimeBuoyQueryResult> {
		return this.timeBuoyService.queryDate(targetDate);
	}

	async queryAllTimeBuoys(): Promise<TimeBuoyAllQueryResult> {
		return this.timeBuoyService.queryAll();
	}

	async rebuildTimeBuoyIndex(options: TimeBuoyRebuildOptions = {}): Promise<TimeBuoyRebuildResult> {
		return this.timeBuoyService.rebuild(options);
	}

	async needsTimeBuoyStartupRebuild(): Promise<boolean> {
		return this.timeBuoyService.needsStartupRebuild();
	}

	deferTimeBuoyStartupRebuild(): void {
		this.timeBuoyService.markRebuildRequired();
	}

	private async syncTimeBuoyMutation(mutation: MemoMutation): Promise<void> {
		await this.timeBuoyService.syncMutation(mutation);
	}

}

export function getMonthPeriodsInRange(start: Date, end: Date): string[] {
	const periods: string[] = [];
	const cursor = new Date(start.getFullYear(), start.getMonth(), 1);
	const last = new Date(end.getFullYear(), end.getMonth(), 1);
	while (cursor <= last) {
		periods.push(formatMonthPeriod(cursor));
		cursor.setMonth(cursor.getMonth() + 1);
	}
	return periods;
}

function hasDailyLocationIssue(memo: MemoRecord): boolean {
	return memo.issue?.type === "daily_block_missing"
		|| memo.issue?.type === "daily_block_ambiguous"
		|| memo.issue?.code === "delete_daily_block_missing"
		|| memo.issue?.code === "delete_daily_block_ambiguous";
}

class MaintenanceOperationGate {
	private activeOperations = 0;
	private readonly idleResolvers: Array<() => void> = [];
	private maintenanceBarrier: Promise<void> | null = null;
	private releaseMaintenanceBarrier: (() => void) | null = null;
	private maintenanceQueue: Promise<void> = Promise.resolve();
	private operationQueue: Promise<void> = Promise.resolve();

	async runOperation<T>(operation: () => Promise<T>): Promise<T> {
		const previousOperation = this.operationQueue;
		let releaseOperation: () => void = () => undefined;
		this.operationQueue = new Promise<void>((resolve) => {
			releaseOperation = resolve;
		});
		await previousOperation;
		try {
			while (this.maintenanceBarrier !== null) {
				await this.maintenanceBarrier;
			}
			this.activeOperations += 1;
			try {
				return await operation();
			} finally {
				this.activeOperations -= 1;
				if (this.activeOperations === 0) {
					for (const resolve of this.idleResolvers.splice(0)) {
						resolve();
					}
				}
			}
		} finally {
			releaseOperation();
		}
	}

	async runMaintenance<T>(operation: () => Promise<T>): Promise<T> {
		const previousMaintenance = this.maintenanceQueue;
		let releaseQueue: () => void = () => undefined;
		this.maintenanceQueue = new Promise<void>((resolve) => {
			releaseQueue = resolve;
		});
		await previousMaintenance;
		this.maintenanceBarrier = new Promise<void>((resolve) => {
			this.releaseMaintenanceBarrier = resolve;
		});
		if (this.activeOperations > 0) {
			await new Promise<void>((resolve) => this.idleResolvers.push(resolve));
		}
		try {
			return await operation();
		} finally {
			const releaseBarrier = this.releaseMaintenanceBarrier;
			this.maintenanceBarrier = null;
			this.releaseMaintenanceBarrier = null;
			releaseBarrier?.();
			releaseQueue();
		}
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

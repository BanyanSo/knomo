import { normalizePath } from "obsidian";

import type { MemoRecord } from "../types/memo";
import type { KnomoSettings } from "../types/settings";
import { KnomoError } from "../types/serviceError";
import { formatMonthPeriod } from "../utils/date";
import type { MemoIndexStore } from "./MemoIndexStore";
import type { SyncConflictIndexCleanupResult } from "./MemoIndexStore";
import type {
	EstimateDailyMemosResult,
	ScanDailyMemosProgress,
	ScanDailyMemosResult,
} from "./MemoScanService";
import type { MemoScanService } from "./MemoScanService";
import type { MonthlyArchiveService } from "./MonthlyArchiveService";
import {
	createMemoId,
	createOperationId,
} from "./syncHelpers";

type GetSettings = () => KnomoSettings;

export type RebuildIndexScope = "30d" | "90d" | "all";
export type RebuildIndexMode = "index-only" | "index-and-monthly";

export interface RebuildIndexResult extends ScanDailyMemosResult {
	backupPath: string | null;
	duplicateIndexRecordsRemoved: number;
	syncConflictIndexFilesDeleted: number;
	syncConflictIndexFileDeleteFailed: number;
	firstFailedSyncConflictIndexPath: string | null;
}

export class MemoRebuildService {
	constructor(
		private readonly getSettings: GetSettings,
		private readonly memoScanService: MemoScanService,
		private readonly monthlyArchiveService: MonthlyArchiveService,
		private readonly memoIndexStore: MemoIndexStore,
	) {}

	async estimateRebuildIndex(scope: RebuildIndexScope): Promise<EstimateDailyMemosResult> {
		const settings = this.getSettings();
		const since = getRebuildSince(scope);
		const existingMemos = this.filterRecoverableMemosForScope(
			await this.memoIndexStore.loadRepairRecoverableMemos(settings.monthlyMemoFolder),
			since,
		);
		return this.memoScanService.estimateDailyMemos({
			since,
			source: "manual_scan",
			deleteSource: "manual_scan",
			existingMemos,
		});
	}

	async rebuildIndex(
		scope: RebuildIndexScope,
		mode: RebuildIndexMode,
		onProgress?: (progress: ScanDailyMemosProgress) => void | Promise<void>,
	): Promise<RebuildIndexResult> {
		const settings = this.getSettings();
		const backupPath = await this.memoIndexStore.backupIndexes(settings.monthlyMemoFolder, "rebuild-index");
		if (mode === "index-and-monthly") {
			await this.monthlyArchiveService.backupMonthlyArchives(settings, backupPath);
		}
		const now = new Date();
		try {
			if (scope === "all") {
				if (backupPath === null) {
					throw new Error("Rebuild index backup path was not created.");
				}
				const candidateIndexFolder = normalizePath(`${backupPath}/rebuilt-indexes`);
				const candidateStore = this.memoIndexStore.createStoreAtIndexFolder(candidateIndexFolder);
				const recoverableMemos = await this.memoIndexStore.loadRepairRecoverableMemos(settings.monthlyMemoFolder);
				const existingPeriods = [
					...new Set([
						...this.memoIndexStore.listExistingPeriods(settings.monthlyMemoFolder),
						...recoverableMemos.map((memo) => formatMonthPeriod(new Date(memo.createdAt))),
					]),
				];
				await candidateStore.initializeEmptyPeriods(settings.monthlyMemoFolder, existingPeriods);
				for (const memo of recoverableMemos) {
					await candidateStore.upsertMemo(settings.monthlyMemoFolder, memo);
				}
				const result = await this.memoScanService.scanDailyMemos((date) => createMemoId(date), createOperationId(now), onProgress, {
					source: "manual_scan",
					deleteSource: "manual_scan",
					syncMonthly: mode === "index-and-monthly",
					existingMemos: recoverableMemos,
					memoIndexStore: candidateStore,
				});
				if (result.failed > 0) {
					throw buildRebuildIndexFailedError(result.failed, backupPath);
				}
				const rebuiltPeriods = [
					...new Set([
						...existingPeriods,
						...candidateStore.listExistingPeriods(settings.monthlyMemoFolder),
					]),
				];
				await candidateStore.loadPeriods(settings.monthlyMemoFolder, rebuiltPeriods);
				await this.memoIndexStore.commitCandidateIndexes(
					settings.monthlyMemoFolder,
					candidateIndexFolder,
					rebuiltPeriods,
				);
				const duplicateIndexRecordsRemoved = await this.compactDuplicateDailyBlockMemos(settings.monthlyMemoFolder, new Set(rebuiltPeriods));
				const cleanup = await this.trashSyncConflictIndexFiles(settings.monthlyMemoFolder, scope);
				return {
					...result,
					backupPath,
					duplicateIndexRecordsRemoved,
					syncConflictIndexFilesDeleted: cleanup.deleted,
					syncConflictIndexFileDeleteFailed: cleanup.failed,
					firstFailedSyncConflictIndexPath: cleanup.firstFailedPath,
				};
			}

			const since = getRebuildSince(scope);
			const recoverableMemos = this.filterRecoverableMemosForScope(
				await this.memoIndexStore.loadRepairRecoverableMemos(settings.monthlyMemoFolder),
				since,
			);
			if (backupPath === null) {
				throw new Error("Rebuild index backup path was not created.");
			}
			const candidateIndexFolder = normalizePath(`${backupPath}/rebuilt-indexes`);
			const candidateStore = this.memoIndexStore.createStoreAtIndexFolder(candidateIndexFolder);
			const cleanupPeriods = getRebuildCleanupPeriods(scope) ?? new Set<string>();
			const candidatePeriods = [
				...new Set([
					...cleanupPeriods,
					...recoverableMemos.map((memo) => formatMonthPeriod(new Date(memo.createdAt))),
				]),
			];
			await candidateStore.initializeEmptyPeriods(settings.monthlyMemoFolder, candidatePeriods);
			for (const memo of recoverableMemos) {
				await candidateStore.upsertMemo(settings.monthlyMemoFolder, memo);
			}
			const result = await this.memoScanService.scanDailyMemos((date) => createMemoId(date), createOperationId(now), onProgress, {
				since,
				source: "manual_scan",
				deleteSource: "manual_scan",
				syncMonthly: mode === "index-and-monthly",
				existingMemos: recoverableMemos,
				memoIndexStore: candidateStore,
			});
			if (result.failed > 0) {
				throw buildRebuildIndexFailedError(result.failed, backupPath);
			}
			const rebuiltPeriods = [
				...new Set([
					...candidatePeriods,
					...candidateStore.listExistingPeriods(settings.monthlyMemoFolder),
				]),
			];
			await candidateStore.loadPeriods(settings.monthlyMemoFolder, rebuiltPeriods);
			await this.memoIndexStore.commitCandidateIndexes(
				settings.monthlyMemoFolder,
				candidateIndexFolder,
				rebuiltPeriods,
			);
			const duplicateIndexRecordsRemoved = await this.compactDuplicateDailyBlockMemos(settings.monthlyMemoFolder, new Set(rebuiltPeriods));
			const cleanup = await this.trashSyncConflictIndexFiles(settings.monthlyMemoFolder, scope);
			return {
				...result,
				backupPath,
				duplicateIndexRecordsRemoved,
				syncConflictIndexFilesDeleted: cleanup.deleted,
				syncConflictIndexFileDeleteFailed: cleanup.failed,
				firstFailedSyncConflictIndexPath: cleanup.firstFailedPath,
			};
		} catch (error) {
			if (mode === "index-and-monthly") {
				await this.monthlyArchiveService.restoreMonthlyArchives(settings, backupPath);
			}
			await this.memoIndexStore.restoreIndexes(settings.monthlyMemoFolder, backupPath);
			throw appendBackupPathToError(error, backupPath);
		}
	}

	private async trashSyncConflictIndexFiles(
		monthlyMemoFolder: string,
		scope: RebuildIndexScope,
	): Promise<SyncConflictIndexCleanupResult> {
		const memoIndexStore = this.memoIndexStore as MemoIndexStore & {
			trashPotentialSyncConflictFiles?: (
				monthlyMemoFolder: string,
				periods?: ReadonlySet<string>,
			) => Promise<SyncConflictIndexCleanupResult>;
		};
		if (typeof memoIndexStore.trashPotentialSyncConflictFiles !== "function") {
			return {
				deleted: 0,
				failed: 0,
				firstFailedPath: null,
			};
		}
		const cleanupPeriods = getRebuildCleanupPeriods(scope);
		return memoIndexStore.trashPotentialSyncConflictFiles(
			monthlyMemoFolder,
			cleanupPeriods ?? undefined,
		);
	}

	private async compactDuplicateDailyBlockMemos(
		monthlyMemoFolder: string,
		periods?: ReadonlySet<string>,
	): Promise<number> {
		const memoIndexStore = this.memoIndexStore as MemoIndexStore & {
			compactDuplicateDailyBlockMemos?: (
				monthlyMemoFolder: string,
				periods?: ReadonlySet<string>,
			) => Promise<number>;
		};
		if (typeof memoIndexStore.compactDuplicateDailyBlockMemos !== "function") {
			return 0;
		}
		return memoIndexStore.compactDuplicateDailyBlockMemos(monthlyMemoFolder, periods);
	}

	private filterRecoverableMemosForScope(memos: MemoRecord[], since: Date | undefined): MemoRecord[] {
		if (since === undefined) {
			return memos;
		}
		return memos.filter((memo) => {
			const createdAt = new Date(memo.createdAt);
			return Number.isFinite(createdAt.getTime()) && createdAt >= since;
		});
	}
}

function buildRebuildIndexFailedError(failedFiles: number, backupPath: string | null): Error {
	return appendBackupPathToError(new KnomoError("rebuild_index_failed", { count: failedFiles }), backupPath);
}

function appendBackupPathToError(error: unknown, backupPath: string | null): Error {
	if (error instanceof KnomoError) {
		if (error.params.backupPath !== undefined || error.params.backupMissing === true) {
			return error;
		}
		return new KnomoError(error.code, {
			...error.params,
			...(backupPath === null ? { backupMissing: true } : { backupPath }),
		}, error.detail);
	}
	const message = error instanceof Error ? error.message : "Rebuild index failed.";
	const backupText = backupPath === null ? "No restorable previous index backup was found." : `Backup path: ${backupPath}`;
	if (message.includes("Backup path:") || message.includes("No restorable previous index backup was found.")) {
		return new Error(message);
	}
	return new Error(`${message}\n${backupText}`);
}

function getRebuildSince(scope: RebuildIndexScope): Date | undefined {
	if (scope === "all") {
		return undefined;
	}
	const days = scope === "30d" ? 30 : 90;
	const now = new Date();
	return new Date(now.getFullYear(), now.getMonth(), now.getDate() - Math.max(days - 1, 0));
}

function getRebuildCleanupPeriods(scope: RebuildIndexScope): Set<string> | null {
	const since = getRebuildSince(scope);
	if (since === undefined) {
		return null;
	}
	const periods = new Set<string>();
	const now = new Date();
	const cursor = new Date(since.getFullYear(), since.getMonth(), 1);
	const end = new Date(now.getFullYear(), now.getMonth(), 1);
	while (cursor <= end) {
		periods.add(formatMonthPeriod(cursor));
		cursor.setMonth(cursor.getMonth() + 1);
	}
	return periods;
}

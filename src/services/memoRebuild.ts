import { normalizePath } from "obsidian";

import type { KnomoSettings } from "../types/settings";
import { KnomoError } from "../types/serviceError";
import type { MemoIndexStore } from "./MemoIndexStore";
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
}

export class MemoRebuildService {
	constructor(
		private readonly getSettings: GetSettings,
		private readonly memoScanService: MemoScanService,
		private readonly monthlyArchiveService: MonthlyArchiveService,
		private readonly memoIndexStore: MemoIndexStore,
	) {}

	async estimateRebuildIndex(scope: RebuildIndexScope): Promise<EstimateDailyMemosResult> {
		return this.memoScanService.estimateDailyMemos({
			since: getRebuildSince(scope),
			source: "manual_scan",
			deleteSource: "manual_scan",
			existingMemos: scope === "all" ? [] : undefined,
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
				const existingPeriods = this.memoIndexStore.listExistingPeriods(settings.monthlyMemoFolder);
				await candidateStore.initializeEmptyPeriods(settings.monthlyMemoFolder, existingPeriods);
				const result = await this.memoScanService.scanDailyMemos((date) => createMemoId(date), createOperationId(now), onProgress, {
					source: "manual_scan",
					deleteSource: "manual_scan",
					syncMonthly: mode === "index-and-monthly",
					existingMemos: [],
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
				return {
					...result,
					backupPath,
				};
			}
			const result = await this.memoScanService.scanDailyMemos((date) => createMemoId(date), createOperationId(now), onProgress, {
				since: getRebuildSince(scope),
				source: "manual_scan",
				deleteSource: "manual_scan",
				syncMonthly: mode === "index-and-monthly",
			});
			if (result.failed > 0) {
				throw buildRebuildIndexFailedError(result.failed, backupPath);
			}
			return {
				...result,
				backupPath,
			};
		} catch (error) {
			if (mode === "index-and-monthly") {
				await this.monthlyArchiveService.restoreMonthlyArchives(settings, backupPath);
			}
			await this.memoIndexStore.restoreIndexes(settings.monthlyMemoFolder, backupPath);
			throw appendBackupPathToError(error, backupPath);
		}
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

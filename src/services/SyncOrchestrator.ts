import { TFile } from "obsidian";
import type { App } from "obsidian";

import type { DailyRef, MarkdownSyncSource, MemoRecord, MonthlyRef, ParsedMemoBlock } from "../types/memo";
import type { KnomoSettings } from "../types/settings";
import { formatLocalIsoString, formatMemoIdPrefix, formatMonthPeriod, formatTimePart } from "../utils/date";
import { matchesDailyNotePath } from "../utils/dailyNotes";
import { hashMemoContent, hashText } from "../utils/hash";
import { findLineNumber, splitMarkdownLines } from "../utils/markdown";
import { buildDailyRef } from "../utils/memoRefs";
import { getIndexFilePath } from "../utils/path";
import { buildMemoReferences } from "../utils/references";
import { DailyNoteService } from "./DailyNoteService";
import type { DailyNotesStatus } from "./DailyNoteService";
import { MarkdownBlockService } from "./MarkdownBlockService";
import { MemoIndexStore } from "./MemoIndexStore";
import { MemoScanService } from "./MemoScanService";
import type { EstimateDailyMemosResult, ScanDailyMemosProgress, ScanDailyMemosResult } from "./MemoScanService";
import {
	formatMonthlyDateHeading,
	getMonthlyArchivePath,
	MonthlyArchiveMissingError,
	MonthlyArchiveService,
} from "./MonthlyArchiveService";
import { SelfWriteTracker } from "./SelfWriteTracker";

// 职责：编排创建、编辑、删除、扫描、修复和跨文件部分失败状态。
export interface CreateMemoResult {
	memo: MemoRecord;
	opId: string;
}

export interface CreateMemoOptions {
	source?: MemoRecord["source"];
	sourceMemoId?: string | null;
	sourceReferenceText?: string | null;
	dailyTrailer?: string | null;
}

export type RebuildIndexScope = "30d" | "90d" | "all";
export type RebuildIndexMode = "index-only" | "index-and-monthly";

export interface RebuildIndexResult extends ScanDailyMemosResult {
	backupPath: string | null;
}

interface RestoreDailyResult {
	ref: DailyRef;
	block: ParsedMemoBlock;
	content: string;
	changed: boolean;
	filePath: string;
}

interface RestoreMonthlyResult {
	ref: MonthlyRef;
	content: string;
	changed: boolean;
	filePath: string;
}

export class SyncOrchestrator {
	private readonly memoScanService: MemoScanService;

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
	}

	async createMemo(input: string, options: CreateMemoOptions = {}): Promise<CreateMemoResult> {
		const content = normalizeMemoInput(input);
		if (content.trim().length === 0) {
			throw new Error("Memo 内容不能为空。");
		}

		const settings = this.getSettings();
		const createdAt = new Date();
		const createdAtText = formatLocalIsoString(createdAt);
		const opId = createOperationId(createdAt);
		const memoId = createMemoId(createdAt);
		const block = this.markdownBlockService.buildMemoBlock(content, formatTimePart(createdAt, settings.memoTimeFormat));
		const contentHash = hashMemoContent(content);
		const metadata = this.markdownBlockService.parseMemoMetadata(content);
		const dailyResult = await this.dailyNoteService.insertMemoBlock(settings, block, options.dailyTrailer ?? undefined);
		this.markSelfWrite(opId, dailyResult.file.path, "create", dailyResult.content);

		let monthlyRef: MonthlyRef;
		let syncStatus: MemoRecord["syncStatus"] = "synced";
		let issue: MemoRecord["issue"] = null;
		try {
			const monthlyResult = await this.monthlyArchiveService.insertMemoBlock(settings, createdAt, block);
			monthlyRef = monthlyResult.ref;
			this.markSelfWrite(opId, monthlyResult.file.path, "archive", monthlyResult.content);
		} catch (error) {
			syncStatus = "monthly_failed";
			issue = {
				type: "monthly_sync_failed",
				detectedAt: new Date().toISOString(),
				message: error instanceof Error ? error.message : "月度归档同步失败。",
			};
			monthlyRef = {
				path: "",
				dateHeading: "",
				lastKnownBlock: "",
				lastKnownHash: "",
				lineNumberHint: null,
				lastSyncedAt: null,
			};
		}

		const memo: MemoRecord = {
			id: memoId,
			createdAt: createdAtText,
			updatedAt: createdAtText,
			contentSnapshot: content,
			contentHash,
			status: "active",
			syncStatus,
			source: options.source ?? "plugin_input",
			version: 1,
			tags: metadata.tags,
			links: metadata.links,
			images: metadata.images,
			references: buildMemoReferences(content, options.sourceMemoId ?? null, options.sourceReferenceText ?? null),
			sourceMemoId: options.sourceMemoId ?? null,
			issue,
			lastMarkdownSyncAt: null,
			lastMarkdownSyncSource: null,
			dailyRef: dailyResult.ref,
			monthlyRef,
		};

		let savedMemo: MemoRecord;
		try {
			savedMemo = await this.memoIndexStore.addMemo(
				settings.monthlyMemoFolder,
				memo,
				() => createMemoId(createdAt),
			);
		} catch (error) {
			throw buildIndexWriteFailedError("创建", error, dailyResult.file.path, monthlyRef.path);
		}
		this.markIndexSelfWrite(opId, settings, createdAt);

		return { memo: savedMemo, opId };
	}

	async updateMemo(memo: MemoRecord, input: string): Promise<MemoRecord> {
		const content = normalizeMemoInput(input);
		if (content.trim().length === 0) {
			throw new Error("Memo 内容不能为空。");
		}

		const settings = this.getSettings();
		const dailyFile = this.getTextFile(memo.dailyRef.path, "日记文件不存在。");
		const opId = createOperationId(new Date());
		let nextDailyBlock = "";
		let dailyIssueType: MemoRecord["issue"] = null;
		let dailyContent = "";
		let dailyLineNumberHint = memo.dailyRef.lineNumberHint;
		try {
			dailyContent = await this.app.vault.process(dailyFile, (currentContent) => {
				const location = this.markdownBlockService.findMemoBlock(currentContent, {
					lineNumberHint: memo.dailyRef.lineNumberHint,
					lastKnownBlock: memo.dailyRef.lastKnownBlock,
					lastKnownHash: memo.dailyRef.lastKnownHash,
					contentHash: memo.contentHash,
					allowLineHintTimeMatch: true,
				}, "daily_block_missing");
				if (location.parsedBlock === null) {
					dailyIssueType = {
						type: location.issueType ?? "daily_block_missing",
						detectedAt: new Date().toISOString(),
						message: "无法定位日记中的 memo block。",
					};
					throw new Error(dailyIssueType.message);
				}
				nextDailyBlock = this.markdownBlockService.buildMemoBlockWithBlockId(
					content,
					location.parsedBlock.time,
					location.parsedBlock.blockId,
				);
				dailyLineNumberHint = location.parsedBlock.startLine + 1;
				const lines = splitMarkdownLines(currentContent);
				lines.splice(
					location.parsedBlock.startLine,
					location.parsedBlock.endLine - location.parsedBlock.startLine + 1,
					...splitMarkdownLines(nextDailyBlock),
				);
				return lines.join("\n");
			});
		} catch (error) {
			if (dailyIssueType !== null) {
				await this.memoIndexStore.upsertMemo(settings.monthlyMemoFolder, {
					...memo,
					issue: dailyIssueType,
				});
			}
			throw error;
		}
		this.markSelfWrite(opId, dailyFile.path, "edit", dailyContent);

		const metadata = this.markdownBlockService.parseMemoMetadata(content);
		const contentHash = hashMemoContent(content);
		let syncStatus: MemoRecord["syncStatus"] = "synced";
		let issue: MemoRecord["issue"] = null;
		let monthlyRef = memo.monthlyRef;
		try {
			const monthlyResult = await this.monthlyArchiveService.upsertMemoBlock(settings, {
				...memo,
				contentSnapshot: content,
				contentHash,
				tags: metadata.tags,
				links: metadata.links,
				images: metadata.images,
			}, nextDailyBlock);
			monthlyRef = monthlyResult.ref;
			this.markSelfWrite(opId, monthlyResult.file.path, "archive", monthlyResult.content);
		} catch (error) {
			syncStatus = "monthly_failed";
			issue = buildMonthlyIssue(error);
		}

		let updatedMemo: MemoRecord;
		try {
			updatedMemo = await this.memoIndexStore.upsertMemo(settings.monthlyMemoFolder, {
				...memo,
				updatedAt: new Date().toISOString(),
				contentSnapshot: content,
				contentHash,
				syncStatus,
				version: memo.version + 1,
				tags: metadata.tags,
				links: metadata.links,
				images: metadata.images,
				references: buildMemoReferences(content, memo.sourceMemoId, memo.references[0]?.referenceText ?? null),
				issue,
				dailyRef: buildDailyRef(dailyFile.path, memo.dailyRef.heading, nextDailyBlock, dailyLineNumberHint),
				monthlyRef,
			});
		} catch (error) {
			throw buildIndexWriteFailedError("编辑", error, dailyFile.path, monthlyRef.path);
		}
		this.markIndexSelfWrite(opId, settings, new Date(memo.createdAt));
		return updatedMemo;
	}

	async deleteMemo(memo: MemoRecord): Promise<MemoRecord> {
		const settings = this.getSettings();
		const currentMemo = await this.memoIndexStore.findMemoById(settings.monthlyMemoFolder, memo.id);
		if (currentMemo === null) {
			throw new Error("Memo 不存在或已被清理。");
		}
		if (currentMemo.status === "deleted") {
			return currentMemo;
		}
		if (currentMemo.status !== "active") {
			return currentMemo;
		}

		const dailyFile = this.getTextFile(currentMemo.dailyRef.path, "日记文件不存在。");
		const opId = createOperationId(new Date());
		let deletedDailyBlock = "";
		let dailyIssueType: MemoRecord["issue"] = null;
		let dailyContent = "";
		try {
			dailyContent = await this.app.vault.process(dailyFile, (currentContent) => {
				const location = this.markdownBlockService.findMemoBlock(currentContent, {
					lineNumberHint: currentMemo.dailyRef.lineNumberHint,
					lastKnownBlock: currentMemo.dailyRef.lastKnownBlock,
					lastKnownHash: currentMemo.dailyRef.lastKnownHash,
					contentHash: currentMemo.contentHash,
				}, "daily_block_missing");
				if (location.parsedBlock === null) {
					dailyIssueType = {
						type: "delete_failed",
						detectedAt: new Date().toISOString(),
						message: "无法定位要删除的日记 memo block。",
					};
					throw new Error(dailyIssueType.message);
				}
				deletedDailyBlock = location.parsedBlock.rawBlock;
				return this.markdownBlockService.deleteMemoBlock(currentContent, location.parsedBlock.startLine);
			});
		} catch (error) {
			if (dailyIssueType !== null) {
				await this.memoIndexStore.upsertMemo(settings.monthlyMemoFolder, {
					...currentMemo,
					issue: dailyIssueType,
				});
			}
			throw error;
		}
		this.markSelfWrite(opId, dailyFile.path, "delete", dailyContent);

		let syncStatus: MemoRecord["syncStatus"] = "synced";
		let issue: MemoRecord["issue"] = null;
		let deletedMonthlyBlock = hasValidMonthlyRef(currentMemo) ? currentMemo.monthlyRef.lastKnownBlock : "";
		if (hasValidMonthlyRef(currentMemo)) {
			try {
				const monthlyResult = await this.monthlyArchiveService.deleteMemoBlock(currentMemo);
				deletedMonthlyBlock = monthlyResult.ref.lastKnownBlock;
				this.markSelfWrite(opId, monthlyResult.file.path, "archive", monthlyResult.content);
			} catch (error) {
				syncStatus = "monthly_delete_failed";
				issue = {
					type: "delete_failed",
					detectedAt: new Date().toISOString(),
					message: error instanceof Error ? error.message : "月度归档删除失败。",
				};
			}
		}

		let deletedMemo: MemoRecord;
		try {
			deletedMemo = await this.memoIndexStore.upsertMemo(settings.monthlyMemoFolder, {
				...currentMemo,
				status: "deleted",
				syncStatus,
				issue,
				deletedAt: new Date().toISOString(),
				deleteSource: "knomo_ui",
				deletedDailyBlock,
				deletedMonthlyBlock,
			});
		} catch (error) {
			console.error("Knomo delete memo index write failed.", error);
			throw buildIndexWriteFailedError("删除", error, dailyFile.path, currentMemo.monthlyRef.path);
		}
		this.markIndexSelfWrite(opId, settings, new Date(currentMemo.createdAt));
		return deletedMemo;
	}

	async scanDailyMemos(onProgress?: (progress: ScanDailyMemosProgress) => void | Promise<void>): Promise<ScanDailyMemosResult> {
		const now = new Date();
		return this.memoScanService.scanDailyMemos((date) => createMemoId(date), createOperationId(now), onProgress);
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
		return this.memoScanService.estimateDailyMemos({
			since: getRebuildSince(scope),
			source: "manual_scan",
			deleteSource: "manual_scan",
		});
	}

	async rebuildIndex(
		scope: RebuildIndexScope,
		mode: RebuildIndexMode,
		onProgress?: (progress: ScanDailyMemosProgress) => void | Promise<void>,
	): Promise<RebuildIndexResult> {
		const settings = this.getSettings();
		const backupPath = await this.memoIndexStore.backupIndexes(settings.monthlyMemoFolder, "rebuild-index");
		const now = new Date();
		const result = await this.memoScanService.scanDailyMemos((date) => createMemoId(date), createOperationId(now), onProgress, {
			since: getRebuildSince(scope),
			source: "manual_scan",
			deleteSource: "manual_scan",
			syncMonthly: mode === "index-and-monthly",
		});
		return {
			...result,
			backupPath,
		};
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
		const settings = this.getSettings();
		const period = formatMonthPeriod(new Date());
		const index = await this.memoIndexStore.loadPeriod(settings.monthlyMemoFolder, period);
		return Object.values(index.memos)
			.filter((memo) => memo.status === "active")
			.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
	}

	async listRecentMemos(): Promise<MemoRecord[]> {
		const settings = this.getSettings();
		const now = new Date();
		const periods = [
			formatMonthPeriod(now),
			formatMonthPeriod(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
		];
		const memos = await this.memoIndexStore.loadPeriods(settings.monthlyMemoFolder, periods);
		return memos
			.filter((memo) => memo.status === "active")
			.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
	}

	async listMemos(): Promise<MemoRecord[]> {
		const settings = this.getSettings();
		const memos = await this.memoIndexStore.loadAll(settings.monthlyMemoFolder);
		return memos
			.filter((memo) => memo.status === "active")
			.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
	}

	async listDeletedMemos(): Promise<MemoRecord[]> {
		const settings = this.getSettings();
		const memos = await this.memoIndexStore.loadAll(settings.monthlyMemoFolder);
		return memos
			.filter((memo) => memo.status === "deleted")
			.sort(compareDeletedMemos);
	}

	async restoreMemo(memoId: string): Promise<MemoRecord> {
		const settings = this.getSettings();
		const currentMemo = await this.memoIndexStore.findMemoById(settings.monthlyMemoFolder, memoId);
		if (currentMemo === null) {
			throw new Error("Memo 不存在或已被清理。");
		}
		if (currentMemo.status !== "deleted") {
			return currentMemo;
		}

		const opId = createOperationId(new Date());
		const dailyBlock = this.getRestorableBlock(
			currentMemo,
			currentMemo.deletedDailyBlock,
			currentMemo.dailyRef.lastKnownBlock,
		);
		const monthlyBlock = this.getRestorableBlock(
			currentMemo,
			currentMemo.deletedMonthlyBlock,
			currentMemo.monthlyRef.lastKnownBlock || dailyBlock,
		);

		let dailyResult: RestoreDailyResult;
		let monthlyResult: RestoreMonthlyResult;
		try {
			dailyResult = await this.restoreDailyMemoBlock(settings, currentMemo, dailyBlock);
			if (dailyResult.changed) {
				this.markSelfWrite(opId, dailyResult.filePath, "repair", dailyResult.content);
			}
			monthlyResult = await this.restoreMonthlyMemoBlock(settings, currentMemo, monthlyBlock);
			if (monthlyResult.changed) {
				this.markSelfWrite(opId, monthlyResult.filePath, "archive", monthlyResult.content);
			}
		} catch (error) {
			throw error instanceof Error ? error : new Error("恢复失败，请稍后重试。");
		}

		const now = new Date().toISOString();
		const metadata = this.markdownBlockService.parseMemoMetadata(dailyResult.block.content);
		let restoredMemo: MemoRecord;
		try {
			restoredMemo = await this.memoIndexStore.updateMemo(settings.monthlyMemoFolder, currentMemo, (memo) => ({
				...memo,
				updatedAt: now,
				contentSnapshot: dailyResult.block.content,
				contentHash: dailyResult.block.contentHash,
				status: "active",
				syncStatus: "synced",
				tags: metadata.tags,
				links: metadata.links,
				images: metadata.images,
				references: buildMemoReferences(dailyResult.block.content, memo.sourceMemoId, memo.references[0]?.referenceText ?? null),
				issue: null,
				dailyRef: dailyResult.ref,
				monthlyRef: monthlyResult.ref,
				deletedAt: undefined,
				deleteSource: undefined,
				deletedDailyBlock: undefined,
				deletedMonthlyBlock: undefined,
			}));
		} catch (error) {
			throw buildIndexWriteFailedError("恢复", error, dailyResult.filePath, monthlyResult.ref.path);
		}
		this.markIndexSelfWrite(opId, settings, new Date(restoredMemo.createdAt));
		return restoredMemo;
	}

	async purgeDeletedMemo(memoId: string): Promise<void> {
		const settings = this.getSettings();
		const currentMemo = await this.memoIndexStore.findMemoById(settings.monthlyMemoFolder, memoId);
		if (currentMemo === null) {
			throw new Error("Memo 不存在或已被清理。");
		}
		if (currentMemo.status !== "deleted") {
			throw new Error("只能永久删除回收站中的 Memo。");
		}
		const opId = createOperationId(new Date());
		await this.memoIndexStore.purgeDeletedMemo(settings.monthlyMemoFolder, memoId);
		this.markIndexSelfWrite(opId, settings, new Date(currentMemo.createdAt));
	}

	async listIssueMemos(): Promise<MemoRecord[]> {
		const settings = this.getSettings();
		const memos = await this.memoIndexStore.loadAll(settings.monthlyMemoFolder);
		return memos
			.filter((memo) => memo.issue !== null || memo.syncStatus !== "synced")
			.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
	}

	async retryMonthlyDelete(memo: MemoRecord): Promise<MemoRecord> {
		const settings = this.getSettings();
		if (memo.syncStatus !== "monthly_delete_failed") {
			return memo;
		}
		if (!hasValidMonthlyRef(memo)) {
			const resolvedMemo = await this.memoIndexStore.upsertMemo(settings.monthlyMemoFolder, {
				...memo,
				syncStatus: "synced",
				issue: null,
			});
			this.markIndexSelfWrite(createOperationId(new Date()), settings, new Date(memo.createdAt));
			return resolvedMemo;
		}

		const opId = createOperationId(new Date());
		try {
			const monthlyResult = await this.monthlyArchiveService.deleteMemoBlock(memo);
			this.markSelfWrite(opId, monthlyResult.file.path, "archive", monthlyResult.content);
		} catch (error) {
			if (!(error instanceof MonthlyArchiveMissingError)) {
				const failedMemo = await this.memoIndexStore.upsertMemo(settings.monthlyMemoFolder, {
					...memo,
					issue: {
						type: "delete_failed",
						detectedAt: new Date().toISOString(),
						message: error instanceof Error ? error.message : "月度归档删除重试失败。",
					},
				});
				this.markIndexSelfWrite(opId, settings, new Date(memo.createdAt));
				return failedMemo;
			}
		}

		const resolvedMemo = await this.memoIndexStore.upsertMemo(settings.monthlyMemoFolder, {
			...memo,
			syncStatus: "synced",
			issue: null,
		});
		this.markIndexSelfWrite(opId, settings, new Date(memo.createdAt));
		return resolvedMemo;
	}

	async retryMonthlySync(memo: MemoRecord): Promise<MemoRecord> {
		const settings = this.getSettings();
		const dailyFile = this.getTextFile(memo.dailyRef.path, "日记文件不存在。");
		const content = await this.app.vault.cachedRead(dailyFile);
		const location = this.markdownBlockService.findMemoBlock(content, {
			lineNumberHint: memo.dailyRef.lineNumberHint,
			lastKnownBlock: memo.dailyRef.lastKnownBlock,
			lastKnownHash: memo.dailyRef.lastKnownHash,
			contentHash: memo.contentHash,
			allowLineHintTimeMatch: true,
		}, "daily_block_missing");
		const opId = createOperationId(new Date());
		if (location.parsedBlock === null) {
			const failedMemo = await this.memoIndexStore.upsertMemo(settings.monthlyMemoFolder, {
				...memo,
				issue: {
					type: location.issueType ?? "daily_block_missing",
					detectedAt: new Date().toISOString(),
					message: "重试月度同步前无法定位日记 memo block。",
				},
			});
			this.markIndexSelfWrite(opId, settings, new Date(memo.createdAt));
			return failedMemo;
		}

		try {
			const monthlyResult = await this.monthlyArchiveService.upsertMemoBlock(settings, {
				...memo,
				contentSnapshot: location.parsedBlock.content,
				contentHash: location.parsedBlock.contentHash,
				tags: location.parsedBlock.tags,
				links: location.parsedBlock.links,
				images: location.parsedBlock.images,
			}, location.parsedBlock.rawBlock, { allowMissingInsert: true });
			this.markSelfWrite(opId, monthlyResult.file.path, "repair", monthlyResult.content);
			const syncedMemo = await this.memoIndexStore.upsertMemo(settings.monthlyMemoFolder, {
				...memo,
				updatedAt: new Date().toISOString(),
				contentSnapshot: location.parsedBlock.content,
				contentHash: location.parsedBlock.contentHash,
				tags: location.parsedBlock.tags,
				links: location.parsedBlock.links,
				images: location.parsedBlock.images,
				references: buildMemoReferences(location.parsedBlock.content, memo.sourceMemoId, memo.references[0]?.referenceText ?? null),
				syncStatus: "synced",
				issue: null,
				dailyRef: {
					path: dailyFile.path,
					heading: memo.dailyRef.heading,
					lastKnownBlock: location.parsedBlock.rawBlock,
					lastKnownHash: hashText(location.parsedBlock.rawBlock),
					lineNumberHint: location.parsedBlock.startLine + 1,
					lastSyncedAt: new Date().toISOString(),
				},
				monthlyRef: monthlyResult.ref,
			});
			this.markIndexSelfWrite(opId, settings, new Date(memo.createdAt));
			return syncedMemo;
		} catch (error) {
			const failedMemo = await this.memoIndexStore.upsertMemo(settings.monthlyMemoFolder, {
				...memo,
				syncStatus: "monthly_failed",
				issue: buildMonthlyIssue(error),
			});
			this.markIndexSelfWrite(opId, settings, new Date(memo.createdAt));
			return failedMemo;
		}
	}

	async ensureReferenceBlockId(memo: MemoRecord): Promise<string> {
		const settings = this.getSettings();
		const dailyFile = this.getTextFile(memo.dailyRef.path, "日记文件不存在。");
		const initialContent = await this.app.vault.cachedRead(dailyFile);
		const initialLocation = this.markdownBlockService.findMemoBlock(initialContent, {
			lineNumberHint: memo.dailyRef.lineNumberHint,
			lastKnownBlock: memo.dailyRef.lastKnownBlock,
			lastKnownHash: memo.dailyRef.lastKnownHash,
			contentHash: memo.contentHash,
			allowLineHintTimeMatch: true,
		}, "daily_block_missing");
		if (initialLocation.parsedBlock === null) {
			await this.memoIndexStore.upsertMemo(settings.monthlyMemoFolder, {
				...memo,
				issue: {
					type: initialLocation.issueType ?? "daily_block_missing",
					detectedAt: new Date().toISOString(),
					message: "无法定位日记中的 memo block。",
				},
			});
			throw new Error("无法定位日记中的 memo block。");
		}
		if (initialLocation.parsedBlock.blockId !== null) {
			return initialLocation.parsedBlock.blockId;
		}

		const opId = createOperationId(new Date());
		let blockId = "";
		let nextDailyBlock = "";
		let dailyLineNumberHint = memo.dailyRef.lineNumberHint;
		let dailyChanged = false;
		const dailyContent = await this.app.vault.process(dailyFile, (currentContent) => {
			const location = this.markdownBlockService.findMemoBlock(currentContent, {
				lineNumberHint: memo.dailyRef.lineNumberHint,
				lastKnownBlock: memo.dailyRef.lastKnownBlock,
				lastKnownHash: memo.dailyRef.lastKnownHash,
				contentHash: memo.contentHash,
				allowLineHintTimeMatch: true,
			}, "daily_block_missing");
			if (location.parsedBlock === null) {
				throw new Error("无法定位日记中的 memo block。");
			}
			if (location.parsedBlock.blockId !== null) {
				blockId = location.parsedBlock.blockId;
				nextDailyBlock = location.parsedBlock.rawBlock;
				dailyLineNumberHint = location.parsedBlock.startLine + 1;
				return currentContent;
			}

			blockId = createUniqueReferenceBlockId(currentContent);
			nextDailyBlock = this.markdownBlockService.appendBlockIdToMemoBlock(location.parsedBlock.rawBlock, blockId);
			dailyLineNumberHint = location.parsedBlock.startLine + 1;
			const lines = splitMarkdownLines(currentContent);
			lines.splice(
				location.parsedBlock.startLine,
				location.parsedBlock.endLine - location.parsedBlock.startLine + 1,
				...splitMarkdownLines(nextDailyBlock),
			);
			dailyChanged = true;
			return lines.join("\n");
		});
		if (dailyChanged) {
			this.markSelfWrite(opId, dailyFile.path, "edit", dailyContent);
		}

		let syncStatus: MemoRecord["syncStatus"] = "synced";
		let issue: MemoRecord["issue"] = null;
		let monthlyRef = memo.monthlyRef;
		try {
			const monthlyResult = await this.monthlyArchiveService.upsertMemoBlock(settings, memo, nextDailyBlock);
			monthlyRef = monthlyResult.ref;
			this.markSelfWrite(opId, monthlyResult.file.path, "archive", monthlyResult.content);
		} catch (error) {
			syncStatus = "monthly_failed";
			issue = buildMonthlyIssue(error);
		}

		try {
			await this.memoIndexStore.upsertMemo(settings.monthlyMemoFolder, {
				...memo,
				syncStatus,
				issue,
				dailyRef: buildDailyRef(dailyFile.path, memo.dailyRef.heading, nextDailyBlock, dailyLineNumberHint),
				monthlyRef,
			});
		} catch (error) {
			throw buildIndexWriteFailedError("生成引用", error, dailyFile.path, monthlyRef.path);
		}
		this.markIndexSelfWrite(opId, settings, new Date(memo.createdAt));
		return blockId;
	}

	async syncExternalDailyFile(file: TFile): Promise<boolean> {
		if (!this.isPotentialDailyFile(file.path)) {
			return false;
		}
		const result = await this.memoScanService.syncDailyFile(file, (date) => createMemoId(date), createOperationId(new Date()));
		return result.created > 0 || result.updated > 0 || result.deleted > 0;
	}

	private async restoreDailyMemoBlock(
		settings: KnomoSettings,
		memo: MemoRecord,
		block: string,
	): Promise<RestoreDailyResult> {
		const existingFile = this.getExistingTextFile(memo.dailyRef.path);
		const dailyFile = existingFile ?? await this.dailyNoteService.getOrCreateDailyNoteForDate(new Date(memo.createdAt));
		let changed = false;
		let restoredBlock = block;
		let restoredLineNumber: number | null = null;
		let restoredParsedBlock: ParsedMemoBlock | null = null;
		const content = await this.app.vault.process(dailyFile, (currentContent) => {
			const existingBlock = this.findExistingRestoredBlock(currentContent, block);
			if (existingBlock !== null) {
				restoredBlock = existingBlock.rawBlock;
				restoredLineNumber = existingBlock.startLine + 1;
				restoredParsedBlock = existingBlock;
				return currentContent;
			}
			changed = true;
			return this.markdownBlockService.insertMemoBlock(currentContent, {
				heading: memo.dailyRef.heading || settings.dailyHeading,
				block,
				position: settings.dailyInsertPosition,
				createHeadingIfMissing: true,
			});
		});

		if (restoredParsedBlock === null) {
			restoredLineNumber = findLineNumber(content, restoredBlock, settings.dailyInsertPosition === "bottom");
			const parsedBlock = this.parseRestoredBlockFromContent(content, restoredBlock, restoredLineNumber);
			if (parsedBlock === null) {
				throw new Error("恢复失败：无法确认日记 block。");
			}
			restoredParsedBlock = parsedBlock;
		}

		return {
			ref: buildDailyRef(dailyFile.path, memo.dailyRef.heading || settings.dailyHeading, restoredBlock, restoredLineNumber),
			block: restoredParsedBlock,
			content,
			changed,
			filePath: dailyFile.path,
		};
	}

	private async restoreMonthlyMemoBlock(
		settings: KnomoSettings,
		memo: MemoRecord,
		block: string,
	): Promise<RestoreMonthlyResult> {
		const date = new Date(memo.createdAt);
		const dateHeading = memo.monthlyRef.dateHeading || formatMonthlyDateHeading(settings.monthlyDateHeadingFormat, date);
		const configuredPath = getMonthlyArchivePath(settings, formatMonthPeriod(date));
		const candidatePaths = uniqueNonEmptyStrings([memo.monthlyRef.path, configuredPath]);
		for (const path of candidatePaths) {
			const existing = await this.findExistingMonthlyRestore(settings, memo, block, path, dateHeading);
			if (existing !== null) {
				return existing;
			}
		}

		const restoreMemo: MemoRecord = {
			...memo,
			contentHash: this.getBlockContentHash(block),
			monthlyRef: {
				...memo.monthlyRef,
				path: memo.monthlyRef.path || configuredPath,
				dateHeading,
				lastKnownBlock: block,
				lastKnownHash: hashText(block),
			},
		};
		const monthlyResult = await this.monthlyArchiveService.upsertMemoBlock(settings, restoreMemo, block, {
			allowMissingInsert: true,
		});
		return {
			ref: monthlyResult.ref,
			content: monthlyResult.content,
			changed: true,
			filePath: monthlyResult.file.path,
		};
	}

	private async findExistingMonthlyRestore(
		settings: KnomoSettings,
		memo: MemoRecord,
		block: string,
		path: string,
		dateHeading: string,
	): Promise<RestoreMonthlyResult | null> {
		const file = this.getExistingTextFile(path);
		if (file === null) {
			return null;
		}
		const content = await this.app.vault.cachedRead(file);
		const existingBlock = this.findExistingRestoredBlock(content, block);
		if (existingBlock === null) {
			return null;
		}
		return {
			ref: {
				path: file.path,
				dateHeading: memo.monthlyRef.dateHeading || dateHeading || formatMonthlyDateHeading(settings.monthlyDateHeadingFormat, new Date(memo.createdAt)),
				lastKnownBlock: existingBlock.rawBlock,
				lastKnownHash: hashText(existingBlock.rawBlock),
				lineNumberHint: existingBlock.startLine + 1,
				lastSyncedAt: new Date().toISOString(),
			},
			content,
			changed: false,
			filePath: file.path,
		};
	}

	private findExistingRestoredBlock(currentContent: string, block: string): ParsedMemoBlock | null {
		const parsedBlock = this.parseRestoredBlock(block);
		if (parsedBlock === null) {
			return null;
		}

		const existingBlocks = this.markdownBlockService.parseMemoBlocks(currentContent);
		if (parsedBlock.blockId !== null) {
			const blockIdMatch = existingBlocks.find((existingBlock) => existingBlock.blockId === parsedBlock.blockId);
			if (blockIdMatch !== undefined) {
				return blockIdMatch;
			}
		}
		return existingBlocks.find((existingBlock) => existingBlock.contentHash === parsedBlock.contentHash) ?? null;
	}

	private parseRestoredBlockFromContent(
		content: string,
		block: string,
		lineNumber: number | null,
	): ParsedMemoBlock | null {
		if (lineNumber !== null) {
			const parsedBlock = this.markdownBlockService.parseMemoBlock(splitMarkdownLines(content), lineNumber - 1);
			if (parsedBlock !== null) {
				return parsedBlock;
			}
		}
		return this.parseRestoredBlock(block);
	}

	private parseRestoredBlock(block: string): ParsedMemoBlock | null {
		return this.markdownBlockService.parseMemoBlock(splitMarkdownLines(block), 0);
	}

	private getRestorableBlock(memo: MemoRecord, deletedBlock: string | undefined, fallbackBlock: string): string {
		for (const block of [deletedBlock, fallbackBlock]) {
			if (block !== undefined && block.trim().length > 0 && this.parseRestoredBlock(block) !== null) {
				return block;
			}
		}
		if (memo.contentSnapshot.trim().length === 0) {
			throw new Error("缺少删除快照。");
		}
		return this.markdownBlockService.buildMemoBlock(memo.contentSnapshot, formatTimePart(new Date(memo.createdAt), this.getSettings().memoTimeFormat));
	}

	private getBlockContentHash(block: string): string {
		const parsedBlock = this.parseRestoredBlock(block);
		return parsedBlock?.contentHash ?? hashMemoContent(block);
	}

	private getExistingTextFile(path: string): TFile | null {
		if (path.trim().length === 0) {
			return null;
		}
		const file = this.app.vault.getAbstractFileByPath(path);
		return file instanceof TFile ? file : null;
	}

	private markSelfWrite(opId: string, path: string, reason: "create" | "edit" | "delete" | "archive" | "repair", content: string): void {
		const writtenAt = Date.now();
		this.selfWriteTracker.mark(path, {
			opId,
			path,
			reason,
			writtenAt,
			expiresAt: writtenAt + 10000,
			expectedHash: hashText(content),
		});
	}

	private markIndexSelfWrite(opId: string, settings: KnomoSettings, date: Date): void {
		const path = getIndexFilePath(settings.monthlyMemoFolder, formatMonthPeriod(date));
		const writtenAt = Date.now();
		this.selfWriteTracker.mark(path, {
			opId,
			path,
			reason: "index",
			writtenAt,
			expiresAt: writtenAt + 10000,
			expectedHash: null,
		});
	}

	private getTextFile(path: string, errorMessage: string): TFile {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) {
			throw new Error(errorMessage);
		}
		return file;
	}
}

export function createOperationId(date: Date): string {
	return `op-${formatMemoIdPrefix(date)}-${Math.floor(Math.random() * 10000)
		.toString()
		.padStart(4, "0")}`;
}

export function createMemoId(date: Date): string {
	return `${formatMemoIdPrefix(date)}${Math.floor(Math.random() * 100)
		.toString()
		.padStart(2, "0")}`;
}

export function normalizeMemoInput(input: string): string {
	return input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function buildMonthlyIssue(error: unknown): MemoRecord["issue"] {
	return {
		type: error instanceof MonthlyArchiveMissingError ? "monthly_block_missing" : "monthly_sync_failed",
		detectedAt: new Date().toISOString(),
		message: error instanceof Error ? error.message : "月度归档同步失败。",
	};
}

function buildIndexWriteFailedError(action: string, error: unknown, dailyPath: string, monthlyPath: string): Error {
	const reason = error instanceof Error ? error.message : "未知错误";
	const monthlyText = monthlyPath.trim().length > 0 ? monthlyPath : "月度归档未完成";
	return new Error(
		`${action} memo 时 memo-index 写入失败。日记可能已经写入：${dailyPath}；月度归档：${monthlyText}。` +
				`请先修复 memo-index 或运行手动扫描恢复索引，避免重复发送。原始错误：${reason}`,
	);
}

function compareDeletedMemos(left: MemoRecord, right: MemoRecord): number {
	if (left.deletedAt === undefined && right.deletedAt === undefined) {
		return right.createdAt.localeCompare(left.createdAt);
	}
	if (left.deletedAt === undefined) {
		return 1;
	}
	if (right.deletedAt === undefined) {
		return -1;
	}
	return right.deletedAt.localeCompare(left.deletedAt) || right.createdAt.localeCompare(left.createdAt);
}

function uniqueNonEmptyStrings(values: string[]): string[] {
	const uniqueValues: string[] = [];
	for (const value of values) {
		const trimmedValue = value.trim();
		if (trimmedValue.length === 0 || uniqueValues.includes(trimmedValue)) {
			continue;
		}
		uniqueValues.push(trimmedValue);
	}
	return uniqueValues;
}

function hasValidMonthlyRef(memo: MemoRecord): boolean {
	return memo.monthlyRef.path.trim().length > 0;
}

function getRebuildSince(scope: RebuildIndexScope): Date | undefined {
	if (scope === "all") {
		return undefined;
	}
	const days = scope === "30d" ? 30 : 90;
	const now = new Date();
	return new Date(now.getFullYear(), now.getMonth(), now.getDate() - Math.max(days - 1, 0));
}

const REFERENCE_BLOCK_ID_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";

function createUniqueReferenceBlockId(content: string): string {
	const existingIds = extractBlockIds(content);
	for (let attempt = 0; attempt < 1000; attempt += 1) {
		const blockId = createReferenceBlockId();
		if (!existingIds.has(blockId)) {
			return blockId;
		}
	}
	throw new Error("无法生成唯一 blockId。");
}

function createReferenceBlockId(): string {
	let blockId = "";
	for (let index = 0; index < 6; index += 1) {
		const charIndex = Math.min(Math.floor(Math.random() * REFERENCE_BLOCK_ID_CHARS.length), REFERENCE_BLOCK_ID_CHARS.length - 1);
		blockId += REFERENCE_BLOCK_ID_CHARS[charIndex];
	}
	return blockId;
}

function extractBlockIds(content: string): Set<string> {
	const ids = new Set<string>();
	const regex = /(?:^|[^A-Za-z0-9_-])\^([A-Za-z0-9_-]+)/g;
	let match = regex.exec(content);
	while (match !== null) {
		ids.add(match[1]);
		match = regex.exec(content);
	}
	return ids;
}

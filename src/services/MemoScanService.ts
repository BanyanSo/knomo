import { TFile, TFolder, Vault } from "obsidian";
import type { App } from "obsidian";

import type { MarkdownSyncSource, MemoRecord, MonthlyRef, ParsedMemoBlock } from "../types/memo";
import type { KnomoSettings } from "../types/settings";
import { formatLocalIsoString, formatMonthPeriod } from "../utils/date";
import { matchesDailyNotePath, parseDailyNoteDateFromPath } from "../utils/dailyNotes";
import { hashText } from "../utils/hash";
import { buildDailyRef } from "../utils/memoRefs";
import { getIndexFilePath } from "../utils/path";
import { buildMemoReferences } from "../utils/references";
import { DailyNoteService } from "./DailyNoteService";
import type { DailyNotesConfig } from "./DailyNoteService";
import { MarkdownBlockService } from "./MarkdownBlockService";
import { MemoIndexStore } from "./MemoIndexStore";
import { MonthlyArchiveMissingError, MonthlyArchiveService } from "./MonthlyArchiveService";
import type { SelfWriteTracker } from "./SelfWriteTracker";

export interface ScanDailyMemosResult {
	scannedFiles: number;
	created: number;
	updated: number;
	deleted: number;
	skipped: number;
	failed: number;
	errors: string[];
}

export interface ScanDailyMemosProgress extends ScanDailyMemosResult {
	completedFiles: number;
	currentFile: string | null;
}

export interface EstimateDailyMemosResult {
	scannedFiles: number;
	estimatedNew: number;
	estimatedUpdated: number;
	estimatedMissing: number;
}

export interface ScanDailyMemosOptions {
	since?: Date;
	source?: MarkdownSyncSource;
	deleteSource?: string;
	syncMonthly?: boolean;
}

interface HeadingMemoBlock {
	heading: string;
	block: ParsedMemoBlock;
}

export class MemoScanService {
	constructor(
		private readonly app: App,
		private readonly getSettings: () => KnomoSettings,
		private readonly dailyNoteService: DailyNoteService,
		private readonly monthlyArchiveService: MonthlyArchiveService,
		private readonly memoIndexStore: MemoIndexStore,
		private readonly selfWriteTracker: SelfWriteTracker,
		private readonly markdownBlockService = new MarkdownBlockService(),
	) {}

	async estimateDailyMemos(options: ScanDailyMemosOptions = {}): Promise<EstimateDailyMemosResult> {
		const settings = this.getSettings();
		const config = await this.dailyNoteService.getDailyNotesConfig();
		const files = this.filterDailyFiles(this.getDailyFiles(config), config, options.since);
		const existingMemos = await this.memoIndexStore.loadAll(settings.monthlyMemoFolder);
		const result: EstimateDailyMemosResult = {
			scannedFiles: files.length,
			estimatedNew: 0,
			estimatedUpdated: 0,
			estimatedMissing: 0,
		};

		for (const file of files) {
			const content = await this.app.vault.cachedRead(file);
			const activeFileMemos = existingMemos.filter((memo) => memo.status === "active" && memo.dailyRef.path === file.path);
			const blocks = this.parseMemoBlocksForHeadings(content, getDailyHeadings(settings, activeFileMemos));
			const usedBlockStarts = new Set<number>();
			for (const memo of activeFileMemos) {
				const match = this.findIndexedMemoBlock(content, blocks, memo, usedBlockStarts);
				if (match.block === null) {
					result.estimatedMissing += 1;
					continue;
				}
				usedBlockStarts.add(match.block.block.startLine);
				const nextDailyRef = buildDailyRef(file.path, match.block.heading, match.block.block);
				if (
					memo.contentHash !== match.block.block.contentHash ||
					memo.dailyRef.heading !== nextDailyRef.heading ||
					memo.dailyRef.lastKnownHash !== nextDailyRef.lastKnownHash ||
					memo.dailyRef.lineNumberHint !== nextDailyRef.lineNumberHint ||
					memo.issue !== null ||
					memo.syncStatus !== "synced"
				) {
					result.estimatedUpdated += 1;
				}
			}
			result.estimatedNew += blocks.filter((block) => !usedBlockStarts.has(block.block.startLine)).length;
		}

		return result;
	}

	async scanDailyMemos(
		createMemoId: (date: Date) => string,
		opId: string,
		onProgress?: (progress: ScanDailyMemosProgress) => void | Promise<void>,
		options: ScanDailyMemosOptions = {},
	): Promise<ScanDailyMemosResult> {
		const settings = this.getSettings();
		const config = await this.dailyNoteService.getDailyNotesConfig();
		const files = this.filterDailyFiles(this.getDailyFiles(config), config, options.since);
		const existingMemos = await this.memoIndexStore.loadAll(settings.monthlyMemoFolder);
		const source = options.source ?? "manual_scan";
		const deleteSource = options.deleteSource ?? source;
		const syncMonthly = options.syncMonthly ?? true;
		const result: ScanDailyMemosResult = {
			scannedFiles: files.length,
			created: 0,
			updated: 0,
			deleted: 0,
			skipped: 0,
			failed: 0,
			errors: [],
		};

		let completedFiles = 0;
		for (const file of files) {
			try {
				await onProgress?.({ ...result, completedFiles, currentFile: file.path });
				const content = await this.app.vault.cachedRead(file);
				await this.syncDailyFileContent(settings, config, existingMemos, file, content, createMemoId, opId, result, source, deleteSource, syncMonthly);
			} catch (error) {
				result.failed += 1;
				result.errors.push(error instanceof Error ? error.message : `扫描失败：${file.path}`);
			} finally {
				completedFiles += 1;
				await onProgress?.({ ...result, completedFiles, currentFile: file.path });
			}
		}

		return result;
	}

	async syncDailyFile(
		file: TFile,
		createMemoId: (date: Date) => string,
		opId: string,
		source: MarkdownSyncSource = "file_watch",
		deleteSource = source,
	): Promise<ScanDailyMemosResult> {
		const settings = this.getSettings();
		const config = await this.dailyNoteService.getDailyNotesConfig();
		const existingMemos = await this.memoIndexStore.loadAll(settings.monthlyMemoFolder);
		const result: ScanDailyMemosResult = {
			scannedFiles: 1,
			created: 0,
			updated: 0,
			deleted: 0,
			skipped: 0,
			failed: 0,
			errors: [],
		};
		const content = await this.app.vault.cachedRead(file);
		await this.syncDailyFileContent(settings, config, existingMemos, file, content, createMemoId, opId, result, source, deleteSource, true);
		return result;
	}

	private async syncDailyFileContent(
		settings: KnomoSettings,
		config: DailyNotesConfig,
		existingMemos: MemoRecord[],
		file: TFile,
		content: string,
		createMemoId: (date: Date) => string,
		opId: string,
		result: ScanDailyMemosResult,
		source: MarkdownSyncSource,
		deleteSource: string,
		syncMonthly: boolean,
	): Promise<void> {
		const usedBlockStarts = new Set<number>();
		const activeFileMemos = existingMemos.filter((memo) => memo.status === "active" && memo.dailyRef.path === file.path);
		const blocks = this.parseMemoBlocksForHeadings(content, getDailyHeadings(settings, activeFileMemos));

		for (const memo of activeFileMemos) {
			const match = this.findIndexedMemoBlock(content, blocks, memo, usedBlockStarts);
			if (match.block !== null) {
				usedBlockStarts.add(match.block.block.startLine);
				await this.syncMatchedBlock(settings, existingMemos, memo, file, match.block, opId, result, source, syncMonthly);
				continue;
			}
			if (match.issueType === "daily_block_ambiguous") {
				await this.markDailyIssue(settings, existingMemos, memo, opId, result, source);
				continue;
			}
			await this.softDeleteMissingDailyMemo(settings, existingMemos, memo, opId, result, source, deleteSource);
		}

		for (const block of blocks) {
			if (usedBlockStarts.has(block.block.startLine)) {
				continue;
			}
			await this.createScannedBlock(settings, config, existingMemos, file, block, createMemoId, opId, result, source, syncMonthly);
		}
	}

	private async createScannedBlock(
		settings: KnomoSettings,
		config: DailyNotesConfig,
		existingMemos: MemoRecord[],
		file: TFile,
		headingBlock: HeadingMemoBlock,
		createMemoId: (date: Date) => string,
		opId: string,
		result: ScanDailyMemosResult,
		source: MarkdownSyncSource,
		syncMonthly: boolean,
	): Promise<void> {
		const block = headingBlock.block;
		const createdAt = parseCreatedAt(file.path, config, block.time);
		if (createdAt === null) {
			result.skipped += 1;
			return;
		}

		const createdAtText = formatLocalIsoString(createdAt);
		const memo: MemoRecord = {
			id: createMemoId(createdAt),
			createdAt: createdAtText,
			updatedAt: createdAtText,
			contentSnapshot: block.content,
			contentHash: block.contentHash,
			status: "active",
			syncStatus: "synced",
			source: "daily_scan",
			version: 1,
			tags: block.tags,
			links: block.links,
			images: block.images,
			references: [],
			sourceMemoId: null,
			issue: null,
			lastMarkdownSyncAt: new Date().toISOString(),
			lastMarkdownSyncSource: source,
			dailyRef: buildDailyRef(file.path, headingBlock.heading, block),
			monthlyRef: {
				path: "",
				dateHeading: "",
				lastKnownBlock: "",
				lastKnownHash: "",
				lineNumberHint: null,
				lastSyncedAt: null,
			},
		};
		const monthlySync = syncMonthly
			? await this.syncMonthlyBlock(settings, memo, block.rawBlock, opId, result, file.path)
			: { monthlyRef: memo.monthlyRef, syncStatus: "synced" as const, issue: null };
		const savedMemo = await this.memoIndexStore.addMemo(
			settings.monthlyMemoFolder,
			{
				...memo,
				syncStatus: monthlySync.syncStatus,
				issue: monthlySync.issue,
				monthlyRef: monthlySync.monthlyRef,
			},
			() => createMemoId(createdAt),
		);
		existingMemos.push(savedMemo);
		this.markIndexSelfWrite(settings, createdAt, opId);
		result.created += 1;
	}

	private async syncMatchedBlock(
		settings: KnomoSettings,
		existingMemos: MemoRecord[],
		memo: MemoRecord,
		file: TFile,
		headingBlock: HeadingMemoBlock,
		opId: string,
		result: ScanDailyMemosResult,
		source: MarkdownSyncSource,
		syncMonthly: boolean,
	): Promise<void> {
		const block = headingBlock.block;
		const nextDailyRef = buildDailyRef(file.path, headingBlock.heading, block);
		if (
			memo.contentHash === block.contentHash &&
			memo.dailyRef.heading === nextDailyRef.heading &&
			memo.dailyRef.lastKnownHash === nextDailyRef.lastKnownHash &&
			memo.dailyRef.lineNumberHint === nextDailyRef.lineNumberHint &&
			memo.syncStatus === "synced" &&
			memo.issue === null
		) {
			result.skipped += 1;
			return;
		}

		const monthlyMemo = {
			...memo,
			contentSnapshot: block.content,
			contentHash: block.contentHash,
			tags: block.tags,
			links: block.links,
			images: block.images,
		};
		const monthlySync = syncMonthly
			? await this.syncMonthlyBlock(settings, monthlyMemo, block.rawBlock, opId, result, file.path)
			: { monthlyRef: memo.monthlyRef, syncStatus: "synced" as const, issue: null };
		const now = new Date().toISOString();
		const updatedMemo = await this.memoIndexStore.upsertMemo(settings.monthlyMemoFolder, {
			...memo,
			updatedAt: now,
			contentSnapshot: block.content,
			contentHash: block.contentHash,
			tags: block.tags,
			links: block.links,
			images: block.images,
			references: buildMemoReferences(block.content, memo.sourceMemoId, memo.references[0]?.referenceText ?? null),
			syncStatus: monthlySync.syncStatus,
			issue: monthlySync.issue,
			lastMarkdownSyncAt: now,
			lastMarkdownSyncSource: source,
			dailyRef: nextDailyRef,
			monthlyRef: monthlySync.monthlyRef,
		});
		this.markIndexSelfWrite(settings, new Date(memo.createdAt), opId);
		replaceMemo(existingMemos, updatedMemo);
		result.updated += 1;
	}

	private async markDailyIssue(
		settings: KnomoSettings,
		existingMemos: MemoRecord[],
		memo: MemoRecord,
		opId: string,
		result: ScanDailyMemosResult,
		source: MarkdownSyncSource,
	): Promise<void> {
		const now = new Date().toISOString();
		const updatedMemo = await this.memoIndexStore.upsertMemo(settings.monthlyMemoFolder, {
			...memo,
			issue: {
				type: "daily_block_ambiguous",
				detectedAt: now,
				message: "当前日记标题下存在多条可能匹配的 memo block，无法自动同步。",
			},
			lastMarkdownSyncAt: now,
			lastMarkdownSyncSource: source,
		});
		this.markIndexSelfWrite(settings, new Date(memo.createdAt), opId);
		replaceMemo(existingMemos, updatedMemo);
		result.updated += 1;
	}

	private async softDeleteMissingDailyMemo(
		settings: KnomoSettings,
		existingMemos: MemoRecord[],
		memo: MemoRecord,
		opId: string,
		result: ScanDailyMemosResult,
		source: MarkdownSyncSource,
		deleteSource: string,
	): Promise<void> {
		let syncStatus: MemoRecord["syncStatus"] = "synced";
		let issue: MemoRecord["issue"] = null;
		let deletedMonthlyBlock = memo.monthlyRef.lastKnownBlock;

		if (memo.monthlyRef.path.trim().length > 0) {
			try {
				const monthlyResult = await this.monthlyArchiveService.deleteMemoBlock(memo);
				deletedMonthlyBlock = monthlyResult.ref.lastKnownBlock;
				this.selfWriteTracker.mark(monthlyResult.file.path, {
					opId,
					path: monthlyResult.file.path,
					reason: "scan",
					writtenAt: Date.now(),
					expiresAt: Date.now() + 10000,
					expectedHash: hashText(monthlyResult.content),
				});
			} catch (error) {
				if (!(error instanceof MonthlyArchiveMissingError)) {
					const message = error instanceof Error ? error.message : "月度归档删除失败。";
					syncStatus = "monthly_delete_failed";
					issue = {
						type: "delete_failed",
						detectedAt: new Date().toISOString(),
						message,
					};
					result.failed += 1;
					result.errors.push(`${memo.dailyRef.path}: ${message}`);
				}
			}
		}

		const now = new Date().toISOString();
		const deletedMemo = await this.memoIndexStore.upsertMemo(settings.monthlyMemoFolder, {
			...memo,
			status: "deleted",
			syncStatus,
			issue,
			deletedAt: now,
			deleteSource,
			deletedDailyBlock: memo.dailyRef.lastKnownBlock,
			deletedMonthlyBlock,
			lastMarkdownSyncAt: now,
			lastMarkdownSyncSource: source,
		});
		this.markIndexSelfWrite(settings, new Date(memo.createdAt), opId);
		replaceMemo(existingMemos, deletedMemo);
		result.deleted += 1;
	}

	private findIndexedMemoBlock(
		content: string,
		blocks: HeadingMemoBlock[],
		memo: MemoRecord,
		usedBlockStarts: Set<number>,
	): { block: HeadingMemoBlock | null; issueType: "daily_block_ambiguous" | null } {
		const blocksByStart = new Map(blocks.map((block) => [block.block.startLine, block]));
		const location = this.markdownBlockService.findMemoBlock(content, {
			lineNumberHint: memo.dailyRef.lineNumberHint,
			lastKnownBlock: memo.dailyRef.lastKnownBlock,
			lastKnownHash: memo.dailyRef.lastKnownHash,
			contentHash: memo.contentHash,
			allowLineHintTimeMatch: true,
		}, "daily_block_missing");
		if (location.parsedBlock === null) {
			return {
				block: null,
				issueType: location.issueType === "daily_block_ambiguous" ? "daily_block_ambiguous" : null,
			};
		}

		const headingBlock = blocksByStart.get(location.parsedBlock.startLine) ?? null;
		if (headingBlock === null) {
			return { block: null, issueType: null };
		}
		if (usedBlockStarts.has(headingBlock.block.startLine)) {
			return { block: null, issueType: "daily_block_ambiguous" };
		}
		return { block: headingBlock, issueType: null };
	}

	private parseMemoBlocksForHeadings(content: string, headings: string[]): HeadingMemoBlock[] {
		const blocksByStart = new Map<number, HeadingMemoBlock>();
		for (const heading of headings) {
			for (const block of this.markdownBlockService.parseMemoBlocksUnderHeading(content, heading)) {
				if (!blocksByStart.has(block.startLine)) {
					blocksByStart.set(block.startLine, { heading, block });
				}
			}
		}
		return [...blocksByStart.values()].sort((left, right) => left.block.startLine - right.block.startLine);
	}

	private async syncMonthlyBlock(
		settings: KnomoSettings,
		memo: MemoRecord,
		block: string,
		opId: string,
		result: ScanDailyMemosResult,
		sourcePath: string,
	): Promise<{ monthlyRef: MonthlyRef; syncStatus: MemoRecord["syncStatus"]; issue: MemoRecord["issue"] }> {
		try {
			const monthlyResult = await this.monthlyArchiveService.upsertMemoBlock(settings, memo, block, {
				allowMissingInsert: true,
			});
			this.selfWriteTracker.mark(monthlyResult.file.path, {
				opId,
				path: monthlyResult.file.path,
				reason: "scan",
				writtenAt: Date.now(),
				expiresAt: Date.now() + 10000,
				expectedHash: hashText(monthlyResult.content),
			});
			return {
				monthlyRef: monthlyResult.ref,
				syncStatus: "synced",
				issue: null,
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : "月度归档同步失败。";
			result.failed += 1;
			result.errors.push(`${sourcePath}: ${message}`);
			return {
				monthlyRef: memo.monthlyRef,
				syncStatus: "monthly_failed",
				issue: {
					type: "monthly_sync_failed",
					detectedAt: new Date().toISOString(),
					message,
				},
			};
		}
	}

	private getDailyFiles(config: DailyNotesConfig): TFile[] {
		if (config.folder !== null && config.folder.trim().length > 0) {
			const folder = this.app.vault.getAbstractFileByPath(config.folder);
			if (!(folder instanceof TFolder)) {
				return [];
			}
			const files: TFile[] = [];
			Vault.recurseChildren(folder, (child) => {
				if (child instanceof TFile && child.extension === "md" && matchesDailyNotePath(child.path, config)) {
					files.push(child);
				}
			});
			return files;
		}

		return this.app.vault.getMarkdownFiles().filter((file) => matchesDailyNotePath(file.path, config));
	}

	private filterDailyFiles(files: TFile[], config: DailyNotesConfig, since?: Date): TFile[] {
		if (since === undefined) {
			return files;
		}
		const start = startOfDay(since);
		const end = addDays(startOfDay(new Date()), 1);
		return files.filter((file) => {
			const date = parseDailyNoteDateFromPath(file.path, config);
			return date !== null && date >= start && date < end;
		});
	}

	private markIndexSelfWrite(settings: KnomoSettings, date: Date, opId: string): void {
		const path = getIndexFilePath(settings.monthlyMemoFolder, formatMonthPeriod(date));
		this.selfWriteTracker.mark(path, {
			opId,
			path,
			reason: "index",
			writtenAt: Date.now(),
			expiresAt: Date.now() + 10000,
			expectedHash: null,
		});
	}
}

function parseCreatedAt(path: string, config: DailyNotesConfig, time: string): Date | null {
	const date = parseDailyNoteDateFromPath(path, config);
	const timeMatch = time.match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/);
	if (date === null || timeMatch === null) {
		return null;
	}
	date.setHours(Number(timeMatch[1]), Number(timeMatch[2]), timeMatch[3] === undefined ? 0 : Number(timeMatch[3]), 0);
	return date;
}

function replaceMemo(memos: MemoRecord[], memo: MemoRecord): void {
	const index = memos.findIndex((item) => item.id === memo.id);
	if (index === -1) {
		memos.push(memo);
		return;
	}
	memos[index] = memo;
}

function startOfDay(date: Date): Date {
	return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date: Date, days: number): Date {
	return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function getDailyHeadings(settings: KnomoSettings, memos: MemoRecord[]): string[] {
	const headings = [
		settings.dailyHeading,
		...settings.legacyDailyHeadings,
		...memos.map((memo) => memo.dailyRef.heading),
	]
		.map((heading) => heading.trim())
		.filter((heading) => heading.length > 0);
	return [...new Set(headings)];
}

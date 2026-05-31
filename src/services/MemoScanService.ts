import { TFile, TFolder, Vault } from "obsidian";
import type { App } from "obsidian";

import type { DailyRefSectionType, MarkdownSyncSource, MemoRecord, MonthlyRef, ParsedMemoBlock } from "../types/memo";
import type { KnomoSettings } from "../types/settings";
import { formatLocalIsoString, formatMonthPeriod } from "../utils/date";
import { matchesDailyNotePath, parseDailyNoteDateFromPath } from "../utils/dailyNotes";
import { hashText } from "../utils/hash";
import { buildDailyRef } from "../utils/memoRefs";
import { isMarkdownHeadingLine, splitMarkdownLines } from "../utils/markdown";
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

export type LegacyDailyMemosImportScope = "30d" | "90d" | "all";

export interface LegacyDailyMemosSample {
	path: string;
	lineNumber: number;
	time: string;
	content: string;
}

export interface LegacyDailyMemosGroupPreview {
	key: string;
	heading: string | null;
	sectionType: DailyRefSectionType;
	label: string;
	count: number;
	selectedByDefault: boolean;
	samples: LegacyDailyMemosSample[];
}

export interface LegacyDailyMemosPreview {
	scannedFiles: number;
	candidateCount: number;
	groups: LegacyDailyMemosGroupPreview[];
}

export interface LegacyDailyMemosImportOptions {
	scope: LegacyDailyMemosImportScope;
	selectedGroupKeys: string[];
}

export interface LegacyDailyMemosImportResult extends ScanDailyMemosResult {
	imported: number;
	importedHeadings: string[];
}

interface HeadingMemoBlock {
	heading: string | null;
	sectionType: DailyRefSectionType;
	block: ParsedMemoBlock;
	allowCreate: boolean;
}

interface LegacyMemoCandidate {
	file: TFile;
	path: string;
	groupKey: string;
	heading: string | null;
	sectionType: DailyRefSectionType;
	block: ParsedMemoBlock;
	createdAt: Date;
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

	async previewLegacyDailyMemos(scope: LegacyDailyMemosImportScope): Promise<LegacyDailyMemosPreview> {
		const settings = this.getSettings();
		const config = await this.dailyNoteService.getDailyNotesConfig();
		const files = this.filterDailyFiles(this.getDailyFiles(config), config, getLegacyImportSince(scope));
		const groups = new Map<string, LegacyDailyMemosGroupPreview>();
		let candidateCount = 0;

		for (const file of files) {
			const content = await this.app.vault.cachedRead(file);
			const candidates = this.parseLegacyMemoCandidates(config, file, content);
			candidateCount += candidates.length;
			for (const candidate of candidates) {
				const group = groups.get(candidate.groupKey) ?? createLegacyPreviewGroup(settings, candidate);
				group.count += 1;
				if (group.samples.length < 5) {
					group.samples.push({
						path: candidate.path,
						lineNumber: candidate.block.startLine + 1,
						time: candidate.block.time,
						content: candidate.block.content,
					});
				}
				groups.set(candidate.groupKey, group);
			}
		}

		return {
			scannedFiles: files.length,
			candidateCount,
			groups: [...groups.values()].sort(compareLegacyPreviewGroups),
		};
	}

	async importLegacyDailyMemos(
		createMemoId: (date: Date) => string,
		opId: string,
		options: LegacyDailyMemosImportOptions,
	): Promise<LegacyDailyMemosImportResult> {
		const settings = this.getSettings();
		const config = await this.dailyNoteService.getDailyNotesConfig();
		const selectedGroupKeys = new Set(options.selectedGroupKeys);
		const files = this.filterDailyFiles(this.getDailyFiles(config), config, getLegacyImportSince(options.scope));
		const existingMemos = await this.memoIndexStore.loadAll(settings.monthlyMemoFolder);
		const importedHeadings = new Set<string>();
		const result: LegacyDailyMemosImportResult = {
			scannedFiles: files.length,
			created: 0,
			updated: 0,
			deleted: 0,
			skipped: 0,
			failed: 0,
			errors: [],
			imported: 0,
			importedHeadings: [],
		};

		for (const file of files) {
			const content = await this.app.vault.cachedRead(file);
			const candidates = this.parseLegacyMemoCandidates(config, file, content)
				.filter((candidate) => selectedGroupKeys.has(candidate.groupKey));
			for (const candidate of candidates) {
				try {
					if (isDuplicateLegacyCandidate(existingMemos, candidate, this.markdownBlockService)) {
						result.skipped += 1;
						continue;
					}
					const savedMemo = await this.importLegacyCandidate(settings, candidate, candidate.block, createMemoId, opId, result);
					existingMemos.push(savedMemo);
					if (candidate.heading !== null) {
						importedHeadings.add(candidate.heading);
					}
					result.created += 1;
					result.imported += 1;
				} catch (error) {
					result.failed += 1;
					result.errors.push(error instanceof Error ? error.message : `Import failed: ${candidate.path}:${candidate.block.startLine + 1}`);
				}
			}
		}

		result.importedHeadings = [...importedHeadings];
		return result;
	}

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
				result.errors.push(error instanceof Error ? error.message : `Scan failed: ${file.path}`);
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
		const blocks = this.parseMemoBlocksForHeadings(content, getDailyHeadings(settings, activeFileMemos), hasRootDailyMemo(activeFileMemos));

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
			if (!block.allowCreate) {
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
				message: "Multiple memo blocks may match under the current daily note heading, so Knomo cannot sync automatically.",
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
					const message = error instanceof Error ? error.message : "Monthly archive delete failed.";
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

	private parseMemoBlocksForHeadings(content: string, headings: string[], includeRootBlocks = false): HeadingMemoBlock[] {
		const blocksByStart = new Map<number, HeadingMemoBlock>();
		for (const heading of headings) {
			for (const block of this.markdownBlockService.parseMemoBlocksUnderHeading(content, heading)) {
				if (!blocksByStart.has(block.startLine)) {
					blocksByStart.set(block.startLine, { heading, sectionType: "heading", block, allowCreate: true });
				}
			}
		}
		if (includeRootBlocks) {
			for (const block of this.parseRootMemoBlocks(content)) {
				if (!blocksByStart.has(block.startLine)) {
					blocksByStart.set(block.startLine, { heading: null, sectionType: "root", block, allowCreate: false });
				}
			}
		}
		return [...blocksByStart.values()].sort((left, right) => left.block.startLine - right.block.startLine);
	}

	private parseLegacyMemoCandidates(
		config: DailyNotesConfig,
		file: TFile,
		content: string,
	): LegacyMemoCandidate[] {
		const lines = splitMarkdownLines(content);
		const candidates: LegacyMemoCandidate[] = [];
		const frontmatterEnd = getFrontmatterEndLine(lines);
		let currentHeading: string | null = null;
		let codeFence: string | null = null;

		for (let index = 0; index < lines.length; index += 1) {
			if (frontmatterEnd !== -1 && index <= frontmatterEnd) {
				continue;
			}
			const fence = getCodeFenceMarker(lines[index]);
			if (fence !== null) {
				codeFence = codeFence === null ? fence : codeFence === fence ? null : codeFence;
				continue;
			}
			if (codeFence !== null) {
				continue;
			}
			if (isMarkdownHeadingLine(lines[index])) {
				currentHeading = lines[index].trim();
				continue;
			}

			const block = this.markdownBlockService.parseMemoBlock(lines, index);
			if (block === null) {
				continue;
			}
			const createdAt = parseCreatedAt(file.path, config, block.time);
			if (createdAt !== null) {
				const sectionType: DailyRefSectionType = currentHeading === null ? "root" : "heading";
				candidates.push({
					file,
					path: file.path,
					groupKey: getLegacyGroupKey(sectionType, currentHeading),
					heading: currentHeading,
					sectionType,
					block,
					createdAt,
				});
			}
			index = block.endLine;
		}

		return candidates;
	}

	private parseRootMemoBlocks(content: string): ParsedMemoBlock[] {
		return parseLegacyMemoBlocks(content, this.markdownBlockService)
			.filter((candidate) => candidate.sectionType === "root")
			.map((candidate) => candidate.block);
	}

	private async importLegacyCandidate(
		settings: KnomoSettings,
		candidate: LegacyMemoCandidate,
		block: ParsedMemoBlock,
		createMemoId: (date: Date) => string,
		opId: string,
		result: ScanDailyMemosResult,
	): Promise<MemoRecord> {
		const now = new Date().toISOString();
		const createdAtText = formatLocalIsoString(candidate.createdAt);
		const memo: MemoRecord = {
			id: createMemoId(candidate.createdAt),
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
			lastMarkdownSyncAt: now,
			lastMarkdownSyncSource: "legacy_import",
			dailyRef: buildDailyRef(candidate.path, candidate.heading, block),
			monthlyRef: {
				path: "",
				dateHeading: "",
				lastKnownBlock: "",
				lastKnownHash: "",
				lineNumberHint: null,
				lastSyncedAt: null,
			},
		};
		const monthlySync = await this.syncMonthlyBlock(settings, memo, block.rawBlock, opId, result, candidate.path);
		const savedMemo = await this.memoIndexStore.addMemo(
			settings.monthlyMemoFolder,
			{
				...memo,
				syncStatus: monthlySync.syncStatus,
				issue: monthlySync.issue,
				monthlyRef: monthlySync.monthlyRef,
			},
			() => createMemoId(candidate.createdAt),
		);
		this.markIndexSelfWrite(settings, candidate.createdAt, opId);
		return savedMemo;
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
			const message = error instanceof Error ? error.message : "Monthly archive sync failed.";
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

function getLegacyImportSince(scope: LegacyDailyMemosImportScope): Date | undefined {
	if (scope === "all") {
		return undefined;
	}
	const days = scope === "30d" ? 30 : 90;
	const now = new Date();
	return new Date(now.getFullYear(), now.getMonth(), now.getDate() - Math.max(days - 1, 0));
}

function getDailyHeadings(settings: KnomoSettings, memos: MemoRecord[]): string[] {
	const headings = [
		settings.dailyHeading,
		...settings.legacyDailyHeadings,
		...memos.map((memo) => memo.dailyRef.heading ?? ""),
	]
		.map((heading) => heading.trim())
		.filter((heading) => heading.length > 0);
	return [...new Set(headings)];
}

function hasRootDailyMemo(memos: MemoRecord[]): boolean {
	return memos.some((memo) => memo.dailyRef.sectionType === "root" || memo.dailyRef.heading === null);
}

function createLegacyPreviewGroup(settings: KnomoSettings, candidate: LegacyMemoCandidate): LegacyDailyMemosGroupPreview {
	return {
		key: candidate.groupKey,
		heading: candidate.heading,
		sectionType: candidate.sectionType,
		label: candidate.heading ?? "Untitled section",
		count: 0,
		selectedByDefault: shouldSelectLegacyGroup(settings, candidate),
		samples: [],
	};
}

function shouldSelectLegacyGroup(settings: KnomoSettings, candidate: LegacyMemoCandidate): boolean {
	if (candidate.sectionType === "root" || candidate.heading === null) {
		return false;
	}
	return candidate.heading.trim() === settings.dailyHeading.trim() || candidate.heading.trim() === "## Memos";
}

function compareLegacyPreviewGroups(left: LegacyDailyMemosGroupPreview, right: LegacyDailyMemosGroupPreview): number {
	if (left.sectionType !== right.sectionType) {
		return left.sectionType === "heading" ? -1 : 1;
	}
	return right.count - left.count || left.label.localeCompare(right.label);
}

function getLegacyGroupKey(sectionType: DailyRefSectionType, heading: string | null): string {
	return sectionType === "root" ? "root" : `heading:${heading ?? ""}`;
}

interface ParsedLegacySectionBlock {
	heading: string | null;
	sectionType: DailyRefSectionType;
	block: ParsedMemoBlock;
}

function parseLegacyMemoBlocks(content: string, markdownBlockService: MarkdownBlockService): ParsedLegacySectionBlock[] {
	const lines = splitMarkdownLines(content);
	const blocks: ParsedLegacySectionBlock[] = [];
	const frontmatterEnd = getFrontmatterEndLine(lines);
	let currentHeading: string | null = null;
	let codeFence: string | null = null;

	for (let index = 0; index < lines.length; index += 1) {
		if (frontmatterEnd !== -1 && index <= frontmatterEnd) {
			continue;
		}
		const fence = getCodeFenceMarker(lines[index]);
		if (fence !== null) {
			codeFence = codeFence === null ? fence : codeFence === fence ? null : codeFence;
			continue;
		}
		if (codeFence !== null) {
			continue;
		}
		if (isMarkdownHeadingLine(lines[index])) {
			currentHeading = lines[index].trim();
			continue;
		}
		const block = markdownBlockService.parseMemoBlock(lines, index);
		if (block === null) {
			continue;
		}
		blocks.push({
			heading: currentHeading,
			sectionType: currentHeading === null ? "root" : "heading",
			block,
		});
		index = block.endLine;
	}

	return blocks;
}

function getFrontmatterEndLine(lines: string[]): number {
	if (lines[0]?.trim() !== "---") {
		return -1;
	}
	for (let index = 1; index < lines.length; index += 1) {
		if (lines[index].trim() === "---") {
			return index;
		}
	}
	return lines.length - 1;
}

function getCodeFenceMarker(line: string): string | null {
	const match = line.trim().match(/^(`{3,}|~{3,})/);
	if (match === null) {
		return null;
	}
	return match[1].charAt(0);
}

function isDuplicateLegacyCandidate(
	existingMemos: MemoRecord[],
	candidate: LegacyMemoCandidate,
	markdownBlockService: MarkdownBlockService,
): boolean {
	const candidateBlockId = candidate.block.blockId;
	const candidateRawHash = hashText(candidate.block.rawBlock);
	for (const memo of existingMemos) {
		if (memo.dailyRef.path !== candidate.path) {
			continue;
		}
		const existingBlock = markdownBlockService.parseMemoBlock(splitMarkdownLines(memo.dailyRef.lastKnownBlock), 0);
		if (candidateBlockId !== null && existingBlock?.blockId === candidateBlockId) {
			return true;
		}
		if ((memo.dailyRef.lastKnownHash || hashText(memo.dailyRef.lastKnownBlock)) === candidateRawHash) {
			return true;
		}
		if (memo.dailyRef.lineNumberHint === candidate.block.startLine + 1 && memo.contentHash === candidate.block.contentHash) {
			return true;
		}
		if (memo.createdAt === formatLocalIsoString(candidate.createdAt) && memo.contentHash === candidate.block.contentHash) {
			return true;
		}
	}
	return false;
}

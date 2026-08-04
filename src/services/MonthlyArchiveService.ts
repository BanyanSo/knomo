import { moment as obsidianMoment, normalizePath, TFile, TFolder, Vault } from "obsidian";
import type { App } from "obsidian";

import { DEFAULT_MONTHLY_DATE_HEADING_FORMAT, DEFAULT_MONTHLY_MEMO_FILE_FORMAT } from "../constants";
import { getKnomoLocale, translate } from "../i18n";
import type { KnomoLocale } from "../i18n";
import type { MemoRecord, MonthlyRef } from "../types/memo";
import type { PreparedMonthlyMemoWrite } from "../types/pending";
import { PendingMemoWriteConflictError } from "../types/pending";
import { KnomoError } from "../types/serviceError";
import type { SyncConflictFile } from "../types/syncConflict";
import type { KnomoErrorCode } from "../types/serviceError";
import type { KnomoSettings, MonthlyDateOrder } from "../types/settings";
import { formatMonthPeriod } from "../utils/date";
import { hashText } from "../utils/hash";
import { findLineNumber, normalizeMarkdownLineEndings } from "../utils/markdown";
import { getSystemFolderPath, normalizeVaultPath } from "../utils/path";
import { isLikelySyncConflictPath } from "../utils/syncConflict";
import { ensureFolder, ensureTextFile, getParentFolderPath } from "../utils/vault";
import { MarkdownBlockService } from "./MarkdownBlockService";

// 职责：维护月度归档文件中的月份标题、日期标题和完整 memo block。
export const MONTHLY_ARCHIVE_MARKER = "knomo:monthly-archive";
const MONTHLY_DATE_TOKEN_PATTERN = /YYYY|MMMM|dddd|MM|DD|M|D/g;
const ASCII_LETTER_PATTERN = /[A-Za-z]/;
export const LEGACY_MONTHLY_ARCHIVE_READONLY_COMMENT = [
	"<!--",
	"Knomo monthly archive file: this file is generated automatically from Daily Notes. Do not edit memos here directly; edit them in Knomo or the corresponding daily note.",
	"-->",
].join("\n");

interface MomentFormatter {
	format(format: string): string;
}

type MomentFactory = (input: Date) => MomentFormatter;

export interface MonthlyArchiveWriteResult {
	file: TFile;
	ref: MonthlyRef;
	content: string;
}

export interface MonthlyArchivePreparedWriteResult extends MonthlyArchiveWriteResult {
	changed: boolean;
}

export interface MonthlyArchiveUpsertOptions {
	allowMissingInsert?: boolean;
}

export interface MonthlyArchiveRebuildEntry {
	memoId: string;
	createdAt: Date;
	block: string;
}

export interface MonthlyArchiveRebuildWriteResult {
	file: TFile;
	content: string;
	refsByMemoId: Map<string, MonthlyRef>;
}

export class MonthlyArchiveMissingError extends KnomoError {
	constructor(code: Extract<KnomoErrorCode, "monthly_archive_file_missing" | "monthly_archive_block_missing">) {
		super(code);
		this.name = "MonthlyArchiveMissingError";
	}
}

export class MonthlyArchiveAmbiguousError extends KnomoError {
	constructor() {
		super("monthly_archive_block_ambiguous");
		this.name = "MonthlyArchiveAmbiguousError";
	}
}

export class MonthlyArchiveService {
	constructor(
		private readonly app: App,
		private readonly markdownBlockService = new MarkdownBlockService(),
		private readonly onBeforeInternalTrash?: (path: string) => void,
	) {}

	async backupMonthlyArchives(settings: KnomoSettings, backupPath: string | null): Promise<void> {
		if (backupPath === null) {
			return;
		}
		const monthlyBackupPath = normalizePath(`${backupPath}/monthly`);
		await ensureFolder(this.app, monthlyBackupPath);
		const monthlyFolderPath = normalizeVaultPath(settings.monthlyMemoFolder);
		for (const file of this.listMonthlyArchiveFiles(settings)) {
			const relativePath = file.path.slice(monthlyFolderPath.length + 1);
			const backupFilePath = normalizePath(`${monthlyBackupPath}/${relativePath}`);
			const parentPath = getParentFolderPath(backupFilePath);
			if (parentPath !== null) {
				await ensureFolder(this.app, parentPath);
			}
			await this.app.vault.create(backupFilePath, await this.app.vault.cachedRead(file));
		}
	}

	async restoreMonthlyArchives(settings: KnomoSettings, backupPath: string | null): Promise<void> {
		if (backupPath === null) {
			return;
		}
		const monthlyBackupPath = normalizePath(`${backupPath}/monthly`);
		const backupFolder = this.app.vault.getAbstractFileByPath(monthlyBackupPath);
		const backupFiles: TFile[] = [];
		if (backupFolder instanceof TFolder) {
			Vault.recurseChildren(backupFolder, (child) => {
				if (child instanceof TFile) {
					backupFiles.push(child);
				}
			});
		}
		const backupRelativePaths = new Set(backupFiles.map((file) => file.path.slice(monthlyBackupPath.length + 1)));
		await this.removeMonthlyArchiveFilesExcept(settings, backupRelativePaths);
		const monthlyFolderPath = normalizeVaultPath(settings.monthlyMemoFolder);
		for (const file of backupFiles) {
			const relativePath = file.path.slice(monthlyBackupPath.length + 1);
			const targetPath = normalizePath(`${monthlyFolderPath}/${relativePath}`);
			const parentPath = getParentFolderPath(targetPath);
			if (parentPath !== null) {
				await ensureFolder(this.app, parentPath);
			}
			const content = await this.app.vault.cachedRead(file);
			const existing = this.app.vault.getAbstractFileByPath(targetPath);
			if (existing instanceof TFile) {
				await this.app.vault.process(existing, () => content);
			} else {
				await this.app.vault.create(targetPath, content);
			}
		}
	}

	async insertMemoBlock(settings: KnomoSettings, createdAt: Date, block: string): Promise<MonthlyArchiveWriteResult> {
		const period = formatMonthPeriod(createdAt);
		const dateHeading = formatMonthlyDateHeading(settings.monthlyDateHeadingFormat, createdAt);
		const path = getMonthlyArchivePath(settings, period);
		const file = await ensureTextFile(this.app, path);
		const content = await this.app.vault.process(file, (currentContent) => {
			const withMonthHeading = ensureMonthHeading(currentContent, period);
			const withComment = ensureReadOnlyComment(withMonthHeading);
			const withDateHeading = ensureDateHeading(withComment, dateHeading, settings.monthlyDateOrder);
			return this.markdownBlockService.insertMemoBlock(withDateHeading, {
				heading: dateHeading,
				block,
				position: "bottom",
				createHeadingIfMissing: true,
			});
		});
		return {
			file,
			content,
			ref: buildMonthlyRef(file.path, dateHeading, content, block),
		};
	}

	async prepareMemoBlockInsert(
		settings: KnomoSettings,
		createdAt: Date,
		block: string,
	): Promise<PreparedMonthlyMemoWrite> {
		const period = formatMonthPeriod(createdAt);
		const dateHeading = formatMonthlyDateHeading(settings.monthlyDateHeadingFormat, createdAt);
		const path = getMonthlyArchivePath(settings, period);
		const file = await ensureTextFile(this.app, path);
		const beforeContent = await this.app.vault.cachedRead(file);
		const afterContent = this.buildInsertedMemoContent(beforeContent, settings, period, dateHeading, block);
		return {
			path: file.path,
			beforeHash: hashText(beforeContent),
			afterHash: hashText(afterContent),
			blockOccurrencesBefore: this.countMemoBlockOccurrences(beforeContent, block),
			ref: buildMonthlyRef(file.path, dateHeading, afterContent, block),
		};
	}

	async commitPreparedMemoBlock(
		settings: KnomoSettings,
		createdAt: Date,
		block: string,
		prepared: PreparedMonthlyMemoWrite,
	): Promise<MonthlyArchivePreparedWriteResult> {
		const file = this.app.vault.getAbstractFileByPath(prepared.path);
		if (!(file instanceof TFile)) {
			throw new PendingMemoWriteConflictError(`Prepared monthly archive does not exist: ${prepared.path}`);
		}
		const period = formatMonthPeriod(createdAt);
		const dateHeading = prepared.ref.dateHeading;
		let changed = false;
		const content = await this.app.vault.process(file, (currentContent) => {
			const currentHash = hashText(currentContent);
			if (currentHash === prepared.afterHash) {
				return currentContent;
			}
			if (currentHash !== prepared.beforeHash) {
				const occurrenceCount = this.countMemoBlockOccurrences(currentContent, block);
				if (occurrenceCount === prepared.blockOccurrencesBefore + 1) {
					return currentContent;
				}
				throw new PendingMemoWriteConflictError(`Monthly archive changed during pending memo create: ${prepared.path}`);
			}
			const nextContent = this.buildInsertedMemoContent(currentContent, settings, period, dateHeading, block);
			if (hashText(nextContent) !== prepared.afterHash) {
				throw new PendingMemoWriteConflictError(`Prepared monthly archive content no longer matches: ${prepared.path}`);
			}
			changed = true;
			return nextContent;
		});
		return {
			file,
			content,
			ref: prepared.ref,
			changed,
		};
	}

	async upsertMemoBlock(
		settings: KnomoSettings,
		memo: MemoRecord,
		block: string,
		options: MonthlyArchiveUpsertOptions = {},
	): Promise<MonthlyArchiveWriteResult> {
		if (memo.monthlyRef.path.trim().length === 0) {
			return this.insertMemoBlock(settings, new Date(memo.createdAt), block);
		}

		const existing = this.app.vault.getAbstractFileByPath(memo.monthlyRef.path);
		if (!(existing instanceof TFile)) {
			if (options.allowMissingInsert === true) {
				return this.insertMemoBlock(settings, new Date(memo.createdAt), block);
			}
			throw new MonthlyArchiveMissingError("monthly_archive_file_missing");
		}
		const file = existing;
		const dateHeading = memo.monthlyRef.dateHeading || formatMonthlyDateHeading(settings.monthlyDateHeadingFormat, new Date(memo.createdAt));
		let lineNumberHint: number | null = null;
		const content = await this.app.vault.process(file, (currentContent) => {
			const location = this.markdownBlockService.findMemoBlock(currentContent, {
				lineNumberHint: memo.monthlyRef.lineNumberHint,
				lastKnownBlock: memo.monthlyRef.lastKnownBlock,
				lastKnownHash: memo.monthlyRef.lastKnownHash,
				contentHash: memo.contentHash,
				heading: dateHeading,
				allowLineHintTimeMatch: true,
				matchPolicy: "safe-mutation",
			}, "monthly_block_missing");
			if (location.parsedBlock === null) {
				if (location.issueType === "monthly_block_ambiguous") {
					throw new MonthlyArchiveAmbiguousError();
				}
				if (options.allowMissingInsert !== true) {
					throw new MonthlyArchiveMissingError("monthly_archive_block_missing");
				}
				const withMonthHeading = ensureMonthHeading(currentContent, formatMonthPeriod(new Date(memo.createdAt)));
				const withComment = ensureReadOnlyComment(withMonthHeading);
				const withDateHeading = ensureDateHeading(withComment, dateHeading, settings.monthlyDateOrder);
				return this.markdownBlockService.insertMemoBlock(withDateHeading, {
					heading: dateHeading,
					block,
					position: "bottom",
					createHeadingIfMissing: true,
				});
			}
			lineNumberHint = location.parsedBlock.startLine + 1;
			const lines = normalizeMarkdownLineEndings(currentContent).split("\n");
			lines.splice(
				location.parsedBlock.startLine,
				location.parsedBlock.endLine - location.parsedBlock.startLine + 1,
				...block.split("\n"),
			);
			return lines.join("\n");
		});
		return {
			file,
			content,
			ref: buildMonthlyRef(file.path, dateHeading, content, block, lineNumberHint),
		};
	}

	async deleteMemoBlock(memo: MemoRecord): Promise<MonthlyArchiveWriteResult> {
		const existing = this.app.vault.getAbstractFileByPath(memo.monthlyRef.path);
		if (!(existing instanceof TFile)) {
			throw new MonthlyArchiveMissingError("monthly_archive_file_missing");
		}
		const file = existing;
		const dateHeading = memo.monthlyRef.dateHeading;
		let deletedBlock = "";
		const content = await this.app.vault.process(file, (currentContent) => {
			const location = this.markdownBlockService.findMemoBlock(currentContent, {
				lineNumberHint: memo.monthlyRef.lineNumberHint,
				lastKnownBlock: memo.monthlyRef.lastKnownBlock,
				lastKnownHash: memo.monthlyRef.lastKnownHash,
				contentHash: memo.contentHash,
				heading: dateHeading,
				allowLineHintTimeMatch: true,
				matchPolicy: "safe-mutation",
			}, "monthly_block_missing");
			if (location.parsedBlock === null) {
				if (location.issueType === "monthly_block_ambiguous") {
					throw new MonthlyArchiveAmbiguousError();
				}
				throw new MonthlyArchiveMissingError("monthly_archive_block_missing");
			}
			deletedBlock = location.parsedBlock.rawBlock;
			return this.markdownBlockService.deleteMemoBlock(currentContent, location.parsedBlock.startLine);
		});
		return {
			file,
			content,
			ref: {
				...memo.monthlyRef,
				lastKnownBlock: deletedBlock,
				lastKnownHash: hashText(deletedBlock),
				lastSyncedAt: new Date().toISOString(),
			},
		};
	}

	async rebuildMonthlyArchive(
		settings: KnomoSettings,
		period: string,
		entries: MonthlyArchiveRebuildEntry[],
		replaceExisting: boolean,
	): Promise<MonthlyArchiveRebuildWriteResult | null> {
		const path = getMonthlyArchivePath(settings, period);
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing !== null && !(existing instanceof TFile)) {
			throw new Error(`Monthly archive path is not a file: ${path}`);
		}
		if (existing instanceof TFile && !replaceExisting) {
			return null;
		}

		const previousContent = existing instanceof TFile ? await this.app.vault.cachedRead(existing) : "";
		const content = this.buildRebuiltMonthlyArchiveContent(settings, period, entries, previousContent);
		const parentPath = getParentFolderPath(path);
		if (parentPath !== null) {
			await ensureFolder(this.app, parentPath);
		}

		let file: TFile;
		if (existing instanceof TFile) {
			await this.app.vault.process(existing, () => content);
			file = existing;
		} else {
			const current = this.app.vault.getAbstractFileByPath(path);
			if (current instanceof TFile && !replaceExisting) {
				return null;
			}
			if (current !== null) {
				throw new Error(`Monthly archive path is not available: ${path}`);
			}
			file = await this.app.vault.create(path, content);
		}

		return {
			file,
			content,
			refsByMemoId: this.buildRebuiltMonthlyRefs(settings, file.path, content, entries),
		};
	}

	listPotentialSyncConflictFiles(settings: KnomoSettings): SyncConflictFile[] {
		const monthlyFolderPath = normalizeVaultPath(settings.monthlyMemoFolder);
		const monthlyFolder = this.app.vault.getAbstractFileByPath(monthlyFolderPath);
		if (!(monthlyFolder instanceof TFolder)) {
			return [];
		}
		const systemFolderPath = getSystemFolderPath(settings.monthlyMemoFolder);
		const files: SyncConflictFile[] = [];
		Vault.recurseChildren(monthlyFolder, (child) => {
			if (
				child instanceof TFile &&
				child.extension === "md" &&
				!child.path.startsWith(`${systemFolderPath}/`) &&
				isLikelySyncConflictPath(child.name)
			) {
				const conflict = buildMonthlyArchiveConflictFile(settings, child);
				if (conflict !== null) {
					files.push(conflict);
				}
			}
		});
		return files.sort((left, right) => left.path.localeCompare(right.path));
	}

	private listMonthlyArchiveFiles(settings: KnomoSettings): TFile[] {
		const monthlyFolderPath = normalizeVaultPath(settings.monthlyMemoFolder);
		const monthlyFolder = this.app.vault.getAbstractFileByPath(monthlyFolderPath);
		if (!(monthlyFolder instanceof TFolder)) {
			return [];
		}
		const systemFolderPath = getSystemFolderPath(settings.monthlyMemoFolder);
		const archivePathPattern = buildMonthlyArchivePathPattern(settings);
		const files: TFile[] = [];
		Vault.recurseChildren(monthlyFolder, (child) => {
			if (
				child instanceof TFile &&
				!child.path.startsWith(`${systemFolderPath}/`) &&
				archivePathPattern.test(child.path)
			) {
				files.push(child);
			}
		});
		return files;
	}

	private async removeMonthlyArchiveFilesExcept(settings: KnomoSettings, keepRelativePaths: Set<string>): Promise<void> {
		const monthlyFolderPath = normalizeVaultPath(settings.monthlyMemoFolder);
		for (const file of this.listMonthlyArchiveFiles(settings)) {
			const relativePath = file.path.slice(monthlyFolderPath.length + 1);
			if (!keepRelativePaths.has(relativePath)) {
				this.onBeforeInternalTrash?.(file.path);
				await this.app.fileManager.trashFile(file);
			}
		}
	}

	private buildRebuiltMonthlyArchiveContent(
		settings: KnomoSettings,
		period: string,
		entries: MonthlyArchiveRebuildEntry[],
		previousContent: string,
	): string {
		const preservedComment = extractLeadingReadOnlyComment(previousContent);
		let content = preservedComment === null
			? ensureReadOnlyComment(`# ${period}`)
			: `${preservedComment}\n\n# ${period}`;
		for (const entry of entries) {
			const dateHeading = formatMonthlyDateHeading(settings.monthlyDateHeadingFormat, entry.createdAt);
			content = ensureDateHeading(content, dateHeading, settings.monthlyDateOrder);
			content = this.markdownBlockService.insertMemoBlock(content, {
				heading: dateHeading,
				block: entry.block,
				position: "bottom",
				createHeadingIfMissing: true,
			});
		}
		return content;
	}

	private buildRebuiltMonthlyRefs(
		settings: KnomoSettings,
		path: string,
		content: string,
		entries: MonthlyArchiveRebuildEntry[],
	): Map<string, MonthlyRef> {
		const refs = new Map<string, MonthlyRef>();
		const usedLines = new Set<number>();
		for (const entry of entries) {
			const dateHeading = formatMonthlyDateHeading(settings.monthlyDateHeadingFormat, entry.createdAt);
			const block = this.markdownBlockService.parseMemoBlocksUnderHeading(content, dateHeading)
				.find((candidate) => candidate.rawBlock === entry.block && !usedLines.has(candidate.startLine));
			if (block === undefined) {
				throw new Error(`Unable to locate rebuilt monthly memo: ${entry.memoId}`);
			}
			usedLines.add(block.startLine);
			refs.set(entry.memoId, buildMonthlyRef(path, dateHeading, content, block.rawBlock, block.startLine + 1));
		}
		return refs;
	}

	private buildInsertedMemoContent(
		currentContent: string,
		settings: KnomoSettings,
		period: string,
		dateHeading: string,
		block: string,
	): string {
		const withMonthHeading = ensureMonthHeading(currentContent, period);
		const withComment = ensureReadOnlyComment(withMonthHeading);
		const withDateHeading = ensureDateHeading(withComment, dateHeading, settings.monthlyDateOrder);
		return this.markdownBlockService.insertMemoBlock(withDateHeading, {
			heading: dateHeading,
			block,
			position: "bottom",
			createHeadingIfMissing: true,
		});
	}

	private countMemoBlockOccurrences(content: string, block: string): number {
		return this.markdownBlockService.parseMemoBlocks(content)
			.filter((candidate) => candidate.rawBlock === block)
			.length;
	}
}

export function getMonthlyArchivePath(settings: KnomoSettings, period: string): string {
	const folder = normalizeVaultPath(settings.monthlyMemoFolder);
	const format = settings.monthlyMemoFileFormat.trim() || DEFAULT_MONTHLY_MEMO_FILE_FORMAT;
	const fileName = format.replace(/YYYY-MM/g, period);
	return normalizePath(`${folder}/${fileName}`);
}

export function isMonthlyArchivePath(settings: KnomoSettings, path: string): boolean {
	return buildMonthlyArchivePathPattern(settings).test(path);
}

function buildMonthlyArchiveConflictFile(settings: KnomoSettings, file: TFile): SyncConflictFile | null {
	const period = file.name.match(/(\d{4}-\d{2})/)?.[1] ?? null;
	if (period === null) {
		return null;
	}
	const canonicalPath = getMonthlyArchivePath(settings, period);
	if (getParentFolderPath(file.path) !== getParentFolderPath(canonicalPath)) {
		return null;
	}
	const canonicalName = canonicalPath.split("/").pop() ?? "";
	const canonicalStem = stripMarkdownExtension(canonicalName);
	const fileStem = stripMarkdownExtension(file.name);
	if (file.name === canonicalName || !isMonthlyArchiveSideCopyStem(fileStem, canonicalStem)) {
		return null;
	}
	return {
		kind: "monthly-archive",
		path: file.path,
		period,
	};
}

function stripMarkdownExtension(fileName: string): string {
	return fileName.replace(/\.md$/i, "");
}

function isMonthlyArchiveSideCopyStem(fileStem: string, canonicalStem: string): boolean {
	if (canonicalStem.length === 0 || !fileStem.startsWith(canonicalStem) || fileStem === canonicalStem) {
		return false;
	}
	const suffix = fileStem.slice(canonicalStem.length);
	return /^[-\s(._]/.test(suffix);
}

export function formatMonthlyDateHeading(format: string, date: Date): string {
	const dateFormat = format.trim() || DEFAULT_MONTHLY_DATE_HEADING_FORMAT;
	const momentFactory = obsidianMoment as unknown as MomentFactory;
	const momentDate = momentFactory(date);
	return dateFormat.replace(MONTHLY_DATE_TOKEN_PATTERN, (token: string, offset: number, source: string) => {
		const previousCharacter = source[offset - 1] ?? "";
		const nextCharacter = source[offset + token.length] ?? "";
		if (ASCII_LETTER_PATTERN.test(previousCharacter) || ASCII_LETTER_PATTERN.test(nextCharacter)) {
			return token;
		}
		return momentDate.format(token);
	});
}

function ensureMonthHeading(content: string, period: string): string {
	const normalizedContent = normalizeMarkdownLineEndings(content).trim();
	const monthHeading = `# ${period}`;
	if (normalizedContent.length === 0) {
		return monthHeading;
	}
	if (normalizedContent.split("\n").some((line) => line.trim() === monthHeading)) {
		return normalizeMarkdownLineEndings(content);
	}
	return `${monthHeading}\n\n${normalizeMarkdownLineEndings(content).replace(/^\s+/, "")}`;
}

export function ensureReadOnlyComment(content: string, locale: KnomoLocale = getKnomoLocale()): string {
	const normalizedContent = normalizeMarkdownLineEndings(content);
	const trimmedStart = normalizedContent.replace(/^\s+/, "");
	if (
		trimmedStart.startsWith(`<!-- ${MONTHLY_ARCHIVE_MARKER}`)
		|| trimmedStart.startsWith(LEGACY_MONTHLY_ARCHIVE_READONLY_COMMENT)
	) {
		return normalizedContent;
	}
	const comment = getMonthlyArchiveReadOnlyComment(locale);
	const contentWithoutOldLeadingSpace = normalizedContent.replace(/^\s+/, "");
	return contentWithoutOldLeadingSpace.length === 0
		? comment
		: `${comment}\n\n${contentWithoutOldLeadingSpace}`;
}

export function getMonthlyArchiveReadOnlyComment(locale: KnomoLocale): string {
	return [
		`<!-- ${MONTHLY_ARCHIVE_MARKER}`,
		translate(locale, "archive.readOnlyComment"),
		"-->",
	].join("\n");
}

function ensureDateHeading(content: string, dateHeading: string, order: MonthlyDateOrder): string {
	const normalizedContent = normalizeMarkdownLineEndings(content);
	if (normalizedContent.split("\n").some((line) => line.trim() === dateHeading.trim())) {
		return normalizedContent;
	}
	if (order === "desc") {
		const lines = normalizedContent.split("\n");
		const firstDateHeadingIndex = lines.findIndex((line) => /^##\s/.test(line));
		if (firstDateHeadingIndex === -1) {
			return `${normalizedContent.replace(/\s*$/, "")}\n\n${dateHeading}`;
		}
		const before = lines.slice(0, firstDateHeadingIndex).join("\n");
		const after = lines.slice(firstDateHeadingIndex).join("\n");
		return `${before}\n${dateHeading}\n\n${after}`;
	}
	return `${normalizedContent.replace(/\s*$/, "")}\n\n${dateHeading}`;
}

function buildMonthlyRef(
	path: string,
	dateHeading: string,
	content: string,
	block: string,
	lineNumberHint: number | null = null,
): MonthlyRef {
	return {
		path,
		dateHeading,
		lastKnownBlock: block,
		lastKnownHash: hashText(block),
		lineNumberHint: lineNumberHint ?? findLineNumber(content, block, true),
		lastSyncedAt: new Date().toISOString(),
	};
}

function buildMonthlyArchivePathPattern(settings: KnomoSettings): RegExp {
	const monthlyFolderPath = normalizeVaultPath(settings.monthlyMemoFolder);
	const format = settings.monthlyMemoFileFormat.trim() || DEFAULT_MONTHLY_MEMO_FILE_FORMAT;
	const escapedFormat = format
		.split("YYYY-MM")
		.map(escapeRegExp)
		.join("\\d{4}-\\d{2}");
	return new RegExp(`^${escapeRegExp(monthlyFolderPath)}/${escapedFormat}$`);
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractLeadingReadOnlyComment(content: string): string | null {
	const trimmed = normalizeMarkdownLineEndings(content).replace(/^\s+/, "");
	if (!trimmed.startsWith("<!--")) {
		return null;
	}
	const endIndex = trimmed.indexOf("-->");
	if (endIndex === -1) {
		return null;
	}
	const comment = trimmed.slice(0, endIndex + 3);
	return comment.includes(MONTHLY_ARCHIVE_MARKER) || comment === LEGACY_MONTHLY_ARCHIVE_READONLY_COMMENT
		? comment
		: null;
}

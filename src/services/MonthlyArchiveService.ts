import { normalizePath, TFile, TFolder, Vault } from "obsidian";
import type { App } from "obsidian";

import { DEFAULT_MONTHLY_DATE_HEADING_FORMAT, DEFAULT_MONTHLY_MEMO_FILE_FORMAT } from "../constants";
import type { MemoRecord, MonthlyRef } from "../types/memo";
import type { KnomoSettings, MonthlyDateOrder } from "../types/settings";
import { formatDatePart, formatMonthPeriod } from "../utils/date";
import { hashText } from "../utils/hash";
import { findLineNumber, normalizeMarkdownLineEndings } from "../utils/markdown";
import { getSystemFolderPath, normalizeVaultPath } from "../utils/path";
import { ensureFolder, ensureTextFile, getParentFolderPath } from "../utils/vault";
import { MarkdownBlockService } from "./MarkdownBlockService";

// 职责：维护月度归档文件中的月份标题、日期标题和完整 memo block。
export const MONTHLY_ARCHIVE_READONLY_COMMENT = [
	"<!--",
	"Knomo monthly archive file: this file is generated automatically from Daily Notes. Do not edit memos here directly; edit them in Knomo or the corresponding daily note.",
	"-->",
].join("\n");

export interface MonthlyArchiveWriteResult {
	file: TFile;
	ref: MonthlyRef;
	content: string;
}

export interface MonthlyArchiveUpsertOptions {
	allowMissingInsert?: boolean;
}

export class MonthlyArchiveMissingError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "MonthlyArchiveMissingError";
	}
}

export class MonthlyArchiveService {
	constructor(
		private readonly app: App,
		private readonly markdownBlockService = new MarkdownBlockService(),
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
			throw new MonthlyArchiveMissingError("Monthly archive file does not exist.");
		}
		const file = existing as TFile;
		const dateHeading = memo.monthlyRef.dateHeading || formatMonthlyDateHeading(settings.monthlyDateHeadingFormat, new Date(memo.createdAt));
		let lineNumberHint: number | null = null;
		const content = await this.app.vault.process(file, (currentContent) => {
			const location = this.markdownBlockService.findMemoBlock(currentContent, {
				lineNumberHint: memo.monthlyRef.lineNumberHint,
				lastKnownBlock: memo.monthlyRef.lastKnownBlock,
				lastKnownHash: memo.monthlyRef.lastKnownHash,
				contentHash: memo.contentHash,
			}, "monthly_block_missing");
			if (location.parsedBlock === null) {
				if (options.allowMissingInsert !== true) {
					throw new MonthlyArchiveMissingError("Monthly archive block does not exist.");
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
			throw new MonthlyArchiveMissingError("Monthly archive file does not exist.");
		}
		const file = existing as TFile;
		let deletedBlock = "";
		const content = await this.app.vault.process(file, (currentContent) => {
			const location = this.markdownBlockService.findMemoBlock(currentContent, {
				lineNumberHint: memo.monthlyRef.lineNumberHint,
				lastKnownBlock: memo.monthlyRef.lastKnownBlock,
				lastKnownHash: memo.monthlyRef.lastKnownHash,
				contentHash: memo.contentHash,
			}, "monthly_block_missing");
			if (location.parsedBlock === null) {
				throw new MonthlyArchiveMissingError("Monthly archive block does not exist.");
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
				await this.app.vault.delete(file);
			}
		}
	}
}

export function getMonthlyArchivePath(settings: KnomoSettings, period: string): string {
	const folder = normalizeVaultPath(settings.monthlyMemoFolder);
	const format = settings.monthlyMemoFileFormat.trim() || DEFAULT_MONTHLY_MEMO_FILE_FORMAT;
	const fileName = format.replace(/YYYY-MM/g, period);
	return normalizePath(`${folder}/${fileName}`);
}

export function formatMonthlyDateHeading(format: string, date: Date): string {
	const dateFormat = format.trim() || DEFAULT_MONTHLY_DATE_HEADING_FORMAT;
	const datePart = formatDatePart(date);
	return dateFormat.replace(/YYYY-MM-DD/g, datePart).replace(/YYYY-MM/g, datePart.slice(0, 7));
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

export function ensureReadOnlyComment(content: string): string {
	const normalizedContent = normalizeMarkdownLineEndings(content);
	const trimmedStart = normalizedContent.trimStart();
	if (trimmedStart.startsWith(MONTHLY_ARCHIVE_READONLY_COMMENT)) {
		return normalizedContent;
	}
	const contentWithoutOldLeadingSpace = normalizedContent.replace(/^\s+/, "");
	return contentWithoutOldLeadingSpace.length === 0
		? MONTHLY_ARCHIVE_READONLY_COMMENT
		: `${MONTHLY_ARCHIVE_READONLY_COMMENT}\n\n${contentWithoutOldLeadingSpace}`;
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

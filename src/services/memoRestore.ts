import { TFile } from "obsidian";
import type { App } from "obsidian";

import type { DailyRef, MemoRecord, MonthlyRef, ParsedMemoBlock } from "../types/memo";
import type { KnomoSettings } from "../types/settings";
import { KnomoError } from "../types/serviceError";
import { formatMonthPeriod, formatTimePart } from "../utils/date";
import { hashMemoContent, hashText } from "../utils/hash";
import { findLineNumber, splitMarkdownLines } from "../utils/markdown";
import { buildDailyRef } from "../utils/memoRefs";
import { buildMemoReferences } from "../utils/references";
import type { DailyNoteService } from "./DailyNoteService";
import type { MarkdownBlockService } from "./MarkdownBlockService";
import type { MemoIndexStore } from "./MemoIndexStore";
import {
	formatMonthlyDateHeading,
	getMonthlyArchivePath,
	MonthlyArchiveMissingError,
} from "./MonthlyArchiveService";
import type { MonthlyArchiveService } from "./MonthlyArchiveService";
import type { SelfWriteTracker } from "./SelfWriteTracker";
import {
	buildIndexWriteFailedError,
	createOperationId,
	hasValidMonthlyRef,
	markIndexSelfWrite,
	markSelfWrite,
} from "./syncHelpers";

type GetSettings = () => KnomoSettings;

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

export class MemoRestoreService {
	constructor(
		private readonly app: App,
		private readonly getSettings: GetSettings,
		private readonly dailyNoteService: DailyNoteService,
		private readonly monthlyArchiveService: MonthlyArchiveService,
		private readonly memoIndexStore: MemoIndexStore,
		private readonly selfWriteTracker: SelfWriteTracker,
		private readonly markdownBlockService: MarkdownBlockService,
	) {}

	async restoreMemo(memoId: string): Promise<MemoRecord> {
		const settings = this.getSettings();
		const currentMemo = await this.memoIndexStore.findMemoById(settings.monthlyMemoFolder, memoId);
		if (currentMemo === null) {
			throw new KnomoError("memo_not_found_or_cleaned");
		}
		return this.restoreCurrentMemo(settings, currentMemo);
	}

	async restoreMemoRecord(memo: MemoRecord): Promise<MemoRecord> {
		const settings = this.getSettings();
		const currentMemo = await this.memoIndexStore.findMemoByIdInPeriod(
			settings.monthlyMemoFolder,
			formatMonthPeriod(new Date(memo.createdAt)),
			memo.id,
		);
		if (currentMemo === null) {
			throw new KnomoError("memo_not_found_or_cleaned");
		}
		return this.restoreCurrentMemo(settings, currentMemo);
	}

	private async restoreCurrentMemo(settings: KnomoSettings, currentMemo: MemoRecord): Promise<MemoRecord> {
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
				markSelfWrite(this.selfWriteTracker, opId, dailyResult.filePath, "repair", dailyResult.content);
			}
			monthlyResult = await this.restoreMonthlyMemoBlock(settings, currentMemo, monthlyBlock);
			if (monthlyResult.changed) {
				markSelfWrite(this.selfWriteTracker, opId, monthlyResult.filePath, "archive", monthlyResult.content);
			}
		} catch (error) {
			throw error instanceof Error ? error : new KnomoError("restore_failed_retry");
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
			throw buildIndexWriteFailedError("restoring", error, dailyResult.filePath, monthlyResult.ref.path);
		}
		markIndexSelfWrite(this.selfWriteTracker, opId, settings, new Date(restoredMemo.createdAt));
		return restoredMemo;
	}

	async purgeDeletedMemo(memoId: string): Promise<void> {
		const settings = this.getSettings();
		const currentMemo = await this.memoIndexStore.findMemoById(settings.monthlyMemoFolder, memoId);
		if (currentMemo === null) {
			throw new KnomoError("memo_not_found_or_cleaned");
		}
		await this.purgeCurrentDeletedMemo(settings, currentMemo);
	}

	async purgeDeletedMemoRecord(memo: MemoRecord): Promise<void> {
		const settings = this.getSettings();
		const currentMemo = await this.memoIndexStore.findMemoByIdInPeriod(
			settings.monthlyMemoFolder,
			formatMonthPeriod(new Date(memo.createdAt)),
			memo.id,
		);
		if (currentMemo === null) {
			throw new KnomoError("memo_not_found_or_cleaned");
		}
		await this.purgeCurrentDeletedMemo(settings, currentMemo);
	}

	private async purgeCurrentDeletedMemo(settings: KnomoSettings, currentMemo: MemoRecord): Promise<void> {
		if (currentMemo.status !== "deleted") {
			throw new KnomoError("trash_only_purge");
		}
		const opId = createOperationId(new Date());
		await this.memoIndexStore.purgeDeletedMemoRecord(settings.monthlyMemoFolder, currentMemo);
		markIndexSelfWrite(this.selfWriteTracker, opId, settings, new Date(currentMemo.createdAt));
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
			markIndexSelfWrite(this.selfWriteTracker, createOperationId(new Date()), settings, new Date(memo.createdAt));
			return resolvedMemo;
		}

		const opId = createOperationId(new Date());
		try {
			const monthlyResult = await this.monthlyArchiveService.deleteMemoBlock(memo);
			markSelfWrite(this.selfWriteTracker, opId, monthlyResult.file.path, "archive", monthlyResult.content);
		} catch (error) {
			if (!(error instanceof MonthlyArchiveMissingError)) {
				const failedMemo = await this.memoIndexStore.upsertMemo(settings.monthlyMemoFolder, {
					...memo,
					issue: {
						type: "delete_failed",
						...(error instanceof KnomoError ? { code: error.code, context: error.params } : {}),
						detectedAt: new Date().toISOString(),
						message: error instanceof Error ? error.message : "Monthly archive delete retry failed.",
					},
				});
				markIndexSelfWrite(this.selfWriteTracker, opId, settings, new Date(memo.createdAt));
				return failedMemo;
			}
		}

		const resolvedMemo = await this.memoIndexStore.upsertMemo(settings.monthlyMemoFolder, {
			...memo,
			syncStatus: "synced",
			issue: null,
		});
		markIndexSelfWrite(this.selfWriteTracker, opId, settings, new Date(memo.createdAt));
		return resolvedMemo;
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
		const dailyHeading = memo.dailyRef.heading || settings.dailyHeading;
		const content = await this.app.vault.process(dailyFile, (currentContent) => {
			const existingBlock = this.findExistingRestoredBlock(currentContent, block, dailyHeading);
			if (existingBlock !== null) {
				restoredBlock = existingBlock.rawBlock;
				restoredLineNumber = existingBlock.startLine + 1;
				restoredParsedBlock = existingBlock;
				return currentContent;
			}
			changed = true;
			return this.markdownBlockService.insertMemoBlock(currentContent, {
				heading: dailyHeading,
				block,
				position: settings.dailyInsertPosition,
				createHeadingIfMissing: true,
			});
		});

		if (restoredParsedBlock === null) {
			restoredLineNumber = findLineNumber(content, restoredBlock, settings.dailyInsertPosition === "bottom");
			const parsedBlock = this.parseRestoredBlockFromContent(content, restoredBlock, restoredLineNumber);
			if (parsedBlock === null) {
				throw new KnomoError("restore_verify_daily_failed");
			}
			restoredParsedBlock = parsedBlock;
		}

		return {
			ref: buildDailyRef(dailyFile.path, dailyHeading, restoredBlock, restoredLineNumber),
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
		const existingBlock = this.findExistingRestoredBlock(content, block, dateHeading);
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

	private findExistingRestoredBlock(currentContent: string, block: string, heading: string): ParsedMemoBlock | null {
		const parsedBlock = this.parseRestoredBlock(block);
		if (parsedBlock === null) {
			return null;
		}

		const existingBlocks = this.markdownBlockService.parseMemoBlocksUnderHeading(currentContent, heading);
		if (parsedBlock.blockId !== null) {
			const blockIdMatch = existingBlocks.find((existingBlock) => existingBlock.blockId === parsedBlock.blockId);
			if (blockIdMatch !== undefined) {
				return blockIdMatch;
			}
		}
		return existingBlocks.find((existingBlock) => existingBlock.rawBlock === parsedBlock.rawBlock) ?? null;
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
			throw new KnomoError("missing_delete_snapshot");
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

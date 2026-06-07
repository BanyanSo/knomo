import { TFile } from "obsidian";
import type { App } from "obsidian";

import type { MemoRecord, MonthlyRef } from "../types/memo";
import type { KnomoSettings } from "../types/settings";
import { formatLocalIsoString, formatMonthPeriod, formatTimePart } from "../utils/date";
import { hashMemoContent } from "../utils/hash";
import { splitMarkdownLines } from "../utils/markdown";
import { buildDailyRef } from "../utils/memoRefs";
import { buildMemoReferences } from "../utils/references";
import type { DailyNoteService } from "./DailyNoteService";
import type { MarkdownBlockService } from "./MarkdownBlockService";
import type { MemoIndexStore } from "./MemoIndexStore";
import type { MonthlyArchiveService } from "./MonthlyArchiveService";
import type { SelfWriteTracker } from "./SelfWriteTracker";
import {
	buildIndexWriteFailedError,
	buildMonthlyIssue,
	createMemoId,
	createOperationId,
	hasValidMonthlyRef,
	markIndexSelfWrite,
	markSelfWrite,
	normalizeMemoInput,
} from "./syncHelpers";

type GetSettings = () => KnomoSettings;

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

export class MemoCommandService {
	constructor(
		private readonly app: App,
		private readonly getSettings: GetSettings,
		private readonly dailyNoteService: DailyNoteService,
		private readonly monthlyArchiveService: MonthlyArchiveService,
		private readonly memoIndexStore: MemoIndexStore,
		private readonly selfWriteTracker: SelfWriteTracker,
		private readonly markdownBlockService: MarkdownBlockService,
	) {}

	async createMemo(input: string, options: CreateMemoOptions = {}): Promise<CreateMemoResult> {
		const content = normalizeMemoInput(input);
		if (content.trim().length === 0) {
			throw new Error("Memo content cannot be empty.");
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
		markSelfWrite(this.selfWriteTracker, opId, dailyResult.file.path, "create", dailyResult.content);

		let monthlyRef: MonthlyRef;
		let syncStatus: MemoRecord["syncStatus"] = "synced";
		let issue: MemoRecord["issue"] = null;
		try {
			const monthlyResult = await this.monthlyArchiveService.insertMemoBlock(settings, createdAt, block);
			monthlyRef = monthlyResult.ref;
			markSelfWrite(this.selfWriteTracker, opId, monthlyResult.file.path, "archive", monthlyResult.content);
		} catch (error) {
			syncStatus = "monthly_failed";
			issue = {
				type: "monthly_sync_failed",
				detectedAt: new Date().toISOString(),
				message: error instanceof Error ? error.message : "Monthly archive sync failed.",
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
			throw buildIndexWriteFailedError("creating", error, dailyResult.file.path, monthlyRef.path);
		}
		markIndexSelfWrite(this.selfWriteTracker, opId, settings, createdAt);

		return { memo: savedMemo, opId };
	}

	async updateMemo(memo: MemoRecord, input: string): Promise<MemoRecord> {
		const content = normalizeMemoInput(input);
		if (content.trim().length === 0) {
			throw new Error("Memo content cannot be empty.");
		}

		const settings = this.getSettings();
		const currentMemo = await this.memoIndexStore.findMemoByIdInPeriod(
			settings.monthlyMemoFolder,
			formatMonthPeriod(new Date(memo.createdAt)),
			memo.id,
		);
		if (currentMemo === null || currentMemo.status !== "active") {
			throw new Error("Memo does not exist or has already been cleaned up.");
		}
		if (content === currentMemo.contentSnapshot) {
			return currentMemo;
		}
		const dailyFile = this.getTextFile(currentMemo.dailyRef.path, "Daily note file does not exist.");
		const opId = createOperationId(new Date());
		let nextDailyBlock = "";
		let dailyIssueType: MemoRecord["issue"] = null;
		let dailyContent = "";
		let dailyLineNumberHint = currentMemo.dailyRef.lineNumberHint;
		try {
			dailyContent = await this.app.vault.process(dailyFile, (currentContent) => {
				const location = this.markdownBlockService.findMemoBlock(currentContent, {
					lineNumberHint: currentMemo.dailyRef.lineNumberHint,
					lastKnownBlock: currentMemo.dailyRef.lastKnownBlock,
					lastKnownHash: currentMemo.dailyRef.lastKnownHash,
					contentHash: currentMemo.contentHash,
					allowLineHintTimeMatch: true,
				}, "daily_block_missing");
				if (location.parsedBlock === null) {
					dailyIssueType = {
						type: location.issueType ?? "daily_block_missing",
						detectedAt: new Date().toISOString(),
						message: "Unable to find the memo block in the daily note.",
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
					...currentMemo,
					issue: dailyIssueType,
				});
			}
			throw error;
		}
		markSelfWrite(this.selfWriteTracker, opId, dailyFile.path, "edit", dailyContent);

		const metadata = this.markdownBlockService.parseMemoMetadata(content);
		const contentHash = hashMemoContent(content);
		let syncStatus: MemoRecord["syncStatus"] = "synced";
		let issue: MemoRecord["issue"] = null;
		let monthlyRef = currentMemo.monthlyRef;
		try {
			const monthlyResult = await this.monthlyArchiveService.upsertMemoBlock(settings, {
				...currentMemo,
				contentSnapshot: content,
				contentHash,
				tags: metadata.tags,
				links: metadata.links,
				images: metadata.images,
			}, nextDailyBlock);
			monthlyRef = monthlyResult.ref;
			markSelfWrite(this.selfWriteTracker, opId, monthlyResult.file.path, "archive", monthlyResult.content);
		} catch (error) {
			syncStatus = "monthly_failed";
			issue = buildMonthlyIssue(error);
		}

		let updatedMemo: MemoRecord;
		try {
			updatedMemo = await this.memoIndexStore.upsertMemo(settings.monthlyMemoFolder, {
				...currentMemo,
				updatedAt: new Date().toISOString(),
				contentSnapshot: content,
				contentHash,
				syncStatus,
				version: currentMemo.version + 1,
				tags: metadata.tags,
				links: metadata.links,
				images: metadata.images,
				references: buildMemoReferences(content, currentMemo.sourceMemoId, currentMemo.references[0]?.referenceText ?? null),
				issue,
				dailyRef: buildDailyRef(dailyFile.path, currentMemo.dailyRef.heading, nextDailyBlock, dailyLineNumberHint),
				monthlyRef,
			});
		} catch (error) {
			throw buildIndexWriteFailedError("editing", error, dailyFile.path, monthlyRef.path);
		}
		markIndexSelfWrite(this.selfWriteTracker, opId, settings, new Date(currentMemo.createdAt));
		return updatedMemo;
	}

	async deleteMemo(memo: MemoRecord): Promise<MemoRecord> {
		const settings = this.getSettings();
		const currentMemo = await this.memoIndexStore.findMemoById(settings.monthlyMemoFolder, memo.id);
		if (currentMemo === null) {
			throw new Error("Memo does not exist or has already been cleaned up.");
		}
		if (currentMemo.status === "deleted") {
			return currentMemo;
		}
		if (currentMemo.status !== "active") {
			return currentMemo;
		}

		const dailyFile = this.getTextFile(currentMemo.dailyRef.path, "Daily note file does not exist.");
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
						message: "Unable to find the daily memo block to delete.",
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
		markSelfWrite(this.selfWriteTracker, opId, dailyFile.path, "delete", dailyContent);

		let syncStatus: MemoRecord["syncStatus"] = "synced";
		let issue: MemoRecord["issue"] = null;
		let deletedMonthlyBlock = hasValidMonthlyRef(currentMemo) ? currentMemo.monthlyRef.lastKnownBlock : "";
		if (hasValidMonthlyRef(currentMemo)) {
			try {
				const monthlyResult = await this.monthlyArchiveService.deleteMemoBlock(currentMemo);
				deletedMonthlyBlock = monthlyResult.ref.lastKnownBlock;
				markSelfWrite(this.selfWriteTracker, opId, monthlyResult.file.path, "archive", monthlyResult.content);
			} catch (error) {
				syncStatus = "monthly_delete_failed";
				issue = {
					type: "delete_failed",
					detectedAt: new Date().toISOString(),
					message: error instanceof Error ? error.message : "Monthly archive delete failed.",
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
			throw buildIndexWriteFailedError("deleting", error, dailyFile.path, currentMemo.monthlyRef.path);
		}
		markIndexSelfWrite(this.selfWriteTracker, opId, settings, new Date(currentMemo.createdAt));
		return deletedMemo;
	}

	private getTextFile(path: string, errorMessage: string): TFile {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) {
			throw new Error(errorMessage);
		}
		return file;
	}
}

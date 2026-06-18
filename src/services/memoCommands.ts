import { TFile } from "obsidian";
import type { App } from "obsidian";

import type { MemoRecord, MonthlyRef } from "../types/memo";
import type { PendingMemoCreate } from "../types/pending";
import { PendingMemoWriteConflictError } from "../types/pending";
import type { KnomoSettings } from "../types/settings";
import { KnomoError } from "../types/serviceError";
import { formatLocalIsoString, formatMonthPeriod, formatTimePart } from "../utils/date";
import { hashMemoContent } from "../utils/hash";
import { splitMarkdownLines } from "../utils/markdown";
import { buildDailyRef } from "../utils/memoRefs";
import { buildMemoReferences } from "../utils/references";
import type { DailyNoteService } from "./DailyNoteService";
import type { MarkdownBlockService } from "./MarkdownBlockService";
import type { MemoIndexStore } from "./MemoIndexStore";
import type { MonthlyArchiveService } from "./MonthlyArchiveService";
import type { PendingMemoCreateStoreLike } from "./PendingMemoCreateStore";
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
		private readonly pendingMemoCreateStore: PendingMemoCreateStoreLike,
	) {}

	async createMemo(input: string, options: CreateMemoOptions = {}): Promise<CreateMemoResult> {
		const content = normalizeMemoInput(input);
		if (content.trim().length === 0) {
			throw new KnomoError("memo_content_empty");
		}

		await this.recoverPendingCreates();
		const settings = this.getSettings();
		const createdAt = new Date();
		const createdAtText = formatLocalIsoString(createdAt);
		const opId = createOperationId(createdAt);
		const memoId = await this.allocateMemoId(settings, createdAt);
		const block = this.markdownBlockService.buildMemoBlock(content, formatTimePart(createdAt, settings.memoTimeFormat));
		const dailyTrailer = options.dailyTrailer ?? null;
		const dailyWrite = await this.dailyNoteService.prepareMemoBlockInsert(
			settings,
			createdAt,
			block,
			dailyTrailer ?? undefined,
		);
		const operation: PendingMemoCreate = {
			memoId,
			opId,
			createdAt: createdAtText,
			content,
			block,
			dailyTrailer,
			source: options.source ?? "plugin_input",
			sourceMemoId: options.sourceMemoId ?? null,
			sourceReferenceText: options.sourceReferenceText ?? null,
			settings,
			dailyWrite,
			monthlyWrite: null,
		};
		await this.pendingMemoCreateStore.add(operation);
		return this.completePendingCreate(operation);
	}

	async recoverPendingCreates(): Promise<number> {
		const operations = await this.pendingMemoCreateStore.list();
		const errors: string[] = [];
		let recovered = 0;
		for (const operation of operations) {
			try {
				const existingMemo = await this.memoIndexStore.findMemoByIdInPeriod(
					operation.settings.monthlyMemoFolder,
					formatMonthPeriod(new Date(operation.createdAt)),
					operation.memoId,
				);
				if (existingMemo !== null) {
					if (
						existingMemo.createdAt !== operation.createdAt
						|| existingMemo.dailyRef.path !== operation.dailyWrite.ref.path
					) {
						throw new Error(`memoId collision: ${operation.memoId}`);
					}
					await this.pendingMemoCreateStore.remove(operation.memoId);
				} else {
					await this.completePendingCreate(operation);
				}
				recovered += 1;
			} catch (error) {
				errors.push(error instanceof Error ? error.message : `Unable to recover memo: ${operation.memoId}`);
			}
		}
		if (errors.length > 0) {
			throw new Error(`Pending memo create recovery failed: ${errors.join("; ")}`);
		}
		return recovered;
	}

	async updateMemo(memo: MemoRecord, input: string): Promise<MemoRecord> {
		const content = normalizeMemoInput(input);
		if (content.trim().length === 0) {
			throw new KnomoError("memo_content_empty");
		}

		const settings = this.getSettings();
		const currentMemo = await this.memoIndexStore.findMemoByIdInPeriod(
			settings.monthlyMemoFolder,
			formatMonthPeriod(new Date(memo.createdAt)),
			memo.id,
		);
		if (currentMemo === null || currentMemo.status !== "active") {
			throw new KnomoError("memo_not_found_or_cleaned");
		}
		if (content === currentMemo.contentSnapshot) {
			return currentMemo;
		}
		const dailyFile = this.getTextFile(currentMemo.dailyRef.path);
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
						code: "daily_block_missing",
						detectedAt: new Date().toISOString(),
						message: "Unable to find the memo block in the daily note.",
					};
					throw new KnomoError("daily_block_missing");
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
			throw new KnomoError("memo_not_found_or_cleaned");
		}
		if (currentMemo.status === "deleted") {
			return currentMemo;
		}
		if (currentMemo.status !== "active") {
			return currentMemo;
		}

		const dailyFile = this.getTextFile(currentMemo.dailyRef.path);
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
						code: "delete_daily_block_missing",
						detectedAt: new Date().toISOString(),
						message: "Unable to find the daily memo block to delete.",
					};
					throw new KnomoError("delete_daily_block_missing");
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
					...(error instanceof KnomoError ? { code: error.code, context: error.params } : {}),
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

	private getTextFile(path: string): TFile {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) {
			throw new KnomoError("daily_file_missing");
		}
		return file;
	}

	private async completePendingCreate(operation: PendingMemoCreate): Promise<CreateMemoResult> {
		const createdAt = new Date(operation.createdAt);
		const dailyResult = await this.dailyNoteService.commitPreparedMemoBlock(
			operation.settings,
			operation.block,
			operation.dailyWrite,
			operation.dailyTrailer ?? undefined,
		);
		if (dailyResult.changed) {
			markSelfWrite(this.selfWriteTracker, operation.opId, dailyResult.file.path, "create", dailyResult.content);
		}

		let currentOperation = operation;
		let monthlyRef = createEmptyMonthlyRef();
		let syncStatus: MemoRecord["syncStatus"] = "synced";
		let issue: MemoRecord["issue"] = null;
		let monthlyWrite = currentOperation.monthlyWrite;
		if (monthlyWrite === null) {
			try {
				monthlyWrite = await this.monthlyArchiveService.prepareMemoBlockInsert(
					currentOperation.settings,
					createdAt,
					currentOperation.block,
				);
			} catch (error) {
				syncStatus = "monthly_failed";
				issue = buildMonthlyIssue(error);
			}
			if (monthlyWrite !== null) {
				currentOperation = {
					...currentOperation,
					monthlyWrite,
				};
				await this.pendingMemoCreateStore.update(currentOperation);
			}
		}

		if (monthlyWrite !== null) {
			try {
				const monthlyResult = await this.monthlyArchiveService.commitPreparedMemoBlock(
					currentOperation.settings,
					createdAt,
					currentOperation.block,
					monthlyWrite,
				);
				monthlyRef = monthlyResult.ref;
				if (monthlyResult.changed) {
					markSelfWrite(this.selfWriteTracker, currentOperation.opId, monthlyResult.file.path, "archive", monthlyResult.content);
				}
			} catch (error) {
				if (error instanceof PendingMemoWriteConflictError) {
					throw error;
				}
				syncStatus = "monthly_failed";
				issue = buildMonthlyIssue(error);
			}
		}

		const memo = this.buildPendingMemo(currentOperation, dailyResult.ref, monthlyRef, syncStatus, issue);
		let savedMemo: MemoRecord;
		try {
			savedMemo = await this.memoIndexStore.addMemoWithId(
				currentOperation.settings.monthlyMemoFolder,
				memo,
			);
		} catch (error) {
			throw buildIndexWriteFailedError("creating", error, dailyResult.file.path, monthlyRef.path);
		}
		markIndexSelfWrite(this.selfWriteTracker, currentOperation.opId, currentOperation.settings, createdAt);
		try {
			await this.pendingMemoCreateStore.remove(currentOperation.memoId);
		} catch {
			// 索引已提交；保留 journal 供下次启动做幂等清理。
		}
		return {
			memo: savedMemo,
			opId: currentOperation.opId,
		};
	}

	private buildPendingMemo(
		operation: PendingMemoCreate,
		dailyRef: MemoRecord["dailyRef"],
		monthlyRef: MonthlyRef,
		syncStatus: MemoRecord["syncStatus"],
		issue: MemoRecord["issue"],
	): MemoRecord {
		const metadata = this.markdownBlockService.parseMemoMetadata(operation.content);
		return {
			id: operation.memoId,
			createdAt: operation.createdAt,
			updatedAt: operation.createdAt,
			contentSnapshot: operation.content,
			contentHash: hashMemoContent(operation.content),
			status: "active",
			syncStatus,
			source: operation.source,
			version: 1,
			tags: metadata.tags,
			links: metadata.links,
			images: metadata.images,
			references: buildMemoReferences(
				operation.content,
				operation.sourceMemoId,
				operation.sourceReferenceText,
			),
			sourceMemoId: operation.sourceMemoId,
			issue,
			lastMarkdownSyncAt: null,
			lastMarkdownSyncSource: null,
			dailyRef,
			monthlyRef,
		};
	}

	private async allocateMemoId(settings: KnomoSettings, createdAt: Date): Promise<string> {
		const pendingIds = new Set((await this.pendingMemoCreateStore.list()).map((operation) => operation.memoId));
		const period = formatMonthPeriod(createdAt);
		for (let attempt = 0; attempt < 100; attempt += 1) {
			const memoId = createMemoId(createdAt);
			if (pendingIds.has(memoId)) {
				continue;
			}
			const existingMemo = await this.memoIndexStore.findMemoByIdInPeriod(
				settings.monthlyMemoFolder,
				period,
				memoId,
			);
			if (existingMemo === null) {
				return memoId;
			}
		}
		throw new Error("Unable to allocate a unique memoId.");
	}
}

function createEmptyMonthlyRef(): MonthlyRef {
	return {
		path: "",
		dateHeading: "",
		lastKnownBlock: "",
		lastKnownHash: "",
		lineNumberHint: null,
		lastSyncedAt: null,
	};
}

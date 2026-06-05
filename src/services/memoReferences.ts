import { TFile } from "obsidian";
import type { App } from "obsidian";

import type { MemoRecord } from "../types/memo";
import type { KnomoSettings } from "../types/settings";
import { splitMarkdownLines } from "../utils/markdown";
import { buildDailyRef } from "../utils/memoRefs";
import type { MarkdownBlockService } from "./MarkdownBlockService";
import type { MemoIndexStore } from "./MemoIndexStore";
import type { MonthlyArchiveService } from "./MonthlyArchiveService";
import type { SelfWriteTracker } from "./SelfWriteTracker";
import {
	buildIndexWriteFailedError,
	buildMonthlyIssue,
	createOperationId,
	markIndexSelfWrite,
	markSelfWrite,
} from "./syncHelpers";

type GetSettings = () => KnomoSettings;

export class MemoReferenceService {
	constructor(
		private readonly app: App,
		private readonly getSettings: GetSettings,
		private readonly monthlyArchiveService: MonthlyArchiveService,
		private readonly memoIndexStore: MemoIndexStore,
		private readonly selfWriteTracker: SelfWriteTracker,
		private readonly markdownBlockService: MarkdownBlockService,
	) {}

	async ensureReferenceBlockId(memo: MemoRecord): Promise<string> {
		const settings = this.getSettings();
		const dailyFile = this.getTextFile(memo.dailyRef.path, "Daily note file does not exist.");
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
					message: "Unable to find the memo block in the daily note.",
				},
			});
			throw new Error("Unable to find the memo block in the daily note.");
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
				throw new Error("Unable to find the memo block in the daily note.");
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
			markSelfWrite(this.selfWriteTracker, opId, dailyFile.path, "edit", dailyContent);
		}

		let syncStatus: MemoRecord["syncStatus"] = "synced";
		let issue: MemoRecord["issue"] = null;
		let monthlyRef = memo.monthlyRef;
		try {
			const monthlyResult = await this.monthlyArchiveService.upsertMemoBlock(settings, memo, nextDailyBlock);
			monthlyRef = monthlyResult.ref;
			markSelfWrite(this.selfWriteTracker, opId, monthlyResult.file.path, "archive", monthlyResult.content);
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
			throw buildIndexWriteFailedError("generating reference", error, dailyFile.path, monthlyRef.path);
		}
		markIndexSelfWrite(this.selfWriteTracker, opId, settings, new Date(memo.createdAt));
		return blockId;
	}

	private getTextFile(path: string, errorMessage: string): TFile {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) {
			throw new Error(errorMessage);
		}
		return file;
	}
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
	throw new Error("Unable to generate a unique blockId.");
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

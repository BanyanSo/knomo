import { TFile } from "obsidian";
import type { App } from "obsidian";

import type { MemoRecord } from "../types/memo";
import type { KnomoSettings } from "../types/settings";
import { KnomoError } from "../types/serviceError";
import { hashText } from "../utils/hash";
import { buildMemoReferences } from "../utils/references";
import type { MarkdownBlockService } from "./MarkdownBlockService";
import type { MemoIndexStore } from "./MemoIndexStore";
import type { MonthlyArchiveService } from "./MonthlyArchiveService";
import type { SelfWriteTracker } from "./SelfWriteTracker";
import {
	buildMonthlyIssue,
	createOperationId,
	markIndexSelfWrite,
	markSelfWrite,
} from "./syncHelpers";

type GetSettings = () => KnomoSettings;

export class MemoRepairService {
	constructor(
		private readonly app: App,
		private readonly getSettings: GetSettings,
		private readonly monthlyArchiveService: MonthlyArchiveService,
		private readonly memoIndexStore: MemoIndexStore,
		private readonly selfWriteTracker: SelfWriteTracker,
		private readonly markdownBlockService: MarkdownBlockService,
	) {}

	async retryMonthlySync(memo: MemoRecord): Promise<MemoRecord> {
		const settings = this.getSettings();
		const dailyFile = this.getTextFile(memo.dailyRef.path);
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
					code: "retry_monthly_sync_daily_missing",
					detectedAt: new Date().toISOString(),
					message: "Unable to find the daily memo block before retrying monthly sync.",
				},
			});
			markIndexSelfWrite(this.selfWriteTracker, opId, settings, new Date(memo.createdAt));
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
			markSelfWrite(this.selfWriteTracker, opId, monthlyResult.file.path, "repair", monthlyResult.content);
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
					sectionType: memo.dailyRef.sectionType ?? (memo.dailyRef.heading === null ? "root" : "heading"),
					lastKnownBlock: location.parsedBlock.rawBlock,
					lastKnownHash: hashText(location.parsedBlock.rawBlock),
					lineNumberHint: location.parsedBlock.startLine + 1,
					lastSyncedAt: new Date().toISOString(),
				},
				monthlyRef: monthlyResult.ref,
			});
			markIndexSelfWrite(this.selfWriteTracker, opId, settings, new Date(memo.createdAt));
			return syncedMemo;
		} catch (error) {
			const failedMemo = await this.memoIndexStore.upsertMemo(settings.monthlyMemoFolder, {
				...memo,
				syncStatus: "monthly_failed",
				issue: buildMonthlyIssue(error),
			});
			markIndexSelfWrite(this.selfWriteTracker, opId, settings, new Date(memo.createdAt));
			return failedMemo;
		}
	}

	private getTextFile(path: string): TFile {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) {
			throw new KnomoError("daily_file_missing");
		}
		return file;
	}
}

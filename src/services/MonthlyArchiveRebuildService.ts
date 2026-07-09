import { TFile } from "obsidian";
import type { App } from "obsidian";

import type { MemoIssue } from "../types/issue";
import type { MemoRecord, ParsedMemoBlock } from "../types/memo";
import type { KnomoSettings } from "../types/settings";
import { KnomoError } from "../types/serviceError";
import { hashText } from "../utils/hash";
import { buildMemoReferences } from "../utils/references";
import type { MarkdownBlockService } from "./MarkdownBlockService";
import type { MemoIndexStore } from "./MemoIndexStore";
import { getMonthlyArchivePath } from "./MonthlyArchiveService";
import type { MonthlyArchiveRebuildEntry, MonthlyArchiveService } from "./MonthlyArchiveService";
import type { SelfWriteTracker } from "./SelfWriteTracker";
import { createOperationId, markIndexSelfWrite, markSelfWrite } from "./syncHelpers";

type GetSettings = () => KnomoSettings;

export interface RebuildMonthlyArchiveOptions {
	replaceExisting: boolean;
	createBackup: boolean;
}

export interface RebuildMonthlyArchiveResult {
	period: string;
	path: string;
	active: number;
	rebuilt: number;
	issues: number;
	archiveChanged: boolean;
	indexChanged: boolean;
	backupPath: string | null;
}

interface ResolvedMemo {
	memo: MemoRecord;
	block: ParsedMemoBlock;
}

interface UnresolvedMemo {
	memo: MemoRecord;
	issue: MemoIssue;
}

// 职责：以日记为主存储，按月份批量重建月度归档并保留 memoId。
export class MonthlyArchiveRebuildService {
	constructor(
		private readonly app: App,
		private readonly getSettings: GetSettings,
		private readonly monthlyArchiveService: MonthlyArchiveService,
		private readonly memoIndexStore: MemoIndexStore,
		private readonly selfWriteTracker: SelfWriteTracker,
		private readonly markdownBlockService: MarkdownBlockService,
	) {}

	async rebuildPeriod(period: string, options: RebuildMonthlyArchiveOptions): Promise<RebuildMonthlyArchiveResult> {
		if (!isValidPeriod(period)) {
			throw new KnomoError("monthly_archive_period_invalid", { period });
		}

		const settings = this.getSettings();
		const path = getMonthlyArchivePath(settings, period);
		const existingIndex = await this.memoIndexStore.loadExistingPeriod(settings.monthlyMemoFolder, period);
		if (existingIndex === null) {
			throw new KnomoError("monthly_archive_index_missing", { period });
		}

		const activeMemos = (await this.memoIndexStore.loadExistingPeriods(settings.monthlyMemoFolder, [period]))
			.filter((memo) => memo.status === "active")
			.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
		const initialResult: RebuildMonthlyArchiveResult = {
			period,
			path,
			active: activeMemos.length,
			rebuilt: 0,
			issues: 0,
			archiveChanged: false,
			indexChanged: false,
			backupPath: null,
		};
		if (activeMemos.length === 0) {
			return initialResult;
		}

		const existingArchive = this.app.vault.getAbstractFileByPath(path);
		if (existingArchive instanceof TFile && !options.replaceExisting) {
			return initialResult;
		}

		let backupPath: string | null = null;
		if (options.createBackup) {
			backupPath = await this.memoIndexStore.backupIndexes(
				settings.monthlyMemoFolder,
				`rebuild-monthly-${period}`,
			);
			await this.monthlyArchiveService.backupMonthlyArchives(settings, backupPath);
		}

		const { resolved, unresolved } = await this.resolveDailyBlocks(activeMemos);
		const opId = createOperationId(new Date());
		let archiveChanged = false;
		let refsByMemoId = new Map<string, MemoRecord["monthlyRef"]>();
		if (resolved.length > 0) {
			const entries: MonthlyArchiveRebuildEntry[] = resolved.map(({ memo, block }) => ({
				memoId: memo.id,
				createdAt: new Date(memo.createdAt),
				block: block.rawBlock,
			}));
			const writeResult = await this.monthlyArchiveService.rebuildMonthlyArchive(
				settings,
				period,
				entries,
				options.replaceExisting,
			);
			if (writeResult === null) {
				return { ...initialResult, backupPath };
			}
			archiveChanged = true;
			refsByMemoId = writeResult.refsByMemoId;
			markSelfWrite(this.selfWriteTracker, opId, writeResult.file.path, "repair", writeResult.content);
		}

		const now = new Date().toISOString();
		await this.memoIndexStore.mergePeriod(settings.monthlyMemoFolder, period, (index) => {
			const nextMemos = { ...index.memos };
			for (const item of resolved) {
				const current = nextMemos[item.memo.id];
				const monthlyRef = refsByMemoId.get(item.memo.id);
				if (current === undefined || current.status !== "active" || monthlyRef === undefined) {
					continue;
				}
				const contentChanged = current.contentHash !== item.block.contentHash;
				nextMemos[current.id] = {
					...current,
					updatedAt: contentChanged ? now : current.updatedAt,
					contentSnapshot: item.block.content,
					contentHash: item.block.contentHash,
					tags: item.block.tags,
					links: item.block.links,
					images: item.block.images,
					references: buildMemoReferences(
						item.block.content,
						current.sourceMemoId,
						current.references[0]?.referenceText ?? null,
					),
					syncStatus: "synced",
					issue: shouldClearRebuildIssue(current.issue) ? null : current.issue,
					dailyRef: {
						...current.dailyRef,
						lastKnownBlock: item.block.rawBlock,
						lastKnownHash: hashText(item.block.rawBlock),
						lineNumberHint: item.block.startLine + 1,
						lastSyncedAt: now,
					},
					monthlyRef,
				};
			}
			for (const item of unresolved) {
				const current = nextMemos[item.memo.id];
				if (current === undefined || current.status !== "active") {
					continue;
				}
				nextMemos[current.id] = {
					...current,
					syncStatus: "monthly_failed",
					issue: item.issue,
				};
			}
			return {
				...index,
				updatedAt: now,
				memos: nextMemos,
			};
		});
		markIndexSelfWrite(this.selfWriteTracker, opId, settings, periodToDate(period));

		return {
			...initialResult,
			rebuilt: resolved.length,
			issues: unresolved.length,
			archiveChanged,
			indexChanged: resolved.length > 0 || unresolved.length > 0,
			backupPath,
		};
	}

	private async resolveDailyBlocks(activeMemos: MemoRecord[]): Promise<{
		resolved: ResolvedMemo[];
		unresolved: UnresolvedMemo[];
	}> {
		const resolved: ResolvedMemo[] = [];
		const unresolved: UnresolvedMemo[] = [];
		const memosByPath = new Map<string, MemoRecord[]>();
		for (const memo of activeMemos) {
			const memos = memosByPath.get(memo.dailyRef.path) ?? [];
			memos.push(memo);
			memosByPath.set(memo.dailyRef.path, memos);
		}

		for (const [path, memos] of memosByPath) {
			const file = this.app.vault.getAbstractFileByPath(path);
			if (!(file instanceof TFile)) {
				for (const memo of memos) {
					unresolved.push({ memo, issue: buildDailyRebuildIssue("daily_block_missing", "daily_file_missing", path) });
				}
				continue;
			}

			const content = await this.app.vault.cachedRead(file);
			const usedBlockStarts = new Set<number>();
			for (const memo of memos) {
				const location = this.markdownBlockService.findMemoBlock(content, {
					lineNumberHint: memo.dailyRef.lineNumberHint,
					lastKnownBlock: memo.dailyRef.lastKnownBlock,
					lastKnownHash: memo.dailyRef.lastKnownHash,
					contentHash: memo.contentHash,
					allowLineHintTimeMatch: true,
				}, "daily_block_missing");
				if (location.parsedBlock === null || usedBlockStarts.has(location.parsedBlock.startLine)) {
					const issueType = location.issueType === "daily_block_ambiguous" || location.parsedBlock !== null
						? "daily_block_ambiguous"
						: "daily_block_missing";
					unresolved.push({
						memo,
						issue: buildDailyRebuildIssue(issueType, issueType, path),
					});
					continue;
				}
				usedBlockStarts.add(location.parsedBlock.startLine);
				resolved.push({ memo, block: location.parsedBlock });
			}
		}

		resolved.sort((left, right) => left.memo.createdAt.localeCompare(right.memo.createdAt));
		return { resolved, unresolved };
	}
}

function buildDailyRebuildIssue(
	type: "daily_block_missing" | "daily_block_ambiguous",
	code: "daily_file_missing" | "daily_block_missing" | "daily_block_ambiguous",
	path: string,
): MemoIssue {
	return {
		type,
		code,
		detectedAt: new Date().toISOString(),
		message: type === "daily_block_ambiguous"
			? "Multiple daily memo blocks match while rebuilding the monthly archive."
			: "Unable to find the daily memo block while rebuilding the monthly archive.",
		context: { path },
	};
}

function shouldClearRebuildIssue(issue: MemoIssue | null): boolean {
	return issue === null || [
		"daily_block_missing",
		"daily_block_ambiguous",
		"monthly_sync_failed",
		"monthly_block_missing",
	].includes(issue.type);
}

function isValidPeriod(period: string): boolean {
	return /^\d{4}-(?:0[1-9]|1[0-2])$/.test(period);
}

function periodToDate(period: string): Date {
	const [year, month] = period.split("-").map(Number);
	return new Date(year, month - 1, 1);
}

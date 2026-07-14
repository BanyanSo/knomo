import { TFile } from "obsidian";
import type { App } from "obsidian";

import type { MemoRecord } from "../types/memo";
import type { KnomoSettings } from "../types/settings";
import type { TimeBuoyIndexShard } from "../types/timeBuoy";
import { formatMonthPeriod } from "../utils/date";
import {
	addTimeBuoyCalendarDays,
	formatTimeBuoyDate,
	getTimeBuoyTargetPeriod,
	listTimeBuoyTargetPeriods,
} from "../utils/timeBuoyDate";
import { extractTimeBuoyDates, getTimeBuoyRevision } from "../utils/timeBuoyParser";
import type { MarkdownBlockService } from "./MarkdownBlockService";
import type { MemoIndexStore } from "./MemoIndexStore";
import type { TimeBuoyIndexStore } from "./TimeBuoyIndexStore";
import { parseTimeBuoyIndex } from "./TimeBuoyIndexStore";

export interface TimeBuoyRebuildProgress {
	total: number;
	completed: number;
	indexed: number;
	skipped: number;
	currentPath: string | null;
}

export interface TimeBuoyRebuildOptions {
	onProgress?: (progress: TimeBuoyRebuildProgress) => Promise<void> | void;
	isCancelled?: () => boolean;
	yieldToUi?: () => Promise<void>;
}

export type TimeBuoyRebuildResult =
	| { status: "completed"; total: number; indexed: number; skipped: number; periods: string[] }
	| { status: "cancelled"; total: number; indexed: number; skipped: number; periods: [] };

export interface TimeBuoyRebuildSkip {
	memoId: string;
	path: string;
	reason: "daily_file_missing" | "daily_block_missing";
}

export class TimeBuoyRebuildIncompleteError extends Error {
	constructor(readonly skippedItems: readonly TimeBuoyRebuildSkip[]) {
		super(`Time buoy rebuild skipped ${skippedItems.length} memo blocks; existing shards were preserved.`);
		this.name = "TimeBuoyRebuildIncompleteError";
	}
}

type GetSettings = () => KnomoSettings;

export class TimeBuoyRebuildService {
	constructor(
		private readonly app: App,
		private readonly getSettings: GetSettings,
		private readonly memoIndexStore: MemoIndexStore,
		private readonly timeBuoyIndexStore: TimeBuoyIndexStore,
		private readonly markdownBlockService: MarkdownBlockService,
	) {}

	async rebuild(options: TimeBuoyRebuildOptions = {}): Promise<TimeBuoyRebuildResult> {
		const settings = this.getSettings();
		const memos = (await this.memoIndexStore.loadAllExisting(settings.monthlyMemoFolder))
			.filter((memo) => memo.status === "active");
		const datesByPeriod = new Map<string, TimeBuoyIndexShard["dates"]>();
		const memosByDailyPath = new Map<string, MemoRecord[]>();
		for (const memo of memos) {
			const dailyMemos = memosByDailyPath.get(memo.dailyRef.path) ?? [];
			dailyMemos.push(memo);
			memosByDailyPath.set(memo.dailyRef.path, dailyMemos);
		}
		const skippedItems: TimeBuoyRebuildSkip[] = [];
		let indexed = 0;
		let completed = 0;

		for (const [dailyPath, dailyMemos] of memosByDailyPath) {
			const file = this.app.vault.getAbstractFileByPath(dailyPath);
			if (!(file instanceof TFile)) {
				for (const memo of dailyMemos) {
					skippedItems.push({ memoId: memo.id, path: dailyPath, reason: "daily_file_missing" });
					completed += 1;
				}
				continue;
			}
			const dailyContent = await this.app.vault.cachedRead(file);
			for (const memo of dailyMemos) {
				if (options.isCancelled?.() === true) {
					return { status: "cancelled", total: memos.length, indexed, skipped: skippedItems.length, periods: [] };
				}
				if (completed % 25 === 0) {
					await options.onProgress?.({
						total: memos.length,
						completed,
						indexed,
						skipped: skippedItems.length,
						currentPath: dailyPath,
					});
				}
				const location = this.markdownBlockService.findMemoBlock(dailyContent, {
					lineNumberHint: memo.dailyRef.lineNumberHint,
					lastKnownBlock: memo.dailyRef.lastKnownBlock,
					lastKnownHash: memo.dailyRef.lastKnownHash,
					contentHash: memo.contentHash,
					heading: memo.dailyRef.heading,
					allowLineHintTimeMatch: true,
					matchPolicy: "flexible",
				}, "daily_block_missing");
				if (location.parsedBlock === null) {
					skippedItems.push({ memoId: memo.id, path: dailyPath, reason: "daily_block_missing" });
					completed += 1;
					continue;
				}
				const targetDates = extractTimeBuoyDates(location.parsedBlock.content);
				const buoyRevision = getTimeBuoyRevision(location.parsedBlock.content);
				for (const targetDate of targetDates) {
					const targetPeriod = getTimeBuoyTargetPeriod(targetDate);
					if (targetPeriod === null) {
						continue;
					}
					const dates = datesByPeriod.get(targetPeriod) ?? {};
					const entries = dates[targetDate] ?? {};
					entries[memo.id] = {
						sourcePeriod: formatMonthPeriod(new Date(memo.createdAt)),
						buoyRevision,
					};
					dates[targetDate] = entries;
					datesByPeriod.set(targetPeriod, dates);
				}
				indexed += 1;
				completed += 1;
				if (completed % 25 === 0) {
					await options.yieldToUi?.();
				}
			}
		}

		if (options.isCancelled?.() === true) {
			return { status: "cancelled", total: memos.length, indexed, skipped: skippedItems.length, periods: [] };
		}
		if (skippedItems.length > 0) {
			throw new TimeBuoyRebuildIncompleteError(skippedItems);
		}
		const now = new Date();
		const nearbyPeriods = listTimeBuoyTargetPeriods(
			formatTimeBuoyDate(addTimeBuoyCalendarDays(now, -30)),
			formatTimeBuoyDate(addTimeBuoyCalendarDays(now, 30)),
		);
		const periods = [...new Set([
			...this.timeBuoyIndexStore.listStoredPeriods(settings.monthlyMemoFolder),
			...datesByPeriod.keys(),
			...nearbyPeriods,
		])].sort();
		for (const targetPeriod of periods) {
			const dates = datesByPeriod.get(targetPeriod) ?? {};
			parseTimeBuoyIndex(JSON.stringify({
				schemaVersion: 2,
				targetPeriod,
				updatedAt: new Date().toISOString(),
				dates,
			}), targetPeriod);
		}
		await this.timeBuoyIndexStore.replacePeriodsWithRollback(
			settings.monthlyMemoFolder,
			new Map(periods.map((targetPeriod) => [targetPeriod, datesByPeriod.get(targetPeriod) ?? {}])),
		);
		await options.onProgress?.({
			total: memos.length,
			completed: memos.length,
			indexed,
			skipped: skippedItems.length,
			currentPath: null,
		});
		return { status: "completed", total: memos.length, indexed, skipped: skippedItems.length, periods };
	}
}

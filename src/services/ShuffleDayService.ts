import type { MemoViewItem as MemoRecord } from "../types/memoView";
import type { CatalogDailyAggregate } from "../types/catalog";
import { formatDatePart, formatLocalIsoString } from "../utils/date";
import {
	buildPluginDataWithShuffleDayHistory,
	extractShuffleDayHistory,
} from "../utils/pluginData";
import {
	buildShuffleDayStats,
	selectShuffleDay,
	sortShuffleDayMemos,
	type ShuffleDaySelectionResult,
} from "../utils/shuffleDay";
import type { PluginDataStore } from "./PluginDataStore";

export class ShuffleDayService {
	constructor(private readonly pluginDataStore: PluginDataStore) {}

	async selectShuffleDay(memos: MemoRecord[]): Promise<ShuffleDaySelectionResult> {
		return this.pluginDataStore.mutate((savedData) => {
			const result = selectShuffleDay(memos, {
				history: extractShuffleDayHistory(savedData),
			});
			return {
				nextData: result.status === "ready"
					? buildPluginDataWithShuffleDayHistory(savedData, result.nextHistory)
					: null,
				result,
			};
		});
	}

	async selectCatalogShuffleDay(
		aggregates: readonly CatalogDailyAggregate[],
		loadDate: (date: string) => Promise<MemoRecord[]>,
		options: { today?: Date; now?: Date; random?: () => number } = {},
	): Promise<ShuffleDaySelectionResult> {
		const today = startOfLocalDay(options.today ?? new Date());
		const now = options.now ?? new Date();
		const random = options.random ?? Math.random;
		return this.pluginDataStore.mutate<ShuffleDaySelectionResult>(async (savedData) => {
			const history = extractShuffleDayHistory(savedData);
			const recentDates = new Set(history.slice(0, 5).map((entry) => entry.date));
			const eligible = aggregates.filter((item) => {
				const date = parseDateKey(item.logicalDate);
				return date !== null && differenceInCalendarDays(today, date) >= 7 && item.memoCount > 0;
			});
			if (eligible.length === 0) return { nextData: null, result: { status: "empty-not-enough-history" } as const };
			const preferred = eligible.filter((item) => !recentDates.has(item.logicalDate));
			const selected = weightedPickAggregate(preferred.length > 0 ? preferred : eligible, today, random);
			const memos = sortShuffleDayMemos(await loadDate(selected.logicalDate));
			if (memos.length === 0) return { nextData: null, result: { status: "empty-no-memos" } as const };
			const historyEntry = { date: selected.logicalDate, shownAt: formatLocalIsoString(now) };
			const nextHistory = [historyEntry, ...history].slice(0, 100);
			return {
				nextData: buildPluginDataWithShuffleDayHistory(savedData, nextHistory),
				result: {
					status: "ready",
					selectedDate: selected.logicalDate,
					memos,
					stats: buildShuffleDayStats(memos),
					historyEntry,
					nextHistory,
				} as const,
			};
		});
	}
}

function weightedPickAggregate(items: readonly CatalogDailyAggregate[], today: Date, random: () => number): CatalogDailyAggregate {
	const weights = items.map((item) => {
		const daysAgo = differenceInCalendarDays(today, parseDateKey(item.logicalDate) ?? today);
		const ageWeight = daysAgo <= 30 ? 10 : daysAgo <= 180 ? 40 : daysAgo <= 365 ? 30 : 20;
		return ageWeight * (1 + Math.min(item.memoCount, 8) + Math.min(item.imageCount, 2) + Math.min(item.linkCount, 3));
	});
	let cursor = Math.min(0.999999999, Math.max(0, random())) * weights.reduce((sum, value) => sum + value, 0);
	for (let index = 0; index < items.length; index += 1) {
		cursor -= weights[index] ?? 0;
		if (cursor <= 0) return items[index] as CatalogDailyAggregate;
	}
	return items[items.length - 1] as CatalogDailyAggregate;
}

function parseDateKey(value: string): Date | null {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
	if (match === null) return null;
	const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
	return formatDatePart(date) === value ? date : null;
}

function startOfLocalDay(date: Date): Date {
	return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function differenceInCalendarDays(later: Date, earlier: Date): number {
	return Math.floor((Date.UTC(later.getFullYear(), later.getMonth(), later.getDate())
		- Date.UTC(earlier.getFullYear(), earlier.getMonth(), earlier.getDate())) / 86_400_000);
}

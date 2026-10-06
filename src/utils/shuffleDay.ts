import type { MemoViewItem as MemoRecord } from "../types/memoView";
import type { CatalogDailyAggregate } from "../types/catalog";
import { formatDatePart, parseMemoCalendarDate } from "./date";
import { getMemoContentStats } from "./memoContentStats";
import { normalizeTagKey } from "./tags";

export interface ShuffleDayHistoryEntry {
	date: string;
	shownAt: string;
}

export interface ShuffleDayStats {
	memoCount: number;
	wordCount: number;
	tagCount: number;
	imageCount: number;
	linkCount: number;
	firstMemoTime: string | null;
	lastMemoTime: string | null;
}

export type ShuffleDayDateSelection =
	| { status: "ready"; selectedDate: string }
	| { status: "empty-no-memos" }
	| { status: "empty-not-enough-history" };

export type ShuffleDaySelectionResult =
	| { status: "ready"; selectedDate: string; memos: MemoRecord[]; stats: ShuffleDayStats; historyUnavailable?: boolean }
	| Exclude<ShuffleDayDateSelection, { status: "ready" }>;

export interface ShuffleDaySelectorOptions {
	today?: Date;
	history?: readonly ShuffleDayHistoryEntry[];
	currentDate?: string | null;
	random?: () => number;
	now?: Date;
}

export type ShuffleDayAggregate = Pick<CatalogDailyAggregate, "logicalDate" | "memoCount" | "imageCount" | "linkCount">;

const SHUFFLE_DAY_BUCKETS = [
	{ minDays: 7, maxDays: 30, weight: 10 },
	{ minDays: 31, maxDays: 180, weight: 40 },
	{ minDays: 181, maxDays: 365, weight: 30 },
	{ minDays: 366, maxDays: Number.POSITIVE_INFINITY, weight: 20 },
];
const HISTORY_LIMIT = 100;
const HISTORY_MAX_AGE_DAYS = 180;

// 唯一选择核心：只用轻量聚合，年代概率不随该段日期数量变化。
export function selectShuffleDayDate(
	aggregates: readonly ShuffleDayAggregate[],
	options: ShuffleDaySelectorOptions = {},
): ShuffleDayDateSelection {
	const nonEmpty = aggregates.filter(item => item.memoCount > 0);
	if (nonEmpty.length === 0) return { status: "empty-no-memos" };
	const now = options.now ?? new Date();
	const today = options.today ?? now;
	const eligible = nonEmpty.flatMap(item => {
		const date = parseDateKey(item.logicalDate);
		const daysAgo = date === null ? -1 : differenceInCalendarDays(today, date);
		return daysAgo >= 7 ? [{ ...item, daysAgo }] : [];
	});
	if (eligible.length === 0) return { status: "empty-not-enough-history" };
	const history = normalizeShuffleDayHistory(options.history ?? [], now);
	const recentDates = [...new Set(history.map(entry => entry.date))].slice(0, 5);
	const excluded = new Set(recentDates);
	if (options.currentDate != null) excluded.add(options.currentDate);
	let candidates = eligible.filter(item => !excluded.has(item.logicalDate));
	// 每次只释放最早的一个历史日期，保留当前页直到没有其他合格日期。
	for (const date of [...recentDates].reverse()) {
		if (candidates.length > 0) break;
		if (date === options.currentDate) continue;
		excluded.delete(date);
		candidates = eligible.filter(item => !excluded.has(item.logicalDate));
	}
	if (candidates.length === 0) candidates = eligible;
	const random = options.random ?? Math.random;
	const bucket = weightedPick(SHUFFLE_DAY_BUCKETS.map(bucket => ({
		item: candidates.filter(item => item.daysAgo >= bucket.minDays && item.daysAgo <= bucket.maxDays),
		weight: bucket.weight,
	})).filter(bucket => bucket.item.length > 0), random)!;
	const recentEvents = new Set(history.slice(0, 30).map(entry => entry.date));
	const selected = weightedPick(bucket.map(item => ({
		item, weight: calculateShuffleDayDateWeight(item, recentEvents.has(item.logicalDate)),
	})), random)!;
	return { status: "ready", selectedDate: selected.logicalDate };
}

export function calculateShuffleDayDateWeight(item: ShuffleDayAggregate, recentlyShown: boolean): number {
	const richness = 1 + Math.min(Math.log2(1 + item.memoCount), 3)
		+ 0.25 * Math.min(item.imageCount, 2) + 0.15 * Math.min(item.linkCount, 2);
	return richness * (recentlyShown ? 0.5 : 1);
}

export function normalizeShuffleDayHistory(
	history: readonly ShuffleDayHistoryEntry[],
	now = new Date(),
): ShuffleDayHistoryEntry[] {
	const sorted = history.flatMap(entry => {
		const shownAt = parseMemoCalendarDate(entry.shownAt);
		return parseDateKey(entry.date) !== null && shownAt !== null
			&& differenceInCalendarDays(now, shownAt) <= HISTORY_MAX_AGE_DAYS
			? [{ entry, timestamp: shownAt.getTime() }] : [];
	}).sort((left, right) => right.timestamp - left.timestamp);
	const seen = new Set<string>();
	const entries: ShuffleDayHistoryEntry[] = [];
	for (const { entry } of sorted) {
		const key = `${entry.date}\n${entry.shownAt}`;
		if (seen.has(key)) continue;
		seen.add(key);
		entries.push({ ...entry });
		if (entries.length >= HISTORY_LIMIT) break;
	}
	return entries;
}

export function sortShuffleDayMemos(memos: readonly MemoRecord[]): MemoRecord[] {
	return memos.map((memo, index) => ({ memo, date: parseMemoCalendarDate(memo.createdAt), index }))
		.sort((left, right) => {
			if (left.date !== null && right.date !== null) return left.date.getTime() - right.date.getTime() || left.index - right.index;
			if (left.date !== null) return -1;
			if (right.date !== null) return 1;
			return left.index - right.index;
		}).map(item => item.memo);
}

export function buildShuffleDayStats(memos: readonly MemoRecord[]): ShuffleDayStats {
	const sorted = sortShuffleDayMemos(memos);
	const tags = new Set<string>();
	let wordCount = 0;
	let imageCount = 0;
	let linkCount = 0;
	let firstMemoTime: string | null = null;
	let lastMemoTime: string | null = null;
	for (const memo of sorted) {
		wordCount += getMemoContentStats(memo).wordCount;
		imageCount += memo.images.length;
		linkCount += memo.links.length;
		for (const tag of memo.tags) {
			const key = normalizeTagKey(tag);
			if (key.length > 0) tags.add(key);
		}
		if (parseMemoCalendarDate(memo.createdAt) !== null) {
			// 展示原 Markdown 时间文本，不把分钟精度补成秒数。
			const time = memo.createdAt.match(/[T ](\d{2}:\d{2}(?::\d{2})?)/u)?.[1] ?? null;
			firstMemoTime ??= time;
			lastMemoTime = time;
		}
	}
	return { memoCount: sorted.length, wordCount, tagCount: tags.size, imageCount, linkCount, firstMemoTime, lastMemoTime };
}

export function getMemoLocalDateKey(memo: MemoRecord): string | null {
	const date = parseDateKey(memo.catalog?.observation.logicalDate ?? memo.createdAt.slice(0, 10));
	return date === null ? null : formatDatePart(date);
}

export function weightedPick<T>(items: Array<{ item: T; weight: number }>, random: () => number = Math.random): T | null {
	const validItems = items.filter(entry => Number.isFinite(entry.weight) && entry.weight > 0);
	if (validItems.length === 0) return null;
	let cursor = clampRandom(random()) * validItems.reduce((sum, entry) => sum + entry.weight, 0);
	for (const entry of validItems) {
		cursor -= entry.weight;
		if (cursor < 0) return entry.item;
	}
	return validItems[validItems.length - 1].item;
}

function parseDateKey(value: string): Date | null {
	return /^\d{4}-\d{2}-\d{2}$/u.test(value) ? parseMemoCalendarDate(value) : null;
}

function differenceInCalendarDays(later: Date, earlier: Date): number {
	return (Date.UTC(later.getFullYear(), later.getMonth(), later.getDate())
		- Date.UTC(earlier.getFullYear(), earlier.getMonth(), earlier.getDate())) / 86_400_000;
}

function clampRandom(value: number): number {
	return Number.isFinite(value) ? Math.min(0.999999999, Math.max(0, value)) : 0;
}

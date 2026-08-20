import type { MemoViewItem as MemoRecord } from "../types/memoView";
import { formatDatePart, formatLocalIsoString } from "./date";
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

export type ShuffleDaySelectionResult =
	| {
		status: "ready";
		selectedDate: string;
		memos: MemoRecord[];
		stats: ShuffleDayStats;
		historyEntry: ShuffleDayHistoryEntry;
		nextHistory: ShuffleDayHistoryEntry[];
	}
	| { status: "empty-no-memos" }
	| { status: "empty-not-enough-history" };

export interface ShuffleDaySelectorOptions {
	today?: Date;
	history?: readonly ShuffleDayHistoryEntry[];
	random?: () => number;
	now?: Date;
}

interface ShuffleDayBucket {
	key: string;
	minDays: number;
	maxDays: number;
	weight: number;
}

interface ShuffleDayCandidate {
	date: string;
	daysAgo: number;
	memos: MemoRecord[];
	stats: ShuffleDayStats;
}

const SHUFFLE_DAY_BUCKETS: ShuffleDayBucket[] = [
	{ key: "nearPast", minDays: 7, maxDays: 30, weight: 10 },
	{ key: "middlePast", minDays: 31, maxDays: 180, weight: 40 },
	{ key: "farPast", minDays: 181, maxDays: 365, weight: 30 },
	{ key: "oldPast", minDays: 366, maxDays: Number.POSITIVE_INFINITY, weight: 20 },
];
const HISTORY_LIMIT = 100;
const HISTORY_MAX_AGE_DAYS = 180;

export function selectShuffleDay(
	memos: readonly MemoRecord[],
	options: ShuffleDaySelectorOptions = {},
): ShuffleDaySelectionResult {
	const activeMemos = memos.filter(isActiveMemo);
	if (activeMemos.length === 0) {
		return { status: "empty-no-memos" };
	}

	const today = startOfDay(options.today ?? new Date());
	const candidates = collectShuffleDayCandidates(activeMemos, today);
	if (candidates.length === 0) {
		return { status: "empty-not-enough-history" };
	}

	const history = normalizeShuffleDayHistory(options.history ?? [], options.now ?? new Date());
	const relaxedCandidates = relaxRecentHistoryExclusion(candidates, history);
	const bucket = pickShuffleDayBucket(relaxedCandidates, options.random ?? Math.random);
	if (bucket === null) {
		return { status: "empty-not-enough-history" };
	}
	const selected = pickShuffleDayCandidate(bucket, history, options.random ?? Math.random, options.now ?? today);
	if (selected === null) {
		return { status: "empty-not-enough-history" };
	}

	const shownAt = formatLocalIsoString(options.now ?? new Date());
	const historyEntry = { date: selected.date, shownAt };
	return {
		status: "ready",
		selectedDate: selected.date,
		memos: selected.memos,
		stats: selected.stats,
		historyEntry,
		nextHistory: trimShuffleDayHistory([historyEntry, ...history], options.now ?? new Date()),
	};
}

export function normalizeShuffleDayHistory(
	history: readonly ShuffleDayHistoryEntry[],
	today = new Date(),
): ShuffleDayHistoryEntry[] {
	return trimShuffleDayHistory(history.filter((entry) => {
		return parseDateKey(entry.date) !== null && parseMemoLocalDate(entry.shownAt) !== null;
	}), today);
}

export function sortShuffleDayMemos(memos: readonly MemoRecord[]): MemoRecord[] {
	return memos
		.map((memo, index) => ({ memo, date: parseMemoLocalDate(memo.createdAt), index }))
		.sort((left, right) => {
			if (left.date !== null && right.date !== null) {
				return left.date.getTime() - right.date.getTime() || left.index - right.index;
			}
			if (left.date !== null) return -1;
			if (right.date !== null) return 1;
			return left.index - right.index;
		})
		.map((item) => item.memo);
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
			const tagKey = normalizeTagKey(tag);
			if (tagKey.length > 0) {
				tags.add(tagKey);
			}
		}
		const createdAt = parseMemoLocalDate(memo.createdAt);
		if (createdAt !== null) {
			const timePart = formatMemoTime(createdAt);
			if (firstMemoTime === null) {
				firstMemoTime = timePart;
			}
			lastMemoTime = timePart;
		}
	}
	return {
		memoCount: sorted.length,
		wordCount,
		tagCount: tags.size,
		imageCount,
		linkCount,
		firstMemoTime,
		lastMemoTime,
	};
}

export function getMemoLocalDateKey(memo: MemoRecord): string | null {
	const date = parseMemoLocalDate(memo.createdAt);
	return date === null ? null : formatDatePart(date);
}

export function weightedPick<T>(
	items: Array<{ item: T; weight: number }>,
	random: () => number = Math.random,
): T | null {
	const validItems = items.filter((entry) => Number.isFinite(entry.weight) && entry.weight > 0);
	if (validItems.length === 0) {
		return null;
	}
	const totalWeight = validItems.reduce((sum, entry) => sum + entry.weight, 0);
	let cursor = clampRandom(random()) * totalWeight;
	for (const entry of validItems) {
		cursor -= entry.weight;
		if (cursor <= 0) {
			return entry.item;
		}
	}
	return validItems[validItems.length - 1].item;
}

function collectShuffleDayCandidates(memos: readonly MemoRecord[], today: Date): ShuffleDayCandidate[] {
	const byDate = new Map<string, MemoRecord[]>();
	for (const memo of memos) {
		const dateKey = getMemoLocalDateKey(memo);
		if (dateKey === null) {
			continue;
		}
		const date = parseDateKey(dateKey);
		if (date === null) {
			continue;
		}
		const daysAgo = differenceInCalendarDays(today, date);
		if (daysAgo < 7) {
			continue;
		}
		const group = byDate.get(dateKey) ?? [];
		group.push(memo);
		byDate.set(dateKey, group);
	}
	return [...byDate.entries()].map(([date, dateMemos]) => {
		const sortedMemos = sortShuffleDayMemos(dateMemos);
		return {
			date,
			daysAgo: differenceInCalendarDays(today, parseDateKey(date) ?? today),
			memos: sortedMemos,
			stats: buildShuffleDayStats(sortedMemos),
		};
	});
}

function relaxRecentHistoryExclusion(
	candidates: ShuffleDayCandidate[],
	history: readonly ShuffleDayHistoryEntry[],
): ShuffleDayCandidate[] {
	const recentDates = new Set(history.slice(0, 5).map((entry) => entry.date));
	const filtered = candidates.filter((candidate) => !recentDates.has(candidate.date));
	return filtered.length > 0 ? filtered : candidates;
}

function pickShuffleDayBucket(
	candidates: ShuffleDayCandidate[],
	random: () => number,
): ShuffleDayCandidate[] | null {
	const bucketItems = SHUFFLE_DAY_BUCKETS
		.map((bucket) => ({
			item: candidates.filter((candidate) => candidate.daysAgo >= bucket.minDays && candidate.daysAgo <= bucket.maxDays),
			weight: bucket.weight,
		}))
		.filter((entry) => entry.item.length > 0)
		.map(({ item, weight }) => ({ item, weight }));
	return weightedPick(bucketItems, random);
}

function pickShuffleDayCandidate(
	candidates: ShuffleDayCandidate[],
	history: readonly ShuffleDayHistoryEntry[],
	random: () => number,
	today: Date,
): ShuffleDayCandidate | null {
	return weightedPick(candidates.map((candidate) => ({
		item: candidate,
		weight: calculateShuffleDayScore(candidate, history, today),
	})), random);
}

function calculateShuffleDayScore(
	candidate: ShuffleDayCandidate,
	history: readonly ShuffleDayHistoryEntry[],
	today: Date,
): number {
	const memoCount = candidate.stats.memoCount;
	const densityScore = Math.min(Math.log2(memoCount + 1), 4);
	const spanScore = getSpanScore(candidate.memos);
	const richnessScore =
		Math.min(candidate.stats.imageCount, 2) * 0.5 +
		Math.min(candidate.stats.linkCount, 3) * 0.3 +
		Math.min(candidate.stats.tagCount, 5) * 0.2;
	let score = 1 + densityScore + spanScore + richnessScore + getNoveltyScore(candidate.date, history, today);
	const historyIndex = history.findIndex((entry) => entry.date === candidate.date);
	if (historyIndex >= 0 && historyIndex < 30) {
		score *= 0.25;
	}
	if (historyIndex >= 0 && historyIndex < 7) {
		score *= 0.2;
	}
	if (hasRecentMonthOverexposure(candidate.date, history)) {
		score *= 0.7;
	}
	return Math.max(0.01, score);
}

function getSpanScore(memos: readonly MemoRecord[]): number {
	const times = memos
		.map((memo) => parseMemoLocalDate(memo.createdAt)?.getTime() ?? null)
		.filter((time): time is number => time !== null)
		.sort((left, right) => left - right);
	if (times.length < 2) {
		return 0;
	}
	const spanHours = (times[times.length - 1] - times[0]) / 3_600_000;
	if (spanHours >= 8) return 1.5;
	if (spanHours >= 3) return 1;
	if (spanHours >= 1) return 0.5;
	return 0;
}

function getNoveltyScore(date: string, history: readonly ShuffleDayHistoryEntry[], today: Date): number {
	const entry = history.find((item) => item.date === date);
	if (entry === undefined) {
		return 1.2;
	}
	const shownAt = parseMemoLocalDate(entry.shownAt);
	if (shownAt === null) {
		return 0;
	}
	return differenceInCalendarDays(startOfDay(today), startOfDay(shownAt)) >= 30 ? 0.8 : 0;
}

function hasRecentMonthOverexposure(date: string, history: readonly ShuffleDayHistoryEntry[]): boolean {
	const month = date.slice(0, 7);
	const recentMonthCount = history.slice(0, 30).filter((entry) => entry.date.startsWith(`${month}-`)).length;
	return recentMonthCount >= 3;
}

function trimShuffleDayHistory(
	history: readonly ShuffleDayHistoryEntry[],
	today: Date,
): ShuffleDayHistoryEntry[] {
	const todayStart = startOfDay(today);
	const seen = new Set<string>();
	const entries: ShuffleDayHistoryEntry[] = [];
	for (const entry of history) {
		const shownAt = parseMemoLocalDate(entry.shownAt);
		if (shownAt === null || differenceInCalendarDays(todayStart, startOfDay(shownAt)) > HISTORY_MAX_AGE_DAYS) {
			continue;
		}
		const key = `${entry.date}\n${entry.shownAt}`;
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		entries.push(entry);
		if (entries.length >= HISTORY_LIMIT) {
			break;
		}
	}
	return entries;
}

function isActiveMemo(memo: MemoRecord): boolean {
	return memo.status === "active" && memo.deletedAt === undefined;
}

function parseMemoLocalDate(value: string): Date | null {
	const match = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/);
	if (match === null) {
		return null;
	}
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const hours = match[4] === undefined ? 0 : Number(match[4]);
	const minutes = match[5] === undefined ? 0 : Number(match[5]);
	const seconds = match[6] === undefined ? 0 : Number(match[6]);
	const date = new Date(year, month - 1, day, hours, minutes, seconds, 0);
	if (
		date.getFullYear() !== year ||
		date.getMonth() !== month - 1 ||
		date.getDate() !== day ||
		date.getHours() !== hours ||
		date.getMinutes() !== minutes ||
		date.getSeconds() !== seconds
	) {
		return null;
	}
	return date;
}

function parseDateKey(value: string): Date | null {
	const date = parseMemoLocalDate(value);
	return date === null ? null : startOfDay(date);
}

function startOfDay(date: Date): Date {
	return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function differenceInCalendarDays(later: Date, earlier: Date): number {
	const laterUtc = Date.UTC(later.getFullYear(), later.getMonth(), later.getDate());
	const earlierUtc = Date.UTC(earlier.getFullYear(), earlier.getMonth(), earlier.getDate());
	return Math.floor((laterUtc - earlierUtc) / 86_400_000);
}

function formatMemoTime(date: Date): string {
	return [
		String(date.getHours()).padStart(2, "0"),
		String(date.getMinutes()).padStart(2, "0"),
	].join(":");
}

function clampRandom(value: number): number {
	if (!Number.isFinite(value)) {
		return 0;
	}
	return Math.min(0.999999999, Math.max(0, value));
}

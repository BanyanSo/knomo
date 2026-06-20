import type { MemoRecord } from "../types/memo";
import { getMemoContentStats } from "../utils/memoContentStats";
import { hasMemoReference } from "../utils/references";

export type RecordStatsView = "week" | "month" | "year";
export type RecordStatsLoadState = "idle" | "loading" | "ready" | "empty" | "error";

export interface RecordStatsOverview {
	memoCount: number;
	wordCount: number;
	recordDayCount: number;
}

export interface RecordStatsRange {
	memoCount: number;
	wordCount: number;
	recordDayCount: number;
	referenceMemoCount: number;
	maxDailyMemoCount: number;
	maxDailyWordCount: number;
	maxDailyMemoDates: string[];
	maxDailyWordDates: string[];
}

export interface RecordStatsTrendPoint {
	key: string;
	label: string;
	count: number;
}

export interface RecordStatsHourPoint {
	hour: number;
	count: number;
}

export interface SelectedRecordStats {
	startDate: string;
	endDateExclusive: string;
	overview: RecordStatsOverview;
	range: RecordStatsRange;
	trend: RecordStatsTrendPoint[];
	activeHours: RecordStatsHourPoint[];
	earliestMemo: MemoRecord | null;
	latestMemo: MemoRecord | null;
}

export interface RecordStatsSnapshot {
	state: RecordStatsLoadState;
	error: string | null;
}

interface DailyRecordStats {
	memoCount: number;
	wordCount: number;
	referenceMemoCount: number;
	hourCounts: number[];
	earliestMemo: MemoRecord;
	earliestTimestamp: number;
	latestMemo: MemoRecord;
	latestTimestamp: number;
}

interface PreparedRecordStats {
	overview: RecordStatsOverview;
	daily: Map<string, DailyRecordStats>;
	earliestYear: number | null;
}

interface LocalMemoTimestamp {
	year: number;
	month: number;
	day: number;
	hour: number;
	timestamp: number;
}

const PREPARE_BATCH_SIZE = 250;

export class RecordStatsService {
	private state: RecordStatsLoadState = "idle";
	private error: string | null = null;
	private source: readonly MemoRecord[] | null = null;
	private prepared: PreparedRecordStats | null = null;
	private runId = 0;

	getSnapshot(): RecordStatsSnapshot {
		return {
			state: this.state,
			error: this.error,
		};
	}

	getEarliestYear(): number | null {
		return this.prepared?.earliestYear ?? null;
	}

	isPreparedFor(memos: readonly MemoRecord[]): boolean {
		return this.source === memos && (this.state === "ready" || this.state === "empty");
	}

	invalidate(): void {
		this.runId += 1;
		this.state = "idle";
		this.error = null;
		this.source = null;
		this.prepared = null;
	}

	fail(message: string): void {
		this.runId += 1;
		this.state = "error";
		this.error = message;
		this.source = null;
		this.prepared = null;
	}

	async prepare(memos: readonly MemoRecord[], yieldToUi: () => Promise<void>): Promise<boolean> {
		if (this.isPreparedFor(memos)) {
			return true;
		}
		const runId = this.runId + 1;
		this.runId = runId;
		this.state = "loading";
		this.error = null;
		this.source = memos;
		this.prepared = null;

		try {
			const prepared = await prepareRecordStats(memos, yieldToUi, () => this.runId === runId);
			if (prepared === null || this.runId !== runId) {
				return false;
			}
			this.prepared = prepared;
			this.state = prepared.overview.memoCount === 0 ? "empty" : "ready";
			return true;
		} catch (error) {
			if (this.runId !== runId) {
				return false;
			}
			this.prepared = null;
			this.state = "error";
			this.error = error instanceof Error ? error.message : "Unable to prepare record statistics.";
			return false;
		}
	}

	select(view: RecordStatsView, selectedDate: Date): SelectedRecordStats | null {
		if (this.prepared === null || (this.state !== "ready" && this.state !== "empty")) {
			return null;
		}
		return selectRecordStats(this.prepared, view, selectedDate);
	}
}

async function prepareRecordStats(
	memos: readonly MemoRecord[],
	yieldToUi: () => Promise<void>,
	isCurrent: () => boolean,
): Promise<PreparedRecordStats | null> {
	const daily = new Map<string, DailyRecordStats>();
	let memoCount = 0;
	let wordCount = 0;
	let earliestYear: number | null = null;

	for (let index = 0; index < memos.length; index += 1) {
		if (index > 0 && index % PREPARE_BATCH_SIZE === 0) {
			await yieldToUi();
			if (!isCurrent()) {
				return null;
			}
		}
		const memo = memos[index];
		if (memo.status !== "active") {
			continue;
		}
		const localTimestamp = parseLocalMemoTimestamp(memo.createdAt);
		if (localTimestamp === null) {
			throw new Error(`Invalid memo createdAt: ${memo.id}`);
		}
		const memoWordCount = getMemoContentStats(memo).wordCount;
		earliestYear = earliestYear === null ? localTimestamp.year : Math.min(earliestYear, localTimestamp.year);
		const dayKey = formatDateKey(localTimestamp.year, localTimestamp.month, localTimestamp.day);
		const current = daily.get(dayKey);
		if (current === undefined) {
			const hourCounts = Array.from({ length: 24 }, () => 0);
			hourCounts[localTimestamp.hour] = 1;
			daily.set(dayKey, {
				memoCount: 1,
				wordCount: memoWordCount,
				referenceMemoCount: hasMemoReference(memo) ? 1 : 0,
				hourCounts,
				earliestMemo: memo,
				earliestTimestamp: localTimestamp.timestamp,
				latestMemo: memo,
				latestTimestamp: localTimestamp.timestamp,
			});
		} else {
			current.memoCount += 1;
			current.wordCount += memoWordCount;
			current.referenceMemoCount += hasMemoReference(memo) ? 1 : 0;
			current.hourCounts[localTimestamp.hour] += 1;
			if (compareMemoTime(memo, localTimestamp.timestamp, current.earliestMemo, current.earliestTimestamp) < 0) {
				current.earliestMemo = memo;
				current.earliestTimestamp = localTimestamp.timestamp;
			}
			if (compareMemoTime(memo, localTimestamp.timestamp, current.latestMemo, current.latestTimestamp) > 0) {
				current.latestMemo = memo;
				current.latestTimestamp = localTimestamp.timestamp;
			}
		}
		memoCount += 1;
		wordCount += memoWordCount;
	}

	return {
		overview: {
			memoCount,
			wordCount,
			recordDayCount: daily.size,
		},
		daily,
		earliestYear,
	};
}

function selectRecordStats(prepared: PreparedRecordStats, view: RecordStatsView, selectedDate: Date): SelectedRecordStats {
	const range = getRecordStatsRange(view, selectedDate);
	const dayKeys = listDateKeys(range.start, range.endExclusive);
	const hourCounts = Array.from({ length: 24 }, () => 0);
	let memoCount = 0;
	let wordCount = 0;
	let recordDayCount = 0;
	let referenceMemoCount = 0;
	let maxDailyMemoCount = 0;
	let maxDailyWordCount = 0;
	let maxDailyMemoDates: string[] = [];
	let maxDailyWordDates: string[] = [];
	let earliestMemo: MemoRecord | null = null;
	let earliestTimestamp = Number.POSITIVE_INFINITY;
	let latestMemo: MemoRecord | null = null;
	let latestTimestamp = Number.NEGATIVE_INFINITY;

	for (const dayKey of dayKeys) {
		const day = prepared.daily.get(dayKey);
		if (day === undefined) {
			continue;
		}
		memoCount += day.memoCount;
		wordCount += day.wordCount;
		recordDayCount += 1;
		referenceMemoCount += day.referenceMemoCount;
		for (let hour = 0; hour < hourCounts.length; hour += 1) {
			hourCounts[hour] += day.hourCounts[hour];
		}
		if (day.memoCount > maxDailyMemoCount) {
			maxDailyMemoCount = day.memoCount;
			maxDailyMemoDates = [dayKey];
		} else if (day.memoCount === maxDailyMemoCount) {
			maxDailyMemoDates.push(dayKey);
		}
		if (maxDailyWordDates.length === 0 || day.wordCount > maxDailyWordCount) {
			maxDailyWordCount = day.wordCount;
			maxDailyWordDates = [dayKey];
		} else if (day.wordCount === maxDailyWordCount) {
			maxDailyWordDates.push(dayKey);
		}
		const dayEarliestTimestamp = parseMemoInstant(day.earliestMemo.createdAt);
		if (
			earliestMemo === null ||
			compareMemoTime(day.earliestMemo, dayEarliestTimestamp, earliestMemo, earliestTimestamp) < 0
		) {
			earliestMemo = day.earliestMemo;
			earliestTimestamp = dayEarliestTimestamp;
		}
		const dayLatestTimestamp = parseMemoInstant(day.latestMemo.createdAt);
		if (
			latestMemo === null ||
			compareMemoTime(day.latestMemo, dayLatestTimestamp, latestMemo, latestTimestamp) > 0
		) {
			latestMemo = day.latestMemo;
			latestTimestamp = dayLatestTimestamp;
		}
	}

	return {
		startDate: formatDateKeyFromDate(range.start),
		endDateExclusive: formatDateKeyFromDate(range.endExclusive),
		overview: prepared.overview,
		range: {
			memoCount,
			wordCount,
			recordDayCount,
			referenceMemoCount,
			maxDailyMemoCount,
			maxDailyWordCount,
			maxDailyMemoDates,
			maxDailyWordDates,
		},
		trend: buildTrend(view, range.start, dayKeys, prepared.daily),
		activeHours: hourCounts.map((count, hour) => ({ hour, count })),
		earliestMemo,
		latestMemo,
	};
}

export function getRecordStatsRange(view: RecordStatsView, selectedDate: Date): { start: Date; endExclusive: Date } {
	const year = selectedDate.getFullYear();
	const month = selectedDate.getMonth();
	const day = selectedDate.getDate();
	if (view === "week") {
		const selectedDay = new Date(year, month, day);
		const mondayOffset = (selectedDay.getDay() + 6) % 7;
		return {
			start: new Date(year, month, day - mondayOffset),
			endExclusive: new Date(year, month, day - mondayOffset + 7),
		};
	}
	if (view === "month") {
		return {
			start: new Date(year, month, 1),
			endExclusive: new Date(year, month + 1, 1),
		};
	}
	return {
		start: new Date(year, 0, 1),
		endExclusive: new Date(year + 1, 0, 1),
	};
}

export function shiftRecordStatsDate(view: RecordStatsView, selectedDate: Date, amount: -1 | 1): Date {
	if (view === "week") {
		return new Date(selectedDate.getFullYear(), selectedDate.getMonth(), selectedDate.getDate() + amount * 7);
	}
	if (view === "month") {
		return new Date(selectedDate.getFullYear(), selectedDate.getMonth() + amount, 1);
	}
	return new Date(selectedDate.getFullYear() + amount, 0, 1);
}

export function canAdvanceRecordStatsDate(view: RecordStatsView, selectedDate: Date, today = new Date()): boolean {
	const selectedRange = getRecordStatsRange(view, selectedDate);
	const currentRange = getRecordStatsRange(view, today);
	return selectedRange.start.getTime() < currentRange.start.getTime();
}

export function canRetreatRecordStatsDate(
	view: RecordStatsView,
	selectedDate: Date,
	earliestYear: number | null,
): boolean {
	if (earliestYear === null) {
		return false;
	}
	const previousDate = shiftRecordStatsDate(view, selectedDate, -1);
	const previousRange = getRecordStatsRange(view, previousDate);
	return previousRange.endExclusive.getTime() > new Date(earliestYear, 0, 1).getTime();
}

function buildTrend(
	view: RecordStatsView,
	start: Date,
	dayKeys: string[],
	daily: ReadonlyMap<string, DailyRecordStats>,
): RecordStatsTrendPoint[] {
	if (view === "week") {
		return dayKeys.map((key, index) => ({
			key,
			label: String(index + 1),
			count: daily.get(key)?.memoCount ?? 0,
		}));
	}
	if (view === "month") {
		return dayKeys.map((key, index) => ({
			key,
			label: String(index + 1),
			count: daily.get(key)?.memoCount ?? 0,
		}));
	}
	const counts = Array.from({ length: 12 }, () => 0);
	for (const key of dayKeys) {
		const parts = parseDateKey(key);
		if (parts !== null) {
			counts[parts.month - 1] += daily.get(key)?.memoCount ?? 0;
		}
	}
	return counts.map((count, index) => ({
		key: `${start.getFullYear()}-${String(index + 1).padStart(2, "0")}`,
		label: String(index + 1),
		count,
	}));
}

function listDateKeys(start: Date, endExclusive: Date): string[] {
	const keys: string[] = [];
	let cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate());
	while (cursor < endExclusive) {
		keys.push(formatDateKeyFromDate(cursor));
		cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1);
	}
	return keys;
}

function parseLocalMemoTimestamp(value: string): LocalMemoTimestamp | null {
	const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?$/);
	if (match === null) {
		return null;
	}
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const hour = Number(match[4]);
	const minute = Number(match[5]);
	const second = match[6] === undefined ? 0 : Number(match[6]);
	const maxDay = getDaysInMonth(year, month);
	const timestamp = parseMemoInstant(value);
	if (
		month < 1 || month > 12 ||
		day < 1 || day > maxDay ||
		hour < 0 || hour > 23 ||
		minute < 0 || minute > 59 ||
		second < 0 || second > 59 ||
		!Number.isFinite(timestamp)
	) {
		return null;
	}
	return { year, month, day, hour, timestamp };
}

function parseMemoInstant(value: string): number {
	return Date.parse(value);
}

function getDaysInMonth(year: number, month: number): number {
	if (month === 2) {
		return isLeapYear(year) ? 29 : 28;
	}
	return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

function isLeapYear(year: number): boolean {
	return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function compareMemoTime(left: MemoRecord, leftTimestamp: number, right: MemoRecord, rightTimestamp: number): number {
	return leftTimestamp - rightTimestamp || left.id.localeCompare(right.id);
}

function formatDateKey(year: number, month: number, day: number): string {
	return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function formatDateKeyFromDate(date: Date): string {
	return formatDateKey(date.getFullYear(), date.getMonth() + 1, date.getDate());
}

function parseDateKey(value: string): { year: number; month: number; day: number } | null {
	const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
	if (match === null) {
		return null;
	}
	return {
		year: Number(match[1]),
		month: Number(match[2]),
		day: Number(match[3]),
	};
}

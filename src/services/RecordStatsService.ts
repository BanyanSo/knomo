import type { MemoRecord } from "../types/memo";
import { isSupportedMemoImage } from "../utils/markdown";
import { getMemoContentStats } from "../utils/memoContentStats";
import { hasMemoReference } from "../utils/references";
import { buildTagDisplayMap, normalizeTagDisplay, normalizeTagKey } from "../utils/tags";
import type { TagDisplaySource } from "../utils/tags";

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
	taggedMemoCount: number;
	untaggedMemoCount: number;
	imageMemoCount: number;
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

export interface RecordStatsTagPoint {
	key: string;
	label: string;
	count: number;
}

export interface SelectedRecordStats {
	startDate: string;
	endDateExclusive: string;
	overview: RecordStatsOverview;
	range: RecordStatsRange;
	trend: RecordStatsTrendPoint[];
	activeHours: RecordStatsHourPoint[];
	commonTags: RecordStatsTagPoint[];
}

export interface RecordStatsSnapshot {
	state: RecordStatsLoadState;
	error: string | null;
}

export interface DailyRecordStats {
	memoCount: number;
	wordCount: number;
	referenceMemoCount: number;
	taggedMemoCount: number;
	untaggedMemoCount: number;
	imageMemoCount: number;
	hourCounts: number[];
	tagMemoCounts: Map<string, number>;
}

export interface PreparedRecordStats {
	overview: RecordStatsOverview;
	daily: Map<string, DailyRecordStats>;
	earliestYear: number | null;
	tagDisplayNames: Map<string, string>;
}

interface LocalMemoTimestamp {
	year: number;
	month: number;
	day: number;
	hour: number;
}

const PREPARE_BATCH_SIZE = 250;

export class RecordStatsService {
	private state: RecordStatsLoadState = "idle";
	private error: string | null = null;
	private source: unknown = null;
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
		return this.isPreparedForSource(memos);
	}

	isPreparedForSource(source: unknown): boolean {
		return this.source === source && (this.state === "ready" || this.state === "empty");
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
		return this.prepareFromSource(memos, (isCurrent) => prepareRecordStats(memos, yieldToUi, isCurrent));
	}

	async prepareFromSource(
		source: unknown,
		loadPrepared: (isCurrent: () => boolean) => Promise<PreparedRecordStats | null>,
	): Promise<boolean> {
		if (this.isPreparedForSource(source)) {
			return true;
		}
		const runId = this.runId + 1;
		this.runId = runId;
		this.state = "loading";
		this.error = null;
		this.source = source;
		this.prepared = null;

		try {
			const prepared = await loadPrepared(() => this.runId === runId);
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

export class RecordStatsBuilder {
	private readonly daily = new Map<string, DailyRecordStats>();
	private readonly tagDisplaySources: TagDisplaySource[] = [];
	private memoCount = 0;
	private wordCount = 0;
	private earliestYear: number | null = null;
	private tagDisplayOrder = 0;

	addMemos(memos: readonly MemoRecord[]): void {
		for (const memo of memos) {
			this.addMemo(memo);
		}
	}

	addMemo(memo: MemoRecord): void {
		if (memo.status !== "active") {
			return;
		}
		const localTimestamp = parseLocalMemoTimestamp(memo.createdAt);
		if (localTimestamp === null) {
			throw new Error(`Invalid memo createdAt: ${memo.id}`);
		}
		const memoWordCount = getMemoContentStats(memo).wordCount;
		const isTagged = memo.tags.length > 0;
		const hasImage = memo.images.some(isSupportedMemoImage);
		const memoTagDisplays = new Map<string, string>();
		for (const tag of memo.tags) {
			const key = normalizeTagKey(tag);
			const label = normalizeTagDisplay(tag);
			if (key.length > 0 && label.length > 0 && !memoTagDisplays.has(key)) {
				memoTagDisplays.set(key, label);
			}
		}
		const updatedTimestamp = Date.parse(memo.updatedAt);
		const tagModifiedTime = Number.isFinite(updatedTimestamp) ? updatedTimestamp : Date.parse(memo.createdAt);
		for (const label of memoTagDisplays.values()) {
			this.tagDisplaySources.push({ tag: label, modifiedTime: tagModifiedTime, order: this.tagDisplayOrder });
			this.tagDisplayOrder += 1;
		}
		this.earliestYear = this.earliestYear === null
			? localTimestamp.year
			: Math.min(this.earliestYear, localTimestamp.year);
		const dayKey = formatDateKey(localTimestamp.year, localTimestamp.month, localTimestamp.day);
		let current = this.daily.get(dayKey);
		if (current === undefined) {
			const hourCounts = Array.from({ length: 24 }, () => 0);
			hourCounts[localTimestamp.hour] = 1;
			current = {
				memoCount: 1,
				wordCount: memoWordCount,
				referenceMemoCount: hasMemoReference(memo) ? 1 : 0,
				taggedMemoCount: isTagged ? 1 : 0,
				untaggedMemoCount: isTagged ? 0 : 1,
				imageMemoCount: hasImage ? 1 : 0,
				hourCounts,
				tagMemoCounts: new Map<string, number>(),
			};
			this.daily.set(dayKey, current);
		} else {
			current.memoCount += 1;
			current.wordCount += memoWordCount;
			current.referenceMemoCount += hasMemoReference(memo) ? 1 : 0;
			current.taggedMemoCount += isTagged ? 1 : 0;
			current.untaggedMemoCount += isTagged ? 0 : 1;
			current.imageMemoCount += hasImage ? 1 : 0;
			current.hourCounts[localTimestamp.hour] += 1;
		}
		for (const key of memoTagDisplays.keys()) {
			current.tagMemoCounts.set(key, (current.tagMemoCounts.get(key) ?? 0) + 1);
		}
		this.memoCount += 1;
		this.wordCount += memoWordCount;
	}

	build(): PreparedRecordStats {
		return {
			overview: {
				memoCount: this.memoCount,
				wordCount: this.wordCount,
				recordDayCount: this.daily.size,
			},
			daily: this.daily,
			earliestYear: this.earliestYear,
			tagDisplayNames: buildTagDisplayMap(this.tagDisplaySources),
		};
	}
}

async function prepareRecordStats(
	memos: readonly MemoRecord[],
	yieldToUi: () => Promise<void>,
	isCurrent: () => boolean,
): Promise<PreparedRecordStats | null> {
	const builder = new RecordStatsBuilder();

	for (let index = 0; index < memos.length; index += 1) {
		if (index > 0 && index % PREPARE_BATCH_SIZE === 0) {
			await yieldToUi();
			if (!isCurrent()) {
				return null;
			}
		}
		builder.addMemo(memos[index]);
	}

	return builder.build();
}

function selectRecordStats(prepared: PreparedRecordStats, view: RecordStatsView, selectedDate: Date): SelectedRecordStats {
	const range = getRecordStatsRange(view, selectedDate);
	const dayKeys = listDateKeys(range.start, range.endExclusive);
	const hourCounts = Array.from({ length: 24 }, () => 0);
	let memoCount = 0;
	let wordCount = 0;
	let recordDayCount = 0;
	let referenceMemoCount = 0;
	let taggedMemoCount = 0;
	let untaggedMemoCount = 0;
	let imageMemoCount = 0;
	let maxDailyMemoCount = 0;
	let maxDailyWordCount = 0;
	let maxDailyMemoDates: string[] = [];
	let maxDailyWordDates: string[] = [];
	const tagMemoCounts = new Map<string, number>();

	for (const dayKey of dayKeys) {
		const day = prepared.daily.get(dayKey);
		if (day === undefined) {
			continue;
		}
		memoCount += day.memoCount;
		wordCount += day.wordCount;
		recordDayCount += 1;
		referenceMemoCount += day.referenceMemoCount;
		taggedMemoCount += day.taggedMemoCount;
		untaggedMemoCount += day.untaggedMemoCount;
		imageMemoCount += day.imageMemoCount;
		for (let hour = 0; hour < hourCounts.length; hour += 1) {
			hourCounts[hour] += day.hourCounts[hour];
		}
		for (const [key, count] of day.tagMemoCounts) {
			tagMemoCounts.set(key, (tagMemoCounts.get(key) ?? 0) + count);
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
			taggedMemoCount,
			untaggedMemoCount,
			imageMemoCount,
			maxDailyMemoCount,
			maxDailyWordCount,
			maxDailyMemoDates,
			maxDailyWordDates,
		},
		trend: buildTrend(view, range.start, dayKeys, prepared.daily),
		activeHours: hourCounts.map((count, hour) => ({ hour, count })),
		commonTags: buildCommonTags(tagMemoCounts, prepared.tagDisplayNames),
	};
}

function buildCommonTags(
	tagMemoCounts: ReadonlyMap<string, number>,
	tagDisplayNames: ReadonlyMap<string, string>,
): RecordStatsTagPoint[] {
	return [...tagMemoCounts.entries()]
		.map(([key, count]) => ({ key, label: tagDisplayNames.get(key) ?? key, count }))
		.sort((left, right) => right.count - left.count || left.key.localeCompare(right.key))
		.slice(0, 5);
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
	return { year, month, day, hour };
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

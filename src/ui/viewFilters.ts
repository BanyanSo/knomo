import { getAllTags } from "obsidian";
import type { App } from "obsidian";

import { t } from "../i18n";
import type { MemoRecord } from "../types/memo";
import { parseDailyNoteDateFromPath } from "../utils/dailyNotes";
import { isSupportedMemoImage, parseMemoLinks } from "../utils/markdown";
import { getMemoContentStats } from "../utils/memoContentStats";
import { hasMemoReference, withMemoIdAlias } from "../utils/references";
import type { TagSummary } from "../utils/tagTree";
import { buildTagDisplayMap, normalizeTagDisplay, normalizeTagKey } from "../utils/tags";
import type { TagDisplaySource } from "../utils/tags";

export type ScopeFilter =
	| "all"
	| "week"
	| "month"
	| "last-month"
	| "last-7"
	| "last-30"
	| "anniversary"
	| "no-tag"
	| "with-link"
	| "with-image";

export type SearchDateFilter = "week" | "month" | "last-7" | "last-30" | "last-week" | "last-month";
export type SummaryScopeFilter = "no-tag" | "with-link" | "with-image" | "anniversary";

export type RecordStatsSearchFilter =
	| { type: "day"; date: string }
	| { type: "month"; month: string }
	| { type: "range"; startDate: string; endDateExclusive: string }
	| { type: "with-tag"; startDate: string; endDateExclusive: string }
	| { type: "no-tag"; startDate: string; endDateExclusive: string }
	| { type: "with-image"; startDate: string; endDateExclusive: string }
	| { type: "tag"; startDate: string; endDateExclusive: string; tagKey: string; tagLabel: string }
	| { type: "references"; startDate: string; endDateExclusive: string }
	| { type: "max-daily-notes"; dates: string[] }
	| { type: "max-daily-words"; dates: string[] }
	| { type: "hour"; startDate: string; endDateExclusive: string; hour: number };

export type RegularFilterCondition =
	| { type: "tag"; text: string }
	| { type: "search"; text: string; query: string }
	| { type: "date"; text: string; filter: SearchDateFilter }
	| { type: "record-stats"; text: string }
	| { type: "scope"; text: string; filter: SummaryScopeFilter };

export interface DailyDateConfig {
	enabled: boolean;
	folder: string | null;
	format: string | null;
}

export interface MemoStats {
	memoCount: number;
	tagCount: number;
	imageCount: number;
	wordCount: number;
}

export function getMemoStats(memos: MemoRecord[]): MemoStats {
	return {
		memoCount: memos.length,
		tagCount: new Set(memos.flatMap((memo) => {
			return memo.tags.map(normalizeTagKey).filter((tagKey) => tagKey.length > 0);
		})).size,
		imageCount: memos.reduce((count, memo) => count + getMemoImages(memo).length, 0),
		wordCount: memos.reduce((count, memo) => count + getMemoContentStats(memo).wordCount, 0),
	};
}

export function collectTags(memos: MemoRecord[], displayTags: Map<string, string>): TagSummary[] {
	const counts = new Map<string, number>();
	const fallbackNames = new Map<string, string>();
	for (const memo of memos) {
		for (const tag of memo.tags) {
			const key = normalizeTagKey(tag);
			if (key.length === 0) {
				continue;
			}
			counts.set(key, (counts.get(key) ?? 0) + 1);
			if (!fallbackNames.has(key)) {
				fallbackNames.set(key, normalizeTagDisplay(tag));
			}
		}
	}
	return [...counts.entries()]
		.map(([key, count]) => ({
			key,
			name: getTagDisplayName(key, fallbackNames.get(key) ?? key, displayTags),
			count,
		}))
		.sort((left, right) => {
			return right.count - left.count || left.name.localeCompare(right.name, "zh");
		});
}

export function collectVaultTagDisplayMap(app: App): Map<string, string> {
	const sources: TagDisplaySource[] = [];
	let order = 0;
	for (const file of app.vault.getMarkdownFiles()) {
		const cache = app.metadataCache.getFileCache(file);
		if (cache === null) {
			continue;
		}
		for (const tag of getAllTags(cache) ?? []) {
			sources.push({
				tag,
				modifiedTime: file.stat.mtime,
				order,
			});
			order += 1;
		}
	}
	return buildTagDisplayMap(sources);
}

export function tagMatchesActiveTagKey(tag: string, activeTagKey: string): boolean {
	const tagKey = normalizeTagKey(tag);
	return tagKey === activeTagKey || tagKey.startsWith(`${activeTagKey}/`);
}

export function getMemoImages(memo: MemoRecord): MemoRecord["images"] {
	return memo.images.filter(isSupportedMemoImage);
}

export function getSourceReferenceText(memo: MemoRecord): string | null {
	const sourceMemoId = memo.sourceMemoId ?? memo.references[0]?.memoId ?? null;
	const referenceText = memo.references[0]?.referenceText ?? null;
	if (sourceMemoId === null || referenceText === null) {
		return null;
	}
	return withMemoIdAlias(referenceText, sourceMemoId);
}

export function formatRegularFilterSummary(conditions: RegularFilterCondition[], count: number): string {
	if (conditions.length === 1) {
		const condition = conditions[0];
		if (condition.type === "tag") {
			return t("filterSummary.tag", { tag: condition.text, count });
		}
		if (condition.type === "search") {
			return t("filterSummary.search", { query: condition.query, count });
		}
		if (condition.type === "record-stats") {
			return t("filterSummary.recordStats", { label: condition.text, count });
		}
		return t("filterSummary.label", { label: condition.text, count });
	}
	const conditionText = conditions.map((condition) => condition.text).join(t("filterSummary.separator"));
	const key = conditions.some((condition) => condition.type === "search")
		? "filterSummary.comboSearch"
		: "filterSummary.combo";
	return t(key, { conditions: conditionText, count });
}

export function formatRegularFilterEmptyTitle(conditions: RegularFilterCondition[], summary: string): string {
	if (conditions.length > 1) {
		return summary;
	}
	const condition = conditions[0];
	if (condition.type === "tag") {
		return t("filterEmpty.tag", { tag: condition.text });
	}
	if (condition.type === "search") {
		return t("filterEmpty.search", { query: condition.query });
	}
	if (condition.type === "date") {
		return getSearchDateEmptyTitle(condition.filter);
	}
	if (condition.type === "record-stats") {
		return t("recordStats.filter.empty", { label: condition.text });
	}
	return getScopeEmptyTitle(condition.filter);
}

export function formatMobileSearchSummary(
	query: string,
	dateFilter: SearchDateFilter | null,
	count: number,
	recordStatsFilter: RecordStatsSearchFilter | null = null,
): string | null {
	const hasQuery = query.length > 0;
	if (!hasQuery && dateFilter === null && recordStatsFilter === null) {
		return null;
	}
	const conditions = [
		hasQuery ? t("mobileSearchSummary.searchCondition", { query }) : null,
		dateFilter === null ? null : getSearchDateLabel(dateFilter),
		recordStatsFilter === null ? null : getRecordStatsSearchFilterLabel(recordStatsFilter),
	].filter((condition): condition is string => condition !== null);
	if (conditions.length > 1) {
		return t("mobileSearchSummary.combo", {
			conditions: conditions.join(t("mobileSearchSummary.separator")),
			count,
		});
	}
	if (hasQuery) {
		return t("mobileSearchSummary.search", { query, count });
	}
	if (dateFilter !== null) {
		return t("mobileSearchSummary.date", { label: getSearchDateLabel(dateFilter), count });
	}
	return recordStatsFilter === null ? null : t("mobileSearchSummary.recordStats", {
		label: getRecordStatsSearchFilterLabel(recordStatsFilter),
		count,
	});
}

export function formatMobileSearchEmptyTitle(
	query: string,
	dateFilter: SearchDateFilter | null,
	recordStatsFilter: RecordStatsSearchFilter | null = null,
): string {
	const hasQuery = query.length > 0;
	const conditions = [
		hasQuery ? t("mobileSearchSummary.searchCondition", { query }) : null,
		dateFilter === null ? null : getSearchDateLabel(dateFilter),
		recordStatsFilter === null ? null : getRecordStatsSearchFilterLabel(recordStatsFilter),
	].filter((condition): condition is string => condition !== null);
	if (conditions.length > 1) {
		return t("mobileSearchSummary.combo", {
			conditions: conditions.join(t("mobileSearchSummary.separator")),
			count: 0,
		});
	}
	if (hasQuery) {
		return t("mobileSearchSummary.emptySearch", { query });
	}
	if (dateFilter !== null) {
		return getSearchDateEmptyTitle(dateFilter);
	}
	if (recordStatsFilter !== null) {
		return t("recordStats.filter.empty", { label: getRecordStatsSearchFilterLabel(recordStatsFilter) });
	}
	return t("search.noResults");
}

export function getRecordStatsSearchFilterLabel(filter: RecordStatsSearchFilter): string {
	if (filter.type === "day") {
		return t("recordStats.filter.day", { date: filter.date });
	}
	if (filter.type === "month") {
		return t("recordStats.filter.month", { month: filter.month });
	}
	if (filter.type === "range") {
		return t("recordStats.filter.range", {
			startDate: filter.startDate,
			endDate: getInclusiveEndDate(filter.endDateExclusive),
		});
	}
	if (filter.type === "with-tag" || filter.type === "no-tag" || filter.type === "with-image") {
		const key = filter.type === "with-tag"
			? "recordStats.filter.withTag"
			: filter.type === "no-tag"
				? "recordStats.filter.noTag"
				: "recordStats.filter.withImage";
		return t(key, {
			startDate: filter.startDate,
			endDate: getInclusiveEndDate(filter.endDateExclusive),
		});
	}
	if (filter.type === "tag") {
		return t("recordStats.filter.tag", {
			startDate: filter.startDate,
			endDate: getInclusiveEndDate(filter.endDateExclusive),
			tag: filter.tagLabel,
		});
	}
	if (filter.type === "references") {
		return t("recordStats.filter.references", {
			startDate: filter.startDate,
			endDate: getInclusiveEndDate(filter.endDateExclusive),
		});
	}
	if (filter.type === "max-daily-notes") {
		return t("recordStats.filter.maxDailyNotes", { dates: formatFilterDates(filter.dates) });
	}
	if (filter.type === "max-daily-words") {
		return t("recordStats.filter.maxDailyWords", { dates: formatFilterDates(filter.dates) });
	}
	return t("recordStats.filter.hour", {
		startDate: filter.startDate,
		endDate: getInclusiveEndDate(filter.endDateExclusive),
		hour: String(filter.hour).padStart(2, "0"),
	});
}

export function getRecordStatsSearchFilterKey(filter: RecordStatsSearchFilter | null): string {
	if (filter === null) {
		return "";
	}
	if (filter.type === "day") return `day:${filter.date}`;
	if (filter.type === "month") return `month:${filter.month}`;
	if (filter.type === "range") return `range:${filter.startDate}:${filter.endDateExclusive}`;
	if (filter.type === "with-tag") return `with-tag:${filter.startDate}:${filter.endDateExclusive}`;
	if (filter.type === "no-tag") return `no-tag:${filter.startDate}:${filter.endDateExclusive}`;
	if (filter.type === "with-image") return `with-image:${filter.startDate}:${filter.endDateExclusive}`;
	if (filter.type === "tag") return `tag:${filter.startDate}:${filter.endDateExclusive}:${filter.tagKey}`;
	if (filter.type === "references") return `references:${filter.startDate}:${filter.endDateExclusive}`;
	if (filter.type === "max-daily-notes") return `max-daily-notes:${filter.dates.join(",")}`;
	if (filter.type === "max-daily-words") return `max-daily-words:${filter.dates.join(",")}`;
	return `hour:${filter.startDate}:${filter.endDateExclusive}:${filter.hour}`;
}

export function matchesRecordStatsSearchFilter(memo: MemoRecord, filter: RecordStatsSearchFilter): boolean {
	if (memo.status !== "active") {
		return false;
	}
	const date = parseLocalDateText(memo.createdAt);
	if (date === null) {
		return false;
	}
	const dateKey = formatLocalDateKey(date);
	if (filter.type === "day") return dateKey === filter.date;
	if (filter.type === "month") return dateKey.startsWith(`${filter.month}-`);
	if (filter.type === "max-daily-notes" || filter.type === "max-daily-words") {
		return filter.dates.includes(dateKey);
	}
	if (dateKey < filter.startDate || dateKey >= filter.endDateExclusive) {
		return false;
	}
	if (filter.type === "range") {
		return true;
	}
	if (filter.type === "with-tag") {
		return memo.tags.length > 0;
	}
	if (filter.type === "no-tag") {
		return memo.tags.length === 0;
	}
	if (filter.type === "with-image") {
		return getMemoImages(memo).length > 0;
	}
	if (filter.type === "tag") {
		return memo.tags.some((tag) => normalizeTagKey(tag) === filter.tagKey);
	}
	if (filter.type === "references") {
		return hasMemoReference(memo);
	}
	return date.getHours() === filter.hour;
}

export function formatTagFilterText(tag: string): string {
	return `#${tag.replace(/^#/, "")}`;
}

export function isSummaryScopeFilter(filter: ScopeFilter): filter is SummaryScopeFilter {
	return filter === "no-tag" || filter === "with-link" || filter === "with-image" || filter === "anniversary";
}

export function buildMemoSearchText(memo: MemoRecord): string {
	return [
		memo.contentSnapshot,
		formatMemoDisplayTime(memo.createdAt),
		memo.createdAt,
		memo.tags.join(" "),
		memo.links.map((link) => link.target).join(" "),
		getMemoImages(memo).map((image) => image.path).join(" "),
	].join(" ").toLowerCase();
}

export function parseMemoLocalDate(memo: MemoRecord, dailyStatus: DailyDateConfig): Date | null {
	const createdAtDate = parseLocalDateText(memo.createdAt);
	if (createdAtDate !== null) {
		return createdAtDate;
	}
	if (dailyStatus.enabled && dailyStatus.format !== null) {
		const dailyDate = parseDailyNoteDateFromPath(memo.dailyRef.path, {
			folder: dailyStatus.folder,
			format: dailyStatus.format,
		});
		if (dailyDate !== null) {
			return applyMemoBlockTime(dailyDate, memo.dailyRef.lastKnownBlock);
		}
	}
	return parseLocalDateText(memo.monthlyRef.dateHeading) ?? parseLocalDateText(memo.monthlyRef.path);
}

export function parseLocalDateText(value: string): Date | null {
	const match = value.match(/(?:^|[^\d])(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/);
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

export function applyMemoBlockTime(date: Date, block: string): Date {
	const timeMatch = block.match(/(?:^|\n)- (\d{2}):(\d{2})(?::(\d{2}))?\b/);
	if (timeMatch === null) {
		return date;
	}
	const nextDate = new Date(date);
	nextDate.setHours(Number(timeMatch[1]), Number(timeMatch[2]), timeMatch[3] === undefined ? 0 : Number(timeMatch[3]), 0);
	return nextDate;
}

export function matchesScope(memo: MemoRecord, filter: ScopeFilter, todayDate = new Date()): boolean {
	const date = new Date(memo.createdAt);
	const today = startOfDay(todayDate);
	if (filter === "all") return true;
	if (filter === "no-tag") return memo.tags.length === 0;
	if (filter === "with-link") return memo.links.length > 0 || parseMemoLinks(memo.contentSnapshot).length > 0;
	if (filter === "with-image") return getMemoImages(memo).length > 0;
	if (filter === "anniversary") {
		return date.getMonth() === today.getMonth() && date.getDate() === today.getDate() && date.getFullYear() !== today.getFullYear();
	}
	if (filter === "week") {
		const mondayOffset = (today.getDay() + 6) % 7;
		const start = addDays(today, -mondayOffset);
		return date >= start && date < addDays(start, 7);
	}
	if (filter === "month") {
		return date >= new Date(today.getFullYear(), today.getMonth(), 1) && date < new Date(today.getFullYear(), today.getMonth() + 1, 1);
	}
	if (filter === "last-month") {
		return date >= new Date(today.getFullYear(), today.getMonth() - 1, 1) && date < new Date(today.getFullYear(), today.getMonth(), 1);
	}
	if (filter === "last-7") return date >= addDays(today, -6) && date < addDays(today, 1);
	if (filter === "last-30") return date >= addDays(today, -29) && date < addDays(today, 1);
	return true;
}

export function getScopeLabel(filter: ScopeFilter): string {
	if (filter === "no-tag") return t("filter.noTag");
	if (filter === "with-link") return t("filter.withLink");
	if (filter === "with-image") return t("filter.withImage");
	if (filter === "anniversary") return t("filter.anniversary");
	return t("nav.allNotes");
}

export function getSearchDateLabel(filter: SearchDateFilter): string {
	if (filter === "week") return t("date.week");
	if (filter === "month") return t("date.month");
	if (filter === "last-7") return t("date.last7");
	if (filter === "last-30") return t("date.last30");
	if (filter === "last-week") return t("date.lastWeek");
	return t("date.lastMonth");
}

export function matchesSearchDateFilter(date: Date, filter: SearchDateFilter, todayDate = new Date()): boolean {
	const today = startOfDay(todayDate);
	if (filter === "week") {
		const mondayOffset = (today.getDay() + 6) % 7;
		const start = addDays(today, -mondayOffset);
		return date >= start && date < addDays(start, 7);
	}
	if (filter === "last-week") {
		const mondayOffset = (today.getDay() + 6) % 7;
		const thisWeekStart = addDays(today, -mondayOffset);
		const lastWeekStart = addDays(thisWeekStart, -7);
		return date >= lastWeekStart && date < thisWeekStart;
	}
	if (filter === "month") {
		return date >= new Date(today.getFullYear(), today.getMonth(), 1) && date < new Date(today.getFullYear(), today.getMonth() + 1, 1);
	}
	if (filter === "last-month") {
		return date >= new Date(today.getFullYear(), today.getMonth() - 1, 1) && date < new Date(today.getFullYear(), today.getMonth(), 1);
	}
	if (filter === "last-7") return date >= addDays(today, -6) && date < addDays(today, 1);
	if (filter === "last-30") return date >= addDays(today, -29) && date < addDays(today, 1);
	return true;
}

export function needsAllMemos(
	scope: ScopeFilter,
	query: string,
	searchDateFilter: SearchDateFilter | null,
	recordStatsFilter: RecordStatsSearchFilter | null = null,
): boolean {
	return query.trim().length > 0 ||
		searchDateFilter !== null ||
		recordStatsFilter !== null ||
		isSummaryScopeFilter(scope);
}

function getTagDisplayName(key: string, fallbackName: string, displayTags: Map<string, string>): string {
	const displayName = displayTags.get(key);
	if (displayName !== undefined) {
		return displayName;
	}
	const keyParts = key.split("/").filter((part) => part.length > 0);
	const fallbackParts = fallbackName.split("/").filter((part) => part.length > 0);
	const displayParts = keyParts.map((keyPart, index) => {
		const prefixKey = keyParts.slice(0, index + 1).join("/");
		const prefixDisplay = displayTags.get(prefixKey);
		if (prefixDisplay !== undefined) {
			const prefixParts = prefixDisplay.split("/").filter((part) => part.length > 0);
			return prefixParts[prefixParts.length - 1] ?? keyPart;
		}
		return fallbackParts[index] ?? keyPart;
	});
	return displayParts.join("/");
}

function getSearchDateEmptyTitle(filter: SearchDateFilter): string {
	if (filter === "week") return t("filterEmpty.date.week");
	if (filter === "month") return t("filterEmpty.date.month");
	if (filter === "last-7") return t("filterEmpty.date.last7");
	if (filter === "last-30") return t("filterEmpty.date.last30");
	if (filter === "last-week") return t("filterEmpty.date.lastWeek");
	return t("filterEmpty.date.lastMonth");
}

function getScopeEmptyTitle(filter: SummaryScopeFilter): string {
	if (filter === "no-tag") return t("filterEmpty.scope.noTag");
	if (filter === "with-link") return t("filterEmpty.scope.withLink");
	if (filter === "with-image") return t("filterEmpty.scope.withImage");
	return t("filterEmpty.scope.anniversary");
}

function formatMemoDisplayTime(value: string): string {
	return value.replace("T", " ").replace(/\.\d{3}[+-]\d{2}:\d{2}$/, "");
}

function formatFilterDates(dates: string[]): string {
	if (dates.length <= 1) {
		return dates[0] ?? "";
	}
	return t("recordStats.filter.tiedDates", { count: dates.length });
}

function getInclusiveEndDate(endDateExclusive: string): string {
	const date = parseLocalDateText(endDateExclusive);
	if (date === null) {
		return endDateExclusive;
	}
	date.setDate(date.getDate() - 1);
	return formatLocalDateKey(date);
}

function formatLocalDateKey(date: Date): string {
	return [
		String(date.getFullYear()).padStart(4, "0"),
		String(date.getMonth() + 1).padStart(2, "0"),
		String(date.getDate()).padStart(2, "0"),
	].join("-");
}

function startOfDay(date: Date): Date {
	return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date: Date, days: number): Date {
	const nextDate = new Date(date);
	nextDate.setDate(nextDate.getDate() + days);
	return nextDate;
}

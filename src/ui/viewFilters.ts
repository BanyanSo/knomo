import { t } from "../i18n";
import type { MemoViewItem as MemoRecord } from "../types/memoView";
import type { CatalogRecordStatsFilter } from "../types/catalogView";
import { parseMemoCalendarDate } from "../utils/date";
import { parseDailyNoteDateFromPath } from "../utils/dailyNotes";
import { isSupportedMemoImage, parseMemoLinks } from "../utils/markdown";
import { hasMemoReference } from "../utils/references";
import type { TagSummary } from "../utils/tagTree";
import { normalizeTagKey } from "../utils/tags";
import type { SidebarNav } from "./viewNavigation";

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

export type RecordStatsSearchFilter = CatalogRecordStatsFilter;

export type RegularFilterCondition =
	| { type: "things"; text: string }
	| { type: "tag"; text: string }
	| { type: "search"; text: string; query: string }
	| { type: "date"; text: string; filter: SearchDateFilter }
	| { type: "record-stats"; text: string }
	| { type: "scope"; text: string; filter: SummaryScopeFilter };

export interface RegularFilterState {
	activeNav?: SidebarNav;
	activeTag: string | null;
	activeTagKey: string | null;
	searchQuery: string;
	searchDateFilter: SearchDateFilter | null;
	recordStatsSearchFilter: RecordStatsSearchFilter | null;
	scopeFilter: ScopeFilter;
}

export interface RegularFilterCopy {
	summary: string;
	emptyTitle: string;
}

export interface DailyDateConfig {
	enabled: boolean;
	folder: string | null;
	format: string | null;
}

export function collectTagsFromCounts(
	counts: ReadonlyMap<string, number>,
	displayTags: Map<string, string>,
	fallbackNames: ReadonlyMap<string, string> = new Map(),
): TagSummary[] {
	const keys = collectTagKeys(counts, fallbackNames);
	return [...keys]
		.map((key) => ({
			key,
			name: getTagDisplayName(key, fallbackNames.get(key) ?? key, displayTags),
			count: counts.get(key) ?? 0,
		}))
		.sort((left, right) => {
			return right.count - left.count || left.name.localeCompare(right.name, "zh");
		});
}

function collectTagKeys(
	counts: ReadonlyMap<string, number>,
	fallbackNames: ReadonlyMap<string, string>,
): Set<string> {
	const keys = new Set<string>();
	for (const key of [...counts.keys(), ...fallbackNames.keys()]) {
		const parts = key.split("/").filter((part) => part.length > 0);
		for (let index = 1; index <= parts.length; index += 1) {
			keys.add(parts.slice(0, index).join("/"));
		}
	}
	return keys;
}

export function tagMatchesActiveTagKey(tag: string, activeTagKey: string): boolean {
	const tagKey = normalizeTagKey(tag);
	return tagKey === activeTagKey || tagKey.startsWith(`${activeTagKey}/`);
}

export function getMemoImages(memo: MemoRecord): MemoRecord["images"] {
	return memo.images.filter(isSupportedMemoImage);
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
	if (condition.type === "things") return t("empty.generic");
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

export function getRegularFilterCopy(state: RegularFilterState, count: number): RegularFilterCopy | null {
	const conditions = getRegularFilterConditions(state);
	if (conditions.length === 0) {
		return null;
	}
	const summary = formatRegularFilterSummary(conditions, count);
	return {
		summary,
		emptyTitle: formatRegularFilterEmptyTitle(conditions, summary),
	};
}

export function getRegularFilterConditions(state: RegularFilterState): RegularFilterCondition[] {
	const conditions: RegularFilterCondition[] = [];
	if (state.activeNav === "things") conditions.push({ type: "things", text: t("nav.things") });
	const tag = state.activeTag?.trim() || state.activeTagKey || "";
	if (state.activeTagKey !== null && tag.length > 0) {
		conditions.push({ type: "tag", text: formatTagFilterText(tag) });
	}
	if (state.recordStatsSearchFilter !== null) {
		conditions.push({
			type: "record-stats",
			text: getRecordStatsSearchFilterLabel(state.recordStatsSearchFilter),
		});
	}
	const query = state.searchQuery.trim();
	if (query.length > 0) {
		conditions.push({
			type: "search",
			text: t("filterSummary.searchCondition", { query }),
			query,
		});
	}
	if (state.searchDateFilter !== null) {
		conditions.push({
			type: "date",
			text: getSearchDateLabel(state.searchDateFilter),
			filter: state.searchDateFilter,
		});
	}
	if (isSummaryScopeFilter(state.scopeFilter)) {
		conditions.push({
			type: "scope",
			text: getScopeLabel(state.scopeFilter),
			filter: state.scopeFilter,
		});
	}
	return conditions;
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
	const date = parseLocalDateText(getMemoCalendarValue(memo));
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
		return memo.tags.some((tag) => tagMatchesActiveTagKey(tag, filter.tagKey));
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

export function parseMemoLocalDate(memo: MemoRecord, dailyStatus: DailyDateConfig): Date | null {
	const createdAtDate = parseLocalDateText(getMemoCalendarValue(memo));
	if (createdAtDate !== null) {
		return createdAtDate;
	}
	if (dailyStatus.enabled && dailyStatus.format !== null) {
		const dailyDate = parseDailyNoteDateFromPath(memo.dailyRef.path, {
			folder: dailyStatus.folder,
			format: dailyStatus.format,
		});
		if (dailyDate !== null) {
			return dailyDate;
		}
	}
	return null;
}

function getMemoCalendarValue(memo: MemoRecord): string {
	const observation = memo.catalog?.observation;
	return observation === undefined ? memo.createdAt : `${observation.logicalDate}T${observation.time}`;
}

export function parseLocalDateText(value: string): Date | null {
	const match = value.match(/(?:^|[^\d])(\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?)/u);
	return match === null ? null : parseMemoCalendarDate(match[1]);
}

export function matchesScope(memo: MemoRecord, filter: ScopeFilter, todayDate = new Date()): boolean {
	const date = new Date(getMemoCalendarValue(memo));
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

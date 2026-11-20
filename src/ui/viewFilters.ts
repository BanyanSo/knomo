import { t } from "../i18n";
import type { CatalogRecordStatsFilter } from "../types/catalogView";
import { parseMemoCalendarDate } from "../utils/date";
import type { TagSummary } from "../utils/tagTree";
import { formatTimeBuoyDate } from "../utils/timeBuoyDate";
import type { SidebarNav } from "./viewNavigation";
import type { ResultCountSummary } from "./ResultCountSummary";

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
	| "referenced"
	| "with-image";

export type SearchDateFilter = "week" | "month" | "last-7" | "last-30" | "last-week" | "last-month";
export type SummaryScopeFilter = "no-tag" | "with-link" | "with-image" | "referenced" | "anniversary";

export type RecordStatsSearchFilter = CatalogRecordStatsFilter;

export type RegularFilterCondition =
	| { type: "things"; text: string }
	| { type: "favorites"; text: string }
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
	summary: ResultCountSummary;
	emptyTitle: string;
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

export function formatRegularFilterSummary(conditions: RegularFilterCondition[], count: number): string {
	const { template, params } = getRegularFilterSummaryTemplate(conditions);
	return t(template, { ...params, count });
}

function getRegularFilterSummaryTemplate(conditions: RegularFilterCondition[]): Pick<ResultCountSummary, "template" | "params"> {
	if (conditions.length === 1) {
		const condition = conditions[0];
		if (condition.type === "tag") {
			return { template: "filterSummary.tag", params: { tag: condition.text } };
		}
		if (condition.type === "search") {
			return { template: "filterSummary.search", params: { query: condition.query } };
		}
		if (condition.type === "record-stats") {
			return { template: "filterSummary.recordStats", params: { label: condition.text } };
		}
		return { template: "filterSummary.label", params: { label: condition.text } };
	}
	const conditionText = conditions.map((condition) => condition.text).join(t("filterSummary.separator"));
	const key = conditions.some((condition) => condition.type === "search")
		? "filterSummary.comboSearch"
		: "filterSummary.combo";
	return { template: key, params: { conditions: conditionText } };
}

export function getRegularFilterCopy(state: RegularFilterState, count: number | null, pending = false): RegularFilterCopy | null {
	const conditions = getRegularFilterConditions(state);
	if (conditions.length === 0) return null;
	return {
		summary: { ...getRegularFilterSummaryTemplate(conditions), count, pending: count === null && pending },
		emptyTitle: formatRegularFilterEmptyTitle(conditions, formatRegularFilterSummary(conditions, count ?? 0)),
	};
}

export function formatRegularFilterEmptyTitle(conditions: RegularFilterCondition[], summary: string): string {
	if (conditions.length > 1) {
		return summary;
	}
	const condition = conditions[0];
	if (condition.type === "things") return t("empty.generic");
	if (condition.type === "favorites") return t("favorite.empty.title");
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

export function getRegularFilterConditions(state: RegularFilterState): RegularFilterCondition[] {
	const conditions: RegularFilterCondition[] = [];
	if (state.activeNav === "things") conditions.push({ type: "things", text: t("nav.things") });
	if (state.activeNav === "favorites") conditions.push({ type: "favorites", text: t("favorite.title") });
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

export function getMobileSearchResultSummary(
	query: string,
	dateFilter: SearchDateFilter | null,
	count: number | null,
	pending: boolean,
	recordStatsFilter: RecordStatsSearchFilter | null = null,
): ResultCountSummary | null {
	pending = count === null && pending;
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
		return { template: "mobileSearchSummary.combo", params: { conditions: conditions.join(t("mobileSearchSummary.separator")) }, count, pending };
	}
	if (hasQuery) {
		return { template: "mobileSearchSummary.search", params: { query }, count, pending };
	}
	if (dateFilter !== null) {
		return { template: "mobileSearchSummary.date", params: { label: getSearchDateLabel(dateFilter) }, count, pending };
	}
	return recordStatsFilter === null ? null : { template: "mobileSearchSummary.recordStats", params: { label: getRecordStatsSearchFilterLabel(recordStatsFilter) }, count, pending };
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
	if (filter.type === "range" || filter.type === "things" || filter.type === "favorites") {
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
	if (filter.type === "referenced") {
		return t("recordStats.filter.referenced", {
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
	if (filter.type === "range" || filter.type === "things" || filter.type === "favorites") return `${filter.type}:${filter.startDate}:${filter.endDateExclusive}`;
	if (filter.type === "with-tag") return `with-tag:${filter.startDate}:${filter.endDateExclusive}`;
	if (filter.type === "no-tag") return `no-tag:${filter.startDate}:${filter.endDateExclusive}`;
	if (filter.type === "with-image") return `with-image:${filter.startDate}:${filter.endDateExclusive}`;
	if (filter.type === "tag") return `tag:${filter.startDate}:${filter.endDateExclusive}:${filter.tagKey}`;
	if (filter.type === "references") return `references:${filter.startDate}:${filter.endDateExclusive}`;
	if (filter.type === "referenced") return `referenced:${filter.startDate}:${filter.endDateExclusive}`;
	if (filter.type === "max-daily-notes") return `max-daily-notes:${filter.dates.join(",")}`;
	if (filter.type === "max-daily-words") return `max-daily-words:${filter.dates.join(",")}`;
	return `hour:${filter.startDate}:${filter.endDateExclusive}:${filter.hour}`;
}

export function formatTagFilterText(tag: string): string {
	return `#${tag.replace(/^#/, "")}`;
}

export function isSummaryScopeFilter(filter: ScopeFilter): filter is SummaryScopeFilter {
	return filter === "no-tag" || filter === "with-link" || filter === "with-image" || filter === "referenced" || filter === "anniversary";
}

export function parseLocalDateText(value: string): Date | null {
	const match = value.match(/(?:^|[^\d])(\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?)/u);
	return match === null ? null : parseMemoCalendarDate(match[1]);
}

export function getScopeLabel(filter: ScopeFilter): string {
	if (filter === "referenced") return t("filter.referenced");
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
	if (filter === "referenced") return t("filterEmpty.scope.referenced");
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
	return formatTimeBuoyDate(date);
}

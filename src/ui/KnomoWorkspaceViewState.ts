import type { RecordStatsView } from "../services/RecordStatsService";
import { parseSearchInput } from "../services/SearchQuery";
import { formatDatePart, parseMemoCalendarDate } from "../utils/date";
import { normalizeTagDisplay, normalizeTagKey } from "../utils/tags";
import type { SidebarNav } from "./viewNavigation";
import type { RecordStatsSearchFilter, ScopeFilter, SearchDateFilter } from "./viewFilters";

export interface KnomoWorkspaceSearchState {
	input: string;
	shortcut: SearchDateFilter | null;
}

export interface KnomoWorkspaceNavigationState {
	activeNav: SidebarNav;
	scopeFilter: ScopeFilter;
	activeTag: string | null;
	activeTagKey: string | null;
	search: KnomoWorkspaceSearchState;
	recordStatsSearchFilter: RecordStatsSearchFilter | null;
}

export interface KnomoWorkspaceStatsState {
	view: RecordStatsView;
	selectedDate: string;
}

export interface KnomoWorkspaceMobileSearchState extends KnomoWorkspaceSearchState {
	recordStatsSearchFilter: RecordStatsSearchFilter | null;
}

export interface KnomoWorkspaceViewState {
	version: 1;
	navigation: KnomoWorkspaceNavigationState;
	recordStats: KnomoWorkspaceStatsState;
	recordStatsReturn: KnomoWorkspaceNavigationState | null;
	mobileSearch: KnomoWorkspaceMobileSearchState;
}

export interface KnomoWorkspaceStateOptions {
	timeBuoyEnabled?: boolean;
	now?: Date;
}

const WORKSPACE_NAVS: readonly SidebarNav[] = ["all", "things", "review", "random", "shuffleDay", "time-buoy", "record-stats", "trash"];
const WORKSPACE_SCOPES: readonly ScopeFilter[] = ["all", "week", "month", "last-month", "last-7", "last-30", "anniversary", "no-tag", "with-link", "with-image"];
const WORKSPACE_SHORTCUTS: readonly SearchDateFilter[] = ["week", "month", "last-7", "last-30", "last-week", "last-month"];
const WORKSPACE_STATS_VIEWS: readonly RecordStatsView[] = ["week", "month", "year"];
// 仅限制宿主弱状态体积，不改变普通搜索或标签操作的输入范围。
const MAX_WORKSPACE_SEARCH_LENGTH = 4_096;
const MAX_WORKSPACE_TAG_LENGTH = 1_024;
const MAX_WORKSPACE_STATS_DATES = 366;

// Workspace 仅保存稳定条件。始终重建白名单对象，未知版本不读取旧字段或派生结果。
export function parseKnomoWorkspaceViewState(raw: unknown, options: KnomoWorkspaceStateOptions = {}): KnomoWorkspaceViewState {
	const value = asRecord(raw);
	const state = value.version === 1 ? value : {};
	const navigation = sanitizeWorkspaceNavigationState(state.navigation, options);
	const returnValue = asRecord(state.recordStatsReturn);
	const recordStatsReturn = navigation.activeNav === "record-stats" && WORKSPACE_NAVS.includes(returnValue.activeNav as SidebarNav)
		&& returnValue.activeNav !== "record-stats" ? sanitizeWorkspaceNavigationState(returnValue, options) : null;
	const mobile = asRecord(state.mobileSearch);
	return {
		version: 1,
		navigation,
		recordStats: sanitizeWorkspaceStatsState(state.recordStats, options.now),
		recordStatsReturn,
		mobileSearch: { ...sanitizeWorkspaceSearchState(mobile), recordStatsSearchFilter: sanitizeWorkspaceRecordStatsFilter(mobile.recordStatsSearchFilter) },
	};
}

export function sanitizeWorkspaceSearchState(raw: unknown): KnomoWorkspaceSearchState {
	const value = asRecord(raw);
	const input = typeof value.input === "string" && value.input.length <= MAX_WORKSPACE_SEARCH_LENGTH ? value.input : "";
	const parsed = parseSearchInput(input);
	if (parsed.status !== "valid" && parsed.status !== "empty") return { input: "", shortcut: null };
	return { input, shortcut: parsed.date === null && WORKSPACE_SHORTCUTS.includes(value.shortcut as SearchDateFilter)
		? value.shortcut as SearchDateFilter : null };
}

export function sanitizeWorkspaceNavigationState(raw: unknown, options: KnomoWorkspaceStateOptions = {}): KnomoWorkspaceNavigationState {
	const value = asRecord(raw);
	const activeNav = WORKSPACE_NAVS.includes(value.activeNav as SidebarNav) ? value.activeNav as SidebarNav : null;
	if (activeNav === null || (activeNav === "time-buoy" && options.timeBuoyEnabled === false)) return defaultNavigation();
	if (!["all", "things", "review"].includes(activeNav)) return { ...defaultNavigation(), activeNav };
	const tag = sanitizeTag(value.activeTagKey, value.activeTag);
	const scopeFilter = WORKSPACE_SCOPES.includes(value.scopeFilter as ScopeFilter) ? value.scopeFilter as ScopeFilter : "all";
	const search = sanitizeWorkspaceSearchState(value.search);
	// Things 的日期来源沿用导航转换：保留 tag/已提交搜索，旧日期 scope 转为 shortcut。
	if (activeNav === "things" && WORKSPACE_SHORTCUTS.includes(scopeFilter as SearchDateFilter)
		&& search.shortcut === null && parseSearchInput(search.input).date === null) search.shortcut = scopeFilter as SearchDateFilter;
	return {
		activeNav,
		scopeFilter: activeNav === "things" ? "all" : scopeFilter,
		activeTag: tag?.label ?? null,
		activeTagKey: tag?.key ?? null,
		search,
		recordStatsSearchFilter: sanitizeWorkspaceRecordStatsFilter(value.recordStatsSearchFilter),
	};
}

export function sanitizeWorkspaceStatsState(raw: unknown, now = new Date()): KnomoWorkspaceStatsState {
	const value = asRecord(raw);
	return { view: WORKSPACE_STATS_VIEWS.includes(value.view as RecordStatsView) ? value.view as RecordStatsView : "week",
		selectedDate: isCalendarDate(value.selectedDate) ? value.selectedDate : formatDatePart(now) };
}

export function sanitizeWorkspaceRecordStatsFilter(raw: unknown): RecordStatsSearchFilter | null {
	const value = asRecord(raw);
	if (value.type === "day") return isCalendarDate(value.date) ? { type: "day", date: value.date } : null;
	if (value.type === "month") return typeof value.month === "string" && /^\d{4}-\d{2}$/u.test(value.month)
		&& isCalendarDate(value.month + "-01") ? { type: "month", month: value.month } : null;
	if (value.type === "max-daily-notes" || value.type === "max-daily-words") {
		if (!Array.isArray(value.dates) || value.dates.length === 0 || value.dates.length > MAX_WORKSPACE_STATS_DATES
			|| !value.dates.every(isCalendarDate)) return null;
		return { type: value.type, dates: [...value.dates] as string[] };
	}
	if (!isCalendarDate(value.startDate) || !isCalendarDate(value.endDateExclusive) || value.startDate >= value.endDateExclusive) return null;
	const range = { startDate: value.startDate, endDateExclusive: value.endDateExclusive };
	if (value.type === "range" || value.type === "with-tag" || value.type === "no-tag" || value.type === "with-image" || value.type === "references") {
		return { type: value.type, ...range };
	}
	if (value.type === "hour") return typeof value.hour === "number" && Number.isInteger(value.hour) && value.hour >= 0 && value.hour <= 23
		? { type: "hour", ...range, hour: value.hour } : null;
	if (value.type === "tag") {
		const tag = sanitizeTag(value.tagKey, value.tagLabel);
		return tag === null ? null : { type: "tag", ...range, tagKey: tag.key, tagLabel: tag.label };
	}
	return null;
}

function defaultNavigation(): KnomoWorkspaceNavigationState {
	return { activeNav: "all", scopeFilter: "all", activeTag: null, activeTagKey: null,
		search: { input: "", shortcut: null }, recordStatsSearchFilter: null };
}

function asRecord(raw: unknown): Record<string, unknown> {
	return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
}

function isCalendarDate(raw: unknown): raw is string {
	return typeof raw === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(raw) && parseMemoCalendarDate(raw) !== null;
}

function sanitizeTag(rawKey: unknown, rawLabel: unknown): { key: string; label: string } | null {
	if (typeof rawKey !== "string" || rawKey.length > MAX_WORKSPACE_TAG_LENGTH) return null;
	const key = normalizeTagKey(rawKey);
	if (key.length === 0 || /[\s\u0000-\u001f\u007f]/u.test(key)) return null;
	const label = typeof rawLabel === "string" && rawLabel.length <= MAX_WORKSPACE_TAG_LENGTH ? normalizeTagDisplay(rawLabel) : key;
	return { key, label: normalizeTagKey(label) === key ? label : key };
}

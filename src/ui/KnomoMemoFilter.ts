import type { MemoViewItem as MemoRecord } from "../types/memoView";
import { matchesCatalogQuery, normalizeCatalogText } from "../services/MemoCatalogStore";
import { formatDatePart } from "../utils/date";
import type { SidebarNav } from "./viewNavigation";
import {
	matchesRecordStatsSearchFilter,
	matchesScope,
	matchesSearchDateFilter,
	parseMemoLocalDate,
	tagMatchesActiveTagKey,
} from "./viewFilters";
import type {
	DailyDateConfig,
	RecordStatsSearchFilter,
	ScopeFilter,
	SearchDateFilter,
} from "./viewFilters";

interface FilterVisibleMemosOptions {
	memos: MemoRecord[];
	randomMemos: MemoRecord[];
	shuffleDayMemos: MemoRecord[];
	activeNav: SidebarNav;
	activeTagKey: string | null;
	scopeFilter: ScopeFilter;
	normalizedQuery: string;
	searchDateFilter: SearchDateFilter | null;
	recordStatsFilter: RecordStatsSearchFilter | null;
	dailyStatus: DailyDateConfig;
	getMemoSearchText: (memo: MemoRecord) => string;
	today?: Date;
}

export function filterVisibleMemos(options: FilterVisibleMemosOptions): MemoRecord[] {
	const {
		memos,
		randomMemos,
		shuffleDayMemos,
		activeNav,
		activeTagKey,
		scopeFilter,
		normalizedQuery,
		searchDateFilter,
		recordStatsFilter,
		dailyStatus,
		getMemoSearchText,
	} = options;
	const today = options.today ?? new Date();
	if (activeNav === "trash" || activeNav === "record-stats") {
		return [];
	}
	if (activeNav === "random") {
		return randomMemos;
	}
	if (activeNav === "shuffleDay") {
		return shuffleDayMemos;
	}
	if (hasActiveMemoSearch(normalizedQuery, searchDateFilter, recordStatsFilter)) {
		return memos.filter((memo) => {
			return memoMatchesSearch(memo, normalizedQuery, searchDateFilter, recordStatsFilter, dailyStatus, getMemoSearchText, today);
		});
	}
	if (activeNav === "review") {
		return getOutsideTodayMemos(memos, dailyStatus, today);
	}
	return memos.filter((memo) => {
		if (activeTagKey !== null && !memo.tags.some((tag) => tagMatchesActiveTagKey(tag, activeTagKey))) {
			return false;
		}
		if (!matchesMemoSearchText(memo, normalizedQuery, getMemoSearchText)) {
			return false;
		}
		return matchesScope(memo, scopeFilter, today);
	});
}

export function memoMatchesSearch(
	memo: MemoRecord,
	normalizedQuery: string,
	dateFilter: SearchDateFilter | null,
	recordStatsFilter: RecordStatsSearchFilter | null,
	dailyStatus: DailyDateConfig,
	getMemoSearchText: (memo: MemoRecord) => string,
	today = new Date(),
): boolean {
	if (!matchesMemoSearchText(memo, normalizedQuery, getMemoSearchText)) {
		return false;
	}
	if (dateFilter !== null && !memoMatchesSearchDate(memo, dateFilter, dailyStatus, today)) {
		return false;
	}
	if (recordStatsFilter !== null && !matchesRecordStatsSearchFilter(memo, recordStatsFilter)) {
		return false;
	}
	return true;
}

function matchesMemoSearchText(
	memo: MemoRecord,
	query: string,
	getMemoSearchText: (memo: MemoRecord) => string,
): boolean {
	if (query.length === 0) return true;
	// Catalog 卡片复用计数的匹配规则，避免二次过滤丢掉已命中的结果。
	if (memo.catalog !== undefined) return matchesCatalogQuery(memo.catalog.observation, { text: query });
	return normalizeCatalogText(getMemoSearchText(memo)).includes(normalizeCatalogText(query));
}

function hasActiveMemoSearch(
	normalizedQuery: string,
	searchDateFilter: SearchDateFilter | null,
	recordStatsFilter: RecordStatsSearchFilter | null,
): boolean {
	return normalizedQuery.length > 0
		|| searchDateFilter !== null
		|| recordStatsFilter !== null;
}

function memoMatchesSearchDate(
	memo: MemoRecord,
	filter: SearchDateFilter,
	dailyStatus: DailyDateConfig,
	today: Date,
): boolean {
	const date = parseMemoLocalDate(memo, dailyStatus);
	if (date === null) {
		return false;
	}
	return matchesSearchDateFilter(date, filter, today);
}

function getOutsideTodayMemos(
	memos: MemoRecord[],
	dailyStatus: DailyDateConfig,
	today: Date,
): MemoRecord[] {
	const todayDay = today.getDate();
	const todayKey = formatDatePart(today);
	const isLeapDay = today.getMonth() === 1 && todayDay === 29;
	return memos
		.map((memo) => ({ memo, date: parseMemoLocalDate(memo, dailyStatus) }))
		.filter((item): item is { memo: MemoRecord; date: Date } => {
			if (item.date === null || item.date.getDate() !== todayDay || formatDatePart(item.date) === todayKey) {
				return false;
			}
			return !isLeapDay || item.date.getMonth() === 1;
		})
		.sort((left, right) => {
			return right.date.getTime() - left.date.getTime() || right.memo.createdAt.localeCompare(left.memo.createdAt);
		})
		.map((item) => item.memo);
}

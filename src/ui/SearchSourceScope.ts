import type { CatalogQueryFilter } from "../types/catalog";
import { buildRecordStatsCatalogQuery, buildReviewCatalogQuery } from "../services/CatalogReadService";
import { intersectCatalogFilters } from "../services/SearchMatching";
import { formatDatePart } from "../utils/date";
import { type RegularFilterState, type SearchDateFilter } from "./viewFilters";
import { getSearchShortcutDate } from "./SearchSession";

export type SearchSourceContext = Omit<RegularFilterState, "searchQuery" | "searchDateFilter">;

export function buildSearchSourceScope(context: SearchSourceContext, today = new Date()): CatalogQueryFilter {
	let filter: CatalogQueryFilter = {};
	const supported = context.recordStatsSearchFilter !== null || ["all", "things", "review"].includes(context.activeNav ?? "all");
	if (!supported) return filter;
	if (context.activeNav === "things") { filter.hasTask = true; }
	if (context.activeNav === "review") { filter = buildReviewCatalogQuery(today); }
	if (context.activeTagKey !== null) {
		filter.tags = [context.activeTagKey];
	}
	if (context.scopeFilter === "with-image") { filter.hasImage = true; }
	if (context.scopeFilter === "with-link") { filter.hasLink = true; }
	if (context.scopeFilter === "no-tag") { filter.hasTag = false; }
	if (context.scopeFilter === "anniversary") {
		filter.monthDay = formatDatePart(today).slice(5);
		filter.excludeDate = formatDatePart(today);
	}
	if (["week", "month", "last-month", "last-7", "last-30"].includes(context.scopeFilter)) {
		const date = getSearchShortcutDate(context.scopeFilter as SearchDateFilter, today);
		if (date.kind === "range") filter = intersectCatalogFilters(filter, { fromDate: date.fromDate, toDate: date.toDate });
	}
	if (context.recordStatsSearchFilter !== null) {
		filter = intersectCatalogFilters(filter, buildRecordStatsCatalogQuery(context.recordStatsSearchFilter).query);
	}
	return filter;
}

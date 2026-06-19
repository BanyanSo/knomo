import { KNOMO_ALL_NOTES_ICON, KNOMO_RANDOM_REUNION_ICON } from "../icons";
import { t } from "../i18n";
import type { ScopeFilter, SearchDateFilter } from "./viewFilters";

export type SidebarNav = "all" | "wechat" | "review" | "ai" | "random" | "record-stats" | "trash";
export type TitleMode = "all" | "no-tag" | "with-link" | "with-image" | "anniversary" | "review" | "random";

export interface ScopeOption {
	filter: ScopeFilter;
	label: string;
	icon: string;
}

export interface SearchDateOption {
	filter: SearchDateFilter;
	label: string;
	mobileLabel?: string;
	icon: string;
}

export interface TitleModeOption {
	mode: TitleMode;
	label: string;
	icon: string;
	nav?: SidebarNav;
	scope?: ScopeFilter;
}

export interface SidebarNavItem {
	nav: SidebarNav;
	label: string;
	icon: string;
}

const SIDEBAR_NAV_ITEMS: SidebarNavItem[] = [
	{ nav: "all", label: t("nav.allNotes"), icon: KNOMO_ALL_NOTES_ICON },
	{ nav: "review", label: t("nav.review"), icon: "calendar-check" },
	{ nav: "random", label: t("nav.random"), icon: KNOMO_RANDOM_REUNION_ICON },
	{ nav: "record-stats", label: t("nav.recordStats"), icon: "chart-column-increasing" },
];

export const TRASH_NAV_ITEM: SidebarNavItem = { nav: "trash", label: t("nav.trash"), icon: "trash-2" };

export const TITLE_SCOPE_OPTIONS: ScopeOption[] = [
	{ filter: "all", label: t("nav.allNotes"), icon: KNOMO_ALL_NOTES_ICON },
	{ filter: "no-tag", label: t("filter.noTag"), icon: "tag" },
	{ filter: "with-link", label: t("filter.withLink"), icon: "link" },
	{ filter: "with-image", label: t("filter.withImage"), icon: "image" },
	{ filter: "anniversary", label: t("filter.anniversary"), icon: "history" },
];

export const TITLE_MODE_OPTIONS: TitleModeOption[] = [
	{ mode: "all", label: t("nav.allNotes"), icon: KNOMO_ALL_NOTES_ICON, scope: "all" },
	{ mode: "no-tag", label: t("filter.noTag"), icon: "tag", scope: "no-tag" },
	{ mode: "with-link", label: t("filter.withLink"), icon: "link", scope: "with-link" },
	{ mode: "with-image", label: t("filter.withImage"), icon: "image", scope: "with-image" },
	{ mode: "anniversary", label: t("filter.anniversary"), icon: "history", scope: "anniversary" },
	{ mode: "review", label: t("nav.review"), icon: "calendar-check", nav: "review" },
	{ mode: "random", label: t("nav.random"), icon: KNOMO_RANDOM_REUNION_ICON, nav: "random" },
];

export const SEARCH_DATE_OPTIONS: SearchDateOption[] = [
	{ filter: "week", label: t("date.week"), icon: "calendar-days" },
	{ filter: "month", label: t("date.month"), icon: "calendar-range" },
	{ filter: "last-7", label: t("date.last7"), mobileLabel: t("date.last7Mobile"), icon: "calendar-clock" },
	{ filter: "last-30", label: t("date.last30"), mobileLabel: t("date.last30Mobile"), icon: "calendar-clock" },
	{ filter: "last-week", label: t("date.lastWeek"), icon: "calendar-minus" },
	{ filter: "last-month", label: t("date.lastMonth"), icon: "calendar-minus" },
];

export function getSidebarNavItems(): SidebarNavItem[] {
	return SIDEBAR_NAV_ITEMS;
}

export function getAllSidebarNavItems(): SidebarNavItem[] {
	return [...SIDEBAR_NAV_ITEMS, TRASH_NAV_ITEM];
}

export function isTitleMode(value: string | null): value is TitleMode {
	return value !== null && TITLE_MODE_OPTIONS.some((option) => option.mode === value);
}

export function isSearchDateFilter(value: string | null): value is SearchDateFilter {
	return value !== null && SEARCH_DATE_OPTIONS.some((option) => option.filter === value);
}

export function isSidebarNav(value: string | null): value is SidebarNav {
	return value !== null && getAllSidebarNavItems().some((item) => item.nav === value);
}

export function getSidebarNavLabel(value: SidebarNav): string {
	return getAllSidebarNavItems().find((item) => item.nav === value)?.label ?? t("nav.allNotes");
}

export function getEmptyStateTitle(activeNav: SidebarNav): string {
	if (activeNav === "review") {
		return t("empty.review");
	}
	if (activeNav === "random") {
		return t("empty.random");
	}
	return t("empty.generic");
}

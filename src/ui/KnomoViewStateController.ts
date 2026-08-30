import type { SidebarNav } from "./viewNavigation";
import type { RecordStatsSearchFilter, ScopeFilter, SearchDateFilter } from "./viewFilters";

export interface KnomoViewStateTransitionEffects {
	closeScopeMenu?: boolean;
	clearCardMenu?: boolean;
}

interface SetScopeResult extends KnomoViewStateTransitionEffects {
	type: "already-active" | "changed";
}

interface SearchStateResult extends KnomoViewStateTransitionEffects {
	type: "changed";
}

interface SidebarNavResult extends KnomoViewStateTransitionEffects {
	type: "already-default" | "changed";
	clearRandomReunion: boolean;
	reloadCatalogQuery: boolean;
	refreshRandomReunion: boolean;
	loadTrashMemos: boolean;
	prepareRecordStats: boolean;
	clearShuffleDay: boolean;
	refreshShuffleDay: boolean;
}

interface ReturnFromRecordStatsResult extends KnomoViewStateTransitionEffects {
	type: "inactive" | "returned";
	returnedNav: Exclude<SidebarNav, "record-stats"> | null;
	reloadCatalogQuery: boolean;
	refreshRandomReunionIfEmpty: boolean;
	loadTrashMemos: boolean;
	refreshShuffleDayIfEmpty: boolean;
}

interface ResetToAllNotesResult extends KnomoViewStateTransitionEffects {
	type: "already-default" | "changed";
	reloadCatalogQuery: boolean;
}

interface RecordStatsReturnState {
	activeNav: Exclude<SidebarNav, "record-stats">;
	scopeFilter: ScopeFilter;
	searchQuery: string;
	searchDateFilter: SearchDateFilter | null;
	recordStatsSearchFilter: RecordStatsSearchFilter | null;
	activeTag: string | null;
	activeTagKey: string | null;
}

export class KnomoViewStateController {
	activeNav: SidebarNav = "all";
	scopeFilter: ScopeFilter = "all";
	searchQuery = "";
	searchDateFilter: SearchDateFilter | null = null;
	recordStatsSearchFilter: RecordStatsSearchFilter | null = null;
	activeTag: string | null = null;
	activeTagKey: string | null = null;
	mobileDrawerOpen = false;
	desktopSearchOpen = false;
	compactSearchOpen = false;

	private recordStatsReturnState: RecordStatsReturnState | null = null;

	isDefaultListState(): boolean {
		return this.activeNav === "all"
			&& this.activeTagKey === null
			&& this.scopeFilter === "all"
			&& this.searchQuery.trim().length === 0
			&& this.searchDateFilter === null
			&& this.recordStatsSearchFilter === null;
	}

	setScope(scope: ScopeFilter): SetScopeResult {
		if (
			this.activeNav === "all" &&
			this.activeTagKey === null &&
			this.scopeFilter === scope &&
			this.searchQuery.trim().length === 0 &&
			this.searchDateFilter === null &&
			this.recordStatsSearchFilter === null
		) {
			this.mobileDrawerOpen = false;
			this.desktopSearchOpen = false;
			return { type: "already-active", closeScopeMenu: true };
		}
		this.clearDesktopSearchState();
		this.scopeFilter = scope;
		this.clearActiveTag();
		this.activeNav = "all";
		this.mobileDrawerOpen = false;
		this.desktopSearchOpen = false;
		return { type: "changed", closeScopeMenu: true };
	}

	setSearchQuery(query: string): SearchStateResult {
		this.searchQuery = query;
		if (query.trim().length > 0 || this.searchDateFilter !== null || this.recordStatsSearchFilter !== null) {
			this.clearActiveTag();
			this.activeNav = "all";
			this.scopeFilter = "all";
		}
		this.activeNav = "all";
		return { type: "changed", clearCardMenu: true };
	}

	setSearchDateFilter(filter: SearchDateFilter): SearchStateResult {
		this.searchDateFilter = this.searchDateFilter === filter ? null : filter;
		this.recordStatsSearchFilter = null;
		this.clearActiveTag();
		this.activeNav = "all";
		this.scopeFilter = "all";
		this.desktopSearchOpen = false;
		this.compactSearchOpen = false;
		return { type: "changed", clearCardMenu: true };
	}

	setSidebarNav(nav: SidebarNav): SidebarNavResult {
		if (nav === "all" && this.isDefaultListState()) {
			this.mobileDrawerOpen = false;
			return {
				type: "already-default",
				closeScopeMenu: true,
				clearCardMenu: true,
				clearRandomReunion: false,
				reloadCatalogQuery: false,
				refreshRandomReunion: false,
				loadTrashMemos: false,
				prepareRecordStats: false,
				clearShuffleDay: false,
				refreshShuffleDay: false,
			};
		}
		const previousNav = this.activeNav;
		if (nav === "record-stats" && previousNav !== "record-stats") {
			this.recordStatsReturnState = {
				activeNav: previousNav,
				scopeFilter: this.scopeFilter,
				searchQuery: this.searchQuery,
				searchDateFilter: this.searchDateFilter,
				recordStatsSearchFilter: this.recordStatsSearchFilter,
				activeTag: this.activeTag,
				activeTagKey: this.activeTagKey,
			};
		} else if (nav !== "record-stats") {
			this.recordStatsReturnState = null;
		}
		this.clearDesktopSearchState();
		this.activeNav = nav;
		this.clearActiveTag();
		this.scopeFilter = "all";
		this.mobileDrawerOpen = false;
		return {
			type: "changed",
			closeScopeMenu: true,
			clearCardMenu: true,
			clearRandomReunion: false,
			clearShuffleDay: false,
			reloadCatalogQuery: nav === "review" || nav === "all",
			refreshRandomReunion: nav === "random",
			refreshShuffleDay: nav === "shuffleDay" && previousNav !== "shuffleDay",
			loadTrashMemos: nav === "trash",
			prepareRecordStats: nav === "record-stats",
		};
	}

	returnFromRecordStats(): ReturnFromRecordStatsResult {
		if (this.activeNav !== "record-stats") {
			return {
				type: "inactive",
				returnedNav: null,
				reloadCatalogQuery: false,
				refreshRandomReunionIfEmpty: false,
				loadTrashMemos: false,
				refreshShuffleDayIfEmpty: false,
			};
		}
		const returnState = this.recordStatsReturnState ?? {
			activeNav: "all",
			scopeFilter: "all",
			searchQuery: "",
			searchDateFilter: null,
			recordStatsSearchFilter: null,
			activeTag: null,
			activeTagKey: null,
		} satisfies RecordStatsReturnState;
		this.recordStatsReturnState = null;
		this.activeNav = returnState.activeNav;
		this.scopeFilter = returnState.scopeFilter;
		this.searchQuery = returnState.searchQuery;
		this.searchDateFilter = returnState.searchDateFilter;
		this.recordStatsSearchFilter = returnState.recordStatsSearchFilter;
		this.activeTag = returnState.activeTag;
		this.activeTagKey = returnState.activeTagKey;
		this.mobileDrawerOpen = false;
		this.desktopSearchOpen = false;
		this.compactSearchOpen = false;
		return {
			type: "returned",
			returnedNav: returnState.activeNav,
			closeScopeMenu: true,
			clearCardMenu: true,
			reloadCatalogQuery: returnState.activeNav === "review",
			refreshRandomReunionIfEmpty: returnState.activeNav === "random",
			loadTrashMemos: returnState.activeNav === "trash",
			refreshShuffleDayIfEmpty: returnState.activeNav === "shuffleDay",
		};
	}

	resetToAllNotes(): ResetToAllNotesResult {
		const isAlreadyDefault = this.isDefaultListState();
		this.clearDesktopSearchState();
		this.clearActiveTag();
		this.activeNav = "all";
		this.scopeFilter = "all";
		this.mobileDrawerOpen = false;
		this.desktopSearchOpen = false;
		this.compactSearchOpen = false;
		return {
			type: isAlreadyDefault ? "already-default" : "changed",
			reloadCatalogQuery: !isAlreadyDefault,
			closeScopeMenu: true,
			clearCardMenu: true,
		};
	}

	clearDesktopSearchState(): void {
		this.searchQuery = "";
		this.searchDateFilter = null;
		this.recordStatsSearchFilter = null;
	}

	clearActiveTag(): void {
		this.activeTag = null;
		this.activeTagKey = null;
	}
}

import type { MemoAction, TrashAction } from "./KnomoActionDispatch";
import {
	getKnomoActionDispatch,
	getMemoActionDispatch,
	getTrashActionDispatch,
	shouldRenderAfterActionDispatch,
	type ComposerToolAction,
} from "./KnomoActionDispatch";
import { getMemoCardOpenRoute, getRootClickRoute } from "./KnomoActionRouter";
import { normalizeTagKey } from "../utils/tags";
import {
	isSearchDateFilter,
	isSidebarNav,
	isTitleMode,
	type SidebarNav,
	type TitleMode,
} from "./viewNavigation";
import type { SearchDateFilter } from "./viewFilters";
import type { TimeBuoyTab } from "./TimeBuoyViewController";

export interface EscapeState {
	mobileSearchPageOpen: boolean;
	composerOpen: boolean;
	editingOrQuoting: boolean;
	hasOpenChrome: boolean;
}

interface KnomoUserActionControllerOptions {
	isMobileLayout: () => boolean;
	isMobileSearchPageOpen: () => boolean;
	isComposerOpen: () => boolean;
	isDrawerOpen: () => boolean;
	getRenderGeneration: () => number;
	hasMoreCardFlowItems: () => boolean;
	shouldDeferCardFlowForAllMemos: () => boolean;
	shouldIgnoreMobileSaveInput: () => boolean;
	getEscapeState: () => EscapeState;
	consumeSuppressedOpenPopupDismissClick: (event: Event) => boolean;
	handleOpenPopupOutsideEvent: (event: Event, target: EventTarget | null, suppressFollowingClick: boolean) => boolean;
	handleCardImageClick: (imageTrigger: HTMLElement) => void;
	toggleTagGroup: (tag: string, element: HTMLElement) => void;
	applyTagFilter: (tag: string, tagKey: string) => void;
	setSidebarNav: (nav: SidebarNav) => void;
	setTitleMode: (mode: TitleMode) => void;
	setSearchDateFilter: (filter: SearchDateFilter, sourceEl: HTMLElement | null) => void;
	setMobileSearchDateFilter: (filter: SearchDateFilter) => void;
	runTrashAction: (action: TrashAction, memoId: string | null) => Promise<void>;
	runMemoAction: (action: MemoAction, memoId: string | null, candidateMemoId: string | null) => Promise<void>;
	shouldIgnoreHandledMobileToolClick: (element: HTMLElement, action: string | null) => boolean;
	openMemoCardDailyNote: (memoId: string, randomReunion: boolean) => Promise<void>;
	closeCardMenu: () => void;
	closeScopeMenu: () => void;
	closeDesktopSearch: () => void;
	closeCompactSearch: () => void;
	toggleCardMenu: (memoId: string | null) => void;
	refreshRandomReunion: () => Promise<void>;
	renderNextCardBatch: (generation: number) => void;
	loadOlderMemoPeriods: () => void;
	loadMoreMobileSearchResults: () => void;
	resetToAllNotes: () => void;
	closeMobileSearchPage: () => void;
	closeComposerKeepingDraft: () => void;
	openDrawer: () => void;
	closeDrawer: () => void;
	ensureSidebarIndexes: () => void;
	toggleScopeMenu: () => void;
	toggleSidebar: () => void;
	collapseSidebar: () => void;
	handleManualRefresh: () => Promise<void>;
	focusStats: () => void;
	returnFromRecordStats: () => void;
	goToPreviousRecordStatsPeriod: () => void;
	goToNextRecordStatsPeriod: () => void;
	retryRecordStats: () => Promise<void>;
	retryTimeBuoy?: () => Promise<void>;
	setTimeBuoyTab?: (tab: TimeBuoyTab) => void;
	loadMoreTimeBuoyCards?: () => void;
	openTimeBuoy?: () => void;
	enableTimeBuoyIntro?: () => Promise<void>;
	dismissTimeBuoyIntro?: () => Promise<void>;
	renderAllMemosLoadingState: () => void;
	ensureAllMemosLoaded: () => Promise<void>;
	setRecordStatsView: (view: "week" | "month" | "year") => void;
	openRecordStatsTrendFilter: (sourceEl: HTMLElement | null) => void;
	openRecordStatsHourFilter: (sourceEl: HTMLElement | null) => void;
	openRecordStatsMetricFilter: (
		type: "range" | "with-tag" | "no-tag" | "with-image" | "references" | "max-daily-notes" | "max-daily-words",
	) => void;
	openRecordStatsTagFilter: (sourceEl: HTMLElement | null) => void;
	openComposer: () => void;
	toggleCompactSearch: () => void;
	runComposerToolAction: (action: ComposerToolAction) => boolean;
	clearReference: () => void;
	cancelEditing: () => void;
	saveInput: () => Promise<void>;
	renderUiState: () => void;
	syncUiChrome: () => void;
	syncCardMenuState: () => void;
	cancelComposerFromEscape: () => void;
	closeOpenChromeFromEscape: () => void;
	initializeCatalogVault?: () => Promise<void>;
	refreshCatalogSyncState?: () => Promise<void>;
	openCatalogSettings?: () => void;
}

export class KnomoUserActionController {
	constructor(private readonly options: KnomoUserActionControllerOptions) {}

	handleRootPointerDown(event: PointerEvent): void {
		if (!this.options.isMobileLayout()) {
			return;
		}
		const target = event.target as Node | null;
		if (target?.instanceOf(Element) && this.isSidebarLayerTarget(target)) {
			return;
		}
		this.options.handleOpenPopupOutsideEvent(event, event.target, true);
	}

	async handleRootClick(event: MouseEvent): Promise<void> {
		const target = event.target as Node | null;
		if (target === null || !target.instanceOf(Element)) {
			return;
		}

		const sidebarLayerTarget = this.isSidebarLayerTarget(target);
		if (!sidebarLayerTarget && this.options.consumeSuppressedOpenPopupDismissClick(event)) {
			return;
		}
		if (!sidebarLayerTarget && this.options.handleOpenPopupOutsideEvent(event, target, false)) {
			return;
		}

		const imageTrigger = target.closest("[data-knomo-card-image]");
		if (imageTrigger?.instanceOf(HTMLElement)) {
			event.preventDefault();
			event.stopPropagation();
			this.options.handleCardImageClick(imageTrigger);
			return;
		}

		const route = getRootClickRoute(target, this.options.isMobileLayout());
		if (route.type === "tag-toggle") {
			event.preventDefault();
			if (route.tag !== null) {
				this.options.toggleTagGroup(route.tag, route.element);
			}
			return;
		}

		if (route.type === "tag") {
			event.preventDefault();
			if (route.tag !== null) {
				const tagKey = route.tagKey ?? normalizeTagKey(route.tag);
				if (tagKey.length > 0) {
					this.options.applyTagFilter(route.tag, tagKey);
				}
			}
			return;
		}

		if (route.type === "nav") {
			if (isSidebarNav(route.nav)) {
				this.options.setSidebarNav(route.nav);
			}
			return;
		}

		if (route.type === "title-mode") {
			if (isTitleMode(route.mode)) {
				this.options.setTitleMode(route.mode);
			}
			return;
		}

		if (route.type === "search-date") {
			if (isSearchDateFilter(route.filter)) {
				if (this.options.isMobileLayout() && this.options.isMobileSearchPageOpen()) {
					this.options.setMobileSearchDateFilter(route.filter);
				} else {
					this.options.setSearchDateFilter(route.filter, route.element);
				}
			}
			return;
		}

		if (route.type === "trash-action") {
			const dispatch = getTrashActionDispatch(route.action);
			if (dispatch.type === "trash-action") {
				await this.options.runTrashAction(dispatch.action, route.memoId);
			}
			return;
		}

		if (route.type === "memo-action") {
			const dispatch = getMemoActionDispatch(route.action);
			if (dispatch.type === "memo-action") {
				await this.options.runMemoAction(dispatch.action, route.memoId, route.candidateMemoId);
			}
			return;
		}

		if (route.type === "action") {
			if (route.action === "initialize-catalog-vault") {
				await this.options.initializeCatalogVault?.();
				return;
			}
			if (route.action === "refresh-catalog-sync-state") {
				await this.options.refreshCatalogSyncState?.();
				return;
			}
			if (route.action === "open-catalog-settings") {
				this.options.openCatalogSettings?.();
				return;
			}
			if (this.options.shouldIgnoreHandledMobileToolClick(route.element, route.action)) {
				return;
			}
			await this.handleAction(route.action, route.memoId, route.element);
			if (route.mobileToolButtonEl !== null) {
				route.mobileToolButtonEl.blur();
			}
			return;
		}

		if (route.type === "memo-card-open") {
			if (route.memoId !== null) {
				await this.options.openMemoCardDailyNote(route.memoId, route.randomReunion);
			}
			return;
		}

		if (sidebarLayerTarget) {
			return;
		}
		if (route.closeCardMenu) {
			this.options.closeCardMenu();
		}
		if (route.closeScopeMenu) {
			this.options.closeScopeMenu();
		}
		if (route.closeDesktopSearch) {
			this.options.closeDesktopSearch();
		}
		if (route.closeCompactSearch) {
			this.options.closeCompactSearch();
		}
	}

	private isSidebarLayerTarget(target: Element): boolean {
		const actionEl = target.closest("[data-action]");
		if (actionEl?.instanceOf(HTMLElement)) {
			const action = actionEl.getAttr("data-action");
			if (
				action === "open-drawer" ||
				action === "close-drawer" ||
				action === "toggle-sidebar" ||
				action === "collapse-sidebar"
			) {
				return true;
			}
		}
		return this.options.isDrawerOpen() && target.closest(".knomo-sidebar, .knomo-drawer-backdrop") !== null;
	}

	async handleAction(
		action: string | null,
		memoId: string | null,
		sourceEl: HTMLElement | null = null,
	): Promise<void> {
		const dispatch = getKnomoActionDispatch(action);
		switch (dispatch.type) {
			case "none":
				return;
			case "toggle-card-menu":
				this.options.toggleCardMenu(memoId);
				return;
			case "refresh-random-reunion":
				await this.options.refreshRandomReunion();
				return;
			case "load-more":
				if (this.options.hasMoreCardFlowItems()) {
					this.options.renderNextCardBatch(this.options.getRenderGeneration());
				} else {
					this.options.loadOlderMemoPeriods();
				}
				return;
			case "load-more-mobile-search":
				this.options.loadMoreMobileSearchResults();
				return;
			case "reset-list-state":
				this.options.resetToAllNotes();
				return;
			case "close-mobile-search":
				this.options.closeMobileSearchPage();
				return;
			case "open-drawer":
				if (this.options.isComposerOpen()) {
					this.options.closeComposerKeepingDraft();
				}
				this.options.openDrawer();
				this.options.ensureSidebarIndexes();
				break;
			case "close-drawer":
				this.options.closeDrawer();
				break;
			case "toggle-scope-menu":
				this.options.toggleScopeMenu();
				break;
			case "toggle-sidebar":
				this.options.toggleSidebar();
				break;
			case "collapse-sidebar":
				this.options.collapseSidebar();
				break;
			case "refresh":
				await this.options.handleManualRefresh();
				return;
			case "focus-stats":
				this.options.focusStats();
				break;
			case "record-stats-back":
				this.options.returnFromRecordStats();
				return;
			case "record-stats-previous":
				this.options.goToPreviousRecordStatsPeriod();
				return;
			case "record-stats-next":
				this.options.goToNextRecordStatsPeriod();
				return;
			case "record-stats-retry":
				await this.options.retryRecordStats();
				return;
			case "retry-time-buoy":
				await this.options.retryTimeBuoy?.();
				return;
			case "time-buoy-tab-today":
				this.options.setTimeBuoyTab?.("today");
				return;
			case "time-buoy-tab-upcoming":
				this.options.setTimeBuoyTab?.("upcoming");
				return;
			case "time-buoy-tab-past":
				this.options.setTimeBuoyTab?.("past");
				return;
			case "load-more-time-buoy-cards":
				this.options.loadMoreTimeBuoyCards?.();
				return;
			case "open-time-buoy":
				this.options.openTimeBuoy?.();
				return;
			case "enable-time-buoy-intro":
				await this.options.enableTimeBuoyIntro?.();
				return;
			case "dismiss-time-buoy-intro":
				await this.options.dismissTimeBuoyIntro?.();
				return;
			case "retry-all-memos":
				if (!this.options.shouldDeferCardFlowForAllMemos()) {
					return;
				}
				this.options.renderAllMemosLoadingState();
				await this.options.ensureAllMemosLoaded();
				return;
			case "record-stats-view-week":
				this.options.setRecordStatsView("week");
				return;
			case "record-stats-view-month":
				this.options.setRecordStatsView("month");
				return;
			case "record-stats-view-year":
				this.options.setRecordStatsView("year");
				return;
			case "record-stats-filter-trend":
				this.options.openRecordStatsTrendFilter(sourceEl);
				return;
			case "record-stats-filter-hour":
				this.options.openRecordStatsHourFilter(sourceEl);
				return;
			case "record-stats-filter-notes":
				this.options.openRecordStatsMetricFilter("range");
				return;
			case "record-stats-filter-with-tag":
				this.options.openRecordStatsMetricFilter("with-tag");
				return;
			case "record-stats-filter-no-tag":
				this.options.openRecordStatsMetricFilter("no-tag");
				return;
			case "record-stats-filter-with-image":
				this.options.openRecordStatsMetricFilter("with-image");
				return;
			case "record-stats-filter-tag":
				this.options.openRecordStatsTagFilter(sourceEl);
				return;
			case "record-stats-filter-references":
				this.options.openRecordStatsMetricFilter("references");
				return;
			case "record-stats-filter-max-daily-notes":
				this.options.openRecordStatsMetricFilter("max-daily-notes");
				return;
			case "record-stats-filter-max-daily-words":
				this.options.openRecordStatsMetricFilter("max-daily-words");
				return;
			case "open-composer":
				this.options.openComposer();
				return;
			case "toggle-compact-search":
				this.options.toggleCompactSearch();
				break;
			case "composer-tool":
				if (this.options.runComposerToolAction(dispatch.action)) {
					return;
				}
				break;
			case "clear-reference":
				this.options.clearReference();
				return;
			case "cancel-edit":
				this.options.cancelEditing();
				return;
			case "save-input":
				if (this.options.shouldIgnoreMobileSaveInput()) {
					return;
				}
				await this.options.saveInput();
				return;
			case "unknown":
				break;
		}
		if (shouldRenderAfterActionDispatch(dispatch)) {
			if (dispatch.type === "unknown") {
				this.options.renderUiState();
			} else {
				this.options.syncUiChrome();
				this.options.syncCardMenuState();
			}
		}
	}

	async handleRootKeydown(event: KeyboardEvent): Promise<void> {
		if ((event.ctrlKey || event.metaKey) && event.key === "\\") {
			event.preventDefault();
			this.options.toggleSidebar();
			return;
		}
		const target = event.target as Node | null;
		if ((event.key === "Enter" || event.key === " ") && target?.instanceOf(Element)) {
			const memoCardOpenRoute = getMemoCardOpenRoute(target);
			if (memoCardOpenRoute !== null) {
				if (memoCardOpenRoute.memoId !== null) {
					event.preventDefault();
					await this.options.openMemoCardDailyNote(memoCardOpenRoute.memoId, memoCardOpenRoute.randomReunion);
				}
				return;
			}
		}
		if (event.key !== "Escape") {
			return;
		}
		const state = this.options.getEscapeState();
		if (state.mobileSearchPageOpen) {
			event.preventDefault();
			this.options.closeMobileSearchPage();
			return;
		}
		if (state.composerOpen) {
			event.preventDefault();
			this.options.closeComposerKeepingDraft();
			return;
		}
		if (state.editingOrQuoting) {
			event.preventDefault();
			this.options.cancelComposerFromEscape();
			return;
		}
		if (state.hasOpenChrome) {
			event.preventDefault();
			this.options.closeOpenChromeFromEscape();
		}
	}
}

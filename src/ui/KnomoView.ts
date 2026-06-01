import { AbstractInputSuggest, getAllTags, ItemView, Keymap, MarkdownRenderer, Notice, Platform, prepareFuzzySearch, renderResults, Scope, setIcon } from "obsidian";
import type { App, HoverPopover, SearchResult, WorkspaceLeaf } from "obsidian";

import { KNOMO_VIEW_DISPLAY_TEXT, KNOMO_VIEW_TYPE } from "../constants";
import { KNOMO_ALL_NOTES_ICON, KNOMO_LOGO_ICON, KNOMO_RANDOM_REUNION_ICON, KNOMO_SEARCH_ICON, KNOMO_SIDEBAR_MENU_ICON } from "../icons";
import { t } from "../i18n";
import type { RandomReunionService } from "../services/RandomReunionService";
import type { ReferenceService } from "../services/ReferenceService";
import type { SettingsService } from "../services/SettingsService";
import type { SyncOrchestrator } from "../services/SyncOrchestrator";
import type { ScanDailyMemosResult } from "../services/MemoScanService";
import type { MemoRecord } from "../types/memo";
import type { MobileCompactMode } from "../types/settings";
import { applyListFormatToText, getHashInsertionText, getListEnterPatch, getListEnterPatchForNativeInput, getTagQueryAtCursor, replaceTagQueryWithSuggestion } from "../utils/composerInput";
import type { TextReplacement } from "../utils/composerInput";
import { formatDatePart } from "../utils/date";
import { parseDailyNoteDateFromPath } from "../utils/dailyNotes";
import { isSupportedMemoImage } from "../utils/markdown";
import { buildQuoteCreatedMemoContent, stripTrailingWikiLink, withMemoIdAlias } from "../utils/references";
import { formatSettingsText } from "./KnomoSettingTab";
import { MobileNavbarCompactController } from "./MobileNavbarCompactController";
import { buildTagTree } from "../utils/tagTree";
import type { TagSummary, TagTreeNode } from "../utils/tagTree";
import { buildTagDisplayMap, normalizeTagDisplay, normalizeTagKey } from "../utils/tags";
import type { TagDisplaySource } from "../utils/tags";

type ScopeFilter =
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

type SidebarNav = "all" | "wechat" | "review" | "ai" | "random" | "trash";

interface ScopeOption {
	filter: ScopeFilter;
	label: string;
	icon: string;
}

type SearchDateFilter = "week" | "month" | "last-7" | "last-30" | "last-week" | "last-month";
type TitleMode = "all" | "no-tag" | "with-link" | "with-image" | "anniversary" | "review" | "random";

interface SearchDateOption {
	filter: SearchDateFilter;
	label: string;
	mobileLabel?: string;
	icon: string;
}

interface TitleModeOption {
	mode: TitleMode;
	label: string;
	icon: string;
	nav?: SidebarNav;
	scope?: ScopeFilter;
}

interface SidebarNavItem {
	nav: SidebarNav;
	label: string;
	icon: string;
}

interface TitleHost {
	el: HTMLElement;
	mobile: boolean;
}

interface SidebarDragState {
	pointerId: number;
	startX: number;
	startWidth: number;
}

interface FilteredMemosCache {
	memos: MemoRecord[];
	activeTagKey: string | null;
	activeNav: SidebarNav;
	scopeFilter: ScopeFilter;
	searchQuery: string;
	searchDateFilter: SearchDateFilter | null;
	todayKey: string;
	result: MemoRecord[];
}

const SIDEBAR_MIN_WIDTH = 210;
const SIDEBAR_MAX_WIDTH = 300;
const RANDOM_REUNION_DEFAULT_COUNT = 5;
const CARD_BATCH_SIZE = 50;
const MOBILE_SEARCH_BATCH_SIZE = 30;
const INITIAL_VISIBLE_RENDER_COUNT = 16;
const MARKDOWN_RENDER_CONCURRENCY = 8;
const SEARCH_DEBOUNCE_MS = 220;
const MOBILE_COMPOSER_TOP_GUARD = 52;
const MOBILE_VIEW_HEADER_SELECTORS = [
	".workspace-leaf.mod-active .view-header",
	".mod-active .view-header",
	".view-header",
];

const SIDEBAR_NAV_ITEMS: SidebarNavItem[] = [
	{ nav: "all", label: t("nav.allNotes"), icon: KNOMO_ALL_NOTES_ICON },
	{ nav: "review", label: t("nav.review"), icon: "calendar-check" },
	{ nav: "random", label: t("nav.random"), icon: KNOMO_RANDOM_REUNION_ICON },
];

const TRASH_NAV_ITEM: SidebarNavItem = { nav: "trash", label: t("nav.trash"), icon: "trash-2" };

const TITLE_SCOPE_OPTIONS: ScopeOption[] = [
	{ filter: "all", label: t("nav.allNotes"), icon: KNOMO_ALL_NOTES_ICON },
	{ filter: "no-tag", label: t("filter.noTag"), icon: "tag" },
	{ filter: "with-link", label: t("filter.withLink"), icon: "link" },
	{ filter: "with-image", label: t("filter.withImage"), icon: "image" },
	{ filter: "anniversary", label: t("filter.anniversary"), icon: "history" },
];

const TITLE_MODE_OPTIONS: TitleModeOption[] = [
	{ mode: "all", label: t("nav.allNotes"), icon: KNOMO_ALL_NOTES_ICON, scope: "all" },
	{ mode: "no-tag", label: t("filter.noTag"), icon: "tag", scope: "no-tag" },
	{ mode: "with-link", label: t("filter.withLink"), icon: "link", scope: "with-link" },
	{ mode: "with-image", label: t("filter.withImage"), icon: "image", scope: "with-image" },
	{ mode: "anniversary", label: t("filter.anniversary"), icon: "history", scope: "anniversary" },
	{ mode: "review", label: t("nav.review"), icon: "calendar-check", nav: "review" },
	{ mode: "random", label: t("nav.random"), icon: KNOMO_RANDOM_REUNION_ICON, nav: "random" },
];

const SEARCH_DATE_OPTIONS: SearchDateOption[] = [
	{ filter: "week", label: t("date.week"), icon: "calendar-days" },
	{ filter: "month", label: t("date.month"), icon: "calendar-range" },
	{ filter: "last-7", label: t("date.last7"), mobileLabel: t("date.last7Mobile"), icon: "calendar-clock" },
	{ filter: "last-30", label: t("date.last30"), mobileLabel: t("date.last30Mobile"), icon: "calendar-clock" },
	{ filter: "last-week", label: t("date.lastWeek"), icon: "calendar-minus" },
	{ filter: "last-month", label: t("date.lastMonth"), icon: "calendar-minus" },
];

type LayoutMode = "desktop-wide" | "desktop-medium" | "desktop-narrow" | "mobile";
type ComposerMode = "create" | "edit" | "quote";
type MobileComposerPhase = "closed" | "opening" | "focusing" | "open" | "closing";
type CardFlowRenderMode = "memo" | "trash";
type MarkdownRenderPriority = "high" | "normal";
type WindowWithIntersectionObserver = Window & {
	IntersectionObserver?: typeof IntersectionObserver;
};

interface MarkdownRenderTask {
	generation: number;
	run: () => Promise<void>;
}

interface PendingMobileListEnterCorrection {
	patch: TextReplacement;
	nativeValue: string;
}

interface HandledMobileToolPointer {
	button: HTMLElement;
	action: string;
}

const ALL_SCOPE_OPTIONS = TITLE_SCOPE_OPTIONS;
let nextA11yId = 0;

export class KnomoView extends ItemView {
	private readonly a11yIdPrefix = `knomo-view-${nextA11yId += 1}`;
	hoverPopover: HoverPopover | null = null;
	private rootEl: HTMLElement | null = null;
	private sidebarEl: HTMLElement | null = null;
	private titleHosts: TitleHost[] = [];
	private statsEls: HTMLElement[] = [];
	private allTagsEl: HTMLElement | null = null;
	private cardFlowEl: HTMLElement | null = null;
	private trashCountEls: HTMLElement[] = [];
	private inputEl: HTMLTextAreaElement | null = null;
	private tagSuggest: KnomoTagSuggest | null = null;
	private sendButtonEl: HTMLButtonElement | null = null;
	private cancelEditButtonEl: HTMLButtonElement | null = null;
	private statusEl: HTMLElement | null = null;
	private referencePreviewEl: HTMLElement | null = null;
	private composerEl: HTMLElement | null = null;
	private composerBarEl: HTMLElement | null = null;
	private desktopSearchInputEl: HTMLInputElement | null = null;
	private compactInlineSearchInputEl: HTMLInputElement | null = null;
	private compactSearchInputEl: HTMLInputElement | null = null;
	private mobileSearchHeaderActionEl: HTMLElement | null = null;
	private mobileHeaderTitleEl: HTMLElement | null = null;
	private mobileHeaderTitleRegisteredEl: HTMLElement | null = null;
	private mobileHeaderTitleOriginalText: string | null = null;
	private mobileSearchPageEl: HTMLElement | null = null;
	private mobileSearchInputEl: HTMLInputElement | null = null;
	private mobileSearchResultsEl: HTMLElement | null = null;
	private sidebarResizerEl: HTMLElement | null = null;
	private mobileVisualViewport: VisualViewport | null = null;
	private mobileVisualViewportHandler: (() => void) | null = null;
	private memos: MemoRecord[] = [];
	private cardFlowError: string | null = null;
	private allMemosLoaded = false;
	private allMemosLoadingPromise: Promise<boolean> | null = null;
	private scopeFilter: ScopeFilter = "all";
	private searchQuery = "";
	private searchDateFilter: SearchDateFilter | null = null;
	private mobileSearchQuery = "";
	private mobileSearchDateFilter: SearchDateFilter | null = null;
	private mobileSearchVisibleCount = MOBILE_SEARCH_BATCH_SIZE;
	private activeTag: string | null = null;
	private activeTagKey: string | null = null;
	private expandedTagGroups = new Set<string>();
	private activeNav: SidebarNav = "all";
	private sidebarCollapsed = false;
	private sidebarWidth = 248;
	private mobileDrawerOpen = false;
	private desktopSearchOpen = false;
	private scopeMenuOpen = false;
	private composerOpen = false;
	private mobileComposerInputFocused = false;
	private compactSearchOpen = false;
	private mobileSearchPageOpen = false;
	private editingMemo: MemoRecord | null = null;
	private quoteSourceMemoId: string | null = null;
	private quoteReferenceText: string | null = null;
	private quoteMarkdownText: string | null = null;
	private activeMenuMemoId: string | null = null;
	private draftContent = "";
	private isSaving = false;
	private composerSaveShortcutDown = false;
	private sidebarDrag: SidebarDragState | null = null;
	private currentLayout: LayoutMode = "desktop-wide";
	private layoutObserver: ResizeObserver | null = null;
	private filteredMemosCache: FilteredMemosCache | null = null;
	private dateChangeTimeoutId: number | null = null;
	private randomReunionMemos: MemoRecord[] | null = null;
	private randomReunionLoading = false;
	private trashMemos: MemoRecord[] | null = null;
	private trashLoading = false;
	private trashError: string | null = null;
	private trashCount = 0;
	private deletedMemoIds = new Set<string>();
	private trashBusyMemoActions = new Map<string, "restore" | "purge">();
	private currentFeedItems: MemoRecord[] = [];
	private currentRenderOffset = 0;
	private feedRenderMode: CardFlowRenderMode = "memo";
	private isLoadingMore = false;
	private hasMoreFeedItems = false;
	private loadMoreObserver: IntersectionObserver | null = null;
	private loadMoreSentinelEl: HTMLElement | null = null;
	private highPriorityMarkdownQueue: MarkdownRenderTask[] = [];
	private normalPriorityMarkdownQueue: MarkdownRenderTask[] = [];
	private activeMarkdownRenderCount = 0;
	private memoSearchTextCache = new Map<string, string>();
	private memoSearchCacheSource: MemoRecord[] | null = null;
	private searchDebounceTimeoutId: number | null = null;
	private mobileSearchDebounceTimeoutId: number | null = null;
	private mobileComposerFocusFrameId: number | null = null;
	private mobileComposerFocusTimerId: number | null = null;
	private mobileComposerResizeFrameId: number | null = null;
	private mobileViewportFrameId: number | null = null;
	private mobileKeyboardFocusStartedAt: number | null = null;
	private mobileWindowResizeHandler: (() => void) | null = null;
	private mobileOrientationChangeHandler: (() => void) | null = null;
	private mobileComposerPhase: MobileComposerPhase = "closed";
	private mobileKeyboardHeight = 0;
	private mobileComposerViewportBaselineHeight: number | null = null;
	private mobileComposerInputMaxHeight: number | null = null;
	private mobileKeyboardMeasureTimers: number[] = [];
	private mobileComposerCloseTimer: number | null = null;
	private lastMobileSendPointerAt = 0;
	private pendingMobileListEnterCorrection: PendingMobileListEnterCorrection | null = null;
	private listEnterKeydownPatch: TextReplacement | null = null;
	private listEnterKeydownPatchTimerId: number | null = null;
	private skipListEnterInputFallback = false;
	private skipListEnterInputFallbackTimerId: number | null = null;
	private handledMobileToolPointer: HandledMobileToolPointer | null = null;
	private handledMobileToolPointerTimerId: number | null = null;
	private mobileComposerLayerEl: HTMLElement | null = null;
	private mobileComposerBackdropEl: HTMLElement | null = null;
	private mobileComposerContentEl: HTMLElement | null = null;
	private mobileComposerHomeEl: HTMLElement | null = null;
	private mobileComposerNextSibling: ChildNode | null = null;
	private mobileComposerOpenScrollTop: number | null = null;
	private mobileNavbarCompactController: MobileNavbarCompactController | null = null;
	private renderGeneration = 0;

	constructor(
		leaf: WorkspaceLeaf,
		private readonly settingsService: SettingsService,
		private readonly syncOrchestrator: SyncOrchestrator,
		private readonly referenceService: ReferenceService,
		private readonly randomReunionService: RandomReunionService,
		private readonly onMemosChanged: () => Promise<void>,
		private readonly onManualRefresh: () => Promise<ScanDailyMemosResult>,
	) {
		super(leaf);
		this.scope = new Scope(this.app.scope);
		this.scope.register(["Mod"], "Enter", (event) => {
			if (this.handleComposerSaveShortcut(event)) {
				return false;
			}
		});
	}

	getViewType(): string {
		return KNOMO_VIEW_TYPE;
	}

	getDisplayText(): string {
		return KNOMO_VIEW_DISPLAY_TEXT;
	}

	getIcon(): string {
		return KNOMO_LOGO_ICON;
	}

	async onOpen(): Promise<void> {
		this.contentEl.addClass("knomo-view-host");
		await this.render();
		this.mobileNavbarCompactController = new MobileNavbarCompactController(this, {
			isActive: () => this.app.workspace.getActiveViewOfType(KnomoView) === this,
			isComposerOpen: () => this.composerOpen,
			toggleSidebar: () => this.toggleSidebar(),
			openComposer: () => this.openComposer(),
		});
		this.mobileNavbarCompactController.start();
		this.startLayoutObserver();
		this.startDateChangeWatcher();
	}

	async onClose(): Promise<void> {
		this.mobileNavbarCompactController?.stop();
		this.mobileNavbarCompactController = null;
		this.tagSuggest?.close();
		this.tagSuggest = null;
		this.clearSearchDebounce();
		this.clearMobileSearchDebounce();
		this.clearMobileComposerFocus();
		this.clearMobileComposerResizeFrame();
		this.clearMobileComposerCloseTimer();
		this.clearMobileKeyboardMeasureTimers();
		this.clearListEnterKeydownPatch();
		this.clearSkipListEnterInputFallback();
		this.clearHandledMobileToolPointer();
		this.pendingMobileListEnterCorrection = null;
		this.stopMobileViewportTracking();
		this.removeMobileComposerLayer();
		this.removeMobileSearchPage();
		this.containerEl.doc.body.removeClass("knomo-mobile-search-active");
		this.removeMobileHeaderTitle();
		this.removeMobileHeaderActions();
		this.stopDateChangeWatcher();
		this.stopLayoutObserver();
		this.disconnectLoadMoreObserver();
		this.renderGeneration += 1;
		this.clearMarkdownRenderQueue();
		this.contentEl.removeClass("knomo-view-host");
	}

	async refresh(): Promise<void> {
		if (this.activeNav === "trash") {
			await this.loadTrashMemos();
			return;
		}
		await this.waitForAllMemosLoading();
		await this.reloadMemos(this.allMemosLoaded);
		void this.refreshTrashCount(false);
		if (this.activeNav === "random") {
			await this.refreshRandomReunionMemos();
		}
	}

	async reloadAllMemosAfterImport(): Promise<boolean> {
		const loaded = await this.ensureAllMemosLoaded(true);
		if (!loaded) {
			return false;
		}
		return true;
	}

	private async render(): Promise<void> {
		const container = this.contentEl;
		container.empty();
		this.titleHosts = [];
		this.statsEls = [];
		this.trashCountEls = [];
		this.tagSuggest?.close();
		this.tagSuggest = null;

		const settings = this.settingsService.getSettings();
		this.sidebarWidth = clamp(settings.desktopSidebarWidth, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH);
		this.sidebarCollapsed = settings.desktopSidebarCollapsed;

		const root = container.createDiv({ cls: "knomo-plugin knomo-view" });
		this.rootEl = root;

		const drawerBackdrop = root.createDiv({
			cls: "knomo-drawer-backdrop",
			attr: { "data-action": "close-drawer" },
		});
		drawerBackdrop.setAttr("aria-hidden", "true");

		const shell = root.createDiv({ cls: "knomo-shell" });
		this.sidebarEl = shell.createDiv({ cls: "knomo-sidebar" });
		this.renderSidebar(this.sidebarEl);

		const main = shell.createDiv({ cls: "knomo-main" });
		this.renderCompactHeader(main);
		this.renderCompactSearchPanel(main);
		const contentColumn = main.createDiv({ cls: "knomo-content-column" });
		this.renderDesktopTopbar(contentColumn);
		this.renderScopePopover(contentColumn);
		this.renderComposer(contentColumn);
		this.cardFlowEl = contentColumn.createDiv({
			cls: "knomo-card-flow",
		});
		this.registerDomEvent(this.cardFlowEl, "scroll", () => this.handleCardFlowScroll());
		this.registerDomEvent(this.cardFlowEl, "mouseover", (event) => {
			this.handleMarkdownInternalLinkHover(event);
		});
		this.registerDomEvent(this.cardFlowEl, "click", (event) => {
			void this.handleMarkdownInternalLinkClick(event);
		});

		this.registerDomEvent(root, "click", (event) => {
			void this.handleRootClick(event);
		});
		this.registerDomEvent(root, "keydown", (event) => {
			void this.handleRootKeydown(event);
		});

		this.renderScopeState();
		this.syncRootState();
		await this.ensureAllMemosLoaded(true);
		void this.refreshTrashCount(false);
	}

	private renderSidebar(sidebar: HTMLElement): void {
		const header = sidebar.createDiv({ cls: "knomo-sidebar-header" });
		const brand = header.createDiv({ cls: "knomo-brand" });
		brand.createDiv({ cls: "knomo-brand-title", text: "Knomo" });
		brand.createDiv({ cls: "knomo-brand-subtitle", text: t("sidebar.subtitle") });
		const actions = header.createDiv({ cls: "knomo-sidebar-actions" });
		this.createIconButton(actions, "bar-chart-3", t("sidebar.stats"), "knomo-sidebar-action", "focus-stats");
		this.createIconButton(actions, "refresh-cw", t("sidebar.refresh"), "knomo-sidebar-action", "refresh");
		this.createIconButton(actions, "panel-left-close", t("sidebar.hide"), "knomo-sidebar-action knomo-desktop-only", "collapse-sidebar");

		const statsLabelId = this.createHiddenText(sidebar, "stats-label", t("sidebar.stats"));
		const stats = sidebar.createDiv({ cls: "knomo-sidebar-stats", attr: { "aria-labelledby": statsLabelId, tabindex: "-1" } });
		this.statsEls.push(stats);

		const navLabelId = this.createHiddenText(sidebar, "nav-label", t("sidebar.scope"));
		const nav = sidebar.createEl("nav", {
			cls: "knomo-nav",
			attr: { "aria-labelledby": navLabelId },
		});
		for (const item of SIDEBAR_NAV_ITEMS) {
			this.renderSidebarNavButton(nav, item);
		}

		const allTagSection = sidebar.createDiv({ cls: "knomo-tag-section" });
		allTagSection.createDiv({ cls: "knomo-section-label", text: t("sidebar.allTags") });
		this.allTagsEl = allTagSection.createDiv({ cls: "knomo-tag-list" });

		const trashSection = sidebar.createDiv({ cls: "knomo-trash-section" });
		const trashButton = this.renderSidebarNavButton(trashSection, TRASH_NAV_ITEM);
		trashButton.addClass("knomo-trash-nav-button");
		this.trashCountEls.push(trashButton.createSpan({ cls: "knomo-trash-count" }));

		const resizerLabelId = this.createHiddenText(sidebar, "resizer-label", t("sidebar.resize"));
		this.sidebarResizerEl = sidebar.createDiv({
			cls: "knomo-sidebar-resizer knomo-desktop-only",
			attr: {
				role: "separator",
				"aria-orientation": "vertical",
				"aria-labelledby": resizerLabelId,
				"aria-valuemin": String(SIDEBAR_MIN_WIDTH),
				"aria-valuemax": String(SIDEBAR_MAX_WIDTH),
				tabindex: "0",
			},
		});
		this.registerDomEvent(this.sidebarResizerEl, "pointerdown", (event) => this.startSidebarResize(event));
		this.registerDomEvent(this.sidebarResizerEl, "pointermove", (event) => this.resizeSidebar(event));
		this.registerDomEvent(this.sidebarResizerEl, "pointerup", (event) => this.stopSidebarResize(event));
		this.registerDomEvent(this.sidebarResizerEl, "pointercancel", (event) => this.stopSidebarResize(event));
		this.registerDomEvent(this.sidebarResizerEl, "keydown", (event) => {
			if (event.key === "ArrowLeft") {
				event.preventDefault();
				this.setSidebarWidth(this.sidebarWidth - 8, true);
			} else if (event.key === "ArrowRight") {
				event.preventDefault();
				this.setSidebarWidth(this.sidebarWidth + 8, true);
			}
		});
	}

	private renderDesktopTopbar(main: HTMLElement): void {
		const topbar = main.createDiv({ cls: "knomo-topbar" });
		this.createIconButton(topbar, KNOMO_SIDEBAR_MENU_ICON, t("sidebar.show"), "knomo-sidebar-toggle", "toggle-sidebar");

		const scopeWrap = topbar.createDiv({ cls: "knomo-scope-wrap" });
		const titleHost = scopeWrap.createDiv({ cls: "knomo-title-host" });
		this.titleHosts.push({ el: titleHost, mobile: false });
		const popover = scopeWrap.createDiv({ cls: "knomo-scope-popover knomo-desktop-scope-popover", attr: { role: "menu" } });
		for (const option of TITLE_MODE_OPTIONS) {
			this.renderTitleModeButton(popover, option, "knomo-scope-option");
		}

		const searchWrap = topbar.createDiv({ cls: "knomo-search-wrap" });
		setIcon(searchWrap.createSpan({ cls: "knomo-search-icon" }), KNOMO_SEARCH_ICON);
		const desktopSearchLabelId = this.createHiddenText(searchWrap, "desktop-search-label", t("search.label"));
		this.desktopSearchInputEl = searchWrap.createEl("input", {
			cls: "knomo-search-input",
			attr: {
				type: "search",
				placeholder: t("search.label"),
				"aria-labelledby": desktopSearchLabelId,
			},
		});
		this.registerDomEvent(this.desktopSearchInputEl, "focus", () => this.openDesktopSearch());
		this.registerDomEvent(this.desktopSearchInputEl, "click", () => this.openDesktopSearch());
		this.registerDomEvent(this.desktopSearchInputEl, "input", () => {
			this.queueSearchQuery(this.desktopSearchInputEl?.value ?? "");
		});
		this.registerDomEvent(this.desktopSearchInputEl, "keydown", (event) => {
			if (event.key === "Escape") {
				this.desktopSearchOpen = false;
				this.syncRootState();
				this.desktopSearchInputEl?.blur();
			}
		});

		this.renderSearchPopover(searchWrap);
	}

	private renderScopePopover(main: HTMLElement): void {
		const mobilePopover = main.createDiv({ cls: "knomo-scope-popover knomo-mobile-scope-popover", attr: { role: "menu" } });
		for (const option of TITLE_MODE_OPTIONS) {
			this.renderTitleModeButton(mobilePopover, option, "knomo-scope-option");
		}
	}

	private renderSearchPopover(container: HTMLElement): void {
		const searchMenu = container.createDiv({ cls: "knomo-search-menu", attr: { role: "menu" } });
		for (const option of SEARCH_DATE_OPTIONS) {
			this.renderSearchDateButton(searchMenu, option, "knomo-search-menu-option");
		}
	}

	private renderComposer(main: HTMLElement): void {
		const dailyStatus = this.syncOrchestrator.getDailyNotesStatus();
		const composer = main.createDiv({ cls: "knomo-composer" });
		this.composerEl = composer;
		this.registerDomEvent(composer, "click", (event) => {
			if (this.isMobileComposerLayered()) {
				void this.handleRootClick(event);
			}
		});
		this.registerDomEvent(composer, "keydown", (event) => {
			if (this.isMobileComposerLayered()) {
				void this.handleRootKeydown(event);
			}
		});
		const inputArea = composer.createDiv({ cls: "knomo-composer-input-area" });
		const composerInputLabelId = this.createHiddenText(inputArea, "composer-input-label", t("composer.inputLabel"));
		this.inputEl = inputArea.createEl("textarea", {
			cls: "knomo-composer-input",
			attr: {
				placeholder: t("composer.placeholder"),
				"aria-labelledby": composerInputLabelId,
			},
		});
		this.inputEl.disabled = !dailyStatus.enabled;
		this.inputEl.value = this.draftContent;
		this.registerDomEvent(this.inputEl, "beforeinput", (event: InputEvent) => {
			this.handleComposerBeforeInput(event);
		});
		this.registerDomEvent(this.inputEl, "input", (event) => {
			this.handleComposerInput(event);
		});
		this.registerDomEvent(this.inputEl, "focus", () => {
			this.handleComposerInputFocus();
		});
		this.registerDomEvent(this.inputEl, "blur", () => {
			this.handleComposerInputBlur();
		});
		this.tagSuggest = new KnomoTagSuggest(this.app, this.inputEl, () => this.syncInputState());
		this.registerDomEvent(this.inputEl, "keydown", (event) => {
			if (this.handleComposerSaveShortcut(event)) {
				return;
			}
			if (this.currentLayout === "mobile") {
				return;
			}
			if (event.key === "Enter" && event.shiftKey && !event.isComposing) {
				this.markSkipListEnterInputFallback();
				return;
			}
			this.handleListEnterKeydown(event);
		}, { capture: true });
		this.registerDomEvent(this.inputEl, "keydown", (event) => {
			this.handleComposerKeydown(event);
		});
		this.registerDomEvent(this.inputEl, "keyup", (event) => {
			this.handleComposerKeyup(event);
		});

		this.referencePreviewEl = inputArea.createDiv({ cls: "knomo-reference-preview" });
		const composerBar = inputArea.createDiv({ cls: "knomo-composer-bar" });
		this.composerBarEl = composerBar;
		const tools = composerBar.createDiv({ cls: "knomo-tool-group" });
		this.registerDomEvent(tools, "pointerdown", (event) => this.handleComposerToolPointerDown(event));
		this.registerDomEvent(tools, "mousedown", (event) => this.handleComposerToolPointerDown(event));
		this.createIconButton(tools, "hash", t("composer.insertTag"), "knomo-tool-button", "insert-tag", false);
		this.createIconButton(tools, "image", t("composer.insertImage"), "knomo-tool-button", "insert-image", false);
		this.createIconButton(tools, "list", t("composer.insertList"), "knomo-tool-button", "insert-list", false);
		this.createIconButton(tools, "list-ordered", t("composer.insertNumberedList"), "knomo-tool-button", "insert-numbered-list", false);
		const actions = composerBar.createDiv({ cls: "knomo-composer-actions" });
		this.cancelEditButtonEl = actions.createEl("button", {
			cls: "knomo-cancel-edit-button",
			text: t("composer.cancelEdit"),
			attr: {
				type: "button",
				"data-action": "cancel-edit",
				hidden: "",
			},
		});
		this.statusEl = composer.createDiv({
			cls: dailyStatus.enabled ? "knomo-status" : "knomo-status is-error",
		});
		this.sendButtonEl = actions.createEl("button", {
			cls: "knomo-send-button",
			attr: {
				type: "button",
				"aria-label": t("composer.send"),
				"data-action": "save-input",
			},
		});
		setIcon(this.sendButtonEl, "send");
		this.registerDomEvent(this.sendButtonEl, "pointerdown", (event) => {
			this.handleSendPointerDown(event);
		});
		this.registerDomEvent(this.sendButtonEl, "mousedown", (event) => {
			this.handleSendPointerDown(event);
		});
		this.updateSendButtonState();
	}

	private renderTitleModeButton(container: HTMLElement, option: TitleModeOption, cls: string): HTMLButtonElement {
		const button = container.createEl("button", {
			cls,
			attr: {
				type: "button",
				"aria-pressed": "false",
				"data-title-mode": option.mode,
			},
		});
		setIcon(button.createSpan({ cls: "knomo-button-icon" }), option.icon);
		button.createSpan({ cls: "knomo-button-label", text: option.label });
		return button;
	}

	private renderSearchDateButton(container: HTMLElement, option: SearchDateOption, cls: string, label = option.label): HTMLButtonElement {
		const button = container.createEl("button", {
			cls,
			attr: {
				type: "button",
				"aria-pressed": "false",
				"data-search-date": option.filter,
			},
		});
		setIcon(button.createSpan({ cls: "knomo-button-icon" }), option.icon);
		button.createSpan({ cls: "knomo-button-label", text: label });
		return button;
	}

	private renderSidebarNavButton(container: HTMLElement, item: SidebarNavItem): HTMLButtonElement {
		const button = container.createEl("button", {
			cls: "knomo-nav-button",
			attr: {
				type: "button",
				"aria-pressed": "false",
				"data-nav": item.nav,
			},
		});
		setIcon(button.createSpan({ cls: "knomo-button-icon" }), item.icon);
		button.createSpan({ cls: "knomo-button-label", text: item.label });
		return button;
	}

	private createIconButton(
		container: HTMLElement,
		icon: string,
		ariaLabel: string,
		cls: string,
		action: string,
		showTooltip = true,
	): HTMLButtonElement {
		const button = container.createEl("button", {
			cls,
			attr: {
				type: "button",
				"aria-label": ariaLabel,
				"data-action": action,
			},
		});
		if (showTooltip) {
			this.setTooltipIfDesktopOnly(button);
		}
		setIcon(button, icon);
		return button;
	}

	private setTooltipIfDesktopOnly(element: HTMLElement): void {
		if (this.currentLayout === "mobile") {
			element.removeAttribute("data-tooltip-position");
			return;
		}
		element.setAttr("data-tooltip-position", "top");
	}

	private syncTooltipState(root: HTMLElement): void {
		if (this.currentLayout === "mobile") {
			for (const container of [root, this.mobileComposerLayerEl]) {
				for (const element of container?.findAll("[data-tooltip-position]") ?? []) {
					element.removeAttribute("data-tooltip-position");
				}
			}
			return;
		}
		for (const element of root.findAll(
			".knomo-sidebar-action, .knomo-sidebar-toggle, .knomo-compact-menu-btn, .knomo-compact-search-btn, .knomo-reference-clear",
		)) {
			this.setTooltipIfDesktopOnly(element);
		}
	}

	private getA11yId(name: string): string {
		return `${this.a11yIdPrefix}-${name}`;
	}

	private createHiddenText(container: HTMLElement, name: string, text: string): string {
		const id = this.getA11yId(name);
		container.createSpan({
			cls: "knomo-visually-hidden",
			text,
			attr: { id },
		});
		return id;
	}

	private renderCompactHeader(main: HTMLElement): void {
		const header = main.createDiv({ cls: "knomo-compact-header" });
		this.createIconButton(header, KNOMO_SIDEBAR_MENU_ICON, t("mobile.menu"), "knomo-compact-menu-btn", "open-drawer");

		const titleHost = header.createDiv({
			cls: "knomo-compact-title",
		});
		this.titleHosts.push({ el: titleHost, mobile: false });

		const inlineSearchWrap = header.createDiv({ cls: "knomo-compact-search-wrap knomo-compact-inline-search" });
		setIcon(inlineSearchWrap.createSpan({ cls: "knomo-search-icon" }), KNOMO_SEARCH_ICON);
		this.compactInlineSearchInputEl = this.createCompactSearchInput(inlineSearchWrap, "compact-inline-search-label");
		this.renderSearchPopover(inlineSearchWrap);

		this.createIconButton(header, KNOMO_SEARCH_ICON, t("search.label"), "knomo-compact-search-btn", "toggle-compact-search");
	}

	private renderCompactSearchPanel(main: HTMLElement): void {
		const panel = main.createDiv({ cls: "knomo-compact-search-panel" });
		const searchWrap = panel.createDiv({ cls: "knomo-compact-search-wrap" });
		setIcon(searchWrap.createSpan({ cls: "knomo-search-icon" }), KNOMO_SEARCH_ICON);
		this.compactSearchInputEl = this.createCompactSearchInput(searchWrap, "compact-search-label");
		this.renderSearchPopover(searchWrap);
	}

	private createCompactSearchInput(searchWrap: HTMLElement, labelName: string): HTMLInputElement {
		const searchLabelId = this.createHiddenText(searchWrap, labelName, t("search.label"));
		const searchInput = searchWrap.createEl("input", {
			cls: "knomo-search-input",
			attr: {
				type: "search",
				placeholder: t("search.label"),
				"aria-labelledby": searchLabelId,
			},
		});
		this.registerDomEvent(searchInput, "focus", () => this.openDesktopSearch());
		this.registerDomEvent(searchInput, "click", () => this.openDesktopSearch());
		this.registerDomEvent(searchInput, "input", () => {
			this.queueSearchQuery(searchInput.value);
		});
		this.registerDomEvent(searchInput, "keydown", (event) => {
			if (event.key === "Escape") {
				this.compactSearchOpen = false;
				this.desktopSearchOpen = false;
				searchInput.value = "";
				this.setSearchQuery("");
				this.syncRootState();
			}
		});
		return searchInput;
	}

	private async reloadMemos(loadAll: boolean): Promise<boolean> {
		let loaded = false;
		try {
			this.memos = loadAll
				? await this.syncOrchestrator.listMemos()
				: await this.syncOrchestrator.listRecentMemos();
			this.allMemosLoaded = loadAll;
			this.cardFlowError = null;
			this.filteredMemosCache = null;
			this.invalidateMemoSearchCache();
			this.resetVisibleMemos();
			if (this.activeNav === "random" && !this.randomReunionLoading) {
				this.randomReunionMemos = null;
			}
			loaded = true;
		} catch (error) {
			this.memos = [];
			this.invalidateMemoSearchCache();
			this.cardFlowError = formatSettingsText(error instanceof Error ? error.message : t("empty.cardFlowFailed"));
			this.updateStatus(this.cardFlowError, true);
		}
		this.renderUiState();
		if (this.activeNav === "random" && !this.randomReunionLoading && this.randomReunionMemos === null) {
			void this.refreshRandomReunionMemos();
		}
		return loaded;
	}

	private renderUiState(): void {
		this.syncRootState();
		this.syncComposerDailyStatus();
		this.syncComposerMode();
		this.renderStats();
		this.renderTags();
		this.renderTrashCount();
		this.renderScopeState();
		this.renderCardFlow();
		this.renderMobileSearchResults();
		this.syncSearchInputs();
		this.updateSendButtonState();
		this.updateCancelEditButtonState();
	}

	private syncComposerDailyStatus(): void {
		const dailyStatus = this.syncOrchestrator.getDailyNotesStatus();
		if (this.inputEl !== null) {
			this.inputEl.disabled = !dailyStatus.enabled;
		}
		if (this.isSaving || this.editingMemo !== null || this.quoteSourceMemoId !== null || this.cardFlowError !== null) {
			return;
		}
		this.updateStatus("", false);
	}

	private syncComposerMode(): void {
		if (this.referencePreviewEl !== null) {
			if (this.quoteSourceMemoId !== null && this.quoteMarkdownText !== null) {
				this.referencePreviewEl.empty();
				const previewText = this.referencePreviewEl.createDiv({
					cls: "knomo-reference-preview-text",
				});
				previewText.createSpan({ cls: "knomo-reference-label", text: t("reference.label") });
				previewText.createSpan({
					cls: "knomo-reference-content",
					text: this.quoteMarkdownText.replace(/^> ?/gm, ""),
				});
				const clearButton = this.referencePreviewEl.createEl("button", {
					cls: "knomo-reference-clear",
					attr: {
						type: "button",
						"aria-label": t("reference.clear"),
						"data-action": "clear-reference",
					},
				});
				this.setTooltipIfDesktopOnly(clearButton);
				setIcon(clearButton, "x");
				this.referencePreviewEl.style.display = "flex";
			} else {
				this.referencePreviewEl.empty();
				this.referencePreviewEl.style.display = "none";
			}
		}
		if (this.currentLayout === "mobile") {
			this.updateMobileComposerMeasurements();
			this.resizeInput();
		}
	}

	private syncRootState(): void {
		const root = this.rootEl;
		if (root === null) {
			return;
		}
		root.toggleClass("is-layout-desktop-wide", this.currentLayout === "desktop-wide");
		root.toggleClass("is-layout-desktop-medium", this.currentLayout === "desktop-medium");
		root.toggleClass("is-layout-desktop-narrow", this.currentLayout === "desktop-narrow");
		root.toggleClass("is-layout-mobile", this.currentLayout === "mobile");
		root.toggleClass("is-sidebar-collapsed", this.sidebarCollapsed);
		root.toggleClass("is-drawer-open", this.mobileDrawerOpen);
		root.toggleClass("is-desktop-search-open", this.desktopSearchOpen);
		root.toggleClass("is-scope-open", this.scopeMenuOpen);
		root.toggleClass("is-composer-open", this.composerOpen);
		root.toggleClass("is-compact-search-open", this.compactSearchOpen);
		root.toggleClass("is-mobile-search-open", this.mobileSearchPageOpen);
		root.toggleClass("is-mobile-compact", shouldUseMobileCompact(this.settingsService.getSettings().mobileCompactMode));
		root.style.setProperty("--knomo-sidebar-width", `${this.sidebarWidth}px`);
			this.syncTooltipState(root);
			this.syncMobileHeaderActions();
			this.syncMobileHeaderTitle();
			this.syncTitlePopoverPosition();
			this.syncMobileSearchPage();
			this.syncMobileDrawerTop(root);
		const shouldTrackMobileViewport = this.currentLayout === "mobile"
			&& this.composerOpen
			&& (this.mobileComposerPhase === "focusing" || this.mobileComposerPhase === "open");
		if (shouldTrackMobileViewport) {
			this.startMobileViewportTracking();
		} else if (this.mobileComposerPhase !== "closing") {
			this.stopMobileViewportTracking();
		}
		this.syncMobileComposerLayer();
		if (this.sidebarResizerEl !== null) {
			this.sidebarResizerEl.setAttr("aria-valuenow", String(this.sidebarWidth));
		}
		this.rootEl?.findAll("[aria-expanded]").forEach((element) => {
			if (element.getAttr("data-action") === "toggle-scope-menu") {
				element.setAttr("aria-expanded", this.scopeMenuOpen ? "true" : "false");
			}
		});
		this.mobileNavbarCompactController?.sync();
	}

	private syncMobileDrawerTop(root: HTMLElement): void {
		if (this.currentLayout !== "mobile") {
			root.style.removeProperty("--knomo-mobile-drawer-top");
			return;
		}
		const headerBottom = this.measureMobileHeaderBottom();
		if (headerBottom === null) {
			root.style.removeProperty("--knomo-mobile-drawer-top");
			return;
		}
		root.style.setProperty("--knomo-mobile-drawer-top", `${headerBottom}px`);
	}

	private measureMobileHeaderBottom(): number | null {
		const headerEl = this.findMobileViewHeader();
		const rect = headerEl?.getBoundingClientRect();
		if (
			rect === undefined ||
			rect.width <= 0 ||
			rect.height <= 0 ||
			rect.bottom <= 0 ||
			rect.bottom > this.containerEl.win.innerHeight / 2
		) {
			return null;
		}
		return Math.ceil(rect.bottom);
	}

	private findMobileViewHeader(): HTMLElement | null {
		const leafEl = this.containerEl.closest(".workspace-leaf");
		const leafHeaderEl = leafEl?.querySelector(".view-header");
		if (leafHeaderEl?.instanceOf(HTMLElement)) {
			return leafHeaderEl;
		}
		for (const selector of MOBILE_VIEW_HEADER_SELECTORS) {
			const headerEl = this.containerEl.doc.body.querySelector(selector);
			if (headerEl?.instanceOf(HTMLElement)) {
				return headerEl;
			}
		}
		return null;
	}

	private syncMobileHeaderActions(): void {
		if (this.currentLayout === "mobile") {
			this.ensureMobileHeaderActions();
			return;
		}
		this.removeMobileHeaderActions();
	}

	private syncMobileHeaderTitle(): void {
		if (this.currentLayout !== "mobile") {
			this.removeMobileHeaderTitle();
			return;
		}
		const headerEl = this.findMobileViewHeader();
		const titleEl = headerEl?.querySelector(".view-header-title");
		if (!titleEl?.instanceOf(HTMLElement)) {
			return;
		}
		if (this.mobileHeaderTitleEl !== titleEl) {
			this.removeMobileHeaderTitle();
			this.mobileHeaderTitleEl = titleEl;
			this.mobileHeaderTitleOriginalText = titleEl.textContent;
		}
		if (this.mobileHeaderTitleRegisteredEl !== titleEl) {
			this.mobileHeaderTitleRegisteredEl = titleEl;
			this.registerDomEvent(titleEl, "click", (event) => {
				event.preventDefault();
				this.scopeMenuOpen = !this.scopeMenuOpen;
				this.desktopSearchOpen = false;
				this.syncRootState();
			});
			this.registerDomEvent(titleEl, "keydown", (event) => {
				if (event.key !== "Enter" && event.key !== " ") {
					return;
				}
				event.preventDefault();
				this.scopeMenuOpen = !this.scopeMenuOpen;
				this.desktopSearchOpen = false;
				this.syncRootState();
			});
		}
		titleEl.empty();
		titleEl.addClass("knomo-mobile-title");
		titleEl.setAttr("role", "button");
		titleEl.setAttr("aria-haspopup", "menu");
		titleEl.setAttr("aria-expanded", this.scopeMenuOpen ? "true" : "false");
		titleEl.setAttr("tabindex", "0");
		titleEl.createSpan({ text: this.getMobileTitleLabel() });
		setIcon(titleEl.createSpan({ cls: "knomo-title-chevron" }), "chevron-down");
	}

	private syncTitlePopoverPosition(): void {
		const root = this.rootEl;
		if (root === null) {
			return;
		}
		const anchor = this.getTitlePopoverAnchor();
		if (anchor === null) {
			root.style.removeProperty("--knomo-title-popover-left");
			root.style.removeProperty("--knomo-title-popover-top");
			return;
		}
		const rect = anchor.getBoundingClientRect();
		if (this.currentLayout === "mobile") {
			root.style.setProperty("--knomo-title-popover-top", `${Math.round(rect.bottom + 6)}px`);
			root.style.removeProperty("--knomo-title-popover-left");
			return;
		}
		const container = anchor.closest(".knomo-main");
		const containerRect = container?.getBoundingClientRect() ?? root.getBoundingClientRect();
		const dropdownWidth = 168;
		const left = clamp(
			Math.round(rect.left - containerRect.left),
			12,
			Math.max(12, Math.round(containerRect.width - dropdownWidth - 12)),
		);
		root.style.setProperty("--knomo-title-popover-left", `${left}px`);
		root.style.setProperty("--knomo-title-popover-top", `${Math.round(rect.bottom - containerRect.top + 6)}px`);
	}

	private getTitlePopoverAnchor(): HTMLElement | null {
		if (this.currentLayout === "mobile") {
			return this.mobileHeaderTitleEl;
		}
		if (this.currentLayout === "desktop-medium" || this.currentLayout === "desktop-narrow") {
			for (const titleHost of this.titleHosts) {
				if (titleHost.el.isConnected && titleHost.el.closest(".knomo-compact-header") !== null) {
					const labelEl = titleHost.el.find(".knomo-title-label");
					return labelEl?.instanceOf(HTMLElement) ? labelEl : titleHost.el;
				}
			}
		}
		return null;
	}

	private ensureMobileHeaderActions(): void {
		if (this.mobileSearchHeaderActionEl === null || !this.mobileSearchHeaderActionEl.isConnected) {
			this.mobileSearchHeaderActionEl?.remove();
			this.mobileSearchHeaderActionEl = this.addAction(KNOMO_SEARCH_ICON, t("search.knomo"), () => this.openMobileHeaderSearch());
			this.mobileSearchHeaderActionEl.addClass("knomo-mobile-header-action");
			this.mobileSearchHeaderActionEl.setAttr("aria-label", t("search.knomo"));
		}
	}

	private removeMobileHeaderActions(): void {
		this.mobileSearchHeaderActionEl?.remove();
		this.mobileSearchHeaderActionEl = null;
	}

	private removeMobileHeaderTitle(): void {
		if (this.mobileHeaderTitleEl !== null) {
			this.mobileHeaderTitleEl.empty();
			if (this.mobileHeaderTitleOriginalText !== null) {
				this.mobileHeaderTitleEl.setText(this.mobileHeaderTitleOriginalText);
			}
			this.mobileHeaderTitleEl.removeClass("knomo-mobile-title");
			this.mobileHeaderTitleEl.removeAttribute("role");
			this.mobileHeaderTitleEl.removeAttribute("aria-haspopup");
			this.mobileHeaderTitleEl.removeAttribute("aria-expanded");
			this.mobileHeaderTitleEl.removeAttribute("tabindex");
		}
		this.mobileHeaderTitleEl = null;
		this.mobileHeaderTitleOriginalText = null;
	}

	private openMobileHeaderSearch(): void {
		this.openMobileSearchPage();
	}

	private openMobileSearchPage(): void {
		this.mobileDrawerOpen = false;
		this.scopeMenuOpen = false;
		this.compactSearchOpen = false;
		this.desktopSearchOpen = false;
		this.activeMenuMemoId = null;
		this.mobileSearchPageOpen = true;
		this.ensureMobileSearchPage();
		if (this.mobileSearchInputEl !== null && this.mobileSearchInputEl.value !== this.mobileSearchQuery) {
			this.mobileSearchInputEl.value = this.mobileSearchQuery;
		}
		this.renderMobileSearchResults();
		this.syncRootState();
		this.focusMobileSearchInputSoon();
	}

	private ensureMobileSearchPage(): void {
		if (this.rootEl === null) {
			return;
		}
		if (this.mobileSearchPageEl !== null && this.mobileSearchPageEl.isConnected) {
			return;
		}
		const page = this.rootEl.createDiv({ cls: "knomo-mobile-search-page" });
		this.mobileSearchPageEl = page;
		const header = page.createDiv({ cls: "knomo-mobile-search-header" });
		const searchWrap = header.createDiv({ cls: "knomo-mobile-search-wrap" });
		setIcon(searchWrap.createSpan({ cls: "knomo-search-icon" }), KNOMO_SEARCH_ICON);
		const searchLabelId = this.createHiddenText(searchWrap, "mobile-search-label", t("search.label"));
		this.mobileSearchInputEl = searchWrap.createEl("input", {
			cls: "knomo-search-input",
			attr: {
				type: "search",
				placeholder: t("search.label"),
				"aria-labelledby": searchLabelId,
			},
		});
		this.registerDomEvent(this.mobileSearchInputEl, "input", () => {
			this.queueMobileSearchQuery(this.mobileSearchInputEl?.value ?? "");
		});
		this.registerDomEvent(this.mobileSearchInputEl, "keydown", (event) => {
			if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				this.closeMobileSearchPage();
			}
		});
		const closeButton = header.createEl("button", {
			cls: "knomo-mobile-search-close",
			attr: {
				type: "button",
				"aria-label": t("search.close"),
				"data-action": "close-mobile-search",
			},
		});
		setIcon(closeButton, "x");

		const quickSection = page.createDiv({ cls: "knomo-mobile-search-quick" });
		quickSection.createDiv({ cls: "knomo-mobile-search-section-title", text: t("search.quick") });
		const quickList = quickSection.createDiv({ cls: "knomo-mobile-search-chip-list" });
		for (const option of SEARCH_DATE_OPTIONS) {
			this.renderSearchDateButton(quickList, option, "knomo-mobile-search-chip", option.mobileLabel ?? option.label);
		}
		this.mobileSearchResultsEl = page.createDiv({ cls: "knomo-mobile-search-results" });
		this.registerDomEvent(this.mobileSearchResultsEl, "click", (event) => {
			void this.handleMarkdownInternalLinkClick(event);
		});
	}

	private syncMobileSearchPage(): void {
		const shouldOpen = this.currentLayout === "mobile" && this.mobileSearchPageOpen;
		this.containerEl.doc.body.toggleClass("knomo-mobile-search-active", shouldOpen);
		if (this.currentLayout !== "mobile") {
			this.mobileSearchPageOpen = false;
			this.rootEl?.toggleClass("is-mobile-search-open", false);
			this.mobileSearchPageEl?.toggleClass("is-open", false);
			return;
		}
		if (!this.mobileSearchPageOpen) {
			this.mobileSearchPageEl?.toggleClass("is-open", false);
			return;
		}
		this.ensureMobileSearchPage();
		this.mobileSearchPageEl?.toggleClass("is-open", true);
	}

	private closeMobileSearchPage(): void {
		const scrollTop = this.getCardFlowScrollTop();
		this.mobileSearchPageOpen = false;
		this.activeMenuMemoId = null;
		this.resetMobileSearchState();
		this.syncRootState();
		this.renderCardFlow();
		this.restoreCardFlowScrollTop(scrollTop);
	}

	private removeMobileSearchPage(): void {
		this.clearMobileSearchDebounce();
		this.mobileSearchPageEl?.detach();
		this.mobileSearchPageEl = null;
		this.mobileSearchInputEl = null;
		this.mobileSearchResultsEl = null;
	}

	private focusMobileSearchInputSoon(): void {
		this.containerEl.win.requestAnimationFrame(() => {
			const input = this.mobileSearchInputEl;
			if (input === null || !input.isConnected) {
				return;
			}
			try {
				input.focus({ preventScroll: true });
			} catch {
				input.focus();
			}
		});
	}

	private queueMobileSearchQuery(query: string): void {
		this.clearMobileSearchDebounce();
		this.mobileSearchDebounceTimeoutId = this.containerEl.win.setTimeout(() => {
			this.mobileSearchDebounceTimeoutId = null;
			this.mobileSearchQuery = query;
			this.mobileSearchVisibleCount = MOBILE_SEARCH_BATCH_SIZE;
			this.renderMobileSearchResults();
		}, SEARCH_DEBOUNCE_MS);
	}

	private clearMobileSearchDebounce(): void {
		if (this.mobileSearchDebounceTimeoutId === null) {
			return;
		}
		this.containerEl.win.clearTimeout(this.mobileSearchDebounceTimeoutId);
		this.mobileSearchDebounceTimeoutId = null;
	}

	private setMobileSearchDateFilter(filter: SearchDateFilter): void {
		this.flushMobileSearchQuery();
		this.mobileSearchDateFilter = this.mobileSearchDateFilter === filter ? null : filter;
		this.mobileSearchVisibleCount = MOBILE_SEARCH_BATCH_SIZE;
		this.renderMobileSearchResults();
	}

	private resetMobileSearchState(): void {
		this.clearMobileSearchDebounce();
		this.mobileSearchQuery = "";
		this.mobileSearchDateFilter = null;
		this.mobileSearchVisibleCount = MOBILE_SEARCH_BATCH_SIZE;
		if (this.mobileSearchInputEl !== null) {
			this.mobileSearchInputEl.value = "";
		}
		this.mobileSearchResultsEl?.empty();
		this.syncMobileSearchDateButtons();
	}

	private flushMobileSearchQuery(): void {
		this.clearMobileSearchDebounce();
		this.mobileSearchQuery = this.mobileSearchInputEl?.value ?? this.mobileSearchQuery;
	}

	private loadMoreMobileSearchResults(): void {
		this.mobileSearchVisibleCount += MOBILE_SEARCH_BATCH_SIZE;
		this.renderMobileSearchResults();
	}

	private renderMobileSearchResults(): void {
		const resultsEl = this.mobileSearchResultsEl;
		if (resultsEl === null || !this.mobileSearchPageOpen) {
			return;
		}
		const generation = this.renderGeneration + 1;
		this.renderGeneration = generation;
		this.clearMarkdownRenderQueue();
		resultsEl.empty();
		this.syncMobileSearchDateButtons();
		const normalizedQuery = this.mobileSearchQuery.trim().toLowerCase();
		if (normalizedQuery.length === 0 && this.mobileSearchDateFilter === null) {
			resultsEl.createDiv({ cls: "knomo-mobile-search-empty", text: t("search.emptyPrompt") });
			return;
		}
		const memos = this.memos.filter((memo) => this.memoMatchesSearch(memo, normalizedQuery, this.mobileSearchDateFilter));
		if (memos.length === 0) {
			resultsEl.createDiv({ cls: "knomo-mobile-search-empty", text: t("search.noResults") });
			return;
		}
		const visibleMemos = memos.slice(0, this.mobileSearchVisibleCount);
		for (const [index, memo] of visibleMemos.entries()) {
			this.renderMemoCardInContainer(resultsEl, memo, generation, index, true, false);
		}
		if (visibleMemos.length < memos.length) {
			resultsEl.createEl("button", {
				cls: "knomo-load-more knomo-mobile-search-more",
				text: t("list.loadMore", { count: memos.length - visibleMemos.length }),
				attr: {
					type: "button",
					"data-action": "load-more-mobile-search",
				},
			});
		}
	}

	private syncMobileSearchDateButtons(): void {
		this.mobileSearchPageEl?.findAll("[data-search-date]").forEach((element) => {
			const active = element.getAttr("data-search-date") === this.mobileSearchDateFilter;
			element.toggleClass("is-active", active);
			element.setAttr("aria-pressed", active ? "true" : "false");
		});
	}

	private startLayoutObserver(): void {
		if (this.layoutObserver !== null) {
			return;
		}
		this.layoutObserver = new ResizeObserver(() => {
			this.updateCurrentLayout();
			this.syncRootState();
			this.updateMobileComposerMeasurements();
			this.resizeInput();
		});
		this.layoutObserver.observe(this.containerEl);
		this.updateCurrentLayout();
		this.syncRootState();
		this.updateMobileComposerMeasurements();
		this.resizeInput();
	}

	private stopLayoutObserver(): void {
		if (this.layoutObserver !== null) {
			this.layoutObserver.disconnect();
			this.layoutObserver = null;
		}
	}

	private startMobileViewportTracking(): void {
		if (this.rootEl === null) {
			return;
		}
		const win = this.containerEl.win;
		if (this.mobileWindowResizeHandler === null) {
			this.mobileWindowResizeHandler = () => this.queueMobileViewportUpdate();
			win.addEventListener("resize", this.mobileWindowResizeHandler);
		}
		if (this.mobileOrientationChangeHandler === null) {
			this.mobileOrientationChangeHandler = () => this.queueMobileViewportUpdate();
			win.addEventListener("orientationchange", this.mobileOrientationChangeHandler);
		}
		const viewport = win.visualViewport;
		if (viewport === undefined || viewport === null) {
			this.updateMobileKeyboardMetrics();
			return;
		}
		if (this.mobileVisualViewportHandler === null) {
			this.mobileVisualViewport = viewport;
			this.mobileVisualViewportHandler = () => this.queueMobileViewportUpdate();
			viewport.addEventListener("resize", this.mobileVisualViewportHandler);
			viewport.addEventListener("scroll", this.mobileVisualViewportHandler);
		}
		this.updateMobileKeyboardMetrics();
	}

	private stopMobileViewportTracking(clearMetrics = true): void {
		const win = this.containerEl.win;
		if (this.mobileVisualViewport !== null && this.mobileVisualViewportHandler !== null) {
			this.mobileVisualViewport.removeEventListener("resize", this.mobileVisualViewportHandler);
			this.mobileVisualViewport.removeEventListener("scroll", this.mobileVisualViewportHandler);
		}
		if (this.mobileWindowResizeHandler !== null) {
			win.removeEventListener("resize", this.mobileWindowResizeHandler);
		}
		if (this.mobileOrientationChangeHandler !== null) {
			win.removeEventListener("orientationchange", this.mobileOrientationChangeHandler);
		}
		this.mobileVisualViewport = null;
		this.mobileVisualViewportHandler = null;
		this.mobileWindowResizeHandler = null;
		this.mobileOrientationChangeHandler = null;
		this.clearMobileViewportFrame();
		this.clearMobileKeyboardMeasureTimers();
		this.mobileKeyboardFocusStartedAt = null;
		if (clearMetrics) {
			this.clearMobileKeyboardMetrics();
		}
	}

	private syncMobileComposerLayer(): void {
		const shouldShow = this.currentLayout === "mobile" && this.composerOpen;
		if (shouldShow) {
			if (this.mobileComposerPhase === "closing") {
				return;
			}
			this.ensureMobileComposerLayer();
			return;
		}
		if (this.mobileComposerPhase !== "closing") {
			this.detachMobileComposerLayer();
		}
	}

	private ensureMobileComposerLayer(): void {
		if (this.composerEl === null) {
			return;
		}
		if (this.mobileComposerLayerEl === null) {
			this.mobileComposerLayerEl = this.containerEl.doc.body.createDiv({
				cls: "knomo-plugin knomo-mobile-composer-layer is-layout-mobile",
			});
			this.mobileComposerBackdropEl = this.mobileComposerLayerEl.createDiv({
				cls: "knomo-mobile-composer-backdrop",
			});
			const stage = this.mobileComposerLayerEl.createDiv({
				cls: "knomo-mobile-composer-stage",
			});
			this.mobileComposerContentEl = stage.createDiv({
				cls: "knomo-mobile-composer-content",
			});
			this.mobileComposerBackdropEl.setAttr("aria-hidden", "true");
			this.registerDomEvent(this.mobileComposerBackdropEl, "click", (event) => {
				if (event.target === this.mobileComposerBackdropEl) {
					this.closeComposerKeepingDraft();
				}
			});
		} else if (this.mobileComposerLayerEl.parentElement === null) {
			this.containerEl.doc.body.appendChild(this.mobileComposerLayerEl);
		}
		if (this.composerEl.parentElement === this.mobileComposerContentEl) {
			return;
		}
		this.mobileComposerHomeEl = this.composerEl.parentElement;
		this.mobileComposerNextSibling = this.composerEl.nextSibling;
		this.mobileComposerContentEl?.appendChild(this.composerEl);
	}

	private restoreMobileComposerLayer(): void {
		if (this.composerEl !== null && this.mobileComposerHomeEl !== null && this.composerEl.parentElement === this.mobileComposerContentEl) {
			if (this.mobileComposerNextSibling !== null && this.mobileComposerNextSibling.parentNode === this.mobileComposerHomeEl) {
				this.mobileComposerHomeEl.insertBefore(this.composerEl, this.mobileComposerNextSibling);
			} else {
				this.mobileComposerHomeEl.appendChild(this.composerEl);
			}
		}
		this.mobileComposerHomeEl = null;
		this.mobileComposerNextSibling = null;
	}

	private clearMobileComposerLayerState(): void {
		this.mobileComposerLayerEl?.toggleClass("is-open", false);
		this.mobileComposerLayerEl?.toggleClass("is-closing", false);
		this.mobileComposerLayerEl?.toggleClass("is-keyboard-open", false);
	}

	private detachMobileComposerLayer(): void {
		this.restoreMobileComposerLayer();
		this.clearMobileComposerResizeFrame();
		this.clearMobileKeyboardMeasureTimers();
		this.mobileComposerViewportBaselineHeight = null;
		this.mobileComposerInputMaxHeight = null;
		this.clearMobileComposerLayerState();
		this.mobileComposerLayerEl?.detach();
	}

	private removeMobileComposerLayer(): void {
		this.restoreMobileComposerLayer();
		this.clearMobileComposerResizeFrame();
		this.clearMobileKeyboardMeasureTimers();
		this.mobileComposerViewportBaselineHeight = null;
		this.mobileComposerInputMaxHeight = null;
		this.clearMobileComposerLayerState();
		this.mobileComposerLayerEl?.detach();
		this.mobileComposerLayerEl = null;
		this.mobileComposerBackdropEl = null;
		this.mobileComposerContentEl = null;
	}

	private isMobileComposerLayered(): boolean {
		return this.composerEl !== null && this.composerEl.parentElement === this.mobileComposerContentEl;
	}

	private queueMobileViewportUpdate(): void {
		if (this.mobileViewportFrameId !== null) {
			return;
		}
		this.mobileViewportFrameId = this.containerEl.win.requestAnimationFrame(() => {
			this.mobileViewportFrameId = null;
			this.updateMobileKeyboardMetrics();
		});
	}

	private clearMobileViewportFrame(): void {
		if (this.mobileViewportFrameId === null) {
			return;
		}
		this.containerEl.win.cancelAnimationFrame(this.mobileViewportFrameId);
		this.mobileViewportFrameId = null;
	}

	private scheduleMobileKeyboardMeasurements(): void {
		this.clearMobileKeyboardMeasureTimers();
		const delays = [80, 160, 320, 600];
		for (const delay of delays) {
			const timer = this.containerEl.win.setTimeout(() => {
				this.updateMobileKeyboardMetrics();
			}, delay);
			this.mobileKeyboardMeasureTimers.push(timer);
		}
	}

	private clearMobileKeyboardMeasureTimers(): void {
		for (const timer of this.mobileKeyboardMeasureTimers) {
			this.containerEl.win.clearTimeout(timer);
		}
		this.mobileKeyboardMeasureTimers = [];
	}

	private scheduleMobileComposerResize(): void {
		if (this.mobileComposerResizeFrameId !== null) {
			return;
		}
		this.mobileComposerResizeFrameId = this.containerEl.win.requestAnimationFrame(() => {
			this.mobileComposerResizeFrameId = null;
			this.updateMobileComposerMeasurements();
			this.resizeInput();
		});
	}

	private clearMobileComposerResizeFrame(): void {
		if (this.mobileComposerResizeFrameId === null) {
			return;
		}
		this.containerEl.win.cancelAnimationFrame(this.mobileComposerResizeFrameId);
		this.mobileComposerResizeFrameId = null;
	}

	private updateMobileKeyboardMetrics(): void {
		const win = this.containerEl.win;
		const viewport = this.mobileVisualViewport ?? win.visualViewport;
		const visibleTop = viewport === undefined || viewport === null ? 0 : Math.max(0, viewport.offsetTop);
		const visibleHeight = viewport === undefined || viewport === null ? win.innerHeight : Math.max(0, viewport.height);
		const visibleBottom = visibleTop + visibleHeight;
		const baselineHeight = this.mobileComposerViewportBaselineHeight ?? win.innerHeight;
		let keyboardHeight = Math.max(0, baselineHeight - visibleBottom);
		if (keyboardHeight < 80) {
			keyboardHeight = 0;
		}
		const activeElement = this.containerEl.doc.activeElement;
		const shouldUseFallback = this.currentLayout === "mobile"
			&& this.composerOpen
			&& (this.mobileComposerInputFocused || activeElement === this.inputEl)
			&& keyboardHeight === 0
			&& this.mobileKeyboardFocusStartedAt !== null
			&& Date.now() - this.mobileKeyboardFocusStartedAt > 220;
		if (shouldUseFallback) {
			keyboardHeight = this.getMobileKeyboardFallbackHeight(baselineHeight);
		}
		this.mobileKeyboardHeight = keyboardHeight;
		this.setMobileKeyboardMetrics(visibleTop, visibleHeight, keyboardHeight);
		this.updateMobileComposerMeasurements();
		if (this.mobileComposerPhase === "focusing"
			&& this.mobileKeyboardFocusStartedAt !== null
			&& Date.now() - this.mobileKeyboardFocusStartedAt > 240) {
			this.mobileComposerPhase = "open";
		}
		if (this.currentLayout === "mobile" && this.composerOpen && this.mobileComposerPhase !== "opening" && this.mobileComposerPhase !== "closing") {
			this.resizeInput();
		}
	}

	private getMobileKeyboardFallbackHeight(baselineHeight: number): number {
		const height = baselineHeight > 0 ? baselineHeight : this.containerEl.win.innerHeight;
		return Math.round(Math.min(Math.max(height * 0.42, 300), 430));
	}

	private setMobileKeyboardMetrics(visibleTop: number, visibleHeight: number, keyboardHeight: number): void {
		const visibleTopValue = `${Math.round(visibleTop)}px`;
		const visibleHeightValue = `${Math.round(visibleHeight)}px`;
		const keyboardHeightValue = `${Math.round(keyboardHeight)}px`;
		for (const element of [this.rootEl, this.mobileComposerLayerEl]) {
			element?.style.setProperty("--knomo-visible-top", visibleTopValue);
			element?.style.setProperty("--knomo-visible-height", visibleHeightValue);
			element?.style.setProperty("--knomo-keyboard-height", keyboardHeightValue);
			element?.style.setProperty("--knomo-vv-top", visibleTopValue);
			element?.style.setProperty("--knomo-vv-height", visibleHeightValue);
		}
		this.mobileComposerLayerEl?.toggleClass("is-keyboard-open", keyboardHeight > 0);
	}

	private clearMobileKeyboardMetrics(): void {
		const win = this.containerEl.win;
		this.mobileKeyboardHeight = 0;
		this.mobileComposerViewportBaselineHeight = null;
		this.setMobileKeyboardMetrics(0, win.innerHeight, 0);
		this.updateMobileComposerMeasurements();
	}

	private updateMobileComposerMeasurements(): number {
		const win = this.containerEl.win;
		const viewport = this.mobileVisualViewport ?? win.visualViewport;
		const containerTop = Math.max(0, this.containerEl.getBoundingClientRect().top);
		const viewportTop = viewport === undefined || viewport === null ? 0 : Math.max(0, viewport.offsetTop);
		const topLimit = Math.max(viewportTop + MOBILE_COMPOSER_TOP_GUARD, containerTop + 8);
		const keyboardHeight = this.mobileKeyboardHeight || 0;
		const baselineHeight = this.mobileComposerViewportBaselineHeight ?? win.innerHeight;
		const keyboardTop = keyboardHeight > 0
			? baselineHeight - keyboardHeight
			: viewport === undefined || viewport === null
				? win.innerHeight
				: viewport.offsetTop + viewport.height;
		const contentMaxHeight = Math.round(Math.max(160, keyboardTop - topLimit));
		const toolbarHeight = this.composerBarEl?.offsetHeight ?? 52;
		const referenceHeight = this.referencePreviewEl !== null && this.referencePreviewEl.style.display !== "none"
			? this.referencePreviewEl.offsetHeight
			: 0;
		const verticalPadding = 32;
		const inputMaxHeight = Math.max(120, contentMaxHeight - toolbarHeight - referenceHeight - verticalPadding);
		const contentMaxHeightValue = `${contentMaxHeight}px`;
		this.mobileComposerInputMaxHeight = Math.round(inputMaxHeight);
		const inputMaxHeightValue = `${this.mobileComposerInputMaxHeight}px`;
		for (const element of [this.rootEl, this.mobileComposerLayerEl]) {
			element?.style.setProperty("--knomo-composer-content-max-height", contentMaxHeightValue);
			element?.style.setProperty("--knomo-composer-input-max-height", inputMaxHeightValue);
		}
		return Math.round(inputMaxHeight);
	}

	private updateCurrentLayout(): void {
		if (Platform.isMobile) {
			this.currentLayout = "mobile";
			return;
		}
		const width = this.containerEl.getBoundingClientRect().width;
		if (width >= 960) {
			this.currentLayout = "desktop-wide";
		} else if (width >= 640) {
			this.currentLayout = "desktop-medium";
		} else {
			this.currentLayout = "desktop-narrow";
		}
	}

	private renderStats(): void {
		const stats = getMemoStats(this.memos);
		for (const statsEl of this.statsEls) {
			statsEl.empty();
			this.renderStat(statsEl, String(stats.memoCount), t("stats.notes"));
			this.renderStat(statsEl, String(stats.tagCount), t("stats.tags"));
			this.renderStat(statsEl, stats.imageCount > 0 ? String(stats.imageCount) : String(stats.wordCount), stats.imageCount > 0 ? t("stats.images") : t("stats.words"));
		}
	}

	private renderStat(container: HTMLElement, value: string, label: string): void {
		const item = container.createDiv({ cls: "knomo-stat" });
		item.createDiv({ cls: "knomo-stat-value", text: value });
		item.createDiv({ cls: "knomo-stat-label", text: label });
	}

	private renderTags(): void {
		const allTags = collectTags(this.memos, collectVaultTagDisplayMap(this.app));
		if (this.activeTagKey !== null) {
			const activeTag = allTags.find((tag) => tag.key === this.activeTagKey);
			if (activeTag !== undefined) {
				this.activeTag = activeTag.name;
			}
		}
		this.renderTagList(this.allTagsEl, buildTagTree(allTags), t("tags.empty"));
	}

	private renderTrashCount(): void {
		for (const countEl of this.trashCountEls) {
			countEl.setText(this.trashCount > 0 ? String(this.trashCount) : "");
			countEl.toggleAttribute("hidden", this.trashCount === 0);
		}
	}

	private renderTagList(container: HTMLElement | null, tags: TagTreeNode[], emptyText: string): void {
		if (container === null) {
			return;
		}
		container.empty();
		if (tags.length === 0) {
			container.createDiv({ cls: "knomo-muted-text", text: emptyText });
			return;
		}
		for (const tag of tags) {
			this.renderTagTreeNode(container, tag);
		}
	}

	private renderTagTreeNode(container: HTMLElement, tag: TagTreeNode): void {
		const collapsed = tag.children.length > 0 && !this.expandedTagGroups.has(tag.key);
		const node = container.createDiv({ cls: collapsed ? "knomo-tag-node is-collapsed" : "knomo-tag-node" });
		const row = node.createDiv({ cls: "knomo-tag-row" });
		const button = row.createEl("button", {
			cls: this.activeTagKey === tag.key ? "knomo-tag-nav is-active" : "knomo-tag-nav",
			attr: {
				type: "button",
				"data-tag": tag.name,
				"data-tag-key": tag.key,
				"aria-pressed": this.activeTagKey === tag.key ? "true" : "false",
			},
		});
		button.createSpan({ cls: "knomo-tag-name", text: tag.label });
		if (tag.children.length > 0) {
			const toggle = row.createEl("button", {
				cls: "knomo-tag-toggle",
				attr: {
					type: "button",
					"aria-label": collapsed ? t("tags.expandGroup") : t("tags.collapseGroup"),
					"aria-expanded": collapsed ? "false" : "true",
					"data-tag-toggle": tag.key,
				},
			});
			toggle.createSpan({ cls: "knomo-tag-count", text: String(tag.count) });
			const toggleIcon = toggle.createSpan({ cls: "knomo-tag-toggle-icon" });
			setIcon(toggleIcon, "chevron-down");
		} else {
			row.createSpan({ cls: "knomo-tag-count", text: String(tag.count) });
		}
		if (tag.children.length > 0) {
			const children = node.createDiv({ cls: "knomo-tag-children" });
			for (const child of tag.children) {
				this.renderTagTreeNode(children, child);
			}
		}
	}

	private renderScopeState(): void {
		for (const titleHost of this.titleHosts) {
			this.renderTitleHost(titleHost);
		}
		this.syncMobileHeaderTitle();
		this.rootEl?.findAll("[data-nav]").forEach((element) => {
			const active = element.getAttr("data-nav") === this.activeNav;
			element.toggleClass("is-active", active);
			element.setAttr("aria-pressed", active ? "true" : "false");
		});
		this.rootEl?.findAll("[data-title-mode]").forEach((element) => {
			const active = element.getAttr("data-title-mode") === this.getCurrentTitleMode();
			element.toggleClass("is-active", active);
			element.setAttr("aria-pressed", active ? "true" : "false");
		});
		this.rootEl?.findAll("[data-search-date]").forEach((element) => {
			const active = element.getAttr("data-search-date") === this.searchDateFilter;
			element.toggleClass("is-active", active);
			element.setAttr("aria-pressed", active ? "true" : "false");
		});
	}

	private renderTitleHost(host: TitleHost): void {
		host.el.empty();
		const label = host.mobile ? this.getMobileTitleLabel() : this.getDesktopTitleLabel();
		const isDefault = this.isDefaultListState();
		if (!host.mobile && !isDefault) {
			host.el.createEl("button", {
				cls: "knomo-title-root",
				text: t("nav.allNotes"),
				attr: {
					type: "button",
					"data-action": "reset-list-state",
					"aria-label": t("title.backAllNotes"),
				},
			});
			host.el.createSpan({ cls: "knomo-title-separator", text: "/" });
		}
		const trigger = host.el.createEl("button", {
			cls: "knomo-scope-trigger",
			attr: {
				type: "button",
				"aria-haspopup": "menu",
				"aria-expanded": this.scopeMenuOpen ? "true" : "false",
				"data-action": "toggle-scope-menu",
			},
		});
		trigger.createSpan({ cls: "knomo-title-label", text: label });
		setIcon(trigger.createSpan({ cls: "knomo-title-chevron" }), "chevron-down");
	}

	private getDesktopTitleLabel(): string {
		const query = this.searchQuery.trim();
		if (query.length > 0) {
			return t("search.label");
		}
		if (this.searchDateFilter !== null) {
			return getSearchDateLabel(this.searchDateFilter);
		}
		return this.getListTitleLabel();
	}

	private getMobileTitleLabel(): string {
		return this.getListTitleLabel();
	}

	private getListTitleLabel(): string {
		if (this.activeTag !== null) {
			return `#${this.activeTag}`;
		}
		if (this.activeNav !== "all") {
			return getSidebarNavLabel(this.activeNav);
		}
		return getScopeLabel(this.scopeFilter);
	}

	private getCurrentTitleMode(): string {
		if (this.activeNav === "review" || this.activeNav === "random") {
			return this.activeNav;
		}
		if (this.activeTagKey !== null || this.activeNav !== "all") {
			return "";
		}
		return this.scopeFilter;
	}

	private isDefaultListState(): boolean {
		return this.activeNav === "all"
			&& this.activeTagKey === null
			&& this.scopeFilter === "all"
			&& this.searchQuery.trim().length === 0
			&& this.searchDateFilter === null;
	}

	private renderCardFlow(): void {
		if (this.cardFlowEl === null) {
			return;
		}

		const generation = this.renderGeneration + 1;
		this.renderGeneration = generation;
		this.clearMarkdownRenderQueue();
		this.disconnectLoadMoreObserver();
		this.cardFlowEl.empty();
		this.loadMoreSentinelEl = null;
		if (this.cardFlowError !== null) {
			this.renderEmptyState(t("empty.cardFlowFailed"), this.cardFlowError);
			return;
		}
		if (this.activeNav === "trash") {
			this.renderTrashCardFlow(generation);
			return;
		}
		if (this.activeNav === "random" && this.randomReunionLoading) {
			this.renderEmptyState(t("empty.randomLoading"));
			return;
		}
		const memos = this.getFilteredMemos();
		if (memos.length === 0) {
			this.renderEmptyState(getEmptyStateTitle(this.activeNav));
			return;
		}
		if (this.activeNav === "review") {
			this.renderOutsideTodaySummary(memos.length);
		}
		if (this.activeNav === "random") {
			this.renderRandomReunionToolbar(memos.length);
		}
		this.startCardFeed(memos, "memo", generation);
	}

	private renderTrashCardFlow(generation: number): void {
		if (this.trashLoading || this.trashMemos === null) {
			this.renderEmptyState(t("empty.trashLoading"));
			return;
		}
		if (this.trashError !== null) {
			this.renderEmptyState(t("empty.trashFailed"), this.trashError);
			return;
		}
		if (this.trashMemos.length === 0) {
			this.renderEmptyState(t("empty.trashEmptyTitle"), t("empty.trashEmptyDesc"));
			return;
		}
		this.startCardFeed(this.trashMemos, "trash", generation);
	}

	private renderOutsideTodaySummary(count: number): void {
		this.cardFlowEl?.createDiv({
			cls: "knomo-list-summary",
			text: t("list.reviewSummary", { count }),
		});
	}

	private renderRandomReunionToolbar(count: number): void {
		const toolbar = this.cardFlowEl?.createDiv({ cls: "knomo-list-toolbar" });
		if (toolbar === undefined) {
			return;
		}
		toolbar.createDiv({
			cls: "knomo-list-summary",
			text: t("list.randomSummary", { count }),
		});
		toolbar.createEl("button", {
			cls: "knomo-inline-button",
			text: t("list.randomRefresh"),
			attr: {
				type: "button",
				"data-action": "refresh-random-reunion",
			},
		});

	}

	private startCardFeed(memos: MemoRecord[], mode: CardFlowRenderMode, generation: number): void {
		const initialBatchSize = Math.max(this.currentRenderOffset, CARD_BATCH_SIZE);
		this.currentFeedItems = memos;
		this.currentRenderOffset = 0;
		this.feedRenderMode = mode;
		this.hasMoreFeedItems = memos.length > 0;
		this.renderNextCardBatch(generation, initialBatchSize);
	}

	private renderNextCardBatch(generation: number, batchSize = CARD_BATCH_SIZE): void {
		if (this.cardFlowEl === null || this.isLoadingMore || generation !== this.renderGeneration) {
			return;
		}
		const batchStart = this.currentRenderOffset;
		if (batchStart >= this.currentFeedItems.length) {
			this.hasMoreFeedItems = false;
			this.removeLoadMoreSentinel();
			return;
		}

		this.isLoadingMore = true;
		this.removeLoadMoreSentinel();
		const batchEnd = Math.min(batchStart + batchSize, this.currentFeedItems.length);
		const batchMemos = this.currentFeedItems.slice(batchStart, batchEnd);
		for (const [index, memo] of batchMemos.entries()) {
			if (generation !== this.renderGeneration) {
				this.isLoadingMore = false;
				return;
			}
			const renderIndex = batchStart + index;
			if (this.feedRenderMode === "trash") {
				this.renderTrashMemoCard(memo, generation, renderIndex);
			} else {
				this.renderMemoCard(memo, generation, renderIndex);
			}
		}
		if (generation !== this.renderGeneration) {
			this.isLoadingMore = false;
			return;
		}
		this.currentRenderOffset = batchEnd;
		this.hasMoreFeedItems = this.currentRenderOffset < this.currentFeedItems.length;
		this.isLoadingMore = false;
		if (this.hasMoreFeedItems) {
			this.renderLoadMoreSentinel(this.currentFeedItems.length - this.currentRenderOffset, generation);
		}
	}

	private renderLoadMoreSentinel(remainingCount: number, generation: number): void {
		const sentinel = this.cardFlowEl?.createEl("button", {
			cls: "knomo-load-more",
			text: t("list.loadMore", { count: remainingCount }),
			attr: {
				type: "button",
				"data-action": "load-more",
				"data-load-more-sentinel": "true",
			},
		});
		if (sentinel === undefined) {
			return;
		}
		this.loadMoreSentinelEl = sentinel;
		this.observeLoadMoreSentinel(sentinel, generation);
	}

	private observeLoadMoreSentinel(sentinel: HTMLElement, generation: number): void {
		const cardFlow = this.cardFlowEl;
		const Observer = (this.containerEl.win as WindowWithIntersectionObserver).IntersectionObserver;
		if (cardFlow === null || Observer === undefined) {
			return;
		}
		const observer = new Observer((entries: IntersectionObserverEntry[]) => {
			if (generation !== this.renderGeneration || !entries.some((entry) => entry.isIntersecting)) {
				return;
			}
			this.renderNextCardBatch(generation);
		}, {
			root: cardFlow,
			rootMargin: "240px 0px",
			threshold: 0,
		});
		this.loadMoreObserver = observer;
		observer.observe(sentinel);
	}

	private removeLoadMoreSentinel(): void {
		this.disconnectLoadMoreObserver();
		this.loadMoreSentinelEl?.detach();
		this.loadMoreSentinelEl = null;
	}

	private disconnectLoadMoreObserver(): void {
		this.loadMoreObserver?.disconnect();
		this.loadMoreObserver = null;
	}

	private renderMemoCard(memo: MemoRecord, generation: number, renderIndex: number): void {
		if (this.cardFlowEl === null) {
			return;
		}
		this.renderMemoCardInContainer(this.cardFlowEl, memo, generation, renderIndex, true, this.activeNav === "random");
	}

	private renderMemoCardInContainer(
		container: HTMLElement,
		memo: MemoRecord,
		generation: number,
		renderIndex: number,
		includeActions: boolean,
		randomCard: boolean,
	): void {
		const markdownPriority = getMarkdownRenderPriority(renderIndex);
		const cardAttrs: Record<string, string> = { "data-memo-id": memo.id };
		let randomCardDescriptionId: string | null = null;
		if (randomCard) {
			randomCardDescriptionId = this.getA11yId(`random-card-${renderIndex}-description`);
			cardAttrs.tabindex = "0";
			cardAttrs["aria-describedby"] = randomCardDescriptionId;
			cardAttrs["data-random-reunion-card"] = "true";
		}
		const card = container.createEl("article", {
			cls: includeActions && this.activeMenuMemoId === memo.id ? "knomo-card is-menu-open" : "knomo-card",
			attr: cardAttrs,
		});
		if (randomCardDescriptionId !== null) {
			card.createSpan({
				cls: "knomo-visually-hidden",
				text: t("card.openSourceHint"),
				attr: { id: randomCardDescriptionId },
			});
		}
		const head = card.createDiv({ cls: "knomo-card-head" });
		head.createDiv({ cls: "knomo-card-time", text: formatMemoDisplayTime(memo.createdAt) });
		if (includeActions) {
			const menu = head.createEl("button", {
				cls: "knomo-card-menu",
				attr: {
					type: "button",
					"aria-label": t("card.moreActions"),
					"aria-expanded": this.activeMenuMemoId === memo.id ? "true" : "false",
					"data-action": "toggle-card-menu",
					"data-memo-id": memo.id,
				},
			});
			setIcon(menu, "more-horizontal");

			const actions = head.createDiv({ cls: "knomo-card-actions", attr: { role: "menu" } });
			this.renderCardAction(actions, memo.id, "edit", t("card.edit"));
			this.renderCardAction(actions, memo.id, "reference", t("card.reference"));
			this.renderCardAction(actions, memo.id, "copy-text", t("card.copyText"));
			this.renderCardAction(actions, memo.id, "copy-link", t("card.copyLink"));
			this.renderCardAction(actions, memo.id, "delete", t("card.delete"));
		}

		const content = card.createDiv({ cls: "knomo-card-content markdown-rendered" });
		this.queueMemoMarkdown(memo, content, generation, markdownPriority);
		this.renderCardMeta(card, memo, generation);
	}

	private renderTrashMemoCard(memo: MemoRecord, generation: number, renderIndex: number): void {
		if (this.cardFlowEl === null) {
			return;
		}
		const markdownPriority = getMarkdownRenderPriority(renderIndex);
		const busyAction = this.trashBusyMemoActions.get(memo.id) ?? null;
		const card = this.cardFlowEl.createEl("article", {
			cls: busyAction !== null ? "knomo-card knomo-trash-card is-busy" : "knomo-card knomo-trash-card",
			attr: { "data-memo-id": memo.id },
		});
		const head = card.createDiv({ cls: "knomo-card-head" });
		head.createDiv({ cls: "knomo-card-time", text: t("trash.createdAt", { time: formatMemoDisplayTime(memo.createdAt) }) });
		const actions = head.createDiv({ cls: "knomo-trash-actions" });
		this.renderTrashAction(actions, memo.id, "restore", busyAction === "restore" ? t("trash.restoring") : t("trash.restore"), busyAction !== null);
		this.renderTrashAction(actions, memo.id, "purge", busyAction === "purge" ? t("trash.purging") : t("trash.purge"), busyAction !== null);

		const content = card.createDiv({ cls: "knomo-card-content markdown-rendered" });
		this.queueMemoMarkdown(memo, content, generation, markdownPriority);

		const meta = card.createDiv({ cls: "knomo-card-meta knomo-trash-meta" });
		meta.createDiv({ text: t("trash.deletedAt", { time: formatOptionalMemoTime(memo.deletedAt) }) });
		if (memo.deleteSource !== undefined && memo.deleteSource.trim().length > 0) {
			meta.createDiv({ text: t("trash.deleteSource", { source: formatDeleteSource(memo.deleteSource) }) });
		}
		if (memo.issue !== null) {
			card.createDiv({ cls: "knomo-card-warning", text: formatSettingsText(memo.issue.message) });
		}
	}

	private renderTrashAction(
		container: HTMLElement,
		memoId: string,
		action: "restore" | "purge",
		label: string,
		disabled: boolean,
	): void {
		container.createEl("button", {
			cls: action === "purge" ? "knomo-inline-button is-danger" : "knomo-inline-button",
				text: label,
				attr: {
					type: "button",
					"data-trash-action": action,
					"data-memo-id": memoId,
				},
		}).disabled = disabled;
	}

	private renderCardMeta(card: HTMLElement, memo: MemoRecord, generation: number): void {
		if (memo.sourceMemoId !== null && !this.deletedMemoIds.has(memo.sourceMemoId)) {
			const sourceReferenceText = getSourceReferenceText(memo);
			const meta = card.createDiv({ cls: "knomo-card-meta knomo-source-reference markdown-rendered" });
			if (sourceReferenceText === null) {
				meta.setText(`${t("reference.fromPrefix")}${memo.sourceMemoId}`);
			} else {
				this.queueSourceReferenceMarkdown(meta, `${t("reference.fromPrefix")}${sourceReferenceText}`, memo.dailyRef.path, generation);
			}
		}
		if (memo.syncStatus !== "synced") {
			card.createDiv({ cls: "knomo-card-warning", text: formatSettingsText(memo.issue?.message ?? memo.syncStatus) });
		}
		if (memo.issue !== null && memo.syncStatus === "synced") {
			card.createDiv({ cls: "knomo-card-warning", text: formatSettingsText(memo.issue.message) });
		}
	}

	private renderCardAction(container: HTMLElement, memoId: string, action: string, label: string): void {
		container.createEl("button", {
			cls: action === "delete" ? "knomo-card-action is-danger" : "knomo-card-action",
			text: label,
			attr: {
				type: "button",
				role: "menuitem",
				"data-memo-action": action,
				"data-memo-id": memoId,
			},
		});
	}

	private renderEmptyState(title = t("empty.generic"), description = ""): void {
		if (this.cardFlowEl === null) {
			return;
		}
		const emptyState = this.cardFlowEl.createDiv({ cls: "knomo-empty-state" });
		emptyState.createDiv({ cls: "knomo-empty-title", text: title });
		if (description.length > 0) {
			emptyState.createDiv({ cls: "knomo-empty-description", text: description });
		}
	}

	private async handleRootClick(event: MouseEvent): Promise<void> {
		const target = event.target as Node | null;
		if (target === null || !target.instanceOf(Element)) {
			return;
		}

		const tagToggleEl = target.closest("[data-tag-toggle]");
		if (tagToggleEl?.instanceOf(HTMLElement)) {
			event.preventDefault();
			const tag = tagToggleEl.getAttr("data-tag-toggle");
			if (tag === null) {
				return;
			}
			if (this.expandedTagGroups.has(tag)) {
				this.expandedTagGroups.delete(tag);
			} else {
				this.expandedTagGroups.add(tag);
			}
			this.renderTags();
			return;
		}

		const tagEl = target.closest("[data-tag]");
		if (tagEl?.instanceOf(HTMLElement)) {
			event.preventDefault();
			const tag = tagEl.getAttr("data-tag");
			if (tag === null) {
				return;
			}
			const tagKey = tagEl.getAttr("data-tag-key") ?? normalizeTagKey(tag);
			if (tagKey.length === 0) {
				return;
			}
			this.clearSearchDebounce();
			this.clearDesktopSearchState();
			if (this.activeTagKey === tagKey) {
				this.clearActiveTag();
			} else {
				this.activeTag = tag;
				this.activeTagKey = tagKey;
			}
			this.scopeFilter = "all";
			this.activeNav = "all";
			this.resetVisibleMemos();
			this.mobileDrawerOpen = false;
			this.scopeMenuOpen = false;
			this.activeMenuMemoId = null;
			this.renderUiState();
			return;
		}

		const navEl = target.closest("[data-nav]");
		if (navEl?.instanceOf(HTMLElement)) {
			const nav = navEl.getAttr("data-nav");
			if (isSidebarNav(nav)) {
				this.setSidebarNav(nav);
			}
			return;
		}

		const titleModeEl = target.closest("[data-title-mode]");
		if (titleModeEl?.instanceOf(HTMLElement)) {
			const mode = titleModeEl.getAttr("data-title-mode");
			if (isTitleMode(mode)) {
				this.setTitleMode(mode);
			}
			return;
		}

		const searchDateEl = target.closest("[data-search-date]");
		if (searchDateEl?.instanceOf(HTMLElement)) {
			const filter = searchDateEl.getAttr("data-search-date");
				if (isSearchDateFilter(filter)) {
					if (this.currentLayout === "mobile" && this.mobileSearchPageOpen) {
						this.setMobileSearchDateFilter(filter);
					} else {
						this.setSearchDateFilter(filter, searchDateEl);
					}
				}
			return;
		}

		const trashActionEl = target.closest("[data-trash-action]");
		if (trashActionEl?.instanceOf(HTMLElement)) {
			const memoId = trashActionEl.getAttr("data-memo-id");
			const action = trashActionEl.getAttr("data-trash-action");
			const memo = this.trashMemos?.find((item) => item.id === memoId) ?? null;
			if (memo !== null && isTrashAction(action)) {
				await this.handleTrashAction(action, memo);
			}
			return;
		}

		const memoActionEl = target.closest("[data-memo-action]");
		if (memoActionEl?.instanceOf(HTMLElement)) {
			const memoId = memoActionEl.getAttr("data-memo-id");
			const action = memoActionEl.getAttr("data-memo-action");
			const memo = this.memos.find((item) => item.id === memoId);
			if (memo !== undefined && action !== null) {
				await this.handleMemoAction(action, memo);
			}
			return;
		}

		const actionEl = target.closest("[data-action]");
		if (actionEl?.instanceOf(HTMLElement)) {
			const action = actionEl.getAttr("data-action");
			const memoId = actionEl.getAttr("data-memo-id");
			if (this.shouldIgnoreHandledMobileToolClick(actionEl, action)) {
				return;
			}
			const mobileToolButton = this.currentLayout === "mobile" ? target.closest(".knomo-tool-button") : null;
			await this.handleAction(action, memoId);
			if (mobileToolButton?.instanceOf(HTMLElement)) {
				mobileToolButton.blur();
			}
			return;
		}

		const randomReunionCardEl = target.closest("[data-random-reunion-card]");
		if (randomReunionCardEl?.instanceOf(HTMLElement) && shouldOpenRandomReunionCard(target)) {
			const memoId = randomReunionCardEl.getAttr("data-memo-id");
			if (memoId !== null) {
				await this.openRandomReunionMemo(memoId);
			}
			return;
		}

		if (target.closest(".knomo-card-actions") === null && target.closest(".knomo-card-menu") === null) {
			this.closeCardMenu();
		}
		if (target.closest(".knomo-scope-popover") === null && target.closest("[data-action='toggle-scope-menu']") === null) {
			this.scopeMenuOpen = false;
			this.syncRootState();
		}
		if (target.closest(".knomo-search-wrap, .knomo-compact-search-wrap, .knomo-search-menu") === null) {
			this.desktopSearchOpen = false;
			this.syncRootState();
		}
		if (target.closest(".knomo-compact-search-panel") === null && target.closest("[data-action='toggle-compact-search']") === null) {
			this.compactSearchOpen = false;
			this.syncRootState();
		}
	}

	private async handleAction(action: string | null, memoId: string | null): Promise<void> {
		if (action === null) {
			return;
		}
		if (action === "toggle-card-menu") {
			if (this.currentLayout !== "mobile") {
				this.scopeMenuOpen = false;
				this.desktopSearchOpen = false;
				this.compactSearchOpen = false;
				this.syncRootState();
			}
			this.activeMenuMemoId = this.activeMenuMemoId === memoId ? null : memoId;
			this.syncCardMenuState();
			return;
		}
		if (action === "refresh-random-reunion") {
			await this.refreshRandomReunionMemos();
			return;
		}
		if (action === "load-more") {
			this.renderNextCardBatch(this.renderGeneration);
			return;
		}
		if (action === "load-more-mobile-search") {
			this.loadMoreMobileSearchResults();
			return;
		}
		if (action === "reset-list-state") {
			this.resetToAllNotes();
			return;
		}
		if (action === "close-mobile-search") {
			this.closeMobileSearchPage();
			return;
		}
		if (action === "open-drawer") {
			if (this.composerOpen) {
				this.closeComposerKeepingDraft();
			}
			this.mobileDrawerOpen = true;
		}
		if (action === "close-drawer") this.mobileDrawerOpen = false;
		if (action === "toggle-scope-menu") {
			this.scopeMenuOpen = !this.scopeMenuOpen;
			this.desktopSearchOpen = false;
			if (this.currentLayout !== "mobile") {
				this.compactSearchOpen = false;
				this.activeMenuMemoId = null;
			}
		}
		if (action === "toggle-sidebar") this.toggleSidebar();
		if (action === "collapse-sidebar") {
			if (this.isDrawerLayout()) {
				this.mobileDrawerOpen = false;
			} else {
				this.setSidebarCollapsed(true);
			}
		}
		if (action === "refresh") {
			await this.handleManualRefresh();
			return;
		}
		if (action === "focus-stats") this.sidebarEl?.querySelector<HTMLElement>(".knomo-sidebar-stats")?.focus();
		if (action === "open-composer") {
			this.openComposer();
			return;
		}
		if (action === "close-composer") {
			this.closeComposerWithConfirm();
			return;
		}
		if (action === "toggle-compact-search") {
			this.compactSearchOpen = !this.compactSearchOpen;
			this.desktopSearchOpen = false;
			if (this.currentLayout !== "mobile") {
				this.activeMenuMemoId = null;
			}
		}
		if (this.runComposerToolAction(action)) {
			return;
		}
		if (action === "clear-reference") {
			this.clearReference();
			return;
		}
		if (action === "cancel-edit") {
			this.cancelEditing();
			return;
		}
		if (action === "save-input") {
			if (this.currentLayout === "mobile" && Date.now() - this.lastMobileSendPointerAt < 700) {
				return;
			}
			await this.saveInput();
			return;
		}
		this.renderUiState();
	}

	private async handleRootKeydown(event: KeyboardEvent): Promise<void> {
		if ((event.ctrlKey || event.metaKey) && event.key === "\\") {
			event.preventDefault();
			this.toggleSidebar();
			return;
		}
		const target = event.target as Node | null;
		if ((event.key === "Enter" || event.key === " ") && target?.instanceOf(Element)) {
			const randomReunionCardEl = target.closest("[data-random-reunion-card]");
			if (randomReunionCardEl?.instanceOf(HTMLElement) && shouldOpenRandomReunionCard(target)) {
				const memoId = randomReunionCardEl.getAttr("data-memo-id");
				if (memoId !== null) {
					event.preventDefault();
					await this.openRandomReunionMemo(memoId);
				}
				return;
			}
		}
		if (event.key !== "Escape") {
			return;
		}
		if (this.mobileSearchPageOpen) {
			event.preventDefault();
			this.closeMobileSearchPage();
			return;
		}
		if (this.composerOpen) {
			event.preventDefault();
			this.closeComposerKeepingDraft();
			return;
		}
		if (this.editingMemo !== null || this.quoteSourceMemoId !== null) {
			event.preventDefault();
			this.cancelEditingOrCloseComposer();
			return;
		}
		if (
			this.activeMenuMemoId !== null ||
			this.scopeMenuOpen ||
			this.desktopSearchOpen ||
			this.compactSearchOpen ||
			this.mobileDrawerOpen ||
			this.composerOpen
		) {
			event.preventDefault();
			this.activeMenuMemoId = null;
			this.scopeMenuOpen = false;
			this.desktopSearchOpen = false;
			this.compactSearchOpen = false;
			this.mobileDrawerOpen = false;
			this.composerOpen = false;
			this.clearMobileComposerFocus();
			this.mobileComposerInputFocused = false;
			this.stopMobileViewportTracking();
			this.renderUiState();
		}
	}

	private async handleMemoAction(action: string, memo: MemoRecord): Promise<void> {
		this.activeMenuMemoId = null;
		const shouldCloseMobileSearch = this.currentLayout === "mobile" && this.mobileSearchPageOpen;
		try {
			if (action === "edit") {
				if (shouldCloseMobileSearch) {
					this.closeMobileSearchPage();
				}
				this.startEditing(memo);
				this.syncCardMenuState();
				return;
			} else if (action === "reference") {
				const referenceText = await this.referenceService.createReferenceText(memo, "link");
				if (shouldCloseMobileSearch) {
					this.closeMobileSearchPage();
				}
				this.startReferenceMemo(memo, withMemoIdAlias(referenceText, memo.id));
				this.syncCardMenuState();
				return;
			} else if (action === "copy-text") {
				await this.copyText(memo.contentSnapshot);
				new Notice(t("notice.copiedText"));
			} else if (action === "copy-link") {
				const referenceText = await this.referenceService.createReferenceText(memo, "link");
				await this.copyText(referenceText);
				new Notice(t("notice.copiedLink"));
			} else if (action === "delete") {
				const confirmed = this.containerEl.win.confirm(t("confirm.deleteMemo"));
				if (!confirmed) {
					this.renderUiState();
					return;
				}
				await this.syncOrchestrator.deleteMemo(memo);
				new Notice(t("notice.deleted"));
				await this.onMemosChanged();
				return;
			}
			this.renderUiState();
		} catch (error) {
			const message = formatSettingsText(error instanceof Error ? error.message : t("error.operationFailed"));
			new Notice(message);
			this.renderUiState();
		}
	}

	private async saveInput(): Promise<void> {
		if (this.inputEl === null || this.isSaving) {
			return;
		}

		const input = this.inputEl.value;
		if (input.trim().length === 0) {
			this.updateStatus(t("composer.emptyContent"), true);
			this.updateSendButtonState();
			return;
		}
		const isMobileSave = this.currentLayout === "mobile";
		const mobileScrollTop = isMobileSave ? this.mobileComposerOpenScrollTop ?? this.getCardFlowScrollTop() : null;
		const createInput = this.editingMemo === null ? this.prepareCreateMemoInput(input) : null;
		const content = createInput?.content ?? input;

		this.isSaving = true;
		this.updateStatus("", false);
		this.updateSendButtonState();
		try {
			if (this.editingMemo !== null) {
				await this.syncOrchestrator.updateMemo(this.editingMemo, content);
			} else {
				const sourceMemoId = createInput?.sourceMemoId ?? null;
				await this.syncOrchestrator.createMemo(content, {
					source: sourceMemoId === null ? "plugin_input" : "quote_create",
					sourceMemoId,
					sourceReferenceText: createInput?.sourceReferenceText ?? null,
					dailyTrailer: createInput?.quoteTrailer ?? null,
				});
			}
			this.draftContent = "";
			this.clearComposerContext();
			if (this.inputEl !== null) {
				this.inputEl.value = "";
			}
			if (isMobileSave) {
				this.closeMobileComposerKeepingDraft();
			} else {
				this.composerOpen = false;
				if (this.inputEl !== null) {
					this.resizeInput();
				}
			}
			this.updateStatus("", false);
			await this.onMemosChanged();
			if (isMobileSave) {
				this.restoreCardFlowScrollTop(mobileScrollTop);
				this.mobileComposerOpenScrollTop = null;
			}
		} catch (error) {
			const message = formatSettingsText(error instanceof Error ? error.message : t("error.saveFailed"));
			this.updateStatus(message, true);
			new Notice(message);
		} finally {
			this.isSaving = false;
			this.updateSendButtonState();
			this.syncRootState();
		}
	}

	private async handleManualRefresh(): Promise<void> {
		if (this.activeNav === "trash") {
			await this.loadTrashMemos();
			if (this.trashError === null) {
				new Notice(t("notice.trashRefreshed"));
			}
			return;
		}
		try {
			const result = await this.onManualRefresh();
			const failed = result.failed;
			if (failed > 0) {
				const message = t("notice.refreshFailedCount", { count: failed });
				new Notice(message);
				return;
			}
			if (result.created > 0 || result.updated > 0 || result.deleted > 0) {
				new Notice(t("notice.refreshComplete", { created: result.created, updated: result.updated, deleted: result.deleted }));
				return;
			}
			new Notice(t("notice.upToDate"));
		} catch (error) {
			const message = formatSettingsText(error instanceof Error ? error.message : t("error.refreshFailed"));
			new Notice(message);
		}
	}

	private setScope(scope: ScopeFilter): void {
		this.clearSearchDebounce();
		this.clearDesktopSearchState();
		this.scopeFilter = scope;
		this.clearActiveTag();
		this.activeNav = "all";
		this.resetVisibleMemos();
		this.mobileDrawerOpen = false;
		this.desktopSearchOpen = false;
		this.scopeMenuOpen = false;
		this.renderUiState();
		if (needsAllMemos(scope, this.searchQuery, this.searchDateFilter)) {
			void this.ensureAllMemosLoaded();
		}
	}

	private setSearchQuery(query: string): void {
		this.clearSearchDebounce();
		this.searchQuery = query;
		if (query.trim().length > 0 || this.searchDateFilter !== null) {
			this.clearActiveTag();
			this.activeNav = "all";
			this.scopeFilter = "all";
		}
		this.activeMenuMemoId = null;
		this.activeNav = "all";
		this.resetVisibleMemos();
		this.renderCardFlow();
		this.renderScopeState();
		this.syncSearchInputs();
		if (needsAllMemos(this.scopeFilter, query, this.searchDateFilter)) {
			void this.ensureAllMemosLoaded();
		}
	}

	private setSearchDateFilter(filter: SearchDateFilter, sourceEl: HTMLElement | null = null): void {
		this.flushDesktopSearchQuery(sourceEl);
		this.searchDateFilter = this.searchDateFilter === filter ? null : filter;
		this.clearActiveTag();
		this.activeNav = "all";
		this.scopeFilter = "all";
		this.activeMenuMemoId = null;
		this.desktopSearchOpen = false;
		this.compactSearchOpen = false;
		if (this.currentLayout !== "mobile") {
			this.syncRootState();
		}
		this.resetVisibleMemos();
		this.renderCardFlow();
		this.renderScopeState();
		this.syncSearchInputs();
		if (needsAllMemos(this.scopeFilter, this.searchQuery, this.searchDateFilter)) {
			void this.ensureAllMemosLoaded();
		}
	}

	private flushDesktopSearchQuery(sourceEl: HTMLElement | null): void {
		this.clearSearchDebounce();
		const input = sourceEl
			?.closest(".knomo-search-wrap, .knomo-compact-search-wrap")
			?.querySelector(".knomo-search-input");
		if (input?.instanceOf(HTMLInputElement)) {
			this.searchQuery = input.value;
		}
	}

	private queueSearchQuery(query: string): void {
		this.clearSearchDebounce();
		this.searchDebounceTimeoutId = this.containerEl.win.setTimeout(() => {
			this.searchDebounceTimeoutId = null;
			this.setSearchQuery(query);
		}, SEARCH_DEBOUNCE_MS);
	}

	private clearSearchDebounce(): void {
		if (this.searchDebounceTimeoutId === null) {
			return;
		}
		this.containerEl.win.clearTimeout(this.searchDebounceTimeoutId);
		this.searchDebounceTimeoutId = null;
	}

	private clearDesktopSearchState(): void {
		this.searchQuery = "";
		this.searchDateFilter = null;
	}

	private clearActiveTag(): void {
		this.activeTag = null;
		this.activeTagKey = null;
	}

	private setSidebarNav(nav: SidebarNav): void {
		this.clearSearchDebounce();
		this.clearDesktopSearchState();
		this.activeNav = nav;
		this.clearActiveTag();
		this.scopeFilter = "all";
		this.resetVisibleMemos();
		this.mobileDrawerOpen = false;
		this.scopeMenuOpen = false;
		this.activeMenuMemoId = null;
		if (nav !== "random") {
			this.randomReunionMemos = null;
		}
		this.renderUiState();
		if (nav === "review") {
			void this.ensureAllMemosLoaded();
		}
		if (nav === "random") {
			void this.refreshRandomReunionMemos();
		}
		if (nav === "trash") {
			void this.loadTrashMemos();
		}
	}

	private setTitleMode(mode: TitleMode): void {
		const option = TITLE_MODE_OPTIONS.find((item) => item.mode === mode);
		if (option === undefined) {
			return;
		}
		if (option.nav !== undefined) {
			this.setSidebarNav(option.nav);
			return;
		}
		this.setScope(option.scope ?? "all");
	}

	private resetToAllNotes(): void {
		this.clearSearchDebounce();
		this.clearDesktopSearchState();
		this.clearActiveTag();
		this.activeNav = "all";
		this.scopeFilter = "all";
		this.mobileDrawerOpen = false;
		this.scopeMenuOpen = false;
		this.desktopSearchOpen = false;
		this.compactSearchOpen = false;
		this.activeMenuMemoId = null;
		this.resetVisibleMemos();
		this.renderUiState();
	}

	private openDesktopSearch(): void {
		this.desktopSearchOpen = true;
		this.scopeMenuOpen = false;
		if (this.currentLayout !== "mobile") {
			this.activeMenuMemoId = null;
			this.syncCardMenuState();
		}
		this.syncRootState();
	}

	private getCardFlowScrollTop(): number | null {
		return this.cardFlowEl?.scrollTop ?? null;
	}

	private restoreCardFlowScrollTop(scrollTop: number | null): void {
		if (scrollTop === null || this.cardFlowEl === null) {
			return;
		}
		const flow = this.cardFlowEl;
		flow.scrollTop = scrollTop;
		this.containerEl.win.requestAnimationFrame(() => {
			flow.scrollTop = scrollTop;
		});
	}

	private openComposer(): void {
		if (this.currentLayout === "mobile") {
			this.openMobileComposer();
			return;
		}
		this.clearMobileComposerCloseTimer();
		this.mobileComposerPhase = "closed";
		this.composerOpen = true;
		this.mobileDrawerOpen = false;
		this.scopeMenuOpen = false;
		this.syncRootState();
		this.focusComposerInputSoon();
	}

	private openMobileComposer(): void {
		if (this.currentLayout === "mobile" && !this.composerOpen) {
			this.mobileComposerOpenScrollTop = this.getCardFlowScrollTop();
		}
		this.clearMobileComposerCloseTimer();
		this.clearMobileComposerFocus();
		this.composerOpen = true;
		this.mobileComposerPhase = "opening";
		this.mobileComposerInputFocused = false;
		this.mobileKeyboardFocusStartedAt = null;
		this.mobileDrawerOpen = false;
		this.scopeMenuOpen = false;
		this.ensureMobileComposerLayer();
		this.mobileComposerLayerEl?.toggleClass("is-open", false);
		this.mobileComposerLayerEl?.toggleClass("is-closing", false);
		this.clearMobileKeyboardMetrics();
		this.mobileComposerViewportBaselineHeight = this.containerEl.win.innerHeight;
		this.updateMobileComposerMeasurements();
		this.syncRootState();
		this.mobileComposerFocusFrameId = this.containerEl.win.requestAnimationFrame(() => {
			this.mobileComposerFocusFrameId = null;
			if (this.mobileComposerPhase !== "opening") {
				return;
			}
			this.mobileComposerLayerEl?.toggleClass("is-open", true);
			this.mobileComposerFocusTimerId = this.containerEl.win.setTimeout(() => {
				this.mobileComposerFocusTimerId = null;
				if (this.mobileComposerPhase !== "opening") {
					return;
				}
				this.mobileComposerPhase = "focusing";
				this.focusComposerInputNow(false, false);
				this.scheduleMobileKeyboardMeasurements();
				this.startMobileViewportTracking();
				this.mobileComposerFocusTimerId = this.containerEl.win.setTimeout(() => {
					this.mobileComposerFocusTimerId = null;
					if (this.mobileComposerPhase === "focusing") {
						this.updateMobileKeyboardMetrics();
						this.mobileComposerPhase = "open";
					}
				}, 260);
			}, 100);
		});
	}

	private closeComposerWithConfirm(): void {
		if (this.currentLayout === "mobile") {
			this.closeComposerKeepingDraft();
			return;
		}
		if (this.inputEl !== null && this.inputEl.value.trim().length > 0) {
			const confirmed = this.containerEl.win.confirm(t("composer.closeConfirm"));
			if (!confirmed) {
				return;
			}
			this.draftContent = this.inputEl.value;
		}
		this.composerOpen = false;
		this.syncRootState();
	}

	private closeComposerKeepingDraft(): void {
		if (this.currentLayout === "mobile") {
			this.closeMobileComposerKeepingDraft();
			return;
		}
		if (this.inputEl !== null) {
			this.draftContent = this.getDraftForClose(this.inputEl.value);
			this.inputEl.value = this.draftContent;
		}
		this.composerOpen = false;
		this.clearMobileComposerFocus();
		this.mobileComposerInputFocused = false;
		this.mobileKeyboardFocusStartedAt = null;
		this.stopMobileViewportTracking();
		this.syncRootState();
		this.syncComposerMode();
		this.updateSendButtonState();
		this.updateCancelEditButtonState();
	}

	private closeMobileComposerKeepingDraft(): void {
		if (this.inputEl !== null) {
			this.draftContent = this.getDraftForClose(this.inputEl.value);
			this.inputEl.value = this.draftContent;
		}
		this.clearComposerContext();
		this.mobileComposerOpenScrollTop = null;
		this.clearMobileComposerFocus();
		this.clearMobileKeyboardMeasureTimers();
		this.clearMobileComposerCloseTimer();
		this.mobileComposerPhase = "closing";
		this.mobileComposerLayerEl?.toggleClass("is-open", false);
		this.mobileComposerLayerEl?.toggleClass("is-closing", true);
		this.inputEl?.blur();
		this.mobileComposerInputFocused = false;
		this.mobileKeyboardFocusStartedAt = null;
		this.mobileComposerCloseTimer = this.containerEl.win.setTimeout(() => {
			this.mobileComposerCloseTimer = null;
			this.restoreMobileComposerLayer();
			this.clearMobileComposerLayerState();
			this.mobileComposerLayerEl?.detach();
			this.stopMobileViewportTracking(false);
			this.clearMobileKeyboardMetrics();
			this.composerOpen = false;
			this.mobileComposerPhase = "closed";
			this.syncRootState();
			this.syncComposerMode();
			this.updateSendButtonState();
			this.updateCancelEditButtonState();
		}, 240);
	}

	private focusComposerInputSoon(): void {
		this.clearMobileComposerFocus();
		if (this.currentLayout !== "mobile") {
			this.focusComposerInputNow();
			return;
		}
		const win = this.containerEl.win;
		this.mobileComposerFocusFrameId = win.requestAnimationFrame(() => {
			this.mobileComposerFocusFrameId = null;
			if (this.inputEl !== null && this.containerEl.doc.activeElement !== this.inputEl) {
				this.focusComposerInputNow();
			} else {
				this.queueMobileViewportUpdate();
			}
		});
	}

	private focusComposerInputNow(shouldResize = true, shouldQueueViewport = true): void {
		if (this.inputEl === null) {
			return;
		}
		try {
			this.inputEl.focus({ preventScroll: true });
		} catch {
			this.inputEl.focus();
		}
		if (shouldResize) {
			this.resizeInput();
		}
		if (shouldQueueViewport && this.currentLayout === "mobile") {
			this.queueMobileViewportUpdate();
		}
	}

	private handleComposerInputFocus(): void {
		if (this.currentLayout === "mobile") {
			this.mobileComposerInputFocused = true;
			this.mobileKeyboardFocusStartedAt = Date.now();
			this.scheduleMobileKeyboardMeasurements();
			if (this.mobileComposerPhase === "open") {
				this.queueMobileViewportUpdate();
			}
			if (this.mobileComposerPhase === "opening" || this.mobileComposerPhase === "focusing") {
				return;
			}
		}
		this.resizeInput();
	}

	private handleComposerInputBlur(): void {
		this.composerSaveShortcutDown = false;
		if (this.currentLayout === "mobile") {
			this.mobileComposerInputFocused = false;
			this.mobileKeyboardFocusStartedAt = null;
			this.clearMobileKeyboardMeasureTimers();
			if (this.mobileComposerPhase === "closing") {
				return;
			}
			this.clearMobileKeyboardMetrics();
		}
		this.resizeInput();
	}

	private clearMobileComposerFocus(): void {
		if (this.mobileComposerFocusFrameId !== null) {
			this.containerEl.win.cancelAnimationFrame(this.mobileComposerFocusFrameId);
			this.mobileComposerFocusFrameId = null;
		}
		if (this.mobileComposerFocusTimerId !== null) {
			this.containerEl.win.clearTimeout(this.mobileComposerFocusTimerId);
			this.mobileComposerFocusTimerId = null;
		}
	}

	private clearMobileComposerCloseTimer(): void {
		if (this.mobileComposerCloseTimer === null) {
			return;
		}
		this.containerEl.win.clearTimeout(this.mobileComposerCloseTimer);
		this.mobileComposerCloseTimer = null;
	}

	private cancelEditingOrCloseComposer(): void {
		if (this.currentLayout === "mobile") {
			this.closeComposerKeepingDraft();
			return;
		}
		if (this.editingMemo !== null || this.quoteSourceMemoId !== null) {
			this.clearComposerMode();
			return;
		}
		this.closeComposerWithConfirm();
	}

	private cancelEditing(): void {
		if (this.editingMemo === null) {
			return;
		}
		this.clearComposerMode();
	}

	private clearReference(): void {
		this.quoteSourceMemoId = null;
		this.quoteReferenceText = null;
		this.quoteMarkdownText = null;
		this.updateStatus("", false);
		this.syncComposerMode();
		this.updateSendButtonState();
		this.focusComposerInputNow();
	}

	private clearComposerMode(): void {
		this.clearComposerContext();
		this.draftContent = "";
		if (this.inputEl !== null) {
			this.inputEl.value = "";
		}
		this.updateStatus("", false);
		this.renderUiState();
	}

	private clearComposerContext(): void {
		this.editingMemo = null;
		this.quoteSourceMemoId = null;
		this.quoteReferenceText = null;
		this.quoteMarkdownText = null;
	}

	private getComposerMode(): ComposerMode {
		if (this.editingMemo !== null) {
			return "edit";
		}
		if (this.quoteSourceMemoId !== null) {
			return "quote";
		}
		return "create";
	}

	private getDraftForClose(draft: string): string {
		if (this.getComposerMode() !== "quote" || this.quoteMarkdownText === null) {
			return draft;
		}
		const normalizedDraft = draft.replace(/\s+$/g, "");
		const normalizedQuote = this.quoteMarkdownText.trim();
		if (normalizedDraft === normalizedQuote) {
			return "";
		}
		return draft;
	}

	private startEditing(memo: MemoRecord): void {
		this.editingMemo = memo;
		this.quoteSourceMemoId = null;
		this.quoteReferenceText = null;
		this.quoteMarkdownText = null;
		this.draftContent = memo.contentSnapshot;
		if (this.inputEl !== null) {
			this.inputEl.value = memo.contentSnapshot;
		}
		this.openComposer();
		this.resizeInput();
		this.updateStatus("", false);
		this.syncComposerMode();
		this.updateSendButtonState();
		this.updateCancelEditButtonState();
	}

	private startReferenceMemo(memo: MemoRecord, referenceText: string): void {
		this.editingMemo = null;
		this.quoteSourceMemoId = memo.id;
		this.quoteReferenceText = referenceText;
		this.quoteMarkdownText = toMarkdownQuote(memo.contentSnapshot);
		this.openComposer();
		const cursor = this.inputEl?.value.length ?? 0;
		this.inputEl?.setSelectionRange(cursor, cursor);
		this.resizeInput();
		this.updateStatus("", false);
		this.syncComposerMode();
		this.updateSendButtonState();
		this.updateCancelEditButtonState();
	}

	private handleComposerBeforeInput(event: InputEvent): void {
		if (event.defaultPrevented) {
			return;
		}
		const shouldHandleListEnter =
			!this.skipListEnterInputFallback &&
			!event.isComposing &&
			isListEnterInputEvent(event);
		if (shouldHandleListEnter && this.handleListEnterBeforeInput(event)) {
			return;
		}
		if (event.inputType !== "insertText" || event.data !== "#") {
			return;
		}
		event.preventDefault();
		this.insertText("#");
		if (this.currentLayout === "mobile") {
			this.openTagSuggestAfterHashInsert();
		}
	}

	private isComposerSaveShortcut(event: KeyboardEvent): boolean {
		const isMod = event.metaKey || event.ctrlKey;
		if (!isMod) {
			return false;
		}
		return event.key === "Enter" || event.code === "Enter" || event.code === "NumpadEnter";
	}

	private handleComposerKeydown(event: KeyboardEvent): void {
		if (this.handleComposerSaveShortcut(event)) {
			return;
		}
		if (this.currentLayout !== "mobile") {
			if (event.key === "Enter" && event.shiftKey && !event.isComposing) {
				this.markSkipListEnterInputFallback();
			}
			if (this.handleListEnterKeydown(event)) {
				return;
			}
		}
		if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			this.cancelEditingOrCloseComposer();
		}
	}

	private handleComposerKeyup(event: KeyboardEvent): void {
		if (!this.composerSaveShortcutDown) {
			return;
		}
		if (event.key === "Enter" || event.code === "Enter" || event.code === "NumpadEnter" || (!event.metaKey && !event.ctrlKey)) {
			this.composerSaveShortcutDown = false;
		}
	}

	private handleComposerSaveShortcut(event: KeyboardEvent): boolean {
		if (this.inputEl === null || !this.isComposerSaveShortcut(event)) {
			return false;
		}
		const isComposerEvent = event.target === this.inputEl || this.containerEl.doc.activeElement === this.inputEl;
		if (!isComposerEvent) {
			return false;
		}
		event.preventDefault();
		event.stopPropagation();
		event.stopImmediatePropagation();
		if (this.composerSaveShortcutDown || this.isSaving) {
			return true;
		}
		this.composerSaveShortcutDown = true;
		void this.saveInput();
		return true;
	}

	private handleComposerToolPointerDown(event: PointerEvent | MouseEvent): void {
		if (this.currentLayout !== "mobile") {
			return;
		}
		const target = event.target as Node | null;
		if (!target?.instanceOf(Element)) {
			return;
		}
		const toolButton = target.closest(".knomo-tool-button");
		if (!toolButton?.instanceOf(HTMLElement)) {
			return;
		}
		const action = toolButton.getAttr("data-action");
		if (action === null) {
			return;
		}
		if (action === "insert-image") {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		if (this.isHandledMobileToolPointer(toolButton, action)) {
			return;
		}
		if (this.runComposerToolAction(action)) {
			this.markHandledMobileToolPointer(toolButton, action);
		}
	}

	private runComposerToolAction(action: string | null): boolean {
		if (action === "insert-tag") {
			this.insertText("#");
			if (this.currentLayout === "mobile") {
				this.openTagSuggestAfterHashInsert();
			}
			return true;
		}
		if (action === "insert-image") {
			this.openNativeImagePicker();
			return true;
		}
		if (action === "insert-list") {
			this.applyListFormat("bullet");
			return true;
		}
		if (action === "insert-numbered-list") {
			this.applyListFormat("ordered");
			return true;
		}
		return false;
	}

	private markHandledMobileToolPointer(button: HTMLElement, action: string): void {
		this.clearHandledMobileToolPointer();
		this.handledMobileToolPointer = { button, action };
		this.handledMobileToolPointerTimerId = this.containerEl.win.setTimeout(() => {
			this.handledMobileToolPointer = null;
			this.handledMobileToolPointerTimerId = null;
		}, 350);
	}

	private shouldIgnoreHandledMobileToolClick(actionEl: HTMLElement, action: string | null): boolean {
		const handled = this.handledMobileToolPointer;
		if (this.currentLayout !== "mobile" || handled === null || action === null) {
			return false;
		}
		const shouldIgnore = this.isHandledMobileToolPointer(actionEl, action);
		if (shouldIgnore) {
			this.clearHandledMobileToolPointer();
		}
		return shouldIgnore;
	}

	private isHandledMobileToolPointer(button: HTMLElement, action: string): boolean {
		const handled = this.handledMobileToolPointer;
		return handled !== null && handled.button === button && handled.action === action;
	}

	private clearHandledMobileToolPointer(): void {
		this.handledMobileToolPointer = null;
		if (this.handledMobileToolPointerTimerId !== null) {
			this.containerEl.win.clearTimeout(this.handledMobileToolPointerTimerId);
			this.handledMobileToolPointerTimerId = null;
		}
	}

	private handleSendPointerDown(event: PointerEvent | MouseEvent): void {
		if (this.currentLayout !== "mobile") {
			return;
		}
		if (this.isSaving) {
			return;
		}
		if (this.sendButtonEl === null || this.sendButtonEl.disabled) {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		this.lastMobileSendPointerAt = Date.now();
		void this.saveInput();
	}

	private insertText(text: string): void {
		if (this.inputEl === null) {
			return;
		}
		const start = this.inputEl.selectionStart;
		const end = this.inputEl.selectionEnd;
		const insertText = text === "#" ? getHashInsertionText(this.inputEl.value, start) : text;
		this.inputEl.value = `${this.inputEl.value.slice(0, start)}${insertText}${this.inputEl.value.slice(end)}`;
		const nextCursor = start + insertText.length;
		try {
			this.inputEl.focus({ preventScroll: true });
		} catch {
			this.inputEl.focus();
		}
		this.inputEl.setSelectionRange(nextCursor, nextCursor);
		const inputEvent = this.containerEl.doc.createEvent("Event");
		inputEvent.initEvent("input", true, false);
		this.inputEl.dispatchEvent(inputEvent);
	}

	private applyListFormat(type: "bullet" | "ordered"): void {
		if (this.inputEl === null) {
			return;
		}
		const input = this.inputEl;
		const replacement = applyListFormatToText(input.value, input.selectionStart, input.selectionEnd, type);
		input.value = replacement.value;
		try {
			input.focus({ preventScroll: true });
		} catch {
			input.focus();
		}
		input.setSelectionRange(replacement.cursor, replacement.cursor);
		const inputEvent = this.containerEl.doc.createEvent("Event");
		inputEvent.initEvent("input", true, false);
		input.dispatchEvent(inputEvent);
	}

	private handleComposerInput(event: Event): void {
		const pending = this.pendingMobileListEnterCorrection;
		if (pending !== null) {
			this.pendingMobileListEnterCorrection = null;
			if (this.inputEl?.value === pending.nativeValue) {
				this.applyTextareaPatch(pending.patch);
				return;
			}
		}
		if (this.handleListEnterInputFallback(event)) {
			return;
		}
		this.syncInputState();
	}

	private handleListEnterBeforeInput(event: InputEvent): boolean {
		if (this.handleListEnterKeydownDuplicateBeforeInput(event)) {
			return true;
		}
		const patch = this.getCurrentListEnterPatch();
		if (patch === null) {
			return false;
		}
		if (!event.cancelable) {
			this.pendingMobileListEnterCorrection = this.getPendingMobileListEnterCorrection(patch);
			return false;
		}
		event.preventDefault();
		event.stopPropagation();
		this.pendingMobileListEnterCorrection = null;
		this.applyTextareaPatch(patch);
		return true;
	}

	private handleListEnterInputFallback(event: Event): boolean {
		if (this.skipListEnterInputFallback || this.inputEl === null) {
			return false;
		}
		const inputEvent = this.asInputEvent(event);
		if (
			inputEvent !== null &&
			(inputEvent.inputType === "insertFromPaste" || inputEvent.inputType === "insertFromDrop")
		) {
			return false;
		}
		const input = this.inputEl;
		const patch = getListEnterPatchForNativeInput(this.draftContent, input.value, input.selectionStart, input.selectionEnd, {
			allowTextChangeWithNewline: this.currentLayout === "mobile",
		});
		if (patch === null) {
			return false;
		}
		this.applyTextareaPatch(patch);
		return true;
	}

	private handleListEnterKeydownDuplicateBeforeInput(event: InputEvent): boolean {
		const patch = this.listEnterKeydownPatch;
		if (patch === null || this.inputEl === null) {
			return false;
		}
		const input = this.inputEl;
		if (input.value !== patch.value || input.selectionStart !== patch.cursor || input.selectionEnd !== patch.cursor) {
			return false;
		}
		this.clearListEnterKeydownPatch();
		if (!event.cancelable) {
			this.pendingMobileListEnterCorrection = this.getPendingMobileListEnterCorrection(patch);
			return true;
		}
		event.preventDefault();
		event.stopPropagation();
		return true;
	}

	private handleListEnterKeydown(event: KeyboardEvent): boolean {
		if (event.key !== "Enter" || event.shiftKey || event.isComposing) {
			return false;
		}
		const patch = this.getCurrentListEnterPatch();
		if (patch === null) {
			return false;
		}
		event.preventDefault();
		event.stopPropagation();
		this.applyTextareaPatch(patch);
		this.markListEnterKeydownPatch(patch);
		return true;
	}

	private markListEnterKeydownPatch(patch: TextReplacement): void {
		this.clearListEnterKeydownPatch();
		this.listEnterKeydownPatch = patch;
		this.listEnterKeydownPatchTimerId = this.containerEl.win.setTimeout(() => {
			this.listEnterKeydownPatch = null;
			this.listEnterKeydownPatchTimerId = null;
		}, 0);
	}

	private clearListEnterKeydownPatch(): void {
		this.listEnterKeydownPatch = null;
		if (this.listEnterKeydownPatchTimerId !== null) {
			this.containerEl.win.clearTimeout(this.listEnterKeydownPatchTimerId);
			this.listEnterKeydownPatchTimerId = null;
		}
	}

	private markSkipListEnterInputFallback(): void {
		this.clearSkipListEnterInputFallback();
		this.skipListEnterInputFallback = true;
		this.skipListEnterInputFallbackTimerId = this.containerEl.win.setTimeout(() => {
			this.skipListEnterInputFallback = false;
			this.skipListEnterInputFallbackTimerId = null;
		}, 0);
	}

	private clearSkipListEnterInputFallback(): void {
		this.skipListEnterInputFallback = false;
		if (this.skipListEnterInputFallbackTimerId !== null) {
			this.containerEl.win.clearTimeout(this.skipListEnterInputFallbackTimerId);
			this.skipListEnterInputFallbackTimerId = null;
		}
	}

	private asInputEvent(event: Event): InputEvent | null {
		const win = this.inputEl?.ownerDocument.defaultView ?? null;
		if (win === null || typeof win.InputEvent === "undefined") {
			return null;
		}
		return event instanceof win.InputEvent ? event : null;
	}

	private getCurrentListEnterPatch(): TextReplacement | null {
		if (this.inputEl === null) {
			return null;
		}
		const input = this.inputEl;
		return getListEnterPatch(input.value, input.selectionStart, input.selectionEnd);
	}

	private getPendingMobileListEnterCorrection(patch: TextReplacement): PendingMobileListEnterCorrection | null {
		if (this.inputEl === null) {
			return null;
		}
		const input = this.inputEl;
		const start = input.selectionStart;
		const end = input.selectionEnd;
		return {
			patch,
			nativeValue: `${input.value.slice(0, start)}\n${input.value.slice(end)}`,
		};
	}

	private applyTextareaPatch(patch: TextReplacement): void {
		if (this.inputEl === null) {
			return;
		}
		const input = this.inputEl;
		input.value = patch.value;
		input.setSelectionRange(patch.cursor, patch.cursor);
		const inputEvent = this.containerEl.doc.createEvent("Event");
		inputEvent.initEvent("input", true, false);
		input.dispatchEvent(inputEvent);
	}

	private openTagSuggestAfterHashInsert(): void {
		if (this.inputEl === null || this.tagSuggest === null) {
			return;
		}
		const win = this.containerEl.win;
		win.requestAnimationFrame(() => {
			try {
				this.inputEl?.focus({ preventScroll: true });
			} catch {
				this.inputEl?.focus();
			}
			this.tagSuggest?.openForCurrentTrigger();
		});
	}

	private syncInputState(): void {
		this.draftContent = this.inputEl?.value ?? "";
		this.updateSendButtonState();
		if (this.currentLayout === "mobile") {
			this.scheduleMobileComposerResize();
			return;
		}
		this.resizeInput();
	}

	private resizeInput(): void {
		if (this.inputEl === null) {
			return;
		}
		const minHeight = this.currentLayout === "mobile" ? 150 : 48;
		const maxHeight = this.currentLayout === "mobile" ? this.getMobileMaxInputHeight() : 480;
		if (this.currentLayout !== "mobile") {
			this.inputEl.style.height = "auto";
			const nextHeight = Math.min(maxHeight, Math.max(minHeight, this.inputEl.scrollHeight));
			this.inputEl.style.height = `${nextHeight}px`;
			this.inputEl.style.overflowY = this.inputEl.scrollHeight > maxHeight ? "auto" : "hidden";
			return;
		}
		const currentHeight = this.inputEl.getBoundingClientRect().height || minHeight;
		const nextHeight = Math.min(maxHeight, Math.max(minHeight, this.inputEl.scrollHeight));
		if (Math.abs(currentHeight - nextHeight) > 1) {
			this.inputEl.style.height = `${nextHeight}px`;
		}
		this.inputEl.style.overflowY = this.inputEl.scrollHeight > maxHeight ? "auto" : "hidden";
	}

	private getMobileMaxInputHeight(): number {
		if (this.currentLayout === "mobile" && this.mobileComposerInputMaxHeight !== null) {
			return this.mobileComposerInputMaxHeight;
		}
		return this.updateMobileComposerMeasurements();
	}

	private updateStatus(message: string, isError: boolean): void {
		if (this.statusEl === null) {
			return;
		}
		this.statusEl.setText(message);
		this.statusEl.toggleClass("is-error", isError);
	}

	private updateSendButtonState(): void {
		if (this.inputEl === null || this.sendButtonEl === null) {
			return;
		}
		this.sendButtonEl.disabled =
			this.isSaving || this.inputEl.disabled || this.inputEl.value.trim().length === 0;
		const label = this.isSaving ? t("composer.saving") : t("composer.send");
		this.sendButtonEl.setAttr("aria-label", label);
	}

	private updateCancelEditButtonState(): void {
		if (this.cancelEditButtonEl === null) {
			return;
		}
		this.cancelEditButtonEl.toggleAttribute("hidden", this.editingMemo === null);
	}

	private syncSearchInputs(): void {
		const displayedValue = this.searchQuery;
		if (this.desktopSearchInputEl !== null && this.desktopSearchInputEl.value !== displayedValue) {
			this.desktopSearchInputEl.value = displayedValue;
		}
		if (this.compactInlineSearchInputEl !== null && this.compactInlineSearchInputEl.value !== displayedValue) {
			this.compactInlineSearchInputEl.value = displayedValue;
		}
		if (this.compactSearchInputEl !== null && this.compactSearchInputEl.value !== displayedValue) {
			this.compactSearchInputEl.value = displayedValue;
		}
	}

	private getFilteredMemos(): MemoRecord[] {
		if (this.activeNav === "trash") {
			return [];
		}
		if (this.activeNav === "random") {
			return this.randomReunionMemos ?? [];
		}
		const normalizedQuery = this.searchQuery.trim().toLowerCase();
		const searchDateFilter = this.searchDateFilter;
		const activeTagKey = this.activeTagKey;
		const today = new Date();
		const todayKey = formatDatePart(today);
		const cache = this.filteredMemosCache;
		if (
			cache !== null &&
			cache.memos === this.memos &&
			cache.activeTagKey === activeTagKey &&
			cache.activeNav === this.activeNav &&
			cache.scopeFilter === this.scopeFilter &&
			cache.searchQuery === normalizedQuery &&
			cache.searchDateFilter === searchDateFilter &&
			cache.todayKey === todayKey
		) {
			return cache.result;
		}

		let filteredMemos: MemoRecord[];
		if (this.isDesktopSearchActive()) {
			filteredMemos = this.memos.filter((memo) => this.memoMatchesSearch(memo, normalizedQuery, searchDateFilter));
		} else if (this.activeNav === "review") {
			filteredMemos = this.getOutsideTodayMemos(today);
		} else {
			filteredMemos = this.memos.filter((memo) => {
				if (activeTagKey !== null && !memo.tags.some((tag) => tagMatchesActiveTagKey(tag, activeTagKey))) {
					return false;
				}
				if (normalizedQuery.length > 0 && !this.getMemoSearchText(memo).includes(normalizedQuery)) {
					return false;
				}
				return matchesScope(memo, this.scopeFilter);
			});
		}
		this.filteredMemosCache = {
			memos: this.memos,
			activeTagKey,
			activeNav: this.activeNav,
			scopeFilter: this.scopeFilter,
			searchQuery: normalizedQuery,
			searchDateFilter,
			todayKey,
			result: filteredMemos,
		};
		return filteredMemos;
	}

	private isDesktopSearchActive(): boolean {
		return this.searchQuery.trim().length > 0 || this.searchDateFilter !== null;
	}

	private memoMatchesSearch(memo: MemoRecord, normalizedQuery: string, dateFilter: SearchDateFilter | null): boolean {
		if (normalizedQuery.length > 0 && !this.getMemoSearchText(memo).includes(normalizedQuery)) {
			return false;
		}
		if (dateFilter !== null && !this.memoMatchesSearchDate(memo, dateFilter)) {
			return false;
		}
		return true;
	}

	private memoMatchesSearchDate(memo: MemoRecord, filter: SearchDateFilter): boolean {
		const date = this.parseMemoLocalDate(memo);
		if (date === null) {
			return false;
		}
		return matchesSearchDateFilter(date, filter);
	}

	private getOutsideTodayMemos(today: Date): MemoRecord[] {
		const todayDay = today.getDate();
		const todayKey = formatDatePart(today);
		const isLeapDay = today.getMonth() === 1 && todayDay === 29;
		return this.memos
			.map((memo) => ({ memo, date: this.parseMemoLocalDate(memo) }))
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

	private parseMemoLocalDate(memo: MemoRecord): Date | null {
		const createdAtDate = parseLocalDateText(memo.createdAt);
		if (createdAtDate !== null) {
			return createdAtDate;
		}
		const dailyStatus = this.syncOrchestrator.getDailyNotesStatus();
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

	private closeCardMenu(): void {
		if (this.activeMenuMemoId === null) {
			return;
		}
		this.activeMenuMemoId = null;
		this.syncCardMenuState();
	}

	private syncCardMenuState(): void {
		for (const container of [this.cardFlowEl, this.mobileSearchResultsEl]) {
			if (container === null) {
				continue;
			}
			for (const card of container.findAll(".knomo-card")) {
				const isOpen = this.activeMenuMemoId !== null && card.getAttr("data-memo-id") === this.activeMenuMemoId;
				card.toggleClass("is-menu-open", isOpen);
				card.toggleClass("is-menu-above", false);
				card.find(".knomo-card-menu")?.setAttr("aria-expanded", isOpen ? "true" : "false");
				if (isOpen) {
					this.positionOpenCardMenu(card);
				}
			}
		}
	}

	private positionOpenCardMenu(card: HTMLElement): void {
		const actions = card.find(".knomo-card-actions");
		if (!actions?.instanceOf(HTMLElement)) {
			return;
		}
		const mobileSearchResults = card.closest(".knomo-mobile-search-results");
		const flowEl = mobileSearchResults?.instanceOf(HTMLElement) ? mobileSearchResults : this.cardFlowEl;
		if (flowEl === null) {
			return;
		}
		const flowRect = flowEl.getBoundingClientRect();
		const actionsRect = actions.getBoundingClientRect();
		card.toggleClass("is-menu-above", actionsRect.bottom > flowRect.bottom - 8);
	}

	private toggleSidebar(): void {
		if (this.isDrawerLayout()) {
			this.mobileDrawerOpen = !this.mobileDrawerOpen;
			if (this.mobileDrawerOpen && this.composerOpen) {
				this.closeComposerKeepingDraft();
			}
			this.sidebarCollapsed = false;
			this.syncRootState();
			return;
		}
		this.toggleSidebarCollapsed();
	}

	private toggleSidebarCollapsed(): void {
		this.setSidebarCollapsed(!this.sidebarCollapsed);
	}

	private setSidebarCollapsed(collapsed: boolean): void {
		this.sidebarCollapsed = collapsed;
		this.syncRootState();
		void this.persistSidebarPreferences();
	}

	private startSidebarResize(event: PointerEvent): void {
		if (this.sidebarCollapsed || this.sidebarResizerEl === null) {
			return;
		}
		this.sidebarDrag = {
			pointerId: event.pointerId,
			startX: event.clientX,
			startWidth: this.sidebarWidth,
		};
		this.sidebarResizerEl.setPointerCapture(event.pointerId);
		this.rootEl?.toggleClass("is-resizing-sidebar", true);
		event.preventDefault();
	}

	private resizeSidebar(event: PointerEvent): void {
		if (this.sidebarDrag === null || this.sidebarDrag.pointerId !== event.pointerId) {
			return;
		}
		this.setSidebarWidth(this.sidebarDrag.startWidth + event.clientX - this.sidebarDrag.startX, false);
	}

	private stopSidebarResize(event: PointerEvent): void {
		if (this.sidebarDrag === null || this.sidebarDrag.pointerId !== event.pointerId) {
			return;
		}
		if (this.sidebarResizerEl?.hasPointerCapture(event.pointerId)) {
			this.sidebarResizerEl.releasePointerCapture(event.pointerId);
		}
		this.sidebarDrag = null;
		this.rootEl?.toggleClass("is-resizing-sidebar", false);
		void this.persistSidebarPreferences();
	}

	private setSidebarWidth(width: number, persist: boolean): void {
		this.sidebarWidth = clamp(Math.round(width), SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH);
		this.syncRootState();
		if (persist) {
			void this.persistSidebarPreferences();
		}
	}

	private isDrawerLayout(): boolean {
		return (
			this.currentLayout === "desktop-medium" ||
			this.currentLayout === "desktop-narrow" ||
			this.currentLayout === "mobile"
		);
	}

	private async persistSidebarPreferences(): Promise<void> {
		await this.settingsService.updateSettings({
			desktopSidebarWidth: this.sidebarWidth,
			desktopSidebarCollapsed: this.sidebarCollapsed,
		});
	}

	private async ensureAllMemosLoaded(forceReload = false): Promise<boolean> {
		if (this.allMemosLoaded && !forceReload) {
			return true;
		}
		if (this.allMemosLoadingPromise !== null) {
			return this.allMemosLoadingPromise;
		}
		this.allMemosLoadingPromise = this.reloadMemos(true).finally(() => {
			this.allMemosLoadingPromise = null;
		});
		return this.allMemosLoadingPromise;
	}

	private async waitForAllMemosLoading(): Promise<void> {
		if (this.allMemosLoadingPromise !== null) {
			await this.allMemosLoadingPromise;
		}
	}

	private resetVisibleMemos(): void {
		this.currentFeedItems = [];
		this.currentRenderOffset = 0;
		this.isLoadingMore = false;
		this.hasMoreFeedItems = false;
	}

	private invalidateMemoSearchCache(): void {
		this.memoSearchTextCache.clear();
		this.memoSearchCacheSource = this.memos;
	}

	private getMemoSearchText(memo: MemoRecord): string {
		if (this.memoSearchCacheSource !== this.memos) {
			this.invalidateMemoSearchCache();
		}
		const cachedText = this.memoSearchTextCache.get(memo.id);
		if (cachedText !== undefined) {
			return cachedText;
		}
		const searchText = buildMemoSearchText(memo);
		this.memoSearchTextCache.set(memo.id, searchText);
		return searchText;
	}

	private handleCardFlowScroll(): void {
		const cardFlow = this.cardFlowEl;
		if (
			cardFlow === null ||
			this.loadMoreObserver !== null ||
			!this.hasMoreFeedItems ||
			cardFlow.scrollTop + cardFlow.clientHeight < cardFlow.scrollHeight - 160
		) {
			return;
		}
		this.renderNextCardBatch(this.renderGeneration);
	}

	private async refreshTrashCount(render = true): Promise<void> {
		try {
			const deletedMemos = await this.syncOrchestrator.listDeletedMemos();
			this.trashCount = deletedMemos.length;
			this.deletedMemoIds = new Set(deletedMemos.map((memo) => memo.id));
			if (this.trashMemos !== null) {
				this.trashMemos = deletedMemos;
			}
			this.trashError = null;
		} catch (error) {
			this.trashError = formatSettingsText(error instanceof Error ? error.message : t("error.trashCountFailed"));
		}
		if (render) {
			this.renderUiState();
		} else {
			this.renderTrashCount();
			this.renderScopeState();
		}
	}

	private async loadTrashMemos(): Promise<void> {
		if (this.trashLoading) {
			return;
		}
		this.trashLoading = true;
		this.trashError = null;
		this.trashMemos = null;
		if (this.activeNav === "trash") {
			this.renderUiState();
		}
		try {
			const deletedMemos = await this.syncOrchestrator.listDeletedMemos();
			this.trashMemos = deletedMemos;
			this.trashCount = deletedMemos.length;
			this.deletedMemoIds = new Set(deletedMemos.map((memo) => memo.id));
		} catch (error) {
			this.trashMemos = [];
			this.trashError = formatSettingsText(error instanceof Error ? error.message : t("error.trashLoadFailed"));
			new Notice(this.trashError);
		} finally {
			this.trashLoading = false;
			if (this.activeNav === "trash") {
				this.renderUiState();
			} else {
				this.renderTrashCount();
			}
		}
	}

	private async handleTrashAction(action: "restore" | "purge", memo: MemoRecord): Promise<void> {
		if (this.trashBusyMemoActions.has(memo.id)) {
			return;
		}
		if (action === "purge") {
			const confirmed = this.containerEl.win.confirm(t("confirm.purgeMemo"));
			if (!confirmed) {
				return;
			}
		}

		this.trashBusyMemoActions.set(memo.id, action);
		this.renderCardFlow();
		try {
			if (action === "restore") {
				await this.syncOrchestrator.restoreMemo(memo.id);
				this.trashMemos = (this.trashMemos ?? []).filter((item) => item.id !== memo.id);
				this.trashCount = Math.max(0, this.trashCount - 1);
				new Notice(t("notice.restored"));
				await this.onMemosChanged();
				return;
			}

			await this.syncOrchestrator.purgeDeletedMemo(memo.id);
			this.trashMemos = (this.trashMemos ?? []).filter((item) => item.id !== memo.id);
			this.trashCount = Math.max(0, this.trashCount - 1);
			new Notice(t("notice.purged"));
			void this.refreshTrashCount(false);
			this.renderUiState();
		} catch (error) {
			const message = formatSettingsText(formatTrashActionErrorMessage(action, error));
			new Notice(message);
			this.renderUiState();
		} finally {
			this.trashBusyMemoActions.delete(memo.id);
			this.renderCardFlow();
		}
	}

	private async refreshRandomReunionMemos(): Promise<void> {
		if (this.randomReunionLoading) {
			return;
		}
		this.randomReunionLoading = true;
		this.randomReunionMemos = null;
		if (this.activeNav === "random") {
			this.renderUiState();
		}
		try {
			await this.ensureAllMemosLoaded();
			this.randomReunionMemos = await this.randomReunionService.getRandomReunionMemos(
				RANDOM_REUNION_DEFAULT_COUNT,
				this.memos,
			);
		} catch (error) {
			this.randomReunionMemos = [];
			new Notice(formatSettingsText(error instanceof Error ? error.message : t("error.randomLoadFailed")));
		} finally {
			this.randomReunionLoading = false;
			if (this.activeNav === "random") {
				this.renderUiState();
			}
		}
	}

	private async openRandomReunionMemo(memoId: string): Promise<void> {
		const memo = this.findMemoById(memoId);
		if (memo === null) {
			return;
		}
		const line = memo.dailyRef.lineNumberHint === null
			? undefined
			: Math.max(0, memo.dailyRef.lineNumberHint - 1);
		const openState = line === undefined
			? { active: true }
			: { active: true, eState: { line } };
		try {
			await this.app.workspace.openLinkText(memo.dailyRef.path, "", false, openState);
			await this.randomReunionService.markRandomReunionReviewed(memo.id);
		} catch (error) {
			new Notice(formatSettingsText(error instanceof Error ? error.message : t("error.randomOpenFailed")));
		}
	}

	private findMemoById(memoId: string): MemoRecord | null {
		return this.randomReunionMemos?.find((memo) => memo.id === memoId) ?? this.memos.find((memo) => memo.id === memoId) ?? null;
	}

	private startDateChangeWatcher(): void {
		if (this.dateChangeTimeoutId !== null) {
			return;
		}
		const win = this.containerEl.win;
		const now = new Date();
		const nextDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 1);
		const delay = Math.max(1000, nextDay.getTime() - now.getTime());
		this.dateChangeTimeoutId = win.setTimeout(() => {
			this.dateChangeTimeoutId = null;
			this.filteredMemosCache = null;
			this.renderUiState();
			this.startDateChangeWatcher();
			if (this.activeNav === "review") {
				void this.ensureAllMemosLoaded();
			}
		}, delay);
	}

	private stopDateChangeWatcher(): void {
		if (this.dateChangeTimeoutId === null) {
			return;
		}
		this.containerEl.win.clearTimeout(this.dateChangeTimeoutId);
		this.dateChangeTimeoutId = null;
	}

	private prepareCreateMemoInput(input: string): { content: string; sourceMemoId: string | null; sourceReferenceText: string | null; quoteTrailer: string | null } {
		if (this.quoteSourceMemoId === null || this.quoteReferenceText === null || this.quoteMarkdownText === null) {
			return {
				content: input,
				sourceMemoId: null,
				sourceReferenceText: null,
				quoteTrailer: null,
			};
		}
		return {
			content: buildQuoteCreatedMemoContent(
				`${this.quoteMarkdownText}\n\n${input}`,
				this.quoteMarkdownText,
				this.quoteReferenceText,
			),
			sourceMemoId: this.quoteSourceMemoId,
			sourceReferenceText: this.quoteReferenceText,
			quoteTrailer: null,
		};
	}

	private queueMemoMarkdown(memo: MemoRecord, container: HTMLElement, generation: number, priority: MarkdownRenderPriority): void {
		this.enqueueMarkdownRender(priority, generation, () => this.renderMemoMarkdown(memo, container, generation));
	}

	private queueSourceReferenceMarkdown(container: HTMLElement, text: string, sourcePath: string, generation: number): void {
		this.enqueueMarkdownRender("normal", generation, () => this.renderSourceReferenceMarkdown(container, text, sourcePath, generation));
	}

	private enqueueMarkdownRender(priority: MarkdownRenderPriority, generation: number, run: () => Promise<void>): void {
		if (generation !== this.renderGeneration) {
			return;
		}
		const task: MarkdownRenderTask = { generation, run };
		if (priority === "high") {
			this.highPriorityMarkdownQueue.push(task);
		} else {
			this.normalPriorityMarkdownQueue.push(task);
		}
		this.pumpMarkdownRenderQueue();
	}

	private pumpMarkdownRenderQueue(): void {
		while (this.activeMarkdownRenderCount < MARKDOWN_RENDER_CONCURRENCY) {
			const task = this.highPriorityMarkdownQueue.shift() ?? this.normalPriorityMarkdownQueue.shift();
			if (task === undefined) {
				return;
			}
			if (task.generation !== this.renderGeneration) {
				continue;
			}
			this.activeMarkdownRenderCount += 1;
			void this.runMarkdownRenderTask(task);
		}
	}

	private async runMarkdownRenderTask(task: MarkdownRenderTask): Promise<void> {
		try {
			if (task.generation === this.renderGeneration) {
				await task.run();
			}
		} catch {
			// 单张卡片渲染失败会在任务内部降级，队列本身只负责继续调度。
		} finally {
			this.activeMarkdownRenderCount = Math.max(0, this.activeMarkdownRenderCount - 1);
			this.pumpMarkdownRenderQueue();
		}
	}

	private clearMarkdownRenderQueue(): void {
		this.highPriorityMarkdownQueue = [];
		this.normalPriorityMarkdownQueue = [];
	}

	private async renderMemoMarkdown(memo: MemoRecord, container: HTMLElement, generation: number): Promise<void> {
		if (generation !== this.renderGeneration) {
			return;
		}
		const displayContent = memo.references.length > 0 ? stripTrailingWikiLink(memo.contentSnapshot) : memo.contentSnapshot;
		const renderTarget = this.containerEl.doc.createElement("div");
		try {
			await MarkdownRenderer.render(this.app, displayContent, renderTarget, memo.dailyRef.path, this);
			if (generation !== this.renderGeneration) {
				return;
			}
			container.empty();
			while (renderTarget.firstChild !== null) {
				container.appendChild(renderTarget.firstChild);
			}
			for (const imageEl of container.findAll("img")) {
				imageEl.setAttr("loading", "lazy");
			}
			this.prepareInternalLinks(container, memo.dailyRef.path);
			for (const tagEl of container.findAll(".tag")) {
				const tag = tagEl.getText().replace(/^#/, "");
				const tagKey = normalizeTagKey(tag);
				if (tagKey.length > 0) {
					tagEl.setAttr("data-tag", tag);
					tagEl.setAttr("data-tag-key", tagKey);
				}
			}
		} catch {
			if (generation !== this.renderGeneration) {
				return;
			}
			container.setText(memo.contentSnapshot);
		}
	}

	private async renderSourceReferenceMarkdown(container: HTMLElement, text: string, sourcePath: string, generation: number): Promise<void> {
		if (generation !== this.renderGeneration) {
			return;
		}
		const renderTarget = this.containerEl.doc.createElement("div");
		try {
			await MarkdownRenderer.render(this.app, text, renderTarget, sourcePath, this);
			if (generation !== this.renderGeneration) {
				return;
			}
			container.empty();
			while (renderTarget.firstChild !== null) {
				container.appendChild(renderTarget.firstChild);
			}
			for (const imageEl of container.findAll("img")) {
				imageEl.setAttr("loading", "lazy");
			}
			this.prepareInternalLinks(container, sourcePath);
		} catch {
			if (generation !== this.renderGeneration) {
				return;
			}
			container.setText(text);
		}
	}

	private prepareInternalLinks(container: HTMLElement, sourcePath: string): void {
		const links = Array.from(container.querySelectorAll<HTMLAnchorElement>("a.internal-link"));
		for (const linkEl of links) {
			linkEl.setAttr("data-knomo-source-path", sourcePath);
		}
	}

	private handleMarkdownInternalLinkHover(event: MouseEvent): void {
		const linkEl = this.getMarkdownInternalLink(event.target);
		if (linkEl === null) {
			return;
		}
		const linktext = linkEl.getAttribute("data-href") ?? linkEl.getAttribute("href");
		const sourcePath = linkEl.getAttr("data-knomo-source-path");
		if (!linktext || sourcePath === null) {
			return;
		}
		this.app.workspace.trigger("hover-link", {
			event,
			source: "preview",
			hoverParent: this,
			targetEl: linkEl,
			linktext,
			sourcePath,
		});
	}

	private async handleMarkdownInternalLinkClick(event: MouseEvent): Promise<void> {
		const linkEl = this.getMarkdownInternalLink(event.target);
		if (linkEl === null) {
			return;
		}
		const linktext = linkEl.getAttribute("data-href") ?? linkEl.getAttribute("href");
		const sourcePath = linkEl.getAttr("data-knomo-source-path");
		if (!linktext || sourcePath === null) {
			return;
		}
		event.preventDefault();
		await this.app.workspace.openLinkText(linktext, sourcePath, Keymap.isModEvent(event));
	}

	private getMarkdownInternalLink(target: EventTarget | null): HTMLAnchorElement | null {
		const targetNode = target as Node | null;
		if (targetNode === null || !targetNode.instanceOf(Element)) {
			return null;
		}
		const linkEl = targetNode.closest("a.internal-link");
		return linkEl?.instanceOf(HTMLAnchorElement) ? linkEl : null;
	}

	private openNativeImagePicker(): void {
		const input = this.containerEl.createEl("input", {
			cls: "knomo-hidden-file-input",
			attr: {
				type: "file",
				accept: "image/*",
				multiple: "true",
			},
		});
		const win = this.containerEl.win;
		let handledChange = false;
		let cleanedUp = false;
		const cleanup = () => {
			if (cleanedUp) {
				return;
			}
			cleanedUp = true;
			input.detach();
		};
		this.registerDomEvent(input, "change", () => {
			handledChange = true;
			void this.insertImageFiles(input.files).finally(cleanup);
		});
		this.registerDomEvent(win, "focus", () => {
			win.setTimeout(() => {
				if (!handledChange) {
					cleanup();
				}
			}, 1000);
		}, { once: true });
		input.click();
	}

	private async insertImageFiles(files: FileList | null): Promise<void> {
		if (files === null || files.length === 0) {
			return;
		}
		try {
			const sourcePath = this.getAttachmentSourcePath();
			if (sourcePath === null) {
				return;
			}
			const links: string[] = [];
			for (const file of Array.from(files)) {
				const path = await this.app.fileManager.getAvailablePathForAttachment(file.name, sourcePath);
				const attachment = await this.app.vault.createBinary(path, await file.arrayBuffer());
				const link = this.app.fileManager.generateMarkdownLink(attachment, sourcePath);
				links.push(`!${link}`);
			}
			this.insertText(links.join("\n"));
		} catch (error) {
			const message = formatSettingsText(error instanceof Error ? error.message : t("error.imageInsertFailed"));
			this.updateStatus(message, true);
			new Notice(message);
		}
	}

	private getAttachmentSourcePath(): string | null {
		const todayDailyNotePath = this.syncOrchestrator.getTodayDailyNotePath();
		if (todayDailyNotePath !== null) {
			return todayDailyNotePath;
		}
		const activeFile = this.app.workspace.getActiveFile();
		if (activeFile !== null && activeFile.extension === "md") {
			return activeFile.path;
		}
		const message = t("composer.enableDailyOrOpenMarkdown");
		this.updateStatus(message, true);
		new Notice(message);
		return null;
	}

	private async copyText(text: string): Promise<void> {
		const clipboard = this.containerEl.win.navigator.clipboard;
		if (clipboard !== undefined) {
			await clipboard.writeText(text);
			return;
		}
		const helper = this.containerEl.createEl("textarea", { cls: "knomo-clipboard-helper" });
		helper.value = text;
		helper.select();
		this.containerEl.doc.execCommand("copy");
		helper.detach();
	}
}

interface TagSuggestion {
	tag: string;
	result: SearchResult | null;
}

class KnomoTagSuggest extends AbstractInputSuggest<TagSuggestion> {
	private tagsSnapshot: string[] | null = null;

	constructor(
		app: App,
		private readonly inputEl: HTMLTextAreaElement,
		private readonly onInputChanged: () => void,
	) {
		super(app, inputEl as unknown as HTMLInputElement);
		this.limit = 0;
	}

	open(): void {
		super.open();
		this.hidePopoverUntilPositioned();
		this.queuePopoverReposition();
	}

	close(): void {
		this.showPositionedPopover();
		super.close();
		this.tagsSnapshot = null;
	}

	openForCurrentTrigger(): void {
		this.open();
		this.queuePopoverReposition();
		const container = this.getSuggestionContainer();
		if (container !== null) {
			container.addClass("knomo-tag-suggest-popover");
			container.style.position = "fixed";
			container.style.zIndex = "10020";
		}
	}

	protected getSuggestions(): TagSuggestion[] {
		const range = getTagQueryAtCursor(this.inputEl.value, this.inputEl.selectionStart);
		if (range === null) {
			return [];
		}
		const tags = this.getTagsSnapshot();
		const suggestions = range.query.length === 0
			? tags.map((tag) => ({ tag, result: null }))
			: this.getFuzzySuggestions(tags, range.query);
		if (suggestions.length > 0) {
			this.queuePopoverReposition();
		}
		return suggestions;
	}

	renderSuggestion(value: TagSuggestion, el: HTMLElement): void {
		if (value.result === null) {
			el.setText(value.tag);
			return;
		}
		el.empty();
		renderResults(el, value.tag, value.result);
	}

	selectSuggestion(value: TagSuggestion, _evt: MouseEvent | KeyboardEvent): void {
		const range = getTagQueryAtCursor(this.inputEl.value, this.inputEl.selectionStart);
		if (range === null) {
			this.close();
			return;
		}
		const next = replaceTagQueryWithSuggestion(this.inputEl.value, range, value.tag);
		this.inputEl.value = next.value;
		this.inputEl.setSelectionRange(next.cursor, next.cursor);
		this.onInputChanged();
		this.close();
	}

	private hidePopoverUntilPositioned(): void {
		const container = this.getSuggestionContainer();
		if (container === null) {
			return;
		}
		container.addClass("knomo-tag-suggest-popover");
		container.addClass("knomo-tag-suggest-positioning");
	}

	private showPositionedPopover(container = this.getSuggestionContainer()): void {
		container?.removeClass("knomo-tag-suggest-positioning");
	}

	private getTagsSnapshot(): string[] {
		if (this.tagsSnapshot === null) {
			this.tagsSnapshot = this.getVaultTags();
		}
		return this.tagsSnapshot;
	}

	private getFuzzySuggestions(tags: string[], query: string): TagSuggestion[] {
		const search = prepareFuzzySearch(query);
		const suggestions: TagSuggestion[] = [];
		for (const tag of tags) {
			const result = search(tag);
			if (result !== null) {
				suggestions.push({ tag, result });
			}
		}
		return suggestions;
	}

	private getVaultTags(): string[] {
		const tags = new Set<string>();
		for (const file of this.app.vault.getMarkdownFiles()) {
			const cache = this.app.metadataCache.getFileCache(file);
			if (cache === null) {
				continue;
			}
			for (const tag of getAllTags(cache) ?? []) {
				const normalizedTag = tag.replace(/^#/, "");
				if (normalizedTag.length > 0) {
					tags.add(normalizedTag);
				}
			}
		}
		return Array.from(tags).sort((first, second) => first.localeCompare(second));
	}

	private queuePopoverReposition(): void {
		const win = this.inputEl.ownerDocument.defaultView;
		if (win === null) {
			this.repositionPopover();
			return;
		}
		win.requestAnimationFrame(() => this.repositionPopover());
	}

	private repositionPopover(): void {
		const range = getTagQueryAtCursor(this.inputEl.value, this.inputEl.selectionStart);
		if (range === null) {
			return;
		}
		const anchor = this.getTextareaCharacterRect(range.to);
		const container = this.getSuggestionContainer();
		if (anchor === null || container === null) {
			return;
		}
		const layer = this.inputEl.closest(".knomo-mobile-composer-layer");
		if (layer !== null) {
			const win = this.inputEl.ownerDocument.defaultView;
			const viewport = win?.visualViewport ?? null;
			const viewportTop = viewport ? Math.max(0, viewport.offsetTop) : 0;
			const topGuard = 52;
			const gap = 8;
			const minHeight = 120;
			const maxHeightLimit = 240;
			const availableAbove = Math.max(minHeight, anchor.top - viewportTop - topGuard - gap);
			const maxHeight = Math.min(maxHeightLimit, availableAbove);
			container.addClass("knomo-tag-suggest-popover");
			container.style.position = "fixed";
			container.style.zIndex = "10020";
			container.style.maxHeight = `${Math.round(maxHeight)}px`;
			container.style.overflowY = "auto";
			const measuredHeight = Math.min(maxHeight, Math.max(minHeight, container.offsetHeight || maxHeight));
			const top = Math.max(viewportTop + topGuard, anchor.top - measuredHeight - gap);
			const inputRect = this.inputEl.getBoundingClientRect();
			const viewportLeft = viewport ? Math.max(0, viewport.offsetLeft) : 0;
			const viewportRight = viewport
				? viewport.offsetLeft + viewport.width
				: win?.innerWidth ?? this.inputEl.ownerDocument.documentElement.clientWidth;
			const viewportMargin = 12;
			const availableWidth = Math.max(0, viewportRight - viewportLeft - viewportMargin * 2);
			const contentWidth = this.measureSuggestionContentWidth(container);
			const targetWidth = contentWidth > 0 ? contentWidth + 44 : inputRect.width - 24;
			const width = Math.max(0, Math.min(targetWidth, availableWidth));
			const minLeft = viewportLeft + viewportMargin;
			const maxLeft = Math.max(minLeft, viewportRight - viewportMargin - width);
			const left = clamp(anchor.left, minLeft, maxLeft);
			container.style.left = `${Math.round(left)}px`;
			container.style.top = `${Math.round(top)}px`;
			container.style.width = `${Math.round(width)}px`;
			container.style.right = "";
			container.style.bottom = "";
			this.showPositionedPopover(container);
			return;
		}
		container.addClass("knomo-tag-suggest-popover");
		const win = this.inputEl.ownerDocument.defaultView;
		const viewport = win?.visualViewport ?? null;
		const viewportLeft = viewport ? Math.max(0, viewport.offsetLeft) : 0;
		const viewportRight = viewport
			? viewport.offsetLeft + viewport.width
			: win?.innerWidth ?? this.inputEl.ownerDocument.documentElement.clientWidth;
		const viewportMargin = 12;
		const availableWidth = Math.max(0, viewportRight - viewportLeft - viewportMargin * 2);
		const inputRect = this.inputEl.getBoundingClientRect();
		const contentWidth = this.measureSuggestionContentWidth(container, true, 12);
		const targetWidth = contentWidth > 0 ? contentWidth : inputRect.width;
		const width = Math.max(0, Math.min(targetWidth, 320, availableWidth));
		const minLeft = viewportLeft + viewportMargin;
		const maxLeft = Math.max(minLeft, viewportRight - viewportMargin - width);
		const left = clamp(anchor.left, minLeft, maxLeft);
		container.style.position = "fixed";
		container.style.left = `${Math.round(left)}px`;
		container.style.top = `${Math.round(anchor.bottom)}px`;
		container.style.width = `${Math.round(width)}px`;
		container.style.right = "";
		container.style.bottom = "";
		this.showPositionedPopover(container);
	}

	private measureSuggestionContentWidth(container: HTMLElement, includeScrollbarWidth = false, extraWidth = 2): number {
		const doc = this.inputEl.ownerDocument;
		const items = Array.from(container.querySelectorAll<HTMLElement>(".suggestion-item"));
		if (items.length === 0) {
			return Math.ceil(container.scrollWidth || container.getBoundingClientRect().width);
		}
		const host = container.cloneNode(false);
		if (!host.instanceOf(HTMLElement)) {
			return Math.ceil(container.scrollWidth || container.getBoundingClientRect().width);
		}
		host.style.position = "fixed";
		host.style.visibility = "hidden";
		host.style.pointerEvents = "none";
		host.style.width = "max-content";
		host.style.maxWidth = "none";
		host.style.minWidth = "0";
		host.style.left = "-10000px";
		host.style.top = "0";
		doc.body.appendChild(host);
		let width = 0;
		for (const item of items) {
			const clone = item.cloneNode(true);
			if (!clone.instanceOf(HTMLElement)) {
				continue;
			}
			clone.style.width = "max-content";
			clone.style.maxWidth = "none";
			clone.style.minWidth = "0";
			host.appendChild(clone);
			width = Math.max(width, clone.getBoundingClientRect().width);
		}
		host.detach();
		const win = doc.defaultView;
		if (win === null) {
			return Math.ceil(width);
		}
		const computed = win.getComputedStyle(container);
		const horizontalInset =
			parseCssPixels(computed.paddingLeft) +
			parseCssPixels(computed.paddingRight) +
			parseCssPixels(computed.borderLeftWidth) +
			parseCssPixels(computed.borderRightWidth);
		const scrollbarWidth = includeScrollbarWidth ? measureScrollbarWidth(doc) : 0;
		return Math.ceil(width + horizontalInset + scrollbarWidth + extraWidth);
	}

	private getTextareaCharacterRect(index: number): DOMRect | null {
		const doc = this.inputEl.ownerDocument;
		const win = doc.defaultView;
		if (win === null) {
			return null;
		}
		const inputRect = this.inputEl.getBoundingClientRect();
		const computed = win.getComputedStyle(this.inputEl);
		const mirror = doc.body.createDiv();
		const mirrorStyle = mirror.style;
		mirrorStyle.position = "fixed";
		mirrorStyle.visibility = "hidden";
		mirrorStyle.pointerEvents = "none";
		mirrorStyle.whiteSpace = "pre-wrap";
		mirrorStyle.overflowWrap = "break-word";
		mirrorStyle.wordBreak = computed.wordBreak;
		mirrorStyle.boxSizing = computed.boxSizing;
		mirrorStyle.width = `${inputRect.width}px`;
		mirrorStyle.minHeight = computed.minHeight;
		mirrorStyle.padding = computed.padding;
		mirrorStyle.border = computed.border;
		mirrorStyle.font = computed.font;
		mirrorStyle.lineHeight = computed.lineHeight;
		mirrorStyle.letterSpacing = computed.letterSpacing;
		mirrorStyle.textTransform = computed.textTransform;
		mirrorStyle.left = `${inputRect.left - this.inputEl.scrollLeft}px`;
		mirrorStyle.top = `${inputRect.top - this.inputEl.scrollTop}px`;
		mirror.setText(this.inputEl.value.slice(0, index));
		const marker = mirror.createSpan({ text: this.inputEl.value.charAt(index) || "\u200b" });
		const rect = marker.getBoundingClientRect();
		mirror.detach();
		return rect;
	}

	private getSuggestionContainer(): HTMLElement | null {
		const internal = this as unknown as { suggestEl?: unknown; popover?: unknown };
		const directContainer = this.asHTMLElement(internal.suggestEl) ?? this.getContainerElement(internal.suggestEl) ?? this.getContainerElement(internal.popover);
		if (directContainer !== null) {
			return directContainer;
		}
		const containers = Array.from(this.inputEl.ownerDocument.querySelectorAll<HTMLElement>(".suggestion-container"));
		return containers.length > 0 ? containers[containers.length - 1] : null;
	}

	private getContainerElement(value: unknown): HTMLElement | null {
		if (value === null || typeof value !== "object") {
			return null;
		}
		const candidate = value as { containerEl?: unknown; el?: unknown };
		return this.asHTMLElement(candidate.containerEl) ?? this.asHTMLElement(candidate.el);
	}

	private asHTMLElement(value: unknown): HTMLElement | null {
		const win = this.inputEl.ownerDocument.defaultView;
		if (win === null) {
			return null;
		}
		return value instanceof win.HTMLElement ? value : null;
	}
}

function getMemoStats(memos: MemoRecord[]): { memoCount: number; tagCount: number; imageCount: number; wordCount: number } {
	return {
		memoCount: memos.length,
		tagCount: new Set(memos.flatMap((memo) => {
			return memo.tags.map(normalizeTagKey).filter((tagKey) => tagKey.length > 0);
		})).size,
		imageCount: memos.reduce((count, memo) => count + getMemoImages(memo).length, 0),
		wordCount: memos.reduce((count, memo) => count + memo.contentSnapshot.replace(/\s/g, "").length, 0),
	};
}

function collectTags(memos: MemoRecord[], displayTags: Map<string, string>): TagSummary[] {
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

function collectVaultTagDisplayMap(app: App): Map<string, string> {
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

function tagMatchesActiveTagKey(tag: string, activeTagKey: string): boolean {
	const tagKey = normalizeTagKey(tag);
	return tagKey === activeTagKey || tagKey.startsWith(`${activeTagKey}/`);
}

function getMemoImages(memo: MemoRecord): MemoRecord["images"] {
	return memo.images.filter(isSupportedMemoImage);
}

function getSourceReferenceText(memo: MemoRecord): string | null {
	const sourceMemoId = memo.sourceMemoId ?? memo.references[0]?.memoId ?? null;
	const referenceText = memo.references[0]?.referenceText ?? null;
	if (sourceMemoId === null || referenceText === null) {
		return null;
	}
	return withMemoIdAlias(referenceText, sourceMemoId);
}

function getEmptyStateTitle(activeNav: SidebarNav): string {
	if (activeNav === "review") {
		return t("empty.review");
	}
	if (activeNav === "random") {
		return t("empty.random");
	}
	return t("empty.generic");
}

function shouldOpenRandomReunionCard(target: Element): boolean {
	return target.closest("a, button, input, textarea, select, [data-tag], .knomo-card-actions, .knomo-card-menu") === null;
}

function isListEnterInputEvent(event: InputEvent): boolean {
	return event.inputType === "insertParagraph" || event.inputType === "insertLineBreak" || (event.inputType === "insertText" && event.data === "\n");
}

function getMarkdownRenderPriority(renderIndex: number): MarkdownRenderPriority {
	return renderIndex < INITIAL_VISIBLE_RENDER_COUNT ? "high" : "normal";
}

function buildMemoSearchText(memo: MemoRecord): string {
	return [
		memo.contentSnapshot,
		formatMemoDisplayTime(memo.createdAt),
		memo.createdAt,
		memo.tags.join(" "),
		memo.links.map((link) => link.target).join(" "),
		getMemoImages(memo).map((image) => image.path).join(" "),
	].join(" ").toLowerCase();
}

function parseLocalDateText(value: string): Date | null {
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

function applyMemoBlockTime(date: Date, block: string): Date {
	const timeMatch = block.match(/(?:^|\n)- (\d{2}):(\d{2})(?::(\d{2}))?\b/);
	if (timeMatch === null) {
		return date;
	}
	const nextDate = new Date(date);
	nextDate.setHours(Number(timeMatch[1]), Number(timeMatch[2]), timeMatch[3] === undefined ? 0 : Number(timeMatch[3]), 0);
	return nextDate;
}

function matchesScope(memo: MemoRecord, filter: ScopeFilter): boolean {
	const date = new Date(memo.createdAt);
	const today = startOfDay(new Date());
	if (filter === "all") return true;
	if (filter === "no-tag") return memo.tags.length === 0;
	if (filter === "with-link") return memo.links.length > 0;
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

function getScopeLabel(filter: ScopeFilter): string {
	return ALL_SCOPE_OPTIONS.find((option) => option.filter === filter)?.label ?? t("nav.allNotes");
}

function isTitleMode(value: string | null): value is TitleMode {
	return value !== null && TITLE_MODE_OPTIONS.some((option) => option.mode === value);
}

function isSearchDateFilter(value: string | null): value is SearchDateFilter {
	return value !== null && SEARCH_DATE_OPTIONS.some((option) => option.filter === value);
}

function getSearchDateLabel(filter: SearchDateFilter): string {
	return SEARCH_DATE_OPTIONS.find((option) => option.filter === filter)?.label ?? t("search.label");
}

function isSidebarNav(value: string | null): value is SidebarNav {
	return value !== null && getAllSidebarNavItems().some((item) => item.nav === value);
}

function getSidebarNavLabel(value: SidebarNav): string {
	return getAllSidebarNavItems().find((item) => item.nav === value)?.label ?? t("nav.allNotes");
}

function getAllSidebarNavItems(): SidebarNavItem[] {
	return [...SIDEBAR_NAV_ITEMS, TRASH_NAV_ITEM];
}

function isTrashAction(value: string | null): value is "restore" | "purge" {
	return value === "restore" || value === "purge";
}

function matchesSearchDateFilter(date: Date, filter: SearchDateFilter): boolean {
	const today = startOfDay(new Date());
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

function needsAllMemos(scope: ScopeFilter, query: string, searchDateFilter: SearchDateFilter | null): boolean {
	return query.trim().length > 0 || searchDateFilter !== null || scope === "anniversary";
}

function toMarkdownQuote(content: string): string {
	return content
		.split("\n")
		.map((line) => `> ${line}`)
		.join("\n");
}

function shouldUseMobileCompact(mode: MobileCompactMode): boolean {
	return mode === "auto" || mode === "on";
}

function startOfDay(date: Date): Date {
	return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date: Date, days: number): Date {
	const nextDate = new Date(date);
	nextDate.setDate(nextDate.getDate() + days);
	return nextDate;
}

function formatMemoDisplayTime(value: string): string {
	return value.replace("T", " ").replace(/\.\d{3}[+-]\d{2}:\d{2}$/, "");
}

function formatOptionalMemoTime(value: string | undefined): string {
	return value === undefined || value.trim().length === 0 ? t("trash.unknownTime") : formatMemoDisplayTime(value);
}

function formatDeleteSource(value: string): string {
	if (value === "knomo_ui") {
		return "Knomo";
	}
	if (value === "file_watch") {
		return t("deleteSource.fileWatch");
	}
	if (value === "manual_scan") {
		return t("deleteSource.manualScan");
	}
	if (value === "startup_scan") {
		return t("deleteSource.startupScan");
	}
	return value;
}

function formatTrashActionErrorMessage(action: "restore" | "purge", error: unknown): string {
	const actionLabel = action === "restore" ? t("error.restoreFailed") : t("error.purgeFailed");
	const fallbackMessage = action === "restore" ? t("error.restoreFailedRetry") : t("error.purgeFailedRetry");
	if (!(error instanceof Error) || error.message.length === 0) {
		return fallbackMessage;
	}
	if (error.message.startsWith(actionLabel)) {
		return error.message;
	}
	return t("error.actionFailedWithReason", { action: actionLabel, message: error.message });
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function parseCssPixels(value: string): number {
	const parsed = Number.parseFloat(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

function measureScrollbarWidth(doc: Document): number {
	const outer = doc.body.createDiv();
	const inner = outer.createDiv();
	outer.style.position = "fixed";
	outer.style.visibility = "hidden";
	outer.style.pointerEvents = "none";
	outer.style.overflow = "scroll";
	outer.style.width = "100px";
	outer.style.height = "100px";
	outer.style.left = "-10000px";
	outer.style.top = "0";
	inner.style.width = "100%";
	inner.style.height = "120px";
	const scrollbarWidth = outer.offsetWidth - outer.clientWidth;
	outer.detach();
	return Math.max(0, scrollbarWidth);
}

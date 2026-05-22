import { AbstractInputSuggest, getAllTags, ItemView, Keymap, MarkdownRenderer, Notice, Platform, setIcon } from "obsidian";
import type { App, HoverPopover, WorkspaceLeaf } from "obsidian";

import { KNOMO_VIEW_DISPLAY_TEXT, KNOMO_VIEW_TYPE } from "../constants";
import type { RandomReunionService } from "../services/RandomReunionService";
import type { ReferenceService } from "../services/ReferenceService";
import type { SettingsService } from "../services/SettingsService";
import type { SyncOrchestrator } from "../services/SyncOrchestrator";
import type { ScanDailyMemosResult } from "../services/MemoScanService";
import type { MemoRecord } from "../types/memo";
import type { MobileCompactMode } from "../types/settings";
import { getHashInsertionText, getTagQueryAtCursor, replaceTagQueryWithSuggestion } from "../utils/composerInput";
import { formatDatePart } from "../utils/date";
import { parseDailyNoteDateFromPath } from "../utils/dailyNotes";
import { isSupportedMemoImage } from "../utils/markdown";
import { buildQuoteCreatedMemoContent, stripTrailingWikiLink, withMemoIdAlias } from "../utils/references";
import { formatSettingsText } from "./KnomoSettingTab";
import { buildTagTree } from "../utils/tagTree";
import type { TagSummary, TagTreeNode } from "../utils/tagTree";

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

interface SidebarNavItem {
	nav: SidebarNav;
	label: string;
	icon: string;
}

interface SidebarDragState {
	pointerId: number;
	startX: number;
	startWidth: number;
}

interface FilteredMemosCache {
	memos: MemoRecord[];
	activeTag: string | null;
	activeNav: SidebarNav;
	scopeFilter: ScopeFilter;
	searchQuery: string;
	todayKey: string;
	result: MemoRecord[];
}

const SIDEBAR_MIN_WIDTH = 210;
const SIDEBAR_MAX_WIDTH = 300;
const RANDOM_REUNION_DEFAULT_COUNT = 5;
const CARD_BATCH_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 220;
const MOBILE_COMPOSER_TOP_GUARD = 52;

const SIDEBAR_NAV_ITEMS: SidebarNavItem[] = [
	{ nav: "all", label: "全部笔记", icon: "layout-list" },
	{ nav: "review", label: "今日之外", icon: "calendar-check" },
	{ nav: "random", label: "随机重逢", icon: "shuffle" },
];

const TRASH_NAV_ITEM: SidebarNavItem = { nav: "trash", label: "回收站", icon: "trash-2" };

const MAIN_SCOPE_OPTIONS: ScopeOption[] = [
	{ filter: "all", label: "全部笔记", icon: "layout-list" },
	{ filter: "week", label: "本周", icon: "calendar-days" },
	{ filter: "month", label: "本月", icon: "calendar-range" },
	{ filter: "no-tag", label: "无标签", icon: "tag" },
	{ filter: "with-link", label: "有链接", icon: "link" },
	{ filter: "with-image", label: "有图片", icon: "image" },
];

const LIST_SCOPE_OPTIONS: ScopeOption[] = [
	{ filter: "week", label: "本周", icon: "calendar-days" },
	{ filter: "month", label: "本月", icon: "calendar-range" },
	{ filter: "with-image", label: "有图片", icon: "image" },
	{ filter: "no-tag", label: "无标签", icon: "tag" },
	{ filter: "with-link", label: "有链接", icon: "link" },
];

const DATE_SCOPE_OPTIONS: ScopeOption[] = [
	{ filter: "anniversary", label: "那年今日", icon: "history" },
	{ filter: "week", label: "本周", icon: "calendar-days" },
	{ filter: "month", label: "本月", icon: "calendar-range" },
	{ filter: "last-month", label: "上月", icon: "calendar-minus" },
	{ filter: "last-7", label: "最近7天", icon: "calendar-clock" },
	{ filter: "last-30", label: "最近30天", icon: "calendar-clock" },
];

type LayoutMode = "desktop-wide" | "desktop-medium" | "desktop-narrow" | "mobile";
type ComposerMode = "create" | "edit" | "quote";
type MobileComposerPhase = "closed" | "opening" | "focusing" | "open" | "closing";

const ALL_SCOPE_OPTIONS = uniqueScopeOptions([...MAIN_SCOPE_OPTIONS, ...DATE_SCOPE_OPTIONS]);

export class KnomoView extends ItemView {
	hoverPopover: HoverPopover | null = null;
	private rootEl: HTMLElement | null = null;
	private sidebarEl: HTMLElement | null = null;
	private scopeTitleEls: HTMLElement[] = [];
	private statsEls: HTMLElement[] = [];
	private pinnedTagsEl: HTMLElement | null = null;
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
	private sidebarResizerEl: HTMLElement | null = null;
	private mobileVisualViewport: VisualViewport | null = null;
	private mobileVisualViewportHandler: (() => void) | null = null;
	private memos: MemoRecord[] = [];
	private cardFlowError: string | null = null;
	private allMemosLoaded = false;
	private scopeFilter: ScopeFilter = "all";
	private searchQuery = "";
	private activeTag: string | null = null;
	private collapsedTagGroups = new Set<string>();
	private activeNav: SidebarNav = "all";
	private sidebarCollapsed = false;
	private sidebarWidth = 248;
	private mobileDrawerOpen = false;
	private desktopSearchOpen = false;
	private scopeMenuOpen = false;
	private composerOpen = false;
	private mobileComposerInputFocused = false;
	private compactSearchOpen = false;
	private editingMemo: MemoRecord | null = null;
	private quoteSourceMemoId: string | null = null;
	private quoteReferenceText: string | null = null;
	private quoteMarkdownText: string | null = null;
	private activeMenuMemoId: string | null = null;
	private draftContent = "";
	private isSaving = false;
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
	private visibleMemoCount = CARD_BATCH_SIZE;
	private searchDebounceTimeoutId: number | null = null;
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
	private mobileComposerLayerEl: HTMLElement | null = null;
	private mobileComposerBackdropEl: HTMLElement | null = null;
	private mobileComposerContentEl: HTMLElement | null = null;
	private mobileComposerHomeEl: HTMLElement | null = null;
	private mobileComposerNextSibling: ChildNode | null = null;
	private mobileComposerOpenScrollTop: number | null = null;
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
	}

	getViewType(): string {
		return KNOMO_VIEW_TYPE;
	}

	getDisplayText(): string {
		return KNOMO_VIEW_DISPLAY_TEXT;
	}

	getIcon(): string {
		return "sticky-note";
	}

	async onOpen(): Promise<void> {
		this.contentEl.addClass("knomo-view-host");
		await this.render();
		this.startLayoutObserver();
		this.startDateChangeWatcher();
	}

	async onClose(): Promise<void> {
		this.tagSuggest?.close();
		this.tagSuggest = null;
		this.clearSearchDebounce();
		this.clearMobileComposerFocus();
		this.clearMobileComposerResizeFrame();
		this.clearMobileComposerCloseTimer();
		this.clearMobileKeyboardMeasureTimers();
		this.stopMobileViewportTracking();
		this.removeMobileComposerLayer();
		this.stopDateChangeWatcher();
		this.stopLayoutObserver();
		this.contentEl.removeClass("knomo-view-host");
	}

	async refresh(): Promise<void> {
		if (this.activeNav === "trash") {
			await this.loadTrashMemos();
			return;
		}
		await this.reloadMemos(this.allMemosLoaded);
		void this.refreshTrashCount(false);
		if (this.activeNav === "random") {
			await this.refreshRandomReunionMemos();
		}
	}

	private async render(): Promise<void> {
		const container = this.contentEl;
		container.empty();
		this.scopeTitleEls = [];
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
			attr: { "aria-label": "卡片流" },
		});
		this.registerDomEvent(this.cardFlowEl, "scroll", () => this.handleCardFlowScroll());

		this.renderFab(root);

		this.registerDomEvent(root, "click", (event) => {
			void this.handleRootClick(event);
		});
		this.registerDomEvent(root, "keydown", (event) => {
			void this.handleRootKeydown(event);
		});

		this.syncRootState();
		await this.reloadMemos(false);
		void this.refreshTrashCount(false);
	}

	private renderSidebar(sidebar: HTMLElement): void {
		const header = sidebar.createDiv({ cls: "knomo-sidebar-header" });
		const brand = header.createDiv({ cls: "knomo-brand" });
		brand.createDiv({ cls: "knomo-brand-title", text: "Knomo" });
		brand.createDiv({ cls: "knomo-brand-subtitle", text: "记下 Memos，便是光阴" });
		const actions = header.createDiv({ cls: "knomo-sidebar-actions" });
		this.createIconButton(actions, "bar-chart-3", "统计", "knomo-sidebar-action", "focus-stats");
		this.createIconButton(actions, "refresh-cw", "刷新", "knomo-sidebar-action", "refresh");
		this.createIconButton(actions, "panel-left-close", "隐藏侧栏", "knomo-sidebar-action knomo-desktop-only", "collapse-sidebar");

		const stats = sidebar.createDiv({ cls: "knomo-sidebar-stats", attr: { "aria-label": "统计", tabindex: "-1" } });
		this.statsEls.push(stats);

		const nav = sidebar.createEl("nav", {
			cls: "knomo-nav",
			attr: { "aria-label": "范围" },
		});
		for (const item of SIDEBAR_NAV_ITEMS) {
			this.renderSidebarNavButton(nav, item);
		}

		const pinnedSection = sidebar.createDiv({ cls: "knomo-tag-section" });
		pinnedSection.createDiv({ cls: "knomo-section-label", text: "置顶标签" });
		this.pinnedTagsEl = pinnedSection.createDiv({ cls: "knomo-tag-list" });

		const allTagSection = sidebar.createDiv({ cls: "knomo-tag-section" });
		allTagSection.createDiv({ cls: "knomo-section-label", text: "全部标签" });
		this.allTagsEl = allTagSection.createDiv({ cls: "knomo-tag-list" });

		const trashSection = sidebar.createDiv({ cls: "knomo-trash-section" });
		const trashButton = this.renderSidebarNavButton(trashSection, TRASH_NAV_ITEM);
		trashButton.addClass("knomo-trash-nav-button");
		this.trashCountEls.push(trashButton.createSpan({ cls: "knomo-trash-count" }));

		this.sidebarResizerEl = sidebar.createDiv({
			cls: "knomo-sidebar-resizer knomo-desktop-only",
			attr: {
				role: "separator",
				"aria-orientation": "vertical",
				"aria-label": "调整侧栏宽度",
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
		this.createIconButton(topbar, "panel-left-open", "显示侧栏", "knomo-sidebar-toggle", "toggle-sidebar");

		const scopeWrap = topbar.createDiv({ cls: "knomo-scope-wrap" });
		const scopeButton = scopeWrap.createEl("button", {
			cls: "knomo-scope-trigger",
			attr: {
				type: "button",
				"aria-haspopup": "menu",
				"aria-expanded": "false",
				"data-action": "toggle-scope-menu",
			},
		});
		const label = scopeButton.createSpan({ text: "全部笔记" });
		this.scopeTitleEls.push(label);
		setIcon(scopeButton.createSpan({ cls: "knomo-title-chevron" }), "chevron-down");
		const popover = scopeWrap.createDiv({ cls: "knomo-scope-popover knomo-desktop-scope-popover", attr: { role: "menu" } });
		for (const option of LIST_SCOPE_OPTIONS) {
			this.renderScopeButton(popover, option, "knomo-scope-option");
		}

		const searchWrap = topbar.createDiv({ cls: "knomo-search-wrap" });
		setIcon(searchWrap.createSpan({ cls: "knomo-search-icon" }), "search");
		this.desktopSearchInputEl = searchWrap.createEl("input", {
			cls: "knomo-search-input",
			attr: {
				type: "search",
				placeholder: "搜索",
				"aria-label": "搜索",
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
		for (const option of ALL_SCOPE_OPTIONS) {
			this.renderScopeButton(mobilePopover, option, "knomo-scope-option");
		}
	}

	private renderSearchPopover(container: HTMLElement): void {
		const searchMenu = container.createDiv({ cls: "knomo-search-menu", attr: { role: "menu" } });
		for (const option of DATE_SCOPE_OPTIONS) {
			this.renderScopeButton(searchMenu, option, "knomo-search-menu-option");
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
		this.inputEl = inputArea.createEl("textarea", {
			cls: "knomo-composer-input",
			attr: {
				placeholder: "现在的想法是…",
				"aria-label": "输入 Memos 内容",
			},
		});
		this.inputEl.disabled = !dailyStatus.enabled;
		this.inputEl.value = this.draftContent;
		this.registerDomEvent(this.inputEl, "beforeinput", (event: InputEvent) => {
			this.handleComposerBeforeInput(event);
		});
		this.registerDomEvent(this.inputEl, "input", () => {
			this.syncInputState();
		});
		this.registerDomEvent(this.inputEl, "focus", () => {
			this.handleComposerInputFocus();
		});
		this.registerDomEvent(this.inputEl, "blur", () => {
			this.handleComposerInputBlur();
		});
		this.tagSuggest = new KnomoTagSuggest(this.app, this.inputEl, () => this.syncInputState());
		this.registerDomEvent(this.inputEl, "keydown", (event) => {
			if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
				event.preventDefault();
				void this.saveInput();
			} else if (event.key === "Escape") {
				this.cancelEditingOrCloseComposer();
			}
		});

		this.referencePreviewEl = inputArea.createDiv({ cls: "knomo-reference-preview" });
		const composerBar = inputArea.createDiv({ cls: "knomo-composer-bar" });
		this.composerBarEl = composerBar;
		const tools = composerBar.createDiv({ cls: "knomo-tool-group" });
		this.registerDomEvent(tools, "pointerdown", (event) => this.handleComposerToolPointerDown(event));
		this.registerDomEvent(tools, "mousedown", (event) => this.handleComposerToolPointerDown(event));
		this.createIconButton(tools, "hash", "插入标签", "knomo-tool-button", "insert-tag");
		this.createIconButton(tools, "image", "插入图片", "knomo-tool-button", "insert-image");
		this.createIconButton(tools, "list", "插入列表", "knomo-tool-button", "insert-list");
		this.createIconButton(tools, "list-ordered", "插入编号列表", "knomo-tool-button", "insert-numbered-list");
		const actions = composerBar.createDiv({ cls: "knomo-composer-actions" });
		this.cancelEditButtonEl = actions.createEl("button", {
			cls: "knomo-cancel-edit-button",
			text: "取消编辑",
			attr: {
				type: "button",
				"aria-label": "取消编辑",
				"data-action": "cancel-edit",
				"data-tooltip-position": "top",
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
				"aria-label": "发送",
				"data-action": "save-input",
				"data-tooltip-position": "top",
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

	private renderScopeButton(container: HTMLElement, option: ScopeOption, cls: string): HTMLButtonElement {
		const button = container.createEl("button", {
			cls,
			attr: {
				type: "button",
				"aria-pressed": "false",
				"data-scope": option.filter,
			},
		});
		setIcon(button.createSpan({ cls: "knomo-button-icon" }), option.icon);
		button.createSpan({ cls: "knomo-button-label", text: option.label });
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
	): HTMLButtonElement {
		const button = container.createEl("button", {
			cls,
			attr: {
				type: "button",
				"aria-label": ariaLabel,
				"data-action": action,
				"data-tooltip-position": "top",
			},
		});
		setIcon(button, icon);
		return button;
	}

	private renderCompactHeader(main: HTMLElement): void {
		const header = main.createDiv({ cls: "knomo-compact-header" });
		this.createIconButton(header, "menu", "菜单", "knomo-compact-menu-btn", "open-drawer");

		const titleButton = header.createEl("button", {
			cls: "knomo-compact-title",
			attr: {
				type: "button",
				"aria-haspopup": "menu",
				"aria-expanded": "false",
				"data-action": "toggle-scope-menu",
			},
		});
		const titleSpan = titleButton.createSpan();
		this.scopeTitleEls.push(titleSpan);
		setIcon(titleButton.createSpan({ cls: "knomo-title-chevron" }), "chevron-down");

		const inlineSearchWrap = header.createDiv({ cls: "knomo-compact-search-wrap knomo-compact-inline-search" });
		setIcon(inlineSearchWrap.createSpan({ cls: "knomo-search-icon" }), "search");
		this.compactInlineSearchInputEl = this.createCompactSearchInput(inlineSearchWrap);
		this.renderSearchPopover(inlineSearchWrap);

		this.createIconButton(header, "search", "搜索", "knomo-compact-search-btn", "toggle-compact-search");
	}

	private renderCompactSearchPanel(main: HTMLElement): void {
		const panel = main.createDiv({ cls: "knomo-compact-search-panel" });
		const searchWrap = panel.createDiv({ cls: "knomo-compact-search-wrap" });
		setIcon(searchWrap.createSpan({ cls: "knomo-search-icon" }), "search");
		this.compactSearchInputEl = this.createCompactSearchInput(searchWrap);
		this.renderSearchPopover(searchWrap);
	}

	private createCompactSearchInput(searchWrap: HTMLElement): HTMLInputElement {
		const searchInput = searchWrap.createEl("input", {
			cls: "knomo-search-input",
			attr: {
				type: "search",
				placeholder: "搜索",
				"aria-label": "搜索",
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

	private renderFab(root: HTMLElement): void {
		const fab = root.createDiv({ cls: "knomo-fab" });
		const button = fab.createEl("button", {
			cls: "knomo-fab-button",
			attr: {
				type: "button",
				"aria-label": "新建",
				"data-action": "open-composer",
			},
		});
		setIcon(button, "plus");
	}

	private async reloadMemos(loadAll: boolean): Promise<void> {
		try {
			this.memos = loadAll
				? await this.syncOrchestrator.listMemos()
				: await this.syncOrchestrator.listRecentMemos();
			this.allMemosLoaded = loadAll;
			this.cardFlowError = null;
			this.filteredMemosCache = null;
			this.resetVisibleMemos();
			if (this.activeNav === "random" && !this.randomReunionLoading) {
				this.randomReunionMemos = null;
			}
		} catch (error) {
			this.memos = [];
			this.cardFlowError = formatSettingsText(error instanceof Error ? error.message : "卡片流刷新失败");
			this.updateStatus(this.cardFlowError, true);
		}
		this.renderUiState();
		if (this.activeNav === "random" && !this.randomReunionLoading && this.randomReunionMemos === null) {
			void this.refreshRandomReunionMemos();
		}
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
				previewText.createSpan({ cls: "knomo-reference-label", text: "引用：" });
				previewText.createSpan({
					cls: "knomo-reference-content",
					text: this.quoteMarkdownText.replace(/^> ?/gm, ""),
				});
				const clearButton = this.referencePreviewEl.createEl("button", {
					cls: "knomo-reference-clear",
					attr: {
						type: "button",
						"aria-label": "清除引用",
						"data-action": "clear-reference",
						"data-tooltip-position": "top",
					},
				});
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
		root.toggleClass("is-mobile-compact", shouldUseMobileCompact(this.settingsService.getSettings().mobileCompactMode));
		root.style.setProperty("--knomo-sidebar-width", `${this.sidebarWidth}px`);
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
			this.renderStat(statsEl, String(stats.memoCount), "内容");
			this.renderStat(statsEl, String(stats.tagCount), "标签");
			this.renderStat(statsEl, stats.imageCount > 0 ? String(stats.imageCount) : String(stats.wordCount), stats.imageCount > 0 ? "图片" : "字数");
		}
	}

	private renderStat(container: HTMLElement, value: string, label: string): void {
		const item = container.createDiv({ cls: "knomo-stat" });
		item.createDiv({ cls: "knomo-stat-value", text: value });
		item.createDiv({ cls: "knomo-stat-label", text: label });
	}

	private renderTags(): void {
		const settings = this.settingsService.getSettings();
		const allTags = collectTags(this.memos);
		const pinnedTags = allTags.filter((tag) => settings.pinnedTags.includes(tag.name));
		this.renderTagList(this.pinnedTagsEl, buildTagTree(pinnedTags), "暂无置顶标签");
		this.renderTagList(this.allTagsEl, buildTagTree(allTags), "暂无标签");
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
		const collapsed = this.collapsedTagGroups.has(tag.name);
		const node = container.createDiv({ cls: collapsed ? "knomo-tag-node is-collapsed" : "knomo-tag-node" });
		const row = node.createDiv({ cls: "knomo-tag-row" });
		const button = row.createEl("button", {
			cls: this.activeTag === tag.name ? "knomo-tag-nav is-active" : "knomo-tag-nav",
			attr: {
				type: "button",
				"data-tag": tag.name,
				"aria-pressed": this.activeTag === tag.name ? "true" : "false",
			},
		});
		button.createSpan({ cls: "knomo-tag-name", text: tag.label });
		if (tag.children.length > 0) {
			const toggle = row.createEl("button", {
				cls: "knomo-tag-toggle",
				attr: {
					type: "button",
					"aria-label": collapsed ? "展开标签组" : "收起标签组",
					"aria-expanded": collapsed ? "false" : "true",
					"data-tag-toggle": tag.name,
					"data-tooltip-position": "top",
				},
			});
			setIcon(toggle, "chevron-down");
		}
		row.createSpan({ cls: "knomo-tag-count", text: String(tag.count) });
		if (tag.children.length > 0) {
			const children = node.createDiv({ cls: "knomo-tag-children" });
			for (const child of tag.children) {
				this.renderTagTreeNode(children, child);
			}
		}
	}

	private renderScopeState(): void {
		const label = this.getCurrentTitle();
		for (const titleEl of this.scopeTitleEls) {
			titleEl.setText(label);
		}
		this.rootEl?.findAll("[data-nav]").forEach((element) => {
			const active = element.getAttr("data-nav") === this.activeNav;
			element.toggleClass("is-active", active);
			element.setAttr("aria-pressed", active ? "true" : "false");
		});
		this.rootEl?.findAll("[data-scope]").forEach((element) => {
			const active = this.activeTag === null && this.activeNav === "all" && element.getAttr("data-scope") === this.scopeFilter;
			element.toggleClass("is-active", active);
			element.setAttr("aria-pressed", active ? "true" : "false");
		});
	}

	private getCurrentTitle(): string {
		if (this.activeTag !== null) {
			return `#${this.activeTag}`;
		}
		if (this.activeNav !== "all") {
			return getSidebarNavLabel(this.activeNav);
		}
		return getScopeLabel(this.scopeFilter);
	}

	private renderCardFlow(): void {
		if (this.cardFlowEl === null) {
			return;
		}

		const generation = this.renderGeneration + 1;
		this.renderGeneration = generation;
		this.cardFlowEl.empty();
		if (this.cardFlowError !== null) {
			this.renderEmptyState("卡片流刷新失败", this.cardFlowError);
			return;
		}
		if (this.activeNav === "trash") {
			this.renderTrashCardFlow();
			return;
		}
		if (this.activeNav === "random" && this.randomReunionLoading) {
			this.renderEmptyState("正在寻找可以随机重逢的 Memos");
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
		const visibleMemos = memos.slice(0, this.visibleMemoCount);
		for (const memo of visibleMemos) {
			this.renderMemoCard(memo, generation);
		}
		if (visibleMemos.length < memos.length) {
			this.renderLoadMoreSentinel(memos.length - visibleMemos.length);
		}
	}

	private renderTrashCardFlow(): void {
		if (this.trashLoading || this.trashMemos === null) {
			this.renderEmptyState("正在加载回收站");
			return;
		}
		if (this.trashError !== null) {
			this.renderEmptyState("回收站加载失败", this.trashError);
			return;
		}
		if (this.trashMemos.length === 0) {
			this.renderEmptyState("回收站为空", "删除的 Memos 会暂时保留在这里");
			return;
		}
		const visibleMemos = this.trashMemos.slice(0, this.visibleMemoCount);
		for (const memo of visibleMemos) {
			this.renderTrashMemoCard(memo, this.renderGeneration);
		}
		if (visibleMemos.length < this.trashMemos.length) {
			this.renderLoadMoreSentinel(this.trashMemos.length - visibleMemos.length);
		}
	}

	private renderOutsideTodaySummary(count: number): void {
		this.cardFlowEl?.createDiv({
			cls: "knomo-list-summary",
			text: `那些今天写下了 ${count} 条 Memos`,
		});
	}

	private renderRandomReunionToolbar(count: number): void {
		const toolbar = this.cardFlowEl?.createDiv({ cls: "knomo-list-toolbar" });
		if (toolbar === undefined) {
			return;
		}
		toolbar.createDiv({
			cls: "knomo-list-summary",
			text: `随机重逢了 ${count} 条 Memos`,
		});
		toolbar.createEl("button", {
			cls: "knomo-inline-button",
			text: "换一批",
			attr: {
				type: "button",
				"aria-label": "换一批",
				"data-action": "refresh-random-reunion",
			},
		});

	}

	private renderLoadMoreSentinel(remainingCount: number): void {
		this.cardFlowEl?.createEl("button", {
			cls: "knomo-load-more",
			text: `加载更多（剩余 ${remainingCount} 条）`,
			attr: {
				type: "button",
				"data-action": "load-more",
			},
		});
	}

	private renderMemoCard(memo: MemoRecord, generation: number): void {
		if (this.cardFlowEl === null) {
			return;
		}
		const cardAttrs: Record<string, string> = { "data-memo-id": memo.id };
		if (this.activeNav === "random") {
			cardAttrs.tabindex = "0";
			cardAttrs["aria-label"] = "打开来源位置";
			cardAttrs["data-random-reunion-card"] = "true";
		}
		const card = this.cardFlowEl.createEl("article", {
			cls: this.activeMenuMemoId === memo.id ? "knomo-card is-menu-open" : "knomo-card",
			attr: cardAttrs,
		});
		const head = card.createDiv({ cls: "knomo-card-head" });
		head.createDiv({ cls: "knomo-card-time", text: formatMemoDisplayTime(memo.createdAt) });
		const menu = head.createEl("button", {
			cls: "knomo-card-menu",
			attr: {
				type: "button",
				"aria-label": "更多操作",
				"aria-expanded": this.activeMenuMemoId === memo.id ? "true" : "false",
				"data-action": "toggle-card-menu",
				"data-memo-id": memo.id,
			},
		});
		menu.setAttr("data-tooltip-position", "top");
		setIcon(menu, "more-horizontal");

		const actions = head.createDiv({ cls: "knomo-card-actions", attr: { role: "menu" } });
		this.renderCardAction(actions, memo.id, "edit", "编辑");
		this.renderCardAction(actions, memo.id, "reference", "引用");
		this.renderCardAction(actions, memo.id, "copy-text", "复制文本");
		this.renderCardAction(actions, memo.id, "copy-link", "复制链接");
		this.renderCardAction(actions, memo.id, "delete", "删除");

		const content = card.createDiv({ cls: "knomo-card-content markdown-rendered" });
		void this.renderMemoMarkdown(memo, content, generation);
		this.renderCardMeta(card, memo);
	}

	private renderTrashMemoCard(memo: MemoRecord, generation: number): void {
		if (this.cardFlowEl === null) {
			return;
		}
		const busyAction = this.trashBusyMemoActions.get(memo.id) ?? null;
		const card = this.cardFlowEl.createEl("article", {
			cls: busyAction !== null ? "knomo-card knomo-trash-card is-busy" : "knomo-card knomo-trash-card",
			attr: { "data-memo-id": memo.id },
		});
		const head = card.createDiv({ cls: "knomo-card-head" });
		head.createDiv({ cls: "knomo-card-time", text: `原创建：${formatMemoDisplayTime(memo.createdAt)}` });
		const actions = head.createDiv({ cls: "knomo-trash-actions" });
		this.renderTrashAction(actions, memo.id, "restore", busyAction === "restore" ? "恢复中" : "恢复", busyAction !== null);
		this.renderTrashAction(actions, memo.id, "purge", busyAction === "purge" ? "删除中" : "永久删除", busyAction !== null);

		const content = card.createDiv({ cls: "knomo-card-content markdown-rendered" });
		void this.renderMemoMarkdown(memo, content, generation);

		const meta = card.createDiv({ cls: "knomo-card-meta knomo-trash-meta" });
		meta.createDiv({ text: `删除时间：${formatOptionalMemoTime(memo.deletedAt)}` });
		if (memo.deleteSource !== undefined && memo.deleteSource.trim().length > 0) {
			meta.createDiv({ text: `删除来源：${formatDeleteSource(memo.deleteSource)}` });
		}
		if (memo.issue !== null) {
			card.createDiv({ cls: "knomo-card-warning", text: memo.issue.message });
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
				"aria-label": label,
				"data-trash-action": action,
				"data-memo-id": memoId,
			},
		}).disabled = disabled;
	}

	private renderCardMeta(card: HTMLElement, memo: MemoRecord): void {
		if (memo.sourceMemoId !== null && !this.deletedMemoIds.has(memo.sourceMemoId)) {
			const sourceReferenceText = getSourceReferenceText(memo);
			const meta = card.createDiv({ cls: "knomo-card-meta knomo-source-reference markdown-rendered" });
			if (sourceReferenceText === null) {
				meta.setText(`引用自：${memo.sourceMemoId}`);
			} else {
				void this.renderSourceReferenceMarkdown(meta, `引用自：${sourceReferenceText}`, memo.dailyRef.path);
			}
		}
		if (memo.syncStatus !== "synced") {
			card.createDiv({ cls: "knomo-card-warning", text: memo.issue?.message ?? memo.syncStatus });
		}
		if (memo.issue !== null && memo.syncStatus === "synced") {
			card.createDiv({ cls: "knomo-card-warning", text: memo.issue.message });
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

	private renderEmptyState(title = "暂无内容", description = ""): void {
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
			if (this.collapsedTagGroups.has(tag)) {
				this.collapsedTagGroups.delete(tag);
			} else {
				this.collapsedTagGroups.add(tag);
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
			this.activeTag = this.activeTag === tag ? null : tag;
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

		const scopeEl = target.closest("[data-scope]");
		if (scopeEl?.instanceOf(HTMLElement)) {
			const scope = scopeEl.getAttr("data-scope");
			if (isScopeFilter(scope)) {
				this.setScope(scope);
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
			await this.handleAction(action, memoId);
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
			this.activeMenuMemoId = this.activeMenuMemoId === memoId ? null : memoId;
			this.syncCardMenuState();
			return;
		}
		if (action === "refresh-random-reunion") {
			await this.refreshRandomReunionMemos();
			return;
		}
		if (action === "load-more") {
			this.visibleMemoCount += CARD_BATCH_SIZE;
			this.renderCardFlow();
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
		}
		if (action === "insert-tag") {
			this.insertText("#");
			return;
		}
		if (action === "insert-image") {
			this.openNativeImagePicker();
			return;
		}
		if (action === "insert-list") {
			this.insertText("- ");
			return;
		}
		if (action === "insert-numbered-list") {
			this.insertText("1. ");
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
		try {
			if (action === "edit") {
				this.startEditing(memo);
				this.syncCardMenuState();
				return;
			} else if (action === "reference") {
				const referenceText = await this.referenceService.createReferenceText(memo, "link");
				this.startReferenceMemo(memo, withMemoIdAlias(referenceText, memo.id));
				this.syncCardMenuState();
				return;
			} else if (action === "copy-text") {
				await this.copyText(memo.contentSnapshot);
				new Notice("已复制文本");
			} else if (action === "copy-link") {
				const referenceText = await this.referenceService.createReferenceText(memo, "link");
				await this.copyText(referenceText);
				new Notice("已复制链接");
			} else if (action === "delete") {
				const confirmed = this.containerEl.win.confirm("确定删除这条内容？");
				if (!confirmed) {
					this.renderUiState();
					return;
				}
				await this.syncOrchestrator.deleteMemo(memo);
				new Notice("已删除");
				await this.onMemosChanged();
				return;
			}
			this.renderUiState();
		} catch (error) {
			const message = formatSettingsText(error instanceof Error ? error.message : "操作失败");
			this.updateStatus(message, true);
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
			this.updateStatus("内容不能为空。", true);
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
			const message = formatSettingsText(error instanceof Error ? error.message : "保存失败");
			this.updateStatus(message, true);
			new Notice(message);
		} finally {
			this.isSaving = false;
			this.updateSendButtonState();
			this.syncRootState();
		}
	}

	private async handleManualRefresh(): Promise<void> {
		this.updateStatus("正在刷新…", false);
		if (this.activeNav === "trash") {
			await this.loadTrashMemos();
		} else {
			await this.reloadMemos(this.allMemosLoaded);
			void this.refreshTrashCount(false);
		}
		this.updateStatus("正在同步最近日记中的 Memos…", false);
		try {
			const result = await this.onManualRefresh();
			const failed = result.failed;
			if (failed > 0) {
				const message = `刷新失败：${failed} 个文件未同步`;
				this.updateStatus(message, true);
				new Notice(message);
				return;
			}
			if (result.created > 0 || result.updated > 0 || result.deleted > 0) {
				this.updateStatus(`刷新完成：新增 ${result.created} 条，更新 ${result.updated} 条，删除 ${result.deleted} 条`, false);
				return;
			}
			this.updateStatus("已是最新", false);
		} catch (error) {
			const message = formatSettingsText(error instanceof Error ? error.message : "刷新失败。");
			this.updateStatus(message, true);
			new Notice(message);
		}
	}

	private setScope(scope: ScopeFilter): void {
		this.scopeFilter = scope;
		this.activeTag = null;
		this.activeNav = "all";
		this.resetVisibleMemos();
		if (isDateScope(scope)) {
			this.searchQuery = "";
		}
		this.mobileDrawerOpen = false;
		this.desktopSearchOpen = false;
		this.scopeMenuOpen = false;
		this.renderUiState();
		if (needsAllMemos(scope, this.searchQuery)) {
			void this.ensureAllMemosLoaded();
		}
	}

	private setSearchQuery(query: string): void {
		if (isDateScope(this.scopeFilter) && query !== getScopeLabel(this.scopeFilter)) {
			this.scopeFilter = "all";
		}
		this.searchQuery = query;
		this.activeNav = "all";
		this.resetVisibleMemos();
		this.renderCardFlow();
		this.renderScopeState();
		this.syncSearchInputs();
		if (needsAllMemos(this.scopeFilter, query)) {
			void this.ensureAllMemosLoaded();
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

	private setSidebarNav(nav: SidebarNav): void {
		this.activeNav = nav;
		this.activeTag = null;
		this.scopeFilter = "all";
		this.resetVisibleMemos();
		this.mobileDrawerOpen = false;
		this.scopeMenuOpen = false;
		this.activeMenuMemoId = null;
		if (nav === "review" || nav === "random" || nav === "trash") {
			this.searchQuery = "";
		}
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

	private openDesktopSearch(): void {
		this.desktopSearchOpen = true;
		this.scopeMenuOpen = false;
		this.syncRootState();
		if (isDateScope(this.scopeFilter) && this.searchQuery.length === 0) {
			this.desktopSearchInputEl?.select();
		}
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
			const confirmed = this.containerEl.win.confirm("收起输入层并保留当前内容？");
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
		if (event.defaultPrevented || event.inputType !== "insertText" || event.data !== "#") {
			return;
		}
		event.preventDefault();
		this.insertText("#");
	}

	private handleComposerToolPointerDown(event: PointerEvent | MouseEvent): void {
		if (this.currentLayout !== "mobile") {
			return;
		}
		const target = event.target as Node | null;
		if (target?.instanceOf(Element) && target.closest(".knomo-tool-button") !== null) {
			event.preventDefault();
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
		const label = this.isSaving ? "保存中" : "发送";
		this.sendButtonEl.setAttr("aria-label", label);
	}

	private updateCancelEditButtonState(): void {
		if (this.cancelEditButtonEl === null) {
			return;
		}
		this.cancelEditButtonEl.toggleAttribute("hidden", this.editingMemo === null);
	}

	private syncSearchInputs(): void {
		const displayedValue = this.searchQuery.length > 0
			? this.searchQuery
			: isDateScope(this.scopeFilter)
				? getScopeLabel(this.scopeFilter)
				: "";
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
		const today = new Date();
		const todayKey = formatDatePart(today);
		const cache = this.filteredMemosCache;
		if (
			cache !== null &&
			cache.memos === this.memos &&
			cache.activeTag === this.activeTag &&
			cache.activeNav === this.activeNav &&
			cache.scopeFilter === this.scopeFilter &&
			cache.searchQuery === normalizedQuery &&
			cache.todayKey === todayKey
		) {
			return cache.result;
		}

		const filteredMemos = this.activeNav === "review"
			? this.getOutsideTodayMemos(today)
			: this.memos.filter((memo) => {
				if (this.activeTag !== null && !memo.tags.some((tag) => tag === this.activeTag || tag.startsWith(`${this.activeTag}/`))) {
					return false;
				}
				if (normalizedQuery.length > 0 && !memoMatchesSearch(memo, normalizedQuery)) {
					return false;
				}
				return matchesScope(memo, this.scopeFilter);
			});
		this.filteredMemosCache = {
			memos: this.memos,
			activeTag: this.activeTag,
			activeNav: this.activeNav,
			scopeFilter: this.scopeFilter,
			searchQuery: normalizedQuery,
			todayKey,
			result: filteredMemos,
		};
		return filteredMemos;
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
		if (this.cardFlowEl === null) {
			return;
		}
		for (const card of this.cardFlowEl.findAll(".knomo-card")) {
			const isOpen = this.activeMenuMemoId !== null && card.getAttr("data-memo-id") === this.activeMenuMemoId;
			card.toggleClass("is-menu-open", isOpen);
			card.toggleClass("is-menu-above", false);
			card.find(".knomo-card-menu")?.setAttr("aria-expanded", isOpen ? "true" : "false");
			if (isOpen) {
				this.positionOpenCardMenu(card);
			}
		}
	}

	private positionOpenCardMenu(card: HTMLElement): void {
		if (this.cardFlowEl === null) {
			return;
		}
		const actions = card.find(".knomo-card-actions");
		if (!actions?.instanceOf(HTMLElement)) {
			return;
		}
		const flowRect = this.cardFlowEl.getBoundingClientRect();
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

	private async ensureAllMemosLoaded(): Promise<void> {
		if (this.allMemosLoaded) {
			return;
		}
		await this.reloadMemos(true);
	}

	private resetVisibleMemos(): void {
		this.visibleMemoCount = CARD_BATCH_SIZE;
	}

	private handleCardFlowScroll(): void {
		const cardFlow = this.cardFlowEl;
		if (cardFlow === null || cardFlow.scrollTop + cardFlow.clientHeight < cardFlow.scrollHeight - 160) {
			return;
		}
		const total = this.activeNav === "trash" ? (this.trashMemos?.length ?? 0) : this.getFilteredMemos().length;
		if (this.visibleMemoCount >= total) {
			return;
		}
		this.visibleMemoCount += CARD_BATCH_SIZE;
		this.renderCardFlow();
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
			this.trashError = formatSettingsText(error instanceof Error ? error.message : "回收站数量刷新失败");
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
			this.trashError = formatSettingsText(error instanceof Error ? error.message : "回收站加载失败");
			this.updateStatus(this.trashError, true);
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
			const confirmed = this.containerEl.win.confirm("永久删除后无法恢复，确定要删除这条 Memo 吗？");
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
				new Notice("已恢复");
				await this.onMemosChanged();
				return;
			}

			await this.syncOrchestrator.purgeDeletedMemo(memo.id);
			this.trashMemos = (this.trashMemos ?? []).filter((item) => item.id !== memo.id);
			this.trashCount = Math.max(0, this.trashCount - 1);
			new Notice("已永久删除");
			void this.refreshTrashCount(false);
			this.renderUiState();
		} catch (error) {
			const message = formatSettingsText(formatTrashActionErrorMessage(action, error));
			this.updateStatus(message, true);
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
			this.updateStatus(formatSettingsText(error instanceof Error ? error.message : "随机重逢加载失败"), true);
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
			this.updateStatus(formatSettingsText(error instanceof Error ? error.message : "随机重逢打开失败"), true);
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

	private async renderMemoMarkdown(memo: MemoRecord, container: HTMLElement, generation: number): Promise<void> {
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
			this.bindInternalLinkEvents(container, memo.dailyRef.path);
			for (const tagEl of container.findAll(".tag")) {
				const tag = tagEl.getText().replace(/^#/, "");
				if (tag.length > 0) {
					tagEl.setAttr("data-tag", tag);
				}
			}
		} catch {
			if (generation !== this.renderGeneration) {
				return;
			}
			container.setText(memo.contentSnapshot);
		}
	}

	private async renderSourceReferenceMarkdown(container: HTMLElement, text: string, sourcePath: string): Promise<void> {
		try {
			await MarkdownRenderer.render(this.app, text, container, sourcePath, this);
			this.bindInternalLinkEvents(container, sourcePath);
		} catch {
			container.setText(text);
		}
	}

	private bindInternalLinkEvents(container: HTMLElement, sourcePath: string): void {
		const links = Array.from(container.querySelectorAll<HTMLAnchorElement>("a.internal-link"));
		for (const linkEl of links) {
			this.registerDomEvent(linkEl, "mouseover", (event: MouseEvent) => {
				const linktext = linkEl.getAttribute("data-href") ?? linkEl.getAttribute("href");
				if (!linktext) return;
				this.app.workspace.trigger("hover-link", {
					event,
					source: "preview",
					hoverParent: this,
					targetEl: linkEl,
					linktext,
					sourcePath,
				});
			});
			this.registerDomEvent(linkEl, "click", (event: MouseEvent) => {
				event.preventDefault();
				const linktext = linkEl.getAttribute("data-href") ?? linkEl.getAttribute("href");
				if (!linktext) return;
				void this.app.workspace.openLinkText(linktext, sourcePath, Keymap.isModEvent(event));
			});
		}
	}

	private openNativeImagePicker(): void {
		if (this.currentLayout === "mobile") {
			this.focusComposerInputNow();
		}
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
			const message = formatSettingsText(error instanceof Error ? error.message : "图片插入失败");
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
		const message = "请先启用 Obsidian 日记核心插件，或打开一个 Markdown 文件后再插入图片";
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

class KnomoTagSuggest extends AbstractInputSuggest<string> {
	constructor(
		app: App,
		private readonly inputEl: HTMLTextAreaElement,
		private readonly onInputChanged: () => void,
	) {
		super(app, inputEl as unknown as HTMLInputElement);
	}

	open(): void {
		super.open();
		this.queuePopoverReposition();
	}

	protected getSuggestions(): string[] {
		const range = getTagQueryAtCursor(this.inputEl.value, this.inputEl.selectionStart);
		if (range === null) {
			return [];
		}
		const normalizedQuery = range.query.toLowerCase();
		const suggestions = this.getVaultTags().filter((tag) => normalizedQuery.length === 0 || tag.toLowerCase().startsWith(normalizedQuery));
		if (suggestions.length > 0) {
			this.queuePopoverReposition();
		}
		return suggestions;
	}

	renderSuggestion(value: string, el: HTMLElement): void {
		el.setText(value);
	}

	selectSuggestion(value: string, _evt: MouseEvent | KeyboardEvent): void {
		const range = getTagQueryAtCursor(this.inputEl.value, this.inputEl.selectionStart);
		if (range === null) {
			this.close();
			return;
		}
		const next = replaceTagQueryWithSuggestion(this.inputEl.value, range, value);
		this.inputEl.value = next.value;
		this.inputEl.setSelectionRange(next.cursor, next.cursor);
		this.onInputChanged();
		this.close();
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
		const anchor = this.getTextareaCharacterRect(range.from);
		const container = this.getSuggestionContainer();
		if (anchor === null || container === null) {
			return;
		}
		container.style.position = "fixed";
		container.style.left = `${Math.round(anchor.left)}px`;
		container.style.top = `${Math.round(anchor.bottom)}px`;
		container.style.right = "";
		container.style.bottom = "";
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
		tagCount: new Set(memos.flatMap((memo) => memo.tags)).size,
		imageCount: memos.reduce((count, memo) => count + getMemoImages(memo).length, 0),
		wordCount: memos.reduce((count, memo) => count + memo.contentSnapshot.replace(/\s/g, "").length, 0),
	};
}

function collectTags(memos: MemoRecord[]): TagSummary[] {
	const counts = new Map<string, number>();
	for (const memo of memos) {
		for (const tag of memo.tags) {
			counts.set(tag, (counts.get(tag) ?? 0) + 1);
		}
	}
	return [...counts.entries()]
		.map(([name, count]) => ({ name, count }))
		.sort((left, right) => {
			return right.count - left.count || left.name.localeCompare(right.name, "zh");
		});
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
		return "今日之外没有留下 Memos";
	}
	if (activeNav === "random") {
		return "还没有足够的 memo 可以随机重逢";
	}
	return "暂无内容";
}

function shouldOpenRandomReunionCard(target: Element): boolean {
	return target.closest("a, button, input, textarea, select, [data-tag], .knomo-card-actions, .knomo-card-menu") === null;
}

function memoMatchesSearch(memo: MemoRecord, normalizedQuery: string): boolean {
	const haystack = [
		memo.contentSnapshot,
		formatMemoDisplayTime(memo.createdAt),
		memo.createdAt,
		memo.tags.join(" "),
		memo.links.map((link) => link.target).join(" "),
		getMemoImages(memo).map((image) => image.path).join(" "),
	].join(" ").toLowerCase();
	return haystack.includes(normalizedQuery);
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

function uniqueScopeOptions(options: ScopeOption[]): ScopeOption[] {
	const seen = new Set<ScopeFilter>();
	const uniqueOptions: ScopeOption[] = [];
	for (const option of options) {
		if (seen.has(option.filter)) {
			continue;
		}
		seen.add(option.filter);
		uniqueOptions.push(option);
	}
	return uniqueOptions;
}

function getScopeLabel(filter: ScopeFilter): string {
	return ALL_SCOPE_OPTIONS.find((option) => option.filter === filter)?.label ?? "全部笔记";
}

function isScopeFilter(value: string | null): value is ScopeFilter {
	return value !== null && ALL_SCOPE_OPTIONS.some((option) => option.filter === value);
}

function isDateScope(value: ScopeFilter): boolean {
	return DATE_SCOPE_OPTIONS.some((option) => option.filter === value);
}

function isSidebarNav(value: string | null): value is SidebarNav {
	return value !== null && getAllSidebarNavItems().some((item) => item.nav === value);
}

function getSidebarNavLabel(value: SidebarNav): string {
	return getAllSidebarNavItems().find((item) => item.nav === value)?.label ?? "全部笔记";
}

function getAllSidebarNavItems(): SidebarNavItem[] {
	return [...SIDEBAR_NAV_ITEMS, TRASH_NAV_ITEM];
}

function isTrashAction(value: string | null): value is "restore" | "purge" {
	return value === "restore" || value === "purge";
}

function needsAllMemos(scope: ScopeFilter, query: string): boolean {
	return query.trim().length > 0 || scope === "anniversary";
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
	return value === undefined || value.trim().length === 0 ? "未知" : formatMemoDisplayTime(value);
}

function formatDeleteSource(value: string): string {
	if (value === "knomo_ui") {
		return "Knomo";
	}
	if (value === "file_watch") {
		return "文件同步";
	}
	if (value === "manual_scan") {
		return "手动扫描";
	}
	if (value === "startup_scan") {
		return "启动扫描";
	}
	return value;
}

function formatTrashActionErrorMessage(action: "restore" | "purge", error: unknown): string {
	const actionLabel = action === "restore" ? "恢复失败" : "永久删除失败";
	const fallbackMessage = action === "restore" ? "恢复失败，请稍后重试" : "永久删除失败，请稍后重试";
	if (!(error instanceof Error) || error.message.length === 0) {
		return fallbackMessage;
	}
	if (error.message.startsWith(actionLabel)) {
		return error.message;
	}
	return `${actionLabel}：${error.message}`;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

import { ItemView, Keymap, MarkdownRenderer, Notice, Platform, Scope, setIcon } from "obsidian";
import type { HoverPopover, WorkspaceLeaf } from "obsidian";

import { KNOMO_VIEW_DISPLAY_TEXT, KNOMO_VIEW_TYPE } from "../constants";
import { KNOMO_LOGO_ICON, KNOMO_SEARCH_ICON } from "../icons";
import { t } from "../i18n";
import type { AttachmentService } from "../services/AttachmentService";
import type { RandomReunionService } from "../services/RandomReunionService";
import type { ReferenceService } from "../services/ReferenceService";
import type { SettingsService } from "../services/SettingsService";
import type { SyncOrchestrator } from "../services/SyncOrchestrator";
import type { ScanDailyMemosResult } from "../services/MemoScanService";
import type { MemoRecord } from "../types/memo";
import type { MobileCompactMode } from "../types/settings";
import { applyListFormatToText, getHashInsertionText, getListEnterPatch, getListEnterPatchForNativeInput } from "../utils/composerInput";
import type { TextReplacement } from "../utils/composerInput";
import { formatDatePart } from "../utils/date";
import {
	getMarkdownTaskLines,
	isMarkdownTaskChecked,
	type MarkdownTaskMarker,
	toggleMarkdownTaskMarkerByIndex,
	type WritableMarkdownTaskMarker,
} from "../utils/markdownTasks";
import { buildQuoteCreatedMemoContent, stripTrailingWikiLink, withMemoIdAlias } from "../utils/references";
import { formatSettingsText } from "../utils/serviceText";
import {
	getComposerToolButtonRoute,
	getRandomReunionCardRoute,
	getRootClickRoute,
} from "./KnomoActionRouter";
import {
	getKnomoActionDispatch,
	getMemoActionDispatch,
	getTrashActionDispatch,
	shouldRenderAfterActionDispatch,
} from "./KnomoActionDispatch";
import type { MemoAction, TrashAction } from "./KnomoActionDispatch";
import { renderKnomoMemoCard, renderKnomoTrashMemoCard } from "./KnomoCard";
import { KnomoCardFlowBatcher, runCardFlowBatch } from "./KnomoCardFlow";
import type { CardFlowBatch, CardFlowRenderMode } from "./KnomoCardFlow";
import { renderComposerReferencePreview, renderKnomoComposer } from "./KnomoComposer";
import {
	renderKnomoCardFlowHeaders,
	renderKnomoEmptyState,
	renderKnomoListSummary,
	renderKnomoLoadMoreButton,
} from "./KnomoFeed";
import { getCardFlowPresentation } from "./KnomoCardFlowPresenter";
import type { CardFlowPresentation, CardFlowRegularFilterCopy } from "./KnomoCardFlowPresenter";
import { KnomoCardFlowSentinel } from "./KnomoCardFlowSentinel";
import {
	renderKnomoCompactHeader,
	renderKnomoCompactSearchPanel,
	renderKnomoDesktopTopbar,
	renderKnomoScopePopover,
} from "./KnomoHeaderSearch";
import { renderKnomoMobileSearchPage } from "./KnomoMobileSearchPage";
import {
	clampSidebarWidth,
	createSidebarDragState,
	getSidebarDragWidth,
	renderKnomoSidebar,
	renderSidebarStat,
	renderSidebarTags,
	SIDEBAR_MAX_WIDTH,
	SIDEBAR_MIN_WIDTH,
	syncSidebarNavButtons,
} from "./KnomoSidebar";
import type { SidebarDragState } from "./KnomoSidebar";
import { KnomoTagSuggest } from "./KnomoTagSuggest";
import { KnomoWikiLinkSuggest } from "./KnomoWikiLinkSuggest";
import { MarkdownRenderQueue } from "./MarkdownRenderQueue";
import type { MarkdownRenderPriority } from "./MarkdownRenderQueue";
import { MemoSearchCache } from "./MemoSearchCache";
import { MemoTaskUpdateCoordinator } from "./MemoTaskUpdateCoordinator";
import { MobileComposerController } from "./MobileComposerController";
import { MobileNavbarCompactController } from "./MobileNavbarCompactController";
import { normalizeTagKey } from "../utils/tags";
import {
	collectTags,
	collectVaultTagDisplayMap,
	formatMobileSearchEmptyTitle,
	formatMobileSearchSummary,
	formatRegularFilterEmptyTitle,
	formatRegularFilterSummary,
	formatTagFilterText,
	getMemoStats,
	getScopeLabel,
	getSearchDateLabel,
	isSummaryScopeFilter,
	matchesScope,
	matchesSearchDateFilter,
	needsAllMemos,
	parseMemoLocalDate,
	tagMatchesActiveTagKey,
} from "./viewFilters";
import type { RegularFilterCondition, ScopeFilter, SearchDateFilter } from "./viewFilters";
import {
	getSidebarNavLabel,
	isSearchDateFilter,
	isSidebarNav,
	isTitleMode,
	TITLE_MODE_OPTIONS,
} from "./viewNavigation";
import type { SidebarNav, TitleMode } from "./viewNavigation";

interface TitleHost {
	el: HTMLElement;
	mobile: boolean;
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

const RANDOM_REUNION_DEFAULT_COUNT = 5;
const CARD_BATCH_SIZE = 50;
const MOBILE_SEARCH_BATCH_SIZE = 30;
const INITIAL_VISIBLE_RENDER_COUNT = 16;
const MARKDOWN_RENDER_CONCURRENCY = 8;
const SEARCH_DEBOUNCE_MS = 220;
const MOBILE_VIEW_HEADER_SELECTORS = [
	".workspace-leaf.mod-active .view-header",
	".mod-active .view-header",
	".view-header",
];

type LayoutMode = "desktop-wide" | "desktop-medium" | "desktop-narrow" | "mobile";
type ComposerMode = "create" | "edit" | "quote";
type WindowWithIntersectionObserver = Window & {
	IntersectionObserver?: typeof IntersectionObserver;
};

interface PendingMobileListEnterCorrection {
	patch: TextReplacement;
	nativeValue: string;
}

interface HandledMobileToolPointer {
	button: HTMLElement;
	action: string;
}

interface RenderUiStateOptions {
	renderCardFlow?: boolean;
	renderMobileSearchResults?: boolean;
}

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
	private wikiLinkSuggest: KnomoWikiLinkSuggest | null = null;
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
	private trashBusyMemoActions = new Map<string, TrashAction>();
	private cardFlowBatcher = new KnomoCardFlowBatcher();
	private cardFlowSentinel = new KnomoCardFlowSentinel();
	private memoSearchCache = new MemoSearchCache();
	private searchDebounceTimeoutId: number | null = null;
	private mobileSearchDebounceTimeoutId: number | null = null;
	private lastMobileSendPointerAt = 0;
	private pendingMobileListEnterCorrection: PendingMobileListEnterCorrection | null = null;
	private listEnterKeydownPatch: TextReplacement | null = null;
	private listEnterKeydownPatchTimerId: number | null = null;
	private skipListEnterInputFallback = false;
	private skipListEnterInputFallbackTimerId: number | null = null;
	private handledMobileToolPointer: HandledMobileToolPointer | null = null;
	private handledMobileToolPointerTimerId: number | null = null;
	private mobileImagePickerActive = false;
	private mobileImagePickerFocusTimerId: number | null = null;
	private readonly mobileComposerController: MobileComposerController;
	private readonly memoTaskUpdateCoordinator: MemoTaskUpdateCoordinator;
	private mobileNavbarCompactController: MobileNavbarCompactController | null = null;
	private renderGeneration = 0;
	private markdownRenderQueue = new MarkdownRenderQueue({
		concurrency: MARKDOWN_RENDER_CONCURRENCY,
		getGeneration: () => this.renderGeneration,
	});

	constructor(
		leaf: WorkspaceLeaf,
		private readonly settingsService: SettingsService,
		private readonly syncOrchestrator: SyncOrchestrator,
		private readonly referenceService: ReferenceService,
		private readonly randomReunionService: RandomReunionService,
		private readonly attachmentService: AttachmentService,
		private readonly onMemosChanged: () => Promise<void>,
		private readonly onManualRefresh: () => Promise<ScanDailyMemosResult>,
	) {
		super(leaf);
		this.memoTaskUpdateCoordinator = new MemoTaskUpdateCoordinator({
			updateMemo: (memo, content) => this.syncOrchestrator.updateMemo(memo, content),
			onSaved: (memo) => this.handleTaskMemoSaved(memo),
			onIssue: (memo) => this.handleTaskMemoIssue(memo),
			onFailed: (memo, error) => this.handleTaskMemoFailed(memo, error),
		});
		this.mobileComposerController = new MobileComposerController({
			getWindow: () => this.containerEl.win,
			getDocument: () => this.containerEl.doc,
			getContainerEl: () => this.containerEl,
			getRootEl: () => this.rootEl,
			getComposerEl: () => this.composerEl,
			getInputEl: () => this.inputEl,
			getComposerBarEl: () => this.composerBarEl,
			getReferencePreviewEl: () => this.referencePreviewEl,
			getLayout: () => this.currentLayout,
			isComposerOpen: () => this.composerOpen,
			setComposerOpen: (open) => {
				this.composerOpen = open;
			},
			getCardFlowScrollTop: () => this.getCardFlowScrollTop(),
			registerBackdropClick: (element, handler) => {
				this.registerDomEvent(element, "click", handler);
			},
			closeComposerKeepingDraft: () => this.closeComposerKeepingDraft(),
			focusInputNow: (shouldResize, shouldQueueViewport) => {
				this.focusComposerInputNow(shouldResize, shouldQueueViewport);
			},
			resizeInput: () => this.resizeInput(),
			syncRootState: () => this.syncRootState(),
			syncComposerMode: () => this.syncComposerMode(),
			updateSendButtonState: () => this.updateSendButtonState(),
			updateCancelEditButtonState: () => this.updateCancelEditButtonState(),
		});
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
		this.wikiLinkSuggest?.destroy();
		this.wikiLinkSuggest = null;
		this.clearSearchDebounce();
		this.clearMobileSearchDebounce();
		this.mobileComposerController.dispose();
		this.clearListEnterKeydownPatch();
		this.clearSkipListEnterInputFallback();
		this.clearHandledMobileToolPointer();
		this.clearMobileImagePickerFocusGuard();
		this.pendingMobileListEnterCorrection = null;
		this.removeMobileSearchPage();
		this.containerEl.doc.body.removeClass("knomo-mobile-search-active");
		this.removeMobileHeaderTitle();
		this.removeMobileHeaderActions();
		this.stopDateChangeWatcher();
		this.stopLayoutObserver();
		this.cardFlowSentinel.remove();
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
		this.wikiLinkSuggest?.destroy();
		this.wikiLinkSuggest = null;

		const settings = this.settingsService.getSettings();
		this.sidebarWidth = clampSidebarWidth(settings.desktopSidebarWidth);
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
		this.registerDomEvent(this.cardFlowEl, "click", (event) => {
			this.handleTaskCheckboxClick(event);
		});
		this.registerDomEvent(this.cardFlowEl, "change", (event) => {
			this.handleTaskCheckboxChange(event);
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
		const elements = renderKnomoSidebar(sidebar, {
			sidebarMinWidth: SIDEBAR_MIN_WIDTH,
			sidebarMaxWidth: SIDEBAR_MAX_WIDTH,
			createHiddenText: (container, id, text) => this.createHiddenText(container, id, text),
			createIconButton: (container, icon, ariaLabel, cls, action, showTooltip) => {
				return this.createIconButton(container, icon, ariaLabel, cls, action, showTooltip);
			},
		});
		this.statsEls.push(elements.statsEl);
		this.allTagsEl = elements.allTagsEl;
		this.trashCountEls.push(elements.trashCountEl);
		this.sidebarResizerEl = elements.resizerEl;
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
		const elements = renderKnomoDesktopTopbar(main, {
			createHiddenText: (container, name, text) => this.createHiddenText(container, name, text),
			createIconButton: (container, icon, ariaLabel, cls, action, showTooltip) => {
				return this.createIconButton(container, icon, ariaLabel, cls, action, showTooltip);
			},
		});
		this.titleHosts.push({ el: elements.titleHostEl, mobile: false });
		this.desktopSearchInputEl = elements.searchInputEl;
		this.registerDesktopSearchInput(elements.searchInputEl);
	}

	private renderScopePopover(main: HTMLElement): void {
		renderKnomoScopePopover(main, "knomo-scope-popover knomo-mobile-scope-popover");
	}

	private renderComposer(main: HTMLElement): void {
		const dailyStatus = this.syncOrchestrator.getDailyNotesStatus();
		const composer = renderKnomoComposer(main, {
			dailyEnabled: dailyStatus.enabled,
			draftContent: this.draftContent,
			createHiddenText: (container, name, text) => this.createHiddenText(container, name, text),
			createIconButton: (container, icon, ariaLabel, cls, action, showTooltip) => {
				return this.createIconButton(container, icon, ariaLabel, cls, action, showTooltip);
			},
		});
		this.composerEl = composer.composerEl;
		this.inputEl = composer.inputEl;
		this.referencePreviewEl = composer.referencePreviewEl;
		this.composerBarEl = composer.composerBarEl;
		this.cancelEditButtonEl = composer.cancelEditButtonEl;
		this.statusEl = composer.statusEl;
		this.sendButtonEl = composer.sendButtonEl;
		this.registerDomEvent(composer.composerEl, "click", (event) => {
			if (this.isMobileComposerLayered()) {
				void this.handleRootClick(event);
			}
		});
		this.registerDomEvent(composer.composerEl, "keydown", (event) => {
			if (this.isMobileComposerLayered()) {
				void this.handleRootKeydown(event);
			}
		});
		this.registerDomEvent(composer.composerEl, "pointerdown", (event) => this.handleMobileComposerActionPointerDown(event));
		this.registerDomEvent(composer.composerEl, "mousedown", (event) => this.handleMobileComposerActionPointerDown(event));
		this.tagSuggest = new KnomoTagSuggest(this.app, this.inputEl, () => this.syncInputState());
		this.wikiLinkSuggest = new KnomoWikiLinkSuggest(this.app, this.inputEl, {
			getSourcePath: () => this.getWikiLinkSourcePath(),
			onInputChanged: () => this.syncInputState(),
			closeTagSuggest: () => this.tagSuggest?.close(),
			registerVaultEvent: (eventRef) => this.registerEvent(eventRef),
		});
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
		this.registerDomEvent(this.inputEl, "compositionstart", () => {
			this.wikiLinkSuggest?.handleCompositionStart();
		});
		this.registerDomEvent(this.inputEl, "compositionend", () => {
			this.wikiLinkSuggest?.handleCompositionEnd();
		});
		this.registerDomEvent(this.inputEl, "click", () => {
			this.wikiLinkSuggest?.refreshForCursor();
		});
		this.registerDomEvent(this.inputEl, "keydown", (event) => {
			if (this.handleComposerSaveShortcut(event)) {
				return;
			}
			if (this.wikiLinkSuggest?.handleKeydown(event)) {
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
			this.wikiLinkSuggest?.refreshForCursor();
		});
		this.registerDomEvent(composer.toolsEl, "pointerdown", (event) => this.handleComposerToolPointerDown(event));
		this.registerDomEvent(composer.toolsEl, "mousedown", (event) => this.handleComposerToolPointerDown(event));
		this.registerDomEvent(this.sendButtonEl, "pointerdown", (event) => {
			this.handleSendPointerDown(event);
		});
		this.registerDomEvent(this.sendButtonEl, "mousedown", (event) => {
			this.handleSendPointerDown(event);
		});
		this.updateSendButtonState();
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
			for (const container of [root, this.mobileComposerController.getLayerEl()]) {
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
		const elements = renderKnomoCompactHeader(main, {
			createHiddenText: (container, name, text) => this.createHiddenText(container, name, text),
			createIconButton: (container, icon, ariaLabel, cls, action, showTooltip) => {
				return this.createIconButton(container, icon, ariaLabel, cls, action, showTooltip);
			},
		});
		this.titleHosts.push({ el: elements.titleHostEl, mobile: false });
		this.compactInlineSearchInputEl = elements.inlineSearchInputEl;
		this.registerCompactSearchInput(elements.inlineSearchInputEl);
	}

	private renderCompactSearchPanel(main: HTMLElement): void {
		const elements = renderKnomoCompactSearchPanel(main, {
			createHiddenText: (container, name, text) => this.createHiddenText(container, name, text),
			createIconButton: (container, icon, ariaLabel, cls, action, showTooltip) => {
				return this.createIconButton(container, icon, ariaLabel, cls, action, showTooltip);
			},
		});
		this.compactSearchInputEl = elements.searchInputEl;
		this.registerCompactSearchInput(elements.searchInputEl);
	}

	private registerDesktopSearchInput(searchInput: HTMLInputElement): void {
		this.registerDomEvent(searchInput, "focus", () => this.openDesktopSearch());
		this.registerDomEvent(searchInput, "click", () => this.openDesktopSearch());
		this.registerDomEvent(searchInput, "input", () => {
			this.queueSearchQuery(searchInput.value);
		});
		this.registerDomEvent(searchInput, "keydown", (event) => {
			if (event.key === "Escape") {
				this.desktopSearchOpen = false;
				this.syncRootState();
				searchInput.blur();
			}
		});
	}

	private registerCompactSearchInput(searchInput: HTMLInputElement): void {
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

	private renderUiState(options: RenderUiStateOptions = {}): void {
		this.syncRootState();
		this.syncComposerDailyStatus();
		this.syncComposerMode();
		this.renderStats();
		this.renderTags();
		this.renderTrashCount();
		this.renderScopeState();
		if (options.renderCardFlow !== false) {
			this.renderCardFlow();
		}
		if (options.renderMobileSearchResults !== false) {
			this.renderMobileSearchResults();
		}
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
			renderComposerReferencePreview(
				this.referencePreviewEl,
				this.quoteSourceMemoId !== null ? this.quoteMarkdownText : null,
				{
					setTooltipIfDesktopOnly: (element) => this.setTooltipIfDesktopOnly(element),
				},
			);
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
		this.mobileComposerController.syncViewportTracking();
		this.mobileComposerController.syncLayer();
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
		const page = renderKnomoMobileSearchPage(this.rootEl, {
			createHiddenText: (container, name, text) => this.createHiddenText(container, name, text),
		});
		this.mobileSearchPageEl = page.pageEl;
		this.mobileSearchInputEl = page.inputEl;
		this.mobileSearchResultsEl = page.resultsEl;
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
		this.registerDomEvent(this.mobileSearchResultsEl, "click", (event) => {
			void this.handleMarkdownInternalLinkClick(event);
		});
		this.registerDomEvent(this.mobileSearchResultsEl, "click", (event) => {
			this.handleTaskCheckboxClick(event);
		});
		this.registerDomEvent(this.mobileSearchResultsEl, "change", (event) => {
			this.handleTaskCheckboxChange(event);
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
		const query = this.mobileSearchQuery.trim();
		const normalizedQuery = query.toLowerCase();
		if (normalizedQuery.length === 0 && this.mobileSearchDateFilter === null) {
			resultsEl.createDiv({ cls: "knomo-mobile-search-empty", text: t("search.emptyPrompt") });
			return;
		}
		const memos = this.memos.filter((memo) => this.memoMatchesSearch(memo, normalizedQuery, this.mobileSearchDateFilter));
		if (memos.length === 0) {
			resultsEl.createDiv({ cls: "knomo-mobile-search-empty", text: formatMobileSearchEmptyTitle(query, this.mobileSearchDateFilter) });
			return;
		}
		const summary = formatMobileSearchSummary(query, this.mobileSearchDateFilter, memos.length);
		if (summary !== null) {
			renderKnomoListSummary(resultsEl, summary);
		}
		const visibleMemos = memos.slice(0, this.mobileSearchVisibleCount);
		for (const [index, memo] of visibleMemos.entries()) {
			this.renderMemoCardInContainer(resultsEl, memo, generation, index, true, false);
		}
		if (visibleMemos.length < memos.length) {
			renderKnomoLoadMoreButton(resultsEl, {
				remainingCount: memos.length - visibleMemos.length,
				action: "load-more-mobile-search",
				extraClass: "knomo-mobile-search-more",
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

	private isMobileComposerLayered(): boolean {
		return this.mobileComposerController.isLayered();
	}

	private scheduleMobileComposerResize(): void {
		this.mobileComposerController.scheduleResize();
	}

	private updateMobileComposerMeasurements(): number {
		return this.mobileComposerController.updateMeasurements();
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
			renderSidebarStat(statsEl, String(stats.memoCount), t("stats.notes"));
			renderSidebarStat(statsEl, String(stats.tagCount), t("stats.tags"));
			renderSidebarStat(statsEl, stats.imageCount > 0 ? String(stats.imageCount) : String(stats.wordCount), stats.imageCount > 0 ? t("stats.images") : t("stats.words"));
		}
	}

	private renderTags(): void {
		const allTags = collectTags(this.memos, collectVaultTagDisplayMap(this.app));
		if (this.activeTagKey !== null) {
			const activeTag = allTags.find((tag) => tag.key === this.activeTagKey);
			if (activeTag !== undefined) {
				this.activeTag = activeTag.name;
			}
		}
		renderSidebarTags(this.allTagsEl, allTags, {
			activeTagKey: this.activeTagKey,
			expandedTagGroups: this.expandedTagGroups,
			emptyText: t("tags.empty"),
		});
	}

	private renderTrashCount(): void {
		for (const countEl of this.trashCountEls) {
			countEl.setText(this.trashCount > 0 ? String(this.trashCount) : "");
			countEl.toggleAttribute("hidden", this.trashCount === 0);
		}
	}

	private renderScopeState(): void {
		for (const titleHost of this.titleHosts) {
			this.renderTitleHost(titleHost);
		}
		this.syncMobileHeaderTitle();
		syncSidebarNavButtons(this.rootEl, this.activeNav);
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

	private getRegularFilterCopy(count: number): CardFlowRegularFilterCopy | null {
		if (this.activeNav !== "all") {
			return null;
		}
		const conditions = this.getRegularFilterConditions();
		if (conditions.length === 0) {
			return null;
		}
		const summary = formatRegularFilterSummary(conditions, count);
		return {
			summary,
			emptyTitle: formatRegularFilterEmptyTitle(conditions, summary),
		};
	}

	private getRegularFilterConditions(): RegularFilterCondition[] {
		const conditions: RegularFilterCondition[] = [];
		const tag = this.activeTag?.trim() || this.activeTagKey || "";
		if (this.activeTagKey !== null && tag.length > 0) {
			conditions.push({ type: "tag", text: formatTagFilterText(tag) });
		}
		const query = this.searchQuery.trim();
		if (query.length > 0) {
			conditions.push({
				type: "search",
				text: t("filterSummary.searchCondition", { query }),
				query,
			});
		}
		if (this.searchDateFilter !== null) {
			conditions.push({
				type: "date",
				text: getSearchDateLabel(this.searchDateFilter),
				filter: this.searchDateFilter,
			});
		}
		if (isSummaryScopeFilter(this.scopeFilter)) {
			conditions.push({
				type: "scope",
				text: getScopeLabel(this.scopeFilter),
				filter: this.scopeFilter,
			});
		}
		return conditions;
	}

	private renderCardFlow(): void {
		if (this.cardFlowEl === null) {
			return;
		}

		const generation = this.renderGeneration + 1;
		this.renderGeneration = generation;
		this.clearMarkdownRenderQueue();
		this.cardFlowSentinel.remove();
		this.cardFlowEl.empty();
		const shouldLoadListMemos = this.cardFlowError === null
			&& this.activeNav !== "trash"
			&& !(this.activeNav === "random" && this.randomReunionLoading);
		const memos = shouldLoadListMemos ? this.getFilteredMemos() : [];
		const presentation = getCardFlowPresentation({
			cardFlowError: this.cardFlowError,
			activeNav: this.activeNav,
			randomReunionLoading: this.randomReunionLoading,
			memos,
			regularFilterCopy: shouldLoadListMemos ? this.getRegularFilterCopy(memos.length) : null,
			trashLoading: this.trashLoading,
			trashError: this.trashError,
			trashMemos: this.trashMemos,
		});
		this.renderCardFlowPresentation(presentation, generation);
	}

	private renderCardFlowPresentation(presentation: CardFlowPresentation, generation: number): void {
		if (presentation.type === "empty") {
			if (this.cardFlowEl !== null) {
				renderKnomoEmptyState(this.cardFlowEl, presentation.title, presentation.description);
			}
			return;
		}
		if (this.cardFlowEl === null) {
			return;
		}
		renderKnomoCardFlowHeaders(this.cardFlowEl, presentation.headers);
		this.startCardFeed(presentation.memos, presentation.mode, generation);
	}

	private startCardFeed(memos: MemoRecord[], mode: CardFlowRenderMode, generation: number): void {
		const batch = this.cardFlowBatcher.start(memos, mode, CARD_BATCH_SIZE);
		this.renderCardBatch(batch, generation);
	}

	private renderNextCardBatch(generation: number, batchSize = CARD_BATCH_SIZE): void {
		if (this.cardFlowEl === null || generation !== this.renderGeneration) {
			return;
		}
		const batch = this.cardFlowBatcher.beginNextBatch(batchSize);
		this.renderCardBatch(batch, generation);
	}

	private renderCardBatch(batch: CardFlowBatch | null, generation: number): void {
		const result = runCardFlowBatch({
			batch,
			generation,
			hasRenderTarget: this.cardFlowEl !== null,
			isCurrentGeneration: (value) => value === this.renderGeneration,
			removeSentinel: () => this.cardFlowSentinel.remove(),
			renderItem: (item) => {
				if (item.mode === "trash") {
					this.renderTrashMemoCard(item.memo, generation, item.renderIndex);
				} else {
					this.renderMemoCard(item.memo, generation, item.renderIndex);
				}
			},
			completeBatch: (completedBatch) => this.cardFlowBatcher.completeBatch(completedBatch),
			cancelBatch: () => this.cardFlowBatcher.cancelBatch(),
		});
		const cardFlow = this.cardFlowEl;
		if (result.type !== "completed" || !result.completion.hasMoreItems || cardFlow === null) {
			return;
		}
		this.cardFlowSentinel.render({
			root: cardFlow,
			remainingCount: result.completion.remainingCount,
			generation,
			Observer: (this.containerEl.win as WindowWithIntersectionObserver).IntersectionObserver,
			isCurrentGeneration: (value) => value === this.renderGeneration,
			onIntersect: (value) => this.renderNextCardBatch(value),
		});
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
		renderKnomoMemoCard(container, memo, {
			generation,
			renderIndex,
			includeActions,
			randomCard,
			activeMenuMemoId: this.activeMenuMemoId,
			deletedMemoIds: this.deletedMemoIds,
			getA11yId: (id) => this.getA11yId(id),
			formatDisplayTime: formatMemoDisplayTime,
			formatSettingsText,
			getMarkdownPriority: getMarkdownRenderPriority,
			queueMemoMarkdown: (memoRecord, content, renderGeneration, priority) => {
				this.queueMemoMarkdown(memoRecord, content, renderGeneration, priority);
			},
			queueSourceReferenceMarkdown: (content, text, sourcePath, renderGeneration) => {
				this.queueSourceReferenceMarkdown(content, text, sourcePath, renderGeneration);
			},
		});
	}

	private renderTrashMemoCard(memo: MemoRecord, generation: number, renderIndex: number): void {
		if (this.cardFlowEl === null) {
			return;
		}
		renderKnomoTrashMemoCard(this.cardFlowEl, memo, {
			generation,
			renderIndex,
			busyAction: this.trashBusyMemoActions.get(memo.id) ?? null,
			formatDisplayTime: formatMemoDisplayTime,
			formatOptionalTime: formatOptionalMemoTime,
			formatDeleteSource,
			formatSettingsText,
			getMarkdownPriority: getMarkdownRenderPriority,
			queueMemoMarkdown: (memoRecord, content, renderGeneration, priority) => {
				this.queueMemoMarkdown(memoRecord, content, renderGeneration, priority);
			},
		});
	}

	private async handleRootClick(event: MouseEvent): Promise<void> {
		const target = event.target as Node | null;
		if (target === null || !target.instanceOf(Element)) {
			return;
		}

		const route = getRootClickRoute(target, this.currentLayout === "mobile");
		if (route.type === "tag-toggle") {
			event.preventDefault();
			const tag = route.tag;
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

		if (route.type === "tag") {
			event.preventDefault();
			const tag = route.tag;
			if (tag === null) {
				return;
			}
			const tagKey = route.tagKey ?? normalizeTagKey(tag);
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

		if (route.type === "nav") {
			if (isSidebarNav(route.nav)) {
				this.setSidebarNav(route.nav);
			}
			return;
		}

		if (route.type === "title-mode") {
			if (isTitleMode(route.mode)) {
				this.setTitleMode(route.mode);
			}
			return;
		}

		if (route.type === "search-date") {
			if (isSearchDateFilter(route.filter)) {
				if (this.currentLayout === "mobile" && this.mobileSearchPageOpen) {
					this.setMobileSearchDateFilter(route.filter);
				} else {
					this.setSearchDateFilter(route.filter, route.element);
				}
			}
			return;
		}

		if (route.type === "trash-action") {
			const memo = this.trashMemos?.find((item) => item.id === route.memoId) ?? null;
			const dispatch = getTrashActionDispatch(route.action);
			if (memo !== null && dispatch.type === "trash-action") {
				await this.handleTrashAction(dispatch.action, memo);
			}
			return;
		}

		if (route.type === "memo-action") {
			const memo = this.memos.find((item) => item.id === route.memoId);
			const dispatch = getMemoActionDispatch(route.action);
			if (memo !== undefined && dispatch.type === "memo-action") {
				await this.handleMemoAction(dispatch.action, memo);
			}
			return;
		}

		if (route.type === "action") {
			if (this.shouldIgnoreHandledMobileToolClick(route.element, route.action)) {
				return;
			}
			await this.handleAction(route.action, route.memoId);
			if (route.mobileToolButtonEl !== null) {
				route.mobileToolButtonEl.blur();
			}
			return;
		}

		if (route.type === "random-reunion-card") {
			if (route.memoId !== null) {
				await this.openRandomReunionMemo(route.memoId);
			}
			return;
		}

		if (route.closeCardMenu) {
			this.closeCardMenu();
		}
		if (route.closeScopeMenu) {
			this.scopeMenuOpen = false;
			this.syncRootState();
		}
		if (route.closeDesktopSearch) {
			this.desktopSearchOpen = false;
			this.syncRootState();
		}
		if (route.closeCompactSearch) {
			this.compactSearchOpen = false;
			this.syncRootState();
		}
	}

	private async handleAction(action: string | null, memoId: string | null): Promise<void> {
		const dispatch = getKnomoActionDispatch(action);
		switch (dispatch.type) {
			case "none":
				return;
			case "toggle-card-menu":
				if (this.currentLayout !== "mobile") {
					this.scopeMenuOpen = false;
					this.desktopSearchOpen = false;
					this.compactSearchOpen = false;
					this.syncRootState();
				}
				this.activeMenuMemoId = this.activeMenuMemoId === memoId ? null : memoId;
				this.syncCardMenuState();
				return;
			case "refresh-random-reunion":
				await this.refreshRandomReunionMemos();
				return;
			case "load-more":
				this.renderNextCardBatch(this.renderGeneration);
				return;
			case "load-more-mobile-search":
				this.loadMoreMobileSearchResults();
				return;
			case "reset-list-state":
				this.resetToAllNotes();
				return;
			case "close-mobile-search":
				this.closeMobileSearchPage();
				return;
			case "open-drawer":
				if (this.composerOpen) {
					this.closeComposerKeepingDraft();
				}
				this.mobileDrawerOpen = true;
				break;
			case "close-drawer":
				this.mobileDrawerOpen = false;
				break;
			case "toggle-scope-menu":
				this.scopeMenuOpen = !this.scopeMenuOpen;
				this.desktopSearchOpen = false;
				if (this.currentLayout !== "mobile") {
					this.compactSearchOpen = false;
					this.activeMenuMemoId = null;
				}
				break;
			case "toggle-sidebar":
				this.toggleSidebar();
				break;
			case "collapse-sidebar":
				if (this.isDrawerLayout()) {
					this.mobileDrawerOpen = false;
				} else {
					this.setSidebarCollapsed(true);
				}
				break;
			case "refresh":
				await this.handleManualRefresh();
				return;
			case "focus-stats":
				this.sidebarEl?.querySelector<HTMLElement>(".knomo-sidebar-stats")?.focus();
				break;
			case "open-composer":
				this.openComposer();
				return;
			case "close-composer":
				this.closeComposerWithConfirm();
				return;
			case "toggle-compact-search":
				this.compactSearchOpen = !this.compactSearchOpen;
				this.desktopSearchOpen = false;
				if (this.currentLayout !== "mobile") {
					this.activeMenuMemoId = null;
				}
				break;
			case "composer-tool":
				if (this.runComposerToolAction(dispatch.action)) {
					return;
				}
				break;
			case "clear-reference":
				this.clearReference();
				return;
			case "cancel-edit":
				this.cancelEditing();
				return;
			case "save-input":
				if (this.currentLayout === "mobile" && Date.now() - this.lastMobileSendPointerAt < 700) {
					return;
				}
				await this.saveInput();
				return;
			case "unknown":
				break;
		}
		if (shouldRenderAfterActionDispatch(dispatch)) {
			const shouldRenderCardFlow = dispatch.type === "unknown";
			this.renderUiState({
				renderCardFlow: shouldRenderCardFlow,
				renderMobileSearchResults: shouldRenderCardFlow,
			});
			if (!shouldRenderCardFlow) {
				this.syncCardMenuState();
			}
		}
	}

	private async handleRootKeydown(event: KeyboardEvent): Promise<void> {
		if ((event.ctrlKey || event.metaKey) && event.key === "\\") {
			event.preventDefault();
			this.toggleSidebar();
			return;
		}
		const target = event.target as Node | null;
		if ((event.key === "Enter" || event.key === " ") && target?.instanceOf(Element)) {
			const randomReunionCardEl = getRandomReunionCardRoute(target);
			if (randomReunionCardEl !== null) {
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
			this.mobileComposerController.resetInactiveState();
			this.renderUiState();
		}
	}

	private async handleMemoAction(action: MemoAction, memo: MemoRecord): Promise<void> {
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
				this.syncCardMenuState();
				return;
			} else if (action === "copy-link") {
				const referenceText = await this.referenceService.createReferenceText(memo, "link");
				await this.copyText(withMemoIdAlias(referenceText, memo.id));
				new Notice(t("notice.copiedLink"));
				this.syncCardMenuState();
				return;
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
		const mobileScrollTop = isMobileSave ? this.mobileComposerController.getOpenScrollTop() ?? this.getCardFlowScrollTop() : null;
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
				this.mobileComposerController.clearOpenScrollTop();
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
		if (
			this.activeNav === "all" &&
			this.activeTagKey === null &&
			this.scopeFilter === scope &&
			this.searchQuery.trim().length === 0 &&
			this.searchDateFilter === null
		) {
			this.mobileDrawerOpen = false;
			this.desktopSearchOpen = false;
			this.scopeMenuOpen = false;
			this.syncRootState();
			this.renderScopeState();
			this.syncSearchInputs();
			return;
		}
		this.clearDesktopSearchState();
		this.scopeFilter = scope;
		this.clearActiveTag();
		this.activeNav = "all";
		this.resetVisibleMemos();
		this.mobileDrawerOpen = false;
		this.desktopSearchOpen = false;
		this.scopeMenuOpen = false;
		this.renderFilteredListState(true);
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
		this.renderFilteredListState(false);
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
		this.renderFilteredListState(false);
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
		if (nav === "all" && this.isDefaultListState()) {
			this.mobileDrawerOpen = false;
			this.scopeMenuOpen = false;
			this.activeMenuMemoId = null;
			this.syncRootState();
			this.renderScopeState();
			this.syncCardMenuState();
			return;
		}
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
		const isAlreadyDefault = this.isDefaultListState();
		this.clearDesktopSearchState();
		this.clearActiveTag();
		this.activeNav = "all";
		this.scopeFilter = "all";
		this.mobileDrawerOpen = false;
		this.scopeMenuOpen = false;
		this.desktopSearchOpen = false;
		this.compactSearchOpen = false;
		this.activeMenuMemoId = null;
		if (isAlreadyDefault) {
			this.syncRootState();
			this.renderScopeState();
			this.syncSearchInputs();
			this.syncCardMenuState();
			return;
		}
		this.resetVisibleMemos();
		this.renderUiState();
	}

	private renderFilteredListState(fullUi: boolean): void {
		const shouldDeferCardFlow = this.shouldDeferCardFlowForAllMemos();
		if (shouldDeferCardFlow) {
			this.cardFlowSentinel.remove();
			this.syncCardMenuState();
		}
		if (fullUi) {
			this.renderUiState({
				renderCardFlow: !shouldDeferCardFlow,
				renderMobileSearchResults: !shouldDeferCardFlow,
			});
		} else if (shouldDeferCardFlow) {
			this.syncRootState();
			this.renderScopeState();
			this.syncSearchInputs();
		} else {
			this.renderCardFlow();
			this.renderScopeState();
			this.syncSearchInputs();
		}
		if (shouldDeferCardFlow) {
			void this.ensureAllMemosLoaded();
		}
	}

	private shouldDeferCardFlowForAllMemos(): boolean {
		return !this.allMemosLoaded && needsAllMemos(this.scopeFilter, this.searchQuery, this.searchDateFilter);
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
		this.mobileComposerController.prepareDesktopOpen();
		this.composerOpen = true;
		this.mobileDrawerOpen = false;
		this.scopeMenuOpen = false;
		this.syncRootState();
		this.focusComposerInputSoon();
	}

	private openMobileComposer(): void {
		this.mobileDrawerOpen = false;
		this.scopeMenuOpen = false;
		this.mobileComposerController.open();
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
		this.mobileComposerController.resetInactiveState();
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
		this.mobileComposerController.closeKeepingDraft();
	}

	private focusComposerInputSoon(): void {
		this.mobileComposerController.focusInputSoon();
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
			this.mobileComposerController.queueViewportUpdate();
		}
	}

	private handleComposerInputFocus(): void {
		if (!this.mobileComposerController.handleInputFocus()) {
			return;
		}
		this.resizeInput();
	}

	private handleComposerInputBlur(): void {
		this.composerSaveShortcutDown = false;
		this.wikiLinkSuggest?.close();
		if (this.currentLayout === "mobile" && this.mobileImagePickerActive) {
			return;
		}
		if (!this.mobileComposerController.handleInputBlur()) {
			return;
		}
		this.resizeInput();
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
		if (this.wikiLinkSuggest?.handleBeforeInput(event)) {
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
		const toolButtonRoute = getComposerToolButtonRoute(target);
		if (toolButtonRoute === null) {
			return;
		}
		const { action, element: toolButton } = toolButtonRoute;
		if (action === null) {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		if (action === "insert-image") {
			return;
		}
		if (this.isHandledMobileToolPointer(toolButton, action)) {
			return;
		}
		if (this.runComposerToolAction(action)) {
			this.markHandledMobileToolPointer(toolButton, action);
		}
	}

	private handleMobileComposerActionPointerDown(event: PointerEvent | MouseEvent): void {
		if (this.currentLayout !== "mobile") {
			return;
		}
		const target = event.target as Node | null;
		if (!target?.instanceOf(Element)) {
			return;
		}
		const actionEl = target.closest("[data-action]");
		if (!actionEl?.instanceOf(HTMLElement)) {
			return;
		}
		const action = actionEl.getAttr("data-action");
		if (action !== "clear-reference" && action !== "cancel-edit") {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		if (this.isHandledMobileToolPointer(actionEl, action)) {
			return;
		}
		if (action === "clear-reference") {
			this.clearReference();
		} else {
			this.cancelEditing();
		}
		this.markHandledMobileToolPointer(actionEl, action);
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

	private beginMobileImagePickerFocusGuard(): boolean {
		this.clearMobileImagePickerFocusGuard();
		if (this.currentLayout !== "mobile" || this.inputEl === null || !this.inputEl.isConnected) {
			return false;
		}
		if (this.containerEl.doc.activeElement !== this.inputEl) {
			return false;
		}
		this.mobileImagePickerActive = true;
		return true;
	}

	private finishMobileImagePickerFocusGuard(shouldRestoreFocus: boolean): void {
		this.mobileImagePickerActive = false;
		this.clearMobileImagePickerFocusTimer();
		if (!shouldRestoreFocus || this.currentLayout === "mobile") {
			return;
		}
		this.mobileImagePickerFocusTimerId = this.containerEl.win.setTimeout(() => {
			this.mobileImagePickerFocusTimerId = null;
			if (this.currentLayout !== "mobile" || !this.composerOpen) {
				return;
			}
			const input = this.inputEl;
			if (input === null || !input.isConnected || input.disabled) {
				return;
			}
			this.focusComposerInputNow(true, true);
		}, 50);
	}

	private clearMobileImagePickerFocusGuard(): void {
		this.mobileImagePickerActive = false;
		this.clearMobileImagePickerFocusTimer();
	}

	private clearMobileImagePickerFocusTimer(): void {
		if (this.mobileImagePickerFocusTimerId === null) {
			return;
		}
		this.containerEl.win.clearTimeout(this.mobileImagePickerFocusTimerId);
		this.mobileImagePickerFocusTimerId = null;
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

	private insertText(text: string, shouldFocus = true): void {
		if (this.inputEl === null) {
			return;
		}
		const start = this.inputEl.selectionStart;
		const end = this.inputEl.selectionEnd;
		const insertText = text === "#" ? getHashInsertionText(this.inputEl.value, start) : text;
		this.inputEl.value = `${this.inputEl.value.slice(0, start)}${insertText}${this.inputEl.value.slice(end)}`;
		const nextCursor = start + insertText.length;
		if (shouldFocus) {
			try {
				this.inputEl.focus({ preventScroll: true });
			} catch {
				this.inputEl.focus();
			}
		}
		this.inputEl.setSelectionRange(nextCursor, nextCursor);
		dispatchTextareaInputEvent(this.inputEl);
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
		dispatchTextareaInputEvent(input);
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
		if (this.wikiLinkSuggest?.handleInput()) {
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
		dispatchTextareaInputEvent(input);
	}

	private openTagSuggestAfterHashInsert(): void {
		if (this.inputEl === null || this.tagSuggest === null) {
			return;
		}
		this.wikiLinkSuggest?.close();
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
		this.inputEl.setCssProps({ "--knomo-composer-input-height": "auto" });
		const nextHeight = Math.min(maxHeight, Math.max(minHeight, this.inputEl.scrollHeight));
		this.inputEl.setCssProps({
			"--knomo-composer-input-height": `${nextHeight}px`,
			"--knomo-composer-input-overflow-y": this.inputEl.scrollHeight > maxHeight ? "auto" : "hidden",
		});
	}

	private getMobileMaxInputHeight(): number {
		return this.mobileComposerController.getMaxInputHeight();
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
		return parseMemoLocalDate(memo, this.syncOrchestrator.getDailyNotesStatus());
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
		this.sidebarDrag = createSidebarDragState(event, this.sidebarWidth);
		this.sidebarResizerEl.setPointerCapture(event.pointerId);
		this.rootEl?.toggleClass("is-resizing-sidebar", true);
		event.preventDefault();
	}

	private resizeSidebar(event: PointerEvent): void {
		if (this.sidebarDrag === null || this.sidebarDrag.pointerId !== event.pointerId) {
			return;
		}
		this.setSidebarWidth(getSidebarDragWidth(this.sidebarDrag, event.clientX), false);
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
		this.sidebarWidth = clampSidebarWidth(width);
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
		this.cardFlowBatcher.reset();
	}

	private invalidateMemoSearchCache(): void {
		this.memoSearchCache.invalidate(this.memos);
	}

	private getMemoSearchText(memo: MemoRecord): string {
		return this.memoSearchCache.get(memo, this.memos);
	}

	private handleCardFlowScroll(): void {
		const cardFlow = this.cardFlowEl;
		if (
			cardFlow === null ||
			this.cardFlowSentinel.isObserving ||
			!this.cardFlowBatcher.hasMoreItems ||
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

	private async handleTrashAction(action: TrashAction, memo: MemoRecord): Promise<void> {
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
		this.markdownRenderQueue.enqueue(priority, generation, () => this.renderMemoMarkdown(memo, container, generation));
	}

	private queueSourceReferenceMarkdown(container: HTMLElement, text: string, sourcePath: string, generation: number): void {
		this.markdownRenderQueue.enqueue("normal", generation, () => this.renderSourceReferenceMarkdown(container, text, sourcePath, generation));
	}

	private clearMarkdownRenderQueue(): void {
		this.markdownRenderQueue.clear();
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
			this.prepareRenderedTaskCheckboxes(container, memo);
		} catch {
			if (generation !== this.renderGeneration) {
				return;
			}
			container.setText(memo.contentSnapshot);
		}
	}

	private prepareRenderedTaskCheckboxes(container: HTMLElement, memo: MemoRecord): void {
		const tasks = getMarkdownTaskLines(memo.contentSnapshot);
		if (tasks.length === 0) {
			return;
		}
		let taskIndex = 0;
		for (const checkboxEl of container.findAll("input[type='checkbox']")) {
			if (taskIndex >= tasks.length) {
				return;
			}
			const input = checkboxEl as HTMLInputElement;
			input.addClass("knomo-task-checkbox");
			input.setAttr("data-knomo-memo-id", memo.id);
			input.setAttr("data-knomo-task-index", String(taskIndex));
			const taskItem = input.closest("li");
			if (taskItem?.instanceOf(HTMLElement)) {
				taskItem.setAttr("data-knomo-task-index", String(taskIndex));
			}
			taskIndex += 1;
		}
	}

	private handleTaskCheckboxClick(event: MouseEvent): void {
		if (this.getTaskCheckboxInput(event.target) !== null) {
			event.stopPropagation();
		}
	}

	private handleTaskCheckboxChange(event: Event): void {
		const input = this.getTaskCheckboxInput(event.target);
		if (input === null) {
			return;
		}
		event.stopPropagation();
		const memo = this.findMemoForTaskCheckbox(input);
		const taskIndex = this.getTaskCheckboxIndex(input);
		if (memo === null || taskIndex === null) {
			return;
		}
		const latestContent = this.memoTaskUpdateCoordinator.getLatestContent(memo);
		const result = toggleMarkdownTaskMarkerByIndex(latestContent, taskIndex);
		if (result === null) {
			this.syncTaskCheckboxDom(input, memo);
			return;
		}
		this.applyTaskCheckboxDomState(input, result.marker);
		this.memoTaskUpdateCoordinator.enqueue(memo, result.content);
	}

	private getTaskCheckboxInput(target: EventTarget | null): HTMLInputElement | null {
		const node = target as Node | null;
		if (!node?.instanceOf(HTMLElement)) {
			return null;
		}
		if (node.tagName !== "INPUT" || node.closest(".knomo-card-content") === null) {
			return null;
		}
		const input = node as HTMLInputElement;
		if (input.type !== "checkbox" || input.getAttr("data-knomo-task-index") === null) {
			return null;
		}
		return input;
	}

	private findMemoForTaskCheckbox(input: HTMLInputElement): MemoRecord | null {
		const memoId = input.getAttr("data-knomo-memo-id");
		if (memoId === null) {
			return null;
		}
		return this.memos.find((memo) => memo.id === memoId) ?? null;
	}

	private getTaskCheckboxIndex(input: HTMLInputElement): number | null {
		const value = input.getAttr("data-knomo-task-index");
		if (value === null) {
			return null;
		}
		const taskIndex = Number(value);
		return Number.isInteger(taskIndex) && taskIndex >= 0 ? taskIndex : null;
	}

	private async handleTaskMemoSaved(memo: MemoRecord): Promise<void> {
		this.replaceMemoInMemory(memo);
	}

	private async handleTaskMemoIssue(memo: MemoRecord): Promise<void> {
		this.replaceMemoInMemory(memo);
		new Notice(t("task.updateFailed"));
		this.renderUiState();
	}

	private async handleTaskMemoFailed(memo: MemoRecord, _error: unknown): Promise<void> {
		this.replaceMemoInMemory(memo);
		this.syncTaskCheckboxesForMemo(memo);
		new Notice(t("task.updateFailed"));
		await this.onMemosChanged();
	}

	private replaceMemoInMemory(updatedMemo: MemoRecord): void {
		let changed = false;
		this.memos = this.memos.map((memo) => {
			if (memo.id !== updatedMemo.id) {
				return memo;
			}
			changed = true;
			return updatedMemo;
		});
		if (!changed) {
			return;
		}
		if (this.randomReunionMemos !== null) {
			this.randomReunionMemos = this.randomReunionMemos.map((memo) => memo.id === updatedMemo.id ? updatedMemo : memo);
		}
		this.filteredMemosCache = null;
		this.invalidateMemoSearchCache();
		this.renderStats();
		this.renderTags();
	}

	private syncTaskCheckboxesForMemo(memo: MemoRecord): void {
		for (const container of [this.cardFlowEl, this.mobileSearchResultsEl]) {
			if (container === null) {
				continue;
			}
			for (const checkboxEl of container.findAll(".knomo-task-checkbox")) {
				const input = checkboxEl as HTMLInputElement;
				if (input.getAttr("data-knomo-memo-id") === memo.id) {
					this.syncTaskCheckboxDom(input, memo);
				}
			}
		}
	}

	private syncTaskCheckboxDom(input: HTMLInputElement, memo: MemoRecord): void {
		const taskIndex = this.getTaskCheckboxIndex(input);
		if (taskIndex === null) {
			return;
		}
		const task = getMarkdownTaskLines(memo.contentSnapshot)[taskIndex] ?? null;
		if (task === null) {
			return;
		}
		this.applyTaskCheckboxDomState(input, task.marker);
	}

	private applyTaskCheckboxDomState(input: HTMLInputElement, marker: MarkdownTaskMarker | WritableMarkdownTaskMarker): void {
		const renderedMarker = marker === "X" ? "x" : marker;
		input.checked = renderedMarker !== " ";
		input.indeterminate = renderedMarker === "-";
		input.setAttr("data-task", renderedMarker);
		const taskItem = input.closest("li");
		if (taskItem?.instanceOf(HTMLElement)) {
			taskItem.setAttr("data-task", renderedMarker);
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
		const shouldRestoreMobileFocus = this.beginMobileImagePickerFocusGuard();
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
		const finishWithoutFiles = () => {
			handledChange = true;
			cleanup();
			this.finishMobileImagePickerFocusGuard(shouldRestoreMobileFocus);
		};
		this.registerDomEvent(input, "change", () => {
			handledChange = true;
			this.finishMobileImagePickerFocusGuard(false);
			void this.insertImageFiles(input.files).finally(cleanup);
		});
		this.registerDomEvent(input, "cancel", () => {
			finishWithoutFiles();
		});
		this.registerDomEvent(win, "focus", () => {
			win.setTimeout(() => {
				if (!handledChange) {
					finishWithoutFiles();
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
			const links = await this.attachmentService.createImageEmbedLinks(sourcePath, Array.from(files));
			this.insertText(links.join("\n"), this.currentLayout !== "mobile");
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

	private getWikiLinkSourcePath(): string {
		const todayDailyNotePath = this.syncOrchestrator.getTodayDailyNotePath();
		if (todayDailyNotePath !== null) {
			return todayDailyNotePath;
		}
		const activeFile = this.app.workspace.getActiveFile();
		if (activeFile !== null && activeFile.extension === "md") {
			return activeFile.path;
		}
		return "";
	}

	private async copyText(text: string): Promise<void> {
		await this.containerEl.win.navigator.clipboard.writeText(text);
	}
}

function dispatchTextareaInputEvent(input: HTMLTextAreaElement): void {
	const EventConstructor = (input.win as Window & { Event: typeof Event }).Event;
	input.dispatchEvent(new EventConstructor("input", { bubbles: true, cancelable: false }));
}

function isListEnterInputEvent(event: InputEvent): boolean {
	return event.inputType === "insertParagraph" || event.inputType === "insertLineBreak" || (event.inputType === "insertText" && event.data === "\n");
}

function getMarkdownRenderPriority(renderIndex: number): MarkdownRenderPriority {
	return renderIndex < INITIAL_VISIBLE_RENDER_COUNT ? "high" : "normal";
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

function formatTrashActionErrorMessage(action: TrashAction, error: unknown): string {
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

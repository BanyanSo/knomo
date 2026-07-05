import { ItemView, Keymap, Notice, Platform, Scope, setIcon, TFile } from "obsidian";
import type { HoverPopover, WorkspaceLeaf } from "obsidian";

import { KNOMO_VIEW_DISPLAY_TEXT, KNOMO_VIEW_TYPE } from "../constants";
import { KNOMO_LOGO_ICON, KNOMO_SEARCH_ICON } from "../icons";
import { t } from "../i18n";
import type { AttachmentService } from "../services/AttachmentService";
import type { RandomReunionService } from "../services/RandomReunionService";
import { RecordStatsService } from "../services/RecordStatsService";
import type { RecordStatsView } from "../services/RecordStatsService";
import type { ReferenceService } from "../services/ReferenceService";
import type { SettingsService } from "../services/SettingsService";
import type { ShuffleDayService } from "../services/ShuffleDayService";
import type { SyncOrchestrator } from "../services/SyncOrchestrator";
import type { ScanDailyMemosResult } from "../services/MemoScanService";
import { getRecentMemoPeriods } from "../services/memoQueries";
import type { MemoMutation, MemoRecord } from "../types/memo";
import { applyListFormatToText, getHashInsertionText, getListEnterPatch, getListEnterPatchForNativeInput } from "../utils/composerInput";
import type { TextReplacement } from "../utils/composerInput";
import { formatDatePart, formatMonthPeriod } from "../utils/date";
import { stripTrailingWikiLink, withMemoIdAlias } from "../utils/references";
import { formatServiceError, formatSettingsText } from "../utils/serviceText";
import { getComposerToolButtonRoute } from "./KnomoActionRouter";
import type { MemoAction, TrashAction } from "./KnomoActionDispatch";
import { CardImageLoadQueue, type CardImageLoadSurface } from "./CardImageLoadQueue";
import { DateChangeWatcher } from "./DateChangeWatcher";
import { DesktopSidebarStateController } from "./DesktopSidebarStateController";
import { renderKnomoMemoCard, renderKnomoTrashMemoCard } from "./KnomoCard";
import {
	parseCardImageIndex,
	planMemoCardImageLoads,
	renderMemoCardImages,
} from "./KnomoCardImages";
import type { CardFlowRenderMode } from "./KnomoCardFlow";
import { KnomoCardFlowCoordinator } from "./KnomoCardFlowCoordinator";
import { renderComposerReferencePreview, renderKnomoComposer } from "./KnomoComposer";
import {
	formatMarkdownQuoteDraft,
	getComposerMode,
	getDraftForComposerClose,
	prepareComposerSaveInput,
} from "./ComposerDraft";
import { getPreferredComposerSourcePath } from "./ComposerSourcePath";
import { ComposerListEnterState } from "./ComposerListEnterState";
import type { PendingListEnterCorrection } from "./ComposerListEnterState";
import { ComposerSaveShortcutController } from "./ComposerSaveShortcutController";
import { ImagePreviewScrollLock } from "./ImagePreviewScrollLock";
import { ImageResourceCache } from "./ImageResourceCache";
import { KnomoImagePreviewModal } from "./KnomoImagePreviewModal";
import { filterVisibleMemos, memoMatchesSearch } from "./KnomoMemoFilter";
import { openMemoDailyNoteDefault, openMemoDailyNoteInNewTab } from "./memoDailyNoteOpen";
import {
	renderKnomoCardFlowHeaders,
	renderKnomoEmptyState,
} from "./KnomoFeed";
import { getCardFlowPresentation } from "./KnomoCardFlowPresenter";
import type { CardFlowPresentation } from "./KnomoCardFlowPresenter";
import {
	renderKnomoCompactHeader,
	renderKnomoCompactSearchPanel,
	renderKnomoDesktopTopbar,
	renderKnomoScopePopover,
} from "./KnomoHeaderSearch";
import { MobileSearchController } from "./MobileSearchController";
import { renderKnomoRecordStatsPage } from "./KnomoRecordStatsPage";
import {
	renderKnomoSidebar,
	renderSidebarStat,
	renderSidebarTags,
	SIDEBAR_MAX_WIDTH,
	SIDEBAR_MIN_WIDTH,
	syncSidebarNavButtons,
	syncSidebarTagGroupExpanded,
} from "./KnomoSidebar";
import { KnomoTagSuggest } from "./KnomoTagSuggest";
import { KnomoWikiLinkSuggest } from "./KnomoWikiLinkSuggest";
import type { MarkdownRenderPriority } from "./MarkdownRenderQueue";
import { MemoMarkdownRenderer } from "./MemoMarkdownRenderer";
import { getMarkdownInternalLinkInfo } from "./MarkdownInternalLink";
import {
	formatDeleteSource,
	formatMemoDisplayTime,
	formatOptionalMemoTime,
} from "./MemoDisplayFormatters";
import { parseMemoCardPreviewLite, resolveMemoPreviewImages } from "./MemoCardPreview";
import type { MemoCardPreview, MemoPreviewImage } from "./MemoCardPreview";
import { MemoCardPreviewCache } from "./MemoCardPreviewCache";
import {
	getMemoRenderRevision,
} from "./MemoRenderRevision";
import { MemoSearchCache } from "./MemoSearchCache";
import { getMemoTaskCheckboxChangePlan } from "./MemoTaskCheckboxChange";
import { MemoTaskUpdateCoordinator } from "./MemoTaskUpdateCoordinator";
import { MobileHandledToolPointer } from "./MobileHandledToolPointer";
import { MobileHeaderTitleController } from "./MobileHeaderTitleController";
import {
	measureMobileHeaderOffsets,
	MOBILE_DRAWER_TOP_DEFAULT,
	MOBILE_SEARCH_TOP_DEFAULT,
} from "./mobileHeaderMetrics";
import { MobileImagePickerFocusGuard } from "./MobileImagePickerFocusGuard";
import { MobileSendPointerGuard } from "./MobileSendPointerGuard";
import { MobileComposerController } from "./MobileComposerController";
import { MobileMemoHydrator } from "./MobileMemoHydrator";
import type { MobileMemoHydrationRenderState } from "./MobileMemoHydrator";
import { MobileNavbarCompactController } from "./MobileNavbarCompactController";
import { NativeImagePickerController } from "./NativeImagePickerController";
import { KnomoPopupState } from "./KnomoPopupState";
import { RandomReunionController } from "./RandomReunionController";
import {
	getRecordStatsHourSearchFilter,
	getRecordStatsMetricSearchFilter,
	getRecordStatsTagSearchFilter,
	getRecordStatsTrendSearchFilter,
	type RecordStatsMetricFilterType,
} from "./RecordStatsDrilldownFilters";
import { RecordStatsPreparationController } from "./RecordStatsPreparationController";
import { RecordStatsViewStateController } from "./RecordStatsViewStateController";
import { SearchQueryDebounce } from "./SearchQueryDebounce";
import { ShuffleDayController } from "./ShuffleDayController";
import { TrashMemoController } from "./TrashMemoController";
import type { TrashMemoRenderTarget } from "./TrashMemoController";
import { KnomoUserActionController } from "./KnomoUserActionController";
import {
	getCardFlowChangeIntent as getCardFlowChangeIntentKey,
	getCardFlowStateKey as getCardFlowStateKeyValue,
	getCardFlowViewStateKey as getCardFlowViewStateKeyValue,
	getVisibleCardFlowStateKey as getVisibleCardFlowStateKeyValue,
} from "./KnomoViewStateKeys";
import type { CardFlowChangeIntent } from "./KnomoViewStateKeys";
import { KnomoViewStateController } from "./KnomoViewStateController";
import type { KnomoViewStateTransitionEffects } from "./KnomoViewStateController";
import {
	collectTags,
	collectVaultTagDisplayMap,
	getMemoStats,
	getRegularFilterCopy,
	getRecordStatsSearchFilterKey,
	needsAllMemos,
} from "./viewFilters";
import type {
	RecordStatsSearchFilter,
	ScopeFilter,
	SearchDateFilter,
} from "./viewFilters";
import {
	getCurrentTitleMode,
	getDesktopTitleLabel,
	getMobileTitleLabel,
	TITLE_MODE_OPTIONS,
} from "./viewNavigation";
import type { SidebarNav, TitleMode, ViewTitleState } from "./viewNavigation";

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
	recordStatsFilterKey: string;
	todayKey: string;
	result: MemoRecord[];
}

const CARD_BATCH_SIZE = 50;
const MOBILE_INITIAL_CARD_BATCH_SIZE = 25;
const MOBILE_INITIAL_SYNC_CARD_COUNT = 8;
const MOBILE_CARD_FRAME_CHUNK_SIZE = 6;
const MOBILE_SEARCH_BATCH_SIZE = 30;
const INITIAL_VISIBLE_RENDER_COUNT = 16;
const MOBILE_EAGER_CARD_IMAGE_RENDER_COUNT = 6;
const MARKDOWN_RENDER_CONCURRENCY = 8;
const MOBILE_MARKDOWN_RENDER_CONCURRENCY = 4;
const MOBILE_CARD_IMAGE_LOAD_CONCURRENCY = 2;
const DESKTOP_CARD_IMAGE_LOAD_CONCURRENCY = 2;
const CARD_IMAGE_LOAD_WATCHDOG_MS = 10_000;
const SEARCH_DEBOUNCE_MS = 220;
const MOBILE_VIEW_HEADER_SELECTORS = [
	".workspace-leaf.mod-active .view-header",
	".mod-active .view-header",
	".view-header",
];
const TITLE_POPOVER_LEFT_DEFAULT = "max(16px, env(safe-area-inset-left))";
const TITLE_POPOVER_TOP_DEFAULT = MOBILE_DRAWER_TOP_DEFAULT;

type LayoutMode = "desktop-wide" | "desktop-medium" | "desktop-narrow" | "mobile";
type WindowWithIntersectionObserver = Window & {
	IntersectionObserver?: typeof IntersectionObserver;
};
type WindowWithResizeObserver = Window & {
	ResizeObserver?: typeof ResizeObserver;
};

interface RenderUiStateOptions {
	renderCardFlow?: boolean;
	renderMobileSearchResults?: boolean;
	cardFlowChangeIntent?: CardFlowChangeIntent;
}

type CardRenderSurface = "card-flow" | "mobile-search";
type ImageLoadPauseReason = "image-preview" | "mobile-search";
type PausableImageLoadSurface = Exclude<CardImageLoadSurface, "image-preview">;

interface ApplyMemoMutationOptions {
	preserveCardMemoId?: string;
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
	private mobileRecordStatsBackActionEl: HTMLElement | null = null;
	private sidebarResizerEl: HTMLElement | null = null;
	private memos: MemoRecord[] = [];
	private cardFlowError: string | null = null;
	private allMemosLoadingPromise: Promise<boolean> | null = null;
	private expandedTagGroups = new Set<string>();
	private composerOpen = false;
	private editingMemo: MemoRecord | null = null;
	private quoteSourceMemoId: string | null = null;
	private quoteReferenceText: string | null = null;
	private quoteMarkdownText: string | null = null;
	private draftContent = "";
	private isSaving = false;
	private isManualRefreshing = false;
	private currentLayout: LayoutMode = "desktop-wide";
	private layoutObserver: ResizeObserver | null = null;
	private filteredMemosCache: FilteredMemosCache | null = null;
	private readonly cardFlowCoordinator = new KnomoCardFlowCoordinator();
	private memoSearchCache = new MemoSearchCache();
	private readonly searchQueryDebounce: SearchQueryDebounce;
	private readonly dateChangeWatcher: DateChangeWatcher;
	private readonly desktopSidebarStateController = new DesktopSidebarStateController();
	private readonly composerListEnterState: ComposerListEnterState;
	private readonly composerSaveShortcutController = new ComposerSaveShortcutController();
	private readonly imagePreviewScrollLock = new ImagePreviewScrollLock();
	private readonly mobileHandledToolPointer: MobileHandledToolPointer;
	private readonly mobileHeaderTitleController: MobileHeaderTitleController;
	private readonly mobileImagePickerFocusGuard: MobileImagePickerFocusGuard;
	private readonly mobileSendPointerGuard = new MobileSendPointerGuard({ getNow: () => Date.now() });
	private readonly nativeImagePickerController: NativeImagePickerController;
	private readonly cardImageLoadQueue: CardImageLoadQueue;
	private readonly imageLoadPauseReasons = new Map<PausableImageLoadSurface, Set<ImageLoadPauseReason>>();
	private readonly memoMarkdownRenderer: MemoMarkdownRenderer;
	private readonly mobileMemoHydrator: MobileMemoHydrator;
	private readonly randomReunionController: RandomReunionController;
	private readonly shuffleDayController: ShuffleDayController;
	private readonly trashMemoController: TrashMemoController;
	private readonly recordStatsService = new RecordStatsService();
	private readonly recordStatsPreparationController: RecordStatsPreparationController;
	private readonly recordStatsViewStateController = new RecordStatsViewStateController();
	private readonly viewStateController = new KnomoViewStateController();
	private readonly popupState: KnomoPopupState;
	private readonly mobileSearchController: MobileSearchController;
	private readonly mobileComposerController: MobileComposerController;
	private readonly memoTaskUpdateCoordinator: MemoTaskUpdateCoordinator;
	private readonly userActionController: KnomoUserActionController;
	private mobileNavbarCompactController: MobileNavbarCompactController | null = null;
	private imagePreviewRenderGeneration = 0;
	private readonly renderedCardMemos = new Map<string, MemoRecord>();
	private readonly renderedPreviewImages = new WeakMap<HTMLElement, readonly MemoPreviewImage[]>();
	private readonly imageResourceCache = new ImageResourceCache();
	private readonly memoCardPreviewCache = new MemoCardPreviewCache((_memo, displayContent) => {
		return parseMemoCardPreviewLite(displayContent);
	});

	private get renderGeneration(): number {
		return this.cardFlowCoordinator.generation;
	}

	private set renderGeneration(generation: number) {
		this.cardFlowCoordinator.generation = generation;
	}

	private get cardFlowDeferredForAllMemos(): boolean {
		return this.cardFlowCoordinator.deferredForAllMemos;
	}

	private set cardFlowDeferredForAllMemos(deferred: boolean) {
		this.cardFlowCoordinator.deferredForAllMemos = deferred;
	}

	private get scopeFilter(): ScopeFilter {
		return this.viewStateController.scopeFilter;
	}

	private set scopeFilter(scopeFilter: ScopeFilter) {
		this.viewStateController.scopeFilter = scopeFilter;
	}

	private get searchQuery(): string {
		return this.viewStateController.searchQuery;
	}

	private set searchQuery(query: string) {
		this.viewStateController.searchQuery = query;
	}

	private get searchDateFilter(): SearchDateFilter | null {
		return this.viewStateController.searchDateFilter;
	}

	private set searchDateFilter(filter: SearchDateFilter | null) {
		this.viewStateController.searchDateFilter = filter;
	}

	private get recordStatsSearchFilter(): RecordStatsSearchFilter | null {
		return this.viewStateController.recordStatsSearchFilter;
	}

	private set recordStatsSearchFilter(filter: RecordStatsSearchFilter | null) {
		this.viewStateController.recordStatsSearchFilter = filter;
	}

	private get activeTag(): string | null {
		return this.viewStateController.activeTag;
	}

	private set activeTag(tag: string | null) {
		this.viewStateController.activeTag = tag;
	}

	private get activeTagKey(): string | null {
		return this.viewStateController.activeTagKey;
	}

	private set activeTagKey(tagKey: string | null) {
		this.viewStateController.activeTagKey = tagKey;
	}

	private get activeNav(): SidebarNav {
		return this.viewStateController.activeNav;
	}

	private set activeNav(nav: SidebarNav) {
		this.viewStateController.activeNav = nav;
	}

	private get mobileDrawerOpen(): boolean {
		return this.viewStateController.mobileDrawerOpen;
	}

	private set mobileDrawerOpen(open: boolean) {
		this.viewStateController.mobileDrawerOpen = open;
	}

	private get desktopSearchOpen(): boolean {
		return this.viewStateController.desktopSearchOpen;
	}

	private set desktopSearchOpen(open: boolean) {
		this.viewStateController.desktopSearchOpen = open;
	}

	private get compactSearchOpen(): boolean {
		return this.viewStateController.compactSearchOpen;
	}

	private set compactSearchOpen(open: boolean) {
		this.viewStateController.compactSearchOpen = open;
	}

	private get activeMenuMemoId(): string | null {
		return this.popupState.activeMenuMemoId;
	}

	private set activeMenuMemoId(memoId: string | null) {
		this.popupState.activeMenuMemoId = memoId;
	}

	private get scopeMenuOpen(): boolean {
		return this.popupState.scopeMenuOpen;
	}

	private set scopeMenuOpen(open: boolean) {
		this.popupState.scopeMenuOpen = open;
	}

	private get mobileSearchPageEl(): HTMLElement | null {
		return this.mobileSearchController.page;
	}

	private get mobileSearchInputEl(): HTMLInputElement | null {
		return this.mobileSearchController.input;
	}

	private get mobileSearchResultsEl(): HTMLElement | null {
		return this.mobileSearchController.results;
	}

	private get mobileRecordStatsSearchFilter(): RecordStatsSearchFilter | null {
		return this.mobileSearchController.searchRecordStatsFilter;
	}

	private set mobileRecordStatsSearchFilter(filter: RecordStatsSearchFilter | null) {
		this.mobileSearchController.searchRecordStatsFilter = filter;
	}

	private get mobileSearchPageOpen(): boolean {
		return this.mobileSearchController.isOpen;
	}

	private set mobileSearchPageOpen(open: boolean) {
		this.mobileSearchController.isOpen = open;
	}

	private get mobileSearchRenderGeneration(): number {
		return this.mobileSearchController.generation;
	}

	private set mobileSearchRenderGeneration(generation: number) {
		this.mobileSearchController.generation = generation;
	}

	constructor(
		leaf: WorkspaceLeaf,
		private readonly settingsService: SettingsService,
		private readonly syncOrchestrator: SyncOrchestrator,
		private readonly referenceService: ReferenceService,
		private readonly randomReunionService: RandomReunionService,
		private readonly shuffleDayService: ShuffleDayService,
		private readonly attachmentService: AttachmentService,
		private readonly onMemoMutation: (mutation: MemoMutation, sourceView: KnomoView) => void,
		private readonly onForceRefreshViews: () => Promise<void>,
		private readonly onManualRefresh: () => Promise<ScanDailyMemosResult>,
	) {
		super(leaf);
		this.popupState = new KnomoPopupState(() => this.containerEl.win);
		this.composerListEnterState = new ComposerListEnterState({
			scheduleTask: (callback, delayMs) => this.containerEl.win.setTimeout(callback, delayMs),
			cancelTask: (taskId) => this.containerEl.win.clearTimeout(taskId),
		});
		this.searchQueryDebounce = new SearchQueryDebounce({
			scheduleTask: (callback, delayMs) => this.containerEl.win.setTimeout(callback, delayMs),
			cancelTask: (taskId) => this.containerEl.win.clearTimeout(taskId),
			delayMs: SEARCH_DEBOUNCE_MS,
		});
		this.dateChangeWatcher = new DateChangeWatcher({
			getNow: () => new Date(),
			scheduleTask: (callback, delayMs) => this.containerEl.win.setTimeout(callback, delayMs),
			cancelTask: (taskId) => this.containerEl.win.clearTimeout(taskId),
		});
		this.recordStatsPreparationController = new RecordStatsPreparationController({
			scheduleTask: (callback, delayMs) => this.containerEl.win.setTimeout(callback, delayMs),
			cancelTask: (taskId) => this.containerEl.win.clearTimeout(taskId),
		});
		this.mobileHandledToolPointer = new MobileHandledToolPointer({
			scheduleClear: (callback, delayMs) => this.containerEl.win.setTimeout(callback, delayMs),
			cancelClear: (taskId) => this.containerEl.win.clearTimeout(taskId),
		});
		this.mobileHeaderTitleController = new MobileHeaderTitleController({
			registerDomEvent: (target, type, listener) => {
				this.registerDomEvent(target, type, listener);
			},
			renderChevron: (container) => {
				setIcon(container.createSpan({ cls: "knomo-title-chevron" }), "chevron-down");
			},
			canToggleScopeMenu: () => this.activeNav !== "record-stats",
			onToggleScopeMenu: () => this.toggleScopeMenu(),
		});
		this.mobileImagePickerFocusGuard = new MobileImagePickerFocusGuard({
			scheduleRestore: (callback, delayMs) => this.containerEl.win.setTimeout(callback, delayMs),
			cancelRestore: (taskId) => this.containerEl.win.clearTimeout(taskId),
		});
		this.nativeImagePickerController = new NativeImagePickerController({
			createInput: () => this.containerEl.createEl("input", {
				cls: "knomo-hidden-file-input",
				attr: {
					type: "file",
					accept: "image/*",
					multiple: "true",
				},
			}),
			beginFocusGuard: () => this.beginMobileImagePickerFocusGuard(),
			finishFocusGuard: (shouldRestoreFocus) => this.finishMobileImagePickerFocusGuard(shouldRestoreFocus),
			insertImageFiles: (files) => this.insertImageFiles(files),
		});
		this.mobileSearchController = new MobileSearchController({
			batchSize: MOBILE_SEARCH_BATCH_SIZE,
			debounceMs: SEARCH_DEBOUNCE_MS,
			getWindow: () => this.containerEl.win,
			getDocument: () => this.containerEl.doc,
			getRootEl: () => this.rootEl,
			isMobileLayout: () => this.currentLayout === "mobile",
			getMemos: () => this.memos,
			registerDomEvent: (target, type, listener) => {
				this.registerDomEvent(target, type, listener);
			},
			createHiddenText: (container, name, text) => this.createHiddenText(container, name, text),
			memoMatchesSearch: (memo, normalizedQuery, dateFilter, recordStatsFilter) => {
				return memoMatchesSearch(
					memo,
					normalizedQuery,
					dateFilter,
					recordStatsFilter,
					this.syncOrchestrator.getDailyNotesStatus(),
					(searchMemo) => this.getMemoSearchText(searchMemo),
				);
			},
			renderMemoCard: (container, memo, generation, index) => {
				this.renderMemoCardInContainer(container, memo, generation, index, true, false, "mobile-search");
			},
			clearMarkdown: (surface) => this.memoMarkdownRenderer.clear(surface),
			clearImages: (surface) => this.cardImageLoadQueue.clear(surface),
			setCardFlowPaused: (paused) => this.setImageLoadSurfacePaused("card-flow", "mobile-search", paused),
			closeSurroundingChrome: () => {
				this.mobileDrawerOpen = false;
				this.scopeMenuOpen = false;
				this.compactSearchOpen = false;
				this.desktopSearchOpen = false;
				this.activeMenuMemoId = null;
			},
			closeCardMenu: () => {
				this.activeMenuMemoId = null;
			},
			syncRootState: () => this.syncRootState(),
			getCardFlowScrollTop: () => this.getCardFlowScrollTop(),
			restoreCardFlowScrollTop: (scrollTop) => this.restoreCardFlowScrollTop(scrollTop),
			restoreElementScrollTop: (element, scrollTop) => this.restoreElementScrollTop(element, scrollTop),
			handleMarkdownInternalLinkClick: (event) => {
				void this.handleMarkdownInternalLinkClick(event);
			},
			handleTaskCheckboxClick: (event) => this.handleTaskCheckboxClick(event),
			handleTaskCheckboxChange: (event) => this.handleTaskCheckboxChange(event),
		});
		this.userActionController = this.createUserActionController();
		const imageQueueWindow = this.containerEl.win;
		this.cardImageLoadQueue = new CardImageLoadQueue({
			concurrency: Platform.isMobile
				? MOBILE_CARD_IMAGE_LOAD_CONCURRENCY
				: DESKTOP_CARD_IMAGE_LOAD_CONCURRENCY,
			getGeneration: (surface) => {
				if (surface === "mobile-search") {
					return this.mobileSearchRenderGeneration;
				}
				if (surface === "image-preview") {
					return this.imagePreviewRenderGeneration;
				}
				return this.renderGeneration;
			},
			scheduleTask: (callback, delayMs) => imageQueueWindow.setTimeout(callback, delayMs),
			cancelTask: (taskId) => imageQueueWindow.clearTimeout(taskId),
			scheduleStartTask: Platform.isMobile
				? (callback) => imageQueueWindow.requestAnimationFrame(callback)
				: undefined,
			cancelStartTask: Platform.isMobile
				? (taskId) => imageQueueWindow.cancelAnimationFrame(taskId)
				: undefined,
			watchdogMs: CARD_IMAGE_LOAD_WATCHDOG_MS,
			releaseSlotOnLoad: (surface) => Platform.isMobile
				&& (surface === "card-flow" || surface === "mobile-search"),
			Observer: (this.containerEl.win as WindowWithIntersectionObserver).IntersectionObserver,
			rootMargin: Platform.isMobile ? "280px 0px" : undefined,
		});
		this.memoMarkdownRenderer = new MemoMarkdownRenderer({
			app: this.app,
			component: this,
			getDocument: () => this.containerEl.doc,
			getGeneration: (surface) => {
				return surface === "card-flow"
					? this.renderGeneration
					: this.mobileSearchRenderGeneration;
			},
			concurrency: Platform.isMobile
				? MOBILE_MARKDOWN_RENDER_CONCURRENCY
				: MARKDOWN_RENDER_CONCURRENCY,
		});
		this.mobileMemoHydrator = new MobileMemoHydrator({
			isMobile: () => Platform.isMobile,
			isLoading: () => this.allMemosLoadingPromise !== null,
			isPaused: () => this.composerOpen,
			canHydrateCardFlow: () => this.activeNav !== "trash"
				&& this.activeNav !== "random"
				&& this.activeNav !== "shuffleDay"
				&& this.activeNav !== "record-stats",
			scheduleTask: (callback, delayMs) => this.containerEl.win.setTimeout(callback, delayMs),
			cancelTask: (taskId) => this.containerEl.win.clearTimeout(taskId),
			listMemoIndexPeriods: () => this.syncOrchestrator.listMemoIndexPeriods(),
			listMemosInPeriods: (periods) => this.syncOrchestrator.listMemosInPeriods(periods),
			getMemos: () => this.memos,
			setMemos: (memos) => {
				this.memos = memos;
			},
			invalidateFilteredMemos: () => {
				this.filteredMemosCache = null;
			},
			captureRenderState: () => this.captureMobileMemoHydrationRenderState(),
			onStarted: () => {
				this.renderStats();
				if (this.mobileDrawerOpen) {
					this.renderTags();
				}
			},
			onPeriodHydrated: (state) => this.handleMobileMemoPeriodHydrated(state),
			onCompleted: (state) => this.handleMobileMemoHydrationCompleted(state),
			onFailed: () => {
				if (this.cardFlowDeferredForAllMemos && this.shouldDeferCardFlowForAllMemos()) {
					this.renderAllMemosLoadErrorState();
				} else {
					this.cardFlowDeferredForAllMemos = false;
				}
				this.renderStats();
				this.renderTags();
			},
			onSidebarRequested: () => {
				this.renderStats();
				this.renderTags();
			},
			beginScheduledHydration: () => this.beginScheduledMobileMemoHydration(),
			ensureAllMemosLoaded: () => {
				void this.ensureAllMemosLoaded();
			},
		});
		this.trashMemoController = new TrashMemoController({
			getDeletedMemoSummary: () => this.syncOrchestrator.getDeletedMemoSummary(),
			listDeletedMemos: () => this.syncOrchestrator.listDeletedMemos(),
			restoreMemo: (memo) => this.syncOrchestrator.restoreMemoRecord(memo),
			handleRestoredMemo: (deletedMemo, restoredMemo) => this.handleRestoredTrashMemo(deletedMemo, restoredMemo),
			purgeDeletedMemo: (memo) => this.syncOrchestrator.purgeDeletedMemoRecord(memo),
			isTrashActive: () => this.activeNav === "trash",
			confirmPurge: () => this.containerEl.win.confirm(t("confirm.purgeMemo")),
			showNotice: (message) => new Notice(message),
			forceRefreshViews: () => this.onForceRefreshViews(),
			requestRender: (target) => this.handleTrashRenderRequest(target),
		});
		this.randomReunionController = new RandomReunionController({
			ensureAllMemosLoaded: async () => {
				await this.ensureAllMemosLoaded();
			},
			getMemos: () => this.memos,
			getRandomReunionMemos: (count, memos) => this.randomReunionService.getRandomReunionMemos(count, memos),
			markRandomReunionReviewed: (memoId) => this.randomReunionService.markRandomReunionReviewed(memoId),
			isRandomActive: () => this.activeNav === "random",
			showNotice: (message) => new Notice(message),
			requestRender: () => this.renderUiState(),
		});
		this.shuffleDayController = new ShuffleDayController({
			ensureAllMemosLoaded: async () => {
				const loaded = await this.ensureAllMemosLoaded();
				if (!loaded) {
					throw new Error(t("shuffleDay.failedDesc"));
				}
			},
			getMemos: () => this.memos,
			service: this.shuffleDayService,
			isShuffleDayActive: () => this.activeNav === "shuffleDay",
			showNotice: (message) => new Notice(message),
			requestRender: () => this.renderUiState(),
		});
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
			onClosed: () => this.resumeMobileBackgroundWork(),
		});
		this.scope = new Scope(this.app.scope);
		this.scope.register(["Mod"], "Enter", (event) => {
			if (this.handleComposerSaveShortcut(event)) {
				return false;
			}
		});
	}

	private createUserActionController(): KnomoUserActionController {
		return new KnomoUserActionController({
			isMobileLayout: () => this.currentLayout === "mobile",
			isMobileSearchPageOpen: () => this.mobileSearchPageOpen,
			isComposerOpen: () => this.composerOpen,
			getRenderGeneration: () => this.renderGeneration,
			hasMoreCardFlowItems: () => this.cardFlowCoordinator.hasMoreItems,
			shouldDeferCardFlowForAllMemos: () => this.shouldDeferCardFlowForAllMemos(),
			shouldIgnoreMobileSaveInput: () => this.mobileSendPointerGuard.shouldIgnoreClick(this.currentLayout === "mobile"),
			getEscapeState: () => ({
				mobileSearchPageOpen: this.mobileSearchPageOpen,
				composerOpen: this.composerOpen,
				editingOrQuoting: this.editingMemo !== null || this.quoteSourceMemoId !== null,
				hasOpenChrome: this.activeMenuMemoId !== null ||
					this.scopeMenuOpen ||
					this.desktopSearchOpen ||
					this.compactSearchOpen ||
					this.mobileDrawerOpen ||
					this.composerOpen,
			}),
			consumeSuppressedOpenPopupDismissClick: (event) => this.consumeSuppressedOpenPopupDismissClick(event),
			handleOpenPopupOutsideEvent: (event, target, suppressFollowingClick) => {
				return this.handleOpenPopupOutsideEvent(event, target, suppressFollowingClick);
			},
			handleCardImageClick: (imageTrigger) => this.handleCardImageClick(imageTrigger),
			toggleTagGroup: (tag, element) => this.toggleSidebarTagGroup(tag, element),
			applyTagFilter: (tag, tagKey) => this.applySidebarTagFilter(tag, tagKey),
			setSidebarNav: (nav) => this.setSidebarNav(nav),
			setTitleMode: (mode) => this.setTitleMode(mode),
			setSearchDateFilter: (filter, sourceEl) => this.setSearchDateFilter(filter, sourceEl),
			setMobileSearchDateFilter: (filter) => this.setMobileSearchDateFilter(filter),
			runTrashAction: (action, memoId) => this.runTrashActionById(action, memoId),
			runMemoAction: (action, memoId) => this.runMemoActionById(action, memoId),
			shouldIgnoreHandledMobileToolClick: (element, action) => this.shouldIgnoreHandledMobileToolClick(element, action),
			openMemoCardDailyNote: (memoId, randomReunion) => this.openMemoCardDailyNote(memoId, randomReunion),
			closeCardMenu: () => this.closeCardMenu(),
			closeScopeMenu: () => {
				this.scopeMenuOpen = false;
				this.syncRootState();
			},
			closeDesktopSearch: () => {
				this.desktopSearchOpen = false;
				this.syncRootState();
			},
			closeCompactSearch: () => {
				this.compactSearchOpen = false;
				this.syncRootState();
			},
			toggleCardMenu: (memoId) => this.toggleCardMenu(memoId),
			refreshRandomReunion: () => this.randomReunionController.refresh(),
			renderNextCardBatch: (generation) => this.renderNextCardBatch(generation),
			requestCardFlowHydration: () => this.mobileMemoHydrator.requestCardFlowHydration(),
			loadMoreMobileSearchResults: () => this.loadMoreMobileSearchResults(),
			resetToAllNotes: () => this.resetToAllNotes(),
			closeMobileSearchPage: () => this.closeMobileSearchPage(),
			closeComposerKeepingDraft: () => this.closeComposerKeepingDraft(),
			openDrawer: () => {
				this.mobileDrawerOpen = true;
			},
			closeDrawer: () => {
				this.mobileDrawerOpen = false;
			},
			deferSidebarHydration: () => this.mobileMemoHydrator.deferSidebarHydration(),
			toggleScopeMenu: () => this.toggleScopeMenu(),
			toggleSidebar: () => this.toggleSidebar(),
			collapseSidebar: () => this.collapseSidebarFromUserAction(),
			handleManualRefresh: () => this.handleManualRefresh(),
			focusStats: () => {
				this.sidebarEl?.querySelector<HTMLElement>(".knomo-sidebar-stats")?.focus();
			},
			returnFromRecordStats: () => this.returnFromRecordStats(),
			goToPreviousRecordStatsPeriod: () => this.goToPreviousRecordStatsPeriod(),
			goToNextRecordStatsPeriod: () => this.goToNextRecordStatsPeriod(),
			retryRecordStats: () => this.retryRecordStats(),
			renderAllMemosLoadingState: () => this.renderAllMemosLoadingState(),
			ensureAllMemosLoaded: async () => {
				await this.ensureAllMemosLoaded();
			},
			setRecordStatsView: (view) => this.setRecordStatsViewFromAction(view),
			openRecordStatsTrendFilter: (sourceEl) => this.openRecordStatsTrendFilter(sourceEl),
			openRecordStatsHourFilter: (sourceEl) => this.openRecordStatsHourFilter(sourceEl),
			openRecordStatsMetricFilter: (type) => this.openRecordStatsMetricFilter(type),
			openRecordStatsTagFilter: (sourceEl) => this.openRecordStatsTagFilter(sourceEl),
			openComposer: () => this.openComposer(),
			closeComposerWithConfirm: () => this.closeComposerWithConfirm(),
			toggleCompactSearch: () => this.toggleCompactSearchFromUserAction(),
			runComposerToolAction: (action) => this.runComposerToolAction(action),
			clearReference: () => this.clearReference(),
			cancelEditing: () => this.cancelEditing(),
			saveInput: () => this.saveInput(),
			renderUiState: () => this.renderUiState(),
			syncUiChrome: () => this.syncUiChrome(),
			syncCardMenuState: () => this.syncCardMenuState(),
			cancelEditingOrCloseComposer: () => this.cancelEditingOrCloseComposer(),
			closeOpenChromeFromEscape: () => this.closeOpenChromeFromEscape(),
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

	requestMobileNavbarSync(): void {
		this.mobileNavbarCompactController?.requestSync();
	}

	async onOpen(): Promise<void> {
		this.contentEl.addClass("knomo-view-host");
		if (Platform.isMobile) {
			this.updateCurrentLayout();
		}
		await this.render();
		if (Platform.isMobile) {
			this.mobileComposerController.prepare();
		}
		this.mobileNavbarCompactController = new MobileNavbarCompactController(this, {
			isActive: () => this.isMobileNavbarSyncTarget(),
			isComposerOpen: () => this.composerOpen,
			toggleSidebar: () => this.toggleSidebar(),
			openComposer: () => this.openComposer(),
		});
		this.mobileNavbarCompactController.start();
		this.startLayoutObserver();
		this.startDateChangeWatcher();
	}

	private isMobileNavbarSyncTarget(): boolean {
		return this.app.workspace.getActiveViewOfType(KnomoView) === this
			|| (Platform.isMobile && this.containerEl.isShown());
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
		this.clearRecordStatsPreparation();
		this.recordStatsPreparationController.clearRetryRequest();
		this.recordStatsService.invalidate();
		this.mobileMemoHydrator.cancel();
		this.clearMobileCardBatchContinuation();
		this.cardFlowCoordinator.setPendingScrollRestore(null);
		this.mobileComposerController.dispose();
		this.cardImageLoadQueue.dispose();
		this.memoCardPreviewCache.clear();
		this.imageResourceCache.clear();
		this.composerListEnterState.clear();
		this.clearHandledMobileToolPointer();
		this.nativeImagePickerController.dispose();
		this.clearMobileImagePickerFocusGuard();
		this.clearSuppressNextOpenPopupDismissClick();
		this.removeMobileSearchPage();
		this.containerEl.doc.body.removeClass("knomo-mobile-search-active");
		if (this.rootEl !== null) {
			this.resetMobileTopOffsets(this.rootEl);
		}
		this.removeMobileHeaderTitle();
		this.removeMobileHeaderActions();
		this.stopDateChangeWatcher();
		this.stopLayoutObserver();
		this.cardFlowCoordinator.removeSentinel();
		this.renderGeneration += 1;
		this.mobileSearchRenderGeneration += 1;
		this.memoMarkdownRenderer.clear();
		this.memoMarkdownRenderer.clear("mobile-search");
		this.contentEl.removeClass("knomo-view-host");
	}

	async refresh(forceRebuild = false): Promise<void> {
		if (this.activeNav === "trash") {
			await this.trashMemoController.loadTrashMemos();
			return;
		}
		await this.waitForAllMemosLoading();
		await this.reloadMemos(this.mobileMemoHydrator.getSnapshot().allMemosLoaded, forceRebuild);
		if (!Platform.isMobile) {
			void this.trashMemoController.refreshTrashCount(false);
		}
		if (this.activeNav === "random") {
			await this.randomReunionController.refresh();
		} else if (this.activeNav === "shuffleDay") {
			this.shuffleDayController.reconcileWithMemos();
			this.renderCardFlow();
		}
	}

	async reloadAllMemosAfterImport(): Promise<boolean> {
		const loaded = await this.reloadMemos(true, true);
		if (!loaded) {
			return false;
		}
		return true;
	}

	applyMemoMutation(mutation: MemoMutation, options: ApplyMemoMutationOptions = {}): void {
		const previousCardFlowKey = this.getCardFlowStateKey();
		const previousMobileSearchKey = this.getMobileSearchStateKey();
		const previousMobileSearchIdsKey = this.getMobileSearchIdsKey();
		if (mutation.type === "create") {
			const memoById = new Map(this.memos.map((memo) => [memo.id, memo]));
			memoById.set(mutation.memo.id, mutation.memo);
			this.memos = Array.from(memoById.values())
				.filter((memo) => memo.status === "active")
				.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
			this.mobileMemoHydrator.markPeriodLoaded(formatMonthPeriod(new Date(mutation.memo.createdAt)));
		} else if (mutation.type === "update") {
			this.memos = this.memos.map((memo) => memo.id === mutation.memo.id ? mutation.memo : memo);
		} else {
			this.memos = this.memos.filter((memo) => memo.id !== mutation.memo.id);
			this.trashMemoController.recordDeletedMemo(mutation.memo.id);
		}
		this.invalidateRecordStats();

		this.randomReunionController.applyMemoMutation(mutation);
		this.shuffleDayController.applyMemoMutation(mutation);
		this.filteredMemosCache = null;
		this.memoSearchCache.remove(mutation.memo.id);
		this.memoCardPreviewCache.remove(mutation.memo.id);
		this.renderStats();
		this.renderTags();
		this.renderTrashCount();

		if (previousCardFlowKey !== this.getCardFlowStateKey()) {
			this.renderCardFlow(options.preserveCardMemoId ?? null);
		}
		if (options.preserveCardMemoId !== undefined) {
			this.renderedCardMemos.set(mutation.memo.id, mutation.memo);
			this.memoMarkdownRenderer.syncTaskCheckboxesForMemo([this.cardFlowEl, this.mobileSearchResultsEl], mutation.memo);
			if (previousMobileSearchIdsKey !== this.getMobileSearchIdsKey()) {
				this.renderMobileSearchResults();
			}
		} else {
			this.renderMobileSearchResultsIfChanged(previousMobileSearchKey);
		}
		if (this.activeNav === "record-stats") {
			void this.prepareRecordStats();
		} else {
			this.scheduleRecordStatsPreparation();
		}
	}

	private handleRestoredTrashMemo(_deletedMemo: MemoRecord, restoredMemo: MemoRecord): void {
		const mutation: MemoMutation = { type: "create", memo: restoredMemo };
		this.applyMemoMutation(mutation);
		this.onMemoMutation(mutation, this);
	}

	handleAttachmentFilesChanged(paths: readonly string[]): void {
		this.cardImageLoadQueue.invalidateResourcePaths(paths);
		this.imageResourceCache.invalidateImagePaths(paths);
		const affectedMemoIds = this.memoCardPreviewCache.findImagePathMemoIds(paths);
		for (const memoId of affectedMemoIds) {
			const memo = this.findMemoById(memoId);
			if (memo !== null) {
				this.refreshVisibleMemoImages(memo);
			}
		}
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
		this.desktopSidebarStateController.setFromSettings(settings.desktopSidebarWidth, settings.desktopSidebarCollapsed);

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

		this.registerDomEvent(root, "pointerdown", (event) => {
			this.handleRootPointerDown(event);
		}, { capture: true });
		this.registerDomEvent(root, "click", (event) => {
			void this.handleRootClick(event);
		});
		this.registerDomEvent(root, "keydown", (event) => {
			void this.handleRootKeydown(event);
		});

		if (Platform.isMobile) {
			this.ensureMobileSearchPage();
		}
		this.renderScopeState();
		this.syncRootState();
		if (Platform.isMobile) {
			this.renderStats();
			this.renderTags();
			this.renderTrashCount();
			void this.loadInitialMobileMemos();
		} else {
			await this.ensureAllMemosLoaded(true);
			this.scheduleRecordStatsPreparation();
			void this.trashMemoController.refreshTrashCount(false);
		}
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
				this.setSidebarWidth(this.desktopSidebarStateController.getSnapshot().width - 8, true);
			} else if (event.key === "ArrowRight") {
				event.preventDefault();
				this.setSidebarWidth(this.desktopSidebarStateController.getSnapshot().width + 8, true);
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

	private async reloadMemos(loadAll: boolean, forceRebuild = false): Promise<boolean> {
		const previousCardFlowKey = this.getCardFlowStateKey();
		const previousMobileSearchKey = this.getMobileSearchStateKey();
		let loaded = false;
		try {
			this.memos = loadAll
				? await this.syncOrchestrator.listMemos()
				: await this.syncOrchestrator.listRecentMemos();
			this.invalidateRecordStats();
			this.mobileMemoHydrator.setReloadSuccess(
				loadAll,
				loadAll ? this.syncOrchestrator.listMemoIndexPeriods() : getRecentMemoPeriods(),
			);
			this.cardFlowError = null;
			this.filteredMemosCache = null;
			this.invalidateMemoSearchCache();
			this.retainMemoCardPreviews();
			if (forceRebuild) {
				this.resetVisibleMemos();
			}
			if (this.activeNav === "random" && !this.randomReunionController.getSnapshot().loading) {
				this.randomReunionController.clearMemos();
			}
			if (this.activeNav === "shuffleDay") {
				this.shuffleDayController.reconcileWithMemos();
			}
			loaded = true;
		} catch (error) {
			this.memos = [];
			this.invalidateRecordStats();
			this.mobileMemoHydrator.setLoadFailure();
			this.invalidateMemoSearchCache();
			this.retainMemoCardPreviews();
			this.cardFlowError = formatServiceError(error, t("empty.cardFlowFailed"));
			this.updateStatus(this.cardFlowError, true);
		}
		this.renderUiState({
			renderCardFlow: false,
			renderMobileSearchResults: false,
		});
		if (forceRebuild) {
			this.forceRebuildCardFlow();
			this.renderMobileSearchResults();
		} else {
			this.renderCardFlowIfChanged(previousCardFlowKey);
			this.renderMobileSearchResultsIfChanged(previousMobileSearchKey);
		}
		const randomSnapshot = this.randomReunionController.getSnapshot();
		if (this.activeNav === "random" && !randomSnapshot.loading && randomSnapshot.memos === null) {
			void this.randomReunionController.refresh();
		}
		if (loaded && loadAll) {
			if (this.activeNav === "record-stats") {
				void this.prepareRecordStats();
			} else {
				this.scheduleRecordStatsPreparation();
			}
		} else if (!loaded && loadAll && this.activeNav === "record-stats") {
			this.recordStatsService.fail(this.cardFlowError ?? t("recordStats.error.desc"));
			this.renderCardFlow();
		}
		return loaded;
	}

	private async loadInitialMobileMemos(): Promise<void> {
		const runId = this.mobileMemoHydrator.getSnapshot().runId;
		try {
			const memos = await this.syncOrchestrator.listRecentMemos();
			if (!this.mobileMemoHydrator.isCurrentRun(runId) || this.cardFlowEl === null || !this.cardFlowEl.isConnected) {
				return;
			}
			this.memos = memos;
			this.invalidateRecordStats();
			this.mobileMemoHydrator.setInitialLoadSuccess(getRecentMemoPeriods());
			this.cardFlowError = null;
			this.filteredMemosCache = null;
			this.invalidateMemoSearchCache();
			this.retainMemoCardPreviews();
			this.resetVisibleMemos();
			if (this.activeNav === "random" && !this.randomReunionController.getSnapshot().loading) {
				this.randomReunionController.clearMemos();
			}
			if (this.activeNav === "shuffleDay") {
				this.shuffleDayController.reconcileWithMemos();
			}
			this.renderUiState();
			const randomSnapshot = this.randomReunionController.getSnapshot();
			if (this.activeNav === "random" && !randomSnapshot.loading && randomSnapshot.memos === null) {
				void this.randomReunionController.refresh();
			}
			this.mobileMemoHydrator.schedule();
		} catch (error) {
			if (!this.mobileMemoHydrator.isCurrentRun(runId) || this.cardFlowEl === null || !this.cardFlowEl.isConnected) {
				return;
			}
			this.memos = [];
			this.mobileMemoHydrator.setLoadFailure();
			this.invalidateMemoSearchCache();
			this.retainMemoCardPreviews();
			this.cardFlowError = formatServiceError(error, t("empty.cardFlowFailed"));
			this.updateStatus(this.cardFlowError, true);
			this.renderUiState();
		}
	}

	private renderUiState(options: RenderUiStateOptions = {}): void {
		this.syncUiChrome();
		this.renderStats();
		this.renderTags();
		this.renderTrashCount();
		if (options.renderCardFlow !== false) {
			this.renderCardFlow(null, options.cardFlowChangeIntent ?? "content-change");
		}
		if (options.renderMobileSearchResults !== false) {
			this.renderMobileSearchResults();
		}
	}

	private syncUiChrome(): void {
		this.syncRootState();
		this.syncComposerDailyStatus();
		this.syncComposerMode();
		this.renderScopeState();
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
		const sidebarState = this.desktopSidebarStateController.getSnapshot();
		root.toggleClass("is-layout-desktop-wide", this.currentLayout === "desktop-wide");
		root.toggleClass("is-layout-desktop-medium", this.currentLayout === "desktop-medium");
		root.toggleClass("is-layout-desktop-narrow", this.currentLayout === "desktop-narrow");
		root.toggleClass("is-layout-mobile", this.currentLayout === "mobile");
		root.toggleClass("is-sidebar-collapsed", sidebarState.collapsed);
		root.toggleClass("is-drawer-open", this.mobileDrawerOpen);
		root.toggleClass("is-desktop-search-open", this.desktopSearchOpen);
		root.toggleClass("is-scope-open", this.scopeMenuOpen);
		root.toggleClass("is-composer-open", this.composerOpen);
		root.toggleClass("is-compact-search-open", this.compactSearchOpen);
		root.toggleClass("is-mobile-search-open", this.mobileSearchPageOpen);
		root.toggleClass("is-mobile-compact", this.settingsService.getSettings().mobileCompactMode !== "off");
		root.toggleClass("is-record-stats", this.activeNav === "record-stats");
		root.toggleClass("is-shuffle-day", this.activeNav === "shuffleDay");
		root.setCssProps({ "--knomo-sidebar-width": `${sidebarState.width}px` });
		this.syncTooltipState(root);
		this.syncManualRefreshButtonState();
		this.syncMobileHeaderActions();
		this.syncMobileHeaderTitle();
		this.syncMobileTopOffsets(root);
		this.syncTitlePopoverPosition();
		this.syncMobileSearchPage();
		this.mobileComposerController.syncViewportTracking();
		this.mobileComposerController.syncLayer();
		if (this.sidebarResizerEl !== null) {
			this.sidebarResizerEl.setAttr("aria-valuenow", String(sidebarState.width));
		}
		this.rootEl?.findAll("[aria-expanded]").forEach((element) => {
			if (element.getAttr("data-action") === "toggle-scope-menu") {
				element.setAttr("aria-expanded", this.scopeMenuOpen ? "true" : "false");
			}
		});
		this.mobileNavbarCompactController?.sync();
	}

	private syncManualRefreshButtonState(): void {
		const root = this.rootEl;
		if (root === null) {
			return;
		}
		for (const element of root.findAll('[data-action="refresh"]')) {
			if (!element.instanceOf(HTMLButtonElement)) {
				continue;
			}
			element.toggleClass("is-loading", this.isManualRefreshing);
			element.disabled = this.isManualRefreshing;
			if (this.isManualRefreshing) {
				element.setAttr("aria-busy", "true");
			} else {
				element.removeAttribute("aria-busy");
			}
		}
	}

	private syncMobileTopOffsets(root: HTMLElement): void {
		if (this.currentLayout !== "mobile") {
			this.resetMobileTopOffsets(root);
			return;
		}
		const metrics = measureMobileHeaderOffsets(this.findMobileViewHeader(), this.containerEl.win.innerHeight);
		if (metrics === null) {
			this.resetMobileTopOffsets(root);
			return;
		}
		root.setCssProps({
			"--knomo-mobile-drawer-top": `${metrics.drawerTop}px`,
			"--knomo-mobile-search-top": `${metrics.searchTop}px`,
		});
	}

	private resetMobileTopOffsets(root: HTMLElement): void {
		root.setCssProps({
			"--knomo-mobile-drawer-top": MOBILE_DRAWER_TOP_DEFAULT,
			"--knomo-mobile-search-top": MOBILE_SEARCH_TOP_DEFAULT,
		});
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
		if (this.currentLayout !== "mobile") {
			this.removeMobileHeaderActions();
			return;
		}
		if (this.activeNav === "record-stats") {
			this.removeMobileSearchHeaderAction();
			this.ensureMobileRecordStatsBackAction();
			return;
		}
		this.removeMobileRecordStatsBackAction();
		this.ensureMobileSearchHeaderAction();
	}

	private syncMobileHeaderTitle(): void {
		if (this.currentLayout !== "mobile") {
			this.removeMobileHeaderTitle();
			return;
		}
		const headerEl = this.findMobileViewHeader();
		if (headerEl === null) {
			return;
		}
		const titleEl = headerEl.querySelector(".view-header-title");
		if (!titleEl?.instanceOf(HTMLElement)) {
			return;
		}
		this.mobileHeaderTitleController.sync({
			headerEl,
			titleEl,
			isRecordStats: this.activeNav === "record-stats",
			scopeMenuOpen: this.scopeMenuOpen,
			label: getMobileTitleLabel(this.getTitleState()),
		});
	}

	private syncTitlePopoverPosition(): void {
		const root = this.rootEl;
		if (root === null) {
			return;
		}
		const anchor = this.getTitlePopoverAnchor();
		if (anchor === null) {
			root.setCssProps({
				"--knomo-title-popover-left": TITLE_POPOVER_LEFT_DEFAULT,
				"--knomo-title-popover-top": TITLE_POPOVER_TOP_DEFAULT,
			});
			return;
		}
		const rect = anchor.getBoundingClientRect();
		if (this.currentLayout === "mobile") {
			root.setCssProps({
				"--knomo-title-popover-left": TITLE_POPOVER_LEFT_DEFAULT,
				"--knomo-title-popover-top": `${Math.round(rect.bottom + 6)}px`,
			});
			return;
		}
		const container = anchor.closest(".knomo-main");
		const containerRect = container?.getBoundingClientRect() ?? root.getBoundingClientRect();
		const dropdownWidth = 168;
		const popoverPadding = 12;
		const maxLeft = Math.max(popoverPadding, Math.round(containerRect.width - dropdownWidth - popoverPadding));
		const left = Math.min(
			maxLeft,
			Math.max(popoverPadding, Math.round(rect.left - containerRect.left)),
		);
		root.setCssProps({
			"--knomo-title-popover-left": `${left}px`,
			"--knomo-title-popover-top": `${Math.round(rect.bottom - containerRect.top + 6)}px`,
		});
	}

	private getTitlePopoverAnchor(): HTMLElement | null {
		if (this.currentLayout === "mobile") {
			return this.mobileHeaderTitleController.getAnchor();
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

	private ensureMobileSearchHeaderAction(): void {
		if (this.mobileSearchHeaderActionEl === null || !this.mobileSearchHeaderActionEl.isConnected) {
			this.mobileSearchHeaderActionEl?.remove();
			this.mobileSearchHeaderActionEl = this.addAction(KNOMO_SEARCH_ICON, t("search.knomo"), () => this.openMobileHeaderSearch());
			this.mobileSearchHeaderActionEl.addClass("knomo-mobile-header-action");
			this.mobileSearchHeaderActionEl.setAttr("aria-label", t("search.knomo"));
		}
	}

	private ensureMobileRecordStatsBackAction(): void {
		if (this.mobileRecordStatsBackActionEl === null || !this.mobileRecordStatsBackActionEl.isConnected) {
			this.mobileRecordStatsBackActionEl?.remove();
			this.mobileRecordStatsBackActionEl = this.addAction("arrow-left", t("recordStats.back"), () => this.returnFromRecordStats());
			this.mobileRecordStatsBackActionEl.addClass("knomo-mobile-header-action", "knomo-record-stats-back");
			this.mobileRecordStatsBackActionEl.setAttr("aria-label", t("recordStats.back"));
		}
	}

	private removeMobileHeaderActions(): void {
		this.removeMobileSearchHeaderAction();
		this.removeMobileRecordStatsBackAction();
	}

	private removeMobileSearchHeaderAction(): void {
		this.mobileSearchHeaderActionEl?.remove();
		this.mobileSearchHeaderActionEl = null;
	}

	private removeMobileRecordStatsBackAction(): void {
		this.mobileRecordStatsBackActionEl?.remove();
		this.mobileRecordStatsBackActionEl = null;
	}

	private removeMobileHeaderTitle(): void {
		this.mobileHeaderTitleController.remove();
	}

	private openMobileHeaderSearch(): void {
		this.openMobileSearchPage();
	}

	private openMobileSearchPage(options: {
		focusInput?: boolean;
		changeIntent?: CardFlowChangeIntent;
	} = {}): void {
		this.mobileSearchController.openPage(options);
	}

	private ensureMobileSearchPage(): void {
		this.mobileSearchController.ensurePage();
	}

	private syncMobileSearchPage(): void {
		this.mobileSearchController.syncPage();
	}

	private closeMobileSearchPage(): void {
		this.mobileSearchController.closePage();
	}

	private removeMobileSearchPage(): void {
		this.mobileSearchController.removePage();
	}

	private clearMobileSearchDebounce(): void {
		this.mobileSearchController.clearDebounce();
	}

	private setMobileSearchDateFilter(filter: SearchDateFilter): void {
		this.mobileSearchController.setDateFilter(filter);
	}

	private resetMobileSearchState(): void {
		this.mobileSearchController.resetState();
	}

	private loadMoreMobileSearchResults(): void {
		this.mobileSearchController.loadMore();
	}

	private renderMobileSearchResults(changeIntent: CardFlowChangeIntent = "content-change"): void {
		this.mobileSearchController.renderResults(changeIntent);
	}

	private startLayoutObserver(): void {
		if (this.layoutObserver !== null) {
			return;
		}
		const win: WindowWithResizeObserver = this.containerEl.win;
		const ResizeObserverConstructor = win.ResizeObserver;
		if (ResizeObserverConstructor !== undefined) {
			const observer = new ResizeObserverConstructor(() => {
				this.syncLayoutMeasurements();
			});
			observer.observe(this.containerEl);
			this.layoutObserver = observer;
		}
		this.syncLayoutMeasurements();
	}

	private stopLayoutObserver(): void {
		if (this.layoutObserver !== null) {
			this.layoutObserver.disconnect();
			this.layoutObserver = null;
		}
	}

	private syncLayoutMeasurements(): void {
		this.updateCurrentLayout();
		this.syncRootState();
		this.updateMobileComposerMeasurements();
		this.resizeInput();
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
		const loading = Platform.isMobile
			&& this.mobileDrawerOpen
			&& this.mobileMemoHydrator.getSnapshot().loadMode === "hydrating";
		for (const statsEl of this.statsEls) {
			statsEl.empty();
			statsEl.toggleClass("is-loading", loading);
			renderSidebarStat(statsEl, String(stats.memoCount), t("stats.notes"));
			renderSidebarStat(statsEl, String(stats.tagCount), t("stats.tags"));
			renderSidebarStat(statsEl, stats.imageCount > 0 ? String(stats.imageCount) : String(stats.wordCount), stats.imageCount > 0 ? t("stats.images") : t("stats.words"));
		}
	}

	private renderTags(): void {
		if (Platform.isMobile && this.mobileDrawerOpen && this.mobileMemoHydrator.getSnapshot().loadMode !== "all") {
			this.allTagsEl?.empty();
			return;
		}
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
		const { trashCount } = this.trashMemoController.getSnapshot();
		for (const countEl of this.trashCountEls) {
			countEl.setText(trashCount > 0 ? String(trashCount) : "");
			countEl.toggleAttribute("hidden", trashCount === 0);
		}
	}

	private renderScopeState(): void {
		for (const titleHost of this.titleHosts) {
			this.renderTitleHost(titleHost);
		}
		this.syncMobileHeaderTitle();
		syncSidebarNavButtons(this.rootEl, this.activeNav);
		const titleState = this.getTitleState();
		this.rootEl?.findAll("[data-title-mode]").forEach((element) => {
			const active = element.getAttr("data-title-mode") === getCurrentTitleMode(titleState);
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
		const titleState = this.getTitleState();
		const label = host.mobile ? getMobileTitleLabel(titleState) : getDesktopTitleLabel(titleState);
		if (this.activeNav === "record-stats") {
			host.el.createSpan({ cls: "knomo-title-label", text: label });
			return;
		}
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

	private getTitleState(): ViewTitleState {
		return {
			activeTag: this.activeTag,
			activeTagKey: this.activeTagKey,
			activeNav: this.activeNav,
			scopeFilter: this.scopeFilter,
			searchQuery: this.searchQuery,
			searchDateFilter: this.searchDateFilter,
			recordStatsSearchFilter: this.recordStatsSearchFilter,
		};
	}

	private isDefaultListState(): boolean {
		return this.viewStateController.isDefaultListState();
	}

	private getCardFlowViewStateKey(): string {
		return getCardFlowViewStateKeyValue({
			activeNav: this.activeNav,
			scopeFilter: this.scopeFilter,
			activeTagKey: this.activeTagKey,
			searchQuery: this.searchQuery,
			searchDateFilter: this.searchDateFilter,
			recordStatsSearchFilter: this.recordStatsSearchFilter,
		});
	}

	private getCardFlowChangeIntent(previousViewStateKey: string): CardFlowChangeIntent {
		return getCardFlowChangeIntentKey(previousViewStateKey, {
			activeNav: this.activeNav,
			scopeFilter: this.scopeFilter,
			activeTagKey: this.activeTagKey,
			searchQuery: this.searchQuery,
			searchDateFilter: this.searchDateFilter,
			recordStatsSearchFilter: this.recordStatsSearchFilter,
		});
	}

	private renderCardFlow(
		preserveCardMemoId: string | null = null,
		changeIntent: CardFlowChangeIntent = "content-change",
	): void {
		if (changeIntent === "view-scope-change") {
			this.forceRebuildCardFlow(changeIntent);
			return;
		}
		if (this.deferMobileCardFlowRender(preserveCardMemoId, false, changeIntent)) {
			return;
		}
		if (this.cardFlowEl === null) {
			return;
		}
		this.cardFlowDeferredForAllMemos = false;
		if (this.activeNav === "record-stats") {
			this.renderRecordStatsPage();
			return;
		}
		this.recordStatsViewStateController.clearRendered();

		const presentation = this.getCurrentCardFlowPresentation();
		if (presentation.type === "empty") {
			this.renderEmptyCardFlow(presentation);
			return;
		}
		this.syncCardFlowPresentation(presentation, preserveCardMemoId);
	}

	private renderRecordStatsPage(force = false): void {
		const cardFlow = this.cardFlowEl;
		if (cardFlow === null) {
			return;
		}
		const renderKey = this.getCardFlowStateKey();
		if (!force && cardFlow.childElementCount > 0 && this.recordStatsViewStateController.isRendered(renderKey)) {
			return;
		}
		const recordStatsState = this.recordStatsViewStateController.getSnapshot();
		this.renderGeneration += 1;
		this.memoMarkdownRenderer.clear();
		this.cardImageLoadQueue.clear("card-flow");
		this.cardFlowCoordinator.resetFlowRuntime(this.containerEl.win);
		this.renderedCardMemos.clear();
		cardFlow.empty();
		const selected = this.recordStatsService.select(recordStatsState.view, recordStatsState.selectedDate);
		renderKnomoRecordStatsPage(cardFlow, {
			snapshot: this.recordStatsService.getSnapshot(),
			selected,
			view: recordStatsState.view,
			createHiddenText: (container, name, text) => this.createHiddenText(container, name, text),
			canAdvance: this.recordStatsViewStateController.canAdvance(),
			canRetreat: this.recordStatsViewStateController.canRetreat(this.recordStatsService.getEarliestYear()),
		});
		this.recordStatsViewStateController.markRendered(renderKey);
	}

	private forceRebuildCardFlow(changeIntent: CardFlowChangeIntent = "content-change"): void {
		if (this.deferMobileCardFlowRender(null, true, changeIntent)) {
			return;
		}
		if (this.cardFlowEl === null) {
			return;
		}
		this.cardFlowCoordinator.setPendingScrollRestore(null);
		const scrollTop = changeIntent === "view-scope-change"
			? 0
			: this.getCardFlowScrollTop() ?? 0;
		const initialBatchSize = changeIntent === "view-scope-change"
			? this.getInitialCardBatchSize()
			: Math.max(this.getInitialCardBatchSize(), this.getRenderedCardCount());
		if (changeIntent === "view-scope-change") {
			this.restoreCardFlowScrollTop(0);
		}
		if (this.activeNav === "record-stats") {
			this.renderRecordStatsPage(true);
			this.restoreCardFlowScrollTop(scrollTop);
			return;
		}
		this.recordStatsViewStateController.clearRendered();
		const generation = this.renderGeneration + 1;
		this.renderGeneration = generation;
		this.memoMarkdownRenderer.clear();
		this.cardImageLoadQueue.clear("card-flow");
		this.cardFlowCoordinator.resetFlowRuntime(this.containerEl.win);
		this.cardFlowEl.empty();
		this.renderedCardMemos.clear();
		this.cardFlowCoordinator.setPendingScrollRestore({ generation, scrollTop, visibleCount: initialBatchSize });
		this.renderCardFlowPresentation(this.getCurrentCardFlowPresentation(), generation, initialBatchSize);
	}

	private deferMobileCardFlowRender(
		preserveCardMemoId: string | null,
		forceRebuild: boolean,
		changeIntent: CardFlowChangeIntent,
	): boolean {
		return this.cardFlowCoordinator.deferMobileRender({
			isMobile: Platform.isMobile,
			composerOpen: this.composerOpen,
			preserveCardMemoId,
			forceRebuild,
			changeIntent,
		});
	}

	private getCurrentCardFlowPresentation(): CardFlowPresentation {
		const randomSnapshot = this.randomReunionController.getSnapshot();
		const shuffleDaySnapshot = this.shuffleDayController.getSnapshot();
		const trashSnapshot = this.trashMemoController.getSnapshot();
		const shouldLoadListMemos = this.cardFlowError === null
			&& this.activeNav !== "trash"
			&& this.activeNav !== "shuffleDay"
			&& !(this.activeNav === "random" && randomSnapshot.loading);
		const memos = shouldLoadListMemos ? this.getFilteredMemos() : [];
		return getCardFlowPresentation({
			cardFlowError: this.activeNav === "shuffleDay" ? null : this.cardFlowError,
			activeNav: this.activeNav,
			randomReunionLoading: randomSnapshot.loading,
			shuffleDay: shuffleDaySnapshot,
			memos,
			regularFilterCopy: shouldLoadListMemos && this.activeNav === "all" ? getRegularFilterCopy({
				activeTag: this.activeTag,
				activeTagKey: this.activeTagKey,
				searchQuery: this.searchQuery,
				searchDateFilter: this.searchDateFilter,
				recordStatsSearchFilter: this.recordStatsSearchFilter,
				scopeFilter: this.scopeFilter,
			}, memos.length) : null,
			trashLoading: trashSnapshot.trashLoading,
			trashError: trashSnapshot.trashError,
			trashMemos: trashSnapshot.trashMemos,
		});
	}

	private renderEmptyCardFlow(presentation: Extract<CardFlowPresentation, { type: "empty" }>): void {
		if (this.cardFlowEl === null) {
			return;
		}
		this.cardFlowCoordinator.setPendingScrollRestore(null);
		this.cardFlowCoordinator.resetFlowRuntime(this.containerEl.win);
		for (const card of this.getDirectCardElements(this.cardFlowEl)) {
			this.removeCardElement(card);
		}
		this.cardFlowEl.empty();
		this.renderedCardMemos.clear();
		renderKnomoEmptyState(this.cardFlowEl, presentation.title, presentation.description);
	}

	private syncCardFlowPresentation(
		presentation: Extract<CardFlowPresentation, { type: "items" }>,
		preserveCardMemoId: string | null,
	): void {
		const cardFlow = this.cardFlowEl;
		if (cardFlow === null) {
			return;
		}
		this.cardFlowCoordinator.clearMobileBatchContinuation(this.containerEl.win);
		this.cardFlowCoordinator.removeSentinel();
		for (const child of Array.from(cardFlow.children)) {
			if (child.instanceOf(HTMLElement) && !child.hasClass("knomo-card")) {
				child.remove();
			}
		}

		const existingCards = new Map(
			this.getDirectCardElements(cardFlow)
				.map((card) => [card.getAttr("data-memo-id"), card] as const)
				.filter((entry): entry is [string, HTMLElement] => entry[0] !== null),
		);
		const pendingVisibleCount = this.cardFlowCoordinator.getPendingVisibleCount(this.renderGeneration);
		const visibleCount = Math.min(
			presentation.memos.length,
			Math.max(this.getInitialCardBatchSize(), existingCards.size, pendingVisibleCount ?? 0),
		);
		const visibleMemos = presentation.memos.slice(0, visibleCount);
		const desiredIds = new Set(visibleMemos.map((memo) => memo.id));
		const renderedCards: HTMLElement[] = [];

		for (const [index, memo] of visibleMemos.entries()) {
			const existingCard = existingCards.get(memo.id) ?? null;
			const previousMemo = this.renderedCardMemos.get(memo.id) ?? null;
			let card: HTMLElement;
			if (
				existingCard !== null
				&& (
					preserveCardMemoId === memo.id
					|| this.canReuseRenderedMemo(previousMemo, memo)
				)
			) {
				card = existingCard;
			} else if (existingCard !== null) {
				card = this.replaceMemoCard(existingCard, previousMemo, memo, index, presentation.mode);
			} else {
				card = this.renderCardForMode(cardFlow, memo, this.renderGeneration, index, presentation.mode);
			}
			this.renderedCardMemos.set(memo.id, memo);
			renderedCards.push(card);
		}

		for (const [memoId, card] of existingCards) {
			if (!desiredIds.has(memoId)) {
				this.removeCardElement(card);
				this.renderedCardMemos.delete(memoId);
			}
		}

		let currentCard = cardFlow.firstElementChild;
		for (const card of renderedCards) {
			if (card !== currentCard) {
				cardFlow.insertBefore(card, currentCard);
			}
			currentCard = card.nextElementSibling;
		}
		const firstCard = renderedCards[0] ?? null;
		const headers = renderKnomoCardFlowHeaders(cardFlow, presentation.headers);
		if (firstCard !== null) {
			for (const header of headers) {
				cardFlow.insertBefore(header, firstCard);
			}
		}
		this.cardFlowCoordinator.syncBatch(presentation.memos, presentation.mode, visibleMemos.length);
		this.renderCardFlowSentinelIfNeeded();
		this.syncCardMenuState();
		this.restorePendingCardFlowScrollTop(this.renderGeneration);
	}

	private replaceMemoCard(
		existingCard: HTMLElement,
		previousMemo: MemoRecord | null,
		memo: MemoRecord,
		renderIndex: number,
		mode: CardFlowRenderMode,
	): HTMLElement {
		const cardFlow = this.cardFlowEl;
		if (cardFlow === null) {
			return existingCard;
		}
		const reusedBodyEl = mode === "memo" && previousMemo?.contentHash === memo.contentHash
			? existingCard.find(".knomo-card-body")
			: null;
		const reusedImagesEl = reusedBodyEl === null
			&& mode === "memo"
			&& previousMemo !== null
			? existingCard.find(".knomo-card-images")
			: null;
		const replacement = this.renderCardForMode(
			cardFlow,
			memo,
			this.renderGeneration,
			renderIndex,
			mode,
			reusedBodyEl?.instanceOf(HTMLElement) ? reusedBodyEl : null,
			reusedImagesEl?.instanceOf(HTMLElement) ? reusedImagesEl : null,
		);
		existingCard.replaceWith(replacement);
		this.removeCardImageTargets(existingCard);
		return replacement;
	}

	private renderCardForMode(
		container: HTMLElement,
		memo: MemoRecord,
		generation: number,
		renderIndex: number,
		mode: CardFlowRenderMode,
		reusedBodyEl: HTMLElement | null = null,
		reusedImagesEl: HTMLElement | null = null,
	): HTMLElement {
		if (mode === "trash") {
			return this.renderTrashMemoCardInContainer(container, memo, generation, renderIndex);
		}
		return this.renderMemoCardInContainer(
			container,
			memo,
			generation,
			renderIndex,
			true,
			this.activeNav === "random",
			"card-flow",
			reusedBodyEl,
			reusedImagesEl,
		);
	}

	private canReuseRenderedMemo(previousMemo: MemoRecord | null, memo: MemoRecord): boolean {
		return previousMemo !== null && getMemoRenderRevision(previousMemo) === getMemoRenderRevision(memo);
	}

	private getDirectCardElements(container: HTMLElement): HTMLElement[] {
		return Array.from(container.children).filter(
			(child): child is HTMLElement => child.instanceOf(HTMLElement) && child.hasClass("knomo-card"),
		);
	}

	private getRenderedCardCount(): number {
		return this.cardFlowEl === null ? 0 : this.getDirectCardElements(this.cardFlowEl).length;
	}

	private removeCardElement(card: HTMLElement): void {
		this.removeCardImageTargets(card);
		card.remove();
	}

	private removeCardImageTargets(card: HTMLElement): void {
		for (const imagesEl of card.findAll(".knomo-card-images")) {
			this.cardImageLoadQueue.forget(imagesEl);
		}
	}

	private renderCardFlowPresentation(
		presentation: CardFlowPresentation,
		generation: number,
		initialBatchSize = this.getInitialCardBatchSize(),
	): void {
		if (presentation.type === "empty") {
			if (this.cardFlowEl !== null) {
				renderKnomoEmptyState(this.cardFlowEl, presentation.title, presentation.description);
			}
			this.restorePendingCardFlowScrollTop(generation);
			return;
		}
		if (this.cardFlowEl === null) {
			return;
		}
		renderKnomoCardFlowHeaders(this.cardFlowEl, presentation.headers);
		this.startCardFeed(presentation.memos, presentation.mode, generation, initialBatchSize);
	}

	private startCardFeed(
		memos: MemoRecord[],
		mode: CardFlowRenderMode,
		generation: number,
		initialBatchSize = this.getInitialCardBatchSize(),
	): void {
		this.cardFlowCoordinator.clearMobileBatchContinuation(this.containerEl.win);
		const batch = this.cardFlowCoordinator.startBatch(memos, mode, initialBatchSize);
		this.renderCardBatch(batch, generation);
	}

	private getInitialCardBatchSize(): number {
		if (this.activeNav === "shuffleDay") {
			return Number.MAX_SAFE_INTEGER;
		}
		return Platform.isMobile ? MOBILE_INITIAL_CARD_BATCH_SIZE : CARD_BATCH_SIZE;
	}

	private renderNextCardBatch(generation: number, batchSize = CARD_BATCH_SIZE): void {
		if (this.cardFlowEl === null || generation !== this.renderGeneration) {
			return;
		}
		const batch = this.cardFlowCoordinator.beginNextBatch(batchSize);
		this.renderCardBatch(batch, generation, true);
	}

	private renderCardBatch(
		batch: ReturnType<KnomoCardFlowCoordinator["beginNextBatch"]>,
		generation: number,
		hydrateWhenExhausted = false,
	): void {
		this.cardFlowCoordinator.renderBatch({
			batch,
			generation,
			isMobile: Platform.isMobile,
			syncItemLimit: MOBILE_INITIAL_SYNC_CARD_COUNT,
			chunkSize: MOBILE_CARD_FRAME_CHUNK_SIZE,
			hydrateWhenExhausted,
			renderItem: (item, currentGeneration) => {
				if (item.mode === "trash") {
					this.renderTrashMemoCard(item.memo, currentGeneration, item.renderIndex);
				} else {
					this.renderMemoCard(item.memo, currentGeneration, item.renderIndex);
				}
			},
			getSentinelRoot: () => this.cardFlowEl,
			getObserver: () => (this.containerEl.win as WindowWithIntersectionObserver).IntersectionObserver,
			onRenderNextBatch: (value) => this.renderNextCardBatch(value),
			requestHydration: () => this.mobileMemoHydrator.requestCardFlowHydration(),
			restorePendingScrollTop: (scrollTop) => this.restoreCardFlowScrollTop(scrollTop),
			scheduleContinuation: (continuation) => this.scheduleMobileCardBatchContinuation(continuation),
		});
	}

	private scheduleMobileCardBatchContinuation(continuation: () => void): void {
		this.cardFlowCoordinator.scheduleMobileBatchContinuation(continuation, this.containerEl.win, this.composerOpen);
	}

	private pauseMobileCardBatchContinuation(): void {
		this.cardFlowCoordinator.pauseMobileBatchContinuation(this.containerEl.win);
	}

	private resumeMobileCardBatchContinuation(): void {
		this.cardFlowCoordinator.resumeMobileBatchContinuation(this.containerEl.win, this.composerOpen);
	}

	private clearMobileCardBatchContinuation(): void {
		this.cardFlowCoordinator.clearMobileBatchContinuation(this.containerEl.win);
	}

	private renderMemoCard(memo: MemoRecord, generation: number, renderIndex: number): void {
		if (this.cardFlowEl === null) {
			return;
		}
		this.renderMemoCardInContainer(
			this.cardFlowEl,
			memo,
			generation,
			renderIndex,
			true,
			this.activeNav === "random",
			"card-flow",
		);
		this.renderedCardMemos.set(memo.id, memo);
	}

	private renderMemoCardInContainer(
		container: HTMLElement,
		memo: MemoRecord,
		generation: number,
		renderIndex: number,
		includeActions: boolean,
		randomCard: boolean,
		surface: CardRenderSurface,
		reusedBodyEl: HTMLElement | null = null,
		reusedImagesEl: HTMLElement | null = null,
	): HTMLElement {
		const { deletedMemoIds } = this.trashMemoController.getSnapshot();
		return renderKnomoMemoCard(container, memo, {
			generation,
			renderIndex,
			includeActions,
			randomCard,
			activeMenuMemoId: this.activeMenuMemoId,
			deletedMemoIds,
			formatDisplayTime: formatMemoDisplayTime,
			formatSettingsText,
			getMarkdownPriority: getMarkdownRenderPriority,
			getMemoCardPreview: (memoRecord) => this.getMemoCardPreview(memoRecord),
			queueMemoMarkdown: (memoRecord, content, renderGeneration, priority, previewText) => {
				this.memoMarkdownRenderer.queueMemoMarkdown(memoRecord, content, renderGeneration, priority, previewText, surface);
			},
			renderMemoCardImages: (content, memoRecord, images, renderGeneration, reusedImagesEl) => {
				this.renderMemoCardImages(content, memoRecord, images, renderGeneration, surface, renderIndex, reusedImagesEl ?? null);
			},
			queueSourceReferenceMarkdown: (content, text, sourcePath, renderGeneration) => {
				this.memoMarkdownRenderer.queueSourceReferenceMarkdown(content, text, sourcePath, renderGeneration, surface);
			},
			reusedBodyEl,
			reusedImagesEl,
		});
	}

	private renderTrashMemoCard(memo: MemoRecord, generation: number, renderIndex: number): void {
		if (this.cardFlowEl === null) {
			return;
		}
		this.renderTrashMemoCardInContainer(this.cardFlowEl, memo, generation, renderIndex);
		this.renderedCardMemos.set(memo.id, memo);
	}

	private renderTrashMemoCardInContainer(
		container: HTMLElement,
		memo: MemoRecord,
		generation: number,
		renderIndex: number,
	): HTMLElement {
		const { trashBusyMemoActions } = this.trashMemoController.getSnapshot();
		return renderKnomoTrashMemoCard(container, memo, {
			generation,
			renderIndex,
			busyAction: trashBusyMemoActions.get(memo.id) ?? null,
			formatDisplayTime: formatMemoDisplayTime,
			formatOptionalTime: formatOptionalMemoTime,
			formatDeleteSource,
			formatSettingsText,
			getMarkdownPriority: getMarkdownRenderPriority,
			getMemoCardPreview: (memoRecord) => this.getMemoCardPreview(memoRecord),
			queueMemoMarkdown: (memoRecord, content, renderGeneration, priority, previewText) => {
				this.memoMarkdownRenderer.queueMemoMarkdown(memoRecord, content, renderGeneration, priority, previewText, "card-flow");
			},
			renderMemoCardImages: (content, memoRecord, images, renderGeneration, reusedImagesEl) => {
				this.renderMemoCardImages(content, memoRecord, images, renderGeneration, "card-flow", renderIndex, reusedImagesEl ?? null);
			},
		});
	}

	private getMemoCardPreview(memo: MemoRecord): MemoCardPreview {
		return resolveMemoPreviewImages(
			this.memoCardPreviewCache.get(memo, this.getMemoDisplayContent(memo)),
			memo.dailyRef.path,
			this.app,
			this.imageResourceCache,
		);
	}

	private getMemoDisplayContent(memo: MemoRecord): string {
		return memo.references.length > 0 ? stripTrailingWikiLink(memo.contentSnapshot) : memo.contentSnapshot;
	}

	private retainMemoCardPreviews(): void {
		const memoIds = new Set(this.memos.map((memo) => memo.id));
		for (const memo of this.randomReunionController.getSnapshot().memos ?? []) {
			memoIds.add(memo.id);
		}
		for (const memo of this.trashMemoController.getSnapshot().trashMemos ?? []) {
			memoIds.add(memo.id);
		}
		this.memoCardPreviewCache.retain(memoIds);
	}

	private renderMemoCardImages(
		container: HTMLElement,
		memo: MemoRecord,
		images: MemoPreviewImage[],
		generation: number,
		surface: CardRenderSurface,
		renderIndex = Number.POSITIVE_INFINITY,
		reusedImagesEl: HTMLElement | null = null,
	): void {
		const rendered = renderMemoCardImages(container, memo, images, {
			previewLabel: t("image.previewLabel"),
			unavailableLabel: t("image.unavailable"),
		}, reusedImagesEl);
		if (rendered === null) {
			return;
		}
		if (rendered.loadItems.length > 0) {
			this.cardImageLoadQueue.forget(rendered.imagesEl, true);
		}
		this.renderedPreviewImages.set(rendered.imagesEl, images);
		const eagerFirstImage = surface === "card-flow"
			&& Platform.isMobile
			&& renderIndex < MOBILE_EAGER_CARD_IMAGE_RENDER_COUNT;
		const { observedLoadItems, eagerLoadItems } = planMemoCardImageLoads(rendered.loadItems, eagerFirstImage);
		if (observedLoadItems.length > 0) {
			this.cardImageLoadQueue.observe({
				targetEl: rendered.imagesEl,
				images: observedLoadItems,
				generation,
				surface,
			});
		}
		if (eagerLoadItems.length > 0) {
			this.cardImageLoadQueue.observe({
				targetEl: rendered.imagesEl,
				images: eagerLoadItems,
				generation,
				surface,
				observe: false,
			});
		}
	}

	private refreshVisibleMemoImages(memo: MemoRecord): void {
		const preview = this.getMemoCardPreview(memo);
		this.refreshMemoImagesInContainer(
			this.cardFlowEl,
			memo,
			preview.images,
			this.renderGeneration,
			"card-flow",
		);
		this.refreshMemoImagesInContainer(
			this.mobileSearchResultsEl,
			memo,
			preview.images,
			this.mobileSearchRenderGeneration,
			"mobile-search",
		);
	}

	private refreshMemoImagesInContainer(
		container: HTMLElement | null,
		memo: MemoRecord,
		images: MemoPreviewImage[],
		generation: number,
		surface: CardRenderSurface,
	): void {
		if (container === null) {
			return;
		}
		for (const card of container.findAll(".knomo-card")) {
			if (card.getAttr("data-memo-id") !== memo.id) {
				continue;
			}
			const body = card.find(".knomo-card-body");
			if (!body?.instanceOf(HTMLElement)) {
				continue;
			}
			for (const imagesEl of body.findAll(".knomo-card-images")) {
				this.cardImageLoadQueue.forget(imagesEl, true);
				imagesEl.remove();
			}
			this.renderMemoCardImages(body, memo, images, generation, surface);
		}
	}

	private handleCardImageClick(trigger: HTMLElement): void {
		const imagesElement = trigger.closest(".knomo-card-images");
		if (imagesElement === null || !imagesElement.instanceOf(HTMLElement)) {
			return;
		}
		const images = this.renderedPreviewImages.get(imagesElement);
		if (images === undefined || images.length === 0) {
			return;
		}
		const imageIndex = parseCardImageIndex(trigger.getAttr("data-image-index"));
		this.openImagePreviewModal(images, imageIndex);
	}

	private openImagePreviewModal(images: readonly MemoPreviewImage[], initialIndex: number): void {
		if (images.length === 0) {
			return;
		}
		this.clearImagePreviewLoads();
		new KnomoImagePreviewModal(this.app, {
			images,
			initialIndex,
			lockCardFlowScroll: () => this.lockCardFlowScrollForImagePreview(),
			unlockCardFlowScroll: () => this.unlockCardFlowScrollForImagePreview(),
			loadImage: (request) => {
				const url = request.image.url;
				if (url === undefined) {
					request.onError?.();
					return;
				}
				this.cardImageLoadQueue.observe({
					targetEl: request.targetEl,
					images: [{
						imageEl: request.imageEl,
						src: url,
						resourcePath: request.image.resourcePath,
						allowDisconnected: request.allowDisconnected,
						onLoad: request.onLoad,
						onError: request.onError,
					}],
					generation: this.imagePreviewRenderGeneration,
					surface: "image-preview",
					priority: request.priority,
					observe: false,
				});
			},
			clearImageLoads: () => this.clearImagePreviewLoads(),
		}).open();
	}

	private clearImagePreviewLoads(): void {
		this.imagePreviewRenderGeneration += 1;
		this.cardImageLoadQueue.clear("image-preview");
	}

	private lockCardFlowScrollForImagePreview(): void {
		this.setImagePreviewBackgroundLoadsPaused(true);
		this.imagePreviewScrollLock.lock(this.cardFlowEl, this.mobileSearchResultsEl);
	}

	private unlockCardFlowScrollForImagePreview(): void {
		this.imagePreviewScrollLock.unlock(
			this.cardFlowEl,
			this.mobileSearchResultsEl,
			(scrollTop) => this.restoreCardFlowScrollTop(scrollTop),
		);
		this.setImagePreviewBackgroundLoadsPaused(false);
	}

	private setImagePreviewBackgroundLoadsPaused(paused: boolean): void {
		this.setImageLoadSurfacePaused("card-flow", "image-preview", paused);
		this.setImageLoadSurfacePaused("mobile-search", "image-preview", paused);
	}

	private setImageLoadSurfacePaused(
		surface: PausableImageLoadSurface,
		reason: ImageLoadPauseReason,
		paused: boolean,
	): void {
		let reasons = this.imageLoadPauseReasons.get(surface);
		if (reasons === undefined) {
			reasons = new Set<ImageLoadPauseReason>();
			this.imageLoadPauseReasons.set(surface, reasons);
		}
		const wasPaused = reasons.size > 0;
		if (paused) {
			reasons.add(reason);
		} else {
			reasons.delete(reason);
		}
		const shouldPause = reasons.size > 0;
		this.cardImageLoadQueue.setSurfacePaused(surface, shouldPause);
		if (paused && !wasPaused && shouldPause) {
			this.cardImageLoadQueue.preemptActiveSurface(surface);
		}
	}

	private toggleSidebarTagGroup(tag: string, element: HTMLElement): void {
		const expanded = !this.expandedTagGroups.has(tag);
		if (expanded) {
			this.expandedTagGroups.add(tag);
		} else {
			this.expandedTagGroups.delete(tag);
		}
		const node = element.closest(".knomo-tag-node");
		if (node?.instanceOf(HTMLElement)) {
			syncSidebarTagGroupExpanded(node, element, expanded);
		}
	}

	private applySidebarTagFilter(tag: string, tagKey: string): void {
		const previousViewStateKey = this.getCardFlowViewStateKey();
		this.clearSearchDebounce();
		this.viewStateController.clearDesktopSearchState();
		if (this.activeTagKey === tagKey) {
			this.viewStateController.clearActiveTag();
		} else {
			this.activeTag = tag;
			this.activeTagKey = tagKey;
		}
		this.scopeFilter = "all";
		this.activeNav = "all";
		this.mobileDrawerOpen = false;
		this.scopeMenuOpen = false;
		this.activeMenuMemoId = null;
		this.renderUiState({
			cardFlowChangeIntent: this.getCardFlowChangeIntent(previousViewStateKey),
		});
	}

	private async runTrashActionById(action: TrashAction, memoId: string | null): Promise<void> {
		const memo = this.trashMemoController.getSnapshot().trashMemos?.find((item) => item.id === memoId) ?? null;
		if (memo !== null) {
			await this.trashMemoController.handleTrashAction(action, memo);
		}
	}

	private async runMemoActionById(action: MemoAction, memoId: string | null): Promise<void> {
		const memo = this.memos.find((item) => item.id === memoId);
		if (memo !== undefined) {
			await this.handleMemoAction(action, memo);
		}
	}

	private collapseSidebarFromUserAction(): void {
		if (this.isDrawerLayout()) {
			this.mobileDrawerOpen = false;
		} else {
			this.setSidebarCollapsed(true);
		}
	}

	private goToPreviousRecordStatsPeriod(): void {
		if (!this.recordStatsViewStateController.goToPrevious(this.recordStatsService.getEarliestYear())) {
			return;
		}
		this.renderCardFlow(null, "view-scope-change");
	}

	private goToNextRecordStatsPeriod(): void {
		if (!this.recordStatsViewStateController.goToNext()) {
			return;
		}
		this.renderCardFlow(null, "view-scope-change");
	}

	private async retryRecordStats(): Promise<void> {
		this.invalidateRecordStats();
		this.renderCardFlow();
		await this.prepareRecordStats();
	}

	private setRecordStatsViewFromAction(view: RecordStatsView): void {
		if (!this.recordStatsViewStateController.setView(view)) {
			return;
		}
		this.renderCardFlow(null, "view-scope-change");
	}

	private toggleCompactSearchFromUserAction(): void {
		this.compactSearchOpen = !this.compactSearchOpen;
		this.desktopSearchOpen = false;
		if (this.currentLayout !== "mobile") {
			this.activeMenuMemoId = null;
		}
	}

	private closeOpenChromeFromEscape(): void {
		this.closeCardMenu();
		this.scopeMenuOpen = false;
		this.desktopSearchOpen = false;
		this.compactSearchOpen = false;
		this.mobileDrawerOpen = false;
		this.composerOpen = false;
		this.mobileComposerController.resetInactiveState();
		this.syncUiChrome();
		this.syncCardMenuState();
	}

	private handleRootPointerDown(event: PointerEvent): void {
		this.userActionController.handleRootPointerDown(event);
	}

	private async handleRootClick(event: MouseEvent): Promise<void> {
		await this.userActionController.handleRootClick(event);
	}

	private toggleCardMenu(memoId: string | null): void {
		if (this.activeMenuMemoId === memoId) {
			this.closeCardMenu();
			return;
		}
		if (this.currentLayout !== "mobile") {
			this.desktopSearchOpen = false;
			this.compactSearchOpen = false;
		}
		this.scopeMenuOpen = false;
		this.activeMenuMemoId = memoId;
		this.syncRootState();
		this.syncCardMenuState();
	}

	private toggleScopeMenu(): void {
		this.scopeMenuOpen = !this.scopeMenuOpen;
		this.desktopSearchOpen = false;
		if (this.currentLayout !== "mobile") {
			this.compactSearchOpen = false;
		}
		this.closeCardMenu();
		this.syncRootState();
		this.syncCardMenuState();
	}

	private async handleAction(
		action: string | null,
		memoId: string | null,
		sourceEl: HTMLElement | null = null,
	): Promise<void> {
		await this.userActionController.handleAction(action, memoId, sourceEl);
	}

	private openRecordStatsTrendFilter(sourceEl: HTMLElement | null): void {
		const key = sourceEl?.getAttr("data-record-stats-key") ?? null;
		const unit = sourceEl?.getAttr("data-record-stats-unit") ?? null;
		const recordStatsState = this.recordStatsViewStateController.getSnapshot();
		const selected = this.recordStatsService.select(recordStatsState.view, recordStatsState.selectedDate);
		const filter = getRecordStatsTrendSearchFilter(selected, key, unit);
		if (filter !== null) {
			this.openRecordStatsSearchFilter(filter);
		}
	}

	private openRecordStatsHourFilter(sourceEl: HTMLElement | null): void {
		const hourText = sourceEl?.getAttr("data-record-stats-hour") ?? "";
		const recordStatsState = this.recordStatsViewStateController.getSnapshot();
		const selected = this.recordStatsService.select(recordStatsState.view, recordStatsState.selectedDate);
		const filter = getRecordStatsHourSearchFilter(selected, hourText);
		if (filter !== null) {
			this.openRecordStatsSearchFilter(filter);
		}
	}

	private openRecordStatsMetricFilter(type: RecordStatsMetricFilterType): void {
		const recordStatsState = this.recordStatsViewStateController.getSnapshot();
		const selected = this.recordStatsService.select(recordStatsState.view, recordStatsState.selectedDate);
		const filter = getRecordStatsMetricSearchFilter(selected, type);
		if (filter !== null) {
			this.openRecordStatsSearchFilter(filter);
		}
	}

	private openRecordStatsTagFilter(sourceEl: HTMLElement | null): void {
		const tagKey = sourceEl?.getAttr("data-record-stats-tag-key") ?? null;
		const recordStatsState = this.recordStatsViewStateController.getSnapshot();
		const selected = this.recordStatsService.select(recordStatsState.view, recordStatsState.selectedDate);
		const filter = getRecordStatsTagSearchFilter(selected, tagKey);
		if (filter !== null) {
			this.openRecordStatsSearchFilter(filter);
		}
	}

	private openRecordStatsSearchFilter(filter: RecordStatsSearchFilter): void {
		if (this.currentLayout === "mobile") {
			this.resetMobileSearchState();
			this.mobileRecordStatsSearchFilter = filter;
			this.openMobileSearchPage({
				focusInput: false,
				changeIntent: "view-scope-change",
			});
			return;
		}

		const previousViewStateKey = this.getCardFlowViewStateKey();
		this.clearSearchDebounce();
		this.viewStateController.clearDesktopSearchState();
		this.recordStatsSearchFilter = filter;
		this.viewStateController.clearActiveTag();
		this.activeNav = "all";
		this.scopeFilter = "all";
		this.mobileDrawerOpen = false;
		this.scopeMenuOpen = false;
		this.desktopSearchOpen = false;
		this.compactSearchOpen = false;
		this.activeMenuMemoId = null;
		this.randomReunionController.clearMemos();
		this.renderFilteredListState(true, this.getCardFlowChangeIntent(previousViewStateKey));
	}

	private async handleRootKeydown(event: KeyboardEvent): Promise<void> {
		await this.userActionController.handleRootKeydown(event);
	}

	private async handleMemoAction(action: MemoAction, memo: MemoRecord): Promise<void> {
		this.closeCardMenu();
		const shouldCloseMobileSearch = this.currentLayout === "mobile" && this.mobileSearchPageOpen;
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
			} else if (action === "open-daily") {
				const file = this.app.vault.getAbstractFileByPath(memo.dailyRef.path);
				if (shouldCloseMobileSearch) {
					this.closeMobileSearchPage();
				}
				this.syncCardMenuState();
				if (!(file instanceof TFile)) {
					new Notice(t("error.dailyNoteMissing"));
					return;
				}
				try {
					await openMemoDailyNoteInNewTab(this.app.workspace, file, memo.dailyRef.lineNumberHint);
				} catch {
					new Notice(t("error.openDailyFailed"));
				}
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
					this.syncCardMenuState();
					return;
				}
				const deletedMemo = await this.syncOrchestrator.deleteMemo(memo);
				new Notice(t("notice.deleted"));
				const mutation: MemoMutation = { type: "delete", previousMemo: memo, memo: deletedMemo };
				this.applyMemoMutation(mutation);
				this.onMemoMutation(mutation, this);
				return;
			}
			this.syncUiChrome();
			this.syncCardMenuState();
		} catch (error) {
			const message = formatServiceError(error, t("error.operationFailed"));
			new Notice(message);
			this.syncUiChrome();
			this.syncCardMenuState();
		}
	}

	private async saveInput(): Promise<void> {
		if (this.inputEl === null || this.isSaving) {
			return;
		}

		const input = this.inputEl.value;
		const preparedInput = prepareComposerSaveInput(input, this.editingMemo, {
			sourceMemoId: this.quoteSourceMemoId,
			referenceText: this.quoteReferenceText,
			markdownText: this.quoteMarkdownText,
		});
		if (preparedInput.type === "empty") {
			this.updateStatus(t("composer.emptyContent"), true);
			this.updateSendButtonState();
			return;
		}
		const isMobileSave = this.currentLayout === "mobile";
		const mobileScrollTop = isMobileSave ? this.mobileComposerController.getOpenScrollTop() ?? this.getCardFlowScrollTop() : null;

		this.isSaving = true;
		this.updateStatus("", false);
		this.updateSendButtonState();
		try {
			let mutation: MemoMutation;
			if (preparedInput.type === "update") {
				const previousMemo = preparedInput.previousMemo;
				const memo = await this.syncOrchestrator.updateMemo(previousMemo, preparedInput.content);
				mutation = { type: "update", previousMemo, memo };
			} else {
				const { memo } = await this.syncOrchestrator.createMemo(preparedInput.content, {
					source: preparedInput.source,
					sourceMemoId: preparedInput.sourceMemoId,
					sourceReferenceText: preparedInput.sourceReferenceText,
					dailyTrailer: preparedInput.dailyTrailer,
				});
				mutation = { type: "create", memo };
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
				this.syncComposerMode();
				this.updateCancelEditButtonState();
				if (this.inputEl !== null) {
					this.resizeInput();
				}
			}
			this.updateStatus("", false);
			this.applyMemoMutation(mutation);
			this.onMemoMutation(mutation, this);
			if (isMobileSave) {
				this.restoreCardFlowScrollTop(mobileScrollTop);
				this.mobileComposerController.clearOpenScrollTop();
			}
		} catch (error) {
			const message = formatServiceError(error, t("error.saveFailed"));
			this.updateStatus(message, true);
			new Notice(message);
		} finally {
			this.isSaving = false;
			this.updateSendButtonState();
			this.syncRootState();
		}
	}

	private async handleManualRefresh(): Promise<void> {
		if (this.isManualRefreshing) {
			return;
		}
		this.isManualRefreshing = true;
		this.syncManualRefreshButtonState();
		try {
			if (this.activeNav === "trash") {
				await this.trashMemoController.loadTrashMemos();
				if (this.trashMemoController.getSnapshot().trashError === null) {
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
				const message = formatServiceError(error, t("error.refreshFailed"));
				new Notice(message);
			}
		} finally {
			this.isManualRefreshing = false;
			this.syncManualRefreshButtonState();
		}
	}

	private setScope(scope: ScopeFilter): void {
		this.clearSearchDebounce();
		const previousViewStateKey = this.getCardFlowViewStateKey();
		const result = this.viewStateController.setScope(scope);
		this.applyViewStateTransitionEffects(result);
		if (result.type === "already-active") {
			this.syncRootState();
			this.renderScopeState();
			this.syncSearchInputs();
			return;
		}
		this.renderFilteredListState(true, this.getCardFlowChangeIntent(previousViewStateKey));
	}

	private setSearchQuery(query: string): void {
		const previousViewStateKey = this.getCardFlowViewStateKey();
		this.clearSearchDebounce();
		this.applyViewStateTransitionEffects(this.viewStateController.setSearchQuery(query));
		this.renderFilteredListState(false, this.getCardFlowChangeIntent(previousViewStateKey));
	}

	private setSearchDateFilter(filter: SearchDateFilter, sourceEl: HTMLElement | null = null): void {
		const previousViewStateKey = this.getCardFlowViewStateKey();
		this.flushDesktopSearchQuery(sourceEl);
		this.applyViewStateTransitionEffects(this.viewStateController.setSearchDateFilter(filter));
		if (this.currentLayout !== "mobile") {
			this.syncRootState();
		}
		this.renderFilteredListState(false, this.getCardFlowChangeIntent(previousViewStateKey));
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
		this.searchQueryDebounce.queue(query, (nextQuery) => this.setSearchQuery(nextQuery));
	}

	private clearSearchDebounce(): void {
		this.searchQueryDebounce.clear();
	}

	private applyViewStateTransitionEffects(effects: KnomoViewStateTransitionEffects): void {
		if (effects.closeScopeMenu === true) {
			this.scopeMenuOpen = false;
		}
		if (effects.clearCardMenu === true) {
			this.activeMenuMemoId = null;
		}
	}

	private setSidebarNav(nav: SidebarNav): void {
		this.clearSearchDebounce();
		const previousViewStateKey = this.getCardFlowViewStateKey();
		const result = this.viewStateController.setSidebarNav(nav);
		this.applyViewStateTransitionEffects(result);
		if (result.type === "already-default") {
			this.syncRootState();
			this.renderScopeState();
			this.syncCardMenuState();
			return;
		}
		if (result.clearRandomReunion) {
			this.randomReunionController.clearMemos();
		}
		if (result.clearShuffleDay) {
			this.shuffleDayController.clearSelection();
		}
		this.renderUiState({
			cardFlowChangeIntent: this.getCardFlowChangeIntent(previousViewStateKey),
		});
		if (result.ensureAllMemosLoaded) {
			void this.ensureAllMemosLoaded();
		}
		if (result.refreshRandomReunion) {
			void this.randomReunionController.refresh();
		}
		if (result.refreshShuffleDay) {
			void this.shuffleDayController.refresh();
		}
		if (result.loadTrashMemos) {
			void this.trashMemoController.loadTrashMemos();
		}
		if (result.prepareRecordStats) {
			void this.prepareRecordStats();
		}
	}

	private returnFromRecordStats(): void {
		if (this.activeNav !== "record-stats") {
			return;
		}
		const previousViewStateKey = this.getCardFlowViewStateKey();
		this.clearSearchDebounce();
		const result = this.viewStateController.returnFromRecordStats();
		if (result.type === "inactive") {
			return;
		}
		this.applyViewStateTransitionEffects(result);
		this.renderUiState({
			cardFlowChangeIntent: this.getCardFlowChangeIntent(previousViewStateKey),
		});
		if (result.ensureAllMemosLoaded) {
			void this.ensureAllMemosLoaded();
		}
		if (result.refreshRandomReunionIfEmpty && this.randomReunionController.getSnapshot().memos === null) {
			void this.randomReunionController.refresh();
		}
		if (result.refreshShuffleDayIfEmpty && this.shuffleDayController.getSnapshot().selectedDate === null) {
			void this.shuffleDayController.refresh();
		}
		if (result.loadTrashMemos) {
			void this.trashMemoController.loadTrashMemos();
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
		const previousViewStateKey = this.getCardFlowViewStateKey();
		const result = this.viewStateController.resetToAllNotes();
		this.applyViewStateTransitionEffects(result);
		if (result.type === "already-default") {
			this.syncRootState();
			this.renderScopeState();
			this.syncSearchInputs();
			this.syncCardMenuState();
			return;
		}
		this.renderUiState({
			cardFlowChangeIntent: this.getCardFlowChangeIntent(previousViewStateKey),
		});
	}

	private renderFilteredListState(
		fullUi: boolean,
		changeIntent: CardFlowChangeIntent = "content-change",
	): void {
		const shouldDeferCardFlow = this.shouldDeferCardFlowForAllMemos();
		if (changeIntent === "view-scope-change") {
			this.restoreCardFlowScrollTop(0);
		}
		if (shouldDeferCardFlow) {
			this.cardFlowCoordinator.removeSentinel();
			this.syncCardMenuState();
		}
		if (fullUi) {
			this.renderUiState({
				renderCardFlow: !shouldDeferCardFlow,
				renderMobileSearchResults: !shouldDeferCardFlow,
				cardFlowChangeIntent: changeIntent,
			});
		} else if (shouldDeferCardFlow) {
			this.syncRootState();
			this.renderScopeState();
			this.syncSearchInputs();
		} else {
			this.renderCardFlow(null, changeIntent);
			this.renderScopeState();
			this.syncSearchInputs();
		}
		if (shouldDeferCardFlow) {
			this.renderAllMemosLoadingState();
			void this.ensureAllMemosLoaded();
		}
	}

	private renderAllMemosLoadingState(): void {
		const cardFlow = this.cardFlowEl;
		if (cardFlow === null) {
			return;
		}
		this.cardFlowDeferredForAllMemos = true;
		this.renderGeneration += 1;
		this.memoMarkdownRenderer.clear();
		this.cardImageLoadQueue.clear("card-flow");
		this.cardFlowCoordinator.resetFlowRuntime(this.containerEl.win);
		this.renderedCardMemos.clear();
		cardFlow.empty();
		const loadingState = renderKnomoEmptyState(cardFlow, t("empty.loadingAllMemos"));
		loadingState.setAttrs({
			role: "status",
			"aria-live": "polite",
			"aria-atomic": "true",
		});
	}

	private renderAllMemosLoadErrorState(): void {
		const cardFlow = this.cardFlowEl;
		this.cardFlowDeferredForAllMemos = false;
		if (cardFlow === null) {
			return;
		}
		cardFlow.empty();
		const errorState = renderKnomoEmptyState(
			cardFlow,
			t("empty.allMemosLoadFailed"),
			t("empty.allMemosLoadFailedDesc"),
		);
		errorState.setAttr("role", "alert");
		errorState.createEl("button", {
			cls: "knomo-inline-button knomo-all-memos-retry",
			text: t("empty.allMemosRetry"),
			attr: { type: "button", "data-action": "retry-all-memos" },
		});
	}

	private shouldDeferCardFlowForAllMemos(): boolean {
		return !this.mobileMemoHydrator.getSnapshot().allMemosLoaded
			&& needsAllMemos(
				this.scopeFilter,
				this.searchQuery,
				this.searchDateFilter,
				this.recordStatsSearchFilter,
			);
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
		this.restoreElementScrollTop(this.cardFlowEl, scrollTop);
	}

	private restoreElementScrollTop(element: HTMLElement | null, scrollTop: number | null): void {
		if (scrollTop === null || element === null) {
			return;
		}
		element.scrollTop = scrollTop;
		this.containerEl.win.requestAnimationFrame(() => {
			if (element.isConnected) {
				element.scrollTop = scrollTop;
			}
		});
	}

	private restorePendingCardFlowScrollTop(generation: number): void {
		this.cardFlowCoordinator.restorePendingScrollTop(generation, (scrollTop) => {
			this.restoreCardFlowScrollTop(scrollTop);
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
		this.pauseMobileBackgroundWork();
		this.mobileComposerController.open();
	}

	private pauseMobileBackgroundWork(): void {
		if (!Platform.isMobile) {
			return;
		}
		this.mobileMemoHydrator.clearScheduled();
		this.pauseMobileCardBatchContinuation();
		this.memoMarkdownRenderer.setPaused(true);
		this.cardImageLoadQueue.setPaused(true);
	}

	private resumeMobileBackgroundWork(): void {
		if (!Platform.isMobile) {
			return;
		}
		const renderRequest = this.cardFlowCoordinator.consumeMobileRenderRequest();
		if (renderRequest !== null) {
			if (renderRequest.forceRebuild) {
				this.forceRebuildCardFlow(renderRequest.changeIntent);
			} else {
				this.renderCardFlow(renderRequest.preserveCardMemoId, renderRequest.changeIntent);
			}
		}
		this.resumeMobileCardBatchContinuation();
		this.memoMarkdownRenderer.setPaused(false);
		this.cardImageLoadQueue.setPaused(false);
		this.mobileMemoHydrator.schedule();
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
			this.draftContent = getDraftForComposerClose(
				this.inputEl.value,
				getComposerMode(this.editingMemo, this.quoteSourceMemoId),
				this.quoteMarkdownText,
			);
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
			this.draftContent = getDraftForComposerClose(
				this.inputEl.value,
				getComposerMode(this.editingMemo, this.quoteSourceMemoId),
				this.quoteMarkdownText,
			);
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
		this.composerSaveShortcutController.reset();
		this.wikiLinkSuggest?.close();
		if (this.mobileImagePickerFocusGuard.shouldIgnoreBlur(this.currentLayout === "mobile")) {
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
		if (this.currentLayout === "mobile") {
			this.closeMobileComposerKeepingDraft();
		}
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
		this.syncUiChrome();
	}

	private clearComposerContext(): void {
		this.editingMemo = null;
		this.quoteSourceMemoId = null;
		this.quoteReferenceText = null;
		this.quoteMarkdownText = null;
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
		this.quoteMarkdownText = formatMarkdownQuoteDraft(memo.contentSnapshot);
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
			!this.composerListEnterState.shouldSkipInputFallback() &&
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
		this.composerSaveShortcutController.handleKeyup(event);
	}

	private handleComposerSaveShortcut(event: KeyboardEvent): boolean {
		return this.composerSaveShortcutController.handleKeydown(event, {
			inputEl: this.inputEl,
			activeElement: this.containerEl.doc.activeElement,
			isSaving: this.isSaving,
			saveInput: () => {
				void this.saveInput();
			},
		});
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
		if (this.mobileHandledToolPointer.isHandled(toolButton, action)) {
			return;
		}
		if (this.runComposerToolAction(action)) {
			this.mobileHandledToolPointer.mark(toolButton, action);
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
		if (this.mobileHandledToolPointer.isHandled(actionEl, action)) {
			return;
		}
		if (action === "clear-reference") {
			this.clearReference();
		} else {
			this.cancelEditing();
		}
		this.mobileHandledToolPointer.mark(actionEl, action);
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
			this.nativeImagePickerController.open();
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

	private shouldIgnoreHandledMobileToolClick(actionEl: HTMLElement, action: string | null): boolean {
		return this.mobileHandledToolPointer.shouldIgnoreClick(actionEl, action, this.currentLayout === "mobile");
	}

	private clearHandledMobileToolPointer(): void {
		this.mobileHandledToolPointer.clear();
	}

	private beginMobileImagePickerFocusGuard(): boolean {
		return this.mobileImagePickerFocusGuard.begin(
			this.currentLayout === "mobile" &&
			this.inputEl !== null &&
			this.inputEl.isConnected &&
			this.containerEl.doc.activeElement === this.inputEl,
		);
	}

	private finishMobileImagePickerFocusGuard(shouldRestoreFocus: boolean): void {
		this.mobileImagePickerFocusGuard.finish(
			shouldRestoreFocus,
			() => this.canRestoreMobileImagePickerFocus(),
			() => this.focusComposerInputNow(true, true),
		);
	}

	private clearMobileImagePickerFocusGuard(): void {
		this.mobileImagePickerFocusGuard.clear();
	}

	private canRestoreMobileImagePickerFocus(): boolean {
		if (this.currentLayout !== "mobile" || !this.composerOpen) {
			return false;
		}
		const input = this.inputEl;
		return input !== null && input.isConnected && !input.disabled;
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
		this.mobileSendPointerGuard.markPointer();
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
		const pendingCorrection = this.composerListEnterState.consumePendingCorrection(this.inputEl?.value ?? null);
		if (pendingCorrection !== null) {
			this.applyTextareaPatch(pendingCorrection);
			return;
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
			this.composerListEnterState.setPendingCorrection(this.getPendingMobileListEnterCorrection(patch));
			return false;
		}
		event.preventDefault();
		event.stopPropagation();
		this.composerListEnterState.setPendingCorrection(null);
		this.applyTextareaPatch(patch);
		return true;
	}

	private handleListEnterInputFallback(event: Event): boolean {
		if (this.composerListEnterState.shouldSkipInputFallback() || this.inputEl === null) {
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
			allowInsertedMarkerCorrection: this.currentLayout === "mobile",
		});
		if (patch === null) {
			return false;
		}
		this.applyTextareaPatch(patch);
		return true;
	}

	private handleListEnterKeydownDuplicateBeforeInput(event: InputEvent): boolean {
		const patch = this.composerListEnterState.getKeydownPatch();
		if (patch === null || this.inputEl === null) {
			return false;
		}
		const input = this.inputEl;
		if (input.value !== patch.value || input.selectionStart !== patch.cursor || input.selectionEnd !== patch.cursor) {
			return false;
		}
		this.clearListEnterKeydownPatch();
		if (!event.cancelable) {
			this.composerListEnterState.setPendingCorrection(this.getPendingMobileListEnterCorrection(patch));
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
		this.composerListEnterState.markKeydownPatch(patch);
	}

	private clearListEnterKeydownPatch(): void {
		this.composerListEnterState.clearKeydownPatch();
	}

	private markSkipListEnterInputFallback(): void {
		this.composerListEnterState.markSkipInputFallback();
	}

	private clearSkipListEnterInputFallback(): void {
		this.composerListEnterState.clearSkipInputFallback();
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

	private getPendingMobileListEnterCorrection(patch: TextReplacement): PendingListEnterCorrection | null {
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
		if (this.activeNav === "trash" || this.activeNav === "record-stats") {
			return [];
		}
		if (this.activeNav === "random") {
			return this.randomReunionController.getSnapshot().memos ?? [];
		}
		if (this.activeNav === "shuffleDay") {
			return this.shuffleDayController.getSnapshot().memos;
		}
		const normalizedQuery = this.searchQuery.trim().toLowerCase();
		const searchDateFilter = this.searchDateFilter;
		const recordStatsFilter = this.recordStatsSearchFilter;
		const recordStatsFilterKey = getRecordStatsSearchFilterKey(recordStatsFilter);
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
				cache.recordStatsFilterKey === recordStatsFilterKey &&
			cache.todayKey === todayKey
		) {
			return cache.result;
		}

		const filteredMemos = filterVisibleMemos({
			memos: this.memos,
			randomMemos: this.randomReunionController.getSnapshot().memos ?? [],
			shuffleDayMemos: this.shuffleDayController.getSnapshot().memos,
			activeNav: this.activeNav,
			activeTagKey,
			scopeFilter: this.scopeFilter,
			normalizedQuery,
			searchDateFilter,
			recordStatsFilter,
			dailyStatus: this.syncOrchestrator.getDailyNotesStatus(),
			getMemoSearchText: (memo) => this.getMemoSearchText(memo),
			today,
		});
		this.filteredMemosCache = {
			memos: this.memos,
			activeTagKey,
			activeNav: this.activeNav,
			scopeFilter: this.scopeFilter,
			searchQuery: normalizedQuery,
			searchDateFilter,
			recordStatsFilterKey,
			todayKey,
			result: filteredMemos,
		};
		return filteredMemos;
	}

	private closeCardMenu(): void {
		const memoId = this.popupState.closeCardMenu();
		if (memoId !== null) {
			this.syncCardMenuState();
			this.blurCardMenuButton(memoId);
		}
	}

	private handleOpenPopupOutsideEvent(event: Event, target: EventTarget | null, suppressFollowingClick: boolean): boolean {
		const result = this.popupState.handleOpenPopupOutsideEvent(event, target, suppressFollowingClick);
		if (!result.handled) {
			return false;
		}
		if (result.closedMemoId !== null) {
			this.syncCardMenuState();
			this.blurCardMenuButton(result.closedMemoId);
		}
		if (result.closedScopeMenu) {
			this.syncRootState();
		}
		return true;
	}

	private consumeSuppressedOpenPopupDismissClick(event: Event): boolean {
		return this.popupState.consumeSuppressedOpenPopupDismissClick(event);
	}

	private clearSuppressNextOpenPopupDismissClick(): void {
		this.popupState.clearSuppressNextOpenPopupDismissClick();
	}

	private blurCardMenuButton(memoId: string): void {
		for (const container of [this.cardFlowEl, this.mobileSearchResultsEl]) {
			if (container === null) {
				continue;
			}
			for (const card of container.findAll(".knomo-card")) {
				if (card.getAttr("data-memo-id") !== memoId) {
					continue;
				}
				card.find(".knomo-card-menu")?.blur();
			}
		}
	}

	private syncCardMenuState(): void {
		for (const container of [this.cardFlowEl, this.mobileSearchResultsEl]) {
			if (container === null) {
				continue;
			}
			for (const card of container.findAll(".knomo-card")) {
				const isOpen = this.activeMenuMemoId !== null && card.getAttr("data-memo-id") === this.activeMenuMemoId;
				if (isOpen) {
					this.positionOpenCardMenu(card);
				}
				card.toggleClass("is-menu-open", isOpen);
				card.find(".knomo-card-menu")?.setAttr("aria-expanded", isOpen ? "true" : "false");
			}
		}
	}

	private positionOpenCardMenu(card: HTMLElement): void {
		const actions = card.find(".knomo-card-actions");
		const head = card.find(".knomo-card-head");
		if (!actions?.instanceOf(HTMLElement) || !head?.instanceOf(HTMLElement)) {
			return;
		}
		const mobileSearchResults = card.closest(".knomo-mobile-search-results");
		const flowEl = mobileSearchResults?.instanceOf(HTMLElement) ? mobileSearchResults : this.cardFlowEl;
		if (flowEl === null) {
			return;
		}
		const flowRect = flowEl.getBoundingClientRect();
		const headRect = head.getBoundingClientRect();
		const menuHeight = actions.offsetHeight;
		const spaceBelow = flowRect.bottom - 8 - headRect.bottom - 6;
		const spaceAbove = headRect.top - flowRect.top - 8 - 6;
		card.toggleClass("is-menu-above", menuHeight > spaceBelow && spaceAbove > spaceBelow);
	}

	private toggleSidebar(): void {
		if (this.isDrawerLayout()) {
			this.mobileDrawerOpen = !this.mobileDrawerOpen;
			if (this.mobileDrawerOpen && this.composerOpen) {
				this.closeComposerKeepingDraft();
			}
			this.desktopSidebarStateController.expandWithoutPersisting();
			this.syncRootState();
			if (this.mobileDrawerOpen) {
				this.mobileMemoHydrator.deferSidebarHydration();
			}
			return;
		}
		this.toggleSidebarCollapsed();
	}

	private toggleSidebarCollapsed(): void {
		this.desktopSidebarStateController.toggleCollapsed();
		this.syncRootState();
		void this.persistSidebarPreferences();
	}

	private setSidebarCollapsed(collapsed: boolean): void {
		this.desktopSidebarStateController.setCollapsed(collapsed);
		this.syncRootState();
		void this.persistSidebarPreferences();
	}

	private startSidebarResize(event: PointerEvent): void {
		if (this.sidebarResizerEl === null || !this.desktopSidebarStateController.startResize(event.pointerId, event.clientX)) {
			return;
		}
		this.sidebarResizerEl.setPointerCapture(event.pointerId);
		this.rootEl?.toggleClass("is-resizing-sidebar", true);
		event.preventDefault();
	}

	private resizeSidebar(event: PointerEvent): void {
		if (!this.desktopSidebarStateController.resize(event.pointerId, event.clientX)) {
			return;
		}
		this.syncRootState();
	}

	private stopSidebarResize(event: PointerEvent): void {
		if (!this.desktopSidebarStateController.stopResize(event.pointerId)) {
			return;
		}
		if (this.sidebarResizerEl?.hasPointerCapture(event.pointerId)) {
			this.sidebarResizerEl.releasePointerCapture(event.pointerId);
		}
		this.rootEl?.toggleClass("is-resizing-sidebar", false);
		void this.persistSidebarPreferences();
	}

	private setSidebarWidth(width: number, persist: boolean): void {
		this.desktopSidebarStateController.setWidth(width);
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
		const sidebarState = this.desktopSidebarStateController.getSnapshot();
		await this.settingsService.updateSettings({
			desktopSidebarWidth: sidebarState.width,
			desktopSidebarCollapsed: sidebarState.collapsed,
		});
	}

	private async ensureAllMemosLoaded(forceReload = false): Promise<boolean> {
		const { allMemosLoaded } = this.mobileMemoHydrator.getSnapshot();
		if (allMemosLoaded && !forceReload) {
			return true;
		}
		if (this.allMemosLoadingPromise !== null) {
			if (Platform.isMobile && !forceReload) {
				this.mobileMemoHydrator.accelerate();
			}
			return this.allMemosLoadingPromise;
		}
		if (Platform.isMobile && !forceReload) {
			this.allMemosLoadingPromise = this.mobileMemoHydrator.start(true).finally(() => {
				this.allMemosLoadingPromise = null;
			});
			return this.allMemosLoadingPromise;
		}
		if (forceReload) {
			this.mobileMemoHydrator.cancel();
		}
		this.allMemosLoadingPromise = this.reloadMemos(true).finally(() => {
			this.allMemosLoadingPromise = null;
		});
		return this.allMemosLoadingPromise;
	}

	private invalidateRecordStats(): void {
		this.recordStatsPreparationController.invalidate();
		this.recordStatsService.invalidate();
	}

	private scheduleRecordStatsPreparation(): void {
		this.recordStatsPreparationController.schedulePreparation({
			isPreparedForSource: (source) => this.recordStatsService.isPreparedForSource(source),
			prepare: () => {
				void this.prepareRecordStats();
			},
		});
	}

	private clearRecordStatsPreparation(): void {
		this.recordStatsPreparationController.clearScheduledPreparation();
	}

	private prepareRecordStats(): Promise<boolean> {
		return this.recordStatsPreparationController.prepare({
			isPreparedForSource: (source) => this.recordStatsService.isPreparedForSource(source),
			runPreparation: (source) => this.runRecordStatsPreparation(source),
			onPreparedForCurrentSource: () => {
				if (this.activeNav === "record-stats") {
					this.renderCardFlow();
				}
			},
		});
	}

	private async runRecordStatsPreparation(source: string): Promise<boolean> {
		const yieldToUi = () => {
			return new Promise<void>((resolve) => {
				this.containerEl.win.setTimeout(resolve, 0);
			});
		};
		const preparation = this.recordStatsService.prepareFromSource(source, (isCurrent) => {
			return this.syncOrchestrator.buildRecordStats(yieldToUi, isCurrent);
		});
		if (this.activeNav === "record-stats") {
			this.renderCardFlow();
		}
		const prepared = await preparation;
		if (this.activeNav === "record-stats") {
			this.renderCardFlow();
		}
		return prepared;
	}

	private beginScheduledMobileMemoHydration(): void {
		if (this.allMemosLoadingPromise !== null) {
			return;
		}
		this.allMemosLoadingPromise = this.mobileMemoHydrator.start(false).finally(() => {
			this.allMemosLoadingPromise = null;
		});
	}

	private captureMobileMemoHydrationRenderState(): MobileMemoHydrationRenderState {
		const renderedCardCount = this.getRenderedCardCount();
		return {
			renderedCardCount,
			previousCardFlowKey: this.getVisibleCardFlowStateKey(renderedCardCount),
			previousMobileSearchKey: this.getMobileSearchStateKey(),
		};
	}

	private handleMobileMemoPeriodHydrated(state: MobileMemoHydrationRenderState): void {
		this.renderStats();
		if (this.shouldDeferCardFlowForAllMemos()) {
			return;
		}
		if (state.previousCardFlowKey !== this.getVisibleCardFlowStateKey(state.renderedCardCount)) {
			this.renderCardFlow();
		} else {
			this.syncCardFlowAfterMemoHydration();
		}
		this.renderMobileSearchResultsIfChanged(state.previousMobileSearchKey);
	}

	private handleMobileMemoHydrationCompleted(state: MobileMemoHydrationRenderState): void {
		const shouldRenderDeferredCardFlow = this.cardFlowDeferredForAllMemos;
		this.cardFlowDeferredForAllMemos = false;
		if (this.activeNav === "record-stats" && !this.recordStatsPreparationController.hasActiveRequest()) {
			void this.prepareRecordStats();
		} else {
			this.scheduleRecordStatsPreparation();
		}
		if (this.shouldRenderFullUiAfterMobileHydration()) {
			this.renderUiState({
				renderCardFlow: false,
				renderMobileSearchResults: false,
			});
			if (
				this.cardFlowEl !== null
				&& (
					shouldRenderDeferredCardFlow
					|| this.cardFlowEl.childElementCount === 0
					|| state.previousCardFlowKey !== this.getVisibleCardFlowStateKey(state.renderedCardCount)
				)
			) {
				this.renderCardFlow();
			} else {
				this.syncCardFlowAfterMemoHydration();
			}
			this.renderMobileSearchResultsIfChanged(state.previousMobileSearchKey);
			return;
		}
		this.renderStats();
		this.renderTags();
		this.syncCardFlowAfterMemoHydration();
	}

	private shouldRenderFullUiAfterMobileHydration(): boolean {
		return this.activeNav !== "all" ||
			this.mobileSearchPageOpen ||
			needsAllMemos(
				this.scopeFilter,
				this.searchQuery,
				this.searchDateFilter,
				this.recordStatsSearchFilter,
			);
	}

	private syncCardFlowAfterMemoHydration(): void {
		if (
			this.cardFlowEl === null ||
			this.cardFlowError !== null ||
			this.activeNav === "trash" ||
			this.activeNav === "random" ||
			this.activeNav === "shuffleDay" ||
			this.activeNav === "record-stats"
		) {
			return;
		}
		const memos = this.getFilteredMemos();
		this.cardFlowCoordinator.updateBatchItems(memos);
		if (
			this.mobileMemoHydrator.getSnapshot().renderNextBatchAfterHydration
			&& this.cardFlowCoordinator.remainingCount > 0
		) {
			this.mobileMemoHydrator.consumeRenderNextBatchRequest();
			this.renderNextCardBatch(this.renderGeneration);
			return;
		}
		this.renderCardFlowSentinelIfNeeded();
	}

	private renderCardFlowSentinelIfNeeded(): void {
		this.cardFlowCoordinator.renderSentinelIfNeeded({
			root: this.cardFlowEl,
			Observer: (this.containerEl.win as WindowWithIntersectionObserver).IntersectionObserver,
			onIntersect: (value) => this.renderNextCardBatch(value),
		});
	}

	private async waitForAllMemosLoading(): Promise<void> {
		if (this.allMemosLoadingPromise !== null) {
			await this.allMemosLoadingPromise;
		}
	}

	private resetVisibleMemos(): void {
		this.cardFlowCoordinator.clearMobileBatchContinuation(this.containerEl.win);
		this.cardFlowCoordinator.resetBatcher();
	}

	private invalidateMemoSearchCache(): void {
		this.memoSearchCache.invalidate();
	}

	private getMemoSearchText(memo: MemoRecord): string {
		return this.memoSearchCache.get(memo);
	}

	private getCardFlowStateKey(): string {
		const recordStatsState = this.recordStatsViewStateController.getSnapshot();
		return getCardFlowStateKeyValue({
			activeNav: this.activeNav,
			recordStatsSnapshot: this.recordStatsService.getSnapshot(),
			recordStatsView: recordStatsState.view,
			recordStatsSelectedDate: recordStatsState.selectedDate,
			today: new Date(),
			presentation: this.getCurrentCardFlowPresentation(),
		});
	}

	private getVisibleCardFlowStateKey(renderedCardCount: number): string {
		const recordStatsState = this.recordStatsViewStateController.getSnapshot();
		return getVisibleCardFlowStateKeyValue({
			activeNav: this.activeNav,
			recordStatsSnapshot: this.recordStatsService.getSnapshot(),
			recordStatsView: recordStatsState.view,
			recordStatsSelectedDate: recordStatsState.selectedDate,
			today: new Date(),
			presentation: this.getCurrentCardFlowPresentation(),
			renderedCardCount,
			initialBatchSize: this.getInitialCardBatchSize(),
		});
	}

	private renderCardFlowIfChanged(previousKey: string): void {
		if (
			this.cardFlowEl !== null
			&& (
				this.cardFlowEl.childElementCount === 0
				|| previousKey !== this.getCardFlowStateKey()
			)
		) {
			this.renderCardFlow();
		}
	}

	private getMobileSearchStateKey(): string {
		return this.mobileSearchController.getStateKey();
	}

	private getMobileSearchIdsKey(): string {
		return this.mobileSearchController.getIdsKey();
	}

	private renderMobileSearchResultsIfChanged(previousKey: string): void {
		if (previousKey !== this.getMobileSearchStateKey()) {
			this.renderMobileSearchResults();
		}
	}

	private handleCardFlowScroll(): void {
		this.cardFlowCoordinator.handleScroll({
			cardFlow: this.cardFlowEl,
			isRecordStatsActive: this.activeNav === "record-stats",
			onRenderNextBatch: (generation) => this.renderNextCardBatch(generation),
			requestHydration: () => this.mobileMemoHydrator.requestCardFlowHydration(),
		});
	}

	private handleTrashRenderRequest(target: TrashMemoRenderTarget): void {
		if (target === "ui-state") {
			this.renderUiState();
			return;
		}
		if (target === "trash-count") {
			this.renderTrashCount();
			return;
		}
		if (target === "trash-count-and-scope") {
			this.renderTrashCount();
			this.renderScopeState();
			return;
		}
		this.renderCardFlow();
	}

	private async openMemoCardDailyNote(memoId: string, markRandomReunionReviewed: boolean): Promise<void> {
		const memo = this.findMemoById(memoId);
		if (memo === null) {
			return;
		}
		this.activeMenuMemoId = null;
		if (this.currentLayout === "mobile" && this.mobileSearchPageOpen) {
			this.closeMobileSearchPage();
		} else {
			this.syncCardMenuState();
		}
		try {
			await openMemoDailyNoteDefault(this.app.workspace, memo);
			if (markRandomReunionReviewed) {
				await this.randomReunionController.markReviewedAfterOpen(memo.id);
			}
		} catch (error) {
			const fallbackMessage = markRandomReunionReviewed ? t("error.randomOpenFailed") : t("error.openDailyFailed");
			new Notice(formatServiceError(error, fallbackMessage));
		}
	}

	private findMemoById(memoId: string): MemoRecord | null {
		return this.randomReunionController.getSnapshot().memos?.find((memo) => memo.id === memoId)
			?? this.shuffleDayController.getSnapshot().memos.find((memo) => memo.id === memoId)
			?? this.memos.find((memo) => memo.id === memoId)
			?? this.trashMemoController.getSnapshot().trashMemos?.find((memo) => memo.id === memoId)
			?? null;
	}

	private startDateChangeWatcher(): void {
		this.dateChangeWatcher.start(() => {
			this.filteredMemosCache = null;
			this.renderUiState();
			this.startDateChangeWatcher();
			if (this.activeNav === "review") {
				void this.ensureAllMemosLoaded();
			}
		});
	}

	private stopDateChangeWatcher(): void {
		this.dateChangeWatcher.stop();
	}

	private handleTaskCheckboxClick(event: MouseEvent): void {
		if (this.consumeSuppressedOpenPopupDismissClick(event)) {
			return;
		}
		if (this.handleOpenPopupOutsideEvent(event, event.target, false)) {
			return;
		}
		const input = this.memoMarkdownRenderer.getTaskCheckboxInput(event.target);
		if (input !== null) {
			event.stopPropagation();
		}
	}

	private handleTaskCheckboxChange(event: Event): void {
		if (!event.isTrusted) {
			return;
		}
		if (this.popupState.suppressNextOpenPopupDismissClick) {
			event.stopPropagation();
			return;
		}
		if (this.handleOpenPopupOutsideEvent(event, event.target, false)) {
			return;
		}
		const input = this.memoMarkdownRenderer.getTaskCheckboxInput(event.target);
		if (input === null) {
			return;
		}
		event.stopPropagation();
		const memo = this.findMemoForTaskCheckbox(input);
		const taskIndex = this.memoMarkdownRenderer.getTaskCheckboxIndex(input);
		if (memo === null || taskIndex === null) {
			return;
		}
		const latestContent = this.memoTaskUpdateCoordinator.getLatestContent(memo);
		const plan = getMemoTaskCheckboxChangePlan(latestContent, taskIndex, input.checked);
		if (plan.type === "sync-dom") {
			this.memoMarkdownRenderer.syncTaskCheckboxDom(input, memo);
			return;
		}
		this.memoMarkdownRenderer.applyTaskCheckboxDomState(input, plan.marker);
		if (!plan.shouldEnqueue) {
			return;
		}
		this.memoTaskUpdateCoordinator.enqueue(memo, plan.nextContent);
	}

	private findMemoForTaskCheckbox(input: HTMLInputElement): MemoRecord | null {
		const memoId = input.getAttr("data-knomo-memo-id");
		if (memoId === null) {
			return null;
		}
		return this.memos.find((memo) => memo.id === memoId) ?? null;
	}

	private async handleTaskMemoSaved(memo: MemoRecord): Promise<void> {
		const previousMemo = this.memos.find((item) => item.id === memo.id);
		if (previousMemo === undefined) {
			return;
		}
		const mutation: MemoMutation = { type: "update", previousMemo, memo };
		this.applyMemoMutation(mutation, { preserveCardMemoId: memo.id });
		this.onMemoMutation(mutation, this);
	}

	private async handleTaskMemoIssue(memo: MemoRecord): Promise<void> {
		const previousMemo = this.memos.find((item) => item.id === memo.id);
		if (previousMemo !== undefined) {
			const mutation: MemoMutation = { type: "update", previousMemo, memo };
			this.applyMemoMutation(mutation);
			this.onMemoMutation(mutation, this);
		}
		new Notice(t("task.updateFailed"));
	}

	private async handleTaskMemoFailed(memo: MemoRecord, _error: unknown): Promise<void> {
		this.memoMarkdownRenderer.syncTaskCheckboxesForMemo([this.cardFlowEl, this.mobileSearchResultsEl], memo);
		new Notice(t("task.updateFailed"));
	}

	private handleMarkdownInternalLinkHover(event: MouseEvent): void {
		const linkInfo = getMarkdownInternalLinkInfo(event.target);
		if (linkInfo === null) {
			return;
		}
		this.app.workspace.trigger("hover-link", {
			event,
			source: "preview",
			hoverParent: this,
			targetEl: linkInfo.element,
			linktext: linkInfo.linktext,
			sourcePath: linkInfo.sourcePath,
		});
	}

	private async handleMarkdownInternalLinkClick(event: MouseEvent): Promise<void> {
		if (this.consumeSuppressedOpenPopupDismissClick(event)) {
			return;
		}
		if (this.handleOpenPopupOutsideEvent(event, event.target, false)) {
			return;
		}
		const linkInfo = getMarkdownInternalLinkInfo(event.target);
		if (linkInfo === null) {
			return;
		}
		event.preventDefault();
		await this.app.workspace.openLinkText(linkInfo.linktext, linkInfo.sourcePath, Keymap.isModEvent(event));
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
			const message = formatServiceError(error, t("error.imageInsertFailed"));
			this.updateStatus(message, true);
			new Notice(message);
		}
	}

	private getAttachmentSourcePath(): string | null {
		const sourcePath = this.getComposerSourcePath();
		if (sourcePath !== null) {
			return sourcePath;
		}
		const message = t("composer.enableDailyOrOpenMarkdown");
		this.updateStatus(message, true);
		new Notice(message);
		return null;
	}

	private getWikiLinkSourcePath(): string {
		return this.getComposerSourcePath() ?? "";
	}

	private getComposerSourcePath(): string | null {
		return getPreferredComposerSourcePath({
			todayDailyNotePath: this.syncOrchestrator.getTodayDailyNotePath(),
			activeFile: this.app.workspace.getActiveFile(),
		});
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

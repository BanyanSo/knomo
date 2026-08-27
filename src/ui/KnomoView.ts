import { Component, ItemView, Keymap, Notice, Platform, Scope, setIcon, TFile } from "obsidian";
import type { HoverPopover, WorkspaceLeaf } from "obsidian";

import { KNOMO_VIEW_DISPLAY_TEXT, KNOMO_VIEW_TYPE } from "../constants";
import { KNOMO_LOGO_ICON, KNOMO_SEARCH_ICON } from "../icons";
import { t } from "../i18n";
import type { AttachmentService } from "../services/AttachmentService";
import type { MemoCommandService } from "../services/MemoCommandService";
import type { CatalogReadService } from "../services/CatalogReadService";
import type { DailyNotesStatus } from "../services/DailyNoteService";
import type { VaultTagIndex } from "../services/VaultTagIndex";
import { RecordStatsService } from "../services/RecordStatsService";
import type { RecordStatsView } from "../services/RecordStatsService";
import type { SettingsService } from "../services/SettingsService";
import type { ShuffleDayService } from "../services/ShuffleDayService";
import type { CatalogCoverage, CatalogRefreshResult } from "../types/catalog";
import type {
	CatalogFeatureCursor,
	CatalogFeatureQuery,
	CatalogLibrarySummary,
	CatalogMemoPage,
	CatalogReadState,
	CatalogReadStatus,
	CatalogTagFacet,
	MemoSaveOperation,
	MemoSaveResult,
} from "../types/catalogView";
import type { MemoViewItem } from "../types/memoView";
import {
	isTrashMemoView,
	isCatalogMemoView,
	toTrashMemoView,
	toCatalogMemoView,
} from "../types/memoView";
import { applyListFormatToText, getHashInsertionText, getListEnterPatch, getListEnterPatchForNativeInput } from "../utils/composerInput";
import type { TextReplacement } from "../utils/composerInput";
import { formatDatePart } from "../utils/date";
import { formatTimeBuoyDate, getTimeBuoyCardStatus } from "../utils/timeBuoyDate";
import { extractTimeBuoyDates } from "../utils/timeBuoyParser";
import {
	alreadyHasTimeBuoyDate,
	getTimeBuoyTriggerStartAfterComposition,
	getTimeBuoyTriggerStartForDirectInput,
	insertTimeBuoyDateAtSelection,
	replaceTimeBuoyTrigger,
} from "../utils/timeBuoyComposer";
import { formatServiceError } from "../utils/serviceText";
import { getComposerToolButtonRoute } from "./KnomoActionRouter";
import type { MemoAction, TrashAction } from "./KnomoActionDispatch";
import { CardImageLoadQueue, type CardImageLoadSurface } from "./CardImageLoadQueue";
import { getCatalogReadStatusHeaders } from "./CatalogReadStatusPresenter";
import { DateChangeWatcher } from "./DateChangeWatcher";
import { DesktopSidebarStateController } from "./DesktopSidebarStateController";
import { renderKnomoMemoCard, renderKnomoTrashMemoCard } from "./KnomoCard";
import type { MemoCardTimeBuoy } from "./KnomoCard";
import {
	parseCardImageIndex,
	planMemoCardImageLoads,
	renderMemoCardImages,
} from "./KnomoCardImages";
import type { CardFlowRenderMode } from "./KnomoCardFlow";
import { KnomoCardFlowCoordinator } from "./KnomoCardFlowCoordinator";
import { getMemoDeleteMode, getMemoDisplayContent } from "./KnomoCardMetadata";
import { renderComposerReferencePreview, renderKnomoComposer } from "./KnomoComposer";
import {
	getTimeBuoyPickerLeft,
	renderTimeBuoyDatePicker,
	type TimeBuoyPickerSource,
} from "./TimeBuoyDatePicker";
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
import { getTextareaCharacterRect } from "./composerSuggestPosition";
import { ImagePreviewScrollLock } from "./ImagePreviewScrollLock";
import { ImageResourceCache } from "./ImageResourceCache";
import { getDestructiveConfirmReturnFocus, showKnomoConfirmModal } from "./KnomoConfirmModal";
import { KnomoImagePreviewModal } from "./KnomoImagePreviewModal";
import { filterVisibleMemos, memoMatchesSearch } from "./KnomoMemoFilter";
import { openMemoDailyNoteDefault, openMemoDailyNoteInNewTab } from "./memoDailyNoteOpen";
import {
	renderKnomoCardFlowHeaders,
	renderKnomoEmptyState,
	renderKnomoLoadMoreButton,
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
import { formatMemoDisplayTime, formatOptionalMemoTime } from "./MemoDisplayFormatters";
import { parseMemoCardPreviewLite, resolveMemoPreviewImages } from "./MemoCardPreview";
import type { MemoCardPreview, MemoPreviewImage } from "./MemoCardPreview";
import { MemoCardPreviewCache } from "./MemoCardPreviewCache";
import {
	getMemoRenderKey,
	getMemoRenderRevision,
} from "./MemoRenderRevision";
import { MemoSearchCache } from "./MemoSearchCache";
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
import { MobileNavbarCompactController } from "./MobileNavbarCompactController";
import { NativeImagePickerController } from "./NativeImagePickerController";
import { KnomoPopupState } from "./KnomoPopupState";
import { RandomReunionController } from "./RandomReunionController";
import { appendTimeBuoyItems, renderTimeBuoyPage } from "./TimeBuoyPage";
import {
	mergeTodayTimeBuoyFeed,
	TimeBuoyViewController,
	type TimeBuoyTab,
	type TimeBuoyTabItem,
} from "./TimeBuoyViewController";
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
	collectTagsFromCounts,
	getRegularFilterCopy,
	getRecordStatsSearchFilterKey,
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

type MemoRecord = MemoViewItem;

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

interface CatalogMemoLoad {
	memos: MemoRecord[];
	nextCursor: CatalogFeatureCursor | null;
	catalogRevision: number;
	coverage: CatalogCoverage;
	readState: CatalogReadState;
	status: CatalogReadStatus;
}

const CARD_BATCH_SIZE = 50;
const CATALOG_PAGE_SIZE = 50;
const TRASH_MEMO_WINDOW_LIMIT = 150;
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
const TIME_BUOY_PICKER_CLOSE_FALLBACK_MS = 280;
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

type TimeBuoyPickerFocusTarget = "default" | "input";

interface OpenTimeBuoyPickerState {
	source: TimeBuoyPickerSource;
	phase: "preparing" | "open" | "closing";
	savedValue: string;
	selectionEnd: number;
	triggerStart: number | null;
	triggerEnd: number | null;
	browseYear: number;
	browseMonth: number;
	mobile: boolean;
}

let nextA11yId = 0;

export class KnomoView extends ItemView {
	private readonly a11yIdPrefix = `knomo-view-${nextA11yId += 1}`;
	hoverPopover: HoverPopover | null = null;
	private rootEl: HTMLElement | null = null;
	private renderScope: Component | null = null;
	private sidebarEl: HTMLElement | null = null;
	private titleHosts: TitleHost[] = [];
	private statsEls: HTMLElement[] = [];
	private allTagsEl: HTMLElement | null = null;
	private cardFlowEl: HTMLElement | null = null;
	private trashCountEls: HTMLElement[] = [];
	private inputEl: HTMLTextAreaElement | null = null;
	private timeBuoyButtonEl: HTMLButtonElement | null = null;
	private timeBuoyMonthStatusEl: HTMLElement | null = null;
	private timeBuoyPickerEl: HTMLElement | null = null;
	private timeBuoyPickerBackdropEl: HTMLElement | null = null;
	private timeBuoyPickerEventCleanups: Array<() => void> = [];
	private timeBuoyPickerState: OpenTimeBuoyPickerState | null = null;
	private timeBuoyPickerKeyboardWaitCancel: (() => void) | null = null;
	private timeBuoyPickerFocusFrameId: number | null = null;
	private timeBuoyPickerCloseTimerId: number | null = null;
	private timeBuoyBrowseMonth: Date | null = null;
	private suppressTimeBuoyAutoOpen = false;
	private pendingTimeBuoyButtonOpenAfterComposition = false;
	private composerIsComposing = false;
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
	private catalogCursor: CatalogFeatureCursor | null = null;
	private catalogLoadingNextPage = false;
	private catalogCoverage: CatalogCoverage | null = null;
	private catalogReadState: CatalogReadState = "ready";
	private catalogStatus: CatalogReadStatus = {
		content: "ready",
		catalog: "complete",
		identity: "ready",
		projection: "ready",
		migration: "none",
	};
	private catalogMobileCursor: CatalogFeatureCursor | null = null;
	private catalogMobileQueryRun = 0;
	private catalogRevision = 0;
	private libraryIndexRevision = -1;
	private libraryIndexRun = 0;
	private librarySummary: CatalogLibrarySummary | null = null;
	private libraryTagFacets: CatalogTagFacet[] | null = null;
	private trashCursor: string | null = null;
	private trashIdentityRevision: string | null = null;
	private cardFlowError: string | null = null;
	private memoLoadingPromise: Promise<boolean> | null = null;
	private memoSourceGeneration = 0;
	private catalogDesktopQueryRun = 0;
	private expandedTagGroups = new Set<string>();
	private composerOpen = false;
	private editingMemo: MemoRecord | null = null;
	private quoteSourceMemoId: string | null = null;
	private quoteReferenceText: string | null = null;
	private quoteMarkdownText: string | null = null;
	private draftContent = "";
	private isSaving = false;
	private composerSaveRefreshQueue: Promise<void> = Promise.resolve();
	private isManualRefreshing = false;
	private lastKnownLocalDate = formatTimeBuoyDate(new Date());
	private currentLayout: LayoutMode = "desktop-wide";
	private renderedTimeBuoyEnabled: boolean | null = null;
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
	private readonly randomReunionController: RandomReunionController;
	private readonly shuffleDayController: ShuffleDayController;
	private readonly trashMemoController: TrashMemoController;
	private readonly timeBuoyViewController: TimeBuoyViewController;
	private timeBuoyPanelEl: HTMLElement | null = null;
	private timeBuoyRenderItems: TimeBuoyTabItem[] = [];
	private timeBuoyRenderedCount = 0;
	private timeBuoyBatchFrameId: number | null = null;
	private timeBuoyLoadMoreObserver: IntersectionObserver | null = null;
	private readonly recordStatsService = new RecordStatsService();
	private readonly recordStatsPreparationController: RecordStatsPreparationController;
	private readonly recordStatsViewStateController = new RecordStatsViewStateController();
	private readonly viewStateController = new KnomoViewStateController();
	private readonly popupState: KnomoPopupState;
	private readonly mobileSearchController: MobileSearchController;
	private readonly getDailyNotesStatus: () => DailyNotesStatus;
	private readonly getTodayDailyNotePath: () => string | null;
	private readonly mobileComposerController: MobileComposerController;
	private readonly userActionController: KnomoUserActionController;
	private mobileNavbarCompactController: MobileNavbarCompactController | null = null;
	private imagePreviewRenderGeneration = 0;
	private readonly renderedCardMemos = new Map<string, MemoRecord>();
	private readonly taskUpdateQueues = new Map<string, Promise<void>>();
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
		private readonly shuffleDayService: ShuffleDayService,
		private readonly attachmentService: AttachmentService,
		private readonly vaultTagIndex: VaultTagIndex,
		private readonly onForceRefreshViews: () => Promise<void>,
		private readonly onManualRefresh: () => Promise<CatalogRefreshResult>,
		private readonly memoCommandService: MemoCommandService,
		private readonly catalogReadService: CatalogReadService,
		getDailyNotesStatus: () => DailyNotesStatus,
		getTodayDailyNotePath: () => string | null,
		private readonly onRefreshCatalogProtocolState: (() => Promise<void>) | null = null,
		private readonly onOpenCatalogSettings: (() => void) | null = null,
	) {
		super(leaf);
		this.getDailyNotesStatus = getDailyNotesStatus;
		this.getTodayDailyNotePath = getTodayDailyNotePath;
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
				this.getRenderScope().registerDomEvent(target, type, listener);
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
				this.getRenderScope().registerDomEvent(target, type, listener);
			},
			createHiddenText: (container, name, text) => this.createHiddenText(container, name, text),
			memoMatchesSearch: (memo, normalizedQuery, dateFilter, recordStatsFilter) => {
				return memoMatchesSearch(
					memo,
					normalizedQuery,
					dateFilter,
					recordStatsFilter,
					this.getDailyNotesStatus(),
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
			loadRemoteResults: (query, dateFilter, recordStatsFilter, reset) => this.loadCatalogMobileSearchResults(
					query,
					dateFilter,
					recordStatsFilter,
					reset,
				),
			hasRemoteNextPage: () => this.catalogMobileCursor !== null,
			restoreRemoteResults: async () => {
					this.catalogMobileQueryRun += 1;
					this.catalogMobileCursor = null;
					await this.reloadMemos(false, true);
			},
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
			createComponent: () => new Component(),
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
		this.trashMemoController = new TrashMemoController<MemoRecord>({
			getDeletedMemoSummary: () => this.catalogReadService.getDeletedSummary(),
			listDeletedMemos: async () => {
				const page = await this.catalogReadService.listDeleted(CATALOG_PAGE_SIZE);
				this.trashCursor = page.nextCursor;
				this.trashIdentityRevision = page.identityRevision;
				return page.items.map(toTrashMemoView);
			},
			restoreMemo: async (memo) => {
				if (isTrashMemoView(memo)) {
					const result = await this.memoCommandService.restore(memo.trashItem);
					return result.memo === null ? null : toCatalogMemoView(result.memo);
				}
				throw new Error("Deleted memo source is unavailable.");
			},
			purgeMemo: async (memo) => {
				if (isTrashMemoView(memo) && memo.trashItem.purgeAllowed) {
					await this.memoCommandService.purge(memo.trashItem);
					return;
				}
				throw new Error("Permanent delete is unavailable for this memo.");
			},
			confirmPurge: () => showKnomoConfirmModal(this.app, {
				title: t("trash.purge"),
				message: t("confirm.purgeMemo"),
				confirmLabel: t("trash.purge"),
				danger: true,
			}),
			handleRestoredMemo: (deletedMemo, restoredMemo) => this.handleRestoredTrashMemo(deletedMemo, restoredMemo),
			isTrashActive: () => this.activeNav === "trash",
			showNotice: (message) => new Notice(message),
			forceRefreshViews: () => this.onForceRefreshViews(),
			requestRender: (target) => this.handleTrashRenderRequest(target),
		});
		this.timeBuoyViewController = new TimeBuoyViewController({
			getNow: () => new Date(),
			isTodayIndexReady: (targetDate) => this.catalogReadService.getCoverageForRange(targetDate, targetDate),
			ensureReady: async () => undefined,
			queryAll: () => this.catalogReadService.queryAllTimeBuoys(),
			queryDate: (date) => this.catalogReadService.queryTimeBuoysForDate(date),
			requestRender: () => {
				if (this.activeNav === "time-buoy") {
					this.renderCardFlow();
				} else if (this.shouldShowTodayTimeBuoys()) {
					this.renderCardFlow();
				}
			},
		});
		this.randomReunionController = new RandomReunionController({
			prepareCatalogData: async () => undefined,
			getMemos: () => this.memos,
			getRandomReunionMemos: (count) => this.catalogReadService.getRandomReunionItems(count),
			openRandomReunionMemo: async (memo) => {
				const file = this.app.vault.getAbstractFileByPath(memo.dailyRef.path);
				if (!(file instanceof TFile)) throw new Error(t("error.dailyNoteMissing"));
				await openMemoDailyNoteInNewTab(this.app.workspace, file, memo.dailyRef.lineNumberHint);
			},
			markRandomReunionReviewed: async (memoId) => {
				const memo = this.findMemoById(memoId);
				if (memo !== null && isCatalogMemoView(memo)) {
					await this.memoCommandService.recordReview(await this.resolveCatalogMemo(memo));
				}
			},
			isRandomActive: () => this.activeNav === "random",
			showNotice: (message) => new Notice(message),
			requestRender: () => this.renderUiState(),
		});
		this.shuffleDayController = new ShuffleDayController({
			prepareCatalogData: async () => undefined,
			getMemos: () => this.memos,
			service: this.shuffleDayService,
			selectShuffleDay: async () => this.shuffleDayService.selectCatalogShuffleDay(
					await this.getCatalogReadService().listDailyAggregates(),
					(date) => this.catalogReadService.listMemoViewsForDate(date),
				),
			isShuffleDayActive: () => this.activeNav === "shuffleDay",
			showNotice: (message) => new Notice(message),
			requestRender: () => this.renderUiState(),
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
				this.getRenderScope().registerDomEvent(element, "click", handler);
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
			isDrawerOpen: () => this.mobileDrawerOpen,
			getRenderGeneration: () => this.renderGeneration,
			hasMoreCardFlowItems: () => this.cardFlowCoordinator.hasMoreItems,
			shouldDeferCardFlowForAllMemos: () => this.shouldDeferCardFlowForAllMemos(),
			shouldIgnoreMobileSaveInput: () => this.mobileSendPointerGuard.shouldIgnoreClick(this.currentLayout === "mobile"),
			getEscapeState: () => ({
				mobileSearchPageOpen: this.mobileSearchPageOpen,
				composerOpen: this.composerOpen,
				editingOrQuoting: this.editingMemo !== null || this.quoteReferenceText !== null,
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
			runMemoAction: (action, memoId, candidateMemoId) => this.runMemoActionById(action, memoId, candidateMemoId),
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
			loadOlderMemoPeriods: () => {
				void this.loadOlderMemoPeriods();
			},
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
			ensureSidebarIndexes: () => {
				void this.ensureSidebarIndexes();
			},
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
			retryTimeBuoy: () => this.timeBuoyViewController.retry(),
			setTimeBuoyTab: (tab) => this.setTimeBuoyTabFromAction(tab),
			loadMoreTimeBuoyCards: () => this.renderNextTimeBuoyBatch(this.renderGeneration),
			openTimeBuoy: () => this.setSidebarNav("time-buoy"),
			enableTimeBuoyIntro: () => this.enableTimeBuoyFromIntro(),
			dismissTimeBuoyIntro: () => this.dismissTimeBuoyIntro(),
			renderAllMemosLoadingState: () => this.renderAllMemosLoadingState(),
			reloadCatalogQuery: async () => {
				await this.reloadCurrentCatalogQuery();
			},
			setRecordStatsView: (view) => this.setRecordStatsViewFromAction(view),
			openRecordStatsTrendFilter: (sourceEl) => this.openRecordStatsTrendFilter(sourceEl),
			openRecordStatsHourFilter: (sourceEl) => this.openRecordStatsHourFilter(sourceEl),
			openRecordStatsMetricFilter: (type) => this.openRecordStatsMetricFilter(type),
			openRecordStatsTagFilter: (sourceEl) => this.openRecordStatsTagFilter(sourceEl),
			openComposer: () => this.openComposer(),
			toggleCompactSearch: () => this.toggleCompactSearchFromUserAction(),
			runComposerToolAction: (action) => this.runComposerToolAction(action),
			clearReference: () => this.clearReference(),
			cancelEditing: () => this.cancelEditing(),
			saveInput: () => this.saveInput(),
			renderUiState: () => this.renderUiState(),
			syncUiChrome: () => this.syncUiChrome(),
			syncCardMenuState: () => this.syncCardMenuState(),
			cancelComposerFromEscape: () => this.cancelComposerFromEscape(),
			closeOpenChromeFromEscape: () => this.closeOpenChromeFromEscape(),
			refreshCatalogSyncState: () => this.refreshCatalogSyncState(),
			openCatalogSettings: () => this.onOpenCatalogSettings?.(),
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
		this.lastKnownLocalDate = formatTimeBuoyDate(new Date());
		this.contentEl.addClass("knomo-view-host");
		this.register(this.vaultTagIndex.subscribe(() => {
			if (this.rootEl !== null) {
				this.renderTags();
			}
		}));
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
		this.register(() => this.clearTimeBuoyPickerEventListeners());
		this.registerDomEvent(this.containerEl.win, "focus", () => this.handleLocalDateChange());
		this.registerDomEvent(this.containerEl.win, "orientationchange", () => this.closeTimeBuoyPicker(false));
		const handleMobileBack = (event: Event): void => {
			if (this.timeBuoyPickerState === null) {
				return;
			}
			event.preventDefault();
			event.stopPropagation();
			this.closeTimeBuoyPicker(true);
		};
		this.containerEl.doc.addEventListener("backbutton", handleMobileBack, { capture: true });
		this.register(() => this.containerEl.doc.removeEventListener("backbutton", handleMobileBack, { capture: true }));
		this.registerDomEvent(this.containerEl.doc, "visibilitychange", () => {
			if (this.containerEl.doc.visibilityState === "visible") {
				this.handleLocalDateChange();
			}
		});
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
		if (this.renderScope !== null) {
			this.removeChild(this.renderScope);
			this.renderScope = null;
		}
		this.closeTimeBuoyPicker(false);
		this.clearSearchDebounce();
		this.clearMobileSearchDebounce();
		this.clearRecordStatsPreparation();
		this.recordStatsPreparationController.clearRetryRequest();
		this.recordStatsService.invalidate();
		this.timeBuoyViewController.clear();
		this.resetTimeBuoyCardFlow();
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
		const timeBuoyEnabled = this.settingsService.getSettings().timeBuoyEnabled;
		if (this.renderedTimeBuoyEnabled !== timeBuoyEnabled) {
			if (!timeBuoyEnabled && this.activeNav === "time-buoy") {
				this.activeNav = "all";
			}
			await this.render();
			return;
		}
		if (this.activeNav === "time-buoy") {
			await this.timeBuoyViewController.loadInitial();
			return;
		}
		if (this.activeNav === "trash") {
			await this.trashMemoController.loadTrashMemos();
			return;
		}
		await this.waitForAllMemosLoading();
		await this.reloadMemos(false, forceRebuild);
		if (!Platform.isMobile) {
			void this.trashMemoController.refreshTrashCount(false);
		}
		if (this.settingsService.getSettings().timeBuoyEnabled) {
			await this.timeBuoyViewController.loadTodayOnly();
		}
		if (this.activeNav === "random") {
			await this.randomReunionController.refresh();
		} else if (this.activeNav === "shuffleDay") {
			this.shuffleDayController.reconcileWithMemos();
			this.renderCardFlow();
		}
	}

	private handleRestoredTrashMemo(_deletedMemo: MemoRecord, restoredMemo: MemoRecord): void {
		if (isCatalogMemoView(restoredMemo)) void this.reloadMemos(false, true);
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

	private getRenderScope(): Component {
		return this.renderScope ?? this;
	}

	private async render(): Promise<void> {
		this.closeTimeBuoyPicker(false);
		const pendingMemoLoad = this.memoLoadingPromise;
		this.memoSourceGeneration += 1;
		if (pendingMemoLoad !== null) {
			await pendingMemoLoad.catch(() => false);
			if (this.memoLoadingPromise === pendingMemoLoad) {
				this.memoLoadingPromise = null;
			}
		}
		this.memos = [];
		this.librarySummary = null;
		this.libraryTagFacets = null;
		this.libraryIndexRevision = -1;
		this.filteredMemosCache = null;
		this.tagSuggest?.close();
		this.tagSuggest = null;
		this.wikiLinkSuggest?.destroy();
		this.wikiLinkSuggest = null;
		if (this.renderScope !== null) {
			this.removeChild(this.renderScope);
		}
		this.renderScope = this.addChild(new Component());
		const container = this.contentEl;
		container.empty();
		this.titleHosts = [];
		this.statsEls = [];
		this.trashCountEls = [];

		const settings = this.settingsService.getSettings();
		this.renderedTimeBuoyEnabled = settings.timeBuoyEnabled;
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
		this.getRenderScope().registerDomEvent(this.cardFlowEl, "scroll", () => this.handleCardFlowScroll());
		this.getRenderScope().registerDomEvent(this.cardFlowEl, "mouseover", (event) => {
			this.handleMarkdownInternalLinkHover(event);
		});
		this.getRenderScope().registerDomEvent(this.cardFlowEl, "click", (event) => {
			void this.handleMarkdownInternalLinkClick(event);
		});
		this.getRenderScope().registerDomEvent(this.cardFlowEl, "click", (event) => {
			this.handleTaskCheckboxClick(event);
		});
		this.getRenderScope().registerDomEvent(this.cardFlowEl, "change", (event) => {
			this.handleTaskCheckboxChange(event);
		});

		this.getRenderScope().registerDomEvent(root, "pointerdown", (event) => {
			this.handleRootPointerDown(event);
		}, { capture: true });
		this.getRenderScope().registerDomEvent(root, "click", (event) => {
			void this.handleRootClick(event);
		});
		this.getRenderScope().registerDomEvent(root, "keydown", (event) => {
			void this.handleRootKeydown(event);
		});

		if (Platform.isMobile) {
			this.ensureMobileSearchPage();
		}
		this.renderScopeState();
		this.syncRootState();
		void this.refreshCatalogLibraryIndexes();
		if (Platform.isMobile) {
			this.renderStats();
			this.renderTags();
			this.renderTrashCount();
			void this.loadInitialMobileMemos();
		} else {
			await this.reloadCurrentCatalogQuery(true);
			void this.trashMemoController.refreshTrashCount(false);
		}
		if (this.settingsService.getSettings().timeBuoyEnabled) {
			if (this.activeNav === "time-buoy") {
				void this.timeBuoyViewController.loadInitial();
			} else {
				void this.timeBuoyViewController.loadTodayOnly();
			}
		}
	}

	private renderSidebar(sidebar: HTMLElement): void {
		const elements = renderKnomoSidebar(sidebar, {
			sidebarMinWidth: SIDEBAR_MIN_WIDTH,
			sidebarMaxWidth: SIDEBAR_MAX_WIDTH,
			timeBuoyEnabled: this.settingsService.getSettings().timeBuoyEnabled,
			createHiddenText: (container, id, text) => this.createHiddenText(container, id, text),
			createIconButton: (container, icon, ariaLabel, cls, action, showTooltip) => {
				return this.createIconButton(container, icon, ariaLabel, cls, action, showTooltip);
			},
		});
		this.statsEls.push(elements.statsEl);
		this.allTagsEl = elements.allTagsEl;
		this.trashCountEls.push(elements.trashCountEl);
		this.sidebarResizerEl = elements.resizerEl;
		this.getRenderScope().registerDomEvent(this.sidebarResizerEl, "pointerdown", (event) => this.startSidebarResize(event));
		this.getRenderScope().registerDomEvent(this.sidebarResizerEl, "pointermove", (event) => this.resizeSidebar(event));
		this.getRenderScope().registerDomEvent(this.sidebarResizerEl, "pointerup", (event) => this.stopSidebarResize(event));
		this.getRenderScope().registerDomEvent(this.sidebarResizerEl, "pointercancel", (event) => this.stopSidebarResize(event));
		this.getRenderScope().registerDomEvent(this.sidebarResizerEl, "keydown", (event) => {
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
		const dailyStatus = this.getDailyNotesStatus();
		const createEnabled = dailyStatus.enabled && this.isComposerCreationAvailable();
		const wikiLinkListboxId = this.getA11yId("wiki-link-suggestions");
		const composer = renderKnomoComposer(main, {
			dailyEnabled: createEnabled,
			timeBuoyEnabled: this.settingsService.getSettings().timeBuoyEnabled,
			timeBuoyPickerId: this.getA11yId("time-buoy-picker"),
			draftContent: this.draftContent,
			createHiddenText: (container, name, text) => this.createHiddenText(container, name, text),
			createIconButton: (container, icon, ariaLabel, cls, action, showTooltip) => {
				return this.createIconButton(container, icon, ariaLabel, cls, action, showTooltip);
			},
		});
		this.composerEl = composer.composerEl;
		this.inputEl = composer.inputEl;
		this.timeBuoyButtonEl = composer.timeBuoyButtonEl;
		this.timeBuoyMonthStatusEl = composer.timeBuoyMonthStatusEl;
		this.referencePreviewEl = composer.referencePreviewEl;
		this.composerBarEl = composer.composerBarEl;
		this.cancelEditButtonEl = composer.cancelEditButtonEl;
		this.statusEl = composer.statusEl;
		this.sendButtonEl = composer.sendButtonEl;
		this.getRenderScope().registerDomEvent(composer.composerEl, "click", (event) => {
			if (this.isMobileComposerLayered()) {
				void this.handleRootClick(event);
			}
		});
		this.getRenderScope().registerDomEvent(composer.composerEl, "keydown", (event) => {
			if (this.isMobileComposerLayered()) {
				void this.handleRootKeydown(event);
			}
		});
		this.getRenderScope().registerDomEvent(composer.composerEl, "pointerdown", (event) => this.handleMobileComposerActionPointerDown(event));
		this.getRenderScope().registerDomEvent(composer.composerEl, "mousedown", (event) => this.handleMobileComposerActionPointerDown(event));
		this.tagSuggest = new KnomoTagSuggest(
			this.app,
			this.inputEl,
			() => this.syncInputState(),
			this.vaultTagIndex,
		);
		this.wikiLinkSuggest = new KnomoWikiLinkSuggest(this.app, this.inputEl, {
			listboxId: wikiLinkListboxId,
			getSourcePath: () => this.getWikiLinkSourcePath(),
			onInputChanged: () => this.syncInputState(),
			closeTagSuggest: () => this.tagSuggest?.close(),
			registerVaultEvent: (eventRef) => this.getRenderScope().registerEvent(eventRef),
		});
		this.getRenderScope().registerDomEvent(this.inputEl, "beforeinput", (event: InputEvent) => {
			this.handleComposerBeforeInput(event);
		});
		this.getRenderScope().registerDomEvent(this.inputEl, "input", (event) => {
			this.handleComposerInput(event);
		});
		this.getRenderScope().registerDomEvent(this.inputEl, "focus", () => {
			this.handleComposerInputFocus();
		});
		this.getRenderScope().registerDomEvent(this.inputEl, "blur", () => {
			this.handleComposerInputBlur();
		});
		this.getRenderScope().registerDomEvent(this.inputEl, "compositionstart", () => {
			this.composerIsComposing = true;
			this.wikiLinkSuggest?.handleCompositionStart();
		});
		this.getRenderScope().registerDomEvent(this.inputEl, "compositionend", (event: CompositionEvent) => {
			this.composerIsComposing = false;
			this.wikiLinkSuggest?.handleCompositionEnd();
			this.handleTimeBuoyCompositionEnd(event);
		});
		this.getRenderScope().registerDomEvent(this.inputEl, "click", () => {
			this.wikiLinkSuggest?.refreshForCursor();
			this.closeTimeBuoyPickerIfTriggerMoved();
		});
		this.getRenderScope().registerDomEvent(this.inputEl, "keydown", (event) => {
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
		this.getRenderScope().registerDomEvent(this.inputEl, "keydown", (event) => {
			this.handleComposerKeydown(event);
		});
		this.getRenderScope().registerDomEvent(this.inputEl, "keyup", (event) => {
			this.handleComposerKeyup(event);
			this.wikiLinkSuggest?.refreshForCursor();
			this.closeTimeBuoyPickerIfTriggerMoved();
		});
		this.getRenderScope().registerDomEvent(composer.toolsEl, "pointerdown", (event) => this.handleComposerToolPointerDown(event));
		this.getRenderScope().registerDomEvent(composer.toolsEl, "mousedown", (event) => this.handleComposerToolPointerDown(event));
		this.getRenderScope().registerDomEvent(this.sendButtonEl, "pointerdown", (event) => {
			this.handleSendPointerDown(event);
		});
		this.getRenderScope().registerDomEvent(this.sendButtonEl, "mousedown", (event) => {
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
		this.getRenderScope().registerDomEvent(searchInput, "focus", () => this.openDesktopSearch());
		this.getRenderScope().registerDomEvent(searchInput, "click", () => this.openDesktopSearch());
		this.getRenderScope().registerDomEvent(searchInput, "input", () => {
			this.queueSearchQuery(searchInput.value);
		});
		this.getRenderScope().registerDomEvent(searchInput, "keydown", (event) => {
			if (event.key === "Escape") {
				this.desktopSearchOpen = false;
				this.syncRootState();
				searchInput.blur();
			}
		});
	}

	private registerCompactSearchInput(searchInput: HTMLInputElement): void {
		this.getRenderScope().registerDomEvent(searchInput, "focus", () => this.openDesktopSearch());
		this.getRenderScope().registerDomEvent(searchInput, "click", () => this.openDesktopSearch());
		this.getRenderScope().registerDomEvent(searchInput, "input", () => {
			this.queueSearchQuery(searchInput.value);
		});
		this.getRenderScope().registerDomEvent(searchInput, "keydown", (event) => {
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
		const queryRun = ++this.catalogDesktopQueryRun;
		const sourceGeneration = this.memoSourceGeneration;
		const previousCardFlowKey = this.getCardFlowStateKey();
		const previousMobileSearchKey = this.getMobileSearchStateKey();
		let loaded = false;
		try {
			const load = await this.loadCatalogMemos(loadAll);
			if (sourceGeneration !== this.memoSourceGeneration || queryRun !== this.catalogDesktopQueryRun) {
				return false;
			}
			this.applyCatalogMemoLoad(load);
			this.memos = load.memos;
			this.invalidateRecordStats();
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
			if (sourceGeneration !== this.memoSourceGeneration || queryRun !== this.catalogDesktopQueryRun) {
				return false;
			}
			this.memos = [];
			this.invalidateRecordStats();
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
			}
		} else if (!loaded && loadAll && this.activeNav === "record-stats") {
			this.recordStatsService.fail(this.cardFlowError ?? t("recordStats.error.desc"));
			this.renderCardFlow();
		}
		return loaded;
	}

	private async refreshCatalogSyncState(): Promise<void> {
		await this.onRefreshCatalogProtocolState?.();
		await this.memoCommandService.refreshLocalCatalog();
		await this.onForceRefreshViews();
	}

	private async loadCatalogMemos(loadAll: boolean): Promise<CatalogMemoLoad> {
		const page = await this.queryCatalogFeature({
			...this.buildCatalogActiveQuery(loadAll),
			limit: CATALOG_PAGE_SIZE,
			cursor: null,
		});
		if (page.invalidated) throw new Error("Catalog changed while loading the current view.");
		return {
			memos: page.items.map(toCatalogMemoView),
			nextCursor: page.nextCursor,
			coverage: page.coverage,
			readState: page.readState,
			status: page.status,
			catalogRevision: page.catalogRevision,
		};
	}

	private applyCatalogMemoLoad(load: CatalogMemoLoad): void {
		this.catalogCursor = load.nextCursor;
		this.catalogCoverage = load.coverage;
		this.catalogReadState = load.readState;
		this.catalogStatus = load.status;
		this.catalogRevision = load.catalogRevision;
		if (this.libraryIndexRevision !== load.catalogRevision || this.librarySummary === null || this.libraryTagFacets === null) {
			void this.refreshCatalogLibraryIndexes();
		}
	}

	private async loadNextCatalogPage(): Promise<boolean> {
		if (this.catalogCursor === null || this.catalogLoadingNextPage) return false;
		const queryRun = this.catalogDesktopQueryRun;
		this.catalogLoadingNextPage = true;
		try {
			const page = await this.queryCatalogFeature({
				...this.buildCatalogActiveQuery(true),
				limit: CATALOG_PAGE_SIZE,
				cursor: this.catalogCursor,
			});
			if (queryRun !== this.catalogDesktopQueryRun) return false;
			if (page.invalidated) return this.reloadMemos(false, true);
			const byRenderKey = new Map(this.memos.map((memo) => [getMemoRenderKey(memo), memo]));
			for (const memo of page.items.map(toCatalogMemoView)) byRenderKey.set(getMemoRenderKey(memo), memo);
			this.memos = mergeCatalogMemoPages([...byRenderKey.values()]);
			this.catalogCursor = page.nextCursor;
			this.catalogCoverage = page.coverage;
			this.catalogReadState = page.readState;
			this.catalogStatus = page.status;
			this.catalogRevision = page.catalogRevision;
			this.filteredMemosCache = null;
			this.invalidateMemoSearchCache();
			this.forceRebuildCardFlow();
			return true;
		} finally {
			this.catalogLoadingNextPage = false;
		}
	}

	private async loadCatalogMobileSearchResults(
		text: string,
		dateFilter: SearchDateFilter | null,
		recordStatsFilter: RecordStatsSearchFilter | null,
		reset: boolean,
	): Promise<void> {
		const run = reset ? ++this.catalogMobileQueryRun : this.catalogMobileQueryRun;
		const query: Omit<CatalogFeatureQuery, "limit" | "cursor"> = {};
		if (text.trim().length > 0) query.text = text.trim();
		const dateRange = getCatalogDateRange(dateFilter, new Date());
		if (dateRange !== null) {
			query.fromDate = dateRange.fromDate;
			query.toDate = dateRange.toDate;
		}
		if (recordStatsFilter?.type === "day") {
			query.fromDate = recordStatsFilter.date;
			query.toDate = recordStatsFilter.date;
		} else if (recordStatsFilter?.type === "month") {
			query.fromDate = `${recordStatsFilter.month}-01`;
			query.toDate = formatDatePart(new Date(
				Number(recordStatsFilter.month.slice(0, 4)),
				Number(recordStatsFilter.month.slice(5, 7)),
				0,
			));
		} else if (recordStatsFilter !== null && "startDate" in recordStatsFilter) {
			query.fromDate = recordStatsFilter.startDate;
			query.toDate = formatDatePart(addLocalDays(parseLogicalDateForView(recordStatsFilter.endDateExclusive), -1));
			if (recordStatsFilter.type === "with-image") query.hasImage = true;
			if (recordStatsFilter.type === "no-tag") query.hasTag = false;
			if (recordStatsFilter.type === "tag") query.tags = [recordStatsFilter.tagKey];
		}
		const page = recordStatsFilter === null
			? await this.getCatalogReadService().query({
				...query,
				limit: CATALOG_PAGE_SIZE,
				cursor: reset ? null : this.catalogMobileCursor,
			})
			: await this.getCatalogReadService().queryRecordStatsDrilldown(recordStatsFilter, {
				limit: CATALOG_PAGE_SIZE,
				cursor: reset ? null : this.catalogMobileCursor,
				text: text.trim() || undefined,
			});
		if (run !== this.catalogMobileQueryRun) return;
		if (page.invalidated) {
			if (!reset) await this.loadCatalogMobileSearchResults(text, dateFilter, recordStatsFilter, true);
			return;
		}
		const next = page.items.map(toCatalogMemoView);
		if (reset) {
			this.memos = next;
		} else {
			const byRenderKey = new Map(this.memos.map((memo) => [getMemoRenderKey(memo), memo]));
			for (const memo of next) byRenderKey.set(getMemoRenderKey(memo), memo);
			this.memos = mergeCatalogMemoPages([...byRenderKey.values()]);
		}
		this.catalogMobileCursor = page.nextCursor;
		this.catalogCoverage = page.coverage;
		this.catalogReadState = page.readState;
		this.catalogStatus = page.status;
		this.catalogRevision = page.catalogRevision;
		this.invalidateMemoSearchCache();
		this.retainMemoCardPreviews();
	}

	private buildCatalogActiveQuery(loadAll: boolean): Omit<CatalogFeatureQuery, "limit" | "cursor"> {
		const query: Omit<CatalogFeatureQuery, "limit" | "cursor"> = {};
		const text = this.searchQuery.trim();
		if (text.length > 0) query.text = text;
		if (this.activeTagKey !== null) query.tags = [this.activeTagKey];
		if (this.scopeFilter === "with-link") query.hasLink = true;
		if (this.scopeFilter === "with-image") query.hasImage = true;
		if (this.scopeFilter === "no-tag") query.hasTag = false;
		const today = new Date();
		if (this.scopeFilter === "anniversary") {
			query.monthDay = formatDatePart(today).slice(5);
		} else {
			const range = getCatalogDateRange(this.searchDateFilter ?? toSearchDateFilter(this.scopeFilter), today);
			if (range !== null) {
				query.fromDate = range.fromDate;
				query.toDate = range.toDate;
			} else if (!loadAll && this.activeNav === "all" && this.isDefaultListState()) {
				query.fromDate = formatDatePart(new Date(today.getFullYear(), today.getMonth() - 1, 1));
			}
		}
		return query;
	}

	private queryCatalogFeature(request: CatalogFeatureQuery): Promise<CatalogMemoPage> {
		if (this.recordStatsSearchFilter !== null) {
			return this.getCatalogReadService().queryRecordStatsDrilldown(this.recordStatsSearchFilter, {
				limit: request.limit,
				cursor: request.cursor,
				text: request.text,
			});
		}
		if (this.activeNav === "review") {
			return this.getCatalogReadService().queryReviewItems(new Date(), {
				limit: request.limit,
				cursor: request.cursor,
				text: request.text,
			});
		}
		return this.getCatalogReadService().query(request);
	}

	private async loadInitialMobileMemos(): Promise<void> {
		const sourceGeneration = this.memoSourceGeneration;
		try {
			const load = await this.loadCatalogMemos(false);
			if (
				sourceGeneration !== this.memoSourceGeneration
				|| this.cardFlowEl === null
				|| !this.cardFlowEl.isConnected
			) {
				return;
			}
			this.applyCatalogMemoLoad(load);
			this.memos = load.memos;
			this.invalidateRecordStats();
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
		} catch (error) {
			if (
				sourceGeneration !== this.memoSourceGeneration
				|| this.cardFlowEl === null
				|| !this.cardFlowEl.isConnected
			) {
				return;
			}
			this.memos = [];
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
		const dailyStatus = this.getDailyNotesStatus();
		const createEnabled = dailyStatus.enabled && this.isComposerCreationAvailable();
		if (this.inputEl !== null) {
			this.inputEl.disabled = !createEnabled;
		}
		if (this.isSaving || this.editingMemo !== null || this.quoteReferenceText !== null || this.cardFlowError !== null) {
			return;
		}
		this.updateStatus("", false);
	}

	private isComposerCreationAvailable(): boolean {
		return this.memoCommandService.getOperationalState(this.catalogReadState).capabilities.createNew;
	}

	private syncComposerMode(): void {
		if (this.referencePreviewEl !== null) {
			renderComposerReferencePreview(
				this.referencePreviewEl,
				this.quoteReferenceText !== null ? this.quoteMarkdownText : null,
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
		root.toggleClass("is-time-buoy", this.activeNav === "time-buoy");
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
		if (this.timeBuoyPickerEl !== null && this.timeBuoyPickerState?.mobile === false) {
			this.positionDesktopTimeBuoyPicker(this.timeBuoyPickerEl);
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
		const previousLayout = this.currentLayout;
		if (Platform.isMobile) {
			this.currentLayout = "mobile";
			if (previousLayout !== this.currentLayout) {
				this.closeTimeBuoyPicker(false);
			}
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
		if (previousLayout !== this.currentLayout) {
			this.closeTimeBuoyPicker(false);
		}
	}

	private renderStats(): void {
		const stats = this.librarySummary;
		for (const statsEl of this.statsEls) {
			statsEl.empty();
			statsEl.toggleClass("is-loading", stats === null);
			if (stats === null) statsEl.setAttr("aria-busy", "true");
			else statsEl.removeAttribute("aria-busy");
			renderSidebarStat(statsEl, stats === null ? "—" : String(stats.memoCount), t("stats.notes"));
			renderSidebarStat(statsEl, stats === null ? "—" : String(stats.tagCount), t("stats.tags"));
			renderSidebarStat(
				statsEl,
				stats === null ? "—" : stats.imageCount > 0 ? String(stats.imageCount) : String(stats.wordCount),
				stats !== null && stats.imageCount > 0 ? t("stats.images") : t("stats.words"),
			);
		}
	}

	private renderTags(): void {
		if (Platform.isMobile && !this.mobileDrawerOpen) {
			return;
		}
		if (!Platform.isMobile && this.vaultTagIndex.getSnapshot().status === "idle") {
			void this.vaultTagIndex.ensureReady();
		}
		if (this.libraryTagFacets === null) {
			this.allTagsEl?.setAttr("aria-busy", "true");
			this.allTagsEl?.empty();
			this.allTagsEl?.createDiv({ cls: "knomo-muted-text", text: t("empty.loadingAllMemos") });
			return;
		}
		this.allTagsEl?.removeAttribute("aria-busy");
		const displayTags = new Map(this.vaultTagIndex.getSnapshot().displayByKey);
		const allTags = collectTagsFromCounts(
			new Map(this.libraryTagFacets.map((facet) => [facet.key, facet.count])),
			displayTags,
			new Map(this.libraryTagFacets.map((facet) => [facet.key, facet.label])),
		);
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
		const trashSnapshot = this.trashMemoController.getSnapshot();
		const trashCount = trashSnapshot.trashCount;
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
		if (this.activeNav === "time-buoy") {
			this.renderTimeBuoyPage();
			return;
		}
		this.resetTimeBuoyCardFlow();
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
		if (presentation.type === "onboarding") {
			this.renderCatalogOnboarding(presentation);
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

	private renderTimeBuoyPage(): void {
		const cardFlow = this.cardFlowEl;
		if (cardFlow === null) {
			return;
		}
		this.resetTimeBuoyCardFlow();
		this.renderGeneration += 1;
		const generation = this.renderGeneration;
		this.memoMarkdownRenderer.clear();
		this.cardImageLoadQueue.clear("card-flow");
		this.cardFlowCoordinator.resetFlowRuntime(this.containerEl.win);
		this.renderedCardMemos.clear();
		const result = renderTimeBuoyPage(cardFlow, this.timeBuoyViewController.getSnapshot(), {
			idPrefix: this.getA11yId("time-buoy"),
		});
		this.timeBuoyPanelEl = result.panelEl;
		this.timeBuoyRenderItems = result.items;
		this.renderNextTimeBuoyBatch(generation, this.getInitialCardBatchSize());
		this.syncCardMenuState();
	}

	private renderNextTimeBuoyBatch(generation: number, batchSize = CARD_BATCH_SIZE): void {
		const panel = this.timeBuoyPanelEl;
		if (
			panel === null
			|| generation !== this.renderGeneration
			|| this.timeBuoyBatchFrameId !== null
			|| this.timeBuoyRenderedCount >= this.timeBuoyRenderItems.length
		) {
			return;
		}
		this.removeTimeBuoyLoadMore();
		const start = this.timeBuoyRenderedCount;
		const end = Math.min(start + batchSize, this.timeBuoyRenderItems.length);
		const items = this.timeBuoyRenderItems.slice(start, end);
		const synchronousCount = Platform.isMobile
			? Math.min(MOBILE_INITIAL_SYNC_CARD_COUNT, items.length)
			: items.length;
		this.appendTimeBuoyBatchItems(panel, items.slice(0, synchronousCount), start, generation);
		if (synchronousCount >= items.length) {
			this.finishTimeBuoyBatch(end, generation);
			return;
		}
		let offset = synchronousCount;
		const continueBatch = (): void => {
			this.timeBuoyBatchFrameId = null;
			if (generation !== this.renderGeneration || panel !== this.timeBuoyPanelEl) {
				return;
			}
			const nextOffset = Math.min(offset + MOBILE_CARD_FRAME_CHUNK_SIZE, items.length);
			this.appendTimeBuoyBatchItems(panel, items.slice(offset, nextOffset), start + offset, generation);
			offset = nextOffset;
			if (offset < items.length) {
				this.timeBuoyBatchFrameId = this.containerEl.win.requestAnimationFrame(continueBatch);
				return;
			}
			this.finishTimeBuoyBatch(end, generation);
		};
		this.timeBuoyBatchFrameId = this.containerEl.win.requestAnimationFrame(continueBatch);
	}

	private appendTimeBuoyBatchItems(
		panel: HTMLElement,
		items: readonly TimeBuoyTabItem[],
		renderIndexStart: number,
		generation: number,
	): void {
		appendTimeBuoyItems(panel, items, renderIndexStart, (container, item, renderIndex) => {
			const today = formatTimeBuoyDate(new Date());
			const status = item.primaryTargetDate === today
				? "today"
				: item.primaryTargetDate > today ? "upcoming" : "past";
			const label = item.primaryTargetDate === today
				? t("timeBuoy.surfacedToday", { date: item.primaryTargetDate })
				: t("timeBuoy.badge.single", { date: item.primaryTargetDate });
			this.renderMemoCardInContainer(
				container,
				item.memo,
				generation,
				renderIndex,
				true,
				false,
				"card-flow",
				null,
				null,
				{ status, label },
			);
		});
	}

	private finishTimeBuoyBatch(renderedCount: number, generation: number): void {
		if (generation !== this.renderGeneration) {
			return;
		}
		this.timeBuoyRenderedCount = renderedCount;
		this.renderTimeBuoyLoadMore(generation);
	}

	private renderTimeBuoyLoadMore(generation: number): void {
		const panel = this.timeBuoyPanelEl;
		const remainingCount = this.timeBuoyRenderItems.length - this.timeBuoyRenderedCount;
		if (panel === null || remainingCount <= 0) {
			return;
		}
		const button = renderKnomoLoadMoreButton(panel, {
			remainingCount,
			action: "load-more-time-buoy-cards",
			extraClass: "knomo-time-buoy-load-more",
			sentinel: true,
		});
		const Observer = (this.containerEl.win as WindowWithIntersectionObserver).IntersectionObserver;
		if (Observer === undefined || this.cardFlowEl === null) {
			return;
		}
		this.timeBuoyLoadMoreObserver = new Observer((entries) => {
			if (entries.some((entry) => entry.isIntersecting)) {
				this.renderNextTimeBuoyBatch(generation);
			}
		}, { root: this.cardFlowEl, rootMargin: "240px 0px" });
		this.timeBuoyLoadMoreObserver.observe(button);
	}

	private removeTimeBuoyLoadMore(): void {
		this.timeBuoyLoadMoreObserver?.disconnect();
		this.timeBuoyLoadMoreObserver = null;
		this.timeBuoyPanelEl?.querySelector<HTMLElement>(".knomo-time-buoy-load-more")?.remove();
	}

	private resetTimeBuoyCardFlow(): void {
		if (this.timeBuoyBatchFrameId !== null) {
			this.containerEl.win.cancelAnimationFrame(this.timeBuoyBatchFrameId);
			this.timeBuoyBatchFrameId = null;
		}
		this.removeTimeBuoyLoadMore();
		this.timeBuoyPanelEl = null;
		this.timeBuoyRenderItems = [];
		this.timeBuoyRenderedCount = 0;
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
		if (this.activeNav === "time-buoy") {
			this.renderTimeBuoyPage();
			this.restoreCardFlowScrollTop(scrollTop);
			return;
		}
		this.resetTimeBuoyCardFlow();
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
		const todayItems = this.getTodayTimeBuoyItems();
		const memos = shouldLoadListMemos
			? mergeTodayTimeBuoyFeed(this.getFilteredMemos(), todayItems)
			: [];
		let presentation = getCardFlowPresentation({
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
		if (presentation.type === "empty" && this.shouldShowTimeBuoyIntro() && this.cardFlowError === null) {
			presentation = { type: "items", memos: [], mode: "memo", headers: [] };
		}
		if (this.cardFlowError === null && this.activeNav !== "trash") {
			const headers = getCatalogReadStatusHeaders({
				status: this.catalogStatus,
				coverage: this.catalogCoverage,
			});
			if (headers.length === 0) return presentation;
			return presentation.type === "items"
				? { ...presentation, headers: [...headers, ...presentation.headers] }
				: { type: "items", memos: [], mode: "memo", headers };
		}
		return presentation;
	}

	private getTodayTimeBuoyItems() {
		if (!this.shouldShowTodayTimeBuoys()) {
			return [];
		}
		return this.timeBuoyViewController.getSnapshot().today;
	}

	private shouldShowTodayTimeBuoys(): boolean {
		return this.settingsService.getSettings().timeBuoyEnabled && this.isDefaultListState();
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
		this.renderHistoryLoadMore();
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
				for (const card of child.findAll(".knomo-card")) {
					this.removeCardImageTargets(card);
				}
				child.remove();
			}
		}

		const existingCards = new Map(
			this.getDirectCardElements(cardFlow)
				.map((card) => [card.getAttr("data-memo-render-key") ?? card.getAttr("data-memo-id"), card] as const)
				.filter((entry): entry is [string, HTMLElement] => entry[0] !== null),
		);
		const pendingVisibleCount = this.cardFlowCoordinator.getPendingVisibleCount(this.renderGeneration);
		const visibleCount = Math.min(
			presentation.memos.length,
			Math.max(this.getInitialCardBatchSize(), existingCards.size, pendingVisibleCount ?? 0),
		);
		const visibleMemos = presentation.memos.slice(0, visibleCount);
		const desiredKeys = new Set(visibleMemos.map(getMemoRenderKey));
		const renderedCards: HTMLElement[] = [];

		for (const [index, memo] of visibleMemos.entries()) {
			const renderKey = getMemoRenderKey(memo);
			const existingCard = existingCards.get(renderKey) ?? null;
			const previousMemo = this.renderedCardMemos.get(renderKey) ?? null;
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
			this.renderedCardMemos.set(renderKey, memo);
			renderedCards.push(card);
		}

		for (const [renderKey, card] of existingCards) {
			if (!desiredKeys.has(renderKey)) {
				this.removeCardElement(card);
				this.renderedCardMemos.delete(renderKey);
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
		const intro = this.renderTimeBuoyIntro(cardFlow);
		if (intro !== null) {
			cardFlow.prepend(intro);
		}
		this.cardFlowCoordinator.syncBatch(presentation.memos, presentation.mode, visibleMemos.length);
		this.renderCardFlowSentinelIfNeeded();
		this.renderHistoryLoadMore();
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
				this.renderHistoryLoadMore();
			}
			this.restorePendingCardFlowScrollTop(generation);
			return;
		}
		if (presentation.type === "onboarding") {
			this.renderCatalogOnboarding(presentation);
			this.restorePendingCardFlowScrollTop(generation);
			return;
		}
		if (this.cardFlowEl === null) {
			return;
		}
		this.renderTimeBuoyIntro(this.cardFlowEl);
		renderKnomoCardFlowHeaders(this.cardFlowEl, presentation.headers);
		this.startCardFeed(presentation.memos, presentation.mode, generation, initialBatchSize);
	}

	private shouldShowTimeBuoyIntro(): boolean {
		const settings = this.settingsService.getSettings();
		return !settings.timeBuoyEnabled && settings.timeBuoyIntroDismissed !== true && this.isDefaultListState();
	}

	private renderTimeBuoyIntro(container: HTMLElement): HTMLElement | null {
		if (!this.shouldShowTimeBuoyIntro()) {
			return null;
		}
		const intro = container.createEl("aside", { cls: "knomo-time-buoy-intro" });
		intro.createDiv({ text: t("timeBuoy.intro") });
		const actions = intro.createDiv({ cls: "knomo-time-buoy-intro-actions" });
		actions.createEl("button", {
			cls: "mod-cta knomo-inline-button",
			text: t("timeBuoy.intro.enable"),
			attr: { type: "button", "data-action": "enable-time-buoy-intro" },
		});
		actions.createEl("button", {
			cls: "knomo-inline-button",
			text: t("timeBuoy.intro.dismiss"),
			attr: { type: "button", "data-action": "dismiss-time-buoy-intro" },
		});
		return intro;
	}

	private async enableTimeBuoyFromIntro(): Promise<void> {
		await this.settingsService.updateSettings({ timeBuoyEnabled: true, timeBuoyIntroDismissed: true });
		await this.render();
		await this.timeBuoyViewController.loadTodayOnly();
		new Notice(t("settings.timeBuoy.enabled"));
	}

	private async dismissTimeBuoyIntro(): Promise<void> {
		await this.settingsService.updateSettings({ timeBuoyIntroDismissed: true });
		this.forceRebuildCardFlow();
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
		this.renderCardBatch(batch, generation);
	}

	private renderCardBatch(
		batch: ReturnType<KnomoCardFlowCoordinator["beginNextBatch"]>,
		generation: number,
	): void {
		this.cardFlowCoordinator.renderBatch({
			batch,
			generation,
			isMobile: Platform.isMobile,
			syncItemLimit: MOBILE_INITIAL_SYNC_CARD_COUNT,
			chunkSize: MOBILE_CARD_FRAME_CHUNK_SIZE,
			hydrateWhenExhausted: false,
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
			requestHydration: () => undefined,
			restorePendingScrollTop: (scrollTop) => this.restoreCardFlowScrollTop(scrollTop),
			scheduleContinuation: (continuation) => this.scheduleMobileCardBatchContinuation(continuation),
			onExhausted: () => this.renderHistoryLoadMore(),
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
		this.renderedCardMemos.set(getMemoRenderKey(memo), memo);
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
		timeBuoy?: MemoCardTimeBuoy,
	): HTMLElement {
		const { deletedMemoIds } = this.trashMemoController.getSnapshot();
		const effectiveTimeBuoy = timeBuoy ?? this.getVisibleMemoTimeBuoy(memo);
		return renderKnomoMemoCard(container, memo, {
			generation,
			renderIndex,
			includeActions,
			randomCard,
			timeBuoy: effectiveTimeBuoy,
			activeMenuMemoId: this.activeMenuMemoId,
			deletedMemoIds,
			formatDisplayTime: formatMemoDisplayTime,
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

	private getVisibleMemoTimeBuoy(memo: MemoRecord): MemoCardTimeBuoy | undefined {
		if (!this.settingsService.getSettings().timeBuoyEnabled || memo.status !== "active") {
			return undefined;
		}
		const dates = extractTimeBuoyDates(memo.contentSnapshot);
		const status = getTimeBuoyCardStatus(dates);
		if (status === null) {
			return undefined;
		}
		const label = dates.length === 1
			? t("timeBuoy.badge.single", { date: dates[0] })
			: t("timeBuoy.badge.multiple", { count: dates.length });
		return { status, label };
	}

	private renderTrashMemoCard(memo: MemoRecord, generation: number, renderIndex: number): void {
		if (this.cardFlowEl === null) {
			return;
		}
		this.renderTrashMemoCardInContainer(this.cardFlowEl, memo, generation, renderIndex);
		this.renderedCardMemos.set(getMemoRenderKey(memo), memo);
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
			this.memoCardPreviewCache.get(memo, getMemoDisplayContent(memo)),
			memo.dailyRef.path,
			this.app,
			this.imageResourceCache,
		);
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
		this.refreshCatalogActiveQuery();
	}

	private renderCatalogOnboarding(presentation: Extract<CardFlowPresentation, { type: "onboarding" }>): void {
		if (this.cardFlowEl === null) return;
		this.cardFlowCoordinator.setPendingScrollRestore(null);
		this.cardFlowCoordinator.resetFlowRuntime(this.containerEl.win);
		this.cardFlowEl.empty();
		this.renderedCardMemos.clear();
		const state = renderKnomoEmptyState(this.cardFlowEl, presentation.title, presentation.description);
		state.addClass("knomo-catalog-onboarding");
		state.setAttrs({ role: "status", "aria-live": "polite", "aria-atomic": "true" });
		const actions = state.createDiv({ cls: "knomo-catalog-onboarding-actions" });
		for (const action of presentation.actions) {
			actions.createEl("button", {
				cls: action.modCta === true ? "mod-cta" : undefined,
				text: action.label,
				attr: { type: "button", "data-action": action.action },
			});
		}
	}

	private async runTrashActionById(action: TrashAction, memoId: string | null): Promise<void> {
		const memo = this.trashMemoController.getSnapshot().trashMemos?.find((item) => item.id === memoId) ?? null;
		if (memo !== null) {
			await this.trashMemoController.handleTrashAction(action, memo);
		}
	}

	private async runMemoActionById(
		action: MemoAction,
		memoId: string | null,
		candidateMemoId: string | null,
	): Promise<void> {
		const memo = memoId === null ? null : this.findMemoById(memoId);
		if (memo !== null) {
			await this.handleMemoAction(action, memo, candidateMemoId);
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
		const target = event.target as Node | null;
		if (
			this.timeBuoyPickerState !== null
			&& !this.timeBuoyPickerState.mobile
			&& target !== null
			&& !this.timeBuoyPickerEl?.contains(target)
			&& !this.timeBuoyButtonEl?.contains(target)
		) {
			this.closeTimeBuoyPicker(false);
		}
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
		this.refreshCatalogActiveQuery();
	}

	private async handleRootKeydown(event: KeyboardEvent): Promise<void> {
		if (event.key === "Escape" && this.timeBuoyPickerState !== null) {
			event.preventDefault();
			event.stopPropagation();
			this.closeTimeBuoyPicker(true);
			return;
		}
		if (this.handleTimeBuoyTabKeydown(event)) {
			return;
		}
		await this.userActionController.handleRootKeydown(event);
	}

	private handleTimeBuoyTabKeydown(event: KeyboardEvent): boolean {
		if (!isTimeBuoyTabNavigationKey(event.key)) {
			return false;
		}
		const target = event.target as Node | null;
		if (target === null || !target.instanceOf(Element)) {
			return false;
		}
		const tab = target.closest<HTMLElement>(".knomo-time-buoy-tab");
		const tabList = tab?.closest<HTMLElement>(".knomo-time-buoy-tabs") ?? null;
		if (tab === null || tabList === null) {
			return false;
		}
		const tabs = tabList.findAll(".knomo-time-buoy-tab");
		const currentIndex = tabs.indexOf(tab);
		if (currentIndex < 0 || tabs.length === 0) {
			return false;
		}
		const nextIndex = event.key === "Home"
			? 0
			: event.key === "End"
				? tabs.length - 1
				: event.key === "ArrowRight"
					? (currentIndex + 1) % tabs.length
					: (currentIndex - 1 + tabs.length) % tabs.length;
		const nextTab = tabs[nextIndex];
		const nextValue = nextTab?.getAttr("data-time-buoy-tab");
		if (nextTab === undefined || !isTimeBuoyTab(nextValue)) {
			return false;
		}
		event.preventDefault();
		this.setTimeBuoyTabFromAction(nextValue);
		this.cardFlowEl
			?.querySelector<HTMLElement>(`.knomo-time-buoy-tab[data-time-buoy-tab="${nextValue}"]`)
			?.focus();
		return true;
	}

	private async resolveCatalogMemo(memo: MemoRecord): Promise<NonNullable<MemoViewItem["catalog"]>> {
		if (isCatalogMemoView(memo)) return memo.catalog;
		throw new Error("The current memo source changed; refresh and retry.");
	}

	private async handleMemoAction(action: MemoAction, memo: MemoRecord, candidateMemoId: string | null): Promise<void> {
		this.closeCardMenu();
		const shouldCloseMobileSearch = this.currentLayout === "mobile" && this.mobileSearchPageOpen;
		try {
			if (action === "confirm-identity") {
				if (!isCatalogMemoView(memo) || candidateMemoId === null) {
					throw new Error("Identity confirmation is unavailable for this memo.");
				}
				await this.memoCommandService.repairIdentity(memo.catalog, candidateMemoId);
				await this.reloadMemos(false);
				new Notice(t("notice.identityConfirmed"));
				return;
			} else if (action === "mark-reviewed") {
				await this.randomReunionController.markReviewed(memo.id);
				new Notice(t("notice.markedReviewed"));
				this.syncCardMenuState();
				return;
			} else if (action === "edit") {
				this.startEditing(memo);
				this.syncCardMenuState();
				return;
			} else if (action === "reference") {
				const reference = await this.memoCommandService.createReferenceText(
					await this.resolveCatalogMemo(memo),
				);
				this.startReferenceMemo(memo, reference.text, reference.memoId);
				this.syncCardMenuState();
				return;
			} else if (action === "open-daily") {
				if (this.activeNav === "random") {
					await this.randomReunionController.openMemo(memo.id);
					return;
				}
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
				const reference = await this.memoCommandService.createReferenceText(
					await this.resolveCatalogMemo(memo),
				);
				await this.copyText(reference.text);
				new Notice(t("notice.copiedLink"));
				this.syncCardMenuState();
				return;
			} else if (action === "delete") {
				const deleteMode = getMemoDeleteMode(memo);
				const resolvedMemo = await this.resolveCatalogMemo(memo);
				if (deleteMode === "permanent") {
					if (!await this.confirmPermanentDelete()) return;
					await this.memoCommandService.removePermanently(resolvedMemo);
				} else if (deleteMode === "recoverable") {
					await this.memoCommandService.delete(resolvedMemo);
				} else {
					throw new Error("Memo delete is unavailable.");
				}
				await this.reloadMemos(false).catch(() => false);
				new Notice(t("notice.deleted"));
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
		this.closeTimeBuoyPicker(false);

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
		const submittedEditingMemo = this.editingMemo;
		const submittedQuoteSourceMemoId = this.quoteSourceMemoId;
		const submittedQuoteReferenceText = this.quoteReferenceText;
		const submittedQuoteMarkdownText = this.quoteMarkdownText;
		let composerCleared = false;
		const clearSavedComposer = (): void => {
			if (composerCleared) return;
			if (this.inputEl !== null && this.inputEl.value !== input) return;
			if (this.editingMemo !== submittedEditingMemo
				|| this.quoteSourceMemoId !== submittedQuoteSourceMemoId
				|| this.quoteReferenceText !== submittedQuoteReferenceText
				|| this.quoteMarkdownText !== submittedQuoteMarkdownText) return;
			composerCleared = true;
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
		};

		this.isSaving = true;
		this.updateStatus("", false);
		this.updateSendButtonState();
		try {
			let operation: MemoSaveOperation;
			if (preparedInput.type === "update") {
				operation = this.memoCommandService.startEdit(
					await this.resolveCatalogMemo(preparedInput.previousMemo),
					preparedInput.content,
				);
			} else {
				operation = this.memoCommandService.startCreate(preparedInput.content, preparedInput.sourceMemoId);
			}
			await operation.dailyCommitted;
			clearSavedComposer();
			this.queueComposerSaveFinish(
				operation.settled,
				extractTimeBuoyDates(preparedInput.content),
				isMobileSave,
				mobileScrollTop,
			);
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

	private showTimeBuoySaveFeedback(dates: readonly string[]): void {
		if (dates.length === 0) {
			return;
		}
		new Notice(dates.length === 1
			? t("timeBuoy.saved.single", { date: dates[0] })
			: t("timeBuoy.saved.multiple", { count: dates.length }));
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
		this.refreshCatalogActiveQuery();
	}

	private confirmPermanentDelete(): Promise<boolean> {
		return showKnomoConfirmModal(this.app, {
			title: t("card.delete"),
			message: t("confirm.deleteMemoPermanently"),
			danger: true,
			getReturnFocus: getDestructiveConfirmReturnFocus,
		});
	}

	private async refreshCatalogLibraryIndexes(): Promise<void> {
		const run = ++this.libraryIndexRun;
		const revision = this.catalogRevision;
		this.renderStats();
		this.renderTags();
		try {
			const [summary, facets] = await Promise.all([
				this.getCatalogReadService().getLibrarySummary(),
				this.getCatalogReadService().getTagFacets(),
			]);
			if (run !== this.libraryIndexRun || revision !== this.catalogRevision) return;
			if (summary.complete && facets.complete && summary.value !== null && facets.value !== null) {
				this.librarySummary = summary.value;
				this.libraryTagFacets = facets.value;
				this.libraryIndexRevision = revision;
			} else {
				this.librarySummary = null;
				this.libraryTagFacets = null;
			}
		} catch {
			if (run !== this.libraryIndexRun || revision !== this.catalogRevision) return;
			this.librarySummary = null;
			this.libraryTagFacets = null;
		} finally {
			if (run === this.libraryIndexRun) {
				this.renderStats();
				this.renderTags();
			}
		}
	}

	private setSearchQuery(query: string): void {
		const previousViewStateKey = this.getCardFlowViewStateKey();
		this.clearSearchDebounce();
		this.applyViewStateTransitionEffects(this.viewStateController.setSearchQuery(query));
		this.renderFilteredListState(false, this.getCardFlowChangeIntent(previousViewStateKey));
		this.refreshCatalogActiveQuery();
	}

	private setSearchDateFilter(filter: SearchDateFilter, sourceEl: HTMLElement | null = null): void {
		const previousViewStateKey = this.getCardFlowViewStateKey();
		this.flushDesktopSearchQuery(sourceEl);
		this.applyViewStateTransitionEffects(this.viewStateController.setSearchDateFilter(filter));
		if (this.currentLayout !== "mobile") {
			this.syncRootState();
		}
		this.renderFilteredListState(false, this.getCardFlowChangeIntent(previousViewStateKey));
		this.refreshCatalogActiveQuery();
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

	private refreshCatalogActiveQuery(): void {
		void this.reloadMemos(false, true);
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
		const shouldDeferReview = result.reloadCatalogQuery && this.shouldDeferCardFlowForAllMemos();
		this.renderUiState({
			renderCardFlow: !shouldDeferReview,
			cardFlowChangeIntent: this.getCardFlowChangeIntent(previousViewStateKey),
		});
		if (shouldDeferReview) {
			this.renderAllMemosLoadingState();
		}
		if (result.reloadCatalogQuery) {
			void this.reloadCurrentCatalogQuery();
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
		if (nav === "time-buoy") {
			void this.timeBuoyViewController.loadInitial();
		}
		if (result.prepareRecordStats) {
			void this.prepareRecordStats();
		}
	}

	private setTimeBuoyTabFromAction(tab: TimeBuoyTab): void {
		if (this.activeNav !== "time-buoy") {
			return;
		}
		this.restoreCardFlowScrollTop(0);
		this.timeBuoyViewController.setActiveTab(tab);
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
		const shouldDeferReview = result.reloadCatalogQuery && this.shouldDeferCardFlowForAllMemos();
		this.renderUiState({
			renderCardFlow: !shouldDeferReview,
			cardFlowChangeIntent: this.getCardFlowChangeIntent(previousViewStateKey),
		});
		if (shouldDeferReview) {
			this.renderAllMemosLoadingState();
		}
		if (result.reloadCatalogQuery) {
			void this.reloadCurrentCatalogQuery();
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
			void this.ensureCurrentMemoDataRequirement();
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
		return false;
	}

	private async ensureCurrentMemoDataRequirement(): Promise<boolean> {
		return this.reloadCurrentCatalogQuery();
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
	}

	private closeComposerKeepingDraft(): void {
		this.closeTimeBuoyPicker(false);
		if (this.currentLayout === "mobile") {
			this.closeMobileComposerKeepingDraft();
			return;
		}
		if (this.inputEl !== null) {
			this.draftContent = getDraftForComposerClose(
				this.inputEl.value,
				getComposerMode(this.editingMemo, this.quoteReferenceText),
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
		this.closeTimeBuoyPicker(false);
		if (this.inputEl !== null) {
			this.draftContent = getDraftForComposerClose(
				this.inputEl.value,
				getComposerMode(this.editingMemo, this.quoteReferenceText),
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

	private cancelComposerFromEscape(): void {
		if (this.currentLayout === "mobile") {
			this.closeComposerKeepingDraft();
			return;
		}
		if (this.editingMemo !== null || this.quoteReferenceText !== null) {
			this.clearComposerMode();
		}
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
		this.closeTimeBuoyPicker(false);
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

	private startReferenceMemo(memo: MemoRecord, referenceText: string, sourceMemoId: string | null = null): void {
		this.editingMemo = null;
		this.quoteSourceMemoId = sourceMemoId;
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
			if (this.timeBuoyPickerState !== null) {
				this.closeTimeBuoyPicker(true);
				return;
			}
			this.cancelComposerFromEscape();
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
		if (action === "insert-time-buoy") {
			this.toggleTimeBuoyPickerFromButton();
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

	private toggleTimeBuoyPickerFromButton(): void {
		if (this.timeBuoyPickerState?.source === "button") {
			this.closeTimeBuoyPicker(true);
			return;
		}
		const input = this.inputEl;
		if (
			input === null
			|| input.disabled
			|| this.isSaving
			|| !this.settingsService.getSettings().timeBuoyEnabled
		) {
			return;
		}
		if (this.composerIsComposing) {
			this.pendingTimeBuoyButtonOpenAfterComposition = true;
			input.blur();
			return;
		}
		this.openTimeBuoyPicker("button", null);
	}

	private openTimeBuoyPicker(source: TimeBuoyPickerSource, triggerStart: number | null): void {
		const input = this.inputEl;
		if (input === null || input.disabled || this.isSaving) {
			return;
		}
		this.closeTimeBuoyPicker(false);
		this.tagSuggest?.close();
		this.wikiLinkSuggest?.close();
		this.closeCardMenu();
		this.scopeMenuOpen = false;
		this.desktopSearchOpen = false;
		this.compactSearchOpen = false;
		const today = new Date();
		const browseMonth = this.timeBuoyBrowseMonth ?? today;
		const mobile = this.currentLayout === "mobile";
		const state: OpenTimeBuoyPickerState = {
			source,
			phase: mobile ? "preparing" : "open",
			savedValue: input.value,
			selectionEnd: input.selectionEnd,
			triggerStart,
			triggerEnd: triggerStart === null ? null : triggerStart + 1,
			browseYear: browseMonth.getFullYear(),
			browseMonth: browseMonth.getMonth(),
			mobile,
		};
		this.timeBuoyPickerState = state;
		this.composerEl?.addClass("is-time-buoy-picker-open");
		this.renderTimeBuoyPicker();
		if (mobile) {
			this.timeBuoyPickerKeyboardWaitCancel = this.mobileComposerController.waitForKeyboardDismissal(() => {
				this.timeBuoyPickerKeyboardWaitCancel = null;
				this.revealMobileTimeBuoyPicker(state);
			});
			input.blur();
		}
	}

	private renderTimeBuoyPicker(): void {
		const state = this.timeBuoyPickerState;
		const composer = this.composerEl;
		if (state === null || composer === null) {
			return;
		}
		this.clearTimeBuoyPickerEventListeners();
		this.timeBuoyPickerEl?.remove();
		this.timeBuoyPickerBackdropEl?.remove();
		this.timeBuoyPickerEl = null;
		this.timeBuoyPickerBackdropEl = null;
		const isModal = state.mobile;
		if (isModal && this.timeBuoyPickerBackdropEl === null) {
			const backdropHost = composer.closest<HTMLElement>(".knomo-mobile-composer-stage") ?? composer;
			this.timeBuoyPickerBackdropEl = backdropHost.createDiv({
				cls: "knomo-time-buoy-picker-backdrop",
				attr: { "aria-hidden": "true" },
			});
			this.timeBuoyPickerBackdropEl.toggleClass("is-preparing", state.phase === "preparing");
			this.timeBuoyPickerBackdropEl.toggleClass("is-open", state.phase === "open");
			this.timeBuoyPickerBackdropEl.toggleClass("is-closing", state.phase === "closing");
			this.addTimeBuoyPickerEvent(this.timeBuoyPickerBackdropEl, "click", (event) => {
				event.preventDefault();
				event.stopPropagation();
				this.closeTimeBuoyPicker(true);
			});
		}
		const pickerId = this.timeBuoyButtonEl?.getAttr("aria-controls") ?? this.getA11yId("time-buoy-picker");
		const picker = renderTimeBuoyDatePicker(composer, pickerId, {
			source: state.source,
			mobile: state.mobile,
			browseYear: state.browseYear,
			browseMonth: state.browseMonth,
			today: new Date(),
		});
		this.timeBuoyPickerEl = picker;
		if (state.mobile) {
			picker.toggleClass("is-preparing", state.phase === "preparing");
			picker.toggleClass("is-open", state.phase === "open");
			picker.toggleClass("is-closing", state.phase === "closing");
			picker.setAttr("aria-hidden", state.phase === "open" ? "false" : "true");
		}
		this.timeBuoyButtonEl?.setAttr("aria-expanded", state.phase === "open" ? "true" : "false");
		if (state.source === "at-input" && !state.mobile) {
			const keepTextareaFocused = (event: PointerEvent | MouseEvent): void => {
				const target = event.target as Node | null;
				if (!target?.instanceOf(Element) || target.closest("button") === null) {
					return;
				}
				event.preventDefault();
				event.stopPropagation();
			};
			this.addTimeBuoyPickerEvent(picker, "pointerdown", keepTextareaFocused);
			this.addTimeBuoyPickerEvent(picker, "mousedown", keepTextareaFocused);
		}
		if (!state.mobile) {
			this.positionDesktopTimeBuoyPicker(picker);
		}
		this.addTimeBuoyPickerEvent(picker, "click", (event) => this.handleTimeBuoyPickerClick(event));
		this.addTimeBuoyPickerEvent(picker, "keydown", (event) => this.handleTimeBuoyPickerKeydown(event));
		if (state.source === "button" && !state.mobile) {
			this.focusDefaultTimeBuoyPickerButton(picker);
		}
	}

	private revealMobileTimeBuoyPicker(state: OpenTimeBuoyPickerState): void {
		const picker = this.timeBuoyPickerEl;
		const backdrop = this.timeBuoyPickerBackdropEl;
		if (
			this.timeBuoyPickerState !== state
			|| state.phase !== "preparing"
			|| this.currentLayout !== "mobile"
			|| !this.composerOpen
			|| picker === null
			|| backdrop === null
		) {
			this.closeTimeBuoyPicker(false);
			return;
		}
		state.phase = "open";
		picker.removeClass("is-preparing");
		picker.addClass("is-open");
		picker.setAttr("aria-hidden", "false");
		backdrop.removeClass("is-preparing");
		backdrop.addClass("is-open");
		this.timeBuoyButtonEl?.setAttr("aria-expanded", "true");
		this.clearTimeBuoyPickerFocusFrame();
		this.timeBuoyPickerFocusFrameId = this.containerEl.win.requestAnimationFrame(() => {
			this.timeBuoyPickerFocusFrameId = null;
			if (this.timeBuoyPickerState === state && state.phase === "open") {
				this.focusDefaultTimeBuoyPickerButton(picker);
			}
		});
	}

	private focusDefaultTimeBuoyPickerButton(picker: HTMLElement): void {
		const focusTarget = picker.querySelector<HTMLButtonElement>(".knomo-time-buoy-picker-day.is-today:not(:disabled)")
			?? picker.querySelector<HTMLButtonElement>(".knomo-time-buoy-picker-day:not(:disabled)")
			?? picker.querySelector<HTMLButtonElement>("button:not(:disabled)");
		focusTarget?.focus();
	}

	private positionDesktopTimeBuoyPicker(picker: HTMLElement): void {
		const composer = this.composerEl;
		const state = this.timeBuoyPickerState;
		const input = this.inputEl;
		const anchor = state?.source === "button" ? this.timeBuoyButtonEl : input;
		if (composer === null || input === null || anchor === null) {
			return;
		}
		const composerRect = composer.getBoundingClientRect();
		const anchorRect = state?.source === "at-input"
			? getTextareaCharacterRect(input, state.triggerStart ?? input.selectionStart)
				?? input.getBoundingClientRect()
			: anchor.getBoundingClientRect();
		const pickerRect = picker.getBoundingClientRect();
		const composerLeft = composerRect.left + composer.clientLeft;
		const left = getTimeBuoyPickerLeft(
			composer.clientWidth,
			anchorRect.left - composerLeft,
			pickerRect.width,
		);
		const availableAbove = Math.max(160, anchorRect.top - 12);
		const availableBelow = Math.max(160, this.containerEl.win.innerHeight - anchorRect.bottom - 12);
		const isBelow = availableAbove < pickerRect.height && availableBelow > availableAbove;
		picker.setCssProps({
			"--knomo-time-buoy-picker-left": `${left}px`,
			"--knomo-time-buoy-picker-max-height": `${isBelow ? availableBelow : availableAbove}px`,
			"--knomo-time-buoy-picker-top": `${Math.round(anchorRect.bottom - composerRect.top + 8)}px`,
			"--knomo-time-buoy-picker-bottom": `${Math.round(composerRect.bottom - anchorRect.top + 8)}px`,
		});
		picker.toggleClass("is-below", isBelow);
	}

	private handleTimeBuoyPickerClick(event: MouseEvent): void {
		const target = event.target as Node | null;
		if (!target?.instanceOf(Element)) {
			return;
		}
		const actionEl = target.closest<HTMLElement>("[data-time-buoy-picker-action]");
		const dateEl = target.closest<HTMLElement>("[data-time-buoy-date]");
		if (actionEl === null && dateEl === null) {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		const action = actionEl?.getAttr("data-time-buoy-picker-action");
		if (action === "cancel") {
			this.closeTimeBuoyPicker(true);
			return;
		}
		if (action === "previous-month" || action === "next-month") {
			this.changeTimeBuoyPickerMonth(action === "previous-month" ? -1 : 1);
			return;
		}
		const date = dateEl?.getAttr("data-time-buoy-date");
		const state = this.timeBuoyPickerState;
		if (date === null || date === undefined || state === null) {
			return;
		}
		this.submitTimeBuoyDate(date);
	}

	private handleTimeBuoyPickerKeydown(event: KeyboardEvent): void {
		const picker = this.timeBuoyPickerEl;
		const state = this.timeBuoyPickerState;
		if (picker === null || state === null) {
			return;
		}
		if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			this.closeTimeBuoyPicker(true);
			return;
		}
		if (event.key === "PageUp" || event.key === "PageDown") {
			event.preventDefault();
			this.changeTimeBuoyPickerMonth(event.key === "PageUp" ? -1 : 1);
			return;
		}
		if (event.key === "Tab" && state.mobile) {
			const focusable = Array.from(picker.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
			const activeIndex = focusable.indexOf(this.containerEl.doc.activeElement as HTMLButtonElement);
			const nextIndex = event.shiftKey
				? (activeIndex <= 0 ? focusable.length - 1 : activeIndex - 1)
				: (activeIndex < 0 || activeIndex === focusable.length - 1 ? 0 : activeIndex + 1);
			if (focusable[nextIndex] !== undefined) {
				event.preventDefault();
				focusable[nextIndex].focus();
			}
			return;
		}
		const target = event.target as Node | null;
		if (!target?.instanceOf(HTMLElement) || !target.hasClass("knomo-time-buoy-picker-day")) {
			return;
		}
		const offset = event.key === "ArrowLeft" ? -1
			: event.key === "ArrowRight" ? 1
				: event.key === "ArrowUp" ? -7
					: event.key === "ArrowDown" ? 7
						: 0;
		if (offset === 0) {
			return;
		}
		event.preventDefault();
		const days = Array.from(picker.querySelectorAll<HTMLButtonElement>(".knomo-time-buoy-picker-day"));
		let nextIndex = days.indexOf(target as HTMLButtonElement) + offset;
		while (nextIndex >= 0 && nextIndex < days.length && days[nextIndex].disabled) {
			nextIndex += offset > 0 ? 1 : -1;
		}
		days[nextIndex]?.focus();
	}

	private changeTimeBuoyPickerMonth(offset: number): void {
		const state = this.timeBuoyPickerState;
		if (state === null) {
			return;
		}
		const month = new Date(state.browseYear, state.browseMonth + offset, 1);
		const current = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
		if (month < current) {
			return;
		}
		state.browseYear = month.getFullYear();
		state.browseMonth = month.getMonth();
		this.timeBuoyBrowseMonth = month;
		this.renderTimeBuoyPicker();
		const monthLabel = this.timeBuoyPickerEl?.find(".knomo-time-buoy-picker-month-label");
		this.timeBuoyMonthStatusEl?.setText(monthLabel?.getText() ?? "");
	}

	private submitTimeBuoyDate(targetDate: string): void {
		const state = this.timeBuoyPickerState;
		const input = this.inputEl;
		if (state === null || input === null) {
			return;
		}
		if (alreadyHasTimeBuoyDate(input.value, targetDate)) {
			new Notice(t("timeBuoy.duplicate"));
			return;
		}
		const insertion = state.source === "at-input"
			? replaceTimeBuoyTrigger(input.value, state.triggerStart ?? -1, state.triggerEnd ?? -1, targetDate)
			: insertTimeBuoyDateAtSelection(
				input.value,
				input.value === state.savedValue ? state.selectionEnd : input.selectionEnd,
				targetDate,
			);
		if (insertion === null) {
			this.closeTimeBuoyPicker(true);
			new Notice(t("timeBuoy.picker.triggerChanged"));
			return;
		}
		this.suppressTimeBuoyAutoOpen = true;
		input.value = insertion.value;
		input.setSelectionRange(insertion.cursor, insertion.cursor);
		try {
			dispatchTextareaInputEvent(input);
		} finally {
			this.suppressTimeBuoyAutoOpen = false;
		}
		this.closeTimeBuoyPicker(true, "input");
	}

	private closeTimeBuoyPicker(
		restoreFocus: boolean,
		focusTarget: TimeBuoyPickerFocusTarget = "default",
	): void {
		const state = this.timeBuoyPickerState;
		this.pendingTimeBuoyButtonOpenAfterComposition = false;
		if (
			state !== null
			&& state.mobile
			&& state.phase === "open"
			&& restoreFocus
			&& this.currentLayout === "mobile"
			&& this.composerOpen
			&& this.timeBuoyPickerEl !== null
		) {
			this.beginMobileTimeBuoyPickerClose(state, focusTarget);
			return;
		}
		if (state?.phase === "closing" && restoreFocus) {
			return;
		}
		this.finishTimeBuoyPickerClose(state, restoreFocus, focusTarget);
	}

	private beginMobileTimeBuoyPickerClose(
		state: OpenTimeBuoyPickerState,
		focusTarget: TimeBuoyPickerFocusTarget,
	): void {
		const picker = this.timeBuoyPickerEl;
		if (picker === null) {
			this.finishTimeBuoyPickerClose(state, true, focusTarget);
			return;
		}
		this.clearTimeBuoyPickerTransitionTasks();
		state.phase = "closing";
		picker.removeClass("is-open");
		picker.addClass("is-closing");
		picker.setAttr("aria-hidden", "true");
		this.timeBuoyPickerBackdropEl?.removeClass("is-open");
		this.timeBuoyPickerBackdropEl?.addClass("is-closing");
		this.timeBuoyButtonEl?.setAttr("aria-expanded", "false");
		const finish = (): void => this.finishTimeBuoyPickerClose(state, true, focusTarget);
		this.addTimeBuoyPickerEvent(picker, "transitionend", (event) => {
			if (event.target === picker && event.propertyName === "transform") {
				finish();
			}
		});
		this.timeBuoyPickerCloseTimerId = this.containerEl.win.setTimeout(finish, TIME_BUOY_PICKER_CLOSE_FALLBACK_MS);
	}

	private finishTimeBuoyPickerClose(
		state: OpenTimeBuoyPickerState | null,
		restoreFocus: boolean,
		focusTarget: TimeBuoyPickerFocusTarget,
	): void {
		if (this.timeBuoyPickerState !== state) {
			return;
		}
		const source = state?.source ?? null;
		this.clearTimeBuoyPickerTransitionTasks();
		this.clearTimeBuoyPickerEventListeners();
		this.timeBuoyPickerEl?.remove();
		this.timeBuoyPickerBackdropEl?.remove();
		this.timeBuoyPickerEl = null;
		this.timeBuoyPickerBackdropEl = null;
		this.timeBuoyPickerState = null;
		this.timeBuoyMonthStatusEl?.setText("");
		this.composerEl?.removeClass("is-time-buoy-picker-open");
		this.timeBuoyButtonEl?.setAttr("aria-expanded", "false");
		if (!restoreFocus) {
			return;
		}
		if (focusTarget === "input") {
			this.focusComposerInputNow();
		} else if (source === "button" && this.currentLayout !== "mobile") {
			this.timeBuoyButtonEl?.focus();
		} else {
			this.focusComposerInputNow();
		}
	}

	private clearTimeBuoyPickerTransitionTasks(): void {
		this.timeBuoyPickerKeyboardWaitCancel?.();
		this.timeBuoyPickerKeyboardWaitCancel = null;
		this.clearTimeBuoyPickerFocusFrame();
		if (this.timeBuoyPickerCloseTimerId !== null) {
			this.containerEl.win.clearTimeout(this.timeBuoyPickerCloseTimerId);
			this.timeBuoyPickerCloseTimerId = null;
		}
	}

	private clearTimeBuoyPickerFocusFrame(): void {
		if (this.timeBuoyPickerFocusFrameId === null) {
			return;
		}
		this.containerEl.win.cancelAnimationFrame(this.timeBuoyPickerFocusFrameId);
		this.timeBuoyPickerFocusFrameId = null;
	}

	private addTimeBuoyPickerEvent<K extends keyof HTMLElementEventMap>(
		element: HTMLElement,
		type: K,
		listener: (event: HTMLElementEventMap[K]) => void,
	): void {
		element.addEventListener(type, listener as EventListener);
		this.timeBuoyPickerEventCleanups.push(() => element.removeEventListener(type, listener as EventListener));
	}

	private clearTimeBuoyPickerEventListeners(): void {
		for (const cleanup of this.timeBuoyPickerEventCleanups.splice(0)) {
			cleanup();
		}
	}

	private handleTimeBuoyComposerInput(event: Event): boolean {
		if (this.suppressTimeBuoyAutoOpen || this.inputEl === null) {
			return false;
		}
		if (this.timeBuoyPickerState?.source === "at-input") {
			this.closeTimeBuoyPicker(false);
		}
		if (!this.settingsService.getSettings().timeBuoyEnabled || this.isSaving) {
			return false;
		}
		const inputEvent = this.asInputEvent(event);
		if (inputEvent === null) {
			return false;
		}
		const triggerStart = getTimeBuoyTriggerStartForDirectInput(this.inputEl.value, {
			inputType: inputEvent.inputType,
			data: inputEvent.data,
			isComposing: inputEvent.isComposing,
			selectionStart: this.inputEl.selectionStart,
			selectionEnd: this.inputEl.selectionEnd,
		});
		if (triggerStart === null) {
			return false;
		}
		this.openTimeBuoyPicker("at-input", triggerStart);
		return true;
	}

	private handleTimeBuoyCompositionEnd(event: CompositionEvent): void {
		if (this.pendingTimeBuoyButtonOpenAfterComposition) {
			this.pendingTimeBuoyButtonOpenAfterComposition = false;
			this.openTimeBuoyPicker("button", null);
			return;
		}
		const input = this.inputEl;
		if (input === null || !this.settingsService.getSettings().timeBuoyEnabled || this.isSaving) {
			return;
		}
		const triggerStart = getTimeBuoyTriggerStartAfterComposition(
			input.value,
			input.selectionStart,
			input.selectionEnd,
			event.data,
		);
		if (triggerStart !== null) {
			this.openTimeBuoyPicker("at-input", triggerStart);
		}
	}

	private closeTimeBuoyPickerIfTriggerMoved(): void {
		const state = this.timeBuoyPickerState;
		const input = this.inputEl;
		if (
			state?.source === "at-input"
			&& input !== null
			&& (input.selectionStart !== state.triggerEnd || input.selectionEnd !== state.triggerEnd)
		) {
			this.closeTimeBuoyPicker(false);
		}
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
		if (this.handleTimeBuoyComposerInput(event)) {
			this.syncInputState();
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
		if (this.timeBuoyButtonEl !== null) {
			this.timeBuoyButtonEl.disabled = this.isSaving || this.inputEl.disabled;
		}
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
			dailyStatus: this.getDailyNotesStatus(),
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
				void this.ensureSidebarIndexes();
			}
			return;
		}
		this.toggleSidebarCollapsed();
	}

	private async ensureSidebarIndexes(): Promise<void> {
		const yieldToUi = () => new Promise<void>((resolve) => {
			this.containerEl.win.setTimeout(resolve, 0);
		});
		await this.vaultTagIndex.ensureReady(yieldToUi);
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

	private async reloadCurrentCatalogQuery(forceReload = false): Promise<boolean> {
		if (this.memoLoadingPromise !== null) {
			return this.memoLoadingPromise;
		}
		return this.runMemoLoad(() => this.reloadMemos(forceReload));
	}

	private runMemoLoad(load: () => Promise<boolean>): Promise<boolean> {
		const loadPromise = load();
		let trackedPromise: Promise<boolean>;
		trackedPromise = loadPromise.finally(() => {
			if (this.memoLoadingPromise === trackedPromise) {
				this.memoLoadingPromise = null;
			}
		});
		this.memoLoadingPromise = trackedPromise;
		return trackedPromise;
	}

	private invalidateRecordStats(): void {
		this.recordStatsPreparationController.invalidate();
		this.recordStatsService.invalidate();
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
			return this.catalogReadService.buildRecordStats(yieldToUi, isCurrent);
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

	private renderCardFlowSentinelIfNeeded(): void {
		this.cardFlowCoordinator.renderSentinelIfNeeded({
			root: this.cardFlowEl,
			Observer: (this.containerEl.win as WindowWithIntersectionObserver).IntersectionObserver,
			onIntersect: (value) => this.renderNextCardBatch(value),
		});
	}

	private renderHistoryLoadMore(): void {
		this.cardFlowEl?.querySelector(".knomo-history-load-more")?.remove();
		if (this.cardFlowEl === null || !this.canLoadOlderMemoPeriods() || this.cardFlowCoordinator.remainingCount > 0) {
			return;
		}
		this.cardFlowEl.createEl("button", {
			cls: "knomo-load-more knomo-history-load-more",
			text: t("list.loadOlder"),
			attr: {
				type: "button",
				"data-action": "load-more",
				"aria-label": t("list.loadOlder"),
			},
		});
	}

	private canLoadOlderMemoPeriods(): boolean {
		if (this.activeNav === "trash") return this.trashCursor !== null;
		return this.catalogCursor !== null
			&& this.activeNav !== "random"
			&& this.activeNav !== "shuffleDay"
			&& this.activeNav !== "time-buoy"
			&& this.activeNav !== "record-stats";
	}

	private async loadOlderMemoPeriods(): Promise<boolean> {
		return this.activeNav === "trash"
			? this.loadNextTrashPage()
			: this.loadNextCatalogPage();
	}

	private async waitForAllMemosLoading(): Promise<void> {
		if (this.memoLoadingPromise !== null) {
			await this.memoLoadingPromise;
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
		if (this.activeNav === "time-buoy") {
			const cardFlow = this.cardFlowEl;
			if (
				cardFlow !== null
				&& this.timeBuoyLoadMoreObserver === null
				&& this.timeBuoyRenderedCount < this.timeBuoyRenderItems.length
				&& cardFlow.scrollTop + cardFlow.clientHeight >= cardFlow.scrollHeight - 160
			) {
				this.renderNextTimeBuoyBatch(this.renderGeneration);
			}
			return;
		}
		this.cardFlowCoordinator.handleScroll({
			cardFlow: this.cardFlowEl,
			isRecordStatsActive: this.activeNav === "record-stats",
			onRenderNextBatch: (generation) => this.renderNextCardBatch(generation),
			requestHydration: () => {
				void this.loadOlderMemoPeriods();
			},
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

	private async openMemoCardDailyNote(memoId: string, randomReunionCard: boolean): Promise<void> {
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
		if (randomReunionCard) {
			await this.randomReunionController.openMemo(memoId);
			return;
		}
		try {
			await openMemoDailyNoteDefault(this.app.workspace, memo);
		} catch (error) {
			const fallbackMessage = randomReunionCard ? t("error.randomOpenFailed") : t("error.openDailyFailed");
			new Notice(formatServiceError(error, fallbackMessage));
		}
	}

	private findMemoById(memoId: string): MemoRecord | null {
		return this.memos.find((memo) => memo.id === memoId)
			?? this.randomReunionController.getSnapshot().memos?.find((memo) => memo.id === memoId)
			?? this.shuffleDayController.getSnapshot().memos.find((memo) => memo.id === memoId)
			?? this.timeBuoyViewController.getMemos().find((memo) => memo.id === memoId)
			?? this.trashMemoController.getSnapshot().trashMemos?.find((memo) => memo.id === memoId)
			?? null;
	}

	private startDateChangeWatcher(): void {
		this.dateChangeWatcher.start(() => {
			this.handleLocalDateChange();
			this.startDateChangeWatcher();
		});
	}

	private handleLocalDateChange(): void {
		const nextDate = formatTimeBuoyDate(new Date());
		if (nextDate === this.lastKnownLocalDate) {
			return;
		}
		this.lastKnownLocalDate = nextDate;
		this.filteredMemosCache = null;
		this.renderUiState();
		if (this.activeNav === "review") {
			void this.reloadCurrentCatalogQuery();
		}
		if (this.activeNav === "time-buoy") {
			void this.timeBuoyViewController.loadInitial();
		} else if (this.settingsService.getSettings().timeBuoyEnabled) {
			void this.timeBuoyViewController.loadTodayOnly();
		}
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
		if (isCatalogMemoView(memo)) {
			this.memoMarkdownRenderer.applyTaskCheckboxDomState(input, input.checked ? "x" : " ");
			this.enqueueCatalogTaskToggle(memo, taskIndex, input.checked);
		}
	}

	private queueComposerSaveFinish(
		settled: Promise<MemoSaveResult>,
		fallbackTimeBuoyDates: readonly string[],
		isMobileSave: boolean,
		mobileScrollTop: number | null,
	): void {
		const previous = this.composerSaveRefreshQueue ?? Promise.resolve();
		this.composerSaveRefreshQueue = previous
			.catch(() => undefined)
			.then(() => this.finishComposerSave(
				settled,
				fallbackTimeBuoyDates,
				isMobileSave,
				mobileScrollTop,
			));
		void this.composerSaveRefreshQueue.catch(() => undefined);
	}

	private async finishComposerSave(
		settled: Promise<MemoSaveResult>,
		fallbackTimeBuoyDates: readonly string[],
		isMobileSave: boolean,
		mobileScrollTop: number | null,
	): Promise<void> {
		let timeBuoyDates = fallbackTimeBuoyDates;
		try {
			const result = await settled;
			timeBuoyDates = result.timeBuoyDates;
			const reloaded = await this.reloadMemos(false);
			if (reloaded) this.updateStatus("", false);
		} catch {
			new Notice(t("catalog.savedRefreshPending"));
		} finally {
			this.showTimeBuoySaveFeedback(timeBuoyDates);
			if (isMobileSave) {
				this.restoreCardFlowScrollTop(mobileScrollTop);
				this.mobileComposerController.clearOpenScrollTop();
			}
		}
	}

	private enqueueCatalogTaskToggle(memo: MemoRecord, taskIndex: number, checked: boolean): void {
		const previous = this.taskUpdateQueues.get(memo.id) ?? Promise.resolve();
		const queued = previous.catch(() => undefined).then(async () => {
			const latestMemo = this.findMemoById(memo.id);
			const targetMemo = latestMemo !== null && isCatalogMemoView(latestMemo) ? latestMemo : memo;
			await this.handleCatalogTaskToggle(targetMemo, taskIndex, checked);
		});
		const settled = queued.catch(() => undefined).finally(() => {
			if (this.taskUpdateQueues.get(memo.id) === settled) {
				this.taskUpdateQueues.delete(memo.id);
			}
		});
		this.taskUpdateQueues.set(memo.id, settled);
		void settled;
	}

	private async loadNextTrashPage(): Promise<boolean> {
		if (this.trashCursor === null) return false;
		const page = await this.getCatalogReadService().listDeleted(CATALOG_PAGE_SIZE, this.trashCursor);
		if (this.trashIdentityRevision !== null && page.identityRevision !== this.trashIdentityRevision) {
			await this.trashMemoController.loadTrashMemos();
			return false;
		}
		this.trashCursor = page.nextCursor;
		this.trashIdentityRevision = page.identityRevision;
		this.trashMemoController.appendTrashMemos(page.items.map(toTrashMemoView), TRASH_MEMO_WINDOW_LIMIT);
		return true;
	}

	private async handleCatalogTaskToggle(memo: MemoRecord, taskIndex: number, checked: boolean): Promise<void> {
		let dailySaved = false;
		try {
			const result = await this.memoCommandService.toggleTask(await this.resolveCatalogMemo(memo), taskIndex, checked);
			dailySaved = result.status === "saved";
			if (result.memo !== null) {
				const updatedMemo = this.applySavedMemo(result.memo);
				this.memoMarkdownRenderer.syncTaskCheckboxesForMemo(
					[this.cardFlowEl, this.mobileSearchResultsEl],
					updatedMemo,
				);
			}
			await this.reloadMemos(false).catch(() => false);
		} catch {
			if (dailySaved) {
				new Notice(t("catalog.savedRefreshPending"));
				return;
			}
			this.memoMarkdownRenderer.syncTaskCheckboxesForMemo([this.cardFlowEl, this.mobileSearchResultsEl], memo as never);
			new Notice(t("task.updateFailed"));
		}
	}

	private applySavedMemo(savedMemo: NonNullable<MemoSaveResult["memo"]>): MemoRecord {
		const updatedMemo = toCatalogMemoView(savedMemo);
		const renderKey = getMemoRenderKey(updatedMemo);
		let replaced = false;
		const memos = this.memos.map((memo) => {
			if (memo.id !== updatedMemo.id && getMemoRenderKey(memo) !== renderKey) return memo;
			replaced = true;
			return updatedMemo;
		});
		if (replaced) {
			this.memos = memos;
			this.filteredMemosCache = null;
			this.invalidateMemoSearchCache();
		}
		this.timeBuoyViewController.replaceMemo(updatedMemo);
		if (this.activeNav === "shuffleDay") this.shuffleDayController.reconcileWithMemos();
		return updatedMemo;
	}

	private findMemoForTaskCheckbox(input: HTMLInputElement): MemoRecord | null {
		const memoId = input.getAttr("data-knomo-memo-id");
		if (memoId === null) {
			return null;
		}
		return this.findMemoById(memoId);
	}

	private handleMarkdownInternalLinkHover(event: MouseEvent): void {
		const linkInfo = getMarkdownInternalLinkInfo(event.target);
		if (linkInfo === null) {
			return;
		}
		this.app.workspace.trigger("hover-link", {
			event,
			source: KNOMO_VIEW_TYPE,
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
			todayDailyNotePath: this.getTodayDailyNotePath(),
			activeFile: this.app.workspace.getActiveFile(),
		});
	}

	private getCatalogReadService(): CatalogReadService {
		return this.catalogReadService;
	}

	private async copyText(text: string): Promise<void> {
		await this.containerEl.win.navigator.clipboard.writeText(text);
	}
}

function toSearchDateFilter(scope: ScopeFilter): SearchDateFilter | null {
	return scope === "week" || scope === "month" || scope === "last-month"
		|| scope === "last-7" || scope === "last-30"
		? scope
		: null;
}

export function mergeCatalogMemoPages(memos: readonly MemoViewItem[]): MemoViewItem[] {
	return [...new Map(memos.map((memo) => [memo.id, memo])).values()]
		.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id));
}

function getCatalogDateRange(filter: SearchDateFilter | null, today: Date): { fromDate: string; toDate: string } | null {
	if (filter === null) return null;
	const day = new Date(today.getFullYear(), today.getMonth(), today.getDate());
	if (filter === "last-7") return { fromDate: formatDatePart(addLocalDays(day, -6)), toDate: formatDatePart(day) };
	if (filter === "last-30") return { fromDate: formatDatePart(addLocalDays(day, -29)), toDate: formatDatePart(day) };
	if (filter === "month") return { fromDate: formatDatePart(new Date(day.getFullYear(), day.getMonth(), 1)), toDate: formatDatePart(day) };
	if (filter === "last-month") {
		return {
			fromDate: formatDatePart(new Date(day.getFullYear(), day.getMonth() - 1, 1)),
			toDate: formatDatePart(new Date(day.getFullYear(), day.getMonth(), 0)),
		};
	}
	const mondayOffset = (day.getDay() + 6) % 7;
	const currentMonday = addLocalDays(day, -mondayOffset);
	if (filter === "last-week") {
		return { fromDate: formatDatePart(addLocalDays(currentMonday, -7)), toDate: formatDatePart(addLocalDays(currentMonday, -1)) };
	}
	return { fromDate: formatDatePart(currentMonday), toDate: formatDatePart(day) };
}

function addLocalDays(date: Date, amount: number): Date {
	return new Date(date.getFullYear(), date.getMonth(), date.getDate() + amount);
}

function parseLogicalDateForView(value: string): Date {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
	if (match === null) throw new Error(`Invalid date: ${value}`);
	return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
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

function isTimeBuoyTab(value: string | null): value is TimeBuoyTab {
	return value === "today" || value === "upcoming" || value === "past";
}

function isTimeBuoyTabNavigationKey(key: string): boolean {
	return key === "ArrowLeft" || key === "ArrowRight" || key === "Home" || key === "End";
}

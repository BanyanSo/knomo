import { MobileViewFocusRecovery } from "./MobileViewFocusRecovery";
import { KnomoMobileMenu } from "./KnomoMobileMenu";
import { registerMobileFirstTapRecovery, registerMobileMenuTriggerTap } from "./MobileMenuTap";
import { LocalComposerDraftStore, type LocalComposerDraft } from "./LocalComposerDraftStore";
import { sha256Bytes } from "../utils/sha256";
import { StaleDailyWriteError } from "../services/DailyMemoWriteGateway";
import { MarkdownMutationStaleError } from "../services/MarkdownMutationService";
import { observationHandleKey, type DailyMemoPresentationChange, type ConfirmedDailyMemoPresentation } from "../services/DailyMemoPresentationChange";
import { ConfirmedMemoPresentation } from "./ConfirmedMemoPresentation";
import { createCatalogCapabilities } from "../services/MemoCapabilityModel";
import { CatalogQueryCancelledError, compareCatalogObservations } from "../services/MemoCatalogStore";
import { DesktopDrawerFocus, getDrawerWidth, resolveLayout, type LayoutMode } from "./KnomoLayout";
import { registerComposerToolGesture } from "./ComposerToolGesture";
import type { KnomoQuickCommand } from "./KnomoQuickCommands";
import { getMemoCardActions, getMemoSourceReferenceMeta, isMemoCardMenuReady, MEMO_ACTION_ICONS, MEMO_WORD_COUNT_ICON } from "./KnomoCardMetadata";
import { positionDesktopMenu } from "./DesktopMenuPosition";
import { getMemoContentStats } from "../utils/memoContentStats";
import { createMemoRenderPlaceholders } from "./MemoRenderPlaceholder";
import { updateComposerToolbar } from "./KnomoComposer";
import { runComposerCommand, type ComposerCommand } from "../utils/composerCommands";
import { applyComposerEdit, type ComposerInput } from "./ComposerEditor";
import type { TrashSnapshotStore } from "../services/TrashSnapshotStore";
import { Component, ItemView, Keymap, Notice, Platform, Scope, setIcon, TFile } from "obsidian";
import type { HoverPopover, WorkspaceLeaf } from "obsidian";

import { KNOMO_VIEW_DISPLAY_TEXT, KNOMO_VIEW_TYPE } from "../constants";
import { KNOMO_LOGO_ICON, KNOMO_SEARCH_ICON } from "../icons";
import { t, getKnomoLocale } from "../i18n";
import type { AttachmentService } from "../services/AttachmentService";
import type { MemoCommandService } from "../services/MemoCommandService";
import type { CatalogReadService } from "../services/CatalogReadService";
import { CatalogDiscoveryInvalidatedError, isQueryCovered } from "../services/CatalogReadService";
import { TrashDailyWriteError } from "../services/IndependentTrashService";
import { logContinuationFailure } from "../utils/continuationDiagnostics";
import { filterCatalogMemos } from "./KnomoMemoFilter";
import { getCatalogQueryKey } from "../services/SearchMatching";
import { bindSearchInput } from "./SearchInputBinding";
import { renderSearchDateHint } from "./SearchDateHint";
import type { DailyNotesStatus } from "../services/DailyNoteService";
import type { VaultTagIndex } from "../services/VaultTagIndex";
import { RecordStatsService } from "../services/RecordStatsService";
import type { RecordStatsView } from "../services/RecordStatsService";
import type { SettingsService } from "../services/SettingsService";
import type { ShuffleDayService } from "../services/ShuffleDayService";
import type { CatalogCoverage, CatalogQueryFilter, CatalogRefreshResult } from "../types/catalog";
import type {
	CatalogFeatureCursor,
	CatalogFeatureFilter,
	CatalogFeatureQuery,
	CatalogLibrarySummary,
	CatalogMemoCountResult,
	CatalogMemoPage,
	CatalogReadState,
	CatalogReadStatus,
	CatalogScanSnapshot,
	CatalogTagFacet,
	MemoSaveOperation,
	MemoSaveResult,
} from "../types/catalogView";
import type { MemoViewItem } from "../types/memoView";
import {
	isTrashMemoView,
	isCatalogMemoView,
	toTrashMemoView,
	toTrashMemoItem,
	toCatalogMemoView,
} from "../types/memoView";
import { getHashInsertionText, getListEnterPatch } from "../utils/composerInput";
import type { TextReplacement } from "../utils/composerInput";
import { formatDatePart } from "../utils/date";
import { formatTimeBuoyDate, getTimeBuoyCardStatus } from "../utils/timeBuoyDate";
import { createRecentTimeFlowContext, formatRecentCalendarDate, getRecentMemoPresentation, RecentTimeFlowDecorations, type RecentDecoration } from "./RecentTimeFlowPresentation";
import { extractTimeBuoyDates } from "../utils/timeBuoyParser";
import {
	alreadyHasTimeBuoyDate,
	getTimeBuoyTriggerStartAfterComposition,
	getTimeBuoyTriggerStartForDirectInput,
	insertTimeBuoyDateAtSelection,
	replaceTimeBuoyTrigger,
} from "../utils/timeBuoyComposer";
import { formatServiceError } from "../utils/serviceText";
import type { MemoAction, TrashAction } from "./KnomoActionDispatch";
import { CardImageLoadQueue, type CardImageLoadSurface } from "./CardImageLoadQueue";
import { getCatalogReadStatusHeaders, hasCatalogReadBlocker } from "./CatalogReadStatusPresenter";
import { DelayedLoadingIndicator } from "./DelayedLoadingIndicator";
import { DateChangeWatcher } from "./DateChangeWatcher";
import { DesktopSidebarStateController } from "./DesktopSidebarStateController";
import { getMemoActionLabel, renderKnomoMemoCard, renderKnomoTrashMemoCard } from "./KnomoCard";
import type { MemoCardTimeBuoy } from "./KnomoCard";
import {
	parseCardImageIndex,
	renderMemoCardImages,
	MemoCardImageCache,
} from "./KnomoCardImages";
import type { CardFlowRenderMode } from "./KnomoCardFlow";
import { KnomoCardFlowCoordinator } from "./KnomoCardFlowCoordinator";
import { getMemoDisplayContent } from "./KnomoCardMetadata";
import { renderComposerReferencePreview, renderKnomoComposer } from "./KnomoComposer";
import {
	getTimeBuoyPickerLeft,
	renderTimeBuoyDatePicker,
	type TimeBuoyPickerSource,
} from "./TimeBuoyDatePicker";
import {
	type ComposerDraftSnapshot,
	formatMarkdownQuoteDraft,
	prepareComposerSaveInput,
} from "./ComposerDraft";
import { getPreferredComposerSourcePath } from "./ComposerSourcePath";
import { ComposerSaveShortcutController } from "./ComposerSaveShortcutController";
import { getTextareaCharacterRect } from "./composerSuggestPosition";
import { ImagePreviewScrollLock } from "./ImagePreviewScrollLock";
import { ImageResourceCache } from "./ImageResourceCache";
import { showKnomoConfirmModal } from "./KnomoConfirmModal";
import { KnomoImagePreviewModal } from "./KnomoImagePreviewModal";
import { openMemoDailyNoteDefault, openMemoDailyNoteInNewTab } from "./memoDailyNoteOpen";
import {
	renderKnomoCardFlowHeaders,
	renderKnomoEmptyState,
	renderKnomoLoadingPlaceholder,
	renderKnomoLoadMoreButton,
} from "./KnomoFeed";
import { getCardFlowPresentation } from "./KnomoCardFlowPresenter";
import type { CardFlowHeader, CardFlowPresentation } from "./KnomoCardFlowPresenter";
import {
	renderKnomoCompactHeader,
	renderKnomoCompactSearchPanel,
	renderKnomoDesktopTopbar,
	renderKnomoScopePopover,
} from "./KnomoHeaderSearch";
import { MobileSearchController, type MobileSearchPage } from "./MobileSearchController";
import { renderKnomoRecordStatsPage } from "./KnomoRecordStatsPage";
import {
	renderKnomoSidebar,
	renderSidebarStats,
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
	areMemoListsUnchanged,
	canRetainMemoCard,
	getMemoRenderKey,
	getMemoRenderRevision,
	rebindMemoCard,
} from "./MemoRenderRevision";
import { registerMobileComposerActionGesture, type MobileComposerAction } from "./MobileComposerActionGesture";
import { MobileHeaderTitleController } from "./MobileHeaderTitleController";
import {
	measureMobileHeaderOffsets,
	MOBILE_DRAWER_TOP_DEFAULT,
	MOBILE_SEARCH_TOP_DEFAULT,
} from "./mobileHeaderMetrics";
import { MobileImagePickerFocusGuard } from "./MobileImagePickerFocusGuard";
import { MobileComposerController } from "./MobileComposerController";
import { MobileNavbarCompactController } from "./MobileNavbarCompactController";
import { NativeImagePickerController } from "./NativeImagePickerController";
import { ComposerImageController, type ComposerImageCapture } from "./ComposerImageController";
import { composerImageLinks, setComposerImageLinks, type ComposerImageLink } from "./ComposerImageState";
import { validateComposerImages } from "./validateComposerImages";
import { KnomoPopupState } from "./KnomoPopupState";
import { RandomReunionController } from "./RandomReunionController";
import { appendTimeBuoyItems, renderTimeBuoyPage, syncTimeBuoyPanelState } from "./TimeBuoyPage";
import {
	mergeTodayTimeBuoyFeed,
	buildTimeBuoyTabItems,
	TimeBuoyViewController,
	TimeBuoyIndexPendingError,
	type TimeBuoyTab,
	type TimeBuoyTabItem,
	type TodayTimeBuoySnapshot,
	type TimeBuoyViewSnapshot,
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
import type { ClearTrashAction } from "./clearTrashAction";
import type { TrashMemoRenderTarget } from "./TrashMemoController";
import { KnomoUserActionController } from "./KnomoUserActionController";
import {
	catalogCoverageKey,
	getCardFlowChangeIntent as getCardFlowChangeIntentKey,
	getCardFlowStateKey as getCardFlowStateKeyValue,
	getCardFlowViewStateKey as getCardFlowViewStateKeyValue,
} from "./KnomoViewStateKeys";
import type { CardFlowChangeIntent } from "./KnomoViewStateKeys";
import { KnomoViewStateController } from "./KnomoViewStateController";
import type { KnomoViewStateTransitionEffects } from "./KnomoViewStateController";
import {
	collectTagsFromCounts,
	getRegularFilterCopy,
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
	searchQuery: string;
	result: MemoRecord[];
}

interface CatalogMemoLoad {
	fullHistoryLoaded?: boolean;
	todayTimeBuoys?: TodayTimeBuoySnapshot;
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

interface MemoChangePresentation {
	memos: MemoRecord[];
	timeBuoyState: string;
	error: string | null;
	waitingForCatalog: boolean;
}

type CardRenderSurface = "card-flow" | "mobile-search";
type ImageLoadPauseReason = "image-preview" | "mobile-search";
type PausableImageLoadSurface = Exclude<CardImageLoadSurface, "image-preview">;

type TimeBuoyPickerFocusTarget = "default" | "input";

interface OpenTimeBuoyPickerState {
	context: ReturnType<ComposerInput["composer"]["capture"]>;
	source: TimeBuoyPickerSource;
	phase: "preparing" | "open" | "closing";
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
	private renderedTagRevision = -1;
	private sidebarTagRender: { container: HTMLElement; key: string; firstChild: ChildNode | null } | null = null;
	private cardFlowEl: HTMLElement | null = null;
	private trashCountEls: HTMLElement[] = [];
	private trashCountRefreshTimer: number | null = null;
	private trashViewClosed = false;
	private inputEl: ComposerInput | null = null;
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
	private composerIsComposing = false;
	private tagSuggest: KnomoTagSuggest | null = null;
	private tagIndexWarmupReady = false;
	private tagIndexWarmupCancel: (() => void) | null = null;
	private tagIndexKeyboardBusy = false;
	private tagIndexInteractionResume: (() => void) | null = null;
	private wikiLinkSuggest: KnomoWikiLinkSuggest | null = null;
	private sendButtonEl: HTMLButtonElement | null = null;
	private cancelEditButtonEl: HTMLButtonElement | null = null;
	private statusEl: HTMLElement | null = null;
	private draftValidationRun = 0;
	private pageFeedbackEl: HTMLElement | null = null;
	private pageRefreshError: string | null = null;
	private pageFeedbackContext = "";
	// 只给页面说明编号，防止旧读取清除新问题；不据此推断服务健康。
	private pageFeedbackRun = 0;
	private pageAnnouncementKey = "";
	private cardFlowFeedback = { key: "", context: "" };
	private imageStatusEl: HTMLElement | null = null;
	private composerImages: ComposerImageController | null = null;
	private draftImageLinks: readonly ComposerImageLink[] = [];
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
	private catalogHistoryExpansionPending = false;
	private catalogLoadingNextPage = false;
	private catalogDesktopTotalCount: number | null = null;
	private catalogDesktopCountPresentation: { queryKey: string; count: number } | null = null;
	private catalogDesktopCountRun = 0;
	private catalogDesktopCountController: AbortController | null = null;
	private catalogDesktopQueryController: AbortController | null = null;
	private catalogCoverage: CatalogCoverage | null = null;
	private catalogReadState: CatalogReadState = "ready";
	private catalogStatus: CatalogReadStatus = {
		content: "ready",
		catalog: "complete",
		projection: "ready",
	};
	private catalogRevision = 0;
	private catalogDesktopQueryFingerprint: string | null = null;
	private hasCommittedCatalogDesktopQuery = false;
	private initialCatalogQueryPending = false;
	private libraryIndexRevision = -1;
	private libraryIndexCoverageKey: string | null = null;
	private libraryIndexRun = 0;
	private libraryIndexRequest: Promise<void> | null = null;
	private libraryIndexRequestedKey: string | null = null;
	private libraryIndexesInvalidatedByCoverage = false;
	private librarySummary: CatalogLibrarySummary | null = null;
	private libraryTagFacets: CatalogTagFacet[] | null = null;
	private libraryIndexesUpdating = false;
	private libraryIndexError = false;
	private loadingIndicators?: Map<string, DelayedLoadingIndicator>;
	private pendingCardFlowKey: string | null = null;
	private cardFlowError: string | null = null;
	private memoLoadingPromise: Promise<boolean> | null = null;
	private memoLoadingFingerprint: string | null = null;
	private memoSourceGeneration = 0;
	private catalogDesktopQueryRun = 0;
	private expandedTagGroups = new Set<string>();
	private composerOpen = false;
	private settleQuickCommandReady!: (ready: boolean) => void;
	private readonly quickCommandReady = new Promise<boolean>((resolve) => { this.settleQuickCommandReady = resolve; });
	private executingQuickCommand = false;
	private mobileViewFocusRecovery: MobileViewFocusRecovery | null = null;
	private editingMemo: MemoRecord | null = null;
	private quoteReferenceText: string | null = null;
	private quoteMarkdownText: string | null = null;
	private draftContent = "";
	private suspendedCreate: ComposerDraftSnapshot | null = null;
	private localDraftStore: LocalComposerDraftStore | null = null;
	private localDraftTimer: number | null = null;
	private restoredDraftSelection: ComposerDraftSnapshot | null = null;
	private restoredEditNeedsTarget = false;
	private draftConfirmationOpen = false;
	private composerRenderPending = false;
	private isSaving = false;
	private composerSaveRefreshQueue: Promise<void> = Promise.resolve();
	private presentationChangeQueue: Promise<void> | null = null;
	private confirmedDailyMemos: ConfirmedMemoPresentation | undefined;
	private presentingConfirmedSave = false;
	private composerCommitGeneration = 0;
	private confirmedTodayTimeBuoys: TimeBuoyTabItem[] = [];
	private confirmedPresentationGeneration = 0;
	private hasConfirmedMemoPresentation = false;
	private isManualRefreshing = false;
	private lastKnownLocalDate = formatTimeBuoyDate(new Date());
	private recentTimeFlowContext = createRecentTimeFlowContext(new Date(), false, new Set());
	private recentDecorations = new RecentTimeFlowDecorations(this.recentTimeFlowContext);
	private recentLifecycleKey = "";
	private recentPreferenceUnsubscribe: (() => void) | null = null;
	private currentLayout: LayoutMode = "desktop-narrow";
	private readonly desktopDrawerFocus = new DesktopDrawerFocus();
	private layoutWindow: Window | null = null;
	private layoutWindowCleanup: (() => void) | null = null;
	private layoutSearchComposing = false;
	private renderedTimeBuoyEnabled: boolean | null = null;
	private layoutObserver: ResizeObserver | null = null;
	private filteredMemosCache: FilteredMemosCache | null = null;
	private readonly cardFlowCoordinator = new KnomoCardFlowCoordinator();
	private readonly searchQueryDebounce: SearchQueryDebounce;
	private readonly dateChangeWatcher: DateChangeWatcher;
	private readonly desktopSidebarStateController = new DesktopSidebarStateController();
	private readonly composerSaveShortcutController = new ComposerSaveShortcutController();
	private readonly imagePreviewScrollLock = new ImagePreviewScrollLock();
	private mobileMenuController: KnomoMobileMenu | null = null;
	private mobileGlassSurfaces: Set<HTMLElement> | null = null;
	private readonly mobileHeaderTitleController: MobileHeaderTitleController;
	private readonly mobileImagePickerFocusGuard: MobileImagePickerFocusGuard;
	private readonly nativeImagePickerController: NativeImagePickerController<ComposerImageCapture>;
	private readonly cardImageLoadQueue: CardImageLoadQueue;
	private readonly cardImageCache = new MemoCardImageCache();
	private readonly imageLoadPauseReasons = new Map<PausableImageLoadSurface, Set<ImageLoadPauseReason>>();
	private readonly memoMarkdownRenderer: MemoMarkdownRenderer;
	private readonly randomReunionController: RandomReunionController;
	private readonly shuffleDayController: ShuffleDayController;
	private readonly trashMemoController: TrashMemoController;
	private readonly timeBuoyViewController: TimeBuoyViewController;
	private catalogTodayTimeBuoys: TodayTimeBuoySnapshot | null = null;
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
		if (nav !== this.viewStateController.activeNav) this.cancelCatalogDesktopQuery();
		this.viewStateController.activeNav = nav;
		if (nav !== "random") this.randomReunionController?.cancelPending();
		if (nav !== "shuffleDay") this.shuffleDayController?.cancelPending();
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
		if (this.popupState.activeMenuMemoId !== memoId) this.mobileMenuController?.close("card");
		this.popupState.activeMenuMemoId = memoId;
	}

	private get scopeMenuOpen(): boolean {
		return this.popupState.scopeMenuOpen;
	}

	private set scopeMenuOpen(open: boolean) {
		if (!open) this.mobileMenuController?.close("scope");
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
		trashStore: TrashSnapshotStore,
		clearTrash: ClearTrashAction,
		getDailyNotesStatus: () => DailyNotesStatus,
		getTodayDailyNotePath: () => string | null,
		private readonly onRefreshCatalogProtocolState: (() => Promise<void>) | null = null,
		private readonly onOpenCatalogSettings: (() => void) | null = null,
		private readonly onRebuildBasicData: (() => Promise<void>) | null = null,
		private readonly onQuickCommandInteraction: (() => void) | null = null,
	) {
		super(leaf);
		this.getDailyNotesStatus = getDailyNotesStatus;
		this.getTodayDailyNotePath = getTodayDailyNotePath;
		this.popupState = new KnomoPopupState(() => this.containerEl.win);
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
		this.mobileHeaderTitleController = new MobileHeaderTitleController({
			registerDomEvent: (target, type, listener) => {
				this.getRenderScope().registerDomEvent(target, type, listener);
			},
			renderChevron: (container) => {
				setIcon(container.createSpan({ cls: "knomo-title-chevron" }), "chevron-down");
			},
			canToggleScopeMenu: () => this.activeNav !== "record-stats",
			onToggleScopeMenu: keyboard => this.toggleScopeMenu(keyboard),
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
			captureContext: () => this.composerImages?.capture(),
			isContextCurrent: (context) => this.composerImages?.isCurrent(context) ?? false,
			releaseContext: (context) => this.composerImages?.release(context),
			insertImageFiles: (files, context) => this.insertImageFiles(files, context),
		});
		this.mobileSearchController = this.createMobileSearchController();
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
			maxInFlight: 4,
			scrollAware: Platform.isMobile,
			deferPresentation: Platform.isMobile,
			Observer: (this.containerEl.win as WindowWithIntersectionObserver).IntersectionObserver,
			rootMargin: Platform.isMobile ? "280px 0px" : undefined,
		});
		this.memoMarkdownRenderer = new MemoMarkdownRenderer({
			scheduleTask: Platform.isMobile ? callback => imageQueueWindow.requestAnimationFrame(callback) : undefined,
			cancelTask: Platform.isMobile ? id => imageQueueWindow.cancelAnimationFrame(id) : undefined,
			app: this.app,
			createComponent: () => new Component(),
			getDocument: () => this.containerEl.doc,
			getGeneration: (surface) => {
				return surface === "card-flow"
					? this.renderGeneration
					: this.mobileSearchRenderGeneration;
			},
			getSearchVersion: surface => surface === "mobile-search"
				? this.mobileSearchController.session.version : this.viewStateController.search.version,
			getSearchFilter: surface => surface === "mobile-search"
				? this.mobileSearchController.getDisplayedFilter()
				: (["all", "things", "review"].includes(this.activeNav) ? this.viewStateController.search.result?.filter ?? {} : {}),
			concurrency: Platform.isMobile
				? MOBILE_MARKDOWN_RENDER_CONCURRENCY
				: MARKDOWN_RENDER_CONCURRENCY,
		});
		this.trashMemoController = new TrashMemoController<MemoRecord>({
			store: trashStore,
			toMemo: (snapshot) => toTrashMemoView(toTrashMemoItem(snapshot)),
			pageSize: CATALOG_PAGE_SIZE,
			windowLimit: TRASH_MEMO_WINDOW_LIMIT,
			onInvalidated: () => this.scheduleTrashCountRefresh(),
			restoreMemo: async (memo) => {
				if (isTrashMemoView(memo)) {
					const result = await this.memoCommandService.restore(memo.trashItem);
					return { ...result, memo: result.memo === null ? null : toCatalogMemoView(result.memo) };
				}
				throw new Error("Deleted memo source is unavailable.");
			},
			isCleanupPending: memo => isTrashMemoView(memo) && this.memoCommandService.isRestoreCleanupPending(memo.trashItem),
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
			clearTrash,
			handleRestoredMemo: (deletedMemo, restoredMemo) => this.handleRestoredTrashMemo(deletedMemo, restoredMemo),
			isTrashActive: () => this.activeNav === "trash",
			showNotice: (message) => new Notice(message),
			forceRefreshViews: () => this.onForceRefreshViews(),
			requestRender: (target) => {
				if (!this.trashViewClosed) this.handleTrashRenderRequest(target);
			},
			onPresentationError: error => this.reportViewRefreshFailure(error, "trash-render"),
		});
		this.timeBuoyViewController = new TimeBuoyViewController({
			projectSnapshot: snapshot => this.projectConfirmedTimeBuoySnapshot(snapshot),
			getNow: () => new Date(),
			isPageActive: () => !this.trashViewClosed && this.activeNav === "time-buoy",
			isTodayIndexReady: (targetDate) => this.catalogReadService.getCoverageForRange(targetDate, targetDate),
			ensureReady: async () => undefined,
			queryPage: (request, signal) => this.catalogReadService.queryTimeBuoyPage(request, signal),
			queryDate: (date, cursor, signal) => this.catalogReadService.queryTimeBuoysForDate(date, cursor, signal),
			requestRender: () => {
				if (this.trashViewClosed) return;
				if (this.activeNav === "time-buoy") {
					this.renderCardFlow();
				} else if (this.shouldShowTodayTimeBuoys()) {
					this.renderCardFlow();
				}
			},
		});
		this.randomReunionController = new RandomReunionController({
			loadRandomReunionMemos: (count, request) => this.catalogReadService.getRandomReunionItems(count, request),
			openRandomReunionMemo: async (memo) => {
				const file = this.app.vault.getAbstractFileByPath(memo.dailyRef.path);
				if (!(file instanceof TFile)) throw new Error(t("error.dailyNoteMissing"));
				await openMemoDailyNoteInNewTab(this.app.workspace, file, memo.dailyRef.lineNumberHint);
			},
			markRandomReunionReviewed: async (memoId) => {
				const memo = this.findMemoById(memoId);
				if (memo === null || !isCatalogMemoView(memo)) throw new Error("Random reunion observation is unavailable.");
				await this.memoCommandService.recordReview(await this.resolveCatalogMemo(memo));
			},
			isRandomActive: () => !this.trashViewClosed && this.activeNav === "random",
			showNotice: (message) => new Notice(message),
			requestRender: () => this.renderUiState(),
		});
		this.shuffleDayController = new ShuffleDayController({
			loadSelectedDate: async (date, signal) => {
				const memos = await this.catalogReadService.listMemoViewsForDate(date, { signal });
				return this.confirmedDailyMemos?.merge(memos, { logicalDates: [date] }) ?? memos;
			},
			selectShuffleDay: (request) => this.shuffleDayService.selectCatalogShuffleDay(this.getCatalogReadService(), request),
			acceptSelection: (date) => this.shuffleDayService.acceptSelection(date),
			isShuffleDayActive: () => !this.trashViewClosed && this.activeNav === "shuffleDay",
			requestRender: () => this.renderUiState(),
		});
		this.mobileComposerController = new MobileComposerController({
			getWindow: () => this.containerEl.win,
			getDocument: () => this.containerEl.doc,
			getContainerEl: () => this.containerEl,
			getRootEl: () => this.rootEl,
			getComposerEl: () => this.composerEl,
			getInputEl: () => this.inputEl,
			captureFocusContext: () => {
				const context = this.inputEl?.composer.capture();
				return () => !this.trashViewClosed && this.composerOpen && !!context?.sameSession()
					&& this.app.workspace.getActiveViewOfType(KnomoView) === this;
			},
			getComposerBarEl: () => this.composerBarEl,
			getReferencePreviewEl: () => this.referencePreviewEl,
			getLayout: () => this.currentLayout,
			isComposerOpen: () => this.composerOpen,
			setComposerOpen: (open) => {
				if (!open) this.composerImages?.cancelAll();
				this.composerOpen = open;
			},
			getCardFlowScrollTop: () => this.getCardFlowScrollTop(),
			registerBackdropClick: (element, handler) => {
				this.getRenderScope().registerDomEvent(element, "click", handler);
			},
			closeComposerKeepingDraft: () => this.closeComposerKeepingDraft(),
			focusInputNow: (shouldResize, shouldQueueViewport, moveToEnd) => {
				this.focusComposerInputNow(shouldResize, shouldQueueViewport, moveToEnd);
			},
			resizeInput: () => this.resizeInput(),
			syncRootState: () => this.syncRootState(),
			syncComposerMode: () => this.syncComposerMode(),
			updateSendButtonState: () => this.updateSendButtonState(),
			updateCancelEditButtonState: () => this.updateCancelEditButtonState(),
			onClosing: () => this.inputEl?.dispatchEvent(new this.inputEl.ownerDocument.defaultView!.Event("composer-action-cancel", { bubbles: true })),
			onClosed: () => this.resumeMobileBackgroundWork(),
			onKeyboardTrackingChange: (busy) => this.setTagIndexKeyboardBusy(busy),
		});
		this.scope = new Scope(this.app.scope);
		this.scope.register(["Mod"], "Enter", (event) => {
			if (this.handleComposerSaveShortcut(event)) {
				return false;
			}
		});
	}

	private createMobileSearchController(): MobileSearchController {
		return new MobileSearchController({
			getThingsContext: () => this.activeNav === "things"
				? { activeNav: "things", activeTag: this.activeTag, activeTagKey: this.activeTagKey } : undefined,
			syncThingsSearch: (query, date) => {
				this.searchQuery = query;
				this.searchDateFilter = date;
			},
			getCatalogRevision: () => this.catalogRevision,
			getCoverageKey: () => catalogCoverageKey(this.catalogCoverage),
			getResultStatus: filter => ({
				headers: getCatalogReadStatusHeaders({ status: this.catalogStatus, coverage: this.catalogCoverage }),
				complete: this.catalogCoverage !== null && isQueryCovered(this.catalogCoverage, filter),
				blocked: hasCatalogReadBlocker(this.catalogStatus, this.catalogCoverage),
			}),
			batchSize: MOBILE_SEARCH_BATCH_SIZE,
			debounceMs: SEARCH_DEBOUNCE_MS,
			getWindow: () => this.containerEl.win,
			getDocument: () => this.containerEl.doc,
			isVisible: () => this.containerEl.isShown() && this.containerEl.doc.visibilityState !== "hidden",
			getRootEl: () => this.rootEl,
			isMobileLayout: () => this.currentLayout === "mobile",
			getQueryContextKey: () => JSON.stringify([this.activeNav, this.activeTagKey, this.scopeFilter]),
			projectResults: (memos, filter) => this.confirmedDailyMemos?.merge(memos, filter) ?? mergeCatalogMemoPages(memos),
			hasPendingConfirmedMemos: () => this.confirmedDailyMemos?.pending ?? false,
			onResultsAccepted: page => {
				this.catalogCoverage = page.coverage;
				this.catalogReadState = page.readState;
				this.catalogStatus = page.status;
				this.catalogRevision = page.catalogRevision;
				this.syncRecordStatsSource();
				this.retainMemoCardPreviews();
			},
			registerDomEvent: (target, type, listener) => {
				this.getRenderScope().registerDomEvent(target, type, listener);
			},
			createHiddenText: (container, name, text) => this.createHiddenText(container, name, text),
			filterMemos: (memos, filter) => filterCatalogMemos(memos, filter),
			renderMemoCard: (container, memo, generation, index, reusedImagesEl) => {
				return this.renderMemoCardInContainer(container, memo, generation, index, true, false, "mobile-search", null, reusedImagesEl);
			},
			clearMarkdown: (surface) => this.memoMarkdownRenderer.clear(surface),
			releaseCard: (card) => this.memoMarkdownRenderer.releaseCard(card, "mobile-search"),
			retainCard: (card, memo) => this.memoMarkdownRenderer.retainCard(card, memo),
			clearImages: (surface) => this.cardImageLoadQueue.clear(surface),
			bindImageRoot: (root) => this.cardImageLoadQueue.bindSurface("mobile-search", root),
			scheduleRenderTask: callback => this.containerEl.win.requestAnimationFrame(callback),
			cancelRenderTask: id => this.containerEl.win.cancelAnimationFrame(id),
			prioritizeMarkdown: (root, scrollTop) => this.memoMarkdownRenderer.prioritizeVisible("mobile-search", root, scrollTop),
			setCardFlowPaused: (paused) => this.setImageLoadSurfacePaused("card-flow", "mobile-search", paused),
			closeSurroundingChrome: () => {
				// 移动搜索拥有自己的结果，打开时使底层旧列表请求失效。
				this.cancelCatalogDesktopQuery();
				this.catalogDesktopQueryRun++;
				this.cancelCatalogDesktopCount();
				this.memoLoadingFingerprint = null;
				this.clearSearchDebounce();
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
			restoreElementScrollTop: (element, scrollTop, isCurrent) => this.restoreElementScrollTop(element, scrollTop, isCurrent),
			handleMarkdownInternalLinkClick: (event) => {
				void this.handleMarkdownInternalLinkClick(event);
			},
			handleTaskCheckboxClick: (event) => this.handleTaskCheckboxClick(event),
			handleTaskCheckboxChange: (event) => this.handleTaskCheckboxChange(event),
			loadRemoteResults: (filter, cursor, signal) => this.loadCatalogMobileSearchResults(filter, cursor, signal),
			countRemoteResults: (filter, signal) => this.getCatalogReadService().count(filter, signal),
			restoreRemoteResults: () => this.restoreCardFlowAfterMobileSearch(),
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
			canRunComposerAction: (action, element) => this.canRunComposerAction(action, element),
			getEscapeState: () => ({
				cardMenuOpen: this.activeMenuMemoId !== null,
				scopeMenuOpen: this.scopeMenuOpen,
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
			clearTrash: () => this.trashMemoController.handleClearTrash(),
			runMemoAction: (action, memoId, sourceEl) => this.runMemoActionById(action, memoId, sourceEl),
			openMemoCardDailyNote: (memoId, randomReunion, sourceEl) => this.openMemoCardDailyNote(memoId, randomReunion, sourceEl),
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
			toggleCardMenu: (memoId, keyboard, sourceEl) => this.toggleCardMenu(memoId, keyboard, sourceEl),
			refreshRandomReunion: () => this.randomReunionController.refresh(),
			refreshShuffleDay: () => this.shuffleDayController.refresh(),
			renderNextCardBatch: (generation) => this.renderNextCardBatch(generation),
			loadOlderMemoPeriods: () => {
				void this.loadOlderMemoPeriods();
			},
			loadMoreMobileSearchResults: () => this.loadMoreMobileSearchResults(),
			resetToAllNotes: () => this.resetToAllNotes(),
			closeMobileSearchPage: () => this.closeMobileSearchPage(),
			closeComposerKeepingDraft: () => this.closeComposerKeepingDraft(),
			openDrawer: () => {
				if (!this.prepareDesktopDrawer()) return;
				this.mobileDrawerOpen = true;
			},
			closeDrawer: () => {
				this.mobileDrawerOpen = false;
			},
			ensureSidebarIndexes: () => {
				void this.ensureSidebarIndexes();
			},
			toggleScopeMenu: keyboard => this.toggleScopeMenu(keyboard),
			toggleSidebar: () => this.toggleSidebar(),
			collapseSidebar: () => this.collapseSidebarFromUserAction(),
			handleManualRefresh: () => this.handleManualRefresh(),
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
			rebuildBasicData: async () => {
				if (this.onRebuildBasicData === null) return;
				if (!await showKnomoConfirmModal(this.app, {
					message: t("catalog.rebuildBasicDataConfirm"),
					confirmLabel: t("catalog.rebuildBasicData"),
					danger: true,
				})) return;
				await this.onRebuildBasicData();
				await this.onForceRefreshViews();
			},
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
		try {
			this.localDraftStore = new LocalComposerDraftStore(this.app, () => new Notice(t("composer.draftStorageFailed")));
			const restored = this.localDraftStore.draft;
			this.draftContent = restored.active.content;
			this.draftImageLinks = restored.active.imageLinks ?? [];
			this.quoteReferenceText = restored.active.referenceText;
			this.quoteMarkdownText = restored.active.markdownText;
			this.editingMemo = restored.editingMemo;
			this.suspendedCreate = restored.suspendedCreate;
			this.restoredDraftSelection = restored.active;
			const flush = () => this.flushLocalDraft();
			this.register(() => { this.flushLocalDraft(); this.localDraftStore?.close(); });
			this.registerDomEvent(this.containerEl.doc, "visibilitychange", flush);
			this.registerDomEvent(this.containerEl.win, "pagehide", flush);
			this.registerDomEvent(this.containerEl.win, "blur", flush);
			await this.initializeView();
			if (!this.trashViewClosed) {
				await this.validateRestoredDraft(restored);
			}
			if (!this.trashViewClosed) this.recoverMobileViewFocus();
			this.settleQuickCommandReady(!this.trashViewClosed);
		} catch (error) {
			this.localDraftStore?.close();
			this.settleQuickCommandReady(false);
			throw error;
		}
	}

	recoverMobileViewFocus(isCurrent: () => boolean = () => true, defer = false): void {
		if (!Platform.isMobile) return;
		if (this.mobileViewFocusRecovery === null) {
			this.mobileViewFocusRecovery = new MobileViewFocusRecovery({
				getRoot: () => this.rootEl,
				canRecover: () => !this.trashViewClosed && this.currentLayout === "mobile"
					&& !this.composerOpen && !this.mobileSearchPageOpen
					&& this.app.workspace.getActiveViewOfType(KnomoView) === this,
			});
			this.register(() => this.mobileViewFocusRecovery?.cancel());
		}
		this.mobileViewFocusRecovery.recover(isCurrent, defer);
	}

	waitForQuickCommands(): Promise<boolean> {
		return this.trashViewClosed ? Promise.resolve(false) : this.quickCommandReady;
	}

	executeQuickCommand(command: KnomoQuickCommand): void {
		if (this.trashViewClosed) return;
		if (command === "time-buoy" && !this.settingsService.getSettings().timeBuoyEnabled) {
			new Notice(t("command.timeBuoyDisabled"));
			return;
		}
		this.executingQuickCommand = true;
		try {
			if (command === "new-memo") {
				// 沿用当前会话；保存或组合输入期间不移动编辑器、不结束输入法组合。
				if (this.isSaving || this.composerIsComposing || this.inputEl?.composer.composing) return;
				if (this.mobileSearchPageOpen) this.closeMobileSearchPage();
				if (this.activeNav === "record-stats") this.returnFromRecordStats();
				if (this.composerOpen) this.focusComposerInputNow();
				else this.openComposer();
				return;
			}
			if (this.mobileSearchPageOpen) this.closeMobileSearchPage();
			this.mobileComposerController.clearFocus();
			if (this.composerOpen && !this.isSaving && !this.composerIsComposing && !this.inputEl?.composer.composing) {
				this.closeComposerKeepingDraft();
			}
			if (command === "on-this-day") {
				// 快捷命令属于独立导航，不能沿用搜索中的来源交集。
				this.viewStateController.clearDesktopSearchState();
				this.mobileSearchController.resetState?.();
				this.setTitleMode("anniversary");
			}
			else this.setSidebarNav(command === "random-revisit" ? "random" : command === "shuffle-day" ? "shuffleDay" : command);
		} finally {
			this.executingQuickCommand = false;
		}
	}

	private cancelPendingQuickCommand(): void {
		if (!this.executingQuickCommand) this.onQuickCommandInteraction?.();
	}

	private async initializeView(): Promise<void> {
		this.trashViewClosed = false;
		this.trashMemoController.start();
		this.lastKnownLocalDate = formatTimeBuoyDate(new Date());
		let recentEnabled = this.settingsService.getSettings().recentTimeFlowEnabled;
		this.recentPreferenceUnsubscribe = this.settingsService.onChanged(() => {
			this.syncReducedGlassEffects();
			const tools = this.composerBarEl?.querySelector<HTMLElement>(".knomo-tool-group");
			if (tools) updateComposerToolbar(tools, this.settingsService.getSettings().composerToolbar);
			const next = this.settingsService.getSettings().recentTimeFlowEnabled;
			if (recentEnabled === next || this.trashViewClosed) return;
			recentEnabled = next;
			this.renderCardFlow();
		});
		this.registerEvent(this.app.workspace.on("active-leaf-change", () => {
			if (this.app.workspace.getActiveViewOfType(KnomoView) === this && !this.trashViewClosed) {
				this.recoverMobileViewFocus();
			} else this.mobileViewFocusRecovery?.cancel();
			if (this.app.workspace.getActiveViewOfType(KnomoView) !== this) {
				this.mobileComposerController.clearFocus();
				this.mobileMenuController?.close();
				if (this.currentLayout === "mobile") {
					this.tagSuggest?.close();
					this.wikiLinkSuggest?.close();
				}
			}
			if (!this.trashViewClosed && this.containerEl.isShown()) {
				this.handleLocalDateChange();
				if (this.libraryTagFacets === null) this.renderTags();
				if (this.mobileSearchController.isOpen) this.mobileSearchController.renderResults("content-change", true, true);
			} else {
				this.clearLoadingIndicators();
				this.mobileSearchController.suspendLoadingFeedback();
			}
			this.syncTagIndexInteraction();
		}));
		this.contentEl.addClass("knomo-view-host");
		let tagRenderFrame: number | null = null;
		let tagRevision = this.vaultTagIndex.getSnapshot().revision;
		const tagWindow = this.containerEl.win;
		this.register(this.vaultTagIndex.subscribe(() => {
			const snapshot = this.vaultTagIndex.getSnapshot();
			if (snapshot.revision <= tagRevision || this.trashViewClosed) return;
			tagRevision = snapshot.revision;
			if (tagRenderFrame !== null) return;
			tagRenderFrame = tagWindow.requestAnimationFrame(() => {
				tagRenderFrame = null;
				this.renderPublishedSidebarTags();
			});
		}));
		this.register(() => {
			if (tagRenderFrame !== null) tagWindow.cancelAnimationFrame(tagRenderFrame);
		});
		if (Platform.isMobile) {
			this.updateCurrentLayout();
		}
		await this.render(false);
		if (this.trashViewClosed) return;
		if (Platform.isMobile) {
			this.mobileComposerController.prepare();
			this.tagIndexWarmupReady = true;
			this.scheduleTagIndexWarmup();
			this.register(() => this.disposeTagIndexWarmup());
			const deferWarmup = () => { this.clearTagIndexWarmup(); this.scheduleTagIndexWarmup(); };
			this.registerDomEvent(this.contentEl, "pointerdown", deferWarmup, { passive: true });
			this.registerDomEvent(this.contentEl, "wheel", deferWarmup, { passive: true });
			this.registerDomEvent(this.contentEl, "scroll", deferWarmup, { capture: true, passive: true });
			this.registerDomEvent(this.containerEl.win, "resize", deferWarmup, { passive: true });
		}
		this.mobileNavbarCompactController = new MobileNavbarCompactController(this, {
			isActive: () => this.isMobileNavbarSyncTarget(),
			isComposerOpen: () => this.composerOpen,
			toggleSidebar: () => this.toggleSidebar(),
			openComposer: () => this.openComposer(),
		});
		this.mobileNavbarCompactController.start();
		this.register(() => this.clearTimeBuoyPickerEventListeners());
		this.registerDomEvent(this.containerEl.win, "focus", () => {
			this.handleLocalDateChange();
			this.recoverMobileViewFocus();
		});
		this.registerDomEvent(this.containerEl.win, "orientationchange", () => this.closeTimeBuoyPicker(false));
		const handleMobileBack = (event: Event): void => this.handleMobileBack(event);
		this.containerEl.doc.addEventListener("backbutton", handleMobileBack, { capture: true });
		this.register(() => this.containerEl.doc.removeEventListener("backbutton", handleMobileBack, { capture: true }));
		this.registerDomEvent(this.containerEl.doc, "visibilitychange", () => {
			if (this.containerEl.doc.visibilityState === "hidden") {
				this.clearLoadingIndicators();
				this.mobileSearchController.suspendLoadingFeedback();
			}
			this.clearTagIndexWarmup();
			this.syncTagIndexInteraction();
			if (this.containerEl.doc.visibilityState === "visible") {
				if (this.app.workspace.getActiveViewOfType(KnomoView) === this && !this.trashViewClosed) {
					this.recoverMobileViewFocus();
				}
				this.scheduleTagIndexWarmup();
				this.handleLocalDateChange();
				if (this.libraryTagFacets === null) this.renderTags();
				if (this.mobileSearchController.isOpen) this.mobileSearchController.renderResults("content-change", true, true);
			}
		});
		this.startLayoutObserver();
		this.registerEvent(this.app.vault.on("modify", file => this.checkConfirmedDailyFile(file.path)));
		this.registerEvent(this.app.vault.on("delete", file => this.checkConfirmedDailyFile(file.path)));
		this.registerEvent(this.app.vault.on("rename", (_file, oldPath) => this.checkConfirmedDailyFile(oldPath)));
		this.registerEvent(this.app.workspace.on("layout-change", () => {
			if (this.trashViewClosed) return;
			this.startLayoutObserver();
			this.syncLayoutMeasurements();
		}));
		this.startDateChangeWatcher();
	}

	private isMobileNavbarSyncTarget(): boolean {
		return this.app.workspace.getActiveViewOfType(KnomoView) === this
			|| (Platform.isMobile && this.containerEl.isShown());
	}

	async onClose(): Promise<void> {
		this.clearLoadingIndicators();
		this.cancelCatalogDesktopQuery();
		this.removeMobileSearchPage();
		this.hasConfirmedMemoPresentation = false;
		this.confirmedDailyMemos?.clear();
		this.confirmedTodayTimeBuoys = [];
		this.mobileViewFocusRecovery?.cancel();
		this.mobileMenuController?.close();
		this.cancelCatalogDesktopCount();
		this.flushLocalDraft();
		this.localDraftStore?.close();
		this.trashViewClosed = true;
		this.disposeTagIndexWarmup();
		this.libraryIndexRun += 1;
		this.libraryIndexRequestedKey = null;
		this.settleQuickCommandReady?.(false);
		this.cancelPendingQuickCommand();
		this.suspendedCreate = null;
		this.draftContent = "";
		this.draftImageLinks = [];
		this.editingMemo = null;
		this.quoteReferenceText = null;
		this.quoteMarkdownText = null;
		this.recentPreferenceUnsubscribe?.();
		this.recentPreferenceUnsubscribe = null;
		this.containerEl.removeClass("knomo-reduce-glass");
		this.trashMemoController.dispose();
		this.randomReunionController.dispose();
		this.shuffleDayController.dispose();
		if (this.trashCountRefreshTimer !== null) {
			this.containerEl.win.clearTimeout(this.trashCountRefreshTimer);
			this.trashCountRefreshTimer = null;
		}
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
		this.clearRecordStatsPreparation();
		this.recordStatsPreparationController.clearRetryRequest();
		this.recordStatsService.invalidate();
		this.timeBuoyViewController.clear();
		this.resetTimeBuoyCardFlow();
		this.clearMobileCardBatchContinuation();
		this.cardFlowCoordinator.setPendingScrollRestore(null);
		this.clearMobileGlassSurfaces();
		this.mobileComposerController.dispose();
		this.cardImageLoadQueue.dispose();
		this.cardImageCache.clear();
		this.memoCardPreviewCache.clear();
		this.imageResourceCache.clear();
		this.nativeImagePickerController.dispose();
		this.clearMobileImagePickerFocusGuard();
		this.clearSuppressNextOpenPopupDismissClick();
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

	async refreshReferences(changedPaths?: readonly string[]): Promise<void> {
		// 纯 metadata 更新只重排已挂载的宿主渲染；Daily 变化由原增量链路处理。
		if (this.trashViewClosed) return;
		for (const [container, surface, generation] of [
			[this.cardFlowEl, "card-flow", this.renderGeneration],
			[this.mobileSearchResultsEl, "mobile-search", this.mobileSearchRenderGeneration],
		] as const) {
			for (const card of Array.from(container?.querySelectorAll<HTMLElement>(".knomo-card[data-memo-id]") ?? [])) {
				const memo = this.findMemoById(card.getAttribute("data-memo-id")!, surface);
				if (!memo) continue;
				const content = card.querySelector<HTMLElement>(".knomo-card-content");
				if (content) {
					// 渲染器在离屏完成后原子替换正文，等待期间保留已有内容。
					this.memoMarkdownRenderer.queueMemoMarkdown(memo, content, generation, "normal", this.getMemoCardPreview(memo).text, surface, changedPaths);
				}
				const meta = card.querySelector<HTMLElement>(".knomo-source-reference");
				const reference = getMemoSourceReferenceMeta(memo);
				if (meta && reference.type !== "none") this.memoMarkdownRenderer.queueSourceReferenceMarkdown(
					meta, `${t("reference.fromPrefix")}${reference.text}`, reference.sourcePath, generation, surface, changedPaths,
				);
			}
		}
	}

	handleConfirmedDailyMemoChange(presentation: ConfirmedDailyMemoPresentation): void {
		if (this.trashViewClosed) return;
		const previousPresentation = this.captureMemoChangePresentation();
		this.confirmedDailyMemos ??= new ConfirmedMemoPresentation();
		const capabilities = createCatalogCapabilities(this.catalogCoverage ?? { kind: "partial", coveredFromDate: null,
			pendingFileCount: 0, coveredFileCount: 0, totalFileCount: 0 });
		const { changes, changed } = this.confirmedDailyMemos.apply(presentation, this.getCachedMemos(), capabilities);
		this.randomReunionController.cancelPending();
		this.shuffleDayController.cancelPending();
		// 保存视图在面板退场前准备卡片，其它正在输入的移动视图继续保留延后渲染。
		this.presentingConfirmedSave = this.isSaving;
		try { this.applyCachedMemoChanges(changes, changed, true, previousPresentation, presentation.change.inserted !== null); }
		finally { this.presentingConfirmedSave = false; }
	}

	private checkConfirmedDailyFile(path: string): void {
		const revision = this.confirmedDailyMemos?.getRevision(path);
		if (this.trashViewClosed) return;
		if (revision === undefined) {
			for (const change of this.confirmedDailyMemos?.getChanges() ?? []) {
				if (change.sourcePath.startsWith(path + "/")) this.checkConfirmedDailyFile(change.sourcePath);
			}
			return;
		}
		const file = this.app.vault.getAbstractFileByPath(path);
		void (async () => {
			const current = file instanceof TFile ? await sha256Bytes(new TextEncoder().encode(await this.app.vault.read(file))) : null;
			if (this.trashViewClosed || this.confirmedDailyMemos?.getRevision(path) !== revision || current === revision) return;
			this.confirmedDailyMemos.remove(path);
			this.hasConfirmedMemoPresentation = this.confirmedDailyMemos.pending;
			this.confirmedTodayTimeBuoys = this.confirmedTodayTimeBuoys.filter(item => item.memo.dailyRef.path !== path);
			this.applyCachedMemoChanges(new Map(this.getCachedMemos()
				.filter(memo => memo.dailyRef.path === path).map(memo => [memo.id, null])));
		})().catch(error => { if (!this.trashViewClosed) console.error("Knomo confirmed Daily validation failed", error); });
	}

	invalidateConfirmedDailyMemos(): void {
		this.cancelCatalogDesktopQuery();
		this.mobileSearchController?.cancelPendingRequest?.();
		this.catalogDesktopCountPresentation = null;
		this.hasConfirmedMemoPresentation = false;
		this.confirmedPresentationGeneration = (this.confirmedPresentationGeneration ?? 0) + 1;
		this.confirmedDailyMemos?.clear();
		this.confirmedTodayTimeBuoys = [];
		this.catalogDesktopQueryRun++;
	}

	handleConfirmedCatalogSettled(change: DailyMemoPresentationChange): void {
		const reconcile = this.confirmedDailyMemos?.settled(change);
		if (!reconcile || this.trashViewClosed) return;
		void this.catalogReadService.getFileSourceRevision(change.sourcePath).then(async revision => {
			if (this.trashViewClosed || !reconcile(revision)) return;
			await this.presentationChangeQueue;
			const latest = this.confirmedDailyMemos?.getChanges().find(item => item.sourcePath === change.sourcePath);
			if (latest?.sourceRevision === revision) await this.handleDailyMemoPresentationChange(latest);
		}).catch(error => { if (!this.trashViewClosed) logContinuationFailure("save", "catalog-reconciliation", error); });
	}

	private async reconcileConfirmedCatalog(): Promise<void> {
		await Promise.all((this.confirmedDailyMemos?.getChanges() ?? []).map(async change => {
			const revision = await this.catalogReadService.getFileSourceRevision(change.sourcePath);
			if (this.trashViewClosed || this.confirmedDailyMemos?.getRevision(change.sourcePath) !== change.sourceRevision) return;
			if (revision === change.sourceRevision) await this.handleDailyMemoPresentationChange(change);
		})).catch(error => { if (!this.trashViewClosed) logContinuationFailure("save", "catalog-refresh", error); });
	}

	async handleDailyMemoPresentationChange(change: DailyMemoPresentationChange, catalogCommitted: Promise<void> = Promise.resolve()): Promise<void> {
		if (this.trashViewClosed) return;
		const generation = this.confirmedPresentationGeneration ?? 0;
		this.randomReunionController.cancelPending();
		this.shuffleDayController.cancelPending();
		const previous = this.presentationChangeQueue ?? Promise.resolve();
		const queued = previous.catch(() => undefined).then(async () => {
			// 提交发布前就占住展示队列；失败时不消费变化，也不授权重试正文。
			try { await catalogCommitted; } catch { return; }
			if (this.trashViewClosed || generation !== (this.confirmedPresentationGeneration ?? 0)) return;
			if (this.confirmedDailyMemos?.isOlder(change)) { this.confirmedDailyMemos.acknowledge(change); return; }
			const revision = this.confirmedDailyMemos?.getRevision(change.sourcePath);
			if (revision !== undefined && revision !== change.sourceRevision) this.confirmedDailyMemos!.remove(change.sourcePath);
			await this.applyDailyMemoPresentationChange(change);
		});
		this.presentationChangeQueue = queued;
		try { await queued; }
		finally { if (this.presentationChangeQueue === queued) this.presentationChangeQueue = null; }
	}

	private getCachedMemos(): MemoRecord[] {
		return [
			...this.memos,
			...(this.randomReunionController.getSnapshot().memos ?? []),
			...this.shuffleDayController.getSnapshot().memos,
			...this.timeBuoyViewController.getMemos(),
			...(this.catalogTodayTimeBuoys?.today.map(item => item.memo) ?? []),
			...(this.mobileSearchController?.getDisplayedMemos() ?? []),
		];
	}

	private async applyDailyMemoPresentationChange(change: DailyMemoPresentationChange): Promise<void> {
		if (this.trashViewClosed) return;
		const generation = this.confirmedPresentationGeneration ?? 0;
		const feedbackRun = this.pageFeedbackRun ?? 0;
		const cached = this.getCachedMemos();
		const pending = this.confirmedDailyMemos?.getMemos().filter(memo => memo.dailyRef.path === change.sourcePath) ?? [];
		const ids = new Set(cached.map(memo => memo.id));
		const replacements = change.replacements.filter(item => ids.has(observationHandleKey(item.before)));
		const inserted = change.inserted !== null && this.shuffleDayController.getSnapshot().selectedDate === change.logicalDate
			? change.inserted : null;
		if (replacements.length === 0 && inserted === null && pending.length === 0) return;
		const changes = new Map<string, MemoRecord | null>(replacements.map(item => [observationHandleKey(item.before), null]));
		const handles = [...new Map([...replacements.flatMap(item => item.after ? [item.after] : []),
			...(inserted ? [inserted] : []), ...pending.map(memo => memo.catalog!.observationHandle)]
			.map(handle => [observationHandleKey(handle), handle])).values()];
		let current: Awaited<ReturnType<CatalogReadService["readMemoItems"]>>;
		try {
			current = await this.catalogReadService.readMemoItems(handles);
		} catch (error) {
			if (this.trashViewClosed || generation !== (this.confirmedPresentationGeneration ?? 0) || this.confirmedDailyMemos?.isOlder(change)) return;
			// 快照失效不代表持久故障；仅移除本次变化确定已过期的原 occurrence。
			if (changes.size > 0) this.applyCachedMemoChanges(changes);
			if (!(error instanceof CatalogDiscoveryInvalidatedError) || pending.length === 0) {
				this.reportViewRefreshFailure(error, "readback", changes.size > 0 && pending.length === 0);
			}
			return;
		}
		if (this.trashViewClosed || generation !== (this.confirmedPresentationGeneration ?? 0)) return;
		if (this.confirmedDailyMemos?.isOlder(change)) { this.confirmedDailyMemos.acknowledge(change); return; }
		try {
			const byKey = new Map(current.map(item => [item.key, toCatalogMemoView(item)]));
			for (const item of replacements) {
				changes.set(observationHandleKey(item.before), item.after ? byKey.get(observationHandleKey(item.after))! : null);
			}
			if (pending.length > 0) for (const memo of cached) {
				if (memo.dailyRef.path !== change.sourcePath) continue;
				const projected = this.confirmedDailyMemos!.merge([memo], undefined, false)[0];
				changes.set(memo.id, projected ? byKey.get(projected.id) ?? projected : null);
			}
			for (const memo of pending) changes.set(memo.id, byKey.get(memo.id)!);
			const upserts = pending.length > 0 ? pending.map(memo => byKey.get(memo.id)!)
				: inserted ? [byKey.get(observationHandleKey(inserted))!] : [];
			if (this.applyCachedMemoChanges(changes, upserts, pending.length > 0)) {
				this.confirmedDailyMemos?.acknowledge(change);
				if (feedbackRun === (this.pageFeedbackRun ?? 0)) { this.pageRefreshError = null; this.syncPageFeedback(); }
			}
		} catch (error) {
			this.reportViewRefreshFailure(error, "state-apply");
		}
	}

	private captureMemoChangePresentation(): MemoChangePresentation {
		const buoy = this.activeNav === "time-buoy" ? this.timeBuoyViewController.getSnapshot() : null;
		return {
			memos: buoy ? buoy[buoy.activeTab].map(item => item.memo)
				: mergeTodayTimeBuoyFeed(this.catalogTodayTimeBuoys?.todayCursor != null && this.shouldShowTodayTimeBuoys()
					? [] : this.getFilteredMemos(), this.getTodayTimeBuoyItems()),
			timeBuoyState: buoy ? JSON.stringify([buoy.activeTab, buoy.loading, buoy.error, buoy.refreshError, buoy.complete,
				buoy[buoy.activeTab].map(item => [item.primaryTargetDate, item.targetDates])]) : "",
			error: this.cardFlowError ?? null,
			waitingForCatalog: ["all", "things", "review"].includes(this.activeNav)
				&& !this.hasCommittedCatalogDesktopQuery && !this.hasConfirmedMemoPresentation,
		};
	}

	private retainUnchangedMemoCards(changes: ReadonlyMap<string, MemoRecord | null>, previous: readonly MemoRecord[]): void {
		for (const card of Array.from(this.cardFlowEl?.querySelectorAll<HTMLElement>(".knomo-card[data-memo-id]") ?? [])) {
			const id = card.getAttribute("data-memo-id")!;
			const before = this.renderedCardMemos.get(card.getAttribute("data-memo-render-key") ?? id)
				?? previous.find(memo => memo.id === id);
			const current = changes.get(id);
			if (!before || !current || !canRetainMemoCard(before, current)) continue;
			if (id !== current.id && this.activeMenuMemoId === id) this.closeCardMenu();
			rebindMemoCard(card, current);
			this.memoMarkdownRenderer.retainCard(card, current);
			this.renderedCardMemos.delete(getMemoRenderKey(before));
			this.renderedCardMemos.set(getMemoRenderKey(current), current);
		}
		this.timeBuoyRenderItems = (this.timeBuoyRenderItems ?? []).map(item => {
			const current = changes.get(item.memo.id);
			return current && canRetainMemoCard(item.memo, current) ? { ...item, memo: current } : item;
		});
	}

	private applyCachedMemoChanges(
		changes: ReadonlyMap<string, MemoRecord | null>, inserted: readonly MemoRecord[] = [], confirmed = false,
		previousPresentation = this.captureMemoChangePresentation(), created = false,
	): boolean {
		this.cancelCatalogDesktopQuery();
		this.retainUnchangedMemoCards(changes, previousPresentation.memos);
		this.catalogDesktopQueryRun++;
		this.memos = this.memos.flatMap(memo => {
			if (!changes.has(memo.id)) return [memo];
			const current = changes.get(memo.id);
			return current ? [current] : [];
		});
		if (confirmed) {
			this.memos = [...new Map([...this.memos, ...inserted].map(memo => [memo.id, memo])).values()]
				.sort((left, right) => compareCatalogObservations(left.catalog!.observation, right.catalog!.observation));
			this.cancelCatalogDesktopCount();
			this.catalogCursor = null;
		}
		const pinned = (this.confirmedTodayTimeBuoys ?? []).flatMap(item => {
			const memo = changes.has(item.memo.id) ? changes.get(item.memo.id) : item.memo;
			return memo ? [memo] : [];
		});
		this.confirmedTodayTimeBuoys = buildTimeBuoyTabItems([...pinned, ...(confirmed ? inserted : [])], "today", formatTimeBuoyDate(new Date()));
		this.filteredMemosCache = null;
		if (this.catalogTodayTimeBuoys !== null) {
			const today = this.catalogTodayTimeBuoys.todayDate;
			this.catalogTodayTimeBuoys = { ...this.catalogTodayTimeBuoys, todayCursor: null,
				today: this.catalogTodayTimeBuoys.today.flatMap(item => {
					if (!changes.has(item.memo.id)) return [item];
					const memo = changes.get(item.memo.id);
					return memo && memo.catalog?.timeBuoyDates.includes(today ?? "")
						? [{ ...item, memo, targetDates: [today!], primaryTargetDate: today! }] : [];
				}),
			};
			if (confirmed) this.catalogTodayTimeBuoys = this.projectTodayTimeBuoys(this.catalogTodayTimeBuoys, inserted);
		}
		this.randomReunionController.applyMemoChanges(changes, false);
		this.shuffleDayController.applyMemoChanges(changes, inserted);
		this.timeBuoyViewController.applyMemoChanges(changes, confirmed ? inserted : []);
		this.mobileSearchController?.applyMemoChanges(changes, confirmed ? inserted : [], created);
		const current = this.captureMemoChangePresentation();
		const sameMemos = areMemoListsUnchanged(previousPresentation.memos, current.memos, changes);
		if (confirmed && current.memos.length > 0) {
			this.hasConfirmedMemoPresentation = true;
			this.cardFlowError = null;
		}
		if (confirmed && !sameMemos) {
			this.catalogDesktopTotalCount = created && typeof this.catalogDesktopTotalCount === "number"
				? this.catalogDesktopTotalCount + current.memos.length - previousPresentation.memos.length : null;
		}
		try {
			this.renderUiState({ renderMobileSearchResults: false, renderCardFlow: !sameMemos
				|| previousPresentation.timeBuoyState !== current.timeBuoyState
				|| previousPresentation.error !== (this.cardFlowError ?? null)
				|| (previousPresentation.waitingForCatalog && this.hasConfirmedMemoPresentation) });
			return true;
		} catch (error) { this.reportViewRefreshFailure(error, "render"); return false; }
	}

	private async refreshRandomReunionBatch(): Promise<void> {
		const snapshot = this.randomReunionController.getSnapshot().memos;
		if (snapshot === null) return;
		const generation = this.confirmedPresentationGeneration ?? 0;
		try {
			const queryable = snapshot.filter(memo => this.confirmedDailyMemos?.getRevision(memo.dailyRef.path) === undefined);
			const validated = await this.catalogReadService.refreshMemoViews(queryable);
			const byId = new Map(validated.map(memo => [memo.id, memo]));
			const current = snapshot.flatMap(memo => this.confirmedDailyMemos?.getRevision(memo.dailyRef.path) !== undefined
				? [memo] : byId.has(memo.id) ? [byId.get(memo.id)!] : []);
			await this.presentationChangeQueue;
			if (!this.trashViewClosed && generation === (this.confirmedPresentationGeneration ?? 0)) this.randomReunionController.reconcileMemos(current, snapshot);
		} catch (error) {
			if (!(error instanceof CatalogDiscoveryInvalidatedError) && !this.trashViewClosed
				&& generation === (this.confirmedPresentationGeneration ?? 0)) this.randomReunionController.reportRefreshFailure(snapshot, error);
		}
	}

	async refresh(forceRebuild = false): Promise<void> {
		await this.presentationChangeQueue?.catch(error => { if (!this.trashViewClosed) logContinuationFailure("view", "presentation-queue", error); });
		if (this.trashViewClosed) return;
		await this.reconcileConfirmedCatalog();
		await this.refreshRandomReunionBatch();
		if (this.mobileSearchController?.isOpen) { await this.mobileSearchController.refreshAppliedResults(); return; }
		const timeBuoyEnabled = this.settingsService.getSettings().timeBuoyEnabled;
		if (this.renderedTimeBuoyEnabled !== timeBuoyEnabled) {
			if (!timeBuoyEnabled && this.activeNav === "time-buoy") {
				this.timeBuoyViewController.clear();
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
			this.handleTrashRenderRequest("ui-state");
			return;
		}
		await this.waitForAllMemosLoading();
		await this.reloadMemos(false, forceRebuild);
		if (this.settingsService.getSettings().timeBuoyEnabled && !this.shouldShowTodayTimeBuoys()) {
			await this.timeBuoyViewController.loadTodayOnly();
		}
		if (this.activeNav === "random" && this.randomReunionController.getSnapshot().status === "idle") {
			await this.randomReunionController.refresh();
		} else if (this.activeNav === "shuffleDay") {
			if (this.shuffleDayController.getSnapshot().status === "idle") await this.shuffleDayController.refresh();
			else await this.shuffleDayController.reloadSelectedDate();
		}
	}

	private handleRestoredTrashMemo(_deletedMemo: MemoRecord, restoredMemo: MemoRecord): void {
		this.shuffleDayController.applyMemoUpdate(restoredMemo);
		if (isCatalogMemoView(restoredMemo)) void this.reloadMemos(false, true).catch(error => this.reportViewRefreshFailure(error, "restore-refresh"));
	}

	handleAttachmentFilesChanged(paths: readonly string[]): void {
		this.cardImageCache.invalidateResourcePaths(paths);
		this.mobileSearchController.invalidateImagePaths(paths);
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

	private async render(waitForCatalog = true): Promise<void> {
		if (this.trashViewClosed) return;
		// 保存中的 DOM 重建延至提交归属已消费，避免留下可重复发送的副本。
		if (this.isSaving) { this.composerRenderPending = true; return; }
		this.clearLoadingIndicators();
		this.cardImageCache.clear();
		this.closeTimeBuoyPicker(false);
		this.cancelCatalogDesktopQuery();
		this.mobileSearchController?.cancelPendingRequest?.();
		this.memoSourceGeneration += 1;
		this.catalogDesktopCountPresentation = null;
		if (this.trashViewClosed) return;
		if (this.isSaving) { this.composerRenderPending = true; return; }
		this.draftContent = this.inputEl?.value ?? this.draftContent;
		this.draftImageLinks = this.inputEl?.composer.view.state.field(composerImageLinks) ?? this.draftImageLinks;
		const selection = this.inputEl?.composer.view.state.selection.main;
		const scrollTop = this.inputEl?.composer.view.scrollDOM.scrollTop ?? 0;
		this.memos = [];
		this.catalogTodayTimeBuoys = null;
		this.catalogCursor = null;
		this.catalogHistoryExpansionPending = false;
		this.catalogDesktopTotalCount = null;
		this.catalogDesktopCountRun += 1;
		this.cancelCatalogDesktopCount();
		this.catalogDesktopQueryFingerprint = null;
		this.hasCommittedCatalogDesktopQuery = false;
		this.memoLoadingFingerprint = null;
		this.libraryIndexRun += 1;
		this.libraryIndexRequestedKey = null;
		this.librarySummary = null;
		this.libraryTagFacets = null;
		this.libraryIndexesUpdating = false;
		this.libraryIndexError = false;
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
		this.renderScope.register(() => this.mobileMenuController?.close());
		this.renderScope.register(() => this.mobileViewFocusRecovery?.cancel());
		if (Platform.isMobile) this.registerMobileMenuTriggerEvents();
		const container = this.contentEl;
		this.finishSidebarResize();
		if (this.rootEl) this.layoutObserver?.unobserve(this.rootEl);
		container.empty();
		this.titleHosts = [];
		this.statsEls = [];
		this.trashCountEls = [];

		const settings = this.settingsService.getSettings();
		this.renderedTimeBuoyEnabled = settings.timeBuoyEnabled;
		this.desktopSidebarStateController.setFromSettings(settings.desktopSidebarWidth, settings.desktopSidebarCollapsed);

		const root = container.createDiv({ cls: "knomo-plugin knomo-view" });
		this.rootEl = root;
		this.layoutObserver?.observe(root);

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
		this.pageFeedbackEl = contentColumn.createDiv({ cls: "knomo-page-feedback", attr: { hidden: "" } });
		this.pageFeedbackEl.createSpan({ attr: { role: "status", "aria-live": "off", "aria-atomic": "true" } });
		this.pageFeedbackEl.createEl("button", { cls: "knomo-inline-button", text: t("settings.attention.retry"), attr: { type: "button", "data-action": "refresh" } });
		this.syncPageFeedback();
		if (selection && this.inputEl) {
			this.inputEl.setSelectionRange(selection.from, selection.to, selection.anchor > selection.head ? "backward" : "forward");
			this.inputEl.composer.view.scrollDOM.scrollTop = scrollTop;
		}
		this.cardFlowEl = contentColumn.createDiv({
			cls: "knomo-card-flow",
		});
		this.cardImageLoadQueue.bindSurface("card-flow", this.cardFlowEl);
		this.getRenderScope().registerDomEvent(this.cardFlowEl, "scroll", () => this.handleCardFlowScroll());
		this.getRenderScope().registerDomEvent(this.cardFlowEl, "touchstart", () => this.cardFlowCoordinator.setPendingScrollRestore(null));
		this.getRenderScope().registerDomEvent(this.cardFlowEl, "wheel", () => this.cardFlowCoordinator.setPendingScrollRestore(null));
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
		this.recoverMobileViewFocus();
		void this.refreshCatalogLibraryIndexes();
		if (Platform.isMobile) {
			this.renderStats();
			this.renderTags();
			this.renderTrashCount();
			void this.loadInitialMobileMemos();
		} else {
			void this.trashMemoController.ensureLoaded();
			const initialQuery = this.reloadCurrentCatalogQuery(true);
			// 首次打开只等待可交互界面；数据继续使用原查询加载与错误状态。
			if (waitForCatalog) await initialQuery;
			else void initialQuery.catch((error: unknown) => {
				if (!this.trashViewClosed) this.reportViewRefreshFailure(error, "initial-load");
			});
		}
		if (this.settingsService.getSettings().timeBuoyEnabled) {
			if (this.activeNav === "time-buoy") {
				void this.timeBuoyViewController.loadInitial();
			} else if (!this.shouldShowTodayTimeBuoys()) {
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
		this.renderedTagRevision = -1;
		this.trashCountEls.push(elements.trashCountEl);
		this.sidebarResizerEl = elements.resizerEl;
		this.getRenderScope().registerDomEvent(this.sidebarResizerEl, "pointerdown", (event) => this.startSidebarResize(event));
		this.getRenderScope().registerDomEvent(this.sidebarResizerEl, "pointermove", (event) => this.resizeSidebar(event));
		this.getRenderScope().registerDomEvent(this.sidebarResizerEl, "pointerup", (event) => this.stopSidebarResize(event));
		this.getRenderScope().registerDomEvent(this.sidebarResizerEl, "pointercancel", (event) => this.stopSidebarResize(event));
		this.getRenderScope().registerDomEvent(this.sidebarResizerEl, "keydown", (event) => {
			if (this.currentLayout !== "desktop-wide") return;
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
		const wikiLinkListboxId = this.getA11yId("wiki-link-suggestions");
		const composer = renderKnomoComposer(main, {
			dailyEnabled: dailyStatus.enabled,
			toolbar: this.settingsService.getSettings().composerToolbar,
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
		this.composerIsComposing = false;
		this.getRenderScope().register(() => composer.inputEl.composer.destroy());
		this.timeBuoyButtonEl = composer.timeBuoyButtonEl;
		this.timeBuoyMonthStatusEl = composer.timeBuoyMonthStatusEl;
		this.referencePreviewEl = composer.referencePreviewEl;
		this.composerBarEl = composer.composerBarEl;
		this.cancelEditButtonEl = composer.cancelEditButtonEl;
		this.statusEl = composer.statusEl;
		this.imageStatusEl = composer.imageStatusEl;
		this.sendButtonEl = composer.sendButtonEl;
		composer.inputEl.composer.view.dispatch({ effects: setComposerImageLinks.of(this.draftImageLinks) });
		this.applyRestoredDraftSelection();
		this.getRenderScope().registerDomEvent(composer.inputEl, "composer-transactions", event => {
			if (event.detail.some(transaction => transaction.docChanged)) this.localDraftStore?.changed();
			this.scheduleLocalDraft();
		});
		this.getRenderScope().registerDomEvent(composer.inputEl, "composer-reset", () => {
			this.localDraftStore?.changed();
			this.scheduleLocalDraft();
		});
		this.getRenderScope().registerDomEvent(composer.inputEl.composer.view.scrollDOM, "scroll", () => this.scheduleLocalDraft());
		const images = this.createComposerImageController(composer.inputEl);
		this.composerImages = images;
		this.getRenderScope().register(() => images.dispose());
		this.getRenderScope().registerDomEvent(composer.cancelImagesButtonEl, "pointerdown", event => event.preventDefault());
		this.getRenderScope().registerDomEvent(composer.cancelImagesButtonEl, "click", event => {
			event.stopPropagation();
			const restoreFocus = composer.cancelImagesButtonEl.ownerDocument.activeElement === composer.cancelImagesButtonEl;
			images.cancelAll();
			if (restoreFocus && !composer.inputEl.composer.composing) composer.inputEl.composer.view.focus();
		});
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
		if (this.currentLayout === "mobile") {
			this.getRenderScope().register(registerMobileComposerActionGesture(composer.composerEl, {
				identify: target => {
					const button = target.closest<HTMLElement>("[data-action]");
					const action = button?.getAttribute("data-action");
					return button && (action === "save-input" || action === "cancel-edit" || action === "clear-reference") ? { button, action } : null;
				},
				isAvailable: (button, action) => this.canRunComposerAction(action, button),
				captureContext: () => {
					const input = this.inputEl;
					const context = input?.composer.capture();
					const editing = this.editingMemo, reference = this.quoteReferenceText;
					return () => this.inputEl === input && context?.sameSession() === true
						&& this.editingMemo === editing && this.quoteReferenceText === reference;
				},
				execute: action => { void this.userActionController.handleAction(action, null); },
			}));
		}
		this.tagSuggest = new KnomoTagSuggest(
			this.app,
			this.inputEl,
			() => this.syncInputState(),
			this.vaultTagIndex,
			surface => this.registerMobileGlassSurface(surface),
		);
		this.wikiLinkSuggest = new KnomoWikiLinkSuggest(this.app, this.inputEl, {
			listboxId: wikiLinkListboxId,
			getSourcePath: () => this.getWikiLinkSourcePath(),
			onInputChanged: () => this.syncInputState(),
			closeTagSuggest: () => this.tagSuggest?.close(),
			registerVaultEvent: (eventRef) => this.getRenderScope().registerEvent(eventRef),
			registerGlassSurface: surface => this.registerMobileGlassSurface(surface),
		});
		this.getRenderScope().registerDomEvent(this.inputEl, "beforeinput", (event: InputEvent) => {
			this.handleComposerBeforeInput(event);
		}, { capture: true });
		this.getRenderScope().registerDomEvent(this.inputEl, "composer-change", (event) => {
			this.clearTagIndexWarmup();
			this.scheduleTagIndexWarmup();
			this.syncInputState();
			if (this.composerIsComposing || this.inputEl?.composer.composing) return;
			if (event.detail.history) { this.tagSuggest?.close(); this.wikiLinkSuggest?.close(); return; }
			if (event.detail.userInput && !this.composerIsComposing) this.wikiLinkSuggest?.handleInput();
			else this.wikiLinkSuggest?.refreshForCursor();
			if (event.detail.event) this.handleTimeBuoyComposerInput(event.detail.event);
			this.tagSuggest?.refresh();
		});
		this.getRenderScope().registerDomEvent(this.inputEl, "focus", () => {
			this.handleComposerInputFocus();
		});
		this.getRenderScope().registerDomEvent(this.inputEl, "blur", () => {
			this.handleComposerInputBlur();
			this.syncTagIndexInteraction();
		});
		this.getRenderScope().registerDomEvent(this.inputEl, "compositionstart", () => {
			this.composerIsComposing = true;
			this.syncTagIndexInteraction();
			this.tagSuggest?.close();
			this.wikiLinkSuggest?.handleCompositionStart();
		});
		this.getRenderScope().registerDomEvent(this.inputEl, "composer-compositionend", (event) => {
			this.composerIsComposing = false;
			this.syncTagIndexInteraction();
			this.wikiLinkSuggest?.handleCompositionEnd();
			this.tagSuggest?.refresh();
			this.handleTimeBuoyCompositionEnd(event.detail);
		});
		this.getRenderScope().registerDomEvent(this.inputEl, "composer-reset", () => {
			this.composerIsComposing = this.inputEl?.composer.composing ?? false;
			this.syncTagIndexInteraction();
			if (!this.composerIsComposing) this.wikiLinkSuggest?.handleCompositionReset();
		});
		this.getRenderScope().registerDomEvent(this.inputEl, "click", () => {
			if (this.inputEl?.composer.composing) return;
			this.wikiLinkSuggest?.refreshForCursor();
			this.tagSuggest?.refresh();
			this.closeTimeBuoyPickerIfTriggerMoved();
		});
		this.getRenderScope().registerDomEvent(this.inputEl, "keydown", (event) => {
			if (this.handleComposerSaveShortcut(event)) {
				return;
			}
			if (this.wikiLinkSuggest?.handleKeydown(event)) {
				return;
			}
		}, { capture: true });
		this.getRenderScope().register(this.tagSuggest.registerLifecycle());
		this.getRenderScope().registerDomEvent(this.inputEl, "keydown", event => this.handleListEnterKeydown(event), { capture: true });
		this.getRenderScope().registerDomEvent(this.inputEl, "keydown", (event) => {
			this.handleComposerKeydown(event);
		});
		this.getRenderScope().registerDomEvent(this.inputEl, "keyup", (event) => {
			this.handleComposerKeyup(event);
			if (event.isComposing || this.inputEl?.composer.composing) return;
			if (!(event.ctrlKey || event.metaKey)) this.wikiLinkSuggest?.refreshForCursor();
			this.closeTimeBuoyPickerIfTriggerMoved();
		});
		this.getRenderScope().register(registerComposerToolGesture(composer.toolsEl, action => { this.runComposerToolAction(action); },
			undefined, this.currentLayout !== "mobile"));
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
		const scope = this.getRenderScope();
		scope.registerDomEvent(searchInput, "focus", () => this.openDesktopSearch());
		scope.registerDomEvent(searchInput, "click", () => this.openDesktopSearch());
		bindSearchInput({
			input: searchInput, session: this.viewStateController.search,
			registerDomEvent: (target, type, listener) => scope.registerDomEvent(target, type, listener),
			onDraftChanged: () => this.invalidateSearchDraft(),
			onQueue: () => this.queueSearchQuery(this.viewStateController.search.draft.text),
			onClose: () => {
				this.closeDesktopSearch();
				if (searchInput === this.desktopSearchInputEl) searchInput.blur();
				else { searchInput.value = ""; this.setSearchQuery(""); }
			},
			onCompositionChanged: composing => {
				this.layoutSearchComposing = composing;
				if (!composing) this.syncLayoutMeasurements();
			},
		});
	}

	private registerCompactSearchInput(searchInput: HTMLInputElement): void { this.registerDesktopSearchInput(searchInput); }

	private invalidateSearchDraft(): void {
		this.cancelCatalogDesktopQuery();
		this.clearSearchDebounce();
		this.catalogDesktopQueryRun++;
		this.catalogDesktopCountRun++;
		this.cancelCatalogDesktopCount();
		this.memoLoadingFingerprint = null;
		if (this.viewStateController.search.requestStatus === "pending") this.viewStateController.search.requestStatus = "idle";
		this.syncSearchControls();
	}

	private closeDesktopSearch(): void {
		if (!this.desktopSearchOpen && !this.compactSearchOpen) return;
		this.desktopSearchOpen = false;
		this.compactSearchOpen = false;
		this.syncRootState();
	}

	private submitSearchDraft(): void {
		const session = this.viewStateController.search;
		this.clearSearchDebounce();
		if (!session.canRewrite) { this.syncSearchControls(); return; }
		const previousViewStateKey = this.getCardFlowViewStateKey();
		session.submit();
		this.applyViewStateTransitionEffects(this.viewStateController.setSearchQuery(session.applied.input));
		this.syncSearchInputs();
		this.syncSearchControls();
		this.syncRootState();
		this.renderFilteredListState(false, this.getCardFlowChangeIntent(previousViewStateKey));
		const filter = this.buildCatalogActiveQuery(true);
		if (session.requestStatus === "ready" && session.result?.key === getCatalogQueryKey(filter)
			&& session.result.catalogRevision === this.catalogRevision && session.result.coverageKey === catalogCoverageKey(this.catalogCoverage)) {
			// 等价条件沿用已有数据与计数，列表已按旧流程恢复展示。
			return;
		}
		this.refreshCatalogActiveQuery();
	}

	private syncSearchControls(): void {
		this.rootEl?.findAll(".knomo-search-menu .knomo-search-date-hint").forEach(element =>
			renderSearchDateHint(element, this.viewStateController.search));
	}

	private async reloadMemos(loadAll: boolean, forceRebuild = false): Promise<boolean> {
		if (this.mobileSearchController?.isOpen) { await this.mobileSearchController.refreshAppliedResults(); return true; }
		let queryFingerprint = this.getCatalogQueryFingerprint(loadAll);
		const previousQueryFingerprint = this.catalogDesktopQueryFingerprint;
		this.prepareCatalogDesktopQuery(queryFingerprint);
		const controller = this.beginCatalogDesktopQuery();
		const queryRun = ++this.catalogDesktopQueryRun;
		const sourceGeneration = this.memoSourceGeneration;
		const searchVersion = this.viewStateController.search.version;
		const coverageKey = catalogCoverageKey(this.catalogCoverage);
		this.viewStateController.search.beginRequest();
		this.syncSearchControls();
		const previousCardFlowKey = this.getCardFlowStateKey();
		const previousMobileSearchKey = this.getMobileSearchStateKey();
		let loaded = false;
		try {
			const load = await this.loadCatalogMemos(loadAll, controller.signal);
			controller.signal.throwIfAborted();
			if (!this.isCatalogQueryRunCurrent(queryRun, sourceGeneration, searchVersion)
				|| !this.isCatalogQueryCurrent(queryFingerprint, loadAll)) {
				return false;
			}
			if (load.fullHistoryLoaded) {
				loadAll = true;
				queryFingerprint = this.getCatalogQueryFingerprint(true);
				this.catalogDesktopQueryFingerprint = queryFingerprint;
			}
			if (coverageKey !== catalogCoverageKey(this.catalogCoverage) && catalogCoverageKey(load.coverage) !== catalogCoverageKey(this.catalogCoverage)) {
				throw new CatalogDiscoveryInvalidatedError();
			}
			this.applyCatalogMemoLoad(load);
			if (this.shouldWaitForInitialCatalogLoad(load)) {
				this.memos = [];
				this.cardFlowError = null;
				this.filteredMemosCache = null;
				this.renderUiState();
				return true;
			}
			this.memos = load.memos;
			// 近月窗口结束不代表全历史结束，桌面与移动端都保留展开入口。
			this.catalogHistoryExpansionPending = !loadAll && !load.fullHistoryLoaded && this.isDefaultListState();
			this.viewStateController.search.commitResult(this.buildCatalogActiveQuery(loadAll), load.catalogRevision, catalogCoverageKey(load.coverage));
			const immediateTotalCount = this.getImmediateCatalogTotalCount(load);
			this.catalogDesktopTotalCount = immediateTotalCount ?? (previousQueryFingerprint === queryFingerprint
				&& isQueryCovered(load.coverage, this.buildCatalogActiveQuery(loadAll)) ? this.catalogDesktopTotalCount : null);
			this.hasCommittedCatalogDesktopQuery = true;
			this.cardFlowError = null;
			this.pageRefreshError = null;
			this.syncPageFeedback();
			this.filteredMemosCache = null;
			this.retainMemoCardPreviews();
			if (forceRebuild) {
				this.resetVisibleMemos();
			}
			if (immediateTotalCount === null && this.shouldCountCatalogQuery()) {
				void this.refreshCatalogDesktopTotalCount({
					loadAll,
					queryFingerprint,
					queryRun,
					sourceGeneration,
					catalogRevision: load.catalogRevision,
				});
			}
			loaded = true;
		} catch (error) {
			if (controller.signal.aborted || error instanceof CatalogQueryCancelledError
				|| error instanceof CatalogDiscoveryInvalidatedError || error instanceof TimeBuoyIndexPendingError) {
				if (!this.trashViewClosed && this.isCatalogQueryRunCurrent(queryRun, sourceGeneration, searchVersion)) {
					this.viewStateController.search.requestStatus = this.viewStateController.search.result === null ? "idle" : "ready";
					this.initialCatalogQueryPending = false;
					this.clearLoadingIndicators("cards");
					if (!this.hasCommittedCatalogDesktopQuery && !this.hasConfirmedMemoPresentation) this.renderUiState();
					this.syncSearchControls();
				}
				return false;
			}
			if (!this.isCatalogQueryRunCurrent(queryRun, sourceGeneration, searchVersion)
				|| !this.isCatalogQueryCurrent(queryFingerprint, loadAll)) {
				return false;
			}
			const message = formatServiceError(error, t("empty.cardFlowFailed"));
			this.viewStateController.search.requestStatus = "failed";
			if (!this.hasCommittedCatalogDesktopQuery && !this.confirmedDailyMemos?.pending && this.memos.length === 0) {
				this.memos = [];
				this.retainMemoCardPreviews();
				this.cardFlowError = message;
			}
			if (!this.cardFlowError) this.reportViewRefreshFailure(error, "query");
		} finally {
			if (this.catalogDesktopQueryController === controller) {
				this.catalogDesktopQueryController = null;
				this.initialCatalogQueryPending = false;
			}
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
		if (loaded && this.activeNav === "record-stats"
			&& this.catalogCoverage !== null && isCompleteCatalogCoverage(this.catalogCoverage)) {
			void this.prepareRecordStats();
		} else if (!loaded && this.activeNav === "record-stats") {
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

	private async loadCatalogMemos(loadAll: boolean, signal?: AbortSignal): Promise<CatalogMemoLoad> {
		for (let attempt = 0; ; attempt++) {
			const coverageKey = catalogCoverageKey(this.catalogCoverage);
			try {
				const load = await this.loadCatalogMemoSnapshot(loadAll, signal);
				signal?.throwIfAborted();
				if (coverageKey !== catalogCoverageKey(this.catalogCoverage)
					&& catalogCoverageKey(load.coverage) !== catalogCoverageKey(this.catalogCoverage)) throw new CatalogDiscoveryInvalidatedError();
				return load;
			} catch (error) {
				signal?.throwIfAborted();
				if (!(error instanceof CatalogDiscoveryInvalidatedError)) throw error;
				// 索引正常前进时最多重读三次；仍失效交回后续刷新，不把等待画成失败。
				if (attempt === 2) throw error;
			}
		}
	}

	private async loadCatalogMemoSnapshot(loadAll: boolean, signal?: AbortSignal): Promise<CatalogMemoLoad> {
		signal?.throwIfAborted();
		let page = await this.queryCatalogFeature({
			...this.buildCatalogActiveQuery(loadAll),
			limit: CATALOG_PAGE_SIZE,
			cursor: null,
		}, signal);
		signal?.throwIfAborted();
		if (page.invalidated) throw new CatalogDiscoveryInvalidatedError();
		if (page.readState === "storage_unavailable") throw new Error(t("empty.cardFlowFailed"));
		let fullHistoryLoaded = loadAll;
		if (!loadAll && this.isDefaultListState() && page.nextCursor === null) {
			// 近月窗口已读完时直接确认全历史，避免小库反复显示无效的加载入口。
			page = await this.queryCatalogFeature({
				...this.buildCatalogActiveQuery(true),
				limit: CATALOG_PAGE_SIZE,
				cursor: null,
			}, signal);
			signal?.throwIfAborted();
			if (page.invalidated) throw new CatalogDiscoveryInvalidatedError();
			fullHistoryLoaded = true;
		}
		let todayTimeBuoys: TodayTimeBuoySnapshot | undefined;
		if (this.shouldShowTodayTimeBuoys()) {
			// 先准备同版本的置顶结果，再提交列表，避免先撤下置顶又重新提升。
			const today = await this.timeBuoyViewController.prepareTodayOnly(undefined, signal);
			signal?.throwIfAborted();
			if (!today.todayValid && this.hasCommittedCatalogDesktopQuery) {
				if (today.todayError === null) throw new TimeBuoyIndexPendingError();
				if (today.todayError instanceof Error) throw today.todayError;
				throw new Error(formatServiceError(today.todayError, "Today's time buoy index is not ready."));
			}
			if (today.todayValid && today.todayRevision !== page.catalogRevision) {
				throw new CatalogDiscoveryInvalidatedError();
			}
			todayTimeBuoys = today;
		}
		return {
			todayTimeBuoys,
			fullHistoryLoaded,
			memos: this.confirmedDailyMemos?.merge(page.items.map(toCatalogMemoView), this.buildCatalogActiveQuery(loadAll)) ?? page.items.map(toCatalogMemoView),
			nextCursor: page.nextCursor,
			coverage: page.coverage,
			readState: page.readState,
			status: page.status,
			catalogRevision: page.catalogRevision,
		};
	}

	private shouldWaitForInitialCatalogLoad(load: CatalogMemoLoad): boolean {
		return !this.hasVisibleConfirmedMemoPresentation() && !this.hasCommittedCatalogDesktopQuery
			&& (load.readState === "history_building" || load.coverage.configurationComplete === false);
	}

	private hasVisibleConfirmedMemoPresentation(): boolean {
		return this.hasConfirmedMemoPresentation && (this.getFilteredMemos().length > 0 || this.getTodayTimeBuoyItems().length > 0);
	}

	private applyCatalogMemoLoad(load: CatalogMemoLoad): void {
		if (load.todayTimeBuoys?.todayValid && !this.confirmedDailyMemos?.pending) this.confirmedTodayTimeBuoys = [];
		this.catalogTodayTimeBuoys = load.todayTimeBuoys ?? null;
		this.catalogCursor = load.nextCursor;
		this.catalogCoverage = load.coverage;
		this.catalogReadState = load.readState;
		this.catalogStatus = load.status;
		this.catalogRevision = load.catalogRevision;
		this.syncRecordStatsSource();
		if (this.libraryIndexRevision !== load.catalogRevision || this.libraryIndexCoverageKey !== catalogCoverageKey(load.coverage)
			|| this.librarySummary === null || this.libraryTagFacets === null) {
			void this.refreshCatalogLibraryIndexes();
		}
	}

	private getImmediateCatalogTotalCount(load: CatalogMemoLoad): number | null {
		if (this.confirmedDailyMemos?.pending) return null;
		return load.nextCursor === null && isQueryCovered(load.coverage, this.viewStateController.search.result?.filter ?? this.buildCatalogActiveQuery(true))
			? load.memos.length
			: null;
	}

	private async refreshCatalogDesktopTotalCount(options: {
		loadAll: boolean;
		queryFingerprint: string;
		queryRun: number;
		sourceGeneration: number;
		catalogRevision: number;
	}): Promise<void> {
		const countRun = ++this.catalogDesktopCountRun;
		this.cancelCatalogDesktopCount();
		const controller = new AbortController();
		this.catalogDesktopCountController = controller;
		try {
			const result = await this.countCatalogFeature(options.loadAll, controller.signal);
			if (options.sourceGeneration !== this.memoSourceGeneration
				|| controller.signal.aborted
				|| options.queryRun !== this.catalogDesktopQueryRun
				|| countRun !== this.catalogDesktopCountRun
				|| !this.isCatalogQueryCurrent(options.queryFingerprint, options.loadAll)
				|| result.catalogRevision !== options.catalogRevision
				|| (this.catalogCoverage != null && catalogCoverageKey(result.coverage) !== catalogCoverageKey(this.catalogCoverage))
				|| !result.complete
				|| result.count === null) {
				return;
			}
			const previousCardFlowKey = this.getCardFlowStateKey();
			this.catalogDesktopTotalCount = result.count;
			this.syncSearchControls();
			this.renderCardFlowIfChanged(previousCardFlowKey);
		} catch (error) {
			if (!controller.signal.aborted) console.warn("Knomo search count failed", error);
		} finally {
			if (this.catalogDesktopCountController === controller) this.catalogDesktopCountController = null;
		}
	}

	private cancelCatalogDesktopCount(): void {
		this.catalogDesktopCountController?.abort();
		this.catalogDesktopCountController = null;
	}

	private countCatalogFeature(loadAll: boolean, signal?: AbortSignal): Promise<CatalogMemoCountResult> {
		return this.getCatalogReadService().count(this.buildCatalogActiveQuery(loadAll), signal);
	}

	private shouldCountCatalogQuery(): boolean {
		if (this.confirmedDailyMemos?.pending) return false;
		return this.activeNav === "things" || this.activeNav === "review"
			|| (this.recordStatsSearchFilter !== null && this.recordStatsSearchFilter !== undefined)
			|| (this.activeTagKey !== null && this.activeTagKey !== undefined)
			|| (typeof this.searchQuery === "string" && this.searchQuery.trim().length > 0)
			|| (this.searchDateFilter !== null && this.searchDateFilter !== undefined)
			|| (this.scopeFilter !== undefined && this.scopeFilter !== "all");
	}

	updateCatalogProgress(coverage: CatalogCoverage, scan?: CatalogScanSnapshot): void {
		const previousAttention = scan ? JSON.stringify(getCatalogReadStatusHeaders({ status: this.catalogStatus, coverage: this.catalogCoverage })) : "";
		const wasBlocked = scan && hasCatalogReadBlocker(this.catalogStatus, this.catalogCoverage);
		if (scan) this.catalogStatus = { ...this.catalogStatus, scan };
		const previousCoverageKey = catalogCoverageKey(this.catalogCoverage);
		this.catalogCoverage = { ...coverage };
		this.mobileSearchController?.updateCatalogProgress(coverage);
		const attentionChanged = scan && previousAttention !== JSON.stringify(getCatalogReadStatusHeaders({ status: this.catalogStatus, coverage: this.catalogCoverage }));
		const waitingChanged = scan && ((!this.hasCommittedCatalogDesktopQuery && !this.hasConfirmedMemoPresentation) || this.activeNav === "record-stats")
			&& wasBlocked !== hasCatalogReadBlocker(this.catalogStatus, this.catalogCoverage);
		if (scan && (attentionChanged || waitingChanged) && !this.trashViewClosed) {
			this.renderCardFlow();
			this.renderMobileSearchResults();
		}
		const recordStatsSourceChanged = this.syncRecordStatsSource();
		if (recordStatsSourceChanged && this.activeNav === "record-stats") {
			this.renderCardFlow();
			if (isCompleteCatalogCoverage(coverage)) {
				this.recordStatsPreparationController.schedulePreparation({
					isPreparedForSource: (source) => this.recordStatsService.isPreparedForSource(source),
					prepare: () => { void this.prepareRecordStats(); },
				});
			}
		}
		if (!isCompleteCatalogCoverage(coverage)) {
			this.cancelCatalogDesktopCount();
			const hadDesktopTotalCount = typeof this.catalogDesktopTotalCount === "number";
			const previousDesktopCount = this.catalogDesktopTotalCount;
			if (!isQueryCovered(coverage, this.viewStateController.search.result?.filter ?? this.buildCatalogActiveQuery(true))) this.catalogDesktopTotalCount = null;
			this.catalogDesktopCountRun += 1;
			if (hadDesktopTotalCount && (this.activeNav === "things"
				|| ((this.activeNav === "all" || this.activeNav === "review")
					&& this.getCatalogPresentationTotalCount() !== previousDesktopCount))) this.renderCardFlow();
			const shouldRender = !this.libraryIndexesInvalidatedByCoverage || !this.libraryIndexesUpdating;
			if (!this.libraryIndexesInvalidatedByCoverage) {
				this.libraryIndexesInvalidatedByCoverage = true;
				this.libraryIndexRun += 1;
			}
			this.libraryIndexRevision = -1;
			this.libraryIndexesUpdating = true;
			if (shouldRender) {
				this.renderStats();
				this.renderTags();
			}
			return;
		}
		if (!this.libraryIndexesInvalidatedByCoverage) {
			if (previousCoverageKey !== catalogCoverageKey(coverage)) void this.refreshCatalogLibraryIndexes();
			return;
		}
		this.libraryIndexesInvalidatedByCoverage = false;
		this.libraryIndexRun += 1;
		this.libraryIndexRevision = -1;
		this.libraryIndexesUpdating = true;
		this.renderStats();
		this.renderTags();
		void this.refreshCatalogLibraryIndexes();
	}

	private async loadNextCatalogPage(): Promise<boolean> {
		if (this.viewStateController.search.requestStatus === "pending") return false;
		if (this.catalogLoadingNextPage) return false;
		const today = this.catalogTodayTimeBuoys;
		if (today?.todayValid && today.todayCursor != null && this.shouldShowTodayTimeBuoys()) {
			const queryRun = this.catalogDesktopQueryRun;
			const controller = this.beginCatalogDesktopQuery();
			this.catalogLoadingNextPage = true;
			try {
				const next = await this.timeBuoyViewController.prepareTodayOnly(today.todayCursor, controller.signal);
				controller.signal.throwIfAborted();
				if (this.trashViewClosed || queryRun !== this.catalogDesktopQueryRun || !this.shouldShowTodayTimeBuoys()) return false;
				if (!next.todayValid || next.todayRevision !== today.todayRevision) return this.reloadMemos(false, true);
				this.catalogTodayTimeBuoys = { ...next, today: [...today.today, ...next.today] };
				this.renderCardFlow();
				this.renderNextCardBatch(this.renderGeneration);
				return true;
			} catch (error) {
				if (controller.signal.aborted || error instanceof CatalogQueryCancelledError) return false;
				throw error;
			} finally {
				if (this.catalogDesktopQueryController === controller) {
					this.catalogDesktopQueryController = null;
					this.catalogLoadingNextPage = false;
				}
			}
		}
		if (this.catalogHistoryExpansionPending) {
			this.catalogHistoryExpansionPending = false;
			this.catalogLoadingNextPage = true;
			try {
				const loaded = await this.reloadMemos(true);
				if (loaded && !(Platform.isMobile && this.composerOpen)) {
					this.renderNextCardBatch(this.renderGeneration);
				}
				if (!loaded && this.isDefaultListState()) {
					this.catalogHistoryExpansionPending = true;
				}
				return loaded;
			} finally {
				this.catalogLoadingNextPage = false;
				if (this.cardFlowEl != null) this.renderHistoryLoadMore();
			}
		}
		if (this.catalogCursor === null) return false;
		const queryFingerprint = this.getCatalogQueryFingerprint(true);
		if (queryFingerprint !== this.catalogDesktopQueryFingerprint) {
			return this.reloadMemos(true, true);
		}
		const queryRun = this.catalogDesktopQueryRun;
		const coverageKey = catalogCoverageKey(this.catalogCoverage);
		const controller = this.beginCatalogDesktopQuery();
		this.catalogLoadingNextPage = true;
		try {
			const page = await this.queryCatalogFeature({
				...this.buildCatalogActiveQuery(true),
				limit: CATALOG_PAGE_SIZE,
				cursor: this.catalogCursor,
			}, controller.signal);
			controller.signal.throwIfAborted();
			if (queryRun !== this.catalogDesktopQueryRun
				|| !this.isCatalogQueryCurrent(queryFingerprint, true)) return false;
			if (page.invalidated || (coverageKey !== catalogCoverageKey(this.catalogCoverage) && catalogCoverageKey(page.coverage) !== catalogCoverageKey(this.catalogCoverage))) return this.reloadMemos(false, true);
			const byRenderKey = new Map(this.memos.map((memo) => [getMemoRenderKey(memo), memo]));
			for (const memo of page.items.map(toCatalogMemoView)) byRenderKey.set(getMemoRenderKey(memo), memo);
			this.memos = this.confirmedDailyMemos?.merge([...byRenderKey.values()], this.buildCatalogActiveQuery(true))
				?? mergeCatalogMemoPages([...byRenderKey.values()]);
			this.catalogCursor = page.nextCursor;
			this.catalogCoverage = page.coverage;
			this.catalogReadState = page.readState;
			this.catalogStatus = page.status;
			this.catalogRevision = page.catalogRevision;
			this.viewStateController.search.commitResult(this.buildCatalogActiveQuery(true), page.catalogRevision, catalogCoverageKey(page.coverage));
			this.syncRecordStatsSource();
			this.filteredMemosCache = null;
			// 分页保留已渲染正文的高度，避免异步 Markdown 重建使滚动位置被压回顶部。
			this.renderCardFlow();
			if (!(Platform.isMobile && this.composerOpen)) {
				this.renderNextCardBatch(this.renderGeneration);
			}
			return true;
		} catch (error) {
			if (controller.signal.aborted || error instanceof CatalogQueryCancelledError) return false;
			throw error;
		} finally {
			if (this.catalogDesktopQueryController === controller) {
				this.catalogDesktopQueryController = null;
				this.catalogLoadingNextPage = false;
			}
		}
	}

	private async loadCatalogMobileSearchResults(query: CatalogFeatureFilter, cursor: CatalogFeatureCursor | null, signal: AbortSignal): Promise<MobileSearchPage> {
		signal.throwIfAborted();
		const page = await this.getCatalogReadService().query({ ...query, limit: CATALOG_PAGE_SIZE, cursor }, signal);
		signal.throwIfAborted();
		return { ...page, items: page.items.map(toCatalogMemoView) };
	}

	private buildCatalogActiveQuery(loadAll: boolean): CatalogQueryFilter {
		const today = new Date();
		const source = this.viewStateController.getSearchSource(today);
		const query = this.viewStateController.search.getFilter(source, today);
		if (!loadAll && this.isDefaultListState()) query.fromDate = formatDatePart(new Date(today.getFullYear(), today.getMonth() - 1, 1));
		return query;
	}

	private getCatalogQueryFingerprint(loadAll: boolean): string { return getCatalogQueryKey(this.buildCatalogActiveQuery(loadAll)); }

	private prepareCatalogDesktopQuery(queryFingerprint: string): void {
		if (queryFingerprint === this.catalogDesktopQueryFingerprint) { this.initialCatalogQueryPending = true; return; }
		this.cancelCatalogDesktopQuery();
		this.cancelCatalogDesktopCount();
		this.catalogDesktopQueryFingerprint = queryFingerprint;
		this.catalogDesktopQueryRun += 1;
		this.catalogDesktopCountRun += 1;
		this.catalogCursor = null;
		this.catalogHistoryExpansionPending = false;
		if (this.viewStateController.search.result === null) this.catalogDesktopTotalCount = null;
		this.cardFlowError = null;
		this.filteredMemosCache = null;
		this.retainMemoCardPreviews();
		this.initialCatalogQueryPending = true;
		if (!this.hasCommittedCatalogDesktopQuery && !this.hasVisibleConfirmedMemoPresentation()) {
			this.memos = [];
			this.resetVisibleMemos();
			this.renderAllMemosLoadingState();
		}
	}

	private isCatalogQueryCurrent(queryFingerprint: string, loadAll: boolean): boolean {
		return queryFingerprint === this.catalogDesktopQueryFingerprint
			&& queryFingerprint === this.getCatalogQueryFingerprint(loadAll);
	}

	private isCatalogQueryRunCurrent(queryRun: number, sourceGeneration: number, searchVersion: number): boolean {
		return sourceGeneration === this.memoSourceGeneration
			&& queryRun === this.catalogDesktopQueryRun
			&& searchVersion === this.viewStateController.search.version;
	}

	private queryCatalogFeature(request: CatalogFeatureQuery, signal?: AbortSignal): Promise<CatalogMemoPage> {
		return this.getCatalogReadService().query(request, signal);
	}

	private beginCatalogDesktopQuery(): AbortController {
		this.cancelCatalogDesktopQuery();
		this.initialCatalogQueryPending = true;
		const controller = new AbortController();
		this.catalogDesktopQueryController = controller;
		return controller;
	}

	private cancelCatalogDesktopQuery(): void {
		this.initialCatalogQueryPending = false;
		if (this.catalogDesktopQueryController != null) {
			this.catalogDesktopQueryController.abort();
			this.catalogLoadingNextPage = false;
		}
		this.catalogDesktopQueryController = null;
		this.memoLoadingPromise = null;
		this.memoLoadingFingerprint = null;
	}

	private async loadInitialMobileMemos(): Promise<void> {
		let loadAll = false;
		let queryFingerprint = this.getCatalogQueryFingerprint(loadAll);
		this.prepareCatalogDesktopQuery(queryFingerprint);
		const controller = this.beginCatalogDesktopQuery();
		const queryRun = ++this.catalogDesktopQueryRun;
		const sourceGeneration = this.memoSourceGeneration;
		const searchVersion = this.viewStateController.search.version;
		const coverageKey = catalogCoverageKey(this.catalogCoverage);
		try {
			const load = await this.loadCatalogMemos(loadAll, controller.signal);
			controller.signal.throwIfAborted();
			if (
				!this.isCatalogQueryRunCurrent(queryRun, sourceGeneration, searchVersion)
				|| !this.isCatalogQueryCurrent(queryFingerprint, loadAll)
				|| this.cardFlowEl === null
				|| !this.cardFlowEl.isConnected
			) {
				return;
			}
			if (load.fullHistoryLoaded) {
				loadAll = true;
				queryFingerprint = this.getCatalogQueryFingerprint(true);
				this.catalogDesktopQueryFingerprint = queryFingerprint;
			}
			if (coverageKey !== catalogCoverageKey(this.catalogCoverage) && catalogCoverageKey(load.coverage) !== catalogCoverageKey(this.catalogCoverage)) throw new CatalogDiscoveryInvalidatedError();
			this.applyCatalogMemoLoad(load);
			// 两端使用相同的首批提交条件，不将构建中的空结果或子集视为已加载。
			if (this.shouldWaitForInitialCatalogLoad(load)) {
				this.memos = [];
				this.cardFlowError = null;
				this.filteredMemosCache = null;
				this.renderUiState();
				return;
			}
			this.catalogHistoryExpansionPending = !load.fullHistoryLoaded && this.isDefaultListState();
			this.memos = load.memos;
			this.viewStateController.search.commitResult(this.buildCatalogActiveQuery(loadAll), load.catalogRevision, catalogCoverageKey(load.coverage));
			this.hasCommittedCatalogDesktopQuery = true;
			this.cardFlowError = null;
			this.pageRefreshError = null;
			this.syncPageFeedback();
			this.filteredMemosCache = null;
			this.retainMemoCardPreviews();
			this.resetVisibleMemos();
			this.renderUiState();
		} catch (error) {
			if (controller.signal.aborted || error instanceof CatalogQueryCancelledError
				|| error instanceof CatalogDiscoveryInvalidatedError || error instanceof TimeBuoyIndexPendingError) {
				if (!this.trashViewClosed && this.isCatalogQueryRunCurrent(queryRun, sourceGeneration, searchVersion)) {
					this.initialCatalogQueryPending = false;
					this.clearLoadingIndicators("cards");
					if (!this.hasCommittedCatalogDesktopQuery && !this.hasConfirmedMemoPresentation) this.renderUiState();
				}
				return;
			}
			if (
				!this.isCatalogQueryRunCurrent(queryRun, sourceGeneration, searchVersion)
				|| !this.isCatalogQueryCurrent(queryFingerprint, false)
				|| this.cardFlowEl === null
				|| !this.cardFlowEl.isConnected
			) {
				return;
			}
			const message = formatServiceError(error, t("empty.cardFlowFailed"));
			if (!this.confirmedDailyMemos?.pending && this.memos.length === 0) {
				this.retainMemoCardPreviews();
				this.cardFlowError = message;
			}
			if (!this.cardFlowError) this.reportViewRefreshFailure(error, "initial-query");
			this.renderUiState();
		} finally {
			if (this.catalogDesktopQueryController === controller) {
				this.catalogDesktopQueryController = null;
				this.initialCatalogQueryPending = false;
			}
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
		if (this.inputEl !== null) {
			this.inputEl.disabled = !dailyStatus.enabled;
		}
		if (this.isSaving || this.editingMemo !== null || this.quoteReferenceText !== null || this.cardFlowError !== null) {
			return;
		}
		this.updateStatus("", false);
	}

	private syncComposerMode(): void {
		this.scheduleLocalDraft();
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

	private syncReducedGlassEffects(): void {
		const reduced = this.settingsService.getSettings().reduceGlassEffects === true;
		for (const container of [this.containerEl, this.rootEl, this.mobileComposerController.getLayerEl(), ...(this.mobileGlassSurfaces ?? [])]) {
			container?.toggleClass("knomo-reduce-glass", reduced);
		}
	}

	private registerMobileGlassSurface(surface: HTMLElement): () => void {
		if (this.currentLayout !== "mobile") return () => {};
		// 只登记本视图创建的独立浮层，不查询或标记其他插件的宿主菜单。
		const surfaces = this.mobileGlassSurfaces ??= new Set<HTMLElement>();
		surfaces.add(surface);
		surface.addClass("knomo-mobile-glass-surface");
		surface.toggleClass("knomo-reduce-glass", this.settingsService.getSettings().reduceGlassEffects === true);
		return () => {
			surfaces.delete(surface);
			surface.classList.remove("knomo-mobile-glass-surface", "knomo-reduce-glass");
		};
	}

	private clearMobileGlassSurfaces(): void {
		for (const surface of this.mobileGlassSurfaces ?? []) surface.classList.remove("knomo-mobile-glass-surface", "knomo-reduce-glass");
		this.mobileGlassSurfaces?.clear();
		this.mobileGlassSurfaces = null;
		for (const container of [this.containerEl, this.rootEl, this.mobileComposerController.getLayerEl()]) container?.removeClass("knomo-reduce-glass");
	}

	private syncRootState(): void {
		const root = this.rootEl;
		if (root === null) {
			return;
		}
		const sidebarState = this.desktopSidebarStateController.getSnapshot();
		if (this.currentLayout === "desktop-narrow") {
			const width = getDrawerWidth(this.getRootInnerWidth(), sidebarState.width);
			root.setCssProps({ "--knomo-drawer-width": `${width}px` });
			if (width <= 0) this.mobileDrawerOpen = false;
		}
		root.toggleClass("is-layout-desktop-wide", this.currentLayout === "desktop-wide");
		root.toggleClass("is-layout-desktop-narrow", this.currentLayout === "desktop-narrow");
		root.toggleClass("is-layout-mobile", this.currentLayout === "mobile");
		root.toggleClass("is-sidebar-collapsed", sidebarState.collapsed);
		root.toggleClass("is-drawer-open", this.mobileDrawerOpen);
		root.toggleClass("is-desktop-search-open", this.desktopSearchOpen);
		root.toggleClass("is-scope-open", this.currentLayout !== "mobile" && this.scopeMenuOpen);
		root.toggleClass("is-composer-open", this.composerOpen);
		this.syncPageFeedback();
		root.toggleClass("is-compact-search-open", this.compactSearchOpen);
		root.toggleClass("is-mobile-search-open", this.mobileSearchPageOpen);
		root.toggleClass("is-mobile-compact", this.settingsService.getSettings().mobileCompactMode !== "off");
		this.syncReducedGlassEffects();
		root.toggleClass("is-record-stats", this.activeNav === "record-stats");
		root.toggleClass("is-time-buoy", this.activeNav === "time-buoy");
		root.toggleClass("is-shuffle-day", this.activeNav === "shuffleDay");
		root.setCssProps({ "--knomo-sidebar-width": `${sidebarState.width}px` });
		if (this.currentLayout !== "mobile") this.desktopDrawerFocus.sync(root, this.currentLayout === "desktop-narrow", this.mobileDrawerOpen, sidebarState.collapsed);
		this.syncTooltipState(root);
		this.syncManualRefreshButtonState();
		this.syncMobileHeaderActions();
		this.syncMobileHeaderTitle();
		this.syncMobileTopOffsets(root);
		this.syncTitlePopoverPosition();
		this.syncMobileSearchPage();
		this.syncSearchControls();
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
		this.positionOpenCardMenus();
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
		if (root === null || this.currentLayout === "mobile" || !this.scopeMenuOpen) {
			return;
		}
		const anchor = this.getTitlePopoverAnchor();
		const menu = root.find(this.currentLayout === "desktop-wide" ? ".knomo-desktop-scope-popover" : ".knomo-mobile-scope-popover");
		if (anchor === null || !menu?.instanceOf(HTMLElement)) return;
		positionDesktopMenu(menu, anchor, anchor.closest<HTMLElement>(".knomo-main") ?? root, "start");
	}

	private getTitlePopoverAnchor(): HTMLElement | null {
		if (this.currentLayout === "mobile") {
			return this.mobileHeaderTitleController.getAnchor();
		}
		const header = this.currentLayout === "desktop-narrow" ? ".knomo-compact-header" : ".knomo-topbar";
		for (const titleHost of this.titleHosts) {
			if (titleHost.el.isConnected && titleHost.el.closest(header) !== null) {
				const labelEl = titleHost.el.find(".knomo-title-label");
				return labelEl?.instanceOf(HTMLElement) ? labelEl : titleHost.el;
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
		if (this.activeNav === "things") {
			this.mobileSearchController.searchQuery = this.searchQuery;
			this.mobileSearchController.searchDateFilter = this.searchDateFilter;
			this.mobileSearchController.searchRecordStatsFilter = null;
		}
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

	private async restoreCardFlowAfterMobileSearch(): Promise<void> {
		// 仍读取当前查询并更新 occurrence；未变化的显示沿用增量比较，不强制重建卡片。
		await this.reloadMemos(false);
	}

	private removeMobileSearchPage(): void {
		this.mobileSearchController.removePage();
	}

	private setMobileSearchDateFilter(filter: SearchDateFilter): void {
		this.mobileSearchController.setDateFilter(filter);
	}

	private loadMoreMobileSearchResults(): void {
		this.mobileSearchController.loadMore();
	}

	private renderMobileSearchResults(changeIntent: CardFlowChangeIntent = "content-change", metadataOnly = false): void {
		this.mobileSearchController.renderResults(changeIntent, false, metadataOnly);
	}

	private startLayoutObserver(): void {
		const win: WindowWithResizeObserver = this.containerEl.win;
		if (this.layoutWindow === win) return;
		this.stopLayoutObserver();
		this.layoutWindow = win;
		const measure = () => {
			if (!this.trashViewClosed && this.layoutWindow === win) this.syncLayoutMeasurements();
		};
		win.addEventListener("resize", measure);
		win.addEventListener("focus", measure);
		win.document.addEventListener("visibilitychange", measure);
		this.layoutWindowCleanup = () => {
			win.removeEventListener("resize", measure);
			win.removeEventListener("focus", measure);
			win.document.removeEventListener("visibilitychange", measure);
		};
		const ResizeObserverConstructor = win.ResizeObserver;
		if (ResizeObserverConstructor !== undefined) {
			const observer = new ResizeObserverConstructor(measure);
			observer.observe(this.containerEl);
			if (this.rootEl) observer.observe(this.rootEl);
			this.layoutObserver = observer;
		}
		this.syncLayoutMeasurements();
	}

	private stopLayoutObserver(): void {
		this.layoutWindowCleanup?.();
		this.layoutWindowCleanup = null;
		this.layoutWindow = null;
		this.finishSidebarResize();
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
		// 搜索控件需要换位时，先让原输入框完成组合，避免隐藏焦点中断 IME。
		if (this.layoutSearchComposing) return;
		const previousLayout = this.currentLayout;
		this.currentLayout = resolveLayout(Platform.isMobile, this.containerEl.getBoundingClientRect().width, previousLayout);
		if (previousLayout === this.currentLayout) return;
		const active = this.containerEl.ownerDocument.activeElement;
		const searchFocused = active === this.desktopSearchInputEl || active === this.compactInlineSearchInputEl || active === this.compactSearchInputEl;
		const selection = searchFocused && active ? { start: (active as HTMLInputElement).selectionStart, end: (active as HTMLInputElement).selectionEnd } : null;
		const headerFocused = active && this.rootEl?.contains(active) && active.closest(".knomo-topbar, .knomo-compact-header");
		const sidebarFocused = active && this.sidebarEl?.contains(active);
		this.finishSidebarResize();
		this.mobileDrawerOpen = false;
		this.scopeMenuOpen = false;
		this.compactSearchOpen = false;
		this.closeTimeBuoyPicker(false);
		this.closeCardMenu();
		this.syncRootState();
		if (searchFocused && active) {
			const input = this.currentLayout === "desktop-wide" ? this.desktopSearchInputEl : this.compactInlineSearchInputEl;
			// 保留尚未经过查询 debounce 的输入，不触发新的 Catalog 查询。
			if (input) {
				input.value = (active as HTMLInputElement).value;
				if (selection) input.setSelectionRange(selection.start, selection.end);
			}
			input?.focus({ preventScroll: true });
		} else if (headerFocused || sidebarFocused && this.currentLayout === "desktop-narrow") {
			const selector = this.currentLayout === "desktop-wide" ? '.knomo-topbar button' : '.knomo-compact-menu-btn';
			Array.from(this.rootEl?.querySelectorAll<HTMLElement>(selector) ?? []).find(el => el.getClientRects().length)?.focus({ preventScroll: true });
		}
	}

	private renderStats(): void {
		const stats = this.librarySummary;
		const metrics: [string, string][] = [
			[stats === null ? "—" : String(stats.memoCount), t("stats.notes")],
			[stats === null ? "—" : String(stats.tagCount), t("stats.tags")],
			[stats === null ? "—" : stats.imageCount > 0 ? String(stats.imageCount) : String(stats.wordCount),
				stats !== null && stats.imageCount > 0 ? t("stats.images") : t("stats.words")],
		];
		for (const statsEl of this.statsEls) {
			statsEl.toggleClass("is-loading", stats === null);
			statsEl.removeClass("is-updating");
			statsEl.toggleClass("knomo-sidebar-stats-updating", stats !== null && this.libraryIndexesUpdating);
			if (stats === null || this.libraryIndexesUpdating) statsEl.setAttr("aria-busy", "true");
			else statsEl.removeAttribute("aria-busy");
			renderSidebarStats(statsEl, metrics, stats !== null && this.libraryIndexesUpdating);
		}
	}

	private renderPublishedSidebarTags(): void {
		// 等待回调与订阅帧可能先后到达，同一快照只补绘一次。
		if (this.rootEl === null || this.trashViewClosed
			|| (this.isDrawerLayout() ? !this.mobileDrawerOpen : this.desktopSidebarStateController.getSnapshot().collapsed)
			|| this.renderedTagRevision === this.vaultTagIndex.getSnapshot().revision) return;
		this.renderTags();
	}

	private renderTags(): void {
		if (Platform.isMobile && !this.mobileDrawerOpen) {
			this.clearLoadingIndicators("tags");
			return;
		}
		if (!Platform.isMobile && this.vaultTagIndex.getSnapshot().status === "idle") {
			void this.vaultTagIndex.ensureReady().catch((error: unknown) => {
				if (!this.trashViewClosed) console.error("[Knomo] Sidebar tag index could not be loaded", error);
			});
		}
		if (this.allTagsEl === null) return;
		const snapshot = this.vaultTagIndex.getSnapshot();
		this.renderedTagRevision = snapshot.revision;
		const blocked = !this.getDailyNotesStatus().enabled || hasCatalogReadBlocker(this.catalogStatus, this.catalogCoverage);
		const visible = this.libraryTagFacets === null && !this.libraryIndexError && !blocked
			? this.revealLoadingAfterDelay("tags", `tags:${this.memoSourceGeneration}`, () => this.renderTags()) : false;
		if (this.libraryTagFacets !== null || this.libraryIndexError || blocked) this.clearLoadingIndicators("tags");
		const key = JSON.stringify([this.libraryTagFacets, snapshot.revision, this.activeTagKey,
			[...this.expandedTagGroups], this.libraryIndexesUpdating, this.libraryIndexError, blocked, visible,
			blocked ? this.catalogStatus : null, getKnomoLocale()]);
		const previous = this.sidebarTagRender;
		if (previous?.container === this.allTagsEl && previous.key === key
			&& previous.firstChild === this.allTagsEl.firstChild) return;
		if (this.libraryTagFacets === null) {
			if (this.libraryIndexError || blocked) this.allTagsEl.removeAttribute("aria-busy");
			else this.allTagsEl.setAttr("aria-busy", "true");
			this.allTagsEl?.empty();
			if (blocked) {
				if (!this.getDailyNotesStatus().enabled) this.allTagsEl.createDiv({ cls: "knomo-muted-text", text: t("service.dailyNotesDisabled") });
				else renderKnomoCardFlowHeaders(this.allTagsEl, getCatalogReadStatusHeaders({ status: this.catalogStatus, coverage: this.catalogCoverage }));
			} else if (this.libraryIndexError) this.renderTagIndexFailure();
			else if (visible) {
				const skeleton = this.allTagsEl.createDiv({ cls: "knomo-tag-loading", attr: { role: "status", "aria-live": "polite", "aria-label": t("loading.label") } });
				for (let index = 0; index < 3; index++) skeleton.createDiv({ cls: "knomo-loading-line is-short", attr: { "aria-hidden": "true" } });
			} else this.allTagsEl.createDiv({ cls: "knomo-muted-text" });
			this.sidebarTagRender = { container: this.allTagsEl, key, firstChild: this.allTagsEl.firstChild };
			return;
		}
		if (this.libraryIndexesUpdating) this.allTagsEl?.setAttr("aria-busy", "true");
		else this.allTagsEl?.removeAttribute("aria-busy");
		const displayTags = new Map(snapshot.displayByKey);
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
		if (this.libraryIndexError) this.renderTagIndexFailure();
		this.sidebarTagRender = { container: this.allTagsEl, key, firstChild: this.allTagsEl.firstChild };
	}

	private renderTagIndexFailure(): void {
		if (!this.allTagsEl) return;
		const feedback = this.allTagsEl.createDiv({ cls: "knomo-sidebar-updating", text: t("loading.tagsFailed"), attr: { role: "status", "aria-live": "polite" } });
		const retry = feedback.createEl("button", { cls: "knomo-inline-button", text: t("settings.attention.retry"), attr: { type: "button" } });
		retry.addEventListener("click", event => { event.stopPropagation(); void this.refreshCatalogLibraryIndexes(); });
	}

	private renderTrashCount(): void {
		const trashSnapshot = this.trashMemoController.getSnapshot();
		const trashCount = trashSnapshot.trashCount;
		for (const countEl of this.trashCountEls) {
			countEl.setText(trashSnapshot.trashCountError ? "!" : trashCount === null ? "—" : trashCount > 0 ? String(trashCount) : "");
			countEl.toggleAttribute("hidden", trashCount === 0 && !trashSnapshot.trashCountError);
			if (trashSnapshot.trashCountLoading) countEl.setAttr("aria-busy", "true");
			else countEl.removeAttribute("aria-busy");
			if (trashSnapshot.trashCountError) countEl.setAttr("aria-label", trashSnapshot.trashCountError);
			else countEl.removeAttribute("aria-label");
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
			element.setAttr(element.getAttribute("role") === "menuitemradio" ? "aria-checked" : "aria-pressed", active ? "true" : "false");
		});
		this.rootEl?.findAll("[data-search-date]").forEach((element) => {
			const active = element.getAttr("data-search-date") === this.searchDateFilter;
			element.toggleClass("is-active", active);
			element.setAttr(element.getAttribute("role") === "menuitemradio" ? "aria-checked" : "aria-pressed", active ? "true" : "false");
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
		if (!["all", "things", "review"].includes(this.activeNav)) this.clearLoadingIndicators("cards");
		if (this.activeNav !== "record-stats") this.clearLoadingIndicators("stats");
		const context = this.getRecentTimeFlowContext();
		const lifecycleKey = JSON.stringify([context.enabled, context.dates]);
		const presentationChanged = this.recentLifecycleKey !== "" && this.recentLifecycleKey !== lifecycleKey;
		this.recentLifecycleKey = lifecycleKey;
		if (presentationChanged) {
			this.clearMobileCardBatchContinuation();
			this.renderGeneration += 1;
			this.forceRebuildCardFlow(changeIntent);
			return;
		}
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
		this.clearLoadingIndicators("cards");
		this.syncCardFlowPresentation(presentation, preserveCardMemoId);
	}

	private renderRecordStatsPage(force = false): void {
		const cardFlow = this.cardFlowEl;
		if (cardFlow === null) {
			return;
		}
		this.clearLoadingIndicators("cards");
		const snapshot = this.recordStatsService.getSnapshot();
		const headers = getCatalogReadStatusHeaders({ status: this.catalogStatus, coverage: this.catalogCoverage });
		const dailyEnabled = this.getDailyNotesStatus().enabled;
		if (!dailyEnabled) headers.unshift({ type: "summary", text: t("service.dailyNotesDisabled") });
		const blocked = !dailyEnabled || hasCatalogReadBlocker(this.catalogStatus, this.catalogCoverage);
		const waiting = snapshot.state === "idle" || snapshot.state === "loading";
		if (snapshot.state === "idle" && !blocked && this.catalogCoverage !== null && isCompleteCatalogCoverage(this.catalogCoverage)) {
			this.recordStatsPreparationController.schedulePreparation({
				isPreparedForSource: source => this.recordStatsService.isPreparedForSource(source),
				prepare: () => { if (!this.trashViewClosed && this.activeNav === "record-stats") void this.prepareRecordStats(); },
			});
		}
		const visible = waiting && !blocked
			? this.revealLoadingAfterDelay("stats", `stats:${this.memoSourceGeneration}`, () => this.renderRecordStatsPage()) : false;
		if (!waiting || blocked) this.clearLoadingIndicators("stats");
		const pending = { visible, blocked, headers };
		const renderKey = JSON.stringify([this.getCardFlowStateKey(), pending]);
		if ((!force || waiting) && cardFlow.childElementCount > 0 && this.recordStatsViewStateController.isRendered(renderKey)) {
			return;
		}
		const recordStatsState = this.recordStatsViewStateController.getSnapshot();
		this.renderGeneration += 1;
		this.cardImageCache.capture(cardFlow, Platform.isMobile ? cardFlow : null);
		this.memoMarkdownRenderer.clear();
		this.cardImageLoadQueue.clear("card-flow");
		this.cardFlowCoordinator.resetFlowRuntime(this.containerEl.win);
		this.renderedCardMemos.clear();
		cardFlow.empty();
		const selected = this.recordStatsService.select(recordStatsState.view, recordStatsState.selectedDate);
		renderKnomoRecordStatsPage(cardFlow, {
			snapshot, pending,
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
		const snapshot = this.timeBuoyViewController.getSnapshot();
		const nextItems = snapshot[snapshot.activeTab];
		if (this.timeBuoyPanelEl?.id === `${this.getA11yId("time-buoy")}-panel-${snapshot.activeTab}`
			&& nextItems.length > this.timeBuoyRenderItems.length
			&& this.timeBuoyRenderItems.every((item, index) => item.memo === nextItems[index]?.memo
				&& item.primaryTargetDate === nextItems[index]?.primaryTargetDate)) {
			// 翻页追加保留已有卡片及高度，不重建已渲染的 Markdown。
			this.timeBuoyRenderItems = nextItems;
			this.renderNextTimeBuoyBatch(this.renderGeneration);
			return;
		}
		const panel = this.timeBuoyPanelEl ?? cardFlow.querySelector<HTMLElement>(".knomo-time-buoy-panel:not([hidden])");
		if (panel?.id === `${this.getA11yId("time-buoy")}-panel-${snapshot.activeTab}`
			&& !snapshot.loading && snapshot.error === null) {
			const wasPending = this.timeBuoyBatchFrameId !== null;
			if (wasPending) {
				this.containerEl.win.cancelAnimationFrame(this.timeBuoyBatchFrameId!);
				this.timeBuoyBatchFrameId = null;
			}
			this.removeTimeBuoyLoadMore();
			const scrollTop = this.getCardFlowScrollTop();
			const existing = new Map(Array.from(panel.querySelectorAll<HTMLElement>(".knomo-card"))
				.map(card => [card.getAttribute("data-memo-render-key") ?? card.getAttribute("data-memo-id"), card]));
			const previous = new Map(this.timeBuoyRenderItems.map(item => [getMemoRenderKey(item.memo), item]));
			const count = Math.min(nextItems.length, Math.max(this.getInitialCardBatchSize(), existing.size, this.timeBuoyRenderedCount));
			const cards: HTMLElement[] = [];
			for (const [index, item] of nextItems.slice(0, count).entries()) {
				const key = getMemoRenderKey(item.memo), before = previous.get(key);
				let card = existing.get(key);
				if (!card || !before || !this.canReuseRenderedMemo(before.memo, item.memo)
					|| before.primaryTargetDate !== item.primaryTargetDate
					|| JSON.stringify(before.targetDates) !== JSON.stringify(item.targetDates)) {
					this.appendTimeBuoyBatchItems(panel, [item], index, this.renderGeneration);
					card = panel.lastElementChild as HTMLElement;
				}
				cards.push(card);
			}
			const retained = new Set(cards);
			for (const card of existing.values()) if (!retained.has(card)) {
				this.memoMarkdownRenderer.releaseCard(card, "card-flow");
				this.renderedCardMemos.delete(card.getAttribute("data-memo-render-key") ?? card.getAttribute("data-memo-id")!);
				this.removeCardElement(card);
			}
			let following: HTMLElement | null = null;
			for (const card of [...cards].reverse()) {
				if (card.nextElementSibling !== following) panel.insertBefore(card, following);
				following = card;
			}
			this.timeBuoyPanelEl = panel;
			this.timeBuoyRenderItems = nextItems;
			this.timeBuoyRenderedCount = count;
			for (const item of nextItems.slice(0, count)) this.renderedCardMemos.set(getMemoRenderKey(item.memo), item.memo);
			syncTimeBuoyPanelState(panel, snapshot);
			this.renderTimeBuoyLoadMore(this.renderGeneration);
			this.restoreCardFlowScrollTop(scrollTop);
			this.syncCardMenuState();
			if (wasPending && count < nextItems.length) this.renderNextTimeBuoyBatch(this.renderGeneration);
			return;
		}
		this.resetTimeBuoyCardFlow();
		this.renderGeneration += 1;
		const generation = this.renderGeneration;
		this.cardImageCache.capture(cardFlow, Platform.isMobile ? cardFlow : null);
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
		if (panel !== null && generation === this.renderGeneration && this.timeBuoyBatchFrameId === null
			&& this.timeBuoyRenderedCount >= this.timeBuoyRenderItems.length) {
			void this.timeBuoyViewController.loadMore();
			return;
		}
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
			this.renderedCardMemos.set(getMemoRenderKey(item.memo), item.memo);
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
		const hasNextPage = this.timeBuoyViewController.getSnapshot().nextCursor !== null;
		if (panel === null || (remainingCount <= 0 && !hasNextPage)) {
			return;
		}
		const button = renderKnomoLoadMoreButton(panel, {
			remainingCount: hasNextPage ? null : remainingCount,
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
		if (!["all", "things", "review"].includes(this.activeNav)) this.clearLoadingIndicators("cards");
		if (this.activeNav !== "record-stats") this.clearLoadingIndicators("stats");
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
		const flowTop = this.cardFlowEl.getBoundingClientRect().top;
		const anchorCard = changeIntent === "content-change"
			? this.getDirectCardElements(this.cardFlowEl).find((card) => card.getBoundingClientRect().bottom > flowTop) : undefined;
		const anchorKey = anchorCard?.getAttr("data-memo-render-key");
		const anchor = anchorCard && anchorKey ? { renderKey: anchorKey, offset: anchorCard.getBoundingClientRect().top - flowTop } : undefined;
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
		const presentation = this.getCurrentCardFlowPresentation();
		if (presentation.type === "empty" && presentation.loading) {
			this.renderEmptyCardFlow(presentation);
			return;
		}
		this.clearLoadingIndicators("cards");
		const generation = this.renderGeneration + 1;
		this.renderGeneration = generation;
		const seedPlaceholder = createMemoRenderPlaceholders(this.getDirectCardElements(this.cardFlowEl).flatMap(card => {
			const key = card.getAttr("data-memo-render-key") ?? card.getAttr("data-memo-id");
			const memo = key ? this.renderedCardMemos.get(key) : undefined;
			return memo ? [{ memo, card }] : [];
		}));
		this.cardImageCache.capture(this.cardFlowEl, Platform.isMobile ? this.cardFlowEl : null, scrollTop);
		this.memoMarkdownRenderer.clear();
		this.cardImageLoadQueue.clear("card-flow");
		this.cardFlowCoordinator.resetFlowRuntime(this.containerEl.win);
		this.cardFlowEl.empty();
		this.renderedCardMemos.clear();
		this.cardFlowCoordinator.setPendingScrollRestore({ generation, scrollTop, visibleCount: initialBatchSize, anchor });
		this.renderCardFlowPresentation(presentation, generation, initialBatchSize, seedPlaceholder);
	}

	private deferMobileCardFlowRender(
		preserveCardMemoId: string | null,
		forceRebuild: boolean,
		changeIntent: CardFlowChangeIntent,
	): boolean {
		if (this.presentingConfirmedSave) return false;
		return this.cardFlowCoordinator.deferMobileRender({
			isMobile: Platform.isMobile,
			composerOpen: this.composerOpen,
			preserveCardMemoId,
			forceRebuild,
			changeIntent,
		});
	}

	private getCurrentCardFlowPresentation(): CardFlowPresentation {
		// 焦点和可见性检查也会重绘；首批结果未确认时不能按空数组显示空库。
		if (["all", "things", "review"].includes(this.activeNav)
			&& !this.hasCommittedCatalogDesktopQuery && !this.hasVisibleConfirmedMemoPresentation() && this.cardFlowError === null) {
			if (!this.getDailyNotesStatus().enabled) return { type: "empty", title: t("service.dailyNotesDisabled"), description: "" };
			const headers = getCatalogReadStatusHeaders({ status: this.catalogStatus, coverage: this.catalogCoverage });
			if (hasCatalogReadBlocker(this.catalogStatus, this.catalogCoverage)) return { type: "items", memos: [], mode: "memo", headers };
			if (!this.initialCatalogQueryPending && this.catalogReadState !== "history_building") return { type: "items", memos: [], mode: "memo", headers };
			return {
				type: "empty", title: "", description: "", loading: true, headers,
			};
		}
		const randomSnapshot = this.randomReunionController.getSnapshot();
		const shuffleDaySnapshot = this.shuffleDayController.getSnapshot();
		const trashSnapshot = this.trashMemoController.getSnapshot();
		const shouldLoadListMemos = this.cardFlowError === null
			&& this.activeNav !== "trash"
			&& this.activeNav !== "shuffleDay";
		const todayItems = this.getTodayTimeBuoyItems();
		const memos = shouldLoadListMemos
			? mergeTodayTimeBuoyFeed(this.catalogTodayTimeBuoys?.todayCursor != null && this.shouldShowTodayTimeBuoys()
				? [] : this.getFilteredMemos(), todayItems)
			: [];
		const matchedTotalCount = this.getCatalogPresentationTotalCount();
		let presentation = getCardFlowPresentation({
			cardFlowError: this.activeNav === "shuffleDay" ? null : this.cardFlowError,
			activeNav: this.activeNav,
			randomReunionStatus: randomSnapshot.status,
			randomReunionError: randomSnapshot.error,
			shuffleDay: shuffleDaySnapshot,
			memos,
			matchedTotalCount,
			regularFilterCopy: shouldLoadListMemos
				&& (this.activeNav === "all" || this.activeNav === "things")
				&& matchedTotalCount !== null ? getRegularFilterCopy({
				activeNav: this.activeNav,
				activeTag: this.activeTag,
				activeTagKey: this.activeTagKey,
				searchQuery: this.viewStateController.search.result?.input ?? this.searchQuery,
				searchDateFilter: this.viewStateController.search.result ? this.viewStateController.search.result.shortcut : this.searchDateFilter,
				recordStatsSearchFilter: this.recordStatsSearchFilter,
				scopeFilter: this.scopeFilter,
			}, matchedTotalCount) : null,
			trashLoading: trashSnapshot.trashLoading,
			trashError: trashSnapshot.trashError,
			trashMemos: trashSnapshot.trashMemos,
			trashCount: trashSnapshot.trashCount,
			trashClearBusy: trashSnapshot.trashClearBusy,
		});
		if (presentation.type === "empty" && this.shouldShowTimeBuoyIntro() && this.cardFlowError === null) {
			presentation = { type: "items", memos: [], mode: "memo", headers: [] };
		}
		if (this.cardFlowError === null && this.activeNav !== "trash") {
			const headers = getCatalogReadStatusHeaders({
				status: this.catalogStatus,
				coverage: this.catalogCoverage,
			});
			const queryCovered = this.catalogCoverage !== null && isQueryCovered(this.catalogCoverage,
				this.viewStateController.search.result?.filter ?? this.buildCatalogActiveQuery(true));
			if (["all", "things", "review"].includes(this.activeNav) && !queryCovered
				&& (this.activeNav === "things" || presentation.type === "empty") && headers.length === 0) {
				headers.push({ type: "summary", text: t("catalog.incompleteResults") });
			}
			if (headers.length === 0) return presentation;
			return presentation.type === "items"
				? { ...presentation, headers: [...headers, ...presentation.headers] }
				: { type: "items", memos: [], mode: "memo", headers };
		}
		return presentation;
	}

	private getCatalogPresentationTotalCount(): number | null {
		if (typeof this.catalogDesktopTotalCount === "number") {
			if (this.hasCommittedCatalogDesktopQuery && (this.activeNav === "all" || this.activeNav === "review")) {
				// 首次展示就保留摘要，避免查询先于进度通知返回时将其撤下。
				this.catalogDesktopCountPresentation = {
					queryKey: getCatalogQueryKey(this.viewStateController.search.result?.filter ?? this.buildCatalogActiveQuery(true)),
					count: this.catalogDesktopTotalCount,
				};
			}
			return this.catalogDesktopTotalCount;
		}
		if (this.activeNav !== "all" && this.activeNav !== "review") return null;
		const cached = this.catalogDesktopCountPresentation;
		return cached && this.catalogCoverage?.configurationComplete !== false
			&& cached.queryKey === getCatalogQueryKey(this.viewStateController.search.result?.filter ?? this.buildCatalogActiveQuery(true))
			&& (cached.queryKey === this.getCatalogQueryFingerprint(true) || cached.queryKey === this.getCatalogQueryFingerprint(false))
			? cached.count : null;
	}

	private getRecentTimeFlowContext() {
		return createRecentTimeFlowContext(new Date(),
			this.settingsService.getSettings().recentTimeFlowEnabled && this.isDefaultListState(),
			new Set(this.getTodayTimeBuoyItems().map((item) => getMemoRenderKey(item.memo))));
	}

	private prepareRecentTimeFlow(): void {
		this.recentTimeFlowContext = this.getRecentTimeFlowContext();
		this.recentLifecycleKey = JSON.stringify([this.recentTimeFlowContext.enabled, this.recentTimeFlowContext.dates]);
		this.recentDecorations = new RecentTimeFlowDecorations(this.recentTimeFlowContext);
	}

	private renderRecentDecoration(container: HTMLElement, decoration: RecentDecoration): HTMLElement {
		if (decoration.kind === "history") {
			return container.createDiv({ cls: "knomo-recent-flow-decoration knomo-recent-flow-history", text: t("recentTimeFlow.history") });
		}
		const labels = [t("recentTimeFlow.today"), t("recentTimeFlow.yesterday"), t("recentTimeFlow.twoDaysAgo")];
		const header = container.createDiv({ cls: "knomo-recent-flow-decoration knomo-recent-flow-date" });
		header.createSpan({ cls: "knomo-recent-flow-relative", text: labels[decoration.day] });
		header.createSpan({ cls: "knomo-recent-flow-calendar", text: ` ${formatRecentCalendarDate(decoration.date, getKnomoLocale())}` });
		return header;
	}

	private getTodayTimeBuoyItems() {
		if (!this.shouldShowTodayTimeBuoys()) {
			return [];
		}
		const snapshot = this.catalogTodayTimeBuoys;
		const items = snapshot?.todayValid
			&& snapshot.todayDate === formatTimeBuoyDate(new Date())
			&& snapshot.todayRevision === this.catalogRevision ? snapshot.today : [];
		const confirmed = buildTimeBuoyTabItems([...(this.confirmedTodayTimeBuoys ?? []).map(item => item.memo)], "today", formatTimeBuoyDate(new Date()));
		const combined = [...new Map([...items, ...confirmed].map(item => [item.memo.id, item])).values()];
		return this.confirmedDailyMemos?.pending ? this.projectTodayTimeBuoys({ ...snapshot,
			today: combined, todayDate: formatTimeBuoyDate(new Date()), todayRevision: this.catalogRevision,
			todayValid: snapshot?.todayValid ?? false, todayError: snapshot?.todayError ?? null }).today : combined;
	}

	private projectTodayTimeBuoys(snapshot: TodayTimeBuoySnapshot, inserted: readonly MemoRecord[] = []): TodayTimeBuoySnapshot {
		const today = snapshot.todayDate ?? formatTimeBuoyDate(new Date());
		const memos = [...snapshot.today.map(item => item.memo), ...inserted];
		return { ...snapshot, today: buildTimeBuoyTabItems(this.confirmedDailyMemos?.merge(memos) ?? memos, "today", today) };
	}

	private projectConfirmedTimeBuoySnapshot(snapshot: TimeBuoyViewSnapshot): TimeBuoyViewSnapshot {
		if (!this.confirmedDailyMemos?.pending) return snapshot;
		const today = formatTimeBuoyDate(new Date());
		const project = (tab: TimeBuoyTab) => buildTimeBuoyTabItems(
			this.confirmedDailyMemos!.merge(snapshot[tab].map(item => item.memo)), tab, today);
		const projected = { ...snapshot, today: project("today"), upcoming: project("upcoming"), past: project("past") };
		return projected[projected.activeTab].length > 0
			? { ...projected, loading: false, error: null, refreshError: projected.error ?? projected.refreshError } : projected;
	}

	private shouldShowTodayTimeBuoys(): boolean {
		return this.settingsService.getSettings().timeBuoyEnabled && this.isDefaultListState();
	}

	private renderEmptyCardFlow(presentation: Extract<CardFlowPresentation, { type: "empty" }>): void {
		if (this.cardFlowEl === null) {
			return;
		}
		let visible = false;
		if (presentation.loading) {
			visible = this.revealLoadingAfterDelay("cards", `${this.memoSourceGeneration}:${this.getCardFlowViewStateKey()}`, () => this.renderCardFlow());
			const key = JSON.stringify([presentation, visible]);
			if (this.pendingCardFlowKey === key && this.cardFlowEl.querySelector(".knomo-loading-placeholder")) return;
			this.pendingCardFlowKey = key;
		} else {
			this.clearLoadingIndicators("cards");
			this.pendingCardFlowKey = null;
		}
		this.cardFlowCoordinator.setPendingScrollRestore(null);
		this.cardFlowCoordinator.resetFlowRuntime(this.containerEl.win);
		for (const card of this.getDirectCardElements(this.cardFlowEl)) {
			this.removeCardElement(card);
		}
		this.cardFlowEl.empty();
		this.renderedCardMemos.clear();
		this.renderCardFlowHeaders(this.cardFlowEl, presentation.headers ?? []);
		if (presentation.loading) renderKnomoLoadingPlaceholder(this.cardFlowEl, visible);
		else renderKnomoEmptyState(this.cardFlowEl, presentation.title, presentation.description);
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
		this.prepareRecentTimeFlow();
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
		const seedPlaceholder = createMemoRenderPlaceholders([...existingCards.entries()].flatMap(([key, card]) => {
			const memo = this.renderedCardMemos.get(key);
			return memo ? [{ memo, card }] : [];
		}));
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
				&& (presentation.mode !== "memo" || existingCard.getAttr("data-time-presentation") === JSON.stringify(getRecentMemoPresentation(memo, this.recentTimeFlowContext).time))
				&& (
					preserveCardMemoId === memo.id
					|| this.canReuseRenderedMemo(previousMemo, memo)
				)
			) {
				card = existingCard;
				const content = card.querySelector<HTMLElement>(".knomo-card-content") ?? card.querySelector<HTMLElement>(".knomo-card-body");
				if (content && presentation.mode === "memo") this.memoMarkdownRenderer.refreshSearchHits(memo, content, "card-flow");
			} else if (existingCard !== null) {
				card = this.replaceMemoCard(existingCard, previousMemo, memo, index, presentation.mode);
				if (presentation.mode === "memo") seedPlaceholder(memo, card);
			} else {
				card = this.renderCardForMode(cardFlow, memo, this.renderGeneration, index, presentation.mode);
				if (presentation.mode === "memo") seedPlaceholder(memo, card);
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
		for (const [index, card] of renderedCards.entries()) {
			const decoration = this.recentDecorations.next(visibleMemos[index]);
			if (decoration !== null) cardFlow.insertBefore(this.renderRecentDecoration(cardFlow, decoration), card);
		}
		const headers = this.renderCardFlowHeaders(cardFlow, presentation.headers);
		if (firstCard !== null) {
			const firstContent = cardFlow.firstElementChild;
			for (const header of headers) {
				cardFlow.insertBefore(header, firstContent);
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
		this.cardImageCache.capture(card, Platform.isMobile ? this.cardFlowEl : null);
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
		seedPlaceholder?: (memo: MemoRecord, card: HTMLElement) => void,
	): void {
		if (!(presentation.type === "empty" && presentation.loading)) this.clearLoadingIndicators("cards");
		if (presentation.type === "empty") {
			this.renderEmptyCardFlow(presentation);
			this.restorePendingCardFlowScrollTop(generation);
			return;
		}
		if (this.cardFlowEl === null) {
			return;
		}
		this.renderTimeBuoyIntro(this.cardFlowEl);
		this.renderCardFlowHeaders(this.cardFlowEl, presentation.headers);
		this.startCardFeed(presentation.memos, presentation.mode, generation, initialBatchSize, seedPlaceholder);
	}

	private renderCardFlowHeaders(container: HTMLElement, headers: CardFlowHeader[]): HTMLElement[] {
		this.cardFlowFeedback ??= { key: "", context: "" };
		this.cardFlowFeedback.context = headers.some(header => header.type === "summary" && header.feedback) ? this.getPageFeedbackContext() : "";
		return renderKnomoCardFlowHeaders(container, headers, this.cardFlowFeedback);
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
		if (this.trashViewClosed) return;
		new Notice(t("settings.timeBuoy.enabled"));
		try { await this.render(); }
		catch (error) { this.reportViewRefreshFailure(error, "time-buoy-enable"); }
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
		seedPlaceholder?: (memo: MemoRecord, card: HTMLElement) => void,
	): void {
		this.cardFlowCoordinator.clearMobileBatchContinuation(this.containerEl.win);
		this.prepareRecentTimeFlow();
		const batch = this.cardFlowCoordinator.startBatch(memos, mode, initialBatchSize);
		this.renderCardBatch(batch, generation, seedPlaceholder);
	}

	private getInitialCardBatchSize(): number {
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
		seedPlaceholder?: (memo: MemoRecord, card: HTMLElement) => void,
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
					this.renderMemoCard(item.memo, currentGeneration, item.renderIndex, seedPlaceholder);
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
		this.cardFlowCoordinator.scheduleMobileBatchContinuation(continuation, this.containerEl.win, Platform.isMobile && this.composerOpen);
	}

	private pauseMobileCardBatchContinuation(): void {
		if (Platform.isMobile) this.cardFlowCoordinator.pauseMobileBatchContinuation(this.containerEl.win);
	}

	private resumeMobileCardBatchContinuation(): void {
		this.cardFlowCoordinator.resumeMobileBatchContinuation(this.containerEl.win, Platform.isMobile && this.composerOpen);
	}

	private clearMobileCardBatchContinuation(): void {
		this.cardFlowCoordinator.clearMobileBatchContinuation(this.containerEl.win);
	}

	private renderMemoCard(memo: MemoRecord, generation: number, renderIndex: number, seedPlaceholder?: (memo: MemoRecord, card: HTMLElement) => void): void {
		if (this.cardFlowEl === null) {
			return;
		}
		const decoration = this.recentDecorations.next(memo);
		if (decoration !== null) this.renderRecentDecoration(this.cardFlowEl, decoration);
		const card = this.renderMemoCardInContainer(
			this.cardFlowEl,
			memo,
			generation,
			renderIndex,
			true,
			this.activeNav === "random",
			"card-flow",
		);
		seedPlaceholder?.(memo, card);
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
		const effectiveTimeBuoy = timeBuoy ?? this.getVisibleMemoTimeBuoy(memo);
		const card = renderKnomoMemoCard(container, memo, {
			generation,
			renderIndex,
			includeActions,
			randomCard,
			timeBuoy: effectiveTimeBuoy,
			timePresentation: surface === "card-flow" && this.isDefaultListState()
				? getRecentMemoPresentation(memo, this.recentTimeFlowContext).time : { mode: "full" },
			activeMenuMemoId: this.activeMenuMemoId,
			formatDisplayTime: formatMemoDisplayTime,
			getMarkdownPriority: getMarkdownRenderPriority,
			getMemoCardPreview: (memoRecord) => this.getMemoCardPreview(memoRecord),
			queueMemoMarkdown: (memoRecord, content, renderGeneration, priority, previewText) => {
				this.memoMarkdownRenderer.queueMemoMarkdown(memoRecord, content, renderGeneration, priority, previewText, surface);
			},
			renderMemoCardImages: (content, memoRecord, images, renderGeneration, reusedImagesEl) => {
				this.renderMemoCardImages(content, memoRecord, images, renderGeneration, surface, reusedImagesEl ?? null);
			},
			queueSourceReferenceMarkdown: (content, text, sourcePath, renderGeneration) => {
				this.memoMarkdownRenderer.queueSourceReferenceMarkdown(content, text, sourcePath, renderGeneration, surface);
			},
			reusedBodyEl,
			reusedImagesEl,
		});
		const content = card.find(".knomo-card-content") ?? card.find(".knomo-card-body");
		if (content && (reusedBodyEl !== null || !card.find(".knomo-card-content"))) this.memoMarkdownRenderer.refreshSearchHits(memo, content, surface);
		return card;
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
		const { trashBusyMemoActions, trashCleanupPendingMemoIds } = this.trashMemoController.getSnapshot();
		return renderKnomoTrashMemoCard(container, memo, {
			generation,
			renderIndex,
			busyAction: trashBusyMemoActions.get(memo.id) ?? null,
			cleanupPending: trashCleanupPendingMemoIds.has(memo.id),
			formatDisplayTime: formatMemoDisplayTime,
			formatOptionalTime: formatOptionalMemoTime,
			getMarkdownPriority: getMarkdownRenderPriority,
			getMemoCardPreview: (memoRecord) => this.getMemoCardPreview(memoRecord),
			queueMemoMarkdown: (memoRecord, content, renderGeneration, priority, previewText) => {
				this.memoMarkdownRenderer.queueMemoMarkdown(memoRecord, content, renderGeneration, priority, previewText, "card-flow");
			},
			renderMemoCardImages: (content, memoRecord, images, renderGeneration, reusedImagesEl) => {
				this.renderMemoCardImages(content, memoRecord, images, renderGeneration, "card-flow", reusedImagesEl ?? null);
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
		const memoIds = new Set([...this.memos, ...(this.mobileSearchController?.getDisplayedMemos() ?? [])].map(memo => memo.id));
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
		reusedImagesEl: HTMLElement | null = null,
	): void {
		const rendered = renderMemoCardImages(container, memo, images, {
			previewLabel: t("image.previewLabel"),
			unavailableLabel: t("image.unavailable"),
			retryLabel: t("image.retry"),
		}, reusedImagesEl ?? (surface === "card-flow" ? this.cardImageCache.take(memo) : null));
		if (rendered === null) {
			return;
		}
		if (rendered.loadItems.length > 0) {
			this.cardImageLoadQueue.forget(rendered.imagesEl, true);
		}
		this.renderedPreviewImages.set(rendered.imagesEl, images);
		if (rendered.loadItems.length > 0) {
			this.cardImageLoadQueue.observe({
				targetEl: rendered.imagesEl,
				images: rendered.loadItems,
				generation,
				surface,
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
		if (this.currentLayout === "mobile") { this.closeCardMenu(); this.scopeMenuOpen = false; }
		this.mobileDrawerOpen = false;
		this.syncRootState();
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
		if (this.activeNav !== "things") this.viewStateController.clearDesktopSearchState();
		if (this.activeTagKey === tagKey) {
			this.viewStateController.clearActiveTag();
		} else {
			this.activeTag = tag;
			this.activeTagKey = tagKey;
		}
		this.scopeFilter = "all";
		if (this.activeNav !== "things") this.activeNav = "all";
		this.mobileDrawerOpen = false;
		this.scopeMenuOpen = false;
		this.activeMenuMemoId = null;
		this.renderUiState({
			cardFlowChangeIntent: this.getCardFlowChangeIntent(previousViewStateKey),
		});
		this.refreshCatalogActiveQuery();
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
		sourceEl?: HTMLElement | null,
	): Promise<void> {
		const memo = memoId === null ? null : this.findMemoById(memoId, this.getMemoSurface(sourceEl));
		if (memo !== null) {
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
		this.composerImages?.cancelAll();
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
		this.cancelPendingQuickCommand();
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
		this.cancelPendingQuickCommand();
		await this.userActionController.handleRootClick(event);
	}

	private toggleCardMenu(memoId: string | null, _keyboard = false, sourceEl?: HTMLElement | null): void {
		if (this.currentLayout === "mobile") { this.toggleMobileCardMenu(memoId, sourceEl); return; }
		if (this.activeMenuMemoId === memoId) {
			this.closeCardMenu();
			return;
		}
		this.desktopSearchOpen = false;
		this.compactSearchOpen = false;
		this.scopeMenuOpen = false;
		this.activeMenuMemoId = memoId;
		this.syncRootState();
		this.syncCardMenuState();
	}

	private toggleScopeMenu(_keyboard = false): void {
		if (this.currentLayout === "mobile") { this.toggleMobileScopeMenu(); return; }
		this.scopeMenuOpen = !this.scopeMenuOpen;
		this.desktopSearchOpen = false;
		this.compactSearchOpen = false;
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
			this.mobileSearchController.resetState();
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
		this.randomReunionController.cancelPending();
		this.renderFilteredListState(true, this.getCardFlowChangeIntent(previousViewStateKey));
		this.refreshCatalogActiveQuery();
	}

	private handleMobileBack(event: Event): void {
		if (event.defaultPrevented || !Platform.isMobile || this.trashViewClosed
			|| this.app.workspace.getActiveViewOfType(KnomoView) !== this) return;
		// 宿主 Menu 和 Modal 自己管理历史返回，避免同一次返回再关闭底层。
		if (this.mobileMenuController?.kind || this.containerEl.doc.querySelector(".modal-container")) return;
		let handled = true;
		if (this.timeBuoyPickerState !== null) this.closeTimeBuoyPicker(true);
		else if (this.composerOpen && this.mobileComposerController.isKeyboardOpen()) this.inputEl?.blur();
		else handled = this.userActionController.closeMobileSurface();
		if (handled) { event.preventDefault(); event.stopImmediatePropagation(); }
	}

	private async handleRootKeydown(event: KeyboardEvent): Promise<void> {
		if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
		if (event.key === "Escape" && this.timeBuoyPickerState !== null) {
			event.preventDefault();
			event.stopPropagation();
			this.closeTimeBuoyPicker(true);
			return;
		}
		if (this.sidebarEl && this.desktopDrawerFocus.handleKeydown(event, this.sidebarEl, () => {
			this.mobileDrawerOpen = false;
			this.syncRootState();
		})) return;
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

	private async handleMemoAction(action: MemoAction, memo: MemoRecord): Promise<void> {
		this.closeCardMenu();
		const shouldCloseMobileSearch = this.currentLayout === "mobile" && this.mobileSearchPageOpen;
		let referenceIsCurrent: (() => boolean) | null = null;
		let releaseReferenceRequest: (() => void) | null = null;
		try {
			if (action === "mark-reviewed") {
				await this.randomReunionController.markReviewed(memo.id);
				if (this.trashViewClosed) return;
				new Notice(t("notice.markedReviewed"));
				this.syncCardMenuState();
				return;
			} else if (action === "edit") {
				this.startEditing(memo);
				this.syncCardMenuState();
				return;
			} else if (action === "reference") {
				if (!this.canChangeComposerContext()) return;
				const mobileReference = this.currentLayout === "mobile";
				if (mobileReference) {
					// 在菜单点击栈内打开输入，再读取引用；异步完成只补充引用内容。
					this.inputEl?.composer.invalidateContext();
					const cursor = this.inputEl?.value.length ?? 0;
					this.inputEl?.setSelectionRange(cursor, cursor);
					this.openComposer();
				}
				const editor = this.inputEl;
				const context = editor?.composer.capture();
				let cancelled = false;
				const cancel = (): void => { cancelled = true; };
				editor?.addEventListener("composer-action-cancel", cancel);
				releaseReferenceRequest = () => editor?.removeEventListener("composer-action-cancel", cancel);
				referenceIsCurrent = () => !cancelled && !this.trashViewClosed && this.inputEl === editor && !!context?.sameSession()
					&& (!mobileReference || this.composerOpen && this.app.workspace.getActiveViewOfType(KnomoView) === this);
				const target = await this.resolveCatalogMemo(memo);
				if (!referenceIsCurrent() || this.isSaving || this.editingMemo !== null) return;
				const reference = await this.memoCommandService.createReferenceText(target);
				if (!referenceIsCurrent() || this.isSaving || this.editingMemo !== null) return;
				this.startReferenceMemo(memo, reference.text, !mobileReference);
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
				if (this.trashViewClosed) return;
				new Notice(t("notice.copiedText"));
				this.syncCardMenuState();
				return;
			} else if (action === "copy-link") {
				const reference = await this.memoCommandService.createReferenceText(
					await this.resolveCatalogMemo(memo),
				);
				if (this.trashViewClosed) return;
				await this.copyText(reference.text);
				if (this.trashViewClosed) return;
				new Notice(t("notice.copiedLink"));
				this.syncCardMenuState();
				return;
			} else if (action === "delete") {
				await this.memoCommandService.delete(await this.resolveCatalogMemo(memo));
				if (this.trashViewClosed) return;
				new Notice(t("notice.deleted"));
				try {
					this.randomReunionController.removeMemo(memo.id);
					this.shuffleDayController.removeMemo(memo.id);
					await this.reloadMemos(false);
				} catch (error) { this.reportViewRefreshFailure(error, "delete-refresh"); }
				return;
			}
			this.syncUiChrome();
			this.syncCardMenuState();
		} catch (error) {
			if (this.trashViewClosed) return;
			if (referenceIsCurrent !== null && !referenceIsCurrent()) return;
			const message = error instanceof TrashDailyWriteError ? t("trash.writeUnconfirmed") : formatServiceError(error, t("error.operationFailed"));
			new Notice(message);
			this.syncUiChrome();
			this.syncCardMenuState();
		} finally { releaseReferenceRequest?.(); }
	}

	private async saveInput(): Promise<void> {
		if (this.trashViewClosed || this.inputEl === null || this.inputEl.disabled || this.isSaving) {
			return;
		}
		if (this.draftConfirmationOpen) return;
		if (this.restoredEditNeedsTarget) { new Notice(t("composer.draftTargetChanged")); return; }
		if (this.composerImages?.pending) { this.updateSendButtonState(); return; }
		if (this.composerIsComposing || this.inputEl.composer.composing) { new Notice(t("composer.finishComposition")); return; }
		const pending = this.localDraftStore?.pending;
		if (pending) {
			this.draftConfirmationOpen = true;
			try {
				const previousInput = prepareComposerSaveInput(pending.active.content, pending.editingMemo, {
					referenceText: pending.active.referenceText, markdownText: pending.active.markdownText,
				});
				const confirmed = await showKnomoConfirmModal(this.app, {
					message: t("composer.draftConfirmRetry") + "\n\n" + (previousInput.type === "empty" ? pending.active.content : previousInput.content),
					confirmLabel: t("composer.draftChecked"),
				});
				if (confirmed && !this.trashViewClosed) this.localDraftStore?.acknowledgePending();
			} finally { this.draftConfirmationOpen = false; }
			// 核对和保存分开，弹窗期间的新输入不能随旧确认自动提交。
			return;
		}
		this.closeTimeBuoyPicker(false);

		const input = this.inputEl.value;
		const preparedInput = prepareComposerSaveInput(input, this.editingMemo, {
			referenceText: this.quoteReferenceText,
			markdownText: this.quoteMarkdownText,
		});
		if (preparedInput.type === "empty") {
			this.updateStatus(t("composer.emptyContent"), true);
			this.updateSendButtonState();
			return;
		}
		this.flushLocalDraft();
		const submittedDraft = this.localDraftStore?.beginSubmission();
		const isMobileSave = this.currentLayout === "mobile";
		const submittedEditor = this.inputEl;
		const imageLinks = this.composerImages?.editor.view.state.field(composerImageLinks) ?? [];
		const validateImageSource = imageLinks.length ? (path: string) => {
			for (const link of imageLinks) {
				if (!(this.app.vault.getAbstractFileByPath(link.path) instanceof TFile)) throw new Error(t("composer.imageLinkChanged", { path: link.path }));
				validateComposerImages(this.app, [link], link.sourcePath);
			}
			validateComposerImages(this.app, imageLinks, path);
		} : undefined;
		this.inputEl.composer.setSaving(true);
		const submittedContext = this.inputEl.composer.capture();
		const submittedEditingMemo = this.editingMemo;
		const submittedQuoteReferenceText = this.quoteReferenceText;
		const submittedQuoteMarkdownText = this.quoteMarkdownText;
		let composerCleared = false;
		let dailyConfirmed = false;
		const clearSavedComposer = (): void => {
			if (this.trashViewClosed || composerCleared || this.inputEl !== submittedEditor || !submittedContext.valid()) return;
			if (this.inputEl !== null && this.inputEl.value !== input) return;
			if (this.editingMemo !== submittedEditingMemo
				|| this.quoteReferenceText !== submittedQuoteReferenceText
				|| this.quoteMarkdownText !== submittedQuoteMarkdownText) return;
			composerCleared = true;
			if (submittedEditingMemo !== null) {
				this.restoreCreateDraft();
			} else {
				this.draftContent = "";
				this.clearComposerContext();
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
					validateImageSource,
				);
			} else {
				operation = this.memoCommandService.startCreate(preparedInput.content, validateImageSource);
			}
			// 两阶段可以同时拒绝；立即监听后续阶段，避免等待 Daily 时出现未处理拒绝。
			void operation.settled.catch(() => undefined);
			await operation.dailyCommitted;
			dailyConfirmed = true;
			const commitGeneration = this.composerCommitGeneration = (this.composerCommitGeneration ?? 0) + 1;
			const canClear = this.trashViewClosed || (this.inputEl === submittedEditor && submittedContext.valid()
				&& this.inputEl.value === input && this.editingMemo === submittedEditingMemo
				&& this.quoteReferenceText === submittedQuoteReferenceText && this.quoteMarkdownText === submittedQuoteMarkdownText);
			if (!this.trashViewClosed) this.flushLocalDraft();
			if (submittedDraft) this.localDraftStore?.committed(submittedDraft, canClear);
			clearSavedComposer();
			this.flushLocalDraft();
			this.queueComposerSaveFinish(
				operation.settled,
				preparedInput.type === "update" ? preparedInput.previousMemo : null,
				commitGeneration,
			);
		} catch (error) {
			if (dailyConfirmed) {
				this.reportViewRefreshFailure(error, "composer-apply");
				return;
			}
			if (error instanceof StaleDailyWriteError || error instanceof MarkdownMutationStaleError) {
				if (submittedEditingMemo) this.restoredEditNeedsTarget = true;
				this.localDraftStore?.acknowledgePending();
			}
			const message = this.restoredEditNeedsTarget ? t("composer.draftTargetChanged") : formatServiceError(error, t("error.saveFailed"));
			if (!this.trashViewClosed && this.inputEl === submittedEditor && submittedContext.sameSession()) {
				this.updateStatus(message, true);
				if (!this.statusEl?.isConnected || (this.currentLayout === "mobile" && !this.composerOpen)) new Notice(message);
			}
		} finally {
			this.localDraftStore?.finishSubmission();
			this.isSaving = false;
			submittedEditor.composer.setSaving(false);
			if (!this.trashViewClosed) {
				if (this.inputEl !== null) this.inputEl.disabled = !this.getDailyNotesStatus().enabled;
				this.updateSendButtonState();
				this.syncRootState();
				if (this.composerRenderPending) { this.composerRenderPending = false; await this.render(); }
			}
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
				await this.trashMemoController.loadTrashMemos(true);
				if (this.trashViewClosed) return;
				if (this.trashMemoController.getSnapshot().trashError === null) {
					new Notice(t("notice.trashRefreshed"));
				}
				return;
			}
			try {
				const result = await this.onManualRefresh();
				if (this.trashViewClosed) return;
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
				if (this.trashViewClosed) return;
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

	private getLibraryIndexContextKey(): string {
		return JSON.stringify([this.libraryIndexRun, this.catalogRevision, catalogCoverageKey(this.catalogCoverage)]);
	}

	private refreshCatalogLibraryIndexes(): Promise<void> {
		if (this.trashViewClosed) return Promise.resolve();
		this.libraryIndexRequestedKey = this.getLibraryIndexContextKey();
		if (this.libraryIndexRequest != null) return this.libraryIndexRequest;
		const operation = this.refreshCatalogLibraryIndexesUntilCurrent().finally(() => {
			if (this.libraryIndexRequest !== operation) return;
			this.libraryIndexRequest = null;
			if (this.libraryIndexRequestedKey != null && !this.trashViewClosed) return this.refreshCatalogLibraryIndexes();
		});
		this.libraryIndexRequest = operation;
		return operation;
	}

	private async refreshCatalogLibraryIndexesUntilCurrent(): Promise<void> {
		while (this.libraryIndexRequestedKey != null && !this.trashViewClosed) {
			const key = this.libraryIndexRequestedKey;
			this.libraryIndexRequestedKey = null;
			this.libraryIndexError = false;
			if (this.librarySummary === null || this.libraryTagFacets === null) {
				this.renderStats();
				this.renderTags();
			}
			let committed = false;
			try {
				const result = await this.getCatalogReadService().getLibraryIndexes();
				if (!this.trashViewClosed && key === this.getLibraryIndexContextKey()) {
					if (result.complete && !result.invalidated && result.value !== null
						&& result.catalogRevision === this.catalogRevision
						&& catalogCoverageKey(result.coverage) === catalogCoverageKey(this.catalogCoverage)) {
						this.librarySummary = result.value.summary;
						this.libraryTagFacets = result.value.facets;
						this.libraryIndexRevision = result.catalogRevision;
						this.libraryIndexCoverageKey = catalogCoverageKey(result.coverage);
						committed = true;
					} else {
						this.libraryIndexRevision = -1;
						this.libraryIndexError = ["degraded", "retrying", "read-only"].includes(result.lifecycle.state);
					}
				}
			} catch {
				if (key === this.getLibraryIndexContextKey() && !this.trashViewClosed) {
					this.libraryIndexRevision = -1;
					this.libraryIndexError = true;
				}
			} finally {
				if (key === this.getLibraryIndexContextKey() && !this.trashViewClosed) {
					if (committed || this.libraryIndexError || (this.catalogCoverage !== null && isCompleteCatalogCoverage(this.catalogCoverage))) {
						this.libraryIndexesUpdating = false;
					}
					this.renderStats();
					this.renderTags();
				}
			}
			// 同上下文来访者共享刚完成的请求；只补一次最新上下文的需求。
			if (this.libraryIndexRequestedKey === key) this.libraryIndexRequestedKey = null;
		}
	}

	private setSearchQuery(query: string): void {
		if (this.viewStateController.search.updateDraft(query)) this.invalidateSearchDraft();
		this.submitSearchDraft();
	}

	private setSearchDateFilter(filter: SearchDateFilter, sourceEl: HTMLElement | null = null): void {
		this.clearSearchDebounce();
		const session = this.viewStateController.search;
		const input = sourceEl?.closest(".knomo-search-wrap, .knomo-compact-search-wrap")?.querySelector(".knomo-search-input");
		if (input?.instanceOf(HTMLInputElement)) session.updateDraft(input.value, input.selectionStart ?? input.value.length, input.selectionEnd ?? input.value.length);
		if (!session.canRewrite) { this.syncSearchControls(); return; }
		const previousViewStateKey = this.getCardFlowViewStateKey();
		this.applyViewStateTransitionEffects(this.viewStateController.setSearchDateFilter(filter));
		this.invalidateSearchDraft();
		this.syncSearchInputs();
		this.syncRootState();
		this.renderFilteredListState(false, this.getCardFlowChangeIntent(previousViewStateKey));
		this.refreshCatalogActiveQuery();
	}

	private queueSearchQuery(query: string): void {
		if (this.viewStateController.search.updateDraft(query)) this.invalidateSearchDraft();
		if (!this.viewStateController.search.canRewrite) return;
		this.searchQueryDebounce.queue(query, () => this.submitSearchDraft());
	}

	private refreshCatalogActiveQuery(): void {
		void this.reloadCurrentCatalogQuery(this.isDefaultListState());
	}

	private clearSearchDebounce(): void {
		this.searchQueryDebounce.clear();
	}

	private applyViewStateTransitionEffects(effects: KnomoViewStateTransitionEffects): void {
		this.cancelPendingQuickCommand();
		if (this.activeNav !== "random") this.randomReunionController.cancelPending();
		if (this.activeNav !== "shuffleDay") this.shuffleDayController.cancelPending();
		if (effects.closeScopeMenu === true) {
			this.scopeMenuOpen = false;
		}
		if (effects.clearCardMenu === true) {
			this.activeMenuMemoId = null;
		}
	}

	private setSidebarNav(nav: SidebarNav): void {
		if (nav !== this.activeNav) {
			const things = this.activeNav === "things";
			if (this.mobileSearchController?.isOpen) {
				this.mobileSearchController.closePage();
				if (things) this.mobileSearchController.resetState();
			} else this.mobileSearchController?.resetState();
		} else this.mobileSearchController?.cancelPendingRequest();
		this.cancelCatalogDesktopCount();
		if (nav !== "time-buoy" && this.activeNav === "time-buoy") this.timeBuoyViewController.clear();
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
		this.cancelCatalogDesktopQuery();
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
			void this.reloadCurrentCatalogQuery(nav === "all");
		}
		if (result.refreshRandomReunion) {
			if (this.randomReunionController.getSnapshot().status === "idle") {
				void this.randomReunionController.refresh();
			} else {
				void this.refreshRandomReunionBatch();
			}
		}
		if (result.refreshShuffleDay) {
			if (this.shuffleDayController.getSnapshot().status === "idle") {
				void this.shuffleDayController.refresh();
			} else {
				void this.shuffleDayController.reloadSelectedDate();
			}
		}
		if (result.loadTrashMemos) {
			void this.trashMemoController.loadTrashMemos();
		}
		if (nav === "time-buoy") {
			void this.timeBuoyViewController.loadInitial();
		}
		if (result.prepareRecordStats) {
			if (this.catalogCoverage !== null && isCompleteCatalogCoverage(this.catalogCoverage)) {
				void this.prepareRecordStats();
			}
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
		this.cancelCatalogDesktopQuery();
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
		if (result.refreshRandomReunionIfEmpty) {
			if (this.randomReunionController.getSnapshot().status === "idle") {
				void this.randomReunionController.refresh();
			} else {
				void this.refreshRandomReunionBatch();
			}
		}
		if (result.refreshShuffleDayIfEmpty) {
			if (this.shuffleDayController.getSnapshot().status === "idle") {
				void this.shuffleDayController.refresh();
			} else {
				void this.shuffleDayController.reloadSelectedDate();
			}
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
		if (result.reloadCatalogQuery) {
			void this.reloadCurrentCatalogQuery(true);
		}
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
		this.renderCardFlow();
		this.cardFlowDeferredForAllMemos = !this.hasCommittedCatalogDesktopQuery && !this.hasVisibleConfirmedMemoPresentation();
	}

	private shouldDeferCardFlowForAllMemos(): boolean {
		return !this.hasCommittedCatalogDesktopQuery && !this.hasVisibleConfirmedMemoPresentation() && this.catalogReadState === "history_building";
	}

	private revealLoadingAfterDelay(surface: string, key: string, render: () => void): boolean {
		if (!this.containerEl.isShown() || this.containerEl.win.document.visibilityState === "hidden") {
			this.clearLoadingIndicators(surface);
			return false;
		}
		this.loadingIndicators ??= new Map();
		let indicator = this.loadingIndicators.get(surface);
		if (!indicator) {
			const win = this.containerEl.win;
			indicator = new DelayedLoadingIndicator({ scheduleTask: (callback, delay) => win.setTimeout(callback, delay), cancelTask: id => win.clearTimeout(id) });
			this.loadingIndicators.set(surface, indicator);
		}
		return indicator.pending(key, () => {
			if (!this.trashViewClosed && this.containerEl.isShown() && this.containerEl.win.document.visibilityState !== "hidden") render();
			else indicator.clear();
		});
	}

	private clearLoadingIndicators(surface?: string): void {
		if (surface !== undefined) this.loadingIndicators?.get(surface)?.clear();
		else for (const indicator of this.loadingIndicators?.values() ?? []) indicator.clear();
	}

	private async ensureCurrentMemoDataRequirement(): Promise<boolean> {
		return this.reloadCurrentCatalogQuery();
	}

	private openDesktopSearch(): void {
		this.mobileDrawerOpen = false;
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

	private restoreElementScrollTop(element: HTMLElement | null, scrollTop: number | null, isCurrent?: () => boolean): void {
		if (scrollTop === null || element === null) {
			return;
		}
		element.scrollTop = scrollTop;
		const generation = this.renderGeneration;
		this.containerEl.win.requestAnimationFrame(() => {
			if (element.isConnected && !this.trashViewClosed && (isCurrent?.() ?? true) && (element !== this.cardFlowEl || generation === this.renderGeneration)) {
				element.scrollTop = scrollTop;
			}
		});
	}

	private restorePendingCardFlowScrollTop(generation: number): void {
		this.cardFlowCoordinator.restorePendingScrollTop(generation, (scrollTop) => {
			this.restoreCardFlowScrollTop(scrollTop);
		}, this.cardFlowEl);
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
		this.closeCardMenu();
		this.mobileDrawerOpen = false;
		this.scopeMenuOpen = false;
		this.pauseMobileBackgroundWork();
		this.mobileComposerController.open();
	}

	private setTagIndexKeyboardBusy(busy: boolean): void {
		this.tagIndexKeyboardBusy = busy;
		this.syncTagIndexInteraction();
	}

	private syncTagIndexInteraction(): void {
		if (!Platform.isMobile || this.trashViewClosed) return;
		const visible = this.containerEl.doc.visibilityState === "visible" && this.containerEl.isShown();
		const composing = this.composerIsComposing && this.inputEl?.contains(this.inputEl.ownerDocument.activeElement);
		if (visible && (this.tagIndexKeyboardBusy || composing)) {
			this.clearTagIndexWarmup();
			this.tagIndexInteractionResume ??= this.vaultTagIndex.pauseForInteraction();
		} else {
			this.tagIndexInteractionResume?.();
			this.tagIndexInteractionResume = null;
			this.scheduleTagIndexWarmup();
		}
	}

	private canWarmTagIndex(): boolean {
		return Platform.isMobile && this.tagIndexWarmupReady && !this.trashViewClosed
			&& !this.tagIndexKeyboardBusy && !this.composerIsComposing
			&& this.containerEl.doc.visibilityState === "visible" && this.containerEl.isShown()
			&& this.vaultTagIndex.getSnapshot().status === "idle";
	}

	private scheduleTagIndexWarmup(): void {
		if (this.tagIndexWarmupCancel || !this.canWarmTagIndex()) return;
		const win = this.containerEl.win;
		let cancelled = false;
		let idle: number | null = null;
		let timer: number | null = null;
		const warm = () => {
			if (cancelled) return;
			cancelled = true;
			this.tagIndexWarmupCancel = null;
			if (!this.canWarmTagIndex()) return;
			void this.vaultTagIndex.ensureReady().catch((error: unknown) => {
				if (!this.trashViewClosed) console.error("[Knomo] Tag index warmup failed", error);
			});
		};
		// 首屏先获得绘制机会；输入/视口变化会撤销等待，旧回调也不能启动构建。
		let frame: number | null = win.requestAnimationFrame(() => {
			frame = null;
			if (cancelled) return;
			if (typeof win.requestIdleCallback === "function") idle = win.requestIdleCallback(warm);
			else timer = win.setTimeout(warm, 120);
		});
		this.tagIndexWarmupCancel = () => {
			cancelled = true;
			if (frame !== null) win.cancelAnimationFrame(frame);
			if (idle !== null) win.cancelIdleCallback(idle);
			if (timer !== null) win.clearTimeout(timer);
		};
	}

	private clearTagIndexWarmup(): void {
		this.tagIndexWarmupCancel?.();
		this.tagIndexWarmupCancel = null;
	}

	private disposeTagIndexWarmup(): void {
		this.tagIndexWarmupReady = false;
		this.clearTagIndexWarmup();
		this.tagIndexInteractionResume?.();
		this.tagIndexInteractionResume = null;
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
		this.composerImages?.cancelAll();
		this.closeTimeBuoyPicker(false);
		if (this.currentLayout === "mobile") {
			this.closeMobileComposerKeepingDraft();
			return;
		}
		this.tagSuggest?.close();
		this.wikiLinkSuggest?.close();
		this.composerOpen = false;
		this.mobileComposerController.resetInactiveState();
		this.syncRootState();
		this.syncComposerMode();
		this.updateSendButtonState();
		this.updateCancelEditButtonState();
	}

	private closeMobileComposerKeepingDraft(): void {
		this.composerImages?.cancelAll();
		this.closeTimeBuoyPicker(false);
		this.tagSuggest?.close();
		this.wikiLinkSuggest?.close();
		this.mobileComposerController.closeKeepingDraft();
	}

	private focusComposerInputSoon(): void {
		this.mobileComposerController.focusInputSoon();
	}

	private focusComposerInputNow(shouldResize = true, shouldQueueViewport = true, moveToEnd = false): void {
		if (this.inputEl === null) {
			return;
		}
		const editor = this.inputEl.composer.view;
		const selection = editor.state.selection;
		// 展开移动草稿后在原生聚焦结束时定位末尾；其他聚焦保留已有选区。
		editor.focus();
		if (moveToEnd) {
			editor.dispatch({ selection: { anchor: editor.state.doc.length }, scrollIntoView: true });
		} else if (!editor.state.selection.eq(selection)) {
			editor.dispatch({ selection, scrollIntoView: true });
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

	private captureLocalDraft(): LocalComposerDraft {
		const editor = this.inputEl?.composer;
		const selection = editor?.view.state.selection.main;
		return { active: {
			content: this.inputEl?.value ?? this.draftContent,
			referenceText: this.quoteReferenceText, markdownText: this.quoteMarkdownText,
			anchor: selection?.anchor ?? 0, head: selection?.head ?? 0,
			scrollTop: Math.max(0, editor?.view.scrollDOM.scrollTop ?? 0),
			imageLinks: editor?.view.state.field(composerImageLinks) ?? this.draftImageLinks,
		}, editingMemo: this.editingMemo, suspendedCreate: this.suspendedCreate };
	}

	private applyRestoredDraftSelection(): void {
		const snapshot = this.restoredDraftSelection;
		const editor = this.inputEl?.composer;
		if (!snapshot || !editor) return;
		this.restoredDraftSelection = null;
		editor.view.dispatch({ selection: { anchor: snapshot.anchor, head: snapshot.head } });
		editor.view.requestMeasure({ read: () => undefined,
			write: () => { editor.view.scrollDOM.scrollTop = snapshot.scrollTop; } });
	}

	private scheduleLocalDraft(): void {
		if (!this.localDraftStore || this.trashViewClosed || this.localDraftTimer !== null) return;
		this.localDraftTimer = this.containerEl.win.setTimeout(() => { this.localDraftTimer = null; this.flushLocalDraft(); }, 500);
	}

	flushLocalDraft(): void {
		if (!this.localDraftStore || this.trashViewClosed) return;
		if (this.localDraftTimer !== null) this.containerEl.win.clearTimeout(this.localDraftTimer);
		this.localDraftTimer = null;
		// 只读取当前 EditorState，不 blur、不 dispatch，也不强制提交 IME。
		this.localDraftStore.update(this.captureLocalDraft());
	}

	private async validateRestoredDraft(draft: LocalComposerDraft): Promise<void> {
		const run = this.draftValidationRun = (this.draftValidationRun ?? 0) + 1;
		const editor = this.inputEl;
		const context = editor?.composer.capture();
		const memo = draft.editingMemo;
		const isCurrent = () => !this.trashViewClosed && run === this.draftValidationRun && this.inputEl === editor
			&& (!context || context.valid()) && this.editingMemo === memo;
		if (memo?.catalog) {
			const handle = memo.catalog.observationHandle;
			let current = false;
			try {
				const file = this.app.vault.getAbstractFileByPath(handle.sourcePath);
				current = file instanceof TFile && await sha256Bytes(new TextEncoder().encode(await this.app.vault.read(file))) === handle.sourceRevision;
			} catch { current = false; }
			if (!isCurrent()) return;
			if (!current) this.restoredEditNeedsTarget = true;
		}
	}

	private cancelComposerFromEscape(): void {
		if (this.composerOpen) this.closeComposerKeepingDraft();
	}

	private cancelEditing(): void {
		if (this.editingMemo === null || this.isSaving) {
			return;
		}
		this.restoreCreateDraft();
		this.updateStatus("", false);
		this.syncUiChrome();
		if (this.currentLayout === "mobile") {
			this.closeMobileComposerKeepingDraft();
		}
	}

	private clearReference(): void {
		if (this.isSaving || this.editingMemo !== null) return;
		this.inputEl?.composer.invalidateContext();
		this.quoteReferenceText = null;
		this.quoteMarkdownText = null;
		this.updateStatus("", false);
		this.syncComposerMode();
		this.updateSendButtonState();
		this.focusComposerInputNow();
	}

	private restoreCreateDraft(): void {
		const draft = this.suspendedCreate;
		this.suspendedCreate = null;
		this.clearComposerContext();
		this.quoteReferenceText = draft?.referenceText ?? null;
		this.quoteMarkdownText = draft?.markdownText ?? null;
		this.draftContent = draft?.content ?? "";
		if (this.inputEl !== null) {
			this.inputEl.value = this.draftContent;
			this.inputEl.composer.view.dispatch({ effects: setComposerImageLinks.of(draft?.imageLinks ?? []) });
			if (draft) {
				this.inputEl.setSelectionRange(Math.min(draft.anchor, draft.head), Math.max(draft.anchor, draft.head), draft.anchor > draft.head ? "backward" : "forward");
				this.inputEl.composer.view.scrollDOM.scrollTop = draft.scrollTop;
			}
		}
	}

	private canChangeComposerContext(): boolean {
		if (this.isSaving) return false;
		if (this.editingMemo !== null) { new Notice(t("composer.finishEdit")); return false; }
		if (this.composerIsComposing || this.inputEl?.composer.composing) { new Notice(t("composer.finishComposition")); return false; }
		return !this.trashViewClosed;
	}

	private clearComposerContext(): void {
		this.closeTimeBuoyPicker(false);
		this.editingMemo = null;
		this.restoredEditNeedsTarget = false;
		this.quoteReferenceText = null;
		this.quoteMarkdownText = null;
	}

	private startEditing(memo: MemoRecord): void {
		if (this.restoredEditNeedsTarget && !this.isSaving && !this.trashViewClosed
			&& !this.composerIsComposing && !this.inputEl?.composer.composing) {
			// 只有用户显式选择卡片的编辑动作才能更换目标，草稿文字和历史留在原编辑器。
			this.editingMemo = memo;
			this.restoredEditNeedsTarget = false;
			this.flushLocalDraft();
			this.openComposer();
			this.updateStatus("", false);
			void this.validateRestoredDraft(this.captureLocalDraft()).catch(error => logContinuationFailure("draft", "target-check", error));
			return;
		}
		if (this.editingMemo !== null && this.editingMemo.id === memo.id) { this.openComposer(); return; }
		if (!this.canChangeComposerContext()) return;
		const selection = this.inputEl?.composer.view.state.selection.main;
		this.suspendedCreate = {
			content: this.inputEl?.value ?? this.draftContent,
			imageLinks: this.inputEl?.composer.view.state.field(composerImageLinks) ?? [],
			referenceText: this.quoteReferenceText, markdownText: this.quoteMarkdownText,
			anchor: selection?.anchor ?? 0, head: selection?.head ?? 0,
			scrollTop: this.inputEl?.composer.view.scrollDOM.scrollTop ?? 0,
		};
		this.editingMemo = memo;
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

	private startReferenceMemo(memo: MemoRecord, referenceText: string, open = true): void {
		if (!this.canChangeComposerContext()) return;
		if (open) this.inputEl?.composer.invalidateContext();
		this.editingMemo = null;
		this.quoteReferenceText = referenceText;
		this.quoteMarkdownText = formatMarkdownQuoteDraft(memo.contentSnapshot);
		if (open) {
			this.openComposer();
			const cursor = this.inputEl?.value.length ?? 0;
			this.inputEl?.setSelectionRange(cursor, cursor);
		}
		this.resizeInput();
		this.updateStatus("", false);
		this.syncComposerMode();
		this.updateSendButtonState();
		this.updateCancelEditButtonState();
	}

	private handleComposerBeforeInput(event: InputEvent): void {
		if (event.defaultPrevented || event.isComposing || this.composerIsComposing || this.inputEl?.composer.composing) {
			return;
		}
		const shouldHandleListEnter =
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
		if (event.isComposing || this.composerIsComposing || this.inputEl?.composer.composing) return false;
		return this.composerSaveShortcutController.handleKeydown(event, {
			inputEl: this.inputEl,
			activeElement: this.containerEl.doc.activeElement,
			isSaving: this.isSaving,
			saveInput: () => {
				void this.saveInput();
			},
		});
	}

	private canRunComposerAction(action: MobileComposerAction, element: HTMLElement | null): boolean {
		if (this.currentLayout !== "mobile") return true;
		if (this.isSaving || !this.inputEl || this.inputEl.disabled || this.inputEl.composer.composing || this.composerIsComposing) return false;
		if (!this.composerOpen || this.mobileComposerController.getPhase() === "closing") return false;
		if (element !== null && element.hasAttribute("disabled")) return false;
		if (action === "save-input") return this.sendButtonEl !== null && !this.sendButtonEl.disabled;
		if (action === "cancel-edit") return this.editingMemo !== null;
		return this.editingMemo === null && this.quoteReferenceText !== null;
	}

	private runComposerToolAction(action: string | null): boolean {
		if (this.isSaving || !this.inputEl || this.inputEl.disabled) return true;
		if (this.inputEl?.composer.composing || this.composerIsComposing) { new Notice(t("composer.finishComposition")); return true; }
		this.tagSuggest?.close();
		this.wikiLinkSuggest?.close();
		const commands: Record<string, ComposerCommand> = { "insert-task": "task", "insert-bold": "bold", "insert-highlight": "highlight", "insert-link": "link" };
		if (action && commands[action]) { this.applyToolbarCommand(commands[action]); return true; }
		if (action === "insert-tag") {
			this.insertText("#");
			if (this.currentLayout === "mobile") {
				this.openTagSuggestAfterHashInsert();
			} else {
				this.tagSuggest?.openForCurrentTrigger();
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
			this.applyToolbarCommand("bullet");
			return true;
		}
		if (action === "insert-numbered-list") {
			this.applyToolbarCommand("ordered");
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
			new Notice(t("composer.finishComposition"));
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
			context: input.composer.capture(),
			source,
			phase: mobile ? "preparing" : "open",
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
		if (!state.context.valid()) { this.closeTimeBuoyPicker(false); new Notice(t("timeBuoy.picker.triggerChanged")); return; }
		if (alreadyHasTimeBuoyDate(input.value, targetDate)) {
			new Notice(t("timeBuoy.duplicate"));
			return;
		}
		const insertion = state.source === "at-input"
			? replaceTimeBuoyTrigger(input.value, state.triggerStart ?? -1, state.triggerEnd ?? -1, targetDate)
			: insertTimeBuoyDateAtSelection(
				input.value,
				state.selectionEnd,
				targetDate,
			);
		if (insertion === null) {
			this.closeTimeBuoyPicker(true);
			new Notice(t("timeBuoy.picker.triggerChanged"));
			return;
		}
		this.suppressTimeBuoyAutoOpen = true;
		try {
			applyComposerEdit(input, insertion.value, insertion.cursor);
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

	private insertText(text: string, shouldFocus = true): void {
		if (this.inputEl === null) {
			return;
		}
		const start = this.inputEl.selectionStart;
		const end = this.inputEl.selectionEnd;
		const insertText = text === "#" ? getHashInsertionText(this.inputEl.value, start) : text;
		const nextValue = `${this.inputEl.value.slice(0, start)}${insertText}${this.inputEl.value.slice(end)}`;
		const nextCursor = start + insertText.length;
		applyComposerEdit(this.inputEl, nextValue, nextCursor);
		if (shouldFocus) {
			try {
				this.inputEl.focus({ preventScroll: true });
			} catch {
				this.inputEl.focus();
			}
		}

	}

	private applyToolbarCommand(command: ComposerCommand): void {
		const input = this.inputEl;
		if (!input) return;
		const selection = input.composer.view.state.selection.main;
		const result = runComposerCommand(input.value, selection.anchor, selection.head, command);
		if (result.type === "unavailable") { new Notice(t("composer.actionUnavailable")); return; }
		if (result.type === "changed") input.composer.apply(result.edit);
		input.focus({ preventScroll: true });
	}

	private handleListEnterBeforeInput(event: InputEvent): boolean {
		const patch = this.getCurrentListEnterPatch();
		if (!patch || !event.cancelable) return false;
		event.preventDefault();
		this.applyComposerPatch(patch);
		return true;
	}

	private handleListEnterKeydown(event: KeyboardEvent): boolean {
		if (event.defaultPrevented || event.key !== "Enter" || event.shiftKey || event.isComposing || this.composerIsComposing) {
			return false;
		}
		const patch = this.getCurrentListEnterPatch();
		if (patch === null) {
			return false;
		}
		event.preventDefault();
		event.stopPropagation();
		this.applyComposerPatch(patch);
		return true;
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

	private applyComposerPatch(patch: TextReplacement): void {
		if (this.inputEl === null) {
			return;
		}
		const input = this.inputEl;
		applyComposerEdit(input, patch.value, patch.cursor);
	}

	private openTagSuggestAfterHashInsert(): void {
		if (this.inputEl === null || this.tagSuggest === null) {
			return;
		}
		this.wikiLinkSuggest?.close();
		const win = this.containerEl.win;
		const input = this.inputEl;
		const context = input.composer.capture();
		win.requestAnimationFrame(() => {
			if (this.trashViewClosed || this.isSaving || !this.composerOpen || this.inputEl !== input || !context.valid()) return;
			try {
				this.inputEl?.focus({ preventScroll: true });
			} catch {
				this.inputEl?.focus();
			}
			this.tagSuggest?.openForCurrentTrigger();
		});
	}

	private syncInputState(): void {
		this.scheduleLocalDraft();
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
		const maxHeight = this.currentLayout === "mobile" ? this.getMobileMaxInputHeight() : 480;
		const height = `${maxHeight}px`;
		// 正文变化由 CodeMirror 自行测量，仅高度约束变化时额外请求布局。
		if (this.inputEl.composer.view.scrollDOM.style.maxHeight === height) return;
		this.inputEl.composer.view.scrollDOM.style.maxHeight = height;
		this.inputEl.composer.view.requestMeasure();
	}

	private getMobileMaxInputHeight(): number {
		return this.mobileComposerController.getMaxInputHeight();
	}

	private updateStatus(message: string, isError: boolean): void {
		if (this.statusEl === null) {
			return;
		}
		if (this.statusEl.textContent !== message) this.statusEl.setText(message);
		this.statusEl.toggleClass("is-error", isError);
	}

	private getPageFeedbackContext(): string {
		return JSON.stringify([this.activeNav, this.activeTagKey, this.scopeFilter, this.viewStateController?.search.result?.key]);
	}

	private syncPageFeedback(): void {
		if (!this.pageFeedbackEl || this.trashViewClosed) return;
		if (this.pageFeedbackContext !== this.getPageFeedbackContext()) this.pageRefreshError = null;
		this.pageFeedbackEl.hidden = !this.pageRefreshError;
		const text = this.pageFeedbackEl.querySelector("span");
		if (text && text.textContent !== (this.pageRefreshError ?? "")) {
			const key = JSON.stringify([this.pageFeedbackContext, this.pageRefreshError]);
			text.setAttribute("aria-live", key === this.pageAnnouncementKey ? "off" : "polite");
			text.textContent = this.pageRefreshError ?? "";
			this.pageAnnouncementKey = key;
		}
	}

	reportViewRefreshFailure(error: unknown, stage = "refresh", sourceChanged = false): void {
		if (this.trashViewClosed) return;
		if (!(error instanceof CatalogDiscoveryInvalidatedError)) logContinuationFailure("view", stage, error, this.confirmedPresentationGeneration);
		this.pageFeedbackContext = this.getPageFeedbackContext();
		this.pageFeedbackRun = (this.pageFeedbackRun ?? 0) + 1;
		const visible = this.activeNav === "trash" ? this.trashMemoController.getSnapshot().trashMemos ?? []
			: this.activeNav === "random" ? this.randomReunionController.getSnapshot().memos ?? []
			: this.activeNav === "shuffleDay" ? this.shuffleDayController.getSnapshot().memos
				: this.activeNav === "time-buoy" ? (() => { const snapshot = this.timeBuoyViewController.getSnapshot(); return snapshot[snapshot.activeTab]; })()
					: this.getFilteredMemos();
		const hasResults = visible.length > 0;
		this.pageRefreshError = sourceChanged ? t("feedback.sourceChanged") : hasResults ? t("feedback.refreshFailed") : t("feedback.loadFailed");
		this.syncPageFeedback();
	}

	private updateSendButtonState(): void {
		if (this.inputEl === null || this.sendButtonEl === null) {
			return;
		}
		const imagesPending = this.composerImages?.pending ?? false;
		this.imageStatusEl?.toggleAttribute("hidden", !imagesPending);
		this.sendButtonEl.disabled =
			this.isSaving || imagesPending || this.inputEl.disabled || this.inputEl.value.trim().length === 0;
		const label = imagesPending ? t("composer.imagesPending") : this.isSaving ? t("composer.saving") : this.editingMemo !== null ? t("composer.save") : t("composer.send");
		this.sendButtonEl.setAttr("aria-label", label);
		this.sendButtonEl.setAttr("aria-busy", String(this.isSaving || imagesPending));
		this.sendButtonEl.toggleClass("is-saving", this.isSaving);
		setIcon(this.sendButtonEl, this.isSaving ? "loader-circle" : this.editingMemo !== null ? "check" : "send");
		for (const button of Array.from(this.composerEl?.querySelectorAll<HTMLButtonElement>(".knomo-tool-button, .knomo-reference-clear, .knomo-cancel-edit-button") ?? [])) {
			button.disabled = this.isSaving || (button.classList.contains("knomo-tool-button") && this.inputEl.disabled);
		}
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
		const displayedValue = this.viewStateController.search.draft.text;
		if (this.viewStateController.search.draft.composing) return;
		if (this.desktopSearchInputEl !== null && this.desktopSearchInputEl.value !== displayedValue) {
			this.desktopSearchInputEl.value = displayedValue;
			const draft = this.viewStateController.search.draft;
			this.desktopSearchInputEl.setSelectionRange(draft.selectionStart, draft.selectionEnd);
		}
		if (this.compactInlineSearchInputEl !== null && this.compactInlineSearchInputEl.value !== displayedValue) {
			this.compactInlineSearchInputEl.value = displayedValue;
			const draft = this.viewStateController.search.draft;
			this.compactInlineSearchInputEl.setSelectionRange(draft.selectionStart, draft.selectionEnd);
		}
		if (this.compactSearchInputEl !== null && this.compactSearchInputEl.value !== displayedValue) {
			this.compactSearchInputEl.value = displayedValue;
			const draft = this.viewStateController.search.draft;
			this.compactSearchInputEl.setSelectionRange(draft.selectionStart, draft.selectionEnd);
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
		const filter = this.viewStateController.search.result?.filter ?? this.buildCatalogActiveQuery(true);
		const normalizedQuery = getCatalogQueryKey(filter);
		const cache = this.filteredMemosCache;
		if (cache?.memos === this.memos && cache.searchQuery === normalizedQuery) return cache.result;
		const filteredMemos = this.confirmedDailyMemos?.merge(this.memos, filter) ?? filterCatalogMemos(this.memos, filter);
		this.filteredMemosCache = {
			memos: this.memos,
			searchQuery: normalizedQuery,
			result: filteredMemos,
		};
		return filteredMemos;
	}

	private closeCardMenu(): void {
		this.mobileMenuController?.close("card");
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
			this.mobileMenuController?.close("card");
			this.syncCardMenuState();
			this.blurCardMenuButton(result.closedMemoId);
		}
		if (result.closedScopeMenu) {
			this.mobileMenuController?.close("scope");
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
			if (container === null) continue;
			for (const card of container.findAll(".knomo-card")) {
				const isOpen = this.activeMenuMemoId !== null && card.getAttr("data-memo-id") === this.activeMenuMemoId;
				card.toggleClass("is-menu-open", isOpen && this.currentLayout !== "mobile");
				if (isOpen && this.currentLayout !== "mobile") this.positionOpenCardMenu(card);
				card.find(".knomo-card-menu")?.setAttr("aria-expanded", String(isOpen));
			}
		}
	}

	private registerMobileMenuTriggerEvents(): void {
		this.getRenderScope().register(registerMobileFirstTapRecovery(this.containerEl.doc, target => {
			if (this.currentLayout !== "mobile" || this.trashViewClosed
				|| this.app.workspace.getActiveViewOfType(KnomoView) !== this) return null;
			const menuItem = this.mobileMenuController?.getInputTapTarget(target);
			if (menuItem) return menuItem;
			if (target.closest(".modal-container, .menu, .suggestion-container, .suggestion-bg, .knomo-mobile-composer-layer")) return null;
			// addAction 的搜索入口位于宿主标题栏，不属于 rootEl 或 mobile-navbar。
			const search = this.mobileSearchHeaderActionEl;
			let button = search?.contains(target) ? search
				: target.closest<HTMLElement>(".knomo-mobile-create-fab, .knomo-mobile-navbar-sidebar-action, .sidebar-toggle-button");
			if (!button && target.closest(".mobile-navbar")) button = target.closest<HTMLElement>(".clickable-icon, button, .mobile-navbar-action");
			if (!button && this.rootEl?.contains(target)) button = target.closest<HTMLElement>("button[data-action='open-composer'], button[data-action='toggle-sidebar'], button[data-action='toggle-compact-search']");
			return button?.closest("[inert], [hidden], [aria-hidden='true'], :disabled, [aria-disabled='true']") ? null : button;
		}));
		this.getRenderScope().register(registerMobileMenuTriggerTap(this.containerEl.doc, target => {
			if (this.currentLayout !== "mobile" || this.trashViewClosed
				|| this.app.workspace.getActiveViewOfType(KnomoView) !== this) return null;
			const title = this.mobileHeaderTitleController.getAnchor();
			if (title?.contains(target) && title.getAttribute("role") === "button") return title;
			const trigger = target.closest<HTMLElement>("button[data-action='toggle-card-menu'], button[data-action='toggle-scope-menu']");
			if (!trigger || trigger.matches(":disabled, [aria-disabled='true']")) return null;
			return this.rootEl?.contains(trigger) || this.mobileSearchResultsEl?.contains(trigger) ? trigger : null;
		}));
	}

	private toggleMobileCardMenu(memoId: string | null, sourceEl?: HTMLElement | null): void {
		if (this.activeMenuMemoId === memoId) { this.closeCardMenu(); return; }
		const surface = sourceEl ? this.getMemoSurface(sourceEl) : this.mobileSearchPageOpen ? "mobile-search" : "card-flow";
		const memo = memoId === null ? null : this.findMemoById(memoId, surface);
		if (!memo || !isMemoCardMenuReady(memo)) return;
		const container = surface === "mobile-search" ? this.mobileSearchResultsEl : this.cardFlowEl;
		const card = container?.findAll(".knomo-card").find(item => item.getAttr("data-memo-id") === memo.id);
		const trigger = card?.find(".knomo-card-menu") ?? null;
		if (!trigger?.isConnected) return;
		this.scopeMenuOpen = false;
		this.closeCardMenu();
		this.activeMenuMemoId = memo.id;
		this.mobileMenuController ??= new KnomoMobileMenu();
		this.mobileMenuController.open({
			kind: "card", trigger,
			registerGlassSurface: surface => this.registerMobileGlassSurface(surface),
			onReturnToView: isCurrent => this.recoverMobileViewFocus(isCurrent, true),
			build: (menu, select, createTitle) => {
				for (const { action } of getMemoCardActions(memo)) {
					const focus = action === "edit" || action === "reference" || action === "open-daily" ? "action" : "view";
					menu.addItem(item => item.setTitle(createTitle(getMemoActionLabel(action), action === "edit" || action === "reference")).setIcon(MEMO_ACTION_ICONS[action]).setWarning(action === "delete")
						.onClick(() => select(() => { void this.handleMemoAction(action, memo); }, focus)));
				}
				menu.addSeparator();
				menu.addItem(item => item.setTitle(createTitle(t("card.wordCount", { count: getMemoContentStats(memo).wordCount }))).setIcon(MEMO_WORD_COUNT_ICON).setIsLabel(true));
			},
			onClose: () => {
				if (this.popupState.activeMenuMemoId === memo.id) this.popupState.activeMenuMemoId = null;
				this.syncCardMenuState();
			},
		});
		this.syncRootState();
		this.syncCardMenuState();
	}

	private toggleMobileScopeMenu(): void {
		if (this.scopeMenuOpen) { this.scopeMenuOpen = false; this.syncRootState(); return; }
		const trigger = this.getTitlePopoverAnchor();
		if (!trigger?.isConnected) return;
		this.closeCardMenu();
		this.scopeMenuOpen = true;
		const mode = getCurrentTitleMode(this.getTitleState());
		this.mobileMenuController ??= new KnomoMobileMenu();
		this.mobileMenuController.open({
			kind: "scope", trigger,
			registerGlassSurface: surface => this.registerMobileGlassSurface(surface),
			onReturnToView: isCurrent => this.recoverMobileViewFocus(isCurrent, true),
			build: (menu, select, createTitle) => {
				for (const option of TITLE_MODE_OPTIONS) {
					menu.addItem(item => item.setTitle(createTitle(option.label)).setIcon(option.icon).setChecked(option.mode === mode)
						.onClick(() => select(() => this.setTitleMode(option.mode))));
				}
			},
			onClose: () => { this.popupState.scopeMenuOpen = false; this.syncRootState(); },
		});
		this.syncRootState();
	}

	private positionOpenCardMenus(): void {
		if (this.currentLayout === "mobile" || this.activeMenuMemoId === null) return;
		for (const card of this.cardFlowEl?.findAll(".knomo-card.is-menu-open") ?? []) {
			this.positionOpenCardMenu(card);
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
		card.toggleClass("is-menu-above", positionDesktopMenu(actions, head, flowEl, "end"));
	}

	private prepareDesktopDrawer(): boolean {
		if (this.currentLayout === "mobile") {
			this.closeCardMenu();
			this.scopeMenuOpen = false;
			this.closeTimeBuoyPicker(false);
			return true;
		}
		if (this.currentLayout !== "desktop-narrow") return true;
		if (this.getRootInnerWidth() <= 0) return false;
		this.closeTimeBuoyPicker(false);
		this.scopeMenuOpen = false;
		this.desktopSearchOpen = false;
		this.compactSearchOpen = false;
		this.closeCardMenu();
		this.tagSuggest?.close();
		this.wikiLinkSuggest?.close();
		return true;
	}

	private getRootInnerWidth(): number {
		if (!this.rootEl) return 0;
		const style = this.containerEl.win.getComputedStyle(this.rootEl);
		return Math.max(0, this.rootEl.getBoundingClientRect().width - parseFloat(style.borderLeftWidth || "0") - parseFloat(style.borderRightWidth || "0"));
	}

	private toggleSidebar(): void {
		if (this.isDrawerLayout()) {
			if (!this.mobileDrawerOpen && !this.prepareDesktopDrawer()) return;
			this.mobileDrawerOpen = !this.mobileDrawerOpen;
			if (this.currentLayout === "mobile" && this.mobileDrawerOpen && this.composerOpen) {
				this.closeComposerKeepingDraft();
			}
			if (this.currentLayout === "mobile") this.desktopSidebarStateController.expandWithoutPersisting();
			this.syncRootState();
			if (this.mobileDrawerOpen) {
				void this.ensureSidebarIndexes();
			} else this.clearLoadingIndicators("tags");
			return;
		}
		this.toggleSidebarCollapsed();
	}

	private async ensureSidebarIndexes(): Promise<void> {
		if (this.trashViewClosed) return;
		// 打开动作负责首次绘制，不依赖已就绪索引再次发布通知。
		this.renderTags();
		if (this.libraryTagFacets === null || this.librarySummary === null
			|| this.libraryIndexRevision !== this.catalogRevision
			|| this.libraryIndexCoverageKey !== catalogCoverageKey(this.catalogCoverage)) {
			void this.refreshCatalogLibraryIndexes();
		}
		void this.trashMemoController.ensureLoaded();
		try {
			await this.vaultTagIndex.ensureReady();
			this.renderPublishedSidebarTags();
		} catch (error) {
			if (!this.trashViewClosed) console.error("[Knomo] Sidebar tag index could not be loaded", error);
		}
	}

	private scheduleTrashCountRefresh(): void {
		if (this.trashViewClosed || Platform.isMobile && !this.mobileDrawerOpen && this.activeNav !== "trash") return;
		if (this.trashCountRefreshTimer !== null) this.containerEl.win.clearTimeout(this.trashCountRefreshTimer);
		this.trashCountRefreshTimer = this.containerEl.win.setTimeout(() => {
			this.trashCountRefreshTimer = null;
			if (!this.trashViewClosed && (!Platform.isMobile || this.mobileDrawerOpen || this.activeNav === "trash")) {
				if (this.activeNav === "trash") void this.trashMemoController.loadTrashMemos();
				else void this.trashMemoController.ensureLoaded();
			}
		}, 100);
	}

	private toggleSidebarCollapsed(): void {
		this.desktopSidebarStateController.toggleCollapsed();
		this.syncRootState();
		if (!this.desktopSidebarStateController.getSnapshot().collapsed) void this.ensureSidebarIndexes();
		else this.clearLoadingIndicators("tags");
		void this.persistSidebarPreferences();
	}

	private setSidebarCollapsed(collapsed: boolean): void {
		this.desktopSidebarStateController.setCollapsed(collapsed);
		this.syncRootState();
		if (!collapsed) void this.ensureSidebarIndexes();
		else this.clearLoadingIndicators("tags");
		void this.persistSidebarPreferences();
	}

	private startSidebarResize(event: PointerEvent): void {
		if (this.currentLayout !== "desktop-wide" || this.sidebarResizerEl === null || !this.desktopSidebarStateController.startResize(event.pointerId, event.clientX)) {
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

	private finishSidebarResize(): void {
		const pointerId = this.desktopSidebarStateController.cancelResize();
		if (pointerId === null) return;
		if (this.sidebarResizerEl?.hasPointerCapture(pointerId)) this.sidebarResizerEl.releasePointerCapture(pointerId);
		this.rootEl?.removeClass("is-resizing-sidebar");
		void this.persistSidebarPreferences();
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
		const queryFingerprint = this.getCatalogQueryFingerprint(forceReload);
		this.prepareCatalogDesktopQuery(queryFingerprint);
		if (this.memoLoadingPromise !== null && this.memoLoadingFingerprint === queryFingerprint) {
			return this.memoLoadingPromise;
		}
		return this.runMemoLoad(queryFingerprint, () => this.reloadMemos(forceReload));
	}

	private runMemoLoad(queryFingerprint: string, load: () => Promise<boolean>): Promise<boolean> {
		const loadPromise = load();
		let trackedPromise: Promise<boolean>;
		trackedPromise = loadPromise.finally(() => {
			if (this.memoLoadingPromise === trackedPromise) {
				this.memoLoadingPromise = null;
				this.memoLoadingFingerprint = null;
			}
		});
		this.memoLoadingPromise = trackedPromise;
		this.memoLoadingFingerprint = queryFingerprint;
		return trackedPromise;
	}

	private invalidateRecordStats(): void {
		this.recordStatsPreparationController.invalidate();
		this.recordStatsService.invalidate();
	}

	private syncRecordStatsSource(): boolean {
		const coverage = this.catalogCoverage !== null && isCompleteCatalogCoverage(this.catalogCoverage)
			? "complete"
			: "incomplete";
		const source = `catalog:${this.catalogRevision}:coverage:${coverage}`;
		if (this.recordStatsPreparationController.setSourceKey(source)) {
			this.recordStatsService.invalidate(
				coverage === "incomplete" || this.recordStatsService.getSnapshot().updating,
			);
			return true;
		}
		return false;
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
		const showUpdating = (this.catalogCoverage !== null && !isCompleteCatalogCoverage(this.catalogCoverage))
			|| this.recordStatsService.getSnapshot().updating;
		const preparation = this.recordStatsService.prepareFromSource(
			source,
			(isCurrent) => this.catalogReadService.buildRecordStats(yieldToUi, isCurrent),
			showUpdating,
		);
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
		const label = t(this.catalogTodayTimeBuoys?.todayCursor != null && this.shouldShowTodayTimeBuoys() ? "list.loadMoreUnknown" : "list.loadOlder");
		this.cardFlowEl.createEl("button", {
			cls: "knomo-load-more knomo-history-load-more",
			text: label,
			attr: {
				type: "button",
				"data-action": "load-more",
				"aria-label": label,
			},
		});
	}

	private canLoadOlderMemoPeriods(): boolean {
		if (this.activeNav === "trash") return this.trashMemoController.hasMore();
		return (this.catalogCursor !== null || this.catalogHistoryExpansionPending
			|| (this.catalogTodayTimeBuoys?.todayCursor != null && this.shouldShowTodayTimeBuoys()))
			&& this.activeNav !== "random"
			&& this.activeNav !== "shuffleDay"
			&& this.activeNav !== "time-buoy"
			&& this.activeNav !== "record-stats";
	}

	private async loadOlderMemoPeriods(): Promise<boolean> {
		return this.activeNav === "trash"
			? this.trashMemoController.loadNextPage()
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

	private getCardFlowStateKey(): string {
		const recordStatsState = this.recordStatsViewStateController.getSnapshot();
		return getCardFlowStateKeyValue({
			presentationContextKey: this.getRecentPresentationStateKey(),
			activeNav: this.activeNav,
			recordStatsSnapshot: this.recordStatsService.getSnapshot(),
			recordStatsView: recordStatsState.view,
			recordStatsSelectedDate: recordStatsState.selectedDate,
			today: new Date(),
			presentation: this.getCurrentCardFlowPresentation(),
		});
	}

	private renderCardFlowIfChanged(previousKey: string): void {
		if (
			this.cardFlowEl !== null
			&& (
				this.cardFlowDeferredForAllMemos
				|| this.cardFlowEl.childElementCount === 0
				|| previousKey !== this.getCardFlowStateKey()
			)
		) {
			this.renderCardFlow();
		} else if (this.cardFlowEl !== null) {
			// 列表正文不变时，分页状态仍可能变化，单独同步底部入口。
			this.renderHistoryLoadMore();
		}
	}

	private getMobileSearchStateKey(): string {
		return this.mobileSearchController.getStateKey();
	}

	private renderMobileSearchResultsIfChanged(previousKey: string): void {
		if (previousKey !== this.getMobileSearchStateKey()) {
			this.renderMobileSearchResults();
		}
	}

	private handleCardFlowScroll(): void {
		this.positionOpenCardMenus();
		if (Platform.isMobile && this.cardFlowEl) this.memoMarkdownRenderer.prioritizeVisible("card-flow", this.cardFlowEl);
		if (this.activeNav === "time-buoy") {
			const cardFlow = this.cardFlowEl;
			if (
				cardFlow !== null
				&& this.timeBuoyLoadMoreObserver === null
				&& (this.timeBuoyRenderedCount < this.timeBuoyRenderItems.length || this.timeBuoyViewController.getSnapshot().nextCursor !== null)
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
		if (target === "clear-trash-state") {
			const busy = this.trashMemoController.getSnapshot().trashClearBusy;
			for (const button of Array.from(this.cardFlowEl?.querySelectorAll<HTMLButtonElement>('button[data-action="clear-trash"]') ?? [])) {
				button.disabled = busy;
				button.setAttribute("aria-busy", String(busy));
			}
			return;
		}
		if (target === "ui-state") {
			this.renderUiState();
			return;
		}
		if (target === "trash-count-and-scope") {
			this.renderTrashCount();
			this.renderScopeState();
			return;
		}
		this.renderCardFlow();
	}

	private async openMemoCardDailyNote(memoId: string, randomReunionCard: boolean, sourceEl?: HTMLElement | null): Promise<void> {
		const memo = this.findMemoById(memoId, this.getMemoSurface(sourceEl));
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

	private getMemoSurface(sourceEl?: HTMLElement | null): CardRenderSurface {
		return sourceEl && this.mobileSearchResultsEl?.contains(sourceEl) ? "mobile-search" : "card-flow";
	}

	private findMemoById(memoId: string, surface?: CardRenderSurface): MemoRecord | null {
		if (surface === "mobile-search") return this.mobileSearchController.getDisplayedMemos().find(memo => memo.id === memoId) ?? null;
		return this.memos.find((memo) => memo.id === memoId)
			?? this.catalogTodayTimeBuoys?.today.find((item) => item.memo.id === memoId)?.memo
			?? this.randomReunionController.getSnapshot().memos?.find((memo) => memo.id === memoId)
			?? this.shuffleDayController.getSnapshot().memos.find((memo) => memo.id === memoId)
			?? this.timeBuoyViewController.getMemos().find((memo) => memo.id === memoId)
			?? this.trashMemoController.getSnapshot().trashMemos?.find((memo) => memo.id === memoId)
			?? (surface === undefined ? this.mobileSearchController?.getDisplayedMemos().find(memo => memo.id === memoId) : null)
			?? null;
	}

	private startDateChangeWatcher(): void {
		this.dateChangeWatcher.start(() => {
			this.handleLocalDateChange();
			this.startDateChangeWatcher();
		});
	}

	private getRecentPresentationStateKey(): string {
		const context = this.getRecentTimeFlowContext();
		return JSON.stringify([context.enabled, context.dates, [...context.pinnedKeys]]);
	}

	private handleLocalDateChange(): void {
		if (this.trashViewClosed) return;
		this.stopDateChangeWatcher();
		this.startDateChangeWatcher();
		const nextDate = formatTimeBuoyDate(new Date());
		if (nextDate === this.lastKnownLocalDate) {
			this.renderCardFlow();
			return;
		}
		this.lastKnownLocalDate = nextDate;
		this.filteredMemosCache = null;
		this.renderUiState();
		// 默认流的刷新会继续协调确认展示和重逢，并刷新当前打开的移动搜索。
		if (this.shouldShowTodayTimeBuoys()) {
			void this.refresh();
			return;
		}
		if (this.mobileSearchPageOpen) { void this.mobileSearchController.refreshAppliedResults(); }
		else if (this.activeNav === "review" || this.scopeFilter !== "all" || this.searchDateFilter !== null) {
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
		previousMemo: MemoRecord | null = null,
		commitGeneration?: number,
	): void {
		const previous = this.composerSaveRefreshQueue ?? Promise.resolve();
		this.composerSaveRefreshQueue = previous
			.catch(() => undefined)
			.then(() => this.finishComposerSave(
				settled,
				previousMemo,
				commitGeneration,
			));
		void this.composerSaveRefreshQueue.catch(() => undefined);
	}

	private async finishComposerSave(
		settled: Promise<MemoSaveResult>,
		previousMemo: MemoRecord | null = null,
		commitGeneration?: number,
	): Promise<void> {
		const isCurrent = () => !this.trashViewClosed && (commitGeneration === undefined || commitGeneration === this.composerCommitGeneration);
		try {
			const result = await settled;
			if (!isCurrent()) return;
			await this.refreshPendingSave(result, previousMemo, isCurrent);
		} catch (error) {
			if (isCurrent()) this.reportViewRefreshFailure(error, "save-settled");
		}
	}

	private enqueueCatalogTaskToggle(memo: MemoRecord, taskIndex: number, checked: boolean): void {
		const previous = this.taskUpdateQueues.get(memo.id) ?? Promise.resolve();
		const queued = previous.catch(() => undefined).then(async () => {
			// 排队期间仍使用用户选中的 occurrence，由写入链校验原 observation。
			await this.handleCatalogTaskToggle(memo, taskIndex, checked);
		});
		const settled = queued.catch(() => undefined).finally(() => {
			if (this.taskUpdateQueues.get(memo.id) === settled) {
				this.taskUpdateQueues.delete(memo.id);
			}
		});
		this.taskUpdateQueues.set(memo.id, settled);
		void settled;
	}

	private async handleCatalogTaskToggle(memo: MemoRecord, taskIndex: number, checked: boolean): Promise<void> {
		let result: MemoSaveResult;
		try {
			result = await this.memoCommandService.toggleTask(await this.resolveCatalogMemo(memo), taskIndex, checked);
		} catch {
			if (this.trashViewClosed) return;
			this.memoMarkdownRenderer.syncTaskCheckboxesForMemo([this.cardFlowEl, this.mobileSearchResultsEl], memo);
			new Notice(t("task.updateFailed"));
			return;
		}
		await this.refreshPendingSave(result, memo);
	}

	private async refreshPendingSave(result: MemoSaveResult, previousMemo: MemoRecord | null = null, isCurrent = () => !this.trashViewClosed): Promise<void> {
		if (!result.localRefreshPending || this.trashViewClosed) return;
		const generation = this.confirmedPresentationGeneration ?? 0;
		const context = this.getPageFeedbackContext();
		const valid = () => isCurrent() && !this.trashViewClosed && generation === (this.confirmedPresentationGeneration ?? 0)
			&& context === this.getPageFeedbackContext();
		try { await this.presentationChangeQueue; }
		catch (error) { if (valid()) logContinuationFailure("save", "presentation-queue", error, generation); }
		if (!valid()) return;
		const handle = previousMemo?.catalog?.observationHandle;
		let stage = "state-apply";
		try {
			if (handle) {
				// 成功提交由广播更新；失败回退只清除原版本，迟到结果不能清除较新的展示。
				const cached = this.getCachedMemos();
				const changes = new Map<string, MemoRecord | null>(cached
					.filter(memo => memo.dailyRef.path === handle.sourcePath
						&& memo.catalog?.observationHandle.sourceRevision === handle.sourceRevision)
					.map(memo => [memo.id, null]));
				if (changes.size > 0) this.applyCachedMemoChanges(changes);
			}
			stage = "refresh";
			await this.refresh();
		} catch (error) { if (valid()) this.reportViewRefreshFailure(error, stage); }
	}

	private findMemoForTaskCheckbox(input: HTMLInputElement): MemoRecord | null {
		const memoId = input.getAttr("data-knomo-memo-id");
		if (memoId === null) {
			return null;
		}
		return this.findMemoById(memoId, this.getMemoSurface(input));
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

	private createComposerImageController(input: ComposerInput): ComposerImageController {
		return new ComposerImageController(input.composer, {
			attachments: this.attachmentService,
			getSourcePath: () => this.getImageSourcePath(),
			// 桌面输入框常驻，只有移动端弹层依赖打开状态。
			canInsert: () => !this.trashViewClosed && !this.isSaving
				&& (this.currentLayout !== "mobile" || this.composerOpen) && this.inputEl === input,
			onPendingChanged: () => { if (!this.trashViewClosed && this.inputEl === input) this.updateSendButtonState(); },
			onError: message => { if (!this.trashViewClosed) new Notice(message); },
		});
	}

	private async insertImageFiles(files: FileList | null, context?: ComposerImageCapture): Promise<void> {
		if (!files || !context || !this.composerImages) return;
		await this.composerImages.insert(Array.from(files), context);
	}

	private getImageSourcePath(): string | null {
		if (!this.getDailyNotesStatus().enabled) return null;
		if (this.editingMemo && !(this.app.vault.getAbstractFileByPath(this.editingMemo.dailyRef.path) instanceof TFile)) return null;
		return this.editingMemo?.dailyRef.path ?? this.getTodayDailyNotePath();
	}

	private getWikiLinkSourcePath(): string {
		return this.getComposerSourcePath() ?? "";
	}

	private getComposerSourcePath(): string | null {
		if (this.editingMemo) return this.editingMemo.dailyRef.path;
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

function isCompleteCatalogCoverage(coverage: CatalogCoverage): boolean {
	return coverage.kind === "complete" && coverage.configurationComplete !== false;
}

export function mergeCatalogMemoPages(memos: readonly MemoViewItem[]): MemoViewItem[] {
	return [...new Map(memos.map((memo) => [memo.id, memo])).values()]
		.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id));
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

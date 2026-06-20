import { ItemView, Keymap, Notice, Platform, Scope, setIcon, TFile } from "obsidian";
import type { HoverPopover, WorkspaceLeaf } from "obsidian";

import { KNOMO_VIEW_DISPLAY_TEXT, KNOMO_VIEW_TYPE } from "../constants";
import { KNOMO_LOGO_ICON, KNOMO_SEARCH_ICON } from "../icons";
import { t } from "../i18n";
import type { AttachmentService } from "../services/AttachmentService";
import type { RandomReunionService } from "../services/RandomReunionService";
import {
	canAdvanceRecordStatsDate,
	canRetreatRecordStatsDate,
	RecordStatsService,
	shiftRecordStatsDate,
} from "../services/RecordStatsService";
import type { RecordStatsView } from "../services/RecordStatsService";
import type { ReferenceService } from "../services/ReferenceService";
import type { SettingsService } from "../services/SettingsService";
import type { SyncOrchestrator } from "../services/SyncOrchestrator";
import type { ScanDailyMemosResult } from "../services/MemoScanService";
import type { MemoMutation, MemoRecord } from "../types/memo";
import type { MobileCompactMode } from "../types/settings";
import { applyListFormatToText, getHashInsertionText, getListEnterPatch, getListEnterPatchForNativeInput } from "../utils/composerInput";
import type { TextReplacement } from "../utils/composerInput";
import { formatDatePart, formatMonthPeriod } from "../utils/date";
import {
	replaceMarkdownTaskMarkerByIndex,
	type WritableMarkdownTaskMarker,
} from "../utils/markdownTasks";
import { buildQuoteCreatedMemoContent, stripTrailingWikiLink, withMemoIdAlias } from "../utils/references";
import { formatServiceError, formatSettingsText } from "../utils/serviceText";
import {
	getComposerToolButtonRoute,
	getMemoCardOpenRoute,
	getRootClickRoute,
} from "./KnomoActionRouter";
import {
	getKnomoActionDispatch,
	getMemoActionDispatch,
	getTrashActionDispatch,
	shouldRenderAfterActionDispatch,
} from "./KnomoActionDispatch";
import type { MemoAction } from "./KnomoActionDispatch";
import { CardImageLoadQueue } from "./CardImageLoadQueue";
import type { CardImageLoadItem } from "./CardImageLoadQueue";
import { renderKnomoMemoCard, renderKnomoTrashMemoCard } from "./KnomoCard";
import {
	getVisibleCardFlowMemoStateKey,
	KnomoCardFlowBatcher,
	runCardFlowBatch,
} from "./KnomoCardFlow";
import type { CardFlowBatch, CardFlowRenderMode } from "./KnomoCardFlow";
import { renderComposerReferencePreview, renderKnomoComposer } from "./KnomoComposer";
import { KnomoImagePreviewModal } from "./KnomoImagePreviewModal";
import { openMemoDailyNoteDefault, openMemoDailyNoteInNewTab } from "./memoDailyNoteOpen";
import {
	renderKnomoCardFlowHeaders,
	renderKnomoEmptyState,
	renderKnomoListSummary,
	renderKnomoLoadMoreButton,
} from "./KnomoFeed";
import { getCardFlowPresentation } from "./KnomoCardFlowPresenter";
import type {
	CardFlowHeader,
	CardFlowPresentation,
	CardFlowRegularFilterCopy,
} from "./KnomoCardFlowPresenter";
import { KnomoCardFlowSentinel } from "./KnomoCardFlowSentinel";
import {
	renderKnomoCompactHeader,
	renderKnomoCompactSearchPanel,
	renderKnomoDesktopTopbar,
	renderKnomoScopePopover,
} from "./KnomoHeaderSearch";
import { renderKnomoMobileSearchPage } from "./KnomoMobileSearchPage";
import { renderKnomoRecordStatsPage } from "./KnomoRecordStatsPage";
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
	syncSidebarTagGroupExpanded,
} from "./KnomoSidebar";
import type { SidebarDragState } from "./KnomoSidebar";
import { KnomoTagSuggest } from "./KnomoTagSuggest";
import { KnomoWikiLinkSuggest } from "./KnomoWikiLinkSuggest";
import type { MarkdownRenderPriority } from "./MarkdownRenderQueue";
import { MemoMarkdownRenderer } from "./MemoMarkdownRenderer";
import { parseMemoCardPreview } from "./MemoCardPreview";
import type { MemoCardPreview, MemoPreviewImage } from "./MemoCardPreview";
import { MemoCardPreviewCache } from "./MemoCardPreviewCache";
import {
	getMemoImageRevision,
	getMemoListStateKey,
	getMemoRenderRevision,
} from "./MemoRenderRevision";
import { MemoSearchCache } from "./MemoSearchCache";
import { MemoTaskUpdateCoordinator } from "./MemoTaskUpdateCoordinator";
import { MobileComposerController } from "./MobileComposerController";
import { MobileMemoHydrator } from "./MobileMemoHydrator";
import type { MobileMemoHydrationRenderState } from "./MobileMemoHydrator";
import { MobileNavbarCompactController } from "./MobileNavbarCompactController";
import { RandomReunionController } from "./RandomReunionController";
import { TrashMemoController } from "./TrashMemoController";
import type { TrashMemoRenderTarget } from "./TrashMemoController";
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
	getRecordStatsSearchFilterKey,
	getRecordStatsSearchFilterLabel,
	getScopeLabel,
	getSearchDateLabel,
	isSummaryScopeFilter,
	matchesRecordStatsSearchFilter,
	matchesScope,
	matchesSearchDateFilter,
	needsAllMemos,
	parseMemoLocalDate,
	tagMatchesActiveTagKey,
} from "./viewFilters";
import type {
	RecordStatsSearchFilter,
	RegularFilterCondition,
	ScopeFilter,
	SearchDateFilter,
} from "./viewFilters";
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
const MARKDOWN_RENDER_CONCURRENCY = 8;
const MOBILE_MARKDOWN_RENDER_CONCURRENCY = 4;
const MOBILE_CARD_IMAGE_LOAD_CONCURRENCY = 2;
const DESKTOP_CARD_IMAGE_LOAD_CONCURRENCY = 2;
const CARD_IMAGE_LOAD_WATCHDOG_MS = 10_000;
const MAX_CARD_PREVIEW_IMAGES = 3;
const SEARCH_DEBOUNCE_MS = 220;
const MOBILE_VIEW_HEADER_SELECTORS = [
	".workspace-leaf.mod-active .view-header",
	".mod-active .view-header",
	".view-header",
];

type LayoutMode = "desktop-wide" | "desktop-medium" | "desktop-narrow" | "mobile";
type ComposerMode = "create" | "edit" | "quote";
type CardFlowChangeIntent = "content-change" | "view-scope-change";
type WindowWithIntersectionObserver = Window & {
	IntersectionObserver?: typeof IntersectionObserver;
};
type WindowWithResizeObserver = Window & {
	ResizeObserver?: typeof ResizeObserver;
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
	cardFlowChangeIntent?: CardFlowChangeIntent;
}

type CardRenderSurface = "card-flow" | "mobile-search";

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
	private mobileHeaderTitleEl: HTMLElement | null = null;
	private mobileHeaderTitleRegisteredEl: HTMLElement | null = null;
	private mobileHeaderTitleOriginalText: string | null = null;
	private mobileSearchPageEl: HTMLElement | null = null;
	private mobileSearchInputEl: HTMLInputElement | null = null;
	private mobileSearchResultsEl: HTMLElement | null = null;
	private sidebarResizerEl: HTMLElement | null = null;
	private memos: MemoRecord[] = [];
	private cardFlowError: string | null = null;
	private allMemosLoadingPromise: Promise<boolean> | null = null;
	private recordStatsRequestPromise: Promise<boolean> | null = null;
	private recordStatsRequestInvalidated = false;
	private recordStatsPrepareTimerId: number | null = null;
	private recordStatsRenderedKey: string | null = null;
	private recordStatsView: RecordStatsView = "week";
	private recordStatsSelectedDate = new Date();
	private scopeFilter: ScopeFilter = "all";
	private searchQuery = "";
	private searchDateFilter: SearchDateFilter | null = null;
	private recordStatsSearchFilter: RecordStatsSearchFilter | null = null;
	private mobileSearchQuery = "";
	private mobileSearchDateFilter: SearchDateFilter | null = null;
	private mobileRecordStatsSearchFilter: RecordStatsSearchFilter | null = null;
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
	private suppressNextOpenPopupDismissClick = false;
	private suppressNextOpenPopupDismissClickTimerId: number | null = null;
	private draftContent = "";
	private isSaving = false;
	private composerSaveShortcutDown = false;
	private sidebarDrag: SidebarDragState | null = null;
	private currentLayout: LayoutMode = "desktop-wide";
	private layoutObserver: ResizeObserver | null = null;
	private filteredMemosCache: FilteredMemosCache | null = null;
	private dateChangeTimeoutId: number | null = null;
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
	private imagePreviewScrollTop: number | null = null;
	private mobileSearchImagePreviewScrollTop: number | null = null;
	private readonly cardImageLoadQueue: CardImageLoadQueue;
	private readonly memoMarkdownRenderer: MemoMarkdownRenderer;
	private readonly mobileMemoHydrator: MobileMemoHydrator;
	private readonly randomReunionController: RandomReunionController;
	private readonly trashMemoController: TrashMemoController;
	private readonly recordStatsService = new RecordStatsService();
	private readonly mobileComposerController: MobileComposerController;
	private readonly memoTaskUpdateCoordinator: MemoTaskUpdateCoordinator;
	private mobileNavbarCompactController: MobileNavbarCompactController | null = null;
	private renderGeneration = 0;
	private mobileSearchRenderGeneration = 0;
	private imagePreviewRenderGeneration = 0;
	private mobileCardFlowRenderPending = false;
	private mobileCardFlowForceRebuildPending = false;
	private mobileCardFlowChangeIntentPending: CardFlowChangeIntent = "content-change";
	private mobileCardFlowPreserveMemoId: string | null = null;
	private mobileCardBatchFrameId: number | null = null;
	private mobileCardBatchContinuation: (() => void) | null = null;
	private pendingCardFlowScrollRestore: {
		generation: number;
		scrollTop: number;
		visibleCount: number;
	} | null = null;
	private cardFlowDeferredForAllMemos = false;
	private readonly renderedCardMemos = new Map<string, MemoRecord>();
	private readonly renderedPreviewImages = new WeakMap<HTMLElement, readonly MemoPreviewImage[]>();
	private readonly memoCardPreviewCache = new MemoCardPreviewCache((memo, displayContent) => {
		return parseMemoCardPreview(displayContent, memo.dailyRef.path, this.app);
	});

	constructor(
		leaf: WorkspaceLeaf,
		private readonly settingsService: SettingsService,
		private readonly syncOrchestrator: SyncOrchestrator,
		private readonly referenceService: ReferenceService,
		private readonly randomReunionService: RandomReunionService,
		private readonly attachmentService: AttachmentService,
		private readonly onMemoMutation: (mutation: MemoMutation, sourceView: KnomoView) => void,
		private readonly onForceRefreshViews: () => Promise<void>,
		private readonly onManualRefresh: () => Promise<ScanDailyMemosResult>,
	) {
		super(leaf);
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
			canHydrateCardFlow: () => this.activeNav !== "trash" && this.activeNav !== "random" && this.activeNav !== "record-stats",
			scheduleTask: (callback, delayMs) => this.containerEl.win.setTimeout(callback, delayMs),
			cancelTask: (taskId) => this.containerEl.win.clearTimeout(taskId),
			listMemoIndexPeriods: () => this.syncOrchestrator.listMemoIndexPeriods(),
			listMemosInPeriods: (periods) => this.syncOrchestrator.listMemosInPeriods(periods),
			getMemos: () => this.memos,
			setMemos: (memos) => {
				this.memos = memos;
				this.invalidateRecordStats();
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
			listDeletedMemos: () => this.syncOrchestrator.listDeletedMemos(),
			restoreMemo: (memoId) => this.syncOrchestrator.restoreMemo(memoId),
			purgeDeletedMemo: (memoId) => this.syncOrchestrator.purgeDeletedMemo(memoId),
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
		if (Platform.isMobile) {
			this.updateCurrentLayout();
		}
		await this.render();
		if (Platform.isMobile) {
			this.mobileComposerController.prepare();
		}
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
		this.clearRecordStatsPreparation();
		this.recordStatsRequestInvalidated = false;
		this.recordStatsService.invalidate();
		this.mobileMemoHydrator.cancel();
		this.clearMobileCardBatchContinuation();
		this.pendingCardFlowScrollRestore = null;
		this.mobileComposerController.dispose();
		this.cardImageLoadQueue.dispose();
		this.memoCardPreviewCache.clear();
		this.clearListEnterKeydownPatch();
		this.clearSkipListEnterInputFallback();
		this.clearHandledMobileToolPointer();
		this.clearMobileImagePickerFocusGuard();
		this.clearSuppressNextOpenPopupDismissClick();
		this.pendingMobileListEnterCorrection = null;
		this.removeMobileSearchPage();
		this.containerEl.doc.body.removeClass("knomo-mobile-search-active");
		this.removeMobileHeaderTitle();
		this.removeMobileHeaderActions();
		this.stopDateChangeWatcher();
		this.stopLayoutObserver();
		this.cardFlowSentinel.remove();
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

	handleAttachmentFilesChanged(paths: readonly string[]): void {
		this.cardImageLoadQueue.invalidateResourcePaths(paths);
		const affectedMemoIds = this.memoCardPreviewCache.invalidateImagePaths(paths);
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

		this.registerDomEvent(root, "pointerdown", (event) => {
			this.handleRootPointerDown(event);
		}, { capture: true });
		this.registerDomEvent(root, "click", (event) => {
			void this.handleRootClick(event);
		});
		this.registerDomEvent(root, "keydown", (event) => {
			void this.handleRootKeydown(event);
		});

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
				loadAll ? this.syncOrchestrator.listMemoIndexPeriods() : this.getRecentMemoPeriods(),
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
			this.mobileMemoHydrator.setInitialLoadSuccess(this.getRecentMemoPeriods());
			this.cardFlowError = null;
			this.filteredMemosCache = null;
			this.invalidateMemoSearchCache();
			this.retainMemoCardPreviews();
			this.resetVisibleMemos();
			if (this.activeNav === "random" && !this.randomReunionController.getSnapshot().loading) {
				this.randomReunionController.clearMemos();
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
		root.toggleClass("is-record-stats", this.activeNav === "record-stats");
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
		if (this.currentLayout === "mobile" && this.activeNav !== "record-stats") {
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
		if (headerEl === null) {
			return;
		}
		const titleEl = headerEl.querySelector(".view-header-title");
		if (!titleEl?.instanceOf(HTMLElement)) {
			return;
		}
		if (this.activeNav === "record-stats") {
			headerEl.addClass("knomo-record-stats-header");
		} else {
			headerEl.removeClass("knomo-record-stats-header");
		}
		if (this.mobileHeaderTitleEl !== titleEl) {
			this.removeMobileHeaderTitle();
			this.mobileHeaderTitleEl = titleEl;
			this.mobileHeaderTitleOriginalText = titleEl.textContent;
		}
		if (this.mobileHeaderTitleRegisteredEl !== titleEl) {
			this.mobileHeaderTitleRegisteredEl = titleEl;
			this.registerDomEvent(titleEl, "click", (event) => {
				if (this.activeNav === "record-stats") {
					return;
				}
				event.preventDefault();
				this.toggleScopeMenu();
			});
			this.registerDomEvent(titleEl, "keydown", (event) => {
				if (this.activeNav === "record-stats") {
					return;
				}
				if (event.key !== "Enter" && event.key !== " ") {
					return;
				}
				event.preventDefault();
				this.toggleScopeMenu();
			});
		}
		titleEl.empty();
		titleEl.addClass("knomo-mobile-title");
		if (this.activeNav === "record-stats") {
			titleEl.removeAttribute("role");
			titleEl.removeAttribute("aria-haspopup");
			titleEl.removeAttribute("aria-expanded");
			titleEl.removeAttribute("tabindex");
			titleEl.createSpan({ text: this.getMobileTitleLabel() });
			return;
		}
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
			const headerEl = this.mobileHeaderTitleEl.closest(".view-header");
			if (headerEl?.instanceOf(HTMLElement)) {
				headerEl.removeClass("knomo-record-stats-header");
			}
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

	private openMobileSearchPage(options: {
		focusInput?: boolean;
		changeIntent?: CardFlowChangeIntent;
	} = {}): void {
		this.mobileDrawerOpen = false;
		this.scopeMenuOpen = false;
		this.compactSearchOpen = false;
		this.desktopSearchOpen = false;
		this.activeMenuMemoId = null;
		this.mobileSearchPageOpen = true;
		this.cardImageLoadQueue.setSurfacePaused("card-flow", true);
		this.ensureMobileSearchPage();
		if (this.mobileSearchInputEl !== null && this.mobileSearchInputEl.value !== this.mobileSearchQuery) {
			this.mobileSearchInputEl.value = this.mobileSearchQuery;
		}
		this.renderMobileSearchResults(options.changeIntent ?? "content-change");
		this.syncRootState();
		if (options.focusInput !== false) {
			this.focusMobileSearchInputSoon();
		}
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
			this.mobileRecordStatsSearchFilter = null;
			this.cardImageLoadQueue.clear("mobile-search");
			this.cardImageLoadQueue.setSurfacePaused("card-flow", false);
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
		this.cardImageLoadQueue.setSurfacePaused("card-flow", false);
		this.syncRootState();
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
			const previousViewStateKey = this.getMobileSearchViewStateKey();
			this.mobileSearchQuery = query;
			const changeIntent = this.getMobileSearchChangeIntent(previousViewStateKey);
			if (changeIntent === "view-scope-change") {
				this.mobileSearchVisibleCount = MOBILE_SEARCH_BATCH_SIZE;
			}
			this.renderMobileSearchResults(changeIntent);
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
		const previousViewStateKey = this.getMobileSearchViewStateKey();
		this.flushMobileSearchQuery();
		this.mobileSearchDateFilter = this.mobileSearchDateFilter === filter ? null : filter;
		this.mobileRecordStatsSearchFilter = null;
		this.mobileSearchVisibleCount = MOBILE_SEARCH_BATCH_SIZE;
		this.renderMobileSearchResults(this.getMobileSearchChangeIntent(previousViewStateKey));
	}

	private resetMobileSearchState(): void {
		this.clearMobileSearchDebounce();
		this.mobileSearchQuery = "";
		this.mobileSearchDateFilter = null;
		this.mobileRecordStatsSearchFilter = null;
		this.mobileSearchVisibleCount = MOBILE_SEARCH_BATCH_SIZE;
		this.mobileSearchRenderGeneration += 1;
		this.memoMarkdownRenderer.clear("mobile-search");
		this.cardImageLoadQueue.clear("mobile-search");
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

	private renderMobileSearchResults(changeIntent: CardFlowChangeIntent = "content-change"): void {
		const resultsEl = this.mobileSearchResultsEl;
		if (resultsEl === null || !this.mobileSearchPageOpen) {
			return;
		}
		const scrollTop = changeIntent === "view-scope-change" ? 0 : resultsEl.scrollTop;
		const generation = this.mobileSearchRenderGeneration + 1;
		this.mobileSearchRenderGeneration = generation;
		this.memoMarkdownRenderer.clear("mobile-search");
		this.cardImageLoadQueue.clear("mobile-search");
		resultsEl.empty();
		this.syncMobileSearchDateButtons();
		const query = this.mobileSearchQuery.trim();
		const normalizedQuery = query.toLowerCase();
		if (
			normalizedQuery.length === 0
			&& this.mobileSearchDateFilter === null
			&& this.mobileRecordStatsSearchFilter === null
		) {
			resultsEl.createDiv({ cls: "knomo-mobile-search-empty", text: t("search.emptyPrompt") });
			this.restoreElementScrollTop(resultsEl, scrollTop);
			return;
		}
		const memos = this.memos.filter((memo) => {
			return this.memoMatchesSearch(
				memo,
				normalizedQuery,
				this.mobileSearchDateFilter,
				this.mobileRecordStatsSearchFilter,
			);
		});
		if (memos.length === 0) {
			resultsEl.createDiv({
				cls: "knomo-mobile-search-empty",
				text: formatMobileSearchEmptyTitle(
					query,
					this.mobileSearchDateFilter,
					this.mobileRecordStatsSearchFilter,
				),
			});
			this.restoreElementScrollTop(resultsEl, scrollTop);
			return;
		}
		const summary = formatMobileSearchSummary(
			query,
			this.mobileSearchDateFilter,
			memos.length,
			this.mobileRecordStatsSearchFilter,
		);
		if (summary !== null) {
			renderKnomoListSummary(resultsEl, summary);
		}
		const visibleMemos = memos.slice(0, this.mobileSearchVisibleCount);
		for (const [index, memo] of visibleMemos.entries()) {
			this.renderMemoCardInContainer(resultsEl, memo, generation, index, true, false, "mobile-search");
		}
		if (visibleMemos.length < memos.length) {
			renderKnomoLoadMoreButton(resultsEl, {
				remainingCount: memos.length - visibleMemos.length,
				action: "load-more-mobile-search",
				extraClass: "knomo-mobile-search-more",
			});
		}
		this.restoreElementScrollTop(resultsEl, scrollTop);
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

	private getDesktopTitleLabel(): string {
		const query = this.searchQuery.trim();
		if (query.length > 0) {
			return t("search.label");
		}
		if (this.searchDateFilter !== null) {
			return getSearchDateLabel(this.searchDateFilter);
		}
		if (this.recordStatsSearchFilter !== null) {
			return getRecordStatsSearchFilterLabel(this.recordStatsSearchFilter);
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
			&& this.searchDateFilter === null
			&& this.recordStatsSearchFilter === null;
	}

	private getCardFlowViewStateKey(): string {
		return getStateKey([
			this.activeNav,
			this.scopeFilter,
			this.activeTagKey ?? "",
			this.searchQuery.trim().toLowerCase(),
			this.searchDateFilter ?? "",
			getRecordStatsSearchFilterKey(this.recordStatsSearchFilter),
		]);
	}

	private getCardFlowChangeIntent(previousViewStateKey: string): CardFlowChangeIntent {
		return previousViewStateKey === this.getCardFlowViewStateKey()
			? "content-change"
			: "view-scope-change";
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
		if (this.recordStatsSearchFilter !== null) {
			conditions.push({
				type: "record-stats",
				text: getRecordStatsSearchFilterLabel(this.recordStatsSearchFilter),
			});
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
		this.recordStatsRenderedKey = null;

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
		if (!force && cardFlow.childElementCount > 0 && this.recordStatsRenderedKey === renderKey) {
			return;
		}
		this.renderGeneration += 1;
		this.memoMarkdownRenderer.clear();
		this.cardImageLoadQueue.clear("card-flow");
		this.clearMobileCardBatchContinuation();
		this.cardFlowSentinel.remove();
		this.cardFlowBatcher.reset();
		this.renderedCardMemos.clear();
		cardFlow.empty();
		const selected = this.recordStatsService.select(this.recordStatsView, this.recordStatsSelectedDate);
			renderKnomoRecordStatsPage(cardFlow, {
				snapshot: this.recordStatsService.getSnapshot(),
				selected,
				view: this.recordStatsView,
				createHiddenText: (container, name, text) => this.createHiddenText(container, name, text),
				canAdvance: canAdvanceRecordStatsDate(this.recordStatsView, this.recordStatsSelectedDate),
			canRetreat: canRetreatRecordStatsDate(
				this.recordStatsView,
				this.recordStatsSelectedDate,
				this.recordStatsService.getEarliestYear(),
			),
		});
		this.recordStatsRenderedKey = renderKey;
	}

	private forceRebuildCardFlow(changeIntent: CardFlowChangeIntent = "content-change"): void {
		if (this.deferMobileCardFlowRender(null, true, changeIntent)) {
			return;
		}
		if (this.cardFlowEl === null) {
			return;
		}
		this.pendingCardFlowScrollRestore = null;
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
		this.recordStatsRenderedKey = null;
		const generation = this.renderGeneration + 1;
		this.renderGeneration = generation;
		this.memoMarkdownRenderer.clear();
		this.cardImageLoadQueue.clear("card-flow");
		this.clearMobileCardBatchContinuation();
		this.cardFlowSentinel.remove();
		this.cardFlowEl.empty();
		this.renderedCardMemos.clear();
		this.cardFlowBatcher.reset();
		this.pendingCardFlowScrollRestore = { generation, scrollTop, visibleCount: initialBatchSize };
		this.renderCardFlowPresentation(this.getCurrentCardFlowPresentation(), generation, initialBatchSize);
	}

	private deferMobileCardFlowRender(
		preserveCardMemoId: string | null,
		forceRebuild: boolean,
		changeIntent: CardFlowChangeIntent,
	): boolean {
		if (!Platform.isMobile || !this.composerOpen) {
			return false;
		}
		this.mobileCardFlowRenderPending = true;
		this.mobileCardFlowForceRebuildPending ||= forceRebuild;
		if (changeIntent === "view-scope-change") {
			this.mobileCardFlowChangeIntentPending = changeIntent;
		}
		if (preserveCardMemoId !== null) {
			this.mobileCardFlowPreserveMemoId = preserveCardMemoId;
		}
		return true;
	}

	private getCurrentCardFlowPresentation(): CardFlowPresentation {
		const randomSnapshot = this.randomReunionController.getSnapshot();
		const trashSnapshot = this.trashMemoController.getSnapshot();
		const shouldLoadListMemos = this.cardFlowError === null
			&& this.activeNav !== "trash"
			&& !(this.activeNav === "random" && randomSnapshot.loading);
		const memos = shouldLoadListMemos ? this.getFilteredMemos() : [];
		return getCardFlowPresentation({
			cardFlowError: this.cardFlowError,
			activeNav: this.activeNav,
			randomReunionLoading: randomSnapshot.loading,
			memos,
			regularFilterCopy: shouldLoadListMemos ? this.getRegularFilterCopy(memos.length) : null,
			trashLoading: trashSnapshot.trashLoading,
			trashError: trashSnapshot.trashError,
			trashMemos: trashSnapshot.trashMemos,
		});
	}

	private renderEmptyCardFlow(presentation: Extract<CardFlowPresentation, { type: "empty" }>): void {
		if (this.cardFlowEl === null) {
			return;
		}
		this.cardFlowSentinel.remove();
		this.pendingCardFlowScrollRestore = null;
		this.clearMobileCardBatchContinuation();
		for (const card of this.getDirectCardElements(this.cardFlowEl)) {
			this.removeCardElement(card);
		}
		this.cardFlowEl.empty();
		this.renderedCardMemos.clear();
		this.cardFlowBatcher.reset();
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
		this.clearMobileCardBatchContinuation();
		this.cardFlowSentinel.remove();
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
		const pendingRestore = this.pendingCardFlowScrollRestore?.generation === this.renderGeneration
			? this.pendingCardFlowScrollRestore
			: null;
		const visibleCount = Math.min(
			presentation.memos.length,
			Math.max(this.getInitialCardBatchSize(), existingCards.size, pendingRestore?.visibleCount ?? 0),
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
		this.cardFlowBatcher.sync(presentation.memos, presentation.mode, visibleMemos.length);
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
			&& this.getMemoImageKey(previousMemo) === this.getMemoImageKey(memo)
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

	private getMemoImageKey(memo: MemoRecord): string {
		return getMemoImageRevision(memo);
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
		this.clearMobileCardBatchContinuation();
		const batch = this.cardFlowBatcher.start(memos, mode, initialBatchSize);
		this.renderCardBatch(batch, generation);
	}

	private getInitialCardBatchSize(): number {
		return Platform.isMobile ? MOBILE_INITIAL_CARD_BATCH_SIZE : CARD_BATCH_SIZE;
	}

	private renderNextCardBatch(generation: number, batchSize = CARD_BATCH_SIZE): void {
		if (this.cardFlowEl === null || generation !== this.renderGeneration) {
			return;
		}
		const batch = this.cardFlowBatcher.beginNextBatch(batchSize);
		this.renderCardBatch(batch, generation, true);
	}

	private renderCardBatch(batch: CardFlowBatch | null, generation: number, hydrateWhenExhausted = false): void {
		const maxItems = Platform.isMobile && batch?.type === "items"
			? MOBILE_INITIAL_SYNC_CARD_COUNT
			: undefined;
		this.runCardBatchChunk(batch, generation, hydrateWhenExhausted, 0, maxItems);
	}

	private runCardBatchChunk(
		batch: CardFlowBatch | null,
		generation: number,
		hydrateWhenExhausted: boolean,
		startIndex: number,
		maxItems: number | undefined,
	): void {
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
			startIndex,
			maxItems,
		});
		if (result.type === "pending") {
			this.scheduleMobileCardBatchContinuation(() => {
				this.runCardBatchChunk(
					batch,
					generation,
					hydrateWhenExhausted,
					result.nextIndex,
					MOBILE_CARD_FRAME_CHUNK_SIZE,
				);
			});
			return;
		}
		const cardFlow = this.cardFlowEl;
		if (result.type === "completed" && result.completion.hasMoreItems && cardFlow !== null) {
			this.cardFlowSentinel.render({
				root: cardFlow,
				remainingCount: result.completion.remainingCount,
				generation,
				Observer: (this.containerEl.win as WindowWithIntersectionObserver).IntersectionObserver,
				isCurrentGeneration: (value) => value === this.renderGeneration,
				onIntersect: (value) => this.renderNextCardBatch(value),
			});
		} else if (hydrateWhenExhausted && result.type === "completed") {
			this.mobileMemoHydrator.requestCardFlowHydration();
		}
		this.restorePendingCardFlowScrollTop(generation);
	}

	private scheduleMobileCardBatchContinuation(continuation: () => void): void {
		this.mobileCardBatchContinuation = continuation;
		if (this.composerOpen || this.mobileCardBatchFrameId !== null) {
			return;
		}
		this.mobileCardBatchFrameId = this.containerEl.win.requestAnimationFrame(() => {
			this.mobileCardBatchFrameId = null;
			const next = this.mobileCardBatchContinuation;
			this.mobileCardBatchContinuation = null;
			next?.();
		});
	}

	private pauseMobileCardBatchContinuation(): void {
		if (this.mobileCardBatchFrameId === null) {
			return;
		}
		this.containerEl.win.cancelAnimationFrame(this.mobileCardBatchFrameId);
		this.mobileCardBatchFrameId = null;
	}

	private resumeMobileCardBatchContinuation(): void {
		const continuation = this.mobileCardBatchContinuation;
		if (continuation === null) {
			return;
		}
		this.scheduleMobileCardBatchContinuation(continuation);
	}

	private clearMobileCardBatchContinuation(): void {
		this.pauseMobileCardBatchContinuation();
		this.mobileCardBatchContinuation = null;
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
			renderMemoCardImages: (content, memoRecord, images, renderGeneration) => {
				this.renderMemoCardImages(content, memoRecord, images, renderGeneration, surface);
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
			renderMemoCardImages: (content, memoRecord, images, renderGeneration) => {
				this.renderMemoCardImages(content, memoRecord, images, renderGeneration, "card-flow");
			},
		});
	}

	private getMemoCardPreview(memo: MemoRecord): MemoCardPreview {
		return this.memoCardPreviewCache.get(memo, this.getMemoDisplayContent(memo));
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
	): void {
		if (images.length === 0) {
			return;
		}
		const visibleImages = images.slice(0, MAX_CARD_PREVIEW_IMAGES);
		const imagesEl = container.createDiv({
			cls: images.length === 1
				? "knomo-card-images knomo-card-images--single"
				: "knomo-card-images knomo-card-images--grid",
		});
		this.renderedPreviewImages.set(imagesEl, images);
		const loadItems: CardImageLoadItem[] = [];
		visibleImages.forEach((image, index) => {
			const hiddenCount = index === MAX_CARD_PREVIEW_IMAGES - 1 ? images.length - MAX_CARD_PREVIEW_IMAGES : 0;
			const loadItem = this.renderMemoCardImage(imagesEl, memo, image, index, hiddenCount);
			if (loadItem !== null) {
				loadItems.push(loadItem);
			}
		});
		this.cardImageLoadQueue.observe({
			targetEl: imagesEl,
			images: loadItems,
			generation,
			surface,
		});
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

	private renderMemoCardImage(
		container: HTMLElement,
		memo: MemoRecord,
		image: MemoPreviewImage,
		index: number,
		hiddenCount: number,
	): CardImageLoadItem | null {
		const item = container.createDiv({ cls: "knomo-card-image-item" });
		const button = item.createEl("button", {
			cls: "knomo-card-image-button",
			attr: {
				type: "button",
				"aria-label": t("image.previewLabel"),
				"data-knomo-card-image": "true",
				"data-memo-id": memo.id,
				"data-image-index": String(index),
			},
		});
		if (image.url === undefined || image.unresolved === true) {
			this.renderMemoCardImagePlaceholder(button, hiddenCount);
			return null;
		}
		const imageEl = button.createEl("img", {
			attr: {
				alt: image.alt ?? "",
				decoding: "async",
			},
		});
		if (image.isRemote) {
			imageEl.setAttr("fetchpriority", "low");
		}
		const handleError = () => {
			item.addClass("is-error");
			button.empty();
			this.renderMemoCardImagePlaceholder(button, hiddenCount);
		};
		if (hiddenCount > 0) {
			this.renderMemoCardImageMore(button, hiddenCount);
		}
		const loadItem: CardImageLoadItem = {
			imageEl,
			src: image.url,
			resourcePath: image.resourcePath,
			priority: index === 0 ? "high" : "low",
			onError: handleError,
		};
		return loadItem;
	}

	private renderMemoCardImagePlaceholder(container: HTMLElement, hiddenCount: number): void {
		container.createDiv({
			cls: "knomo-card-image-placeholder",
			text: t("image.unavailable"),
		});
		if (hiddenCount > 0) {
			this.renderMemoCardImageMore(container, hiddenCount);
		}
	}

	private renderMemoCardImageMore(container: HTMLElement, hiddenCount: number): void {
		container.createSpan({
			cls: "knomo-card-image-more",
			text: `+${hiddenCount}`,
		});
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
		const imageIndex = parseImageIndex(trigger.getAttr("data-image-index"));
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
		if (this.cardFlowEl !== null) {
			this.imagePreviewScrollTop = this.cardFlowEl.scrollTop;
			this.cardFlowEl.addClass("is-image-preview-open");
		}
		if (this.mobileSearchResultsEl !== null) {
			this.mobileSearchImagePreviewScrollTop = this.mobileSearchResultsEl.scrollTop;
			this.mobileSearchResultsEl.addClass("is-image-preview-open");
		}
	}

	private unlockCardFlowScrollForImagePreview(): void {
		if (this.cardFlowEl !== null) {
			this.cardFlowEl.removeClass("is-image-preview-open");
			this.restoreCardFlowScrollTop(this.imagePreviewScrollTop);
		}
		this.imagePreviewScrollTop = null;
		if (this.mobileSearchResultsEl !== null) {
			this.mobileSearchResultsEl.removeClass("is-image-preview-open");
			if (this.mobileSearchImagePreviewScrollTop !== null) {
				this.mobileSearchResultsEl.scrollTop = this.mobileSearchImagePreviewScrollTop;
			}
		}
		this.mobileSearchImagePreviewScrollTop = null;
	}

	private handleRootPointerDown(event: PointerEvent): void {
		if (this.currentLayout !== "mobile") {
			return;
		}
		this.handleOpenPopupOutsideEvent(event, event.target, true);
	}

	private async handleRootClick(event: MouseEvent): Promise<void> {
		const target = event.target as Node | null;
		if (target === null || !target.instanceOf(Element)) {
			return;
		}

		if (this.consumeSuppressedOpenPopupDismissClick(event)) {
			return;
		}
		if (this.handleOpenPopupOutsideEvent(event, target, false)) {
			return;
		}

		const imageTrigger = target.closest("[data-knomo-card-image]");
		if (imageTrigger?.instanceOf(HTMLElement)) {
			event.preventDefault();
			event.stopPropagation();
			this.handleCardImageClick(imageTrigger);
			return;
		}

		const route = getRootClickRoute(target, this.currentLayout === "mobile");
		if (route.type === "tag-toggle") {
			event.preventDefault();
			const tag = route.tag;
			if (tag === null) {
				return;
			}
			const expanded = !this.expandedTagGroups.has(tag);
			if (expanded) {
				this.expandedTagGroups.add(tag);
			} else {
				this.expandedTagGroups.delete(tag);
			}
			const node = route.element.closest(".knomo-tag-node");
			if (node?.instanceOf(HTMLElement)) {
				syncSidebarTagGroupExpanded(node, route.element, expanded);
			}
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
			const previousViewStateKey = this.getCardFlowViewStateKey();
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
			this.mobileDrawerOpen = false;
			this.scopeMenuOpen = false;
			this.activeMenuMemoId = null;
			this.renderUiState({
				cardFlowChangeIntent: this.getCardFlowChangeIntent(previousViewStateKey),
			});
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
			const memo = this.trashMemoController.getSnapshot().trashMemos?.find((item) => item.id === route.memoId) ?? null;
			const dispatch = getTrashActionDispatch(route.action);
			if (memo !== null && dispatch.type === "trash-action") {
				await this.trashMemoController.handleTrashAction(dispatch.action, memo);
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
			await this.handleAction(route.action, route.memoId, route.element);
			if (route.mobileToolButtonEl !== null) {
				route.mobileToolButtonEl.blur();
			}
			return;
		}

		if (route.type === "memo-card-open") {
			if (route.memoId !== null) {
				await this.openMemoCardDailyNote(route.memoId, route.randomReunion);
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
		const dispatch = getKnomoActionDispatch(action);
		switch (dispatch.type) {
			case "none":
				return;
			case "toggle-card-menu":
				this.toggleCardMenu(memoId);
				return;
			case "refresh-random-reunion":
				await this.randomReunionController.refresh();
				return;
			case "load-more":
				if (this.cardFlowBatcher.hasMoreItems) {
					this.renderNextCardBatch(this.renderGeneration);
				} else {
					this.mobileMemoHydrator.requestCardFlowHydration();
				}
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
				this.mobileMemoHydrator.deferSidebarHydration();
				break;
			case "close-drawer":
				this.mobileDrawerOpen = false;
				break;
			case "toggle-scope-menu":
				this.toggleScopeMenu();
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
			case "record-stats-previous":
				if (canRetreatRecordStatsDate(
					this.recordStatsView,
					this.recordStatsSelectedDate,
					this.recordStatsService.getEarliestYear(),
				)) {
					this.recordStatsSelectedDate = shiftRecordStatsDate(this.recordStatsView, this.recordStatsSelectedDate, -1);
					this.renderCardFlow(null, "view-scope-change");
				}
				return;
			case "record-stats-next":
				if (canAdvanceRecordStatsDate(this.recordStatsView, this.recordStatsSelectedDate)) {
					this.recordStatsSelectedDate = shiftRecordStatsDate(this.recordStatsView, this.recordStatsSelectedDate, 1);
					this.renderCardFlow(null, "view-scope-change");
				}
				return;
			case "record-stats-retry":
				this.invalidateRecordStats();
				this.renderCardFlow();
				await this.prepareRecordStats();
				return;
			case "retry-all-memos":
				if (!this.shouldDeferCardFlowForAllMemos()) {
					return;
				}
				this.renderAllMemosLoadingState();
				await this.ensureAllMemosLoaded();
				return;
			case "record-stats-view-week":
				if (this.recordStatsView !== "week") {
					this.recordStatsView = "week";
					this.renderCardFlow(null, "view-scope-change");
				}
				return;
			case "record-stats-view-month":
				if (this.recordStatsView !== "month") {
					this.recordStatsView = "month";
					this.renderCardFlow(null, "view-scope-change");
				}
				return;
			case "record-stats-view-year":
				if (this.recordStatsView !== "year") {
					this.recordStatsView = "year";
					this.renderCardFlow(null, "view-scope-change");
				}
				return;
			case "record-stats-filter-trend":
				this.openRecordStatsTrendFilter(sourceEl);
				return;
			case "record-stats-filter-hour":
				this.openRecordStatsHourFilter(sourceEl);
				return;
			case "record-stats-filter-notes":
				this.openRecordStatsMetricFilter("range");
				return;
			case "record-stats-filter-with-tag":
				this.openRecordStatsMetricFilter("with-tag");
				return;
			case "record-stats-filter-no-tag":
				this.openRecordStatsMetricFilter("no-tag");
				return;
			case "record-stats-filter-with-image":
				this.openRecordStatsMetricFilter("with-image");
				return;
			case "record-stats-filter-tag":
				this.openRecordStatsTagFilter(sourceEl);
				return;
			case "record-stats-filter-references":
				this.openRecordStatsMetricFilter("references");
				return;
			case "record-stats-filter-max-daily-notes":
				this.openRecordStatsMetricFilter("max-daily-notes");
				return;
			case "record-stats-filter-max-daily-words":
				this.openRecordStatsMetricFilter("max-daily-words");
				return;
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
			if (shouldRenderCardFlow) {
				this.renderUiState();
			} else {
				this.syncUiChrome();
				this.syncCardMenuState();
			}
		}
	}

	private openRecordStatsTrendFilter(sourceEl: HTMLElement | null): void {
		const key = sourceEl?.getAttr("data-record-stats-key") ?? null;
		const unit = sourceEl?.getAttr("data-record-stats-unit") ?? null;
		const selected = this.recordStatsService.select(this.recordStatsView, this.recordStatsSelectedDate);
		if (key === null || selected?.trend.some((point) => point.key === key && point.count > 0) !== true) {
			return;
		}
		if (unit === "day" && /^\d{4}-\d{2}-\d{2}$/.test(key)) {
			this.openRecordStatsSearchFilter({ type: "day", date: key });
			return;
		}
		if (unit === "month" && /^\d{4}-\d{2}$/.test(key)) {
			this.openRecordStatsSearchFilter({ type: "month", month: key });
		}
	}

	private openRecordStatsHourFilter(sourceEl: HTMLElement | null): void {
		const hourText = sourceEl?.getAttr("data-record-stats-hour") ?? "";
		const hour = Number(hourText);
		const selected = this.recordStatsService.select(this.recordStatsView, this.recordStatsSelectedDate);
		if (
			!Number.isInteger(hour)
			|| hour < 0
			|| hour > 23
			|| selected?.activeHours[hour]?.count === 0
		) {
			return;
		}
		if (selected === null) {
			return;
		}
		this.openRecordStatsSearchFilter({
			type: "hour",
			startDate: selected.startDate,
			endDateExclusive: selected.endDateExclusive,
			hour,
		});
	}

	private openRecordStatsMetricFilter(
		type: "range" | "with-tag" | "no-tag" | "with-image" | "references" | "max-daily-notes" | "max-daily-words",
	): void {
		const selected = this.recordStatsService.select(this.recordStatsView, this.recordStatsSelectedDate);
		if (selected === null) {
			return;
		}
		if (type === "range" && selected.range.memoCount > 0) {
			this.openRecordStatsSearchFilter({
				type,
				startDate: selected.startDate,
				endDateExclusive: selected.endDateExclusive,
			});
			return;
		}
		if (type === "references" && selected.range.referenceMemoCount > 0) {
			this.openRecordStatsSearchFilter({
				type,
				startDate: selected.startDate,
				endDateExclusive: selected.endDateExclusive,
			});
			return;
		}
		if (type === "with-tag" && selected.range.taggedMemoCount > 0) {
			this.openRecordStatsSearchFilter({
				type,
				startDate: selected.startDate,
				endDateExclusive: selected.endDateExclusive,
			});
			return;
		}
		if (type === "no-tag" && selected.range.untaggedMemoCount > 0) {
			this.openRecordStatsSearchFilter({
				type,
				startDate: selected.startDate,
				endDateExclusive: selected.endDateExclusive,
			});
			return;
		}
		if (type === "with-image" && selected.range.imageMemoCount > 0) {
			this.openRecordStatsSearchFilter({
				type,
				startDate: selected.startDate,
				endDateExclusive: selected.endDateExclusive,
			});
			return;
		}
		if (type === "max-daily-notes" && selected.range.maxDailyMemoCount > 0) {
			this.openRecordStatsSearchFilter({ type, dates: [...selected.range.maxDailyMemoDates] });
			return;
		}
		if (type === "max-daily-words" && selected.range.maxDailyWordCount > 0) {
			this.openRecordStatsSearchFilter({ type, dates: [...selected.range.maxDailyWordDates] });
		}
	}

	private openRecordStatsTagFilter(sourceEl: HTMLElement | null): void {
		const tagKey = sourceEl?.getAttr("data-record-stats-tag-key") ?? null;
		const selected = this.recordStatsService.select(this.recordStatsView, this.recordStatsSelectedDate);
		const tag = tagKey === null ? undefined : selected?.commonTags.find((item) => item.key === tagKey);
		if (selected === null || tag === undefined || tag.count <= 0) {
			return;
		}
		this.openRecordStatsSearchFilter({
			type: "tag",
			startDate: selected.startDate,
			endDateExclusive: selected.endDateExclusive,
			tagKey: tag.key,
			tagLabel: tag.label,
		});
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
		this.clearDesktopSearchState();
		this.recordStatsSearchFilter = filter;
		this.clearActiveTag();
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
		if ((event.ctrlKey || event.metaKey) && event.key === "\\") {
			event.preventDefault();
			this.toggleSidebar();
			return;
		}
		const target = event.target as Node | null;
		if ((event.key === "Enter" || event.key === " ") && target?.instanceOf(Element)) {
			const memoCardOpenRoute = getMemoCardOpenRoute(target);
			if (memoCardOpenRoute !== null) {
				if (memoCardOpenRoute.memoId !== null) {
					event.preventDefault();
					await this.openMemoCardDailyNote(memoCardOpenRoute.memoId, memoCardOpenRoute.randomReunion);
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
			let mutation: MemoMutation;
			if (this.editingMemo !== null) {
				const previousMemo = this.editingMemo;
				const memo = await this.syncOrchestrator.updateMemo(previousMemo, content);
				mutation = { type: "update", previousMemo, memo };
			} else {
				const sourceMemoId = createInput?.sourceMemoId ?? null;
				const { memo } = await this.syncOrchestrator.createMemo(content, {
					source: sourceMemoId === null ? "plugin_input" : "quote_create",
					sourceMemoId,
					sourceReferenceText: createInput?.sourceReferenceText ?? null,
					dailyTrailer: createInput?.quoteTrailer ?? null,
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
	}

	private setScope(scope: ScopeFilter): void {
		this.clearSearchDebounce();
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
			this.scopeMenuOpen = false;
			this.syncRootState();
			this.renderScopeState();
			this.syncSearchInputs();
			return;
		}
		const previousViewStateKey = this.getCardFlowViewStateKey();
		this.clearDesktopSearchState();
		this.scopeFilter = scope;
		this.clearActiveTag();
		this.activeNav = "all";
		this.mobileDrawerOpen = false;
		this.desktopSearchOpen = false;
		this.scopeMenuOpen = false;
		this.renderFilteredListState(true, this.getCardFlowChangeIntent(previousViewStateKey));
	}

	private setSearchQuery(query: string): void {
		const previousViewStateKey = this.getCardFlowViewStateKey();
		this.clearSearchDebounce();
		this.searchQuery = query;
		if (query.trim().length > 0 || this.searchDateFilter !== null || this.recordStatsSearchFilter !== null) {
			this.clearActiveTag();
			this.activeNav = "all";
			this.scopeFilter = "all";
		}
		this.activeMenuMemoId = null;
		this.activeNav = "all";
		this.renderFilteredListState(false, this.getCardFlowChangeIntent(previousViewStateKey));
	}

	private setSearchDateFilter(filter: SearchDateFilter, sourceEl: HTMLElement | null = null): void {
		const previousViewStateKey = this.getCardFlowViewStateKey();
		this.flushDesktopSearchQuery(sourceEl);
		this.searchDateFilter = this.searchDateFilter === filter ? null : filter;
		this.recordStatsSearchFilter = null;
		this.clearActiveTag();
		this.activeNav = "all";
		this.scopeFilter = "all";
		this.activeMenuMemoId = null;
		this.desktopSearchOpen = false;
		this.compactSearchOpen = false;
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
		this.recordStatsSearchFilter = null;
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
		const previousViewStateKey = this.getCardFlowViewStateKey();
		this.clearDesktopSearchState();
		this.activeNav = nav;
		this.clearActiveTag();
		this.scopeFilter = "all";
		this.mobileDrawerOpen = false;
		this.scopeMenuOpen = false;
		this.activeMenuMemoId = null;
		if (nav !== "random") {
			this.randomReunionController.clearMemos();
		}
		this.renderUiState({
			cardFlowChangeIntent: this.getCardFlowChangeIntent(previousViewStateKey),
		});
		if (nav === "review") {
			void this.ensureAllMemosLoaded();
		}
		if (nav === "random") {
			void this.randomReunionController.refresh();
		}
		if (nav === "trash") {
			void this.trashMemoController.loadTrashMemos();
		}
		if (nav === "record-stats") {
			void this.prepareRecordStats();
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
		const previousViewStateKey = this.getCardFlowViewStateKey();
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
			this.cardFlowSentinel.remove();
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
		this.clearMobileCardBatchContinuation();
		this.cardFlowSentinel.remove();
		this.cardFlowBatcher.reset();
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
		const pending = this.pendingCardFlowScrollRestore;
		if (pending === null || pending.generation !== generation || generation !== this.renderGeneration) {
			return;
		}
		this.pendingCardFlowScrollRestore = null;
		this.restoreCardFlowScrollTop(pending.scrollTop);
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
		const shouldRenderCardFlow = this.mobileCardFlowRenderPending;
		const shouldForceRebuild = this.mobileCardFlowForceRebuildPending;
		const changeIntent = this.mobileCardFlowChangeIntentPending;
		const preserveCardMemoId = this.mobileCardFlowPreserveMemoId;
		this.mobileCardFlowRenderPending = false;
		this.mobileCardFlowForceRebuildPending = false;
		this.mobileCardFlowChangeIntentPending = "content-change";
		this.mobileCardFlowPreserveMemoId = null;
		if (shouldRenderCardFlow) {
			if (shouldForceRebuild) {
				this.forceRebuildCardFlow(changeIntent);
			} else {
				this.renderCardFlow(preserveCardMemoId, changeIntent);
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
		this.syncUiChrome();
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
			allowInsertedMarkerCorrection: this.currentLayout === "mobile",
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
		if (this.activeNav === "trash" || this.activeNav === "record-stats") {
			return [];
		}
		if (this.activeNav === "random") {
			return this.randomReunionController.getSnapshot().memos ?? [];
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

		let filteredMemos: MemoRecord[];
		if (this.isDesktopSearchActive()) {
			filteredMemos = this.memos.filter((memo) => {
				return this.memoMatchesSearch(memo, normalizedQuery, searchDateFilter, recordStatsFilter);
			});
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
			recordStatsFilterKey,
			todayKey,
			result: filteredMemos,
		};
		return filteredMemos;
	}

	private isDesktopSearchActive(): boolean {
		return this.searchQuery.trim().length > 0
			|| this.searchDateFilter !== null
			|| this.recordStatsSearchFilter !== null;
	}

	private memoMatchesSearch(
		memo: MemoRecord,
		normalizedQuery: string,
		dateFilter: SearchDateFilter | null,
		recordStatsFilter: RecordStatsSearchFilter | null = null,
	): boolean {
		if (normalizedQuery.length > 0 && !this.getMemoSearchText(memo).includes(normalizedQuery)) {
			return false;
		}
		if (dateFilter !== null && !this.memoMatchesSearchDate(memo, dateFilter)) {
			return false;
		}
		if (recordStatsFilter !== null && !matchesRecordStatsSearchFilter(memo, recordStatsFilter)) {
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
		const memoId = this.activeMenuMemoId;
		this.activeMenuMemoId = null;
		this.syncCardMenuState();
		this.blurCardMenuButton(memoId);
	}

	private handleOpenPopupOutsideEvent(event: Event, target: EventTarget | null, suppressFollowingClick: boolean): boolean {
		const element = this.getEventElement(target);
		if (element === null || !this.hasOpenPopup() || this.isTargetInOpenPopup(element)) {
			return false;
		}
		this.closeOpenPopups();
		if (suppressFollowingClick) {
			this.markSuppressNextOpenPopupDismissClick();
		}
		if (!this.shouldPreserveDefaultForPopupDismiss(element)) {
			event.preventDefault();
		}
		event.stopPropagation();
		return true;
	}

	private consumeSuppressedOpenPopupDismissClick(event: Event): boolean {
		if (!this.suppressNextOpenPopupDismissClick) {
			return false;
		}
		this.clearSuppressNextOpenPopupDismissClick();
		const target = this.getEventElement(event.target);
		const memoTimeButton = target?.closest("[data-memo-time-open='daily']");
		if (memoTimeButton?.instanceOf(HTMLElement)) {
			memoTimeButton.blur();
		}
		event.preventDefault();
		event.stopPropagation();
		event.stopImmediatePropagation();
		return true;
	}

	private markSuppressNextOpenPopupDismissClick(): void {
		this.clearSuppressNextOpenPopupDismissClick();
		this.suppressNextOpenPopupDismissClick = true;
		this.suppressNextOpenPopupDismissClickTimerId = this.containerEl.win.setTimeout(() => {
			this.suppressNextOpenPopupDismissClick = false;
			this.suppressNextOpenPopupDismissClickTimerId = null;
		}, 350);
	}

	private clearSuppressNextOpenPopupDismissClick(): void {
		this.suppressNextOpenPopupDismissClick = false;
		if (this.suppressNextOpenPopupDismissClickTimerId === null) {
			return;
		}
		this.containerEl.win.clearTimeout(this.suppressNextOpenPopupDismissClickTimerId);
		this.suppressNextOpenPopupDismissClickTimerId = null;
	}

	private hasOpenPopup(): boolean {
		return this.activeMenuMemoId !== null || this.scopeMenuOpen;
	}

	private isTargetInOpenPopup(target: Element): boolean {
		return this.isOpenPopupTrigger(target) || this.isTargetInOpenCardMenu(target) || this.isTargetInOpenScopeMenu(target);
	}

	private isOpenPopupTrigger(target: Element): boolean {
		return target.closest(".knomo-card-menu") !== null ||
			target.closest("[data-action='toggle-card-menu']") !== null ||
			target.closest("[data-action='toggle-scope-menu']") !== null ||
			target.closest(".knomo-mobile-title") !== null;
	}

	private closeOpenPopups(): void {
		const shouldCloseScopeMenu = this.scopeMenuOpen;
		this.closeCardMenu();
		if (shouldCloseScopeMenu) {
			this.scopeMenuOpen = false;
			this.syncRootState();
		}
	}

	private getEventElement(target: EventTarget | null): Element | null {
		const node = target as Node | null;
		return node?.instanceOf(Element) ? node : null;
	}

	private isTargetInOpenCardMenu(target: Element): boolean {
		if (this.activeMenuMemoId === null) {
			return false;
		}
		const card = target.closest(".knomo-card");
		if (!card?.instanceOf(HTMLElement) || card.getAttr("data-memo-id") !== this.activeMenuMemoId) {
			return false;
		}
		return target.closest(".knomo-card-actions") !== null || target.closest(".knomo-card-menu") !== null;
	}

	private isTargetInOpenScopeMenu(target: Element): boolean {
		if (!this.scopeMenuOpen) {
			return false;
		}
		return target.closest(".knomo-scope-popover") !== null ||
			target.closest("[data-action='toggle-scope-menu']") !== null ||
			target.closest(".knomo-mobile-title") !== null;
	}

	private shouldPreserveDefaultForPopupDismiss(target: Element): boolean {
		const editable = target.closest("input, textarea, select, [contenteditable='true']");
		if (!editable?.instanceOf(HTMLElement)) {
			return false;
		}
		if (!editable.instanceOf(HTMLInputElement)) {
			return true;
		}
		return !["button", "checkbox", "color", "file", "image", "radio", "range", "reset", "submit"].includes(editable.type.toLowerCase());
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
			this.sidebarCollapsed = false;
			this.syncRootState();
			if (this.mobileDrawerOpen) {
				this.mobileMemoHydrator.deferSidebarHydration();
			}
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
		this.clearRecordStatsPreparation();
		if (this.recordStatsRequestPromise !== null) {
			this.recordStatsRequestInvalidated = true;
		}
		this.recordStatsService.invalidate();
	}

	private scheduleRecordStatsPreparation(): void {
		if (
			!this.mobileMemoHydrator.getSnapshot().allMemosLoaded ||
			this.recordStatsService.isPreparedFor(this.memos) ||
			this.recordStatsRequestPromise !== null ||
			this.recordStatsPrepareTimerId !== null
		) {
			return;
		}
		this.recordStatsPrepareTimerId = this.containerEl.win.setTimeout(() => {
			this.recordStatsPrepareTimerId = null;
			void this.prepareRecordStats();
		}, 180);
	}

	private clearRecordStatsPreparation(): void {
		if (this.recordStatsPrepareTimerId === null) {
			return;
		}
		this.containerEl.win.clearTimeout(this.recordStatsPrepareTimerId);
		this.recordStatsPrepareTimerId = null;
	}

	private prepareRecordStats(): Promise<boolean> {
		this.clearRecordStatsPreparation();
		if (this.recordStatsService.isPreparedFor(this.memos)) {
			if (this.activeNav === "record-stats") {
				this.renderCardFlow();
			}
			return Promise.resolve(true);
		}
		if (this.recordStatsRequestPromise !== null) {
			return this.recordStatsRequestPromise;
		}
		this.recordStatsRequestInvalidated = false;
		const request = this.runRecordStatsPreparation();
		const trackedRequest = request.finally(() => {
			const shouldRetry = this.recordStatsRequestInvalidated && !this.recordStatsService.isPreparedFor(this.memos);
			this.recordStatsRequestInvalidated = false;
			if (this.recordStatsRequestPromise === trackedRequest) {
				this.recordStatsRequestPromise = null;
			}
			if (shouldRetry) {
				void this.prepareRecordStats();
			}
		});
		this.recordStatsRequestPromise = trackedRequest;
		return trackedRequest;
	}

	private async runRecordStatsPreparation(): Promise<boolean> {
		if (!this.mobileMemoHydrator.getSnapshot().allMemosLoaded) {
			if (this.activeNav === "record-stats") {
				this.renderCardFlow();
			}
			const loaded = await this.ensureAllMemosLoaded();
			if (!loaded) {
				this.recordStatsService.fail(t("recordStats.error.desc"));
				if (this.activeNav === "record-stats") {
					this.renderCardFlow();
				}
				return false;
			}
		}
		const source = this.memos;
		const preparation = this.recordStatsService.prepare(source, () => {
			return new Promise((resolve) => {
				this.containerEl.win.setTimeout(resolve, 0);
			});
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
		if (this.activeNav === "record-stats" && this.recordStatsRequestPromise === null) {
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
			this.activeNav === "record-stats"
		) {
			return;
		}
		const memos = this.getFilteredMemos();
		this.cardFlowBatcher.updateItems(memos);
		if (
			this.mobileMemoHydrator.getSnapshot().renderNextBatchAfterHydration
			&& this.cardFlowBatcher.remainingCount > 0
		) {
			this.mobileMemoHydrator.consumeRenderNextBatchRequest();
			this.renderNextCardBatch(this.renderGeneration);
			return;
		}
		this.renderCardFlowSentinelIfNeeded();
	}

	private renderCardFlowSentinelIfNeeded(): void {
		if (this.cardFlowEl === null || !this.cardFlowBatcher.hasMoreItems) {
			return;
		}
		this.cardFlowSentinel.render({
			root: this.cardFlowEl,
			remainingCount: this.cardFlowBatcher.remainingCount,
			generation: this.renderGeneration,
			Observer: (this.containerEl.win as WindowWithIntersectionObserver).IntersectionObserver,
			isCurrentGeneration: (value) => value === this.renderGeneration,
			onIntersect: (value) => this.renderNextCardBatch(value),
		});
	}

	private getRecentMemoPeriods(): string[] {
		const now = new Date();
		return [
			formatMonthPeriod(now),
			formatMonthPeriod(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
		];
	}

	private async waitForAllMemosLoading(): Promise<void> {
		if (this.allMemosLoadingPromise !== null) {
			await this.allMemosLoadingPromise;
		}
	}

	private resetVisibleMemos(): void {
		this.clearMobileCardBatchContinuation();
		this.cardFlowBatcher.reset();
	}

	private invalidateMemoSearchCache(): void {
		this.memoSearchCache.invalidate();
	}

	private getMemoSearchText(memo: MemoRecord): string {
		return this.memoSearchCache.get(memo);
	}

	private getCardFlowStateKey(): string {
		if (this.activeNav === "record-stats") {
			const snapshot = this.recordStatsService.getSnapshot();
			const renderState = snapshot.state === "idle" ? "loading" : snapshot.state;
			return getStateKey([
				"record-stats",
				renderState,
				snapshot.error ?? "",
				this.recordStatsView,
				formatDatePart(this.recordStatsSelectedDate),
				formatDatePart(new Date()),
			]);
		}
		const presentation = this.getCurrentCardFlowPresentation();
		if (presentation.type === "empty") {
			return getStateKey(["empty", presentation.title, presentation.description]);
		}
		return getStateKey([
			"items",
			presentation.mode,
			getCardFlowHeadersStateKey(presentation.headers),
			getMemoListStateKey(presentation.memos),
		]);
	}

	private getVisibleCardFlowStateKey(renderedCardCount: number): string {
		if (this.activeNav === "record-stats") {
			return this.getCardFlowStateKey();
		}
		const presentation = this.getCurrentCardFlowPresentation();
		if (presentation.type === "empty") {
			return getStateKey(["empty", presentation.title, presentation.description]);
		}
		return `${presentation.mode}:${getVisibleCardFlowMemoStateKey(
			presentation.memos,
			renderedCardCount,
			this.getInitialCardBatchSize(),
		)}`;
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
		if (!this.mobileSearchPageOpen) {
			return "closed";
		}
		const query = this.mobileSearchQuery.trim().toLowerCase();
		const memos = this.memos
			.filter((memo) => this.memoMatchesSearch(
				memo,
				query,
				this.mobileSearchDateFilter,
				this.mobileRecordStatsSearchFilter,
			))
			.slice(0, this.mobileSearchVisibleCount);
		return getStateKey([
			query,
			this.mobileSearchDateFilter ?? "",
			getRecordStatsSearchFilterKey(this.mobileRecordStatsSearchFilter),
			getMemoListStateKey(memos),
		]);
	}

	private getMobileSearchViewStateKey(): string {
		return getStateKey([
			this.mobileSearchQuery.trim().toLowerCase(),
			this.mobileSearchDateFilter ?? "",
			getRecordStatsSearchFilterKey(this.mobileRecordStatsSearchFilter),
		]);
	}

	private getMobileSearchChangeIntent(previousViewStateKey: string): CardFlowChangeIntent {
		return previousViewStateKey === this.getMobileSearchViewStateKey()
			? "content-change"
			: "view-scope-change";
	}

	private getMobileSearchIdsKey(): string {
		if (!this.mobileSearchPageOpen) {
			return "closed";
		}
		const query = this.mobileSearchQuery.trim().toLowerCase();
		return this.memos
			.filter((memo) => this.memoMatchesSearch(
				memo,
				query,
				this.mobileSearchDateFilter,
				this.mobileRecordStatsSearchFilter,
			))
			.slice(0, this.mobileSearchVisibleCount)
			.map((memo) => memo.id)
			.join("\n");
	}

	private renderMobileSearchResultsIfChanged(previousKey: string): void {
		if (previousKey !== this.getMobileSearchStateKey()) {
			this.renderMobileSearchResults();
		}
	}

	private handleCardFlowScroll(): void {
		const cardFlow = this.cardFlowEl;
		if (
			cardFlow === null ||
			this.activeNav === "record-stats" ||
			this.cardFlowSentinel.isObserving ||
			cardFlow.scrollTop + cardFlow.clientHeight < cardFlow.scrollHeight - 160
		) {
			return;
		}
		if (this.cardFlowBatcher.hasMoreItems) {
			this.renderNextCardBatch(this.renderGeneration);
			return;
		}
		this.mobileMemoHydrator.requestCardFlowHydration();
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
			?? this.memos.find((memo) => memo.id === memoId)
			?? this.trashMemoController.getSnapshot().trashMemos?.find((memo) => memo.id === memoId)
			?? null;
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
		if (this.suppressNextOpenPopupDismissClick) {
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
		const marker: WritableMarkdownTaskMarker = input.checked ? "x" : " ";
		const nextContent = replaceMarkdownTaskMarkerByIndex(latestContent, taskIndex, marker);
		if (nextContent === null) {
			this.memoMarkdownRenderer.syncTaskCheckboxDom(input, memo);
			return;
		}
		this.memoMarkdownRenderer.applyTaskCheckboxDomState(input, marker);
		if (nextContent === latestContent) {
			return;
		}
		this.memoTaskUpdateCoordinator.enqueue(memo, nextContent);
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
		if (this.consumeSuppressedOpenPopupDismissClick(event)) {
			return;
		}
		if (this.handleOpenPopupOutsideEvent(event, event.target, false)) {
			return;
		}
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
			const message = formatServiceError(error, t("error.imageInsertFailed"));
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

function parseImageIndex(value: string | null): number {
	if (value === null) {
		return 0;
	}
	const index = Number(value);
	return Number.isInteger(index) && index >= 0 ? index : 0;
}

function getCardFlowHeadersStateKey(headers: readonly CardFlowHeader[]): string {
	return headers.map((header) => {
		return header.type === "summary"
			? getStateKey([header.type, header.text])
			: getStateKey([header.type, header.count]);
	}).join("");
}

function getStateKey(parts: readonly (string | number)[]): string {
	return parts.map((part) => {
		const value = String(part);
		return `${value.length}:${value}`;
	}).join("");
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

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

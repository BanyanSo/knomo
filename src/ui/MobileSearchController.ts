import { MemoCardImageCache } from "./KnomoCardImages";
import { areMemoListsUnchanged, canRetainMemoCard, getMemoRenderRevision, rebindMemoCard } from "./MemoRenderRevision";
import { createMemoRenderPlaceholders } from "./MemoRenderPlaceholder";
import type { MemoViewItem as MemoRecord } from "../types/memoView";
import { t } from "../i18n";
import type { CatalogQueryFilter } from "../types/catalog";
import { getCatalogQueryKey } from "../services/SearchMatching";
import { CatalogQueryCancelledError, compareCatalogObservations } from "../services/MemoCatalogStore";
import { SearchSession } from "./SearchSession";
import { logContinuationFailure } from "../utils/continuationDiagnostics";
import { buildSearchSourceScope } from "./SearchSourceScope";
import { bindSearchInput } from "./SearchInputBinding";
import { renderSearchDateHint } from "./SearchDateHint";
import {
	getRegularFilterCopy,
	formatMobileSearchSummary,
	formatMobileSearchEmptyTitle,
	type RecordStatsSearchFilter,
	type SearchDateFilter,
} from "./viewFilters";
import { renderKnomoListSummary, renderKnomoLoadMoreButton, renderKnomoCardFlowHeaders, renderKnomoLoadingPlaceholder } from "./KnomoFeed";
import { DelayedLoadingIndicator } from "./DelayedLoadingIndicator";
import type { CardFlowHeader } from "./KnomoCardFlowPresenter";
import { renderKnomoMobileSearchPage } from "./KnomoMobileSearchPage";
import type { CardFlowChangeIntent } from "./KnomoViewStateKeys";

type MobileSearchSurface = "mobile-search";
type ThingsSearchContext = { activeNav: "things"; activeTag: string | null; activeTagKey: string | null };

interface OpenMobileSearchOptions {
	focusInput?: boolean;
	changeIntent?: CardFlowChangeIntent;
}

interface MobileSearchControllerOptions {
	scheduleRenderTask?: (callback: () => void) => number;
	cancelRenderTask?: (id: number) => void;
	prioritizeMarkdown?: (root: HTMLElement, scrollTop: number) => void;
	getResultStatus?: (filter: CatalogQueryFilter) => { headers: CardFlowHeader[]; complete: boolean; blocked: boolean };
	getThingsContext?: () => ThingsSearchContext | undefined;
	syncThingsSearch?: (query: string, date: SearchDateFilter | null) => void;
	getCatalogRevision?: () => number;
	getCoverageKey?: () => string;
	batchSize: number;
	debounceMs: number;
	getWindow: () => Window;
	getDocument: () => Document;
	isVisible?: () => boolean;
	getRootEl: () => HTMLElement | null;
	isMobileLayout: () => boolean;
	getMemos: () => MemoRecord[];
	getMatchedTotalCount?: () => number | null;
	registerDomEvent: <K extends keyof HTMLElementEventMap>(
		target: HTMLElement,
		type: K,
		listener: (event: HTMLElementEventMap[K]) => void,
	) => void;
	createHiddenText: (container: HTMLElement, name: string, text: string) => string;
	filterMemos: (memos: readonly MemoRecord[], filter: CatalogQueryFilter) => MemoRecord[];
	renderMemoCard: (container: HTMLElement, memo: MemoRecord, generation: number, index: number, reusedImagesEl?: HTMLElement | null) => HTMLElement | void;
	clearMarkdown: (surface?: MobileSearchSurface) => void;
	releaseCard?: (card: HTMLElement) => void;
	retainCard?: (card: HTMLElement, memo: MemoRecord) => void;
	clearImages: (surface: MobileSearchSurface) => void;
	bindImageRoot?: (root: HTMLElement | null) => void;
	setCardFlowPaused: (paused: boolean) => void;
	closeSurroundingChrome: () => void;
	closeCardMenu: () => void;
	syncRootState: () => void;
	getCardFlowScrollTop: () => number | null;
	restoreCardFlowScrollTop: (scrollTop: number | null) => void;
	restoreElementScrollTop: (element: HTMLElement | null, scrollTop: number | null, isCurrent?: () => boolean) => void;
	handleMarkdownInternalLinkClick: (event: MouseEvent) => void;
	handleTaskCheckboxClick: (event: MouseEvent) => void;
	handleTaskCheckboxChange: (event: Event) => void;
	loadRemoteResults?: (filter: CatalogQueryFilter, reset: boolean, signal: AbortSignal) => Promise<void>;
	hasRemoteNextPage?: () => boolean;
	restoreRemoteResults?: () => Promise<void>;
	cancelRemoteCount?: () => void;
}

export class MobileSearchController {
	private readonly imageCache = new MemoCardImageCache();
	private pageEl: HTMLElement | null = null;
	private inputEl: HTMLInputElement | null = null;
	private resultsEl: HTMLElement | null = null;
	readonly session = new SearchSession();
	private displayedContext: { things: ThingsSearchContext | undefined; stats: RecordStatsSearchFilter | null } | null = null;
	private displayedMemos: MemoRecord[] | null = null;
	private displayedCount: number | null = null;
	private dateHintEl: HTMLElement | null = null;
	private pendingQueryKey: string | null = null;
	private get query(): string { return this.session.applied.input; }
	private set query(value: string) { this.session.updateDraft(value); this.session.submit(); }
	private queryError: string | null = null;
	private queryRun = 0;
	private queryController: AbortController | null = null;
	private get dateFilter(): SearchDateFilter | null { return this.session.applied.shortcut; }
	private set dateFilter(filter: SearchDateFilter | null) {
		this.session.applied.shortcut = filter;
		if (filter !== null || this.session.applied.dateOrigin === "shortcut") {
			this.session.applied.date = null;
			this.session.applied.dateOrigin = filter === null ? null : "shortcut";
		}
	}
	private recordStatsFilter: RecordStatsSearchFilter | null = null;
	private visibleCount: number;
	private open = false;
	private renderGeneration = 0;
	private debounceTimeoutId: number | null = null;

	private renderTaskId: number | null = null;
	private renderedRevisions: string[] = [];
	private targetRevisions: string[] = [];
	private renderedViewKey = "";
	private scrollRevision = 0;
	private renderRun = 0;
	private renderedStatus: string | null = null;
	private renderedPending = false;
	private readonly loadingIndicator: DelayedLoadingIndicator;
	private pendingScrollTop: number | null = null;
	private renderedCards: Array<{ memo: MemoRecord; card: HTMLElement }> = [];
	private seedPlaceholder: ReturnType<typeof createMemoRenderPlaceholders> | null = null;
	private markdownPriorityTaskId: number | null = null;

	constructor(private readonly options: MobileSearchControllerOptions) {
		this.visibleCount = options.batchSize;
		this.loadingIndicator = new DelayedLoadingIndicator({
			scheduleTask: (callback, delay) => options.getWindow().setTimeout(callback, delay),
			cancelTask: id => options.getWindow().clearTimeout(id),
		});
	}

	get isOpen(): boolean {
		return this.open;
	}

	set isOpen(open: boolean) {
		if (!open) this.cancelPendingRequest();
		this.open = open;
	}

	get page(): HTMLElement | null {
		return this.pageEl;
	}

	get input(): HTMLInputElement | null {
		return this.inputEl;
	}

	get results(): HTMLElement | null {
		return this.resultsEl;
	}

	get searchQuery(): string {
		return this.query;
	}

	set searchQuery(query: string) {
		this.query = query;
		if (this.open) void this.refreshAppliedResults();
	}

	get searchDateFilter(): SearchDateFilter | null {
		return this.dateFilter;
	}

	set searchDateFilter(filter: SearchDateFilter | null) {
		this.dateFilter = filter;
	}

	get searchRecordStatsFilter(): RecordStatsSearchFilter | null {
		return this.recordStatsFilter;
	}

	set searchRecordStatsFilter(filter: RecordStatsSearchFilter | null) {
		this.recordStatsFilter = filter;
	}

	get searchVisibleCount(): number {
		return this.visibleCount;
	}

	set searchVisibleCount(count: number) {
		this.visibleCount = count;
	}

	get generation(): number {
		return this.renderGeneration;
	}

	set generation(generation: number) {
		this.renderGeneration = generation;
	}

	incrementGeneration(): void {
		this.renderGeneration += 1;
	}

	openPage(options: OpenMobileSearchOptions = {}): void {
		this.options.closeSurroundingChrome();
		this.open = true;
		this.options.setCardFlowPaused(true);
		this.ensurePage();
		this.syncInput();
		this.options.bindImageRoot?.(this.resultsEl);
		if (this.hasSearchConditions()) void this.refreshRemoteResults(true, options.changeIntent ?? "content-change");
		else this.renderResults(options.changeIntent ?? "content-change");
		this.options.syncRootState();
		if (options.focusInput !== false) this.focusInputNow();
	}

	ensurePage(): void {
		const root = this.options.getRootEl();
		if (root === null) {
			return;
		}
		if (this.pageEl !== null && this.pageEl.isConnected) {
			return;
		}
		const page = renderKnomoMobileSearchPage(root, {
			createHiddenText: this.options.createHiddenText,
		});
		this.pageEl = page.pageEl;
		this.inputEl = page.inputEl;
		this.resultsEl = page.resultsEl;
		this.options.bindImageRoot?.(this.resultsEl);
		this.dateHintEl = this.pageEl.find(".knomo-search-date-hint");
		bindSearchInput({
			input: this.inputEl, session: this.session,
			registerDomEvent: this.options.registerDomEvent,
			onDraftChanged: () => this.invalidateDraft(),
			onQueue: () => this.queueQuery(this.session.draft.text),
			onClose: () => this.closePage(),
		});
		this.options.registerDomEvent(this.resultsEl, "click", (event) => {
			this.options.handleMarkdownInternalLinkClick(event);
		});
		this.options.registerDomEvent(this.resultsEl, "click", (event) => {
			this.options.handleTaskCheckboxClick(event);
		});
		this.options.registerDomEvent(this.resultsEl, "change", (event) => {
			this.options.handleTaskCheckboxChange(event);
		});
		const onScrollIntent = () => {
			this.scrollRevision++;
			this.pendingScrollTop = null;
			this.queueMarkdownPriority();
		};
		this.options.registerDomEvent(this.resultsEl, "touchstart", onScrollIntent);
		this.options.registerDomEvent(this.resultsEl, "wheel", onScrollIntent);
		this.options.registerDomEvent(this.resultsEl, "scroll", () => this.queueMarkdownPriority());
	}

	syncPage(): void {
		const shouldOpen = this.options.isMobileLayout() && this.open;
		this.options.getDocument().body.toggleClass("knomo-mobile-search-active", shouldOpen);
		if (!this.options.isMobileLayout()) {
			this.cancelPendingRequest();
			this.clearDebounce();
			this.session.draft.composing = false;
			this.options.cancelRemoteCount?.();
			this.cancelRender();
			this.clearImageCache();
			this.open = false;
			this.options.bindImageRoot?.(null);
			this.recordStatsFilter = null;
			this.options.clearImages("mobile-search");
			this.options.setCardFlowPaused(false);
			this.options.getRootEl()?.toggleClass("is-mobile-search-open", false);
			this.setPageActive(false);
			return;
		}
		if (!this.open) {
			this.setPageActive(false);
			return;
		}
		this.ensurePage();
		this.setPageActive(true);
	}

	closePage(): void {
		this.cancelPendingRequest();
		this.clearDebounce();
		this.options.cancelRemoteCount?.();
		const composing = this.session.draft.composing;
		this.session.draft.composing = false;
		this.cancelRender();
		if (this.resultsEl) this.imageCache.capture(this.resultsEl, this.resultsEl);
		this.queryRun++;
		this.pendingQueryKey = null;
		const scrollTop = this.options.getCardFlowScrollTop();
		this.open = false;
		this.session.close();
		this.options.closeCardMenu();
		if (this.options.getThingsContext?.()) {
			if (!composing) this.flushQuery();
			this.options.syncThingsSearch?.(this.query, this.dateFilter);
		} else {
			this.resetState(true);
		}
		this.options.bindImageRoot?.(null);
		this.options.setCardFlowPaused(false);
		this.options.syncRootState();
		this.options.restoreCardFlowScrollTop(scrollTop);
		void this.options.restoreRemoteResults?.();
	}

	clearImageCache(): void {
		this.imageCache.clear();
	}

	invalidateImagePaths(paths: readonly string[]): void {
		this.imageCache.invalidateResourcePaths(paths);
	}

	private cancelRender(): void {
		this.renderRun++;
		if (this.renderTaskId !== null) this.options.cancelRenderTask?.(this.renderTaskId);
		this.renderTaskId = null;
		this.renderedRevisions = [];
		this.targetRevisions = [];
		this.pendingScrollTop = null;
		this.renderedCards = [];
		this.seedPlaceholder = null;
		if (this.markdownPriorityTaskId !== null) this.options.cancelRenderTask?.(this.markdownPriorityTaskId);
		this.markdownPriorityTaskId = null;
	}

	private prioritizeMarkdown(): void {
		if (this.open && this.resultsEl) {
			this.options.prioritizeMarkdown?.(this.resultsEl, this.pendingScrollTop ?? this.resultsEl.scrollTop);
		}
	}

	private queueMarkdownPriority(): void {
		if (!this.options.prioritizeMarkdown || this.markdownPriorityTaskId !== null) return;
		if (!this.options.scheduleRenderTask) { this.prioritizeMarkdown(); return; }
		const run = this.renderRun;
		this.markdownPriorityTaskId = this.options.scheduleRenderTask(() => {
			if (run !== this.renderRun) return;
			this.markdownPriorityTaskId = null;
			this.prioritizeMarkdown();
		});
	}

	removePage(): void {
		this.cancelPendingRequest();
		this.options.cancelRemoteCount?.();
		this.queryRun++;
		this.session.draft.composing = false;
		this.cancelRender();
		this.clearImageCache();
		this.options.bindImageRoot?.(null);
		this.clearDebounce();
		this.session.close();
		this.open = false;
		this.dateHintEl = null;
		this.pageEl?.detach();
		this.pageEl = null;
		this.inputEl = null;
		this.resultsEl = null;
	}

	focusInputNow(): void {
		const input = this.inputEl;
		if (input === null || !input.isConnected) {
			return;
		}
		try {
			input.focus({ preventScroll: true });
		} catch {
			input.focus();
		}
	}

	queueQuery(query: string): void {
		if (this.session.updateDraft(query)) this.invalidateDraft();
		this.clearDebounce();
		if (!this.open || !this.session.canRewrite) return;
		this.debounceTimeoutId = this.options.getWindow().setTimeout(() => {
			this.debounceTimeoutId = null;
			this.submitDraft();
		}, this.options.debounceMs);
	}

	private invalidateDraft(): void {
		this.cancelPendingRequest();
		this.queryRun++;
		this.pendingQueryKey = null;
		this.clearDebounce();
		this.cancelRender();
		this.options.cancelRemoteCount?.();
		if (this.session.requestStatus === "pending") this.session.requestStatus = "idle";
		this.syncControls();
	}

	private submitDraft(): void {
		this.clearDebounce();
		if (!this.open || !this.session.submit()) { this.syncControls(); return; }
		this.syncInput();
		if (this.options.getThingsContext?.()) this.options.syncThingsSearch?.(this.query, this.dateFilter);
		this.visibleCount = this.options.batchSize;
		void this.refreshRemoteResults(true, "view-scope-change", true);
	}

	private syncInput(): void {
		if (!this.inputEl || this.session.draft.composing || this.inputEl.value === this.session.draft.text) return;
		this.inputEl.value = this.session.draft.text;
		this.inputEl.setSelectionRange?.(this.session.draft.selectionStart, this.session.draft.selectionEnd);
	}

	private syncControls(): void {
		if (this.dateHintEl) renderSearchDateHint(this.dateHintEl, this.session);
		this.syncDateButtons();
	}

	getAppliedFilter(): CatalogQueryFilter {
		const context = this.options.getThingsContext?.();
		const source = buildSearchSourceScope({
			activeNav: context?.activeNav ?? "all", scopeFilter: "all",
			activeTag: context?.activeTag ?? null, activeTagKey: context?.activeTagKey ?? null,
			recordStatsSearchFilter: this.recordStatsFilter,
		});
		return this.session.getFilter(source);
	}

	getDisplayedFilter(): CatalogQueryFilter { return this.session.result?.filter ?? this.getAppliedFilter(); }

	clearDebounce(): void {
		if (this.debounceTimeoutId === null) {
			return;
		}
		this.options.getWindow().clearTimeout(this.debounceTimeoutId);
		this.debounceTimeoutId = null;
	}

	setDateFilter(filter: SearchDateFilter): void {
		this.clearDebounce();
		if (this.inputEl) this.session.updateDraft(this.inputEl.value);
		if (!this.session.toggleShortcut(filter)) { this.syncControls(); return; }
		this.recordStatsFilter = null;
		if (this.options.getThingsContext?.()) this.options.syncThingsSearch?.(this.query, this.dateFilter);
		this.invalidateDraft();
		this.syncInput();
		this.visibleCount = this.options.batchSize;
		void this.refreshRemoteResults(true, "view-scope-change");
	}

	resetState(preserveImages = false): void {
		this.cancelPendingRequest();
		this.options.cancelRemoteCount?.();
		this.session.draft.composing = false;
		this.cancelRender();
		this.queryRun += 1;
		this.queryError = null;
		if (!preserveImages) this.clearImageCache();
		this.clearDebounce();
		this.session.reset();
		this.displayedContext = null;
		this.displayedMemos = null;
		this.displayedCount = null;
		this.pendingQueryKey = null;
		this.recordStatsFilter = null;
		this.visibleCount = this.options.batchSize;
		this.incrementGeneration();
		this.options.clearMarkdown("mobile-search");
		this.options.clearImages("mobile-search");
		if (this.inputEl !== null) {
			this.inputEl.value = "";
		}
		this.resultsEl?.empty();
		this.syncDateButtons();
	}

	flushQuery(): void {
		this.clearDebounce();
		if (this.inputEl) this.session.updateDraft(this.inputEl.value);
		this.session.submit();
	}

	loadMore(): void {
		if (this.session.requestStatus === "pending" || this.session.result?.key !== getCatalogQueryKey(this.getAppliedFilter())) return;
		this.visibleCount += this.options.batchSize;
		const matchedCount = this.getMatchedMemos().length;
		if (this.visibleCount >= matchedCount && this.options.hasRemoteNextPage?.() === true) {
			void this.refreshRemoteResults(false);
			return;
		}
		this.renderResults("content-change", true);
	}

	private async refreshRemoteResults(reset: boolean, changeIntent: CardFlowChangeIntent = "content-change", deduplicate = false): Promise<void> {
		if (!this.open) return;
		if (!this.hasSearchConditions()) {
			this.cancelPendingRequest();
			this.queryRun++;
			this.options.cancelRemoteCount?.();
			this.displayedMemos = null;
			this.displayedCount = null;
			this.displayedContext = null;
			this.session.result = null;
			this.session.requestStatus = "idle";
			this.pendingQueryKey = null;
			this.queryError = null;
			this.renderResults(changeIntent);
			return;
		}
		const context = { things: this.options.getThingsContext?.(), stats: this.recordStatsFilter };
		const filter = this.getAppliedFilter();
		const key = getCatalogQueryKey(filter);
		const revision = this.options.getCatalogRevision?.() ?? 0;
		const coverageKey = this.options.getCoverageKey?.() ?? "";
		if (deduplicate && (this.pendingQueryKey === key || (this.session.requestStatus === "ready"
			&& this.session.result?.key === key && this.session.result.catalogRevision === revision
			&& this.session.result.coverageKey === coverageKey))) {
			this.syncControls();
			if (this.session.requestStatus === "ready") this.renderResults("content-change");
			return;
		}
		this.cancelPendingRequest(false);
		const controller = new AbortController();
		this.queryController = controller;
		const run = ++this.queryRun, version = this.session.version;
		this.pendingQueryKey = key;
		this.session.beginRequest();
		this.queryError = null;
		this.syncControls();
		if (this.displayedMemos === null && this.options.loadRemoteResults) this.renderResults();
		try {
			if (this.options.loadRemoteResults) await this.options.loadRemoteResults(filter, reset, controller.signal);
			controller.signal.throwIfAborted();
			if (!this.open || run !== this.queryRun || version !== this.session.version) return;
			if (key !== getCatalogQueryKey(this.getAppliedFilter())) return;
			this.displayedContext = context;
			const previousCount = this.session.result?.key === key ? this.displayedCount : null;
			this.displayedMemos = this.options.loadRemoteResults ? [...this.options.getMemos()] : this.options.getMemos();
			this.displayedCount = this.options.getMatchedTotalCount?.() ?? (this.options.loadRemoteResults ? previousCount : this.options.filterMemos(this.displayedMemos, filter).length);
			this.session.commitResult(filter, this.options.getCatalogRevision?.() ?? 0, this.options.getCoverageKey?.() ?? "");
		} catch (error) {
			if (!this.open || run !== this.queryRun || version !== this.session.version) return;
			if (controller.signal.aborted || error instanceof CatalogQueryCancelledError) {
				this.session.requestStatus = this.session.result === null ? "idle" : "ready";
				return;
			}
			logContinuationFailure("mobile-search", "query", error, run);
			this.queryError = t("feedback.loadFailed");
			this.session.requestStatus = "failed";
		} finally {
			if (this.queryController === controller) this.queryController = null;
			if (this.open && run === this.queryRun && version === this.session.version) {
				this.pendingQueryKey = null;
				this.syncControls();
				this.renderResults(changeIntent, !reset, true);
			}
		}
	}

	refreshAppliedResults(): Promise<void> { return this.refreshRemoteResults(true); }

	cancelPendingRequest(clearIndicator = true): void {
		this.queryController?.abort();
		this.queryController = null;
		if (clearIndicator) this.loadingIndicator.clear();
	}

	suspendLoadingFeedback(): void { this.loadingIndicator.clear(); }

	getDisplayedMemos(): readonly MemoRecord[] { return this.displayedMemos ?? []; }

	applyMemoChanges(changes: ReadonlyMap<string, MemoRecord | null>, inserted: readonly MemoRecord[] = [], created = false): void {
		if (!this.open || !this.hasSearchConditions()) return;
		const hadPendingQuery = this.pendingQueryKey !== null;
		const resumeSearch = this.pendingQueryKey !== null && this.pendingQueryKey !== this.session.result?.key;
		this.cancelPendingRequest();
		const additions = this.options.filterMemos(inserted, this.getDisplayedFilter());
		if (additions.length === 0 && !this.displayedMemos?.some(memo => changes.has(memo.id))) {
			if (!hadPendingQuery) return;
			this.queryRun++;
			this.pendingQueryKey = null;
			this.session.requestStatus = this.session.result === null ? "idle" : "ready";
			if (resumeSearch) void this.refreshAppliedResults();
			else this.syncControls();
			return;
		}
		const previous = this.getMatchedMemos();
		this.queryRun++;
		this.pendingQueryKey = null;
		this.options.cancelRemoteCount?.();
		this.displayedMemos = [...new Map([...(this.displayedMemos ?? []).flatMap(memo => {
			const current = changes.has(memo.id) ? changes.get(memo.id) : memo;
			return current ? [current] : [];
		}), ...additions].map(memo => [memo.id, memo])).values()]
			.sort((left, right) => left.catalog && right.catalog
				? compareCatalogObservations(left.catalog.observation, right.catalog.observation)
				: right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id));
		const current = this.getMatchedMemos();
		if (!areMemoListsUnchanged(previous, current, changes)) this.displayedCount = created && this.displayedCount !== null
			? this.displayedCount + current.length - previous.length : null;
		if (this.session.result) this.session.requestStatus = "ready";
		if (!this.reconcileCommittedCards(changes)) this.renderResults();
		// 提交通知使旧查询失效后，继续完成用户已提交的新搜索条件。
		if (resumeSearch) void this.refreshAppliedResults();
	}

	private reconcileCommittedCards(changes: ReadonlyMap<string, MemoRecord | null>): boolean {
		const root = this.resultsEl;
		if (!root || this.renderedCards.length === 0
			|| this.renderedViewKey !== this.getViewStateKey()) return false;
		const wasPending = this.renderTaskId !== null;
		const memos = this.getMatchedMemos(), visible = memos.slice(0, wasPending ? this.renderedCards.length : this.visibleCount);
		if (visible.length === 0) return false;
		if (wasPending) {
			this.options.cancelRenderTask?.(this.renderTaskId!);
			this.renderTaskId = null; this.renderRun++;
		}
		const visibleIds = new Set(visible.map(memo => memo.id));
		const retained = new Map<string, { memo: MemoRecord; card: HTMLElement }>();
		for (const item of this.renderedCards) {
			const current = changes.has(item.memo.id) ? changes.get(item.memo.id) : item.memo;
			if (current && visibleIds.has(current.id)) retained.set(current.id, item);
		}
		const seed = createMemoRenderPlaceholders(this.renderedCards);
		const scrollTop = root.scrollTop;
		const next: Array<{ memo: MemoRecord; card: HTMLElement }> = [];
		for (const [index, memo] of visible.entries()) {
			const previous = retained.get(memo.id);
			let card = previous?.card;
			if (previous && canRetainMemoCard(previous.memo, memo)) {
				rebindMemoCard(previous.card, memo);
				this.options.retainCard?.(previous.card, memo);
			} else if (!previous || previous.memo !== memo) {
				const rendered = this.options.renderMemoCard(root, memo, this.renderGeneration, index,
					previous?.card.querySelector<HTMLElement>(".knomo-card-images") ?? null);
				if (!rendered) return false;
				seed(memo, rendered);
				if (card) card.replaceWith(rendered);
				card = rendered;
			}
			next.push({ memo, card: card! });
		}
		const cards = new Set(next.map(item => item.card));
		for (const item of this.renderedCards) if (!cards.has(item.card)) {
			this.options.releaseCard?.(item.card); item.card.remove();
		}
		// 保留现有卡片容器和视口；只在提交影响顺序时移动卡片。
		let following: HTMLElement | null = root.querySelector(".knomo-mobile-search-more");
		for (const item of [...next].reverse()) {
			if (item.card.nextElementSibling !== following) root.insertBefore(item.card, following);
			following = item.card;
		}
		this.renderedCards = next;
		this.renderedRevisions = visible.map(memo => JSON.stringify([getMemoRenderRevision(memo), memo.catalog?.observationHandle]));
		this.targetRevisions = [...this.renderedRevisions];
		root.scrollTop = scrollTop;
		this.syncControls();
		this.syncResultMetadata(memos.length, visible.length, !wasPending);
		this.prioritizeMarkdown();
		if (wasPending) {
			this.pendingScrollTop = scrollTop;
			this.seedPlaceholder = seed;
			this.renderResults("content-change", true);
		}
		return true;
	}

	renderResults(changeIntent: CardFlowChangeIntent = "content-change", append = false, metadataOnly = false): void {
		const resultsEl = this.resultsEl;
		if (resultsEl === null || !this.open) {
			return;
		}
		const viewKey = this.getViewStateKey();
		const sameView = changeIntent !== "view-scope-change" && viewKey === this.renderedViewKey;
		// 临时清空 DOM 会压缩 scrollTop；同范围的后续刷新必须继承尚未完成的恢复目标。
		const scrollTop = changeIntent === "view-scope-change" ? 0
			: (sameView ? this.pendingScrollTop : null) ?? resultsEl.scrollTop;
		const memos = this.getMatchedMemos();
		const visibleMemos = memos.slice(0, this.visibleCount);
		const revisions = visibleMemos.map(memo => JSON.stringify([getMemoRenderRevision(memo), memo.catalog?.observationHandle]));
		const readStatus = this.options.getResultStatus?.(this.getDisplayedFilter());
		const waiting = this.hasSearchConditions() && this.session.requestStatus === "pending" && !readStatus?.blocked
			&& this.options.isVisible?.() !== false && this.options.getDocument().visibilityState !== "hidden";
		const visible = waiting && this.session.result === null ? this.loadingIndicator.pending(viewKey, () => {
			if (this.open && this.options.isVisible?.() !== false && this.options.getDocument().visibilityState !== "hidden") this.renderResults("content-change", true, true);
			else this.loadingIndicator.clear();
		}) : false;
		if (!waiting || this.session.result !== null) this.loadingIndicator.clear();
		const headers: CardFlowHeader[] = this.queryError !== null ? [] : [...(readStatus?.headers ?? [])];
		if (this.session.result !== null && readStatus?.complete === false && headers.length === 0) {
			headers.push({ type: "summary", text: t("catalog.incompleteResults") });
		}
		const status = this.queryError !== null ? (memos.length > 0 ? t("feedback.refreshFailed") : this.queryError)
			: headers.length > 0 ? JSON.stringify(headers) : null;
		const statusChanged = status !== this.renderedStatus;
		if (metadataOnly && this.session.requestStatus === "ready") this.displayedCount = this.options.getMatchedTotalCount?.() ?? this.displayedCount;
		this.syncControls();
		// 总数晚到时仅沿用已开始渲染的卡片列表；空搜索提示不能新增加载入口。
		if (metadataOnly && sameView && this.renderedPending === waiting && this.renderedStatus === status
			&& (this.session.result !== null || !waiting)
			&& revisions.length === this.targetRevisions.length
			&& revisions.every((revision, index) => revision === this.targetRevisions[index])) {
			this.syncResultMetadata(memos.length, visibleMemos.length, this.renderTaskId === null);
			return;
		}
		const canAppend = append && changeIntent !== "view-scope-change" && !status && this.renderTaskId === null
			&& this.renderedStatus === status
			&& this.renderedViewKey === this.getViewStateKey() && this.renderedRevisions.length > 0
			&& this.renderedRevisions.length <= revisions.length
			&& this.renderedRevisions.every((revision, index) => revision === revisions[index]);
		const startIndex = canAppend ? this.renderedRevisions.length : 0;
		if (!canAppend) {
			const seedPlaceholder = sameView
				? this.seedPlaceholder ?? createMemoRenderPlaceholders(this.renderedCards)
				: null;
			this.cancelRender();
			this.pendingScrollTop = scrollTop;
			this.seedPlaceholder = seedPlaceholder;
			this.imageCache.capture(resultsEl, this.options.scheduleRenderTask ? resultsEl : null, scrollTop);
			this.renderGeneration += 1;
			this.options.clearMarkdown("mobile-search");
			this.options.clearImages("mobile-search");
			resultsEl.empty();
		} else {
			resultsEl.find(".knomo-mobile-search-more")?.remove();
		}
		this.targetRevisions = revisions;
		if (this.markdownPriorityTaskId !== null) this.options.cancelRenderTask?.(this.markdownPriorityTaskId);
		this.markdownPriorityTaskId = null;
		const generation = this.renderGeneration;
		const renderRun = ++this.renderRun;
		const scrollRevision = this.scrollRevision;
		const completeRender = () => {
			const target = this.pendingScrollTop;
			this.pendingScrollTop = null;
			this.seedPlaceholder = null;
			if (!canAppend && target !== null && scrollRevision === this.scrollRevision) {
				this.options.restoreElementScrollTop(resultsEl, target, () =>
					this.open && renderRun === this.renderRun && scrollRevision === this.scrollRevision);
			}
		};
		this.renderedStatus = status;
		this.renderedPending = waiting;
		this.renderedViewKey = viewKey;
		this.syncDateButtons();
		if (!this.hasSearchConditions()) {
			resultsEl.createDiv({ cls: "knomo-mobile-search-empty", text: t("search.emptyPrompt") });
			completeRender();
			return;
		}
		if (this.session.result === null && !this.session.canRewrite && !this.session.draft.composing) {
			completeRender();
			return;
		}
		if (this.queryError === null) renderKnomoCardFlowHeaders(resultsEl, headers);
		if (status && this.queryError !== null) {
			const summary = renderKnomoListSummary(resultsEl, status);
			if (this.queryError !== null) {
				summary.setAttr("role", "status"); summary.setAttr("aria-live", statusChanged ? "polite" : "off");
				const retry = summary.createEl("button", { cls: "knomo-inline-button", text: t("settings.attention.retry"), attr: { type: "button" } });
				retry.addEventListener("click", event => { event.stopPropagation(); void this.refreshAppliedResults(); });
			}
		}
		if (this.session.result === null && this.queryError === null) {
			if (waiting) renderKnomoLoadingPlaceholder(resultsEl, visible);
			completeRender();
			return;
		}
		if (memos.length === 0 && status) { completeRender(); return; }
		if (memos.length === 0) {
			resultsEl.createDiv({
				cls: "knomo-mobile-search-empty",
				text: this.getResultCopy(0)?.emptyTitle,
			});
			completeRender();
			return;
		}
		if (!status) this.syncResultMetadata(memos.length, visibleMemos.length, false);
		let index = startIndex;
		const renderChunk = () => {
			if (renderRun !== this.renderRun || !this.open || generation !== this.renderGeneration || resultsEl !== this.resultsEl) return;
			this.renderTaskId = null;
			const startedAt = performance.now();
			let count = 0;
			while (index < visibleMemos.length) {
				const memo = visibleMemos[index];
				const card = this.options.renderMemoCard(resultsEl, memo, generation, index, this.imageCache.take(memo));
				if (card) {
					this.seedPlaceholder?.(memo, card);
					this.renderedCards.push({ memo, card });
				}
				this.renderedRevisions.push(revisions[index++]);
				if (this.options.scheduleRenderTask && (++count >= 6 || performance.now() - startedAt >= 4)) break;
			}
			this.prioritizeMarkdown();
			if (index < visibleMemos.length && this.options.scheduleRenderTask) {
				this.renderTaskId = this.options.scheduleRenderTask(renderChunk);
				return;
			}
			this.syncResultMetadata(memos.length, visibleMemos.length, true, !status);
			// 追加时保留浏览器的当前位置，不用旧 scrollTop 覆盖用户刚发生的滚动。
			completeRender();
		};
		renderChunk();
	}

	private syncResultMetadata(matchedCount: number, visibleCount: number, updateMore: boolean, updateSummary = true): void {
		const results = this.resultsEl;
		if (!results) return;
		const total = this.displayedCount;
		if (updateSummary && total !== null && this.session.result !== null) {
			const summary = this.getResultCopy(total)?.summary;
			if (summary) {
				const previous = results.find(".knomo-list-summary");
				if (previous) previous.setText(summary);
				else results.prepend(renderKnomoListSummary(results, summary));
			}
		}
		if (!updateMore) return;
		const previous = results.find(".knomo-mobile-search-more");
		if (visibleCount >= matchedCount && this.options.hasRemoteNextPage?.() !== true) {
			previous?.remove();
			return;
		}
		if (this.session.requestStatus === "pending" || this.session.result?.key !== getCatalogQueryKey(this.getAppliedFilter())) { previous?.remove(); return; }
		const remainingCount = total === null ? null : Math.max(1, total - visibleCount);
		if (previous) previous.setText(remainingCount === null ? t("list.loadMoreUnknown") : t("list.loadMore", { count: remainingCount }));
		else renderKnomoLoadMoreButton(results, { remainingCount, action: "load-more-mobile-search", extraClass: "knomo-mobile-search-more" });
	}

	syncDateButtons(): void {
		this.pageEl?.findAll("[data-search-date]").forEach((element) => {
			const active = element.getAttr("data-search-date") === this.dateFilter;
			element.toggleClass("is-active", active);
			element.setAttr("aria-pressed", active ? "true" : "false");
		});
	}

	getStateKey(): string {
		return JSON.stringify([this.open, this.getViewStateKey(), this.getVisibleMemos().map(getMemoRenderRevision),
			this.session.result?.catalogRevision, this.session.result?.coverageKey, this.options.getResultStatus?.(this.getDisplayedFilter())]);
	}

	getViewStateKey(): string { return getCatalogQueryKey(this.getAppliedFilter()); }

	private setPageActive(active: boolean): void {
		const page = this.pageEl;
		if (page === null) {
			return;
		}
		page.toggleClass("is-open", active);
		page.setAttr("aria-hidden", active ? "false" : "true");
		if (active) {
			page.removeAttribute("inert");
		} else {
			page.setAttr("inert", "");
		}
	}

	private hasSearchConditions(): boolean {
		return !!this.options.getThingsContext?.() || this.session.hasConditions || this.recordStatsFilter !== null;
	}

	private getResultCopy(count: number) {
		const query = (this.session.result?.input ?? this.query).trim();
		const date = this.session.result ? this.session.result.shortcut : this.dateFilter;
		const context = this.displayedContext ? this.displayedContext.things : this.options.getThingsContext?.();
		const stats = this.displayedContext ? this.displayedContext.stats : this.recordStatsFilter;
		return context ? getRegularFilterCopy({
			...context, searchQuery: query, searchDateFilter: date, recordStatsSearchFilter: stats, scopeFilter: "all",
		}, count) : {
			summary: formatMobileSearchSummary(query, date, count, stats),
			emptyTitle: formatMobileSearchEmptyTitle(query, date, stats),
		};
	}

	private getMatchedMemos(): MemoRecord[] {
		const filter = this.getDisplayedFilter();
		return this.options.filterMemos(this.displayedMemos ?? [], filter);
	}

	private getVisibleMemos(): MemoRecord[] {
		return this.getMatchedMemos().slice(0, this.visibleCount);
	}
}

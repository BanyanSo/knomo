import { MemoCardImageCache } from "./KnomoCardImages";
import { getMemoRenderRevision } from "./MemoRenderRevision";
import { createMemoRenderPlaceholders } from "./MemoRenderPlaceholder";
import type { MemoViewItem as MemoRecord } from "../types/memoView";
import { t } from "../i18n";
import {
	getRegularFilterCopy,
	formatMobileSearchEmptyTitle,
	formatMobileSearchSummary,
	type RecordStatsSearchFilter,
	type SearchDateFilter,
} from "./viewFilters";
import { renderKnomoListSummary, renderKnomoLoadMoreButton } from "./KnomoFeed";
import { renderKnomoMobileSearchPage } from "./KnomoMobileSearchPage";
import {
	getMobileSearchChangeIntent,
	getMobileSearchIdsKey,
	getMobileSearchStateKey,
	getMobileSearchViewStateKey,
	type CardFlowChangeIntent,
} from "./KnomoViewStateKeys";

type MobileSearchSurface = "mobile-search";

interface OpenMobileSearchOptions {
	focusInput?: boolean;
	changeIntent?: CardFlowChangeIntent;
	refreshRemoteResults?: boolean;
}

interface MobileSearchControllerOptions {
	scheduleRenderTask?: (callback: () => void) => number;
	cancelRenderTask?: (id: number) => void;
	prioritizeMarkdown?: (root: HTMLElement, scrollTop: number) => void;
	getThingsStatus?: () => string | null;
	getThingsContext?: () => { activeNav: "things"; activeTag: string | null; activeTagKey: string | null } | undefined;
	syncThingsSearch?: (query: string, date: SearchDateFilter | null) => void;
	batchSize: number;
	debounceMs: number;
	getWindow: () => Window;
	getDocument: () => Document;
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
	memoMatchesSearch: (
		memo: MemoRecord,
		normalizedQuery: string,
		dateFilter: SearchDateFilter | null,
		recordStatsFilter: RecordStatsSearchFilter | null,
	) => boolean;
	renderMemoCard: (container: HTMLElement, memo: MemoRecord, generation: number, index: number, reusedImagesEl?: HTMLElement | null) => HTMLElement | void;
	clearMarkdown: (surface?: MobileSearchSurface) => void;
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
	loadRemoteResults?: (
		query: string,
		dateFilter: SearchDateFilter | null,
		recordStatsFilter: RecordStatsSearchFilter | null,
		reset: boolean,
	) => Promise<void>;
	hasRemoteNextPage?: () => boolean;
	restoreRemoteResults?: () => Promise<void>;
	cancelRemoteCount?: () => void;
}

export class MobileSearchController {
	private readonly imageCache = new MemoCardImageCache();
	private pageEl: HTMLElement | null = null;
	private inputEl: HTMLInputElement | null = null;
	private resultsEl: HTMLElement | null = null;
	private query = "";
	private queryError: string | null = null;
	private queryRun = 0;
	private dateFilter: SearchDateFilter | null = null;
	private recordStatsFilter: RecordStatsSearchFilter | null = null;
	private visibleCount: number;
	private open = false;
	private renderGeneration = 0;
	private debounceTimeoutId: number | null = null;
	private composing = false;
	private renderTaskId: number | null = null;
	private renderedRevisions: string[] = [];
	private targetRevisions: string[] = [];
	private renderedViewKey = "";
	private scrollRevision = 0;
	private renderRun = 0;
	private renderedStatus: string | null = null;
	private pendingScrollTop: number | null = null;
	private renderedCards: Array<{ memo: MemoRecord; card: HTMLElement }> = [];
	private seedPlaceholder: ReturnType<typeof createMemoRenderPlaceholders> | null = null;
	private markdownPriorityTaskId: number | null = null;

	constructor(private readonly options: MobileSearchControllerOptions) {
		this.visibleCount = options.batchSize;
	}

	get isOpen(): boolean {
		return this.open;
	}

	set isOpen(open: boolean) {
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
		if (this.inputEl !== null && this.inputEl.value !== this.query) {
			this.inputEl.value = this.query;
		}
		this.options.bindImageRoot?.(this.resultsEl);
		this.renderResults(options.changeIntent ?? "content-change");
		this.options.syncRootState();
		if (options.focusInput !== false) {
			this.focusInputNow();
		}
		if (options.refreshRemoteResults) {
			void this.refreshRemoteResults(true, options.changeIntent ?? "content-change");
		}
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
		this.options.registerDomEvent(this.inputEl, "compositionstart", () => {
			this.queryRun++;
			this.composing = true;
			this.clearDebounce();
			this.options.cancelRemoteCount?.();
		});
		this.options.registerDomEvent(this.inputEl, "compositionend", () => {
			this.composing = false;
			if (this.open) this.queueQuery(this.inputEl?.value ?? "");
		});
		this.options.registerDomEvent(this.inputEl, "input", (event) => {
			if (this.composing || ("isComposing" in event && event.isComposing === true) || !this.open) return;
			this.queueQuery(this.inputEl?.value ?? "");
		});
		this.options.registerDomEvent(this.inputEl, "keydown", (event) => {
			if (event.key === "Escape" && !this.composing && !event.isComposing) {
				event.preventDefault();
				event.stopPropagation();
				this.closePage();
			}
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
			this.clearDebounce();
			this.composing = false;
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
		this.options.cancelRemoteCount?.();
		this.composing = false;
		this.cancelRender();
		if (this.resultsEl) this.imageCache.capture(this.resultsEl, this.resultsEl);
		this.queryRun += 1;
		const scrollTop = this.options.getCardFlowScrollTop();
		this.open = false;
		this.options.closeCardMenu();
		if (this.options.getThingsContext?.()) {
			this.flushQuery();
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
		this.options.cancelRemoteCount?.();
		this.queryRun++;
		this.composing = false;
		this.cancelRender();
		this.clearImageCache();
		this.options.bindImageRoot?.(null);
		this.clearDebounce();
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
		this.queryRun++;
		this.clearDebounce();
		this.options.cancelRemoteCount?.();
		this.debounceTimeoutId = this.options.getWindow().setTimeout(() => {
			this.debounceTimeoutId = null;
			const previousViewStateKey = this.getViewStateKey();
			this.query = query;
			const changeIntent = this.getChangeIntent(previousViewStateKey);
			if (changeIntent === "view-scope-change") {
				this.visibleCount = this.options.batchSize;
			}
			void this.refreshRemoteResults(true, changeIntent);
		}, this.options.debounceMs);
	}

	clearDebounce(): void {
		if (this.debounceTimeoutId === null) {
			return;
		}
		this.options.getWindow().clearTimeout(this.debounceTimeoutId);
		this.debounceTimeoutId = null;
	}

	setDateFilter(filter: SearchDateFilter): void {
		const previousViewStateKey = this.getViewStateKey();
		this.flushQuery();
		this.dateFilter = this.dateFilter === filter ? null : filter;
		this.recordStatsFilter = null;
		this.visibleCount = this.options.batchSize;
		void this.refreshRemoteResults(true, this.getChangeIntent(previousViewStateKey));
	}

	resetState(preserveImages = false): void {
		this.options.cancelRemoteCount?.();
		this.composing = false;
		this.cancelRender();
		this.queryRun += 1;
		this.queryError = null;
		if (!preserveImages) this.clearImageCache();
		this.clearDebounce();
		this.query = "";
		this.dateFilter = null;
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
		this.query = this.inputEl?.value ?? this.query;
	}

	loadMore(): void {
		this.visibleCount += this.options.batchSize;
		const matchedCount = this.getMatchedMemos(this.query.trim().toLowerCase()).length;
		if (this.visibleCount >= matchedCount && this.options.hasRemoteNextPage?.() === true) {
			void this.refreshRemoteResults(false);
			return;
		}
		this.renderResults("content-change", true);
	}

	private async refreshRemoteResults(reset: boolean, changeIntent: CardFlowChangeIntent = "content-change"): Promise<void> {
		if (this.options.loadRemoteResults === undefined) {
			this.renderResults(changeIntent, !reset);
			return;
		}
		const run = ++this.queryRun;
		try {
			this.queryError = null;
			this.options.syncThingsSearch?.(this.query, this.dateFilter);
			await this.options.loadRemoteResults(this.query, this.dateFilter, this.recordStatsFilter, reset);
		} catch (error) {
			if (run === this.queryRun) this.queryError = error instanceof Error ? error.message : t("empty.cardFlowFailed");
		} finally {
			if (run === this.queryRun) this.renderResults(changeIntent, !reset);
		}
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
		const query = this.query.trim();
		const normalizedQuery = query.toLowerCase();
		const memos = this.getMatchedMemos(normalizedQuery);
		const visibleMemos = memos.slice(0, this.visibleCount);
		const revisions = visibleMemos.map(memo => JSON.stringify([getMemoRenderRevision(memo), memo.catalog?.observationHandle]));
		const status = this.queryError ?? this.options.getThingsStatus?.() ?? null;
		// 总数晚到时仅沿用已开始渲染的卡片列表；空搜索提示不能新增加载入口。
		if (metadataOnly && sameView && !status && this.renderedStatus === status && revisions.length > 0
			&& this.renderedRevisions.length > 0
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
		this.renderedViewKey = viewKey;
		this.syncDateButtons();
		if (
			!this.options.getThingsContext?.()
			&& normalizedQuery.length === 0
			&& this.dateFilter === null
			&& this.recordStatsFilter === null
		) {
			resultsEl.createDiv({ cls: "knomo-mobile-search-empty", text: t("search.emptyPrompt") });
			completeRender();
			return;
		}
		if (status) renderKnomoListSummary(resultsEl, status);
		if (memos.length === 0 && status) { completeRender(); return; }
		const context = this.options.getThingsContext?.();
		const regularState = context === undefined ? null : {
			...context,
			searchQuery: query,
			searchDateFilter: this.dateFilter,
			recordStatsSearchFilter: null,
			scopeFilter: "all" as const,
		};
		if (memos.length === 0) {
			resultsEl.createDiv({
				cls: "knomo-mobile-search-empty",
				text: regularState === null
					? formatMobileSearchEmptyTitle(query, this.dateFilter, this.recordStatsFilter)
					: getRegularFilterCopy(regularState, 0)?.emptyTitle,
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
		const total = this.options.getMatchedTotalCount === undefined ? matchedCount : this.options.getMatchedTotalCount();
		if (updateSummary && total !== null) {
			const query = this.query.trim();
			const context = this.options.getThingsContext?.();
			const summary = context === undefined
				? formatMobileSearchSummary(query, this.dateFilter, total, this.recordStatsFilter)
				: getRegularFilterCopy({ ...context, searchQuery: query, searchDateFilter: this.dateFilter,
					recordStatsSearchFilter: null, scopeFilter: "all" }, total)?.summary;
			if (summary != null) {
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
		return getMobileSearchStateKey({
			open: this.open,
			...this.options.getThingsContext?.(),
			query: this.query,
			dateFilter: this.dateFilter,
			recordStatsFilter: this.recordStatsFilter,
			visibleMemos: this.getVisibleMemos(),
		});
	}

	getViewStateKey(): string {
		return getMobileSearchViewStateKey({
			...this.options.getThingsContext?.(),
			query: this.query,
			dateFilter: this.dateFilter,
			recordStatsFilter: this.recordStatsFilter,
		});
	}

	getChangeIntent(previousViewStateKey: string): CardFlowChangeIntent {
		return getMobileSearchChangeIntent(previousViewStateKey, {
			...this.options.getThingsContext?.(),
			query: this.query,
			dateFilter: this.dateFilter,
			recordStatsFilter: this.recordStatsFilter,
		});
	}

	getIdsKey(): string {
		return getMobileSearchIdsKey(this.open, this.getVisibleMemos());
	}

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

	private getMatchedMemos(normalizedQuery: string): MemoRecord[] {
		return this.options.getMemos().filter((memo) => {
			return this.options.memoMatchesSearch(
				memo,
				normalizedQuery,
				this.dateFilter,
				this.recordStatsFilter,
			);
		});
	}

	private getVisibleMemos(): MemoRecord[] {
		return this.getMatchedMemos(this.query.trim().toLowerCase()).slice(0, this.visibleCount);
	}
}

import type { MemoViewItem as MemoRecord } from "../types/memoView";
import { t } from "../i18n";
import {
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
}

interface MobileSearchControllerOptions {
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
	renderMemoCard: (container: HTMLElement, memo: MemoRecord, generation: number, index: number) => void;
	clearMarkdown: (surface?: MobileSearchSurface) => void;
	clearImages: (surface: MobileSearchSurface) => void;
	setCardFlowPaused: (paused: boolean) => void;
	closeSurroundingChrome: () => void;
	closeCardMenu: () => void;
	syncRootState: () => void;
	getCardFlowScrollTop: () => number | null;
	restoreCardFlowScrollTop: (scrollTop: number | null) => void;
	restoreElementScrollTop: (element: HTMLElement | null, scrollTop: number | null) => void;
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
}

export class MobileSearchController {
	private pageEl: HTMLElement | null = null;
	private inputEl: HTMLInputElement | null = null;
	private resultsEl: HTMLElement | null = null;
	private query = "";
	private dateFilter: SearchDateFilter | null = null;
	private recordStatsFilter: RecordStatsSearchFilter | null = null;
	private visibleCount: number;
	private open = false;
	private renderGeneration = 0;
	private debounceTimeoutId: number | null = null;

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
		this.renderResults(options.changeIntent ?? "content-change");
		this.options.syncRootState();
		if (options.focusInput !== false) {
			this.focusInputNow();
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
		this.options.registerDomEvent(this.inputEl, "input", () => {
			this.queueQuery(this.inputEl?.value ?? "");
		});
		this.options.registerDomEvent(this.inputEl, "keydown", (event) => {
			if (event.key === "Escape") {
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
	}

	syncPage(): void {
		const shouldOpen = this.options.isMobileLayout() && this.open;
		this.options.getDocument().body.toggleClass("knomo-mobile-search-active", shouldOpen);
		if (!this.options.isMobileLayout()) {
			this.open = false;
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
		const scrollTop = this.options.getCardFlowScrollTop();
		this.open = false;
		this.options.closeCardMenu();
		this.resetState();
		this.options.setCardFlowPaused(false);
		this.options.syncRootState();
		this.options.restoreCardFlowScrollTop(scrollTop);
		void this.options.restoreRemoteResults?.();
	}

	removePage(): void {
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
		this.clearDebounce();
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

	resetState(): void {
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
		this.renderResults();
	}

	private async refreshRemoteResults(reset: boolean, changeIntent: CardFlowChangeIntent = "content-change"): Promise<void> {
		if (this.options.loadRemoteResults === undefined) {
			this.renderResults(changeIntent);
			return;
		}
		try {
			await this.options.loadRemoteResults(this.query, this.dateFilter, this.recordStatsFilter, reset);
		} finally {
			this.renderResults(changeIntent);
		}
	}

	renderResults(changeIntent: CardFlowChangeIntent = "content-change"): void {
		const resultsEl = this.resultsEl;
		if (resultsEl === null || !this.open) {
			return;
		}
		const scrollTop = changeIntent === "view-scope-change" ? 0 : resultsEl.scrollTop;
		const generation = this.renderGeneration + 1;
		this.renderGeneration = generation;
		this.options.clearMarkdown("mobile-search");
		this.options.clearImages("mobile-search");
		resultsEl.empty();
		this.syncDateButtons();
		const query = this.query.trim();
		const normalizedQuery = query.toLowerCase();
		if (
			normalizedQuery.length === 0
			&& this.dateFilter === null
			&& this.recordStatsFilter === null
		) {
			resultsEl.createDiv({ cls: "knomo-mobile-search-empty", text: t("search.emptyPrompt") });
			this.options.restoreElementScrollTop(resultsEl, scrollTop);
			return;
		}
		const memos = this.getMatchedMemos(normalizedQuery);
		if (memos.length === 0) {
			resultsEl.createDiv({
				cls: "knomo-mobile-search-empty",
				text: formatMobileSearchEmptyTitle(query, this.dateFilter, this.recordStatsFilter),
			});
			this.options.restoreElementScrollTop(resultsEl, scrollTop);
			return;
		}
		const matchedTotalCount = this.options.getMatchedTotalCount === undefined
			? memos.length
			: this.options.getMatchedTotalCount();
		if (matchedTotalCount !== null) {
			const summary = formatMobileSearchSummary(query, this.dateFilter, matchedTotalCount, this.recordStatsFilter);
			if (summary !== null) {
				renderKnomoListSummary(resultsEl, summary);
			}
		}
		const visibleMemos = memos.slice(0, this.visibleCount);
		for (const [index, memo] of visibleMemos.entries()) {
			this.options.renderMemoCard(resultsEl, memo, generation, index);
		}
		if (visibleMemos.length < memos.length || this.options.hasRemoteNextPage?.() === true) {
			renderKnomoLoadMoreButton(resultsEl, {
				remainingCount: Math.max(1, (matchedTotalCount ?? memos.length) - visibleMemos.length),
				action: "load-more-mobile-search",
				extraClass: "knomo-mobile-search-more",
			});
		}
		this.options.restoreElementScrollTop(resultsEl, scrollTop);
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
			query: this.query,
			dateFilter: this.dateFilter,
			recordStatsFilter: this.recordStatsFilter,
			visibleMemos: this.getVisibleMemos(),
		});
	}

	getViewStateKey(): string {
		return getMobileSearchViewStateKey({
			query: this.query,
			dateFilter: this.dateFilter,
			recordStatsFilter: this.recordStatsFilter,
		});
	}

	getChangeIntent(previousViewStateKey: string): CardFlowChangeIntent {
		return getMobileSearchChangeIntent(previousViewStateKey, {
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

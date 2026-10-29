import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import type { CatalogFeatureCursor, CatalogFeatureQuery, CatalogMemoItem, CatalogMemoPage } from "../src/types/catalogView";
import type { MemoViewItem } from "../src/types/memoView";
import { createCatalogCapabilities } from "../src/services/MemoCapabilityModel";
import { KnomoCardFlowCoordinator } from "../src/ui/KnomoCardFlowCoordinator";
import { KnomoViewStateController } from "../src/ui/KnomoViewStateController";
import { getMemoListStateKey } from "../src/ui/MemoRenderRevision";
import { createBeyondTodayContext } from "../src/ui/BeyondTodayPresentation";
import { ensureObsidianStub } from "./helpers/obsidianStub";

const COVERAGE = { kind: "complete" as const, configurationComplete: true, coveredFromDate: null, pendingFileCount: 0, coveredFileCount: 1, totalFileCount: 1 };
const CURSOR: CatalogFeatureCursor = { catalog: { catalogRevision: 1, createdAtKey: "2026-01-21T12:34", observationKey: "next" } };

test("今日之外独立于近三天开关，首条历史记录即有标题，其他视图保持原规则", async context => {
	context.mock.timers.enable({ apis: ["Date"], now: new Date(2026, 6, 21, 12).getTime() });
	const h = await createHarness();
	try {
		h.setQuery(async () => page([item("2026-04-21", "history")]));
		assert.equal(await h.view.reloadMemos(true), true);
		assert.deepEqual(h.headings(), ["2026 · Second Quarter"]);
		for (const enabled of [false, true, false]) {
			h.settings.recentTimeFlowEnabled = enabled;
			h.view.renderCardFlow();
			assert.deepEqual(h.headings(), ["2026 · Second Quarter"]);
			assert.equal(h.view.getRecentTimeFlowContext().enabled, false);
		}
		h.state.activeNav = "all";
		h.view.renderCardFlow();
		h.flushFrames();
		assert.deepEqual(h.headings(), []);
		assert.equal(h.view.getRecentTimeFlowContext().enabled, false);
		h.settings.recentTimeFlowEnabled = true;
		assert.equal(h.view.getRecentTimeFlowContext().enabled, true);
		h.state.activeNav = "things";
		h.view.renderCardFlow(); h.flushFrames();
		assert.deepEqual(h.headings(), []);
	} finally { h.close(); }
});

test("同组跨查询页和渲染批次无重复，删除首条迁移标题、末条移除标题并复用卡片", async context => {
	context.mock.timers.enable({ apis: ["Date"], now: new Date(2026, 9, 21, 12).getTime() });
	const h = await createHarness();
	try {
		const recent = item("2026-09-21", "recent");
		const first = item("2026-08-21", "first"), second = item("2026-07-21", "second");
		const older = item("2026-04-21", "older"), last = item("2025-12-21", "last");
		h.view.getInitialCardBatchSize = () => 2;
		h.setQuery(async request => request.cursor ? page([second, older, last]) : page([recent, first], CURSOR));
		await h.view.reloadMemos(true);
		const recentCard = h.card("recent"), firstCard = h.card("first");
		assert.deepEqual(h.order(), ["recent", "2026 · Second Half", "first"]);
		assert.equal(await h.view.loadNextCatalogPage(), true);
		h.flushFrames();
		assert.deepEqual(h.headings(), ["2026 · Second Half", "2026 · First Half", "2025 · Second Half"]);
		assert.equal(h.card("recent"), recentCard);
		assert.equal(h.card("first"), firstCard);
		assert.equal(h.requests.length, 2, "标题不引起额外查询");
		const secondCard = h.card("second");
		h.view.memos = h.view.memos.filter((memo: MemoViewItem) => memo.id !== "first");
		h.view.renderCardFlow();
		assert.equal(h.card("second"), secondCard);
		assert.equal(secondCard?.previousElementSibling?.textContent, "2026 · Second Half");
		h.view.memos = h.view.memos.filter((memo: MemoViewItem) => memo.id !== "second");
		h.view.renderCardFlow();
		assert.deepEqual(h.headings(), ["2026 · First Half", "2025 · Second Half"]);
		h.view.memos = h.view.memos.filter((memo: MemoViewItem) => memo.id === "recent");
		h.view.renderCardFlow();
		assert.deepEqual(h.headings(), []);
		assert.equal(h.card("recent"), recentCard);
	} finally { h.close(); }
});

test("标题与卡片为直接同级节点，具有一致标题层级且不增加键盘停靠点", async context => {
	context.mock.timers.enable({ apis: ["Date"], now: new Date(2027, 0, 21).getTime() });
	const h = await createHarness();
	try {
		h.setQuery(async () => page([item("2026-12-21", "unheaded"), item("2026-11-21", "second"), item("2026-06-21", "first")]));
		await h.view.reloadMemos(true);
		assert.deepEqual(h.order(), ["unheaded", "2026 · Second Half", "second", "2026 · First Half", "first"]);
		for (const heading of h.root.querySelectorAll<HTMLElement>("[role='heading']")) {
			assert.equal(heading.parentElement, h.root);
			assert.equal(heading.getAttribute("aria-level"), "2");
			assert.equal(heading.tabIndex, -1);
			assert.equal(heading.hasAttribute("data-memo-id"), false);
			assert.ok(heading.classList.contains("knomo-recent-flow-history"));
			assert.ok(heading.nextElementSibling?.classList.contains("knomo-card"));
		}
		for (const card of h.root.querySelectorAll(".knomo-card")) assert.equal(card.parentElement, h.root);
		assert.ok(h.root.firstElementChild?.classList.contains("knomo-list-summary"), "总量摘要仍在内容之前");
	} finally { h.close(); }
});

for (const mobile of [false, true]) {
	for (const [oldMonth, newYear, newMonth, historicalDate, oldHeading, newHeading] of [
		[7, 2026, 8, "2026-05-31", "2026 · Second Quarter", "2026 · First Half"],
		[8, 2026, 9, "2026-07-31", null, "2026 · Second Half"],
		[12, 2027, 1, "2026-07-31", "2026 · Second Half", "2026 · Second Half"],
	] as const) {
		test(`${mobile ? "移动" : "桌面"} ${oldMonth}→${newMonth} 月查询延迟失败保留旧标题，新结果同步切换并拒绝旧页和旧批次`, async context => {
			context.mock.timers.enable({ apis: ["Date"], now: new Date(2026, oldMonth - 1, 31, 23, 59).getTime() });
			const h = await createHarness(mobile);
			try {
				const oldItems = Array.from({ length: 30 }, (_, index) => item(historicalDate, `old-${index}`));
				h.setQuery(async () => page(oldItems, CURSOR));
				assert.equal(await h.view.reloadMemos(true, true), true);
				assert.deepEqual(h.headings(), oldHeading ? [oldHeading] : []);
				const oldFrames = [...h.frames.values()];
				assert.ok(oldFrames.length > 0, "真实分片渲染必须留下 continuation");
				const previousPage = deferred<CatalogMemoPage>();
				h.setQuery(() => previousPage.promise);
				const paging = h.view.loadNextCatalogPage();
				context.mock.timers.setTime(new Date(newYear, newMonth - 1, 1, 0, 1).getTime());
				const delayed = deferred<CatalogMemoPage>();
				h.setQuery(() => delayed.promise);
				let refreshing!: Promise<boolean>;
				h.view.reloadCurrentCatalogQuery = () => (refreshing = h.view.reloadMemos(true));
				h.view.handleLocalDateChange();
				assert.deepEqual(h.headings(), oldHeading ? [oldHeading] : []);
				const retainedDate = h.view.beyondTodayContext.today;
				assert.equal(h.view.memos[0].id, "old-0");
				delayed.reject(new Error("temporary read failure"));
				assert.equal(await refreshing, false);
				assert.equal(h.view.beyondTodayContext.today, retainedDate);
				assert.deepEqual(h.headings(), oldHeading ? [oldHeading] : []);
				assert.equal(h.failures.length, 1, "失败沿用页面反馈");
				const newDate = `${historicalDate.slice(0, 8)}01`;
				h.setQuery(async () => page([item(newDate, "new")]));
				assert.equal(await h.view.reloadMemos(true), true);
				h.flushFrames();
				assert.equal(h.view.beyondTodayContext.today, `${newYear}-${String(newMonth).padStart(2, "0")}-01`);
				assert.deepEqual(h.headings(), [newHeading]);
				assert.deepEqual(h.cardIds(), ["new"]);
				previousPage.resolve(page([item("2020-01-31", "obsolete")]));
				assert.equal(await paging, false);
				for (const frame of oldFrames) frame(0);
				h.flushFrames();
				assert.deepEqual(h.cardIds(), ["new"]);
				assert.deepEqual(h.headings(), [newHeading]);
				assert.equal(h.requests.length, 4);
				assert.equal(h.requests[0].dayOfMonth, "31");
				assert.equal(h.requests[1].dayOfMonth, "31");
				assert.equal(h.requests[2].dayOfMonth, "01");
				assert.equal(h.requests[3].dayOfMonth, "01");
			} finally { h.close(); }
		});
	}
}

test("移动首屏使用查询日期提交分组，跨日迟到结果不提交，未完成覆盖不产生空历史组", async context => {
	context.mock.timers.enable({ apis: ["Date"], now: new Date(2024, 1, 29, 23, 59).getTime() });
	const h = await createHarness(true);
	try {
		h.setQuery(async () => page([item("2020-02-29", "leap")]));
		await h.view.loadInitialMobileMemos();
		assert.deepEqual(h.headings(), ["2020 · First Half"]);
		assert.equal(h.requests[0].monthDay, "02-29");
		assert.equal(h.requests[0].dayOfMonth, undefined);
		const pending = deferred<CatalogMemoPage>();
		h.setQuery(() => pending.promise);
		const loading = h.view.loadInitialMobileMemos();
		context.mock.timers.setTime(new Date(2024, 2, 1, 0, 1).getTime());
		pending.resolve(page([item("2016-02-29", "stale")]));
		await loading;
		assert.deepEqual(h.cardIds(), ["leap"]);
		assert.equal(h.view.beyondTodayContext.today, "2024-02-29");
		h.view.hasCommittedCatalogDesktopQuery = false;
		h.view.memos = [];
		h.view.beyondTodayContext = null;
		h.setQuery(async () => ({ ...page([]), coverage: { ...COVERAGE, kind: "partial", pendingFileCount: 1 }, readState: "history_building" }));
		await h.view.loadInitialMobileMemos();
		assert.deepEqual(h.headings(), []);
		assert.equal(h.view.hasCommittedCatalogDesktopQuery, false);
		assert.equal(h.view.getCurrentCardFlowPresentation().loading, true);
	} finally { h.close(); }
});

test("单次查询重试与确认展示合并沿用同一日期快照，不在异步完成时重读日期", async context => {
	context.mock.timers.enable({ apis: ["Date"], now: new Date(2026, 6, 31, 23, 59).getTime() });
	const h = await createHarness();
	try {
		const snapshot = new Date();
		const merged: CatalogFeatureQuery[] = [];
		h.view.confirmedDailyMemos = { pending: false, merge: (memos: MemoViewItem[], filter: CatalogFeatureQuery) => { merged.push(filter); return memos; } };
		h.setQuery(async () => {
			context.mock.timers.setTime(new Date(2026, 7, 1, 0, 1).getTime());
			return { ...page([item("2026-04-30", "quarter")]), invalidated: h.requests.length === 1 };
		});
		await h.view.loadCatalogMemos(true, undefined, snapshot);
		assert.equal(h.requests.length, 2);
		assert.deepEqual(h.requests.map(request => request.dayOfMonth), ["31", "31"]);
		assert.equal(merged[0].dayOfMonth, "31");
		assert.equal(h.view.beyondTodayContext, null, "只加载不提前修改展示上下文");
	} finally { h.close(); }
});

test("28 至 31 日和闰日保留既有同日匹配与排除今天未来的查询边界", async () => {
	const h = await createHarness();
	try {
		for (const day of [28, 29, 30, 31]) {
			const query = h.view.buildCatalogActiveQuery(true, new Date(2026, 0, day));
			assert.equal(query.dayOfMonth, String(day));
			assert.equal(query.toDate, `2026-01-${day - 1}`);
			assert.equal(query.monthDay, undefined);
		}
		const leap = h.view.buildCatalogActiveQuery(true, new Date(2024, 1, 29));
		assert.equal(leap.monthDay, "02-29");
		assert.equal(leap.toDate, "2024-02-28");
		assert.equal(leap.dayOfMonth, undefined);
		assert.equal(h.view.buildCatalogActiveQuery(true, new Date(2026, 0, 1)).toDate, "2025-12-31");
	} finally { h.close(); }
});

function item(date: string, id: string): CatalogMemoItem {
	return { key: id, renderKey: id, createdAt: `${date}T12:34`, content: id, tags: [], links: [], images: [], timeBuoyDates: [],
		sourcePath: `Daily/${date}.md`, lineNumberHint: 1, observation: { logicalDate: date, time: "12:34", section: null, contentHash: id },
		observationHandle: { sourcePath: `Daily/${date}.md`, sourceRevision: `revision-${id}`, startLine: 0, endLine: 0, rawBlockHash: id },
	} as unknown as CatalogMemoItem;
}

function page(items: CatalogMemoItem[], nextCursor: CatalogFeatureCursor | null = null): CatalogMemoPage {
	return { items, nextCursor, catalogRevision: 1, coverage: COVERAGE, readState: "ready", invalidated: false,
		status: { content: "ready", catalog: "complete", projection: "ready" }, degraded: false,
		lifecycle: { state: "ready", persistent: true, writable: true, reason: null }, capabilities: createCatalogCapabilities(COVERAGE) };
}

function deferred<T>() {
	let resolve!: (value: T) => void, reject!: (error: Error) => void;
	const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
	return { promise, resolve, reject };
}

// 保留真实查询、展示提交、卡片协调与批次路径，只隔离宿主和 Markdown 渲染。
async function createHarness(mobile = false) {
	await ensureObsidianStub();
	const [{ KnomoView }, { Platform }] = await Promise.all([import("../src/ui/KnomoView"), import("obsidian")]);
	const previousMobile = Platform.isMobile;
	Platform.isMobile = mobile;
	const dom = new JSDOM("<!doctype html><body></body>");
	const win = dom.window;
	const previousHTMLElement = globalThis.HTMLElement;
	globalThis.HTMLElement = win.HTMLElement as unknown as typeof HTMLElement;
	Object.assign(win.HTMLElement.prototype, {
		createEl(this: HTMLElement, tag: string, options: { cls?: string; text?: string; attr?: Record<string, string> } = {}) {
			const element = this.ownerDocument.createElement(tag);
			if (options.cls) element.className = options.cls;
			if (options.text) element.textContent = options.text;
			for (const [key, value] of Object.entries(options.attr ?? {})) element.setAttribute(key, value);
			return this.appendChild(element);
		},
		createDiv(this: HTMLElement, options?: DomElementInfo) { return this.createEl("div", options); },
		createSpan(this: HTMLElement, options?: DomElementInfo) { return this.createEl("span", options); },
		getAttr(this: HTMLElement, key: string) { return this.getAttribute(key); },
		setAttr(this: HTMLElement, key: string, value: string) { this.setAttribute(key, value); },
		hasClass(this: HTMLElement, cls: string) { return this.classList.contains(cls); },
		findAll(this: HTMLElement, selector: string) { return [...this.querySelectorAll(selector)]; },
		empty(this: HTMLElement) { this.replaceChildren(); },
	});
	Object.assign(win.Node.prototype, { instanceOf(this: Node, constructor: typeof Node) { return this instanceof constructor; } });
	const frames = new Map<number, FrameRequestCallback>();
	let frameId = 0;
	win.requestAnimationFrame = callback => { frames.set(++frameId, callback); return frameId; };
	win.cancelAnimationFrame = id => { frames.delete(id); };
	const root = win.document.body.createDiv({ cls: "knomo-card-flow" });
	const coordinator = new KnomoCardFlowCoordinator({ sentinel: { isObserving: false, render: () => {}, remove: () => {} } });
	const state = new KnomoViewStateController();
	state.activeNav = "review";
	const settings = { recentTimeFlowEnabled: true, timeBuoyEnabled: false, timeBuoyIntroDismissed: true };
	const requests: CatalogFeatureQuery[] = [], failures: unknown[] = [];
	let query = async (_request: CatalogFeatureQuery): Promise<CatalogMemoPage> => page([]);
	const view = Object.create(KnomoView.prototype);
	const renderCard = (container: HTMLElement, memo: MemoViewItem) => container.createEl("article", { cls: "knomo-card", text: memo.id,
		attr: { "data-memo-id": memo.id, "data-memo-render-key": memo.id, "data-time-presentation": JSON.stringify({ mode: "full" }) } });
	Object.assign(view, {
		viewStateController: state, settingsService: { getSettings: () => settings },
		containerEl: { win, doc: win.document }, cardFlowEl: root, cardFlowCoordinator: coordinator,
		memos: [], renderedCardMemos: new Map(), beyondTodayContext: null, recentLifecycleKey: "",
		catalogDesktopQueryRun: 0, catalogDesktopCountRun: 0, memoSourceGeneration: 0, catalogRevision: 1,
		catalogCoverage: COVERAGE, catalogStatus: page([]).status, catalogDesktopQueryFingerprint: null,
		catalogCursor: null, catalogDesktopTotalCount: null, hasCommittedCatalogDesktopQuery: false,
		catalogLoadingNextPage: false, cardFlowError: null, hasConfirmedMemoPresentation: false,
		composerOpen: false, trashViewClosed: false, initialCatalogQueryPending: false,
		lastKnownLocalDate: createBeyondTodayContext(new Date()).today,
		mobileSearchController: { isOpen: false },
		getTodayTimeBuoyItems: () => [], getFilteredMemos: () => view.memos,
		randomReunionController: { getSnapshot: () => ({ status: "idle", error: null }) },
		shuffleDayController: { getSnapshot: () => ({ status: "idle", error: null }) },
		trashMemoController: { getSnapshot: () => ({ trashLoading: false, trashError: null, trashMemos: [] }) },
		recordStatsViewStateController: { clearRendered: () => {} },
		getDailyNotesStatus: () => ({ enabled: true }),
		queryCatalogFeature: (request: CatalogFeatureQuery) => { requests.push(request); return query(request); },
		syncRecordStatsSource: () => {}, refreshCatalogLibraryIndexes: async () => {}, shouldCountCatalogQuery: () => false,
		getCardFlowStateKey: () => getMemoListStateKey(view.memos) + view.getRecentPresentationStateKey(),
		getMobileSearchStateKey: () => "", renderMobileSearchResultsIfChanged: () => {}, renderMobileSearchResults: () => {},
		renderUiState: (options?: { renderCardFlow?: boolean }) => { if (options?.renderCardFlow !== false) view.renderCardFlow(); },
		renderAllMemosLoadingState: () => {}, retainMemoCardPreviews: () => {},
		syncPageFeedback: () => {}, reportViewRefreshFailure: (error: unknown) => failures.push(error),
		memoMarkdownRenderer: { clear: () => {}, refreshSearchHits: () => {} },
		cardImageCache: { capture: () => {} }, cardImageLoadQueue: { clear: () => {}, forget: () => {} },
		renderMemoCardInContainer: renderCard, renderTimeBuoyIntro: () => null,
		resetTimeBuoyCardFlow: () => {}, renderHistoryLoadMore: () => {}, syncCardMenuState: () => {},
		clearLoadingIndicators: () => {}, revealLoadingAfterDelay: () => false,
		startDateChangeWatcher: () => {}, stopDateChangeWatcher: () => {},
	});
	return { view, state, settings, root, requests, failures, frames,
		setQuery: (value: typeof query) => { query = value; },
		headings: () => [...root.querySelectorAll(".knomo-beyond-today-group")].map(heading => heading.textContent),
		card: (id: string) => root.querySelector<HTMLElement>(`[data-memo-id='${id}']`),
		cardIds: () => [...root.querySelectorAll(".knomo-card")].map(card => card.getAttribute("data-memo-id")),
		order: () => [...root.children].filter(child => child.classList.contains("knomo-card") || child.classList.contains("knomo-beyond-today-group")).map(child => child.textContent),
		flushFrames: () => { let iterations = 0; while (frames.size > 0) {
			assert.ok(iterations++ < 100, "批次必须有界结束");
			const callbacks = [...frames.values()]; frames.clear();
			for (const callback of callbacks) callback(0);
		} },
		close: () => { view.cancelCatalogDesktopQuery(); frames.clear(); Platform.isMobile = previousMobile; globalThis.HTMLElement = previousHTMLElement; dom.window.close(); },
	};
}

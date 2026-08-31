import assert from "node:assert/strict";
import test from "node:test";

import type { MemoViewItem } from "../src/types/memoView";
import { ensureObsidianStub } from "./helpers/obsidianStub";

test("CAT-QUERY-002：桌面 Catalog 查询只提交最后发起的请求", async () => {
	await ensureObsidianStub();
	const { KnomoView } = await import("../src/ui/KnomoView");
	const first = createDeferred<QueryMemo[]>();
	const second = createDeferred<QueryMemo[]>();
	const loads = [first, second];
	const view = Object.create(KnomoView.prototype) as QueryView;
	view.memoSourceGeneration = 0;
	view.catalogDesktopQueryRun = 0;
	view.catalogDesktopQueryFingerprint = null;
	view.hasCommittedCatalogDesktopQuery = false;
	view.catalogCursor = { catalog: { catalogRevision: 1, createdAtKey: "old", observationKey: "old" } };
	view.memos = [];
	view.viewStateController = { activeNav: "all" };
	view.getCatalogQueryFingerprint = () => "all";
	view.loadCatalogMemos = async () => {
		const load = loads.shift();
		assert.notEqual(load, undefined);
		return {
			memos: await (load?.promise ?? []),
			nextCursor: null,
			catalogRevision: 1,
			identityRevision: "identity-1",
			coverage: { kind: "complete", coveredFromDate: "2026-08-01", pendingFileCount: 0, coveredFileCount: 1, totalFileCount: 1 },
			readState: "ready",
			status: { content: "ready", catalog: "complete", identity: "ready", projection: "ready", migration: "none" },
		};
	};
	view.getCardFlowStateKey = () => "card-flow";
	view.getMobileSearchStateKey = () => "mobile-search";
	view.invalidateRecordStats = () => undefined;
	view.invalidateMemoSearchCache = () => undefined;
	view.retainMemoCardPreviews = () => undefined;
	view.resetVisibleMemos = () => undefined;
	view.renderUiState = () => undefined;
	view.forceRebuildCardFlow = () => undefined;
	view.renderMobileSearchResults = () => undefined;
	view.renderCardFlowIfChanged = () => undefined;
	view.renderMobileSearchResultsIfChanged = () => undefined;
	let loadingRenderCount = 0;
	view.renderAllMemosLoadingState = () => { loadingRenderCount += 1; };
	view.randomReunionController = {
		getSnapshot: () => ({ status: "idle", error: null, memos: null }),
		clearMemos: () => undefined,
		refresh: async () => undefined,
	};
	view.shuffleDayController = { reloadSelectedDate: async () => true };
	view.refreshCatalogLibraryIndexes = async () => undefined;
	view.syncRecordStatsSource = () => undefined;

	const firstRun = view.reloadMemos(false, true);
	const secondRun = view.reloadMemos(false, true);
	second.resolve([makeMemo("new", "2026-08-24T10:00:00")]);
	assert.equal(await secondRun, true);
	first.resolve([makeMemo("old", "2026-08-23T10:00:00")]);
	assert.equal(await firstRun, false);
	assert.deepEqual(view.memos.map((memo) => memo.id), ["new"]);
	assert.equal(loadingRenderCount, 1);
});

test("首次 Catalog 仍在构建时不把已知子集提交为完整历史", async () => {
	await ensureObsidianStub();
	const { KnomoView } = await import("../src/ui/KnomoView");
	const view = Object.create(KnomoView.prototype) as QueryView;
	view.memoSourceGeneration = 0;
	view.catalogDesktopQueryRun = 0;
	view.catalogDesktopQueryFingerprint = null;
	view.hasCommittedCatalogDesktopQuery = false;
	view.catalogCursor = null;
	view.memos = [];
	view.viewStateController = { activeNav: "all" };
	view.getCatalogQueryFingerprint = () => "all";
	let complete = false;
	view.loadCatalogMemos = async () => complete
		? {
			...makeCatalogLoad(2, "identity-2", completeCoverage()),
			memos: [makeMemo("complete", "2026-08-24T10:00:00")],
		}
		: {
			memos: [makeMemo("known-subset", "2026-08-24T10:00:00")],
			nextCursor: null,
			catalogRevision: 1,
			identityRevision: "identity-1",
			coverage: {
				kind: "partial",
				coveredFromDate: "2026-08-20",
				pendingFileCount: 2,
				coveredFileCount: 1,
				totalFileCount: 3,
			},
			readState: "history_building",
			status: {
				content: "scanning",
				catalog: "partial",
				identity: "ready",
				projection: "ready",
				migration: "none",
			},
		};
	view.getCardFlowStateKey = () => "card-flow";
	view.getMobileSearchStateKey = () => "mobile-search";
	view.invalidateRecordStats = () => undefined;
	view.invalidateMemoSearchCache = () => undefined;
	view.retainMemoCardPreviews = () => undefined;
	view.resetVisibleMemos = () => undefined;
	view.renderUiState = () => undefined;
	view.forceRebuildCardFlow = () => undefined;
	view.renderMobileSearchResults = () => undefined;
	view.renderCardFlowIfChanged = () => undefined;
	view.renderMobileSearchResultsIfChanged = () => undefined;
	let loadingRenderCount = 0;
	view.renderAllMemosLoadingState = () => { loadingRenderCount += 1; };
	view.randomReunionController = {
		getSnapshot: () => ({ status: "idle", error: null, memos: null }),
		clearMemos: () => undefined,
		refresh: async () => undefined,
	};
	view.shuffleDayController = { reloadSelectedDate: async () => true };
	view.refreshCatalogLibraryIndexes = async () => undefined;
	view.syncRecordStatsSource = () => undefined;

	assert.equal(await view.reloadMemos(false), true);
	assert.deepEqual(view.memos, []);
	assert.equal(view.hasCommittedCatalogDesktopQuery, false);
	assert.equal(view.catalogReadState, "history_building");
	assert.equal(loadingRenderCount, 1);

	complete = true;
	assert.equal(await view.reloadMemos(false), true);
	assert.deepEqual((view.memos as QueryMemo[]).map((memo) => memo.id), ["complete"]);
	assert.equal(view.hasCommittedCatalogDesktopQuery, true);
});

test("Identity adoption 触发 Catalog 刷新时保留当前随机重逢批次", async () => {
	await ensureObsidianStub();
	const { KnomoView } = await import("../src/ui/KnomoView");
	const view = Object.create(KnomoView.prototype) as QueryView;
	let clearCount = 0;
	let refreshCount = 0;
	const randomMemo = makeMemo("random-ready", "2026-08-20T10:00:00");
	view.memoSourceGeneration = 0;
	view.catalogDesktopQueryRun = 0;
	view.catalogDesktopQueryFingerprint = null;
	view.catalogCursor = null;
	view.memos = [];
	view.viewStateController = { activeNav: "random" };
	view.getCatalogQueryFingerprint = () => "random";
	view.loadCatalogMemos = async () => makeCatalogLoad(2, "identity-2", completeCoverage());
	view.getCardFlowStateKey = () => "random-ready";
	view.getMobileSearchStateKey = () => "mobile-search";
	view.invalidateMemoSearchCache = () => undefined;
	view.retainMemoCardPreviews = () => undefined;
	view.resetVisibleMemos = () => undefined;
	view.renderUiState = () => undefined;
	view.forceRebuildCardFlow = () => undefined;
	view.renderMobileSearchResults = () => undefined;
	view.renderCardFlowIfChanged = () => undefined;
	view.renderMobileSearchResultsIfChanged = () => undefined;
	view.renderAllMemosLoadingState = () => undefined;
	view.randomReunionController = {
		getSnapshot: () => ({ status: "ready", error: null, memos: [randomMemo] }),
		clearMemos: () => { clearCount += 1; },
		refresh: async () => { refreshCount += 1; },
	};
	view.shuffleDayController = { reloadSelectedDate: async () => true };
	view.refreshCatalogLibraryIndexes = async () => undefined;
	view.syncRecordStatsSource = () => undefined;

	assert.equal(await view.reloadMemos(false, true), true);
	assert.equal(clearCount, 0);
	assert.equal(refreshCount, 0);
});

test("返回随机重逢或漫游往日时复用已提交结果", async () => {
	await ensureObsidianStub();
	const [{ KnomoView }, { KnomoViewStateController }] = await Promise.all([
		import("../src/ui/KnomoView"),
		import("../src/ui/KnomoViewStateController"),
	]);
	const view = Object.create(KnomoView.prototype) as NavigationView;
	let randomRefreshCount = 0;
	let randomClearCount = 0;
	let shuffleRefreshCount = 0;
	let shuffleClearCount = 0;
	view.viewStateController = new KnomoViewStateController();
	view.clearSearchDebounce = () => undefined;
	view.getCardFlowViewStateKey = () => "view";
	view.getCardFlowChangeIntent = () => "view-scope-change";
	view.applyViewStateTransitionEffects = () => undefined;
	view.renderUiState = () => undefined;
	view.shouldDeferCardFlowForAllMemos = () => false;
	view.reloadCurrentCatalogQuery = async () => true;
	view.randomReunionController = {
		getSnapshot: () => ({ status: "ready", error: null, memos: [makeMemo("random", "2026-08-20T10:00:00")] }),
		clearMemos: () => { randomClearCount += 1; },
		refresh: async () => { randomRefreshCount += 1; },
	};
	view.shuffleDayController = {
		getSnapshot: () => ({ status: "ready" }),
		clearSelection: () => { shuffleClearCount += 1; },
		refresh: async () => { shuffleRefreshCount += 1; },
	};
	view.trashMemoController = { loadTrashMemos: async () => undefined };
	view.timeBuoyViewController = { loadInitial: async () => undefined };
	view.prepareRecordStats = async () => true;

	view.setSidebarNav("random");
	view.setSidebarNav("all");
	view.setSidebarNav("random");
	view.setSidebarNav("shuffleDay");
	view.setSidebarNav("all");
	view.setSidebarNav("shuffleDay");

	assert.equal(randomRefreshCount, 0);
	assert.equal(randomClearCount, 0);
	assert.equal(shuffleRefreshCount, 0);
	assert.equal(shuffleClearCount, 0);
});

test("普通 Catalog 请求在返回漫游往日后完成时不重算日期快照", async () => {
	await ensureObsidianStub();
	const { KnomoView } = await import("../src/ui/KnomoView");
	const pending = createDeferred<QueryMemo[]>();
	const view = Object.create(KnomoView.prototype) as QueryView;
	let selectedDateReloadCount = 0;
	view.memoSourceGeneration = 0;
	view.catalogDesktopQueryRun = 0;
	view.catalogDesktopQueryFingerprint = "catalog";
	view.hasCommittedCatalogDesktopQuery = true;
	view.catalogCursor = null;
	view.memos = [makeMemo("selected-day", "2026-05-01T09:00:00")];
	view.viewStateController = { activeNav: "all" };
	view.getCatalogQueryFingerprint = () => "catalog";
	view.loadCatalogMemos = async () => ({
		memos: await pending.promise,
		nextCursor: null,
		catalogRevision: 2,
		identityRevision: "identity-2",
		coverage: completeCoverage(),
		readState: "ready",
		status: { content: "ready", catalog: "complete", identity: "ready", projection: "ready", migration: "none" },
	});
	view.getCardFlowStateKey = () => "card-flow";
	view.getMobileSearchStateKey = () => "mobile-search";
	view.invalidateRecordStats = () => undefined;
	view.invalidateMemoSearchCache = () => undefined;
	view.retainMemoCardPreviews = () => undefined;
	view.resetVisibleMemos = () => undefined;
	view.renderUiState = () => undefined;
	view.forceRebuildCardFlow = () => undefined;
	view.renderMobileSearchResults = () => undefined;
	view.renderCardFlowIfChanged = () => undefined;
	view.renderMobileSearchResultsIfChanged = () => undefined;
	view.renderAllMemosLoadingState = () => undefined;
	view.randomReunionController = {
		getSnapshot: () => ({ status: "idle", error: null, memos: null }),
		clearMemos: () => undefined,
		refresh: async () => undefined,
	};
	view.shuffleDayController = {
		reloadSelectedDate: async () => {
			selectedDateReloadCount += 1;
			return true;
		},
	};
	view.refreshCatalogLibraryIndexes = async () => undefined;
	view.syncRecordStatsSource = () => undefined;

	const loading = view.reloadMemos(true);
	view.viewStateController.activeNav = "shuffleDay";
	pending.resolve([makeMemo("recent-first-page", "2026-08-24T10:00:00")]);

	assert.equal(await loading, true);
	assert.equal(selectedDateReloadCount, 0);
});

test("查询 fingerprint 变化时保留旧结果、清空 cursor，并启动新请求而不复用旧 promise", async () => {
	await ensureObsidianStub();
	const { KnomoView } = await import("../src/ui/KnomoView");
	const first = createDeferred<boolean>();
	const second = createDeferred<boolean>();
	const loads = [first, second];
	const view = Object.create(KnomoView.prototype) as QueryView;
	let fingerprint = "review";
	let loadCount = 0;
	let loadingRenderCount = 0;
	view.memoLoadingPromise = null;
	view.memoLoadingFingerprint = null;
	view.catalogDesktopQueryFingerprint = "review";
	view.hasCommittedCatalogDesktopQuery = true;
	view.catalogCursor = { catalog: { catalogRevision: 1, createdAtKey: "review", observationKey: "review" } };
	view.memos = [makeMemo("review-subset", "2026-08-24T10:00:00")];
	view.getCatalogQueryFingerprint = () => fingerprint;
	let recordStatsInvalidations = 0;
	view.invalidateRecordStats = () => { recordStatsInvalidations += 1; };
	view.invalidateMemoSearchCache = () => undefined;
	view.retainMemoCardPreviews = () => undefined;
	view.resetVisibleMemos = () => undefined;
	view.renderAllMemosLoadingState = () => { loadingRenderCount += 1; };
	view.reloadMemos = async () => {
		loadCount += 1;
		const load = loads.shift();
		assert.notEqual(load, undefined);
		return load?.promise ?? false;
	};

	const reviewRequest = view.reloadCurrentCatalogQuery();
	fingerprint = "all";
	const allRequest = view.reloadCurrentCatalogQuery(true);

	assert.equal(loadCount, 2);
	assert.deepEqual(view.memos.map((memo) => memo.id), ["review-subset"]);
	assert.equal(view.catalogCursor, null);
	assert.notEqual(reviewRequest, allRequest);
	assert.equal(recordStatsInvalidations, 0);
	assert.equal(loadingRenderCount, 0);
	second.resolve(true);
	assert.equal(await allRequest, true);
	first.resolve(false);
	assert.equal(await reviewRequest, false);
});

test("统计缓存只随 Catalog、Identity 和完整覆盖版本变化而失效", async () => {
	await ensureObsidianStub();
	const { KnomoView } = await import("../src/ui/KnomoView");
	const view = Object.create(KnomoView.prototype) as QueryView;
	let currentSource = "catalog:uninitialized";
	let invalidationCount = 0;
	let recordStatsUpdating = false;
	const updatingFlags: boolean[] = [];
	view.catalogRevision = 0;
	view.catalogIdentityRevision = "";
	view.catalogCoverage = null;
	view.libraryIndexRevision = 7;
	view.librarySummary = { memoCount: 9, tagCount: 3, imageCount: 1, wordCount: 20 };
	view.libraryTagFacets = [];
	view.recordStatsPreparationController = {
		setSourceKey: (source) => {
			if (source === currentSource) return false;
			currentSource = source;
			return true;
		},
	};
	view.recordStatsService = {
		invalidate: (showUpdating = true) => {
			invalidationCount += 1;
			recordStatsUpdating = showUpdating;
			updatingFlags.push(showUpdating);
		},
		getSnapshot: () => ({ state: "ready", error: null, updating: recordStatsUpdating }),
	};
	view.refreshCatalogLibraryIndexes = async () => undefined;

	const load = makeCatalogLoad(7, "identity-1", completeCoverage());
	view.applyCatalogMemoLoad(load);
	assert.equal(invalidationCount, 1);
	assert.equal(currentSource, "catalog:7:identity:identity-1:coverage:complete");
	assert.deepEqual(updatingFlags, [false]);

	view.applyCatalogMemoLoad({ ...load, memos: [makeMemo("same-source", "2026-08-24T10:00:00")] });
	assert.equal(invalidationCount, 1);

	view.applyCatalogMemoLoad({ ...load, catalogRevision: 8 });
	assert.equal(invalidationCount, 2);
	assert.deepEqual(updatingFlags, [false, false]);
	view.applyCatalogMemoLoad({ ...load, catalogRevision: 8, identityRevision: "identity-2" });
	assert.equal(invalidationCount, 3);
	assert.deepEqual(updatingFlags, [false, false, false]);
	view.applyCatalogMemoLoad({
		...load,
		catalogRevision: 8,
		identityRevision: "identity-2",
		coverage: { ...completeCoverage(), kind: "partial", pendingFileCount: 1 },
	});
	assert.equal(invalidationCount, 4);
	assert.equal(currentSource, "catalog:8:identity:identity-2:coverage:incomplete");
	assert.deepEqual(updatingFlags, [false, false, false, true]);

	view.applyCatalogMemoLoad({ ...load, catalogRevision: 9, identityRevision: "identity-2" });
	assert.equal(invalidationCount, 5);
	assert.equal(currentSource, "catalog:9:identity:identity-2:coverage:complete");
	assert.deepEqual(updatingFlags, [false, false, false, true, true]);
});

test("空库加载占位即使状态键未变化也会渲染暂无内容终态", async () => {
	await ensureObsidianStub();
	const { KnomoView } = await import("../src/ui/KnomoView");
	const view = Object.create(KnomoView.prototype) as QueryView;
	let renderCount = 0;
	view.cardFlowCoordinator = { deferredForAllMemos: true };
	view.cardFlowEl = { childElementCount: 1 };
	view.getCardFlowStateKey = () => "empty-library";
	view.renderCardFlow = () => { renderCount += 1; };

	view.renderCardFlowIfChanged("empty-library");

	assert.equal(renderCount, 1);
});

test("完整 Catalog 的普通 revision 更新静默保留旧侧栏统计直到原子替换", async () => {
	await ensureObsidianStub();
	const { KnomoView } = await import("../src/ui/KnomoView");
	const nextSummary = createDeferred<AggregateSummary>();
	const nextFacets = createDeferred<AggregateFacets>();
	const view = Object.create(KnomoView.prototype) as QueryView;
	let statsRenderCount = 0;
	let tagsRenderCount = 0;
	view.catalogCoverage = completeCoverage();
	view.catalogRevision = 5;
	view.libraryIndexRevision = 4;
	view.libraryIndexRun = 0;
	view.libraryIndexesUpdating = false;
	view.librarySummary = { memoCount: 9, tagCount: 3, imageCount: 1, wordCount: 20 };
	view.libraryTagFacets = [{ key: "old", label: "Old", count: 9 }];
	view.renderStats = () => { statsRenderCount += 1; };
	view.renderTags = () => { tagsRenderCount += 1; };
	view.getCatalogReadService = () => ({
		getLibrarySummary: () => nextSummary.promise,
		getTagFacets: () => nextFacets.promise,
	});

	const refreshing = view.refreshCatalogLibraryIndexes();
	assert.equal(view.libraryIndexesUpdating, false);
	assert.equal(statsRenderCount, 0);
	assert.equal(tagsRenderCount, 0);
	assert.deepEqual(view.librarySummary, { memoCount: 9, tagCount: 3, imageCount: 1, wordCount: 20 });

	nextSummary.resolve({
		value: { memoCount: 10, tagCount: 4, imageCount: 1, wordCount: 24 },
		complete: true,
		coverage: completeCoverage(),
	});
	nextFacets.resolve({
		value: [{ key: "new", label: "New", count: 10 }],
		complete: true,
		coverage: completeCoverage(),
	});
	await refreshing;

	assert.deepEqual(view.librarySummary, { memoCount: 10, tagCount: 4, imageCount: 1, wordCount: 24 });
	assert.deepEqual(view.libraryTagFacets, [{ key: "new", label: "New", count: 10 }]);
	assert.equal(view.libraryIndexRevision, 5);
	assert.equal(view.libraryIndexesUpdating, false);
	assert.equal(statsRenderCount, 1);
	assert.equal(tagsRenderCount, 1);
});

test("侧栏统计使用 Knomo 作用域更新类，避免触发 Obsidian 通用进度样式", async () => {
	await ensureObsidianStub();
	const { KnomoView } = await import("../src/ui/KnomoView");
	const statsEl = new TestStatsElement();
	const view = Object.create(KnomoView.prototype) as QueryView;
	view.statsEls = [statsEl.asHtml()];
	view.librarySummary = { memoCount: 9, tagCount: 3, imageCount: 1, wordCount: 20 };
	view.libraryIndexesUpdating = true;

	view.renderStats();

	assert.equal(statsEl.hasClass("is-updating"), false);
	assert.equal(statsEl.hasClass("knomo-sidebar-stats-updating"), true);
	assert.equal(statsEl.getAttr("aria-busy"), "true");
});

test("coverage 降级保留旧完整统计并标记更新中，恢复后按当前 revision 原子替换", async () => {
	await ensureObsidianStub();
	const { KnomoView } = await import("../src/ui/KnomoView");
	const oldSummary = createDeferred<AggregateSummary>();
	const oldFacets = createDeferred<AggregateFacets>();
	const newSummary = createDeferred<AggregateSummary>();
	const newFacets = createDeferred<AggregateFacets>();
	const summaryLoads = [oldSummary, newSummary];
	const facetLoads = [oldFacets, newFacets];
	const view = Object.create(KnomoView.prototype) as QueryView;
	view.catalogCoverage = completeCoverage();
	view.catalogRevision = 4;
	view.libraryIndexRevision = 4;
	view.libraryIndexRun = 0;
	view.libraryIndexesInvalidatedByCoverage = false;
	view.libraryIndexesUpdating = false;
	view.librarySummary = { memoCount: 9, tagCount: 3, imageCount: 1, wordCount: 20 };
	view.libraryTagFacets = [{ key: "old", label: "Old", count: 9 }];
	view.renderStats = () => undefined;
	view.renderTags = () => undefined;
	view.syncRecordStatsSource = () => undefined;
	view.getCatalogReadService = () => ({
		getLibrarySummary: () => {
			const load = summaryLoads.shift();
			assert.notEqual(load, undefined);
			return load?.promise ?? Promise.reject(new Error("missing summary request"));
		},
		getTagFacets: () => {
			const load = facetLoads.shift();
			assert.notEqual(load, undefined);
			return load?.promise ?? Promise.reject(new Error("missing facet request"));
		},
	});

	const staleRefresh = view.refreshCatalogLibraryIndexes();
	view.updateCatalogProgress({ ...completeCoverage(), kind: "partial", pendingFileCount: 1 });
	assert.deepEqual(view.librarySummary, { memoCount: 9, tagCount: 3, imageCount: 1, wordCount: 20 });
	assert.deepEqual(view.libraryTagFacets, [{ key: "old", label: "Old", count: 9 }]);
	assert.equal(view.libraryIndexRevision, -1);
	assert.equal(view.libraryIndexesUpdating, true);

	oldSummary.resolve({
		value: { memoCount: 9, tagCount: 3, imageCount: 1, wordCount: 20 },
		complete: true,
		coverage: completeCoverage(),
	});
	oldFacets.resolve({
		value: [{ key: "old", label: "Old", count: 9 }],
		complete: true,
		coverage: completeCoverage(),
	});
	await staleRefresh;
	assert.deepEqual(view.librarySummary, { memoCount: 9, tagCount: 3, imageCount: 1, wordCount: 20 });

	view.catalogRevision = 5;
	view.updateCatalogProgress(completeCoverage());
	assert.equal(view.libraryIndexesUpdating, true);
	newSummary.resolve({
		value: { memoCount: 12, tagCount: 4, imageCount: 2, wordCount: 30 },
		complete: true,
		coverage: completeCoverage(),
	});
	newFacets.resolve({
		value: [{ key: "new", label: "New", count: 12 }],
		complete: true,
		coverage: completeCoverage(),
	});
	await waitUntil(() => view.libraryIndexRevision === 5);

	assert.deepEqual(view.librarySummary, { memoCount: 12, tagCount: 4, imageCount: 2, wordCount: 30 });
	assert.deepEqual(view.libraryTagFacets, [{ key: "new", label: "New", count: 12 }]);
	assert.equal(view.libraryIndexesUpdating, false);
});

test("CAT-PAGE-001：分页合并超过旧窗口阈值时不丢失已显示的新记录", async () => {
	await ensureObsidianStub();
	const { mergeCatalogMemoPages } = await import("../src/ui/KnomoView");
	const memos = Array.from({ length: 200 }, (_, index) => makeMemo(
		`memo-${index.toString().padStart(3, "0")}`,
		`2026-08-${(25 - Math.floor(index / 10)).toString().padStart(2, "0")}T${(23 - (index % 10)).toString().padStart(2, "0")}:00:00`,
	));

	const merged = mergeCatalogMemoPages(memos);
	assert.equal(merged.length, 200);
	assert.equal(merged.some((memo) => memo.id === "memo-000"), true);
	assert.equal(merged.some((memo) => memo.id === "memo-199"), true);
});

type QueryMemo = MemoViewItem;

interface QueryView {
	memoSourceGeneration: number;
	catalogDesktopQueryRun: number;
	catalogDesktopQueryFingerprint: string | null;
	hasCommittedCatalogDesktopQuery: boolean;
	catalogCursor: { catalog: { catalogRevision: number; createdAtKey: string; observationKey: string } } | null;
	memos: QueryMemo[];
	viewStateController: { activeNav: "all" | "random" | "shuffleDay" };
	memoLoadingPromise: Promise<boolean> | null;
	memoLoadingFingerprint: string | null;
	catalogCoverage: TestCoverage | null;
	catalogReadState: "ready" | "history_building";
	catalogRevision: number;
	catalogIdentityRevision: string;
	libraryIndexRevision: number;
	libraryIndexRun: number;
	libraryIndexesInvalidatedByCoverage: boolean;
	libraryIndexesUpdating: boolean;
	librarySummary: { memoCount: number; tagCount: number; imageCount: number; wordCount: number } | null;
	libraryTagFacets: Array<{ key: string; label: string; count: number }> | null;
	statsEls: HTMLElement[];
	cardFlowError?: string | null;
	filteredMemosCache?: null;
	loadCatalogMemos: (loadAll: boolean) => Promise<TestCatalogMemoLoad>;
	getCardFlowStateKey: () => string;
	getMobileSearchStateKey: () => string;
	getCatalogQueryFingerprint: (loadAll: boolean) => string;
	invalidateRecordStats: () => void;
	invalidateMemoSearchCache: () => void;
	retainMemoCardPreviews: () => void;
	resetVisibleMemos: () => void;
	renderUiState: (options: object) => void;
	forceRebuildCardFlow: () => void;
	renderMobileSearchResults: () => void;
	renderCardFlowIfChanged: (key: string) => void;
	renderMobileSearchResultsIfChanged: (key: string) => void;
	renderAllMemosLoadingState: () => void;
	renderStats: () => void;
	renderTags: () => void;
	getCatalogReadService: () => {
		getLibrarySummary: () => Promise<AggregateSummary>;
		getTagFacets: () => Promise<AggregateFacets>;
	};
	randomReunionController: {
		getSnapshot: () => {
			status: "idle" | "ready";
			error: null;
			memos: QueryMemo[] | null;
		};
		clearMemos: () => void;
		refresh: () => Promise<void>;
	};
	shuffleDayController: { reloadSelectedDate: () => Promise<boolean> };
	refreshCatalogLibraryIndexes: () => Promise<void>;
	syncRecordStatsSource: () => void;
	applyCatalogMemoLoad: (load: TestCatalogMemoLoad) => void;
	recordStatsPreparationController: { setSourceKey: (source: string) => boolean };
	recordStatsService: {
		invalidate: (showUpdating?: boolean) => void;
		getSnapshot: () => { state: "ready"; error: null; updating: boolean };
	};
	cardFlowCoordinator: { deferredForAllMemos: boolean };
	cardFlowEl: { childElementCount: number } | null;
	renderCardFlow: () => void;
	reloadMemos: (loadAll: boolean, forceRebuild?: boolean) => Promise<boolean>;
	reloadCurrentCatalogQuery: (forceReload?: boolean) => Promise<boolean>;
	updateCatalogProgress: (coverage: TestCoverage) => void;
}

interface NavigationView {
	viewStateController: import("../src/ui/KnomoViewStateController").KnomoViewStateController;
	clearSearchDebounce: () => void;
	getCardFlowViewStateKey: () => string;
	getCardFlowChangeIntent: (key: string) => "view-scope-change";
	applyViewStateTransitionEffects: (effects: object) => void;
	renderUiState: (options?: object) => void;
	shouldDeferCardFlowForAllMemos: () => boolean;
	reloadCurrentCatalogQuery: (forceReload?: boolean) => Promise<boolean>;
	randomReunionController: {
		getSnapshot: () => { status: "ready"; error: null; memos: QueryMemo[] };
		clearMemos: () => void;
		refresh: () => Promise<void>;
	};
	shuffleDayController: {
		getSnapshot: () => { status: "ready" };
		clearSelection: () => void;
		refresh: () => Promise<void>;
	};
	trashMemoController: { loadTrashMemos: () => Promise<void> };
	timeBuoyViewController: { loadInitial: () => Promise<void> };
	prepareRecordStats: () => Promise<boolean>;
	setSidebarNav: (nav: "all" | "random" | "shuffleDay") => void;
}

type TestCoverage = {
	kind: "partial" | "complete" | "rebuilding";
	coveredFromDate: string | null;
	pendingFileCount: number;
	coveredFileCount: number;
	totalFileCount: number;
};

type AggregateSummary = {
	value: { memoCount: number; tagCount: number; imageCount: number; wordCount: number } | null;
	complete: boolean;
	coverage: TestCoverage;
};

type AggregateFacets = {
	value: Array<{ key: string; label: string; count: number }> | null;
	complete: boolean;
	coverage: TestCoverage;
};

type TestCatalogMemoLoad = {
	memos: QueryMemo[];
	nextCursor: null;
	catalogRevision: number;
	identityRevision: string;
	coverage: TestCoverage;
	readState: "ready" | "history_building";
	status: {
		content: "ready" | "scanning";
		catalog: "complete" | "partial";
		identity: "ready";
		projection: "ready";
		migration: "none";
	};
};

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolvePromise: (value: T) => void = () => undefined;
	const promise = new Promise<T>((resolve) => {
		resolvePromise = resolve;
	});
	return { promise, resolve: resolvePromise };
}

function makeMemo(id: string, createdAt: string): MemoViewItem {
	return {
		id,
		createdAt,
		updatedAt: createdAt,
		contentSnapshot: id,
		contentHash: `hash-${id}`,
		status: "active",
		tags: [],
		links: [],
		images: [],
		references: [],
		sourceMemoId: null,
		dailyRef: {
			path: `Daily/${createdAt.slice(0, 10)}.md`,
			heading: "## Memos",
			sectionType: "heading",
			lineNumberHint: 1,
		},
	};
}

function completeCoverage(): TestCoverage {
	return {
		kind: "complete",
		coveredFromDate: "2026-08-01",
		pendingFileCount: 0,
		coveredFileCount: 1,
		totalFileCount: 1,
	};
}

function makeCatalogLoad(
	catalogRevision: number,
	identityRevision: string,
	coverage: TestCoverage,
): TestCatalogMemoLoad {
	return {
		memos: [],
		nextCursor: null,
		catalogRevision,
		identityRevision,
		coverage,
		readState: "ready",
		status: { content: "ready", catalog: "complete", identity: "ready", projection: "ready", migration: "none" },
	};
}

async function waitUntil(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (predicate()) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
	throw new Error("Timed out waiting for view state.");
}

class TestStatsElement {
	private readonly classes = new Set<string>();
	private readonly attrs = new Map<string, string>();

	asHtml(): HTMLElement {
		return this as unknown as HTMLElement;
	}

	empty(): void {}

	toggleClass(name: string, active: boolean): void {
		if (active) this.classes.add(name);
		else this.classes.delete(name);
	}

	removeClass(name: string): void {
		this.classes.delete(name);
	}

	hasClass(name: string): boolean {
		return this.classes.has(name);
	}

	setAttr(name: string, value: string): void {
		this.attrs.set(name, value);
	}

	getAttr(name: string): string | null {
		return this.attrs.get(name) ?? null;
	}

	removeAttribute(name: string): void {
		this.attrs.delete(name);
	}

	createDiv(): HTMLElement {
		return new TestStatsElement().asHtml();
	}
}

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
	view.renderAllMemosLoadingState = () => undefined;
	view.randomReunionController = {
		getSnapshot: () => ({ loading: false, memos: null }),
		clearMemos: () => undefined,
		refresh: async () => undefined,
	};
	view.shuffleDayController = { reconcileWithMemos: () => undefined };
	view.refreshCatalogLibraryIndexes = async () => undefined;

	const firstRun = view.reloadMemos(false, true);
	const secondRun = view.reloadMemos(false, true);
	second.resolve([makeMemo("new", "2026-08-24T10:00:00")]);
	assert.equal(await secondRun, true);
	first.resolve([makeMemo("old", "2026-08-23T10:00:00")]);
	assert.equal(await firstRun, false);
	assert.deepEqual(view.memos.map((memo) => memo.id), ["new"]);
});

test("查询 fingerprint 变化时清空旧结果和 cursor，并启动新请求而不复用旧 promise", async () => {
	await ensureObsidianStub();
	const { KnomoView } = await import("../src/ui/KnomoView");
	const first = createDeferred<boolean>();
	const second = createDeferred<boolean>();
	const loads = [first, second];
	const view = Object.create(KnomoView.prototype) as QueryView;
	let fingerprint = "review";
	let loadCount = 0;
	view.memoLoadingPromise = null;
	view.memoLoadingFingerprint = null;
	view.catalogDesktopQueryFingerprint = "review";
	view.catalogCursor = { catalog: { catalogRevision: 1, createdAtKey: "review", observationKey: "review" } };
	view.memos = [makeMemo("review-subset", "2026-08-24T10:00:00")];
	view.getCatalogQueryFingerprint = () => fingerprint;
	view.invalidateRecordStats = () => undefined;
	view.invalidateMemoSearchCache = () => undefined;
	view.retainMemoCardPreviews = () => undefined;
	view.resetVisibleMemos = () => undefined;
	view.renderAllMemosLoadingState = () => undefined;
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
	assert.deepEqual(view.memos, []);
	assert.equal(view.catalogCursor, null);
	assert.notEqual(reviewRequest, allRequest);
	second.resolve(true);
	assert.equal(await allRequest, true);
	first.resolve(false);
	assert.equal(await reviewRequest, false);
});

test("coverage 降级立即废弃旧完整统计，恢复后按当前 revision 重取", async () => {
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
	view.librarySummary = { memoCount: 9, tagCount: 3, imageCount: 1, wordCount: 20 };
	view.libraryTagFacets = [{ key: "old", label: "Old", count: 9 }];
	view.renderStats = () => undefined;
	view.renderTags = () => undefined;
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
	assert.equal(view.librarySummary, null);
	assert.equal(view.libraryTagFacets, null);
	assert.equal(view.libraryIndexRevision, -1);

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
	assert.equal(view.librarySummary, null);

	view.catalogRevision = 5;
	view.updateCatalogProgress(completeCoverage());
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
	catalogCursor: { catalog: { catalogRevision: number; createdAtKey: string; observationKey: string } } | null;
	memos: QueryMemo[];
	viewStateController: { activeNav: "all" };
	memoLoadingPromise: Promise<boolean> | null;
	memoLoadingFingerprint: string | null;
	catalogCoverage: TestCoverage;
	catalogRevision: number;
	libraryIndexRevision: number;
	libraryIndexRun: number;
	libraryIndexesInvalidatedByCoverage: boolean;
	librarySummary: { memoCount: number; tagCount: number; imageCount: number; wordCount: number } | null;
	libraryTagFacets: Array<{ key: string; label: string; count: number }> | null;
	cardFlowError?: string | null;
	filteredMemosCache?: null;
	loadCatalogMemos: (loadAll: boolean) => Promise<{
		memos: QueryMemo[];
		nextCursor: null;
		coverage: { kind: "complete"; coveredFromDate: string; pendingFileCount: number; coveredFileCount: number; totalFileCount: number };
		readState: "ready";
		status: { content: "ready"; catalog: "complete"; identity: "ready"; projection: "ready"; migration: "none" };
	}>;
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
		getSnapshot: () => { loading: boolean; memos: null };
		clearMemos: () => void;
		refresh: () => Promise<void>;
	};
	shuffleDayController: { reconcileWithMemos: () => void };
	refreshCatalogLibraryIndexes: () => Promise<void>;
	reloadMemos: (loadAll: boolean, forceRebuild?: boolean) => Promise<boolean>;
	reloadCurrentCatalogQuery: (forceReload?: boolean) => Promise<boolean>;
	updateCatalogProgress: (coverage: TestCoverage) => void;
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

async function waitUntil(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (predicate()) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
	throw new Error("Timed out waiting for view state.");
}

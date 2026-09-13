import assert from "node:assert/strict";
import test from "node:test";
import { ensureObsidianStub } from "./helpers/obsidianStub";
import { TimeBuoyViewController } from "../src/ui/TimeBuoyViewController";
import { formatTimeBuoyDate } from "../src/utils/timeBuoyDate";
import type { TimeBuoyQueryResult } from "../src/types/timeBuoy";
import type { MemoViewItem } from "../src/types/memoView";

async function refreshHarness() {
	await ensureObsidianStub();
	const { KnomoView } = await import("../src/ui/KnomoView");
	const view = Object.create(KnomoView.prototype);
	const today = formatTimeBuoyDate(new Date());
	const memo = { id: "pinned", createdAt: `${today}T09:00`, updatedAt: "", contentHash: "same", status: "active", dailyRef: { path: "Daily.md" } } as MemoViewItem;
	const result = (revision: number, items = [memo]): TimeBuoyQueryResult => ({
		catalogRevision: revision, stale: [], missingPeriods: [],
		items: items.map(memo => ({ memo, instance: { memoId: memo.id, targetDate: today } })),
	});
	let revision = 1, ready = true;
	let query = async () => result(revision);
	const renders: string[][] = [];
	const controller = new TimeBuoyViewController({
		getNow: () => new Date(), isTodayIndexReady: async () => ready,
		queryDate: () => query(), queryAll: async () => ({ ...result(revision), complete: true }),
		requestRender: () => { view.renderCardFlow(); },
	});
	Object.assign(view, {
		memoSourceGeneration: 0, catalogDesktopQueryRun: 0, memos: [], catalogTodayTimeBuoys: null,
		catalogRevision: 0, hasCommittedCatalogDesktopQuery: false, cardFlowEl: { isConnected: true, childElementCount: 1 },
		cardFlowCoordinator: { deferredForAllMemos: false },
		timeBuoyViewController: controller, shouldShowTodayTimeBuoys: () => true, isDefaultListState: () => true,
		viewStateController: { activeNav: "all" }, getCatalogQueryFingerprint: () => "all",
		prepareCatalogDesktopQuery: () => {}, isCatalogQueryCurrent: () => true, buildCatalogActiveQuery: () => ({}),
		queryCatalogFeature: async () => ({ items: [], catalogRevision: revision, nextCursor: null, readState: "ready" }),
		syncRecordStatsSource: () => {}, refreshCatalogLibraryIndexes: async () => {}, getImmediateCatalogTotalCount: () => 0,
		invalidateMemoSearchCache: () => {}, retainMemoCardPreviews: () => {}, resetVisibleMemos: () => {},
		renderUiState: (options?: { renderCardFlow?: boolean }) => { if (options?.renderCardFlow !== false) view.renderCardFlow(); },
		getCardFlowStateKey: () => JSON.stringify(view.getTodayTimeBuoyItems().map((item: { memo: MemoViewItem }) => item.memo.id)),
		getMobileSearchStateKey: () => "", renderMobileSearchResultsIfChanged: () => {},
		renderCardFlow: () => renders.push(view.getTodayTimeBuoyItems().map((item: { memo: MemoViewItem }) => item.memo.id)),
		updateStatus: () => {},
	});
	return { view, controller, memo, result, renders,
		setRevision: (value: number) => { revision = value; }, setReady: (value: boolean) => { ready = value; },
		setQuery: (value: () => Promise<TimeBuoyQueryResult>) => { query = value; },
	};
}

test("冷启动后的后台浮标准备不撤下已提交卡片，同结果刷新不重绘，确认空结果才移除", async () => {
	const { view, controller, result, renders, setRevision, setReady, setQuery } = await refreshHarness();
	await view.loadInitialMobileMemos();
	assert.deepEqual(renders, [["pinned"]]);
	const committed = view.catalogTodayTimeBuoys;
	let release!: (value: TimeBuoyQueryResult) => void;
	setRevision(2);
	setQuery(() => new Promise(resolve => { release = resolve; }));
	const refreshing = view.reloadMemos(false);
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(view.catalogTodayTimeBuoys, committed);
	assert.deepEqual(view.getTodayTimeBuoyItems().map((item: { memo: MemoViewItem }) => item.memo.id), ["pinned"]);
	release(result(2)); await refreshing;
	assert.equal(view.catalogRevision, 2);
	assert.equal(view.getTodayTimeBuoyItems().length, 1);
	assert.deepEqual(renders, [["pinned"]], "同内容只推进版本，不重建卡片");
	setReady(false);
	await controller.loadTodayOnly();
	assert.equal(await view.reloadMemos(false), false);
	assert.equal(view.catalogRevision, 2);
	assert.equal(view.getTodayTimeBuoyItems().length, 1, "索引待就绪时保留上一批显示，不混合新数据");
	setReady(true);
	setQuery(async () => { throw new Error("read failed"); });
	assert.equal(await view.reloadMemos(false), false);
	assert.equal(view.getTodayTimeBuoyItems().length, 1);
	setQuery(async () => result(3));
	assert.equal(await view.reloadMemos(false), false, "版本不匹配拒绝整批提交");
	assert.equal(view.getTodayTimeBuoyItems().length, 1);
	setQuery(async () => result(2, []));
	assert.equal(await view.reloadMemos(false), true);
	assert.deepEqual(renders, [["pinned"], []]);
});

test("旧移动端首屏在较新列表查询后返回时，不覆盖列表或置顶快照", async () => {
	const { view, result, setQuery, setRevision } = await refreshHarness();
	for (const fail of [false, true]) {
		let release!: (value: TimeBuoyQueryResult) => void, reject!: (reason: Error) => void;
		setRevision(1);
		setQuery(() => new Promise((resolve, fail) => { release = resolve; reject = fail; }));
		const initial = view.loadInitialMobileMemos();
		await new Promise(resolve => setImmediate(resolve));
		setRevision(2); setQuery(async () => result(2, []));
		assert.equal(await view.reloadMemos(false), true);
		const committed = view.catalogTodayTimeBuoys;
		if (fail) reject(new Error("late failure")); else release(result(1));
		await initial;
		assert.equal(view.catalogRevision, 2);
		assert.equal(view.catalogTodayTimeBuoys, committed);
		assert.deepEqual(view.getTodayTimeBuoyItems(), []);
		assert.equal(view.cardFlowError, null);
	}
});

test("仅在置顶结果中的历史卡片仍使用原 occurrence，并独立接收保存结果", async () => {
	const { view, memo, result, setQuery } = await refreshHarness();
	const other = { ...memo, id: "same-content-other-occurrence" };
	setQuery(async () => result(1, [memo, other]));
	await view.loadInitialMobileMemos();
	assert.deepEqual(view.memos, []);
	assert.equal(view.findMemoById(memo.id), memo);
	view.shuffleDayController = { applyMemoUpdate: () => {} };
	const updated = view.applySavedMemo({
		key: memo.id, renderKey: memo.id, createdAt: memo.createdAt,
		content: "- [x] done", tags: [], links: [], images: [], sourcePath: memo.dailyRef.path,
		observation: { contentHash: "saved", section: null },
	});
	assert.equal(view.findMemoById(memo.id), updated);
	assert.equal(view.findMemoById(other.id), other);
	assert.equal(view.getTodayTimeBuoyItems()[0].memo.contentSnapshot, "- [x] done");
});

test("首次浮标读取失败仍可显示普通列表，不将故障当作已确认的空置顶结果", async () => {
	const { view, setQuery } = await refreshHarness();
	setQuery(async () => { throw new Error("time buoy unavailable"); });
	await view.loadInitialMobileMemos();
	assert.equal(view.hasCommittedCatalogDesktopQuery, true);
	assert.equal(view.cardFlowError, null);
	assert.equal(view.catalogTodayTimeBuoys.todayValid, false);
	assert.deepEqual(view.getTodayTimeBuoyItems(), []);
});

test("列表查询等待置顶数据后才返回，拒绝混合不同 Catalog revision", async () => {
	await ensureObsidianStub();
	const { KnomoView } = await import("../src/ui/KnomoView");
	const view = Object.create(KnomoView.prototype);
	let release!: () => void;
	let revision = 2;
	let queries = 0;
	Object.assign(view, {
		buildCatalogActiveQuery: () => ({}), isDefaultListState: () => false,
		queryCatalogFeature: async () => ({ items: [], catalogRevision: 2, nextCursor: null }),
		shouldShowTodayTimeBuoys: () => true,
		timeBuoyViewController: {
			prepareTodayOnly: async () => {
				queries++;
				await new Promise<void>(resolve => { release = resolve; });
				return { todayValid: true, todayRevision: revision, todayError: null };
			},
		},
	});
	let returned = false;
	const first = view.loadCatalogMemos(false).then(() => { returned = true; });
	await Promise.resolve(); await Promise.resolve();
	assert.equal(returned, false);
	assert.equal(queries, 1);
	release(); await first;
	assert.equal(returned, true);
	revision = 3;
	const stale = view.loadCatalogMemos(false);
	await Promise.resolve(); await Promise.resolve();
	release();
	await assert.rejects(stale, /Catalog changed/);
});

test("引用事件增量刷新且原位排队正文与来源引用，不清空卡片容器", async () => {
	await ensureObsidianStub();
	const { KnomoView } = await import("../src/ui/KnomoView");
	const view = Object.create(KnomoView.prototype);
	const content = {}, meta = {};
	const card = { getAttribute: () => "memo", querySelector: (selector: string) => selector === ".knomo-card-content" ? content : meta };
	const cards = [card];
	const container = { querySelectorAll: () => cards };
	const queued: unknown[][] = [];
	const memo = { id: "memo", contentSnapshot: "text [[Daily#^block]]", dailyRef: { path: "Daily.md" } };
	Object.assign(view, {
		refresh: async (force?: boolean) => { assert.equal(force, undefined); },
		trashViewClosed: false, cardFlowEl: container,
		cardFlowCoordinator: { generation: 3 }, mobileSearchController: { results: null, renderGeneration: 1 },
		findMemoById: () => memo, getMemoCardPreview: () => ({ text: "text" }),
		memoMarkdownRenderer: {
			queueMemoMarkdown: (...args: unknown[]) => queued.push(args),
			queueSourceReferenceMarkdown: (...args: unknown[]) => queued.push(args),
		},
	});
	await view.refreshReferences();
	assert.equal(view.cardFlowEl, container);
	assert.equal(cards[0], card);
	assert.equal(queued.length, 2);
	assert.equal(queued[0][1], content);
	assert.equal(queued[1][0], meta);
	view.trashViewClosed = true;
	await view.refreshReferences();
	assert.equal(queued.length, 2);
});

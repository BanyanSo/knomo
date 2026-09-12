import assert from "node:assert/strict";
import test from "node:test";
import { ensureObsidianStub } from "./helpers/obsidianStub";
import { KnomoViewStateController } from "../src/ui/KnomoViewStateController";
import { TimeBuoyViewController, mergeTodayTimeBuoyFeed } from "../src/ui/TimeBuoyViewController";
import { formatTimeBuoyDate } from "../src/utils/timeBuoyDate";
import type { MemoViewItem } from "../src/types/memoView";

async function setup() {
	await ensureObsidianStub();
	const { KnomoView } = await import("../src/ui/KnomoView");
	const state = new KnomoViewStateController();
	let enabled = true;
	const view = Object.create(KnomoView.prototype);
	Object.assign(view, {
		viewStateController: state, settingsService: { getSettings: () => ({ recentTimeFlowEnabled: enabled, timeBuoyEnabled: true }) },
		catalogRevision: 1, recentLifecycleKey: "", trashViewClosed: false,
		cardFlowCoordinator: { generation: 0 }, cardFlowEl: null,
		getTodayTimeBuoyItems: () => [], clearMobileCardBatchContinuation: () => {},
		deferMobileCardFlowRender: () => false,
	});
	return { view, state, setEnabled: (value: boolean) => { enabled = value; } };
}

test("桌面近月不足一页仍能展开更早历史，完整读完后才结束", async () => {
	const { view } = await setup();
	const { Platform } = await import("obsidian");
	const previousMobile = Platform.isMobile;
	Platform.isMobile = false;
	try {
		const recent = Array.from({ length: 17 }, (_, index) => ({ id: `recent-${index}` }));
		const history = [...recent, { id: "july" }];
		const requests: boolean[] = [];
		Object.assign(view, {
			memoSourceGeneration: 0, catalogDesktopQueryRun: 0, hasCommittedCatalogDesktopQuery: true,
			catalogLoadingNextPage: false, cardFlowError: null,
			prepareCatalogDesktopQuery: () => {}, getCardFlowStateKey: () => "", getMobileSearchStateKey: () => "",
			isCatalogQueryCurrent: () => true,
			loadCatalogMemos: async (loadAll: boolean) => {
				requests.push(loadAll);
				return { fullHistoryLoaded: loadAll, memos: loadAll ? history : recent, nextCursor: null, readState: "ready" };
			},
			applyCatalogMemoLoad: (load: { nextCursor: null }) => { view.catalogCursor = load.nextCursor; },
			getImmediateCatalogTotalCount: () => 17, invalidateMemoSearchCache: () => {}, retainMemoCardPreviews: () => {},
			renderUiState: () => {}, renderCardFlowIfChanged: () => {}, renderMobileSearchResultsIfChanged: () => {},
			renderNextCardBatch: () => {},
		});
		assert.equal(await view.reloadMemos(false), true);
		assert.equal(view.catalogCursor, null);
		assert.equal(view.canLoadOlderMemoPeriods(), true);
		assert.equal(await view.loadNextCatalogPage(), true);
		assert.deepEqual(requests, [false, true]);
		assert.equal(view.memos, history);
		assert.equal(view.canLoadOlderMemoPeriods(), false);
		assert.equal(await view.loadNextCatalogPage(), false);
	} finally { Platform.isMobile = previousMobile; }
});

test("模式切换只取消呈现，不重置已加载结果和 cursor；筛选与默认空搜索独立", async () => {
	const { view, state, setEnabled } = await setup();
	const memos = [{ id: "page-2" }];
	const cursor = { catalog: { revision: 1 } };
	view.memos = memos;
	view.catalogCursor = cursor;
	const intents: string[] = [];
	view.forceRebuildCardFlow = (intent: string) => intents.push(intent);
	view.renderCardFlow();
	setEnabled(false);
	view.renderCardFlow();
	setEnabled(true);
	view.renderCardFlow();
	assert.equal(view.memos, memos);
	assert.equal(view.catalogCursor, cursor);
	assert.deepEqual(intents, ["content-change", "content-change"]);
	assert.equal(view.cardFlowCoordinator.generation, 2);
	state.desktopSearchOpen = true;
	assert.equal(view.getRecentTimeFlowContext().enabled, true);
	state.searchQuery = "query";
	assert.equal(view.getRecentTimeFlowContext().enabled, false);
	state.searchQuery = "";
	state.activeTagKey = "tag";
	assert.equal(view.getRecentTimeFlowContext().enabled, false);
	state.activeTagKey = null;
	for (const nav of ["time-buoy", "random", "review", "trash", "record-stats", "shuffleDay"] as const) {
		state.activeNav = nav;
		assert.equal(view.getRecentTimeFlowContext().enabled, false);
	}
});

test("午夜无 Memo 变化仍刷新，恢复时同日期也重排计时，关闭后不回调", async () => {
	const { view } = await setup();
	const calls: string[] = [];
	view.stopDateChangeWatcher = () => calls.push("stop");
	view.startDateChangeWatcher = () => calls.push("start");
	view.renderCardFlow = () => calls.push("render");
	view.renderUiState = () => calls.push("ui");
	view.timeBuoyViewController = { loadTodayOnly: async () => calls.push("buoy") };
	view.lastKnownLocalDate = "2000-01-01";
	view.handleLocalDateChange();
	assert.deepEqual(calls, ["stop", "start", "ui", "buoy"]);
	calls.length = 0;
	view.handleLocalDateChange();
	assert.deepEqual(calls, ["stop", "start", "render"]);
	calls.length = 0;
	view.trashViewClosed = true;
	view.handleLocalDateChange();
	assert.deepEqual(calls, []);
});

test("分页新增全部已置顶时仍保留下一页，异步返回按最新展示上下文渲染", async () => {
	const { view, setEnabled } = await setup();
	const nextCursor = { catalog: { catalogRevision: 1, createdAtKey: "next", observationKey: "next" } };
	const item = { key: "same", renderKey: "same", createdAt: "2026-09-10T12:34", content: "same", tags: [], links: [], images: [], sourcePath: "Daily/2026-09-10.md", observation: { section: null, contentHash: "same" } };
	const { toCatalogMemoView } = await import("../src/types/memoView");
	const memo = toCatalogMemoView(item as unknown as Parameters<typeof toCatalogMemoView>[0]);
	let resolve!: (page: unknown) => void;
	const renderedModes: boolean[] = [];
	Object.assign(view, { memos: [memo], catalogCursor: nextCursor, catalogLoadingNextPage: false,
		catalogHistoryExpansionPending: false, catalogDesktopQueryRun: 1, catalogDesktopQueryFingerprint: "default",
		getCatalogQueryFingerprint: () => "default", isCatalogQueryCurrent: () => true, buildCatalogActiveQuery: () => ({}),
		queryCatalogFeature: () => new Promise((done) => { resolve = done; }), syncRecordStatsSource: () => {}, invalidateMemoSearchCache: () => {},
		renderCardFlow: () => renderedModes.push(view.getRecentTimeFlowContext().enabled),
		forceRebuildCardFlow: () => { throw new Error("分页不应清空已渲染正文和滚动高度"); },
		renderNextCardBatch: () => {},
	});
	const pending = view.loadNextCatalogPage();
	setEnabled(false);
	resolve({ items: [item], nextCursor, catalogRevision: 1, invalidated: false });
	assert.equal(await pending, true);
	assert.equal(view.memos.length, 1);
	assert.equal(view.catalogCursor, nextCursor);
	assert.deepEqual(renderedModes, [false]);
});

test("近月展开全历史保留已有呈现，并继续渲染历史批次", async () => {
	const { view } = await setup();
	const calls: unknown[] = [];
	Object.assign(view, {
		catalogLoadingNextPage: false, catalogHistoryExpansionPending: true,
		reloadMemos: async (...args: unknown[]) => { calls.push(args); return true; },
		renderNextCardBatch: () => calls.push("append"),
	});
	assert.equal(await view.loadNextCatalogPage(), true);
	assert.deepEqual(calls, [[true], "append"]);
});

test("真实 revision key 的普通与浮标两种到达顺序收敛，同文 occurrence 不丢失", async () => {
	await ensureObsidianStub();
	const { KnomoView } = await import("../src/ui/KnomoView");
	const today = formatTimeBuoyDate(new Date());
	const memo = (revision: string, line: number) => ({ id: `Daily/${today}.md:${revision}:${line}`, createdAt: `${today}T12:34`, contentSnapshot: "same", contentHash: "same", updatedAt: "", status: "active", dailyRef: { path: `Daily/${today}.md` } }) as MemoViewItem;
	for (const buoyFirst of [false, true]) {
		const view = Object.create(KnomoView.prototype);
		let revision = 1;
		let promoted = [memo("a", 1)];
		const controller = new TimeBuoyViewController({ getNow: () => new Date(), queryAll: async () => ({ items: [], stale: [], missingPeriods: [], complete: true }),
			queryDate: async () => ({ catalogRevision: revision, items: promoted.map((memo) => ({ memo, instance: { memoId: memo.id, targetDate: today } })), stale: [], missingPeriods: [] }), requestRender: () => {},
		});
		Object.assign(view, { catalogRevision: 1, shouldShowTodayTimeBuoys: () => true, timeBuoyViewController: controller });
		await controller.loadTodayOnly();
		revision = 2;
		promoted = [memo("b", 1)];
		if (buoyFirst) await controller.loadTodayOnly();
		else view.catalogRevision = 2;
		assert.deepEqual(view.getTodayTimeBuoyItems(), []);
		if (buoyFirst) view.catalogRevision = 2;
		else await controller.loadTodayOnly();
		const ordinary = [memo("b", 1), memo("b", 2)];
		assert.deepEqual(mergeTodayTimeBuoyFeed(ordinary, view.getTodayTimeBuoyItems()).map((item) => item.id), ordinary.map((item) => item.id));
		promoted = [];
		await controller.loadTodayOnly();
		assert.deepEqual(view.getTodayTimeBuoyItems(), []);
		view.shouldShowTodayTimeBuoys = () => false;
		assert.deepEqual(view.getTodayTimeBuoyItems(), []);
	}
});

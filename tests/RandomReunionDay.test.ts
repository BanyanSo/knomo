import assert from "node:assert/strict";
import test from "node:test";
import type { MemoViewItem } from "../src/types/memoView";
import { KnomoViewStateController } from "../src/ui/KnomoViewStateController";
import { createReferenceMemo } from "./helpers/referenceMemo";
import { createDeferred } from "./helpers/deferred";
import { ensureObsidianStub } from "./helpers/obsidianStub";
import { JSDOM } from "jsdom";

test("生产日期入口与返回保留随机批次、曝光和阅读位置，不触发回顾或漫游历史", async () => {
	const h = await harness();
	await h.random.refresh();
	await h.shuffle.refresh();
	const batch = h.random.getSnapshot().memos;
	const shuffle = h.shuffle.getSnapshot();
	await h.view.handleMemoAction("view-day", h.memo);
	assert.equal(h.view.randomDayOpen, true);
	assert.deepEqual(h.reads, ["2026-10-16"]);
	assert.deepEqual(h.view.getFilteredMemos().map((memo: MemoViewItem) => memo.id), ["memo", "other"]);
	assert.equal(h.view.findMemoById("other").id, "other");
	assert.equal(h.shuffle.getSnapshot().selectedDate, shuffle.selectedDate);
	assert.equal(h.shuffle.getSnapshot().memos, shuffle.memos);
	await h.view.returnFromRandomDay();
	assert.equal(h.view.randomDayOpen, false);
	assert.equal(h.random.getSnapshot().memos, batch);
	assert.equal(h.calls.loads, 1);
	assert.equal(h.calls.reviews, 0);
	assert.equal(h.calls.opens, 0);
	assert.equal(h.calls.history, 1);
	assert.deepEqual(h.restored, [h.position]);
	await h.random.refresh();
	assert.deepEqual(h.calls.exposures.at(-1), [["memo"]], "日期详情与普通返回不追加曝光批次");
});

test("返回先核对原批次，失效记录移除后不补抽；离开日期详情终止旧读取", async () => {
	const h = await harness();
	await h.random.refresh();
	await h.view.openRandomDay(h.memo);
	h.view.catalogReadService.refreshMemoViews = async () => [];
	await h.view.returnFromRandomDay();
	assert.deepEqual(h.random.getSnapshot().memos, []);
	assert.equal(h.calls.loads, 1);
	const pending = createDeferred<MemoViewItem[]>();
	h.view.randomDayController = new h.Controller({
		loadSelectedDate: async () => pending.promise, isShuffleDayActive: () => h.view.randomDayOpen,
		requestRender: () => {},
	});
	const opening = h.view.openRandomDay(h.memo);
	h.view.activeNav = "all";
	pending.resolve([h.memo]);
	await opening;
	assert.equal(h.view.randomDayController.getSnapshot().selectedDate, null);
	assert.equal(h.view.randomDayReturnContext, null);
	assert.deepEqual(h.view.historyBrowsePositions.random, h.position);
});

test("日期详情接收提交后的替换与插入，只保留原日期；原随机批次独立更新", async () => {
	const h = await harness();
	await h.random.refresh();
	await h.view.openRandomDay(h.memo);
	const moved = { ...h.memo, id: "moved", createdAt: "2026-10-17T09:00",
		catalog: { ...h.memo.catalog!, observation: { ...h.memo.catalog!.observation, logicalDate: "2026-10-17" } } };
	const inserted = { ...h.memo, id: "new", contentSnapshot: "new" };
	const changes = new Map([[h.memo.id, moved]]);
	h.view.randomDayController.applyMemoChanges(changes, [inserted]);
	h.random.applyMemoChanges(changes, false);
	assert.equal(h.view.randomDayController.getSnapshot().selectedDate, "2026-10-16");
	assert.deepEqual(h.view.getFilteredMemos().map((memo: MemoViewItem) => memo.id), ["other", "new"]);
	assert.deepEqual(h.random.getSnapshot().memos?.map(memo => memo.id), ["moved"]);
});

test("返回核对遇到 Catalog 快照失效时保留批次并提示刷新，不静默补抽", async () => {
	const h = await harness();
	const { CatalogDiscoveryInvalidatedError } = await import("../src/services/CatalogReadService");
	await h.random.refresh();
	const batch = h.random.getSnapshot().memos;
	await h.view.openRandomDay(h.memo);
	h.view.catalogReadService.refreshMemoViews = async () => { throw new CatalogDiscoveryInvalidatedError(); };
	await h.view.returnFromRandomDay();
	assert.equal(h.random.getSnapshot().memos, batch);
	assert.ok(h.random.getSnapshot().error);
	assert.equal(h.calls.loads, 1);
});

test("主动换批成功才回到开头；失败或在日期详情内的换批动作保留阅读位置", async () => {
	const h = await harness();
	await h.random.refresh();
	h.view.historyBrowsePositions = { random: h.position };
	h.failLoad(true);
	await h.view.refreshHistorySelection("random");
	assert.deepEqual(h.view.historyBrowsePositions.random, h.position);
	h.failLoad(false);
	await h.view.refreshHistorySelection("random");
	assert.equal(h.view.historyBrowsePositions.random, undefined);
	assert.ok(h.renders.some(options => options?.cardFlowChangeIntent === "view-scope-change"));
	await h.view.openRandomDay(h.memo);
	const loads = h.calls.loads;
	await h.view.refreshHistorySelection("random");
	assert.equal(h.calls.loads, loads);
});

test("滚动恢复使用可见卡片锚点与偏移，锚点删除后安全落在起点", async () => {
	await ensureObsidianStub();
	const { KnomoView } = await import("../src/ui/KnomoView");
	const { KnomoCardFlowCoordinator } = await import("../src/ui/KnomoCardFlowCoordinator");
	const dom = new JSDOM("<div><article data-memo-render-key='before'></article><article data-memo-render-key='anchor'></article></div>");
	try {
		const flow = dom.window.document.querySelector("div")!;
		const cards = [...flow.querySelectorAll<HTMLElement>("article")];
		for (const card of cards) Object.assign(card, { getAttr: (name: string) => card.getAttribute(name) });
		let anchorTop = -10;
		flow.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
		cards[0].getBoundingClientRect = () => ({ top: -100, bottom: -5 }) as DOMRect;
		cards[1].getBoundingClientRect = () => ({ top: anchorTop, bottom: anchorTop + 100 }) as DOMRect;
		flow.scrollTop = 420;
		const coordinator = new KnomoCardFlowCoordinator();
		coordinator.generation = 3;
		const view = Object.create(KnomoView.prototype);
		let memos = [{ id: "before" }, { id: "anchor" }] as MemoViewItem[];
		Object.assign(view, { cardFlowEl: flow, cardFlowCoordinator: coordinator,
			getDirectCardElements: () => cards, getCardFlowScrollTop: () => flow.scrollTop,
			getFilteredMemos: () => memos, renderCardFlow: () => {
				assert.equal(coordinator.getPendingVisibleCount(3), 2);
				coordinator.restorePendingScrollTop(3, value => { flow.scrollTop = value; }, flow);
			},
		});
		const position = view.captureHistoryBrowsePosition();
		assert.deepEqual(position, { scrollTop: 420, visibleCount: 2, anchor: { renderKey: "anchor", offset: -10 } });
		flow.scrollTop = 1000; anchorTop = 50;
		view.restoreHistoryBrowsePosition(position);
		assert.equal(flow.scrollTop, 1060);
		memos = [];
		view.restoreHistoryBrowsePosition(position);
		assert.equal(flow.scrollTop, 0);
	} finally { dom.window.close(); }
});

test("加载完成重绘保留日期返回按钮焦点，重试按钮消失后回到返回入口", async () => {
	const h = await harness();
	const dom = new JSDOM("<div><button data-action='retry-random-day'>Retry</button></div>");
	try {
		const flow = dom.window.document.querySelector("div")!;
		const retry = flow.querySelector("button")!;
		Object.assign(retry, { getAttr: (name: string) => retry.getAttribute(name) });
		retry.focus();
		h.view.cardFlowEl = flow;
		h.view.renderUiState = () => { flow.replaceChildren(); const back = flow.ownerDocument.createElement("button");
			back.setAttribute("data-action", "random-day-back"); flow.append(back); };
		h.view.renderRandomDay();
		assert.equal(dom.window.document.activeElement?.getAttribute("data-action"), "random-day-back");
	} finally { dom.window.close(); }
});

test("日期详情返回后移动端恢复页面焦点，桌面端恢复原卡片菜单焦点", async () => {
	for (const layout of ["mobile", "desktop-wide"] as const) {
		const h = await harness();
		const { Platform } = await import("obsidian");
		const platform = Platform as unknown as { isMobile: boolean };
		const wasMobile = platform.isMobile;
		const dom = new JSDOM("<main><div><button data-action='random-day-back'>Back</button></div></main>", { pretendToBeVisual: true });
		const cleanups: Array<() => void> = [];
		try {
			platform.isMobile = layout === "mobile";
			const doc = dom.window.document;
			const root = doc.querySelector("main")!;
			const flow = root.querySelector("div")!;
			Object.assign(dom.window.HTMLElement.prototype, { getAttr(this: HTMLElement, name: string) { return this.getAttribute(name); } });
			doc.hasFocus = () => true;
			Object.assign(h.view, { currentLayout: layout, rootEl: root, cardFlowEl: flow, mobileViewFocusRecovery: null,
				containerEl: { doc, win: dom.window }, app: { workspace: { getActiveViewOfType: () => h.view } },
				mobileSearchController: { isOpen: false },
				register: (cleanup: () => void) => cleanups.push(cleanup),
				getDirectCardElements: () => [...flow.querySelectorAll("article")],
				renderUiState: () => { flow.innerHTML = `<article data-memo-id='${h.memo.id}'><button class='knomo-card-menu' aria-expanded='false'>Menu</button></article>`; },
			});
			await h.random.refresh();
			await h.view.openRandomDay(h.memo);
			assert.equal(doc.activeElement, layout === "mobile" ? root : flow.querySelector("button"), "移动端进入日期详情恢复页面焦点，不聚焦返回按钮");
			await h.view.returnFromRandomDay();
			const menu = flow.querySelector(".knomo-card-menu")!;
			assert.equal(doc.activeElement, layout === "mobile" ? root : menu, layout);
			assert.equal(menu.getAttribute("aria-expanded"), "false");
			assert.deepEqual(h.restored, [h.position]);
		} finally {
			for (const cleanup of cleanups) cleanup();
			platform.isMobile = wasMobile;
			dom.window.close();
		}
	}
});

test("移动端原生卡片菜单仅为随机批次提供查看那一天，搜索覆盖层不继承此入口", async () => {
	const h = await harness();
	for (const surface of ["card-flow", "mobile-search"]) {
		const titles: string[] = [];
		const actions = new Map<string, () => void>();
		const focusTargets: unknown[] = [];
		const trigger = { isConnected: true };
		const card = { getAttr: () => h.memo.id, find: () => trigger };
		Object.assign(h.view, {
			popupState: { activeMenuMemoId: null }, getMemoSurface: () => surface, findMemoById: () => h.memo,
			cardFlowEl: { findAll: () => [card] }, mobileSearchController: { results: { findAll: () => [card] } },
			syncRootState: () => {}, syncCardMenuState: () => {},
			mobileMenuController: { close: () => {}, open: (options: { build: (menu: unknown, select: () => void, title: (text: string) => string) => void }) => {
				const menu = { addSeparator: () => {}, addItem: (build: (item: unknown) => void) => {
					let title = "";
					const item = { setTitle: (value: string) => { title = value; titles.push(value); return item; }, setIcon: () => item,
						setWarning: () => item, onClick: (callback: () => void) => { actions.set(title, callback); return item; }, setIsLabel: () => item };
					build(item);
				} };
				options.build(menu, (...args: unknown[]) => { focusTargets.push(args[1]); }, text => text);
			} },
		});
		h.view.toggleMobileCardMenu(h.memo.id, {});
		assert.equal(titles.includes("View this day"), surface === "card-flow");
		assert.ok(titles.includes("Open daily note"));
		if (surface === "card-flow") {
			actions.get("View this day")!();
			assert.deepEqual(focusTargets, ["view"], "日期详情须在原生菜单隐藏后恢复页面焦点");
		}
	}
});

async function harness() {
	await ensureObsidianStub();
	const { KnomoView } = await import("../src/ui/KnomoView");
	const { RandomReunionController } = await import("../src/ui/RandomReunionController");
	const { ShuffleDayController } = await import("../src/ui/ShuffleDayController");
	const { buildShuffleDayStats } = await import("../src/utils/shuffleDay");
	const view = Object.create(KnomoView.prototype);
	const memo = createReferenceMemo(), other = { ...memo, id: "other" };
	const position = { scrollTop: 420, visibleCount: 10, anchor: { renderKey: "memo", offset: -10 } };
	const restored: unknown[] = [], renders: Array<{ cardFlowChangeIntent?: string } | undefined> = [], reads: string[] = [];
	const calls = { loads: 0, reviews: 0, opens: 0, history: 0, exposures: [] as string[][][] };
	let fail = false;
	Object.assign(view, { viewStateController: new KnomoViewStateController(), trashViewClosed: false, cardFlowEl: null,
		closeCardMenu: () => {}, captureHistoryBrowsePosition: () => position,
		restoreHistoryBrowsePosition: (value: unknown) => restored.push(value),
		renderUiState: (options?: { cardFlowChangeIntent?: string }) => renders.push(options),
		catalogReadService: { refreshMemoViews: async (memos: MemoViewItem[]) => memos },
	});
	view.viewStateController.activeNav = "random";
	const random = new RandomReunionController({
		loadRandomReunionMemos: async (_count, request) => { calls.loads++; calls.exposures.push(request.shownBatches.map(batch => [...batch]));
			if (fail) throw new Error("read failed"); return [memo]; },
		openRandomReunionMemo: async () => { calls.opens++; }, markRandomReunionReviewed: async () => { calls.reviews++; },
		isRandomActive: () => view.activeNav === "random" && !view.randomDayOpen, showNotice: () => {}, requestRender: () => {},
	});
	const shuffle = new ShuffleDayController({
		loadSelectedDate: async () => [memo],
		selectShuffleDay: async () => ({ status: "ready", selectedDate: "2026-10-16", memos: [memo], stats: buildShuffleDayStats([memo]) }),
		acceptSelection: async () => { calls.history++; }, isShuffleDayActive: () => true, requestRender: () => {},
	});
	Object.assign(view, { randomReunionController: random, shuffleDayController: shuffle,
		randomDayController: new ShuffleDayController({
			loadSelectedDate: async date => { reads.push(date); return [memo, other]; },
			isShuffleDayActive: () => view.randomDayOpen, requestRender: () => {},
		}),
	});
	return { view, random, shuffle, memo, position, calls, reads, restored, renders, Controller: ShuffleDayController,
		failLoad: (value: boolean) => { fail = value; } };
}

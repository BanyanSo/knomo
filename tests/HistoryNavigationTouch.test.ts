import assert from "node:assert/strict";
import test from "node:test";
import type { MemoViewItem } from "../src/types/memoView";
import { KnomoCardFlowCoordinator } from "../src/ui/KnomoCardFlowCoordinator";
import { RandomReunionController } from "../src/ui/RandomReunionController";
import { ShuffleDayController } from "../src/ui/ShuffleDayController";
import { getRecentMemoPresentation } from "../src/ui/RecentTimeFlowPresentation";
import { formatTimeBuoyDate } from "../src/utils/timeBuoyDate";
import { createMobilePopupFixture } from "./helpers/mobilePopupFixture";
import { createReferenceMemo } from "./helpers/referenceMemo";
import { createDeferred } from "./helpers/deferred";

for (const action of ["random-day-back", "refresh-random-reunion"] as const) {
	for (const focusAt of ["pointerdown", "touchend", "before-recovery"] as const) {
		for (const projection of ["ready", "failed"] as const) {
			for (const nativeClick of [false, true]) test(`${action}: Monthly=${projection}、${focusAt} 恢复焦点、原生 click=${nativeClick} 时首个触摸完成导航，按钮不中途移除`, async () => {
				const h = await harness(projection);
				try {
					if (action === "random-day-back") await h.view.openRandomDay(h.memo);
					assert.equal(h.flow.querySelectorAll("[data-action='open-catalog-settings']").length, projection === "failed" ? 1 : 0);
					const batch = h.random.getSnapshot().memos;
					const before = h.calls.loads;
					const button = h.button(action);
					h.state.focused = false;
					await h.tap(button, focusAt, nativeClick);
					if (action === "random-day-back") {
						assert.equal(h.view.randomDayOpen, false);
						assert.equal(h.random.getSnapshot().memos, batch);
						assert.equal(h.calls.loads, before);
					} else assert.equal(h.calls.loads, before + 1);
					assert.equal(h.calls.reviews, 0);
				} finally { h.close(); }
			});
		}
	}
}

test("前置 Monthly 失败提示下，同页强制重绘保留返回和换批按钮的连接及焦点", async () => {
	for (const action of ["random-day-back", "refresh-random-reunion"] as const) {
		const h = await harness("failed");
		try {
			if (action === "random-day-back") await h.view.openRandomDay(h.memo);
			const button = h.button(action), parent = button.parentElement;
			button.focus();
			const observer = h.observe(button);
			h.view.forceRebuildCardFlow();
			assert.equal(h.button(action), button);
			assert.equal(button.parentElement, parent);
			assert.equal(h.win.document.activeElement, button);
			assert.equal(h.flow.querySelectorAll("[data-action='open-catalog-settings']").length, 1);
			h.assertRetained(observer, button);
		} finally { h.close(); }
	}
});

test("连续十轮查看日期、返回和换批，每个触摸只执行一次；迟到 click 不穿透到新页面", async () => {
	const h = await harness();
	try {
		for (let round = 0; round < 10; round++) {
			h.flow.scrollTop = 420;
			await h.view.handleMemoAction("view-day", h.random.getSnapshot().memos![0]);
			const batch = h.random.getSnapshot().memos;
			h.state.focused = false;
			await h.tap(h.button("random-day-back"));
			assert.equal(h.view.randomDayOpen, false);
			assert.equal(h.random.getSnapshot().memos, batch);
			assert.equal(h.flow.scrollTop, 420);
			await h.nativeClick(h.button("refresh-random-reunion"));
			await h.advance(100);
			assert.equal(h.calls.loads, round + 1, "迟到的兼容 click 不触发换批");
			h.state.focused = false;
			await h.tap(h.button("refresh-random-reunion"), "touchend", round % 2 === 0);
			assert.equal(h.calls.loads, round + 2);
			assert.equal(h.flow.scrollTop, 0);
		}
		assert.equal(h.calls.reviews, 0);
	} finally { h.close(); }
});

test("等待首击补偿时切页、切换日期、失去活动视图或关闭，不执行旧手势", async () => {
	for (const scenario of ["leave", "date", "inactive", "closed"] as const) {
		const h = await harness();
		try {
			await h.view.openRandomDay(h.memo);
			const back = h.button("random-day-back");
			h.state.focused = false; h.state.hit = back;
			h.pointer(back, "pointerdown"); h.touch(back, "touchstart");
			h.pointer(back, "pointerup"); h.touch(back, "touchend");
			if (scenario === "leave") { h.view.activeNav = "shuffleDay"; h.view.renderUiState(); }
			if (scenario === "date") {
				await h.view.randomDayController.openDate("2026-10-17");
				h.state.hit = h.button("random-day-back");
				assert.notEqual(h.state.hit, back, "新日期必须使用新的交互节点");
			}
			if (scenario === "inactive") h.state.active = false;
			if (scenario === "closed") h.view.trashViewClosed = true;
			h.focus(); await h.advance(250);
			assert.equal(h.calls.loads, 1);
			if (scenario === "leave") assert.equal(h.view.activeNav, "shuffleDay");
			else assert.equal(h.view.randomDayOpen, true, scenario);
		} finally { h.close(); }
	}
});

test("触摸拖动、取消、长按和多指不导航；后续独立轻触仍可执行", async () => {
	for (const scenario of ["scroll", "pointercancel", "touchcancel", "long", "multi"] as const) {
		const h = await harness();
		try {
			await h.view.openRandomDay(h.memo);
			const back = h.button("random-day-back");
			h.state.focused = false; h.state.hit = back;
			h.pointer(back, "pointerdown"); h.touch(back, "touchstart");
			if (scenario === "long") await h.advance(650);
			else if (scenario === "multi") h.touch(back, "touchstart", 2);
			else back.dispatchEvent(new h.win.Event(scenario));
			h.touch(back, "touchend"); h.focus(); await h.advance(250);
			assert.equal(h.view.randomDayOpen, true, scenario);
			h.state.focused = false; await h.tap(h.button("random-day-back"));
			assert.equal(h.view.randomDayOpen, false, scenario);
		} finally { h.close(); }
	}
});

test("桌面鼠标与键盘及移动端语义点击仍直接执行，保留原卡片焦点", async () => {
	for (const desktop of [false, true]) {
		const h = await harness();
		try {
			if (desktop) h.view.currentLayout = "desktop-wide";
			await h.view.openRandomDay(h.memo);
			await h.nativeClick(h.button("random-day-back"), desktop ? 1 : 0);
			await h.advance(150);
			assert.equal(h.view.randomDayOpen, false);
			if (desktop) assert.equal(h.win.document.activeElement, h.flow.querySelector(".knomo-card-menu"));
			await h.nativeClick(h.button("refresh-random-reunion"), 0);
			await h.advance(150);
			assert.equal(h.calls.loads, 2);
		} finally { h.close(); }
	}
});

test("日期加载、失败、空态和就绪之间更新，以及同页强制重绘，保留返回按钮和父节点", async () => {
	const h = await harness();
	try {
		const pending = createDeferred<MemoViewItem[]>();
		h.state.dayRead = async () => { await pending.promise; throw new Error("unreadable"); };
		const opening = h.view.openRandomDay(h.memo);
		const back = h.button("random-day-back"), parent = back.parentElement;
		const observer = h.observe(back);
		h.view.renderCardFlow();
		assert.equal(h.button("random-day-back"), back);
		pending.resolve([]); await opening;
		assert.equal(h.button("random-day-back"), back);
		h.state.dayRead = async () => [];
		await h.view.randomDayController.reloadSelectedDate();
		assert.equal(h.button("random-day-back"), back);
		h.state.dayRead = async () => [h.memo];
		await h.view.randomDayController.reloadSelectedDate();
		h.view.forceRebuildCardFlow();
		assert.equal(h.button("random-day-back"), back);
		assert.equal(back.parentElement, parent);
		assert.match(h.flow.querySelector(".knomo-shuffle-day-summary")!.textContent!, /^1 memo/);
		h.assertRetained(observer, back);
	} finally { h.close(); }
});

test("随机列表有卡片、空批次、读取失败和恢复后，同页换批按钮不被重建", async () => {
	const h = await harness();
	try {
		const shuffle = h.button("refresh-random-reunion"), parent = shuffle.parentElement;
		const observer = h.observe(shuffle);
		h.random.reconcileMemos([], h.random.getSnapshot().memos!);
		h.view.renderUiState();
		assert.match(h.flow.querySelector(".knomo-list-summary")!.textContent!, /^0 /);
		h.state.fail = true;
		await h.view.refreshHistorySelection("random");
		h.state.fail = false;
		await h.view.refreshHistorySelection("random");
		assert.equal(h.button("refresh-random-reunion"), shuffle);
		assert.equal(shuffle.parentElement, parent);
		assert.match(h.flow.querySelector(".knomo-list-summary")!.textContent!, /^1 /);
		h.assertRetained(observer, shuffle);
	} finally { h.close(); }
});

async function harness(projection: "ready" | "failed" = "ready") {
	const f = await createMobilePopupFixture();
	const { KnomoView } = await import("../src/ui/KnomoView");
	const { Platform } = await import("obsidian");
	const platform = Platform as unknown as { isMobile: boolean };
	const wasMobile = platform.isMobile; platform.isMobile = true;
	const view = f.view as typeof f.view & Record<string, any>;
	const win = f.win, doc = win.document;
	f.root.replaceChildren();
	Object.assign(win.HTMLElement.prototype, { hasClass(this: HTMLElement, cls: string) { return this.classList.contains(cls); },
		findAll(this: HTMLElement, selector: string) { return [...this.querySelectorAll(selector)]; } });
	const flow = f.root.createDiv({ cls: "knomo-card-flow" });
	const memo = createReferenceMemo();
	const state = { focused: true, active: true, fail: false, now: 0, hit: null as Element | null,
		dayRead: async (): Promise<MemoViewItem[]> => [memo] };
	const calls = { loads: 0, reviews: 0 };
	const timers = new Map<number, { at: number; run: () => void }>(); let timerId = 0;
	win.setTimeout = (run, delay = 0) => { timers.set(++timerId, { at: state.now + delay, run: run as () => void }); return timerId; };
	win.clearTimeout = id => { if (id !== undefined) timers.delete(id); };
	win.requestAnimationFrame = run => win.setTimeout(() => run(state.now), 16);
	win.cancelAnimationFrame = id => win.clearTimeout(id);
	win.performance.now = () => state.now;
	doc.hasFocus = () => state.focused;
	doc.elementFromPoint = () => state.hit;
	const scope = view.getRenderScope();
	Object.assign(view, { containerEl: { doc, win }, rootEl: f.root, cardFlowEl: flow, composerOpen: false,
		mobileSearchController: { isOpen: false }, mobileViewFocusRecovery: null, trashViewClosed: false,
		app: { workspace: { getActiveViewOfType: () => state.active ? view : null } },
		register: scope.register, registerDomEvent: scope.registerDomEvent,
		lastKnownLocalDate: formatTimeBuoyDate(new Date()), recentLifecycleKey: "", cardFlowError: null,
		cardFlowCoordinator: new KnomoCardFlowCoordinator(), renderedCardMemos: new Map(),
		catalogCoverage: null, catalogStatus: { content: "ready", catalog: "complete", projection },
		settingsService: { getSettings: () => ({ timeBuoyEnabled: false, recentTimeFlowEnabled: false }) },
		trashMemoController: { getSnapshot: () => ({ trashLoading: false, trashError: null, trashMemos: [], trashCount: 0 }) },
		mobileHeaderTitleController: { getAnchor: () => null },
		catalogReadService: { refreshMemoViews: async (memos: MemoViewItem[]) => memos },
		recordStatsViewStateController: { clearRendered() {} },
		cardImageCache: { capture() {} }, memoMarkdownRenderer: { clear() {}, refreshSearchHits() {} },
		cardImageLoadQueue: { clear() {}, forget() {} },
		syncUiChrome() {}, renderStats() {}, renderTags() {}, renderTrashCount() {}, renderMobileSearchResults() {},
		clearLoadingIndicators() {}, revealLoadingAfterDelay: () => false,
		stopDateChangeWatcher() {}, startDateChangeWatcher() {},
		renderHistoryLoadMore() {}, renderCardFlowSentinelIfNeeded() {}, syncCardMenuState() {},
		renderTimeBuoyIntro: () => null, shouldShowTimeBuoyIntro: () => false,
		getCatalogPresentationTotalCount: () => null,
		getCardFlowScrollTop: () => flow.scrollTop, restoreCardFlowScrollTop: (top: number) => { flow.scrollTop = top; },
		removeCardElement: (card: HTMLElement) => card.remove(),
		// 隔离 Memo 正文绘制和图片，保留头部、排序、页面状态及滚动恢复的生产实现。
		renderCardForMode: (container: HTMLElement, item: MemoViewItem) => { const card = container.createEl("article", {
			cls: "knomo-card", attr: { "data-memo-id": item.id, "data-memo-render-key": item.id,
				"data-time-presentation": JSON.stringify(getRecentMemoPresentation(item, view.recentTimeFlowContext).time) },
		}); card.createEl("button", { cls: "knomo-card-menu" }); return card; },
		startCardFeed: (items: MemoViewItem[]) => {
			view.prepareRecentTimeFlow();
			for (const item of items) { view.renderCardForMode(flow, item); view.renderedCardMemos.set(item.id, item); }
			view.restorePendingCardFlowScrollTop(view.renderGeneration);
		},
	});
	view.viewStateController.activeNav = "random";
	const random = new RandomReunionController({
		loadRandomReunionMemos: async () => { calls.loads++; if (state.fail) throw new Error("unreadable"); return [{ ...memo }]; },
		openRandomReunionMemo: async () => {}, markRandomReunionReviewed: async () => { calls.reviews++; },
		isRandomActive: () => !view.trashViewClosed && view.activeNav === "random" && !view.randomDayOpen,
		showNotice() {}, requestRender: () => view.renderUiState(),
	});
	view.randomReunionController = random;
	view.shuffleDayController = new ShuffleDayController({ loadSelectedDate: async () => [], isShuffleDayActive: () => false, requestRender() {} });
	view.randomDayController = new ShuffleDayController({ loadSelectedDate: () => state.dayRead(),
		isShuffleDayActive: () => !view.trashViewClosed && view.randomDayOpen, requestRender: () => view.renderRandomDay() });
	// 不替换 renderUiState、renderCardFlow、日期检查或动作路由。
	delete view.renderUiState;
	assert.equal(view.renderUiState, (KnomoView.prototype as any).renderUiState);
	view.userActionController = view.createUserActionController();
	view.registerWindowFocusEvent();
	view.registerMobileMenuTriggerEvents();
	await random.refresh();
	const button = (action: string) => { const element = flow.querySelector<HTMLButtonElement>(`[data-action='${action}']`); assert.ok(element, action); return element; };
	const advance = async (ms: number) => {
		const end = state.now + ms;
		for (;;) {
			const next = [...timers].filter(([, value]) => value.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
			if (!next) break;
			timers.delete(next[0]); state.now = next[1].at; next[1].run(); await settle();
		}
		state.now = end; await settle();
	};
	const focus = () => { state.focused = true; win.dispatchEvent(new win.Event("focus")); };
	const observe = (_button: HTMLElement) => { const records: MutationRecord[] = [];
		const observer = new win.MutationObserver(batch => records.push(...batch)); observer.observe(flow, { childList: true, subtree: true }); return { observer, records }; };
	const assertRetained = ({ observer, records }: ReturnType<typeof observe>, target: HTMLElement) => {
		const removed = [...records, ...observer.takeRecords()].flatMap(record => [...record.removedNodes]); observer.disconnect();
		assert.ok(!removed.some(node => node === target || node.contains(target)), "手势期间不得移除按钮或包含按钮的父节点");
	};
	const touch = (target: HTMLElement, type: string, fingers = 1) => { const event = new win.Event(type, { bubbles: true, cancelable: true });
		const points = Array.from({ length: fingers }, (_, identifier) => ({ identifier: identifier + 1, clientX: 20, clientY: 20 }));
		Object.defineProperties(event, { timeStamp: { value: state.now },
			touches: { value: type === "touchend" ? [] : points }, changedTouches: { value: points } }); target.dispatchEvent(event); };
	return { view, random, memo, flow, win, state, calls, button, focus, advance, observe, assertRetained,
		pointer: f.pointer, touch, nativeClick: f.click,
		async tap(target: HTMLElement, focusAt = "touchend", nativeClick = false) {
			const observer = observe(target); state.hit = target;
			f.pointer(target, "pointerdown"); if (focusAt === "pointerdown") focus();
			touch(target, "touchstart"); await advance(30); f.pointer(target, "pointerup"); touch(target, "touchend");
			if (focusAt === "before-recovery") await advance(90);
			if (focusAt !== "pointerdown") focus();
			assertRetained(observer, target);
			if (nativeClick) await f.click(target);
			await advance(150);
		},
		close() { view.mobileViewFocusRecovery?.cancel(); platform.isMobile = wasMobile; f.close(); },
	};
}

async function settle(): Promise<void> { for (let i = 0; i < 12; i++) await Promise.resolve(); }

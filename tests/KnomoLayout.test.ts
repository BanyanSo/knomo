import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { DesktopDrawerFocus, getDrawerWidth, resolveLayout } from "../src/ui/KnomoLayout";
import { DesktopSidebarStateController } from "../src/ui/DesktopSidebarStateController";
import { KnomoViewStateController } from "../src/ui/KnomoViewStateController";
import { ensureObsidianStub } from "./helpers/obsidianStub";

test("布局按小数 border-box 宽度判断，Mobile 优先，隐藏保留状态", () => {
	for (const width of [180, 240, 320, 480, 640, 779, 779.5]) assert.equal(resolveLayout(false, width), "desktop-narrow");
	for (const width of [780, 781, 1024]) assert.equal(resolveLayout(false, width), "desktop-wide");
	for (const width of [0, 390, 768, 834, 1024]) assert.equal(resolveLayout(true, width), "mobile");
	assert.equal(resolveLayout(false, 0), "desktop-narrow");
	assert.equal(resolveLayout(false, 0, "desktop-wide"), "desktop-wide");
	assert.equal(resolveLayout(false, Number.NaN, "desktop-wide"), "desktop-wide");
});

test("Drawer 在 258px 边界保留留白，极窄时允许占满且不改变偏好", () => {
	for (const [width, expected] of [[320, 272], [258, 210], [257, 257], [240, 240], [180, 180], [0, 0]]) {
		assert.equal(getDrawerWidth(width!, 300), expected);
	}
	assert.equal(getDrawerWidth(700, 999), 300);
	assert.equal(getDrawerWidth(700, 100), 210);
	const sidebar = new DesktopSidebarStateController();
	sidebar.setFromSettings(300, true);
	getDrawerWidth(180, sidebar.getSnapshot().width);
	assert.deepEqual(sidebar.getSnapshot(), { width: 300, collapsed: true });
});

function domHarness() {
	const dom = new JSDOM('<body><div id="root"><aside class="knomo-sidebar"><button data-action="close-drawer">Close</button><button id="last">Nav</button></aside><main class="knomo-main"><button class="knomo-compact-menu-btn">Open</button><button class="knomo-sidebar-toggle">Wide</button></main></div><button id="other">Other pane</button></body>', { pretendToBeVisual: true });
	const doc = dom.window.document;
	const root = doc.getElementById("root")!;
	for (const el of Array.from(doc.querySelectorAll<HTMLElement>("button"))) el.getClientRects = () => [new dom.window.DOMRect()] as unknown as DOMRectList;
	return { dom, doc, root, sidebar: root.querySelector<HTMLElement>("aside")!, main: root.querySelector<HTMLElement>("main")!, entry: root.querySelector<HTMLElement>(".knomo-compact-menu-btn")!, close: root.querySelector<HTMLElement>('[data-action="close-drawer"]')! };
}

test("Drawer 隔离主内容、循环键盘焦点、忽略 IME 并恢复入口", () => {
	const h = domHarness();
	const focus = new DesktopDrawerFocus();
	try {
		h.entry.focus();
		focus.sync(h.root, true, true, true);
		assert.equal(h.doc.activeElement, h.close);
		assert.equal(h.main.inert, true);
		assert.equal(h.sidebar.inert, false);
		const last = h.doc.getElementById("last")!;
		last.focus();
		focus.handleKeydown(new h.dom.window.KeyboardEvent("keydown", { key: "Tab", cancelable: true }), h.sidebar, () => assert.fail());
		assert.equal(h.doc.activeElement, h.close);
		let closed = 0;
		focus.handleKeydown(new h.dom.window.KeyboardEvent("keydown", { key: "Escape", isComposing: true }), h.sidebar, () => closed++);
		assert.equal(closed, 0);
		focus.handleKeydown(new h.dom.window.KeyboardEvent("keydown", { key: "Escape", cancelable: true }), h.sidebar, () => {
			closed++;
			focus.sync(h.root, true, false, true);
		});
		assert.equal(closed, 1);
		assert.equal(h.doc.activeElement, h.entry);
		assert.equal(h.main.inert, false);
		assert.equal(h.sidebar.inert, true);
	} finally { h.dom.window.close(); }
});

test("Drawer 关闭不抢其他 Pane 焦点，布局切换恢复可见入口", () => {
	const h = domHarness();
	const focus = new DesktopDrawerFocus();
	try {
		h.entry.focus();
		focus.sync(h.root, true, true, true);
		h.doc.getElementById("other")!.focus();
		focus.sync(h.root, false, false, true);
		assert.equal(h.doc.activeElement?.id, "other");
		h.entry.focus();
		focus.sync(h.root, true, true, true);
		h.entry.getClientRects = () => [] as unknown as DOMRectList;
		focus.sync(h.root, false, false, true);
		assert.equal(h.doc.activeElement, h.root.querySelector(".knomo-sidebar-toggle"));
	} finally { h.dom.window.close(); }
});

test("实际 View 跨断点清理临时状态，保留编辑与查询，同模式不关闭 Drawer", async () => {
	await ensureObsidianStub();
	const { KnomoView } = await import("../src/ui/KnomoView");
	const dom = new JSDOM("<body></body>");
	let width = 900;
	const state = new KnomoViewStateController();
	state.searchQuery = "unfinished search";
	state.setSidebarNav("things");
	const sidebar = new DesktopSidebarStateController();
	sidebar.setFromSettings(300, true);
	const editor = { selection: { anchor: 2, head: 7 }, history: ["before", "draft"], composing: true };
	let cleanup = 0;
	const view = Object.assign(Object.create(KnomoView.prototype), {
		currentLayout: "desktop-wide", viewStateController: state, popupState: { scopeMenuOpen: true },
		containerEl: { ownerDocument: dom.window.document, getBoundingClientRect: () => ({ width }) },
		rootEl: null, inputEl: { composer: { view: { state: editor } }, get value() { return "draft"; }, set value(_: string) { assert.fail("不得重写草稿"); } },
		desktopSidebarStateController: sidebar, sidebarResizerEl: null,
		closeTimeBuoyPicker: () => cleanup++, closeCardMenu: () => {}, syncRootState: () => {},
	}) as { currentLayout: string; mobileDrawerOpen: boolean; updateCurrentLayout(): void; inputEl: { composer: { view: { state: object } } } };
	try {
		width = 779.5;
		view.updateCurrentLayout();
		assert.equal(view.currentLayout, "desktop-narrow");
		view.mobileDrawerOpen = true;
		width = 320;
		view.updateCurrentLayout();
		assert.equal(view.mobileDrawerOpen, true);
		assert.equal(cleanup, 1);
		width = 0;
		view.updateCurrentLayout();
		assert.equal(view.currentLayout, "desktop-narrow");
		for (const next of [780, 779, 781, 240, 900]) {
			width = next;
			view.updateCurrentLayout();
			assert.equal(view.mobileDrawerOpen, false);
		}
		assert.equal(state.searchQuery, "unfinished search");
		assert.equal(state.activeNav, "things");
		assert.equal(view.inputEl.composer.view.state, editor);
		assert.deepEqual(sidebar.getSnapshot(), { width: 300, collapsed: true });
	} finally { dom.window.close(); }
});

test("取消 Wide 拖拽保留最后有效宽度并拒绝旧 pointer 更新", () => {
	const sidebar = new DesktopSidebarStateController();
	sidebar.setFromSettings(248, false);
	sidebar.startResize(7, 100);
	sidebar.resize(7, 125);
	assert.equal(sidebar.cancelResize(), 7);
	assert.equal(sidebar.resize(7, 180), false);
	assert.equal(sidebar.getSnapshot().width, 273);
	assert.equal(sidebar.cancelResize(), null);
});

test("布局观察器随所属窗口迁移，旧回调失效且关闭释放监听", async () => {
	await ensureObsidianStub();
	const { KnomoView } = await import("../src/ui/KnomoView");
	const first = new JSDOM("<body></body>");
	const second = new JSDOM("<body></body>");
	let disconnected = 0;
	let measures = 0;
	const callbacks: (() => void)[] = [];
	class Observer {
		constructor(callback: () => void) { callbacks.push(callback); }
		observe() {}
		disconnect() { disconnected++; }
	}
	Object.assign(first.window, { ResizeObserver: Observer });
	Object.assign(second.window, { ResizeObserver: Observer });
	const view = Object.assign(Object.create(KnomoView.prototype), {
		containerEl: { win: first.window }, rootEl: null, layoutWindow: null, layoutObserver: null,
		layoutWindowCleanup: null, trashViewClosed: false, finishSidebarResize: () => {},
		syncLayoutMeasurements: () => measures++,
	}) as { containerEl: { win: unknown }; startLayoutObserver(): void; stopLayoutObserver(): void };
	try {
		view.startLayoutObserver();
		view.startLayoutObserver();
		assert.equal(callbacks.length, 1);
		view.containerEl.win = second.window;
		view.startLayoutObserver();
		assert.equal(disconnected, 1);
		assert.equal(callbacks.length, 2);
		const before = measures;
		callbacks[0]!();
		first.window.dispatchEvent(new first.window.Event("resize"));
		assert.equal(measures, before);
		second.window.dispatchEvent(new second.window.Event("resize"));
		assert.equal(measures, before + 1);
		view.stopLayoutObserver();
		callbacks[1]!();
		second.window.dispatchEvent(new second.window.Event("resize"));
		assert.equal(measures, before + 1);
		assert.equal(disconnected, 2);
	} finally { first.window.close(); second.window.close(); }
});

test("跨断点转移搜索焦点和尚未 debounce 的文本，组合结束前延迟换位", async () => {
	await ensureObsidianStub();
	const { KnomoView } = await import("../src/ui/KnomoView");
	const dom = new JSDOM('<body><div id="root"><input id="wide" type="search"><input id="narrow" type="search"></div></body>');
	const wide = dom.window.document.getElementById("wide") as HTMLInputElement;
	const narrow = dom.window.document.getElementById("narrow") as HTMLInputElement;
	wide.value = "pending query";
	wide.focus();
	const view = Object.assign(Object.create(KnomoView.prototype), {
		currentLayout: "desktop-wide", layoutSearchComposing: true,
		containerEl: { ownerDocument: dom.window.document, getBoundingClientRect: () => ({ width: 779 }) },
		rootEl: dom.window.document.getElementById("root"), sidebarEl: null,
		desktopSearchInputEl: wide, compactInlineSearchInputEl: narrow, compactSearchInputEl: null,
		viewStateController: new KnomoViewStateController(), popupState: { scopeMenuOpen: false },
		finishSidebarResize: () => {}, closeTimeBuoyPicker: () => {}, closeCardMenu: () => {}, syncRootState: () => {},
	}) as { currentLayout: string; layoutSearchComposing: boolean; updateCurrentLayout(): void };
	try {
		view.updateCurrentLayout();
		assert.equal(view.currentLayout, "desktop-wide");
		assert.equal(dom.window.document.activeElement, wide);
		view.layoutSearchComposing = false;
		view.updateCurrentLayout();
		assert.equal(view.currentLayout, "desktop-narrow");
		assert.equal(dom.window.document.activeElement, narrow);
		assert.equal(narrow.value, "pending query");
	} finally { dom.window.close(); }
});

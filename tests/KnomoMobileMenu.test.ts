import test from "node:test";
import assert from "node:assert/strict";
import type { Menu, MenuItem, MenuPositionDef } from "obsidian";
import type { MemoViewItem } from "../src/types/memoView";
import type { MemoAction } from "../src/ui/KnomoActionDispatch";
import type { KnomoMobileMenu } from "../src/ui/KnomoMobileMenu";
import { createMobilePopupFixture } from "./helpers/mobilePopupFixture";
import { TITLE_MODE_OPTIONS } from "../src/ui/viewNavigation";

interface MenuView {
	currentLayout: string;
	composerOpen: boolean;
	mobileSearchPageOpen: boolean;
	mobileDrawerOpen: boolean;
	mobileMenuController: KnomoMobileMenu;
	toggleCardMenu(id: string | null): void;
	toggleScopeMenu(): void;
	syncCardMenuState(): void;
	prepareDesktopDrawer(): boolean;
	handleMobileBack(event: Event): void;
	app: { workspace: { getActiveViewOfType(): unknown } };
	mobileComposerController: { isKeyboardOpen(): boolean };
	closeTimeBuoyPicker(): void;
	timeBuoyPickerState: object | null;
}

async function createHarness() {
	const f = await createMobilePopupFixture("cancel-edit");
	const { KnomoMobileMenu } = await import("../src/ui/KnomoMobileMenu");
	const { KnomoView } = await import("../src/ui/KnomoView");
	const menus: FakeMenu[] = [];
	const controller = new KnomoMobileMenu(() => { const menu = new FakeMenu(f.win.document); menus.push(menu); return menu as unknown as Menu; });
	const originalMemo = f.view.editingMemo!;
	let latestMemo = originalMemo;
	const actions: Array<{ action: MemoAction; memo: MemoViewItem }> = [];
	const scopes: string[] = [];
	const trigger = f.root.createEl("button", { text: "Scope" });
	Object.assign(f.win.HTMLElement.prototype, {
		findAll(this: HTMLElement, selector: string) { return Array.from(this.querySelectorAll(selector)); },
		find(this: HTMLElement, selector: string) { return this.querySelector(selector); },
	});
	const view = Object.assign(f.view as unknown as MenuView, {
		rootEl: f.root, cardFlowEl: f.root, mobileMenuController: controller,
		containerEl: { doc: f.win.document },
		findMemoById: () => latestMemo,
		handleMemoAction: async (action: MemoAction, memo: MemoViewItem) => { actions.push({ action, memo }); },
		getTitleState: () => ({ activeNav: "all", activeTagKey: null, scopeFilter: "with-image" }),
		getTitlePopoverAnchor: () => trigger,
		setTitleMode: (mode: string) => scopes.push(mode),
	});
	Object.defineProperty(view, "mobileSearchResultsEl", { configurable: true, value: null });
	Object.defineProperty(view, "mobileSearchPageOpen", { configurable: true, writable: true, value: true });
	view.syncCardMenuState = (KnomoView.prototype as unknown as MenuView).syncCardMenuState.bind(view);
	return { f, view, controller, menus, actions, scopes, originalMemo, trigger,
		replaceMemo() { latestMemo = { ...originalMemo, contentSnapshot: "同一列表 key 下的新正文" }; },
		close() { controller.close(); f.close(); },
	};
}

test("mobile Card Menu delegates to host and retains the selected observation instead of looking up a new memo", async () => {
	const h = await createHarness();
	try {
		h.view.toggleCardMenu(h.originalMemo.id);
		const menu = h.menus[0];
		assert.equal(h.controller.kind, "card");
		assert.equal(menu.items.length, 7);
		assert.equal(menu.noIcon, false);
		assert.deepEqual(menu.items.map(item => item.icon), ["pencil", "quote", "calendar-days", "copy", "link", "trash-2", "text"]);
		assert.equal(menu.items.at(-1)!.label, true);
		assert.equal(menu.items[5].warning, true);
		assert.equal(menu.doc, h.f.win.document);
		assert.equal(h.f.card.classList.contains("is-menu-open"), false, "移动端不再显示卡片内 Popover");
		assert.equal(h.f.card.querySelector(".knomo-card-menu")?.getAttribute("aria-expanded"), "true");
		h.replaceMemo();
		menu.items[0].click!(); menu.items[0].click!();
		assert.deepEqual(h.actions, [{ action: "edit", memo: h.originalMemo }]);
		assert.equal(h.controller.kind, null);
		assert.equal(h.f.popup.activeMenuMemoId, null);
		assert.equal(h.view.mobileSearchPageOpen, true, "选项不顺带退出底层 Search");
	} finally { h.close(); }
});

test("Scope Menu keeps all nine modes and checks only the current mode; delayed old hide cannot close a new menu", async () => {
	const h = await createHarness();
	try {
		h.view.toggleCardMenu(h.originalMemo.id);
		const old = h.menus[0]; old.deferHide = true;
		h.view.toggleScopeMenu();
		const menu = h.menus[1];
		assert.equal(h.controller.kind, "scope");
		assert.ok(menu.items[0].dom.closest(".knomo-mobile-menu-scope"));
		assert.deepEqual(menu.items.map(item => item.title), TITLE_MODE_OPTIONS.map(item => item.label));
		assert.deepEqual(menu.items.map((item, index) => item.checked ? index : -1).filter(index => index >= 0), [4]);
		old.hidden!(); old.items[0].click!();
		assert.equal(h.controller.kind, "scope");
		assert.equal(h.f.popup.scopeMenuOpen, true);
		assert.deepEqual(h.actions, []);
		// 模拟宿主先隐藏再派发本次选项的合法顺序。
		menu.hidden!(); menu.items[3].click!();
		assert.deepEqual(h.scopes, ["with-link"]);
		assert.equal(h.f.popup.scopeMenuOpen, false);
	} finally { h.close(); }
});

test("opening Drawer invalidates native menu callbacks; removing a trigger releases its menu", async () => {
	const h = await createHarness();
	try {
		h.view.toggleScopeMenu(); const scope = h.menus[0];
		assert.equal(h.view.prepareDesktopDrawer(), true);
		assert.equal(h.controller.kind, null);
		scope.items[0].click!(); assert.deepEqual(h.scopes, []);
		h.view.toggleCardMenu(h.originalMemo.id); const card = h.menus[1];
		h.f.card.remove();
		await Promise.resolve();
		assert.equal(h.controller.kind, null);
		card.items[0].click!(); assert.deepEqual(h.actions, []);
	} finally { h.close(); }
});

test("the first outside tap closes Card and Scope without reaching underlying UI, even if bubbling is consumed", async () => {
	for (const kind of ["card", "scope"] as const) {
		const h = await createHarness();
		try {
			if (kind === "card") h.view.toggleCardMenu(h.originalMemo.id);
			else h.view.toggleScopeMenu();
			const menu = h.menus[0];
			let backgroundCalls = 0;
			h.f.win.document.body.addEventListener("click", () => backgroundCalls++);
			// 模拟宿主关闭回调之前，其他监听器消费了第一次蒙版点击。
			menu.background!.addEventListener("click", event => event.stopPropagation(), { once: true });
			await h.f.click(menu.background!);
			assert.equal(h.controller.kind, null, "一次完整点击就应开始关闭");
			assert.equal(menu.hideCalls, 1);
			assert.equal(backgroundCalls, 0, "关闭菜单不能顺带点击底层页面");
			assert.equal(h.view.composerOpen, true);
			assert.equal(h.view.mobileSearchPageOpen, true);
			assert.deepEqual(h.actions, []);
			assert.deepEqual(h.scopes, []);
			await h.f.click(h.f.win.document.body.createEl("button", { text: "下一次普通点击" }));
			assert.equal(backgroundCalls, 1, "关闭后的捕获监听器必须释放");
		} finally { h.close(); }
	}
});

// iOS 触摸结束后不保证有兼容 click；不能用直接派发 click 代替首次轻触。
function touch(h: Awaited<ReturnType<typeof createHarness>>, target: Element, type: string, options: { x?: number; y?: number; ids?: number[]; time?: number } = {}) {
	Object.defineProperty(h.f.win.document, "elementFromPoint", { configurable: true, value: () => target });
	const ids = options.ids ?? [1];
	const points = ids.map(identifier => ({ identifier, target, clientX: options.x ?? 20, clientY: options.y ?? 20 }));
	const event = new h.f.win.Event(type, { bubbles: true, cancelable: true });
	Object.defineProperties(event, {
		touches: { value: type === "touchend" || type === "touchcancel" ? [] : points },
		changedTouches: { value: points },
	});
	if (options.time !== undefined) Object.defineProperty(event, "timeStamp", { value: options.time });
	target.dispatchEvent(event);
	return event;
}

function tap(h: Awaited<ReturnType<typeof createHarness>>, target: Element) {
	touch(h, target, "touchstart");
	return touch(h, target, "touchend");
}

test("the first iOS touch closes Card and Scope without waiting for a compatibility click", async () => {
	for (const kind of ["card", "scope"] as const) {
		const h = await createHarness();
		try {
			if (kind === "card") h.view.toggleCardMenu(h.originalMemo.id); else h.view.toggleScopeMenu();
			const menu = h.menus[0];
			const end = tap(h, menu.background!);
			assert.equal(h.controller.kind, null, "首次 touchend 就关闭，不依赖第二次触摸生成 click");
			assert.equal(menu.hideCalls, 1);
			assert.equal(end.defaultPrevented, true, "阻止浏览器在关闭后向底层补发兼容点击");
			assert.equal(h.view.mobileSearchPageOpen, true);
			assert.equal(h.view.composerOpen, true);
		} finally { h.close(); }
	}
});

test("the first iOS menu-item touch executes the selected Card or Scope action once", async () => {
	for (const kind of ["card", "scope"] as const) {
		const h = await createHarness();
		try {
			if (kind === "card") h.view.toggleCardMenu(h.originalMemo.id); else h.view.toggleScopeMenu();
			const item = h.menus[0].items[kind === "card" ? 0 : 3];
			const end = tap(h, item.dom.querySelector("span")!);
			assert.equal(h.controller.kind, null);
			assert.equal(end.defaultPrevented, true);
			assert.deepEqual(h.actions, kind === "card" ? [{ action: "edit", memo: h.originalMemo }] : []);
			assert.deepEqual(h.scopes, kind === "scope" ? ["with-link"] : []);
			await h.f.click(item.dom);
			assert.equal(h.actions.length + h.scopes.length, 1, "迟到的兼容点击不能再次执行");
		} finally { h.close(); }
	}
});

test("menu touch activation yields to scrolling, host gestures, cancellation, multitouch and long presses", async () => {
	for (const scenario of ["move", "scroll", "cancel", "multi", "long", "release-outside", "host-gesture"] as const) {
		const h = await createHarness();
		try {
			h.view.toggleScopeMenu();
			const item = h.menus[0].items[3].dom;
			// 宿主在元素的 touchstart 中先注册 window 的手势回调。
			if (scenario === "host-gesture") item.addEventListener("touchstart", () => {
				h.f.win.addEventListener("touchmove", event => event.preventDefault(), { once: true, passive: false });
			}, { once: true });
			touch(h, item, "touchstart", { time: 100 });
			if (scenario === "move") touch(h, item, "touchmove", { x: 40 });
			if (scenario === "host-gesture") touch(h, item, "touchmove", { y: 21 });
			if (scenario === "scroll") item.closest(".menu")!.dispatchEvent(new h.f.win.Event("scroll"));
			if (scenario === "cancel") touch(h, item, "touchcancel");
			if (scenario === "multi") touch(h, item, "touchstart", { ids: [1, 2] });
			touch(h, scenario === "release-outside" ? h.menus[0].items[0].dom : item, "touchend", { time: scenario === "long" ? 800 : 200 });
			assert.deepEqual(h.scopes, [], scenario);
			assert.equal(h.controller.kind, "scope", scenario);
			tap(h, item);
			assert.deepEqual(h.scopes, ["with-link"], "取消后新的首次轻触必须立即有效: " + scenario);
		} finally { h.close(); }
	}
});

test("closing or replacing a menu cancels its in-flight touch and releases listeners", async () => {
	const h = await createHarness();
	try {
		h.view.toggleCardMenu(h.originalMemo.id);
		const old = h.menus[0]; old.deferHide = true;
		touch(h, old.items[0].dom, "touchstart");
		h.view.toggleScopeMenu();
		touch(h, old.items[0].dom, "touchend");
		assert.deepEqual(h.actions, []);
		assert.equal(h.controller.kind, "scope");
		tap(h, h.menus[1].items[3].dom);
		assert.deepEqual(h.scopes, ["with-link"]);
		const ordinary = h.f.win.document.body.createEl("button", { text: "下层按钮" });
		assert.equal(tap(h, ordinary).defaultPrevented, false, "菜单关闭不能残留全局触摸拦截");
		old.hidden!();
		assert.equal(h.controller.kind, null);
	} finally { h.close(); }
});

test("the opening click stays open and pointer movement on the background does not dismiss a menu", async () => {
	const h = await createHarness();
	try {
		h.view.composerOpen = false;
		await h.f.click(h.f.card.querySelector(".knomo-card-menu")!);
		assert.equal(h.controller.kind, "card", "不能把打开菜单的同一次点击作为外部点击");
		const background = h.menus[0].background!;
		h.f.pointer(background, "pointerdown");
		h.f.pointer(background, "pointermove", { x: 80, y: 60 });
		h.f.pointer(background, "pointercancel");
		assert.equal(h.controller.kind, "card", "手指滑动或取消不等于点击关闭");
		await h.f.click(background);
		assert.equal(h.controller.kind, null);
	} finally { h.close(); }
});

test("a menu item click remains inside the menu and executes exactly once", async () => {
	const h = await createHarness();
	try {
		h.view.toggleCardMenu(h.originalMemo.id);
		await h.f.click(h.menus[0].items[0].dom);
		assert.deepEqual(h.actions, [{ action: "edit", memo: h.originalMemo }]);
		assert.equal(h.controller.kind, null);
	} finally { h.close(); }
});

test("a surface change after host hide invalidates a delayed selection", async () => {
	const h = await createHarness();
	try {
		h.view.toggleScopeMenu();
		const menu = h.menus[0];
		menu.hidden!();
		h.view.prepareDesktopDrawer();
		menu.items[0].click!();
		assert.deepEqual(h.scopes, [], "自然隐藏后的选项也不能跨越下一次页面切换");
	} finally { h.close(); }
});

test("desktop Card and Scope keep their existing popovers and never instantiate a host menu", async () => {
	const h = await createHarness();
	try {
		h.view.currentLayout = "desktop-wide";
		Object.assign(h.view, { positionOpenCardMenu: () => undefined });
		h.view.toggleCardMenu(h.originalMemo.id);
		assert.equal(h.f.card.classList.contains("is-menu-open"), true);
		h.view.toggleScopeMenu();
		assert.equal(h.f.popup.activeMenuMemoId, null);
		assert.equal(h.f.popup.scopeMenuOpen, true);
		assert.equal(h.menus.length, 0);
	} finally { h.close(); }
});

test("mobile back belongs to the active view, dismisses the keyboard first and leaves host Modal/Menu to the host", async () => {
	const h = await createHarness();
	const { Platform } = await import("obsidian");
	const platform = Platform as unknown as { isMobile: boolean };
	const wasMobile = platform.isMobile;
	platform.isMobile = true;
	let keyboard = true, blurCalls = 0;
	h.view.app = { workspace: { getActiveViewOfType: () => h.view } };
	h.view.mobileComposerController.isKeyboardOpen = () => keyboard;
	h.f.view.inputEl.blur = () => { blurCalls++; };
	Object.assign(h.view, { closeMobileSearchPage: () => { h.view.mobileSearchPageOpen = false; } });
	const back = () => { const event = new h.f.win.Event("backbutton", { cancelable: true }); h.view.handleMobileBack(event); return event; };
	try {
		const before = h.f.snapshot();
		assert.equal(back().defaultPrevented, true);
		assert.equal(blurCalls, 1); assert.equal(h.view.composerOpen, true);
		keyboard = false;
		const modal = h.f.win.document.body.createDiv({ cls: "modal-container" });
		assert.equal(back().defaultPrevented, false); assert.equal(h.view.composerOpen, true);
		modal.remove();
		h.view.toggleCardMenu(h.originalMemo.id);
		assert.equal(back().defaultPrevented, false, "宿主 Menu 自己处理历史返回");
		h.controller.close();
		assert.equal(back().defaultPrevented, true); assert.equal(h.view.composerOpen, false);
		assert.equal(h.f.snapshot().text, before.text); assert.equal(h.f.snapshot().editing, before.editing);
		assert.equal(h.view.mobileSearchPageOpen, true);
		h.view.app.workspace.getActiveViewOfType = () => null;
		assert.equal(back().defaultPrevented, false); assert.equal(h.view.mobileSearchPageOpen, true);
		h.view.app.workspace.getActiveViewOfType = () => h.view;
		assert.equal(back().defaultPrevented, true); assert.equal(h.view.mobileSearchPageOpen, false);
		assert.equal(back().defaultPrevented, false);
	} finally { platform.isMobile = wasMobile; h.close(); }
});

class FakeItem {
	title = "";
	icon = "";
	checked: boolean | null = null;
	warning = false;
	label = false;
	click: (() => void) | null = null;
	readonly dom: HTMLElement;
	private readonly titleEl: HTMLElement;
	constructor(doc: Document) {
		this.dom = doc.createElement("div");
		this.dom.className = "menu-item";
		this.titleEl = this.dom.appendChild(doc.createElement("div"));
		this.titleEl.className = "menu-item-title";
		this.dom.addEventListener("click", () => this.click?.());
	}
	setTitle(title: string | DocumentFragment) {
		this.title = typeof title === "string" ? title : title.textContent ?? "";
		this.titleEl.replaceChildren(typeof title === "string" ? this.dom.ownerDocument.createTextNode(title) : title);
		return this;
	}
	setIcon(icon: string) { this.icon = icon; return this; }
	setChecked(value: boolean) { this.checked = value; this.dom.classList.toggle("mod-checked", value); return this; }
	setWarning(value: boolean) { this.warning = value; return this; }
	setIsLabel(value: boolean) { this.label = value; return this; }
	onClick(callback: () => void) { this.click = callback; return this; }
}
class FakeMenu {
	items: FakeItem[] = [];
	hidden: (() => void) | null = null;
	deferHide = false;
	noIcon = false;
	hideCalls = 0;
	doc: Document | undefined;
	background: HTMLElement | null = null;
	private dom: HTMLElement | null = null;
	private removeOutsideListener: (() => void) | null = null;
	constructor(private readonly ownerDocument: Document) {}
	setNoIcon() { this.noIcon = true; return this; }
	addSeparator() { return this; }
	addItem(build: (item: MenuItem) => void) {
		const item = new FakeItem(this.ownerDocument);
		this.items.push(item);
		build(item as unknown as MenuItem);
		return this;
	}
	onHide(callback: () => void) { this.hidden = callback; }
	hide() {
		this.hideCalls++;
		this.removeOutsideListener?.();
		this.removeOutsideListener = null;
		if (!this.deferHide) { this.dom?.remove(); this.background?.remove(); this.hidden?.(); }
		return this;
	}
	showAtPosition(_position: MenuPositionDef, doc: Document) {
		this.doc = doc;
		this.dom = doc.body.appendChild(doc.createElement("div"));
		this.dom.className = "menu";
		for (const item of this.items) this.dom.appendChild(item.dom);
		this.background = doc.body.appendChild(doc.createElement("div"));
		this.background.className = "suggestion-bg";
		let ready = false;
		queueMicrotask(() => { ready = true; });
		const outside = (event: MouseEvent) => {
			if (ready && event.target instanceof doc.defaultView!.Node && !this.dom?.contains(event.target)) this.hide();
		};
		doc.defaultView!.addEventListener("click", outside);
		this.removeOutsideListener = () => doc.defaultView!.removeEventListener("click", outside);
		return this;
	}
}

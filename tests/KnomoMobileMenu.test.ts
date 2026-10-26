import test from "node:test";
import assert from "node:assert/strict";
import { undo, undoDepth } from "@codemirror/commands";
import type { Menu, MenuItem, MenuPositionDef } from "obsidian";
import type { MemoViewItem } from "../src/types/memoView";
import type { MemoAction } from "../src/ui/KnomoActionDispatch";
import type { KnomoMobileMenu } from "../src/ui/KnomoMobileMenu";
import { createMobilePopupFixture } from "./helpers/mobilePopupFixture";
import { createReferenceMemo } from "./helpers/referenceMemo";

test("原生菜单有无自身锚点均显示固定的引用和复制链接", async () => {
	const h = await createHarness();
	try {
		for (const anchor of [null, "own-anchor"]) {
			h.originalMemo.catalog = createReferenceMemo(anchor).catalog;
			h.view.toggleCardMenu(h.originalMemo.id);
			const menu = h.menus.at(-1)!;
			assert.equal(menu.items[1].title, "Reference");
			assert.equal(menu.items[5].title, "Copy link");
			h.controller.close();
		}
	} finally { h.close(); }
});

interface MenuView {
	currentLayout: string;
	composerOpen: boolean;
	mobileSearchPageOpen: boolean;
	mobileDrawerOpen: boolean;
	mobileMenuController: KnomoMobileMenu;
	toggleCardMenu(id: string | null): void;
	toggleScopeMenu(): void;
	registerMobileMenuTriggerEvents(): void;
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
	// 普通菜单用例默认窗口已激活；失焦交接用例单独控制此状态。
	f.win.document.hasFocus = () => true;
	const { KnomoMobileMenu } = await import("../src/ui/KnomoMobileMenu");
	const { KnomoView } = await import("../src/ui/KnomoView");
	const menus: FakeMenu[] = [];
	const controller = new KnomoMobileMenu(() => { const menu = new FakeMenu(f.win.document); menus.push(menu); return menu as unknown as Menu; });
	const originalMemo = f.view.editingMemo!;
	let latestMemo = originalMemo;
	const actions: Array<{ action: MemoAction; memo: MemoViewItem }> = [];
	const scopes: string[] = [];
	const { MobileHeaderTitleController } = await import("../src/ui/MobileHeaderTitleController");
	const header = f.win.document.body.createDiv();
	const trigger = header.createDiv();
	const headerCleanups: Array<() => void> = [];
	const titleController = new MobileHeaderTitleController({
		registerDomEvent: (target, type, handler) => {
			target.addEventListener(type, handler as EventListener);
			headerCleanups.push(() => target.removeEventListener(type, handler as EventListener));
		},
		renderChevron: container => { container.createSpan(); },
		canToggleScopeMenu: () => trigger.getAttribute("role") === "button",
		onToggleScopeMenu: () => view.toggleScopeMenu(),
	});
	titleController.sync({ headerEl: header, titleEl: trigger, isRecordStats: false, scopeMenuOpen: false, label: "All memos" });
	Object.assign(f.win.HTMLElement.prototype, {
		findAll(this: HTMLElement, selector: string) { return Array.from(this.querySelectorAll(selector)); },
		find(this: HTMLElement, selector: string) { return this.querySelector(selector); },
	});
	const view = Object.assign(f.view as unknown as MenuView, {
		rootEl: f.root, cardFlowEl: f.root, mobileMenuController: controller,
		containerEl: { doc: f.win.document }, mobileHeaderTitleController: titleController,
		mobileViewFocusRecovery: null, register: (cleanup: () => void) => headerCleanups.push(cleanup),
		findMemoById: () => latestMemo,
		handleMemoAction: async (action: MemoAction, memo: MemoViewItem) => { actions.push({ action, memo }); },
		getTitleState: () => ({ activeNav: "all", activeTagKey: null, scopeFilter: "with-image" }),
		getTitlePopoverAnchor: () => trigger,
		setTitleMode: (mode: string) => scopes.push(mode),
	});
	view.app.workspace = { getActiveViewOfType: () => view };
	// 本夹具的 root 承载开启的 Search，菜单触发卡片必须属于实际显示的 surface。
	Object.defineProperty(view, "mobileSearchResultsEl", { configurable: true, get: () => view.mobileSearchPageOpen ? f.root : null });
	Object.defineProperty(view, "mobileSearchPageOpen", { configurable: true, writable: true, value: true });
	view.syncCardMenuState = (KnomoView.prototype as unknown as MenuView).syncCardMenuState.bind(view);
	view.registerMobileMenuTriggerEvents();
	return { f, view, controller, menus, actions, scopes, originalMemo, trigger,
		replaceMemo() { latestMemo = { ...originalMemo, contentSnapshot: "同一列表 key 下的新正文" }; },
		close() { controller.close(); for (const cleanup of headerCleanups) cleanup(); titleController.remove(); f.close(); },
	};
}

test("menu titles stay plain text and belong to the trigger document when helpers use another document", async () => {
	const h = await createHarness();
	try {
		const doc = h.f.win.document;
		const helperDocument = doc.implementation.createHTMLDocument("helper window");
		Object.defineProperty(globalThis, "createSpan", { configurable: true, writable: true, value: () => helperDocument.createElement("span") });
		Object.defineProperty(globalThis, "createFragment", { configurable: true, writable: true, value: () => helperDocument.createDocumentFragment() });
		const text = '菜单 <img src="x"> & 搜索';
		h.controller.open({ kind: "scope", trigger: h.trigger, onClose: () => undefined,
			build(menu, _select, createTitle) {
				const title = createTitle(text, true);
				assert.equal(title.ownerDocument, doc);
				assert.equal(title.firstChild?.ownerDocument, doc);
				assert.equal(title.textContent, text);
				assert.equal(title.querySelector("img"), null);
				assert.ok(title.querySelector("[data-knomo-menu-input]"));
				menu.addItem(item => item.setTitle(title));
			},
		});
		assert.equal(h.menus[0].doc, doc);
		assert.equal(h.menus[0].items[0].title, text);
	} finally { h.close(); }
});

test("native Card and Scope menus stay outside glass preferences and release ownership on every close path", async () => {
	const h = await createHarness();
	try {
		let reduced = true;
		const leaf = h.f.win.document.body.createDiv();
		Object.defineProperty(leaf, "doc", { value: h.f.win.document });
		leaf.appendChild(h.f.root);
		const view = Object.assign(h.view as unknown as { syncReducedGlassEffects(): void }, {
			containerEl: leaf, settingsService: { getSettings: () => ({ reduceGlassEffects: reduced }) },
		});
		Object.assign(h.view.mobileComposerController, { getLayerEl: () => h.f.layer });
		const unrelated = h.f.win.document.body.createDiv({ cls: "menu" });
		for (const mobileSearch of [false, true]) for (const kind of ["scope", "card"] as const) for (const close of ["hide", "replace", "trigger-detach", "controller"] as const) {
			h.view.mobileSearchPageOpen = mobileSearch;
			const context = `${mobileSearch ? "search" : "feed"}/${kind}/${close}`;
			const trigger = kind === "scope" ? h.trigger : h.f.card.querySelector<HTMLElement>(".knomo-card-menu")!;
			if (kind === "scope") h.view.toggleScopeMenu(); else h.view.toggleCardMenu(h.originalMemo.id);
			const owned = h.f.win.document.querySelector<HTMLElement>(".menu.knomo-mobile-menu")!;
			assert.ok(owned, context);
			assert.equal(owned.classList.contains("knomo-reduce-glass"), false, context);
			assert.equal(owned.classList.contains("knomo-mobile-glass-surface"), false, context);
			const className = owned.className;
			for (const value of [false, true]) {
				reduced = value; view.syncReducedGlassEffects();
				assert.equal(leaf.classList.contains("knomo-reduce-glass"), value, context);
				assert.equal(owned.className, className, `${context}: preferences do not change menu ownership or material`);
				assert.equal(h.f.win.document.querySelector(".menu.knomo-mobile-menu"), owned, context);
			}
			if (close === "hide") h.menus.at(-1)!.hide();
			else if (close === "replace") {
				if (kind === "scope") h.view.toggleCardMenu(h.originalMemo.id); else h.view.toggleScopeMenu();
				h.controller.close();
			}
			else if (close === "trigger-detach") {
				const parent = trigger.parentElement!;
				trigger.remove(); await Promise.resolve();
				parent.appendChild(trigger);
			} else h.controller.close();
			assert.equal(owned.classList.contains("knomo-mobile-glass-surface"), false, context);
			assert.equal(owned.classList.contains("knomo-reduce-glass"), false, context);
			assert.equal(owned.classList.contains("knomo-mobile-menu"), false, context);
			assert.equal(owned.classList.contains(`knomo-mobile-menu-${kind}`), false, context);
			assert.equal(unrelated.className, "menu", "other host menus never inherit Knomo state");
		}
	} finally { h.close(); }
});

test("menu interaction ownership requires a title belonging to the exact host menu", async () => {
	const h = await createHarness();
	try {
		h.controller.open({ kind: "scope", trigger: h.trigger, onClose: () => undefined,
			build: menu => { menu.addItem(item => item.setTitle("Unmarked title")); },
		});
		assert.equal(h.f.win.document.querySelector(".knomo-mobile-menu"), null);
		assert.equal(h.f.win.document.querySelector(".knomo-mobile-glass-surface"), null);
	} finally { h.close(); }
});

test("mobile Card Menu delegates to host and retains the selected observation instead of looking up a new memo", async () => {
	const h = await createHarness();
	try {
		h.view.toggleCardMenu(h.originalMemo.id);
		const menu = h.menus[0];
		assert.equal(h.controller.kind, "card");
		assert.equal(menu.items.length, 8);
		assert.equal(menu.noIcon, false);
		assert.deepEqual(menu.items.map(item => item.icon), ["pencil", "quote", "calendar-days", "network", "copy", "link", "trash-2", "text"]);
		assert.equal(menu.items.at(-1)!.label, true);
		assert.equal(menu.items[6].warning, true);
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
	const { TITLE_MODE_OPTIONS } = await import("../src/ui/viewNavigation");
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
		this.dom.getClientRects = () => [new doc.defaultView!.DOMRect(0, 0, 100, 100)] as unknown as DOMRectList;
		for (const item of this.items) this.dom.appendChild(item.dom);
		this.background = doc.body.appendChild(doc.createElement("div"));
		this.background.className = "suggestion-bg";
		this.background.getClientRects = () => [new doc.defaultView!.DOMRect(0, 0, 100, 100)] as unknown as DOMRectList;
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

for (const kind of ["card", "scope"] as const) {
	test("first unfocused iOS touch opens " + kind + " menu without a compatibility click", async () => {
		const h = await createHarness();
		try {
			// 真机记录：失焦窗口收到 down/up/touchend，却没有 click；第二次才有 click。
			Object.defineProperty(h.f.win.document, "hasFocus", { configurable: true, value: () => false });
			const trigger = kind === "card" ? h.f.card.querySelector<HTMLElement>(".knomo-card-menu")! : h.trigger;
			const target = trigger.querySelector("span, svg") ?? trigger;
			h.f.pointer(target, "pointerdown"); touch(h, target, "touchstart");
			h.f.pointer(target, "pointerup"); const end = touch(h, target, "touchend");
			assert.equal(h.controller.kind, kind, "第一次轻触就打开，无需等窗口恢复焦点或第二次 click");
			assert.equal(end.defaultPrevented, true);
			// iOS 的兼容 click 可以标记为 mouse，不能依靠 pointerType 去重。
			await h.f.click(trigger);
			assert.equal(h.controller.kind, kind, "同一触摸的迟到 click 不应把菜单关掉");
			assert.equal(h.menus.length, 1);
			tap(h, h.menus[0].background!);
			assert.equal(h.controller.kind, null);
			tap(h, target);
			assert.equal(h.controller.kind, kind, "关闭后再次轻触仍只需一次");
		} finally { h.close(); }
	});
}

test("menu trigger touch yields to cancelled gestures and invalidated views", async () => {
	for (const scenario of ["move", "scroll", "cancel", "pointercancel", "multi", "long", "release-outside", "host-gesture", "disabled", "removed", "inactive", "desktop", "blur"] as const) {
		const h = await createHarness();
		try {
			const trigger = h.f.card.querySelector<HTMLButtonElement>(".knomo-card-menu")!;
			touch(h, trigger, "touchstart", { time: 100 });
			if (scenario === "move") touch(h, trigger, "touchmove", { x: 40 });
			if (scenario === "scroll") h.f.root.dispatchEvent(new h.f.win.Event("scroll"));
			if (scenario === "cancel") touch(h, trigger, "touchcancel");
			if (scenario === "pointercancel") h.f.pointer(trigger, "pointercancel");
			if (scenario === "multi") touch(h, trigger, "touchstart", { ids: [1, 2] });
			if (scenario === "host-gesture") trigger.addEventListener("touchend", event => event.preventDefault(), { once: true });
			if (scenario === "disabled") trigger.disabled = true;
			if (scenario === "removed") trigger.remove();
			if (scenario === "inactive") h.view.app.workspace.getActiveViewOfType = () => null;
			if (scenario === "desktop") h.view.currentLayout = "desktop";
			if (scenario === "blur") h.f.win.dispatchEvent(new h.f.win.Event("blur"));
			touch(h, scenario === "release-outside" ? h.trigger : trigger, "touchend", { time: scenario === "long" ? 800 : 200 });
			assert.equal(h.menus.length, 0, scenario);
		} finally { h.close(); }
	}
});

test("menu trigger deduplication preserves new mouse gestures, keyboard clicks and other controls", async () => {
	const h = await createHarness();
	try {
		tap(h, h.trigger);
		assert.equal(h.controller.kind, "scope");
		await h.f.click(h.trigger, 0);
		assert.equal(h.controller.kind, null, "键盘及辅助技术的独立激活不被吞掉");
		tap(h, h.trigger);
		h.trigger.dispatchEvent(new h.f.win.Event("pointerdown", { bubbles: true }));
		await h.f.click(h.trigger);
		assert.equal(h.controller.kind, null, "新一轮鼠标按下不受上一触摸抑制影响");
		let calls = 0;
		const other = h.f.win.document.body.createEl("button");
		other.addEventListener("click", () => calls++);
		tap(h, other);
		assert.equal(calls, 0, "其他控件维持原来的 click 路径");
		await h.f.click(other);
		assert.equal(calls, 1);
	} finally { h.close(); }
});


test("menu trigger listener cleanup cancels a pending tap without intercepting later clicks", async () => {
	const h = await createHarness();
	const { registerMobileMenuTriggerTap } = await import("../src/ui/MobileMenuTap");
	try {
		const button = h.f.win.document.body.createEl("button");
		let calls = 0;
		button.addEventListener("click", () => calls++);
		const release = registerMobileMenuTriggerTap(h.f.win.document, target => button.contains(target) ? button : null);
		touch(h, button, "touchstart"); release(); touch(h, button, "touchend");
		assert.equal(calls, 0);
		await h.f.click(button);
		assert.equal(calls, 1);
		const releaseAgain = registerMobileMenuTriggerTap(h.f.win.document, target => button.contains(target) ? button : null);
		tap(h, button); assert.equal(calls, 2);
		releaseAgain(); await h.f.click(button);
		assert.equal(calls, 3, "卸载必须同时移除兼容 click 抑制");
	} finally { h.close(); }
});

test("record statistics title and other views do not become menu touch triggers", async () => {
	const h = await createHarness();
	try {
		h.trigger.removeAttribute("role");
		tap(h, h.trigger);
		const other = h.f.win.document.body.createEl("button", { attr: { "data-action": "toggle-card-menu" } });
		let calls = 0;
		other.addEventListener("click", () => calls++);
		tap(h, other);
		assert.equal(calls, 0);
		assert.equal(h.menus.length, 0);
	} finally { h.close(); }
});


test("关闭 Card 和 Scope 菜单后恢复主视图焦点，不依赖下一次按钮触摸", async () => {
	const { Platform } = await import("obsidian");
	const platform = Platform as unknown as { isMobile: boolean };
	const wasMobile = platform.isMobile;
	platform.isMobile = true;
	try {
		for (const kind of ["card", "scope"] as const) {
			const h = await createHarness();
			const frames = new Map<number, FrameRequestCallback>(); let next = 0;
			h.f.win.requestAnimationFrame = callback => { frames.set(++next, callback); return next; };
			h.f.win.cancelAnimationFrame = id => { frames.delete(id); };
			try {
				h.view.composerOpen = false; h.view.mobileSearchPageOpen = false;
				if (kind === "card") h.view.toggleCardMenu(h.originalMemo.id); else h.view.toggleScopeMenu();
				tap(h, h.menus[0].background!);
				assert.equal(h.controller.kind, null);
				for (const callback of [...frames.values()]) callback(0);
				assert.equal(h.f.win.document.activeElement, h.f.root, "菜单结束后由代码交回焦点");
				h.menus[0].items[0].click!();
				assert.equal(h.actions.length + h.scopes.length, 0, "关闭蒙版后迟到选项不得执行");
			} finally { h.close(); }
		}
	} finally { platform.isMobile = wasMobile; }
});


test("菜单隐藏恢复覆盖普通选项，并让位于替换菜单和用户新操作", async () => {
	const { Platform } = await import("obsidian");
	const platform = Platform as unknown as { isMobile: boolean };
	const wasMobile = platform.isMobile;
	platform.isMobile = true;
	try {
		for (const scenario of ["natural", "deferred-hide", "select", "hide-before-select", "replacement", "programmatic", "user-input", "modal", "inactive", "removed"] as const) {
			const h = await createHarness();
			const frames = new Map<number, FrameRequestCallback>(); let next = 0;
			h.f.win.requestAnimationFrame = callback => { frames.set(++next, callback); return next; };
			h.f.win.cancelAnimationFrame = id => { frames.delete(id); };
			const frame = () => { const tasks = [...frames.values()]; frames.clear(); for (const callback of tasks) callback(0); };
			try {
				h.view.composerOpen = false; h.view.mobileSearchPageOpen = false;
				h.view.toggleScopeMenu(); const menu = h.menus[0];
				if (scenario === "deferred-hide") {
					menu.deferHide = true; tap(h, menu.background!); frame();
					assert.notEqual(h.f.win.document.activeElement, h.f.root, "宿主菜单尚未隐藏，不恢复底层焦点");
					menu.deferHide = false; menu.hide();
				} else if (scenario === "programmatic") h.controller.close();
				else if (scenario === "select") menu.items[0].click!();
				else menu.hide();
				assert.notEqual(h.f.win.document.activeElement, h.f.root, "隐藏回调内不抢同步选项的焦点");
				if (scenario === "hide-before-select") menu.items[0].click!();
				if (scenario === "replacement") h.view.toggleCardMenu(h.originalMemo.id);
				if (scenario === "user-input") h.f.win.document.dispatchEvent(new h.f.win.Event("pointerdown"));
				if (scenario === "inactive") h.view.app.workspace.getActiveViewOfType = () => null;
				if (scenario === "removed") h.trigger.remove();
				if (scenario === "modal") {
					const modal = h.f.win.document.body.createDiv({ cls: "modal-container" });
					modal.getClientRects = () => [new h.f.win.DOMRect(0, 0, 100, 100)] as unknown as DOMRectList;
				}
				frame();
				assert.equal(h.f.win.document.activeElement === h.f.root, ["natural", "deferred-hide", "select", "hide-before-select"].includes(scenario), scenario);
				if (scenario === "hide-before-select" || scenario === "select") assert.equal(h.scopes.length, 1);
			} finally { h.close(); }
		}
	} finally { platform.isMobile = wasMobile; }
});

test("卡片普通选项关闭内部菜单后仍恢复视图，编辑选项保留手势内编辑器焦点", async () => {
	const { Platform } = await import("obsidian");
	const platform = Platform as unknown as { isMobile: boolean }; const wasMobile = platform.isMobile; platform.isMobile = true;
	try {
		for (const action of ["copy-text", "edit", "reference"] as const) {
			const h = await createHarness();
			const frames = new Map<number, FrameRequestCallback>(); let next = 0;
			h.f.win.requestAnimationFrame = callback => { frames.set(++next, callback); return next; };
			h.f.win.cancelAnimationFrame = id => { frames.delete(id); };
			try {
				h.view.composerOpen = false; h.view.mobileSearchPageOpen = false;
				const editor = h.f.win.document.body.appendChild(h.f.win.document.createElement("input"));
				Object.assign(h.view, { handleMemoAction: async () => {
					h.controller.close();
					if (action !== "copy-text") editor.focus();
				} });
				h.view.toggleCardMenu(h.originalMemo.id);
				const index = action === "edit" ? 0 : action === "reference" ? 1 : 3;
				h.menus[0].items[index].click!();
				if (action !== "copy-text") assert.equal(h.f.win.document.activeElement, editor, "编辑聚焦必须同步保留");
				for (const callback of [...frames.values()]) callback(0);
				assert.equal(h.f.win.document.activeElement, action === "copy-text" ? h.f.root : editor, action);
			} finally { h.close(); }
		}
	} finally { platform.isMobile = wasMobile; }
});

test("真实视图接线覆盖新建、搜索、Knomo 侧栏和宿主导航，失焦首击只执行一次", async () => {
	const h = await createHarness();
	try {
		let focused = false;
		Object.defineProperty(h.f.win.document, "hasFocus", { configurable: true, value: () => focused });
		const navbar = h.f.win.document.body.createDiv({ cls: "mobile-navbar" });
		const fab = h.f.root.createEl("button", { cls: "knomo-mobile-create-fab" });
		const sidebar = navbar.createEl("button", { cls: "knomo-mobile-navbar-sidebar-action" });
		const nativeSidebar = h.f.root.createEl("button", { cls: "sidebar-toggle-button" });
		const search = h.f.root.createEl("button", { attr: { "data-action": "toggle-compact-search" } });
		const quickSwitcher = navbar.createDiv({ cls: "mobile-navbar-action mobile-navbar-action-quick-switcher" });
		const tabs = navbar.createDiv({ cls: "mobile-navbar-action mobile-navbar-action-tabs" });
		const menu = navbar.createDiv({ cls: "mobile-navbar-action mobile-navbar-action-menu" });
		const icon = menu.createSpan({ cls: "clickable-icon" });
		const historyButtons = ["random-day-back", "refresh-random-reunion", "retry-random-day"].map(action =>
			h.f.root.createEl("button", { attr: { "data-action": action } }));
		Object.assign(h.view, { randomDayController: { reloadSelectedDate: async () => true, getSnapshot: () => ({ selectedDate: null }) } });
		for (const button of [fab, sidebar, nativeSidebar, search, quickSwitcher, tabs, icon, ...historyButtons]) {
			let calls = 0; button.addEventListener("click", () => calls++);
			focused = false; assert.equal(tap(h, button).defaultPrevented, false);
			focused = true;
			await new Promise(resolve => h.f.win.setTimeout(resolve, 130));
			assert.equal(calls, 1, button.outerHTML);
		}
	} finally { h.close(); }
});

test("首击补偿不接管模态框、非活动视图或已禁用按钮", async () => {
	for (const scenario of ["modal", "inactive", "disabled"]) {
		const h = await createHarness();
		try {
			let focused = false; Object.defineProperty(h.f.win.document, "hasFocus", { configurable: true, value: () => focused });
			const parent = scenario === "modal" ? h.f.win.document.body.createDiv({ cls: "modal-container" }) : h.f.root;
			const button = parent.createEl("button", { cls: "knomo-mobile-create-fab" });
			if (scenario === "disabled") button.setAttribute("aria-disabled", "true");
			if (scenario === "inactive") h.view.app.workspace.getActiveViewOfType = () => null;
			let calls = 0; button.addEventListener("click", () => calls++);
			tap(h, button); focused = true; await new Promise(resolve => h.f.win.setTimeout(resolve, 130));
			assert.equal(calls, 0, scenario);
		} finally { h.close(); }
	}
});

async function useRealComposerActions(h: Awaited<ReturnType<typeof createHarness>>) {
	const { MobileComposerController } = await import("../src/ui/MobileComposerController");
	const { KnomoView } = await import("../src/ui/KnomoView");
	const proto = KnomoView.prototype as unknown as {
		handleMemoAction(action: MemoAction, memo: MemoViewItem): Promise<void>;
		focusComposerInputNow(resize?: boolean, viewport?: boolean, moveToEnd?: boolean): void;
		openComposer(): void;
		applyRestoredDraftSelection(): void;
	};
	const { f, view } = h;
	Object.assign(f.win.HTMLElement.prototype, {
		hasClass(this: HTMLElement, cls: string) { return this.classList.contains(cls); },
		setCssProps(this: HTMLElement, props: Record<string, string>) { for (const [key, value] of Object.entries(props)) this.style.setProperty(key, value); },
	});
	let pending = Promise.resolve();
	const focusStates: boolean[] = [];
	Object.assign(view, {
		composerOpen: false, editingMemo: null, quoteReferenceText: null, quoteMarkdownText: null,
		composerIsComposing: false, trashViewClosed: false,
		pauseMobileBackgroundWork: () => undefined, updateStatus: () => undefined,
		resizeInput: () => undefined, flushLocalDraft: () => undefined,
		resolveCatalogMemo: async () => h.originalMemo.catalog,
		memoCommandService: { createReferenceText: async () => ({ text: "[[source]]" }) },
		handleMemoAction: (action: MemoAction, memo: MemoViewItem) => {
			pending = proto.handleMemoAction.call(view, action, memo); return pending;
		},
	});
	const controller = new MobileComposerController({
		getWindow: () => f.win as unknown as Window, getDocument: () => f.win.document,
		getContainerEl: () => f.root, getRootEl: () => f.root,
		getComposerEl: () => f.view.composerEl, getInputEl: () => f.view.inputEl,
		getComposerBarEl: () => null, getReferencePreviewEl: () => null,
		getLayout: () => "mobile", isComposerOpen: () => view.composerOpen,
		setComposerOpen: value => { view.composerOpen = value; }, getCardFlowScrollTop: () => 0,
		registerBackdropClick: (element, handler) => element.addEventListener("click", handler),
		closeComposerKeepingDraft: () => controller.closeKeepingDraft(),
		focusInputNow: (resize, viewport, moveToEnd) => {
			focusStates.push(f.win.document.hasFocus());
			proto.focusComposerInputNow.call(view, resize, viewport, moveToEnd);
		},
		resizeInput: () => undefined, syncRootState: () => undefined, syncComposerMode: () => undefined,
		updateSendButtonState: () => undefined, updateCancelEditButtonState: () => undefined,
	});
	Object.assign(view, { mobileComposerController: controller });
	controller.prepare();
	return { controller, focusStates, done: () => pending,
		open: () => proto.openComposer.call(view),
		restoreSelection: (anchor: number, head: number) => {
			Object.assign(view, { restoredDraftSelection: { anchor, head, scrollTop: 0 } });
			proto.applyRestoredDraftSelection.call(view);
		},
	};
}

test("移动端从收起状态打开恢复草稿时，真实编辑器光标落在全文末尾", async t => {
	for (const { text, anchor, head } of [
		{ text: "第一行草稿\n\n最后一段继续写 📝", anchor: 0, head: 0 },
		{ text: "恢复中的反向选区\n最后一段", anchor: 5, head: 2 },
		{ text: "保留末尾空行\n\n", anchor: 0, head: 0 },
		{ text: "", anchor: 0, head: 0 },
	]) {
		await t.test(JSON.stringify(text), async () => {
			const h = await createHarness();
			const real = await useRealComposerActions(h);
			try {
				const input = h.f.view.inputEl;
				const editor = input.composer.view;
				input.value = text;
				real.restoreSelection(anchor, head);
				input.blur();
				const doc = editor.state.doc;
				real.open();
				assert.equal(h.f.win.document.activeElement, input);
				assert.deepEqual([editor.state.selection.main.anchor, editor.state.selection.main.head], [text.length, text.length]);
				await new Promise(resolve => h.f.win.requestAnimationFrame(resolve));
				assert.equal(editor.state.selection.main.head, text.length, "后续视口更新不能再把光标移回行首");
				const selection = h.f.win.getSelection()!;
				assert.equal(editor.posAtDOM(selection.anchorNode!, selection.anchorOffset), text.length);
				assert.equal(selection.isCollapsed, true);
				assert.equal(editor.state.doc, doc, "打开草稿只移动光标，不重置正文");
			} finally { real.controller.dispose(); h.close(); }
		});
	}
});

test("移动草稿重新展开定位末尾，已展开时再次聚焦保留选区与撤销历史", async () => {
	const h = await createHarness();
	const real = await useRealComposerActions(h);
	try {
		const input = h.f.view.inputEl;
		const editor = input.composer.view;
		const original = "第一段\n最后一段";
		input.value = original;
		editor.dispatch({ changes: { from: original.length, insert: "继续写" }, selection: { anchor: 0 } });
		const doc = editor.state.doc;
		assert.equal(undoDepth(editor.state), 1);
		real.open();
		assert.equal(editor.state.selection.main.head, doc.length);
		editor.dispatch({ selection: { anchor: 5, head: 2 } });
		real.open();
		assert.deepEqual([editor.state.selection.main.anchor, editor.state.selection.main.head], [5, 2]);
		input.blur();
		real.controller.focusInputSoon();
		await new Promise(resolve => h.f.win.requestAnimationFrame(resolve));
		assert.equal(h.f.win.document.activeElement, input);
		assert.deepEqual([editor.state.selection.main.anchor, editor.state.selection.main.head], [5, 2]);
		real.controller.closeKeepingDraft();
		assert.equal(h.view.composerOpen, false);
		real.open();
		assert.deepEqual([editor.state.selection.main.anchor, editor.state.selection.main.head], [doc.length, doc.length]);
		assert.equal(editor.state.doc, doc);
		assert.equal(undoDepth(editor.state), 1);
		assert.equal(undo(editor), true);
		assert.equal(input.value, original);
	} finally { real.controller.dispose(); h.close(); }
});

test("失焦菜单的编辑与引用保留原生激活，再经真实 View、Composer 和 CodeMirror 获得焦点", async () => {
	for (const index of [0, 1]) {
		const h = await createHarness();
		const real = await useRealComposerActions(h);
		let focused = false;
		h.f.win.document.hasFocus = () => focused;
		try {
			h.view.toggleCardMenu(h.originalMemo.id);
			const end = tap(h, h.menus[0].items[index].dom.querySelector("span")!);
			assert.equal(end.defaultPrevented, false, "不能取消使窗口重新激活的原生触摸");
			assert.equal(h.view.composerOpen, false, "窗口尚未激活，不提前打开并消耗唯一一次聚焦");
			assert.deepEqual(real.focusStates, []);
			focused = true;
			h.f.win.dispatchEvent(new h.f.win.Event("focus"));
			await new Promise(resolve => h.f.win.setTimeout(resolve, 130));
			await real.done();
			assert.equal(h.view.composerOpen, true);
			assert.deepEqual(real.focusStates, [true]);
			assert.equal(h.f.win.document.activeElement, h.f.view.inputEl);
			assert.equal(h.f.view.inputEl.composer.view.hasFocus, true);
			assert.equal(h.f.view.inputEl.value, index === 0 ? h.originalMemo.contentSnapshot : "编辑中的 Memo：取消手势不应丢失这些修改。");
			if (index === 1) assert.equal(h.f.view.quoteReferenceText, "[[source]]");
			let through = 0;
			const layer = real.controller.getLayerEl()!;
			layer.addEventListener("click", () => through++);
			layer.dispatchEvent(new h.f.win.MouseEvent("click", { bubbles: true, cancelable: true, detail: 1, clientX: 20, clientY: 20 }));
			assert.equal(through, 0, "菜单卸载后仍阻止同次触摸的迟到点击穿透编辑器");
		} finally { real.controller.dispose(); h.close(); }
	}
});

test("失焦菜单原生 click 正常到达时直接执行，不被首击补偿重复执行", async () => {
	const h = await createHarness();
	let focused = false; h.f.win.document.hasFocus = () => focused;
	try {
		h.view.toggleCardMenu(h.originalMemo.id);
		const item = h.menus[0].items[1].dom;
		assert.equal(tap(h, item).defaultPrevented, false);
		focused = true; await h.f.click(item);
		await new Promise(resolve => h.f.win.setTimeout(resolve, 130));
		assert.deepEqual(h.actions, [{ action: "reference", memo: h.originalMemo }]);
	} finally { h.close(); }
});

test("失焦菜单等待激活期间取消、切页、替换菜单或禁用选项，不执行旧编辑动作", async () => {
	for (const scenario of ["cancel", "inactive", "replace", "disabled", "new-touch", "never-focused"]) {
		const h = await createHarness();
		let focused = false; h.f.win.document.hasFocus = () => focused;
		try {
			h.view.toggleCardMenu(h.originalMemo.id);
			const item = h.menus[0].items[0].dom;
			tap(h, item);
			if (scenario === "cancel") h.controller.close();
			if (scenario === "inactive") h.view.app.workspace.getActiveViewOfType = () => null;
			if (scenario === "replace") h.view.toggleScopeMenu();
			if (scenario === "disabled") item.classList.add("is-disabled");
			if (scenario === "new-touch") touch(h, h.f.root, "touchstart");
			focused = scenario !== "never-focused";
			await new Promise(resolve => h.f.win.setTimeout(resolve, 130));
			assert.deepEqual(h.actions, [], scenario);
		} finally { h.close(); }
	}
});

test("失焦输入动作修复不改变其他卡片菜单项、Scope 选项和蒙版的同步轻触", async () => {
	for (const scenario of ["copy", "daily", "scope", "backdrop"] as const) {
		const h = await createHarness();
		h.f.win.document.hasFocus = () => false;
		try {
			if (scenario === "scope") h.view.toggleScopeMenu(); else h.view.toggleCardMenu(h.originalMemo.id);
			const menu = h.menus[0];
			const target = scenario === "backdrop" ? menu.background! : menu.items[scenario === "daily" ? 2 : scenario === "copy" ? 4 : 3].dom;
			assert.equal(tap(h, target).defaultPrevented, true, scenario);
			assert.equal(h.controller.kind, null, scenario);
			if (scenario === "copy" || scenario === "daily") assert.deepEqual(h.actions.map(item => item.action), [scenario === "copy" ? "copy-text" : "open-daily"]);
			else assert.deepEqual(h.actions, []);
			assert.deepEqual(h.scopes, scenario === "scope" ? ["with-link"] : []);
		} finally { h.close(); }
	}
});

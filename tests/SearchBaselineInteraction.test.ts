import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { KnomoViewStateController } from "../src/ui/KnomoViewStateController";
import { SearchQueryDebounce } from "../src/ui/SearchQueryDebounce";
import type { SearchDateFilter } from "../src/ui/viewFilters";
import type { SidebarNav } from "../src/ui/viewNavigation";
import { ensureObsidianStub } from "./helpers/obsidianStub";

type SearchSurface = "desktop-wide" | "desktop-narrow" | "compact-panel";

async function desktopSearch(surface: SearchSurface = "desktop-wide") {
	await ensureObsidianStub();
	const { KnomoView } = await import("../src/ui/KnomoView");
	const { renderKnomoDesktopTopbar, renderKnomoCompactHeader, renderKnomoCompactSearchPanel } = await import("../src/ui/KnomoHeaderSearch");
	const dom = new JSDOM("<body></body>");
	Object.assign(dom.window.HTMLElement.prototype, {
		createEl(this: HTMLElement, tag: string, options: { cls?: string; text?: string; attr?: Record<string, string> } = {}) {
			const element = this.ownerDocument.createElement(tag);
			if (options.cls) element.className = options.cls;
			if (options.text) element.textContent = options.text;
			for (const [key, value] of Object.entries(options.attr ?? {})) element.setAttribute(key, value);
			return this.appendChild(element);
		},
		createDiv(this: HTMLElement, options: object) { return this.createEl("div", options); },
		createSpan(this: HTMLElement, options: object) { return this.createEl("span", options); },
		setAttr(this: HTMLElement, key: string, value: string) { this.setAttribute(key, value); },
		getAttr(this: HTMLElement, key: string) { return this.getAttribute(key); },
		setText(this: HTMLElement, value: string) { this.textContent = value; },
		findAll(this: HTMLElement, selector: string) { return Array.from(this.querySelectorAll(selector)); },
		toggleClass(this: HTMLElement, name: string, active: boolean) { this.classList.toggle(name, active); },
		instanceOf(this: HTMLElement, constructor: typeof HTMLElement) { return this instanceof constructor; },
	});
	const root = dom.window.document.body;
	const state = new KnomoViewStateController();
	const timers = new Map<number, () => void>();
	let width = surface === "desktop-wide" ? 1000 : 700;
	let id = 0, queries = 0, renders = 0;
	const view = Object.assign(Object.create(KnomoView.prototype) as {
		registerDesktopSearchInput(input: HTMLInputElement): void;
		registerCompactSearchInput(input: HTMLInputElement): void;
		setSearchQuery(query: string): void;
		setSearchDateFilter(date: SearchDateFilter, source?: HTMLElement | null): void;
		applySidebarTagFilter(tag: string, key: string): void;
		renderScopeState(): void;
		syncSearchControls(): void;
		updateCurrentLayout(): void;
		syncSearchInputs(): void;
	}, {
		rootEl: root, currentLayout: surface === "desktop-wide" ? surface : "desktop-narrow", viewStateController: state,
		containerEl: { ownerDocument: dom.window.document, getBoundingClientRect: () => ({ width }) },
		sidebarEl: null, layoutSearchComposing: false, layoutSearchFocusTransfer: false,
		finishSidebarResize: () => {}, closeTimeBuoyPicker: () => {}, closeCardMenu: () => {},
		syncLayoutMeasurements: () => view.updateCurrentLayout(),
		popupState: { scopeMenuOpen: false, activeMenuMemoId: null },
		desktopSearchInputEl: null, compactInlineSearchInputEl: null, compactSearchInputEl: null,
		titleHosts: [], catalogDesktopQueryRun: 0, catalogDesktopCountRun: 0,
		cancelCatalogDesktopCount: () => {},
		getRenderScope: () => ({ registerDomEvent: (target: EventTarget, type: string, listener: EventListener) => target.addEventListener(type, listener) }),
		searchQueryDebounce: new SearchQueryDebounce({
			delayMs: 10, scheduleTask: callback => { timers.set(++id, callback); return id; },
			cancelTask: timer => timers.delete(timer),
		}),
		getCardFlowViewStateKey: () => state.searchQuery,
		getCardFlowChangeIntent: () => "view-scope-change",
		applyViewStateTransitionEffects: () => {},
		syncCardMenuState: () => {}, syncMobileHeaderTitle: () => {},
		syncRootState: () => {
			root.classList.toggle("is-desktop-search-open", state.desktopSearchOpen);
			root.classList.toggle("is-compact-search-open", state.compactSearchOpen);
			view.syncSearchControls();
		},
		renderFilteredListState: () => { renders++; view.renderScopeState(); },
		renderUiState: () => view.renderScopeState(),
		refreshCatalogActiveQuery: () => { queries++; },
	});
	const options = {
		createHiddenText: (parent: HTMLElement, name: string, text: string) => { parent.createSpan({ text, attr: { id: name } }); return name; },
		createIconButton: (parent: HTMLElement, _icon: string, label: string, cls: string, action: string) => parent.createEl("button", { cls, attr: { "aria-label": label, "data-action": action } }),
	};
	const addInput = (surface: SearchSurface) => {
		const input = surface === "desktop-wide" ? renderKnomoDesktopTopbar(root, options).searchInputEl
			: surface === "desktop-narrow" ? renderKnomoCompactHeader(root, options).inlineSearchInputEl
				: renderKnomoCompactSearchPanel(root, options).searchInputEl;
		Object.assign(view, surface === "desktop-wide" ? { desktopSearchInputEl: input }
			: surface === "desktop-narrow" ? { compactInlineSearchInputEl: input } : { compactSearchInputEl: input });
		if (surface === "desktop-wide") view.registerDesktopSearchInput(input); else view.registerCompactSearchInput(input);
		return input;
	};
	const input = addInput(surface);
	const change = (text: string, composing = false) => { input.value = text; input.dispatchEvent(new dom.window.InputEvent("input", { isComposing: composing })); };
	const key = (key: string) => input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
	const drain = () => { for (const callback of timers.values()) callback(); timers.clear(); };
	return { dom, root, input, view, state, change, key, drain, addInput, setWidth: (value: number) => { width = value; },
		get pending() { return timers.size; }, get queries() { return queries; }, get renders() { return renders; } };
}

test("桌面获焦沿用快捷日期菜单：不查询、不跳页、不增加控件；普通 Enter 仍走防抖", async () => {
	for (const nav of ["all", "things", "review", "random", "shuffleDay", "record-stats", "trash", "time-buoy"] as SidebarNav[]) {
		const h = await desktopSearch();
		try {
			h.state.activeNav = nav; h.state.scopeFilter = "with-image"; h.state.activeTagKey = "work";
			h.input.focus();
			assert.equal(h.state.desktopSearchOpen, true);
			assert.equal(h.state.activeNav, nav); assert.equal(h.state.activeTagKey, "work");
			assert.equal(h.queries, 0); assert.equal(h.renders, 0);
			assert.equal(h.root.querySelectorAll(".knomo-search-menu-option").length, 6);
			assert.equal(h.root.querySelector(".knomo-search-clear-input, .knomo-search-conditions, details, [data-search-action]"), null);
			h.change("项目 复盘"); h.key("Enter"); assert.equal(h.queries, 0);
			assert.equal(h.state.desktopSearchOpen, false);
			h.drain(); assert.equal(h.queries, 1);
			assert.equal(h.state.activeNav, nav === "things" ? "things" : "all");
			assert.deepEqual(h.state.search.applied.terms, ["项目 复盘"]);
		} finally { h.dom.window.close(); }
	}
});

test("桌面 Esc 保留宽屏文字并失焦，窄屏清空文字及手写日期", async () => {
	for (const layout of ["desktop-wide", "desktop-narrow"] as const) {
		const h = await desktopSearch(layout);
		try {
			h.change("20261009 项目"); h.drain(); h.input.focus(); h.key("Escape");
			assert.equal(h.state.desktopSearchOpen, false);
			assert.equal(h.state.searchQuery, layout === "desktop-wide" ? "20261009 项目" : "");
			assert.equal(h.input.value, layout === "desktop-wide" ? "20261009 项目" : "");
			if (layout === "desktop-wide") assert.notEqual(h.dom.window.document.activeElement, h.input);
			else assert.equal(h.state.search.applied.date, null);
		} finally { h.dom.window.close(); }
	}
});

test("快捷日期立即选中并关闭菜单，只替换手写日期；普通标签切换恢复清空搜索", async () => {
	const h = await desktopSearch();
	try {
		h.state.activeTagKey = "old"; h.state.scopeFilter = "with-image";
		h.input.focus(); h.change("项目 20261009 复盘");
		h.view.setSearchDateFilter("month");
		assert.equal(h.input.value, "项目  复盘");
		assert.equal(h.state.desktopSearchOpen, false);
		assert.equal(h.root.querySelector('[data-search-date="month"]')!.getAttribute("aria-pressed"), "true");
		assert.equal(h.state.activeTagKey, null); assert.equal(h.state.scopeFilter, "all");
		h.view.setSearchDateFilter("month");
		assert.equal(h.state.searchDateFilter, null);
		assert.equal(h.root.querySelector('[data-search-date="month"]')!.getAttribute("aria-pressed"), "false");
		h.view.applySidebarTagFilter("work", "work");
		assert.equal(h.state.searchQuery, ""); assert.equal(h.state.search.applied.date, null);
		assert.equal(h.state.activeTagKey, "work");
		h.state.activeNav = "things"; h.change("20261009 项目"); h.drain();
		h.view.applySidebarTagFilter("other", "other");
		assert.equal(h.state.searchQuery, "20261009 项目");
		assert.equal(h.state.activeNav, "things"); assert.equal(h.state.activeTagKey, "other");
	} finally { h.dom.window.close(); }
});

for (const surface of ["desktop-wide", "desktop-narrow", "compact-panel"] as const) {
	test(`桌面非空编辑只收起菜单：${surface} 保留输入、焦点、选区、面板及防抖`, async () => {
		const h = await desktopSearch(surface);
		try {
			h.state.compactSearchOpen = surface === "compact-panel";
			h.input.focus();
			h.change("项目");
			assert.equal(h.state.desktopSearchOpen, false);
			assert.equal(h.state.compactSearchOpen, surface === "compact-panel");
			assert.equal(h.dom.window.document.activeElement, h.input);
			assert.equal(h.input.value, "项目"); assert.equal(h.pending, 1); assert.equal(h.queries, 0);
			assert.ok([...h.root.querySelectorAll<HTMLButtonElement>(".knomo-search-menu-option")].every(button => button.tabIndex === -1));
			h.input.click();
			assert.equal(h.state.desktopSearchOpen, true);
			assert.ok([...h.root.querySelectorAll<HTMLButtonElement>(".knomo-search-menu-option")].every(button => button.tabIndex === 0));
			h.input.setSelectionRange(0, 1); h.key("ArrowLeft");
			h.view.syncSearchInputs(); h.view.syncSearchControls(); h.drain();
			assert.equal(h.queries, 1); assert.equal(h.state.desktopSearchOpen, true);
			assert.deepEqual([h.input.selectionStart, h.input.selectionEnd], [0, 1]);
			h.change("项目");
			assert.equal(h.state.desktopSearchOpen, false, "同文替换或粘贴仍收起菜单");
			assert.equal(h.pending, 0, "同文编辑不重复查询");
			h.input.click();
			h.change("项目 2026-");
			assert.equal(h.state.desktopSearchOpen, false);
			h.drain(); assert.deepEqual(h.state.search.applied.terms, ["项目 2026-"]);
			for (const open of [false, true]) {
				if (open) h.input.click();
				h.change(""); h.drain(); assert.equal(h.state.desktopSearchOpen, open);
				h.change(" 　"); h.drain(); assert.equal(h.state.desktopSearchOpen, open);
			}
			h.change("20261009");
			assert.equal(h.state.desktopSearchOpen, false);
			h.drain(); assert.equal(h.state.search.applied.dateOrigin, "input");
		} finally { h.dom.window.close(); }
	});
}

test("桌面组合期间保持菜单与防抖保护，确认后收起；取消为空不收起", async () => {
	const h = await desktopSearch();
	try {
		h.input.focus();
		h.input.dispatchEvent(new h.dom.window.CompositionEvent("compositionstart"));
		h.change("zhong", true); h.key("Enter"); h.key("Escape");
		assert.equal(h.state.desktopSearchOpen, true); assert.equal(h.pending, 0); assert.equal(h.queries, 0);
		h.input.value = "中文";
		h.input.dispatchEvent(new h.dom.window.CompositionEvent("compositionend"));
		assert.equal(h.state.desktopSearchOpen, false); assert.equal(h.pending, 1);
		h.change("中文"); assert.equal(h.pending, 1);
		h.input.click(); h.drain(); assert.equal(h.queries, 1); assert.equal(h.state.desktopSearchOpen, true);
		h.change(""); h.drain();
		h.input.dispatchEvent(new h.dom.window.CompositionEvent("compositionstart"));
		h.change("qu", true); h.input.value = "";
		h.input.dispatchEvent(new h.dom.window.CompositionEvent("compositionend"));
		assert.equal(h.state.desktopSearchOpen, true);
	} finally { h.dom.window.close(); }
});

for (const open of [false, true]) {
	test(`程序化宽窄焦点交接保留菜单${open ? "打开" : "关闭"}、原文和选区，组合期间延后`, async () => {
		const h = await desktopSearch();
		const narrow = h.addInput("desktop-narrow");
		try {
			h.input.focus(); h.change("pending query");
			if (open) h.input.click();
			h.input.setSelectionRange(2, 7);
			h.input.dispatchEvent(new h.dom.window.CompositionEvent("compositionstart"));
			h.setWidth(700); h.view.updateCurrentLayout();
			assert.equal(h.dom.window.document.activeElement, h.input);
			h.input.dispatchEvent(new h.dom.window.CompositionEvent("compositionend"));
			assert.equal(h.dom.window.document.activeElement, narrow);
			assert.equal(h.state.desktopSearchOpen, false, "组合确认按非空最终值收起");
			if (open) narrow.click();
			h.setWidth(1000); h.view.updateCurrentLayout();
			assert.equal(h.state.desktopSearchOpen, open);
			h.setWidth(700); h.view.updateCurrentLayout();
			assert.equal(h.state.desktopSearchOpen, open);
			assert.equal(narrow.value, "pending query");
			assert.deepEqual([narrow.selectionStart, narrow.selectionEnd], [2, 7]);
			assert.equal(h.queries, 0);
		} finally { h.dom.window.close(); }
	});
}

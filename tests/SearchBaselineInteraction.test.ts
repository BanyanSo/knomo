import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { KnomoViewStateController } from "../src/ui/KnomoViewStateController";
import { SearchQueryDebounce } from "../src/ui/SearchQueryDebounce";
import type { SearchDateFilter } from "../src/ui/viewFilters";
import type { SidebarNav } from "../src/ui/viewNavigation";
import { ensureObsidianStub } from "./helpers/obsidianStub";

async function desktopSearch(layout: "desktop-wide" | "desktop-narrow" = "desktop-wide") {
	await ensureObsidianStub();
	const { KnomoView } = await import("../src/ui/KnomoView");
	const { renderKnomoDesktopTopbar, renderKnomoCompactHeader } = await import("../src/ui/KnomoHeaderSearch");
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
	let id = 0, queries = 0, renders = 0;
	const view = Object.assign(Object.create(KnomoView.prototype) as {
		registerDesktopSearchInput(input: HTMLInputElement): void;
		registerCompactSearchInput(input: HTMLInputElement): void;
		setSearchQuery(query: string): void;
		setSearchDateFilter(date: SearchDateFilter, source?: HTMLElement | null): void;
		applySidebarTagFilter(tag: string, key: string): void;
		renderScopeState(): void;
		syncSearchControls(): void;
	}, {
		rootEl: root, currentLayout: layout, viewStateController: state,
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
		syncRootState: () => { root.classList.toggle("is-desktop-search-open", state.desktopSearchOpen); view.syncSearchControls(); },
		renderFilteredListState: () => { renders++; view.renderScopeState(); },
		renderUiState: () => view.renderScopeState(),
		refreshCatalogActiveQuery: () => { queries++; },
	});
	const options = {
		createHiddenText: (parent: HTMLElement, name: string, text: string) => { parent.createSpan({ text, attr: { id: name } }); return name; },
		createIconButton: (parent: HTMLElement, _icon: string, label: string, cls: string, action: string) => parent.createEl("button", { cls, attr: { "aria-label": label, "data-action": action } }),
	};
	const input = layout === "desktop-wide" ? renderKnomoDesktopTopbar(root, options).searchInputEl
		: renderKnomoCompactHeader(root, options).inlineSearchInputEl;
	Object.assign(view, layout === "desktop-wide" ? { desktopSearchInputEl: input } : { compactInlineSearchInputEl: input });
	if (layout === "desktop-wide") view.registerDesktopSearchInput(input); else view.registerCompactSearchInput(input);
	const change = (text: string) => { input.value = text; input.dispatchEvent(new dom.window.Event("input")); };
	const key = (key: string) => input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
	const drain = () => { for (const callback of timers.values()) callback(); timers.clear(); };
	return { dom, root, input, view, state, change, key, drain, get queries() { return queries; }, get renders() { return renders; } };
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

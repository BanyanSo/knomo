import test from "node:test";
import assert from "node:assert/strict";
import { createMobilePopupFixture } from "./helpers/mobilePopupFixture";
import { createCardMemo } from "./helpers/memoCardFixture";
import { ensureObsidianStub } from "./helpers/obsidianStub";
import { createReferenceMemo } from "./helpers/referenceMemo";

test("桌面菜单的图标子节点、文字和行内空白均沿真实根路由执行一次，字数行不执行动作", async () => {
	const f = await createMobilePopupFixture();
	try {
		Object.assign(f.view, { currentLayout: "desktop-wide", setTitleMode: (mode: string) => f.calls.push(`scope:${mode}`) });
		f.root.className = "knomo-plugin is-layout-desktop-wide";
		for (const button of Array.from(f.card.querySelectorAll<HTMLButtonElement>("[data-memo-action]"))) {
			const icon = button.querySelector(".knomo-menu-icon")!;
			const svg = f.win.document.createElementNS("http://www.w3.org/2000/svg", "svg");
			const path = f.win.document.createElementNS("http://www.w3.org/2000/svg", "path");
			icon.appendChild(svg).appendChild(path);
			for (const target of [path, button.querySelector(".knomo-menu-label")!, button]) {
				f.openPopup("card");
				const before = f.calls.length;
				await f.click(target);
				assert.deepEqual(f.calls.slice(before), [button.dataset.memoAction]);
			}
		}
		f.openPopup("card");
		const before = f.calls.length;
		await f.click(f.card.querySelector(".knomo-card-word-count .knomo-menu-icon")!);
		assert.equal(f.calls.length, before);
		for (const button of Array.from(f.scopeMenu.querySelectorAll<HTMLButtonElement>("[data-title-mode]"))) {
			f.openPopup("scope");
			const before = f.calls.length;
			await f.click(button.querySelector(".knomo-button-icon")!);
			assert.deepEqual(f.calls.slice(before), [`scope:${button.dataset.titleMode}`]);
		}
	} finally { f.close(); }
});

interface DesktopMenuView {
	currentLayout: "desktop-wide" | "desktop-narrow" | "mobile";
	activeMenuMemoId: string | null;
	startLayoutObserver(): void;
	stopLayoutObserver(): void;
	syncRootState(): void;
	syncCardMenuState(): void;
	handleCardFlowScroll(): void;
}

test("桌面菜单统一使用独立分隔线，关联入口动态更新不进入删除分组", async () => {
	const f = await createMobilePopupFixture();
	const { syncMemoCardRelationsAction } = await import("../src/ui/KnomoCard");
	try {
		const menu = f.card.querySelector<HTMLElement>(".knomo-card-actions")!;
		const separators = Array.from(menu.querySelectorAll('[role="separator"]'));
		for (const hasReferrers of [true, true, false, true, false]) {
			syncMemoCardRelationsAction(f.card, createCardMemo({ id: "p0-memo" }), hasReferrers);
			assert.deepEqual(Array.from(menu.querySelectorAll('[role="separator"]')), separators);
			assert.deepEqual(separators.map(el => el.nextElementSibling?.getAttribute("data-memo-action") ?? el.nextElementSibling?.className), [
				"open-daily", "delete", "knomo-card-word-count",
			]);
			assert.equal(separators[1].previousElementSibling?.getAttribute("data-memo-action"), hasReferrers ? "relations" : "copy-link");
			assert.ok(separators.every(el => !el.hasAttribute("tabindex") && !el.hasAttribute("data-memo-action")));
		}
	} finally { f.close(); }
});

async function createDesktopMenuPositionFixture() {
	const f = await createMobilePopupFixture();
	const { KnomoView } = await import("../src/ui/KnomoView");
	let width = 700, height = 600, scrollCalls = 0;
	let resizeObserved = () => {};
	class Observer {
		constructor(callback: () => void) { resizeObserved = callback; }
		observe() {}
		disconnect() {}
	}
	Object.assign(f.win, { ResizeObserver: Observer });
	Object.assign(f.win.HTMLElement.prototype, {
		find(this: HTMLElement, selector: string) { return this.querySelector(selector); },
		findAll(this: HTMLElement, selector: string) { return Array.from(this.querySelectorAll(selector)); },
		setCssProps(this: HTMLElement, props: Record<string, string>) {
			for (const [key, value] of Object.entries(props)) this.style.setProperty(key, value);
		},
	});
	f.root.className = "knomo-plugin is-layout-desktop-narrow";
	f.root.getBoundingClientRect = () => new f.win.DOMRect(0, 0, width, height);
	const flow = f.root.createDiv({ cls: "knomo-card-flow" });
	flow.appendChild(f.card);
	flow.getBoundingClientRect = () => new f.win.DOMRect(0, 100, width, height - 100);
	const head = f.card.querySelector<HTMLElement>(".knomo-card-head")!;
	const menu = f.card.querySelector<HTMLElement>(".knomo-card-actions")!;
	head.getBoundingClientRect = () => new f.win.DOMRect(12, 116 - flow.scrollTop, width - 24, 18);
	// JSDOM 仅提供布局输入；真实浏览器的尺寸、裁切和滚动仍由下方布局用例覆盖。
	Object.defineProperties(menu, {
		offsetParent: { get: () => head },
		offsetWidth: { get: () => Math.min(168, parseFloat(menu.style.getPropertyValue("--knomo-desktop-menu-max-width")) || 168) },
		offsetHeight: { get: () => Math.min(240, parseFloat(menu.style.getPropertyValue("--knomo-desktop-menu-max-height")) || 240) },
	});
	const view = Object.assign(f.view, {
		containerEl: { win: f.win, doc: f.win.document, getBoundingClientRect: () => f.root.getBoundingClientRect() },
		rootEl: f.root, cardFlowEl: flow, currentLayout: "desktop-narrow", trashViewClosed: false,
		layoutWindow: null, layoutWindowCleanup: null, layoutObserver: null, sidebarResizerEl: null, timeBuoyPickerEl: null,
		desktopSidebarStateController: { getSnapshot: () => ({ width: 248, collapsed: false }) },
		desktopDrawerFocus: { sync: () => {} }, getRootInnerWidth: () => width,
		settingsService: { getSettings: () => ({ mobileCompactMode: "off" }) },
		mobileComposerController: { syncViewportTracking: () => {}, syncLayer: () => {} },
		finishSidebarResize: () => {}, updateMobileComposerMeasurements: () => 0, resizeInput: () => {},
		syncReducedGlassEffects: () => {}, syncTooltipState: () => {}, syncManualRefreshButtonState: () => {}, syncMobileHeaderActions: () => {},
		syncMobileHeaderTitle: () => {}, syncMobileTopOffsets: () => {}, syncMobileSearchPage: () => {}, syncSearchControls: () => {},
		cardFlowCoordinator: { handleScroll: () => scrollCalls++ }, memoMarkdownRenderer: { prioritizeVisible: () => {} },
	}) as unknown as DesktopMenuView;
	Object.defineProperties(view, {
		mobileSearchResultsEl: { value: null },
		mobileSearchPageOpen: { value: false },
	});
	view.syncRootState = (KnomoView.prototype as unknown as DesktopMenuView).syncRootState.bind(view);
	view.syncCardMenuState = (KnomoView.prototype as unknown as DesktopMenuView).syncCardMenuState.bind(view);
	view.activeMenuMemoId = "p0-memo";
	view.syncCardMenuState();
	return {
		f, view, flow, menu,
		resize(widthValue: number, heightValue = height) { width = widthValue; height = heightValue; },
		resizeObserved: () => resizeObserved(), getScrollCalls: () => scrollCalls,
		close() { view.stopLayoutObserver(); f.close(); },
	};
}

test("已打开的桌面卡片菜单随窗口和面板尺寸更新，未跨断点也重新定位", async () => {
	const h = await createDesktopMenuPositionFixture();
	try {
		h.view.startLayoutObserver();
		assert.equal(h.menu.style.getPropertyValue("--knomo-desktop-menu-left"), "508px");
		h.resize(500);
		h.f.win.dispatchEvent(new h.f.win.Event("resize"));
		assert.equal(h.view.currentLayout, "desktop-narrow");
		assert.equal(h.menu.style.getPropertyValue("--knomo-desktop-menu-left"), "308px");
		h.resize(360, 260);
		h.resizeObserved();
		assert.equal(h.menu.style.getPropertyValue("--knomo-desktop-menu-left"), "168px");
		assert.equal(h.menu.style.getPropertyValue("--knomo-desktop-menu-max-height"), "112px");
		assert.equal(h.view.activeMenuMemoId, "p0-memo");
		assert.equal(h.f.card.classList.contains("is-menu-open"), true);
	} finally { h.close(); }
});

test("同一帧内的拾星来源通知合并为一次定向更新", async () => {
	const h = await createDesktopMenuPositionFixture();
	try {
		const view = h.f.view as unknown as { handleFavoritesChanged(refresh: boolean, paths: string[]): void };
		const win = h.f.win;
		const callbacks: FrameRequestCallback[] = [];
		const paths: string[][] = [];
		win.requestAnimationFrame = callback => callbacks.push(callback);
		Object.assign(view, { syncFavoriteCards: (changed: ReadonlySet<string>) => paths.push([...changed]) });
		view.handleFavoritesChanged(false, ["Daily/A.md"]);
		view.handleFavoritesChanged(false, ["Daily/A.md", "Daily/B.md"]);
		assert.equal(callbacks.length, 1);
		assert.deepEqual(paths, []);
		callbacks[0](0);
		assert.deepEqual(paths, [["Daily/A.md", "Daily/B.md"]]);
	} finally { h.close(); }
});

test("桌面已打开的拾星菜单不能操作同一张卡片的新收藏", async () => {
	const h = await createDesktopMenuPositionFixture();
	try {
		const view = h.f.view as unknown as {
			runMemoActionById(action: string, id: string, source: HTMLElement): Promise<void>;
			toggleCardMenu(id: string, keyboard: boolean, source: HTMLElement): void;
			handleFavoritesChanged(refresh: boolean): void;
		};
		const memo = createCardMemo({ id: "p0-memo" });
		let favoriteId = "original";
		const handled: (string | undefined)[] = [];
		Object.assign(view, {
			favoriteService: {},
			findMemoById: () => memo,
			getMemoFavoriteState: () => ({ disabled: false, favoriteId }),
			handleMemoAction: async (_action: string, _memo: typeof memo, _focus: boolean, _beacon: number, token?: string) => { handled.push(token); },
			runMemoActionById: Object.getPrototypeOf(view).runMemoActionById,
		});
		const row = h.menu.createEl("button", { attr: { "data-memo-id": memo.id, "data-memo-action": "unstar", "data-favorite-id": favoriteId } });
		const trigger = h.f.card.querySelector<HTMLElement>(".knomo-card-menu")!;
		h.view.activeMenuMemoId = null;
		view.toggleCardMenu(memo.id, false, trigger);
		assert.equal(h.view.activeMenuMemoId, memo.id);

		favoriteId = "replacement";
		view.handleFavoritesChanged(true);
		assert.equal(h.view.activeMenuMemoId, null);
		await view.runMemoActionById("unstar", memo.id, row);
		assert.deepEqual(handled, []);

		view.toggleCardMenu(memo.id, false, trigger);
		await view.runMemoActionById("unstar", memo.id, row);
		assert.deepEqual(handled, ["replacement"]);
	} finally { h.close(); }
});

test("拾星操作提示区分日记尚未保存、选择失效和无法确认操作结果", async () => {
	await ensureObsidianStub();
	const { Notice } = await import("obsidian");
	const { t } = await import("../src/i18n");
	const { KnomoView } = await import("../src/ui/KnomoView");
	const { DailyAnchorNotSavedError, DailyAnchorChangedError } = await import("../src/services/DailyMemoAnchor");
	const notices: string[] = Reflect.get(Notice, "messages");
	const start = notices.length;
	let failure: Error;
	const fail = async () => { throw failure; };
	const view = Object.assign(Object.create(KnomoView.prototype), {
		closeCardMenu: () => {}, favoriteService: { star: fail, unstar: fail },
	});
	const memo = createReferenceMemo();
	try {
		for (const [action, error, key] of [
			["star", new DailyAnchorNotSavedError(), "favorite.saveDailyFirst"],
			["unstar", new DailyAnchorChangedError(), "favorite.selectionChanged"],
			["star", new Error("write result unknown"), "favorite.starUnconfirmed"],
			["unstar", new Error("write result unknown"), "favorite.unstarUnconfirmed"],
		] as const) {
			failure = error;
			await view.handleMemoAction(action, memo, false, undefined, "star");
			assert.equal(notices.at(-1), t(key));
		}
		assert.equal(notices.length - start, 4);
	} finally { notices.length = start; }
});

test("桌面滚动只重新定位打开的卡片菜单，保留其他卡片状态和分页入口", async () => {
	const h = await createDesktopMenuPositionFixture();
	try {
		const other = h.f.card.cloneNode(true) as HTMLElement;
		other.classList.remove("is-menu-open");
		other.setAttribute("data-memo-id", "other-memo");
		other.querySelector(".knomo-card-menu")!.setAttribute("aria-expanded", "false");
		h.flow.appendChild(other);
		const observer = new h.f.win.MutationObserver(() => {});
		observer.observe(other, { attributes: true, subtree: true });
		const previousHeight = h.menu.style.getPropertyValue("--knomo-desktop-menu-max-height");
		h.flow.scrollTop = 20;
		h.view.handleCardFlowScroll();
		assert.notEqual(h.menu.style.getPropertyValue("--knomo-desktop-menu-max-height"), previousHeight);
		assert.deepEqual(observer.takeRecords(), []);
		assert.equal(h.getScrollCalls(), 1);
		const positionedStyle = h.menu.getAttribute("style");
		h.view.currentLayout = "mobile";
		h.flow.scrollTop = 40;
		h.view.handleCardFlowScroll();
		assert.equal(h.menu.getAttribute("style"), positionedStyle);
		h.view.currentLayout = "desktop-narrow";
		h.view.activeMenuMemoId = null;
		h.view.handleCardFlowScroll();
		assert.equal(h.menu.getAttribute("style"), positionedStyle);
		assert.equal(h.getScrollCalls(), 3);
		observer.disconnect();
	} finally { h.close(); }
});

// 使用真实菜单 DOM、生产定位函数和浏览器布局；宿主 SVG 由占位图形代替，真实主题仍需 Obsidian 验收。

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import type { TranslationKey } from "../src/i18n";
import { createMobilePopupFixture } from "./helpers/mobilePopupFixture";

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
test("桌面菜单在宽窄面板、中英文、明暗主题、宿主字号覆盖与 Knomo Token 放大下显示图标并限制裁切", { skip: !process.env.KNOMO_LAYOUT_PLAYWRIGHT }, async () => {
	const f = await createMobilePopupFixture();
	const menus = { card: f.card.outerHTML, scope: f.scopeMenu.outerHTML };
	f.close();
	const { translate } = await import("../src/i18n");
	const bundle = await build({
		stdin: { contents: 'export { positionDesktopMenu } from "./src/ui/DesktopMenuPosition";', resolveDir: process.cwd(), loader: "ts" },
		bundle: true, write: false, format: "iife", globalName: "DesktopMenuFixture",
	});
	const scopeKeys: Record<string, TranslationKey> = {
		all: "nav.allNotes", things: "nav.things", "no-tag": "filter.noTag", "with-link": "filter.withLink",
		"with-image": "filter.withImage", anniversary: "filter.anniversary", review: "nav.review", random: "nav.random", shuffleDay: "nav.shuffleDay",
	};
	const actionKeys: Record<string, TranslationKey> = {
		edit: "card.edit", reference: "card.reference", "open-daily": "card.openDaily", relations: "relations.title",
		"copy-text": "card.copyText", "copy-link": "card.copyLink", delete: "card.delete",
	};
	const css = readFileSync("styles.css", "utf8");
	const hostCss = process.env.KNOMO_HOST_CSS ? readFileSync(process.env.KNOMO_HOST_CSS, "utf8") : "";
	const { chromium } = require(process.env.KNOMO_LAYOUT_PLAYWRIGHT!);
	const browser = await chromium.launch({ channel: process.env.KNOMO_LAYOUT_BROWSER || "msedge", headless: true });
	try {
		const page = await browser.newPage();
		const errors: string[] = [];
		page.on("pageerror", (error: Error) => errors.push(error.message));
		for (const theme of ["theme-light", "theme-dark"]) for (const { font, scale } of [{ font: 15, scale: 1 }, { font: 22, scale: 1 }, { font: 15, scale: 1.5 }, { font: 15, scale: 2 }]) for (const locale of ["en", "zh-CN"] as const) {
			for (const [width, height] of [[1000, 720], [360, 320], [180, 260]]) {
				const narrow = width < 780;
				const scope = narrow ? menus.scope : menus.scope.replace("knomo-mobile-scope-popover", "knomo-desktop-scope-popover");
				await page.setViewportSize({ width, height });
				await page.setContent(`<style>${hostCss}${css}
					body{margin:0;display:block;font:${font}px Arial;background:var(--background-primary);--font-ui-medium:${font}px;--border-width:1px;--text-normal:${theme === "theme-dark" ? "#ddd" : "#222"};--text-muted:var(--text-normal);--text-error:#d33;--background-primary:${theme === "theme-dark" ? "#222" : "#fff"};--background-secondary:var(--background-primary)}
					body{--knomo-text-ui-medium:${15 * scale}px;--knomo-text-ui-base:${14 * scale}px;--knomo-text-meta:${13 * scale}px;--knomo-text-caption:${12 * scale}px}
					#root{position:relative;display:block;margin:20px;width:calc(100vw - 40px);height:calc(100vh - 40px)}
					#bounds{position:relative;display:block;width:100%;height:100%;padding:0;overflow:hidden}
					#header{display:flex;position:relative;height:48px;padding:0}
					#flow{position:absolute;top:60px;bottom:0;left:0;right:0;padding:0;overflow:auto}
					#root *{transition:none!important}
					#root .knomo-card{margin:0}
				</style><body class="${theme}"><div id="root" class="knomo-plugin is-layout-desktop-${narrow ? "narrow" : "wide"} is-scope-open"><main id="bounds" class="knomo-main"><div id="header" class="${narrow ? "knomo-compact-header" : "knomo-topbar"}"><div class="knomo-scope-wrap"><button id="anchor" type="button">All notes</button>${narrow ? "" : scope}</div></div>${narrow ? scope : ""}<div id="flow" class="knomo-card-flow">${menus.card}</div></main></div></body>`);
				await page.addScriptTag({ content: bundle.outputFiles[0].text });
				await page.evaluate(({ scopeLabels, actionLabels, wordCount }: { scopeLabels: Record<string, string>; actionLabels: Record<string, string>; wordCount: string }) => {
					Object.assign(HTMLElement.prototype, {
						setCssProps(this: HTMLElement, props: Record<string, string>) {
							for (const [key, value] of Object.entries(props)) this.style.setProperty(key, value);
						},
					});
					for (const el of Array.from(document.querySelectorAll<HTMLElement>("[data-title-mode]"))) el.querySelector(".knomo-button-label")!.textContent = scopeLabels[el.dataset.titleMode!];
					for (const el of Array.from(document.querySelectorAll<HTMLElement>("[data-memo-action]"))) {
						const label = actionLabels[el.dataset.memoAction!];
						if (!label?.trim()) throw new Error(`Missing menu label: ${el.dataset.memoAction}`);
						el.querySelector(".knomo-menu-label")!.textContent = label;
						el.setAttribute("aria-label", label);
					}
					document.querySelector(".knomo-card-word-count .knomo-menu-label")!.textContent = wordCount;
					for (const el of Array.from(document.querySelectorAll(".knomo-menu-icon, .knomo-button-icon"))) el.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 12h16" stroke="currentColor"/></svg>';
				}, { scopeLabels: Object.fromEntries(Object.entries(scopeKeys).map(([key, label]) => [key, translate(locale, label)])), actionLabels: Object.fromEntries(Object.entries(actionKeys).map(([key, label]) => [key, translate(locale, label)])), wordCount: translate(locale, "card.wordCount", { count: 123456789 }) });
				for (const kind of ["scope", "card"] as const) {
					const result = await page.evaluate((kind: "scope" | "card") => {
						const api = (window as unknown as { DesktopMenuFixture: { positionDesktopMenu: (menu: HTMLElement, anchor: HTMLElement, bounds: HTMLElement, align: "start" | "end") => boolean } }).DesktopMenuFixture;
						const root = document.querySelector<HTMLElement>("#root")!;
						root.classList.toggle("is-scope-open", kind === "scope");
						const card = document.querySelector<HTMLElement>(".knomo-card")!;
						card.classList.toggle("is-menu-open", kind === "card");
						const menu = document.querySelector<HTMLElement>(kind === "scope" ? ".knomo-scope-popover" : ".knomo-card-actions")!;
						const bounds = document.querySelector<HTMLElement>(kind === "scope" ? "#bounds" : "#flow")!;
						const anchor = document.querySelector<HTMLElement>(kind === "scope" ? "#anchor" : ".knomo-card-head")!;
						const above = api.positionDesktopMenu(menu, anchor, bounds, kind === "scope" ? "start" : "end");
						card.classList.toggle("is-menu-above", above);
						const rect = menu.getBoundingClientRect(), bound = bounds.getBoundingClientRect();
						const icons = Array.from(menu.querySelectorAll<HTMLElement>(".knomo-menu-icon, .knomo-button-icon"));
						const rows = Array.from(menu.querySelectorAll<HTMLElement>("button"));
						const last = menu.lastElementChild as HTMLElement;
						// 极窄视口放大后，非交互字数区可能高于菜单；验证其首尾都可滚动抵达。
						menu.scrollTop = last.offsetTop;
						const lastStartReachable = last.getBoundingClientRect().top >= menu.getBoundingClientRect().top - 1;
						menu.scrollTop = menu.scrollHeight;
						return {
							actions: rows.map(el => el.dataset.memoAction),
							labels: rows.map(el => el.querySelector(".knomo-menu-label, .knomo-button-label")?.textContent?.trim() ?? ""),
							accessibleLabels: rows.map(el => el.getAttribute("aria-label")),
							within: rect.left >= bound.left + 7 && rect.right <= bound.right - 7 && rect.top >= bound.top + 7 && rect.bottom <= bound.bottom - 7,
							width: rect.width, boundWidth: bound.width,
							icons: icons.length, iconsVisible: icons.every(el => el.getBoundingClientRect().width === 16 && el.getBoundingClientRect().height === 16 && el.getAttribute("aria-hidden") === "true"),
							iconsAligned: icons.every(el => Math.abs(el.getBoundingClientRect().left - icons[0].getBoundingClientRect().left) <= 1),
							rowsFit: rows.every(el => el.getBoundingClientRect().height >= 32 && el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 1),
							fontSizes: rows.map(el => getComputedStyle(el).fontSize),
							wordCountSize: getComputedStyle(card.querySelector(".knomo-card-word-count")!).fontSize,
							lastStartReachable,
							lastReachable: last.getBoundingClientRect().bottom <= menu.getBoundingClientRect().bottom + 1,
							scrollable: menu.scrollHeight > menu.clientHeight,
						};
					}, kind);
					const context = `${theme}/${font}/${scale}/${locale}/${width}/${kind}`;
					assert.equal(result.within, true, context);
					assert.equal(result.width, Math.min(168, result.boundWidth - 16), context);
					assert.equal(result.icons, kind === "scope" ? 9 : 8, context);
					assert.ok(result.labels.every((label: string) => label.length > 0), `${context}: every menu row has text`);
					if (kind === "card") {
						assert.deepEqual(result.actions, Object.keys(actionKeys), `${context}: all seven actions remain in order`);
						const labels = Object.values(actionKeys).map(key => translate(locale, key));
						assert.deepEqual(result.labels, labels, `${context}: translated labels include relations`);
						assert.deepEqual(result.accessibleLabels, labels, `${context}: accessible names match visible text`);
					}
					assert.equal(result.iconsVisible, true, context);
					assert.equal(result.iconsAligned, true, context);
					assert.equal(result.rowsFit, true, context);
					assert.ok(result.fontSizes.every((size: string) => size === `${14 * scale}px`), context);
					assert.equal(result.wordCountSize, `${13 * scale}px`, context);
					assert.equal(result.lastStartReachable, true, context);
					assert.equal(result.lastReachable, true, context);
					if (width === 180 || (width === 360 && kind === "scope")) assert.equal(result.scrollable, true, context);
				}
			}
		}
		await page.setViewportSize({ width: 800, height: 600 });
		const placements = await page.evaluate(() => {
			const api = (window as unknown as { DesktopMenuFixture: { positionDesktopMenu: (menu: HTMLElement, anchor: HTMLElement, bounds: HTMLElement, align: "start" | "end") => boolean } }).DesktopMenuFixture;
			const root = document.querySelector<HTMLElement>("#root")!;
			// 放大矩阵已验证；以下用默认字号独立验证空间变化和自定义菜单宽度。
			for (const [name, size] of [["ui-medium", 15], ["ui-base", 14], ["meta", 13], ["caption", 12]] as const) root.style.setProperty("--knomo-text-" + name, size + "px");
			const flow = document.querySelector<HTMLElement>("#flow")!;
			const card = document.querySelector<HTMLElement>(".knomo-card")!;
			const head = card.querySelector<HTMLElement>(".knomo-card-head")!;
			const menu = card.querySelector<HTMLElement>(".knomo-card-actions")!;
			root.style.setProperty("--knomo-dropdown-width", "232px");
			root.style.height = "400px";
			card.style.marginTop = "240px";
			flow.scrollTop = 0;
			const above = api.positionDesktopMenu(menu, head, flow, "end");
			card.classList.toggle("is-menu-above", above);
			const aboveFits = menu.getBoundingClientRect().bottom <= head.getBoundingClientRect().top - 5;
			root.style.height = "160px";
			card.style.marginTop = "30px";
			flow.scrollTop = 0;
			api.positionDesktopMenu(menu, head, flow, "end");
			const shortScrollable = menu.scrollHeight > menu.clientHeight;
			root.style.height = "700px";
			card.style.marginTop = "-100px";
			flow.scrollTop = 0;
			api.positionDesktopMenu(menu, head, flow, "end");
			const clippedWindowFits = menu.getBoundingClientRect().top >= flow.getBoundingClientRect().top + 7 && menu.getBoundingClientRect().bottom <= innerHeight - 7;
			root.style.height = "500px";
			card.style.marginTop = "0px";
			const below = !api.positionDesktopMenu(menu, head, flow, "end");
			card.classList.remove("is-menu-above");
			const expanded = menu.scrollHeight <= menu.clientHeight && menu.offsetWidth === 232;
			root.classList.add("is-scope-open");
			card.classList.remove("is-menu-open");
			document.querySelector<HTMLElement>("#header")!.style.justifyContent = "flex-end";
			const scope = document.querySelector<HTMLElement>(".knomo-scope-popover")!;
			const bounds = document.querySelector<HTMLElement>("#bounds")!;
			api.positionDesktopMenu(scope, document.querySelector<HTMLElement>("#anchor")!, bounds, "start");
			const scopeUsesActualWidth = scope.offsetWidth === 232 && scope.getBoundingClientRect().right <= bounds.getBoundingClientRect().right - 7;
			return { above, aboveFits, shortScrollable, clippedWindowFits, below, expanded, scopeUsesActualWidth };
		});
		assert.deepEqual(placements, { above: true, aboveFits: true, shortScrollable: true, clippedWindowFits: true, below: true, expanded: true, scopeUsesActualWidth: true });
		if (process.env.KNOMO_DESKTOP_MENU_SCREENSHOT) await page.screenshot({ path: process.env.KNOMO_DESKTOP_MENU_SCREENSHOT });
		assert.deepEqual(errors, []);
	} finally { await browser.close(); }
});

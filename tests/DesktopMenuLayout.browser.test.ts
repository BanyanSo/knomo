import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import type { TranslationKey } from "../src/i18n";
import { createMobilePopupFixture } from "./helpers/mobilePopupFixture";
import { createCardMemo } from "./helpers/memoCardFixture";

test("桌面菜单在宽窄面板、中英文、明暗主题、宿主字号覆盖与 Knomo Token 放大下显示图标并限制裁切", { skip: !process.env.KNOMO_LAYOUT_PLAYWRIGHT }, async () => {
	const f = await createMobilePopupFixture();
	// 当前菜单仅在有直接引用者时显示关联入口，布局矩阵显式构造完整菜单。
	assert.equal(f.card.querySelector('[data-memo-action="relations"]'), null);
	const { syncMemoCardRelationsAction } = await import("../src/ui/KnomoCard");
	syncMemoCardRelationsAction(f.card, createCardMemo({ id: "p0-memo" }), true);
	const menus = { card: f.card.outerHTML, scope: f.scopeMenu.outerHTML };
	f.close();
	const { translate } = await import("../src/i18n");
	const bundle = await build({
		stdin: { contents: 'export { positionDesktopMenu } from "./src/ui/DesktopMenuPosition";', resolveDir: process.cwd(), loader: "ts" },
		bundle: true, write: false, format: "iife", globalName: "DesktopMenuFixture",
	});
	const scopeKeys: Record<string, TranslationKey> = {
		all: "nav.allNotes", things: "nav.things", favorites: "favorite.title", "no-tag": "filter.noTag", "with-link": "filter.withLink",
		referenced: "filter.referenced",
		"with-image": "filter.withImage", anniversary: "filter.anniversary", review: "nav.review", random: "nav.random", shuffleDay: "nav.shuffleDay",
	};
	const actionKeys: Record<string, TranslationKey> = {
		reference: "card.reference", edit: "card.edit", "share-image": "share.share", "copy-text": "card.copyText",
		"open-daily": "card.openDaily", "copy-link": "card.copyLink", relations: "relations.title", delete: "card.delete",
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
					body{margin:0;display:block;font:${font}px Arial;background:var(--background-primary);--font-ui-medium:${font}px;--border-width:1px;--text-normal:${theme === "theme-dark" ? "#ddd" : "#222"};--text-muted:var(--text-normal);--text-error:#d33;--background-modifier-border:${theme === "theme-dark" ? "#444" : "#ccc"};--background-primary:${theme === "theme-dark" ? "#222" : "#fff"};--background-secondary:var(--background-primary)}
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
							groupSeparators: kind === "card" ? Array.from(menu.querySelectorAll<HTMLElement>('[role="separator"]')).map(el => ({ section: el.dataset.beforeSection, border: getComputedStyle(el).borderTopStyle })) : [],
							scopeSeparators: kind === "scope" ? Array.from(menu.querySelectorAll<HTMLElement>('[role="separator"]')).map(el => ({ group: el.dataset.beforeGroup, border: getComputedStyle(el).borderTopStyle })) : [],
							lastStartReachable,
							lastReachable: last.getBoundingClientRect().bottom <= menu.getBoundingClientRect().bottom + 1,
							scrollable: menu.scrollHeight > menu.clientHeight,
						};
					}, kind);
					const context = `${theme}/${font}/${scale}/${locale}/${width}/${kind}`;
					assert.equal(result.within, true, context);
					assert.equal(result.width, Math.min(168, result.boundWidth - 16), context);
					assert.equal(result.icons, kind === "scope" ? 11 : 9, context);
					if (kind === "scope") assert.deepEqual(result.scopeSeparators, ["filters", "revisit"].map(group => ({ group, border: "solid" })), context);
					assert.ok(result.labels.every((label: string) => label.length > 0), `${context}: every menu row has text`);
					if (kind === "card") {
						assert.deepEqual(result.actions, Object.keys(actionKeys), `${context}: all eight actions remain in order`);
						assert.deepEqual(result.groupSeparators, ["knomo-card-navigation", "knomo-card-danger", "knomo-card-info"].map(section => ({ section, border: "solid" })), `${context}: all groups use the same separator`);
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

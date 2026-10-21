import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import type { MobileHeaderTitleController } from "../src/ui/MobileHeaderTitleController";

interface HeaderWindow extends Window {
	HeaderFixture: { MobileHeaderTitleController: typeof MobileHeaderTitleController };
	titleController: MobileHeaderTitleController;
	headerEvents: { scope: number; search: number; sidebar: number };
}

// 复现宿主的 flex 标题槽、手机安全区及原生按钮尺寸；不依赖本地 Obsidian 安装。
// 对照沿用已有的无底边框设置，隔离本次布局与既有材质差异。
const hostFixture = `
	* { box-sizing:border-box; }
	body.is-mobile { margin:0; font:16px/1.5 Arial; --header-height:40px; --view-header-height:var(--fixture-height); --file-header-border:0;
		--view-header-top-offset:max(var(--fixture-safe), var(--size-4-3)); --safe-area-inset-top:var(--fixture-safe);
		--file-header-justify:start; --view-header-position:relative; --font-ui-medium:15px; --font-normal:400;
		--size-2-1:2px; --size-2-2:4px; --size-2-3:6px; --size-4-1:4px; --size-4-2:8px; --size-4-3:12px; --size-4-4:16px;
		--background-primary:#fff; --background-secondary:#eee; --text-normal:#222; --text-muted:#666; }
	.theme-dark { --background-primary:#222; --background-secondary:#333; --text-normal:#eee; --text-muted:#bbb; }
	.workspace-leaf-content { position:relative; width:100%; height:100vh; display:flex; flex-direction:column; overflow:hidden; }
	.view-header { height:var(--view-header-height); display:flex; position:relative; flex-shrink:0; z-index:1;
		gap:var(--size-4-2); padding:0 var(--size-4-3); }
	.view-header-left { display:flex; align-items:center; flex:0; }
	.view-header-nav-buttons { display:flex; align-items:center; }
	.view-header-title-container { flex:1 1 auto; min-width:0; overflow:hidden; position:relative;
		display:flex; align-items:center; justify-content:var(--file-header-justify); height:var(--view-header-height); }
	.view-header-title-parent { display:flex; color:var(--text-muted); white-space:nowrap; }
	.view-header-title-parent:empty { display:none; }
	.view-header-title { flex:0 0 auto; max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:pre; }
	.view-header-title:focus-within { overflow:auto; text-overflow:unset; }
	.view-actions { display:flex; align-items:center; justify-content:flex-end; padding:var(--size-4-2) 0; gap:var(--size-2-1); }
	.view-action { display:flex; align-items:center; justify-content:center; flex-shrink:0; margin:auto 0; padding:4px 6px; }
	.view-action svg { width:24px; height:24px; }
	body.is-phone { --file-header-justify:center; }
	.is-phone .view-header { position:var(--view-header-position); padding-top:var(--view-header-top-offset); gap:var(--size-4-3); height:auto; width:100%; }
	.is-phone .view-header-nav-buttons { display:none; }
	.is-phone .view-header-left { height:var(--view-header-height); }
	.is-phone .view-header-left .view-action { margin:0; padding:0; z-index:1; }
	.is-phone .view-header .view-actions { margin:0; padding:0; flex-grow:0; margin-inline-start:auto; height:var(--view-header-height); z-index:1; }
	.is-phone .view-header .view-action { width:var(--view-header-height); height:100%; }
	.is-phone .view-header-title { display:block; }
	.is-phone:is(.is-floating-nav, .auto-full-screen) { --view-header-position:fixed;
		--view-top-spacing:calc(var(--fixture-safe) + var(--view-header-height) + var(--fixture-view-gap)); }
	.is-phone.is-floating-nav .view-header { margin-top:var(--view-header-top-offset); padding-top:0; left:0; right:0; }
	.view-content { min-height:0; flex:1; }
	.knomo-plugin, .knomo-shell, .knomo-main, .knomo-content-column { height:100%; }
	.knomo-shell, .knomo-main, .knomo-content-column { display:flex; }
	.knomo-main, .knomo-content-column { flex:1; flex-direction:column; min-height:0; }
	.knomo-card-flow { flex:1; min-height:0; overflow:auto; }
	.fixture-card { height:160px; }
`;

async function headerBundle(): Promise<string> {
	const result = await build({
		stdin: { contents: 'export { MobileHeaderTitleController } from "./src/ui/MobileHeaderTitleController";', resolveDir: process.cwd() },
		bundle: true, write: false, format: "iife", globalName: "HeaderFixture",
	});
	return result.outputFiles[0].text;
}

const installHeader = () => {
	Object.assign(HTMLElement.prototype, {
		empty(this: HTMLElement) { this.replaceChildren(); },
		setText(this: HTMLElement, text: string) { this.textContent = text; },
		addClass(this: HTMLElement, cls: string) { this.classList.add(cls); },
		removeClass(this: HTMLElement, cls: string) { this.classList.remove(cls); },
		setAttr(this: HTMLElement, name: string, value: string) { this.setAttribute(name, value); },
		createSpan(this: HTMLElement, options: { cls?: string; text?: string } = {}) {
			const span = this.ownerDocument.createElement("span");
			span.className = options.cls ?? "";
			span.textContent = options.text ?? "";
			return this.appendChild(span);
		},
	});
	const fixture = window as unknown as HeaderWindow;
	fixture.headerEvents = { scope: 0, search: 0, sidebar: 0 };
	fixture.titleController = new fixture.HeaderFixture.MobileHeaderTitleController({
		registerDomEvent: (target, type, listener) => target.addEventListener(type, listener),
		renderChevron: container => container.createSpan({ cls: "knomo-title-chevron", text: "⌄" }),
		canToggleScopeMenu: () => document.querySelector(".view-header-title")!.getAttribute("role") === "button",
		onToggleScopeMenu: () => { fixture.headerEvents.scope++; },
	});
	document.querySelector(".fixture-search")!.addEventListener("click", () => { fixture.headerEvents.search++; });
	document.querySelector(".fixture-sidebar")!.addEventListener("click", () => { fixture.headerEvents.sidebar++; });
};

const syncTitle = ({ label, stats }: { label: string; stats: boolean }) => {
	(window as unknown as HeaderWindow).titleController.sync({
		headerEl: document.querySelector<HTMLElement>(".view-header")!,
		titleEl: document.querySelector<HTMLElement>(".view-header-title")!,
		label, isRecordStats: stats, scopeMenuOpen: false,
	});
	document.querySelector(".fixture-search")!.classList.toggle("knomo-record-stats-back", stats);
};

const geometry = () => [
	document.querySelector(".view-header")!, document.querySelector(".fixture-sidebar")!,
	document.querySelector(".fixture-search") ?? document.querySelector(".fixture-more")!,
	document.querySelector(".view-header-title-container")!, document.querySelector(".view-header-title")!,
].map(element => {
	const rect = element.getBoundingClientRect();
	return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
});

for (const stats of [false, true]) test(`mobile ${stats ? "statistics" : "filter"} header adds lower space while retaining native control positions`, { skip: !process.env.KNOMO_LAYOUT_PLAYWRIGHT }, async () => {
	const { chromium } = require(process.env.KNOMO_LAYOUT_PLAYWRIGHT!);
	const browser = await chromium.launch({ headless: true, channel: process.env.KNOMO_LAYOUT_BROWSER || "msedge" });
	const css = readFileSync("styles.css", "utf8");
	const extraHost = process.env.KNOMO_LAYOUT_HOST_CSS ? readFileSync(process.env.KNOMO_LAYOUT_HOST_CSS, "utf8") : "";
	const bundle = await headerBundle();
	try {
		const page = await browser.newPage();
		for (const [theme, height] of [["theme-light", 44], ["theme-dark", 40], ["theme-light", 52]] as const) {
			for (const width of [320, 390, 844, 768]) for (const mode of width === 768 ? [""] : ["", "is-floating-nav", "auto-full-screen"]) {
				const phone = width !== 768;
				const safe = phone ? width === 320 ? 0 : width === 844 ? 20 : 59 : 0;
				const context = `${stats}/${theme}/${height}/${width}/${mode}`;
				await page.setViewportSize({ width, height: width === 844 ? 390 : 844 });
				await page.setContent(`<style>${extraHost}${hostFixture}${css}</style><body class="is-mobile ${phone ? "is-phone" : "is-tablet"} show-view-header ${theme} ${mode}" style="--fixture-height:${height}px;--fixture-safe:${safe}px;--fixture-view-gap:8px">
					<div class="workspace-leaf-content" data-type="markdown"><div class="view-header">
					<div class="view-header-left"><div class="view-header-nav-buttons"></div><div class="clickable-icon view-action fixture-sidebar" role="button" tabindex="0" aria-label="Sidebar"><svg></svg></div></div>
					<div class="view-header-title-container"><div class="view-header-title-parent">Journals / </div><div class="view-header-title">2026-10-18</div></div>
					<div class="view-actions mod-raised"><div class="clickable-icon view-action fixture-read" role="button" aria-label="Read"><svg></svg></div><div class="clickable-icon view-action fixture-more" role="button" aria-label="More"><svg></svg></div></div></div>
					<div class="view-content"><div class="knomo-plugin is-layout-mobile"><div class="knomo-shell"><div class="knomo-main"><div class="knomo-content-column"><div class="knomo-card-flow">
					${stats ? "" : '<div class="fixture-flow-start knomo-recent-flow-decoration knomo-recent-flow-date"><span class="knomo-recent-flow-relative">今天</span><span class="knomo-recent-flow-calendar">10月21日</span></div>'}
					<div class="fixture-card knomo-card ${stats ? "fixture-flow-start" : ""}">Memo</div><div class="fixture-card knomo-card">Next memo</div></div></div></div></div></div></div></div></body>`);
				const native = await page.evaluate(geometry);
				await page.addScriptTag({ content: bundle });
				await page.locator(".view-actions").evaluate((el: HTMLElement) => {
					const action = el.ownerDocument.createElement("div");
					action.className = "clickable-icon view-action fixture-search knomo-mobile-header-action";
					action.setAttribute("role", "button");
					action.setAttribute("tabindex", "0");
					action.setAttribute("aria-label", "Search");
					action.appendChild(el.querySelector("svg")!.cloneNode(true));
					el.appendChild(action);
				});
				await page.locator(".view-header-title-parent").evaluate((el: HTMLElement) => { el.textContent = ""; });
				await page.locator(".view-header-title").evaluate((el: HTMLElement) => { el.textContent = "Knomo"; });
				await page.evaluate(installHeader);
				await page.locator(".workspace-leaf-content").evaluate((el: HTMLElement) => el.setAttribute("data-type", "knomo-view"));
				await page.evaluate(syncTitle, { label: "Knomo", stats });
				await page.locator(".view-header").evaluate((el: HTMLElement) => { el.style.paddingBottom = "0px"; });
				const beforeFooter = await page.evaluate(geometry);
				await page.locator(".view-header").evaluate((el: HTMLElement) => el.style.removeProperty("padding-bottom"));
				for (const label of [stats ? "记录统计" : "全部笔记", "很长的筛选标题 LongFilterWithoutBreaks".repeat(8), "图片"]) {
					await page.evaluate(syncTitle, { label, stats });
					const current = await page.evaluate(geometry);
					const bottomSpace = phone ? 8 : 0;
					assert.deepEqual(current[0], { ...native[0], height: native[0].height + bottomSpace }, `${context}: lower space belongs to header`);
					assert.deepEqual(current.slice(1, 4), beforeFooter.slice(1, 4), `${context}: lower space does not move buttons or title slot`);
					if (!stats) assert.deepEqual(current.slice(1, 3), native.slice(1, 3), `${context}: native edge buttons stay in place`);
					const clearance = current[0].y + current[0].height - current[3].y - current[3].height;
					if (phone) assert.equal(clearance, bottomSpace, `${context}: breathing room below buttons`);
					const headerBottom = current[0].y + current[0].height;
					assert.ok(await page.locator(".fixture-flow-start").evaluate((el: HTMLElement) => el.getBoundingClientRect().top) >= headerBottom, `${context}: first content clears header`);
					if (phone && !stats) {
						const textTop = await page.locator(".knomo-recent-flow-relative").evaluate((el: HTMLElement) => el.getBoundingClientRect().top);
						assert.equal(textTop - headerBottom, 8, `${context}: today text begins 8px below header`);
					}
					const cardGap = await page.locator(".fixture-card").evaluateAll((cards: HTMLElement[]) => cards[1].getBoundingClientRect().top - cards[0].getBoundingClientRect().bottom);
					assert.equal(cardGap, 8, `${context}: adjacent cards retain their 8px gap`);
					const centerY = (rect: typeof native[number]) => rect.y + rect.height / 2;
					assert.ok(Math.abs(centerY(current[4]) - centerY(native[4])) < 1, `${context}: title follows native vertical alignment`);
					assert.equal(current[4].height, current[3].height, `${context}: title uses the native slot height`);
					if (phone) assert.ok(Math.abs(centerY(current[4]) - centerY(native[2])) < 1, `${context}: title aligns with phone actions`);
					assert.ok(current[4].x >= current[3].x && current[4].x + current[4].width <= current[3].x + current[3].width + 1, `${context}: title stays inside native slot`);
					if (phone) assert.ok(Math.abs(current[4].x + current[4].width / 2 - current[3].x - current[3].width / 2) < 1, `${context}: filter group centered in its host slot`);
					const text = await page.locator(".knomo-mobile-title > span:first-child").evaluate((el: HTMLElement) => ({
						width: el.clientWidth, scroll: el.scrollWidth, overflow: getComputedStyle(el).textOverflow,
					}));
					if (label.length > 100) {
						assert.ok(text.scroll > text.width, `${context}: long text shrinks`);
						assert.equal(text.overflow, "ellipsis", `${context}: long text is ellipsized`);
					}
					if (!stats) {
						const chevron = await page.locator(".knomo-title-chevron").boundingBox();
						assert.ok(chevron && chevron.x + chevron.width <= current[4].x + current[4].width + 1, `${context}: chevron remains visible`);
						await page.locator(".knomo-mobile-title").click();
						assert.equal(await page.locator(".knomo-mobile-title").evaluate((el: HTMLElement) => getComputedStyle(el).overflowX), "hidden", `${context}: focusing the filter does not scroll the title`);
					}
				}
				if (phone && mode) {
					await page.locator("body").evaluate((el: HTMLElement) => el.style.setProperty("--fixture-view-gap", "32px"));
					const top = await page.locator(".fixture-flow-start").evaluate((el: HTMLElement) => el.getBoundingClientRect().top);
					assert.equal(top, Math.max(safe + height + 32, native[2].y + native[2].height + 8), `${context}: preserve larger host spacing without adding it twice`);
				}
				await page.locator(".fixture-search").click();
				await page.locator(".fixture-sidebar").click();
				if (!stats) {
					await page.locator(".knomo-mobile-title").focus();
					await page.keyboard.press("Enter");
					await page.keyboard.press("Space");
				}
				assert.deepEqual(await page.evaluate(() => (window as unknown as HeaderWindow).headerEvents), { scope: stats ? 0 : 5, search: 1, sidebar: 1 }, context);
				await page.evaluate(() => (window as unknown as HeaderWindow).titleController.remove());
				await page.locator(".fixture-search").evaluate((el: HTMLElement) => el.remove());
				await page.locator(".view-header-title-parent").evaluate((el: HTMLElement) => { el.textContent = "Journals / "; });
				await page.locator(".view-header-title").evaluate((el: HTMLElement) => { el.textContent = "2026-10-18"; });
				await page.locator(".workspace-leaf-content").evaluate((el: HTMLElement) => el.setAttribute("data-type", "markdown"));
				assert.deepEqual(await page.evaluate(geometry), native, `${context}: native view restored`);
			}
		}
	} finally { await browser.close(); }
});

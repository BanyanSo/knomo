import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import type { ComposerEditor } from "../src/ui/ComposerEditor";

interface TypographyWindow extends Window {
	KnomoTypographyFixture: {
		ComposerEditor: typeof ComposerEditor;
		createMobileComposerLayer: typeof import("../src/ui/MobileComposerLayer").createMobileComposerLayer;
		measureSuggestionContentWidth: typeof import("../src/ui/composerSuggestPosition").measureSuggestionContentWidth;
		KnomoTagSuggest: typeof import("../src/ui/KnomoTagSuggest").KnomoTagSuggest;
		KnomoWikiLinkSuggest: typeof import("../src/ui/KnomoWikiLinkSuggest").KnomoWikiLinkSuggest;
		renderKnomoListSummary: typeof import("../src/ui/KnomoFeed").renderKnomoListSummary;
		renderKnomoActionableListSummary: typeof import("../src/ui/KnomoFeed").renderKnomoActionableListSummary;
		renderKnomoRandomReunionToolbar: typeof import("../src/ui/KnomoFeed").renderKnomoRandomReunionToolbar;
		renderKnomoShuffleDayHeader: typeof import("../src/ui/KnomoFeed").renderKnomoShuffleDayHeader;
		renderKnomoCardFlowHeaders: typeof import("../src/ui/KnomoFeed").renderKnomoCardFlowHeaders;
		MobileHeaderTitleController: typeof import("../src/ui/MobileHeaderTitleController").MobileHeaderTitleController;
		undoDepth: typeof import("@codemirror/commands").undoDepth;
		undo: typeof import("@codemirror/commands").undo;
		redo: typeof import("@codemirror/commands").redo;
	};
	editor: ComposerEditor;
	tagSuggest: import("../src/ui/KnomoTagSuggest").KnomoTagSuggest;
	wikiSuggest: import("../src/ui/KnomoWikiLinkSuggest").KnomoWikiLinkSuggest;
	retainedState: import("@codemirror/state").EditorState;
	retainedCapture: ReturnType<ComposerEditor["capture"]>;
}

// 布局由真实浏览器和编辑器测量；默认宿主样式自包含，外部快照只作附加输入。
const hostFixture = `
	* { box-sizing: border-box; }
	body { margin:0; display:block; font:19px Arial; --font-text:Arial; --font-monospace:monospace;
		--font-ui-medium:19px; --font-ui-small:17px; --font-ui-smaller:15px; --font-ui-large:24px;
		--font-normal:400; --font-medium:500; --font-semibold:600; --border-width:1px;
		--size-2-1:2px; --size-2-2:4px; --size-4-1:4px; --size-4-2:8px; --size-4-3:12px;
		--size-4-4:16px; --size-4-5:20px; --size-4-6:24px; --size-4-8:32px;
		--background-primary:white; --background-secondary:#eee; --text-normal:#222; --text-muted:#666; }
	button, input, .suggestion-item { font:inherit; }
	.theme-dark { --background-primary:#202020; --background-secondary:#282828; --text-normal:#eee; --text-muted:#bbb; }
	.menu, .setting-item, .modal, .view-header { font-size:var(--font-ui-medium); }
	.markdown-rendered h2 { font-size:1.5em; }
	.markdown-rendered code { font-family:var(--font-monospace); font-size:0.9em; }
	.probe { display:block; width:calc(100% - 32px); margin:16px; height:auto; }
`;

async function typographyBundle() {
	const result = await build({
		stdin: { contents: `
			export { ComposerEditor } from "./src/ui/ComposerEditor";
			export { createMobileComposerLayer } from "./src/ui/MobileComposerLayer";
			export { measureSuggestionContentWidth } from "./src/ui/composerSuggestPosition";
			export { KnomoTagSuggest } from "./src/ui/KnomoTagSuggest";
			export { KnomoWikiLinkSuggest } from "./src/ui/KnomoWikiLinkSuggest";
			export { renderKnomoListSummary, renderKnomoActionableListSummary, renderKnomoRandomReunionToolbar, renderKnomoShuffleDayHeader, renderKnomoCardFlowHeaders } from "./src/ui/KnomoFeed";
			export { MobileHeaderTitleController } from "./src/ui/MobileHeaderTitleController";
			export { undoDepth, undo, redo } from "@codemirror/commands";
		`, resolveDir: process.cwd(), loader: "ts" },
		bundle: true, write: false, format: "iife", globalName: "KnomoTypographyFixture",
		plugins: [{ name: "host-api-fixture", setup(builder) {
			builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "fixture" }));
			builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: `
				export const getLanguage = () => "en";
				export const prepareFuzzySearch = () => () => null;
				export const renderResults = (el, text) => { el.textContent = text; };
			`, loader: "js" }));
		} }],
	});
	return result.outputFiles[0].text;
}

const installDomHelpers = () => {
	Object.assign(HTMLElement.prototype, {
		createEl(this: HTMLElement, tag: string, options: { cls?: string; text?: string; attr?: Record<string, string> } = {}) {
			const el = this.ownerDocument.createElement(tag);
			el.className = options.cls ?? "";
			el.textContent = options.text ?? "";
			for (const [key, value] of Object.entries(options.attr ?? {})) el.setAttribute(key, value);
			return this.appendChild(el);
		},
		createDiv(this: HTMLElement, options?: { cls?: string; text?: string; attr?: Record<string, string> }) { return this.createEl("div", options); },
		createSpan(this: HTMLElement, options?: { cls?: string; text?: string; attr?: Record<string, string> }) { return this.createEl("span", options); },
		setAttr(this: HTMLElement, key: string, value: string) { this.setAttribute(key, value); },
		addClass(this: HTMLElement, key: string) { this.classList.add(key); },
		removeClass(this: HTMLElement, key: string) { this.classList.remove(key); },
		toggleClass(this: HTMLElement, key: string, value: boolean) { this.classList.toggle(key, value); },
		setCssProps(this: HTMLElement, props: Record<string, string>) { for (const [key, value] of Object.entries(props)) this.style.setProperty(key, value); },
		empty(this: HTMLElement) { this.replaceChildren(); },
		setText(this: HTMLElement, text: string) { this.textContent = text; },
		detach(this: HTMLElement) { this.remove(); },
		instanceOf(this: HTMLElement, ctor: typeof HTMLElement) { return this instanceof ctor; },
	});
};

test("top titles and summaries retain hierarchy, spacing and button reachability across desktop and mobile layouts", { skip: !process.env.KNOMO_LAYOUT_PLAYWRIGHT }, async () => {
	const { chromium } = require(process.env.KNOMO_LAYOUT_PLAYWRIGHT!);
	const browser = await chromium.launch({ channel: process.env.KNOMO_LAYOUT_BROWSER || "msedge", headless: true });
	const css = readFileSync("styles.css", "utf8");
	const host = process.env.KNOMO_LAYOUT_HOST_CSS ? readFileSync(process.env.KNOMO_LAYOUT_HOST_CSS, "utf8") : "";
	const bundle = await typographyBundle();
	try {
		const page = await browser.newPage();
		for (const theme of ["theme-light", "theme-dark"]) for (const [layout, width] of [["desktop-wide", 1000], ["desktop-narrow", 540], ["mobile", 320], ["mobile", 390]] as const) {
			const mobile = layout === "mobile";
			await page.setViewportSize({ width, height: 900 });
			await page.setContent(`<style>${host}${hostFixture}${css}
				body { --font-preferred-size:22px; --text-faint:#888; }
			</style><body class="${theme} ${mobile ? "is-mobile is-phone" : ""}">
				<div class="workspace-leaf-content" data-type="knomo-view"><div class="view-header"><div class="view-header-title-container"><div class="view-header-title"></div></div></div><div class="view-content">
				<div class="probe knomo-plugin is-layout-${layout}">
					<div class="${layout === "desktop-narrow" ? "knomo-compact-title" : "knomo-scope-wrap"}">
						<div class="knomo-title-host"><button class="knomo-title-root">全部笔记</button><span class="knomo-title-separator">/</span>
							<button class="knomo-scope-trigger" aria-haspopup="menu"><span class="knomo-title-label">全部笔记</span><span class="knomo-title-chevron">⌄</span></button></div>
					</div>
					<div class="knomo-title-host"><span class="knomo-title-label">记录统计</span></div>
					<div id="ordinary"></div><div id="long"></div><div id="random"></div><div id="catalog"></div><div id="shuffle"></div>
					<div class="knomo-mobile-search-results"></div>
				</div>
				</div></div>
			</body>`);
			await page.addScriptTag({ content: bundle });
			await page.evaluate(installDomHelpers);
			await page.evaluate(() => {
				const fixture = (window as unknown as TypographyWindow).KnomoTypographyFixture;
				const container = (id: string) => document.getElementById(id)!;
				const card = (parent: HTMLElement) => parent.createDiv({ cls: "knomo-card", text: "Memo" });
				fixture.renderKnomoListSummary(container("ordinary"), "标签 #日常 · 2026年10月 · 关键词 项目复盘 · 共 28 条笔记");
				card(container("ordinary"));
				fixture.renderKnomoListSummary(container("long"), "#" + "LongTagAndSearchKeyword".repeat(20));
				const random = fixture.renderKnomoRandomReunionToolbar(container("random"), 12345);
				random.querySelector(".knomo-list-summary")!.textContent += " · " + "LongSearchKeyword".repeat(8);
				fixture.renderKnomoActionableListSummary(container("catalog"), "当前笔记暂不可用 · " + "LongConfigurationMessage".repeat(8), { label: "重试", action: "refresh-catalog-sync-state" });
				fixture.renderKnomoShuffleDayHeader(container("shuffle"), "2026-10-18", { memoCount: 12, wordCount: 1234, tagCount: 5, imageCount: 2, linkCount: 3, firstMemoTime: null, lastMemoTime: null });
				card(container("shuffle"));
				fixture.renderKnomoListSummary(document.querySelector<HTMLElement>(".knomo-mobile-search-results")!, "关键词 " + "LongMobileSearchKeyword".repeat(12));
			});
			const context = JSON.stringify({ theme, layout, width });
			for (const label of ["全部笔记", "勾事记", "往日回顾", "随机重逢", "往日漫游", "时光浮标", "记录统计", "搜索", "有图片"]) {
				const titles = await page.evaluate(({ label, mobile }: { label: string; mobile: boolean }) => {
					const fixture = (window as unknown as TypographyWindow).KnomoTypographyFixture;
					const titleEl = document.querySelector<HTMLElement>(".view-header-title")!;
					new fixture.MobileHeaderTitleController({
						registerDomEvent: (target, type, listener) => target.addEventListener(type, listener),
						renderChevron: container => container.createSpan({ cls: "knomo-title-chevron", text: "⌄" }),
						canToggleScopeMenu: () => true, onToggleScopeMenu: () => {},
					}).sync({ headerEl: titleEl.closest<HTMLElement>(".view-header")!, titleEl, isRecordStats: label === "记录统计", scopeMenuOpen: false, label });
					const title = document.querySelector<HTMLElement>(".knomo-scope-trigger .knomo-title-label")!;
					title.textContent = label;
					const typography = (el: Element) => {
						const style = getComputedStyle(el);
						return [style.fontSize, style.fontWeight, style.color];
					};
					const normal = getComputedStyle(document.body).getPropertyValue("--text-normal").trim();
					const swatch = document.createElement("span");
					swatch.style.color = normal; document.body.appendChild(swatch);
					const normalColor = getComputedStyle(swatch).color;
					swatch.style.color = "var(--text-muted)";
					const mutedColor = getComputedStyle(swatch).color;
					swatch.style.color = "var(--text-faint)";
					const faintColor = getComputedStyle(swatch).color;
					swatch.remove();
					return {
						active: typography(mobile ? titleEl : title), stats: typography(document.querySelector(".knomo-title-host > .knomo-title-label")!),
						visible: (mobile ? titleEl : title).getBoundingClientRect().height > 0,
						root: typography(document.querySelector(".knomo-title-root")!), separator: getComputedStyle(document.querySelector(".knomo-title-separator")!).color,
						chevron: getComputedStyle(document.querySelector(mobile && label !== "记录统计" ? ".knomo-mobile-title .knomo-title-chevron" : ".knomo-scope-trigger .knomo-title-chevron")!).color,
						normalColor, mutedColor, faintColor,
					};
				}, { label, mobile });
				assert.deepEqual(titles.active, ["15px", "400", titles.normalColor], `${context} ${label}`);
				assert.equal(titles.visible, true, `${context} ${label}`);
				assert.deepEqual(titles.stats, ["15px", "400", titles.normalColor], context);
				assert.deepEqual(titles.root, ["14px", "400", titles.mutedColor], context);
				assert.equal(titles.separator, titles.faintColor, context);
				assert.equal(titles.chevron, titles.faintColor, context);
			}
			const actual = await page.evaluate(() => {
				const el = (selector: string) => document.querySelector<HTMLElement>(selector)!;
				const rect = (selector: string) => el(selector).getBoundingClientRect();
				const typography = (selector: string) => {
					const style = getComputedStyle(el(selector));
					return [style.fontSize, style.fontWeight, style.lineHeight, style.color];
				};
				const bounded = (parent: string, child: string) => {
					const outer = rect(parent), inner = rect(child);
					return inner.left >= outer.left && inner.right <= outer.right + 1 && el(child).scrollWidth <= el(child).clientWidth + 1;
				};
				return {
					summaries: Array.from(document.querySelectorAll(".knomo-list-summary")).map(summary => {
						const style = getComputedStyle(summary);
						return [style.fontSize, style.fontWeight, style.lineHeight, style.color];
					}),
					date: typography(".knomo-shuffle-day-date"), shuffle: typography(".knomo-shuffle-day-summary"),
					gap: rect("#ordinary .knomo-card").top - rect("#ordinary .knomo-list-summary").bottom,
					shuffleGap: rect(".knomo-shuffle-day-summary").top - rect(".knomo-shuffle-day-date").bottom,
					shuffleCardGap: rect("#shuffle .knomo-card").top - rect(".knomo-shuffle-day-header").bottom,
					wrapped: ["#long .knomo-list-summary", ".knomo-mobile-search-results .knomo-list-summary"].every(selector => rect(selector).height > 21 && bounded(".probe", selector)),
					buttons: ["#random", "#catalog"].map(parent => ({
						within: bounded(parent, `${parent} button`) && bounded(parent, `${parent} .knomo-list-summary`),
						separate: parent === "#random" ? rect(`${parent} .knomo-list-summary`).right + 11 <= rect(`${parent} button`).left
							: rect(`${parent} span`).right + 11 <= rect(`${parent} button`).left,
					})),
					caption: getComputedStyle(document.body).getPropertyValue("--knomo-text-caption").trim(),
				};
			});
			for (const summary of actual.summaries) assert.deepEqual(summary.slice(0, 3), ["14px", "400", "21px"], context);
			assert.ok(actual.summaries.every((summary: string[]) => summary[3] === actual.shuffle[3]), context);
			assert.deepEqual(actual.date.slice(0, 2), ["14px", "600"], context);
			assert.deepEqual(actual.shuffle.slice(0, 3), ["14px", "400", "21px"], context);
			assert.notEqual(actual.date[3], actual.shuffle[3], context);
			assert.deepEqual([actual.gap, actual.shuffleGap, actual.shuffleCardGap], [10, 4, 14], context);
			assert.equal(actual.wrapped, true, context);
			assert.ok(actual.buttons.every((button: { within: boolean; separate: boolean }) => button.within && button.separate), context);
			assert.equal(actual.caption, "12px", context);
		}
	} finally { await browser.close(); }
});

test("random day summary and back button share the random toolbar layout on desktop and mobile", { skip: !process.env.KNOMO_LAYOUT_PLAYWRIGHT }, async () => {
	const { chromium } = require(process.env.KNOMO_LAYOUT_PLAYWRIGHT!);
	const browser = await chromium.launch({ channel: process.env.KNOMO_LAYOUT_BROWSER || "msedge", headless: true });
	const css = readFileSync("styles.css", "utf8");
	const bundle = await typographyBundle();
	try {
		const page = await browser.newPage();
		for (const theme of ["theme-light", "theme-dark"]) for (const width of [1000, 540, 390, 320]) {
			const mobile = width < 500;
			await page.setViewportSize({ width, height: 900 });
			for (const content of ["empty", "normal", "long"] as const) {
				await page.setContent(`<style>${hostFixture}${css}</style><body class="${theme} ${mobile ? "is-mobile is-phone" : ""}"><main class="probe knomo-plugin is-layout-${mobile ? "mobile" : "desktop-wide"}"><section id="random"></section><section id="day"></section></main></body>`);
				await page.addScriptTag({ content: bundle });
				await page.evaluate(installDomHelpers);
				const actual = await page.evaluate((content: string) => {
					const fixture = (window as unknown as TypographyWindow).KnomoTypographyFixture;
					fixture.renderKnomoRandomReunionToolbar(document.getElementById("random")!, 7);
					const day = document.getElementById("day")!;
					fixture.renderKnomoCardFlowHeaders(day, [{ type: "random-day", selectedDate: "2025-12-29", stats: content === "empty" ? null : {
						memoCount: 7, wordCount: 200, tagCount: 1, imageCount: 0, linkCount: 0, firstMemoTime: null, lastMemoTime: null,
					} }]);
					const summary = day.querySelector<HTMLElement>(".knomo-shuffle-day-summary");
					if (summary) summary.textContent = "这一天写下了 7 条 Memos · 200 字 · 1 个标签" + (content === "long" ? " · LongHistoricalSummary".repeat(20) : "");
					day.querySelector<HTMLElement>(".knomo-shuffle-day-date")!.textContent = "2025-12-29 · 星期一";
					const back = day.querySelector<HTMLElement>("[data-action='random-day-back']")!;
					back.textContent = "返回";
					const button = back.getBoundingClientRect();
					const summaryRect = summary?.getBoundingClientRect();
					const row = back.parentElement!.getBoundingClientRect();
					const date = day.querySelector(".knomo-shuffle-day-date")!.getBoundingClientRect();
					const shuffle = document.querySelector("[data-action='refresh-random-reunion']")!.getBoundingClientRect();
					return {
						aligned: Math.abs(button.right - shuffle.right) < 1 && Math.abs(button.right - row.right) < 1,
						dateAbove: date.bottom <= row.top,
						sameRow: !summaryRect || Math.abs(summaryRect.top + summaryRect.height / 2 - button.top - button.height / 2) < 1,
						separate: !summaryRect || summaryRect.right + 11 <= button.left,
						bounded: !summary || summary.scrollWidth <= summary.clientWidth + 1,
					};
				}, content);
				assert.deepEqual(actual, { aligned: true, dateAbove: true, sameRow: true, separate: true, bounded: true }, JSON.stringify({ theme, width, content }));
			}
		}
	} finally { await browser.close(); }
});

test("Typography separates content from UI in desktop and body-mounted mobile Composer, preserving host controls and display exceptions", { skip: !process.env.KNOMO_LAYOUT_PLAYWRIGHT }, async () => {
	const { chromium } = require(process.env.KNOMO_LAYOUT_PLAYWRIGHT!);
	const browser = await chromium.launch({ channel: process.env.KNOMO_LAYOUT_BROWSER || "msedge", headless: true });
	const css = readFileSync("styles.css", "utf8");
	const host = process.env.KNOMO_LAYOUT_HOST_CSS ? readFileSync(process.env.KNOMO_LAYOUT_HOST_CSS, "utf8") : "";
	const bundle = await typographyBundle();
	try {
		const page = await browser.newPage();
		const errors: string[] = [];
		page.on("pageerror", (error: Error) => errors.push(error.message));
		for (const theme of ["theme-light", "theme-dark"]) for (const mobile of [false, true]) for (const size of [14, 15, 16, 17, 18, 22]) {
			await page.setViewportSize({ width: mobile ? 390 : 1000, height: 800 });
			await page.setContent(`<style>${host}${hostFixture}${css}
				body { --font-preferred-size:${size}px; }
			</style><body class="${theme} ${mobile ? "is-mobile" : ""}">
				<div class="probe knomo-plugin ${mobile ? "is-layout-mobile" : "is-layout-desktop-wide"}">
					<div class="knomo-card">
						<div class="knomo-card-head"><span class="knomo-card-time">12:34</span><button class="knomo-card-time" data-memo-time-open="daily">12:34</button></div>
						<div class="knomo-card-content markdown-rendered"><p>中文 Memo and text <a class="tag">#标签</a> <code>code</code></p><h2>Heading</h2></div>
						<div class="knomo-card-word-count">123 words</div>
						<div class="knomo-card-meta"><div class="knomo-source-reference"><p><a>来源于</a></p></div></div>
						<div class="knomo-card-image-more">+3</div>
					</div>
					<div class="knomo-composer"><div id="editor"></div><div class="knomo-reference-preview-text">引用摘录</div></div>
					<div class="knomo-recent-flow-date">2026-10-13</div><div class="knomo-recent-flow-decoration knomo-recent-flow-history">更多时光涟漪</div>
					<div class="knomo-empty-title">暂无记录</div><div class="knomo-empty-description">记录一些内容</div>
					<input class="knomo-search-input"><button class="knomo-nav-button">笔记</button><button class="knomo-mobile-search-chip">本周</button>
					<div class="knomo-status">状态 <button class="knomo-inline-button">重试</button></div><span class="knomo-tag-count">12</span>
					<div class="knomo-stat-value">123</div><div class="knomo-record-stats-metric-value">456</div>
					<button class="knomo-tool-button">工具</button>
				</div>
				<div class="menu knomo-mobile-menu-scope">Native menu</div><div class="setting-item">Setting</div>
				<div class="modal knomo-confirm-modal"><div class="knomo-confirm-message">Confirm</div></div><div class="view-header">Header</div>
				<div class="suggestion-container"><div class="suggestion-item">Other suggestion</div></div><div class="knomo-setting-help">Help</div>
				<div class="knomo-image-preview-counter">1/3</div>
			</body>`);
			await page.addScriptTag({ content: bundle });
			await page.evaluate(installDomHelpers);
			await page.evaluate((mobile: boolean) => {
				const win = window as unknown as TypographyWindow;
				if (mobile) {
					const layer = win.KnomoTypographyFixture.createMobileComposerLayer(document);
					layer.layerEl.classList.add("is-active", "is-open");
					layer.contentEl.appendChild(document.querySelector(".knomo-composer")!);
				}
				win.editor = new win.KnomoTypographyFixture.ComposerEditor(document.querySelector("#editor")!, "中文 prose and English #标签\nend", "editor-label", "Write");
				win.editor.input.setSelectionRange(win.editor.input.value.length, win.editor.input.value.length);
			}, mobile);
			const actual = await page.evaluate(() => {
				const font = (selector: string) => getComputedStyle(document.querySelector(selector)!).fontSize;
				return {
					content: font(".knomo-card-content"), composer: font(".knomo-composer-input"),
					times: Array.from(document.querySelectorAll(".knomo-card-time")).map(el => getComputedStyle(el).fontSize),
					wordCount: font(".knomo-card-word-count"), cardTag: font(".knomo-card-content .tag"), composerTag: font(".knomo-composer-tag"),
					date: font(".knomo-recent-flow-date"), history: font(".knomo-recent-flow-history"), title: font(".knomo-empty-title"),
					search: font(".knomo-search-input"), nav: font(".knomo-nav-button"), chip: font(".knomo-mobile-search-chip"),
					reference: font(".knomo-reference-preview-text"), source: font(".knomo-source-reference a"),
					status: font(".knomo-status"), action: font(".knomo-inline-button"), count: font(".knomo-tag-count"), empty: font(".knomo-empty-description"),
					host: [".menu", ".setting-item", ".knomo-confirm-message", ".view-header", ".suggestion-container > .suggestion-item"].map(font),
					help: font(".knomo-setting-help"), preview: font(".knomo-image-preview-counter"),
					display: [font(".knomo-stat-value"), font(".knomo-record-stats-metric-value"), font(".knomo-card-image-more")],
					heading: font(".markdown-rendered h2"), code: font(".markdown-rendered code"),
					lineHeight: getComputedStyle(document.querySelector(".knomo-composer-input")!).lineHeight,
					iconSize: font(".knomo-tool-button"),
				};
			});
			assert.deepEqual(actual, {
				content: `${size}px`, composer: `${mobile ? Math.max(16, size) : size}px`, times: ["13px", "13px"],
				wordCount: "13px", cardTag: "14px", composerTag: "14px", date: "15px", history: "13px", title: "15px",
				search: "14px", nav: "14px", chip: "13px", reference: "13px", source: "12px", status: "12px", action: "14px", count: "12px", empty: "12px",
				host: Array(5).fill("19px"), help: "17px", preview: "19px", display: ["24px", "24px", "26.4px"],
				heading: `${size * 1.5}px`, code: `${size * 0.9}px`, lineHeight: `${Number(((mobile ? Math.max(16, size) : size) * 1.7).toFixed(2))}px`,
				iconSize: mobile ? "24px" : "19px",
			}, JSON.stringify({ theme, mobile, size }));
			await page.evaluate(() => (window as unknown as TypographyWindow).editor.destroy());
		}
		assert.deepEqual(errors, []);
	} finally { await browser.close(); }
});

test("live content font and width changes remeasure the real Composer without replacing state, selection, draft or history", { skip: !process.env.KNOMO_LAYOUT_PLAYWRIGHT }, async () => {
	const { chromium } = require(process.env.KNOMO_LAYOUT_PLAYWRIGHT!);
	const browser = await chromium.launch({ channel: process.env.KNOMO_LAYOUT_BROWSER || "msedge", headless: true });
	const css = readFileSync("styles.css", "utf8");
	const bundle = await typographyBundle();
	try {
		const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
		const errors: string[] = [];
		page.on("pageerror", (error: Error) => errors.push(error.message));
		for (const mobile of [false, true]) {
			await page.setContent(`<style>${hostFixture}${css}body { --font-preferred-size:14px; } .probe { width:720px; }</style>
				<body><div class="probe knomo-plugin ${mobile ? "is-layout-mobile" : "is-layout-desktop-wide"}"><div id="editor"></div></div></body>`);
			await page.addScriptTag({ content: bundle });
			const before = await page.evaluate(async () => {
				const win = window as unknown as TypographyWindow;
				const source = "中文 English 混排与很长的句子 ".repeat(24) + "\n#长标签\n\nend";
				win.editor = new win.KnomoTypographyFixture.ComposerEditor(document.querySelector("#editor")!, source, "editor-label", "Write");
				win.editor.view.dispatch({ changes: { from: source.length, insert: "!" }, userEvent: "input" });
				win.editor.input.setSelectionRange(5, 12, "backward");
				win.editor.view.focus();
				await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
				win.retainedState = win.editor.view.state;
				win.retainedCapture = win.editor.capture();
				return { source: win.editor.input.value, height: win.editor.input.getBoundingClientRect().height, lineHeight: win.editor.view.defaultLineHeight, anchor: win.editor.coordsAtPos(12)?.left };
			});
			await page.evaluate(() => {
				document.body.style.setProperty("--font-preferred-size", "22px");
				document.body.style.setProperty("--knomo-text-ui-base", "28px");
				document.body.style.setProperty("--font-text", "Georgia");
				document.querySelector<HTMLElement>(".probe")!.style.width = "240px";
			});
			await page.waitForFunction(() => (window as unknown as TypographyWindow).editor.view.defaultLineHeight > 35);
			const after = await page.evaluate(() => {
				const win = window as unknown as TypographyWindow;
				return {
					sameState: win.editor.view.state === win.retainedState, captureValid: win.retainedCapture.valid(),
					source: win.editor.input.value, selection: [win.editor.view.state.selection.main.anchor, win.editor.view.state.selection.main.head],
					undoDepth: win.KnomoTypographyFixture.undoDepth(win.editor.view.state),
					height: win.editor.input.getBoundingClientRect().height, anchor: win.editor.coordsAtPos(12)?.left,
					font: getComputedStyle(win.editor.input).fontSize, family: getComputedStyle(win.editor.input).fontFamily,
					tag: getComputedStyle(document.querySelector(".knomo-composer-tag")!).fontSize,
				};
			});
			assert.equal(after.sameState, true);
			assert.equal(after.captureValid, true);
			assert.equal(after.source, before.source);
			assert.deepEqual(after.selection, [12, 5]);
			assert.equal(after.undoDepth, 1);
			assert.ok(after.height > before.height * 2);
			assert.notEqual(after.anchor, before.anchor);
			assert.equal(after.font, "22px");
			assert.equal(after.family, "Georgia");
			assert.equal(after.tag, "28px");
			const history = await page.evaluate(() => {
				const win = window as unknown as TypographyWindow;
				const undo = win.KnomoTypographyFixture.undo(win.editor.view);
				const source = win.editor.input.value;
				const redo = win.KnomoTypographyFixture.redo(win.editor.view);
				return { undo, source, redo, restored: win.editor.input.value };
			});
			assert.equal(history.undo, true);
			assert.equal(history.source, before.source.slice(0, -1));
			assert.equal(history.redo, true);
			assert.equal(history.restored, before.source);
			await page.evaluate(() => (window as unknown as TypographyWindow).editor.destroy());
		}
		assert.deepEqual(errors, []);
	} finally { await browser.close(); }
});

test("body-mounted Tag and Wiki candidates share typography with real measurement clones, clamp long content and retain keyboard selection", { skip: !process.env.KNOMO_LAYOUT_PLAYWRIGHT }, async () => {
	const { chromium } = require(process.env.KNOMO_LAYOUT_PLAYWRIGHT!);
	const browser = await chromium.launch({ channel: process.env.KNOMO_LAYOUT_BROWSER || "msedge", headless: true });
	const css = readFileSync("styles.css", "utf8");
	const host = process.env.KNOMO_LAYOUT_HOST_CSS ? readFileSync(process.env.KNOMO_LAYOUT_HOST_CSS, "utf8") : "";
	const bundle = await typographyBundle();
	try {
		const page = await browser.newPage();
		const errors: string[] = [];
		page.on("pageerror", (error: Error) => errors.push(error.message));
		for (const mobile of [false, true]) for (const width of [240, 390, 900]) for (const scale of [1, 1.5, 2]) {
			await page.setViewportSize({ width, height: 800 });
			await page.setContent(`<style>${host}${hostFixture}${css}
				body { --font-preferred-size:18px; --font-ui-medium:${19 * scale}px; --knomo-text-ui-medium:${15 * scale}px; --knomo-text-ui-base:${14 * scale}px; --knomo-text-meta:${13 * scale}px; --knomo-text-caption:${12 * scale}px; }
				.suggestion-container { padding:4px; border:1px solid; }
				.suggestion { overflow-y:auto; padding:6px; }
				.suggestion-item { font-size:var(--font-ui-medium); padding:6px 8px; }
				.suggestion-item.mod-complex { display:flex; align-items:baseline; }
				.suggestion-content { display:flex; flex-direction:column; overflow:hidden; }
				.suggestion-title, .suggestion-note { overflow-wrap:break-word; }
				.suggestion-note { font-size:.8em; color:var(--text-muted); }
			</style><body><div class="probe knomo-plugin"><div class="knomo-composer"><div id="editor"></div></div></div></body>`);
			await page.addScriptTag({ content: bundle });
			await page.evaluate(installDomHelpers);
			await page.evaluate((mobile: boolean) => {
				const win = window as unknown as TypographyWindow;
				if (mobile) {
					const layer = win.KnomoTypographyFixture.createMobileComposerLayer(document);
					layer.layerEl.classList.add("is-active", "is-open");
					layer.contentEl.appendChild(document.querySelector(".knomo-composer")!);
				}
				win.editor = new win.KnomoTypographyFixture.ComposerEditor(document.querySelector("#editor")!, "prefix #", "editor-label", "Write");
				win.editor.view.focus();
				const tags = Array.from({ length: 12 }, (_, i) => `#${i}_长标签_${"中文English".repeat(12)}`);
				win.tagSuggest = new win.KnomoTypographyFixture.KnomoTagSuggest({} as import("obsidian").App, win.editor.input, () => {}, {
					getSnapshot: () => ({ status: "ready", revision: 1, suggestions: tags }),
				} as unknown as import("../src/services/VaultTagIndex").VaultTagIndex);
				win.tagSuggest.open();
			}, mobile);
			for (const kind of ["tag", "wiki"]) {
				if (kind === "wiki") await page.evaluate(() => {
					const win = window as unknown as TypographyWindow;
					win.tagSuggest.close();
					win.editor.reset("prefix [[]]");
					win.editor.input.setSelectionRange(9, 9);
					const basename = "会议记录_" + "中文English".repeat(12);
					const files = Array.from({ length: 10 }, (_, i) => ({ basename, path: `目录_${i}/${"很长的目录/".repeat(10)}${basename}.md` }));
					const app = {
						vault: { on: () => ({}), getMarkdownFiles: () => files },
						metadataCache: { fileToLinktext: (file: { path: string }) => file.path.slice(0, -3), getFirstLinkpathDest: (path: string) => files.find(file => file.path === path + ".md") },
					};
					win.wikiSuggest = new win.KnomoTypographyFixture.KnomoWikiLinkSuggest(app as unknown as import("obsidian").App, win.editor.input, {
						listboxId: "wiki", getSourcePath: () => "Daily/2026-10-13.md", onInputChanged: () => {}, closeTagSuggest: () => win.tagSuggest.close(), registerVaultEvent: () => {},
					});
					win.wikiSuggest.openForCurrentRange();
				});
				await page.waitForFunction((kind: string) => {
					const popup = document.querySelector(kind === "tag" ? ".knomo-tag-suggest-popover" : ".knomo-link-suggest-popover");
					return popup && getComputedStyle(popup).visibility === "visible";
				}, kind);
				const actual = await page.evaluate((kind: string) => {
					const win = window as unknown as TypographyWindow;
					const popup = document.querySelector<HTMLElement>(kind === "tag" ? ".knomo-tag-suggest-popover" : ".knomo-link-suggest-popover")!;
					const selector = kind === "tag" ? ".suggestion-item" : ".knomo-link-suggest-item";
					const styles = (el: Element) => {
						const css = getComputedStyle(el);
						return [css.fontSize, css.fontWeight, css.fontFamily, css.lineHeight];
					};
					const rowStyles = (el: Element) => [styles(el), ...Array.from(el.querySelectorAll("span, .knomo-link-suggest-title, .knomo-link-suggest-path")).map(styles)];
					const visible = Array.from(popup.querySelectorAll(selector)).map(rowStyles);
					const clones: string[][][] = [];
					const originalRect = HTMLElement.prototype.getBoundingClientRect;
					HTMLElement.prototype.getBoundingClientRect = function () {
						if (this.classList.contains("knomo-suggest-measure-item")) clones.push(rowStyles(this));
						return originalRect.call(this);
					};
					let measured: number;
					try { measured = win.KnomoTypographyFixture.measureSuggestionContentWidth(win.editor.input, popup, selector); }
					finally { HTMLElement.prototype.getBoundingClientRect = originalRect; }
					const rect = popup.getBoundingClientRect();
					const saved = popup.getAttribute("style")!;
					popup.style.width = "max-content"; popup.style.maxWidth = "none"; popup.style.minWidth = "0";
					popup.style.maxHeight = "none"; popup.style.overflowY = "visible";
					const naturalWidth = Math.ceil(popup.getBoundingClientRect().width + 2);
					popup.setAttribute("style", saved);
					const first = popup.querySelector<HTMLElement>(selector)!;
					const title = popup.querySelector(".knomo-link-suggest-title");
					const path = popup.querySelector(".knomo-link-suggest-path");
					return {
						visible, clones, measured, naturalWidth, bodyMounted: popup.parentElement === document.body,
						tokens: ["ui-medium", "ui-base", "meta", "caption"].map(name => getComputedStyle(popup).getPropertyValue("--knomo-text-" + name).trim()),
						mainSize: getComputedStyle(title ?? first).fontSize, pathSize: path ? getComputedStyle(path).fontSize : null,
						within: rect.left >= 11 && rect.right <= innerWidth - 11 && rect.top >= 0 && rect.bottom <= innerHeight,
						rowHeight: first.getBoundingClientRect().height, scrollable: (popup.querySelector(".suggestion") ?? popup).scrollHeight > (popup.querySelector(".suggestion") ?? popup).clientHeight,
						ellipsis: title ? popup.classList.contains("knomo-native-suggest") ? title.scrollWidth <= title.clientWidth + 1
							: getComputedStyle(title).textOverflow === "ellipsis" && title.scrollWidth > title.clientWidth : true,
						leftoverClones: document.querySelectorAll(".knomo-suggest-measure-host").length,
					};
				}, kind);
				const context = JSON.stringify({ mobile, width, scale, kind });
				assert.equal(actual.bodyMounted, true, context);
				assert.deepEqual(actual.clones, actual.visible, context);
				assert.ok(Math.abs(actual.measured - actual.naturalWidth) <= 1, context);
				assert.deepEqual(actual.tokens, [15, 14, 13, 12].map(size => `${size * scale}px`), context);
				assert.equal(actual.mainSize, `${19 * scale}px`, context);
				if (kind === "wiki") assert.equal(actual.pathSize, `${Number((19 * scale * .8).toFixed(2))}px`, context);
				if (mobile) assert.ok(actual.rowHeight >= 44, context);
				assert.equal(actual.within, true, context);
				assert.equal(actual.scrollable, true, context);
				assert.equal(actual.ellipsis, true, context);
				assert.equal(actual.leftoverClones, 0, context);
				if (scale === 1 && width === 390) {
					const dynamic = await page.evaluate(async ({ kind, mobile }: { kind: string; mobile: boolean }) => {
						const win = window as unknown as TypographyWindow;
						const state = win.editor.view.state, capture = win.editor.capture();
						const anchorBefore = win.editor.coordsAtPos(win.editor.input.selectionStart)!;
						document.body.style.setProperty("--font-preferred-size", "22px");
						document.body.style.setProperty("--knomo-text-ui-base", "21px");
						document.body.style.setProperty("--knomo-text-caption", "18px");
						document.body.style.setProperty("--font-ui-medium", "27px");
						document.body.style.setProperty("--font-text", "Georgia");
						win.editor.view.dom.style.width = "200px";
						await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
						// 复用视图重排后调用的既有刷新入口，不另建候选定位逻辑。
						if (kind === "tag") win.tagSuggest.refresh(); else win.wikiSuggest.refreshForCursor();
						await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
						const popup = document.querySelector<HTMLElement>(kind === "tag" ? ".knomo-tag-suggest-popover" : ".knomo-link-suggest-popover")!;
						const rect = popup.getBoundingClientRect(), anchor = win.editor.coordsAtPos(win.editor.input.selectionStart)!;
						return {
							sameState: win.editor.view.state === state, captureValid: capture.valid(),
							anchorChanged: anchor.left !== anchorBefore.left || anchor.bottom !== anchorBefore.bottom,
							anchored: mobile ? rect.bottom <= anchor.top - 7 && rect.top >= 51 : Math.abs(rect.top - anchor.bottom) <= 1,
							within: rect.left >= 11 && rect.right <= innerWidth - 11,
							font: getComputedStyle(popup.querySelector(kind === "tag" ? ".suggestion-item" : ".knomo-link-suggest-title")!).fontSize,
						};
					}, { kind, mobile });
					assert.deepEqual(dynamic, { sameState: true, captureValid: true, anchorChanged: true, anchored: true, within: true, font: "27px" }, context);
					await page.evaluate(() => {
						document.body.style.removeProperty("--font-preferred-size"); document.body.style.removeProperty("--knomo-text-ui-base");
						document.body.style.removeProperty("--knomo-text-caption"); document.body.style.removeProperty("--font-text");
						document.body.style.removeProperty("--font-ui-medium");
						(window as unknown as TypographyWindow).editor.view.dom.style.removeProperty("width");
					});
				}
				const selected = await page.evaluate((kind: string) => {
					const win = window as unknown as TypographyWindow;
					const suggest = kind === "tag" ? win.tagSuggest : win.wikiSuggest;
					suggest.handleKeydown(new KeyboardEvent("keydown", { key: "ArrowDown", cancelable: true }));
					const row = document.querySelector<HTMLElement>(kind === "tag" ? ".knomo-tag-suggest-popover .is-selected" : ".knomo-link-suggest-popover .is-selected")!;
					const text = row.textContent!;
					suggest.handleKeydown(new KeyboardEvent("keydown", { key: "Enter", cancelable: true }));
					return { text, source: win.editor.input.value, expanded: win.editor.input.getAttribute("aria-expanded") };
				}, kind);
				assert.equal(selected.expanded, "false", context);
				assert.ok(selected.source.startsWith(kind === "tag" ? "prefix #1_" : "prefix [[目录_1/"), context);
				assert.ok(selected.text.length > 20, context);
				if (!mobile) {
					const edge = await page.evaluate(async (kind: string) => {
						const win = window as unknown as TypographyWindow;
						const probe = document.querySelector<HTMLElement>(".probe")!;
						probe.style.position = "fixed";
						probe.style.top = `${innerHeight - 80}px`;
						const source = kind === "tag" ? "prefix #" : "prefix [[]]";
						const cursor = source.length - (kind === "tag" ? 0 : 2);
						win.editor.reset(source);
						win.editor.input.setSelectionRange(cursor, cursor);
						win.editor.view.focus();
						win.editor.view.requestMeasure();
						await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
						if (kind === "tag") win.tagSuggest.open(); else win.wikiSuggest.openForCurrentRange();
						await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
						const popup = document.querySelector<HTMLElement>(kind === "tag" ? ".knomo-tag-suggest-popover" : ".knomo-link-suggest-popover")!;
						const rect = popup.getBoundingClientRect(), anchor = win.editor.coordsAtPos(cursor)!;
						const result = { above: rect.bottom <= anchor.top + 1, within: rect.top >= 11 && rect.bottom <= innerHeight - 11,
							unchanged: win.editor.input.value === source && win.editor.input.selectionStart === cursor };
						win.tagSuggest.close(); win.wikiSuggest?.close();
						probe.style.removeProperty("position"); probe.style.removeProperty("top");
						return result;
					}, kind);
					assert.deepEqual(edge, { above: true, within: true, unchanged: true }, `${context}: desktop candidates stay visible near the bottom edge`);
				}
			}
			await page.evaluate(() => {
				const win = window as unknown as TypographyWindow;
				win.wikiSuggest.destroy(); win.editor.destroy();
			});
		}
		assert.deepEqual(errors, []);
	} finally { await browser.close(); }
});

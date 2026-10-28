import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { ensureObsidianStub } from "./helpers/obsidianStub";
import { DiaryMemoParser } from "../src/services/DiaryMemoParser";
import { MemoCatalogService } from "../src/services/MemoCatalogService";
import { InMemoryMemoCatalogStore } from "../src/services/MemoCatalogStore";
import { observationHandleKey } from "../src/services/DailyMemoPresentationChange";
import type { MemoViewItem } from "../src/types/memoView";
import type { MemoRelationNode } from "../src/types/memoRelations";
import type { MemoRelationOptions } from "../src/services/MemoRelationService";
import type { MemoRelationsPageOptions } from "../src/ui/MemoRelationsPage";

async function fixture(withPreviews = false, withProductionCache = false, relations?: MemoRelationOptions,
	renderCard?: MemoRelationsPageOptions["renderCard"]) {
	await ensureObsidianStub();
	const dom = new JSDOM("<!doctype html><body><main></main></body>", { pretendToBeVisual: true });
	const win = dom.window;
	Object.defineProperties(win.HTMLElement.prototype, { win: { get() { return win; } }, doc: { get() { return win.document; } } });
	Object.assign(win.HTMLElement.prototype, {
		createEl(this: HTMLElement, tag: string, options: { cls?: string; text?: string; attr?: Record<string, string> } = {}) {
			const element = this.ownerDocument.createElement(tag);
			if (options.cls) element.className = options.cls;
			if (options.text) element.textContent = options.text;
			for (const [key, value] of Object.entries(options.attr ?? {})) element.setAttribute(key, value);
			return this.appendChild(element);
		},
		createDiv(this: HTMLElement, options?: object) { return this.createEl("div", options); },
		createSpan(this: HTMLElement, options?: object) { return this.createEl("span", options); },
		find(this: HTMLElement, selector: string) { return this.querySelector(selector); },
		findAll(this: HTMLElement, selector: string) { return Array.from(this.querySelectorAll(selector)); },
		getAttr(this: HTMLElement, name: string) { return this.getAttribute(name); },
		setAttr(this: HTMLElement, name: string, value: string) { this.setAttribute(name, value); },
		addClass(this: HTMLElement, ...classes: string[]) { this.classList.add(...classes); },
		empty(this: HTMLElement) { this.replaceChildren(); },
		setCssProps(this: HTMLElement, values: Record<string, string>) { for (const [key, value] of Object.entries(values)) this.style.setProperty(key, value); },
	});
	if (withPreviews) {
		win.HTMLElement.prototype.getClientRects = () => [new win.DOMRect(0, 0, 360, 260)] as unknown as DOMRectList;
		Object.defineProperty(win.HTMLElement.prototype, "clientHeight", { configurable: true, get() { return 600; } });
	}
	const store = new InMemoryMemoCatalogStore(50000), catalog = new MemoCatalogService(store);
	await catalog.open();
	const parser = new DiaryMemoParser(async bytes => createHash("sha256").update(bytes).digest("hex"));
	const seed = async (path: string, content: string) => {
		const parsed = await parser.parse({ sourcePath: path, logicalDate: "2026-10-25", bytes: Buffer.from(content) });
		await catalog.replaceFile({ inventory: { sourcePath: path, logicalDate: "2026-10-25", mtime: 1, size: content.length },
			sourceRevision: parsed.sourceRevision, observations: parsed.observations, blockAnchors: parsed.blockAnchors,
			parserVersion: 14, settingsFingerprint: "test", auditedAt: 1 });
		await store.setCoverage({ kind: "complete", pendingFileCount: 0, coveredFromDate: null, coveredFileCount: 1, totalFileCount: 1 });
		return parsed.observations;
	};
	const { CatalogReadService } = await import("../src/services/CatalogReadService");
	const { MemoRelationsPage } = await import("../src/ui/MemoRelationsPage");
	const { MemoRelationCards } = await import("../src/ui/MemoRelationCards");
	const { toCatalogMemoView } = await import("../src/types/memoView");
	const { MemoCardPreviewCache } = await import("../src/ui/MemoCardPreviewCache");
	const { parseMemoCardPreviewLite } = await import("../src/ui/MemoCardPreview");
	const cache = new MemoCardPreviewCache((_memo, text) => parseMemoCardPreviewLite(text));
	let cacheView: { getMemoCardPreview: (memo: MemoViewItem) => unknown; releaseRelationCard: (row: HTMLElement) => void; memos: MemoViewItem[] } | null = null;
	if (withProductionCache) {
		const { KnomoView } = await import("../src/ui/KnomoView");
		cacheView = Object.assign(Object.create(KnomoView.prototype), { memos: [], memoCardPreviewCache: cache,
			memoMarkdownRenderer: { releaseCard: () => {} }, cardImageLoadQueue: { forget: () => {} },
			randomReunionController: { getSnapshot: () => ({ memos: [] }) }, trashMemoController: { getSnapshot: () => ({ trashMemos: [] }) } });
	}
	const read = new CatalogReadService({ catalog, relations });
	const host = win.document.querySelector<HTMLElement>("main")!;
	const actions: string[] = [], errors: string[] = [];
	let bodyReads = 0;
	const original = catalog.readObservationSnapshot.bind(catalog);
	catalog.readObservationSnapshot = async (keys, signal) => { bodyReads += keys.length; return original(keys, signal); };
	const page = new MemoRelationsPage({ read, getHost: () => host, onChanged: open => { actions.push(String(open)); }, onError: error => errors.push(error),
		renderCard: renderCard ?? ((row, memo) => {
			cacheView?.getMemoCardPreview(memo);
			const card = row.createEl("article", { cls: "knomo-card", attr: { "data-memo-id": memo.id } });
			card.createEl("button", { cls: "knomo-card-menu", text: "menu" });
			card.createDiv({ cls: "knomo-card-content", text: memo.contentSnapshot });
			cards?.observe(card, memo);
			return card;
		}), releaseCard: row => cacheView?.releaseRelationCard(row) });
	const { KnomoView } = await import("../src/ui/KnomoView");
	const previewView = Object.assign(Object.create(KnomoView.prototype), { catalogReadService: read,
		containerEl: host, rootEl: host, relationsPage: page, closeCardMenu: () => {},
		cardFlowEl: withPreviews ? host.createDiv({ cls: "knomo-card-flow" }) : null, trashViewClosed: false,
		openMemoRelations: (handle: Parameters<typeof page.open>[0], trigger: HTMLElement, focusSubject: boolean) => page.open(handle, trigger, focusSubject) });
	// 使用真实视图接线，覆盖原先固定写入主卡片流顶部的状态回调。
	const cards: InstanceType<typeof MemoRelationCards> | null = withPreviews ? previewView.ensureRelationCards() : null;
	if (cacheView) Object.assign(cacheView, { relationsPage: page, relationCards: cards });
	return { dom, win, host, page, read, catalog, seed, errors, actions, cards, previewView, bodyReads: () => bodyReads,
		cache, cacheView, cacheSize: () => (cache as unknown as { entries: Map<string, unknown> }).entries.size,
		memo: async (handle: Parameters<typeof read.readMemoItems>[0][number]) => toCatalogMemoView((await read.readMemoItems([handle]))[0]),
		close: () => { cards?.dispose(); page.dispose(); read.relations.dispose(); dom.window.close(); } };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 80));

test("关闭关联页释放子元素引用，重复进入不保留上次主体 DOM", async () => {
	const h = await fixture();
	try {
		const [handle] = await h.seed("A.md", "- 10:00 subject ^a\n");
		for (let cycle = 0; cycle < 3; cycle++) {
			await h.page.open(handle!);
			assert.ok(h.page.el?.querySelector(".knomo-card"));
			h.page.close();
			assert.equal(h.page.el, null);
			assert.equal(h.host.querySelector(".knomo-relations-page"), null);
			const fields = h.page as unknown as Record<string, unknown>;
			for (const name of ["listEl", "listTitle", "status", "loadingEl"]) assert.equal(fields[name], null, name);
		}
		assert.deepEqual(h.errors, []);
	} finally { h.close(); }
});

test("被引用入口首次及再次指针点击不聚焦时间，键盘激活保留焦点转移和返回恢复", async () => {
	await ensureObsidianStub();
	const { renderKnomoMemoCard } = await import("../src/ui/KnomoCard");
	const h = await fixture(true, false, undefined, (row, memo) => renderKnomoMemoCard(row, memo, {
		generation: 1, renderIndex: 0, includeActions: true, randomCard: false, activeMenuMemoId: null,
		formatDisplayTime: value => value, getMarkdownPriority: () => "normal",
		getMemoCardPreview: item => ({ text: item.contentSnapshot, images: [] }),
		queueMemoMarkdown: () => {}, renderMemoCardImages: () => {}, queueSourceReferenceMarkdown: () => {},
	}));
	try {
		const [a] = await h.seed("A.md", "- 10:00 A ^a\n");
		await h.seed("B.md", "- 11:00 B [[A#^a]]\n");
		const card = h.host.createEl("article", { cls: "knomo-card" });
		h.cards!.observe(card, await h.memo(a));
		await settle(); await settle();
		const trigger = card.querySelector<HTMLButtonElement>(".knomo-referrer-preview")!;
		assert.ok(trigger);
		// 移动端首次点击可以不聚焦入口；返回后入口已聚焦，两个状态都不能强制聚焦时间。
		for (const focused of [false, true]) {
			if (focused) trigger.focus();
			else assert.equal(h.win.document.activeElement, h.win.document.body);
			trigger.dispatchEvent(new h.win.MouseEvent("click", { bubbles: true, detail: 1 }));
			await settle();
			assert.equal(h.page.isOpen, true);
			const time = h.page.el!.querySelector<HTMLButtonElement>(".knomo-relations-subject .knomo-card-time")!;
			assert.ok(time);
			assert.notEqual(h.win.document.activeElement, time);
			h.page.back();
			assert.equal(h.win.document.activeElement, trigger);
		}
		// 原生按钮的键盘或辅助技术激活产生 detail=0 的 click。
		trigger.click(); await settle();
		assert.equal(h.win.document.activeElement, h.page.el!.querySelector(".knomo-relations-subject .knomo-card-time"));
		h.page.back();
		assert.equal(h.win.document.activeElement, trigger);
		assert.deepEqual(h.errors, []);
	} finally { h.close(); }
});

test("卡片菜单随被引用信息加载、增删更新，只有引用来源时不显示关联详情", async () => {
	const h = await fixture(true);
	const { renderKnomoMemoCard } = await import("../src/ui/KnomoCard");
	try {
		const [a, b] = await h.seed("D.md", "- 10:00 A ^a\n- 11:00 B [[#^a]] ^b\n");
		const render = async (handle: typeof a) => {
			const memo = await h.memo(handle);
			const card = renderKnomoMemoCard(h.host, memo, {
				generation: 1, renderIndex: 0, includeActions: true, randomCard: false, activeMenuMemoId: null,
				formatDisplayTime: value => value, getMarkdownPriority: () => "normal",
				getMemoCardPreview: item => ({ text: item.contentSnapshot, images: [] }),
				queueMemoMarkdown: () => {}, renderMemoCardImages: () => {}, queueSourceReferenceMarkdown: () => {},
			});
			h.cards!.observe(card, memo);
			return card;
		};
		const target = await render(a), source = await render(b);
		assert.equal(target.querySelector('[data-memo-action="relations"]'), null);
		await settle(); await settle();
		assert.deepEqual(Array.from(target.querySelectorAll<HTMLElement>("[data-memo-action]")).map(item => item.dataset.memoAction),
			["share-image", "edit", "reference", "copy-text", "open-daily", "copy-link", "relations", "delete"]);
		assert.equal(source.querySelector('[data-memo-action="relations"]'), null);
		await h.seed("C.md", "- 12:00 C [[D#^b]]\n"); await settle(); await settle();
		assert.ok(source.querySelector('[data-memo-action="relations"]'));
		await h.seed("C.md", "- 12:00 C\n"); await settle(); await settle();
		assert.equal(source.querySelector('[data-memo-action="relations"]'), null);
		await h.page.open(a); await settle(); await settle();
		assert.equal(h.page.el!.querySelector(".knomo-relations-subject .knomo-card")!.hasAttribute("data-has-referrers"), true);
		assert.equal(h.page.el!.querySelector(".knomo-relations-list .knomo-card")!.hasAttribute("data-has-referrers"), false);
	} finally { h.close(); }
});

test("关联详情将返回移至当前记录行，移除页面时间，保留逐层返回与原焦点", async () => {
	const h = await fixture();
	try {
		const [a] = await h.seed("A.md", "- 10:00 A ^a\n");
		const [b] = await h.seed("B.md", "- 11:00 B [[A#^a]] ^b\n");
		const trigger = h.host.createEl("button", { text: "View" });
		await h.page.open(a, trigger);
		const currentHeader = h.page.el!.querySelector(".knomo-relations-section-header")!;
		assert.equal(currentHeader.querySelector("h3")!.textContent, "Current record");
		const back = currentHeader.querySelector<HTMLButtonElement>("button")!;
		assert.equal(back.textContent, "");
		assert.equal(back.getAttribute("data-icon"), "arrow-left");
		assert.equal(back.type, "button");
		assert.equal(back.getAttribute("aria-label"), "Back to original list");
		assert.equal(h.page.el!.getAttribute("aria-label"), null);
		assert.equal(h.page.el!.querySelector(".knomo-relations-header h2")!.textContent, "Relation details");
		assert.equal(h.page.el!.querySelector(".knomo-relations-header button, .knomo-relations-header time, .knomo-relations-context"), null);
		const titleHost = h.host.createDiv();
		h.previewView.renderTitleHost({ el: titleHost, mobile: false });
		assert.equal(titleHost.textContent, "Relation details");
		assert.equal(titleHost.querySelector("button"), null);
		await h.page.open(b);
		const nestedBack = h.page.el!.querySelector<HTMLButtonElement>(".knomo-relations-back")!;
		assert.equal(nestedBack.getAttribute("aria-label"), "Back to previous record");
		nestedBack.click(); await settle();
		assert.equal(h.page.el!.querySelector<HTMLElement>(".knomo-relations-subject")!.dataset.subject, observationHandleKey(a));
		h.page.el!.querySelector<HTMLButtonElement>(".knomo-relations-back")!.click();
		assert.equal(h.page.isOpen, false);
		assert.equal(h.win.document.activeElement, trigger);
		assert.deepEqual(h.errors, []);
	} finally { h.close(); }
});

test("移动端关联详情使用顶部返回，关闭后恢复统计页原生返回操作", async () => {
	const h = await fixture();
	try {
		const [a] = await h.seed("A.md", "- 10:00 A ^a\n");
		const actions = h.host.createDiv();
		let returns = 0;
		Object.assign(h.previewView, { currentLayout: "mobile", mobileSearchHeaderActionEl: null, mobileRecordStatsBackActionEl: null,
			addAction: (_icon: string, label: string, callback: () => void) => {
				const button = actions.createEl("button", { text: label });
				button.addEventListener("click", callback); return button;
			}, returnFromRecordStats: () => { returns++; } });
		Object.defineProperty(h.previewView, "activeNav", { value: "record-stats" });
		h.previewView.syncMobileHeaderActions();
		assert.equal(actions.querySelectorAll("button").length, 1);
		await h.page.open(a);
		h.previewView.syncMobileHeaderActions();
		assert.equal(actions.querySelectorAll("button").length, 1);
		assert.equal(actions.querySelector("button")!.getAttribute("aria-label"), h.page.backLabel);
		assert.equal(h.page.el!.querySelectorAll(".knomo-relations-back").length, 1);
		actions.querySelector<HTMLButtonElement>("button")!.click();
		assert.equal(h.page.isOpen, false);
		h.previewView.syncMobileHeaderActions();
		actions.querySelector<HTMLButtonElement>("button")!.click();
		assert.equal(returns, 1);
		assert.deepEqual(h.errors, []);
	} finally { h.close(); }
});

test("关联详情在中英文、主题强调色及窄屏大字体下保持标题和返回按钮可见", { skip: !process.env.KNOMO_LAYOUT_PLAYWRIGHT }, async () => {
	const h = await fixture();
	const { chromium } = require(process.env.KNOMO_LAYOUT_PLAYWRIGHT!);
	const browser = await chromium.launch({ headless: true, channel: process.env.KNOMO_LAYOUT_BROWSER || "msedge" });
	try {
		const { translate } = await import("../src/i18n");
		const [a] = await h.seed("A.md", "- 10:00 A ^a\n");
		await h.page.open(a);
		h.page.el!.classList.add("has-host-header");
		const subjectCard = h.page.el!.querySelector<HTMLElement>(".knomo-relations-subject .knomo-card")!;
		const cardHead = subjectCard.createDiv({ cls: "knomo-card-head" });
		cardHead.createSpan({ cls: "knomo-card-time", text: "10:00" });
		cardHead.appendChild(subjectCard.querySelector(".knomo-card-menu")!);
		subjectCard.prepend(cardHead);
		const css = readFileSync("styles.css", "utf8");
		const page = await browser.newPage();
		for (const locale of ["zh-CN", "en"] as const) for (const theme of ["theme-light", "theme-dark", "theme-custom"]) {
			for (const width of [320, 390, 768, 1024]) for (const font of [14, 22]) {
				h.page.el!.querySelector(".knomo-relations-section-header h3")!.textContent = translate(locale, "relations.current");
				h.page.el!.querySelector(".knomo-relations-back")!.setAttribute("aria-label", translate(locale, "relations.backList"));
				h.page.el!.querySelector("h3[tabindex]")!.textContent = translate(locale, "relations.referrers", { count: 10000 });
				await page.setViewportSize({ width, height: 800 });
				await page.setContent(`<style>
					* { box-sizing:border-box; }
					body { margin:0; font:${font}px/1.5 Arial; --font-ui-small:${font}px; --font-ui-medium:${font}px;
						--size-4-2:8px; --h3-line-height:1.3;
						--text-normal:#222; --text-muted:#666; --text-accent:#6340c2; --interactive-accent:#6340c2;
						--background-primary:#fff; --background-secondary:#eee; --background-modifier-hover:rgba(127,127,127,.14); }
					.theme-dark { --text-normal:#eee; --text-muted:#bbb; --text-accent:#b19afa; --background-primary:#202020; }
					.theme-custom { font-family:Georgia; --h3-line-height:1.5; --text-accent:#00756b; --background-primary:#f8f2e7; }
					h3 { line-height:var(--h3-line-height); }
					button { font:inherit; }
					${css}
				</style><body class="${theme}"><main class="knomo-plugin has-memo-relations is-record-stats is-sidebar-collapsed ${width < 768 ? "is-layout-mobile" : width < 1024 ? "is-layout-desktop-narrow" : "is-layout-desktop-wide"}"
					style="display:block;width:100%;height:100vh;--knomo-text-ui-base:${font}px">
					<div class="knomo-topbar"><button class="knomo-record-stats-back">Back</button></div>
					<div class="knomo-compact-header"><button class="knomo-record-stats-back">Back</button></div>
					${h.page.el!.outerHTML}<span class="fixture-accent" style="color:var(--text-accent)"></span>
					<div class="knomo-recent-flow-decoration knomo-recent-flow-date"><span>Today</span></div>
				</main></body>`);
				await page.mouse.move(0, 0);
				const actual = await page.evaluate(() => {
					const relationPage = document.querySelector<HTMLElement>(".knomo-relations-page")!;
					const header = relationPage.querySelector<HTMLElement>(".knomo-relations-header")!;
					const row = relationPage.querySelector<HTMLElement>(".knomo-relations-section-header")!;
					const title = row.querySelector("h3")!;
					const back = row.querySelector<HTMLButtonElement>("button")!;
					const listTitle = relationPage.querySelector<HTMLElement>("h3[tabindex]")!;
					const cardMenu = relationPage.querySelector<HTMLElement>(".knomo-relations-subject .knomo-card-menu")!;
					const textLeft = (el: HTMLElement) => {
						const range = document.createRange(); range.selectNodeContents(el);
						return range.getBoundingClientRect().left;
					};
					const reference = document.querySelector<HTMLButtonElement>(".knomo-topbar .knomo-record-stats-back")!;
					const appearance = (el: HTMLElement) => {
						const style = getComputedStyle(el);
						return [style.padding, style.borderWidth, style.borderRadius, style.color, style.backgroundColor, style.boxShadow, style.cursor];
					};
					const resting = appearance(back), referenceResting = appearance(reference);
					const rect = back.getBoundingClientRect();
					const rowRect = row.getBoundingClientRect(), titleRect = title.getBoundingClientRect();
					const menuRect = cardMenu.getBoundingClientRect(), listStyle = getComputedStyle(listTitle);
					const subjectCard = cardMenu.closest<HTMLElement>(".knomo-card")!, subjectRect = subjectCard.getBoundingClientRect();
					const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.bottom - 1);
					const cardHit = document.elementFromPoint(rect.x + rect.width / 2, subjectRect.top + 1);
					back.focus();
					const focused = appearance(back);
					// 移动布局会隐藏桌面标题栏，临时移出后才能比较其真实聚焦样式。
					const referenceParent = reference.parentElement!;
					relationPage.parentElement!.appendChild(reference);
					reference.style.display = "inline-flex"; reference.focus();
					const referenceFocused = appearance(reference);
					reference.style.removeProperty("display"); referenceParent.appendChild(reference); back.focus();
					const focusedSurface = getComputedStyle(back, "::before");
					return { headerHeight: header.getBoundingClientRect().height, overflow: relationPage.scrollWidth > relationPage.clientWidth,
						rowOverflow: row.scrollWidth > row.clientWidth, buttonWidth: rect.width, buttonHeight: rect.height,
						buttonRight: rect.right, titleRight: title.getBoundingClientRect().right, buttonLeft: rect.left,
						currentSpacing: [titleRect.top - rowRect.top, rowRect.bottom - titleRect.bottom],
						listSpacing: [listStyle.paddingTop, listStyle.paddingBottom, listStyle.marginTop, listStyle.marginBottom],
						subjectGap: listTitle.getBoundingClientRect().top - subjectRect.bottom,
						leftOffsets: [textLeft(title), textLeft(listTitle), textLeft(document.querySelector<HTMLElement>(".knomo-recent-flow-date")!)],
						buttonCenterOffset: rect.y + rect.height / 2 - titleRect.y - titleRect.height / 2,
						buttonMenuCenterOffset: rect.x + rect.width / 2 - menuRect.x - menuRect.width / 2,
						buttonWithinHeader: rect.top >= rowRect.top && rect.bottom <= rowRect.bottom,
						buttonHit: hit?.closest(".knomo-relations-back") === back, cardHit: cardHit?.closest(".knomo-card") === subjectCard,
						focusSurface: [focusedSurface.width, focusedSurface.height, focusedSurface.backgroundColor, focusedSurface.pointerEvents],
						colors: [...relationPage.querySelectorAll("h3")].map(el => getComputedStyle(el).color),
						accent: getComputedStyle(document.querySelector(".fixture-accent")!).color,
						resting, referenceResting, focusedAppearance: focused, referenceFocused,
						outline: getComputedStyle(back).outlineStyle, outlineOffset: getComputedStyle(back).outlineOffset, focused: document.activeElement === back,
						hostBacksHidden: [...document.querySelectorAll(".knomo-record-stats-back")].every(el => getComputedStyle(el).display === "none") };
				});
				const context = JSON.stringify({ locale, theme, width, font, actual });
				assert.equal(actual.headerHeight, 0, context);
				assert.equal(actual.overflow || actual.rowOverflow, false, context);
				assert.ok(Math.abs(actual.currentSpacing[0] - (width < 768 ? 8 : 10)) < 0.1, context);
				assert.ok(Math.abs(actual.currentSpacing[1] - 8) < 0.1, context);
				assert.deepEqual(actual.listSpacing, ["10px", "8px", "0px", "0px"], context);
				assert.equal(actual.subjectGap, 8, context);
				assert.ok(actual.leftOffsets.every((left: number) => Math.abs(left - actual.leftOffsets[2]) < 0.1), context);
				assert.deepEqual(actual.colors, [actual.accent, actual.accent], context);
				if (width < 768) {
					assert.equal(actual.buttonWidth, 0, context);
					assert.equal(actual.buttonHeight, 0, context);
					continue;
				}
				const buttonSize = 32;
				assert.equal(actual.buttonWidth, buttonSize, context);
				assert.equal(actual.buttonHeight, buttonSize, context);
				assert.deepEqual(actual.resting, actual.referenceResting, context);
				assert.equal(actual.focusedAppearance[3], actual.referenceFocused[3], context);
				assert.equal(actual.focusedAppearance[4], "rgba(0, 0, 0, 0)", context);
				assert.deepEqual(actual.focusSurface, ["28px", "28px", actual.referenceFocused[4], "none"], context);
				assert.ok(actual.buttonRight <= width && actual.titleRight <= actual.buttonLeft, context);
				assert.ok(Math.abs(actual.buttonCenterOffset) < 0.1 && Math.abs(actual.buttonMenuCenterOffset) < 0.1, context);
				assert.equal(actual.buttonWithinHeader && actual.buttonHit && actual.cardHit, true, context);
				assert.equal(actual.outlineOffset, "-4px", context);
				assert.equal(actual.focused && actual.outline === "solid" && actual.hostBacksHidden, true, context);
				await page.locator(".knomo-relations-back").hover();
				const hovered = await page.locator(".knomo-relations-back").evaluate((button: HTMLElement) => {
					const surface = getComputedStyle(button, "::before");
					return [getComputedStyle(button).backgroundColor, surface.width, surface.height, surface.backgroundColor];
				});
				assert.deepEqual(hovered, ["rgba(0, 0, 0, 0)", "28px", "28px", actual.referenceFocused[4]], context);
			}
		}
	} finally { await browser.close(); h.close(); }
});

test("被引用指标局部撤下旧数值与入口，正常更新不播报，持续故障只保留一个原位说明", async () => {
	const h = await fixture();
	try {
		await h.seed("A.md", "- 10:00 A ^a\n"); await h.seed("B.md", "- 11:00 B [[A#^a]]\n");
		const { RecordStatsService } = await import("../src/services/RecordStatsService");
		const { syncKnomoReferencedMetric } = await import("../src/ui/KnomoRecordStatsPage");
		const stats = new RecordStatsService(); await stats.prepareFromSource("test", current => h.read.buildRecordStats(async () => {}, current));
		const selected = stats.select("month", new Date(2026, 9, 25))!;
		const chart = h.host.createDiv({ text: "chart" });
		const metric = h.host.createEl("button", { attr: { "data-record-stats-metric": "referenced", "data-action": "record-stats-filter-referenced" } });
		metric.createDiv({ cls: "knomo-record-stats-metric-value", text: "1" }); metric.focus();
		syncKnomoReferencedMetric(h.host, selected, { state: "ready", updating: true, error: null });
		assert.equal(metric.textContent, "—"); assert.equal(metric.getAttribute("data-action"), null);
		assert.equal(h.win.document.activeElement, metric); assert.equal(h.host.firstElementChild, chart);
		assert.equal(metric.querySelector("[role='status'],[aria-live]"), null);
		const failed = { ...selected, referenced: { count: 1, complete: false, failed: true } };
		syncKnomoReferencedMetric(h.host, failed, { state: "ready", updating: false, error: null });
		const fault = metric.querySelector("[role='status']"); assert.ok(fault);
		syncKnomoReferencedMetric(h.host, failed, { state: "ready", updating: false, error: null });
		assert.equal(metric.querySelector("[role='status']"), fault);
		syncKnomoReferencedMetric(h.host, selected, { state: "ready", updating: false, error: null });
		assert.equal(metric.textContent, "1"); assert.equal(metric.querySelector("[role='status']"), null);
		assert.equal(h.host.firstElementChild, chart); assert.equal(h.win.document.activeElement, metric);
	} finally { h.close(); }
});

test("统计构建正常失效仍有一次尾随准备，同代次持续失效不会空转", async () => {
	for (const persistent of [false, true]) {
	const h = await fixture();
	try {
		await h.seed("A.md", "- 10:00 A ^a\n"); await h.seed("B.md", "- 11:00 B [[A#^a]]\n");
		const { KnomoView } = await import("../src/ui/KnomoView");
		const { KnomoViewStateController } = await import("../src/ui/KnomoViewStateController");
		const { RecordStatsService } = await import("../src/services/RecordStatsService");
		const { RecordStatsPreparationController } = await import("../src/ui/RecordStatsPreparationController");
		const { MemoRelationsChangedError } = await import("../src/services/MemoRelationService");
		const state = new KnomoViewStateController(); state.activeNav = "record-stats";
		const stats = new RecordStatsService(), original = h.read.relations.assertCurrent.bind(h.read.relations);
		let checks = 0;
		h.read.relations.assertCurrent = async (...args) => { if (++checks === 1 || persistent) throw new MemoRelationsChangedError(); return original(...args); };
		const view = Object.assign(Object.create(KnomoView.prototype), {
			viewStateController: state, recordStatsService: stats, catalogReadService: h.read, containerEl: h.host,
			catalogCoverage: await h.catalog.getStore().getCoverage(), trashViewClosed: false, mobileSearchController: { isOpen: false },
			relationStatsRefreshTimer: null, renderCardFlow: () => {}, renderRecordStatsPage: () => {},
			recordStatsPreparationController: new RecordStatsPreparationController({ scheduleTask: (callback, delay) => h.win.setTimeout(callback, delay), cancelTask: id => h.win.clearTimeout(id) }),
		});
		assert.equal(await view.prepareRecordStats(), false); await settle(); await settle();
		assert.equal(stats.getSnapshot().state, persistent ? "idle" : "ready"); assert.equal(stats.getSnapshot().error, null);
		if (!persistent) assert.equal(stats.select("month", new Date(2026, 9, 25))?.referenced?.count, 1);
		assert.equal(checks, persistent ? 2 : 3);
	} finally { h.close(); }
	}
});

test("实际视图接线在 metadata 挂起期间无全局关系提示，后台放行后各表面自动出现预览", async () => {
	let pending = true;
	const h = await fixture(true, false, { resolvePath: () => ({ path: "A.md", pending }) });
	try {
		const [a] = await h.seed("A.md", "- 10:00 A ^a\n");
		await h.seed("B.md", "- 11:00 saved [[A#^a]]\n");
		const memo = await h.memo(a);
		for (const surface of ["card-flow", "mobile-search", "random", "review", "time-buoy"]) {
			const card = h.host.createEl("article", { cls: "knomo-card", attr: { "data-surface": surface } });
			card.createDiv({ cls: "original-body", text: "正文" });
			h.cards!.observe(card, memo);
		}
		await settle();
		assert.equal(h.host.querySelector(".knomo-relation-progress"), null);
		assert.doesNotMatch(h.host.textContent!, /Updating related|Pending update|Retry related|关联记录正在更新|待更新|重试关联记录/u);
		pending = false; h.read.relations.invalidateResolution(["A.md"]);
		await settle();
		assert.equal(h.host.querySelectorAll(".knomo-referrer-preview").length, 5);
		assert.equal(h.host.querySelectorAll(".original-body").length, 5);
	} finally { h.close(); }
});

test("不完整的空集合保留已读预览与同一控件焦点，完整确认后才移除", async () => {
	let pending = false;
	const h = await fixture(true, false, { isFileCurrent: file => file.sourcePath !== "B.md" || !pending });
	try {
		const [a] = await h.seed("A.md", "- 10:00 A ^a\n");
		await h.seed("B.md", "- 11:00 [[A#^a]]\n");
		const card = h.host.createEl("article", { cls: "knomo-card" });
		h.cards!.observe(card, await h.memo(a)); await settle();
		const preview = card.querySelector<HTMLButtonElement>(".knomo-referrer-preview")!;
		preview.focus(); pending = true; h.read.relations.invalidateResolution(["B.md"]);
		await settle();
		assert.equal(card.querySelector(".knomo-referrer-preview"), preview);
		assert.equal(h.win.document.activeElement, preview);
		assert.equal(card.querySelector(".knomo-referrers-title"), null);
		pending = false; await h.seed("B.md", "- 11:00 removed\n"); await settle();
		assert.equal(card.querySelector(".knomo-memo-referrers"), null);
	} finally { h.close(); }
});

test("旧行取消与新节点集合交错后可见空行自动接续，并以未知总量暴露部分结果", async () => {
	const h = await fixture();
	try {
		const { MemoRelationWindow } = await import("../src/ui/MemoRelationWindow");
		const [handle] = await h.seed("A.md", "- 10:00 A ^a\n");
		const node: MemoRelationNode = { handle, blockId: "a", logicalDate: handle.logicalDate, time: handle.time, targets: [] };
		let release!: () => void, calls = 0;
		const gate = new Promise<void>(resolve => { release = resolve; });
		const el = h.host.createDiv();
		const list = new MemoRelationWindow(el, h.host, 100, async row => {
			if (++calls === 1) { await gate; return; }
			row.createEl("button", { text: "A" });
		}, () => {});
		try {
			list.setNodes([node]); list.setNodes([node], false); release(); await settle();
			assert.equal(calls, 2);
			assert.equal(el.querySelector("button")?.textContent, "A");
			assert.equal(el.querySelector("[role='listitem']")?.getAttribute("aria-setsize"), "-1");
			list.setComplete(true);
			assert.equal(el.querySelector("[role='listitem']")?.getAttribute("aria-setsize"), "1");
		} finally { list.dispose(); }
	} finally { h.close(); }
});

test("关联页不展示引用来源目录或未解析提示，保留正文链接与直接引用者", async () => {
	for (const target of ["A#^a", "Missing#^missing"]) {
		const h = await fixture();
		try {
			await h.seed("A.md", "- 10:00 A ^a\n");
			const link = `[[${target}|自定义来源]]`;
			const [b] = await h.seed("B.md", `- 11:00 B ${link} ^b\n`);
			const [c] = await h.seed("C.md", "- 12:00 C [[B#^b]]\n");
			await h.page.open(b); await settle();
			assert.equal(h.page.el!.querySelector(".knomo-relations-sources, .knomo-relation-source"), null);
			assert.deepEqual(Array.from(h.page.el!.querySelectorAll("h3")).map(heading => heading.textContent), ["Current record", "Referenced by 1 record"]);
			assert.ok(h.page.el!.querySelector(".knomo-relations-subject .knomo-card-content")!.textContent!.includes(link));
			assert.equal(h.page.el!.querySelector<HTMLElement>(".knomo-relations-list .knomo-card")!.dataset.memoId, observationHandleKey(c));
			assert.deepEqual(h.errors, []);
		} finally { h.close(); }
	}
});

test("关联页保留直接引用者的 DOM、焦点与滚动，部分零不形成空结论", async () => {
	const h = await fixture();
	try {
		await h.seed("A.md", "- 10:00 A ^a\n");
		const [b] = await h.seed("B.md", "- 11:00 B [[A#^a]] ^b\n");
		await h.seed("C.md", "- 12:00 C [[B#^b]]\n");
		await h.page.open(b); await settle();
		const row = h.page.el!.querySelector(".knomo-relations-list .knomo-card")!;
		const menu = row.querySelector<HTMLButtonElement>(".knomo-card-menu")!;
		menu.focus(); h.page.el!.scrollTop = 222;
		// 关系暂不完整时，主体和已读引用者仍保持可验证。
		h.read.relations.invalidateResolution(["A.md"]);
		const original = h.read.relations.read.bind(h.read.relations);
		h.read.relations.read = async (signal, handles) => {
			const snapshot = await original(signal, handles);
			return { ...snapshot, complete: false, referrers: new Map() };
		};
		await settle();
		assert.equal(h.page.el!.querySelector(".knomo-relations-list .knomo-card"), row);
		assert.equal(h.win.document.activeElement, menu); assert.equal(h.page.el!.scrollTop, 222);
		assert.ok([...h.page.el!.querySelectorAll("[aria-setsize]")].every(item => item.getAttribute("aria-setsize") === "-1"));
		assert.equal(h.page.el!.querySelector("[role='status'],[aria-live]"), null);
		h.read.relations.read = original; h.read.relations.invalidateResolution(["A.md"]); await settle();
		assert.equal(h.page.el!.querySelector(".knomo-relations-list .knomo-card"), row);
		assert.equal(h.win.document.activeElement, menu);
	} finally { h.close(); }
});

test("行读取中发生版本失效，旧任务结束后无需滚动也会接续当前行", async () => {
	const h = await fixture();
	let release!: () => void;
	try {
		const [a] = await h.seed("A.md", "- 10:00 A ^a\n"); await h.seed("B.md", "- 11:00 B [[A#^a]]\n");
		const original = h.read.readMemoItems.bind(h.read); let attempts = 0, entered!: () => void;
		const gate = new Promise<void>(resolve => { release = resolve; });
		const ready = new Promise<void>(resolve => { entered = resolve; });
		h.read.readMemoItems = async (handles, signal) => {
			if (handles.some(handle => handle.sourcePath === "B.md") && ++attempts === 1) { entered(); await gate; }
			return original(handles, signal);
		};
		await h.page.open(a); await ready;
		h.read.relations.invalidateResolution(["A.md"]); await settle(); release();
		await settle(); await settle();
		assert.equal(attempts, 2);
		assert.equal(h.page.el!.querySelector(".knomo-relations-list .knomo-card-content")?.textContent, "B [[A#^a]]");
		assert.equal(h.page.el!.querySelector("[role='status']"), null);
	} finally { release?.(); h.close(); }
});

test("行句柄读取正常失效会取得新查询再补读，持续失效有界且不留下永久空白忙碌行", async () => {
	for (const persistent of [false, true]) {
		const h = await fixture();
		try {
			const { CatalogDiscoveryInvalidatedError } = await import("../src/services/CatalogReadService");
			const [a] = await h.seed("A.md", "- 10:00 A ^a\n"); await h.seed("B.md", "- 11:00 B [[A#^a]]\n");
			const original = h.read.readMemoItems.bind(h.read); let attempts = 0;
			h.read.readMemoItems = async (handles, signal) => {
				if (handles.some(handle => handle.sourcePath === "B.md") && (++attempts === 1 || persistent)) throw new CatalogDiscoveryInvalidatedError();
				return original(handles, signal);
			};
			await h.page.open(a); await settle(); await settle();
			assert.equal(attempts, 2);
			const list = h.page.el!.querySelector(".knomo-relations-list")!;
			assert.equal(!!list.querySelector(".knomo-card"), !persistent);
			assert.equal(!!list.querySelector("[role='status']"), persistent);
			assert.equal(list.querySelector("[aria-busy='true']"), null);
		} finally { h.close(); }
	}
});

test("窗口锚点和焦点所在行删除后回退邻近存活行", async () => {
	const h = await fixture();
	try {
		const { MemoRelationWindow } = await import("../src/ui/MemoRelationWindow");
		const nodes = (await h.seed("D.md", "- 10:00 A ^a\n- 11:00 B ^b\n- 12:00 C ^c\n")).map((handle): MemoRelationNode => ({ handle, logicalDate: handle.logicalDate, time: handle.time, blockId: handle.existingBlockId, targets: [] }));
		const el = h.host.createDiv(); el.getBoundingClientRect = () => new h.win.DOMRect(0, -h.host.scrollTop, 360, 300);
		const window = new MemoRelationWindow(el, h.host, 100, async (row, node) => { row.createEl("button", { text: node.blockId! }); }, () => {});
		try {
			window.setNodes(nodes); await settle(); h.host.scrollTop = 150;
			el.querySelectorAll<HTMLButtonElement>("button")[1].focus();
			window.setNodes([nodes[0], nodes[2]]); await settle();
			assert.equal(h.win.document.activeElement?.textContent, "c");
			assert.equal(h.host.scrollTop, 150);
		} finally { window.dispose(); }
	} finally { h.close(); }
});

test("同日连续保存沿提交映射复用主体、图片及引用者行，不更换已选操作句柄", async () => {
	const h = await fixture();
	try {
		let before = await h.seed("D.md", "- 10:00 A ^a\n- 11:00 B [[#^a]]\n");
		await h.page.open(before[0]); await settle();
		const subject = h.page.el!.querySelector<HTMLElement>(".knomo-relations-subject .knomo-card")!;
		const row = h.page.el!.querySelector<HTMLElement>(".knomo-relations-list .knomo-card")!;
		const image = subject.createEl("img", { attr: { src: "image.png" } });
		const selected = h.page.findMemo(observationHandleKey(before[0]));
		const selectedHandle = selected!.catalog!.observationHandle;
		const menu = subject.querySelector<HTMLButtonElement>("button")!; menu.focus();
		for (let index = 0; index < 2; index++) {
			const after = await h.seed("D.md", "- 10:00 A ^a\n- 11:00 B [[#^a]]\n" + Array.from({ length: index + 1 }, (_, item) => `- 12:00 extra ${item}\n`).join(""));
			const { buildDailyMemoPresentationChange } = await import("../src/services/DailyMemoPresentationChange");
			const prepared = { sourcePath: "D.md", logicalDate: "2026-10-25", before: { sourceRevision: before[0].sourceRevision, observations: before }, after: { sourceRevision: after[0].sourceRevision, observations: after } };
			h.page.applyChange(buildDailyMemoPresentationChange(prepared as Parameters<typeof buildDailyMemoPresentationChange>[0], null, after.at(-1)!));
			await settle();
			assert.equal(h.page.el!.querySelector(".knomo-relations-subject .knomo-card"), subject);
			assert.equal(h.page.el!.querySelector(".knomo-relations-subject img"), image);
			assert.equal(h.page.el!.querySelector(".knomo-relations-list .knomo-card"), row);
			assert.equal(h.win.document.activeElement, menu);
			assert.equal(selected!.catalog!.observationHandle, selectedHandle);
			assert.notEqual(h.page.findMemo(observationHandleKey(after[0]))!.catalog!.observationHandle.sourceRevision, selectedHandle.sourceRevision);
			before = after;
		}
	} finally { h.close(); }
});

test("查看直接引用者不等待主列表的旧预览批次，也不在关联页追加预览", async () => {
	const h = await fixture(true);
	let release!: () => void;
	try {
		const [a] = await h.seed("A.md", "- 10:00 A ^a\n"); await h.seed("B.md", "- 11:00 B [[A#^a]]\n");
		const memo = await h.memo(a), original = h.read.readMemoItems.bind(h.read);
		let entered!: () => void, blocked = false;
		const gate = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { entered = resolve; });
		h.read.readMemoItems = async (handles, signal) => {
			if (!blocked && handles.some(handle => handle.sourcePath === "B.md")) { blocked = true; entered(); await gate; }
			return original(handles, signal);
		};
		const card = h.host.createEl("article", { cls: "knomo-card" }); h.cards!.observe(card, memo); await ready;
		let opened = false;
		const opening = h.page.open(a).then(() => { opened = true; }); await settle();
		assert.equal(opened, true);
		assert.ok(h.page.el!.querySelector(".knomo-relations-list .knomo-card"));
		assert.equal(h.page.el!.querySelector(".knomo-memo-referrers"), null);
		const focus = h.page.el!.querySelector(".knomo-relations-subject .knomo-card-menu");
		assert.equal(h.win.document.activeElement, focus);
		release(); await opening; await settle();
		assert.ok(card.querySelector(".knomo-referrer-preview"));
		assert.equal(h.page.el!.querySelector(".knomo-memo-referrers"), null);
		assert.equal(h.win.document.activeElement, focus);
	} finally { release?.(); h.close(); }
});

test("预览正文瞬时失败自动补读，持续失败有界且没有全局错误或重试按钮", async () => {
	for (const persistent of [false, true]) {
		const h = await fixture(true);
		try {
			const [a] = await h.seed("A.md", "- 10:00 A ^a\n");
			await h.seed("B.md", "- 11:00 B [[A#^a]]\n");
			const memo = await h.memo(a), original = h.read.readMemoItems.bind(h.read);
			let attempts = 0;
			h.read.readMemoItems = async (handles, signal) => {
				if (handles.some(handle => handle.sourcePath === "B.md") && (++attempts === 1 || persistent)) throw Error("preview I/O");
				return original(handles, signal);
			};
			const card = h.host.createEl("article", { cls: "knomo-card" }); h.cards!.observe(card, memo);
			await settle(); await settle(); await settle();
			assert.equal(attempts, 2); assert.equal(!!card.querySelector(".knomo-referrer-preview"), !persistent);
			assert.equal(h.host.querySelector(".knomo-relation-progress,[role='status'],[data-action='retry-memo-relations']"), null);
		} finally { h.close(); }
	}
});

test("关联窗口正文瞬时失败自动补读，持续错误用行内故障保留可感知结果", async () => {
	for (const persistent of [false, true]) {
		const h = await fixture();
		try {
			const [a] = await h.seed("A.md", "- 10:00 A ^a\n"); await h.seed("B.md", "- 11:00 B [[A#^a]]\n");
			const original = h.read.readMemoItems.bind(h.read); let attempts = 0;
			h.read.readMemoItems = async (handles, signal) => {
				if (handles.some(handle => handle.sourcePath === "B.md") && (++attempts === 1 || persistent)) throw Error("row I/O");
				return original(handles, signal);
			};
			await h.page.open(a); await settle(); await settle();
			assert.equal(attempts, 2);
			const list = h.page.el!.querySelector(".knomo-relations-list")!;
			assert.equal(!!list.querySelector(".knomo-card"), !persistent);
			assert.equal(!!list.querySelector("[role='status']"), persistent);
			assert.equal(list.querySelector("button[data-action='retry-memo-relations']"), null);
		} finally { h.close(); }
	}
});

test("metadata 更新使被引用统计待更新，仅刷新正在浏览的统计或钻取，不重读原卡片正文", async () => {
	const h = await fixture();
	try {
		await h.seed("A.md", "- 10:00 A ^a\n");
		await h.seed("B.md", "- 11:00 [[A#^a]]\n");
		const { KnomoView } = await import("../src/ui/KnomoView");
		const { KnomoViewStateController } = await import("../src/ui/KnomoViewStateController");
		const { RecordStatsService } = await import("../src/services/RecordStatsService");
		const { RecordStatsPreparationController } = await import("../src/ui/RecordStatsPreparationController");
		const stats = new RecordStatsService(), state = new KnomoViewStateController();
		await stats.prepareFromSource("same-catalog-revision", current => h.read.buildRecordStats(async () => {}, current));
		state.activeNav = "record-stats";
		let renders = 0, scheduled = 0, queries = 0;
		const view = Object.assign(Object.create(KnomoView.prototype), {
			viewStateController: state, recordStatsService: stats, trashViewClosed: false,
			mobileSearchController: { isOpen: false, searchRecordStatsFilter: null },
			recordStatsViewStateController: { clearRendered: () => {} },
			recordStatsPreparationController: new RecordStatsPreparationController({ scheduleTask: () => ++scheduled, cancelTask: () => {} }),
			renderRecordStatsPage: () => { renders++; },
			renderCardFlow: () => { throw Error("不能重建原卡片"); },
			cancelCatalogDesktopCount: () => {}, cancelCatalogDesktopQuery: () => {}, refreshCatalogActiveQuery: () => { queries++; },
		});
		const unsubscribe = h.read.relations.subscribe(() => view.onMemoRelationsChanged());
		try {
			const bodies = h.bodyReads();
			h.read.relations.invalidateResolution(["A.md"]);
			assert.equal(stats.getSnapshot().updating, true);
			assert.equal(renders, 1); assert.equal(scheduled, 1); assert.equal(queries, 0);
			state.activeNav = "all";
			h.read.relations.invalidateResolution(["A.md"]);
			assert.equal(renders, 1); assert.equal(queries, 0);
			state.recordStatsSearchFilter = { type: "referenced", startDate: "2026-10-01", endDateExclusive: "2026-11-01" };
			const flow = h.host.createDiv(), body = flow.createDiv({ text: "正文与图片" });
			const count = flow.createDiv({ cls: "knomo-relation-result-count", text: "9" });
			Object.assign(view, { cardFlowEl: flow, catalogStatus: {}, catalogDesktopTotalCount: 9, catalogDesktopCountPresentation: { count: 9 } });
			h.read.relations.invalidateResolution(["A.md"]);
			assert.equal(queries, 1);
			assert.equal(view.catalogDesktopTotalCount, null);
			assert.equal(view.catalogDesktopCountPresentation, null);
			assert.equal(view.getCatalogPresentationTotalCount(), null);
			assert.equal(count.isConnected, false); assert.equal(flow.firstElementChild, body);
			assert.equal(h.bodyReads(), bodies);
			state.activeNav = "record-stats";
			state.recordStatsSearchFilter = null;
			view.mobileSearchController.isOpen = true;
			view.mobileSearchController.searchRecordStatsFilter = { type: "referenced", startDate: "2026-10-01", endDateExclusive: "2026-11-01" };
			h.read.relations.invalidateResolution(["A.md"]);
			assert.equal(queries, 2, "移动钻取覆盖在统计页上时同样刷新真实搜索结果");
			assert.equal(renders, 1, "移动搜索或关联页覆盖期间不重建底层统计 DOM，不清理正在阅读的 Markdown");
		} finally { unsubscribe(); }
	} finally { h.close(); }
});

test("生产预览缓存随关联窗口和层级释放，保留原页面仍使用的正文", async () => {
	const h = await fixture(false, true);
	try {
		Object.defineProperty(h.win.HTMLElement.prototype, "clientHeight", { configurable: true, get() { return 600; } });
		const [a, ...refs] = await h.seed("A.md", "- 10:00 subject ^a\n" + Array.from({ length: 300 }, (_, i) => `- 11:00 body ${i} [[#^a]]\n`).join(""));
		const shared = await h.memo(refs[0]);
		h.cacheView!.memos = [shared]; h.cacheView!.getMemoCardPreview(shared);
		const sharedPreview = h.cache.get(shared, "unused");
		await h.page.open(a); await settle();
		const list = h.page.el!.querySelector<HTMLElement>(".knomo-relations-list")!;
		list.getBoundingClientRect = () => new h.win.DOMRect(0, -h.page.el!.scrollTop, 360, 78000);
		const window = (h.page as unknown as { referrersWindow: { refresh: () => void } }).referrersWindow;
		for (let offset = 0; offset < 300; offset += 30) {
			h.page.el!.scrollTop = offset * 260; window.refresh(); await settle();
			assert.ok(h.cacheSize() <= 27, `缓存 ${h.cacheSize()} 应只保留窗口、主体和原页面正文`);
		}
		for (const handle of refs.slice(0, 12)) {
			await h.page.open(handle); await settle();
			assert.ok(h.cacheSize() <= 3, "历史层不保留完整正文预览");
		}
		h.page.close();
		assert.equal(h.cacheSize(), 1, "关闭后仅保留原页面仍使用的 Memo");
		assert.equal(h.cache.get(shared, "must reuse"), sharedPreview);
	} finally { h.close(); }
});

test("查看等待关系查询时主体可见且无文字或播报噪声，关闭后不发布迟到内容", async () => {
	const h = await fixture();
	try {
		const [a] = await h.seed("A.md", "- 10:00 readable ^a\n");
		const read = h.read.relations.read.bind(h.read.relations);
		let release!: () => void, entered!: () => void;
		const gate = new Promise<void>(resolve => { release = resolve; });
		const ready = new Promise<void>(resolve => { entered = resolve; });
		h.read.relations.read = async signal => { entered(); await gate; return read(signal); };
		const opening = h.page.open(a); await ready;
		try {
			assert.equal(h.page.el!.querySelector(".knomo-card-content")?.textContent, "readable");
			assert.equal(h.page.el!.classList.contains("is-locating-list"), false);
			assert.equal(h.page.el!.querySelector("[role='status'],[aria-live]"), null);
			assert.doesNotMatch(h.page.el!.textContent!, /Updating related|Pending update|Retry related|正在更新|待更新|重试关联记录/u);
		} finally { h.page.close(); release(); await opening; }
		assert.equal(h.page.el, null);
	} finally { h.close(); }
});

test("无关 Daily 编辑不打断已打开关联页或重读其正文", async () => {
	const h = await fixture(true);
	try {
		const [a] = await h.seed("A.md", "- 10:00 A ^a\n");
		await h.seed("B.md", "- 11:00 [[A#^a]]\n");
		await h.seed("C.md", "- 12:00 unrelated\n");
		await h.page.open(a); await settle();
		const count = h.bodyReads();
		await h.seed("C.md", "- 12:00 unrelated changed\n");
		assert.doesNotMatch(h.page.el!.querySelector("h3:last-of-type")!.textContent!, /Pending update|待更新/u);
		await settle();
		assert.equal(h.bodyReads(), count);
	} finally { h.close(); }
});

test("被引用区展示全部单行摘要，倒序、主 Memo 导航且不冒泡", async () => {
	const h = await fixture();
	try {
		const nodes = await h.seed("D.md", "- 10:00 A ^a\n- 11:00 短文 👨‍👩‍👦 [[#^a]]\n- 12:00 long [[#^a]]\n- 13:00 extra [[#^a]]\n");
		const memo = await h.memo(nodes[0]);
		const snapshot = await h.read.relations.read();
		const { renderMemoReferrers, markRelationCardStale } = await import("../src/ui/MemoRelationCards");
		const card = h.host.createEl("article", { cls: "knomo-card" });
		const body = card.createDiv({ cls: "original-body", text: "原有引用自" });
		const menu = card.createEl("button", { cls: "knomo-card-menu", text: "menu" });
		const opened: Array<[string, HTMLElement]> = [];
		let bubbled = 0; card.addEventListener("click", () => bubbled++);
		const summaries = new Map(nodes.slice(1).map(node => [observationHandleKey(node), { text: "短文 👨‍👩‍👦", imageOnly: false }]));
		renderMemoReferrers(card, memo, snapshot, summaries, async (handle, trigger) => { opened.push([observationHandleKey(handle), trigger]); });
		assert.equal(card.querySelector(".original-body"), body);
		assert.equal(card.querySelectorAll(".knomo-referrer-preview").length, 3);
		const view = card.querySelector<HTMLButtonElement>(".knomo-referrer-preview")!;
		assert.equal(card.querySelector(".knomo-referrers-title"), null);
		assert.equal(card.querySelector(".knomo-referrers-view"), null);
		assert.equal(view.dataset.relationTarget, observationHandleKey(nodes[3]));
		assert.equal(view.querySelector("[data-icon]")?.getAttribute("data-icon"), "message-square-reply");
		assert.equal(view.querySelector("time")?.textContent, "2026-10-25");
		assert.doesNotMatch(view.getAttribute("aria-label")!, /\{date\}/u);
		assert.equal(view.parentElement?.querySelectorAll(".knomo-referrers-title").length, 0);
		assert.equal(card.querySelector(".knomo-referrer-summary")?.textContent, "短文 👨‍👩‍👦");
		view.click(); card.querySelector<HTMLButtonElement>(".knomo-referrer-preview")!.click();
		assert.deepEqual(opened, [[memo.id, view], [memo.id, view]]);
		assert.equal(bubbled, 0);
		markRelationCardStale(card);
		assert.equal(card.querySelector(".knomo-referrers-title"), null);
		view.focus();
		renderMemoReferrers(card, memo, { ...snapshot, referrers: new Map() }, new Map(), async () => {});
		assert.equal(card.querySelector(".knomo-memo-referrers"), null);
		assert.equal(h.win.document.activeElement, menu);
	} finally { h.close(); }
});

test("普通卡片在 0、1、3、10 个引用者下完整展示摘要，热刷新及无关编辑不重读正文", async () => {
	const h = await fixture(true);
	try {
		const targets: Array<{ count: number; memo: MemoViewItem; card: HTMLElement }> = [];
		for (const count of [0, 1, 3, 10]) {
			const [target] = await h.seed(`A${count}.md`, `- 10:00 target ${count} ^a\n`);
			if (count) await h.seed(`R${count}.md`, Array.from({ length: count }, (_, index) =>
				`- 11:00 ${index === 0 ? "长正文 👨‍👩‍👦 ".repeat(400) : "ref " + index} [[A${count}#^a]]\n`).join(""));
			targets.push({ count, memo: await h.memo(target), card: h.host.createEl("article", { cls: "knomo-card" }) });
		}
		const before = h.bodyReads(), started = performance.now();
		for (const target of targets) h.cards!.observe(target.card, target.memo);
		await settle(); await settle();
		const coldElapsedMs = Math.round(performance.now() - started);
		for (const { count, card } of targets) assert.equal(card.querySelectorAll(".knomo-referrer-preview").length, count);
		assert.equal(h.bodyReads() - before, 14, "同屏卡片只读取其 14 条直接引用者正文");
		const target = targets[3], region = target.card.querySelector(".knomo-memo-referrers");
		const button = target.card.querySelector<HTMLButtonElement>(".knomo-referrer-preview")!;
		button.focus();
		const warmReads = h.bodyReads(); h.cards!.refresh(); await settle();
		await h.seed("Unrelated.md", "- 12:00 unrelated edit\n"); h.cards!.refresh(); await settle();
		assert.equal(h.bodyReads(), warmReads);
		assert.equal(target.card.querySelector(".knomo-memo-referrers"), region);
		assert.equal(h.win.document.activeElement, button);
		await h.page.open(target.memo.catalog!.observationHandle, button); await settle();
		const mountedDetailCards = h.page.el!.querySelectorAll(".knomo-card").length;
		assert.ok(mountedDetailCards > 1 && mountedDetailCards <= 11);
		assert.equal(h.page.el!.querySelector("h3[tabindex='-1']")!.textContent, "Referenced by 10 records");
		assert.equal(h.page.el!.querySelector(".knomo-memo-referrers"), null);
		h.page.back(); assert.equal(h.win.document.activeElement, button);
		for (const { card } of targets) { h.cards!.release(card); card.remove(); }
		const releasedReads = h.bodyReads(); h.cards!.refresh(); await settle();
		assert.equal(h.bodyReads(), releasedReads, "普通卡片释放后没有后台正文读取");
		console.log(JSON.stringify({ fixture: "visible cards with 0, 1, 3, 10 direct referrers", environment: "Node/jsdom",
			coldElapsedMs, previewBodyReads: warmReads - before, previewButtons: 14, warmAndUnrelatedBodyReads: 0 }));
	} finally { h.close(); }
});

test("卡片与详情复用分钟秒归一化及同时间稳定排序", async () => {
	const h = await fixture(true);
	try {
		const [target] = await h.seed("A.md", "- 10:00 A ^a\n");
		await h.seed("R.md", "- 11:00 minute [[A#^a]]\n- 11:00:00 second [[A#^a]]\n- 11:00:01 later [[A#^a]]\n- 11:00 same minute [[A#^a]]\n");
		const memo = await h.memo(target), card = h.host.createEl("article", { cls: "knomo-card" });
		h.cards!.observe(card, memo); await settle();
		const snapshot = await h.read.relations.read();
		const expected = snapshot.referrers.get(memo.id)!.map(node => observationHandleKey(node.handle));
		assert.deepEqual(Array.from(card.querySelectorAll<HTMLElement>(".knomo-referrer-preview")).map(button => button.dataset.relationTarget), expected);
		await h.page.open(target); await settle();
		assert.deepEqual(Array.from(h.page.el!.querySelectorAll<HTMLElement>(".knomo-relations-list .knomo-card")).map(row => row.dataset.memoId), expected);
	} finally { h.close(); }
});

test("A→B→C 返回恢复原位置，A→B→A 成环收栈，菜单自身不重复压栈", async () => {
	const h = await fixture();
	try {
		const [a, b, c] = await h.seed("D.md", "- 10:00 A [[#^b]] ^a\n- 11:00 B [[#^a]] ^b\n- 12:00 C [[#^b]] ^c\n");
		await h.page.open(a); h.page.el!.scrollTop = 321;
		await h.page.open(b); h.page.el!.scrollTop = 654;
		await h.page.open(c);
		h.page.back(); await settle();
		assert.equal(h.page.el?.scrollTop, 654);
		h.page.back(); await settle();
		assert.equal(h.page.el?.scrollTop, 321);
		await h.page.open(b); await h.page.open(a);
		await h.page.open(a);
		h.page.back();
		assert.equal(h.page.isOpen, false);
		assert.deepEqual(h.errors, []);
	} finally { h.close(); }
});

test("关联页只展示直接引用者，通过记录菜单进入下一层后才读取和展示其引用者", async () => {
	const h = await fixture(true);
	try {
		const [a] = await h.seed("A.md", "- 10:00 A ^a\n");
		const [b] = await h.seed("B.md", "- 11:00 B [[A#^a]] [[A#^a|重复]] ^b\n");
		const [c] = await h.seed("C.md", "- 12:00 C [[B#^b]] ^c\n");
		const aKey = observationHandleKey(a), bKey = observationHandleKey(b), cKey = observationHandleKey(c);
		const read = h.read.readMemoItems.bind(h.read), reads: string[] = [];
		h.read.readMemoItems = async (handles, signal) => {
			reads.push(...handles.map(observationHandleKey));
			return read(handles, signal);
		};
		const card = h.host.createEl("article", { cls: "knomo-card" });
		h.cards!.observe(card, await h.memo(a)); await settle();
		assert.equal(card.querySelectorAll(".knomo-referrer-preview").length, 1);
		const entry = card.querySelector<HTMLButtonElement>(".knomo-referrer-preview")!;
		await h.page.open(a, entry); await settle();
		const listIds = () => Array.from(h.page.el!.querySelectorAll<HTMLElement>(".knomo-relations-list .knomo-card")).map(row => row.dataset.memoId);
		assert.deepEqual(listIds(), [bKey]);
		assert.equal(h.page.el!.querySelector(".knomo-memo-referrers"), null);
		assert.equal(reads.includes(cKey), false, "浏览 A 时不能读取间接引用者 C 的正文");
		assert.equal(h.page.el!.querySelector(".knomo-relations-list .knomo-card")!.hasAttribute("data-has-referrers"), true);
		assert.equal(h.page.el!.querySelector("h3[tabindex='-1']")!.textContent, "Referenced by 1 record");
		h.page.el!.scrollTop = 321;
		const background = h.previewView.cardFlowEl.createEl("article", { cls: "knomo-card", attr: { "data-memo-id": bKey } });
		background.createEl("button", { cls: "knomo-card-menu", text: "background menu" });
		const menu = h.page.el!.querySelector<HTMLButtonElement>(".knomo-relations-list .knomo-card-menu")!;
		menu.focus();
		await h.previewView.handleMemoAction("relations", h.page.findMemo(bKey)); await settle();
		assert.equal(h.page.el!.querySelector<HTMLElement>(".knomo-relations-subject")!.dataset.subject, bKey);
		assert.deepEqual(listIds(), [cKey]);
		assert.equal(h.page.el!.querySelector(".knomo-relations-list .knomo-card")!.hasAttribute("data-has-referrers"), false);
		assert.equal(reads.includes(cKey), true);
		assert.equal(h.page.el!.querySelector(".knomo-memo-referrers"), null);
		assert.equal(h.page.el!.querySelector("h3[tabindex='-1']")!.textContent, "Referenced by 1 record");
		const snapshot = await h.read.relations.read();
		assert.equal(snapshot.referrers.get(aKey)?.length, 1);
		assert.equal(snapshot.referrers.get(bKey)?.length, 1);
		assert.equal(snapshot.referrers.get(cKey), undefined);
		h.page.back(); await settle();
		assert.deepEqual(listIds(), [bKey]);
		assert.equal(h.page.el!.scrollTop, 321);
		assert.equal(h.win.document.activeElement, h.page.el!.querySelector(".knomo-relations-list .knomo-card-menu"));
		h.page.back();
		assert.equal(h.page.isOpen, false);
		assert.equal(h.win.document.activeElement, entry);
		assert.deepEqual(h.errors, []);
	} finally { h.close(); }
});

test("全部引用者元数据立即可用，10000 条正文与 DOM 受窗口限制且无需手动翻页", async () => {
	const h = await fixture();
	try {
		Object.defineProperty(h.win.HTMLElement.prototype, "clientHeight", { configurable: true, get() { return 600; } });
		const [a] = await h.seed("D.md", "- 10:00 A ^a\n" + Array.from({ length: 10000 }, (_, index) => `- 11:00 ref ${index} [[#^a]]\n`).join(""));
		const started = performance.now();
		await h.page.open(a); await settle();
		assert.equal((await h.read.relations.read()).referrers.get(observationHandleKey(a))?.length, 10000);
		assert.ok(h.host.querySelectorAll(".knomo-relation-window-row").length <= 25);
		assert.ok(h.bodyReads() <= 27, `正文读取 ${h.bodyReads()} 应只含主体和初始窗口`);
		assert.equal(h.host.querySelectorAll("[data-action='load-more']").length, 0);
		console.log(JSON.stringify({ fixture: "10000 direct referrers", environment: "Node/jsdom, 600px simulated viewport", elapsedMs: Math.round(performance.now() - started),
			bodyReads: h.bodyReads(), mountedRows: h.host.querySelectorAll(".knomo-relation-window-row").length }));
	} finally { h.close(); }
});

test("列表行与焦点在无关更新中复用，虚拟窗口可按键连续进入下一行", async () => {
	const h = await fixture();
	try {
		const { MemoRelationWindow } = await import("../src/ui/MemoRelationWindow");
		const nodes = (await h.seed("D.md", "- 10:00 A ^a\n- 11:00 B ^b\n")).map((node): MemoRelationNode => ({
			handle: node, blockId: node.existingBlockId, logicalDate: node.logicalDate, time: node.time, targets: [] }));
		const el = h.host.createDiv();
		const list = new MemoRelationWindow(el, h.host, 100, async (row, node) => { row.createEl("button", { text: node.blockId! }); }, () => {});
		list.setNodes(nodes); await settle();
		const button = el.querySelector<HTMLButtonElement>("button")!; button.focus();
		list.setNodes(nodes);
		assert.equal(h.win.document.activeElement, button);
		button.dispatchEvent(new h.win.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
		await settle();
		assert.equal(h.win.document.activeElement?.textContent, "b");
		list.dispose(); assert.equal(el.children.length, 0);
	} finally { h.close(); }
});

test("10000 个直接引用者各有后续引用时，关联页只加载当前层正文", async () => {
	const h = await fixture(true);
	try {
		const [a] = await h.seed("D.md", "- 10:00 A ^a\n" + Array.from({ length: 10000 }, (_, index) =>
			`- 11:00 ref ${index} [[#^a]] ^r${index}\n- 12:00 child one ${index} [[#^r${index}]]\n- 13:00 child two ${index} [[#^r${index}]]\n`).join(""));
		const started = performance.now();
		await h.page.open(a); await settle();
		assert.equal((await h.read.relations.read()).referrers.get(observationHandleKey(a))?.length, 10000);
		assert.ok(h.bodyReads() <= 27, `当前层主体与初始窗口读取 ${h.bodyReads()} 条正文`);
		assert.ok(h.host.querySelectorAll(".knomo-relation-window-row").length <= 25);
		assert.equal(h.page.el!.querySelector(".knomo-referrer-preview"), null);
		console.log(JSON.stringify({ fixture: "10000 referrers, each with 2 incoming records", nodes: 30001,
			environment: "Node/jsdom, 600px simulated viewport", elapsedMs: Math.round(performance.now() - started), bodyReads: h.bodyReads(),
			mountedRows: h.host.querySelectorAll(".knomo-relation-window-row").length,
			previewButtons: h.host.querySelectorAll(".knomo-referrer-preview").length }));
	} finally { h.close(); }
});

test("读取中退出不发布迟到卡片，删除主体后提供失效状态与安全返回", async () => {
	const h = await fixture();
	try {
		const [a] = await h.seed("D.md", "- 10:00 A ^a\n- 11:00 B [[#^a]]\n");
		await h.page.open(a);
		await h.catalog.deleteFile("D.md");
		await settle(); await settle();
		assert.match(h.page.el!.textContent!, /no longer available|不可访问/u);
		h.page.back();
		await settle();
		assert.equal(h.page.el, null);
		assert.equal(h.host.children.length, 0);
		await h.page.open(a);
		assert.equal(h.page.isOpen, false);
		assert.equal(h.errors.length, 1);
	} finally { h.close(); }
});

test("快速切换以最后一次导航为准，关闭入口会取消尚未完成的首次打开", async () => {
	const h = await fixture();
	try {
		const [a, b] = await h.seed("D.md", "- 10:00 A ^a\n- 11:00 B ^b\n");
		const original = h.read.readMemoItems.bind(h.read);
		let release!: () => void, entered!: () => void;
		const gate = new Promise<void>(resolve => { release = resolve; });
		const ready = new Promise<void>(resolve => { entered = resolve; });
		h.read.readMemoItems = async (handles, signal) => {
			if (handles[0] === a) { entered(); await gate; throw Error("late request failed"); }
			return original(handles, signal);
		};
		const slow = h.page.open(a);
		await ready;
		await h.page.open(b);
		release(); await slow;
		assert.equal(h.page.el!.querySelector(".knomo-card-content")?.textContent, "B");
		assert.deepEqual(h.errors, [], "旧导航失败不能向新页面发布失效通知");
		h.page.close();
		let resume!: () => void, seen!: () => void;
		const next = new Promise<void>(resolve => { resume = resolve; });
		const started = new Promise<void>(resolve => { seen = resolve; });
		h.read.readMemoItems = async (handles, signal) => { seen(); await next; return original(handles, signal); };
		const opening = h.page.open(a); await started; h.page.close(); resume(); await opening;
		assert.equal(h.page.isOpen, false);
	} finally { h.close(); }
});

test("确认编辑使用既有提交映射更新主体阅读，不替换已选写入对象", async () => {
	const h = await fixture();
	try {
		const before = await h.seed("D.md", "- 10:00 A ^a\n- 11:00 B [[#^a]]\n");
		await h.page.open(before[0]);
		const selected = h.page.findMemo(observationHandleKey(before[0]))!;
		const after = await h.seed("D.md", "- 10:00 edited A ^a\n- 11:00 B [[#^a]]\n");
		const { buildDailyMemoPresentationChange } = await import("../src/services/DailyMemoPresentationChange");
		const prepared = { sourcePath: "D.md", logicalDate: "2026-10-25",
			before: { sourceRevision: before[0].sourceRevision, observations: before },
			after: { sourceRevision: after[0].sourceRevision, observations: after } };
		h.page.applyChange(buildDailyMemoPresentationChange(prepared as Parameters<typeof buildDailyMemoPresentationChange>[0], before[0], after[0]));
		await settle();
		assert.equal(h.page.isOpen, true);
		assert.equal(h.page.el!.querySelector(".knomo-relations-subject .knomo-card-content")?.textContent, "edited A");
		assert.equal(selected.catalog!.observationHandle.sourceRevision, before[0].sourceRevision);
		assert.equal(h.page.findMemo(observationHandleKey(after[0]))!.catalog!.observationHandle.sourceRevision, after[0].sourceRevision);
	} finally { h.close(); }
});

test("生产标准卡片操作在关联页不关闭原移动搜索、不记录随机回顾，排队写入保留原句柄", async () => {
	const h = await fixture();
	try {
		const [a] = await h.seed("D.md", "- 10:00 A ^a\n");
		const memo = await h.memo(a);
		const { KnomoView } = await import("../src/ui/KnomoView");
		const { TFile } = await import("obsidian");
		const file = Object.assign(new TFile(), { path: "D.md" });
		let opened = 0, closed = 0, reviewed = 0;
		const target = Object.create(KnomoView.prototype) as Record<string, unknown>;
		Object.defineProperties(target, { activeNav: { value: "random" }, randomDayOpen: { value: false }, mobileSearchPageOpen: { value: true } });
		Object.assign(target, { currentLayout: "mobile", relationsPage: { isOpen: true, findMemo: () => memo }, popupState: { activeMenuMemoId: null },
			closeCardMenu: () => {}, syncCardMenuState: () => {}, closeMobileSearchPage: () => { closed++; },
			findMemoById: () => memo, randomReunionController: { openMemo: async () => { reviewed++; } },
			app: { vault: { getAbstractFileByPath: () => file }, workspace: { getLeaf: () => ({ openFile: async () => { opened++; } }), openLinkText: async () => { opened++; } } } });
		const view = target as unknown as { handleMemoAction: (action: "open-daily", memo: MemoViewItem) => Promise<void>;
			openMemoCardDailyNote: (id: string, random: boolean) => Promise<void>; enqueueCatalogTaskToggle: (memo: MemoViewItem, index: number, checked: boolean) => void };
		await view.handleMemoAction("open-daily", memo);
		await view.openMemoCardDailyNote(memo.id, false);
		assert.equal(opened, 2); assert.equal(closed, 0); assert.equal(reviewed, 0);
		let release!: () => void;
		const prior = new Promise<void>(resolve => { release = resolve; });
		let selected: unknown;
		Object.assign(target, { taskUpdateQueues: new Map([[memo.id, prior]]), refreshPendingSave: async () => {},
			memoCommandService: { toggleTask: async (item: unknown) => { selected = item; return {}; } } });
		view.enqueueCatalogTaskToggle(memo, 0, true);
		Object.assign(target, { relationsPage: { isOpen: true, findMemo: () => ({ ...memo, id: "replacement" }) } });
		release(); await settle();
		assert.equal(selected, memo.catalog);
	} finally { h.close(); }
});

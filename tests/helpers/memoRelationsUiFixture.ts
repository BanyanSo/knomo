import { before, after } from "node:test";
import { JSDOM } from "jsdom";
import { createHash } from "node:crypto";
import { ensureObsidianStub } from "./obsidianStub";
import { DiaryMemoParser } from "../../src/services/DiaryMemoParser";
import { MemoCatalogService } from "../../src/services/MemoCatalogService";
import { InMemoryMemoCatalogStore } from "../../src/services/MemoCatalogStore";
import type { MemoViewItem } from "../../src/types/memoView";
import type { MemoRelationOptions } from "../../src/services/MemoRelationService";
import type { MemoRelationsPageOptions } from "../../src/ui/MemoRelationsPage";

export function setupMemoRelationsTestWindow(): void {
	const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
	before(() => Object.defineProperty(globalThis, "window", { configurable: true, value: { setTimeout: globalThis.setTimeout } }));
	after(() => { if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow); else Reflect.deleteProperty(globalThis, "window"); });
}

export async function fixture(withPreviews = false, withProductionCache = false, relations?: MemoRelationOptions,
	renderCard?: MemoRelationsPageOptions["renderCard"]) {
	await ensureObsidianStub();
	const dom = new JSDOM("<!doctype html><body><main></main></body>", { pretendToBeVisual: true });
	const win = dom.window;
	const focusState = { mobile: false };
	win.focus = () => {};
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
	const { CatalogReadService } = await import("../../src/services/CatalogReadService");
	const { MemoRelationsPage } = await import("../../src/ui/MemoRelationsPage");
	const { MemoRelationCards } = await import("../../src/ui/MemoRelationCards");
	const { toCatalogMemoView } = await import("../../src/types/memoView");
	const { MemoCardPreviewCache } = await import("../../src/ui/MemoCardPreviewCache");
	const { parseMemoCardPreviewLite } = await import("../../src/ui/MemoCardPreview");
	const cache = new MemoCardPreviewCache((_memo, text) => parseMemoCardPreviewLite(text));
	let cacheView: { getMemoCardPreview: (memo: MemoViewItem) => unknown; releaseRelationCard: (row: HTMLElement) => void; memos: MemoViewItem[] } | null = null;
	if (withProductionCache) {
		const { KnomoView } = await import("../../src/ui/KnomoView");
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
		isMobile: () => focusState.mobile,
		renderCard: renderCard ?? ((row, memo) => {
			cacheView?.getMemoCardPreview(memo);
			const card = row.createEl("article", { cls: "knomo-card", attr: { "data-memo-id": memo.id } });
			card.createEl("button", { cls: "knomo-card-menu", text: "menu" });
			card.createDiv({ cls: "knomo-card-content", text: memo.contentSnapshot });
			cards?.observe(card, memo);
			return card;
		}), releaseCard: row => cacheView?.releaseRelationCard(row) });
	const { KnomoView } = await import("../../src/ui/KnomoView");
	const previewView = Object.assign(Object.create(KnomoView.prototype), { catalogReadService: read,
		containerEl: host, rootEl: host, relationsPage: page, closeCardMenu: () => {},
		cardFlowEl: withPreviews ? host.createDiv({ cls: "knomo-card-flow" }) : null, trashViewClosed: false,
		openMemoRelations: (handle: Parameters<typeof page.open>[0], trigger: HTMLElement, focusVisible: boolean) => page.open(handle, trigger, focusVisible) });
	// 使用真实视图接线，覆盖原先固定写入主卡片流顶部的状态回调。
	const cards: InstanceType<typeof MemoRelationCards> | null = withPreviews ? previewView.ensureRelationCards() : null;
	if (cacheView) Object.assign(cacheView, { relationsPage: page, relationCards: cards });
	return { dom, win, host, page, read, catalog, seed, errors, actions, cards, previewView, focusState, bodyReads: () => bodyReads,
		cache, cacheView, cacheSize: () => (cache as unknown as { entries: Map<string, unknown> }).entries.size,
		memo: async (handle: Parameters<typeof read.readMemoItems>[0][number]) => toCatalogMemoView((await read.readMemoItems([handle]))[0]),
		close: () => { cards?.dispose(); page.dispose(); read.relations.dispose(); dom.window.close(); } };
}

export const settle = () => new Promise(resolve => setTimeout(resolve, 80));

import assert from "node:assert/strict";
import test from "node:test";
import type { MemoViewItem } from "../src/types/memoView";
import type { CatalogMemoCountResult } from "../src/types/catalogView";
import type { RecordStatsSearchFilter, SearchDateFilter } from "../src/ui/viewFilters";
import type { MobileSearchPage } from "../src/ui/MobileSearchController";
import { createCatalogCapabilities } from "../src/services/MemoCapabilityModel";
import { createMobilePopupFixture } from "./helpers/mobilePopupFixture";

test("筛选摘要在相同范围内原位更新，不撤下头部或移动已有卡片", async () => {
	const h = await createMobilePopupFixture();
	const { syncKnomoCardFlowHeaders } = await import("../src/ui/KnomoFeed");
	try {
		for (const relationCount of [false, true]) {
			const root = h.root.createDiv();
			const render = (text: string) => syncKnomoCardFlowHeaders(root, [
				{ type: "summary", text, relationCount },
			], `filter:${relationCount}`);
			const summary = render("Filtered: 1 Memo")[0];
			const card = root.createEl("article", { cls: "knomo-card" });
			const observer = new h.win.MutationObserver(() => {});
			observer.observe(root, { childList: true, subtree: true });
			for (const text of ["Filtered: 1 Memo", "Filtered: 2 Memos"]) {
				assert.equal(render(text)[0], summary);
				assert.equal(summary.textContent, text);
				assert.deepEqual(Array.from(root.children), [summary, card]);
				assert.ok(!observer.takeRecords().some(record => Array.from(record.removedNodes).includes(summary)));
			}
			observer.disconnect();
		}
	} finally { h.close(); }
});

test("桌面被引用筛选重查期间保留已提交摘要，内部旧计数立即失效", async () => {
	const h = await createMobilePopupFixture();
	const { KnomoView } = await import("../src/ui/KnomoView");
	const { KnomoViewStateController } = await import("../src/ui/KnomoViewStateController");
	try {
		const state = new KnomoViewStateController();
		state.recordStatsSearchFilter = { type: "referenced", startDate: "2026-10-01", endDateExclusive: "2026-11-01" };
		const summary = h.root.createDiv({ cls: "knomo-relation-result-count", text: "Referenced: 1 Memo" });
		const card = h.root.createEl("article", { cls: "knomo-card" });
		let queries = 0;
		const view = Object.assign(Object.create(KnomoView.prototype), {
			viewStateController: state, cardFlowEl: h.root, trashViewClosed: false,
			catalogStatus: {}, catalogDesktopTotalCount: 1, catalogDesktopCountPresentation: { count: 1 },
			invalidateRecordStats: () => {}, recordStatsViewStateController: { clearRendered: () => {} },
			cancelCatalogDesktopCount: () => {}, cancelCatalogDesktopQuery: () => {},
			refreshCatalogActiveQuery: () => { queries++; },
		});
		view.onMemoRelationsChanged();
		assert.equal(queries, 1);
		assert.equal(view.catalogDesktopTotalCount, null);
		assert.equal(view.getCatalogPresentationTotalCount(), null);
		assert.equal(summary.parentElement, h.root, "等待当前查询时不能让摘要消失并压缩列表高度");
		assert.equal(card.previousElementSibling, summary);
	} finally { h.close(); }
});

test("移动筛选与搜索在保存和同结果重查期间保留摘要、正文、图片与滚动", async () => {
	const statsFilters: RecordStatsSearchFilter[] = [
		{ type: "day", date: "2026-10-29" }, { type: "month", month: "2026-10" },
		...["range", "with-tag", "no-tag", "with-image", "references", "referenced"].map(type => ({
			type, startDate: "2026-10-01", endDateExclusive: "2026-11-01",
		} as RecordStatsSearchFilter)),
		{ type: "tag", startDate: "2026-10-01", endDateExclusive: "2026-11-01", tagKey: "keep", tagLabel: "keep" },
		{ type: "hour", startDate: "2026-10-01", endDateExclusive: "2026-11-01", hour: 9 },
		{ type: "max-daily-notes", dates: ["2026-10-29"] }, { type: "max-daily-words", dates: ["2026-10-29"] },
	];
	const cases: Array<{ query?: string; date?: SearchDateFilter; stats?: RecordStatsSearchFilter; things?: boolean }> = [
		{ query: "memo" }, ...["week", "month", "last-7", "last-30", "last-week", "last-month"].map(date => ({ date: date as SearchDateFilter })),
		...statsFilters.map(stats => ({ stats })), { query: "memo", things: true },
		{ query: "memo", date: "month", stats: statsFilters.find(filter => filter.type === "referenced") },
	];
	for (const scenario of cases) {
		const h = await searchFixture(scenario);
		try {
			const root = h.controller.results!;
			const summary = root.querySelector(".knomo-search-result-count")!;
			const card = root.querySelector(".knomo-card")!;
			const image = card.querySelector("img");
			root.scrollTop = 320;
			h.controller.applyMemoChanges(new Map([[h.memo.id, h.memo]]), [], true);
			assert.equal(root.querySelector(".knomo-search-result-count"), summary, JSON.stringify(scenario));
			const gate = deferred<MobileSearchPage>();
			h.setLoad(() => gate.promise);
			const refreshing = h.controller.refreshAppliedResults();
			try {
				assert.equal(root.querySelector(".knomo-search-result-count"), summary, "后台重查不能先移除摘要");
				assert.equal(root.querySelector(".knomo-card"), card);
			} finally { gate.resolve(h.page()); await refreshing; }
			assert.equal(root.querySelector(".knomo-search-result-count"), summary);
			assert.equal(root.querySelector(".knomo-card"), card);
			assert.equal(card.querySelector("img"), image);
			assert.equal(root.scrollTop, 320);
		} finally { h.close(); }
	}
});

test("移动被引用多页查询等待新计数时保留摘要，计数不可用时清除旧数量", async () => {
	for (const complete of [true, false]) {
		const countGate = deferred<CatalogMemoCountResult>(), countStarted = deferred<void>();
		const h = await searchFixture({ stats: { type: "referenced", startDate: "2026-10-01", endDateExclusive: "2026-11-01" } }, {
			countRemoteResults: async () => { countStarted.resolve(); return countGate.promise; },
		});
		const countResult = { count: complete ? 2 : null, complete, catalogRevision: 1, coverage: h.page().coverage };
		try {
			const root = h.controller.results!, summary = root.querySelector(".knomo-search-result-count"), card = root.querySelector(".knomo-card");
			const page = h.page();
			page.nextCursor = { catalog: { catalogRevision: 1, createdAtKey: "next", observationKey: "next" }, relationsVersion: 1 };
			h.setLoad(async () => page);
			await h.controller.refreshAppliedResults(); await countStarted.promise;
			assert.equal(h.controller.getDisplayedCount(), null);
			assert.equal(root.querySelector(".knomo-search-result-count"), summary);
			countGate.resolve(countResult); await new Promise<void>(resolve => setImmediate(resolve));
			assert.equal(root.querySelector(".knomo-search-result-count"), complete ? summary : null);
			assert.equal(h.controller.getDisplayedCount(), complete ? 2 : null);
			assert.equal(root.querySelector(".knomo-card"), card);
		} finally { countGate.resolve(countResult); h.close(); }
	}
});

test("移动被引用查询确认新成员或移除引用时更新结果，同时保留未变卡片", async () => {
	const h = await searchFixture({ stats: { type: "referenced", startDate: "2026-10-01", endDateExclusive: "2026-11-01" } });
	try {
		const root = h.controller.results!, card = root.querySelector(".knomo-card");
		const page = h.page();
		page.items.push({ ...h.memo, id: "new-target", contentHash: "new", contentSnapshot: "new target" });
		h.setLoad(async () => page);
		await h.controller.refreshAppliedResults();
		assert.equal(h.controller.getDisplayedCount(), 2);
		assert.equal(root.querySelector(".knomo-card"), card);
		assert.equal(root.querySelectorAll(".knomo-card").length, 2);
		page.items = []; await h.controller.refreshAppliedResults();
		assert.equal(h.controller.getDisplayedCount(), 0);
		assert.equal(root.querySelectorAll(".knomo-card").length, 0);
		assert.equal(root.querySelector(".knomo-search-result-count"), null);
		assert.ok(root.querySelector(".knomo-mobile-search-empty"));
	} finally { h.close(); }
});

async function searchFixture(
	scenario: { query?: string; date?: SearchDateFilter; stats?: RecordStatsSearchFilter; things?: boolean },
	overrides: Partial<ConstructorParameters<typeof import("../src/ui/MobileSearchController").MobileSearchController>[0]> = {},
) {
	const h = await createMobilePopupFixture();
	const { MobileSearchController } = await import("../src/ui/MobileSearchController");
	Object.assign(h.win.HTMLElement.prototype, {
		find(this: HTMLElement, selector: string) { return this.querySelector(selector); },
		findAll(this: HTMLElement, selector: string) { return Array.from(this.querySelectorAll(selector)); },
	});
	const memo: MemoViewItem = { id: "kept", createdAt: "2026-10-29T09:00", updatedAt: "", contentHash: "kept",
		contentSnapshot: "memo #keep", status: "active", tags: ["keep"], links: [], images: [],
		dailyRef: { path: "Daily/2026-10-29.md", heading: null, lineNumberHint: 1 } };
	const coverage = { kind: "complete" as const, coveredFromDate: null, pendingFileCount: 0, coveredFileCount: 1, totalFileCount: 1 };
	const page = (): MobileSearchPage => ({ items: [memo], catalogRevision: 1, nextCursor: null, coverage,
		readState: "ready", invalidated: false, degraded: false,
		status: { content: "ready", catalog: "complete", projection: "ready", relations: { complete: true, failed: false } },
		lifecycle: { state: "ready", persistent: true, writable: true, reason: null }, capabilities: createCatalogCapabilities(coverage) });
	let load = async () => page();
	const controller = new MobileSearchController({
		batchSize: 20, debounceMs: 10, getWindow: () => h.win as unknown as Window, getDocument: () => h.win.document,
		getRootEl: () => h.root, isMobileLayout: () => true,
		getThingsContext: () => scenario.things ? { activeNav: "things", activeTag: "keep", activeTagKey: "keep" } : undefined,
		registerDomEvent: () => {}, createHiddenText: (_container, name) => name, filterMemos: memos => [...memos],
		renderMemoCard: (container, item) => {
			const card = container.createEl("article", { cls: "knomo-card", attr: { "data-memo-id": item.id } });
			card.createDiv({ cls: "knomo-card-content", text: item.contentSnapshot });
			card.createEl("img", { attr: { src: "https://example.test/image.png" } });
			return card;
		},
		clearMarkdown: () => {}, clearImages: () => {}, setCardFlowPaused: () => {}, closeSurroundingChrome: () => {},
		closeCardMenu: () => {}, syncRootState: () => {}, getCardFlowScrollTop: () => 0, restoreCardFlowScrollTop: () => {},
		restoreElementScrollTop: (element, scrollTop) => { if (element) element.scrollTop = scrollTop ?? 0; },
		handleMarkdownInternalLinkClick: () => {}, handleTaskCheckboxClick: () => {}, handleTaskCheckboxChange: () => {},
		loadRemoteResults: () => load(),
		...overrides,
	});
	controller.searchQuery = scenario.query ?? "";
	controller.searchDateFilter = scenario.date ?? null;
	controller.searchRecordStatsFilter = scenario.stats ?? null;
	controller.openPage({ focusInput: false });
	await new Promise<void>(resolve => setImmediate(resolve));
	return { controller, memo, page, setLoad: (next: () => Promise<MobileSearchPage>) => { load = next; },
		close: () => { controller.removePage(); h.close(); } };
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(complete => { resolve = complete; });
	return { promise, resolve };
}

import assert from "node:assert/strict";
import test from "node:test";
import type { MemoViewItem } from "../src/types/memoView";
import type { CatalogMemoCountResult } from "../src/types/catalogView";
import type { RecordStatsSearchFilter, SearchDateFilter } from "../src/ui/viewFilters";
import type { MobileSearchPage } from "../src/ui/MobileSearchController";
import { createCatalogCapabilities } from "../src/services/MemoCapabilityModel";
import { createMobilePopupFixture } from "./helpers/mobilePopupFixture";

test("首次切入被引用固定筛选不展示上一范围的卡片与计数，重复选择保留已确认结果", async () => {
	const h = await createMobilePopupFixture();
	const { KnomoView } = await import("../src/ui/KnomoView");
	const { KnomoViewStateController } = await import("../src/ui/KnomoViewStateController");
	try {
		const state = new KnomoViewStateController(), oldMemo = { id: "unconfirmed" };
		let renders = 0, queries = 0;
		const view = Object.assign(Object.create(KnomoView.prototype), {
			viewStateController: state, memos: [oldMemo], hasCommittedCatalogDesktopQuery: true,
			catalogDesktopTotalCount: 10, catalogDesktopCountPresentation: { count: 10 },
			rememberHistoryBrowsePosition: () => {}, clearSearchDebounce: () => {}, getCardFlowViewStateKey: () => "old",
			applyViewStateTransitionEffects: () => {}, getCardFlowChangeIntent: () => "view-scope-change",
			syncRootState: () => {}, renderScopeState: () => {}, syncSearchInputs: () => {},
			renderFilteredListState: () => {
				renders++; assert.deepEqual(view.memos, []);
				assert.equal(view.hasCommittedCatalogDesktopQuery, false);
				assert.equal(view.catalogDesktopTotalCount, null); assert.equal(view.catalogDesktopCountPresentation, null);
				assert.equal(view.initialCatalogQueryPending, true);
			},
			refreshCatalogActiveQuery: () => { queries++; },
		});
		view.setScope("referenced");
		assert.equal(renders, 1); assert.equal(queries, 1);
		view.memos = [oldMemo]; view.hasCommittedCatalogDesktopQuery = true;
		view.setScope("referenced");
		assert.equal(renders, 1); assert.equal(queries, 1);
		assert.deepEqual(view.memos, [oldMemo]);
	} finally { h.close(); }
});

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

for (const scope of [false, true]) test(`桌面被引用${scope ? "固定筛选" : "钻取"}重查期间保留已提交摘要，内部旧计数立即失效`, async () => {
	const h = await createMobilePopupFixture();
	const { KnomoView } = await import("../src/ui/KnomoView");
	const { KnomoViewStateController } = await import("../src/ui/KnomoViewStateController");
	try {
		const state = new KnomoViewStateController();
		if (scope) state.scopeFilter = "referenced";
		else state.recordStatsSearchFilter = { type: "referenced", startDate: "2026-10-01", endDateExclusive: "2026-11-01" };
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
	const cases: Array<{ query?: string; date?: SearchDateFilter; stats?: RecordStatsSearchFilter; things?: boolean; referenced?: boolean }> = [
		{ query: "memo" }, ...["week", "month", "last-7", "last-30", "last-week", "last-month"].map(date => ({ date: date as SearchDateFilter })),
		...statsFilters.map(stats => ({ stats })), { query: "memo", things: true },
		{ query: "memo", date: "month", stats: statsFilters.find(filter => filter.type === "referenced") },
		{ referenced: true }, { referenced: true, query: "memo", date: "month" },
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

test("移动已有成员实际编辑后在查询和计数接续期间保留原摘要", async () => {
	const cases = [
		{ query: "memo" }, { query: "memo", things: true }, { date: "month" as const },
		{ stats: { type: "tag" as const, startDate: "2026-10-01", endDateExclusive: "2026-11-01", tagKey: "keep", tagLabel: "keep" } },
		{ referenced: true },
	];
	for (const scenario of cases) {
		const countGate = deferred<CatalogMemoCountResult>(), started = deferred<void>();
		const h = await searchFixture(scenario, { countRemoteResults: async () => { started.resolve(); return countGate.promise; } });
		const countResult = { count: 7, complete: true, catalogRevision: 1, coverage: h.page().coverage };
		try {
			const root = h.controller.results!, summary = root.querySelector(".knomo-search-result-count")!;
			const observer = new root.ownerDocument.defaultView!.MutationObserver(() => {});
			observer.observe(root, { childList: true, subtree: true });
			const edited = { ...h.memo, contentHash: "changed", contentSnapshot: "memo changed #keep" };
			h.controller.applyMemoChanges(new Map([[h.memo.id, edited]]));
			assert.equal(h.controller.getDisplayedCount(), null);
			assert.equal(root.querySelector(".knomo-search-result-count"), summary, JSON.stringify(scenario));
			assert.match(root.querySelector(".knomo-card")!.textContent!, /memo changed/);
			const pageGate = deferred<MobileSearchPage>(); h.setLoad(() => pageGate.promise);
			const refreshing = h.controller.refreshAppliedResults();
			assert.equal(root.querySelector(".knomo-search-result-count"), summary);
			const page = h.page(); page.items = [edited];
			page.nextCursor = { catalog: { catalogRevision: 1, createdAtKey: "next", observationKey: "next" } };
			pageGate.resolve(page); await refreshing; await started.promise;
			assert.equal(root.querySelector(".knomo-search-result-count"), summary);
			countGate.resolve(countResult); await new Promise<void>(resolve => setImmediate(resolve));
			assert.equal(h.controller.getDisplayedCount(), 7);
			assert.equal(root.querySelector(".knomo-search-result-count"), summary);
			assert.match(summary.textContent!, /7/);
			assert.ok(!observer.takeRecords().some(record => Array.from(record.removedNodes).includes(summary)));
			observer.disconnect();
		} finally { countGate.resolve(countResult); h.close(); }
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
			assert.equal(root.querySelector(".knomo-search-result-count"), summary);
			if (!complete) assert.match(summary!.textContent!, /—/u);
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

test("移动计数失败、不完整和配置失效清除旧数字，旧计数收尾不能清除新摘要", async t => {
	for (const mode of ["failed", "incomplete", "stale", "configuration"] as const) await t.test(mode, async () => {
		const gate = deferred<CatalogMemoCountResult>(), started = deferred<void>();
		let reads = 0;
		const h = await searchFixture({ query: "memo" }, { countRemoteResults: async () => {
			reads++; if (reads > 1) return { count: 9, complete: true, catalogRevision: 1, coverage: h.page().coverage };
			started.resolve(); if (mode === "failed") { await gate.promise; throw new Error("count unavailable"); }
			return gate.promise;
		} });
		const result = { count: null, complete: false, catalogRevision: 1, coverage: h.page().coverage };
		if (mode === "failed") t.mock.method(console, "warn", () => {});
		try {
			const root = h.controller.results!, summary = root.querySelector(".knomo-search-result-count");
			const page = h.page(); page.nextCursor = { catalog: { catalogRevision: 1, createdAtKey: "next", observationKey: "next" } };
			h.setLoad(async () => page); await h.controller.refreshAppliedResults(); await started.promise;
			assert.equal(root.querySelector(".knomo-search-result-count"), summary);
			if (mode === "stale") {
				await h.controller.refreshAppliedResults(); await new Promise(resolve => setTimeout(resolve, 5));
				assert.equal(h.controller.getDisplayedCount(), 9);
			} else if (mode === "configuration") {
				h.controller.updateCatalogProgress({ ...page.coverage, kind: "partial", configurationComplete: false });
			}
			gate.resolve(result); await new Promise<void>(resolve => setImmediate(resolve));
			assert.equal(root.querySelector(".knomo-search-result-count"), summary);
			if (mode !== "stale") assert.match(summary!.textContent!, /—/u);
		} finally { gate.resolve(result); h.close(); }
	});
});

test("移动删除最后已加载成员时不以窗口长度当总数，新范围和确认零结果正确替换摘要", async () => {
	const gate = deferred<CatalogMemoCountResult>(), started = deferred<void>();
	const h = await searchFixture({ query: "memo" }, { countRemoteResults: async () => { started.resolve(); return gate.promise; } });
	const count = { count: 8, complete: true, catalogRevision: 1, coverage: h.page().coverage };
	try {
		const root = h.controller.results!, summary = root.querySelector(".knomo-search-result-count")!;
		const page = h.page(); page.nextCursor = { catalog: { catalogRevision: 1, createdAtKey: "next", observationKey: "next" } };
		h.setLoad(async () => page); await h.controller.refreshAppliedResults(); await started.promise;
		gate.resolve(count); await new Promise<void>(resolve => setImmediate(resolve));
		h.controller.applyMemoChanges(new Map([[h.memo.id, null]]));
		assert.equal(h.controller.getDisplayedCount(), null);
		assert.equal(root.querySelector(".knomo-search-result-count"), summary);
		assert.match(summary.textContent!, /8/);
		const empty = h.page(); empty.items = []; h.setLoad(async () => empty);
		await h.controller.refreshAppliedResults();
		assert.equal(h.controller.getDisplayedCount(), 0);
		assert.equal(root.querySelector(".knomo-search-result-count"), null);
		assert.ok(root.querySelector(".knomo-mobile-search-empty"));
		h.controller.searchQuery = "new scope"; h.setLoad(async () => h.page());
		await h.controller.refreshAppliedResults();
		const current = root.querySelector(".knomo-search-result-count")!;
		assert.match(current.textContent!, /new scope/);
		assert.doesNotMatch(current.textContent!, /8/);
	} finally { gate.resolve(count); h.close(); }
});

test("受阻状态下删除最后已加载成员清除旧摘要", async () => {
	let blocked = false;
	const h = await searchFixture({ query: "memo" }, {
		getResultStatus: () => ({ headers: blocked ? [{ type: "summary", text: "unavailable" }] : [], complete: !blocked, blocked }),
	});
	try {
		const root = h.controller.results!;
		assert.ok(root.querySelector(".knomo-search-result-count"));
		blocked = true;
		h.controller.applyMemoChanges(new Map([[h.memo.id, null]]));
		assert.equal(h.controller.getDisplayedCount(), null);
		assert.equal(root.querySelectorAll(".knomo-card").length, 0);
		assert.equal(root.querySelector(".knomo-search-result-count"), null);
		assert.match(root.querySelector(".knomo-search-result-feedback")!.textContent!, /unavailable/u);
	} finally { h.close(); }
});

async function searchFixture(
	scenario: { query?: string; date?: SearchDateFilter; stats?: RecordStatsSearchFilter; things?: boolean; referenced?: boolean },
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
		getSourceScope: () => scenario.referenced ? "referenced" : "all",
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

test("新范围首批卡片与摘要同批出现，延迟计数只更新数字节点", async t => {
	for (const source of ["search", "things", "referenced"]) for (const outcome of ["ready", "unavailable", "failed"] as const) await t.test(`${source}:${outcome}`, async () => {
		const firstPage = deferred<MobileSearchPage>(), count = deferred<CatalogMemoCountResult>(), started = deferred<void>();
		if (outcome === "failed") t.mock.method(console, "warn", () => {});
		const h = await searchFixture({ query: "memo 2026 {{count}}", things: source === "things", referenced: source === "referenced" }, {
			loadRemoteResults: () => firstPage.promise,
			countRemoteResults: async () => { started.resolve(); const result = await count.promise; if (outcome === "failed") throw new Error("count unavailable"); return result; },
		});
		const result = { count: outcome === "ready" ? 12345 : null, complete: outcome === "ready", catalogRevision: 1, coverage: h.page().coverage };
		try {
			const root = h.controller.results!;
			assert.equal(root.querySelector(".knomo-search-result-count"), null);
			const page = h.page(); page.nextCursor = { catalog: { catalogRevision: 1, createdAtKey: "next", observationKey: "next" }, relationsVersion: 1 };
			firstPage.resolve(page); await started.promise;
			const summary = root.querySelector(".knomo-search-result-count")!;
			const card = root.querySelector(".knomo-card")!;
			assert.ok(summary, "第一张卡片出现时摘要必须已经存在");
			assert.ok(card); assert.equal(card.previousElementSibling, summary);
			const fixed = summary.firstChild, slot = summary.querySelector(".knomo-result-summary-count")!;
			assert.ok(slot); assert.equal(slot.getAttribute("data-state"), "pending");
			assert.match(summary.textContent!, /memo 2026 \{\{count\}\}/u);
			count.resolve(result); await new Promise<void>(resolve => setImmediate(resolve));
			assert.equal(root.querySelector(".knomo-search-result-count"), summary);
			assert.equal(summary.firstChild, fixed); assert.equal(summary.querySelector(".knomo-result-summary-count"), slot);
			assert.equal(root.querySelector(".knomo-card"), card);
			assert.equal(slot.getAttribute("data-state"), outcome === "ready" ? "ready" : "unavailable");
			assert.match(slot.textContent!, outcome === "ready" ? /12345/u : /—/u);
		} finally { firstPage.resolve(h.page()); count.resolve(result); h.close(); }
	});
});

test("结果摘要保留固定文字和数字槽，与前置故障提示分别复用，过渡只播放一次", async () => {
	const h = await createMobilePopupFixture();
	const { syncKnomoCardFlowHeaders } = await import("../src/ui/KnomoFeed");
	try {
		const root = h.root.createDiv();
		const summary = { template: "filterSummary.search" as const, params: { query: "2026 {{count}} <b>memo</b>" }, count: null as number | null, pending: true };
		const render = (feedback = false) => syncKnomoCardFlowHeaders(root, [
			...(feedback ? [{ type: "summary" as const, text: "temporarily unavailable", feedback: true }] : []),
			{ type: "result-summary", summary },
		], "same-filter").at(-1)!;
		const element = render(), fixed = element.firstChild, slot = element.querySelector(".knomo-result-summary-count")!;
		const card = root.createEl("article", { cls: "knomo-card" });
		assert.equal(element.querySelectorAll('[aria-label="Loading"]').length, 1);
		assert.equal(element.querySelector("b"), null);
		assert.equal(render(true), element); assert.equal(element.firstChild, fixed);
		summary.count = 900; summary.pending = false; render();
		assert.equal(element.querySelector(".knomo-result-summary-count"), slot);
		assert.equal(element.firstChild, fixed); assert.equal(card.previousElementSibling, element);
		assert.equal(slot.getAttribute("aria-label"), "900"); assert.ok(slot.classList.contains("is-revealing"));
		const ended = new h.win.Event("animationend"); Object.assign(ended, { animationName: "knomo-result-count-reveal" }); slot.dispatchEvent(ended);
		summary.count = null; summary.pending = true; render();
		summary.count = 901; summary.pending = false; render();
		assert.ok(!slot.classList.contains("is-revealing"), "同一结果的后续刷新不重复播放入场");
		assert.match(element.textContent!, /2026 \{\{count\}\} <b>memo<\/b>/u);
		const immediate = syncKnomoCardFlowHeaders(root, [{ type: "result-summary", summary }], "new-filter")[0]!;
		assert.ok(!immediate.querySelector(".is-revealing"), "首屏已有真实数量时直接显示");
	} finally { h.close(); }
});

test("移动 A→B→A 后第一轮 A 的成功或失败都不能覆盖第二轮摘要", async t => {
	for (const failed of [false, true]) await t.test(String(failed), async () => {
		const gate = deferred<CatalogMemoCountResult>(), started = deferred<void>(); let reads = 0;
		const h = await searchFixture({ query: "A" }, { countRemoteResults: async () => {
			if (++reads > 1) return { count: 9, complete: true, catalogRevision: 1, coverage: h.page().coverage };
			started.resolve(); const result = await gate.promise; if (failed) throw new Error("old A failed"); return result;
		} });
		const result = { count: 999, complete: true, catalogRevision: 1, coverage: h.page().coverage };
		try {
			const page = h.page(); page.nextCursor = { catalog: { catalogRevision: 1, createdAtKey: "next", observationKey: "next" } };
			h.setLoad(async () => page); await h.controller.refreshAppliedResults(); await started.promise;
			h.setLoad(async () => h.page()); h.controller.searchQuery = "B"; await new Promise<void>(resolve => setImmediate(resolve));
			h.setLoad(async () => page); h.controller.searchQuery = "A"; await new Promise(resolve => setTimeout(resolve, 10));
			assert.equal(h.controller.getDisplayedCount(), 9);
			const root = h.controller.results!, summary = root.querySelector(".knomo-search-result-count"), card = root.querySelector(".knomo-card");
			gate.resolve(result); await new Promise<void>(resolve => setImmediate(resolve));
			assert.equal(h.controller.getDisplayedCount(), 9); assert.equal(root.querySelector(".knomo-search-result-count"), summary);
			assert.equal(root.querySelector(".knomo-card"), card); assert.doesNotMatch(summary!.textContent!, /999/u);
			h.controller.session.updateDraft("unsubmitted B"); h.controller.renderResults("content-change", true, true);
			assert.equal(root.querySelector(".knomo-search-result-count"), summary); assert.match(summary!.textContent!, /“A”/u);
		} finally { gate.resolve(result); h.close(); }
	});
});

test("组合筛选确认零结果只显示现有空态，空搜索不生成计数摘要", async () => {
	const h = await searchFixture({ query: "memo", date: "month", things: true });
	try {
		const page = h.page(); page.items = []; h.setLoad(async () => page); await h.controller.refreshAppliedResults();
		const root = h.controller.results!;
		assert.equal(root.querySelectorAll(".knomo-mobile-search-empty").length, 1);
		assert.match(root.querySelector(".knomo-mobile-search-empty")!.textContent!, /0 Memos/u);
		assert.equal(root.querySelector(".knomo-search-result-count"), null);
	} finally { h.close(); }
	const empty = await searchFixture({});
	try { assert.equal(empty.controller.results!.querySelector(".knomo-search-result-count"), null); }
	finally { empty.close(); }
});

test("移动组合首查等待、失败及不完整空切片不显示零条，确认完整空结果后才显示", async t => {
	for (const outcome of ["ready", "empty", "partial", "failed"] as const) await t.test(outcome, async () => {
		const pending = deferred<MobileSearchPage>();
		let complete = true;
		const h = await searchFixture({ query: "memo", date: "month", things: true }, {
			loadRemoteResults: async () => {
				const page = await pending.promise;
				if (outcome === "failed") throw new Error("Combination unavailable");
				return page;
			},
			onResultsAccepted: page => { complete = page.coverage.kind === "complete"; },
			getResultStatus: () => ({ complete, blocked: false,
				headers: complete ? [] : [{ type: "summary", text: "Coverage incomplete" }] }),
		});
		try {
			const root = h.controller.results!;
			assert.equal(root.querySelector(".knomo-mobile-search-empty"), null);
			const page = h.page();
			if (outcome !== "ready") page.items = [];
			if (outcome === "partial") page.coverage = { ...page.coverage, kind: "partial", pendingFileCount: 1 };
			pending.resolve(page);
			await new Promise<void>(resolve => setImmediate(resolve));
			if (outcome === "empty") assert.match(root.querySelector(".knomo-mobile-search-empty")!.textContent!, /0 Memos/u);
			else assert.equal(root.querySelector(".knomo-mobile-search-empty"), null);
			if (outcome === "partial") assert.match(root.textContent!, /Coverage incomplete/u);
			if (outcome === "failed") assert.match(root.textContent!, /Could not load this view/u);
		} finally { pending.resolve(h.page()); h.close(); }
	});
});

test("移动组合空窗口仍有下一页时保留加载入口，数量确认为零才显示空态，失效后撤下结论", async t => {
	for (const total of [null, 0]) await t.test(String(total), async () => {
		const pending = deferred<MobileSearchPage>(), count = deferred<CatalogMemoCountResult>(), started = deferred<void>();
		const h = await searchFixture({ query: "memo", date: "month", things: true }, {
			loadRemoteResults: () => pending.promise,
			countRemoteResults: async () => { started.resolve(); return count.promise; },
		});
		const page = h.page();
		page.items = [];
		page.nextCursor = { catalog: { catalogRevision: 1, createdAtKey: "next", observationKey: "next" } };
		const result = { count: total, complete: total !== null, catalogRevision: 1, coverage: page.coverage };
		try {
			pending.resolve(page);
			await started.promise;
			const root = h.controller.results!;
			assert.equal(root.querySelector(".knomo-mobile-search-empty"), null);
			assert.equal(root.querySelector(".knomo-result-summary-count")!.getAttribute("data-state"), "pending");
			assert.ok(root.querySelector(".knomo-mobile-search-more"));
			count.resolve(result);
			await new Promise<void>(resolve => setImmediate(resolve));
			if (total === null) {
				assert.equal(root.querySelector(".knomo-mobile-search-empty"), null);
				assert.equal(root.querySelector(".knomo-result-summary-count")!.getAttribute("data-state"), "unavailable");
			} else {
				assert.equal(root.querySelector(".knomo-search-result-count"), null);
				assert.match(root.querySelector(".knomo-mobile-search-empty")!.textContent!, /0 Memos/u);
			}
			page.nextCursor = null;
			await h.controller.refreshAppliedResults();
			assert.equal(root.querySelector(".knomo-search-result-count"), null);
			assert.match(root.querySelector(".knomo-mobile-search-empty")!.textContent!, /0 Memos/u);
			h.controller.updateCatalogProgress({ ...page.coverage, coveredFileCount: 2, totalFileCount: 2 });
			h.controller.renderResults();
			assert.equal(root.querySelector(".knomo-mobile-search-empty"), null);
			assert.equal(root.querySelector(".knomo-result-summary-count")!.getAttribute("data-state"), "unavailable");
			assert.ok(root.querySelector(".knomo-mobile-search-more"));
		} finally { pending.resolve(page); count.resolve(result); h.close(); }
	});
});

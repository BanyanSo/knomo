import assert from "node:assert/strict";
import test from "node:test";
import type { CatalogFeatureQuery } from "../src/types/catalogView";
import { DateChangeWatcher } from "../src/ui/DateChangeWatcher";
import { KnomoViewStateController } from "../src/ui/KnomoViewStateController";
import { formatTimeBuoyDate } from "../src/utils/timeBuoyDate";
import { ensureObsidianStub } from "./helpers/obsidianStub";

const contexts = ["default", "things", "review", "scope", "date", "tag", "time-buoy"] as const;
type PageContext = typeof contexts[number];

for (const context of contexts) {
	test(`跨日 ${context} 页面只刷新一次当前查询并保留日期副作用`, async () => {
		for (const enabled of [false, true]) for (const mobileOpen of [false, true]) {
			const h = await createHarness(context, enabled, mobileOpen);
			try {
				h.view.handleLocalDateChange();
				await settle();
				assert.equal(h.queries.length, mobileOpen ? 1 : 0, `${context}/${enabled}: 移动查询次数`);
				assert.equal(h.effects.normal, !mobileOpen && (context === "review" || context === "scope" || context === "date" || (context === "default" && enabled)) ? 1 : 0);
				assert.equal(h.effects.confirmed, context === "default" && enabled ? 1 : 0);
				assert.equal(h.effects.reunion, h.effects.confirmed);
				assert.equal(h.effects.initial, context === "time-buoy" ? 1 : 0);
				assert.equal(h.effects.today, enabled && context !== "default" && context !== "time-buoy" ? 1 : 0);
				assert.equal(h.effects.ui, 1);
				assert.equal(h.timers.size, 1);
				assert.equal(h.view.lastKnownLocalDate, formatTimeBuoyDate(new Date()));
			} finally { h.close(); }
		}
	});
}

test("相对日期跨日重算，固定日期保持原值；同日唤醒只重绘和续订单一日期计时器", async context => {
	context.mock.timers.enable({ apis: ["Date"], now: new Date(2026, 9, 19, 12).getTime() });
	for (const relative of [false, true]) {
		const h = await createHarness("default", true, true);
		try {
			h.search.searchDateFilter = relative ? "last-7" : null;
			h.search.session.updateDraft(relative ? "memo" : "2026-10-10 memo");
			h.search.session.submit();
			await h.search.refreshAppliedResults();
			const previous = h.queries.at(-1)!.searchDate;
			h.view.lastKnownLocalDate = formatTimeBuoyDate(new Date());
			context.mock.timers.tick(24 * 60 * 60 * 1000);
			h.queries.length = 0;
			h.view.handleLocalDateChange();
			await settle();
			assert.equal(h.queries.length, 1);
			if (relative) assert.notDeepEqual(h.queries[0].searchDate, previous);
			else assert.deepEqual(h.queries[0].searchDate, previous);
			h.view.handleLocalDateChange();
			await settle();
			assert.equal(h.queries.length, 1);
			assert.equal(h.effects.cards, 1);
			assert.equal(h.timers.size, 1);
		} finally { h.close(); }
	}
});

test("跨日请求在关闭后不提交迟到结果，多 View 的请求和日期计时器独立", async () => {
	const first = await createHarness("default", true, true);
	const second = await createHarness("default", true, true);
	let release!: () => void;
	first.view.getCatalogReadService = () => ({ query: () => new Promise(resolve => { release = () => resolve(first.page()); }) });
	try {
		first.view.handleLocalDateChange();
		second.view.handleLocalDateChange();
		await settle();
		first.search.isOpen = false;
		release();
		await settle();
		assert.equal(first.search.session.result, null);
		assert.equal(second.search.session.requestStatus, "ready");
		assert.equal(first.timers.size, 1);
		assert.equal(second.timers.size, 1);
		first.view.stopDateChangeWatcher();
		assert.equal(first.timers.size, 0);
		assert.equal(second.timers.size, 1);
	} finally { first.close(); second.close(); }
});

async function createHarness(context: PageContext, enabled: boolean, mobileOpen: boolean) {
	await ensureObsidianStub();
	const { KnomoView } = await import("../src/ui/KnomoView");
	const view = Object.create(KnomoView.prototype);
	const state = new KnomoViewStateController();
	if (context === "things" || context === "review" || context === "time-buoy") state.activeNav = context;
	if (context === "scope") state.scopeFilter = "week";
	if (context === "date") state.searchDateFilter = "last-7";
	if (context === "tag") state.activeTagKey = "project";
	const queries: CatalogFeatureQuery[] = [];
	const timers = new Map<number, () => void>();
	let nextTimer = 0;
	const effects = { normal: 0, confirmed: 0, reunion: 0, initial: 0, today: 0, ui: 0, cards: 0 };
	const coverage = { kind: "complete", configurationComplete: true, coveredFromDate: null, pendingFileCount: 0, coveredFileCount: 1, totalFileCount: 1 };
	const page = () => ({ items: [], nextCursor: null, catalogRevision: 1, coverage,
		readState: "ready", invalidated: false, status: { content: "ready", catalog: "complete", projection: "ready" } });
	Object.assign(view, {
		viewStateController: state, trashViewClosed: false, lastKnownLocalDate: "0001-01-01", memos: [],
		catalogCoverage: coverage, catalogRevision: 1, containerEl: { win: { setTimeout, clearTimeout } },
		settingsService: { getSettings: () => ({ timeBuoyEnabled: enabled }) }, renderedTimeBuoyEnabled: enabled,
		reconcileConfirmedCatalog: async () => { effects.confirmed++; },
		refreshRandomReunionBatch: async () => { effects.reunion++; },
		timeBuoyViewController: { loadInitial: async () => { effects.initial++; }, loadTodayOnly: async () => { effects.today++; } },
		reloadCurrentCatalogQuery: async () => { effects.normal++; }, reloadMemos: async () => { effects.normal++; },
		waitForAllMemosLoading: async () => {}, renderUiState: () => { effects.ui++; }, renderCardFlow: () => { effects.cards++; },
		syncRecordStatsSource: () => {}, retainMemoCardPreviews: () => {},
		getCatalogReadService: () => ({ query: async (query: CatalogFeatureQuery) => { queries.push(query); return page(); } }),
	});
	const search = view.createMobileSearchController();
	Object.assign(search, { renderResults: () => {}, syncControls: () => {} });
	search.searchQuery = "memo";
	search.isOpen = mobileOpen;
	view.mobileSearchController = search;
	view.dateChangeWatcher = new DateChangeWatcher({ getNow: () => new Date(),
		scheduleTask: callback => { timers.set(++nextTimer, callback); return nextTimer; }, cancelTask: id => { timers.delete(id); } });
	return { view, search, queries, timers, effects, page,
		close() { search.isOpen = false; view.stopDateChangeWatcher(); } };
}

async function settle(): Promise<void> { await new Promise(resolve => setImmediate(resolve)); }

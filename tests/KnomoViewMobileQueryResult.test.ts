import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import type { CatalogFeatureQuery, CatalogMemoCountResult, CatalogMemoPage } from "../src/types/catalogView";
import type { CatalogQueryFilter } from "../src/types/catalog";
import { createCatalogCapabilities, createResolvedMemoCapabilities } from "../src/services/MemoCapabilityModel";
import { CatalogQueryCancelledError } from "../src/services/MemoCatalogStore";
import { KnomoViewStateController } from "../src/ui/KnomoViewStateController";
import { ensureObsidianStub } from "./helpers/obsidianStub";

test("A04 baseline：首屏 50 条、实际 cursor 分页及延迟 count 的读取、接受和渲染次数", async context => {
	const h = await createHarness();
	try {
		await h.search.refreshAppliedResults();
		assert.equal(h.search.getDisplayedMemos().length, 50);
		assert.equal(h.queries.length, 1);
		assert.equal(h.counts(), 0, "首屏不能等待 count 启动或完成");
		assert.equal(h.view.catalogMobileTotalCount, null);
		await h.flushTimers();
		assert.equal(h.counts(), 1);
		h.search.loadMore();
		await settle();
		assert.equal(h.queries.length, 2);
		assert.equal(h.queries[0].limit, 50);
		assert.equal(h.queries[0].cursor, null);
		assert.equal(h.queries[1].cursor, h.cursor);
		assert.equal(h.search.getDisplayedMemos().length, 51);
		assert.equal(new Set(h.search.getDisplayedMemos().map(memo => memo.id)).size, 51, "同文 occurrence 不合并");
		for (const memo of h.search.getDisplayedMemos()) {
			assert.equal(memo.catalog?.observationHandle, h.items.find(item => item.key === memo.id)!.observationHandle);
		}
		h.releaseCount(51);
		await settle();
		assert.equal(h.view.catalogMobileTotalCount, 51);
		assert.deepEqual(h.metrics, { accepted: 2, renders: 4, metadata: 1 });
		context.diagnostic(JSON.stringify({ pages: h.queries.length, counts: h.counts(), ...h.metrics, sharedReadbacks: h.readbacks() }));
	} finally { h.close(); }
});

test("移动生产适配返回本次结果及元数据，Controller 接受 page 不回读共享数组", async () => {
	const h = await createHarness();
	try {
		const result = await h.view.loadCatalogMobileSearchResults({ textTerms: ["memo"] }, true);
		assert.ok(result, "生产读取必须返回可提交的 page");
		assert.equal(result.items.length, 50);
		assert.equal(result.nextCursor, h.cursor);
		assert.equal(result.catalogRevision, 7);
		assert.equal(result.coverage, h.coverage);
		assert.equal(result.status, h.page().status);
		assert.equal(result.lifecycle, h.page().lifecycle);
		assert.equal(result.capabilities, h.page().capabilities);
		assert.equal(result.readState, "ready");
		assert.equal(result.invalidated, false);
		assert.equal(result.degraded, false);
		assert.equal(result.totalCount, null);
		h.setSharedRead(() => assert.fail("接受本次 page 不得读回共享 View.memos"));
		const options = Reflect.get(h.search, "options");
		options.getCatalogRevision = () => 999;
		options.getCoverageKey = () => "unrelated-global-state";
		await h.search.refreshAppliedResults();
		assert.equal(h.search.session.requestStatus, "ready");
		assert.equal(h.search.getDisplayedMemos().length, 50);
		assert.equal(h.search.session.result?.catalogRevision, result.catalogRevision);
		assert.equal(h.search.session.result?.coverageKey, result.coverageKey);
	} finally { h.close(); }
});

for (const invalidation of ["run", "context", "close"] as const) {
	test(`移动 page 在 ${invalidation} 变化后不提交成功结果，保留旧显示快照和 stamp`, async () => {
		const h = await createHarness();
		try {
			await h.search.refreshAppliedResults();
			const previous = h.search.getDisplayedMemos();
			const stamp = h.search.session.result;
			let release!: (page: CatalogMemoPage) => void;
			h.service.query = () => new Promise(resolve => { release = resolve; });
			const pending = h.search.refreshAppliedResults();
			assert.equal(h.search.getDisplayedMemos(), previous);
			if (invalidation === "run") h.view.catalogMobileQueryRun++;
			else if (invalidation === "context") h.view.viewStateController.scopeFilter = "week";
			else h.search.isOpen = false;
			release(h.page()); await pending;
			assert.equal(h.search.getDisplayedMemos(), previous);
			assert.equal(h.search.session.result, stamp);
			assert.equal(h.metrics.accepted, 1);
		} finally { h.close(); }
	});
}

test("移动生产读取对过期 run、失效页、覆盖变化和不可用存储明确失败", async () => {
	for (const failure of ["run", "invalidated", "coverage", "storage"] as const) {
		const h = await createHarness();
		try {
			await h.search.refreshAppliedResults();
			const previous = h.view.memos;
			let release!: (page: CatalogMemoPage) => void;
			h.service.query = () => new Promise(resolve => { release = resolve; });
			const pending = h.view.loadCatalogMobileSearchResults({ textTerms: ["memo"] }, true);
			if (failure === "run") h.view.catalogMobileQueryRun++;
			if (failure === "coverage") h.view.catalogCoverage = { ...h.coverage, kind: "partial", pendingFileCount: 1 };
			release({ ...h.page(), invalidated: failure === "invalidated", readState: failure === "storage" ? "storage_unavailable" : "ready" });
			await assert.rejects(pending, failure === "run" ? CatalogQueryCancelledError : Error);
			assert.equal(h.view.memos, previous);
		} finally { h.close(); }
	}
});

async function createHarness() {
	await ensureObsidianStub();
	const { KnomoView } = await import("../src/ui/KnomoView");
	const { MobileSearchController } = await import("../src/ui/MobileSearchController");
	const { DiaryMemoParser } = await import("../src/services/DiaryMemoParser");
	const { toCatalogMemoItem } = await import("../src/services/CatalogReadService");
	const coverage = { kind: "complete" as const, configurationComplete: true, coveredFromDate: null,
		pendingFileCount: 0, coveredFileCount: 1, totalFileCount: 1 };
	const capabilities = createCatalogCapabilities(coverage);
	const parser = new DiaryMemoParser(async bytes => createHash("sha256").update(bytes).digest("hex"));
	const parsed = await parser.parse({ sourcePath: "Daily/2026-10-19.md", logicalDate: "2026-10-19",
		bytes: Buffer.from("## Memos\n" + "- 09:00 memo same\n".repeat(51)) });
	const items = parsed.observations.map(observation => toCatalogMemoItem({ kind: "observation", observation,
		capabilities: createResolvedMemoCapabilities() }, capabilities));
	const cursor = { catalog: { catalogRevision: 7, createdAtKey: items[49].createdAt, observationKey: items[49].key } };
	const status = { content: "ready" as const, catalog: "complete" as const, projection: "ready" as const };
	const lifecycle = { state: "ready" as const, persistent: true, writable: true, reason: null };
	const page = (next = false): CatalogMemoPage => ({ items: next ? items.slice(50) : items.slice(0, 50),
		nextCursor: next ? null : cursor, catalogRevision: 7, coverage, status, lifecycle, capabilities,
		readState: "ready", invalidated: false, degraded: false });
	const timers = new Map<number, () => void>();
	let nextTimer = 0, counts = 0, readbacks = 0;
	let releaseCount!: (count: number) => void;
	const countResult = new Promise<CatalogMemoCountResult>(resolve => { releaseCount = count => resolve({ count, complete: true, catalogRevision: 7, coverage }); });
	const queries: CatalogFeatureQuery[] = [];
	const view = Object.create(KnomoView.prototype);
	const service = {
		query: async (request: CatalogFeatureQuery): Promise<CatalogMemoPage> => { queries.push(request); return page(request.cursor != null); },
		count: async () => { counts++; return countResult; },
	};
	const metrics = { accepted: 0, renders: 0, metadata: 0 };
	Object.assign(view, { viewStateController: new KnomoViewStateController(), catalogCoverage: coverage, catalogRevision: 7,
		catalogMobileQueryRun: 0, catalogMobileCursor: null, memos: [],
		containerEl: { win: {
			setTimeout: (callback: () => void) => { timers.set(++nextTimer, callback); return nextTimer; },
			clearTimeout: (id: number) => { timers.delete(id); },
		} }, getCatalogReadService: () => service, syncRecordStatsSource: () => {}, retainMemoCardPreviews: () => {},
		renderMobileSearchResults: () => { metrics.metadata++; search.renderResults("content-change", true, true); },
	});
	let sharedRead = () => { readbacks++; return view.memos; };
	const search = new MobileSearchController({ batchSize: 50, debounceMs: 0,
		getWindow: () => view.containerEl.win, getMemos: () => sharedRead(),
		getMatchedTotalCount: () => view.catalogMobileTotalCount, filterMemos: (memos: unknown) => memos,
		getCatalogRevision: () => view.catalogRevision,
		getCoverageKey: () => JSON.stringify([coverage.kind, coverage.configurationComplete, coverage.coveredFromDate,
			coverage.pendingFileCount, coverage.coveredFileCount, coverage.totalFileCount]),
		loadRemoteResults: (filter: CatalogQueryFilter, reset: boolean, signal: AbortSignal) => view.loadCatalogMobileSearchResults(filter, reset, signal),
		hasRemoteNextPage: () => view.catalogMobileCursor !== null,
	} as never);
	const commit = search.session.commitResult.bind(search.session);
	search.session.commitResult = (...args) => { metrics.accepted++; commit(...args); };
	Object.assign(search, { renderResults: () => { metrics.renders++; }, syncControls: () => {} });
	search.searchQuery = "memo"; search.isOpen = true;
	view.mobileSearchController = search;
	return { view, search, service, queries, metrics, cursor, coverage, items, page, counts: () => counts, readbacks: () => readbacks,
		releaseCount, setSharedRead: (read: typeof sharedRead) => { sharedRead = read; },
		async flushTimers() { const callbacks = [...timers.values()]; timers.clear(); for (const callback of callbacks) callback(); await settle(); },
		close() { search.isOpen = false; view.catalogMobileQueryRun++; view.cancelCatalogMobileCount(); } };
}

async function settle(): Promise<void> { await new Promise(resolve => setImmediate(resolve)); }

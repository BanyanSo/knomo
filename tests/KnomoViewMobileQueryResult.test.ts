import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { JSDOM } from "jsdom";
import type { MemoViewItem } from "../src/types/memoView";
import type { CatalogFeatureQuery, CatalogMemoCountResult, CatalogMemoPage } from "../src/types/catalogView";
import { createCatalogCapabilities, createResolvedMemoCapabilities } from "../src/services/MemoCapabilityModel";
import { KnomoViewStateController } from "../src/ui/KnomoViewStateController";
import { ensureObsidianStub } from "./helpers/obsidianStub";

test("移动查询保留普通列表数组及其 occurrence，接受结果只属于移动会话", async () => {
	const h = await createHarness();
	try {
		const ordinary = [{ id: "ordinary-occurrence" }];
		h.view.memos = ordinary;
		await h.search.refreshAppliedResults();
		h.search.loadMore(); await settle();
		assert.ok(h.view.memos === ordinary, "移动首屏和分页不能回写普通列表");
		assert.equal(h.search.getDisplayedMemos().length, 51);
		for (const field of ["catalogMobileCursor", "catalogMobileQueryRun", "catalogMobileCountController", "catalogMobileQueryFingerprint", "catalogMobileTotalCount"]) {
			assert.equal(field in h.view, false);
		}
	} finally { h.close(); }
});

test("A04 baseline：生产装配首屏 50 条、cursor 分页、迟到 count 保持相同读取与接纳次数", async context => {
	const h = await createHarness();
	try {
		await h.search.refreshAppliedResults();
		assert.equal(h.search.getDisplayedMemos().length, 50);
		assert.equal(h.queries.length, 1);
		assert.equal(h.countSignals.length, 0, "首屏不能等待 count 启动或完成");
		assert.equal(h.search.getDisplayedCount(), null);
		await h.flushTimers();
		assert.equal(h.countSignals.length, 1);
		h.search.loadMore(); await settle();
		assert.equal(h.queries.length, 2);
		assert.equal(h.queries[0].limit, 50);
		assert.equal(h.queries[0].cursor, null);
		assert.equal(h.queries[1].cursor, h.cursor);
		assert.equal(h.search.getDisplayedMemos().length, 51);
		assert.equal(new Set(h.search.getDisplayedMemos().map(memo => memo.id)).size, 51, "同文 occurrence 不合并");
		for (const memo of h.search.getDisplayedMemos()) {
			assert.equal(memo.catalog?.observationHandle, h.items.find(item => item.key === memo.id)!.observationHandle);
		}
		h.releaseCount(51); await settle();
		assert.equal(h.search.getDisplayedCount(), 51, "同一查询分页不得使首屏 count 失效");
		assert.equal(h.countSignals[0].aborted, false);
		assert.deepEqual(h.metrics, { accepted: 2, renders: 4, metadata: 1 });
		context.diagnostic(JSON.stringify({ pages: h.queries.length, counts: h.countSignals.length, ...h.metrics, sharedWrites: 0 }));
	} finally { h.close(); }
});

test("移动 Catalog 适配只返回本页及原始句柄，不读取或写入 View 查询状态", async () => {
	const h = await createHarness();
	try {
		const ordinary = h.view.memos;
		const result = await h.view.loadCatalogMobileSearchResults({ textTerms: ["memo"] }, null, new AbortController().signal);
		assert.equal(result.items.length, 50);
		assert.equal(result.nextCursor, h.cursor);
		for (const field of ["catalogRevision", "coverage", "status", "lifecycle", "capabilities", "readState", "invalidated", "degraded"] as const) {
			assert.equal(result[field], h.page()[field]);
		}
		assert.equal(h.view.memos, ordinary);
		assert.equal(h.search.session.result, null, "适配器不能自行接纳查询结果");
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(h.view.loadCatalogMobileSearchResults({}, null, controller.signal));
	} finally { h.close(); }
});

for (const invalidation of ["cancel", "context", "close"] as const) {
	test("移动 page 在 " + invalidation + " 变化后不接纳，保留旧快照和 stamp", async () => {
		const h = await createHarness();
		try {
			await h.search.refreshAppliedResults();
			const previous = h.search.getDisplayedMemos(), stamp = h.search.session.result;
			const pendingPage = deferred<CatalogMemoPage>();
			h.service.query = () => pendingPage.promise;
			const pending = h.search.refreshAppliedResults();
			assert.equal(h.search.getDisplayedMemos(), previous);
			if (invalidation === "cancel") h.search.cancelPendingRequest();
			else if (invalidation === "context") h.view.viewStateController.scopeFilter = "week";
			else h.search.isOpen = false;
			pendingPage.resolve(h.page()); await pending;
			assert.equal(h.search.getDisplayedMemos(), previous);
			assert.equal(h.search.session.result, stamp);
			assert.equal(h.metrics.accepted, 1);
		} finally { h.close(); }
	});
}

for (const failure of ["invalidated", "coverage", "revision", "storage", "append-revision"] as const) {
	test("移动 " + failure + " 结果不能替换已接受快照或普通列表", async () => {
		const h = await createHarness();
		try {
			await h.search.refreshAppliedResults();
			const previous = h.search.getDisplayedMemos(), ordinary = h.view.memos, stamp = h.search.session.result;
			const pendingPage = deferred<CatalogMemoPage>();
			h.service.query = () => pendingPage.promise;
			let work: Promise<void>;
			if (failure === "append-revision") { h.search.loadMore(); work = settle(); }
			else work = h.search.refreshAppliedResults();
			if (failure === "coverage") h.view.catalogCoverage = { ...h.coverage, kind: "partial", pendingFileCount: 1 };
			if (failure === "revision") h.view.catalogRevision++;
			pendingPage.resolve({ ...h.page(), invalidated: failure === "invalidated",
				catalogRevision: failure === "append-revision" ? 8 : 7,
				readState: failure === "storage" ? "storage_unavailable" : "ready" });
			await work; await settle();
			assert.equal(h.search.session.requestStatus, "failed");
			assert.equal(h.search.getDisplayedMemos(), previous);
			assert.equal(h.search.session.result, stamp);
			assert.equal(h.view.memos, ordinary);
			assert.equal(h.view.catalogRevision, failure === "revision" ? 8 : 7);
		} finally { h.close(); }
	});
}

test("旧 page 的 finally 不能清除新查询控制器、pending 或覆盖新结果", async () => {
	const h = await createHarness();
	try {
		const old = deferred<CatalogMemoPage>(), current = deferred<CatalogMemoPage>();
		const signals: AbortSignal[] = [];
		h.service.query = (_query, signal) => { signals.push(signal!); return signals.length === 1 ? old.promise : current.promise; };
		const first = h.search.refreshAppliedResults();
		h.search.searchQuery = "new memo";
		assert.equal(signals[0].aborted, true);
		old.resolve(h.page()); await first;
		assert.equal(h.search.session.requestStatus, "pending");
		assert.equal(signals[1].aborted, false);
		h.search.cancelPendingRequest();
		assert.equal(signals[1].aborted, true, "旧 finally 不能使新 AbortController 丢失");
		current.resolve(h.page()); await settle();
		assert.equal(h.metrics.accepted, 0);
	} finally { h.close(); }
});

test("Things 首屏、分页、count 与桌面组合条件一致；标签切换拒绝迟到 count", async () => {
	const h = await createHarness();
	try {
		h.search.isOpen = false;
		Object.assign(h.view.viewStateController, { activeNav: "things", activeTagKey: "project", searchQuery: "release" });
		h.view.viewStateController.searchDateFilter = "last-30";
		h.search.searchQuery = "release"; h.search.searchDateFilter = "last-30";
		h.search.isOpen = true;
		const expected = h.view.buildCatalogActiveQuery(false);
		await h.search.refreshAppliedResults();
		h.search.loadMore(); await settle(); await h.flushTimers();
		for (const { limit, cursor, ...filter } of h.queries) { assert.ok(limit > 0); assert.deepEqual(filter, expected); }
		assert.equal(h.queries[0].cursor, null);
		assert.equal(h.queries[1].cursor, h.cursor);
		assert.deepEqual(h.countFilters, [expected]);
		h.view.viewStateController.activeTagKey = "new";
		h.releaseCount(99); await settle();
		assert.equal(h.search.getDisplayedCount(), null);
	} finally { h.close(); }
});

test("关闭取消未启动与扫描中的 count，多 View 互不取消；普通列表仍重新读取", async () => {
	const first = await createHarness(), second = await createHarness();
	try {
		await first.search.refreshAppliedResults(); await second.search.refreshAppliedResults();
		let cancellations = 0;
		const cancel = first.search.cancelPendingRequest.bind(first.search);
		first.search.cancelPendingRequest = () => { cancellations++; cancel(); };
		first.search.closePage();
		assert.equal(cancellations, 1, "关闭、reset、恢复合并为一次会话取消");
		assert.equal(first.timers.size, 0);
		await first.flushTimers();
		assert.equal(first.countSignals.length, 0);
		assert.equal(first.restores(), 1);
		assert.equal(first.search.session.result, null);
		await second.flushTimers();
		assert.equal(second.countSignals[0].aborted, false);
		second.search.closePage();
		assert.equal(second.countSignals[0].aborted, true);
		assert.equal(second.restores(), 1);
		second.releaseCount(99); await settle();
		assert.equal(second.search.getDisplayedCount(), null);
		assert.equal(first.metrics.accepted, 1);
	} finally { first.close(); second.close(); }
});

test("旧 count 的 finally 不影响新 count，重新筛选只接纳新查询计数", async () => {
	const h = await createHarness();
	const old = deferred<CatalogMemoCountResult>(), current = deferred<CatalogMemoCountResult>();
	try {
		let calls = 0;
		h.service.count = async (_filter, signal) => {
			h.countSignals.push(signal!);
			return ++calls === 1 ? old.promise : current.promise;
		};
		await h.search.refreshAppliedResults(); await h.flushTimers();
		h.search.searchQuery = "next memo"; await settle(); await h.flushTimers();
		assert.equal(h.countSignals[0].aborted, true);
		old.resolve({ count: 999, complete: true, catalogRevision: 7, coverage: h.coverage }); await settle();
		assert.equal(h.search.getDisplayedCount(), null);
		h.search.isOpen = false;
		assert.equal(h.countSignals[1].aborted, true, "旧 count finally 不得清除当前取消句柄");
		current.resolve({ count: 99, complete: true, catalogRevision: 7, coverage: h.coverage }); await settle();
		assert.equal(h.search.getDisplayedCount(), null);
	} finally { h.close(); }
});

test("coverage 降级清除不再有效的总数，保留卡片；revision 变化拒绝迟到 count", async () => {
	const h = await createHarness();
	try {
		await h.search.refreshAppliedResults(); await h.flushTimers();
		h.releaseCount(51); await settle();
		const displayed = h.search.getDisplayedMemos();
		const partial = { ...h.coverage, kind: "partial" as const, coveredFromDate: null, pendingFileCount: 1 };
		Object.assign(h.view, { renderStats: () => {}, renderTags: () => {}, libraryIndexRun: 0, catalogDesktopCountRun: 0 });
		h.view.updateCatalogProgress(partial);
		assert.equal(h.search.getDisplayedCount(), null);
		assert.equal(h.search.getDisplayedMemos(), displayed);
		h.view.catalogCoverage = h.coverage;
		await h.search.refreshAppliedResults(); await h.flushTimers();
		h.view.catalogRevision++;
		h.releaseCount(99); await settle();
		assert.equal(h.search.getDisplayedCount(), null);
	} finally { h.close(); }
});

test("迟到 count 的 revision、coverage、完整性或可用性不符时不产生错误总数", async () => {
	for (const failure of ["revision", "coverage", "incomplete", "unavailable"] as const) {
		const h = await createHarness(), count = deferred<CatalogMemoCountResult>();
		try {
			h.service.count = async () => count.promise;
			await h.search.refreshAppliedResults(); await h.flushTimers();
			const renders = h.metrics.renders;
			count.resolve({ count: failure === "unavailable" ? null : 99, complete: failure !== "incomplete",
				catalogRevision: failure === "revision" ? 8 : 7,
				coverage: failure === "coverage" ? { ...h.coverage, kind: "partial", pendingFileCount: 1 } : h.coverage });
			await settle();
			assert.equal(h.search.getDisplayedCount(), null);
			assert.equal(h.metrics.renders, renders);
			assert.equal(h.search.session.requestStatus, "ready");
		} finally { h.close(); }
	}
});

test("生产点击路由、任务队列及关闭导航保留所属 surface 的原操作对象与 handle", async () => {
	const h = await createHarness();
	const dom = await attachSurfaces(h);
	try {
		const actions: Array<{ action: string; memo: MemoViewItem }> = [], tasks: MemoViewItem[] = [];
		h.view.handleMemoAction = async (action: string, memo: MemoViewItem) => { actions.push({ action, memo }); };
		h.view.handleCatalogTaskToggle = async (memo: MemoViewItem) => { tasks.push(memo); };
		h.view.taskUpdateQueues = new Map();
		h.view.consumeSuppressedOpenPopupDismissClick = () => false;
		h.view.handleOpenPopupOutsideEvent = () => false;
		Object.assign(h.view.memoMarkdownRenderer, {
			getTaskCheckboxInput: (target: unknown) => target, getTaskCheckboxIndex: () => 0,
			applyTaskCheckboxDomState: () => {},
		});
		const actionsController = h.view.createUserActionController();
		await actionsController.handleRootClick(dom.event(dom.trigger(dom.flow, dom.ordinary, { "data-memo-action": "edit" })));
		await actionsController.handleRootClick(dom.event(dom.trigger(dom.search, dom.mobile, { "data-memo-action": "delete" })));
		assert.deepEqual(actions.map(item => item.action), ["edit", "delete"]);
		assert.equal(actions[0].memo, dom.ordinary);
		assert.equal(actions[1].memo, dom.mobile);
		assert.equal(actions[1].memo.catalog!.observationHandle, h.items[1].observationHandle);
		const checkbox = dom.trigger(dom.search, dom.mobile, { "data-knomo-memo-id": dom.mobile.id }, "input") as HTMLInputElement;
		checkbox.checked = true;
		h.view.handleTaskCheckboxChange(dom.event(checkbox));
		// 同一 key 的另一表面缓存也不能在旧操作排队后替换它。
		h.view.memos.push({ ...dom.mobile });
		const opened: unknown[][] = [];
		h.view.app = { workspace: { openLinkText: async (...args: unknown[]) => { opened.push(args); } } };
		const time = dom.trigger(dom.search, dom.mobile, { "data-memo-time-open": "daily" });
		await actionsController.handleRootClick(dom.event(time));
		await settle();
		assert.equal(h.search.isOpen, false);
		assert.equal(h.search.getDisplayedMemos().length, 0);
		assert.equal(tasks[0], dom.mobile, "队列继续使用关闭前点击时的对象");
		assert.deepEqual(opened, [[dom.mobile.dailyRef.path, "", false, { active: true, eState: { line: dom.mobile.dailyRef.lineNumberHint! - 1 } }]]);
		assert.equal(h.restores(), 1);
	} finally { h.close(); dom.close(); }
});

test("移动菜单使用触发卡片的 surface，选择动作时不重取已改变的结果", async () => {
	const h = await createHarness(), dom = await attachSurfaces(h);
	try {
		const callbacks: Array<(event: MouseEvent) => void> = [], received: MemoViewItem[] = [];
		h.view.closeCardMenu = () => { h.view.activeMenuMemoId = null; };
		h.view.syncCardMenuState = () => {};
		h.view.handleMemoAction = async (_action: string, memo: MemoViewItem) => { received.push(memo); };
		h.view.mobileMenuController = { close: () => {}, open: (options: { build: (menu: unknown, select: unknown, title: unknown) => void }) => {
			const item = { setSection: () => item, setTitle: () => item, setIcon: () => item, setWarning: () => item, setIsLabel: () => item,
				onClick: (callback: (event: MouseEvent) => void) => { callbacks.push(callback); return item; } };
			options.build({ addItem: (build: (item: unknown) => void) => build(item), addSeparator: () => {} },
				(callback: () => void) => callback(), (title: string) => title);
		} };
		const trigger = dom.trigger(dom.search, dom.mobile, { "data-action": "toggle-card-menu" });
		trigger.classList.add("knomo-card-menu");
		h.view.toggleCardMenu(dom.mobile.id, false, trigger);
		assert.ok(callbacks.length > 0);
		h.view.memos = [{ ...dom.mobile }];
		h.search.resetState();
		callbacks[0](dom.event(trigger)); await settle();
		assert.equal(received[0], dom.mobile);
		assert.equal(received[0].catalog!.observationHandle, h.items[1].observationHandle);
	} finally { h.close(); dom.close(); }
});

test("预览保留与附件刷新纳入移动 occurrence，不再依赖普通列表覆盖", async () => {
	const h = await createHarness();
	try {
		const { toCatalogMemoView } = await import("../src/types/memoView");
		const { MemoCardPreviewCache } = await import("../src/ui/MemoCardPreviewCache");
		const normal = toCatalogMemoView(h.items[0]), mobile = toCatalogMemoView(h.items[1]);
		h.view.memos = [normal];
		h.service.query = async () => ({ ...h.page(), items: [h.items[1]], nextCursor: null });
		await h.search.refreshAppliedResults();
		let builds = 0;
		const cache = new MemoCardPreviewCache((_memo, text) => { builds++; return { text, imageRefs: [{ path: "image.png", raw: "![[image.png]]", isRemote: false, start: 0, end: 14 }] }; });
		cache.get(normal, "normal"); cache.get(mobile, "mobile");
		cache.get({ ...normal, id: "unused" }, "unused");
		Object.assign(h.view, { memoCardPreviewCache: cache,
			randomReunionController: { getSnapshot: () => ({ memos: [] }) }, trashMemoController: { getSnapshot: () => ({ trashMemos: [] }) },
			shuffleDayController: { getSnapshot: () => ({ memos: [] }) }, timeBuoyViewController: { getMemos: () => [] }, catalogTodayTimeBuoys: null,
			cardImageCache: { invalidateResourcePaths: () => {} }, imageResourceCache: { invalidateImagePaths: () => {} },
		});
		h.view.cardImageLoadQueue.invalidateResourcePaths = () => {};
		Object.getPrototypeOf(h.view).retainMemoCardPreviews.call(h.view);
		cache.get(normal, "normal"); cache.get(mobile, "mobile");
		assert.equal(builds, 3, "两个表面缓存均保留");
		const refreshed: MemoViewItem[] = [];
		h.view.refreshVisibleMemoImages = (memo: MemoViewItem) => { refreshed.push(memo); };
		h.view.handleAttachmentFilesChanged(["image.png"]);
		assert.deepEqual(refreshed.map(memo => memo.id), [normal.id, mobile.id]);
		assert.equal(refreshed[1], h.search.getDisplayedMemos()[0]);
		cache.get({ ...normal, id: "unused" }, "unused");
		assert.equal(builds, 4, "退出所有结果上下文的缓存被清除");
	} finally { h.close(); }
});

async function attachSurfaces(h: Awaited<ReturnType<typeof createHarness>>) {
	const { toCatalogMemoView } = await import("../src/types/memoView");
	const dom = new JSDOM("<body><main></main><aside></aside></body>");
	const win = dom.window, flow = win.document.querySelector<HTMLElement>("main")!, search = win.document.querySelector<HTMLElement>("aside")!;
	const previous = { Element: globalThis.Element, HTMLElement: globalThis.HTMLElement };
	Object.assign(globalThis, { Element: win.Element, HTMLElement: win.HTMLElement });
	Object.assign(win.Node.prototype, { instanceOf(this: Node, type: { prototype: object }) { return type.prototype.isPrototypeOf(this); } });
	Object.assign(win.HTMLElement.prototype, {
		getAttr(this: HTMLElement, key: string) { return this.getAttribute(key); },
		find(this: HTMLElement, selector: string) { return this.querySelector(selector); },
		findAll(this: HTMLElement, selector: string) { return Array.from(this.querySelectorAll(selector)); },
		empty(this: HTMLElement) { this.replaceChildren(); },
	});
	const ordinary = toCatalogMemoView(h.items[0]);
	h.view.memos = [ordinary]; h.view.cardFlowEl = flow;
	Object.assign(h.search, { resultsEl: search });
	h.service.query = async () => ({ ...h.page(), items: h.items.slice(1, 3), nextCursor: null });
	await h.search.refreshAppliedResults();
	const mobile = h.search.getDisplayedMemos().find(memo => memo.id === h.items[1].key)!;
	return { flow, search, ordinary, mobile,
		trigger(root: HTMLElement, memo: MemoViewItem, attributes: Record<string, string>, tag = "button") {
			const card = win.document.createElement("article"); card.className = "knomo-card"; card.setAttribute("data-memo-id", memo.id);
			const element = win.document.createElement(tag); element.setAttribute("data-memo-id", memo.id);
			for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
			card.appendChild(element); root.appendChild(card); return element;
		},
		event(target: HTMLElement) { return { type: "click", target, detail: 1, isTrusted: true, preventDefault() {}, stopPropagation() {} } as unknown as MouseEvent; },
		close() { Object.assign(globalThis, previous); dom.window.close(); },
	};
}

async function createHarness() {
	await ensureObsidianStub();
	const { KnomoView } = await import("../src/ui/KnomoView");
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
	let nextTimer = 0, restores = 0;
	const countSignals: AbortSignal[] = [], countFilters: unknown[] = [];
	let countResult = deferred<CatalogMemoCountResult>();
	const queries: CatalogFeatureQuery[] = [];
	const view = Object.create(KnomoView.prototype);
	const service = {
		query: async (request: CatalogFeatureQuery, _signal?: AbortSignal): Promise<CatalogMemoPage> => { queries.push(request); return page(request.cursor != null); },
		count: async (filter: unknown, signal?: AbortSignal) => { countSignals.push(signal!); countFilters.push(filter); return countResult.promise; },
	};
	const metrics = { accepted: 0, renders: 0, metadata: 0 };
	Object.assign(view, { viewStateController: new KnomoViewStateController(), catalogCoverage: coverage, catalogRevision: 7,
		catalogStatus: status, memos: [], currentLayout: "mobile", rootEl: null, popupState: {},
		containerEl: { win: {
			setTimeout: (callback: () => void) => { timers.set(++nextTimer, callback); return nextTimer; },
			clearTimeout: (id: number) => { timers.delete(id); },
		} }, getCatalogReadService: () => service, syncRecordStatsSource: () => {}, retainMemoCardPreviews: () => {},
		getCardFlowScrollTop: () => 0, restoreCardFlowScrollTop: () => {}, syncRootState: () => {},
		setImageLoadSurfacePaused: () => {}, reloadMemos: async () => { restores++; },
		cardImageLoadQueue: { clear: () => {}, bindSurface: () => {} }, memoMarkdownRenderer: { clear: () => {} },
	});
	// 使用 View 的生产装配，测试只替换 DOM 渲染出口与 Catalog I/O。
	const search: import("../src/ui/MobileSearchController").MobileSearchController = view.createMobileSearchController();
	const commit = search.session.commitResult.bind(search.session);
	search.session.commitResult = (...args) => { metrics.accepted++; commit(...args); };
	Object.assign(search, { renderResults: () => {
		metrics.renders++;
		if (search.getDisplayedCount() !== null) metrics.metadata++;
	}, syncControls: () => {} });
	search.searchQuery = "memo"; search.isOpen = true;
	view.mobileSearchController = search;
	return { view, search, service, queries, metrics, cursor, coverage, items, page, countSignals, countFilters, timers,
		restores: () => restores,
		releaseCount(count: number) { countResult.resolve({ count, complete: true, catalogRevision: 7, coverage }); countResult = deferred(); },
		async flushTimers() { const callbacks = [...timers.values()]; timers.clear(); for (const callback of callbacks) callback(); await settle(); },
		close() { search.isOpen = false; } };
}

function deferred<T>() { let resolve!: (result: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function settle(): Promise<void> { await new Promise(resolve => setImmediate(resolve)); }

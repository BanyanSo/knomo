import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { JSDOM } from "jsdom";
import type { TFile } from "obsidian";
import type { ObservationHandle } from "../src/types/catalog";
import type { MemoViewItem } from "../src/types/memoView";
import type { MemoSaveResult } from "../src/types/catalogView";
import type { MarkdownCatalogCommitInput } from "../src/services/MarkdownMutationService";
import type { DailyMemoPresentationChange, ConfirmedDailyMemoPresentation } from "../src/services/DailyMemoPresentationChange";
import { ensureObsidianStub } from "./helpers/obsidianStub";
import type { ReadyCardImageHandoff } from "../src/ui/KnomoCardImages";

// 查询在机器繁忙时会协作式让出；夹具必须提供窗口计时器，不能依赖它始终同步完成。
const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
before(() => Object.defineProperty(globalThis, "window", {
	configurable: true, value: { setTimeout, clearTimeout },
}));
after(() => {
	if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
	else Reflect.deleteProperty(globalThis, "window");
});

test("两个 leaf 按提交前普通窗口分别接纳灯标编辑，索引接管不把窗口外缓存补入列表", async () => {
	const gate = deferred<void>();
	const h = await fixture({ body: "## Memos\n- 08:00 neighbor ^neighbor\n- 09:00 selected ^beacon\n- 10:00 tail ^tail\n",
		immediate: true, catalogGate: gate.promise });
	const other = await h.createView(), selected = h.memos[1]!, cursor = { catalogRevision: 1, observationKey: "cursor", createdAtKey: "date" };
	const beacon = { getSnapshot: () => ({ state: "locating", selection: 1 }),
		isBoundObservation: (observation: import("../src/types/catalog").MemoObservation, anchors?: Record<string, number>) =>
			observation.existingBlockId === "beacon" && anchors?.beacon === 1 };
	Object.assign(h.view, { beaconService: beacon, isDefaultListState: () => true });
	Object.assign(other.view, { beaconService: beacon, isDefaultListState: () => true, memos: [h.memos[0]!],
		catalogCursor: cursor, catalogDesktopTotalCount: 3 });
	const operation = h.command.startEdit(selected.catalog!, "edited selected");
	try {
		await operation.dailyCommitted;
		assert.equal(h.view.memos.length, 3);
		assert.equal(h.view.memos.filter(memo => memo.contentSnapshot === "edited selected").length, 1);
		assert.deepEqual(other.view.memos.map(memo => memo.contentSnapshot), ["neighbor"]);
		assert.equal(Reflect.get(other.view, "catalogCursor"), cursor);
		assert.equal(Reflect.get(other.view, "catalogDesktopTotalCount"), 3);
		assert.deepEqual(other.view.confirmedDailyMemos!.getMemos().map(memo => memo.contentSnapshot), ["neighbor"]);
	} finally { gate.resolve(); }
	await operation.settled;
	assert.deepEqual(other.view.memos.map(memo => memo.contentSnapshot), ["neighbor"]);
	assert.equal(Reflect.get(other.view, "catalogCursor"), cursor);
	assert.equal(Reflect.get(other.view, "catalogDesktopTotalCount"), 3);
	await assert.rejects(h.edit(selected, "stale edit"), /stale|revision|changed/iu);
});

test("窗口外灯标编辑在索引落后、两个真实分页窗口刷新及继续加载时保留成员、游标边界和总数", async t => {
	t.mock.timers.enable({ apis: ["Date"], now: new Date(2026, 10, 17, 12).getTime() });
	const gate = deferred<void>(), h = await fixture({ immediate: true, refreshViews: true, catalogGate: gate.promise,
		body: "## Memos\n" + Array.from({ length: 160 }, (_, index) => `- 09:00 kept-${index}${index === 0 ? " ^beacon" : ""}\n`).join("") });
	const other = await h.createView(), selected = await readCurrentSourceMemo(h, memo => memo.existingBlockId === "beacon");
	const beacon = { getSnapshot: () => ({ state: "locating", selection: 1 }),
		isBoundObservation: (observation: import("../src/types/catalog").MemoObservation, anchors?: Record<string, number>) =>
			observation.existingBlockId === "beacon" && anchors?.beacon === 1 };
	const windows = [];
	for (const [view, pageCount] of [[h.view, 1], [other.view, 2]] as const) {
		Object.assign(view, { beaconService: beacon });
		windows.push(await prepareDefaultCatalogWindow(h, view, pageCount));
	}
	const operation = h.command.startEdit(selected.catalog!, "edited outside");
	try {
		await operation.dailyCommitted;
		for (const { view, members, cursor } of windows) {
			assert.deepEqual(view.memos.map(memo => memo.contentSnapshot), members);
			assert.equal(Reflect.get(view, "catalogCursor"), cursor); assert.equal(Reflect.get(view, "catalogDesktopTotalCount"), 160);
		}
		assert.equal(await windows[0]!.production.loadNextCatalogPage.call(h.view), true);
		assert.equal(h.view.memos.length, 100, "索引尚未接管时也能继续真实旧快照分页");
		assert.equal(h.view.memos.some(memo => memo.contentSnapshot === "edited outside"), false);
		assert.equal(await windows[0]!.production.loadNextCatalogPage.call(h.view), true); assert.equal(h.view.memos.length, 150);
		assert.equal(await windows[0]!.production.loadNextCatalogPage.call(h.view), true); assert.equal(h.view.memos.length, 160);
		assert.equal(h.view.memos.filter(memo => memo.contentSnapshot === "edited outside").length, 1, "旧索引真实读到目标时采用已确认的当前正文");
		assert.equal(Reflect.get(h.view, "catalogCursor"), null); assert.equal(Reflect.get(h.view, "catalogDesktopTotalCount"), 160);
	} finally { gate.resolve(); }
	await operation.settled; await h.waitForViewRefresh();
	for (const { view, production } of windows) {
		assert.equal(view.memos.length, view === h.view ? 160 : 100, "后台刷新保留各 leaf 此时分别已读取的四页/两页");
		assert.equal(Reflect.get(view, "catalogDesktopTotalCount"), 160);
		assert.equal(production.getCatalogPresentationTotalCount.call(view), 160);
		const cursor = Reflect.get(view, "catalogCursor") as import("../src/types/catalogView").CatalogFeatureCursor;
		if (view === h.view) { assert.equal(cursor, null); assert.equal(await production.loadNextCatalogPage.call(view), false); continue; }
		assert.ok(cursor?.catalog); assert.equal(cursor.catalog.catalogRevision, await h.catalog.getStore().getCatalogRevision());
		assert.equal(await production.loadNextCatalogPage.call(view), true); assert.equal(view.memos.length, 150);
		assert.equal(new Set(view.memos.map(memo => memo.id)).size, 150);
		assert.equal(view.memos.some(memo => memo.contentSnapshot === "edited outside"), false);
		assert.equal(Reflect.get(view, "catalogDesktopTotalCount"), 160);
	}
	assert.equal(await windows[1]!.production.loadNextCatalogPage.call(other.view), true);
	assert.equal(other.view.memos.length, 160); assert.equal(Reflect.get(other.view, "catalogCursor"), null);
	assert.equal(other.view.memos.filter(memo => memo.contentSnapshot === "edited outside").length, 1, "只有真实分页读到目标时才进入该 leaf 的普通窗口");
	assert.equal(h.view.memos.length, 160); assert.equal(Reflect.get(other.view, "catalogDesktopTotalCount"), 160);
});

test("首次设置所需的原生 ID 写入只更新既有成员，不扩充其它 leaf 的普通窗口或重置分页总数", async t => {
	t.mock.timers.enable({ apis: ["Date"], now: new Date(2026, 10, 17, 12).getTime() });
	const gate = deferred<void>(), confirmed = deferred<void>(), h = await fixture({ immediate: true, refreshViews: true,
		catalogGate: gate.promise, onConfirmed: () => confirmed.resolve(),
		body: "## Memos\n" + Array.from({ length: 160 }, (_, index) => `- 09:00 kept-${index}\n`).join("") });
	const other = await h.createView(), selected = await readCurrentSourceMemo(h, memo => memo.content === "kept-0");
	const windows = [await prepareDefaultCatalogWindow(h, h.view, 1), await prepareDefaultCatalogWindow(h, other.view, 2)];
	const reference = h.mutations.createBlockReference({ observation: selected.catalog!.observationHandle, sourcePath: PATH });
	try {
		await confirmed.promise;
		for (const { view, cursor, members } of windows) {
			assert.deepEqual(view.memos.map(memo => memo.contentSnapshot), members);
			assert.equal(Reflect.get(view, "catalogCursor"), cursor); assert.equal(Reflect.get(view, "catalogDesktopTotalCount"), 160);
		}
	} finally { gate.resolve(); }
	const result = await reference; await h.waitForViewRefresh();
	assert.ok(result.blockId); assert.equal(result.observation!.existingBlockId, result.blockId);
	for (const { view, members } of windows) {
		assert.deepEqual(view.memos.map(memo => memo.contentSnapshot), members);
		assert.equal(Reflect.get(view, "catalogDesktopTotalCount"), 160);
	}
});

for (const entry of ["beacon", "copy-link"] as const) test(`${entry} 的纯锚点提交按各查询窗口接续，索引接管后继续分页`, async t => {
	t.mock.timers.enable({ apis: ["Date"], now: new Date(2026, 10, 17, 12).getTime() });
	const gate = deferred<void>(), confirmed = deferred<void>();
	const h = await fixture({ immediate: true, refreshViews: true, catalogGate: gate.promise, onConfirmed: () => confirmed.resolve(),
		body: "## Memos\n" + Array.from({ length: 160 }, (_, index) => `- 09:00 kept-${index}\n`).join("") });
	const desktop = await h.createView(), mobile = await h.createView(), target = await readCurrentSourceMemo(h, memo => memo.content === "kept-0");
	desktop.view.viewStateController.searchQuery = "kept";
	const first = await prepareDefaultCatalogWindow(h, h.view, 1), filtered = await prepareDefaultCatalogWindow(h, desktop.view, 2);
	await prepareDefaultCatalogWindow(h, mobile.view, 2);
	Object.assign(mobile.view, { containerEl: { win: { setTimeout, clearTimeout } } });
	const search = mobile.view.createMobileSearchController();
	Object.assign(mobile.view, { mobileSearchController: search });
	Object.assign(search, { renderResults: () => {}, syncControls: () => {} });
	search.searchQuery = "kept"; search.isOpen = true;
	await search.refreshAppliedResults();
	const mobileMembers = search.getDisplayedMemos().map(memo => memo.contentSnapshot);
	const mobileCursor = Reflect.get(search, "cursor");
	assert.equal(mobileMembers.length, 50);
	assert.equal(mobile.view.memos.length, 100, "同一 leaf 的主列表保有搜索窗口以外的缓存");
	const loadSource = async () => {
		const { DiaryMemoParser } = await import("../src/services/DiaryMemoParser");
		return { path: PATH, logicalDate: DATE, ...await new DiaryMemoParser().parse({ sourcePath: PATH, logicalDate: DATE, bytes: Buffer.from(h.body()) }) };
	};
	const { BeaconService } = await import("../src/services/BeaconService");
	const { PluginDataStore } = await import("../src/services/PluginDataStore");
	const { toParsedCatalogMemoItem } = await import("../src/services/CatalogReadService");
	let saved: unknown = {};
	const beacon = new BeaconService(new PluginDataStore({
		loadData: async () => saved, saveData: async (value: unknown) => { saved = value; },
	} as import("obsidian").Plugin), {
		readSource: loadSource, isSourceCurrent: async source => (await loadSource()).sourceRevision === source.sourceRevision,
		createBlockReference: observation => h.mutations.createBlockReference({ observation, sourcePath: PATH }),
		fromObservation: observation => toParsedCatalogMemoItem(observation, target.catalog!.capabilities.catalog),
		onFailure: error => { throw error; },
	});
	t.after(() => { search.isOpen = false; beacon.dispose(); });
	await beacon.reload();
	const operation = entry === "beacon" ? beacon.set(target.catalog!.observationHandle) : h.command.createReferenceText(target.catalog!);
	try {
		await confirmed.promise;
		for (const { view, members, cursor } of [first, filtered]) {
			assert.deepEqual(view.getFilteredMemos().map(memo => memo.contentSnapshot), members);
			assert.equal(Reflect.get(view, "catalogCursor"), cursor);
			assert.equal(Reflect.get(view, "catalogDesktopTotalCount"), 160);
		}
		assert.deepEqual(search.getDisplayedMemos().map(memo => memo.contentSnapshot), mobileMembers);
		assert.equal(Reflect.get(search, "cursor"), mobileCursor);
		await search.refreshAppliedResults();
		assert.deepEqual(search.getDisplayedMemos().map(memo => memo.contentSnapshot), mobileMembers);
		assert.equal(search.getDisplayedMemos().some(memo => memo.contentSnapshot === "kept-0"), false);
	} finally { gate.resolve(); await operation; }
	await h.waitForViewRefresh();
	const revision = await h.catalog.getStore().getCatalogRevision();
	for (const { view, members, production } of [first, filtered]) {
		assert.deepEqual(view.getFilteredMemos().map(memo => memo.contentSnapshot), members);
		assert.equal(Reflect.get(view, "catalogCursor").catalog.catalogRevision, revision);
		assert.equal(await production.loadNextCatalogPage.call(view), true);
		assert.equal(view.memos.length, members.length + 50);
		assert.equal(new Set(view.memos.map(memo => memo.id)).size, view.memos.length);
	}
	assert.deepEqual(search.getDisplayedMemos().map(memo => memo.contentSnapshot), mobileMembers);
	assert.equal(Reflect.get(search, "cursor").catalog.catalogRevision, revision);
	await Object.getPrototypeOf(search).refreshRemoteResults.call(search, false);
	assert.equal(search.getDisplayedMemos().length, 100);
	assert.equal(new Set(search.getDisplayedMemos().map(memo => memo.id)).size, 100);
	if (entry === "beacon") assert.equal(beacon.getSnapshot().memo?.contentSnapshot, "kept-0");
	assert.equal((h.body().match(/ \^[a-z0-9]{6}$/gmu) ?? []).length, 1);
});

test("真实新建后连续复制块链接，索引滞后时只补入已经接纳的新建", async () => {
	const gate = deferred<void>(), anchored = deferred<void>();
	let confirmations = 0;
	const h = await fixture({ immediate: true, catalogGate: gate.promise, rejectStalePublication: true,
		onConfirmed: () => { if (++confirmations === 2) anchored.resolve(); },
		body: "## Memos\n- 09:00 kept first\n- 10:00 kept second\n" });
	const creating = h.command.startCreate("kept new");
	let copying: ReturnType<typeof h.command.createReferenceText> | undefined;
	try {
		await creating.dailyCommitted;
		const target = h.view.memos.find(memo => memo.contentSnapshot === "kept first")!;
		copying = h.command.createReferenceText(target.catalog!);
		await anchored.promise;
		assert.deepEqual(h.view.confirmedDailyMemos!.merge([], { textTerms: ["kept"] }).map(memo => memo.contentSnapshot), ["kept new"]);
		assert.equal(h.view.memos.filter(memo => memo.contentSnapshot === "kept new").length, 1);
		assert.equal(h.view.memos.find(memo => memo.contentSnapshot === "kept first")?.catalog?.observation.existingBlockId?.length, 6);
	} finally { gate.resolve(); await Promise.all([creating.settled, copying]); }
	assert.equal(h.view.memos.filter(memo => memo.contentSnapshot === "kept new").length, 1);
});

for (const takeover of ["publication", "refresh"] as const) test(`目标 Daily 完全不在另一 leaf 缓存中时，${takeover} 接管空成员确认并恢复搜索计数`, async () => {
	const gate = deferred<void>(), confirmed = deferred<void>();
	const h = await fixture({ immediate: true, catalogGate: gate.promise, onConfirmed: () => confirmed.resolve(),
		body: "## Memos\n- 09:00 selected\n", otherBody: "## Memos\n- 10:00 other\n" });
	const other = await h.createView(), selected = h.memos.find(memo => memo.dailyRef.path === PATH)!;
	const targetChanges = new Map([[selected.id, null]]);
	other.random.applyMemoChanges(targetChanges, false); other.shuffle.applyMemoChanges(targetChanges);
	other.view.memos = h.memos.filter(memo => memo.dailyRef.path !== PATH);
	const members = [...other.view.memos], cursor = { catalogRevision: 1, observationKey: "cursor", createdAtKey: "date" };
	Object.assign(other.view, { catalogCursor: cursor, catalogDesktopTotalCount: 2 });
	const production = Object.getPrototypeOf(other.view);
	assert.ok(production.getCachedMemos.call(other.view).every((memo: MemoViewItem) => memo.dailyRef.path !== PATH));
	if (takeover === "refresh") h.failCatalog();
	const reference = h.mutations.createBlockReference({ observation: selected.catalog!.observationHandle, sourcePath: PATH });
	try {
		await confirmed.promise;
		assert.equal(other.view.confirmedDailyMemos!.pending, true);
		assert.deepEqual(other.view.confirmedDailyMemos!.getMemos(), []);
		await production.reconcileConfirmedCatalog.call(other.view);
		assert.equal(other.view.confirmedDailyMemos!.pending, true, "索引尚未接管时不能丢弃确认记录");
		assert.deepEqual(other.view.memos, members); assert.equal(Reflect.get(other.view, "catalogCursor"), cursor);
	} finally { gate.resolve(); }
	const result = await reference;
	assert.ok(result.blockId);
	if (takeover === "refresh") {
		assert.equal(result.catalogUpdatePending, true);
		assert.equal(other.view.confirmedDailyMemos!.pending, true, "发布失败不能确认接管");
		await h.externalReplace(h.body());
		await production.reconcileConfirmedCatalog.call(other.view);
	}
	assert.equal(other.view.confirmedDailyMemos!.pending, false, "Catalog 接管后空成员记录必须收尾");
	assert.deepEqual(other.view.memos, members);
	assert.equal(Reflect.get(other.view, "catalogCursor"), cursor);
	assert.equal(Reflect.get(other.view, "catalogDesktopTotalCount"), 2);
	other.view.viewStateController.searchQuery = "other";
	assert.equal(production.shouldCountCatalogQuery.call(other.view), true);
	const page = await h.read.query({ textTerms: ["other"], limit: 20 });
	assert.equal(production.getImmediateCatalogTotalCount.call(other.view, { ...page, memos: members }), 1);
	Object.assign(other.view, { containerEl: { win: { setTimeout, clearTimeout } },
		catalogCoverage: page.coverage, catalogRevision: page.catalogRevision, catalogStatus: page.status,
		syncRecordStatsSource: () => {}, retainMemoCardPreviews: () => {} });
	const search = other.view.createMobileSearchController();
	Object.assign(other.view, { mobileSearchController: search });
	Object.assign(search, { renderResults: () => {}, syncControls: () => {} });
	try {
		search.searchQuery = "other"; search.isOpen = true;
		await search.refreshAppliedResults();
		assert.deepEqual(search.getDisplayedMemos().map(memo => memo.contentSnapshot), ["other"]);
		assert.equal(search.getDisplayedCount(), 1);
		assert.deepEqual(other.view.memos, members, "搜索计数恢复不能扩充普通窗口");
	} finally { search.isOpen = false; }
});

async function readCurrentSourceMemo(h: Awaited<ReturnType<typeof fixture>>, matches: (memo: import("../src/types/catalog").MemoObservation) => boolean) {
	const { DiaryMemoParser } = await import("../src/services/DiaryMemoParser"), { toCatalogMemoView } = await import("../src/types/memoView");
	const parsed = await new DiaryMemoParser().parse({ sourcePath: PATH, logicalDate: DATE, bytes: Buffer.from(h.body()) });
	const observation = parsed.observations.find(matches); assert.ok(observation);
	return toCatalogMemoView((await h.read.readMemoItems([observation]))[0]!);
}

async function prepareDefaultCatalogWindow(h: Awaited<ReturnType<typeof fixture>>, view: TestView, pageCount: number) {
	const { toCatalogMemoView } = await import("../src/types/memoView"), { getMemoListStateKey } = await import("../src/ui/MemoRenderRevision");
	const production = Object.getPrototypeOf(view), query = production.buildCatalogActiveQuery.call(view, true);
	let page = await h.read.query({ ...query, limit: 50 }); const items = [...page.items];
	for (let index = 1; index < pageCount; index++) { page = await h.read.query({ ...query, limit: 50, cursor: page.nextCursor }); items.push(...page.items); }
	view.memos = items.map(toCatalogMemoView); view.viewStateController.search.commitResult(query, page.catalogRevision, "complete");
	Object.assign(view, { memoSourceGeneration: 0, catalogDesktopCountRun: 0, catalogCursor: page.nextCursor,
		cardFlowCoordinator: { generation: 1 },
		catalogDesktopTotalCount: 160, catalogHistoryExpansionPending: false,
		catalogDesktopQueryFingerprint: production.getCatalogQueryFingerprint.call(view, true),
		catalogCoverage: page.coverage, catalogRevision: page.catalogRevision, catalogStatus: page.status,
		cardFlowError: null, shouldShowTodayTimeBuoys: () => false,
		trashMemoController: { getSnapshot: () => ({ trashLoading: false, trashError: null, trashMemos: [] }) },
		getCatalogReadService: () => h.read, reloadMemos: production.reloadMemos,
		retainMemoCardPreviews: () => {}, syncRecordStatsSource: () => {}, refreshCatalogLibraryIndexes: async () => {},
		syncSearchControls: () => {}, getMobileSearchStateKey: () => "closed", renderMobileSearchResultsIfChanged: () => {},
		refreshCatalogDesktopTotalCount: async () => {}, renderNextCardBatch: () => {},
		getCardFlowStateKey: () => getMemoListStateKey(view.getFilteredMemos()),
	});
	production.rememberCatalogRefreshWindow.call(view, Reflect.get(view, "catalogDesktopQueryFingerprint"));
	return { view, production, members: view.memos.map(memo => memo.contentSnapshot), cursor: page.nextCursor };
}

test("窗口外灯标与另一张窗口外浮标同时撤权后，确认编辑只恢复原普通窗口成员", async t => {
	const gate = deferred<void>(), h = await fixture({ immediate: true, catalogGate: gate.promise,
		body: "## Memos\n- 08:00 neighbor ^neighbor\n- 09:00 selected ^beacon\n- 10:00 buoy @2026-10-10 ^buoy\n" });
	h.view.memos = [h.memos[0]!];
	const first = h.command.startEdit(h.memos[0]!.catalog!, "neighbor first"); await first.dailyCommitted;
	const current = h.random.getSnapshot().memos!, selected = current.find(memo => memo.catalog!.observation.existingBlockId === "beacon")!,
		buoy = current.find(memo => memo.catalog!.observation.existingBlockId === "buoy")!;
	const { sameBeaconHandle } = await import("../src/types/beacon");
	Object.assign(h.view, { beaconService: { getSnapshot: () => ({ state: "ready", selection: 1, memo: selected }),
		isSelectedHandle: (handle: import("../src/types/catalog").ObservationHandle) => sameBeaconHandle(selected.catalog!.observationHandle, handle),
		isBoundObservation: (observation: import("../src/types/catalog").MemoObservation, anchors?: Record<string, number>) =>
			observation.existingBlockId === "beacon" && anchors?.beacon === 1 }, isDefaultListState: () => true,
		trashMemoController: { getSnapshot: () => ({ trashMemos: [] }) }, catalogDesktopTotalCount: 3 });
	const cursor = { catalogRevision: 1, observationKey: "cursor", createdAtKey: "date" }; Object.assign(h.view, { catalogCursor: cursor });
	const dom = attachCardFlow(h.view); let second: ReturnType<typeof h.command.startEdit> | undefined;
	try {
		Reflect.get(h.view, "syncCardFlowPresentation").call(h.view, { type: "items", mode: "memo", headers: [], memos: [...h.view.memos, buoy] }, null);
		assert.equal(dom.root.querySelectorAll(".knomo-card").length, 3);
		const app = Reflect.get(h.view, "app") as import("obsidian").App, process = app.vault.process.bind(app.vault);
		t.mock.method(app.vault, "process", async (file: TFile, update: (content: string) => string) => {
			const result = await process(file, update); await h.view.checkConfirmedDailyFile(PATH); return result;
		});
		second = h.command.startEdit(selected.catalog!, "edited selected"); await second.dailyCommitted;
		assert.deepEqual(h.view.memos.map(memo => memo.contentSnapshot), ["neighbor first"]);
		assert.equal(Reflect.get(h.view, "catalogCursor"), cursor); assert.equal(Reflect.get(h.view, "catalogDesktopTotalCount"), 3);
	} finally { gate.resolve(); await first.settled; await second?.settled; dom.dispose(); }
});

test("日期详情接收真实 Daily 编辑、新建和删除广播，原重逢批次不补抽", async () => {
	const h = await fixture();
	const { ShuffleDayController } = await import("../src/ui/ShuffleDayController");
	const detail = new ShuffleDayController({ loadSelectedDate: () => h.loadMemos(),
		isShuffleDayActive: () => true, requestRender: () => {} });
	Object.assign(h.view, { randomDayController: detail });
	h.view.viewStateController.activeNav = "random";
	await detail.openDate(DATE);
	await h.edit(h.memos[0]!, "changed in day detail");
	assert.deepEqual(detail.getSnapshot().memos.map(memo => memo.contentSnapshot), ["changed in day detail", "same", "same"]);
	await h.command.create("new day memo");
	assert.equal(detail.getSnapshot().stats?.memoCount, 4);
	assert.equal(h.random.getSnapshot().memos!.length, 3);
	const selected = detail.getSnapshot().memos[1]!;
	await h.command.delete(selected.catalog!);
	assert.equal(detail.getSnapshot().stats?.memoCount, 3);
	assert.equal(detail.getSnapshot().selectedDate, DATE);
	assert.deepEqual(new Set(detail.getSnapshot().memos.map(memo => memo.id)), new Set((await h.loadMemos()).map(memo => memo.id)));
	assert.equal(h.randomLoads(), 1);
});

test("真实 Daily 编辑改变 key 后原位更新重逢卡片，保留本组与原编辑句柄", async () => {
	const h = await fixture();
	const original = h.memos[0]!;
	h.view.editingMemo = original;
	const result = await h.edit(original, "changed body\nsecond line");
	assert.notEqual(result.memo?.key, original.id);
	await h.view.finishComposerSave(Promise.resolve(result), original);
	const current = h.random.getSnapshot().memos!;
	assert.deepEqual(current.map(memo => memo.contentSnapshot), ["changed body\nsecond line", "same", "same"]);
	assert.deepEqual(current.map(memo => memo.id), (await h.loadMemos()).map(memo => memo.id));
	assert.equal(h.randomLoads(), 1);
	assert.equal(h.view.editingMemo, original);
	assert.equal(h.view.editingMemo.catalog?.observationHandle.sourceRevision, original.catalog!.observationHandle.sourceRevision);
	const body = h.body();
	await assert.rejects(h.edit(original, "stale overwrite"), /stale|revision|changed/iu);
	assert.equal(h.body(), body);
});

test("真实 Daily 编辑改变 key 后漫游不保留旧新两张卡片，同文 occurrence 仍独立", async () => {
	const h = await fixture();
	const original = h.memos[0]!;
	await h.edit(original, "changed");
	assert.deepEqual(h.shuffle.getSnapshot().memos.map(memo => memo.contentSnapshot), ["changed", "same", "same"]);
	assert.equal(h.shuffle.getSnapshot().stats?.memoCount, 3);
	assert.equal(h.shuffle.getSnapshot().selectedDate, DATE);
	assert.equal(new Set(h.shuffle.getSnapshot().memos.map(memo => memo.id)).size, 3);
});

test("修改第二个同文 occurrence 只替换对应位置，同时刷新其它卡片句柄", async () => {
	const h = await fixture();
	await h.edit(h.memos[2]!, "second occurrence changed");
	assert.deepEqual(h.random.getSnapshot().memos!.map(memo => memo.contentSnapshot), ["old", "same", "second occurrence changed"]);
	assert.equal(new Set(h.random.getSnapshot().memos!.map(memo => memo.id)).size, 3);
	await h.edit(h.random.getSnapshot().memos![1]!, "first occurrence changed");
	assert.deepEqual(h.random.getSnapshot().memos!.map(memo => memo.contentSnapshot), ["old", "first occurrence changed", "second occurrence changed"]);
	assert.deepEqual(h.shuffle.getSnapshot().memos.map(memo => memo.id), (await h.loadMemos()).map(memo => memo.id));
});

test("任务勾选与正文引用提交同步全部已打开页面，不重新抽样", async () => {
	const h = await fixture({ body: "## Memos\n- 09:00 - [ ] todo\n- 10:00 same\n" });
	const other = await h.createView();
	other.view.editingMemo = h.memos[1]!;
	await h.view.handleCatalogTaskToggle(h.memos[0]!, 0, true);
	for (const page of [h, other]) {
		assert.match(page.random.getSnapshot().memos![0]!.contentSnapshot, /\[x\]/u);
		assert.deepEqual(page.shuffle.getSnapshot().memos.map(memo => memo.id), (await h.loadMemos()).map(memo => memo.id));
	}
	const selected = h.random.getSnapshot().memos![1]!;
	await h.command.createReferenceText(selected.catalog!);
	assert.notEqual(h.random.getSnapshot().memos![1]!.id, selected.id);
	assert.deepEqual(other.random.getSnapshot().memos!.map(memo => memo.id), h.random.getSnapshot().memos!.map(memo => memo.id));
	assert.equal(other.view.editingMemo, h.memos[1]);
	assert.equal(h.randomLoads(), 2);
});

test("任务写入区分过期、目标不可用和未知 I/O，列表补刷失败单独反馈", async t => {
	const { Notice } = await import("obsidian");
	const { t: translate } = await import("../src/i18n");
	const notices = (Notice as unknown as { messages: string[] }).messages;
	for (const failure of ["stale", "missing", "io-before", "io-after", "refresh"] as const) {
		const h = await fixture({ body: "## Memos\n- 09:00 - [ ] task\n" });
		const app = Reflect.get(h.view, "app") as import("obsidian").App;
		const before = h.body();
		const logs: unknown[][] = [];
		const warn = t.mock.method(console, "warn", (...args: unknown[]) => { logs.push(args); });
		Object.assign(h.view, { memoMarkdownRenderer: { syncTaskCheckboxesForMemo: () => {} }, reportViewRefreshFailure: () => {} });
		Object.defineProperty(h.view, "mobileSearchResultsEl", { value: null });
		if (failure === "refresh") {
			h.failCatalog();
			h.view.refresh = async () => { throw new Error("private body"); };
		} else if (failure === "stale") {
			await h.externalReplace(before + "- 10:00 concurrent\n");
		} else if (failure === "missing") {
			t.mock.method(app.vault, "getAbstractFileByPath", () => null);
		} else {
			const process = app.vault.process.bind(app.vault);
			t.mock.method(app.vault, "process", async (file: TFile, update: (content: string) => string) => {
				if (failure === "io-after") await process(file, update);
				throw new Error("private body I/O");
			});
		}
		notices.length = 0;
		await h.view.handleCatalogTaskToggle(h.memos[0]!, 0, true);
		assert.deepEqual(notices, [translate(failure === "stale" ? "task.targetChanged" : failure === "missing" ? "task.sourceUnavailable"
			: failure.startsWith("io-") ? "task.updateFailed" : "task.refreshIncomplete")]);
		assert.equal(h.body().includes("[x]"), failure === "refresh" || failure === "io-after");
		assert.ok(!JSON.stringify(logs).includes("private body"));
		warn.mock.restore();
	}
});

test("删除、同文恢复和创建保持重逢本组，漫游同步独立 occurrence 与统计", async () => {
	const h = await fixture();
	const deleted = h.memos[2]!;
	await h.command.delete(deleted.catalog!);
	assert.deepEqual(h.random.getSnapshot().memos!.map(memo => memo.contentSnapshot), ["old", "same"]);
	assert.equal(h.shuffle.getSnapshot().stats?.memoCount, 2);
	const snapshot = (await h.trash.store.query()).items[0]!;
	await h.trash.restore(snapshot);
	assert.deepEqual(h.random.getSnapshot().memos!.map(memo => memo.contentSnapshot), ["old", "same"]);
	assert.deepEqual(h.shuffle.getSnapshot().memos.map(memo => memo.contentSnapshot), ["old", "same", "same"]);
	assert.equal(new Set(h.shuffle.getSnapshot().memos.map(memo => memo.id)).size, 3);
	assert.equal((await h.trash.store.query()).items.length, 0);
	await h.command.create("new memo");
	assert.equal(h.random.getSnapshot().memos!.length, 2);
	assert.equal(h.shuffle.getSnapshot().stats?.memoCount, 4);
	assert.equal(h.shuffle.getSnapshot().selectedDate, DATE);
	assert.deepEqual(h.shuffle.getSnapshot().memos.map(memo => memo.id), (await h.loadMemos()).map(memo => memo.id));
	assert.equal(h.randomLoads(), 1);
});

test("浮标页面与列表置顶卡片接收新 key，移除已取消的日期归属", async () => {
	const h = await fixture({ body: "## Memos\n- 09:00 old @2026-10-10\n- 10:00 same\n" });
	await h.buoy.loadInitial();
	h.view.catalogTodayTimeBuoys = h.buoy.getSnapshot();
	const original = h.memos[0]!;
	await h.edit(original, "changed @2026-10-10");
	assert.equal(h.buoy.getSnapshot().today[0]!.memo.contentSnapshot, "changed @2026-10-10");
	assert.notEqual(h.buoy.getSnapshot().today[0]!.memo.id, original.id);
	assert.equal(h.view.catalogTodayTimeBuoys!.today[0]!.memo.id, h.buoy.getSnapshot().today[0]!.memo.id);
	await h.edit(h.random.getSnapshot().memos![0]!, "no buoy");
	assert.deepEqual(h.buoy.getSnapshot().today, []);
	assert.deepEqual(h.view.catalogTodayTimeBuoys!.today, []);
});

test("外部文件改动使旧重逢展示失效，保留旧草稿且不按行号或同文重绑定", async () => {
	const h = await fixture();
	h.view.editingMemo = h.memos[1]!;
	await h.externalReplace("## Memos\n- 09:00 external\n- 10:00 same\n- 10:00 same\n");
	await h.view.refreshRandomReunionBatch();
	assert.deepEqual(h.random.getSnapshot().memos, []);
	assert.equal(h.random.getSnapshot().status, "empty");
	assert.ok(h.random.getSnapshot().error);
	assert.equal(h.randomLoads(), 1);
	assert.equal(h.view.editingMemo, h.memos[1]);
	await assert.rejects(h.edit(h.memos[1]!, "overwrite"), /stale|revision|changed/iu);
});

test("迟到的重逢校验不覆盖保存结果或关闭后的状态", async t => {
	for (const close of [false, true]) {
		const h = await fixture();
		const before = h.random.getSnapshot().memos!;
		const gate = deferred<MemoViewItem[]>();
		let started!: () => void;
		const entered = new Promise<void>(resolve => { started = resolve; });
		t.mock.method(h.read, "refreshMemoViews", async () => { started(); return gate.promise; });
		const pending = h.view.refreshRandomReunionBatch();
		await entered;
		if (close) {
			h.view.trashViewClosed = true;
			h.random.dispose();
		} else {
			await h.edit(h.memos[0]!, "newest");
		}
		const committed = h.random.getSnapshot().memos;
		gate.resolve(before);
		await pending;
		assert.equal(h.random.getSnapshot().memos, committed);
		if (!close) assert.equal(committed![0]!.contentSnapshot, "newest");
	}
});

test("重逢复核固定实际送检成员，等待期间解除提交保护不移除未送检卡片", async t => {
	const h = await fixture({ immediate: true });
	h.failCatalog();
	await h.command.create("confirmed creation");
	const before = h.random.getSnapshot().memos!;
	const gate = deferred<MemoViewItem[]>();
	t.mock.method(h.read, "readMemoItems", async () => assert.fail("本轮没有任何成员送检"));
	t.mock.method(h.read, "refreshMemoViews", async (memos: readonly MemoViewItem[]) => {
		assert.deepEqual(memos, []);
		return gate.promise;
	});
	const pending = h.view.refreshRandomReunionBatch();
	h.view.confirmedDailyMemos!.remove(PATH);
	gate.resolve([]); await pending;
	assert.equal(h.random.getSnapshot().memos!.length, 3);
	assert.deepEqual(h.random.getSnapshot().memos!.map(memo => memo.id), before.map(memo => memo.id));
	assert.equal(h.random.getSnapshot().error, null);
});

test("Knomo 编辑确认后仅文件头续写保留随机组原位成员，旧操作拒写且新卡可继续编辑", async t => {
	for (const header of ["---\nmodified: now\n---\n", "---\nmodified: later\nextra: value\n...\n"]) await t.test(header, async () => {
		const h = await fixture({ immediate: true });
		h.view.viewStateController.activeNav = "random";
		const selected = h.memos[2]!;
		await h.edit(selected, "edited second occurrence");
		const confirmed = h.random.getSnapshot().memos!;
		await h.externalReplace(header + h.body());
		await h.view.checkConfirmedDailyFile(PATH);
		assert.equal(h.random.getSnapshot().memos!.length, 3, "磁盘通知不能先移除再加回成员");
		await h.view.refreshRandomReunionBatch();
		const current = h.random.getSnapshot().memos!;
		assert.deepEqual(current.map(memo => memo.contentSnapshot), ["old", "same", "edited second occurrence"]);
		assert.deepEqual(current.map(memo => memo.id), (await h.loadMemos()).map(memo => memo.id));
		assert.equal(h.random.getSnapshot().error, null);
		assert.equal(h.randomLoads(), 1);
		await assert.rejects(h.edit(confirmed[2]!, "stale"), /stale|revision|changed/iu);
		await h.edit(current[2]!, "next edit");
		assert.deepEqual(h.random.getSnapshot().memos!.map(memo => memo.contentSnapshot), ["old", "same", "next edit"]);
	});
});

test("随机组从真实卡片编辑保存接续 Catalog 前后文件头更新，索引等待时跨文件卡仍可操作", async t => {
	for (const order of ["before-publication", "after-publication"] as const) await t.test(order, async () => {
		const publication = deferred<void>(), confirmed = deferred<void>();
		const h = await fixture({ immediate: true, body: "## Memos\n- 10:00 same\n- 10:00 same\n", otherBody: "## Memos\n- 11:00 other file\n",
			catalogGate: publication.promise, rejectStalePublication: true, onConfirmed: () => confirmed.resolve() });
		h.view.viewStateController.activeNav = "random";
		const dom = attachCardFlow(h.view);
		try {
			const selected = h.memos[1]!;
			prepareComposer(h.view, "edited B", selected);
			await h.view.saveInput(); await confirmed.promise;
			const edited = h.random.getSnapshot().memos![1]!;
			assert.deepEqual(h.random.getSnapshot().memos!.map(memo => memo.contentSnapshot), ["same", "edited B", "other file"]);
			if (order === "after-publication") { publication.resolve(); await h.view.composerSaveRefreshQueue; }
			const latest = "---\nmodified: first\n---\n" + h.body();
			h.vault.replace(PATH, latest);
			await h.view.checkConfirmedDailyFile(PATH);
			dom.render();
			assert.equal(dom.root.querySelectorAll(".knomo-card").length, 3);
			assert.equal(dom.root.querySelectorAll("[data-knomo-readonly-transition]").length, 2);
			assert.equal(dom.findMemo(edited.id), null);
			assert.equal(dom.findMemo(h.memos[2]!.id)?.contentSnapshot, "other file");
			await h.view.refreshRandomReunionBatch();
			assert.equal(h.random.getSnapshot().memos!.length, 3);
			assert.equal(h.random.getSnapshot().error, null);
			publication.resolve(); await h.view.composerSaveRefreshQueue;
			await h.externalReplace(latest.replace("modified: first", "modified: second\nadded: true"));
			// Catalog 通知先到也必须读取当前 Daily，不能先移除旧成员。
			await h.view.refreshRandomReunionBatch(); dom.render();
			const current = h.random.getSnapshot().memos!;
			assert.deepEqual(current.map(memo => memo.contentSnapshot), ["same", "edited B", "other file"]);
			assert.equal(new Set(current.map(memo => memo.id)).size, 3);
			assert.equal(dom.root.querySelectorAll("[data-knomo-readonly-transition]").length, 0);
			assert.equal(dom.findMemo(current[1]!.id), current[1]);
			assert.equal(h.random.getSnapshot().error, null);
			assert.equal(h.randomLoads(), 1);
			await assert.rejects(h.edit(edited, "stale menu"), /stale|revision|changed/iu);
			await h.edit(current[1]!, "B next");
			assert.deepEqual(h.random.getSnapshot().memos!.map(memo => memo.contentSnapshot), ["same", "B next", "other file"]);
		} finally { publication.resolve(); await h.view.composerSaveRefreshQueue; dom.dispose(); }
	});
});

test("随机组文件头续接拒绝正文、空白、分隔线、重排、删除和未闭合文件头的变化", async t => {
	const mutations = [
		(body: string) => body.replace("edited B", "external B"),
		(body: string) => body + "\n",
		(body: string) => body + "---\n",
		(body: string) => body.replace("- 10:00 same\n- 10:00 edited B", "- 10:00 edited B\n- 10:00 same"),
		(body: string) => body.replace("- 10:00 edited B\n", ""),
		(body: string) => "---\nmodified: no closing delimiter\n" + body,
	];
	for (const [index, mutate] of mutations.entries()) await t.test(String(index), async () => {
		const h = await fixture({ immediate: true, body: "## Memos\n- 10:00 same\n- 10:00 same\n", otherBody: "- 11:00 C\n" });
		h.view.viewStateController.activeNav = "random";
		await h.edit(h.memos[1]!, "edited B");
		const body = mutate(h.body());
		await h.externalReplace(index === mutations.length - 1 ? body : "---\nmodified: now\n---\n" + body);
		await h.view.checkConfirmedDailyFile(PATH);
		await h.view.refreshRandomReunionBatch();
		assert.deepEqual(h.random.getSnapshot().memos!.map(memo => memo.contentSnapshot), ["C"]);
		assert.ok(h.random.getSnapshot().error);
		assert.equal(h.randomLoads(), 1);
		await h.view.refreshRandomReunionBatch();
		assert.equal(h.random.getSnapshot().error, null, "无新增减员的成功复核清除上一次提示");
	});
});

test("随机组文件头复核读取失败保留可读成员，恢复后接纳；同字节通知不减员", async t => {
	const h = await fixture({ immediate: true, body: "## Memos\n- 10:00 same\n- 10:00 same\n", otherBody: "- 11:00 C\n" });
	h.view.viewStateController.activeNav = "random";
	await h.edit(h.memos[1]!, "edited B");
	const dom = attachCardFlow(h.view);
	try {
		await h.view.checkConfirmedDailyFile(PATH); await h.view.refreshRandomReunionBatch();
		assert.equal(h.random.getSnapshot().memos!.length, 3);
		assert.equal(h.random.getSnapshot().error, null);
		await h.externalReplace("---\nmodified: now\n---\n" + h.body());
		const app = Reflect.get(h.view, "app") as import("obsidian").App;
		const read = app.vault.read.bind(app.vault);
		const failure = t.mock.method(app.vault, "read", async (file: TFile) => {
			if (file.path === PATH) throw new Error("temporary read failure");
			return read(file);
		});
		Object.assign(h.view, { reportViewRefreshFailure: () => {} });
		await h.view.checkConfirmedDailyFile(PATH); await h.view.refreshRandomReunionBatch(); dom.render();
		assert.equal(h.random.getSnapshot().memos!.length, 3);
		assert.equal(dom.root.querySelectorAll("[data-knomo-readonly-transition]").length, 2);
		assert.equal(dom.findMemo(h.memos[2]!.id)?.contentSnapshot, "C");
		assert.ok(h.random.getSnapshot().error);
		failure.mock.restore();
		await h.view.checkConfirmedDailyFile(PATH); await h.view.refreshRandomReunionBatch(); dom.render();
		assert.deepEqual(h.random.getSnapshot().memos!.map(memo => memo.id), (await h.loadMemos()).map(memo => memo.id));
		assert.equal(dom.root.querySelectorAll("[data-knomo-readonly-transition]").length, 0);
		assert.equal(h.random.getSnapshot().error, null);
	} finally { dom.dispose(); }
});

test("随机组复核期间再次写文件头、换组或关闭，旧结果不能回写或留下提示", async t => {
	for (const action of ["rewrite", "next-batch", "close"] as const) await t.test(action, async () => {
		const h = await fixture({ immediate: true });
		await h.edit(h.memos[2]!, "edited B");
		await h.externalReplace("---\nmodified: first\n---\n" + h.body());
		const gate = deferred<void>(), entered = deferred<void>();
		const read = h.read.readMemoItems.bind(h.read);
		const delayed = t.mock.method(h.read, "readMemoItems", async (...args: Parameters<typeof read>) => {
			const result = await read(...args); entered.resolve(); await gate.promise; return result;
		});
		const pending = h.view.refreshRandomReunionBatch(); await entered.promise;
		delayed.mock.restore();
		if (action === "rewrite") {
			await h.externalReplace(h.body().replace("modified: first", "modified: second\nextra: true"));
			await h.view.checkConfirmedDailyFile(PATH);
		} else if (action === "next-batch") await h.random.refresh();
		else { h.view.trashViewClosed = true; h.random.dispose(); }
		const current = h.random.getSnapshot().memos;
		gate.resolve(); await pending;
		assert.equal(h.random.getSnapshot().memos, current);
		assert.equal(h.random.getSnapshot().error, null);
		if (action === "rewrite") {
			await h.view.refreshRandomReunionBatch();
			assert.deepEqual(h.random.getSnapshot().memos!.map(memo => memo.id), (await h.loadMemos()).map(memo => memo.id));
			assert.equal(h.randomLoads(), 1);
		}
	});
});

test("Catalog 读取校验完整句柄并拒绝读取期间发生的 revision 变化", async t => {
	const h = await fixture();
	const handle = h.memos[0]!.catalog!.observationHandle;
	await assert.rejects(h.read.readMemoItems([{ ...handle, rawBlockHash: "wrong" }]), /snapshot changed/iu);
	const read = h.catalog.readObservationSnapshot.bind(h.catalog);
	let changed = false;
	t.mock.method(h.catalog, "readObservationSnapshot", async (keys: readonly string[]) => {
		const snapshot = await read(keys);
		if (!changed) {
			changed = true;
			await h.externalReplace("## Memos\n- 09:00 replaced\n- 10:00 same\n");
		}
		return snapshot;
	});
	await assert.rejects(h.read.readMemoItems([handle]), /snapshot changed/iu);
});

test("Catalog 后续失败不回滚已写入的 Daily，旧展示失效并可重新抽样", async () => {
	const h = await fixture();
	h.failCatalog();
	const result = await h.edit(h.memos[0]!, "written");
	assert.equal(result.localRefreshPending, true);
	assert.match(h.body(), /written/u);
	await h.view.finishComposerSave(Promise.resolve(result), h.memos[0]!);
	assert.deepEqual(h.random.getSnapshot().memos, []);
	await h.externalReplace(h.body());
	await h.random.refresh();
	assert.equal(h.random.getSnapshot().memos![0]!.contentSnapshot, "written");
});

test("一个打开页面的展示失败不阻断其它页面，也不改变正文成功状态", async t => {
	const h = await fixture();
	const other = await h.createView();
	t.mock.method(console, "error", () => undefined);
	t.mock.method(h.view, "handleDailyMemoPresentationChange", async () => { throw new Error("view failed"); });
	const result = await h.edit(h.memos[0]!, "saved");
	assert.equal(result.localRefreshPending, false);
	assert.match(h.body(), /saved/u);
	assert.equal(other.random.getSnapshot().memos![0]!.contentSnapshot, "saved");
});

test("侧栏与记录统计返回均校验重逢缓存，漫游重载原选中日期", async t => {
	for (const route of ["sidebar", "stats"] as const) {
		for (const nav of ["random", "shuffleDay"] as const) {
			const h = await fixture();
			const state = h.view.viewStateController;
			if (route === "stats") { state.setSidebarNav(nav); state.setSidebarNav("record-stats"); }
			Object.assign(h.view, {
				clearSearchDebounce: () => {}, applyViewStateTransitionEffects: () => {},
				getCardFlowViewStateKey: () => "", getCardFlowChangeIntent: () => "view-scope-change",
				cancelCatalogDesktopCount: () => {},
			});
			let pending: Promise<unknown> | undefined;
			if (nav === "random") {
				const refresh = h.view.refreshRandomReunionBatch.bind(h.view);
				t.mock.method(h.view, "refreshRandomReunionBatch", () => { pending = refresh(); return pending as Promise<void>; });
			} else {
				const reload = h.shuffle.reloadSelectedDate.bind(h.shuffle);
				t.mock.method(h.shuffle, "reloadSelectedDate", () => { pending = reload(); return pending as Promise<boolean>; });
			}
			await h.externalReplace("## Memos\n- 09:00 external\n- 10:00 same\n- 10:00 same\n");
			if (route === "stats") h.view.returnFromRecordStats();
			else h.view.setSidebarNav(nav);
			assert.ok(pending);
			await pending;
			assert.equal(state.activeNav, nav);
			if (nav === "random") assert.deepEqual(h.random.getSnapshot().memos, []);
			else {
				assert.equal(h.shuffle.getSnapshot().selectedDate, DATE);
				assert.equal(h.shuffle.getSnapshot().memos[0]!.contentSnapshot, "external");
			}
			assert.equal(h.randomLoads(), 1);
		}
	}
});

test("Catalog 已发布但提交通知尚未结束时普通刷新不抢先移除本组卡片", async () => {
	const h = await fixture();
	const published = deferred<void>(), release = deferred<void>();
	h.afterCatalogPublished(async () => { published.resolve(); await release.promise; });
	const saving = h.edit(h.memos[0]!, "latest");
	await published.promise;
	const refresh = h.view.refreshRandomReunionBatch();
	await new Promise<void>(resolve => setImmediate(resolve));
	release.resolve();
	await saving;
	await refresh;
	assert.deepEqual(h.random.getSnapshot().memos!.map(memo => memo.contentSnapshot), ["latest", "same", "same"]);
	assert.equal(h.randomLoads(), 1);
});

test("提交使尚未完成的首次重逢和漫游抽样失效，下一次刷新取得当前正文", async () => {
	for (const nav of ["random", "shuffleDay"] as const) {
		const h = await fixture();
		const gate = deferred<MemoViewItem[]>();
		h.setDiscoveryGate(gate.promise);
		h.view.viewStateController.activeNav = nav;
		if (nav === "random") h.random.clearMemos();
		else h.shuffle.clearSelection();
		const loading = nav === "random" ? h.random.refresh() : h.shuffle.refresh();
		await h.edit(h.memos[0]!, "latest");
		gate.resolve(h.memos);
		await loading;
		const shown = nav === "random" ? h.random.getSnapshot().memos : h.shuffle.getSnapshot().memos;
		assert.ok(!shown?.some(memo => memo.contentSnapshot === "old"));
		h.setDiscoveryGate(null);
		await h.view.refresh();
		const refreshed = nav === "random" ? h.random.getSnapshot().memos : h.shuffle.getSnapshot().memos;
		assert.equal(refreshed![0]!.contentSnapshot, "latest");
	}
});

test("迟到的编辑和任务定点读取拒绝旧版本时保留最新卡片", async t => {
	for (const kind of ["composer", "task"] as const) {
		const h = await fixture({ body: "## Memos\n- 09:00 - [ ] todo @2026-10-10\n- 10:00 same\n" });
		h.view.memos = [...h.memos];
		await h.buoy.loadInitial();
		h.view.catalogTodayTimeBuoys = h.buoy.getSnapshot();
		const original = h.memos[0]!;
		const entered = deferred<void>(), release = deferred<void>();
		const read = h.command.getReadService(), readItems = read.readMemoItems.bind(read);
		let first = true;
		t.mock.method(read, "readMemoItems", async (handles: Parameters<typeof readItems>[0]) => {
			if (first) { first = false; entered.resolve(); await release.promise; }
			return readItems(handles);
		});
		const finishing = kind === "composer"
			? h.view.finishComposerSave(h.edit(original, "first @2026-10-10"), original)
			: h.view.handleCatalogTaskToggle(original, 0, true);
		await entered.promise;
		try {
			await h.edit(h.random.getSnapshot().memos![0]!, "newest @2026-10-10");
		} finally { release.resolve(); }
		await finishing;
		const expected = (await h.loadMemos()).map(memo => memo.id);
		assert.deepEqual(h.random.getSnapshot().memos!.map(memo => memo.id), expected);
		assert.deepEqual(h.shuffle.getSnapshot().memos.map(memo => memo.id), expected);
		assert.deepEqual(h.view.memos.map(memo => memo.id), expected);
		assert.equal(h.buoy.getSnapshot().today[0]!.memo.contentSnapshot, "newest @2026-10-10");
		assert.equal(h.view.catalogTodayTimeBuoys!.today[0]!.memo.contentSnapshot, "newest @2026-10-10");
		assert.equal(h.randomLoads(), 1);
	}
});

test("迟到的成功保存结果不向漫游追加旧版本", async () => {
	const h = await fixture();
	const original = h.memos[0]!;
	const first = await h.edit(original, "first");
	await h.edit(h.random.getSnapshot().memos![0]!, "newest");
	await h.view.finishComposerSave(Promise.resolve(first), original);
	assert.deepEqual(h.shuffle.getSnapshot().memos.map(memo => memo.id), (await h.loadMemos()).map(memo => memo.id));
	assert.equal(h.shuffle.getSnapshot().stats?.memoCount, 3);
	assert.equal(h.random.getSnapshot().memos![0]!.contentSnapshot, "newest");
});

test("广播完成后保存回调不重复加载列表或漫游", async t => {
	const h = await fixture();
	h.view.viewStateController.activeNav = "shuffleDay";
	const result = await h.edit(h.memos[0]!, "saved");
	const list = t.mock.method(h.view, "reloadMemos", async () => true);
	const shuffle = t.mock.method(h.shuffle, "reloadSelectedDate", async () => true);
	await h.view.finishComposerSave(Promise.resolve(result), h.memos[0]!);
	assert.equal(list.mock.callCount(), 0);
	assert.equal(shuffle.mock.callCount(), 0);
});

const DATE = "2026-08-22";
const PATH = "Daily/" + DATE + ".md";

test("配置变化后迟到的 Catalog 读取失败不能清空当前展示", async () => {
	const h = await fixture();
	const started = deferred<void>(), gate = deferred<void>();
	h.read.readMemoItems = async () => { started.resolve(); await gate.promise; throw new Error("Catalog unavailable"); };
	let renders = 0;
	Object.assign(h.view, { renderUiState: () => { renders++; } });
	const original = h.random.getSnapshot().memos!;
	const saving = h.edit(h.memos[0]!, "changed before configuration invalidation");
	await started.promise;
	h.view.invalidateConfirmedDailyMemos();
	gate.resolve();
	await saving;
	assert.deepEqual(h.random.getSnapshot().memos, original);
	assert.equal(renders, 0);
});

test("Daily 确认后新建卡片与输入清空同时完成，不等待 Catalog", async () => {
	const gate = deferred<void>();
	const h = await fixture({ immediate: true, catalogGate: gate.promise });
	prepareComposer(h.view, "new immediate memo");
	try {
		await h.view.saveInput();
		assert.equal(h.view.inputEl!.value, "");
		assert.equal(h.view.getFilteredMemos().some(memo => memo.contentSnapshot === "new immediate memo"), true);
		assert.equal((await h.loadMemos()).some(memo => memo.contentSnapshot === "new immediate memo"), false);
	} finally { gate.resolve(); }
	await h.view.composerSaveRefreshQueue;
	assert.equal(h.view.memos.filter(memo => memo.contentSnapshot === "new immediate memo").length, 1);
});

test("新建不匹配当前标签时保存和索引接续均不重绘卡片，也不撤下筛选计数", async () => {
	const gate = deferred<void>();
	const h = await fixture({ immediate: true, catalogGate: gate.promise, body: "## Memos\n- 09:00 kept #keep\n" });
	h.view.viewStateController.activeTag = "keep";
	h.view.viewStateController.activeTagKey = "keep";
	let renders = 0;
	Object.assign(h.view, { catalogDesktopTotalCount: 1, renderUiState: (options?: { renderCardFlow?: boolean }) => {
		if (options?.renderCardFlow !== false) renders++;
	} });
	prepareComposer(h.view, "new #other");
	try {
		await h.view.saveInput();
		assert.equal(renders, 0);
		assert.deepEqual(h.view.getFilteredMemos().map(memo => memo.contentSnapshot), ["kept #keep"]);
		assert.equal((h.view as unknown as { catalogDesktopTotalCount: number }).catalogDesktopTotalCount, 1);
	} finally { gate.resolve(); }
	await h.view.composerSaveRefreshQueue;
	await h.view.refresh();
	assert.equal(renders, 0);
});

test("被引用固定筛选和钻取保存普通 Memo 时，Catalog 挂起或失败均不加入未经关系确认的记录", async () => {
	for (const scope of [false, true]) for (const failed of [false, true]) {
		const gate = deferred<void>();
		const h = await fixture({ immediate: true, catalogGate: gate.promise, body: "## Memos\n- 09:00 target ^a\n- 10:00 source [[#^a]]\n" });
		h.view.memos = [h.memos[0]!];
		if (scope) h.view.viewStateController.scopeFilter = "referenced";
		else h.view.viewStateController.recordStatsSearchFilter = { type: "referenced", startDate: "1900-01-01", endDateExclusive: "2099-01-01" };
		h.view.reloadMemos = async () => {
			const { toCatalogMemoView } = await import("../src/types/memoView");
			h.view.memos = (await h.read.query({ hasReferrers: true, limit: 20 })).items.map(toCatalogMemoView);
			return true;
		};
		if (failed) h.failCatalog();
		prepareComposer(h.view, "unreferenced new memo");
		try {
			await h.view.saveInput();
			assert.deepEqual(h.view.getFilteredMemos().map(memo => memo.contentSnapshot), ["target"]);
		} finally { gate.resolve(); }
		await h.view.composerSaveRefreshQueue;
		assert.deepEqual(h.view.getFilteredMemos().map(memo => memo.contentSnapshot), ["target"]);
		assert.match(h.body(), /unreferenced new memo/u);
	}
});

test("多页被引用筛选保存普通 Memo 后保留摘要与卡片，计数接续失败才撤下旧数量", async t => {
	for (const scope of [false, true]) for (const countFails of [false, true]) {
		const catalogGate = deferred<void>(), countGate = deferred<void>();
		const body = "## Memos\n" + Array.from({ length: 60 }, (_, index) => `- 09:00 target-${index} ^a-${index}\n`).join("")
			+ "- 10:00 source " + Array.from({ length: 60 }, (_, index) => `[[#^a-${index}]]`).join(" ") + "\n";
		const h = await fixture({ immediate: true, catalogGate: catalogGate.promise, body });
		const { toCatalogMemoView } = await import("../src/types/memoView");
		const { getMemoListStateKey } = await import("../src/ui/MemoRenderRevision");
		if (scope) h.view.viewStateController.scopeFilter = "referenced";
		else h.view.viewStateController.recordStatsSearchFilter = { type: "referenced", startDate: "1900-01-01", endDateExclusive: "2099-01-01" };
		const production = Object.getPrototypeOf(h.view);
		const query = production.buildCatalogActiveQuery.call(h.view, true);
		const initial = await h.read.query({ ...query, limit: 50 });
		assert.equal(initial.items.length, 50);
		h.view.memos = initial.items.map(toCatalogMemoView);
		h.view.viewStateController.search.commitResult(query, initial.catalogRevision, "complete");
		let counting: Promise<void> | null = null;
		Object.assign(h.view, {
			memoSourceGeneration: 0, catalogDesktopCountRun: 0, catalogDesktopTotalCount: 60,
			catalogDesktopQueryFingerprint: production.getCatalogQueryFingerprint.call(h.view, true),
			catalogCoverage: initial.coverage, catalogRevision: initial.catalogRevision, catalogStatus: initial.status,
			cardFlowError: null, shouldShowTodayTimeBuoys: () => false,
			trashMemoController: { getSnapshot: () => ({ trashLoading: false, trashError: null, trashMemos: [] }) },
			getCatalogReadService: () => h.read, reloadMemos: production.reloadMemos,
			retainMemoCardPreviews: () => {}, syncRecordStatsSource: () => {}, refreshCatalogLibraryIndexes: async () => {},
			syncSearchControls: () => {}, getMobileSearchStateKey: () => "closed", renderMobileSearchResultsIfChanged: () => {},
			invalidateRecordStats: () => {}, recordStatsViewStateController: { clearRendered: () => {} }, refreshCatalogActiveQuery: () => {},
			countCatalogFeature: async () => { await countGate.promise; if (countFails) throw new Error("count failed"); return h.read.count(query); },
			refreshCatalogDesktopTotalCount: (...args: unknown[]) => {
				counting = production.refreshCatalogDesktopTotalCount.apply(h.view, args) as Promise<void>; return counting;
			},
		});
		const dom = attachCardFlow(h.view, false, true);
		Object.assign(h.view, { getCardFlowStateKey: () => {
			const presentation = h.view.getCurrentCardFlowPresentation();
			return JSON.stringify([presentation.type, presentation.type === "items" ? getMemoListStateKey(presentation.memos) : "", presentation.headers]);
		} });
		const summary = dom.root.querySelector(".knomo-relation-result-count")!;
		const card = dom.root.querySelector(".knomo-card")!, image = card.querySelector("img");
		assert.ok(summary);
		const unsubscribe = h.read.relations.subscribe(() => production.onMemoRelationsChanged.call(h.view));
		if (countFails) t.mock.method(console, "warn", () => {});
		prepareComposer(h.view, "ordinary new memo");
		try {
			await h.view.saveInput();
			assert.equal(dom.root.querySelector(".knomo-relation-result-count"), summary);
			catalogGate.resolve(); await h.view.composerSaveRefreshQueue;
			assert.equal(dom.root.querySelector(".knomo-relation-result-count"), summary);
			await h.view.refresh();
			assert.ok(counting);
			assert.equal(dom.root.querySelector(".knomo-relation-result-count"), summary, "首屏已返回、计数仍在查询时不撤下摘要");
			countGate.resolve(); await counting;
			assert.equal(dom.root.querySelector(".knomo-relation-result-count"), summary);
			if (countFails) assert.equal(summary.querySelector(".knomo-result-summary-count")!.getAttribute("data-state"), "unavailable");
			assert.equal(card.parentElement, dom.root);
			assert.equal(card.querySelector("img"), image);
			assert.equal(h.view.getFilteredMemos().some(memo => memo.contentSnapshot === "ordinary new memo"), false);
		} finally { unsubscribe(); catalogGate.resolve(); countGate.resolve(); await counting; dom.dispose(); }
	}
});

test("多页列表深处编辑经实际保存广播和后台刷新后保留窗口、卡片与新分页", async t => {
	t.mock.timers.enable({ apis: ["Date"], now: new Date(2026, 10, 22, 12).getTime() });
	for (const scope of ["all", "things", "review", "tag", "search", "stats"] as const) await t.test(scope, async () => {
		const h = await fixture({ immediate: true, refreshViews: true,
			body: "## Memos\n" + Array.from({ length: 160 }, (_, index) => `- 09:00 - [ ] kept-${index} #keep\n`).join("") });
		const { toCatalogMemoView } = await import("../src/types/memoView");
		const { getMemoListStateKey } = await import("../src/ui/MemoRenderRevision");
		const production = Object.getPrototypeOf(h.view);
		const state = h.view.viewStateController;
		if (scope === "things" || scope === "review") state.activeNav = scope;
		if (scope === "tag") { state.activeTag = "keep"; state.activeTagKey = "keep"; }
		if (scope === "search") state.searchQuery = "kept";
		if (scope === "stats") state.recordStatsSearchFilter = { type: "tag", tagKey: "keep", tagLabel: "keep", startDate: DATE, endDateExclusive: "2026-08-23" };
		const query = production.buildCatalogActiveQuery.call(h.view, true);
		let page = await h.read.query({ ...query, limit: 50 });
		const items = [...page.items];
		for (let index = 1; index < 3; index++) {
			page = await h.read.query({ ...query, limit: 50, cursor: page.nextCursor });
			items.push(...page.items);
		}
		h.view.memos = items.map(toCatalogMemoView);
		assert.equal(h.view.memos.length, 150);
		state.search.commitResult(query, page.catalogRevision, "complete");
		Object.assign(h.view, {
			memoSourceGeneration: 0, catalogDesktopCountRun: 0, catalogCursor: page.nextCursor,
			catalogDesktopQueryFingerprint: production.getCatalogQueryFingerprint.call(h.view, true),
			catalogCoverage: page.coverage, catalogRevision: page.catalogRevision, catalogStatus: page.status,
			cardFlowError: null, shouldShowTodayTimeBuoys: () => false,
			trashMemoController: { getSnapshot: () => ({ trashLoading: false, trashError: null, trashMemos: [] }) },
			getCatalogReadService: () => h.read, reloadMemos: production.reloadMemos,
			retainMemoCardPreviews: () => {}, syncRecordStatsSource: () => {}, refreshCatalogLibraryIndexes: async () => {},
			syncSearchControls: () => {}, getMobileSearchStateKey: () => "closed", renderMobileSearchResultsIfChanged: () => {},
			refreshCatalogDesktopTotalCount: async () => {}, renderNextCardBatch: () => {},
			getCardFlowStateKey: () => getMemoListStateKey(h.view.getFilteredMemos()),
		});
		const dom = attachCardFlow(h.view);
		Object.assign(h.view, { getInitialCardBatchSize: () => 150 }); dom.render();
		const stable = dom.root.querySelectorAll(".knomo-card")[110]!;
		try {
			for (const index of [90, 130]) {
				const memo = h.view.memos[index]!;
				prepareComposer(h.view, memo.contentSnapshot + " edited", memo);
				await h.view.saveInput(); await h.view.composerSaveRefreshQueue; await h.waitForViewRefresh();
				assert.equal(h.view.memos.length, 150, "后台首批不能覆盖原来已读取的三页");
				assert.equal(dom.root.querySelectorAll(".knomo-card").length, 150);
				assert.match(h.view.memos[index]!.contentSnapshot, / edited$/);
				assert.equal(dom.root.querySelectorAll(".knomo-card")[110], stable, "未编辑的深处卡片沿提交映射复用");
			}
			await production.restoreCardFlowAfterMobileSearch.call(h.view);
			assert.equal(h.view.memos.length, 150, "搜索返回也保留同范围的已展开窗口");
			const deleted = h.view.memos[120]!;
			Object.assign(h.view, { closeCardMenu: () => {} });
			await production.handleMemoAction.call(h.view, "delete", deleted); await h.waitForViewRefresh();
			assert.equal(h.view.memos.length, 150, "真实菜单删除、本页收尾与跨页广播不能收起已读窗口");
			assert.equal(h.view.memos.some(memo => memo.contentSnapshot === deleted.contentSnapshot), false);
			assert.equal(await production.loadNextCatalogPage.call(h.view), true);
			assert.equal(h.view.memos.length, 159);
			assert.equal(new Set(h.view.memos.map(memo => memo.id)).size, 159);
		} finally { dom.dispose(); }
	});
});

test("Things 任务提交在 Daily、Catalog 和真实分页计数接续中保留摘要，连续修改也可收尾", async () => {
	for (const tagged of [false, true]) for (const total of [2, 51]) {
		const catalogGate = deferred<void>(), countGate = deferred<void>();
		const h = await fixture({ immediate: true, catalogGate: catalogGate.promise,
			body: "## Memos\n" + Array.from({ length: total }, (_, index) => `- 09:00 - [ ] task-${index}${tagged ? " #keep" : ""}\n`).join("") });
		const { toCatalogMemoView } = await import("../src/types/memoView");
		const production = Object.getPrototypeOf(h.view);
		h.view.viewStateController.activeNav = "things";
		if (tagged) { h.view.viewStateController.activeTag = "keep"; h.view.viewStateController.activeTagKey = "keep"; }
		const query = production.buildCatalogActiveQuery.call(h.view, true);
		const initial = await h.read.query({ ...query, limit: 50 });
		h.view.memos = initial.items.map(toCatalogMemoView);
		h.view.viewStateController.search.commitResult(query, initial.catalogRevision, "complete");
		const counts: Promise<void>[] = [];
		Object.assign(h.view, {
			memoSourceGeneration: 0, catalogDesktopCountRun: 0, catalogDesktopTotalCount: total,
			catalogDesktopQueryFingerprint: production.getCatalogQueryFingerprint.call(h.view, true),
			catalogCoverage: initial.coverage, catalogRevision: initial.catalogRevision, catalogStatus: initial.status,
			cardFlowError: null, shouldShowTodayTimeBuoys: () => false,
			trashMemoController: { getSnapshot: () => ({ trashLoading: false, trashError: null, trashMemos: [] }) },
			getCatalogReadService: () => h.read, reloadMemos: production.reloadMemos,
			retainMemoCardPreviews: () => {}, syncRecordStatsSource: () => {}, refreshCatalogLibraryIndexes: async () => {},
			syncSearchControls: () => {}, getMobileSearchStateKey: () => "closed", renderMobileSearchResultsIfChanged: () => {},
			countCatalogFeature: async () => { const result = await h.read.count(query); await countGate.promise; return result; },
			refreshCatalogDesktopTotalCount: (...args: unknown[]) => {
				const promise = production.refreshCatalogDesktopTotalCount.apply(h.view, args) as Promise<void>; counts.push(promise); return promise;
			},
		});
		const dom = attachCardFlow(h.view, false, true), summary = dom.root.querySelector(".knomo-list-summary")!;
		Object.assign(h.view, { getCardFlowStateKey: () => JSON.stringify(h.view.getCurrentCardFlowPresentation()) });
		const observer = new dom.window.MutationObserver(() => {}); observer.observe(dom.root, { childList: true, subtree: true });
		let toggling: Promise<unknown> | null = null;
		try {
			toggling = h.view.handleCatalogTaskToggle(h.view.memos[0]!, 0, true);
			await new Promise<void>(resolve => setImmediate(resolve)); await Reflect.get(h.view, "presentationChangeQueue");
			assert.match(h.body(), /\[x\]/);
			assert.equal(Reflect.get(h.view, "catalogDesktopTotalCount"), null);
			assert.equal(dom.root.querySelector(".knomo-list-summary"), summary);
			catalogGate.resolve(); await toggling; await h.view.refresh();
			assert.equal(dom.root.querySelector(".knomo-list-summary"), summary);
			await h.view.handleCatalogTaskToggle(h.view.memos[0]!, 0, false); await h.view.refresh();
			assert.equal(dom.root.querySelector(".knomo-list-summary"), summary);
			countGate.resolve(); await Promise.all(counts);
			assert.equal(Reflect.get(h.view, "catalogDesktopTotalCount"), total);
			assert.match(summary.textContent!, new RegExp(String(total)));
			assert.equal(counts.length > 0, total > 50);
			assert.ok(!observer.takeRecords().some(record => Array.from(record.removedNodes).includes(summary)));
		} finally { catalogGate.resolve(); countGate.resolve(); await toggling; await Promise.all(counts); observer.disconnect(); dom.dispose(); }
	}
});

test("新建匹配当前标签时只触发一次增量展示，索引接续不重复重绘", async () => {
	const gate = deferred<void>();
	const h = await fixture({ immediate: true, catalogGate: gate.promise, body: "## Memos\n- 09:00 kept #keep\n" });
	h.view.viewStateController.activeTag = "keep";
	h.view.viewStateController.activeTagKey = "keep";
	let renders = 0;
	Object.assign(h.view, { catalogDesktopTotalCount: 1, renderUiState: (options?: { renderCardFlow?: boolean }) => {
		if (options?.renderCardFlow !== false) renders++;
	} });
	prepareComposer(h.view, "new #keep");
	try {
		await h.view.saveInput();
		assert.equal(renders, 1);
		assert.equal((h.view as unknown as { catalogDesktopTotalCount: number }).catalogDesktopTotalCount, 2);
		assert.deepEqual(h.view.getFilteredMemos().map(memo => memo.contentSnapshot), ["new #keep", "kept #keep"]);
	} finally { gate.resolve(); }
	await h.view.composerSaveRefreshQueue;
	assert.equal(renders, 1);
});

test("桌面搜索、标签、分类与统计筛选保存后原位接续摘要，保留原卡片与图片", async () => {
	const range = { startDate: "2026-08-01", endDateExclusive: "2026-09-01" };
	const scenarios: Array<{
		query?: string; scope?: "no-tag" | "with-link" | "with-image"; tag?: string;
		stats?: import("../src/ui/viewFilters").RecordStatsSearchFilter;
	}> = [
		{ query: "kept" }, { tag: "keep" }, { scope: "no-tag" }, { scope: "with-link" }, { scope: "with-image" },
		{ stats: { type: "day", date: DATE } }, { stats: { type: "month", month: "2026-08" } },
		...["range", "with-tag", "no-tag", "with-image", "references"].map(type => ({
			stats: { type, ...range } as import("../src/ui/viewFilters").RecordStatsSearchFilter,
		})),
		{ stats: { type: "hour", ...range, hour: 9 } },
		{ stats: { type: "tag", ...range, tagKey: "keep", tagLabel: "keep" } },
		{ stats: { type: "max-daily-notes", dates: [DATE] } }, { stats: { type: "max-daily-words", dates: [DATE] } },
		{ query: "kept", tag: "keep", stats: { type: "with-image", ...range } },
	];
	for (const scenario of scenarios) {
		const gate = deferred<void>();
		const untagged = scenario.scope === "no-tag" || scenario.stats?.type === "no-tag";
		const h = await fixture({ immediate: true, catalogGate: gate.promise,
			body: `## Memos\n- 09:00 kept ${untagged ? "" : "#keep"} [[target#^block]] ![[image.png]]\n` });
		const state = h.view.viewStateController;
		state.search.updateDraft(scenario.query ?? ""); state.search.submit();
		state.activeTag = scenario.tag ?? null; state.activeTagKey = scenario.tag ?? null;
		state.scopeFilter = scenario.scope ?? "all"; state.recordStatsSearchFilter = scenario.stats ?? null;
		Object.assign(h.view, { catalogDesktopTotalCount: 1, cardFlowError: null, shouldShowTodayTimeBuoys: () => false,
			catalogCoverage: (await h.read.query({ limit: 20 })).coverage,
			catalogStatus: { content: "ready", catalog: "complete", projection: "ready" },
			trashMemoController: { getSnapshot: () => ({ trashLoading: false, trashError: null, trashMemos: [] }) } });
		assert.equal(h.view.getCurrentCardFlowPresentation().type, "items", JSON.stringify(scenario));
		const dom = attachCardFlow(h.view, false, true);
		const summary = dom.root.querySelector(".knomo-list-summary"), card = dom.root.querySelector(".knomo-card")!;
		const image = card.querySelector("img");
		assert.ok(summary, JSON.stringify(scenario));
		prepareComposer(h.view, "ordinary #other");
		try {
			await h.view.saveInput();
			assert.equal(dom.root.querySelector(".knomo-list-summary"), summary, JSON.stringify(scenario));
			gate.resolve(); await h.view.composerSaveRefreshQueue;
			assert.equal(dom.root.querySelector(".knomo-list-summary"), summary);
			assert.equal(card.parentElement, dom.root);
			assert.equal(card.querySelector("img"), image);
		} finally { gate.resolve(); await h.view.composerSaveRefreshQueue; dom.dispose(); }
	}
});

test("超过一页的有链接视图在顶部保存无链接 Memo 后保留摘要与首屏卡片", async () => {
	const catalogGate = deferred<void>(), countGate = deferred<void>();
	const body = "## Memos\n" + Array.from({ length: 150 }, (_, index) => `- 09:00 kept-${index} [[target]]\n`).join("");
	const h = await fixture({ immediate: true, catalogGate: catalogGate.promise, body });
	const { toCatalogMemoView } = await import("../src/types/memoView");
	const { getMemoListStateKey } = await import("../src/ui/MemoRenderRevision");
	h.view.viewStateController.scopeFilter = "with-link";
	const initial = await h.read.query({ hasLink: true, limit: 50 });
	h.view.memos = initial.items.map(toCatalogMemoView);
	const production = Object.getPrototypeOf(h.view);
	const query = production.buildCatalogActiveQuery.call(h.view, true);
	let counting: Promise<void> | null = null;
	h.view.viewStateController.search.commitResult(query, initial.catalogRevision, "complete");
	Object.assign(h.view, {
		memoSourceGeneration: 0, catalogDesktopCountRun: 0, catalogDesktopTotalCount: 150,
		catalogDesktopQueryFingerprint: production.getCatalogQueryFingerprint.call(h.view, true),
		catalogCoverage: initial.coverage, catalogRevision: initial.catalogRevision, catalogStatus: initial.status,
		cardFlowError: null, shouldShowTodayTimeBuoys: () => false,
		trashMemoController: { getSnapshot: () => ({ trashLoading: false, trashError: null, trashMemos: [] }) },
		getCatalogReadService: () => h.read, reloadMemos: production.reloadMemos,
		retainMemoCardPreviews: () => {}, syncRecordStatsSource: () => {}, refreshCatalogLibraryIndexes: async () => {},
		syncSearchControls: () => {}, getMobileSearchStateKey: () => "closed", renderMobileSearchResultsIfChanged: () => {},
		countCatalogFeature: async () => { await countGate.promise; return h.read.count(query); },
		refreshCatalogDesktopTotalCount: (...args: unknown[]) => {
			counting = production.refreshCatalogDesktopTotalCount.apply(h.view, args) as Promise<void>;
			return counting;
		},
	});
	const dom = attachCardFlow(h.view);
	const stateKey = () => {
		const presentation = h.view.getCurrentCardFlowPresentation();
		return JSON.stringify([presentation.type, presentation.type === "items" ? getMemoListStateKey(presentation.memos) : "", presentation.headers]);
	};
	Object.assign(h.view, { getCardFlowStateKey: stateKey });
	const before = h.view.getCurrentCardFlowPresentation();
	const card = dom.root.querySelector(".knomo-card")!, content = card.querySelector(".knomo-card-content");
	prepareComposer(h.view, "new without link");
	try {
		await h.view.saveInput();
		assert.deepEqual(h.view.getCurrentCardFlowPresentation().headers, before.headers);
		catalogGate.resolve();
		await h.view.composerSaveRefreshQueue;
		await h.view.refresh();
		assert.deepEqual(h.view.getCurrentCardFlowPresentation().headers, before.headers);
		assert.equal(card.parentElement, dom.root);
		assert.equal(card.querySelector(".knomo-card-content"), content);
		assert.equal(h.view.memos.filter(memo => memo.links?.length).length, 50);
		countGate.resolve();
		await counting;
		assert.deepEqual(h.view.getCurrentCardFlowPresentation().headers, before.headers);
		assert.equal(card.parentElement, dom.root);
	} finally { catalogGate.resolve(); countGate.resolve(); await counting; dom.dispose(); }
});

test("首次新建链接 Memo 的 Catalog 接续保留精确计数、无标签摘要与未变卡片", async () => {
	const gate = deferred<void>();
	const body = "## Memos\n" + Array.from({ length: 150 }, (_, index) => `- 09:00 kept-${index}\n`).join("");
	const h = await fixture({ immediate: true, catalogGate: gate.promise, body });
	const { toCatalogMemoView } = await import("../src/types/memoView");
	h.view.viewStateController.scopeFilter = "no-tag";
	const initial = await h.read.query({ hasTag: false, limit: 50 });
	h.view.memos = initial.items.map(toCatalogMemoView);
	Object.assign(h.view, {
		memoSourceGeneration: 0, catalogDesktopTotalCount: 150, catalogDesktopCountPresentation: null,
		catalogCoverage: initial.coverage, catalogStatus: initial.status, cardFlowError: null,
		shouldShowTodayTimeBuoys: () => false,
		trashMemoController: { getSnapshot: () => ({ trashLoading: false, trashError: null, trashMemos: [] }) },
	});
	const dom = attachCardFlow(h.view);
	const card = dom.root.querySelector(".knomo-card")!, content = card.querySelector(".knomo-card-content");
	const readCount = () => (h.view as unknown as { catalogDesktopTotalCount: number | null }).catalogDesktopTotalCount;
	const before = h.view.getCurrentCardFlowPresentation();
	prepareComposer(h.view, "new [[target]]");
	try {
		await h.view.saveInput();
		const confirmed = h.view.getCurrentCardFlowPresentation();
		assert.equal(readCount(), 151);
		assert.notDeepEqual(confirmed.headers, before.headers);
		gate.resolve();
		await h.view.composerSaveRefreshQueue;
		const indexed = h.view.getFilteredMemos().find(memo => memo.contentSnapshot === "new [[target]]")!;
		assert.equal(indexed.catalog?.links[0]?.target, "target");
		assert.equal(indexed.catalog?.observationHandle.rawBlockHash, indexed.catalog?.observation.rawBlockHash);
		assert.equal(readCount(), 151, "未变的 Markdown 展示不因额外引用派生而使计数失效");
		assert.deepEqual(h.view.getCurrentCardFlowPresentation().headers, confirmed.headers, "完整覆盖下的 Catalog 接续也不能撤下刚显示的摘要");
		assert.equal(card.parentElement, dom.root);
		assert.equal(card.querySelector(".knomo-card-content"), content);
	} finally { gate.resolve(); await h.view.composerSaveRefreshQueue; dom.dispose(); }
});

test("在浮标页面新建无浮标 memo 时不重绘当前页面", async () => {
	const gate = deferred<void>();
	const h = await fixture({ immediate: true, catalogGate: gate.promise });
	h.view.viewStateController.activeNav = "time-buoy";
	let renders = 0;
	Object.assign(h.view, { renderUiState: (options?: { renderCardFlow?: boolean }) => {
		if (options?.renderCardFlow !== false) renders++;
	} });
	prepareComposer(h.view, "ordinary memo");
	try {
		await h.view.saveInput();
		assert.equal(renders, 0);
	} finally { gate.resolve(); }
	await h.view.composerSaveRefreshQueue;
	assert.equal(renders, 0);
});

test("标签视图保存匹配或不匹配的新卡片均保留旧卡片 DOM、图片、滚动及当前任务句柄", async () => {
	for (const content of ["new #other", "new #keep"]) {
		const gate = deferred<void>();
		const h = await fixture({ immediate: true, catalogGate: gate.promise, body: "## Memos\n- 09:00 kept #keep\n  - [ ] task\n" });
		h.view.viewStateController.activeTag = "keep";
		h.view.viewStateController.activeTagKey = "keep";
		const dom = attachCardFlow(h.view);
		const original = h.view.getFilteredMemos()[0]!;
		const card = dom.root.firstElementChild!, body = card.querySelector(".knomo-card-content"), image = card.querySelector("img");
		const checkbox = card.querySelector("input")!;
		dom.root.scrollTop = 600;
		prepareComposer(h.view, content);
		try {
			await h.view.saveInput();
			const retained = h.view.getFilteredMemos().find(memo => memo.contentSnapshot.startsWith("kept"))!;
			assert.notEqual(retained.id, original.id);
			assert.equal(card.parentElement, dom.root);
			assert.equal(card.querySelector(".knomo-card-content"), body);
			assert.equal(card.querySelector("img"), image);
			assert.equal(card.querySelector("input"), checkbox);
			assert.equal(checkbox.getAttribute("data-knomo-memo-id"), retained.id);
			assert.equal(checkbox.getAttribute("data-knomo-source-revision"), retained.catalog!.observationHandle.sourceRevision);
			assert.equal(dom.findMemo(retained.id), retained);
			assert.equal(dom.root.scrollTop, 600);
			assert.equal(dom.root.querySelectorAll(".knomo-card").length, content.endsWith("#keep") ? 2 : 1);
		} finally { gate.resolve(); }
		await h.view.composerSaveRefreshQueue;
		assert.equal(card.parentElement, dom.root);
		assert.equal(card.querySelector(".knomo-card-content"), body);
		assert.equal(dom.root.scrollTop, 600);
		dom.dispose();
	}
});

test("外部保存 Daily 的其它正文、frontmatter 或标题后，接纳当前句柄并接续图片", async t => {
	for (const prefix of ["", "---\ntitle: Before\n---\n", "# Before\n\n"]) await t.test(prefix || "other-text", async () => {
		const h = await fixture({ immediate: true, body: prefix + "## Memos\n- 09:00 kept ![[image.png]]\n\n## Notes\nBefore\n" });
		const dom = attachCardFlow(h.view, false, false, true);
		const old = h.view.memos[0]!;
		const oldCard = dom.root.querySelector(".knomo-card")!;
		const image = oldCard.querySelector("img")!;
		const button = image.parentElement;
		const changes: MutationRecord[] = [];
		const observer = new dom.window.MutationObserver(records => changes.push(...records));
		observer.observe(image, { attributes: true, attributeFilter: ["src"] });
		const reload = h.view.reloadMemos;
		h.view.reloadMemos = async () => {
			await reload();
			Object.assign(h.view, { filteredMemosCache: null });
			dom.render();
			return true;
		};
		try {
			await h.externalReplace(h.body().replace("Before", "After"));
			assert.ok(oldCard.contains(image), "接纳新查询前图片留在原卡片");
			await h.view.refresh();
			const card = dom.root.querySelector(".knomo-card")!;
			assert.notEqual(card, oldCard);
			assert.notEqual(card.querySelector("button"), button);
			assert.equal(card.querySelector("img"), image);
			assert.equal(image.getAttribute("src"), "app://image.png?knomo-mtime=1");
			assert.equal(card.querySelector(".is-loading"), null);
			assert.equal(dom.imageLoads(), 1);
			assert.deepEqual([...changes, ...observer.takeRecords()], []);
			assert.equal(dom.findMemo(card.getAttribute("data-memo-id")!)?.id, h.view.memos[0]!.id);
			await assert.rejects(h.edit(old, "stale edit"), /stale|revision|changed/iu);
		} finally {
			observer.disconnect();
			dom.dispose();
		}
	});
});

test("记录统计准备中的非 force 重绘保留同范围位置，完成时使用用户的新位置", async () => {
	const h = await fixture({ immediate: true });
	const dom = attachCardFlow(h.view);
	const { RecordStatsService } = await import("../src/services/RecordStatsService");
	const { RecordStatsPreparationController } = await import("../src/ui/RecordStatsPreparationController");
	const { RecordStatsViewStateController } = await import("../src/ui/RecordStatsViewStateController");
	const stats = new RecordStatsService();
	const state = new RecordStatsViewStateController(new Date(2026, 7, 22));
	const prep = new RecordStatsPreparationController({ scheduleTask: () => 1, cancelTask: () => {} });
	const ready = await h.read.buildRecordStats(async () => {}, () => true);
	assert.ok(ready);
	await stats.prepareFromSource("old", async () => ready);
	const view = h.view as unknown as { renderRecordStatsPage: () => void; prepareRecordStats: () => Promise<boolean> };
	const pending = deferred<typeof ready>();
	Object.assign(h.view, {
		recordStatsService: stats, recordStatsViewStateController: state, recordStatsPreparationController: prep,
		mobileSearchController: { isOpen: false },
		catalogStatus: { content: "ready", catalog: "complete", projection: "ready" }, catalogCoverage: null,
		getDailyNotesStatus: () => ({ enabled: true }), clearLoadingIndicators: () => {},
		getCardFlowStateKey: () => JSON.stringify([stats.getSnapshot(), state.getSnapshot()]),
		createHiddenText: () => "stats-label", renderCardFlow: () => view.renderRecordStatsPage(),
	});
	Object.assign(h.read, { buildRecordStats: () => pending.promise });
	h.view.viewStateController.activeNav = "record-stats";
	dom.root.empty = () => { dom.root.replaceChildren(); dom.root.scrollTop = 0; };
	Object.defineProperty(dom.root, "scrollHeight", { value: 1000 });
	try {
		view.renderRecordStatsPage();
		const previous = dom.root.firstElementChild;
		dom.root.scrollTop = 300;
		Object.assign(h.view, { catalogStatus: { content: "ready", catalog: "complete", projection: "failed" } });
		prep.setSourceKey("new");
		const refreshing = view.prepareRecordStats();
		assert.notEqual(dom.root.firstElementChild, previous, "准备过程的状态变化触发同范围重绘");
		assert.equal(dom.root.scrollTop, 300);
		dom.root.scrollTop = 120;
		pending.resolve(ready);
		assert.equal(await refreshing, true);
		assert.equal(dom.root.scrollTop, 120);
		state.setView("month");
		view.renderRecordStatsPage();
		assert.equal(dom.root.scrollTop, 0);
	} finally {
		pending.resolve(ready);
		dom.dispose();
	}
});

test("记录统计仅回填当前期，拾星变化只重读拾星卡，旧快照空期不显示零", async () => {
	const h = await fixture({ immediate: true });
	const dom = attachCardFlow(h.view);
	const { RecordStatsService } = await import("../src/services/RecordStatsService");
	const { RecordStatsViewStateController } = await import("../src/ui/RecordStatsViewStateController");
	const stats = new RecordStatsService();
	const state = new RecordStatsViewStateController(new Date(2026, 7, 22));
	const base = (await h.read.buildRecordStats(async () => {}, () => true))!;
	const catalog = await h.read.query({ limit: 1, matchNone: true });
	await stats.prepareFromSource("current", async () => base);
	const things: { signal?: AbortSignal; finish: (count: number, revision?: number) => void }[] = [];
	let favoriteReads = 0;
	const service = { revision: 1, status: "ready", paths: () => [] as string[] };
	const opened: unknown[] = [];
	const view = h.view as unknown as {
		activeNav: string;
		renderRecordStatsPage: (force?: boolean) => void;
		handleFavoritesChanged: (refresh: boolean) => void;
		stopRecordStatsPreparation: () => void;
		openRecordStatsMetricFilter: (type: "things" | "favorites") => void;
	};
	const read = {
		count: (filter: object, signal?: AbortSignal) => {
			assert.equal((filter as { hasTask: boolean }).hasTask, true);
			const pending = deferred<import("../src/types/catalogView").CatalogMemoCountResult>();
			things.push({ signal, finish: (count, revision = catalog.catalogRevision) => pending.resolve({
				count, complete: true, catalogRevision: revision, coverage: catalog.coverage,
			}) });
			return pending.promise;
		},
		query: async () => { favoriteReads++; return catalog; },
	};
	Object.assign(h.view, {
		recordStatsService: stats, recordStatsViewStateController: state, favoriteService: service, catalogReadService: read,
		containerEl: { win: { requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0) } },
		catalogStatus: catalog.status, catalogRevision: catalog.catalogRevision, catalogCoverage: catalog.coverage,
		mobileSearchController: { isOpen: false }, getDailyNotesStatus: () => ({ enabled: true }),
		clearLoadingIndicators: () => {}, createHiddenText: () => "stats-label", syncFavoriteCards: () => {},
		getCardFlowStateKey: () => JSON.stringify([stats.getSnapshot(), state.getSnapshot()]),
		yieldToRecordStatsUi: async () => {},
		openRecordStatsSearchFilter: (filter: unknown) => opened.push(filter),
	});
	h.view.viewStateController.activeNav = "record-stats";
	const value = (name: string) => dom.root.querySelector(`[data-record-stats-metric='${name}'] .knomo-record-stats-metric-value`)?.textContent;
	const metric = (name: string) => dom.root.querySelector(`button[data-record-stats-metric='${name}']`)!;
	const settle = () => new Promise<void>(resolve => setTimeout(resolve, 10));
	try {
		view.renderRecordStatsPage();
		assert.equal(value("things"), "—");
		assert.equal(metric("things").getAttribute("aria-disabled"), "true");
		view.openRecordStatsMetricFilter("things");
		assert.deepEqual(opened, []);
		await settle();
		assert.equal(things.length, 1);
		assert.equal(value("favorites"), "0");
		assert.equal(metric("favorites").hasAttribute("data-action"), false);
		state.setView("month");
		view.renderRecordStatsPage();
		const page = dom.root.firstElementChild;
		const month = dom.root.querySelector<HTMLButtonElement>("[data-action='record-stats-view-month']")!;
		const thingsCard = metric("things");
		month.focus(); dom.root.scrollTop = 140;
		await settle();
		assert.equal(things[0]?.signal?.aborted, true);
		assert.equal(things.length, 2);
		things[0]!.finish(99);
		await settle();
		assert.equal(value("things"), "—");
		things[1]!.finish(3);
		await settle();
		assert.equal(value("things"), "3");
		assert.equal(metric("things"), thingsCard);
		assert.equal(thingsCard.getAttribute("data-action"), "record-stats-filter-things");
		view.openRecordStatsMetricFilter("things");
		assert.deepEqual(opened, [{ type: "things", startDate: "2026-08-01", endDateExclusive: "2026-09-01" }]);
		assert.equal(dom.root.firstElementChild, page);
		assert.equal(dom.window.document.activeElement, month);
		assert.equal(dom.root.scrollTop, 140);

		service.revision++;
		service.status = "loading";
		view.handleFavoritesChanged(false);
		await settle();
		assert.equal(value("favorites"), "0");
		view.handleFavoritesChanged(true);
		await settle();
		assert.equal(value("favorites"), "—");
		service.status = "ready";
		service.revision++;
		view.handleFavoritesChanged(true);
		await settle();
		assert.equal(value("favorites"), "0");
		assert.equal(things.length, 2);
		assert.equal(favoriteReads, 3);

		state.goToPrevious(stats.getEarliestYear());
		view.renderRecordStatsPage();
		assert.equal(value("things"), "0");
		assert.equal(value("favorites"), "0");
		stats.invalidate(false);
		view.renderRecordStatsPage();
		assert.equal(value("things"), "—");
		view.openRecordStatsMetricFilter("things");
		assert.equal(opened.length, 1);
		assert.equal(value("favorites"), "—");
		assert.equal(things.length, 2);
		assert.equal(favoriteReads, 3);

		await stats.prepareFromSource("current", async () => base);
		state.goToNext();
		view.renderRecordStatsPage();
		await settle();
		view.stopRecordStatsPreparation();
		assert.equal(things[2]?.signal?.aborted, true);
		view.renderRecordStatsPage(true);
		await settle();
		things[2]!.finish(99);
		things[3]!.finish(4, catalog.catalogRevision + 1);
		await settle();
		assert.equal(value("things"), "—");
		assert.equal(dom.root.querySelector("[data-record-stats-metric='things'] [role='status']")?.textContent, "Things count unavailable");
	} finally {
		view.stopRecordStatsPreparation();
		dom.dispose();
	}
});

test("浮标当前分组匹配时增量插入，不匹配时保留原面板，索引刷新也不重建", async () => {
	const today = new Date();
	const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
	for (const content of [`new @${date}`, "new @2099-12-31", "ordinary memo"]) {
		const gate = deferred<void>();
		const h = await fixture({ immediate: true, catalogGate: gate.promise, body: `## Memos\n- 09:00 kept @${date}\n` });
		h.view.viewStateController.activeNav = "time-buoy";
		await h.buoy.loadInitial();
		const dom = attachCardFlow(h.view, true);
		const panel = dom.root.querySelector(".knomo-time-buoy-panel:not([hidden])")!;
		const card = panel.querySelector(".knomo-card")!, body = card.querySelector(".knomo-card-content");
		dom.root.scrollTop = 600;
		prepareComposer(h.view, content);
		try {
			await h.view.saveInput();
			assert.equal(dom.root.querySelector(".knomo-time-buoy-panel:not([hidden])"), panel);
			assert.equal(card.parentElement, panel);
			assert.equal(card.querySelector(".knomo-card-content"), body);
			assert.equal(panel.querySelectorAll(".knomo-card").length, content === `new @${date}` ? 2 : 1);
			assert.equal(dom.root.scrollTop, 600);
		} finally { gate.resolve(); }
		await h.view.composerSaveRefreshQueue;
		await h.buoy.loadInitial();
		dom.render();
		assert.equal(dom.root.querySelector(".knomo-time-buoy-panel:not([hidden])"), panel);
		assert.equal(card.parentElement, panel);
		assert.equal(card.querySelector(".knomo-card-content"), body);
		assert.equal(dom.root.scrollTop, 600);
		dom.dispose();
	}
});

test("浮标真实任务勾选在 Catalog 等待和接续后保留已就绪图片与新句柄", async () => {
	const gate = deferred<void>();
	const h = await fixture({ immediate: true, catalogGate: gate.promise,
		body: "## Memos\n- 09:00 - [ ] task @2099-12-31 ![[image.png]]\n" });
	h.view.viewStateController.activeNav = "time-buoy";
	h.buoy.setActiveTab("upcoming"); await h.buoy.loadInitial();
	const dom = attachCardFlow(h.view, true, false, true);
	const image = dom.root.querySelector("img"), oldMemo = h.view.memos[0]!;
	assert.ok(image);
	let toggling: Promise<unknown> | null = null;
	try {
		toggling = h.view.handleCatalogTaskToggle(oldMemo, 0, true);
		await new Promise<void>(resolve => setImmediate(resolve)); await Reflect.get(h.view, "presentationChangeQueue");
		assert.match(h.body(), /\[x\]/);
		assert.equal(dom.root.querySelector("img"), image);
		assert.equal(dom.imageLoads(), 1);
		const currentId = dom.root.querySelector(".knomo-card")!.getAttribute("data-memo-id")!;
		assert.notEqual(currentId, oldMemo.id);
		assert.equal(dom.root.querySelector(".knomo-card-image-button")!.getAttribute("data-memo-id"), currentId);
		assert.equal(dom.findMemo(currentId)?.catalog?.observationHandle.sourceRevision,
			createHash("sha256").update(h.body()).digest("hex"));
		gate.resolve(); await toggling; await h.buoy.loadInitial(); dom.render();
		assert.equal(dom.root.querySelector("img"), image);
		assert.equal(dom.imageLoads(), 1);
	} finally { gate.resolve(); await toggling; dom.dispose(); }
});

test("首次 Catalog 读取失败后保存仍立即显示真实卡片，不被旧错误或历史构建占位遮盖", async () => {
	const gate = deferred<void>();
	const h = await fixture({ immediate: true, catalogGate: gate.promise });
	Object.assign(h.view, { memos: [], hasCommittedCatalogDesktopQuery: false, cardFlowError: "Catalog unavailable",
		catalogStatus: { content: "unavailable", catalog: "degraded", projection: "ready" }, catalogCoverage: null,
		catalogDesktopTotalCount: null, shouldShowTimeBuoyIntro: () => false, shouldShowTodayTimeBuoys: () => false,
		trashMemoController: { getSnapshot: () => ({ trashLoading: false, trashError: null, trashMemos: [] }) },
	});
	prepareComposer(h.view, "saved while Catalog unavailable");
	try {
		await h.view.saveInput();
		const presentation = h.view.getCurrentCardFlowPresentation();
		assert.equal(presentation.type, "items");
		if (presentation.type === "items") assert.equal(presentation.memos[0]!.contentSnapshot, "saved while Catalog unavailable");
	} finally { gate.resolve(); }
	await h.view.composerSaveRefreshQueue;
});

test("Daily 确认后筛选编辑立即替换或移出，同时补入其它匹配视图", async () => {
	for (const content of ["changed #keep", "changed #other"]) {
		const gate = deferred<void>();
		const h = await fixture({ immediate: true, catalogGate: gate.promise, body: "## Memos\n- 09:00 old #keep\n- 10:00 same\n" });
		const other = await h.createView();
		for (const view of [h.view, other.view]) {
			view.viewStateController.activeTag = "keep";
			view.viewStateController.activeTagKey = "keep";
		}
		other.view.memos = [];
		const original = h.memos[0]!;
		prepareComposer(h.view, content, original);
		try {
			await h.view.saveInput();
			for (const view of [h.view, other.view]) assert.deepEqual(view.getFilteredMemos().map(memo => memo.contentSnapshot),
				content.endsWith("#keep") ? [content] : []);
			assert.equal(h.random.getSnapshot().memos![0]!.contentSnapshot, content);
			assert.equal(h.shuffle.getSnapshot().memos[0]!.contentSnapshot, content);
			await assert.rejects(h.command.edit(original.catalog!, "stale overwrite"), /stale|revision|changed/iu);
		} finally { gate.resolve(); }
		await h.view.composerSaveRefreshQueue;
	}
});

test("索引排队期间同文连续保存保持独立卡片，旧查询与旧提交不覆盖它们", async () => {
	const gate = deferred<void>();
	const h = await fixture({ immediate: true, catalogGate: gate.promise });
	try {
		for (let count = 0; count < 2; count++) {
			prepareComposer(h.view, "same new memo");
			await h.view.saveInput();
		}
		await h.view.reloadMemos();
		const immediate = h.view.getFilteredMemos().filter(memo => memo.contentSnapshot === "same new memo");
		assert.equal(immediate.length, 2);
		assert.equal(new Set(immediate.map(memo => memo.id)).size, 2);
		await h.view.refreshRandomReunionBatch();
		assert.deepEqual(h.random.getSnapshot().memos!.map(memo => memo.contentSnapshot), ["old", "same", "same"]);
	} finally { gate.resolve(); }
	await h.view.composerSaveRefreshQueue;
	assert.equal(h.view.getFilteredMemos().filter(memo => memo.contentSnapshot === "same new memo").length, 2);
	assert.equal((await h.loadMemos()).filter(memo => memo.contentSnapshot === "same new memo").length, 2);
});

test("Catalog 失败保留已确认新卡片，后续外部 Daily 变化使即时展示失效", async () => {
	const h = await fixture({ immediate: true });
	h.failCatalog();
	prepareComposer(h.view, "confirmed despite Catalog failure");
	await h.view.saveInput();
	await h.view.composerSaveRefreshQueue;
	assert.equal(h.view.getFilteredMemos().some(memo => memo.contentSnapshot === "confirmed despite Catalog failure"), true);
	await h.externalReplace("## Memos\n- 09:00 external replacement\n");
	await h.view.checkConfirmedDailyFile(PATH);
	assert.equal(h.view.getFilteredMemos().some(memo => memo.contentSnapshot === "confirmed despite Catalog failure"), false);
	await h.view.reloadMemos();
	assert.deepEqual(h.view.getFilteredMemos().map(memo => memo.contentSnapshot), ["external replacement"]);
});

test("确认展示被外部覆盖时保留只读过渡，旧绑定立即撤销，当前查询接纳后再替换", async () => {
	const h = await fixture({ immediate: true });
	h.failCatalog();
	prepareComposer(h.view, "confirmed reading surface");
	await h.view.saveInput(); await h.view.composerSaveRefreshQueue;
	const dom = attachCardFlow(h.view);
	try {
		const before = dom.root.textContent;
		Object.assign(h.view, { trashMemoController: { getSnapshot: () => ({ trashMemos: [] }) } });
		const applyBuoys = h.view.timeBuoyViewController.applyMemoChanges.bind(h.view.timeBuoyViewController);
		h.view.timeBuoyViewController.applyMemoChanges = (...args) => {
			const changed = applyBuoys(...args);
			h.view.renderCardFlow();
			return changed;
		};
		await h.externalReplace("## Memos\n- 09:00 external replacement\n");
		await h.view.checkConfirmedDailyFile(PATH);
		assert.equal(h.view.getFilteredMemos().length, 0, "旧 occurrence 已退出操作集合");
		assert.equal(dom.root.textContent, before, "索引接纳前保持可读画面");
		const snapshot = dom.root.querySelector<HTMLElement>("[data-knomo-readonly-transition]")!;
		assert.ok(snapshot?.hasAttribute("inert"));
		assert.equal(snapshot.querySelector("[data-knomo-memo-id], [data-action]"), null);
		assert.equal(dom.findMemo(h.memos[0]!.id), null);
		dom.render();
		assert.equal(dom.root.querySelectorAll("[data-knomo-readonly-transition]").length, 4, "普通重绘仍保留全部只读卡片");
		assert.equal(dom.root.textContent, before);
		await h.externalReplace("## Memos\n- 09:00 latest external replacement\n");
		await h.view.checkConfirmedDailyFile("Daily");
		const pending = Reflect.get(h.view, "externallyInvalidatedDailyRevisions") as Map<string, string | null>;
		assert.equal(pending.get(PATH), await h.read.getFileSourceRevision(PATH), "目录事件继续验证尚在过渡的源文件");
		await h.view.queryCatalogFeature({ limit: 50 }); h.view.prepareCatalogResultAcceptance()();
		await h.view.reloadMemos(); dom.render();
		assert.match(dom.root.textContent ?? "", /external replacement/);
		assert.equal(dom.root.querySelector("[data-knomo-readonly-transition]"), null);
	} finally { dom.dispose(); }
});

test("连续外部保存的重叠复核按最后事件接纳，较早读取不能覆盖最新版本", async t => {
	for (const newestFirst of [false, true]) {
		const h = await fixture({ immediate: true });
		h.failCatalog(); prepareComposer(h.view, "confirmed");
		await h.view.saveInput(); await h.view.composerSaveRefreshQueue;
		const app = Reflect.get(h.view, "app") as import("obsidian").App;
		const reads = [deferred<string>(), deferred<string>()];
		let index = 0, refreshes = 0;
		t.mock.method(app.vault, "read", () => reads[index++]!.promise);
		t.mock.method(h.view, "refresh", async () => { refreshes++; });
		Object.assign(h.view, { presentationVisibilityReady: true, isPresentationHidden: () => false });
		const oldRead = h.view.checkConfirmedDailyFile(PATH);
		const newRead = h.view.checkConfirmedDailyFile(PATH);
		const latest = "## Memos\n- 09:00 latest external\n";
		await h.externalReplace(latest);
		if (newestFirst) { reads[1]!.resolve(latest); await newRead; }
		reads[0]!.resolve("## Memos\n- 09:00 superseded external\n"); await oldRead;
		if (!newestFirst) { reads[1]!.resolve(latest); await newRead; }
		const page = await h.view.queryCatalogFeature({ limit: 50 });
		assert.deepEqual(page.items.map(item => item.content), ["latest external"]);
		assert.ok(refreshes > 0, "最新复核完成后即使 Catalog 通知已到也会请求交接");
	}
});

test("普通列表的只读交接在失败和两个视图间独立保留，其它文件仍可操作，当前零结果才清空", async t => {
	const h = await fixture({ immediate: true, otherBody: "- 11:00 C\n" });
	const other = await h.createView();
	h.failCatalog(); prepareComposer(h.view, "confirmed");
	await h.view.saveInput(); await h.view.composerSaveRefreshQueue;
	const firstDom = attachCardFlow(h.view), secondDom = attachCardFlow(other.view);
	try {
		await h.externalReplace("## Memos\n");
		const app = Reflect.get(h.view, "app") as import("obsidian").App;
		Object.assign(h.view, { reportViewRefreshFailure() {} });
		await h.view.checkConfirmedDailyFile(PATH); await other.view.checkConfirmedDailyFile(PATH);
		for (const dom of [firstDom, secondDom]) {
			dom.render();
			assert.equal(dom.root.querySelectorAll("[data-knomo-readonly-transition]").length, 4);
			assert.equal(dom.findMemo(h.memos[3]!.id)?.contentSnapshot, "C");
		}
		const read = t.mock.method(app.vault, "read", async () => { throw new Error("temporary source failure"); });
		await h.view.checkConfirmedDailyFile(PATH); firstDom.render();
		assert.equal(firstDom.root.querySelectorAll("[data-knomo-readonly-transition]").length, 4);
		read.mock.restore(); await h.view.checkConfirmedDailyFile(PATH);
		await h.view.queryCatalogFeature({ limit: 50 }); h.view.prepareCatalogResultAcceptance()();
		await h.view.reloadMemos(); firstDom.render(); secondDom.render();
		assert.equal(firstDom.root.querySelectorAll("[data-knomo-readonly-transition]").length, 0);
		assert.equal(firstDom.root.querySelectorAll(".knomo-card").length, 1, "当前 Daily 确认零条，只留下另一个来源");
		assert.equal(secondDom.root.querySelectorAll("[data-knomo-readonly-transition]").length, 4, "另一视图尚未接纳，继续保持只读");
		await other.view.queryCatalogFeature({ limit: 50 }); other.view.prepareCatalogResultAcceptance()();
		await other.view.reloadMemos(); secondDom.render();
		assert.equal(secondDom.root.querySelectorAll(".knomo-card").length, 1);
	} finally { secondDom.dispose(); firstDom.dispose(); }
});

test("普通列表等待 A 的索引交接时，B 连续编辑立即更新且 A 始终只读", async t => {
	const { CatalogDiscoveryInvalidatedError } = await import("../src/services/CatalogReadService");
	const h = await fixture({ immediate: true, otherBody: "## Memos\n- 11:00 - [ ] other original\n- 11:01 other sibling\n" });
	h.random.applyMemoChanges(new Map(h.memos.filter(memo => memo.dailyRef.path !== PATH).map(memo => [memo.id, null])));
	await h.edit(h.memos[0]!, "confirmed A");
	Object.assign(h.view, { trashMemoController: { getSnapshot: () => ({ trashMemos: [] }) } });
	const dom = attachCardFlow(h.view);
	try {
		const app = Reflect.get(h.view, "app") as import("obsidian").App;
		const processDaily = app.vault.process.bind(app.vault);
		t.mock.method(app.vault, "process", async (file: TFile, update: (content: string) => string) => {
			const result = await processDaily(file, update);
			if (file.path !== PATH) await h.view.checkConfirmedDailyFile(file.path);
			return result;
		});
		h.vault.replace(PATH, "---\nmodified: external\n---\n" + h.body());
		await h.view.checkConfirmedDailyFile(PATH);
		const readonlyCards = [...dom.root.querySelectorAll<HTMLElement>("[data-knomo-readonly-transition]")];
		assert.equal(readonlyCards.length, 3);
		await assert.rejects(h.view.queryCatalogFeature({ limit: 50 }), CatalogDiscoveryInvalidatedError);
		let other = h.view.memos.find(memo => memo.contentSnapshot === "- [ ] other original")!;
		const publication = deferred<void>();
		h.afterCatalogPublished(() => publication.promise);
		try {
			for (const content of ["- [ ] other first edit", "- [x] other second edit"]) {
				const previous = other;
				prepareComposer(h.view, content, previous);
				await h.view.saveInput(); dom.render();
				const current = h.view.getFilteredMemos();
				other = current.find(memo => memo.contentSnapshot === content)!;
				assert.ok(other);
				const card = [...dom.root.querySelectorAll<HTMLElement>(".knomo-card")]
					.find(element => element.getAttribute("data-memo-id") === other.id);
				assert.equal(card?.querySelector(".knomo-card-content")?.textContent, content);
				assert.equal(card?.querySelector("input")?.getAttribute("data-knomo-memo-id"), other.id);
				for (const memo of current) {
					const selected = dom.findMemo(memo.id);
					assert.ok(selected, "B 的未编辑卡片也立即使用当前操作目标");
					assert.deepEqual(selected.catalog!.observationHandle, memo.catalog!.observationHandle);
					assert.equal(selected.contentSnapshot, memo.contentSnapshot);
				}
				assert.equal(dom.findMemo(previous.id), null);
				assert.deepEqual([...dom.root.querySelectorAll("[data-knomo-readonly-transition]")], readonlyCards);
				assert.ok(readonlyCards.every(element => element.hasAttribute("inert") && element.querySelector("[data-knomo-memo-id], [data-action]") === null));
				assert.equal(current.some(memo => memo.dailyRef.path === PATH), false);
			}
		} finally { publication.resolve(); await h.view.composerSaveRefreshQueue; }
		await assert.rejects(h.edit(h.memos[0]!, "stale A"), /stale|revision|changed/iu);
		await assert.rejects(h.view.queryCatalogFeature({ limit: 50 }), CatalogDiscoveryInvalidatedError);
		await h.externalReplace(h.body());
		await h.view.queryCatalogFeature({ limit: 50 }); h.view.prepareCatalogResultAcceptance()();
		await h.view.reloadMemos(); dom.render();
		assert.equal(dom.root.querySelectorAll("[data-knomo-readonly-transition]").length, 0);
		assert.equal(dom.root.querySelectorAll(".knomo-card").length, 5);
		assert.match(dom.root.textContent ?? "", /other second edit/u);
	} finally { dom.dispose(); }
});

test("删除后创建或移入同名 Daily 的事件更新交接版本，真实删除可接纳空结果", async t => {
	for (const event of ["create", "rename", "folder", "deleted"] as const) {
		const h = await fixture({ immediate: true });
		h.failCatalog(); prepareComposer(h.view, "confirmed");
		await h.view.saveInput(); await h.view.composerSaveRefreshQueue;
		const app = Reflect.get(h.view, "app") as import("obsidian").App;
		const listeners = new Map<string, (file: TFile, oldPath?: string) => unknown>();
		Object.assign(app.vault, { on: (name: string, listener: (file: TFile, oldPath?: string) => unknown) => { listeners.set(name, listener); return {}; } });
		Object.assign(h.view, { registerEvent: () => {} });
		h.view.registerConfirmedDailyFileEvents();
		const file = app.vault.getAbstractFileByPath(PATH) as TFile;
		h.vault.remove(PATH);
		await listeners.get("delete")!(file);
		if (event === "deleted") {
			await h.catalog.deleteFile(PATH);
			assert.deepEqual((await h.view.queryCatalogFeature({ limit: 50 })).items, []);
			continue;
		}
		const replacement = await app.vault.create(PATH, "## Memos\n- 09:00 recreated\n");
		await h.externalReplace(h.body());
		if (event === "create") await listeners.get("create")!(replacement);
		else {
			await listeners.get("rename")!(event === "folder" ? { path: "Daily" } as TFile : replacement,
				event === "folder" ? "Incoming" : "Incoming/recreated.md");
		}
		const page = await h.view.queryCatalogFeature({ limit: 50 });
		assert.deepEqual(page.items.map(item => item.content), ["recreated"], event);
	}
});

test("逐页校验保留外部交接约束，到整轮接纳才消费，途中新事件使旧轮失效", async () => {
	const h = await fixture({ immediate: true });
	h.failCatalog(); prepareComposer(h.view, "confirmed");
	await h.view.saveInput(); await h.view.composerSaveRefreshQueue;
	await h.externalReplace("## Memos\n- 09:00 first\n- 10:00 second\n");
	await h.view.checkConfirmedDailyFile(PATH);
	const accept = h.view.prepareCatalogResultAcceptance();
	await h.view.queryCatalogFeature({ limit: 1 });
	const pending = Reflect.get(h.view, "externallyInvalidatedDailyRevisions") as Map<string, string | null>;
	assert.ok(pending.has(PATH), "首批页成功不代表整轮查询已接纳");
	await h.externalReplace("## Memos\n- 09:00 newer\n");
	await h.view.checkConfirmedDailyFile(PATH);
	assert.throws(accept, /snapshot changed/i);
	const acceptCurrent = h.view.prepareCatalogResultAcceptance();
	await h.view.queryCatalogFeature({ limit: 50 });
	acceptCurrent();
	assert.equal(pending.size, 0);
});

test("复核读取失败可在下一轮刷新恢复，关闭或新内部确认使旧读取失效", async t => {
	for (const finish of ["retry", "close", "confirmed"] as const) {
		const h = await fixture({ immediate: true });
		h.failCatalog(); prepareComposer(h.view, "confirmed");
		await h.view.saveInput(); await h.view.composerSaveRefreshQueue;
		const app = Reflect.get(h.view, "app") as import("obsidian").App;
		if (finish === "retry") {
			const read = t.mock.method(app.vault, "read", async () => { throw new Error("unreadable"); });
			const errors = t.mock.method(h.view, "reportViewRefreshFailure", () => {});
			await h.view.checkConfirmedDailyFile(PATH);
			assert.equal(errors.mock.callCount(), 1);
			await assert.rejects(h.view.queryCatalogFeature({ limit: 50 }), /snapshot changed/i);
			read.mock.restore();
			await h.view.refresh();
			await h.view.queryCatalogFeature({ limit: 50 });
			continue;
		}
		const gate = deferred<string>();
		const read = t.mock.method(app.vault, "read", () => gate.promise);
		const pending = h.view.checkConfirmedDailyFile(PATH);
		read.mock.restore();
		if (finish === "close") { h.view.invalidateConfirmedDailyMemos(); h.view.trashViewClosed = true; }
		else { prepareComposer(h.view, "new internal"); await h.view.saveInput(); await h.view.composerSaveRefreshQueue; }
		gate.resolve("## Memos\n- 09:00 old external\n"); await pending;
		assert.equal(Reflect.get(h.view, "externallyInvalidatedDailyRevisions")?.size ?? 0, 0);
		if (finish === "confirmed") assert.ok(h.view.getFilteredMemos().some(memo => memo.contentSnapshot === "new internal"));
	}
});

test("真实移动搜索三页经历连续外部保存、一次读取失败后接纳最新版本并继续翻页", async t => {
	const body = "## Memos\n" + Array.from({ length: 200 }, (_, index) => `- 09:00 memo-${index}\n`).join("");
	const h = await fixture({ immediate: true, body });
	h.failCatalog(); prepareComposer(h.view, "memo-confirmed", h.memos[0]);
	await h.view.saveInput(); await h.view.composerSaveRefreshQueue;
	await h.externalReplace(h.body());
	const first = await h.read.query({ textTerms: ["memo"], limit: 50 });
	Object.assign(h.view, { containerEl: { win: { setTimeout, clearTimeout } },
		catalogCoverage: first.coverage, catalogRevision: first.catalogRevision, catalogStatus: first.status,
		syncRecordStatsSource: () => {}, retainMemoCardPreviews: () => {},
	});
	const search = h.view.createMobileSearchController();
	Object.assign(h.view, { mobileSearchController: search });
	Object.assign(search, { renderResults: () => {}, syncControls: () => {} });
	search.searchQuery = "memo"; search.isOpen = true; search.searchVisibleCount = 50;
	await search.refreshAppliedResults();
	search.loadMore(); await new Promise<void>(resolve => setImmediate(resolve));
	search.loadMore(); await new Promise<void>(resolve => setImmediate(resolve));
	search.searchVisibleCount = 150;
	assert.equal(search.getDisplayedMemos().length, 150);
	const app = Reflect.get(h.view, "app") as import("obsidian").App;
	const reads = [deferred<string>(), deferred<string>()]; let index = 0;
	const read = t.mock.method(app.vault, "read", () => reads[index++]!.promise);
	const checks = [h.view.checkConfirmedDailyFile(PATH), h.view.checkConfirmedDailyFile(PATH)];
	const latest = "---\naliases: latest\n---\n" + body;
	await h.externalReplace(latest);
	reads[0]!.resolve("---\naliases: older\n---\n" + body); await checks[0];
	reads[1]!.resolve(latest); await checks[1]; read.mock.restore();
	assert.equal(search.getDisplayedMemos().length, 0, "旧操作集合已经撤销");
	const queryPage = h.read.query.bind(h.read), pageEntered = deferred<void>();
	const secondPage = deferred<Awaited<ReturnType<typeof queryPage>>>();
	const partial = t.mock.method(h.read, "query", (request: Parameters<typeof queryPage>[0], signal?: AbortSignal) => {
		if (request.cursor) { pageEntered.resolve(); return secondPage.promise; }
		return queryPage(request, signal);
	});
	const cancelled = search.refreshAppliedResults();
	await pageEntered.promise;
	search.cancelPendingRequest(true);
	secondPage.resolve(await queryPage({ textTerms: ["memo"], limit: 50 }));
	await cancelled; partial.mock.restore();
	assert.ok((Reflect.get(h.view, "externallyInvalidatedDailyRevisions") as Map<string, unknown>).has(PATH), "第二页取消保留源版本约束");
	assert.equal(search.getDisplayedMemos().length, 0);
	const query = t.mock.method(h.read, "query", async () => { throw new Error("temporary failure"); });
	t.mock.method(console, "warn", () => {});
	await search.refreshAppliedResults();
	assert.equal(search.session.requestStatus, "failed");
	assert.ok((Reflect.get(h.view, "externallyInvalidatedDailyRevisions") as Map<string, unknown>).has(PATH));
	query.mock.restore();
	await search.refreshAppliedResults();
	assert.equal(search.getDisplayedMemos().length, 150);
	const revision = createHash("sha256").update(latest).digest("hex");
	assert.ok(search.getDisplayedMemos().every(memo => memo.catalog?.observationHandle.sourceRevision === revision));
	search.loadMore(); await new Promise<void>(resolve => setImmediate(resolve));
	assert.equal(search.getDisplayedMemos().length, 200);
	assert.equal(new Set(search.getDisplayedMemos().map(memo => memo.id)).size, 200);
	search.searchQuery = "memo-199";
	await search.refreshAppliedResults();
	assert.equal(search.getDisplayedMemos().length, 1);
	search.isOpen = false;
});

test("只读画面恢复原字节后重新创建可操作卡片和任务正文", async () => {
	const h = await fixture({ immediate: true, body: "## Memos\n- 09:00 - [ ] task\n" });
	h.failCatalog(); prepareComposer(h.view, "confirmed", h.memos[0]);
	await h.view.saveInput(); await h.view.composerSaveRefreshQueue;
	const original = h.body();
	const dom = attachCardFlow(h.view);
	try {
		await h.externalReplace("## Memos\n- 09:00 external\n");
		await h.view.checkConfirmedDailyFile(PATH);
		assert.ok(dom.root.querySelector("[data-knomo-readonly-transition]"));
		await h.externalReplace(original);
		await h.view.checkConfirmedDailyFile(PATH);
		await h.view.queryCatalogFeature({ limit: 50 }); h.view.prepareCatalogResultAcceptance()();
		await h.view.checkConfirmedDailyFile(PATH);
		await h.view.reloadMemos(); dom.render();
		assert.equal(dom.root.querySelector("[inert], [data-knomo-readonly-transition]"), null);
		const checkbox = dom.root.querySelector<HTMLInputElement>("input")!;
		assert.equal(checkbox.disabled, false);
		assert.equal(checkbox.getAttribute("data-knomo-memo-id"), h.view.getFilteredMemos()[0]!.id);
	} finally { dom.dispose(); }
});

test("刚保存卡片的任务操作继续更新确认展示，索引追上后不重复插入", async () => {
	const gate = deferred<void>();
	const h = await fixture({ immediate: true, catalogGate: gate.promise });
	prepareComposer(h.view, "- [ ] immediate task");
	try {
		await h.view.saveInput();
		const memo = h.view.getFilteredMemos().find(memo => memo.contentSnapshot.includes("immediate task"))!;
		const toggling = h.view.handleCatalogTaskToggle(memo, 0, true);
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.match(h.view.getFilteredMemos().find(memo => memo.contentSnapshot.includes("immediate task"))!.contentSnapshot, /\[x\]/u);
		gate.resolve();
		await toggling;
	} finally { gate.resolve(); }
	await h.view.composerSaveRefreshQueue;
	assert.equal(h.view.getFilteredMemos().filter(memo => memo.contentSnapshot.includes("immediate task")).length, 1);
});

test("手机保存时先准备卡片再退场，普通输入期间仍保留延后渲染", async () => {
	const gate = deferred<void>();
	const h = await fixture({ immediate: true, catalogGate: gate.promise });
	const { Platform } = await import("obsidian");
	const { KnomoCardFlowCoordinator } = await import("../src/ui/KnomoCardFlowCoordinator");
	const previous = Platform.isMobile;
	const deferredRenders: boolean[] = [];
	prepareComposer(h.view, "mobile immediate");
	Object.assign(Platform, { isMobile: true });
	Object.assign(h.view, { currentLayout: "mobile", cardFlowCoordinator: new KnomoCardFlowCoordinator(),
		closeMobileComposerKeepingDraft: () => {},
		renderUiState: () => deferredRenders.push(h.view.deferMobileCardFlowRender(null, false, "content-change")),
	});
	try {
		await h.view.saveInput();
		assert.equal(h.view.inputEl!.value, "");
		assert.deepEqual(deferredRenders, [false]);
		assert.equal(h.view.getFilteredMemos()[0]!.contentSnapshot, "mobile immediate");
		assert.equal(h.view.deferMobileCardFlowRender(null, false, "content-change"), true);
	} finally { Object.assign(Platform, { isMobile: previous }); gate.resolve(); }
	await h.view.composerSaveRefreshQueue;
});

test("新建浮标在索引等待期间立即归入今日置顶和浮标页面，旧查询不撤下它", async () => {
	const gate = deferred<void>();
	const h = await fixture({ immediate: true, catalogGate: gate.promise });
	const today = new Date();
	const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
	Object.assign(h.view, { shouldShowTodayTimeBuoys: () => true });
	prepareComposer(h.view, `new buoy @${date}`);
	try {
		await h.view.saveInput();
		assert.equal(h.view.getTodayTimeBuoyItems()[0]!.memo.contentSnapshot, `new buoy @${date}`);
		assert.equal(h.buoy.getSnapshot().today[0]!.memo.contentSnapshot, `new buoy @${date}`);
		const loading = h.buoy.loadInitial();
		assert.equal(h.buoy.getSnapshot().loading, false);
		await loading;
		assert.equal(h.buoy.getSnapshot().today[0]!.memo.contentSnapshot, `new buoy @${date}`);
	} finally { gate.resolve(); }
	await h.view.composerSaveRefreshQueue;
	assert.equal(h.view.getTodayTimeBuoyItems()[0]!.memo.contentSnapshot, `new buoy @${date}`);
	assert.equal(h.buoy.getSnapshot().today[0]!.memo.contentSnapshot, `new buoy @${date}`);
});

test("真实 Daily 确认保存接入独立移动会话，同文 occurrence 和旧读取保护保留", async () => {
	const gate = deferred<void>();
	const h = await fixture({ immediate: true, catalogGate: gate.promise });
	const firstPage = await h.read.query({ textTerms: ["same"], limit: 50 });
	Object.assign(h.view, { containerEl: { win: { setTimeout, clearTimeout } },
		catalogCoverage: firstPage.coverage, catalogRevision: firstPage.catalogRevision, catalogStatus: firstPage.status,
		syncRecordStatsSource: () => {}, retainMemoCardPreviews: () => {},
	});
	const search = h.view.createMobileSearchController();
	Object.assign(h.view, { mobileSearchController: search });
	Object.assign(search, { renderResults: () => {}, syncControls: () => {} });
	search.searchQuery = "same"; search.isOpen = true;
	await search.refreshAppliedResults();
	assert.equal(search.getDisplayedMemos().length, 2);
	const old = deferred<typeof firstPage>(), query = h.read.query.bind(h.read);
	let hold = true;
	h.read.query = (...args) => { if (hold) { hold = false; return old.promise; } return query(...args); };
	const pending = search.refreshAppliedResults();
	prepareComposer(h.view, "same");
	try {
		await h.view.saveInput();
		assert.equal(search.getDisplayedMemos().length, 3, "首屏无需等待 Catalog 接续");
		assert.equal(search.getDisplayedCount(), 3);
		assert.equal(new Set(search.getDisplayedMemos().map(memo => memo.id)).size, 3);
		const revision = createHash("sha256").update(h.body()).digest("hex");
		assert.ok(search.getDisplayedMemos().every(memo => memo.catalog?.observationHandle.sourceRevision === revision));
		old.resolve(firstPage); await pending;
		await search.refreshAppliedResults();
		assert.equal(search.getDisplayedMemos().length, 3, "旧 Catalog 页面经唯一 confirmed 投影不能撤下保存结果");
		const ordinary = h.view.memos;
		assert.equal(ordinary.length, 4, "普通列表仍保留独立的全部 Memo");
		await search.refreshAppliedResults();
		assert.equal(h.view.memos, ordinary);
	} finally { old.resolve(firstPage); gate.resolve(); }
	await h.view.composerSaveRefreshQueue;
	await search.refreshAppliedResults();
	assert.equal(search.getDisplayedMemos().length, 3);
	search.isOpen = false;
});

test("真实 Daily 编辑后的移动分页失效不会被等价输入及取消刷新重新激活", async () => {
	const h = await fixture({ immediate: true, body: "## Memos\n" + "- 10:00 same\n".repeat(51) });
	const query = h.read.query.bind(h.read);
	const firstPage = await query({ textTerms: ["same"], limit: 50 });
	const timers = new Map<number, () => void>(); let timerId = 0;
	Object.assign(h.view, {
		containerEl: { win: { setTimeout: (callback: () => void) => { timers.set(++timerId, callback); return timerId; },
			clearTimeout: (id: number) => { timers.delete(id); } } },
		catalogCoverage: firstPage.coverage, catalogRevision: firstPage.catalogRevision, catalogStatus: firstPage.status,
		syncRecordStatsSource: () => {}, retainMemoCardPreviews: () => {},
	});
	const search = h.view.createMobileSearchController();
	Object.assign(h.view, { mobileSearchController: search });
	Object.assign(search, { renderResults: () => {}, syncControls: () => {} });
	search.searchQuery = "same"; search.isOpen = true;
	await search.refreshAppliedResults();
	const pendingPage = deferred<typeof firstPage>(), refreshStarted = deferred<void>();
	const requests: Array<Parameters<typeof query>[0]> = [], signals: Array<AbortSignal | undefined> = [];
	const flushTimers = async () => {
		const tasks = [...timers.values()]; timers.clear();
		for (const callback of tasks) callback();
		await new Promise(resolve => setImmediate(resolve));
	};
	try {
		await h.edit(h.memos[0], "same changed");
		assert.match(h.body(), /same changed/);
		const currentPage = await query({ textTerms: ["same"], limit: 50 });
		assert.notEqual(currentPage.catalogRevision, firstPage.catalogRevision);
		assert.equal(search.session.result?.catalogRevision, firstPage.catalogRevision);
		assert.equal(search.getDisplayedMemos().length, 50);
		h.read.query = (request, signal) => {
			requests.push(request); signals.push(signal);
			if (requests.length === 1) { refreshStarted.resolve(); return pendingPage.promise; }
			return query(request, signal);
		};
		// 使用真实 View.refresh -> Controller -> Catalog 适配，仅挂起这次 I/O。
		const refreshing = h.view.refresh();
		await refreshStarted.promise;
		const ordinary = h.view.memos;
		search.queueQuery("same "); await flushTimers();
		assert.equal(signals[0]?.aborted, true);
		assert.equal(requests.length, 2, "Daily 已使旧分页失效，必须重新读取首屏");
		assert.equal(requests[1].cursor, null);
		assert.equal(search.session.result?.catalogRevision, currentPage.catalogRevision);
		const accepted = search.getDisplayedMemos();
		pendingPage.resolve(currentPage); await refreshing;
		assert.equal(search.getDisplayedMemos(), accepted, "迟到刷新和旧 finally 不能替换新快照");
		search.loadMore(); await new Promise(resolve => setImmediate(resolve));
		assert.deepEqual(requests[2].cursor, currentPage.nextCursor);
		assert.equal(search.getDisplayedMemos().length, 51);
		assert.equal(new Set(search.getDisplayedMemos().map(memo => memo.id)).size, 51);
		const revision = createHash("sha256").update(h.body()).digest("hex");
		assert.ok(search.getDisplayedMemos().every(memo => memo.catalog?.observationHandle.sourceRevision === revision));
		await flushTimers();
		assert.equal(search.getDisplayedCount(), 51);
		assert.equal(h.view.memos, ordinary, "恢复移动分页不能回写普通列表");
	} finally {
		pendingPage.resolve(firstPage); search.isOpen = false; timers.clear(); h.read.query = query;
	}
});

test("拾星集无需加载下一页即可原位更新总数", async t => {
	const total = 51, countGate = deferred<void>();
	const h = await fixture({ immediate: true,
		body: "## Memos\n" + Array.from({ length: total }, (_, index) => `- 09:00 starred-${index}\n`).join("") });
	const page = await h.read.query({ limit: total });
	const bindings = new Map(page.items.map(item => [item.key, item.observationHandle]));
	const count = h.read.count.bind(h.read);
	t.mock.method(h.read, "count", async (...args: Parameters<typeof count>) => {
		await countGate.promise;
		return count(...args);
	});
	const view = h.view as TestView & { loadFavorites(): Promise<boolean> };
	const dom = attachCardFlow(view);
	try {
		Object.assign(view, {
			favoriteService: { status: "ready", revision: 1, persistedCount: total, paths: () => [PATH], getDate: () => DATE,
				countAt: () => total, resolve: async () => ({ status: "ready", revision: page.items[0]!.observationHandle.sourceRevision, bindings }),
				cardState: () => ({ favoriteId: "star" }) },
			mobileSearchController: { isOpen: false },
			renderCardFlow: () => {
				const presentation = view.getCurrentCardFlowPresentation();
				assert.equal(presentation.type, "items");
				Reflect.get(view, "syncCardFlowPresentation").call(view, presentation, null);
			},
		});
		view.viewStateController.activeNav = "favorites";
		assert.equal(await view.loadFavorites(), true);
		const summary = dom.root.querySelector(".knomo-result-summary");
		const slot = summary?.querySelector(".knomo-result-summary-count");
		assert.equal(slot?.getAttribute("data-state"), "pending");
		const card = dom.root.querySelector(".knomo-card");
		assert.ok(card);
		const window = Reflect.get(view, "favoriteWindow");
		assert.equal(window.memos.length, 50);
		countGate.resolve();
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.equal(slot?.textContent, String(total));
		assert.equal(dom.root.querySelector(".knomo-result-summary"), summary);
		assert.equal(dom.root.querySelector(".knomo-card"), card);
		assert.equal(window.memos.length, 50);
	} finally { countGate.resolve(); dom.dispose(); }
});

test("真实首次拾星在锚点提交和收藏读回后保留卡片及图片节点", async () => {
	const gate = deferred<void>(), confirmed = deferred<void>();
	const h = await fixture({ immediate: true, refreshViews: true, catalogGate: gate.promise, onConfirmed: () => confirmed.resolve() });
	const { FavoriteService } = await import("../src/services/FavoriteService");
	const { FavoriteStore } = await import("../src/services/FavoriteStore");
	const { DiaryMemoParser } = await import("../src/services/DiaryMemoParser");
	const parser = new DiaryMemoParser();
	const readSource = async (path: string) => ({ path, logicalDate: DATE,
		...await parser.parse({ sourcePath: path, logicalDate: DATE, bytes: Buffer.from(h.vault.read(path)!) }) });
	const service = new FavoriteService(new FavoriteStore(h.vault.app, () => "Knomo", () => true), {
		getDate: () => DATE, getFileIdentity: path => h.vault.app.vault.getAbstractFileByPath(path), readSource,
		isSourceCurrent: async source => (await readSource(source.path)).sourceRevision === source.sourceRevision,
		createBlockReference: observation => h.mutations.createBlockReference({ observation, sourcePath: observation.sourcePath }),
	});
	await service.retry();
	Object.assign(h.view, { favoriteService: service });
	const dom = attachCardFlow(h.view);
	const selected = h.view.memos.find(memo => memo.contentSnapshot === "old")!;
	const card = Array.from(dom.root.querySelectorAll(".knomo-card")).find(el => el.getAttribute("data-memo-id") === selected.id);
	const image = card?.querySelector("img");
	const operation = service.star(selected.catalog!.observationHandle);
	try {
		await confirmed.promise;
		const current = h.view.memos.find(memo => memo.contentSnapshot === "old")!;
		assert.notEqual(current.id, selected.id);
		assert.notEqual(current.catalog!.observation.rawBlockHash, selected.catalog!.observation.rawBlockHash);
		assert.ok(card?.isConnected);
		assert.equal(card.getAttribute("data-memo-id"), current.id);
		assert.equal(card.querySelector("img"), image);
		assert.equal(service.cardState(current.catalog!.observationHandle).favoriteId, undefined);
		gate.resolve();
		await operation;
		await h.waitForViewRefresh();
		assert.ok(card.isConnected);
		assert.ok(service.cardState(current.catalog!.observationHandle).favoriteId);
	} finally {
		gate.resolve();
		await operation;
		service.dispose(); dom.dispose();
	}
});

test("拾星重读期间保留卡片节点，取消当前卡片后接续相邻记录的阅读位置", async () => {
	const h = await fixture({ immediate: true });
	const dom = attachCardFlow(h.view);
	try {
		const view = h.view as TestView & {
			favoriteWindow: { key: string; version: number; memos: MemoViewItem[]; cursor: null; progress: object };
			loadFavorites(): Promise<boolean>;
		};
		const previous = [...h.memos];
		const key = "[]";
		const progress = { persisted: 3, located: 3, matched: 3, missing: 0, waiting: 0 };
		let partial = false;
		const service: { status: "ready" | "loading"; revision: number; cardState: (handle: ObservationHandle) => { favoriteId?: string } } = {
			status: "loading", revision: 2,
			cardState: handle => service.status === "ready" && (!partial || handle.startLine === previous[0]!.catalog!.observationHandle.startLine)
				? { favoriteId: "star" } : {},
		};
		const renderCard = Reflect.get(view, "renderCardForMode");
		const setGeometry = (card: HTMLElement) => {
			card.getBoundingClientRect = () => new dom.window.DOMRect(0,
				Array.from(dom.root.querySelectorAll(".knomo-card")).indexOf(card) * 100 - dom.root.scrollTop, 200, 100);
		};
		Object.assign(view, {
			favoriteService: service, isPresentationHidden: () => false, clearLoadingIndicators: () => {},
			revealLoadingAfterDelay: () => false,
			mobileSearchController: { isOpen: false },
			getCatalogQueryFingerprint: () => key, buildCatalogActiveQuery: () => ({}),
			getInitialCardBatchSize: () => 1,
			renderCardForMode: (...args: unknown[]) => {
				const card: HTMLElement = renderCard(...args);
				setGeometry(card);
				return card;
			},
		});
		Reflect.get(view, "cardFlowCoordinator").setPendingScrollRestore = () => {};
		view.viewStateController.activeNav = "favorites";
		view.favoriteWindow = { key, version: 1, memos: previous, cursor: null, progress };
		dom.root.querySelectorAll<HTMLElement>(".knomo-card").forEach(setGeometry);
		dom.root.scrollTop = 150;
		const cards = Array.from(dom.root.querySelectorAll(".knomo-card"));
		assert.equal(view.getCurrentCardFlowPresentation().type, "items");
		dom.render();
		assert.deepEqual(Array.from(dom.root.querySelectorAll(".knomo-card")), cards);
		assert.equal(dom.findMemo(previous[0]!.id), null);
		await view.loadFavorites();
		assert.equal(view.favoriteWindow.memos.length, 3);

		service.revision++;
		service.status = "ready";
		// 新收藏版本已读回，其他来源的旧卡片可以先显示，但完整的新查询还在等待。
		partial = true;
		dom.render();
		assert.deepEqual(Array.from(dom.root.querySelectorAll(".knomo-card")), cards);
		assert.equal(dom.root.scrollTop, 150);

		partial = false;
		view.favoriteWindow = { key, version: service.revision, memos: [previous[0]!, previous[2]!], cursor: null, progress };
		dom.render();
		assert.equal(dom.root.querySelectorAll(".knomo-card").length, 2);
		assert.equal(dom.root.scrollTop, 50);
	} finally { dom.dispose(); }
});

async function fixture(options: { body?: string; otherBody?: string; immediate?: boolean; catalogGate?: Promise<void>;
	refreshViews?: boolean; rejectStalePublication?: boolean; onConfirmed?: () => void } = {}) {
	await ensureObsidianStub();
	const { InMemoryVault } = await import("./helpers/InMemoryVault");
	const { DiaryMemoParser } = await import("../src/services/DiaryMemoParser");
	const { DailyMemoWriteGateway } = await import("../src/services/DailyMemoWriteGateway");
	const { MarkdownMutationService } = await import("../src/services/MarkdownMutationService");
	const { MemoCatalogService } = await import("../src/services/MemoCatalogService");
	const { InMemoryMemoCatalogStore } = await import("../src/services/MemoCatalogStore");
	const { CatalogReadService } = await import("../src/services/CatalogReadService");
	const { MemoCommandService } = await import("../src/services/MemoCommandService");
	const { IndependentTrashService } = await import("../src/services/IndependentTrashService");
	const { TrashSnapshotStore } = await import("../src/services/TrashSnapshotStore");
	const { toCatalogMemoView } = await import("../src/types/memoView");
	const { RandomReunionController } = await import("../src/ui/RandomReunionController");
	const { ShuffleDayController } = await import("../src/ui/ShuffleDayController");
	const { TimeBuoyViewController } = await import("../src/ui/TimeBuoyViewController");
	const { buildShuffleDayStats } = await import("../src/utils/shuffleDay");
	const { KnomoView } = await import("../src/ui/KnomoView");
	const { KnomoViewStateController } = await import("../src/ui/KnomoViewStateController");
	const { default: KnomoPlugin } = await import("../src/main");
	const vault = new InMemoryVault({ [PATH]: options.body ?? "## Memos\n- 09:00 old\n- 10:00 same\n- 10:00 same\n" });
	const otherPath = "Daily/2026-08-21.md";
	if (options.otherBody !== undefined) await vault.app.vault.create(otherPath, options.otherBody);
	const app = vault.app;
	const views: TestView[] = [];
	Object.assign(app, {
		workspace: { getActiveViewOfType: () => null, getLeavesOfType: () => views.map(view => ({ view })),
			containerEl: { win: { setTimeout, clearTimeout } } },
		metadataCache: { getFirstLinkpathDest: () => null },
		fileManager: { generateMarkdownLink: () => "[[reference]]" },
		loadLocalStorage: () => null, saveLocalStorage: () => undefined,
	});
	Object.assign(app.vault, { delete: async (file: TFile) => vault.remove(file.path) });
	const file = app.vault.getAbstractFileByPath(PATH) as TFile;
	const parser = new DiaryMemoParser(async bytes => createHash("sha256").update(bytes).digest("hex"));
	const store = new InMemoryMemoCatalogStore();
	const catalog = new MemoCatalogService(store);
	await catalog.open();
	const seed = async (parsed: Awaited<ReturnType<typeof parser.parse>>, sourcePath = PATH, logicalDate = DATE) => {
		await catalog.replaceFile({ inventory: { sourcePath, logicalDate, mtime: 1, size: vault.read(sourcePath)!.length },
			sourceRevision: parsed.sourceRevision, observations: parsed.observations, parserVersion: 2, settingsFingerprint: "settings", auditedAt: 1 });
		const fileCount = options.otherBody === undefined ? 1 : 2;
		await store.setCoverage({ kind: "complete", coveredFromDate: DATE, pendingFileCount: 0, coveredFileCount: fileCount, totalFileCount: fileCount });
	};
	const externalReplace = async (body: string) => {
		vault.replace(PATH, body);
		await seed(await parser.parse({ sourcePath: PATH, logicalDate: DATE, bytes: Buffer.from(body) }));
	};
	await externalReplace(vault.read(PATH)!);
	if (options.otherBody !== undefined) await seed(await parser.parse({ sourcePath: otherPath, logicalDate: "2026-08-21", bytes: Buffer.from(options.otherBody) }), otherPath, "2026-08-21");
	const read = new CatalogReadService({ catalog });
	const loadMemos = async () => (await read.query({ sourcePaths: options.otherBody === undefined ? [PATH] : [PATH, otherPath], limit: 20 })).items.map(toCatalogMemoView)
		.sort((left, right) => right.dailyRef.path.localeCompare(left.dailyRef.path)
			|| left.catalog!.observationHandle.startLine - right.catalog!.observationHandle.startLine);
	const memos = await loadMemos();
	let randomLoads = 0;
	let discoveryGate: Promise<MemoViewItem[]> | null = null;
	const discover = () => discoveryGate ?? loadMemos();
	const createView = async () => {
		const view = Object.create(KnomoView.prototype) as TestView;
		const random = new RandomReunionController({ loadRandomReunionMemos: async () => { randomLoads++; return discover(); },
			openRandomReunionMemo: async () => {}, markRandomReunionReviewed: async () => {}, isRandomActive: () => true,
			showNotice: () => {}, requestRender: () => {} });
		const shuffle = new ShuffleDayController({ loadSelectedDate: async () => {
			const current = await loadMemos();
			return view.confirmedDailyMemos?.merge(current, { logicalDates: [DATE] }) ?? current;
		},
			selectShuffleDay: async () => { const selected = await discover();
				return { status: "ready", selectedDate: DATE, memos: selected, stats: buildShuffleDayStats(selected) }; },
			acceptSelection: async () => {}, isShuffleDayActive: () => true, requestRender: () => {} });
		await random.refresh();
		await shuffle.refresh();
		const buoy = new TimeBuoyViewController({ getNow: () => options.immediate ? new Date() : new Date(2026, 9, 10),
			projectSnapshot: snapshot => options.immediate ? view.projectConfirmedTimeBuoySnapshot(snapshot) : snapshot,
			queryPage: request => read.queryTimeBuoyPage(request), queryDate: (date, cursor) => read.queryTimeBuoysForDate(date, cursor),
			requestRender: () => {} });
		Object.assign(view, { app, memos: options.immediate ? await loadMemos() : [], editingMemo: null, viewStateController: new KnomoViewStateController(),
			randomReunionController: random, shuffleDayController: shuffle,
			timeBuoyViewController: buoy, catalogReadService: read, catalogTodayTimeBuoys: null, trashViewClosed: false,
			catalogDesktopQueryRun: 0,
			hasCommittedCatalogDesktopQuery: options.immediate ?? false,
			reloadMemos: async () => { view.memos = await loadMemos(); return true; },
			settingsService: { getSettings: () => ({ timeBuoyEnabled: false }) }, renderedTimeBuoyEnabled: false,
			waitForAllMemosLoading: async () => {}, renderCardFlow: () => {}, renderUiState: () => {} });
		views.push(view);
		return { view, random, shuffle, buoy };
	};
	const primary = await createView();
	const plugin = Object.create(KnomoPlugin.prototype) as {
		updateCommittedCatalogPartition: (input: MarkdownCatalogCommitInput) => Promise<void>;
		runRefreshOpenViews: () => Promise<void>;
	};
	let afterPublished = async () => {};
	let viewRefresh = Promise.resolve();
	Object.assign(plugin, { app, catalogIndexCoordinator: { replaceCommittedFile: async (input: MarkdownCatalogCommitInput) => {
		if (options.rejectStalePublication && vault.read(input.file.path) !== input.content) throw new Error("Daily changed before Catalog publication");
		await seed(input.parsed, input.file.path, input.logicalDate); await afterPublished();
	} }, queueRefreshOpenViews: () => {
		if (options.refreshViews) viewRefresh = viewRefresh.then(() => plugin.runRefreshOpenViews());
		return viewRefresh;
	} });
	let failCatalog = false;
	const updateCatalogPartition = async (input: MarkdownCatalogCommitInput) => {
		await options.catalogGate;
		if (failCatalog) throw new Error("Catalog unavailable");
		await plugin.updateCommittedCatalogPartition(input);
	};
	const gateway = new DailyMemoWriteGateway(app, parser);
	const mutationOptions = { getWriteHeading: () => "## Memos", getDailyFileForDate: async () => file,
		getLogicalDateForPath: (path: string) => path === otherPath ? "2026-08-21" : DATE, getMemoTimeFormat: () => "HH:mm",
		updateCatalogPartition, refreshCatalogPaths: async () => {} };
	if (options.immediate) Object.assign(mutationOptions, {
		onDailyConfirmed: (change: ConfirmedDailyMemoPresentation) => { for (const view of views) view.handleConfirmedDailyMemoChange(change); options.onConfirmed?.(); },
		onCatalogUpdateSettled: (change: DailyMemoPresentationChange) => { for (const view of views) view.handleConfirmedCatalogSettled(change); },
	});
	const mutations = new MarkdownMutationService(app, { ...mutationOptions, getMemoTimeFormat: () => "HH:mm" }, gateway);
	let snapshotId = 0;
	const trash = new IndependentTrashService(app, new TrashSnapshotStore(app, () => "Knomo"), {
		getLogicalDateForPath: () => DATE, getOriginalDailyFile: async () => file, getDailyFileForDate: async () => file,
		updateCatalogPartition, refreshCatalogPaths: async () => {}, newSnapshotId: () => "s_" + (++snapshotId),
	}, gateway);
	const command = new MemoCommandService(app, catalog, { getMemoTimeFormat: () => "HH:mm", getTrashService: () => trash,
		now: () => new Date(2026, 7, 22, 12), refreshCatalogPaths: async () => {},
		refreshLocalCatalog: async () => { throw new Error("Unexpected refresh"); }, rebuildLocalCatalog: async () => {} }, mutations);
	Object.assign(primary.view, { memoCommandService: command });
	return { ...primary, memos, read, loadMemos, command, mutations, trash, catalog, vault, body: () => vault.read(PATH)!,
		randomLoads: () => randomLoads, createView, externalReplace, failCatalog: () => { failCatalog = true; },
		afterCatalogPublished: (action: () => Promise<void>) => { afterPublished = action; },
		setDiscoveryGate: (gate: Promise<MemoViewItem[]> | null) => { discoveryGate = gate; },
		waitForViewRefresh: () => viewRefresh,
		edit: (memo: MemoViewItem, content: string) => command.edit(memo.catalog!, content) };
}

interface TestView {
	timeBuoyViewController: import("../src/ui/TimeBuoyViewController").TimeBuoyViewController;
	renderCardFlow: () => void;
	createMobileSearchController: () => import("../src/ui/MobileSearchController").MobileSearchController;
	renderUiState: () => void;
	getCurrentCardFlowPresentation: () => import("../src/ui/KnomoCardFlowPresenter").CardFlowPresentation;
	deferMobileCardFlowRender: (id: string | null, force: boolean, intent: "content-change") => boolean;
	getTodayTimeBuoyItems: () => import("../src/ui/TimeBuoyViewController").TimeBuoyTabItem[];
	confirmedDailyMemos?: import("../src/ui/ConfirmedMemoPresentation").ConfirmedMemoPresentation;
	projectConfirmedTimeBuoySnapshot: (snapshot: import("../src/ui/TimeBuoyViewController").TimeBuoyViewSnapshot) => import("../src/ui/TimeBuoyViewController").TimeBuoyViewSnapshot;
	handleConfirmedDailyMemoChange: (change: ConfirmedDailyMemoPresentation) => void;
	handleConfirmedCatalogSettled: (change: DailyMemoPresentationChange) => void;
	invalidateConfirmedDailyMemos: () => void;
	checkConfirmedDailyFile: (path: string) => Promise<void> | void;
	registerConfirmedDailyFileEvents: () => void;
	prepareCatalogResultAcceptance: () => () => void;
	reportViewRefreshFailure: (error: unknown, stage?: string) => void;
	queryCatalogFeature: (request: import("../src/types/catalogView").CatalogFeatureQuery, signal?: AbortSignal) => Promise<import("../src/types/catalogView").CatalogMemoPage>;
	inputEl: { value: string } | null;
	saveInput: () => Promise<void>;
	getFilteredMemos: () => MemoViewItem[];
	composerSaveRefreshQueue: Promise<void>;
	viewStateController: import("../src/ui/KnomoViewStateController").KnomoViewStateController;
	setSidebarNav: (nav: "random" | "shuffleDay") => void;
	returnFromRecordStats: () => void;
	memos: MemoViewItem[];
	editingMemo: MemoViewItem | null;
	trashViewClosed: boolean;
	refresh: () => Promise<void>;
	reloadMemos: () => Promise<boolean>;
	catalogTodayTimeBuoys: import("../src/ui/TimeBuoyViewController").TimeBuoyViewSnapshot | null;
	finishComposerSave: (result: Promise<MemoSaveResult>, previousMemo: MemoViewItem) => Promise<void>;
	handleCatalogTaskToggle: (memo: MemoViewItem, taskIndex: number, checked: boolean) => Promise<void>;
	handleDailyMemoPresentationChange: (change: DailyMemoPresentationChange) => Promise<void>;
	refreshRandomReunionBatch: () => Promise<void>;
}

function prepareComposer(view: TestView, content: string, editingMemo: MemoViewItem | null = null) {
	let value = content, revision = 0;
	Object.assign(view, {
		inputEl: { get value() { return value; }, set value(next: string) { value = next; revision++; },
			composer: { setSaving: () => {}, capture: () => { const current = revision;
				return { valid: () => current === revision, sameSession: () => current === revision }; } } },
		isSaving: false, editingMemo, quoteReferenceText: null, quoteMarkdownText: null,
		currentLayout: "desktop", draftContent: content, composerOpen: true,
		getDailyNotesStatus: () => ({ enabled: true }),
		closeTimeBuoyPicker: () => {}, updateStatus: () => {}, updateSendButtonState: () => {}, clearComposerContext: () => {},
		syncComposerMode: () => {}, updateCancelEditButtonState: () => {}, resizeInput: () => {}, syncRootState: () => {},
		restoreCreateDraft: () => { value = ""; view.editingMemo = null; },
	});
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(yes => { resolve = yes; });
	return { promise, resolve };
}

test("后台 publication、readback、展示队列或补刷挂起时 Daily 确认即释放保存，下一次发送和关闭不等待旧结果", async t => {
	for (const stage of ["publication", "readback", "presentation-queue", "refresh"] as const) {
		const gate = deferred<void>();
		const h = await fixture({ immediate: true, ...(stage === "publication" ? { catalogGate: gate.promise } : {}) });
		prepareComposer(h.view, "first @2026-10-20");
		const { Notice } = await import("obsidian");
		const notices = (Notice as unknown as { messages: string[] }).messages; notices.length = 0;
		if (stage === "readback") {
			const read = h.read.readMemoItems.bind(h.read);
			t.mock.method(h.read, "readMemoItems", async (...args: Parameters<typeof read>) => { await gate.promise; return read(...args); });
		}
		if (stage === "presentation-queue") Object.assign(h.view, { presentationChangeQueue: gate.promise });
		if (stage === "refresh") {
			t.mock.method(h.read, "readMemoItems", async () => { throw new Error("readback unavailable"); });
			h.view.refresh = () => gate.promise;
		}
		const input = h.view.inputEl!;
		let locked = false;
		Object.assign((input as unknown as { composer: object }).composer, { setSaving: (value: boolean) => { locked = value; } });
		await h.view.saveInput();
		assert.match(h.body(), /first @2026-10-20/);
		assert.equal(Reflect.get(h.view, "isSaving"), false, stage); assert.equal(locked, false, stage);
		input.value = "second";
		const second = h.view.saveInput();
		assert.equal(Reflect.get(h.view, "isSaving"), true, "第二次发送已被接受");
		Object.assign(h.view, { mobileComposerController: { resetInactiveState: () => {} } });
		(h.view as unknown as { closeComposerKeepingDraft(): void }).closeComposerKeepingDraft();
		assert.equal(Reflect.get(h.view, "composerOpen"), false);
		gate.resolve(); await second; await h.view.composerSaveRefreshQueue;
		assert.match(h.body(), /second/);
		assert.equal(Reflect.get(h.view, "isSaving"), false); assert.equal(locked, false);
		assert.deepEqual(notices, []);
	}
});

test("已确认展示的渲染失败保留正文与当前句柄，归入本页错误而不冒充读回失败或发保存通知", async t => {
	const h = await fixture({ immediate: true });
	const { Notice } = await import("obsidian");
	const notices = (Notice as unknown as { messages: string[] }).messages; notices.length = 0;
	const logs: unknown[][] = []; t.mock.method(console, "warn", (...args: unknown[]) => { logs.push(args); });
	t.mock.method(h.view, "renderUiState", () => { throw new Error("private memo body data:image/png;base64,secret"); });
	const result = await h.edit(h.memos[0]!, "confirmed body");
	assert.equal(result.status, "saved"); assert.match(h.body(), /confirmed body/);
	assert.equal(h.random.getSnapshot().memos![0]!.contentSnapshot, "confirmed body");
	assert.ok(h.view.confirmedDailyMemos?.pending);
	assert.ok(Reflect.get(h.view, "pageRefreshError"));
	assert.match(JSON.stringify(logs), /render/);
	assert.doesNotMatch(JSON.stringify(logs), /private memo|data:image|secret/);
	assert.deepEqual(notices, []);
});

test("A 的迟到后台失败不能释放 B 的保存锁、清空 B 输入或补发结果 Notice", async () => {
	const h = await fixture(); prepareComposer(h.view, "A");
	const aDaily = deferred<void>(), bDaily = deferred<void>(), bSettled = deferred<MemoSaveResult>();
	let rejectA!: (error: Error) => void;
	const aSettled = new Promise<MemoSaveResult>((_resolve, reject) => { rejectA = reject; });
	let calls = 0, locked = false;
	Object.assign(h.view, { memoCommandService: { startCreate: () => ++calls === 1
		? { dailyCommitted: aDaily.promise, settled: aSettled } : { dailyCommitted: bDaily.promise, settled: bSettled.promise } } });
	Object.assign((h.view.inputEl as unknown as { composer: object }).composer, { setSaving: (value: boolean) => { locked = value; } });
	const { Notice } = await import("obsidian"); const notices = (Notice as unknown as { messages: string[] }).messages; notices.length = 0;
	const first = h.view.saveInput(); aDaily.resolve(); await first;
	h.view.inputEl!.value = "B"; const second = h.view.saveInput();
	rejectA(new Error("late readback failure")); await h.view.composerSaveRefreshQueue;
	assert.equal(Reflect.get(h.view, "isSaving"), true); assert.equal(locked, true); assert.equal(h.view.inputEl!.value, "B");
	assert.deepEqual(notices, []);
	bDaily.resolve(); await second;
	bSettled.resolve({ status: "saved", memo: null, timeBuoyDates: [], localRefreshPending: false });
	await h.view.composerSaveRefreshQueue; assert.equal(locked, false); assert.deepEqual(notices, []);
});

test("浮标新增、减为单日和全部移除在 Daily 确认时立即更新 badge 数据，无保存 Notice", async () => {
	const { t: translate } = await import("../src/i18n");
	for (const [content, dates] of [["two @2026-10-20 @2026-10-21", ["2026-10-20", "2026-10-21"]],
		["single @2026-10-21", ["2026-10-21"]], ["none", []]] as const) {
		const gate = deferred<void>(); const h = await fixture({ immediate: true, catalogGate: gate.promise, body: "## Memos\n- 09:00 old @2026-10-20\n" });
		Object.assign(h.view, { settingsService: { getSettings: () => ({ timeBuoyEnabled: true }) }, renderedTimeBuoyEnabled: true });
		prepareComposer(h.view, content, h.memos[0]!);
		const { Notice } = await import("obsidian"); const notices = (Notice as unknown as { messages: string[] }).messages; notices.length = 0;
		try {
			await h.view.saveInput();
			const current = h.view.getFilteredMemos().find(memo => memo.contentSnapshot === content)!;
			assert.ok(current); assert.deepEqual(current.catalog!.timeBuoyDates, dates);
			const badge = (h.view as unknown as { getVisibleMemoTimeBuoy(memo: MemoViewItem): { label: string } | undefined }).getVisibleMemoTimeBuoy(current);
			if (dates.length === 0) assert.equal(badge, undefined);
			else assert.equal(badge?.label, dates.length === 1 ? translate("timeBuoy.badge.single", { date: dates[0] }) : translate("timeBuoy.badge.multiple", { count: dates.length }));
			assert.deepEqual(notices, []);
		} finally { gate.resolve(); }
		await h.view.composerSaveRefreshQueue; assert.deepEqual(notices, []);
	}
});

function attachCardFlow(view: TestView, timeBuoy = false, usePresentation = false, previewImages = false) {
	const dom = new JSDOM("<body><main></main></body>");
	const originalHTMLElement = globalThis.HTMLElement;
	globalThis.HTMLElement = dom.window.HTMLElement;
	const root = dom.window.document.querySelector("main")!;
	Object.assign(dom.window.HTMLElement.prototype, {
		instanceOf(this: HTMLElement, constructor: typeof HTMLElement) { return this instanceof constructor; },
		hasClass(this: HTMLElement, name: string) { return this.classList.contains(name); },
		getAttr(this: HTMLElement, name: string) { return this.getAttribute(name); },
		setAttr(this: HTMLElement, name: string, value: string) { this.setAttribute(name, value); },
		setText(this: HTMLElement, text: string) { this.textContent = text; },
		addClass(this: HTMLElement, name: string) { this.classList.add(name); },
		removeClass(this: HTMLElement, name: string) { this.classList.remove(name); },
		toggleClass(this: HTMLElement, name: string, active: boolean) { this.classList.toggle(name, active); },
		setCssProps(this: HTMLElement, props: Record<string, string>) {
			for (const [name, value] of Object.entries(props)) this.style.setProperty(name, value);
		},
		find(this: HTMLElement, selector: string) { return this.querySelector(selector); },
		findAll(this: HTMLElement, selector: string) { return Array.from(this.querySelectorAll(selector)); },
		empty(this: HTMLElement) { this.replaceChildren(); },
		createEl(this: HTMLElement, tag: string, options: { cls?: string; text?: string; attr?: Record<string, string> } = {}) {
			const element = dom.window.document.createElement(tag);
			element.className = options.cls ?? ""; element.textContent = options.text ?? "";
			for (const [name, value] of Object.entries(options.attr ?? {})) element.setAttribute(name, value);
			this.append(element); return element;
		},
		createDiv(this: HTMLElement, options: object) { return this.createEl("div", options); },
		createSpan(this: HTMLElement, options: object) { return this.createEl("span", options); },
	});
	const renderingView = view as unknown as {
		syncCardFlowPresentation: (presentation: object, preserve: null) => void;
		renderTimeBuoyPage: () => void;
		findMemoById: (id: string) => MemoViewItem | null;
		renderMemoCardImages: (container: HTMLElement, memo: MemoViewItem, images: import("../src/ui/MemoCardPreview").MemoPreviewImage[],
			generation: number, surface: "card-flow", reuse: null, handoff?: ReadyCardImageHandoff) => void;
	};
	let imageLoads = 0;
	const renderCard = (container: HTMLElement, memo: MemoViewItem, generation: number, _index: number, _mode: unknown,
		_body: unknown, _images: unknown, handoff?: ReadyCardImageHandoff) => {
		const card = dom.window.document.createElement("article"); card.className = "knomo-card";
		card.setAttribute("data-memo-id", memo.id); card.setAttribute("data-memo-render-key", memo.catalog!.renderKey);
		card.setAttribute("data-time-presentation", JSON.stringify({ mode: "full" }));
		if (_body instanceof dom.window.HTMLElement) {
			card.append(_body); container.append(card); return card;
		}
		const body = dom.window.document.createElement("div"); body.className = "knomo-card-body knomo-card-content"; body.textContent = memo.contentSnapshot;
		const checkbox = dom.window.document.createElement("input"); checkbox.type = "checkbox";
		checkbox.setAttribute("data-knomo-memo-id", memo.id); checkbox.setAttribute("data-knomo-task-index", "0"); body.append(checkbox);
		card.append(body); container.append(card);
		if (previewImages) renderingView.renderMemoCardImages(body, memo, [{
			raw: "![[image.png]]", path: "image.png", resourcePath: "image.png", isRemote: false,
			url: "app://image.png?knomo-mtime=1", mtime: 1,
		}], generation, "card-flow", null, handoff);
		else {
			const image = dom.window.document.createElement("img");
			image.src = "https://example.test/image.png";
			body.append(image);
		}
		return card;
	};
	const render = () => {
		const previous = globalThis.HTMLElement;
		globalThis.HTMLElement = dom.window.HTMLElement;
		try {
			if (timeBuoy) renderingView.renderTimeBuoyPage();
			else renderingView.syncCardFlowPresentation(usePresentation ? view.getCurrentCardFlowPresentation() : {
				type: "items", mode: "memo", headers: [], memos: view.getFilteredMemos(),
			}, null);
		} finally { globalThis.HTMLElement = previous; }
	};
	Object.assign(view, {
		cardFlowEl: root, renderedCardMemos: new Map(), popupState: { activeMenuMemoId: null },
		containerEl: { win: dom.window }, getA11yId: () => "buoy", getInitialCardBatchSize: () => 20,
		cardFlowCoordinator: { generation: 1, clearMobileBatchContinuation: () => {}, removeSentinel: () => {},
			getPendingVisibleCount: () => null, syncBatch: () => {}, resetFlowRuntime: () => {} },
		memoMarkdownRenderer: { retainCard: () => {}, releaseCard: () => {}, refreshSearchHits: () => {}, clear: () => {} },
		cardImageCache: { capture: () => {}, take: () => null },
		renderedPreviewImages: new WeakMap(),
		cardImageLoadQueue: { clear: () => {}, update: ({ images }: import("../src/ui/CardImageLoadQueue").CardImageLoadRequest) => {
			for (const item of images) {
				imageLoads++;
				item.imageEl.setAttribute("src", item.src);
				Object.defineProperties(item.imageEl, { complete: { value: true }, naturalWidth: { value: 640 } });
				item.onLoad?.();
			}
		} },
		timeBuoyPanelEl: null, timeBuoyRenderItems: [], timeBuoyRenderedCount: 0, timeBuoyBatchFrameId: null,
		timeBuoyLoadMoreObserver: null,
		prepareRecentTimeFlow: () => { Object.assign(view, { recentTimeFlowContext: { enabled: false, dates: [], pinnedKeys: new Set() },
			recentDecorations: { next: () => null } }); },
		renderCardForMode: renderCard,
		renderMemoCardInContainer: (container: HTMLElement, memo: MemoViewItem, generation: number, index: number,
			_actions: unknown, _random: unknown, _surface: unknown, _body: unknown, _images: unknown, _buoy: unknown, handoff?: ReadyCardImageHandoff) =>
			renderCard(container, memo, generation, index, undefined, undefined, undefined, handoff),
		removeCardElement: (card: HTMLElement) => card.remove(),
		renderTimeBuoyIntro: () => null, renderCardFlowSentinelIfNeeded: () => {}, renderHistoryLoadMore: () => {},
		syncCardMenuState: () => {}, restorePendingCardFlowScrollTop: () => {},
		getCardFlowScrollTop: () => root.scrollTop, restoreCardFlowScrollTop: (scroll: number) => { root.scrollTop = scroll; },
		renderCardFlow: render, renderUiState: (options?: { renderCardFlow?: boolean }) => { if (options?.renderCardFlow !== false) render(); },
	});
	render();
	return { root, render, window: dom.window, imageLoads: () => imageLoads, findMemo: (id: string) => renderingView.findMemoById(id),
		dispose: () => { view.trashViewClosed = true; globalThis.HTMLElement = originalHTMLElement; dom.window.close(); } };
}

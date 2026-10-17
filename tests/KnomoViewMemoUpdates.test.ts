import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { JSDOM } from "jsdom";
import type { TFile } from "obsidian";
import type { MemoViewItem } from "../src/types/memoView";
import type { MemoSaveResult } from "../src/types/catalogView";
import type { MarkdownCatalogCommitInput } from "../src/services/MarkdownMutationService";
import type { DailyMemoPresentationChange, ConfirmedDailyMemoPresentation } from "../src/services/DailyMemoPresentationChange";
import { ensureObsidianStub } from "./helpers/obsidianStub";

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

test("删除、同文恢复和创建保持重逢本组，漫游同步独立 occurrence 与统计", async () => {
	const h = await fixture();
	const deleted = h.memos[2]!;
	await h.command.delete(deleted.catalog!);
	assert.deepEqual(h.random.getSnapshot().memos!.map(memo => memo.contentSnapshot), ["old", "same"]);
	assert.equal(h.shuffle.getSnapshot().stats?.memoCount, 2);
	const snapshot = (await h.trash.store.query()).items[0]!;
	await h.trash.restore(snapshot.snapshotId);
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
				cancelCatalogMobileCount: () => {}, cancelCatalogDesktopCount: () => {},
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
	h.view.checkConfirmedDailyFile(PATH);
	await new Promise<void>(resolve => setTimeout(resolve, 10));
	assert.equal(h.view.getFilteredMemos().some(memo => memo.contentSnapshot === "confirmed despite Catalog failure"), false);
	await h.view.reloadMemos();
	assert.deepEqual(h.view.getFilteredMemos().map(memo => memo.contentSnapshot), ["external replacement"]);
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

async function fixture(options: { body?: string; immediate?: boolean; catalogGate?: Promise<void> } = {}) {
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
	const seed = async (parsed: Awaited<ReturnType<typeof parser.parse>>) => {
		await catalog.replaceFile({ inventory: { sourcePath: PATH, logicalDate: DATE, mtime: 1, size: vault.read(PATH)!.length },
			sourceRevision: parsed.sourceRevision, observations: parsed.observations, parserVersion: 2, settingsFingerprint: "settings", auditedAt: 1 });
		await store.setCoverage({ kind: "complete", coveredFromDate: DATE, pendingFileCount: 0, coveredFileCount: 1, totalFileCount: 1 });
	};
	const externalReplace = async (body: string) => {
		vault.replace(PATH, body);
		await seed(await parser.parse({ sourcePath: PATH, logicalDate: DATE, bytes: Buffer.from(body) }));
	};
	await externalReplace(vault.read(PATH)!);
	const read = new CatalogReadService({ catalog });
	const loadMemos = async () => (await read.query({ sourcePaths: [PATH], limit: 20 })).items.map(toCatalogMemoView)
		.sort((left, right) => left.catalog!.observationHandle.startLine - right.catalog!.observationHandle.startLine);
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
			catalogDesktopQueryRun: 0, catalogMobileQueryRun: 0,
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
	};
	let afterPublished = async () => {};
	Object.assign(plugin, { app, catalogIndexCoordinator: { replaceCommittedFile: async (input: MarkdownCatalogCommitInput) => {
		await seed(input.parsed); await afterPublished();
	} }, queueRefreshOpenViews: async () => {} });
	let failCatalog = false;
	const updateCatalogPartition = async (input: MarkdownCatalogCommitInput) => {
		await options.catalogGate;
		if (failCatalog) throw new Error("Catalog unavailable");
		await plugin.updateCommittedCatalogPartition(input);
	};
	const gateway = new DailyMemoWriteGateway(app, parser);
	const mutationOptions = { getWriteHeading: () => "## Memos", getDailyFileForDate: async () => file,
		getLogicalDateForPath: () => DATE, getMemoTimeFormat: () => "HH:mm",
		updateCatalogPartition, refreshCatalogPaths: async () => {} };
	if (options.immediate) Object.assign(mutationOptions, {
		onDailyConfirmed: (change: ConfirmedDailyMemoPresentation) => { for (const view of views) view.handleConfirmedDailyMemoChange(change); },
		onCatalogUpdateSettled: (change: DailyMemoPresentationChange) => { for (const view of views) view.handleConfirmedCatalogSettled(change); },
	});
	const mutations = new MarkdownMutationService(app, { ...mutationOptions, getMemoTimeFormat: () => "HH:mm" }, gateway);
	let snapshotId = 0;
	const trash = new IndependentTrashService(app, new TrashSnapshotStore(app, () => "Knomo"), {
		getLogicalDateForPath: async () => DATE, getOriginalDailyFile: async () => file, getDailyFileForDate: async () => file,
		updateCatalogPartition, refreshCatalogPaths: async () => {}, newSnapshotId: () => "s_" + (++snapshotId),
	}, gateway);
	const command = new MemoCommandService(app, catalog, { getMemoTimeFormat: () => "HH:mm", getTrashService: () => trash,
		now: () => new Date(2026, 7, 22, 12), refreshCatalogPaths: async () => {},
		refreshLocalCatalog: async () => { throw new Error("Unexpected refresh"); }, rebuildLocalCatalog: async () => {} }, mutations);
	Object.assign(primary.view, { memoCommandService: command });
	return { ...primary, memos, read, loadMemos, command, trash, catalog, body: () => vault.read(PATH)!,
		randomLoads: () => randomLoads, createView, externalReplace, failCatalog: () => { failCatalog = true; },
		afterCatalogPublished: (action: () => Promise<void>) => { afterPublished = action; },
		setDiscoveryGate: (gate: Promise<MemoViewItem[]> | null) => { discoveryGate = gate; },
		edit: (memo: MemoViewItem, content: string) => command.edit(memo.catalog!, content) };
}

interface TestView {
	renderUiState: () => void;
	getCurrentCardFlowPresentation: () => import("../src/ui/KnomoCardFlowPresenter").CardFlowPresentation;
	deferMobileCardFlowRender: (id: string | null, force: boolean, intent: "content-change") => boolean;
	getTodayTimeBuoyItems: () => import("../src/ui/TimeBuoyViewController").TimeBuoyTabItem[];
	confirmedDailyMemos?: import("../src/ui/ConfirmedMemoPresentation").ConfirmedMemoPresentation;
	projectConfirmedTimeBuoySnapshot: (snapshot: import("../src/ui/TimeBuoyViewController").TimeBuoyViewSnapshot) => import("../src/ui/TimeBuoyViewController").TimeBuoyViewSnapshot;
	handleConfirmedDailyMemoChange: (change: ConfirmedDailyMemoPresentation) => void;
	handleConfirmedCatalogSettled: (change: DailyMemoPresentationChange) => void;
	invalidateConfirmedDailyMemos: () => void;
	checkConfirmedDailyFile: (path: string) => void;
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
		getDailyNotesStatus: () => ({ enabled: true }), isComposerCreationAvailable: () => true,
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

function attachCardFlow(view: TestView, timeBuoy = false) {
	const dom = new JSDOM("<body><main></main></body>");
	const originalHTMLElement = globalThis.HTMLElement;
	globalThis.HTMLElement = dom.window.HTMLElement;
	const root = dom.window.document.querySelector("main")!;
	Object.assign(dom.window.HTMLElement.prototype, {
		instanceOf(this: HTMLElement, constructor: typeof HTMLElement) { return this instanceof constructor; },
		hasClass(this: HTMLElement, name: string) { return this.classList.contains(name); },
		getAttr(this: HTMLElement, name: string) { return this.getAttribute(name); },
		setAttr(this: HTMLElement, name: string, value: string) { this.setAttribute(name, value); },
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
	};
	const renderCard = (container: HTMLElement, memo: MemoViewItem) => {
		const card = dom.window.document.createElement("article"); card.className = "knomo-card";
		card.setAttribute("data-memo-id", memo.id); card.setAttribute("data-memo-render-key", memo.catalog!.renderKey);
		card.setAttribute("data-time-presentation", JSON.stringify({ mode: "full" }));
		const body = dom.window.document.createElement("div"); body.className = "knomo-card-content"; body.textContent = memo.contentSnapshot;
		const checkbox = dom.window.document.createElement("input"); checkbox.type = "checkbox";
		checkbox.setAttribute("data-knomo-memo-id", memo.id); checkbox.setAttribute("data-knomo-task-index", "0"); body.append(checkbox);
		const image = dom.window.document.createElement("img"); image.src = "https://example.test/image.png"; body.append(image);
		card.append(body); container.append(card); return card;
	};
	const render = () => timeBuoy ? renderingView.renderTimeBuoyPage() : renderingView.syncCardFlowPresentation({
		type: "items", mode: "memo", headers: [], memos: view.getFilteredMemos(),
	}, null);
	Object.assign(view, {
		cardFlowEl: root, renderedCardMemos: new Map(), popupState: { activeMenuMemoId: null },
		containerEl: { win: dom.window }, getA11yId: () => "buoy", getInitialCardBatchSize: () => 20,
		cardFlowCoordinator: { generation: 1, clearMobileBatchContinuation: () => {}, removeSentinel: () => {},
			getPendingVisibleCount: () => null, syncBatch: () => {}, resetFlowRuntime: () => {} },
		memoMarkdownRenderer: { retainCard: () => {}, releaseCard: () => {}, refreshSearchHits: () => {}, clear: () => {} },
		cardImageCache: { capture: () => {} }, cardImageLoadQueue: { clear: () => {} },
		timeBuoyPanelEl: null, timeBuoyRenderItems: [], timeBuoyRenderedCount: 0, timeBuoyBatchFrameId: null,
		timeBuoyLoadMoreObserver: null,
		prepareRecentTimeFlow: () => { Object.assign(view, { recentTimeFlowContext: { enabled: false, dates: [], pinnedKeys: new Set() },
			recentDecorations: { next: () => null } }); },
		renderCardForMode: renderCard, renderMemoCardInContainer: renderCard, removeCardElement: (card: HTMLElement) => card.remove(),
		renderTimeBuoyIntro: () => null, renderCardFlowSentinelIfNeeded: () => {}, renderHistoryLoadMore: () => {},
		syncCardMenuState: () => {}, restorePendingCardFlowScrollTop: () => {},
		getCardFlowScrollTop: () => root.scrollTop, restoreCardFlowScrollTop: (scroll: number) => { root.scrollTop = scroll; },
		renderCardFlow: render, renderUiState: (options?: { renderCardFlow?: boolean }) => { if (options?.renderCardFlow !== false) render(); },
	});
	render();
	return { root, render, findMemo: (id: string) => renderingView.findMemoById(id),
		dispose: () => { view.trashViewClosed = true; globalThis.HTMLElement = originalHTMLElement; dom.window.close(); } };
}

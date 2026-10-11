import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { TFile } from "obsidian";
import type { MemoViewItem } from "../src/types/memoView";
import type { MemoSaveResult } from "../src/types/catalogView";
import type { MarkdownCatalogCommitInput } from "../src/services/MarkdownMutationService";
import type { DailyMemoPresentationChange } from "../src/services/DailyMemoPresentationChange";
import { ensureObsidianStub } from "./helpers/obsidianStub";

test("真实 Daily 编辑改变 key 后原位更新重逢卡片，保留本组与原编辑句柄", async () => {
	const h = await fixture();
	const original = h.memos[0]!;
	h.view.editingMemo = original;
	const result = await h.edit(original, "changed body\nsecond line");
	assert.notEqual(result.memo?.key, original.id);
	await h.view.finishComposerSave(Promise.resolve(result), [], original);
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
	const get = h.catalog.getObservation.bind(h.catalog);
	let changed = false;
	t.mock.method(h.catalog, "getObservation", async (key: string) => {
		const observation = await get(key);
		if (!changed) {
			changed = true;
			await h.externalReplace("## Memos\n- 09:00 replaced\n- 10:00 same\n");
		}
		return observation;
	});
	await assert.rejects(h.read.readMemoItems([handle]), /snapshot changed/iu);
});

test("Catalog 后续失败不回滚已写入的 Daily，旧展示失效并可重新抽样", async () => {
	const h = await fixture();
	h.failCatalog();
	const result = await h.edit(h.memos[0]!, "written");
	assert.equal(result.localRefreshPending, true);
	assert.match(h.body(), /written/u);
	await h.view.finishComposerSave(Promise.resolve(result), [], h.memos[0]!);
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

test("迟到的编辑和任务查询查不到旧版本时保留最新卡片", async t => {
	for (const kind of ["composer", "task"] as const) {
		const h = await fixture({ body: "## Memos\n- 09:00 - [ ] todo @2026-10-10\n- 10:00 same\n" });
		h.view.memos = [...h.memos];
		await h.buoy.loadInitial();
		h.view.catalogTodayTimeBuoys = h.buoy.getSnapshot();
		const original = h.memos[0]!;
		const entered = deferred<void>(), release = deferred<void>();
		const read = h.command.getReadService(), query = read.query.bind(read);
		let first = true;
		t.mock.method(read, "query", async (request: Parameters<typeof query>[0]) => {
			if (first) { first = false; entered.resolve(); await release.promise; }
			return query(request);
		});
		const finishing = kind === "composer"
			? h.view.finishComposerSave(h.edit(original, "first @2026-10-10"), [], original)
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
	await h.view.finishComposerSave(Promise.resolve(first), [], original);
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
	await h.view.finishComposerSave(Promise.resolve(result), [], h.memos[0]!);
	assert.equal(list.mock.callCount(), 0);
	assert.equal(shuffle.mock.callCount(), 0);
});

const DATE = "2026-08-22";
const PATH = "Daily/" + DATE + ".md";

async function fixture(options: { body?: string } = {}) {
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
		const random = new RandomReunionController({ loadRandomReunionMemos: async () => { randomLoads++; return discover(); },
			openRandomReunionMemo: async () => {}, markRandomReunionReviewed: async () => {}, isRandomActive: () => true,
			showNotice: () => {}, requestRender: () => {} });
		const shuffle = new ShuffleDayController({ loadSelectedDate: loadMemos,
			selectShuffleDay: async () => { const selected = await discover();
				return { status: "ready", selectedDate: DATE, memos: selected, stats: buildShuffleDayStats(selected) }; },
			acceptSelection: async () => {}, isShuffleDayActive: () => true, showNotice: () => {}, requestRender: () => {} });
		await random.refresh();
		await shuffle.refresh();
		const buoy = new TimeBuoyViewController({ getNow: () => new Date(2026, 9, 10),
			queryPage: request => read.queryTimeBuoyPage(request), queryDate: (date, cursor) => read.queryTimeBuoysForDate(date, cursor),
			requestRender: () => {} });
		const view = Object.create(KnomoView.prototype) as TestView;
		Object.assign(view, { memos: [], editingMemo: null, viewStateController: new KnomoViewStateController(),
			randomReunionController: random, shuffleDayController: shuffle,
			timeBuoyViewController: buoy, catalogReadService: read, catalogTodayTimeBuoys: null, trashViewClosed: false,
			catalogDesktopQueryRun: 0, catalogMobileQueryRun: 0,
			reloadMemos: async () => { view.memos = await loadMemos(); return true; },
			settingsService: { getSettings: () => ({ timeBuoyEnabled: false }) }, renderedTimeBuoyEnabled: false,
			waitForAllMemosLoading: async () => {}, renderCardFlow: () => {}, renderUiState: () => {}, showTimeBuoySaveFeedback: () => {} });
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
		if (failCatalog) throw new Error("Catalog unavailable");
		await plugin.updateCommittedCatalogPartition(input);
	};
	const gateway = new DailyMemoWriteGateway(app, parser);
	const mutations = new MarkdownMutationService(app, { getWriteHeading: () => "## Memos", getDailyFileForDate: async () => file,
		getLogicalDateForPath: () => DATE, getMemoTimeFormat: () => "HH:mm",
		updateCatalogPartition, refreshCatalogPaths: async () => {} }, gateway);
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
	viewStateController: import("../src/ui/KnomoViewStateController").KnomoViewStateController;
	setSidebarNav: (nav: "random" | "shuffleDay") => void;
	returnFromRecordStats: () => void;
	memos: MemoViewItem[];
	editingMemo: MemoViewItem | null;
	trashViewClosed: boolean;
	refresh: () => Promise<void>;
	reloadMemos: () => Promise<boolean>;
	catalogTodayTimeBuoys: import("../src/ui/TimeBuoyViewController").TimeBuoyViewSnapshot | null;
	finishComposerSave: (result: Promise<MemoSaveResult>, dates: readonly string[], previousMemo: MemoViewItem) => Promise<void>;
	handleCatalogTaskToggle: (memo: MemoViewItem, taskIndex: number, checked: boolean) => Promise<void>;
	handleDailyMemoPresentationChange: (change: DailyMemoPresentationChange) => Promise<void>;
	refreshRandomReunionBatch: () => Promise<void>;
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(yes => { resolve = yes; });
	return { promise, resolve };
}

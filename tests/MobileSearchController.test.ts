import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

import type { MemoViewItem } from "../src/types/memoView";
import type { RecordStatsSearchFilter } from "../src/ui/viewFilters";
import { ensureObsidianStub } from "./helpers/obsidianStub";
import { CatalogQueryCancelledError } from "../src/services/MemoCatalogStore";

test("Workspace恢复仅还原移动已提交条件，下次打开沿用且不恢复弹层或草稿", async () => {
	await ensureObsidianStub();
	const { MobileSearchController } = await import("../src/ui/MobileSearchController");
	let saves = 0;
	const queries: Parameters<LoadRemoteResults>[0][] = [];
	const { controller, dispatch } = createControllerHarness(MobileSearchController, [], undefined,
		async filter => { queries.push(filter); }, { onAppliedStateChanged: () => { saves++; } });
	controller.applyWorkspaceState({ input: "memo", shortcut: "last-7", recordStatsSearchFilter: null });
	assert.equal(controller.isOpen, false);
	assert.equal(queries.length, 0);
	assert.equal(saves, 0);
	controller.session.updateDraft("unsubmitted");
	assert.deepEqual(controller.exportWorkspaceState(), { input: "memo", shortcut: "last-7", recordStatsSearchFilter: null });
	controller.applyWorkspaceState(controller.exportWorkspaceState());
	controller.openPage({ focusInput: false });
	await new Promise<void>(resolve => setImmediate(resolve));
	assert.deepEqual(queries[0].textTerms, ["memo"]);
	const input = controller.input as unknown as TestElement;
	input.value = "draft";
	dispatch(input, "input", createKeyboardEvent(""));
	assert.equal(saves, 0, "keyup与未提交草稿不保存Workspace布局");
	controller.flushQuery();
	assert.equal(saves, 1);
	assert.equal(controller.exportWorkspaceState().input, "draft");
	controller.removePage();
});

test("Workspace不保存移动超长已提交搜索，live条件保持原文", async () => {
	await ensureObsidianStub();
	const { MobileSearchController } = await import("../src/ui/MobileSearchController");
	const { controller } = createControllerHarness(MobileSearchController, []);
	const query = "q".repeat(4097);
	controller.searchQuery = query;
	assert.equal(controller.exportWorkspaceState().input, "");
	assert.equal(controller.searchQuery, query);
	assert.equal(controller.session.applied.input, query);
	controller.removePage();
});

type MobileSearchControllerConstructor = typeof import("../src/ui/MobileSearchController").MobileSearchController;
type MobileSearchControllerInstance = InstanceType<MobileSearchControllerConstructor>;
type MobileSearchControllerOptions = ConstructorParameters<MobileSearchControllerConstructor>[0];
type LoadRemoteResults = NonNullable<MobileSearchControllerOptions["loadRemoteResults"]>;

test("查询取消：移动草稿变化立即停止旧读取，后续只提交新条件", async () => {
	await ensureObsidianStub();
	const { MobileSearchController } = await import("../src/ui/MobileSearchController");
	const memos = [makeMemo("alpha", "alpha")];
	const signals: AbortSignal[] = [];
	const { controller, root } = createControllerHarness(MobileSearchController, memos, undefined,
		async (filter, _reset, signal) => {
			signals.push(signal);
			if (filter.textTerms?.[0] === "alpha") {
				await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
			} else memos.splice(0, memos.length, makeMemo("beta", "beta"));
		});
	controller.searchQuery = "alpha";
	controller.openPage({ focusInput: false });
	controller.queueQuery("beta");
	assert.equal(signals[0].aborted, true);
	controller.searchQuery = "beta";
	await new Promise<void>(resolve => setImmediate(resolve));
	assert.equal(signals[1].aborted, false);
	assert.equal(controller.session.result?.input, "beta");
	assert.deepEqual(root.findAll(".knomo-card").map(card => card.getAttr("data-memo-id")), ["beta"]);
	assert.equal(controller.session.requestStatus, "ready");
	controller.removePage();
});

test("查询取消：移除移动页面只停止本视图请求，runtime取消不显示错误", async () => {
	await ensureObsidianStub();
	const { MobileSearchController } = await import("../src/ui/MobileSearchController");
	const signals: AbortSignal[] = [];
	const loader: LoadRemoteResults = (_filter, _reset, signal) => {
		signals.push(signal);
		return new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
	};
	const first = createControllerHarness(MobileSearchController, [], undefined, loader).controller;
	const second = createControllerHarness(MobileSearchController, [], undefined, loader).controller;
	first.searchQuery = "memo"; second.searchQuery = "memo";
	first.openPage({ focusInput: false }); second.openPage({ focusInput: false });
	first.removePage();
	assert.equal(signals[0].aborted, true);
	assert.equal(signals[1].aborted, false);
	second.removePage();
	const runtime = createControllerHarness(MobileSearchController, [], undefined, async () => { throw new CatalogQueryCancelledError(); });
	runtime.controller.searchQuery = "memo";
	runtime.controller.openPage({ focusInput: false });
	await new Promise<void>(resolve => setImmediate(resolve));
	assert.equal(runtime.controller.session.requestStatus, "idle");
	assert.equal(runtime.root.findAll(".knomo-empty-description").some(element => element.getText().includes("cancelled")), false);
	runtime.controller.removePage();
	const failure = createControllerHarness(MobileSearchController, [], undefined, async () => { throw new Error("Vault read failed"); });
	failure.controller.searchQuery = "memo";
	failure.controller.openPage({ focusInput: false });
	await new Promise<void>(resolve => setImmediate(resolve));
	assert.equal(failure.controller.session.requestStatus, "failed");
	failure.controller.applyMemoChanges(new Map([["unrelated", makeMemo("updated", "other")]]));
	assert.equal(failure.controller.session.requestStatus, "failed", "无关变化不能清除既有读取失败状态");
	failure.controller.removePage();
});

test("Things 移动搜索显示组合摘要，关闭保留搜索与日期，标签改变使状态键失效", async () => {
	await ensureObsidianStub();
	const { MobileSearchController } = await import("../src/ui/MobileSearchController");
	let tag = "project";
	let saved: unknown;
	const { controller, root } = createControllerHarness(MobileSearchController, [makeMemo("one", "release")], () => 1, undefined, {
		getThingsContext: () => ({ activeNav: "things", activeTag: tag, activeTagKey: tag }),
		syncThingsSearch: (query, date) => { saved = [query, date]; },
	});
	controller.searchQuery = "release";
	controller.searchDateFilter = "week";
	controller.openPage({ focusInput: false });
	assert.match(root.find(".knomo-list-summary")!.getText(), /Things.*project.*release/);
	const previous = controller.getViewStateKey();
	tag = "other";
	assert.notEqual(controller.getViewStateKey(), previous);
	controller.closePage();
	assert.deepEqual(saved, ["release", "week"]);
	assert.equal(controller.searchQuery, "release");
	assert.equal(controller.searchDateFilter, "week");
});

test("移动搜索仅渲染当前页的匹配卡片，状态键跟随可见结果和分页变化", async () => {
	await ensureObsidianStub();
	const { MobileSearchController } = await import("../src/ui/MobileSearchController");
	const memos = [makeMemo("memo-1", "alpha memo"), makeMemo("memo-2", "beta memo"), makeMemo("note-1", "other")];
	const { controller, root } = createControllerHarness(MobileSearchController, memos);

	controller.searchQuery = "memo";
	controller.openPage({ focusInput: false });
	assert.deepEqual(root.findAll(".knomo-card").map(card => card.getAttr("data-memo-id")), ["memo-1"]);
	const key = controller.getStateKey();
	memos[2] = { ...memos[2], contentHash: "unmatched-change" };
	assert.equal(controller.getStateKey(), key);

	controller.loadMore();
	assert.deepEqual(root.findAll(".knomo-card").map(card => card.getAttr("data-memo-id")), ["memo-1", "memo-2"]);
	assert.notEqual(controller.getStateKey(), key);
	controller.closePage();
	assert.deepEqual(root.findAll(".knomo-card"), []);
});

test("mobile search summary uses the complete remote match count before later pages load", async () => {
	await ensureObsidianStub();
	const { MobileSearchController } = await import("../src/ui/MobileSearchController");
	const memos = Array.from({ length: 50 }, (_, index) => makeMemo(`memo-${index + 1}`, "project memo"));
	const { controller, root } = createControllerHarness(MobileSearchController, memos, () => 90);

	controller.searchQuery = "project";
	controller.openPage({ focusInput: false });

	assert.equal(root.find(".knomo-list-summary")?.getText(), "Found 90 Memos for “project”");
});

test("总数晚到只更新摘要，保留卡片、滚动和正在加载的图片", async () => {
	await ensureObsidianStub();
	const { MobileSearchController } = await import("../src/ui/MobileSearchController");
	let total: number | null = null, clears = 0;
	const { controller, root, state } = createControllerHarness(MobileSearchController,
		[makeMemo("one", "memo"), makeMemo("two", "memo")], () => total, undefined, {
			batchSize: 2, clearImages: () => { clears++; }, clearMarkdown: () => { clears++; },
		});
	controller.searchQuery = "memo";
	controller.openPage({ focusInput: false });
	const card = root.find(".knomo-card");
	const before = clears;
	const results = controller.results as unknown as TestElement;
	results.scrollTop = 128;
	total = 90;
	controller.renderResults("content-change", false, true);
	assert.equal(root.find(".knomo-card"), card);
	assert.deepEqual(state.renderedMemoIds, ["one", "two"]);
	assert.equal(clears, before);
	assert.equal(results.scrollTop, 128);
	assert.equal(root.find(".knomo-list-summary")?.getText(), "Found 90 Memos for “memo”");
	const frames = new Map<number, () => void>();
	let frameId = 0;
	total = null;
	const chunked = createControllerHarness(MobileSearchController,
		Array.from({ length: 14 }, (_, index) => makeMemo(String(index), "memo")), () => total, undefined, {
			batchSize: 14, hasRemoteNextPage: () => true,
			scheduleRenderTask: callback => { frames.set(++frameId, callback); return frameId; },
			cancelRenderTask: frame => { frames.delete(frame); },
		});
	chunked.controller.searchQuery = "memo"; chunked.controller.openPage({ focusInput: false });
	const ongoing = [...frames.values()][0];
	const firstCard = chunked.root.find(".knomo-card");
	total = 90;
	chunked.controller.renderResults("content-change", false, true);
	assert.equal([...frames.values()][0], ongoing);
	assert.equal(chunked.root.find(".knomo-card"), firstCard);
	while (frames.size) { const [frame, callback] = [...frames][0]; frames.delete(frame); callback(); }
	assert.equal(chunked.state.renderedMemoIds.length, 14);
	assert.equal(chunked.root.findAll(".knomo-list-summary").length, 1);
	assert.equal(chunked.root.find(".knomo-mobile-search-more")?.getText(), "Load more (76 remaining)");
});

test("空搜索收到晚到计数不显示加载入口，清空关键词后仍保持提示", async () => {
	await ensureObsidianStub();
	const { MobileSearchController } = await import("../src/ui/MobileSearchController");
	let total: number | null = null;
	const { controller, root } = createControllerHarness(MobileSearchController,
		Array.from({ length: 50 }, (_, index) => makeMemo(String(index), "memo")), () => total, undefined, {
			batchSize: 12, hasRemoteNextPage: () => true,
		});
	const receiveCount = () => {
		total = 90;
		controller.renderResults("content-change", false, true);
		assert.equal(root.findAll(".knomo-mobile-search-empty").length, 1);
		assert.equal(root.findAll(".knomo-card").length, 0);
		assert.equal(root.find(".knomo-list-summary"), null);
		assert.equal(root.find(".knomo-mobile-search-more"), null);
	};
	controller.openPage({ focusInput: false });
	receiveCount();
	controller.searchQuery = "memo";
	controller.renderResults("view-scope-change");
	assert.equal(root.findAll(".knomo-card").length, 12);
	controller.searchQuery = "";
	total = null;
	controller.renderResults("view-scope-change");
	receiveCount();
});

test("移动搜索等待中文选字，最终 input 不重复查询，关闭取消待提交文本", async () => {
	await ensureObsidianStub();
	const { MobileSearchController } = await import("../src/ui/MobileSearchController");
	const tasks = new Map<number, () => void>();
	let id = 0;
	const queries: string[] = [];
	const { controller, dispatch } = createControllerHarness(MobileSearchController, [], undefined,
		async query => { queries.push((query.textTerms ?? []).join(" ")); }, {
			getWindow: () => ({ setTimeout: (callback: () => void) => { tasks.set(++id, callback); return id; },
				clearTimeout: (task: number) => tasks.delete(task) }) as unknown as Window,
		});
	controller.openPage({ focusInput: false });
	const input = controller.input as unknown as TestElement;
	input.value = "z";
	dispatch(input, "input", createKeyboardEvent(""));
	dispatch(input, "compositionstart", createKeyboardEvent(""));
	input.value = "zhong";
	dispatch(input, "input", createKeyboardEvent(""));
	assert.equal(tasks.size, 0);
	input.value = "中文";
	dispatch(input, "compositionend", createKeyboardEvent(""));
	dispatch(input, "input", createKeyboardEvent(""));
	assert.equal(tasks.size, 1);
	for (const callback of [...tasks.values()]) callback();
	tasks.clear();
	await Promise.resolve();
	assert.deepEqual(queries, ["中文"]);
	input.value = "next";
	dispatch(input, "input", createKeyboardEvent(""));
	controller.closePage();
	assert.equal(tasks.size, 0);
});

test("mobile record stats filter refreshes remote results and renders its summary", async () => {
	await ensureObsidianStub();
	const { MobileSearchController } = await import("../src/ui/MobileSearchController");
	const recordStatsFilter: RecordStatsSearchFilter = {
		type: "range",
		startDate: "2026-06-01",
		endDateExclusive: "2026-07-01",
	};
	const remoteCalls: unknown[][] = [];
	const { controller, root } = createControllerHarness(
		MobileSearchController,
		[makeMemo("memo-1", "project memo")],
		() => 13,
		async (...args) => {
			remoteCalls.push(args);
		},
	);

	controller.searchRecordStatsFilter = recordStatsFilter;
	controller.openPage({
		focusInput: false,
		changeIntent: "view-scope-change",
	});
	await Promise.resolve();

	assert.deepEqual(remoteCalls.map(([filter, reset]) => [filter, reset]), [[{ fromDate: "2026-06-01", toDate: "2026-06-30" }, true]]);
	assert.ok(remoteCalls[0][2] instanceof AbortSignal);
	assert.equal(remoteCalls[0][2].aborted, false);
	assert.equal(root.find(".knomo-list-summary")?.getText(), "2026-06-01 to 2026-06-30: 13 Memos");
});

test("mobile search opens, syncs the page, and closes from Escape", async () => {
	await ensureObsidianStub();
	const { MobileSearchController } = await import("../src/ui/MobileSearchController");
	const { controller, root, state, dispatch } = createControllerHarness(MobileSearchController, [
		makeMemo("memo-1", "alpha memo"),
	]);

	controller.searchQuery = "alpha";
	controller.openPage();

	const page = controller.page as unknown as TestElement;
	const input = controller.input as unknown as TestElement;
	const results = controller.results as unknown as TestElement;
	assert.equal(controller.isOpen, true);
	assert.equal(root.find(".knomo-mobile-search-page"), page);
	assert.equal(input.value, "alpha");
	assert.equal(input.focusCount, 1);
	assert.deepEqual(state.pausedStates, [true]);
	assert.equal(state.closeSurroundingChromeCount, 1);
	assert.equal(state.syncRootStateCount, 1);
	assert.deepEqual(state.renderedMemoIds, ["memo-1"]);

	controller.syncPage();
	assert.equal(page.hasClass("is-open"), true);
	assert.equal(page.getAttr("aria-hidden"), "false");
	assert.equal(page.getAttr("inert"), null);
	assert.deepEqual(state.bodyToggleCalls, [{ cls: "knomo-mobile-search-active", active: true }]);

	const event = createKeyboardEvent("Escape");
	dispatch(input, "keydown", event);

	assert.equal(event.defaultPrevented, true);
	assert.equal(event.propagationStopped, true);
	assert.equal(controller.isOpen, false);
	assert.equal(controller.searchQuery, "");
	assert.equal(input.value, "");
	assert.equal(results.childCount, 0);
	assert.deepEqual(state.pausedStates, [true, false]);
	assert.equal(state.closeCardMenuCount, 1);
	assert.equal(state.syncRootStateCount, 2);
	assert.deepEqual(state.restoredCardFlowScrolls, [48]);
});

test("mobile search date filters reset visible results and clear record stats filters", async () => {
	await ensureObsidianStub();
	const { MobileSearchController } = await import("../src/ui/MobileSearchController");
	const { controller, root } = createControllerHarness(MobileSearchController, [
		makeMemo("memo-1", "alpha memo"),
		makeMemo("memo-2", "beta memo"),
		makeMemo("memo-3", "other"),
	]);
	const recordStatsFilter: RecordStatsSearchFilter = {
		type: "range",
		startDate: "2026-06-01",
		endDateExclusive: "2026-07-01",
	};

	controller.searchQuery = "memo";
	controller.openPage({ focusInput: false });
	controller.loadMore();
	assert.equal(controller.searchVisibleCount, 2);
	assert.deepEqual(root.findAll(".knomo-card").map(card => card.getAttr("data-memo-id")), ["memo-1", "memo-2"]);

	controller.searchRecordStatsFilter = recordStatsFilter;
	controller.setDateFilter("week");

	assert.equal(controller.searchVisibleCount, 1);
	assert.equal(controller.searchDateFilter, "week");
	assert.equal(controller.searchRecordStatsFilter, null);
	assert.deepEqual(root.findAll(".knomo-card").map(card => card.getAttr("data-memo-id")), ["memo-1"]);
	const weekButton = root.find("[data-search-date='week']");
	assert.equal(weekButton?.hasClass("is-active"), true);
	assert.equal(weekButton?.getAttr("aria-pressed"), "true");
});

function makeMemo(id: string, content: string): MemoViewItem {
	return {
		id,
		createdAt: "2026-06-02T00:00:00+08:00",
		updatedAt: "2026-06-02T00:00:00+08:00",
		contentSnapshot: content,
		contentHash: id,
		status: "active",
		tags: [],
		links: [],
		images: [],
		dailyRef: {
			path: "Journal/2026-06-02.md",
			heading: null,
			lineNumberHint: 1,
		},
	};
}

test("mobile search hands off ready images through repeated rebuilds and unbinds closed roots", async () => {
	await ensureObsidianStub();
	const { MobileSearchController } = await import("../src/ui/MobileSearchController");
	const { renderMemoCardImages } = await import("../src/ui/KnomoCardImages");
	const observed = makeMemo("memo", "image memo");
	observed.catalog = { observationHandle: { sourcePath: "Daily.md", sourceRevision: "1", startLine: 1, endLine: 2, rawBlockHash: "same" } } as NonNullable<MemoViewItem["catalog"]>;
	let loads = 0;
	const roots: (HTMLElement | null)[] = [];
	const { controller, root } = createControllerHarness(MobileSearchController, [observed], undefined, undefined, {
		bindImageRoot: (el) => roots.push(el),
		renderMemoCard: (container, memo, _generation, _index, reuse) => {
			const rendered = renderMemoCardImages(container.createDiv({cls:"knomo-card"}), memo,
				[{raw:"![[image.png]]", path:"image.png", url:"app://image.png", isRemote:false}], {previewLabel:"Preview", unavailableLabel:"Unavailable"}, reuse);
			for (const item of rendered?.loadItems ?? []) { loads++; item.imageEl.setAttr("src", item.src); item.onLoad?.(); }
		},
	});
	controller.searchQuery = "image"; controller.openPage({focusInput:false});
	const original = root.find("img");
	for (let i=0; i<3; i++) controller.renderResults("view-scope-change");
	assert.equal(root.find("img"), original); assert.equal(loads, 1);
	controller.searchQuery = "no matches"; controller.renderResults("view-scope-change");
	assert.equal(root.find("img"), null);
	controller.searchQuery = "image"; controller.renderResults("view-scope-change");
	assert.equal(root.find("img"), original); assert.equal(loads, 1);
	controller.searchQuery = "no matches"; controller.renderResults("view-scope-change");
	controller.clearImageCache();
	controller.searchQuery = "image"; controller.renderResults("view-scope-change");
	assert.equal(loads, 2); assert.notEqual(root.find("img"), original);
	controller.searchQuery = "no matches"; controller.renderResults("view-scope-change");
	controller.closePage(); assert.equal(roots[roots.length - 1], null);
	controller.searchQuery = "image"; controller.openPage({focusInput:false});
	assert.equal(roots[roots.length - 1], controller.results);
	assert.equal(loads, 2);
	assert.notEqual(root.find("img"), original);
	const beforeClose = root.find("img");
	controller.closePage();
	controller.searchQuery = "image"; controller.openPage({ focusInput: false });
	assert.equal(loads, 2, "关闭非空筛选结果也应先收集已加载图片");
	assert.equal(root.find("img"), beforeClose);
	controller.removePage(); assert.equal(roots[roots.length - 1], null);
});

test("移动搜索追加保留已有卡片和 generation，正文改变时安全重建", async () => {
	await ensureObsidianStub();
	const { MobileSearchController } = await import("../src/ui/MobileSearchController");
	const memos = [makeMemo("one", "memo one"), makeMemo("two", "memo two"), makeMemo("three", "memo three")];
	let clears = 0;
	const { controller, root, state } = createControllerHarness(MobileSearchController, memos, undefined, undefined, {
		clearImages: () => { clears++; },
	});
	controller.searchQuery = "memo"; controller.openPage({ focusInput:false });
	const original = root.find(".knomo-card");
	controller.loadMore();
	assert.equal(root.find(".knomo-card"), original);
	assert.deepEqual(state.renderedMemoIds, ["one", "two"]);
	assert.equal(clears, 1);
	memos[0] = { ...memos[0], contentHash:"changed", contentSnapshot:"changed memo" };
	controller.loadMore();
	assert.notEqual(root.find(".knomo-card"), original);
	assert.equal(clears, 2);
});

test("移动搜索分帧追加且关闭取消未完成渲染", async () => {
	await ensureObsidianStub();
	const { MobileSearchController } = await import("../src/ui/MobileSearchController");
	const frames = new Map<number, () => void>();
	let id = 0;
	const { controller, state } = createControllerHarness(MobileSearchController,
		Array.from({length:14}, (_, index) => makeMemo(String(index), "memo")), undefined, undefined, {
			batchSize:14,
			scheduleRenderTask: callback => { frames.set(++id, callback); return id; },
			cancelRenderTask: frame => { frames.delete(frame); },
		});
	controller.searchQuery = "memo"; controller.openPage({focusInput:false});
	assert.ok(state.renderedMemoIds.length > 0 && state.renderedMemoIds.length <= 6);
	assert.equal(frames.size, 1);
	const late = [...frames.values()][0];
	controller.closePage();
	const count = state.renderedMemoIds.length;
	assert.equal(frames.size, 0);
	late();
	assert.equal(state.renderedMemoIds.length, count);
});

test("连续分帧重建保留最初滚动目标，用户滚动和范围切换使旧目标失效", async () => {
	await ensureObsidianStub();
	const { MobileSearchController } = await import("../src/ui/MobileSearchController");
	const frames = new Map<number, () => void>();
	let id = 0;
	const restored: number[] = [];
	const guards: Array<() => boolean> = [];
	const priorities: number[] = [];
	const { controller, dispatch } = createControllerHarness(MobileSearchController,
		Array.from({ length: 30 }, (_, index) => makeMemo(String(index), "memo")), undefined, undefined, {
			batchSize: 30,
			scheduleRenderTask: callback => { frames.set(++id, callback); return id; },
			cancelRenderTask: frame => { frames.delete(frame); },
			restoreElementScrollTop: (element, top, isCurrent) => { restored.push(top!); element!.scrollTop = top!; guards.push(isCurrent!); },
			prioritizeMarkdown: (_root, top) => { priorities.push(top); },
		});
	const drain = () => {
		while (frames.size) {
			const [frame, callback] = [...frames][0]; frames.delete(frame); callback();
		}
	};
	controller.searchQuery = "memo"; controller.openPage({ focusInput: false }); drain();
	const results = controller.results as unknown as TestElement;
	results.scrollTop = 2400;
	controller.renderResults();
	assert.equal(results.scrollTop, 0);
	controller.renderResults(); drain();
	assert.equal(restored.at(-1), 2400);
	assert.ok(priorities.includes(2400));
	assert.equal(guards.at(-1)!(), true);
	const restoreCount = restored.length;
	controller.renderResults();
	dispatch(results, "wheel", createKeyboardEvent(""));
	results.scrollTop = 160;
	drain();
	assert.equal(restored.length, restoreCount);
	assert.equal(results.scrollTop, 160);
	controller.renderResults();
	assert.equal(guards.at(-1)!(), false);
	dispatch(results, "touchstart", createKeyboardEvent(""));
	results.scrollTop = 125;
	controller.renderResults(); drain();
	assert.equal(restored.at(-1), 125);
	dispatch(results, "wheel", createKeyboardEvent(""));
	assert.equal(guards.at(-1)!(), false);
	controller.renderResults();
	controller.renderResults("view-scope-change"); drain();
	assert.equal(restored.at(-1), 0);
	controller.removePage();
});

test("连续重建复用未变正文快照，深处尚未创建的卡片也保留快照且不复用旧交互", async () => {
	await ensureObsidianStub();
	const { MobileSearchController } = await import("../src/ui/MobileSearchController");
	const dom = new JSDOM("<body></body>");
	const frames = new Map<number, () => void>();
	const cards = new Map<string, HTMLElement>();
	const memos = Array.from({ length: 30 }, (_, index) => makeMemo(String(index), "**memo**"));
	let id = 0, rebuilding = false;
	const { controller } = createControllerHarness(MobileSearchController, memos, undefined, undefined, {
		batchSize: 30,
		scheduleRenderTask: callback => { frames.set(++id, callback); return id; },
		cancelRenderTask: frame => { frames.delete(frame); },
		renderMemoCard: (_container, memo) => {
			const card = dom.window.document.createElement("article");
			card.innerHTML = rebuilding
				? '<div class="knomo-card-content"><div data-knomo-render-placeholder>**memo**</div></div>'
				: '<div class="knomo-card-content"><p><strong>memo</strong><input data-knomo-memo-id="old"></p></div>';
			cards.set(memo.id, card);
			return card;
		},
	});
	const drain = () => {
		while (frames.size) {
			const [frame, callback] = [...frames][0]; frames.delete(frame); callback();
		}
	};
	try {
		controller.searchQuery = "memo"; controller.openPage({ focusInput: false }); drain();
		rebuilding = true;
		controller.renderResults(); controller.renderResults(); drain();
		assert.equal(cards.get("29")!.querySelector("strong")?.textContent, "memo");
		assert.equal(cards.get("29")!.querySelector("[data-knomo-memo-id]"), null);
		assert.ok(cards.get("29")!.querySelector("[inert]"));
		memos[29] = { ...memos[29], contentSnapshot: "changed memo", contentHash: "changed" };
		controller.renderResults(); drain();
		assert.equal(cards.get("29")!.querySelector("strong"), null);
	} finally { controller.removePage(); dom.window.close(); }
});

test("移动搜索提交即时更新深处卡片，保留其它 DOM、滚动与独立结果快照", async () => {
	await ensureObsidianStub();
	const { MobileSearchController } = await import("../src/ui/MobileSearchController");
	const dom = new JSDOM("<body></body>");
	const root = dom.window.document.createElement("div");
	Object.assign(root, {
		find: (selector: string) => root.querySelector(selector),
		findAll: (selector: string) => Array.from(root.querySelectorAll(selector)),
		empty: () => root.replaceChildren(),
		createEl: (tag: string, options: { cls?: string; text?: string; attr?: Record<string, string> }) => {
			const element = dom.window.document.createElement(tag);
			element.className = options.cls ?? ""; element.textContent = options.text ?? "";
			for (const [name, value] of Object.entries(options.attr ?? {})) element.setAttribute(name, value);
			root.append(element); return element;
		},
		createDiv: (options: { cls?: string; text?: string }) => {
			const element = dom.window.document.createElement("div");
			element.className = options.cls ?? ""; element.textContent = options.text ?? "";
			Object.assign(element, { setText: (text: string) => { element.textContent = text; } });
			root.appendChild(element); return element;
		},
	});
	dom.window.document.body.append(root);
	const memos = Array.from({ length: 30 }, (_, index) => makeMemo(String(index), "original memo"));
	const frames = new Map<number, () => void>();
	const released: HTMLElement[] = [];
	let id = 0;
	const { controller } = createControllerHarness(MobileSearchController, memos, undefined, undefined, {
		batchSize: 30, scheduleRenderTask: callback => { frames.set(++id, callback); return id; },
		cancelRenderTask: frame => { frames.delete(frame); }, releaseCard: card => released.push(card),
		renderMemoCard: (_container, memo, _generation, _index, reusedImagesEl) => {
			const card = dom.window.document.createElement("article"); card.className = "knomo-card";
			card.setAttribute("data-memo-id", memo.id);
			const body = dom.window.document.createElement("div"); body.className = "knomo-card-content";
			body.textContent = memo.contentSnapshot; card.append(body);
			if (reusedImagesEl) card.append(reusedImagesEl);
			else if (memo.id === "29") { const images = dom.window.document.createElement("div"); images.className = "knomo-card-images"; card.append(images); }
			root.append(card); return card;
		},
	});
	try {
		controller.searchQuery = "memo"; controller.openPage({ focusInput: false });
		while (frames.size) { const [frame, action] = [...frames][0]; frames.delete(frame); action(); }
		Object.assign(controller, { resultsEl: root }); root.scrollTop = 900;
		const first = root.querySelector('[data-memo-id="0"]');
		const old = root.querySelector<HTMLElement>('[data-memo-id="29"]')!;
		const images = old.querySelector(".knomo-card-images");
		controller.applyMemoChanges(new Map(), [makeMemo("unmatched-new", "outside the active search")]);
		assert.equal(root.querySelector('[data-memo-id="0"]'), first);
		assert.equal(controller.getDisplayedMemos().some(memo => memo.id === "unmatched-new"), false);
		await controller.refreshAppliedResults();
		assert.equal(root.querySelector('[data-memo-id="0"]'), first, "同结果后台查询不能重建搜索页面");
		assert.equal(root.querySelector('[data-memo-id="29"]'), old);
		const updated = { ...memos[29]!, id: "29-current", contentSnapshot: "updated memo", contentHash: "updated" };
		controller.applyMemoChanges(new Map([["29", updated]]));
		assert.equal(root.querySelector('[data-memo-id="0"]'), first);
		assert.equal(root.querySelector('[data-memo-id="29-current"]')?.textContent, "updated memo");
		assert.equal(root.querySelector('[data-memo-id="29"]'), null);
		assert.equal(root.querySelector('[data-memo-id="29-current"] .knomo-card-images'), images);
		assert.equal(root.scrollTop, 900);
		assert.deepEqual(released, [old]);
		assert.equal(controller.getDisplayedMemos().some(memo => memo.id === updated.id), true);
		assert.equal(frames.size, 0);
		controller.applyMemoChanges(new Map([[updated.id, { ...updated, id: "29-unmatched", contentSnapshot: "unmatched" }]]));
		assert.equal(root.querySelectorAll(".knomo-card").length, 29);
		controller.renderResults();
		assert.ok(frames.size > 0);
		const retained = root.querySelector('[data-memo-id="0"]');
		const partial = controller.getDisplayedMemos().find(memo => memo.id === "12")!;
		controller.applyMemoChanges(new Map([[partial.id, { ...partial, id: "12-current", contentSnapshot: "partial memo", contentHash: "partial" }]]));
		assert.equal(root.querySelector('[data-memo-id="0"]'), retained);
		assert.equal(root.querySelector('[data-memo-id="12-current"]')?.textContent, "partial memo");
		while (frames.size) { const [frame, action] = [...frames][0]; frames.delete(frame); action(); }
		assert.equal(root.querySelectorAll(".knomo-card").length, 29);
		assert.equal(root.querySelectorAll('[data-memo-id="12-current"]').length, 1);
		assert.equal(root.querySelector('[data-memo-id="12"]'), null);
		const beforeInsert = root.querySelector('[data-memo-id="0"]');
		controller.applyMemoChanges(new Map(), [{ ...makeMemo("matched-new", "new memo"), createdAt: "2099-12-31T12:00" }]);
		assert.equal(root.querySelector('[data-memo-id="0"]'), beforeInsert);
		assert.equal(root.querySelector('[data-memo-id="matched-new"]')?.textContent, "new memo");
		assert.equal(root.scrollTop, 900);
	} finally { dom.window.close(); }
});

test("移动搜索的迟到查询不能覆盖已确认提交的结果快照", async () => {
	await ensureObsidianStub();
	const { MobileSearchController } = await import("../src/ui/MobileSearchController");
	const memos = [makeMemo("original", "original memo")];
	let release!: () => void;
	let pending: Promise<void> | undefined;
	const { controller, root } = createControllerHarness(MobileSearchController, memos, undefined, () => pending ?? Promise.resolve());
	controller.searchQuery = "memo"; controller.openPage({ focusInput: false });
	await Promise.resolve(); await Promise.resolve();
	pending = new Promise<void>(resolve => { release = resolve; });
	const refreshing = controller.refreshAppliedResults();
	controller.applyMemoChanges(new Map([["original", makeMemo("current", "confirmed memo")]]));
	release(); await refreshing;
	assert.deepEqual(controller.getDisplayedMemos().map(memo => memo.id), ["current"]);
	assert.deepEqual(root.findAll(".knomo-card").map(card => card.getAttr("data-memo-id")), ["current"]);
	controller.closePage();
});

test("保存通知接入旧结果时，仍完成用户正在切换的新搜索", async () => {
	await ensureObsidianStub();
	const { MobileSearchController } = await import("../src/ui/MobileSearchController");
	const memos = [makeMemo("original", "original memo"), makeMemo("next", "next memo")];
	let release!: () => void;
	let pending: Promise<void> | undefined;
	const { controller, root } = createControllerHarness(MobileSearchController, memos, undefined, () => pending ?? Promise.resolve());
	controller.searchQuery = "original";
	controller.openPage({ focusInput: false });
	await controller.refreshAppliedResults();
	pending = new Promise<void>(resolve => { release = resolve; });
	try {
		controller.searchQuery = "next";
		controller.applyMemoChanges(new Map([["original", makeMemo("current", "original confirmed memo")]]));
		release();
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.equal(controller.session.result?.input, "next");
		assert.deepEqual(root.findAll(".knomo-card").map(card => card.getAttr("data-memo-id")), ["next"]);
	} finally { release(); controller.closePage(); }
});

function createControllerHarness(
	Controller: MobileSearchControllerConstructor,
	memos: MemoViewItem[],
	getMatchedTotalCount?: () => number | null,
	loadRemoteResults?: LoadRemoteResults,
	overrides: Partial<MobileSearchControllerOptions> = {},
): {
	controller: MobileSearchControllerInstance;
	root: TestElement;
	state: ControllerHarnessState;
	dispatch: (target: TestElement, type: string, event: FakeEvent) => void;
} {
	const root = new TestElement("div");
	const body = new TestElement("body");
	const events: RegisteredEvent[] = [];
	const state: ControllerHarnessState = {
		pausedStates: [],
		bodyToggleCalls: [],
		renderedMemoIds: [],
		restoredCardFlowScrolls: [],
		closeSurroundingChromeCount: 0,
		closeCardMenuCount: 0,
		syncRootStateCount: 0,
	};
	const controller = new Controller({
		batchSize: 1,
		debounceMs: 10,
		getWindow: () => fakeWindow(),
		getDocument: () => ({
			body: body.asHtml(),
		} as Document),
		getRootEl: () => root.asHtml(),
		isMobileLayout: () => true,
		getMemos: () => memos,
		getMatchedTotalCount,
		loadRemoteResults,
		registerDomEvent: (target, type, listener) => {
			events.push({
				target: target as unknown as TestElement,
				type,
				listener: listener as unknown as (event: FakeEvent) => void,
			});
		},
		createHiddenText: (container, name, text) => {
			container.createSpan({ cls: "sr-only", text, attr: { id: name } });
			return name;
		},
		filterMemos: (memos, filter) => memos.filter(memo => (filter.textTerms ?? []).every(term => memo.contentSnapshot.includes(term))),
		renderMemoCard: (container, memo) => {
			state.renderedMemoIds.push(memo.id);
			container.createDiv({ cls: "knomo-card", text: memo.id, attr: { "data-memo-id": memo.id } });
		},
		clearMarkdown: () => undefined,
		clearImages: () => undefined,
		setCardFlowPaused: (paused) => {
			state.pausedStates.push(paused);
		},
		closeSurroundingChrome: () => {
			state.closeSurroundingChromeCount += 1;
		},
		closeCardMenu: () => {
			state.closeCardMenuCount += 1;
		},
		syncRootState: () => {
			state.syncRootStateCount += 1;
		},
		getCardFlowScrollTop: () => 48,
		restoreCardFlowScrollTop: (scrollTop) => {
			state.restoredCardFlowScrolls.push(scrollTop);
		},
		restoreElementScrollTop: (element, scrollTop) => {
			if (element !== null) {
				(element as unknown as TestElement).scrollTop = scrollTop ?? 0;
			}
		},
		handleMarkdownInternalLinkClick: () => undefined,
		handleTaskCheckboxClick: () => undefined,
		handleTaskCheckboxChange: () => undefined,
		...overrides,
	});
	body.toggleClass = (cls: string, active: boolean) => {
		state.bodyToggleCalls.push({ cls, active });
	};
	return {
		controller,
		root,
		state,
		dispatch: (target, type, event) => {
			for (const registered of events) {
				if (registered.target === target && registered.type === type) {
					registered.listener(event);
				}
			}
		},
	};
}

interface ControllerHarnessState {
	pausedStates: boolean[];
	bodyToggleCalls: Array<{ cls: string; active: boolean }>;
	renderedMemoIds: string[];
	restoredCardFlowScrolls: Array<number | null>;
	closeSurroundingChromeCount: number;
	closeCardMenuCount: number;
	syncRootStateCount: number;
}

interface RegisteredEvent {
	target: TestElement;
	type: string;
	listener: (event: FakeEvent) => void;
}

interface CreateElementOptions {
	cls?: string;
	text?: string;
	attr?: Record<string, string>;
}

class TestElement {
	addEventListener(): void {}
	getBoundingClientRect(): DOMRect { return {top:0, bottom:200} as DOMRect; }
	private readonly children: TestElement[] = [];
	private readonly classes = new Set<string>();
	private readonly attrs = new Map<string, string>();
	private text = "";
	private parent: TestElement | null = null;
	isConnected = true;
	scrollTop = 0;
	value = "";
	focusCount = 0;

	constructor(private readonly tagName: string) {}

	get childCount(): number {
		return this.children.length;
	}

	asHtml(): HTMLElement {
		return this as unknown as HTMLElement;
	}

	prepend(child: TestElement): void {
		child.remove();
		child.parent = this;
		this.children.unshift(child);
	}

	createDiv(options: CreateElementOptions = {}): TestElement {
		return this.createEl("div", options);
	}

	createSpan(options: CreateElementOptions = {}): TestElement {
		return this.createEl("span", options);
	}

	createEl(tagName: string, options: CreateElementOptions = {}): TestElement {
		const child = new TestElement(tagName);
		child.parent = this;
		if (options.cls !== undefined) {
			for (const cls of options.cls.split(/\s+/)) {
				if (cls.length > 0) {
					child.addClass(cls);
				}
			}
		}
		if (options.text !== undefined) {
			child.setText(options.text);
		}
		for (const [key, value] of Object.entries(options.attr ?? {})) {
			child.setAttr(key, value);
		}
		this.children.push(child);
		return child;
	}

	setText(value: string): void {
		this.text = value;
	}

	getText(): string {
		return this.text + this.children.map((child) => child.getText()).join("");
	}

	setAttr(key: string, value: string): void {
		this.attrs.set(key, value);
	}

	getAttr(key: string): string | null {
		return this.attrs.get(key) ?? null;
	}

	removeAttribute(key: string): void {
		this.attrs.delete(key);
	}

	addClass(cls: string): void {
		this.classes.add(cls);
	}

	removeClass(cls: string): void {
		this.classes.delete(cls);
	}

	toggleClass(cls: string, active: boolean): void {
		if (active) {
			this.addClass(cls);
		} else {
			this.removeClass(cls);
		}
	}

	hasClass(cls: string): boolean {
		return this.classes.has(cls);
	}

	focus(): void {
		this.focusCount += 1;
	}

	empty(): void {
		this.scrollTop = 0;
		for (const child of this.children) child.parent = null;
		this.children.length = 0;
		this.text = "";
	}

	appendChild(child: TestElement): TestElement {
		child.remove(); child.parent = this; this.children.push(child); return child;
	}

	remove(): void {
		if (this.parent === null) return;
		const index = this.parent.children.indexOf(this);
		if (index >= 0) this.parent.children.splice(index, 1);
		this.parent = null;
	}

	detach(): void {
		this.isConnected = false;
	}

	find(selector: string): TestElement | null {
		return this.findAll(selector)[0] ?? null;
	}

	findAll(selector: string): TestElement[] {
		const result: TestElement[] = [];
		for (const child of this.children) {
			child.collect(selector, result);
		}
		return result;
	}

	private collect(selector: string, result: TestElement[]): void {
		if (this.matches(selector)) {
			result.push(this);
		}
		for (const child of this.children) {
			child.collect(selector, result);
		}
	}

	private matches(selector: string): boolean {
		if (selector.startsWith(".")) {
			return this.classes.has(selector.slice(1));
		}
		const attrMatch = selector.match(/^\[([^=\]]+)(?:='([^']*)')?\]$/);
		if (attrMatch !== null) {
			const value = this.attrs.get(attrMatch[1]);
			return attrMatch[2] === undefined ? value !== undefined : value === attrMatch[2];
		}
		return this.tagName === selector;
	}
}

interface FakeEvent {
	readonly key?: string;
	defaultPrevented: boolean;
	propagationStopped: boolean;
	preventDefault(): void;
	stopPropagation(): void;
}

function createKeyboardEvent(key: string): FakeEvent {
	return {
		key,
		defaultPrevented: false,
		propagationStopped: false,
		preventDefault() {
			this.defaultPrevented = true;
		},
		stopPropagation() {
			this.propagationStopped = true;
		},
	};
}

function fakeWindow(): Window {
	return {
		setTimeout: () => 1,
		clearTimeout: () => undefined,
	} as unknown as Window;
}

test("恢复旧移动空搜索：只显示提示，不查询也不显示 Memo，关闭重开清空", async () => {
 await ensureObsidianStub();
 const { MobileSearchController } = await import("../src/ui/MobileSearchController");
 let loads = 0;
 const { controller, root } = createControllerHarness(MobileSearchController, [makeMemo("one", "memo")],
  undefined, async () => { loads++; });
 controller.openPage({ focusInput: false });
 await Promise.resolve();
 assert.equal(loads, 0);
 assert.equal(root.findAll(".knomo-card").length, 0);
 assert.ok(root.find(".knomo-mobile-search-empty"));
 controller.searchQuery = "memo";
 await Promise.resolve();
 controller.closePage();
 controller.openPage({ focusInput: false });
 assert.equal(controller.searchQuery, "");
 assert.equal(controller.input?.value, "");
 assert.equal(root.findAll(".knomo-card").length, 0);
});

test("A：非法日期保留卡片与摘要，迟到查询失效；普通 Enter 仍走防抖，关闭重开清空", async () => {
	await ensureObsidianStub();
	const { MobileSearchController } = await import("../src/ui/MobileSearchController");
	let memos = [makeMemo("A", "alpha")], total = 1, id = 0;
	const timers = new Map<number, () => void>();
	const calls: Array<{ filter: Parameters<LoadRemoteResults>[0]; resolve: () => void }> = [];
	const { controller, root, dispatch } = createControllerHarness(MobileSearchController, memos, () => total,
		filter => new Promise<void>(resolve => calls.push({ filter, resolve })), {
			getMemos: () => memos,
			getWindow: () => ({ setTimeout: (callback: () => void) => { timers.set(++id, callback); return id; },
				clearTimeout: (timer: number) => timers.delete(timer) }) as unknown as Window,
		});
	const settle = async () => { for (let tick = 0; tick < 8; tick++) await Promise.resolve(); };
	controller.searchQuery = "alpha"; controller.openPage({ focusInput: false });
	calls[0].resolve(); await settle();
	const card = root.find(".knomo-card"), summary = root.find(".knomo-list-summary")!.getText();
	const input = controller.input as unknown as TestElement;
	input.value = "beta"; dispatch(input, "input", createKeyboardEvent(""));
	dispatch(input, "keydown", createKeyboardEvent("Enter"));
	assert.equal(calls.length, 1);
	for (const callback of timers.values()) callback(); timers.clear();
	assert.equal(calls.length, 2);
	assert.deepEqual(calls[1].filter, { textTerms: ["beta"] });
	assert.equal(root.find(".knomo-card"), card);
	input.value = "2026-"; dispatch(input, "input", createKeyboardEvent(""));
	memos = [makeMemo("B", "beta")]; total = 99; calls[1].resolve(); await settle();
	assert.equal(root.find(".knomo-card"), card);
	assert.equal(root.find(".knomo-list-summary")!.getText(), summary);
	assert.deepEqual(root.findAll(".knomo-card").map(card => card.getAttr("data-memo-id")), ["A"]);
	assert.equal(root.find(".knomo-search-date-hint")!.getAttr("hidden"), null);
	assert.match(root.find(".knomo-search-date-hint")!.getText(), /previous/i);
	assert.equal(root.find(".knomo-search-conditions"), null);
	controller.closePage(); controller.openPage({ focusInput: false });
	assert.equal(controller.searchQuery, ""); assert.equal(input.value, "");
	assert.equal(root.findAll(".knomo-card").length, 0);
	assert.equal(calls.length, 2);
	controller.removePage();
});

test("B：移动快捷日期只替换手写日期，清空输入删除手写日期，Things 关闭提交有效草稿", async () => {
	await ensureObsidianStub();
	const { MobileSearchController } = await import("../src/ui/MobileSearchController");
	let saved: unknown;
	const { controller } = createControllerHarness(MobileSearchController, [], undefined, undefined, {
		getThingsContext: () => ({ activeNav: "things", activeTag: "work", activeTagKey: "work" }),
		syncThingsSearch: (query, date) => { saved = [query, date]; },
	});
	controller.openPage({ focusInput: false });
	const input = controller.input as unknown as TestElement;
	input.value = "项目 ２０２６１００９ 复盘";
	controller.setDateFilter("month");
	assert.equal(input.value, "项目  复盘");
	assert.deepEqual(controller.session.applied.terms, ["项目 复盘"]);
	assert.equal(controller.searchDateFilter, "month");
	controller.setDateFilter("month"); assert.equal(controller.searchDateFilter, null);
	input.value = "20261009 项目";
	controller.closePage();
	assert.deepEqual(saved, ["20261009 项目", null]);
	assert.equal(controller.session.applied.date?.kind, "range");
	controller.searchDateFilter = null;
	assert.equal(controller.session.applied.date?.kind, "range", "复制空快捷日期不能删除手写日期");
	controller.openPage({ focusInput: false });
	input.value = ""; controller.flushQuery();
	assert.equal(controller.session.hasConditions, false);
	controller.closePage(); controller.removePage();
});

test("重复进入手机统计筛选总是重置文字、手写日期和快捷日期", async () => {
	await ensureObsidianStub();
	const { MobileSearchController } = await import("../src/ui/MobileSearchController");
	const { KnomoView } = await import("../src/ui/KnomoView");
	const filters: Parameters<LoadRemoteResults>[0][] = [];
	const { controller } = createControllerHarness(MobileSearchController, [], undefined, async filter => { filters.push(filter); });
	const view = Object.assign(Object.create(KnomoView.prototype) as {
		openRecordStatsSearchFilter(filter: RecordStatsSearchFilter): void;
	}, {
		currentLayout: "mobile", mobileSearchController: controller,
		openMobileSearchPage: (options: Parameters<MobileSearchControllerInstance["openPage"]>[0]) => controller.openPage(options),
	});
	const source: RecordStatsSearchFilter = { type: "range", startDate: "2026-06-01", endDateExclusive: "2026-07-01" };
	view.openRecordStatsSearchFilter(source); await Promise.resolve();
	controller.searchQuery = "20260609 项目"; await controller.refreshAppliedResults();
	controller.session.updateDraft("2026-");
	controller.closePage();
	view.openRecordStatsSearchFilter({ ...source }); await Promise.resolve();
	assert.equal(controller.searchQuery, ""); assert.equal(controller.session.draft.text, "");
	assert.equal(controller.searchDateFilter, null);
	assert.deepEqual(filters.at(-1), { fromDate: "2026-06-01", toDate: "2026-06-30" });
	controller.removePage();
});

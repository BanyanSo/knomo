import test from "node:test";
import assert from "node:assert/strict";
import { createDeferred } from "./helpers/deferred";

import type { ShuffleDaySelectionResult } from "../src/utils/shuffleDay";
import type { MemoViewItem } from "../src/types/memoView";
import { buildShuffleDayStats } from "../src/utils/shuffleDay";
import { ensureObsidianStub } from "./helpers/obsidianStub";

test("refreshes shuffle day through the service and renders loading transitions", async () => {
	const { ShuffleDayController } = await loadController();
	const memo = makeMemo("memo-1", "2026-05-01T09:00:00");
	let renderCalls = 0;
	const controller = new ShuffleDayController({
		loadSelectedDate: async () => [memo],
		...makeService(async () => ({
			status: "ready",
			selectedDate: "2026-05-01",
			memos: [memo],
			stats: buildShuffleDayStats([memo]),
		})),
		isShuffleDayActive: () => true,
		requestRender: () => {
			renderCalls += 1;
		},
	});

	await controller.refresh();

	assert.equal(renderCalls, 2);
	assert.equal(controller.getSnapshot().status, "ready");
	assert.equal(controller.getSnapshot().selectedDate, "2026-05-01");
	assert.deepEqual(controller.getSnapshot().memos.map((item) => item.id), ["memo-1"]);
});

test("refresh keeps the previous shuffle day visible until the next selection commits", async () => {
	const { ShuffleDayController } = await loadController();
	const oldMemo = makeMemo("old", "2026-05-01T09:00:00");
	const newMemo = makeMemo("new", "2026-05-02T09:00:00");
	const nextSelection = createDeferred<ShuffleDaySelectionResult>();
	let useDeferred = false;
	const controller = new ShuffleDayController({
		loadSelectedDate: async () => [oldMemo],
		...makeService(async () => {
			if (useDeferred) return nextSelection.promise;
			return makeSelection("2026-05-01", oldMemo);
		}),
		isShuffleDayActive: () => true,
		requestRender: () => {},
	});

	await controller.refresh();
	useDeferred = true;
	const refreshing = controller.refresh();
	assert.equal(controller.getSnapshot().status, "loading");
	assert.equal(controller.getSnapshot().selectedDate, "2026-05-01");
	assert.deepEqual(controller.getSnapshot().memos.map((memo) => memo.id), ["old"]);

	nextSelection.resolve(makeSelection("2026-05-02", newMemo));
	await refreshing;
	assert.equal(controller.getSnapshot().selectedDate, "2026-05-02");
	assert.deepEqual(controller.getSnapshot().memos.map((memo) => memo.id), ["new"]);
});

test("clearing shuffle day invalidates an in-flight selection", async () => {
	const { ShuffleDayController } = await loadController();
	const memo = makeMemo("late", "2026-05-03T09:00:00");
	const selection = createDeferred<ShuffleDaySelectionResult>();
	const controller = new ShuffleDayController({
		loadSelectedDate: async () => [memo],
		...makeService(async () => selection.promise),
		isShuffleDayActive: () => false,
		requestRender: () => {},
	});

	const refreshing = controller.refresh();
	controller.clearSelection();
	selection.resolve(makeSelection("2026-05-03", memo));
	await refreshing;

	assert.equal(controller.getSnapshot().status, "idle");
	assert.equal(controller.getSnapshot().selectedDate, null);
	assert.deepEqual(controller.getSnapshot().memos, []);
});

test("selected-date reload keeps the committed day visible until its complete result commits", async () => {
	const { ShuffleDayController } = await loadController();
	const oldMemo = makeMemo("old", "2026-05-01T09:00:00");
	const updatedMemo = { ...oldMemo, contentSnapshot: "updated" };
	const dateLoad = createDeferred<MemoViewItem[]>();
	const controller = new ShuffleDayController({
		loadSelectedDate: async () => dateLoad.promise,
		...makeService(async () => makeSelection("2026-05-01", oldMemo)),
		isShuffleDayActive: () => true,
		requestRender: () => {},
	});

	await controller.refresh();
	const reloading = controller.reloadSelectedDate();
	assert.equal(controller.getSnapshot().status, "loading");
	assert.deepEqual(controller.getSnapshot().memos.map((memo) => memo.contentSnapshot), ["old"]);

	dateLoad.resolve([updatedMemo]);
	assert.equal(await reloading, true);
	assert.equal(controller.getSnapshot().status, "ready");
	assert.deepEqual(controller.getSnapshot().memos.map((memo) => memo.contentSnapshot), ["updated"]);
});

test("targeted memo updates preserve unaffected shuffle-day memos and clear only after the last removal", async () => {
	const { ShuffleDayController } = await loadController();
	const firstMemo = makeMemo("first", "2026-05-01T09:00:00");
	const secondMemo = makeMemo("second", "2026-05-01T10:00:00");
	let renderCalls = 0;
	const controller = new ShuffleDayController({
		loadSelectedDate: async () => [firstMemo, secondMemo],
		...makeService(async () => makeSelectionWithMemos("2026-05-01", [firstMemo, secondMemo])),
		isShuffleDayActive: () => true,
		requestRender: () => { renderCalls++; },
	});

	await controller.refresh();
	assert.equal(controller.applyMemoUpdate({ ...firstMemo, contentSnapshot: "updated first" }), true);
	assert.deepEqual(controller.getSnapshot().memos.map((memo) => memo.contentSnapshot), ["updated first", "second"]);

	assert.equal(controller.applyMemoUpdate({ ...secondMemo, createdAt: "2026-05-02T10:00:00" }), true);
	assert.deepEqual(controller.getSnapshot().memos.map((memo) => memo.id), ["first"]);
	assert.equal(controller.getSnapshot().status, "ready");

	const rendersBeforeChange = renderCalls;
	const current = { ...firstMemo, id: "first-current", contentSnapshot: "confirmed first" };
	const inserted = makeMemo("inserted", "2026-05-01T11:00:00");
	const unrelated = makeMemo("outside", "2026-05-02T11:00:00");
	assert.equal(controller.applyMemoChanges(new Map([[firstMemo.id, current]]), [inserted, unrelated]), true);
	assert.deepEqual(controller.getSnapshot().memos.map(memo => memo.id).sort(), ["first-current", "inserted"]);
	assert.equal(renderCalls, rendersBeforeChange, "提交更新由父视图统一重绘");
	assert.equal(controller.removeMemo(current.id), true);
	assert.equal(controller.getSnapshot().status, "ready");
	assert.equal(renderCalls, rendersBeforeChange + 1, "独立删除仍触发重绘");
	assert.equal(controller.removeMemo(inserted.id), true);
	assert.equal(controller.getSnapshot().status, "empty-day-cleared");
	assert.deepEqual(controller.getSnapshot().memos, []);
	assert.equal(renderCalls, rendersBeforeChange + 2);
});

test("a late selected-date reload cannot overwrite a newer targeted update", async () => {
	const { ShuffleDayController } = await loadController();
	const oldMemo = makeMemo("memo", "2026-05-01T09:00:00");
	const dateLoad = createDeferred<MemoViewItem[]>();
	const controller = new ShuffleDayController({
		loadSelectedDate: async () => dateLoad.promise,
		...makeService(async () => makeSelection("2026-05-01", oldMemo)),
		isShuffleDayActive: () => true,
		requestRender: () => {},
	});

	await controller.refresh();
	const reloading = controller.reloadSelectedDate();
	controller.applyMemoUpdate({ ...oldMemo, contentSnapshot: "newer local result" });
	dateLoad.resolve([{ ...oldMemo, contentSnapshot: "stale reload" }]);

	assert.equal(await reloading, false);
	assert.equal(controller.getSnapshot().status, "ready");
	assert.deepEqual(controller.getSnapshot().memos.map((memo) => memo.contentSnapshot), ["newer local result"]);
});

test("漫游只接受有效请求一次，导航取消传递 signal，保留已提交日期供返回复用", async () => {
	const { ShuffleDayController } = await loadController();
	const old = makeMemo("old", "2026-05-01T09:00");
	const late = makeMemo("late", "2026-05-02T09:00");
	const pending = createDeferred<ShuffleDaySelectionResult>();
	let active = true;
	let calls = 0;
	let signal: AbortSignal | undefined;
	const accepts: string[] = [];
	const currentDates: Array<string | null> = [];
	const controller = new ShuffleDayController({
		selectShuffleDay: async request => {
			currentDates.push(request.currentDate);
			signal = request.signal;
			return ++calls === 1 ? makeSelection("2026-05-01", old) : pending.promise;
		},
		acceptSelection: async date => { accepts.push(date); },
		loadSelectedDate: async () => [old], isShuffleDayActive: () => active, requestRender: () => {},
	});
	await controller.refresh();
	const first = controller.refresh();
	await controller.refresh();
	assert.equal(calls, 2);
	active = false;
	controller.cancelPending();
	assert.equal(signal?.aborted, true);
	pending.resolve(makeSelection("2026-05-02", late));
	await first;
	assert.equal(controller.getSnapshot().selectedDate, "2026-05-01");
	assert.equal(controller.getSnapshot().status, "ready");
	assert.deepEqual(currentDates, [null, "2026-05-01"]);
	assert.deepEqual(accepts, ["2026-05-01"]);
	active = true;
	await controller.reloadSelectedDate();
	assert.deepEqual(accepts, ["2026-05-01"]);
});

test("历史保存失败不阻断 ready 内容，读取降级可见，迟到错误不影响后来的页面", async () => {
	const { ShuffleDayController } = await loadController();
	const saved = createDeferred<void>();
	let rejectSave: (reason: Error) => void = () => {};
	const failedSave = new Promise<void>((_resolve, reject) => { rejectSave = reject; });
	let active = true;
	let failLoad = false;
	let accepts = 0;
	const { Notice } = await import("obsidian"); const notices = (Notice as unknown as { messages: string[] }).messages; notices.length = 0;
	const memo = makeMemo("memo", "2026-05-01T09:00");
	const controller = new ShuffleDayController({
		selectShuffleDay: async () => { if (failLoad) throw new Error("load failed"); return { ...makeSelection("2026-05-01", memo), historyUnavailable: true }; },
		acceptSelection: () => ++accepts === 1 ? failedSave : saved.promise,
		loadSelectedDate: async () => [memo], isShuffleDayActive: () => active,
		requestRender: () => {},
	});
	await controller.refresh();
	assert.equal(controller.getSnapshot().status, "ready");
	assert.match(controller.getSnapshot().historyError!, /history could not be read/);
	rejectSave(new Error("save failed"));
	await Promise.resolve();
	assert.match(controller.getSnapshot().historyError!, /history was not saved/);
	assert.deepEqual(notices, []);
	assert.equal(controller.getSnapshot().status, "ready");
	failLoad = true;
	await controller.refresh();
	assert.equal(accepts, 1);
	assert.deepEqual(controller.getSnapshot().memos, [memo]);
	failLoad = false;
	await controller.refresh();
	active = false;
	controller.dispose();
	saved.resolve();
	await Promise.resolve();
	assert.equal(accepts, 2);
});

test("指定日期接纳昨天的完整时间流，回读和重试均不抽日或记录历史", async () => {
	const { ShuffleDayController } = await loadController();
	const date = "2026-10-22";
	const memos = Array.from({ length: 300 }, (_, index) => makeMemo(String(index), `${date}T09:00`));
	let reads = 0;
	const controller = new ShuffleDayController({
		loadSelectedDate: async requested => { assert.equal(requested, date); reads++; return memos; },
		selectShuffleDay: async () => assert.fail("指定日期不抽日"),
		acceptSelection: async () => assert.fail("指定日期不记历史"),
		isShuffleDayActive: () => true, requestRender: () => {},
	});
	assert.equal(await controller.openDate(date), true);
	assert.equal(await controller.reloadSelectedDate(), true);
	assert.equal(controller.getSnapshot().memos.length, 300);
	assert.equal(controller.getSnapshot().stats?.memoCount, 300);
	assert.equal(controller.getSnapshot().stats?.firstMemoTime, "09:00");
	assert.deepEqual(controller.getSnapshot().memos.map(item => item.id), memos.map(item => item.id));
	assert.equal(reads, 2);
});

test("指定日期快速切换或返回，取消信号与代次拒绝旧成功和旧失败", async () => {
	const { ShuffleDayController } = await loadController();
	for (const rejectOld of [false, true]) {
		let release!: (value: MemoViewItem[]) => void, fail!: (error: Error) => void;
		let firstSignal!: AbortSignal;
		const controller = new ShuffleDayController({
			loadSelectedDate: (date, signal) => date === "2026-05-01" ? new Promise((resolve, reject) => {
				firstSignal = signal; release = resolve; fail = reject;
			}) : Promise.resolve([makeMemo("new", "2026-05-02T10:00")]),
			isShuffleDayActive: () => true, requestRender: () => {},
		});
		const pending = controller.openDate("2026-05-01");
		await controller.openDate("2026-05-02");
		assert.equal(firstSignal.aborted, true);
		if (rejectOld) fail(new Error("late failure")); else release([makeMemo("old", "2026-05-01T09:00")]);
		assert.equal(await pending, false);
		assert.equal(controller.getSnapshot().selectedDate, "2026-05-02");
		assert.deepEqual(controller.getSnapshot().memos.map(item => item.id), ["new"]);
		const cancelled = controller.openDate("2026-05-01");
		controller.clearSelection();
		release([makeMemo("old", "2026-05-01T09:00")]);
		assert.equal(await cancelled, false);
		assert.equal(controller.getSnapshot().selectedDate, null);
	}
});

test("指定日期读取失败保留目标以便重试，清空或移动不跳到另一天", async () => {
	const { ShuffleDayController } = await loadController();
	let fail = true;
	const controller = new ShuffleDayController({
		loadSelectedDate: async () => { if (fail) throw new Error("read failed"); return [makeMemo("memo", "2026-05-01T09:00")]; },
		isShuffleDayActive: () => true, requestRender: () => {},
	});
	assert.equal(await controller.openDate("2026-05-01"), false);
	assert.equal(controller.getSnapshot().status, "failed");
	assert.equal(controller.getSnapshot().selectedDate, "2026-05-01");
	fail = false;
	assert.equal(await controller.reloadSelectedDate(), true);
	controller.applyMemoChanges(new Map([["memo", makeMemo("moved", "2026-05-02T09:00")]]));
	assert.equal(controller.getSnapshot().selectedDate, "2026-05-01");
	assert.equal(controller.getSnapshot().status, "empty-day-cleared");
	await controller.refresh();
	assert.equal(controller.getSnapshot().status, "empty-day-cleared", "没有随机能力的日期详情不能换日");
});

test("首次日期读取遇到插入时重读整日，不能用局部插入冒充完整日期", async () => {
	const { ShuffleDayController } = await loadController();
	let release!: (value: MemoViewItem[]) => void;
	let reads = 0;
	const old = makeMemo("old", "2026-05-01T09:00");
	const added = makeMemo("added", "2026-05-01T10:00");
	const controller = new ShuffleDayController({
		loadSelectedDate: async () => ++reads === 1 ? new Promise(resolve => { release = resolve; }) : [old, added],
		isShuffleDayActive: () => true, requestRender: () => {},
	});
	const first = controller.openDate("2026-05-01");
	controller.applyMemoChanges(new Map(), [added]);
	assert.equal(controller.getSnapshot().stats, null);
	assert.equal(controller.getSnapshot().status, "loading");
	await new Promise(resolve => setImmediate(resolve));
	assert.deepEqual(controller.getSnapshot().memos.map(memo => memo.id), ["old", "added"]);
	release([old]);
	assert.equal(await first, false);
	assert.equal(controller.getSnapshot().stats?.memoCount, 2);
	assert.equal(reads, 2);
});

for (const update of ["insert", "restore"] as const) {
	test(`首次整日读取失败后 ${update} 触发完整重读，重读失败仍可重试`, async () => {
		const { ShuffleDayController } = await loadController();
		const old = makeMemo("old", "2026-05-01T09:00");
		const added = makeMemo("added", "2026-05-01T10:00");
		let reads = 0;
		let fail = true;
		const controller = new ShuffleDayController({
			loadSelectedDate: async () => { reads++; if (fail) throw new Error("read failed"); return [old, added]; },
			isShuffleDayActive: () => true, requestRender: () => {},
		});
		await controller.openDate("2026-05-01");
		const apply = () => update === "insert" ? controller.applyMemoChanges(new Map(), [added]) : controller.applyMemoUpdate(added);
		assert.equal(apply(), true);
		assert.equal(controller.getSnapshot().status, "loading");
		assert.deepEqual(controller.getSnapshot().memos, []);
		assert.equal(controller.getSnapshot().stats, null);
		await new Promise(resolve => setImmediate(resolve));
		assert.equal(controller.getSnapshot().status, "failed");
		assert.ok(controller.getSnapshot().error);
		assert.equal(controller.getSnapshot().selectedDate, "2026-05-01");
		fail = false;
		apply();
		await new Promise(resolve => setImmediate(resolve));
		assert.equal(controller.getSnapshot().status, "ready");
		assert.deepEqual(controller.getSnapshot().memos.map(memo => memo.id), ["old", "added"]);
		assert.equal(controller.getSnapshot().stats?.memoCount, 2);
		assert.equal(controller.getSnapshot().error, null);
		assert.equal(reads, 3);
	});
}

async function loadController(): Promise<typeof import("../src/ui/ShuffleDayController")> {
	await ensureObsidianStub();
	return import("../src/ui/ShuffleDayController");
}

function makeService(selectShuffleDay: () => Promise<ShuffleDaySelectionResult>) {
	return { selectShuffleDay, acceptSelection: async () => {} };
}

function makeSelection(selectedDate: string, memo: MemoViewItem) {
	return makeSelectionWithMemos(selectedDate, [memo]);
}

function makeSelectionWithMemos(selectedDate: string, memos: MemoViewItem[]) {
	return {
		status: "ready" as const,
		selectedDate,
		memos,
		stats: buildShuffleDayStats(memos),
	};
}


function makeMemo(id: string, createdAt: string): MemoViewItem {
	return {
		id,
		createdAt,
		updatedAt: createdAt,
		contentSnapshot: id,
		contentHash: `hash-${id}`,
		status: "active",
		tags: [],
		links: [],
		images: [],
		dailyRef: {
			path: `Daily/${createdAt.slice(0, 10)}.md`,
			heading: "## Memos",
			lineNumberHint: 1,
		},
	};
}

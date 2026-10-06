import test from "node:test";
import assert from "node:assert/strict";

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
		showNotice: () => {},
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
		showNotice: () => {},
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
		showNotice: () => {},
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
		showNotice: () => {},
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
	const controller = new ShuffleDayController({
		loadSelectedDate: async () => [firstMemo, secondMemo],
		...makeService(async () => makeSelectionWithMemos("2026-05-01", [firstMemo, secondMemo])),
		isShuffleDayActive: () => true,
		showNotice: () => {},
		requestRender: () => {},
	});

	await controller.refresh();
	assert.equal(controller.applyMemoUpdate({ ...firstMemo, contentSnapshot: "updated first" }), true);
	assert.deepEqual(controller.getSnapshot().memos.map((memo) => memo.contentSnapshot), ["updated first", "second"]);

	assert.equal(controller.applyMemoUpdate({ ...secondMemo, createdAt: "2026-05-02T10:00:00" }), true);
	assert.deepEqual(controller.getSnapshot().memos.map((memo) => memo.id), ["first"]);
	assert.equal(controller.getSnapshot().status, "ready");

	assert.equal(controller.removeMemo(firstMemo.id), true);
	assert.equal(controller.getSnapshot().status, "empty-day-cleared");
	assert.deepEqual(controller.getSnapshot().memos, []);
});

test("a late selected-date reload cannot overwrite a newer targeted update", async () => {
	const { ShuffleDayController } = await loadController();
	const oldMemo = makeMemo("memo", "2026-05-01T09:00:00");
	const dateLoad = createDeferred<MemoViewItem[]>();
	const controller = new ShuffleDayController({
		loadSelectedDate: async () => dateLoad.promise,
		...makeService(async () => makeSelection("2026-05-01", oldMemo)),
		isShuffleDayActive: () => true,
		showNotice: () => {},
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
		loadSelectedDate: async () => [old], isShuffleDayActive: () => active, showNotice: () => {}, requestRender: () => {},
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
	const notices: string[] = [];
	const memo = makeMemo("memo", "2026-05-01T09:00");
	const controller = new ShuffleDayController({
		selectShuffleDay: async () => { if (failLoad) throw new Error("load failed"); return { ...makeSelection("2026-05-01", memo), historyUnavailable: true }; },
		acceptSelection: () => ++accepts === 1 ? failedSave : saved.promise,
		loadSelectedDate: async () => [memo], isShuffleDayActive: () => active,
		showNotice: message => { notices.push(message); }, requestRender: () => {},
	});
	await controller.refresh();
	assert.equal(controller.getSnapshot().status, "ready");
	assert.match(notices[0], /history could not be read/);
	rejectSave(new Error("save failed"));
	await Promise.resolve();
	assert.match(notices[1], /history was not saved/);
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

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolvePromise: (value: T) => void = () => undefined;
	const promise = new Promise<T>((resolve) => {
		resolvePromise = resolve;
	});
	return { promise, resolve: resolvePromise };
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

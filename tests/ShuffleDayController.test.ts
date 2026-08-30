import test from "node:test";
import assert from "node:assert/strict";

import type { ShuffleDayService } from "../src/services/ShuffleDayService";
import type { MemoRecord } from "./helpers/memoViewFixture";
import { buildShuffleDayStats } from "../src/utils/shuffleDay";
import { ensureObsidianStub } from "./helpers/obsidianStub";

test("refreshes shuffle day through the service and renders loading transitions", async () => {
	const { ShuffleDayController } = await loadController();
	const memo = makeMemo("memo-1", "2026-05-01T09:00:00");
	let prepareCalls = 0;
	let renderCalls = 0;
	const controller = new ShuffleDayController({
		prepareCatalogData: async () => {
			prepareCalls += 1;
		},
		getMemos: () => [memo],
		loadSelectedDate: async () => [memo],
		service: makeService(async () => ({
			status: "ready",
			selectedDate: "2026-05-01",
			memos: [memo],
			stats: buildShuffleDayStats([memo]),
			historyEntry: { date: "2026-05-01", shownAt: "2026-07-02T10:00:00" },
			nextHistory: [{ date: "2026-05-01", shownAt: "2026-07-02T10:00:00" }],
		})),
		isShuffleDayActive: () => true,
		showNotice: () => {},
		requestRender: () => {
			renderCalls += 1;
		},
	});

	await controller.refresh();

	assert.equal(prepareCalls, 1);
	assert.equal(renderCalls, 2);
	assert.equal(controller.getSnapshot().status, "ready");
	assert.equal(controller.getSnapshot().selectedDate, "2026-05-01");
	assert.deepEqual(controller.getSnapshot().memos.map((item) => item.id), ["memo-1"]);
});

test("refresh keeps the previous shuffle day visible until the next selection commits", async () => {
	const { ShuffleDayController } = await loadController();
	const oldMemo = makeMemo("old", "2026-05-01T09:00:00");
	const newMemo = makeMemo("new", "2026-05-02T09:00:00");
	const nextSelection = createDeferred<ReturnType<ShuffleDayService["selectShuffleDay"]> extends Promise<infer T> ? T : never>();
	let useDeferred = false;
	const controller = new ShuffleDayController({
		prepareCatalogData: async () => {},
		getMemos: () => [oldMemo, newMemo],
		loadSelectedDate: async () => [oldMemo],
		service: makeService(async () => {
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
	const selection = createDeferred<ReturnType<ShuffleDayService["selectShuffleDay"]> extends Promise<infer T> ? T : never>();
	const controller = new ShuffleDayController({
		prepareCatalogData: async () => {},
		getMemos: () => [memo],
		loadSelectedDate: async () => [memo],
		service: makeService(async () => selection.promise),
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
	const dateLoad = createDeferred<MemoRecord[]>();
	const controller = new ShuffleDayController({
		prepareCatalogData: async () => {},
		getMemos: () => [oldMemo],
		loadSelectedDate: async () => dateLoad.promise,
		service: makeService(async () => makeSelection("2026-05-01", oldMemo)),
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
		prepareCatalogData: async () => {},
		getMemos: () => [firstMemo, secondMemo],
		loadSelectedDate: async () => [firstMemo, secondMemo],
		service: makeService(async () => makeSelectionWithMemos("2026-05-01", [firstMemo, secondMemo])),
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
	const dateLoad = createDeferred<MemoRecord[]>();
	const controller = new ShuffleDayController({
		prepareCatalogData: async () => {},
		getMemos: () => [oldMemo],
		loadSelectedDate: async () => dateLoad.promise,
		service: makeService(async () => makeSelection("2026-05-01", oldMemo)),
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

async function loadController(): Promise<typeof import("../src/ui/ShuffleDayController")> {
	await ensureObsidianStub();
	return import("../src/ui/ShuffleDayController");
}

function makeService(selectShuffleDay: ShuffleDayService["selectShuffleDay"]): ShuffleDayService {
	return { selectShuffleDay } as ShuffleDayService;
}

function makeSelection(selectedDate: string, memo: MemoRecord) {
	return makeSelectionWithMemos(selectedDate, [memo]);
}

function makeSelectionWithMemos(selectedDate: string, memos: MemoRecord[]) {
	return {
		status: "ready" as const,
		selectedDate,
		memos,
		stats: buildShuffleDayStats(memos),
		historyEntry: { date: selectedDate, shownAt: "2026-07-02T10:00:00" },
		nextHistory: [{ date: selectedDate, shownAt: "2026-07-02T10:00:00" }],
	};
}

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolvePromise: (value: T) => void = () => undefined;
	const promise = new Promise<T>((resolve) => {
		resolvePromise = resolve;
	});
	return { promise, resolve: resolvePromise };
}

function makeMemo(id: string, createdAt: string): MemoRecord {
	return {
		id,
		createdAt,
		updatedAt: createdAt,
		contentSnapshot: id,
		contentHash: `hash-${id}`,
		status: "active",
		syncStatus: "synced",
		source: "plugin_input",
		version: 1,
		tags: [],
		links: [],
		images: [],
		references: [],
		sourceMemoId: null,
		issue: null,
		lastMarkdownSyncAt: null,
		lastMarkdownSyncSource: null,
		dailyRef: {
			path: `Daily/${createdAt.slice(0, 10)}.md`,
			heading: "## Memos",
			lastKnownBlock: id,
			lastKnownHash: `daily-${id}`,
			lineNumberHint: 1,
			lastSyncedAt: null,
		},
		monthlyRef: {
			path: "Memos/Memos-2026-05.md",
			dateHeading: createdAt.slice(0, 10),
			lastKnownBlock: id,
			lastKnownHash: `monthly-${id}`,
			lineNumberHint: 1,
			lastSyncedAt: null,
		},
	};
}

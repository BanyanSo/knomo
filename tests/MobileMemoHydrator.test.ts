import test from "node:test";
import assert from "node:assert/strict";

import type { MemoRecord } from "../src/types/memo";
import { MobileMemoHydrator } from "../src/ui/MobileMemoHydrator";
import type { MobileMemoHydrationRenderState } from "../src/ui/MobileMemoHydrator";

test("retains recent-period coverage without loading history in the background", () => {
	let periodReadCalls = 0;
	const hydrator = new MobileMemoHydrator({
		isMobile: () => true,
		isLoading: () => false,
		listMemoIndexPeriods: () => [],
		listMemosInPeriods: async () => {
			periodReadCalls += 1;
			return [];
		},
		getMemos: () => [],
		setMemos: () => {},
		invalidateFilteredMemos: () => {},
		captureRenderState: makeRenderState,
		onStarted: () => {},
		onPeriodHydrated: () => {},
		onCompleted: () => {},
		onFailed: () => {},
	});

	hydrator.setInitialLoadSuccess(["2026-06", "2026-05"]);

	assert.equal(hydrator.getSnapshot().allMemosLoaded, false);
	assert.equal(hydrator.getSnapshot().loadMode, "recent");
	assert.deepEqual(Array.from(hydrator.getSnapshot().loadedMemoPeriods), ["2026-06", "2026-05"]);
	assert.equal(periodReadCalls, 0);
});

test("loads every missing period only after an explicit all-active request", async () => {
	const recentMemo = makeMemo("recent", "2026-06-10T08:00:00+08:00");
	const mayMemo = makeMemo("may", "2026-05-10T08:00:00+08:00");
	const aprilMemo = makeMemo("april", "2026-04-10T08:00:00+08:00");
	const marchMemo = makeMemo("march", "2026-03-10T08:00:00+08:00");
	const februaryMemo = makeMemo("february", "2026-02-10T08:00:00+08:00");
	const januaryMemo = makeMemo("january", "2026-01-10T08:00:00+08:00");
	const updatedRecentMemo = { ...recentMemo, contentSnapshot: "updated", updatedAt: "2026-06-11T08:00:00+08:00" };
	const deletedMemo = { ...makeMemo("deleted", "2026-04-10T08:00:00+08:00"), status: "deleted" as const };
	let memos = [recentMemo];
	const listedPeriods: string[] = [];
	const batchStates: MobileMemoHydrationRenderState[] = [];
	let completedState: MobileMemoHydrationRenderState | null = null;
	let invalidateCalls = 0;
	const hydrator = new MobileMemoHydrator({
		isMobile: () => true,
		isLoading: () => false,
		listMemoIndexPeriods: () => ["2026-06", "2026-05", "2026-04", "2026-03", "2026-02", "2026-01"],
		listMemosInPeriods: async ([period]) => {
			listedPeriods.push(period);
			if (period === "2026-05") return [mayMemo, updatedRecentMemo];
			if (period === "2026-04") return [aprilMemo, deletedMemo];
			if (period === "2026-03") return [marchMemo];
			if (period === "2026-02") return [februaryMemo];
			return [januaryMemo];
		},
		getMemos: () => memos,
		setMemos: (nextMemos) => {
			memos = nextMemos;
		},
		invalidateFilteredMemos: () => {
			invalidateCalls += 1;
		},
		captureRenderState: makeRenderState,
		onStarted: () => {},
		onPeriodHydrated: (state) => batchStates.push(state),
		onCompleted: (state) => {
			completedState = state;
		},
		onFailed: () => {},
	});
	hydrator.setInitialLoadSuccess(["2026-06"]);

	const hydration = hydrator.start();
	assert.equal(await hydration, true);

	assert.deepEqual(listedPeriods, ["2026-05", "2026-04", "2026-03", "2026-02", "2026-01"]);
	assert.deepEqual(memos.map((memo) => memo.id), ["recent", "may", "april", "march", "february", "january"]);
	assert.equal(memos[0].contentSnapshot, "updated");
	assert.equal(batchStates.length, 1);
	assert.notEqual(completedState, null);
	assert.equal(invalidateCalls, 2);
	assert.equal(hydrator.getSnapshot().allMemosLoaded, true);
	assert.equal(hydrator.getSnapshot().loadMode, "all");
});

test("does not read memo periods before an explicit load request", () => {
	let periodReadCalls = 0;
	const hydrator = new MobileMemoHydrator({
		isMobile: () => true,
		isLoading: () => false,
		listMemoIndexPeriods: () => ["2026-05"],
		listMemosInPeriods: async () => {
			periodReadCalls += 1;
			return [];
		},
		getMemos: () => [],
		setMemos: () => {},
		invalidateFilteredMemos: () => {},
		captureRenderState: makeRenderState,
		onStarted: () => {},
		onPeriodHydrated: () => {},
		onCompleted: () => {},
		onFailed: () => {},
	});

	assert.equal(hydrator.getSnapshot().loadMode, "recent");
	assert.equal(periodReadCalls, 0);
});

test("loads at most two older periods for one explicit history request", async () => {
	const listedPeriods: string[] = [];
	const hydrator = new MobileMemoHydrator({
		isMobile: () => true,
		isLoading: () => false,
		listMemoIndexPeriods: () => ["2026-05", "2026-04"],
		listMemosInPeriods: async ([period]) => {
			listedPeriods.push(period);
			return [];
		},
		getMemos: () => [],
		setMemos: () => {},
		invalidateFilteredMemos: () => {},
		captureRenderState: makeRenderState,
		onStarted: () => {},
		onPeriodHydrated: () => {},
		onCompleted: () => {},
		onFailed: () => {},
	});

	const hydration = hydrator.loadNextPeriods(2);
	assert.equal(await hydration, true);
	assert.deepEqual(listedPeriods, ["2026-05", "2026-04"]);
});

test("explicit period loading is not kept alive by polling timers", async () => {
	const olderMemo = makeMemo("older", "2026-05-10T08:00:00+08:00");
	let periodReadCalls = 0;
	let completedCalls = 0;
	let memos: MemoRecord[] = [];
	const hydrator = new MobileMemoHydrator({
		isMobile: () => true,
		isLoading: () => false,
		listMemoIndexPeriods: () => ["2026-05"],
		listMemosInPeriods: async () => {
			periodReadCalls += 1;
			return [olderMemo];
		},
		getMemos: () => memos,
		setMemos: (nextMemos) => {
			memos = nextMemos;
		},
		invalidateFilteredMemos: () => {},
		captureRenderState: makeRenderState,
		onStarted: () => {},
		onPeriodHydrated: () => {},
		onCompleted: () => {
			completedCalls += 1;
		},
		onFailed: () => {},
	});

	const hydration = hydrator.start();
	assert.equal(await hydration, true);
	assert.equal(periodReadCalls, 1);
	assert.equal(completedCalls, 1);
	assert.deepEqual(memos.map((memo) => memo.id), ["older"]);
});

test("cancels a hydration run while a period read is pending", async () => {
	let periodReadCalls = 0;
	let completedCalls = 0;
	let resolveRead!: () => void;
	const pendingRead = new Promise<void>((resolve) => {
		resolveRead = resolve;
	});
	const hydrator = new MobileMemoHydrator({
		isMobile: () => true,
		isLoading: () => false,
		listMemoIndexPeriods: () => ["2026-05"],
		listMemosInPeriods: async () => {
			periodReadCalls += 1;
			await pendingRead;
			return [];
		},
		getMemos: () => [],
		setMemos: () => {},
		invalidateFilteredMemos: () => {},
		captureRenderState: makeRenderState,
		onStarted: () => {},
		onPeriodHydrated: () => {},
		onCompleted: () => {
			completedCalls += 1;
		},
		onFailed: () => {},
	});

	const hydration = hydrator.start();
	hydrator.cancel();
	resolveRead();

	assert.equal(await hydration, false);
	assert.equal(periodReadCalls, 1);
	assert.equal(completedCalls, 0);
});

test("reports a failed period read without completing hydration", async () => {
	let failedCalls = 0;
	let completedCalls = 0;
	const hydrator = new MobileMemoHydrator({
		isMobile: () => true,
		isLoading: () => false,
		listMemoIndexPeriods: () => ["2026-05"],
		listMemosInPeriods: async () => {
			throw new Error("period read failed");
		},
		getMemos: () => [],
		setMemos: () => {},
		invalidateFilteredMemos: () => {},
		captureRenderState: makeRenderState,
		onStarted: () => {},
		onPeriodHydrated: () => {},
		onCompleted: () => {
			completedCalls += 1;
		},
		onFailed: () => {
			failedCalls += 1;
		},
	});

	const hydration = hydrator.start();

	assert.equal(await hydration, false);
	assert.equal(failedCalls, 1);
	assert.equal(completedCalls, 0);
	assert.equal(hydrator.getSnapshot().allMemosLoaded, false);
	assert.equal(hydrator.getSnapshot().loadMode, "recent");
});

function makeRenderState(): MobileMemoHydrationRenderState {
	return {
		renderedCardCount: 4,
		previousCardFlowKey: "card-flow",
		previousMobileSearchKey: "mobile-search",
	};
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
			path: "Daily/2026-06-02.md",
			heading: "Memos",
			sectionType: "heading",
			lastKnownBlock: id,
			lastKnownHash: `hash-${id}`,
			lineNumberHint: 1,
			lastSyncedAt: null,
		},
		monthlyRef: {
			path: "Memos/Memos-2026-06.md",
			dateHeading: "2026-06-02",
			lastKnownBlock: id,
			lastKnownHash: `hash-${id}`,
			lineNumberHint: 1,
			lastSyncedAt: null,
		},
	};
}

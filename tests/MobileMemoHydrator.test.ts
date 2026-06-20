import test from "node:test";
import assert from "node:assert/strict";

import type { MemoRecord } from "../src/types/memo";
import { MobileMemoHydrator } from "../src/ui/MobileMemoHydrator";
import type { MobileMemoHydrationRenderState } from "../src/ui/MobileMemoHydrator";

test("schedules background hydration after the initial recent memo periods", () => {
	const scheduler = new TestScheduler();
	let beginCalls = 0;
	const hydrator = new MobileMemoHydrator({
		isMobile: () => true,
		isLoading: () => false,
		canHydrateCardFlow: () => true,
		scheduleTask: (callback, delayMs) => scheduler.schedule(callback, delayMs),
		cancelTask: (taskId) => scheduler.cancel(taskId),
		listMemoIndexPeriods: () => [],
		listMemosInPeriods: async () => [],
		getMemos: () => [],
		setMemos: () => {},
		invalidateFilteredMemos: () => {},
		captureRenderState: makeRenderState,
		onStarted: () => {},
		onPeriodHydrated: () => {},
		onCompleted: () => {},
		onFailed: () => {},
		onSidebarRequested: () => {},
		beginScheduledHydration: () => {
			beginCalls += 1;
		},
		ensureAllMemosLoaded: () => {},
	});

	hydrator.setInitialLoadSuccess(["2026-06", "2026-05"]);
	hydrator.schedule();
	hydrator.schedule();

	assert.equal(hydrator.getSnapshot().allMemosLoaded, false);
	assert.equal(hydrator.getSnapshot().loadMode, "recent");
	assert.deepEqual(Array.from(hydrator.getSnapshot().loadedMemoPeriods), ["2026-06", "2026-05"]);
	assert.deepEqual(scheduler.pendingDelays(), [1200]);

	scheduler.runNext();
	assert.equal(beginCalls, 1);
});

test("hydrates missing periods in background and merges active memos", async () => {
	const scheduler = new TestScheduler();
	const recentMemo = makeMemo("recent", "2026-06-10T08:00:00+08:00");
	const olderMemo = makeMemo("older", "2026-05-10T08:00:00+08:00");
	const updatedRecentMemo = { ...recentMemo, contentSnapshot: "updated" };
	const deletedMemo = { ...makeMemo("deleted", "2026-04-10T08:00:00+08:00"), status: "deleted" as const };
	let memos = [recentMemo];
	const listedPeriods: string[] = [];
	const periodStates: MobileMemoHydrationRenderState[] = [];
	let completedState: MobileMemoHydrationRenderState | null = null;
	let invalidateCalls = 0;
	const hydrator = new MobileMemoHydrator({
		isMobile: () => true,
		isLoading: () => false,
		canHydrateCardFlow: () => true,
		scheduleTask: (callback, delayMs) => scheduler.schedule(callback, delayMs),
		cancelTask: (taskId) => scheduler.cancel(taskId),
		listMemoIndexPeriods: () => ["2026-06", "2026-05", "2026-04"],
		listMemosInPeriods: async ([period]) => {
			listedPeriods.push(period);
			return period === "2026-05" ? [olderMemo] : [updatedRecentMemo, deletedMemo];
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
		onPeriodHydrated: (state) => periodStates.push(state),
		onCompleted: (state) => {
			completedState = state;
		},
		onFailed: () => {},
		onSidebarRequested: () => {},
		beginScheduledHydration: () => {},
		ensureAllMemosLoaded: () => {},
	});
	hydrator.setInitialLoadSuccess(["2026-06"]);

	const hydration = hydrator.start(false);
	assert.deepEqual(scheduler.pendingDelays(), [180]);
	await scheduler.runNextAndFlush();
	assert.deepEqual(scheduler.pendingDelays(), [180]);
	await scheduler.runNextAndFlush();
	assert.equal(await hydration, true);

	assert.deepEqual(listedPeriods, ["2026-05", "2026-04"]);
	assert.deepEqual(memos.map((memo) => memo.id), ["recent", "older"]);
	assert.equal(memos[0].contentSnapshot, "updated");
	assert.equal(periodStates.length, 2);
	assert.notEqual(completedState, null);
	assert.equal(invalidateCalls, 3);
	assert.equal(hydrator.getSnapshot().allMemosLoaded, true);
	assert.equal(hydrator.getSnapshot().loadMode, "all");
});

test("card-flow and sidebar requests switch hydration to fast mode", async () => {
	const scheduler = new TestScheduler();
	let ensureCalls = 0;
	let sidebarRenderCalls = 0;
	const hydrator = new MobileMemoHydrator({
		isMobile: () => true,
		isLoading: () => false,
		canHydrateCardFlow: () => true,
		scheduleTask: (callback, delayMs) => scheduler.schedule(callback, delayMs),
		cancelTask: (taskId) => scheduler.cancel(taskId),
		listMemoIndexPeriods: () => ["2026-05"],
		listMemosInPeriods: async () => [],
		getMemos: () => [],
		setMemos: () => {},
		invalidateFilteredMemos: () => {},
		captureRenderState: makeRenderState,
		onStarted: () => {},
		onPeriodHydrated: () => {},
		onCompleted: () => {},
		onFailed: () => {},
		onSidebarRequested: () => {
			sidebarRenderCalls += 1;
		},
		beginScheduledHydration: () => {},
		ensureAllMemosLoaded: () => {
			ensureCalls += 1;
		},
	});

	hydrator.requestCardFlowHydration();
	assert.equal(hydrator.getSnapshot().fastMode, true);
	assert.equal(hydrator.getSnapshot().loadMode, "hydrating");
	assert.equal(hydrator.getSnapshot().renderNextBatchAfterHydration, true);
	assert.equal(ensureCalls, 1);
	hydrator.consumeRenderNextBatchRequest();
	assert.equal(hydrator.getSnapshot().renderNextBatchAfterHydration, false);

	const hydration = hydrator.start(true);
	assert.deepEqual(scheduler.pendingDelays(), [0]);
	await scheduler.runNextAndFlush();
	assert.equal(await hydration, true);

	const sidebarHydrator = new MobileMemoHydrator({
		isMobile: () => true,
		isLoading: () => false,
		canHydrateCardFlow: () => true,
		scheduleTask: (callback, delayMs) => scheduler.schedule(callback, delayMs),
		cancelTask: (taskId) => scheduler.cancel(taskId),
		listMemoIndexPeriods: () => [],
		listMemosInPeriods: async () => [],
		getMemos: () => [],
		setMemos: () => {},
		invalidateFilteredMemos: () => {},
		captureRenderState: makeRenderState,
		onStarted: () => {},
		onPeriodHydrated: () => {},
		onCompleted: () => {},
		onFailed: () => {},
		onSidebarRequested: () => {
			sidebarRenderCalls += 1;
		},
		beginScheduledHydration: () => {},
		ensureAllMemosLoaded: () => {
			ensureCalls += 1;
		},
	});
	sidebarHydrator.deferSidebarHydration();
	assert.deepEqual(scheduler.pendingDelays(), [0]);
	scheduler.runNext();
	assert.equal(sidebarHydrator.getSnapshot().fastMode, true);
	assert.equal(sidebarRenderCalls, 1);
	assert.equal(ensureCalls, 2);
});

test("accelerates a background hydration run after the current wait", async () => {
	const scheduler = new TestScheduler();
	const listedPeriods: string[] = [];
	const hydrator = new MobileMemoHydrator({
		isMobile: () => true,
		isLoading: () => false,
		canHydrateCardFlow: () => true,
		scheduleTask: (callback, delayMs) => scheduler.schedule(callback, delayMs),
		cancelTask: (taskId) => scheduler.cancel(taskId),
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
		onSidebarRequested: () => {},
		beginScheduledHydration: () => {},
		ensureAllMemosLoaded: () => {},
	});

	const hydration = hydrator.start(false);
	assert.deepEqual(scheduler.pendingDelays(), [180]);
	hydrator.accelerate();
	await scheduler.runNextAndFlush();
	assert.deepEqual(listedPeriods, ["2026-05"]);
	assert.deepEqual(scheduler.pendingDelays(), [0]);
	await scheduler.runNextAndFlush();
	assert.equal(await hydration, true);
});

test("cancels a pending hydration run before period reads", async () => {
	const scheduler = new TestScheduler();
	let periodReadCalls = 0;
	let completedCalls = 0;
	const hydrator = new MobileMemoHydrator({
		isMobile: () => true,
		isLoading: () => false,
		canHydrateCardFlow: () => true,
		scheduleTask: (callback, delayMs) => scheduler.schedule(callback, delayMs),
		cancelTask: (taskId) => scheduler.cancel(taskId),
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
		onCompleted: () => {
			completedCalls += 1;
		},
		onFailed: () => {},
		onSidebarRequested: () => {},
		beginScheduledHydration: () => {},
		ensureAllMemosLoaded: () => {},
	});

	const hydration = hydrator.start(false);
	hydrator.cancel();
	await scheduler.runNextAndFlush();

	assert.equal(await hydration, false);
	assert.equal(periodReadCalls, 0);
	assert.equal(completedCalls, 0);
	assert.equal(hydrator.getSnapshot().fastMode, false);
});

test("reports a failed period read without completing hydration", async () => {
	const scheduler = new TestScheduler();
	let failedCalls = 0;
	let completedCalls = 0;
	const hydrator = new MobileMemoHydrator({
		isMobile: () => true,
		isLoading: () => false,
		canHydrateCardFlow: () => true,
		scheduleTask: (callback, delayMs) => scheduler.schedule(callback, delayMs),
		cancelTask: (taskId) => scheduler.cancel(taskId),
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
		onSidebarRequested: () => {},
		beginScheduledHydration: () => {},
		ensureAllMemosLoaded: () => {},
	});

	const hydration = hydrator.start(true);
	await scheduler.runNextAndFlush();

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

class TestScheduler {
	private nextId = 1;
	private readonly tasks: Array<{
		id: number;
		delayMs: number;
		callback: () => void;
	}> = [];

	schedule(callback: () => void, delayMs: number): number {
		const id = this.nextId;
		this.nextId += 1;
		this.tasks.push({ id, delayMs, callback });
		return id;
	}

	cancel(taskId: number): void {
		const index = this.tasks.findIndex((task) => task.id === taskId);
		if (index !== -1) {
			this.tasks.splice(index, 1);
		}
	}

	pendingDelays(): number[] {
		return this.tasks.map((task) => task.delayMs);
	}

	runNext(): void {
		const task = this.tasks.shift();
		assert.notEqual(task, undefined);
		task?.callback();
	}

	async runNextAndFlush(): Promise<void> {
		this.runNext();
		await Promise.resolve();
		await Promise.resolve();
	}
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

import test from "node:test";
import assert from "node:assert/strict";

import type { TimeBuoyAllQueryResult, TimeBuoyQueryItem, TimeBuoyQueryResult } from "../src/types/timeBuoy";
import type { MemoRecord } from "./helpers/memoViewFixture";
import { mergeTodayTimeBuoyFeed, TimeBuoyViewController } from "../src/ui/TimeBuoyViewController";

const EMPTY_RESULT: TimeBuoyQueryResult = { items: [], stale: [], missingPeriods: [] };
const EMPTY_ALL_RESULT: TimeBuoyAllQueryResult = { ...EMPTY_RESULT, complete: true };

test("promotes every today card in creation-time order without duplicating ordinary feed memos", () => {
	const memos = Array.from({ length: 8 }, (_, index) => ({
		id: `memo-${index}`,
		createdAt: `2026-07-${String(8 - index).padStart(2, "0")}T08:00:00+08:00`,
	}) as MemoRecord);
	const todayItems = memos.slice(0, 7).reverse().map((memo) => ({
		memo,
		targetDates: ["2026-07-11"],
		primaryTargetDate: "2026-07-11",
	}));
	todayItems.push(todayItems[0]);

	const result = mergeTodayTimeBuoyFeed(memos, todayItems);

	assert.deepEqual(result.map((memo) => memo.id), memos.map((memo) => memo.id));
});

test("today promotion keeps the latest Catalog memo when the controller snapshot is stale", () => {
	const staleMemo = makeMemo("memo-1", "- [ ] task", "2026-07-10T08:00:00+08:00");
	const latestMemo = makeMemo("memo-1", "- [x] task", "2026-07-10T08:00:00+08:00");
	const result = mergeTodayTimeBuoyFeed([latestMemo], [{
		memo: staleMemo,
		targetDates: ["2026-07-11"],
		primaryTargetDate: "2026-07-11",
	}]);

	assert.equal(result[0], latestMemo);
});

test("replaces a memo in loaded Time buoy tabs without querying again", async () => {
	const staleMemo = makeMemo("memo-1", "- [ ] task", "2026-07-10T08:00:00+08:00");
	const latestMemo = makeMemo("memo-1", "- [x] task", "2026-07-10T08:00:00+08:00");
	let renderCount = 0;
	const controller = new TimeBuoyViewController({
		getNow: () => new Date(2026, 6, 11),
		queryAll: async () => ({
			items: [makeQueryItem(staleMemo, "2026-07-11")],
			stale: [],
			missingPeriods: [],
			complete: true,
		}),
		queryDate: async () => EMPTY_RESULT,
		requestRender: () => {
			renderCount += 1;
		},
	});
	await controller.loadInitial();
	const rendersAfterLoad = renderCount;

	assert.equal(controller.replaceMemo(latestMemo), true);
	assert.equal(controller.getSnapshot().today[0]?.memo, latestMemo);
	assert.equal(renderCount, rendersAfterLoad + 1);
	assert.equal(controller.replaceMemo(latestMemo), false);
});

test("loads every Time buoy once and partitions the complete result into tabs", async () => {
	let queryCount = 0;
	const controller = createController(new Date(2026, 6, 11), async () => {
		queryCount += 1;
		return {
			items: [
				makeItem("today-new", "2026-07-11", "2026-07-10T09:00:00+08:00"),
				makeItem("upcoming-far", "2035-12-20", "2026-07-10T08:00:00+08:00"),
				makeItem("past-old", "2020-01-02", "2020-01-01T08:00:00+08:00"),
				makeItem("upcoming-near", "2026-07-12", "2026-07-10T10:00:00+08:00"),
			],
			stale: [],
			missingPeriods: [],
			complete: true,
		};
	});

	await controller.loadInitial();

	const snapshot = controller.getSnapshot();
	assert.equal(queryCount, 1);
	assert.deepEqual(snapshot.today.map((item) => item.memo.id), ["today-new"]);
	assert.deepEqual(snapshot.upcoming.map((item) => item.memo.id), ["upcoming-near", "upcoming-far"]);
	assert.deepEqual(snapshot.past.map((item) => item.memo.id), ["past-old"]);
	assert.equal(snapshot.activeTab, "today");
	assert.equal(snapshot.error, null);
});

test("keeps partial all-history Time buoy results visible while Catalog continues scanning", async () => {
	const controller = createController(new Date(2026, 6, 11), async () => ({
		items: [
			makeItem("upcoming-known", "2026-07-12", "2026-07-10T10:00:00+08:00"),
			makeItem("past-known", "2026-07-10", "2026-07-09T10:00:00+08:00"),
		],
		stale: [],
		missingPeriods: ["2026-06"],
		complete: false,
	}));

	await controller.loadInitial();

	const snapshot = controller.getSnapshot();
	assert.equal(snapshot.error, null);
	assert.equal(snapshot.complete, false);
	assert.deepEqual(snapshot.upcoming.map((item) => item.memo.id), ["upcoming-known"]);
	assert.deepEqual(snapshot.past.map((item) => item.memo.id), ["past-known"]);
});

test("prepares a deferred Time buoy index before the first full query", async () => {
	const calls: string[] = [];
	const controller = new TimeBuoyViewController({
		getNow: () => new Date(2026, 6, 11),
		ensureReady: async () => {
			calls.push("rebuild");
		},
		queryAll: async () => {
			calls.push("query");
			return EMPTY_ALL_RESULT;
		},
		queryDate: async () => EMPTY_RESULT,
		requestRender: () => {},
	});

	await controller.loadInitial();

	assert.deepEqual(calls, ["rebuild", "query"]);
});

test("shows a blocking loading state only for the first complete Time buoy load", async () => {
	const firstQuery = createDeferred<TimeBuoyAllQueryResult>();
	let renderCount = 0;
	const controller = new TimeBuoyViewController({
		getNow: () => new Date(2026, 6, 11),
		queryAll: () => firstQuery.promise,
		queryDate: async () => EMPTY_RESULT,
		requestRender: () => {
			renderCount += 1;
		},
	});

	const loading = controller.loadInitial();
	assert.equal(controller.getSnapshot().loading, true);
	assert.equal(renderCount, 1);

	firstQuery.resolve({
		items: [makeItem("today", "2026-07-11", "2026-07-10T09:00:00+08:00")],
		stale: [],
		missingPeriods: [],
		complete: true,
	});
	await loading;

	assert.equal(controller.getSnapshot().loading, false);
	assert.deepEqual(controller.getSnapshot().today.map((item) => item.memo.id), ["today"]);
	assert.equal(renderCount, 2);
});

test("keeps complete Time buoy content visible and skips rendering when a warm refresh is unchanged", async () => {
	const item = makeItem("today", "2026-07-11", "2026-07-10T09:00:00+08:00");
	const refreshQuery = createDeferred<TimeBuoyAllQueryResult>();
	let queryCount = 0;
	let renderCount = 0;
	const controller = new TimeBuoyViewController({
		getNow: () => new Date(2026, 6, 11),
		queryAll: () => {
			queryCount += 1;
			return queryCount === 1
				? Promise.resolve({ items: [item], stale: [], missingPeriods: [], complete: true })
				: refreshQuery.promise;
		},
		queryDate: async () => EMPTY_RESULT,
		requestRender: () => {
			renderCount += 1;
		},
	});
	await controller.loadInitial();
	renderCount = 0;

	const refreshing = controller.loadInitial();
	assert.equal(controller.getSnapshot().loading, false);
	assert.deepEqual(controller.getSnapshot().today.map((entry) => entry.memo.id), ["today"]);
	assert.equal(renderCount, 0);

	refreshQuery.resolve({ items: [item], stale: [], missingPeriods: [], complete: true });
	await refreshing;
	assert.equal(renderCount, 0);
});

test("keeps a tab selected while a warm Time buoy refresh is pending", async () => {
	const refreshQuery = createDeferred<TimeBuoyAllQueryResult>();
	let queryCount = 0;
	const controller = new TimeBuoyViewController({
		getNow: () => new Date(2026, 6, 11),
		queryAll: () => {
			queryCount += 1;
			return queryCount === 1 ? Promise.resolve(EMPTY_ALL_RESULT) : refreshQuery.promise;
		},
		queryDate: async () => EMPTY_RESULT,
		requestRender: () => undefined,
	});
	await controller.loadInitial();

	const refreshing = controller.loadInitial();
	controller.setActiveTab("upcoming");
	refreshQuery.resolve(EMPTY_ALL_RESULT);
	await refreshing;

	assert.equal(controller.getSnapshot().activeTab, "upcoming");
});

test("keeps committed content visible when a warm refresh fails and retries in place", async () => {
	const retryQuery = createDeferred<TimeBuoyAllQueryResult>();
	const original = makeItem("today", "2026-07-11", "2026-07-10T09:00:00+08:00");
	let queryCount = 0;
	const controller = new TimeBuoyViewController({
		getNow: () => new Date(2026, 6, 11),
		queryAll: () => {
			queryCount += 1;
			if (queryCount === 1) {
				return Promise.resolve({ items: [original], stale: [], missingPeriods: [], complete: true });
			}
			if (queryCount === 2) {
				return Promise.reject(new Error("transient refresh failure"));
			}
			return retryQuery.promise;
		},
		queryDate: async () => EMPTY_RESULT,
		requestRender: () => undefined,
	});
	await controller.loadInitial();
	await controller.loadInitial();
	assert.equal(controller.getSnapshot().error, null);
	assert.notEqual(controller.getSnapshot().refreshError, null);
	assert.deepEqual(controller.getSnapshot().today.map((item) => item.memo.id), ["today"]);

	const retrying = controller.retry();
	assert.equal(controller.getSnapshot().loading, false);
	assert.equal(controller.getSnapshot().refreshError, null);
	assert.deepEqual(controller.getSnapshot().today.map((item) => item.memo.id), ["today"]);

	retryQuery.resolve(EMPTY_ALL_RESULT);
	await retrying;
});

test("renders a warm Time buoy refresh exactly once when its content changes", async () => {
	const original = makeItem("today", "2026-07-11", "2026-07-10T09:00:00+08:00");
	const changed = makeItem("today", "2026-07-11", "2026-07-10T09:00:00+08:00");
	changed.memo = {
		...changed.memo,
		updatedAt: "2026-07-11T10:00:00+08:00",
		contentHash: "changed-hash",
	};
	let result: TimeBuoyAllQueryResult = {
		items: [original],
		stale: [],
		missingPeriods: [],
		complete: true,
	};
	let renderCount = 0;
	const controller = new TimeBuoyViewController({
		getNow: () => new Date(2026, 6, 11),
		queryAll: async () => result,
		queryDate: async () => EMPTY_RESULT,
		requestRender: () => {
			renderCount += 1;
		},
	});
	await controller.loadInitial();
	renderCount = 0;

	result = { items: [changed], stale: [], missingPeriods: [], complete: true };
	await controller.loadInitial();

	assert.equal(controller.getSnapshot().today[0]?.memo.contentHash, "changed-hash");
	assert.equal(renderCount, 1);
});

test("a today-only query does not suppress the first complete Time buoy loading state", async () => {
	const completeQuery = createDeferred<TimeBuoyAllQueryResult>();
	let renderCount = 0;
	const controller = new TimeBuoyViewController({
		getNow: () => new Date(2026, 6, 11),
		queryAll: () => completeQuery.promise,
		queryDate: async () => ({
			items: [makeItem("today", "2026-07-11", "2026-07-10T09:00:00+08:00")],
			stale: [],
			missingPeriods: [],
		}),
		requestRender: () => {
			renderCount += 1;
		},
	});
	await controller.loadTodayOnly();
	renderCount = 0;

	const loading = controller.loadInitial();
	assert.equal(controller.getSnapshot().loading, true);
	assert.deepEqual(controller.getSnapshot().today, []);
	assert.equal(renderCount, 1);

	completeQuery.resolve(EMPTY_ALL_RESULT);
	await loading;
});

test("clear restores the blocking state for the next complete Time buoy load", async () => {
	const nextQuery = createDeferred<TimeBuoyAllQueryResult>();
	let useDeferredQuery = false;
	const controller = new TimeBuoyViewController({
		getNow: () => new Date(2026, 6, 11),
		queryAll: () => useDeferredQuery ? nextQuery.promise : Promise.resolve(EMPTY_ALL_RESULT),
		queryDate: async () => EMPTY_RESULT,
		requestRender: () => undefined,
	});
	await controller.loadInitial();

	controller.clear();
	useDeferredQuery = true;
	const loading = controller.loadInitial();

	assert.equal(controller.getSnapshot().loading, true);
	nextQuery.resolve(EMPTY_ALL_RESULT);
	await loading;
});

test("today-only refresh requests render only when the visible result changes", async () => {
	let renderCount = 0;
	let result: TimeBuoyQueryResult = {
		items: [makeItem("today", "2026-07-11", "2026-07-10T09:00:00+08:00")],
		stale: [],
		missingPeriods: [],
	};
	const controller = new TimeBuoyViewController({
		getNow: () => new Date(2026, 6, 11),
		queryAll: async () => EMPTY_ALL_RESULT,
		queryDate: async () => result,
		requestRender: () => {
			renderCount += 1;
		},
	});

	await controller.loadTodayOnly();
	assert.equal(renderCount, 1);
	await controller.loadTodayOnly();
	assert.equal(renderCount, 1);

	const changedItem = makeItem("today", "2026-07-11", "2026-07-10T09:00:00+08:00");
	changedItem.memo = {
		...changedItem.memo,
		updatedAt: "2026-07-11T10:00:00+08:00",
		contentHash: "changed-hash",
	};
	result = { items: [changedItem], stale: [], missingPeriods: [] };
	await controller.loadTodayOnly();
	assert.equal(renderCount, 2);
});

test("today-only refresh preserves the last successful result when the index becomes incomplete", async () => {
	let result: TimeBuoyQueryResult = {
		items: [makeItem("today", "2026-07-11", "2026-07-10T09:00:00+08:00")],
		stale: [],
		missingPeriods: [],
	};
	const controller = new TimeBuoyViewController({
		getNow: () => new Date(2026, 6, 11),
		queryAll: async () => EMPTY_ALL_RESULT,
		queryDate: async () => result,
		requestRender: () => undefined,
	});
	await controller.loadTodayOnly();

	result = { items: [], stale: [], missingPeriods: ["2026-07"] };
	await controller.loadTodayOnly();

	const snapshot = controller.getSnapshot();
	assert.deepEqual(snapshot.today.map((item) => item.memo.id), ["today"]);
	assert.notEqual(snapshot.todayError, null);
});

test("today-only refresh preserves visible items while a background rebuild is pending", async () => {
	let todayIndexReady = true;
	let queryDateCalls = 0;
	const controller = new TimeBuoyViewController({
		getNow: () => new Date(2026, 6, 11),
		isTodayIndexReady: async (targetDate) => {
			assert.equal(targetDate, "2026-07-11");
			return todayIndexReady;
		},
		queryAll: async () => EMPTY_ALL_RESULT,
		queryDate: async () => {
			queryDateCalls += 1;
			return {
				items: [makeItem("today", "2026-07-11", "2026-07-10T09:00:00+08:00")],
				stale: [],
				missingPeriods: [],
			};
		},
		requestRender: () => undefined,
	});

	await controller.loadTodayOnly();
	todayIndexReady = false;
	await controller.loadTodayOnly();

	assert.equal(queryDateCalls, 1);
	assert.deepEqual(controller.getSnapshot().today.map((item) => item.memo.id), ["today"]);
});

test("merges one memo within each tab, preserves its dates, and keeps cross-tab entries independent", async () => {
	const controller = createController(new Date(2026, 6, 11), async () => ({
		items: [
			...makeItemsForMemo(
				"shared",
				["2026-07-09", "2026-07-10", "2026-07-20", "2026-08-01"],
				"2026-07-01T08:00:00+08:00",
			),
			...makeItemsForMemo("nearer", ["2026-07-15"], "2026-07-02T08:00:00+08:00"),
		],
		stale: [],
		missingPeriods: [],
		complete: true,
	}));

	await controller.loadInitial();

	const snapshot = controller.getSnapshot();
	assert.deepEqual(snapshot.upcoming.map((item) => item.memo.id), ["nearer", "shared"]);
	assert.deepEqual(snapshot.upcoming[1]?.targetDates, ["2026-07-20", "2026-08-01"]);
	assert.equal(snapshot.upcoming[1]?.primaryTargetDate, "2026-07-20");
	assert.deepEqual(snapshot.past.map((item) => item.memo.id), ["shared"]);
	assert.deepEqual(snapshot.past[0]?.targetDates, ["2026-07-09", "2026-07-10"]);
	assert.equal(snapshot.past[0]?.primaryTargetDate, "2026-07-10");
});

test("switches tabs without querying again and preserves the tab through reload", async () => {
	let queryCount = 0;
	const controller = createController(new Date(2026, 6, 11), async () => {
		queryCount += 1;
		return EMPTY_ALL_RESULT;
	});

	await controller.loadInitial();
	assert.equal(controller.setActiveTab("upcoming"), true);
	assert.equal(controller.setActiveTab("upcoming"), false);
	assert.equal(queryCount, 1);
	await controller.loadInitial();

	assert.equal(queryCount, 2);
	assert.equal(controller.getSnapshot().activeTab, "upcoming");
});

test("removes a deleted memo after the next Catalog query", async () => {
	const memo = { id: "memo-1", contentSnapshot: "回看 @2026-07-11", status: "active" } as MemoRecord;
	let result: TimeBuoyAllQueryResult = {
		items: [{
			memo,
			instance: { memoId: "memo-1", targetDate: "2026-07-11" },
		}],
		stale: [],
		missingPeriods: [],
		complete: true,
	};
	let renderCount = 0;
	const controller = new TimeBuoyViewController({
		getNow: () => new Date(2026, 6, 11),
		queryAll: async () => result,
		queryDate: async () => ({
			items: [{
				memo,
				instance: { memoId: "memo-1", targetDate: "2026-07-11" },
			}],
			stale: [],
			missingPeriods: [],
		}),
		requestRender: () => {
			renderCount += 1;
		},
	});
	await controller.loadInitial();
	renderCount = 0;
	result = EMPTY_ALL_RESULT;

	await controller.loadInitial();

	assert.deepEqual(controller.getSnapshot().today, []);
	assert.equal(renderCount, 1);
});

function createController(
	now: Date,
	queryAll: () => Promise<TimeBuoyAllQueryResult> = async () => EMPTY_ALL_RESULT,
): TimeBuoyViewController {
	return new TimeBuoyViewController({
		getNow: () => now,
		queryAll,
		queryDate: async () => EMPTY_RESULT,
		requestRender: () => undefined,
	});
}

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve: (value: T) => void = () => undefined;
	const promise = new Promise<T>((innerResolve) => {
		resolve = innerResolve;
	});
	return { promise, resolve };
}

function makeItem(memoId: string, targetDate: string, createdAt: string): TimeBuoyQueryItem {
	const memo = makeMemo(memoId, `回看 @${targetDate}`, createdAt);
	return {
		memo,
		instance: {
			memoId,
			targetDate,
		},
	};
}

function makeQueryItem(memo: MemoRecord, targetDate: string): TimeBuoyQueryItem {
	return {
		memo,
		instance: {
			memoId: memo.id,
			targetDate,
		},
	};
}

function makeItemsForMemo(memoId: string, targetDates: string[], createdAt: string): TimeBuoyQueryItem[] {
	const memo = makeMemo(memoId, targetDates.map((date) => `@${date}`).join(" "), createdAt);
	return targetDates.map((targetDate) => ({
		memo,
		instance: {
			memoId,
			targetDate,
		},
	}));
}

function makeMemo(id: string, contentSnapshot: string, createdAt: string): MemoRecord {
	const contentHash = `hash:${id}:${contentSnapshot}`;
	const block = `- 08:00:00 ${contentSnapshot}`;
	return {
		id,
		createdAt,
		updatedAt: createdAt,
		contentSnapshot,
		contentHash,
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
			sectionType: "heading",
			lastKnownBlock: block,
			lastKnownHash: contentHash,
			lineNumberHint: 1,
			lastSyncedAt: null,
		},
		monthlyRef: {
			path: `Memos/Memos-${createdAt.slice(0, 7)}.md`,
			dateHeading: createdAt.slice(0, 10),
			lastKnownBlock: block,
			lastKnownHash: contentHash,
			lineNumberHint: 1,
			lastSyncedAt: null,
		},
	};
}

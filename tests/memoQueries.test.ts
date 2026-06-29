import test from "node:test";
import assert from "node:assert/strict";

import { MemoQueryService } from "../src/services/memoQueries";
import type { MemoRecord } from "../src/types/memo";
import type { KnomoSettings } from "../src/types/settings";
import { formatMonthPeriod } from "../src/utils/date";

test("lists active memos by created date descending", async () => {
	const activeOlder = makeMemo("active-older", "2026-05-18T08:00:00.000+08:00");
	const activeNewer = makeMemo("active-newer", "2026-05-19T08:00:00.000+08:00");
	const deletedMemo = makeMemo("deleted", "2026-05-20T08:00:00.000+08:00", { status: "deleted" });
	const loadAllCalls: string[] = [];
	const service = createService([activeOlder, deletedMemo, activeNewer], [], [], loadAllCalls);

	const memos = await service.listMemos();

	assert.deepEqual(memos.map((memo) => memo.id), ["active-newer", "active-older"]);
	assert.deepEqual(loadAllCalls, []);
});

test("lists deleted memos by deleted date with created date fallback", async () => {
	const deletedOlder = makeMemo("deleted-older", "2026-05-20T08:00:00.000+08:00", {
		status: "deleted",
		deletedAt: "2026-05-22T08:00:00.000+08:00",
	});
	const deletedNewer = makeMemo("deleted-newer", "2026-05-19T08:00:00.000+08:00", {
		status: "deleted",
		deletedAt: "2026-05-23T08:00:00.000+08:00",
	});
	const deletedWithoutDate = makeMemo("deleted-without-date", "2026-05-24T08:00:00.000+08:00", {
		status: "deleted",
	});
	const service = createService([deletedOlder, deletedWithoutDate, deletedNewer]);

	const memos = await service.listDeletedMemos();

	assert.deepEqual(memos.map((memo) => memo.id), ["deleted-newer", "deleted-older", "deleted-without-date"]);
});

test("summarizes deleted memos without loading full memo list", async () => {
	const deletedMemo = makeMemo("deleted", "2026-05-20T08:00:00.000+08:00", { status: "deleted" });
	const activeMemo = makeMemo("active", "2026-05-21T08:00:00.000+08:00");
	const loadAllCalls: string[] = [];
	const service = createService([deletedMemo, activeMemo], [], [], loadAllCalls);

	const summary = await service.getDeletedMemoSummary();

	assert.deepEqual(summary, { count: 1, ids: ["deleted"] });
	assert.deepEqual(loadAllCalls, []);
});

test("lists issue memos by updated date descending", async () => {
	const monthlyFailed = makeMemo("monthly-failed", "2026-05-18T08:00:00.000+08:00", {
		updatedAt: "2026-05-22T08:00:00.000+08:00",
		syncStatus: "monthly_failed",
	});
	const issueMemo = makeMemo("issue", "2026-05-19T08:00:00.000+08:00", {
		updatedAt: "2026-05-23T08:00:00.000+08:00",
		issue: {
			type: "monthly_sync_failed",
			detectedAt: "2026-05-23T08:00:00.000+08:00",
			message: "Monthly archive sync failed.",
		},
	});
	const healthyMemo = makeMemo("healthy", "2026-05-20T08:00:00.000+08:00");
	const service = createService([monthlyFailed, issueMemo, healthyMemo]);

	const memos = await service.listIssueMemos();

	assert.deepEqual(memos.map((memo) => memo.id), ["issue", "monthly-failed"]);
});

test("loads current and previous periods for recent memos", async () => {
	const requestedPeriods: string[][] = [];
	const now = new Date();
	const expectedPeriods = [
		formatMonthPeriod(now),
		formatMonthPeriod(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
	];
	const service = createService([
		makeMemo("recent", "2026-05-20T08:00:00.000+08:00"),
		makeMemo("deleted", "2026-05-21T08:00:00.000+08:00", { status: "deleted" }),
	], requestedPeriods);

	const memos = await service.listRecentMemos();

	assert.deepEqual(requestedPeriods, [expectedPeriods]);
	assert.deepEqual(memos.map((memo) => memo.id), ["recent"]);
});

test("lists memo index periods without loading memo files", () => {
	const requestedPeriods: string[][] = [];
	const service = createService([], requestedPeriods, ["2026-06", "2026-05"]);

	const periods = service.listMemoIndexPeriods();

	assert.deepEqual(periods, ["2026-06", "2026-05"]);
	assert.deepEqual(requestedPeriods, []);
});

test("loads active memos from selected periods", async () => {
	const requestedPeriods: string[][] = [];
	const activeOlder = makeMemo("active-older", "2026-04-18T08:00:00.000+08:00");
	const activeNewer = makeMemo("active-newer", "2026-04-19T08:00:00.000+08:00");
	const deletedMemo = makeMemo("deleted", "2026-04-20T08:00:00.000+08:00", { status: "deleted" });
	const service = createService([activeOlder, deletedMemo, activeNewer], requestedPeriods);

	const memos = await service.listMemosInPeriods(["2026-04"]);

	assert.deepEqual(requestedPeriods, [["2026-04"]]);
	assert.deepEqual(memos.map((memo) => memo.id), ["active-newer", "active-older"]);
});

test("builds record stats from scanned index periods", async () => {
	const activeMemo = makeMemo("active", "2026-05-20T08:00:00.000+08:00");
	const deletedMemo = makeMemo("deleted", "2026-05-21T08:00:00.000+08:00", { status: "deleted" });
	const service = createService([activeMemo, deletedMemo]);
	let yieldCalls = 0;

	const prepared = await service.buildRecordStats(async () => {
		yieldCalls += 1;
	}, () => true);

	assert.equal(yieldCalls, 1);
	assert.deepEqual(prepared?.overview, {
		memoCount: 1,
		wordCount: 1,
		recordDayCount: 1,
	});
});

function createService(
	memos: MemoRecord[],
	requestedPeriods: string[][] = [],
	existingPeriods: string[] = [],
	loadAllCalls: string[] = [],
): MemoQueryService {
	const store = {
		listExistingPeriods: () => existingPeriods,
		loadPeriod: async () => ({
			memos: Object.fromEntries(memos.map((memo) => [memo.id, memo])),
		}),
		loadPeriods: async (_monthlyMemoFolder: string, periods: string[]) => {
			requestedPeriods.push(periods);
			return memos;
		},
		scanAll: async (
			_monthlyMemoFolder: string,
			visitor: (period: string, periodMemos: MemoRecord[]) => boolean | void | Promise<boolean | void>,
		) => {
			const shouldContinue = await visitor("2026-05", memos);
			return shouldContinue !== false;
		},
		loadAll: async () => {
			loadAllCalls.push("loadAll");
			return memos;
		},
	};
	return new MemoQueryService(() => ({ monthlyMemoFolder: "Memos" } as KnomoSettings), store as never);
}

function makeMemo(id: string, createdAt: string, overrides: Partial<MemoRecord> = {}): MemoRecord {
	return {
		id,
		createdAt,
		updatedAt: overrides.updatedAt ?? createdAt,
		contentSnapshot: id,
		contentHash: `${id}-hash`,
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
			path: "Daily/2026-05-18.md",
			heading: "## Knomo",
			lastKnownBlock: "",
			lastKnownHash: "",
			lineNumberHint: null,
			lastSyncedAt: null,
		},
		monthlyRef: {
			path: "Memos/Memos-2026-05.md",
			dateHeading: "## 2026-05-18",
			lastKnownBlock: "",
			lastKnownHash: "",
			lineNumberHint: null,
			lastSyncedAt: null,
		},
		...overrides,
	};
}

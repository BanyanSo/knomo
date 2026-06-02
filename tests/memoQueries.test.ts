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
	const service = createService([activeOlder, deletedMemo, activeNewer]);

	const memos = await service.listMemos();

	assert.deepEqual(memos.map((memo) => memo.id), ["active-newer", "active-older"]);
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

function createService(memos: MemoRecord[], requestedPeriods: string[][] = []): MemoQueryService {
	const store = {
		loadPeriod: async () => ({
			memos: Object.fromEntries(memos.map((memo) => [memo.id, memo])),
		}),
		loadPeriods: async (_monthlyMemoFolder: string, periods: string[]) => {
			requestedPeriods.push(periods);
			return memos;
		},
		loadAll: async () => memos,
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

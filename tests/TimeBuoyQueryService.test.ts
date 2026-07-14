import test from "node:test";
import assert from "node:assert/strict";

import type { MemoRecord } from "../src/types/memo";
import type { TimeBuoyIndexShard } from "../src/types/timeBuoy";
import { TimeBuoyQueryService } from "../src/services/TimeBuoyQueryService";
import { hashMemoContent, hashText } from "../src/utils/hash";
import { getTimeBuoyRevision } from "../src/utils/timeBuoyParser";

test("queries only the target shard and source memo periods", async () => {
	const memo = createMemo("memo-1", "2026-05-10T08:00:00+08:00", "回看 @2026-07-20");
	const loadedTargetPeriods: string[] = [];
	const loadedSourcePeriods: string[][] = [];
	const service = new TimeBuoyQueryService(
		() => ({ monthlyMemoFolder: "Memos" }) as never,
		{
			loadExistingPeriod: async (_folder: string, period: string) => {
				loadedTargetPeriods.push(period);
				return createShard(period, {
					"2026-07-20": {
						[memo.id]: { sourcePeriod: "2026-05", buoyRevision: getTimeBuoyRevision(memo.contentSnapshot) },
					},
				});
			},
		} as never,
		{
			loadExistingPeriods: async (_folder: string, periods: string[]) => {
				loadedSourcePeriods.push(periods);
				return [memo];
			},
		} as never,
	);

	const result = await service.queryDate("2026-07-20");

	assert.deepEqual(loadedTargetPeriods, ["2026-07"]);
	assert.deepEqual(loadedSourcePeriods, [["2026-05"]]);
	assert.deepEqual(result.items.map((item) => item.memo.id), ["memo-1"]);
	assert.deepEqual(result.stale, []);
});

test("suppresses stale, deleted, and no-longer-matching entries", async () => {
	const validMemo = createMemo("memo-valid", "2026-05-10T08:00:00+08:00", "回看 @2026-07-20");
	const changedMemo = createMemo("memo-changed", "2026-05-11T08:00:00+08:00", "已经移除日期");
	const deletedMemo = { ...createMemo("memo-deleted", "2026-05-12T08:00:00+08:00", "@2026-07-20"), status: "deleted" as const };
	const entries = Object.fromEntries([validMemo, changedMemo, deletedMemo].map((memo) => [memo.id, {
		sourcePeriod: "2026-05",
		buoyRevision: getTimeBuoyRevision(memo.contentSnapshot),
	}]));
	const service = new TimeBuoyQueryService(
		() => ({ monthlyMemoFolder: "Memos" }) as never,
		{ loadExistingPeriod: async () => createShard("2026-07", { "2026-07-20": entries }) } as never,
		{ loadExistingPeriods: async () => [validMemo, changedMemo, deletedMemo] } as never,
	);

	const result = await service.queryDate("2026-07-20");

	assert.deepEqual(result.items.map((item) => item.memo.id), ["memo-valid"]);
	assert.deepEqual(result.stale.map((item) => item.memoId).sort(), ["memo-changed", "memo-deleted"]);
});

test("reports missing target periods without scanning another source", async () => {
	const loadedSourcePeriods: string[][] = [];
	const service = new TimeBuoyQueryService(
		() => ({ monthlyMemoFolder: "Memos" }) as never,
		{ loadExistingPeriod: async () => null } as never,
		{
			loadExistingPeriods: async (_folder: string, periods: string[]) => {
				loadedSourcePeriods.push(periods);
				return [];
			},
		} as never,
	);

	const result = await service.queryRange("2026-07-31", "2026-08-01");

	assert.deepEqual(result.missingPeriods, ["2026-07", "2026-08"]);
	assert.deepEqual(loadedSourcePeriods, [[]]);
});

test("queries every stored Time buoy period once and keeps multiple dates for one memo", async () => {
	const memo = createMemo("memo-1", "2026-05-10T08:00:00+08:00", "回看 @2020-01-02 @2035-12-20");
	const loadedTargetPeriods: string[] = [];
	const loadedSourcePeriods: string[][] = [];
	const shards: Record<string, TimeBuoyIndexShard> = {
		"2020-01": createShard("2020-01", {
			"2020-01-02": { [memo.id]: { sourcePeriod: "2026-05", buoyRevision: getTimeBuoyRevision(memo.contentSnapshot) } },
		}),
		"2035-12": createShard("2035-12", {
			"2035-12-20": { [memo.id]: { sourcePeriod: "2026-05", buoyRevision: getTimeBuoyRevision(memo.contentSnapshot) } },
		}),
	};
	const service = new TimeBuoyQueryService(
		() => ({ monthlyMemoFolder: "Memos" }) as never,
		{
			loadExistingPeriod: async (_folder: string, period: string) => {
				loadedTargetPeriods.push(period);
				return shards[period] ?? null;
			},
		} as never,
		{
			loadExistingPeriods: async (_folder: string, periods: string[]) => {
				loadedSourcePeriods.push(periods);
				return [memo];
			},
		} as never,
	);

	const result = await service.queryAll(["2035-12", "2020-01", "2035-12"]);

	assert.deepEqual(loadedTargetPeriods, ["2020-01", "2035-12"]);
	assert.deepEqual(loadedSourcePeriods, [["2026-05"]]);
	assert.deepEqual(result.items.map((item) => item.instance.targetDate), ["2020-01-02", "2035-12-20"]);
	assert.equal(result.complete, true);
});

function createShard(
	targetPeriod: string,
	dates: TimeBuoyIndexShard["dates"],
): TimeBuoyIndexShard {
	return {
		schemaVersion: 2,
		targetPeriod,
		updatedAt: "2026-07-01T00:00:00.000+08:00",
		dates,
	};
}

function createMemo(id: string, createdAt: string, content: string): MemoRecord {
	const block = `- 08:00:00 ${content}`;
	return {
		id,
		createdAt,
		updatedAt: createdAt,
		contentSnapshot: content,
		contentHash: hashMemoContent(content),
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
			lastKnownHash: hashText(block),
			lineNumberHint: 1,
			lastSyncedAt: null,
		},
		monthlyRef: {
			path: `Memos/Memos-${createdAt.slice(0, 7)}.md`,
			dateHeading: createdAt.slice(0, 10),
			lastKnownBlock: block,
			lastKnownHash: hashText(block),
			lineNumberHint: 1,
			lastSyncedAt: null,
		},
	};
}

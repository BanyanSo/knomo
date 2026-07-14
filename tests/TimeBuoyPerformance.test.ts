import test from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

import { TimeBuoyQueryService } from "../src/services/TimeBuoyQueryService";
import type { MemoRecord } from "../src/types/memo";
import type { TimeBuoyIndexShard } from "../src/types/timeBuoy";
import { hashMemoContent, hashText } from "../src/utils/hash";
import { getTimeBuoyRevision } from "../src/utils/timeBuoyParser";

test("10,000 memo / 5,000 buoy fixture keeps today query bounded to one target shard", async () => {
	const memos = Array.from({ length: 10_000 }, (_, index) => createMemo(index));
	const memosById = new Map(memos.map((memo) => [memo.id, memo]));
	const shards = new Map<string, TimeBuoyIndexShard>();
	for (let month = 1; month <= 10; month += 1) {
		const period = `2026-${String(month).padStart(2, "0")}`;
		const targetDate = `${period}-20`;
		const entries: TimeBuoyIndexShard["dates"][string] = {};
		for (let offset = 0; offset < 500; offset += 1) {
			const memo = memos[(month - 1) * 500 + offset];
			memo.contentSnapshot = `回看 @${targetDate}`;
			memo.contentHash = hashMemoContent(memo.contentSnapshot);
			entries[memo.id] = { sourcePeriod: "2026-01", buoyRevision: getTimeBuoyRevision(memo.contentSnapshot) };
		}
		shards.set(period, {
			schemaVersion: 2,
			targetPeriod: period,
			updatedAt: "2026-01-01T00:00:00.000Z",
			dates: { [targetDate]: entries },
		});
	}
	const loadedTargetPeriods: string[] = [];
	const service = new TimeBuoyQueryService(
		() => ({ monthlyMemoFolder: "Memos" }) as never,
		{
			loadExistingPeriod: async (_folder: string, period: string) => {
				loadedTargetPeriods.push(period);
				return shards.get(period) ?? null;
			},
		} as never,
		{
			loadExistingPeriods: async (_folder: string, _periods: string[]) => [...memosById.values()],
		} as never,
	);

	const startedAt = performance.now();
	const result = await service.queryDate("2026-07-20");
	const elapsedMs = performance.now() - startedAt;

	assert.deepEqual(loadedTargetPeriods, ["2026-07"]);
	assert.equal(result.items.length, 500);
	assert.ok(elapsedMs < 2_000, `today query took ${elapsedMs.toFixed(1)}ms`);
});

function createMemo(index: number): MemoRecord {
	const content = `普通 memo ${index}`;
	const block = `- 08:00:00 ${content}`;
	return {
		id: `memo-${index}`,
		createdAt: "2026-01-10T08:00:00+08:00",
		updatedAt: "2026-01-10T08:00:00+08:00",
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
			path: "Daily/2026-01-10.md",
			heading: "## Memos",
			sectionType: "heading",
			lastKnownBlock: block,
			lastKnownHash: hashText(block),
			lineNumberHint: index + 1,
			lastSyncedAt: null,
		},
		monthlyRef: {
			path: "Memos/Memos-2026-01.md",
			dateHeading: "2026-01-10",
			lastKnownBlock: block,
			lastKnownHash: hashText(block),
			lineNumberHint: index + 1,
			lastSyncedAt: null,
		},
	};
}

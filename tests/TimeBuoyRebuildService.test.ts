import test from "node:test";
import assert from "node:assert/strict";

import type { MemoRecord } from "../src/types/memo";
import { hashMemoContent, hashText } from "../src/utils/hash";
import { getTimeBuoyRevision } from "../src/utils/timeBuoyParser";
import { ensureObsidianStub } from "./helpers/obsidianStub";

test("rebuilds candidates from current Daily Note blocks instead of memo snapshots", async () => {
	const memo = createMemo("old snapshot");
	const { service, replacements } = await createHarness(
		[memo],
		"- 08:00:00 current body @2026-08-15",
	);

	const result = await service.rebuild();

	assert.equal(result.status, "completed");
	const august = replacements.find((replacement) => replacement.period === "2026-08");
	assert.deepEqual(august?.dates["2026-08-15"], {
		"memo-1": {
			sourcePeriod: "2026-05",
			buoyRevision: getTimeBuoyRevision("current body @2026-08-15"),
		},
	});
});

test("cancels a rebuild before committing any candidate shard", async () => {
	const memo = createMemo("old snapshot");
	const { service, replacements } = await createHarness(
		[memo],
		"- 08:00:00 current body @2026-08-15",
	);

	const result = await service.rebuild({ isCancelled: () => true });

	assert.equal(result.status, "cancelled");
	assert.deepEqual(replacements, []);
});

test("preserves existing shards when any current Daily Note block cannot be resolved", async () => {
	const memo = createMemo("old snapshot");
	const { service, replacements } = await createHarness([memo], "unrelated content");

	await assert.rejects(service.rebuild(), (error: unknown) => {
		const rebuildError = error as {
			name?: string;
			skippedItems?: Array<{ memoId: string; path: string; reason: string }>;
		};
		assert.equal(rebuildError.name, "TimeBuoyRebuildIncompleteError");
		assert.deepEqual(rebuildError.skippedItems, [{
			memoId: "memo-1",
			path: "Daily/2026-05-10.md",
			reason: "daily_block_missing",
		}]);
		return true;
	});
	assert.deepEqual(replacements, []);
});

test("reads a shared Daily Note once while rebuilding multiple memos", async () => {
	const first = createMemo("first");
	const second = { ...createMemo("second"), id: "memo-2", dailyRef: { ...createMemo("second").dailyRef, lineNumberHint: 2 } };
	const { service, getDailyReadCount } = await createHarness(
		[first, second],
		"- 08:00:00 first @2026-08-15\n- 08:01:00 second @2026-08-16",
	);

	await service.rebuild();

	assert.equal(getDailyReadCount(), 1);
});

async function createHarness(memos: MemoRecord[], dailyContent: string) {
	await ensureObsidianStub();
	const { TFile } = await import("obsidian");
	const { MarkdownBlockService } = await import("../src/services/MarkdownBlockService");
	const { TimeBuoyRebuildService } = await import("../src/services/TimeBuoyRebuildService");
	const dailyFile = Object.assign(new TFile(), {
		path: "Daily/2026-05-10.md",
		name: "2026-05-10.md",
		extension: "md",
	});
	const replacements: Array<{ period: string; dates: Record<string, Record<string, unknown>> }> = [];
	let dailyReadCount = 0;
	const app = {
		vault: {
			getAbstractFileByPath: (path: string) => path === dailyFile.path ? dailyFile : null,
			cachedRead: async () => {
				dailyReadCount += 1;
				return dailyContent;
			},
		},
	};
	const service = new TimeBuoyRebuildService(
		app as never,
		() => ({ monthlyMemoFolder: "Memos" }) as never,
		{ loadAllExisting: async () => memos } as never,
		{
			listStoredPeriods: () => [],
			replacePeriodsWithRollback: async (
				_folder: string,
				periods: Map<string, Record<string, Record<string, unknown>>>,
			) => {
				for (const [period, dates] of periods) {
					replacements.push({ period, dates });
				}
			},
		} as never,
		new MarkdownBlockService(),
	);
	return { service, replacements, getDailyReadCount: () => dailyReadCount };
}

function createMemo(content: string): MemoRecord {
	const block = `- 08:00:00 ${content}`;
	return {
		id: "memo-1",
		createdAt: "2026-05-10T08:00:00+08:00",
		updatedAt: "2026-05-10T08:00:00+08:00",
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
			path: "Daily/2026-05-10.md",
			heading: null,
			sectionType: "root",
			lastKnownBlock: block,
			lastKnownHash: hashText(block),
			lineNumberHint: 1,
			lastSyncedAt: null,
		},
		monthlyRef: {
			path: "Memos/Memos-2026-05.md",
			dateHeading: "2026-05-10",
			lastKnownBlock: block,
			lastKnownHash: hashText(block),
			lineNumberHint: 1,
			lastSyncedAt: null,
		},
	};
}

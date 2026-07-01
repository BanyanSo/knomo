import assert from "node:assert/strict";
import test from "node:test";

import type { MemoRecord } from "../src/types/memo";
import { filterVisibleMemos, memoMatchesSearch } from "../src/ui/KnomoMemoFilter";
import { buildMemoSearchText } from "../src/ui/viewFilters";

test("filterVisibleMemos returns random, trash, and record stats branches directly", () => {
	const memos = [makeMemo("regular")];
	const randomMemos = [makeMemo("random")];

	assert.deepEqual(filterVisibleMemos({
		...baseOptions(memos),
		activeNav: "random",
		randomMemos,
	}), randomMemos);
	assert.deepEqual(filterVisibleMemos({
		...baseOptions(memos),
		activeNav: "trash",
	}), []);
	assert.deepEqual(filterVisibleMemos({
		...baseOptions(memos),
		activeNav: "record-stats",
	}), []);
});

test("filterVisibleMemos applies regular tag, query, and scope filters", () => {
	const tagged = makeMemo("tagged", {
		contentSnapshot: "Alpha memo",
		tags: ["Project/Knomo"],
	});
	const childTagged = makeMemo("child-tagged", {
		contentSnapshot: "Beta memo",
		tags: ["Project/Knomo/UI"],
	});
	const untagged = makeMemo("untagged", {
		contentSnapshot: "Alpha memo",
		tags: [],
	});

	assert.deepEqual(filterVisibleMemos({
		...baseOptions([tagged, childTagged, untagged]),
		activeTagKey: "project/knomo",
		normalizedQuery: "alpha",
	}).map((memo) => memo.id), ["tagged", "untagged"]);
	assert.deepEqual(filterVisibleMemos({
		...baseOptions([tagged, childTagged, untagged]),
		activeTagKey: "project/knomo",
	}).map((memo) => memo.id), ["tagged", "child-tagged"]);
	assert.deepEqual(filterVisibleMemos({
		...baseOptions([tagged, childTagged, untagged]),
		scopeFilter: "no-tag",
	}).map((memo) => memo.id), ["untagged"]);
});

test("filterVisibleMemos returns historical same-day review memos in newest order", () => {
	const today = makeMemo("today", { createdAt: "2026-05-21T09:00:00" });
	const lastYear = makeMemo("last-year", { createdAt: "2025-05-21T09:00:00" });
	const older = makeMemo("older", { createdAt: "2024-05-21T09:00:00" });
	const otherDay = makeMemo("other-day", { createdAt: "2025-05-22T09:00:00" });

	assert.deepEqual(filterVisibleMemos({
		...baseOptions([older, today, otherDay, lastYear]),
		activeNav: "review",
		today: new Date(2026, 4, 21),
	}).map((memo) => memo.id), ["last-year", "older"]);
});

test("memoMatchesSearch uses query, date, and record stats filters together", () => {
	const memo = makeMemo("memo", {
		createdAt: "2026-06-08T09:15:00",
		contentSnapshot: "Alpha memo",
		tags: ["Work"],
	});

	assert.equal(memoMatchesSearch(
		memo,
		"alpha",
		"week",
		{ type: "tag", startDate: "2026-06-01", endDateExclusive: "2026-07-01", tagKey: "work", tagLabel: "Work" },
		disabledDailyStatus(),
		buildMemoSearchText,
		new Date(2026, 5, 10),
	), true);
	assert.equal(memoMatchesSearch(
		memo,
		"missing",
		"week",
		null,
		disabledDailyStatus(),
		buildMemoSearchText,
		new Date(2026, 5, 10),
	), false);
});

function baseOptions(memos: MemoRecord[]) {
	return {
		memos,
		randomMemos: [],
		activeNav: "all" as const,
		activeTagKey: null,
		scopeFilter: "all" as const,
		normalizedQuery: "",
		searchDateFilter: null,
		recordStatsFilter: null,
		dailyStatus: disabledDailyStatus(),
		getMemoSearchText: buildMemoSearchText,
		today: new Date(2026, 4, 21),
	};
}

function disabledDailyStatus(): { enabled: false; folder: null; format: null } {
	return { enabled: false, folder: null, format: null };
}

function makeMemo(
	id: string,
	overrides: {
		createdAt?: string;
		contentSnapshot?: string;
		tags?: MemoRecord["tags"];
		links?: MemoRecord["links"];
		images?: MemoRecord["images"];
	} = {},
): MemoRecord {
	const createdAt = overrides.createdAt ?? "2026-05-20T09:00:00";
	const dailyBlock = "- 09:00:00 memo";
	return {
		id,
		createdAt,
		updatedAt: createdAt,
		contentSnapshot: overrides.contentSnapshot ?? "memo",
		contentHash: `hash-${id}`,
		status: "active",
		syncStatus: "synced",
		source: "plugin_input",
		version: 1,
		tags: overrides.tags ?? [],
		links: overrides.links ?? [],
		images: overrides.images ?? [],
		references: [],
		sourceMemoId: null,
		issue: null,
		lastMarkdownSyncAt: null,
		lastMarkdownSyncSource: null,
		dailyRef: {
			path: `Daily/${createdAt.slice(0, 10)}.md`,
			heading: "## Memos",
			lastKnownBlock: dailyBlock,
			lastKnownHash: `daily-${id}`,
			lineNumberHint: 1,
			lastSyncedAt: null,
		},
		monthlyRef: {
			path: "Knomo/Memos-2026-05.md",
			dateHeading: `## [[${createdAt.slice(0, 10)}]]`,
			lastKnownBlock: dailyBlock,
			lastKnownHash: `monthly-${id}`,
			lineNumberHint: 1,
			lastSyncedAt: null,
		},
	};
}

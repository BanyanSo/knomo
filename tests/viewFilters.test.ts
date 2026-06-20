import test from "node:test";
import assert from "node:assert/strict";

import type { MemoRecord } from "../src/types/memo";
import {
	buildMemoSearchText,
	collectTags,
	getMemoImages,
	getMemoStats,
	getRecordStatsSearchFilterKey,
	matchesRecordStatsSearchFilter,
	matchesScope,
	matchesSearchDateFilter,
	needsAllMemos,
	parseMemoLocalDate,
	tagMatchesActiveTagKey,
} from "../src/ui/viewFilters";

test("computes memo stats from normalized tags and supported images", () => {
	const memos = [
		makeMemo("a", {
			contentSnapshot: "abc 空 白",
			tags: ["#Project/Knomo", "project/knomo"],
			images: [
				{ path: "image.png", altText: "", syntax: "obsidian_embed" },
				{ path: "doc.pdf", altText: "", syntax: "obsidian_embed" },
			],
		}),
		makeMemo("b", {
			contentSnapshot: "two words",
			tags: ["life"],
			images: [
				{ path: "https://example.com/a", altText: "a", syntax: "markdown_image" },
			],
		}),
	];

	assert.deepEqual(getMemoStats(memos), {
		memoCount: 2,
		tagCount: 2,
		imageCount: 2,
		wordCount: 5,
	});
	assert.deepEqual(getMemoImages(memos[0]).map((image) => image.path), ["image.png"]);
});

test("collects display tags and matches nested active tag keys", () => {
	const tags = collectTags([
		makeMemo("a", { tags: ["#project/knomo"] }),
		makeMemo("b", { tags: ["Project/Knomo"] }),
		makeMemo("c", { tags: ["life"] }),
	], new Map([
		["project", "Project"],
		["project/knomo", "Project/Knomo"],
	]));

	assert.deepEqual(tags, [
		{ key: "project/knomo", name: "Project/Knomo", count: 2 },
		{ key: "life", name: "life", count: 1 },
	]);
	assert.equal(tagMatchesActiveTagKey("project/knomo/ui", "project/knomo"), true);
	assert.equal(tagMatchesActiveTagKey("project/other", "project/knomo"), false);
});

test("matches scope filters against a fixed day", () => {
	const today = new Date(2026, 4, 21);

	assert.equal(matchesScope(makeMemo("all"), "all", today), true);
	assert.equal(matchesScope(makeMemo("tagged", { tags: ["x"] }), "no-tag", today), false);
	assert.equal(matchesScope(makeMemo("link", { links: [{ target: "Note", displayText: null, syntax: "wiki_link" }] }), "with-link", today), true);
	assert.equal(matchesScope(makeMemo("bare-url", { contentSnapshot: "Visit https://example.com", links: [] }), "with-link", today), true);
	assert.equal(matchesScope(makeMemo("image", { images: [{ path: "a.png", altText: "", syntax: "obsidian_embed" }] }), "with-image", today), true);
	assert.equal(matchesScope(makeMemo("anniversary", { createdAt: "2025-05-21T09:00:00" }), "anniversary", today), true);
	assert.equal(matchesScope(makeMemo("this-week", { createdAt: "2026-05-18T09:00:00" }), "week", today), true);
	assert.equal(matchesScope(makeMemo("last-week", { createdAt: "2026-05-17T09:00:00" }), "week", today), false);
	assert.equal(matchesScope(makeMemo("this-month", { createdAt: "2026-05-01T09:00:00" }), "month", today), true);
	assert.equal(matchesScope(makeMemo("last-month", { createdAt: "2026-04-30T09:00:00" }), "last-month", today), true);
	assert.equal(matchesScope(makeMemo("last-7", { createdAt: "2026-05-15T09:00:00" }), "last-7", today), true);
	assert.equal(matchesScope(makeMemo("last-30", { createdAt: "2026-04-22T09:00:00" }), "last-30", today), true);
});

test("matches search date filters against a fixed day", () => {
	const today = new Date(2026, 4, 21);

	assert.equal(matchesSearchDateFilter(new Date(2026, 4, 21), "week", today), true);
	assert.equal(matchesSearchDateFilter(new Date(2026, 4, 12), "last-week", today), true);
	assert.equal(matchesSearchDateFilter(new Date(2026, 4, 18), "last-week", today), false);
	assert.equal(matchesSearchDateFilter(new Date(2026, 4, 1), "month", today), true);
	assert.equal(matchesSearchDateFilter(new Date(2026, 3, 30), "last-month", today), true);
	assert.equal(matchesSearchDateFilter(new Date(2026, 4, 15), "last-7", today), true);
	assert.equal(matchesSearchDateFilter(new Date(2026, 3, 22), "last-30", today), true);
});

test("matches record statistics drill-down filters with local date and hour semantics", () => {
	const morning = makeMemo("morning", { createdAt: "2026-06-08T09:15:00+08:00" });
	const late = makeMemo("late", { createdAt: "2026-06-30T23:45:00+09:00" });
	const nextMonth = makeMemo("next-month", { createdAt: "2026-07-01T09:00:00+08:00" });
	const inactive = makeMemo("inactive", { createdAt: "2026-06-09T09:00:00+08:00" });
	inactive.status = "deleted";
	const referenced = makeMemo("referenced", {
		createdAt: "2026-06-09T09:00:00+08:00",
		sourceMemoId: "source",
	});

	assert.equal(matchesRecordStatsSearchFilter(morning, { type: "day", date: "2026-06-08" }), true);
	assert.equal(matchesRecordStatsSearchFilter(late, { type: "month", month: "2026-06" }), true);
	assert.equal(matchesRecordStatsSearchFilter(nextMonth, { type: "month", month: "2026-06" }), false);
	const rangeFilter = {
		type: "range" as const,
		startDate: "2026-06-01",
		endDateExclusive: "2026-07-01",
	};
	assert.equal(matchesRecordStatsSearchFilter(morning, rangeFilter), true);
	assert.equal(matchesRecordStatsSearchFilter(nextMonth, rangeFilter), false);
	assert.equal(matchesRecordStatsSearchFilter(inactive, rangeFilter), false);
	assert.equal(matchesRecordStatsSearchFilter(late, {
		type: "hour",
		startDate: "2026-06-01",
		endDateExclusive: "2026-07-01",
		hour: 23,
	}), true);
	assert.equal(matchesRecordStatsSearchFilter(morning, {
		type: "hour",
		startDate: "2026-06-01",
		endDateExclusive: "2026-07-01",
		hour: 23,
	}), false);
	assert.equal(matchesRecordStatsSearchFilter(referenced, {
		type: "references",
		startDate: "2026-06-01",
		endDateExclusive: "2026-07-01",
	}), true);
	assert.equal(matchesRecordStatsSearchFilter(morning, {
		type: "references",
		startDate: "2026-06-01",
		endDateExclusive: "2026-07-01",
	}), false);
	assert.equal(matchesRecordStatsSearchFilter(morning, {
		type: "max-daily-notes",
		dates: ["2026-06-08", "2026-06-09"],
	}), true);
	assert.equal(matchesRecordStatsSearchFilter(nextMonth, {
		type: "max-daily-words",
		dates: ["2026-06-08", "2026-06-09"],
	}), false);
	assert.equal(getRecordStatsSearchFilterKey({ type: "day", date: "2026-06-08" }), "day:2026-06-08");
	assert.equal(getRecordStatsSearchFilterKey(rangeFilter), "range:2026-06-01:2026-07-01");
});

test("parses memo local date from createdAt, daily path, and monthly refs", () => {
	const createdAtMemo = makeMemo("created", { createdAt: "2026-05-20T08:09:10" });
	assert.equal(parseMemoLocalDate(createdAtMemo, disabledDailyStatus())?.getHours(), 8);

	const dailyMemo = makeMemo("daily", {
		createdAt: "invalid",
		dailyPath: "Daily/2026-05-20.md",
		dailyBlock: "- 18:30:45 daily memo",
	});
	const dailyDate = parseMemoLocalDate(dailyMemo, { enabled: true, folder: "Daily", format: "YYYY-MM-DD" });
	assert.equal(dailyDate?.getFullYear(), 2026);
	assert.equal(dailyDate?.getMonth(), 4);
	assert.equal(dailyDate?.getDate(), 20);
	assert.equal(dailyDate?.getHours(), 18);
	assert.equal(dailyDate?.getMinutes(), 30);
	assert.equal(dailyDate?.getSeconds(), 45);

	const monthlyMemo = makeMemo("monthly", {
		createdAt: "invalid",
		monthlyDateHeading: "## [[2026-05-19]]",
	});
	assert.equal(parseMemoLocalDate(monthlyMemo, disabledDailyStatus())?.getDate(), 19);
});

test("builds memo search text and all-memo loading flags", () => {
	const memo = makeMemo("search", {
		createdAt: "2026-05-20T09:00:00",
		contentSnapshot: "Hello Knomo",
		tags: ["Project"],
		links: [{ target: "Linked note", displayText: null, syntax: "wiki_link" }],
		images: [{ path: "clip.png", altText: "", syntax: "obsidian_embed" }],
	});
	const searchText = buildMemoSearchText(memo);

	assert.equal(searchText.includes("hello knomo"), true);
	assert.equal(searchText.includes("2026-05-20 09:00:00"), true);
	assert.equal(searchText.includes("project"), true);
	assert.equal(searchText.includes("linked note"), true);
	assert.equal(searchText.includes("clip.png"), true);
	assert.equal(needsAllMemos("all", "", null), false);
	assert.equal(needsAllMemos("all", "knomo", null), true);
	assert.equal(needsAllMemos("all", "", "week"), true);
	assert.equal(needsAllMemos("all", "", null, { type: "day", date: "2026-05-20" }), true);
	assert.equal(needsAllMemos("anniversary", "", null), true);
	assert.equal(needsAllMemos("no-tag", "", null), true);
	assert.equal(needsAllMemos("with-link", "", null), true);
	assert.equal(needsAllMemos("with-image", "", null), true);
});

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
		dailyPath?: string;
		dailyBlock?: string;
		monthlyDateHeading?: string;
		sourceMemoId?: string | null;
	} = {},
): MemoRecord {
	const createdAt = overrides.createdAt ?? "2026-05-20T09:00:00";
	const dailyPath = overrides.dailyPath ?? `Daily/${createdAt.slice(0, 10)}.md`;
	const dailyBlock = overrides.dailyBlock ?? "- 09:00:00 memo";
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
		sourceMemoId: overrides.sourceMemoId ?? null,
		issue: null,
		lastMarkdownSyncAt: null,
		lastMarkdownSyncSource: null,
		dailyRef: {
			path: dailyPath,
			heading: "## Memos",
			lastKnownBlock: dailyBlock,
			lastKnownHash: `daily-${id}`,
			lineNumberHint: 1,
			lastSyncedAt: null,
		},
		monthlyRef: {
			path: "Knomo/Memos-2026-05.md",
			dateHeading: overrides.monthlyDateHeading ?? "## [[2026-05-20]]",
			lastKnownBlock: dailyBlock,
			lastKnownHash: `monthly-${id}`,
			lineNumberHint: 1,
			lastSyncedAt: null,
		},
	};
}

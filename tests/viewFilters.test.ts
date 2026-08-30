import test from "node:test";
import assert from "node:assert/strict";

import type { MemoRecord } from "./helpers/memoViewFixture";
import {
	buildMemoSearchText,
	getMemoImages,
	getRegularFilterConditions,
	getRegularFilterCopy,
	getRecordStatsSearchFilterKey,
	getRecordStatsSearchFilterLabel,
	matchesRecordStatsSearchFilter,
	matchesScope,
	matchesSearchDateFilter,
	needsAllMemos,
	getMemoDataRequirement,
	parseMemoLocalDate,
	periodHasActiveTag,
	tagMatchesActiveTagKey,
} from "../src/ui/viewFilters";

test("filters supported memo images", () => {
	const memo = makeMemo("a", {
		images: [
			{ path: "image.png", altText: "", syntax: "obsidian_embed" },
			{ path: "doc.pdf", altText: "", syntax: "obsidian_embed" },
		],
	});

	assert.deepEqual(getMemoImages(memo).map((image) => image.path), ["image.png"]);
});

test("matches nested active tag keys", () => {
	assert.equal(tagMatchesActiveTagKey("project/knomo/ui", "project/knomo"), true);
	assert.equal(tagMatchesActiveTagKey("project/other", "project/knomo"), false);
});

test("builds regular filter copy from active filters", () => {
	const state = {
		activeTag: "Project/Knomo",
		activeTagKey: "project/knomo",
		searchQuery: "  alpha  ",
		searchDateFilter: "last-7" as const,
		recordStatsSearchFilter: {
			type: "with-image" as const,
			startDate: "2026-06-01",
			endDateExclusive: "2026-07-01",
		},
		scopeFilter: "with-link" as const,
	};

	assert.deepEqual(getRegularFilterConditions(state), [
		{ type: "tag", text: "#Project/Knomo" },
		{ type: "record-stats", text: "2026-06-01 to 2026-06-30 · With images" },
		{ type: "search", text: "“alpha”", query: "alpha" },
		{ type: "date", text: "Last 7 days", filter: "last-7" },
		{ type: "scope", text: "With links", filter: "with-link" },
	]);
	assert.deepEqual(getRegularFilterCopy(state, 3), {
		summary: "#Project/Knomo · 2026-06-01 to 2026-06-30 · With images · “alpha” · Last 7 days · With links: 3 Memos",
		emptyTitle: "#Project/Knomo · 2026-06-01 to 2026-06-30 · With images · “alpha” · Last 7 days · With links: 3 Memos",
	});
});

test("regular filter copy is empty when filters are inactive", () => {
	assert.equal(getRegularFilterCopy({
		activeTag: null,
		activeTagKey: null,
		searchQuery: "  ",
		searchDateFilter: null,
		recordStatsSearchFilter: null,
		scopeFilter: "all",
	}, 0), null);
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
	const tagged = makeMemo("tagged", {
		createdAt: "2026-06-10T09:00:00+08:00",
		tags: ["Work"],
	});
	const childTagged = makeMemo("child-tagged", {
		createdAt: "2026-06-10T10:00:00+08:00",
		tags: ["work/project"],
	});
	const imaged = makeMemo("imaged", {
		createdAt: "2026-06-11T09:00:00+08:00",
		images: [{ path: "photo.png", altText: "", syntax: "obsidian_embed" }],
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
	assert.equal(matchesRecordStatsSearchFilter(tagged, {
		type: "with-tag",
		startDate: "2026-06-01",
		endDateExclusive: "2026-07-01",
	}), true);
	assert.equal(matchesRecordStatsSearchFilter(morning, {
		type: "no-tag",
		startDate: "2026-06-01",
		endDateExclusive: "2026-07-01",
	}), true);
	assert.equal(matchesRecordStatsSearchFilter(tagged, {
		type: "no-tag",
		startDate: "2026-06-01",
		endDateExclusive: "2026-07-01",
	}), false);
	assert.equal(matchesRecordStatsSearchFilter(imaged, {
		type: "with-image",
		startDate: "2026-06-01",
		endDateExclusive: "2026-07-01",
	}), true);
	const tagFilter = {
		type: "tag" as const,
		startDate: "2026-06-01",
		endDateExclusive: "2026-07-01",
		tagKey: "work",
		tagLabel: "Work",
	};
	assert.equal(matchesRecordStatsSearchFilter(tagged, tagFilter), true);
	assert.equal(matchesRecordStatsSearchFilter(childTagged, tagFilter), true);
	assert.equal(matchesRecordStatsSearchFilter(nextMonth, tagFilter), false);
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
	assert.equal(getRecordStatsSearchFilterKey({
		type: "with-tag",
		startDate: "2026-06-01",
		endDateExclusive: "2026-07-01",
	}), "with-tag:2026-06-01:2026-07-01");
	assert.equal(getRecordStatsSearchFilterKey({
		type: "no-tag",
		startDate: "2026-06-01",
		endDateExclusive: "2026-07-01",
	}), "no-tag:2026-06-01:2026-07-01");
	assert.equal(getRecordStatsSearchFilterKey({
		type: "with-image",
		startDate: "2026-06-01",
		endDateExclusive: "2026-07-01",
	}), "with-image:2026-06-01:2026-07-01");
	assert.equal(getRecordStatsSearchFilterLabel({
		type: "with-tag",
		startDate: "2026-06-01",
		endDateExclusive: "2026-07-01",
	}), "2026-06-01 to 2026-06-30 · With tags");
	assert.equal(getRecordStatsSearchFilterLabel({
		type: "no-tag",
		startDate: "2026-06-01",
		endDateExclusive: "2026-07-01",
	}), "2026-06-01 to 2026-06-30 · Without tags");
	assert.equal(getRecordStatsSearchFilterLabel({
		type: "with-image",
		startDate: "2026-06-01",
		endDateExclusive: "2026-07-01",
	}), "2026-06-01 to 2026-06-30 · With images");
	assert.equal(getRecordStatsSearchFilterKey(tagFilter), "tag:2026-06-01:2026-07-01:work");
	assert.equal(getRecordStatsSearchFilterLabel(tagFilter), "2026-06-01 to 2026-06-30 · #Work");
});

test("parses memo local date from createdAt and falls back to the Daily path date", () => {
	const createdAtMemo = makeMemo("created", { createdAt: "2026-05-20T08:09:10" });
	assert.equal(parseMemoLocalDate(createdAtMemo, disabledDailyStatus())?.getHours(), 8);

	const dailyMemo = makeMemo("daily", {
		createdAt: "invalid",
		dailyPath: "Daily/2026-05-20.md",
	});
	const dailyDate = parseMemoLocalDate(dailyMemo, { enabled: true, folder: "Daily", format: "YYYY-MM-DD" });
	assert.equal(dailyDate?.getFullYear(), 2026);
	assert.equal(dailyDate?.getMonth(), 4);
	assert.equal(dailyDate?.getDate(), 20);
	assert.equal(dailyDate?.getHours(), 0);
	assert.equal(dailyDate?.getMinutes(), 0);
	assert.equal(dailyDate?.getSeconds(), 0);
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

test("resolves tag and date filters to only the required memo periods", () => {
	assert.deepEqual(getMemoDataRequirement({
		scope: "all",
		query: "",
		searchDateFilter: null,
		recordStatsFilter: null,
		activeTagKey: "project",
		tagPeriods: ["2026-05", "2025-12"],
	}), { kind: "periods", periods: ["2026-05", "2025-12"] });
	assert.deepEqual(getMemoDataRequirement({
		scope: "all",
		query: "",
		searchDateFilter: "last-30",
		recordStatsFilter: null,
		activeTagKey: null,
		tagPeriods: null,
		today: new Date(2026, 2, 2),
	}), { kind: "periods", periods: ["2026-02", "2026-03"] });
	assert.deepEqual(getMemoDataRequirement({
		scope: "all",
		query: "historical text",
		searchDateFilter: null,
		recordStatsFilter: null,
		activeTagKey: null,
		tagPeriods: null,
	}), { kind: "all-active" });
	assert.deepEqual(getMemoDataRequirement({
		activeNav: "review",
		scope: "all",
		query: "",
		searchDateFilter: null,
		recordStatsFilter: null,
		activeTagKey: null,
		tagPeriods: null,
	}), { kind: "all-active" });
	assert.equal(periodHasActiveTag({ "project/sub": 2 }, "project"), true);
	assert.equal(periodHasActiveTag({ "project-other": 1 }, "project"), false);
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

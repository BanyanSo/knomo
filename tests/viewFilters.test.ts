import test from "node:test";
import assert from "node:assert/strict";

import type { MemoViewItem } from "../src/types/memoView";
import {
	getMemoImages,
	getRegularFilterConditions,
	getRegularFilterCopy,
	getRecordStatsSearchFilterKey,
	getRecordStatsSearchFilterLabel,
	parseLocalDateText,
	tagMatchesActiveTagKey,
} from "../src/ui/viewFilters";

test("Things 摘要包含所有 AND 条件", () => {
	const state = { activeNav: "things" as const, activeTag: "project", activeTagKey: "project", searchQuery: "release", searchDateFilter: "week" as const, recordStatsSearchFilter: null, scopeFilter: "all" as const };
	assert.deepEqual(getRegularFilterConditions(state).map(item => item.type), ["things", "tag", "search", "date"]);
	assert.match(getRegularFilterCopy(state, 3)!.summary, /Things/);
	assert.match(getRegularFilterCopy(state, 0)!.emptyTitle, /Things/);
});

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

test("formats record statistics filter keys and labels", () => {
	const rangeFilter = { type: "range" as const, startDate: "2026-06-01", endDateExclusive: "2026-07-01" };
	const tagFilter = { type: "tag" as const, startDate: "2026-06-01", endDateExclusive: "2026-07-01", tagKey: "work", tagLabel: "Work" };
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

test("display date parsing keeps local calendar and rejects invalid dates", () => {
	const date = parseLocalDateText("2026-05-20T08:09:10");
	assert.deepEqual(date === null ? null : [date.getFullYear(), date.getMonth(), date.getDate(), date.getHours()], [2026, 4, 20, 8]);
	assert.equal(parseLocalDateText("invalid"), null);
	assert.equal(parseLocalDateText("2026-02-30"), null);
});

test("converts zoned creation time to the current device calendar semantics", () => {
	const originalTimeZone = process.env.TZ;
	process.env.TZ = "Asia/Shanghai";
	try {
		const date = parseLocalDateText("2026-08-31T22:04:15.986Z");

		assert.equal(date?.getFullYear(), 2026);
		assert.equal(date?.getMonth(), 8);
		assert.equal(date?.getDate(), 1);
		assert.equal(date?.getHours(), 6);

	} finally {
		if (originalTimeZone === undefined) delete process.env.TZ;
		else process.env.TZ = originalTimeZone;
	}
});

function makeMemo(
	id: string,
	overrides: {
		createdAt?: string;
		contentSnapshot?: string;
		tags?: MemoViewItem["tags"];
		links?: MemoViewItem["links"];
		images?: MemoViewItem["images"];
		dailyPath?: string;
		monthlyDateHeading?: string;
	} = {},
): MemoViewItem {
	const createdAt = overrides.createdAt ?? "2026-05-20T09:00:00";
	const dailyPath = overrides.dailyPath ?? `Daily/${createdAt.slice(0, 10)}.md`;
	return {
		id,
		createdAt,
		updatedAt: createdAt,
		contentSnapshot: overrides.contentSnapshot ?? "memo",
		contentHash: `hash-${id}`,
		status: "active",
		tags: overrides.tags ?? [],
		links: overrides.links ?? [],
		images: overrides.images ?? [],
		dailyRef: {
			path: dailyPath,
			heading: "## Memos",
			lineNumberHint: 1,
		},
	};
}

import test from "node:test";
import assert from "node:assert/strict";

import type { SelectedRecordStats } from "../src/services/RecordStatsService";
import {
	getRecordStatsHourSearchFilter,
	getRecordStatsMetricSearchFilter,
	getRecordStatsTagSearchFilter,
	getRecordStatsTrendSearchFilter,
} from "../src/ui/RecordStatsDrilldownFilters";

test("record stats trend drill-down accepts positive day and month points", () => {
	const selected = makeSelected({
		trend: [
			{ key: "2026-06-01", label: "2026-06-01", count: 2 },
			{ key: "2026-06-02", label: "2026-06-02", count: 0 },
			{ key: "2026-06", label: "2026-06", count: 4 },
		],
	});

	assert.deepEqual(getRecordStatsTrendSearchFilter(selected, "2026-06-01", "day"), {
		type: "day",
		date: "2026-06-01",
	});
	assert.deepEqual(getRecordStatsTrendSearchFilter(selected, "2026-06", "month"), {
		type: "month",
		month: "2026-06",
	});
	assert.equal(getRecordStatsTrendSearchFilter(selected, "2026-06-02", "day"), null);
	assert.equal(getRecordStatsTrendSearchFilter(selected, "2026-06-01", "month"), null);
	assert.equal(getRecordStatsTrendSearchFilter(null, "2026-06-01", "day"), null);
});

test("record stats hour drill-down accepts valid active hours only", () => {
	const selected = makeSelected({
		activeHours: makeActiveHours({ 8: 3 }),
	});

	assert.deepEqual(getRecordStatsHourSearchFilter(selected, "8"), {
		type: "hour",
		startDate: "2026-06-01",
		endDateExclusive: "2026-06-08",
		hour: 8,
	});
	assert.equal(getRecordStatsHourSearchFilter(selected, "8.5"), null);
	assert.equal(getRecordStatsHourSearchFilter(selected, "24"), null);
	assert.equal(getRecordStatsHourSearchFilter(selected, "9"), null);
	assert.equal(getRecordStatsHourSearchFilter(null, "8"), null);
});

test("record stats metric drill-down maps positive range metrics", () => {
	const selected = makeSelected({
		range: {
			memoCount: 3,
			referenceMemoCount: 2,
			imageMemoCount: 1,
			taggedMemoCount: 0,
		},
	});

	assert.deepEqual(getRecordStatsMetricSearchFilter(selected, "range"), {
		type: "range",
		startDate: "2026-06-01",
		endDateExclusive: "2026-06-08",
	});
	assert.deepEqual(getRecordStatsMetricSearchFilter(selected, "references"), {
		type: "references",
		startDate: "2026-06-01",
		endDateExclusive: "2026-06-08",
	});
	assert.deepEqual(getRecordStatsMetricSearchFilter(selected, "with-image"), {
		type: "with-image",
		startDate: "2026-06-01",
		endDateExclusive: "2026-06-08",
	});
	assert.equal(getRecordStatsMetricSearchFilter(selected, "with-tag"), null);
	assert.equal(getRecordStatsMetricSearchFilter(null, "range"), null);
});

test("record stats max-day drill-down copies date arrays", () => {
	const selected = makeSelected({
		range: {
			maxDailyMemoCount: 5,
			maxDailyMemoDates: ["2026-06-02", "2026-06-03"],
			maxDailyWordCount: 8,
			maxDailyWordDates: ["2026-06-04"],
		},
	});

	const memoFilter = getRecordStatsMetricSearchFilter(selected, "max-daily-notes");
	assert.deepEqual(memoFilter, {
		type: "max-daily-notes",
		dates: ["2026-06-02", "2026-06-03"],
	});
	if (memoFilter?.type === "max-daily-notes") {
		memoFilter.dates.push("2026-06-05");
	}
	assert.deepEqual(selected.range.maxDailyMemoDates, ["2026-06-02", "2026-06-03"]);

	assert.deepEqual(getRecordStatsMetricSearchFilter(selected, "max-daily-words"), {
		type: "max-daily-words",
		dates: ["2026-06-04"],
	});
});

test("record stats tag drill-down accepts positive common tags only", () => {
	const selected = makeSelected({
		commonTags: [
			{ key: "work", label: "Work", count: 2 },
			{ key: "empty", label: "Empty", count: 0 },
		],
	});

	assert.deepEqual(getRecordStatsTagSearchFilter(selected, "work"), {
		type: "tag",
		startDate: "2026-06-01",
		endDateExclusive: "2026-06-08",
		tagKey: "work",
		tagLabel: "Work",
	});
	assert.equal(getRecordStatsTagSearchFilter(selected, "empty"), null);
	assert.equal(getRecordStatsTagSearchFilter(selected, "missing"), null);
	assert.equal(getRecordStatsTagSearchFilter(null, "work"), null);
});

interface SelectedOverrides {
	range?: Partial<SelectedRecordStats["range"]>;
	trend?: SelectedRecordStats["trend"];
	activeHours?: SelectedRecordStats["activeHours"];
	commonTags?: SelectedRecordStats["commonTags"];
}

function makeSelected(overrides: SelectedOverrides = {}): SelectedRecordStats {
	const range: SelectedRecordStats["range"] = {
		memoCount: 1,
		wordCount: 10,
		recordDayCount: 1,
		referenceMemoCount: 0,
		taggedMemoCount: 1,
		untaggedMemoCount: 0,
		imageMemoCount: 0,
		maxDailyMemoCount: 0,
		maxDailyWordCount: 0,
		maxDailyMemoDates: [],
		maxDailyWordDates: [],
		...overrides.range,
	};
	return {
		startDate: "2026-06-01",
		endDateExclusive: "2026-06-08",
		overview: {
			memoCount: 1,
			wordCount: 10,
			recordDayCount: 1,
		},
		range,
		trend: overrides.trend ?? [{ key: "2026-06-01", label: "2026-06-01", count: 1 }],
		activeHours: overrides.activeHours ?? makeActiveHours({ 9: 1 }),
		commonTags: overrides.commonTags ?? [{ key: "work", label: "Work", count: 1 }],
	};
}

function makeActiveHours(counts: Record<number, number>): SelectedRecordStats["activeHours"] {
	return Array.from({ length: 24 }, (_, hour) => ({
		hour,
		count: counts[hour] ?? 0,
	}));
}

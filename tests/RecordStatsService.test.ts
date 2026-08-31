import test from "node:test";
import assert from "node:assert/strict";

import {
	canAdvanceRecordStatsDate,
	canRetreatRecordStatsDate,
	getRecordStatsRange,
	RecordStatsBuilder,
	RecordStatsService as ProductionRecordStatsService,
	shiftRecordStatsDate,
} from "../src/services/RecordStatsService";
import type { MemoRecord } from "./helpers/memoViewFixture";
import { matchesRecordStatsSearchFilter } from "../src/ui/viewFilters";

class RecordStatsService extends ProductionRecordStatsService {
	async prepare(memos: readonly MemoRecord[], yieldToUi: () => Promise<void>): Promise<boolean> {
		return this.prepareFromSource(memos, async (isCurrent) => {
			const builder = new RecordStatsBuilder();
			for (let index = 0; index < memos.length; index += 1) {
				if (index > 0 && index % 250 === 0) {
					await yieldToUi();
					if (!isCurrent()) {
						return null;
					}
				}
				builder.addMemo(memos[index]);
			}
			return builder.build();
		});
	}
}

test("prepares overview and selects weekly statistics with natural-day boundaries", async () => {
	const service = new RecordStatsService();
	const memos = [
		makeMemo("monday-early", "2026-06-08T00:00:00.000+08:00", "中文 one 1", {
			tags: ["work"],
			images: [{ path: "photo.png", altText: "", syntax: "obsidian_embed" }],
		}),
		makeMemo("monday-late", "2026-06-08T23:59:59.999+08:00", "two words"),
		makeMemo("sunday", "2026-06-14T23:30:00.000+08:00", "三", {
			sourceMemoId: "source",
			tags: ["journal"],
			images: [{ path: "document.pdf", altText: "", syntax: "obsidian_embed" }],
		}),
		makeMemo("next-week", "2026-06-15T00:00:00.000+08:00", "next"),
		makeMemo("deleted", "2020-06-09T12:00:00.000+08:00", "deleted", { status: "deleted" }),
	];

	assert.equal(await service.prepare(memos, async () => {}), true);
	assert.equal(service.getSnapshot().state, "ready");
	assert.equal(service.getEarliestYear(), 2026);
	const selected = service.select("week", new Date(2026, 5, 10));
	assert.notEqual(selected, null);
	assert.deepEqual(selected?.overview, {
		memoCount: 4,
		wordCount: 8,
		recordDayCount: 3,
	});
	assert.deepEqual(selected?.range, {
		memoCount: 3,
		wordCount: 7,
		recordDayCount: 2,
		referenceMemoCount: 1,
		taggedMemoCount: 2,
		untaggedMemoCount: 1,
		imageMemoCount: 1,
		maxDailyMemoCount: 2,
		maxDailyWordCount: 6,
		maxDailyMemoDates: ["2026-06-08"],
		maxDailyWordDates: ["2026-06-08"],
	});
	assert.deepEqual(selected?.trend.map((point) => point.count), [2, 0, 0, 0, 0, 0, 1]);
	assert.equal(selected?.activeHours[0].count, 1);
	assert.equal(selected?.activeHours[23].count, 2);
	assert.equal(memos.filter((memo) => matchesRecordStatsSearchFilter(memo, {
		type: "day",
		date: "2026-06-08",
	})).length, 2);
	assert.equal(memos.filter((memo) => matchesRecordStatsSearchFilter(memo, {
		type: "range",
		startDate: selected?.startDate ?? "",
		endDateExclusive: selected?.endDateExclusive ?? "",
	})).length, selected?.range.memoCount);
	assert.equal(memos.filter((memo) => matchesRecordStatsSearchFilter(memo, {
		type: "references",
		startDate: selected?.startDate ?? "",
		endDateExclusive: selected?.endDateExclusive ?? "",
	})).length, selected?.range.referenceMemoCount);
	assert.equal(memos.filter((memo) => matchesRecordStatsSearchFilter(memo, {
		type: "with-tag",
		startDate: selected?.startDate ?? "",
		endDateExclusive: selected?.endDateExclusive ?? "",
	})).length, selected?.range.taggedMemoCount);
	assert.equal(memos.filter((memo) => matchesRecordStatsSearchFilter(memo, {
		type: "no-tag",
		startDate: selected?.startDate ?? "",
		endDateExclusive: selected?.endDateExclusive ?? "",
	})).length, selected?.range.untaggedMemoCount);
	assert.equal(memos.filter((memo) => matchesRecordStatsSearchFilter(memo, {
		type: "with-image",
		startDate: selected?.startDate ?? "",
		endDateExclusive: selected?.endDateExclusive ?? "",
	})).length, selected?.range.imageMemoCount);
	assert.equal(memos.filter((memo) => matchesRecordStatsSearchFilter(memo, {
		type: "hour",
		startDate: selected?.startDate ?? "",
		endDateExclusive: selected?.endDateExclusive ?? "",
		hour: 23,
	})).length, selected?.activeHours[23].count);
});

test("uses createdAt wall-clock date and hour", async () => {
	const service = new RecordStatsService();
	const memos = [
		makeMemo("later-instant", "2026-06-08T01:00:00.000+08:00", "a"),
		makeMemo("earlier-instant", "2026-06-08T00:30:00.000+09:00", "b"),
	];

	await service.prepare(memos, async () => {});
	const selected = service.select("week", new Date(2026, 5, 8));
	assert.equal(selected?.range.memoCount, 2);
	assert.equal(selected?.activeHours[0].count, 1);
	assert.equal(selected?.activeHours[1].count, 1);
});

test("counts historical references recoverable from a Knomo memoId alias", async () => {
	const service = new RecordStatsService();
	const historicalReference = makeMemo(
		"historical-reference",
		"2026-06-08T09:00:00.000+08:00",
		"内容 [[Daily/2026-06-07#^abc123|20260607-080000-01]]",
	);

	await service.prepare([historicalReference], async () => {});
	const selected = service.select("week", new Date(2026, 5, 8));

	assert.equal(selected?.range.referenceMemoCount, 1);
	assert.equal(matchesRecordStatsSearchFilter(historicalReference, {
		type: "references",
		startDate: "2026-06-08",
		endDateExclusive: "2026-06-15",
	}), true);
});

test("builds month and year trends including leap day", async () => {
	const service = new RecordStatsService();
	const memos = [
		makeMemo("leap", "2024-02-29T12:00:00+08:00", "leap"),
		makeMemo("march-a", "2024-03-01T12:00:00+08:00", "march"),
		makeMemo("march-b", "2024-03-31T12:00:00+08:00", "march"),
	];

	await service.prepare(memos, async () => {});
	const month = service.select("month", new Date(2024, 1, 12));
	assert.equal(month?.trend.length, 29);
	assert.equal(month?.trend[28].count, 1);
	const year = service.select("year", new Date(2024, 7, 1));
	assert.equal(year?.trend.length, 12);
	assert.equal(year?.trend[1].count, 1);
	assert.equal(year?.trend[2].count, 2);
});

test("retains every tied maximum date", async () => {
	const service = new RecordStatsService();
	await service.prepare([
		makeMemo("a", "2026-06-08T10:00:00+08:00", "one"),
		makeMemo("b", "2026-06-09T10:00:00+08:00", "two"),
	], async () => {});

	const selected = service.select("week", new Date(2026, 5, 8));
	assert.deepEqual(selected?.range.maxDailyMemoDates, ["2026-06-08", "2026-06-09"]);
	assert.deepEqual(selected?.range.maxDailyWordDates, ["2026-06-08", "2026-06-09"]);
});

test("returns the top five normalized tags by memo count", async () => {
	const service = new RecordStatsService();
	const memos = [
		makeMemo("a", "2026-06-08T10:00:00+08:00", "one", { tags: ["#Work", "work", "alpha"] }),
		makeMemo("b", "2026-06-09T10:00:00+08:00", "two", { tags: ["WORK", "beta"] }),
		makeMemo("c", "2026-06-10T10:00:00+08:00", "three", { tags: ["gamma"] }),
		makeMemo("d", "2026-06-11T10:00:00+08:00", "four", { tags: ["delta"] }),
		makeMemo("e", "2026-06-12T10:00:00+08:00", "five", { tags: ["epsilon"] }),
		makeMemo("f", "2026-06-13T10:00:00+08:00", "six", { tags: ["zeta"] }),
		makeMemo("outside", "2026-06-15T10:00:00+08:00", "outside", { tags: ["alpha"] }),
	];

	await service.prepare(memos, async () => {});
	const selected = service.select("week", new Date(2026, 5, 10));
	assert.deepEqual(selected?.commonTags, [
		{ key: "work", label: "WORK", count: 2 },
		{ key: "alpha", label: "alpha", count: 1 },
		{ key: "beta", label: "beta", count: 1 },
		{ key: "delta", label: "delta", count: 1 },
		{ key: "epsilon", label: "epsilon", count: 1 },
	]);
	for (const tag of selected?.commonTags ?? []) {
		assert.equal(memos.filter((memo) => matchesRecordStatsSearchFilter(memo, {
			type: "tag",
			startDate: selected?.startDate ?? "",
			endDateExclusive: selected?.endDateExclusive ?? "",
			tagKey: tag.key,
			tagLabel: tag.label,
		})).length, tag.count);
	}
});

test("returns an empty common-tag list when the selected range has no tags", async () => {
	const service = new RecordStatsService();
	await service.prepare([
		makeMemo("plain", "2026-06-08T10:00:00+08:00", "plain"),
	], async () => {});

	assert.deepEqual(service.select("week", new Date(2026, 5, 8))?.commonTags, []);
});

test("reports empty and error states without exposing partial statistics", async () => {
	const emptyService = new RecordStatsService();
	assert.equal(await emptyService.prepare([], async () => {}), true);
	assert.equal(emptyService.getSnapshot().state, "empty");
	assert.equal(emptyService.select("week", new Date(2026, 5, 8))?.range.memoCount, 0);

	const service = new RecordStatsService();
	assert.equal(await service.prepare([
		makeMemo("invalid", "not-a-date", "text"),
	], async () => {}), false);
	assert.equal(service.getSnapshot().state, "error");
	assert.equal(service.select("week", new Date(2026, 5, 8)), null);
});

test("invalidating an in-flight preparation discards its result", async () => {
	const service = new RecordStatsService();
	const memos = Array.from({ length: 251 }, (_, index) => {
		return makeMemo(`memo-${index}`, "2026-06-08T12:00:00+08:00", "text");
	});
	let yielded = false;
	const preparing = service.prepare(memos, async () => {
		yielded = true;
		service.invalidate();
	});

	assert.equal(await preparing, false);
	assert.equal(yielded, true);
	assert.equal(service.getSnapshot().state, "idle");
});

test("prepares statistics from a scanned source key", async () => {
	const service = new RecordStatsService();
	const builder = new RecordStatsBuilder();
	builder.addMemos([
		makeMemo("memo-1", "2026-06-08T10:00:00+08:00", "one"),
		makeMemo("memo-2", "2026-06-09T10:00:00+08:00", "two words"),
	]);
	let loadCalls = 0;

	assert.equal(await service.prepareFromSource("catalog:1", async () => {
		loadCalls += 1;
		return builder.build();
	}), true);
	assert.equal(await service.prepareFromSource("catalog:1", async () => {
		loadCalls += 1;
		return null;
	}), true);

	assert.equal(loadCalls, 1);
	assert.equal(service.getSnapshot().state, "ready");
	assert.equal(service.select("week", new Date(2026, 5, 8))?.range.memoCount, 2);
});

test("source refresh keeps committed statistics visible until the replacement is ready", async () => {
	const service = new RecordStatsService();
	const oldBuilder = new RecordStatsBuilder();
	oldBuilder.addMemos([makeMemo("old", "2026-06-08T10:00:00+08:00", "old")]);
	assert.equal(await service.prepareFromSource("catalog:1", async () => oldBuilder.build()), true);

	const nextPrepared = createDeferred<ReturnType<RecordStatsBuilder["build"]>>();
	service.invalidate();
	assert.deepEqual(service.getSnapshot(), { state: "ready", error: null, updating: true });
	const refreshing = service.prepareFromSource("catalog:2", async () => nextPrepared.promise);

	assert.deepEqual(service.getSnapshot(), { state: "ready", error: null, updating: true });
	assert.equal(service.select("week", new Date(2026, 5, 8))?.range.memoCount, 1);

	const newBuilder = new RecordStatsBuilder();
	newBuilder.addMemos([
		makeMemo("new-1", "2026-06-08T10:00:00+08:00", "new one"),
		makeMemo("new-2", "2026-06-09T10:00:00+08:00", "new two"),
	]);
	nextPrepared.resolve(newBuilder.build());
	assert.equal(await refreshing, true);
	assert.deepEqual(service.getSnapshot(), { state: "ready", error: null, updating: false });
	assert.equal(service.select("week", new Date(2026, 5, 8))?.range.memoCount, 2);
});

test("routine complete-revision refresh keeps committed statistics visible without an updating marker", async () => {
	const service = new RecordStatsService();
	const oldBuilder = new RecordStatsBuilder();
	oldBuilder.addMemos([makeMemo("old", "2026-06-08T10:00:00+08:00", "old")]);
	assert.equal(await service.prepareFromSource("catalog:1", async () => oldBuilder.build()), true);

	const nextPrepared = createDeferred<ReturnType<RecordStatsBuilder["build"]>>();
	service.invalidate(false);
	assert.deepEqual(service.getSnapshot(), { state: "ready", error: null, updating: false });
	const refreshing = service.prepareFromSource("catalog:2", async () => nextPrepared.promise, false);

	assert.deepEqual(service.getSnapshot(), { state: "ready", error: null, updating: false });
	assert.equal(service.select("week", new Date(2026, 5, 8))?.range.memoCount, 1);

	const newBuilder = new RecordStatsBuilder();
	newBuilder.addMemos([
		makeMemo("new-1", "2026-06-08T10:00:00+08:00", "new one"),
		makeMemo("new-2", "2026-06-09T10:00:00+08:00", "new two"),
	]);
	nextPrepared.resolve(newBuilder.build());
	assert.equal(await refreshing, true);
	assert.deepEqual(service.getSnapshot(), { state: "ready", error: null, updating: false });
	assert.equal(service.select("week", new Date(2026, 5, 8))?.range.memoCount, 2);
});

test("calculates Monday ranges and bounded calendar navigation", () => {
	const week = getRecordStatsRange("week", new Date(2026, 5, 14));
	assert.deepEqual(toDateParts(week.start), [2026, 6, 8]);
	assert.deepEqual(toDateParts(week.endExclusive), [2026, 6, 15]);
	assert.deepEqual(toDateParts(shiftRecordStatsDate("month", new Date(2026, 0, 31), 1)), [2026, 2, 1]);
	assert.deepEqual(toDateParts(shiftRecordStatsDate("year", new Date(2026, 5, 1), -1)), [2025, 1, 1]);
	assert.equal(canAdvanceRecordStatsDate("week", new Date(2026, 5, 8), new Date(2026, 5, 19)), true);
	assert.equal(canAdvanceRecordStatsDate("week", new Date(2026, 5, 19), new Date(2026, 5, 19)), false);
	assert.equal(canRetreatRecordStatsDate("year", new Date(2021, 5, 1), 2021), false);
	assert.equal(canRetreatRecordStatsDate("year", new Date(2022, 5, 1), 2021), true);
	assert.equal(canRetreatRecordStatsDate("month", new Date(2021, 0, 1), 2021), false);
	assert.equal(canRetreatRecordStatsDate("month", new Date(2021, 1, 1), 2021), true);
	assert.equal(canRetreatRecordStatsDate("week", new Date(2021, 0, 4), 2021), true);
	assert.equal(canRetreatRecordStatsDate("week", new Date(2020, 11, 28), 2021), false);
	assert.equal(canRetreatRecordStatsDate("week", new Date(2026, 5, 8), null), false);
});

function makeMemo(
	id: string,
	createdAt: string,
	contentSnapshot: string,
	overrides: {
		status?: MemoRecord["status"];
		sourceMemoId?: string | null;
		tags?: MemoRecord["tags"];
		images?: MemoRecord["images"];
	} = {},
): MemoRecord {
	return {
		id,
		createdAt,
		updatedAt: createdAt,
		contentSnapshot,
		contentHash: `${id}-hash`,
		status: overrides.status ?? "active",
		syncStatus: "synced",
		source: "plugin_input",
		version: 1,
		tags: overrides.tags ?? [],
		links: [],
		images: overrides.images ?? [],
		references: overrides.sourceMemoId === undefined ? [] : [{ memoId: overrides.sourceMemoId ?? "source", referenceText: "[[Daily#^abc]]" }],
		sourceMemoId: overrides.sourceMemoId ?? null,
		issue: null,
		lastMarkdownSyncAt: null,
		lastMarkdownSyncSource: null,
		dailyRef: {
			path: `Daily/${createdAt.slice(0, 10)}.md`,
			heading: "## Memos",
			lastKnownBlock: `- 12:00 ${contentSnapshot}`,
			lastKnownHash: "hash",
			lineNumberHint: 1,
			lastSyncedAt: null,
		},
		monthlyRef: {
			path: "Memos/2026-06.md",
			dateHeading: "## 2026-06-08",
			lastKnownBlock: `- 12:00 ${contentSnapshot}`,
			lastKnownHash: "hash",
			lineNumberHint: 1,
			lastSyncedAt: null,
		},
	};
}

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolvePromise: (value: T) => void = () => undefined;
	const promise = new Promise<T>((resolve) => {
		resolvePromise = resolve;
	});
	return { promise, resolve: resolvePromise };
}

function toDateParts(date: Date): [number, number, number] {
	return [date.getFullYear(), date.getMonth() + 1, date.getDate()];
}

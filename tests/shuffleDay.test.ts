import test from "node:test";
import assert from "node:assert/strict";

import type { MemoViewItem } from "../src/types/memoView";
import {
	buildShuffleDayStats,
	selectShuffleDayDate,
	getMemoLocalDateKey,
	calculateShuffleDayDateWeight,
	normalizeShuffleDayHistory,
	type ShuffleDaySelectorOptions,
	sortShuffleDayMemos,
	weightedPick,
} from "../src/utils/shuffleDay";

test("returns empty states for missing or too-recent memos", () => {
	const today = new Date(2026, 6, 2);

	assert.deepEqual(selectShuffleDay([], { today }), { status: "empty-no-memos" });
	assert.deepEqual(selectShuffleDay([
		makeMemo("today", "2026-07-02T09:00:00"),
		makeMemo("recent", "2026-06-26T09:00:00"),
	], { today }), { status: "empty-not-enough-history" });
});

test("allows exactly seven days ago and excludes future dates", () => {
	const result = selectShuffleDay([
		makeMemo("future", "2026-07-03T09:00:00"),
		makeMemo("seven-days", "2026-06-25T09:00:00"),
	], {
		today: new Date(2026, 6, 2),
		now: new Date(2026, 6, 2, 10),
		random: makeRandom([0, 0]),
	});

	assert.equal(result.status, "ready");
	if (result.status === "ready") {
		assert.equal(result.selectedDate, "2026-06-25");
	}
});

test("picks among non-empty time buckets by normalized bucket weight", () => {
	const result = selectShuffleDay([
		makeMemo("near", "2026-06-25T09:00:00"),
		makeMemo("middle", "2026-05-01T09:00:00"),
		makeMemo("far", "2025-12-01T09:00:00"),
		makeMemo("old", "2024-01-01T09:00:00"),
	], {
		today: new Date(2026, 6, 2),
		now: new Date(2026, 6, 2, 10),
		random: makeRandom([0.2, 0]),
	});

	assert.equal(result.status, "ready");
	if (result.status === "ready") {
		assert.equal(result.selectedDate, "2026-05-01");
	}
});

test("avoids recently shown dates when another candidate remains", () => {
	const result = selectShuffleDay([
		makeMemo("recent-history", "2026-05-01T09:00:00"),
		makeMemo("available", "2026-05-02T09:00:00"),
	], {
		today: new Date(2026, 6, 2),
		now: new Date(2026, 6, 2, 10),
		history: [{ date: "2026-05-01", shownAt: "2026-07-01T10:00:00" }],
		random: makeRandom([0, 0]),
	});

	assert.equal(result.status, "ready");
	if (result.status === "ready") {
		assert.equal(result.selectedDate, "2026-05-02");
	}
});

test("sorts shuffle day memos by valid created time and builds visible stats", () => {
	const later = makeMemo("later", "2026-05-01T11:00:00", {
		contentSnapshot: "hello world",
		tags: ["Project"],
		images: [{ path: "a.png", altText: "", syntax: "markdown_image" }],
	});
	const earlier = makeMemo("earlier", "2026-05-01T09:00:00", {
		contentSnapshot: "中文 memo",
		tags: ["project/ui"],
		links: [{ target: "https://example.com", displayText: null, syntax: "url" }],
	});
	const invalid = makeMemo("invalid", "not-a-date");

	assert.deepEqual(sortShuffleDayMemos([later, invalid, earlier]).map((memo) => memo.id), ["earlier", "later", "invalid"]);

	const stats = buildShuffleDayStats([later, earlier]);
	assert.equal(stats.memoCount, 2);
	assert.equal(stats.wordCount, 5);
	assert.equal(stats.tagCount, 2);
	assert.equal(stats.imageCount, 1);
	assert.equal(stats.linkCount, 1);
	assert.equal(stats.firstMemoTime, "09:00:00");
	assert.equal(stats.lastMemoTime, "11:00:00");
});

test("Memo 日期和时间遵循 Daily 文本，不随设备时区漂移", () => {
	const originalTimeZone = process.env.TZ;
	process.env.TZ = "Asia/Shanghai";
	try {
		const memo = makeMemo("utc", "2026-06-24T22:30:00.000Z");
		const result = selectShuffleDay([memo], {
			today: new Date(2026, 6, 2),
			now: new Date(2026, 6, 2, 10),
			random: makeRandom([0, 0]),
		});

		assert.equal(result.status, "ready");
		if (result.status !== "ready") return;
		assert.equal(result.selectedDate, "2026-06-24");
		assert.equal(getMemoLocalDateKey(memo), "2026-06-24");
		assert.equal(buildShuffleDayStats([memo]).firstMemoTime, "22:30:00");
	} finally {
		if (originalTimeZone === undefined) delete process.env.TZ;
		else process.env.TZ = originalTimeZone;
	}
});

// 保留旧入口的有效日期断言，测试数据转换后交给唯一聚合选择核心。
function selectShuffleDay(memos: MemoViewItem[], options: ShuffleDaySelectorOptions) {
	const counts = new Map<string, number>();
	for (const memo of memos) {
		const date = getMemoLocalDateKey(memo);
		if (memo.status === "active" && date !== null) counts.set(date, (counts.get(date) ?? 0) + 1);
	}
	return selectShuffleDayDate([...counts].map(([logicalDate, memoCount]) => ({ logicalDate, memoCount, imageCount: 0, linkCount: 0 })), options);
}

test("weightedPick ignores invalid weights", () => {
	assert.equal(weightedPick([
		{ item: "ignored", weight: Number.NaN },
		{ item: "picked", weight: 2 },
	], () => 0), "picked");
	assert.equal(weightedPick([{ item: "none", weight: 0 }]), null);
});

test("年代段边界为 7/30/31/180/181/365/366，概率只按非空段归一化", () => {
	const now = new Date(2026, 9, 5, 12);
	const makeAggregate = (days: number) => ({ logicalDate: localDate(new Date(2026, 9, 5 - days)), memoCount: 1, imageCount: 0, linkCount: 0 });
	for (const [days, expected] of [[6, false], [7, true], [30, true], [31, true], [180, true], [181, true], [365, true], [366, true], [-1, false]] as const) {
		assert.equal(selectShuffleDayDate([makeAggregate(days)], { now }).status === "ready", expected);
	}
	const aggregates = [7, 31, 181, 366].map(makeAggregate);
	for (const [draw, index] of [[0, 0], [0.0999, 0], [0.1, 1], [0.4999, 1], [0.5, 2], [0.7999, 2], [0.8, 3]] as const) {
		const result = selectShuffleDayDate(aggregates, { now, random: makeRandom([draw, 0]) });
		assert.deepEqual(result, { status: "ready", selectedDate: aggregates[index].logicalDate });
	}
	const two = [makeAggregate(31), makeAggregate(366)];
	assert.deepEqual(selectShuffleDayDate(two, { now, random: makeRandom([0.666, 0]) }), { status: "ready", selectedDate: two[0].logicalDate });
	assert.deepEqual(selectShuffleDayDate(two, { now, random: makeRandom([0.667, 0]) }), { status: "ready", selectedDate: two[1].logicalDate });
});

test("1～6 日期逐个释放最早历史，历史重复不占 distinct 日期窗口，当前页另行排除", () => {
	const now = new Date(2026, 9, 5, 12);
	for (let count = 1; count <= 6; count++) {
		const aggregates = Array.from({ length: count }, (_, i) => ({ logicalDate: `2026-08-0${i + 1}`, memoCount: 1, imageCount: 0, linkCount: 0 }));
		const history = aggregates.slice(0, 5).flatMap((item, i) => [0, 1].map(offset => ({ date: item.logicalDate, shownAt: new Date(now.getTime() - i * 10000 - offset).toISOString() })));
		const result = selectShuffleDayDate(aggregates, { now, history, currentDate: aggregates[0].logicalDate, random: () => 0 });
		assert.equal(result.status, "ready");
		if (result.status === "ready") assert.equal(result.selectedDate, aggregates[count === 6 ? 5 : count - 1].logicalDate);
		if (count > 1) {
			const withoutHistory = selectShuffleDayDate(aggregates, { now, currentDate: aggregates[0].logicalDate, random: () => 0 });
			assert.deepEqual(withoutHistory, { status: "ready", selectedDate: aggregates[1].logicalDate });
		}
	}
});

test("段内评分使用有界密度与媒体分，历史降权只影响该日期", () => {
	const base = { logicalDate: "2026-08-01", memoCount: 1, imageCount: 0, linkCount: 0 };
	assert.equal(calculateShuffleDayDateWeight(base, false), 2);
	assert.equal(calculateShuffleDayDateWeight({ ...base, memoCount: 10000, imageCount: 100, linkCount: 100 }, false), 4.8);
	assert.equal(calculateShuffleDayDateWeight(base, true), 1);
});

test("历史按实际时间排序去重、裁剪 180 日与 100 条，时钟不回落到系统时间", () => {
	const now = new Date(2024, 2, 3, 12);
	const recent = { date: "2023-01-01", shownAt: now.toISOString() };
	const history = normalizeShuffleDayHistory([
		{ date: "2023-01-02", shownAt: new Date(2023, 7, 1).toISOString() },
		{ date: "2023-01-03", shownAt: new Date(2024, 1, 29).toISOString() }, recent, recent,
		{ date: "2024-02-30", shownAt: now.toISOString() },
	], now);
	assert.deepEqual(history.map(entry => entry.date), ["2023-01-01", "2023-01-03"]);
	assert.equal(normalizeShuffleDayHistory(Array.from({ length: 110 }, (_, i) => ({ date: "2023-01-01", shownAt: new Date(now.getTime() - i * 1000).toISOString() })), now).length, 100);
});

function localDate(date: Date): string {
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function makeMemo(
	id: string,
	createdAt: string,
	overrides: Partial<Pick<MemoViewItem, "contentSnapshot" | "tags" | "links" | "images" | "status">> = {},
): MemoViewItem {
	return {
		id,
		createdAt,
		updatedAt: createdAt,
		contentSnapshot: overrides.contentSnapshot ?? "memo content",
		contentHash: `hash-${id}`,
		status: overrides.status ?? "active",
		tags: overrides.tags ?? [],
		links: overrides.links ?? [],
		images: overrides.images ?? [],
		dailyRef: {
			path: `Daily/${createdAt.slice(0, 10)}.md`,
			heading: "## Memos",
			lineNumberHint: 1,
		},
	};
}

function makeRandom(values: number[]): () => number {
	let index = 0;
	return () => {
		const value = values[index] ?? 0;
		index += 1;
		return value;
	};
}

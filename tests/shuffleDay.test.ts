import test from "node:test";
import assert from "node:assert/strict";

import type { MemoRecord } from "./helpers/memoViewFixture";
import {
	buildShuffleDayStats,
	selectShuffleDay,
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
		assert.deepEqual(result.memos.map((memo) => memo.id), ["seven-days"]);
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
	assert.equal(stats.firstMemoTime, "09:00");
	assert.equal(stats.lastMemoTime, "11:00");
});

test("weightedPick ignores invalid weights", () => {
	assert.equal(weightedPick([
		{ item: "ignored", weight: Number.NaN },
		{ item: "picked", weight: 2 },
	], () => 0), "picked");
	assert.equal(weightedPick([{ item: "none", weight: 0 }]), null);
});

function makeMemo(
	id: string,
	createdAt: string,
	overrides: Partial<Pick<MemoRecord, "contentSnapshot" | "tags" | "links" | "images" | "status">> = {},
): MemoRecord {
	return {
		id,
		createdAt,
		updatedAt: createdAt,
		contentSnapshot: overrides.contentSnapshot ?? "memo content",
		contentHash: `hash-${id}`,
		status: overrides.status ?? "active",
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
			lastKnownBlock: id,
			lastKnownHash: `daily-${id}`,
			lineNumberHint: 1,
			lastSyncedAt: null,
		},
		monthlyRef: {
			path: "Memos/Memos-2026-05.md",
			dateHeading: createdAt.slice(0, 10),
			lastKnownBlock: id,
			lastKnownHash: `monthly-${id}`,
			lineNumberHint: 1,
			lastSyncedAt: null,
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

import test from "node:test";
import assert from "node:assert/strict";

import type { MemoRecord } from "./helpers/memoViewFixture";
import {
	calculateRandomReunionWeight,
	filterRandomReunionCandidates,
	markMemoReviewed,
	selectDiverseRandomReunionMemos,
	weightedSampleWithoutReplacement,
} from "../src/utils/randomReunion";

test("filters random reunion candidates lightly", () => {
	const today = new Date(2026, 4, 21);
	const memos = [
		makeMemo("valid", { createdAt: "2026-05-20T09:00:00", contentSnapshot: "这是一条足够长的 memo" }),
		makeMemo("today", { createdAt: "2026-05-21T09:00:00", contentSnapshot: "今天刚写完的内容" }),
		makeMemo("short", { createdAt: "2026-05-19T09:00:00", contentSnapshot: "太短" }),
		makeMemo("tag", { createdAt: "2026-05-18T09:00:00", contentSnapshot: "这条内容足够长", tags: ["草稿"] }),
		makeMemo("path", { createdAt: "2026-05-17T09:00:00", contentSnapshot: "这条内容足够长", sourcePath: "Template/a.md" }),
		makeMemo("deleted", { createdAt: "2026-05-16T09:00:00", contentSnapshot: "这条内容足够长", status: "deleted" }),
	];

	assert.deepEqual(filterRandomReunionCandidates(memos, { today }).map((memo) => memo.id), ["valid"]);
});

test("filters bilingual default blacklist tags without treating archive as archived", () => {
	const today = new Date(2026, 4, 21);
	const memos = [
		makeMemo("temp", { tags: ["temp"] }),
		makeMemo("temporary", { tags: ["Temporary"] }),
		makeMemo("draft-child", { tags: ["Draft/work"] }),
		makeMemo("archived", { tags: ["archived"] }),
		makeMemo("archive-topic", { tags: ["archive"] }),
	];

	assert.deepEqual(filterRandomReunionCandidates(memos, { today }).map((memo) => memo.id), ["archive-topic"]);
});

test("calculates random reunion weights", () => {
	const today = new Date(2026, 4, 21);
	const historicalToday = makeMemo("historical", { createdAt: "2025-05-21T09:00:00" });
	const recentReviewed = makeMemo("recent", { createdAt: "2026-05-10T09:00:00" });
	const oldReviewed = makeMemo("old", { createdAt: "2026-05-10T09:00:00" });

	assert.equal(calculateRandomReunionWeight(historicalToday, undefined, today), 7.5);
	assert.equal(
		calculateRandomReunionWeight(recentReviewed, { memoId: "recent", lastReviewedAt: "2026-05-20", reviewCount: 1 }, today),
		0.01,
	);
	assert.ok(
		calculateRandomReunionWeight(oldReviewed, { memoId: "old", lastReviewedAt: "2026-04-01", reviewCount: 1 }, today) > 1,
	);
	assert.ok(
		calculateRandomReunionWeight(oldReviewed, { memoId: "old", lastReviewedAt: "2026-04-01", reviewCount: 1 }, today) <= 1.2,
	);
});

test("samples weighted items without replacement", () => {
	const picked = weightedSampleWithoutReplacement(
		["a", "b", "c"],
		(item) => item === "b" ? 9 : 1,
		2,
		makeRandom([0.5, 0]),
	);

	assert.deepEqual(picked, ["b", "a"]);
});

test("applies diversity and then degrades to fill results", () => {
	const sameSource = [
		makeMemo("a", { sourcePath: "Daily/2026-05-01.md", createdAt: "2026-05-01T09:00:00", tags: ["project/a"] }),
		makeMemo("b", { sourcePath: "Daily/2026-05-01.md", createdAt: "2026-05-01T10:00:00", tags: ["project/b"] }),
		makeMemo("c", { sourcePath: "Daily/2026-05-01.md", createdAt: "2026-05-01T11:00:00", tags: ["project/c"] }),
		makeMemo("d", { sourcePath: "Daily/2026-05-02.md", createdAt: "2026-05-02T09:00:00", tags: ["life"] }),
		makeMemo("e", { sourcePath: "Daily/2026-05-03.md", createdAt: "2026-05-03T09:00:00", tags: ["work"] }),
	];
	assert.deepEqual(selectDiverseRandomReunionMemos(sameSource, 4).map((memo) => memo.id), ["a", "b", "d", "e"]);

	const onlySameSource = sameSource.slice(0, 3);
	assert.deepEqual(selectDiverseRandomReunionMemos(onlySameSource, 3).map((memo) => memo.id), ["a", "b", "c"]);
});

test("updates memo review state without touching markdown", () => {
	const nextState = markMemoReviewed({
		a: { memoId: "a", lastReviewedAt: "2026-05-20", reviewCount: 2 },
	}, "a", new Date(2026, 4, 21));

	assert.deepEqual(nextState.a, {
		memoId: "a",
		lastReviewedAt: "2026-05-21",
		reviewCount: 3,
	});
});

function makeMemo(
	id: string,
	overrides: {
		createdAt?: string;
		contentSnapshot?: string;
		tags?: string[];
		sourcePath?: string;
		status?: MemoRecord["status"];
	} = {},
): MemoRecord {
	const createdAt = overrides.createdAt ?? "2026-05-20T09:00:00";
	const sourcePath = overrides.sourcePath ?? `Daily/${createdAt.slice(0, 10)}.md`;
	return {
		id,
		createdAt,
		updatedAt: createdAt,
		contentSnapshot: overrides.contentSnapshot ?? "这是一条足够长的 memo",
		contentHash: `hash-${id}`,
		status: overrides.status ?? "active",
		syncStatus: "synced",
		source: "plugin_input",
		version: 2,
		tags: overrides.tags ?? [],
		links: [],
		images: [],
		references: [],
		sourceMemoId: null,
		issue: null,
		lastMarkdownSyncAt: null,
		lastMarkdownSyncSource: null,
		dailyRef: {
			path: sourcePath,
			heading: "## Knomo",
			lastKnownBlock: "- 09:00:00 这是一条足够长的 memo",
			lastKnownHash: `daily-${id}`,
			lineNumberHint: 3,
			lastSyncedAt: null,
		},
		monthlyRef: {
			path: "Memos/Memos-2026-05.md",
			dateHeading: `## ${createdAt.slice(0, 10)}`,
			lastKnownBlock: "- 09:00:00 这是一条足够长的 memo",
			lastKnownHash: `monthly-${id}`,
			lineNumberHint: 3,
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

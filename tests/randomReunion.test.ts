import test from "node:test";
import { sampleRandomReunionCandidates } from "../src/utils/randomReunion";
import assert from "node:assert/strict";

import type { MemoViewItem } from "../src/types/memoView";
import {
	calculateRandomReunionWeight,
	filterRandomReunionCandidates,
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

test("实际重逢按权重无放回抽样，支持零数量", async () => {
	const candidates = [makeMemo("a"), makeMemo("b", { createdAt: "2025-05-21T09:00:00" }), makeMemo("c")];
	const options = { today: new Date(2026, 4, 21), random: makeRandom([0.5, 0]) };
	const runtime = { yieldControl: async () => undefined };
	const picked = await sampleRandomReunionCandidates(candidates, {}, 2, options, runtime);
	assert.deepEqual(picked.map(memo => memo.id), ["b", "a"]);
	assert.deepEqual(await sampleRandomReunionCandidates(candidates, {}, 0, options, runtime), []);
});

test("applies diversity and then degrades to fill results", async () => {
	const sameSource = [
		makeMemo("a", { sourcePath: "Daily/2026-05-01.md", createdAt: "2026-05-01T09:00:00", tags: ["project/a"] }),
		makeMemo("b", { sourcePath: "Daily/2026-05-01.md", createdAt: "2026-05-01T10:00:00", tags: ["project/b"] }),
		makeMemo("c", { sourcePath: "Daily/2026-05-01.md", createdAt: "2026-05-01T11:00:00", tags: ["project/c"] }),
		makeMemo("d", { sourcePath: "Daily/2026-05-02.md", createdAt: "2026-05-02T09:00:00", tags: ["life"] }),
		makeMemo("e", { sourcePath: "Daily/2026-05-03.md", createdAt: "2026-05-03T09:00:00", tags: ["work"] }),
	];
	const runtime = { yieldControl: async () => undefined };
	assert.deepEqual((await sampleRandomReunionCandidates(sameSource, {}, 4, { random: () => 0 }, runtime)).map(memo => memo.id), ["a", "b", "d", "e"]);

	const onlySameSource = sameSource.slice(0, 3);
	assert.deepEqual((await sampleRandomReunionCandidates(onlySameSource, {}, 3, { random: () => 0 }, runtime)).map(memo => memo.id), ["a", "b", "c"]);
});

test("实际重逢只读取一次候选权重，零随机值仍保留全部独立 occurrence", async () => {
	const values = Array.from({ length: 1000 }, (_, index) => makeMemo(String(index)));
	let reads = 0;
	const reviews = new Proxy({}, { get: () => { reads++; return undefined; } });
	const selected = await sampleRandomReunionCandidates(values, reviews, values.length, { random: () => 0 }, { yieldControl: async () => undefined });
	assert.deepEqual(selected.map(memo => memo.id), values.map(memo => memo.id));
	assert.equal(reads, values.length);
});

test("P8 分片抽样在长候选集内让出执行，保留权重和多样性不足时的补齐", async () => {
	const candidates = Array.from({ length: 10000 }, (_, index) => makeMemo(String(index)));
	let yields = 0;
	const selected = await sampleRandomReunionCandidates(candidates, {}, 10, { random: () => 0 }, {
		maxOperationsPerSlice: 256, yieldControl: async () => { yields++; },
	});
	assert.deepEqual(selected.map((memo) => memo.id), candidates.slice(0, 10).map((memo) => memo.id));
	assert.ok(yields > 10);
});

test("重逢在满足数量和多样性后停止抽取，大候选池不会先全量排列", async () => {
	const candidates = Array.from({ length: 10000 }, (_, index) => makeMemo(String(index), {
		createdAt: new Date(2020, 0, index + 1).toISOString(), sourcePath: `Daily/${index}.md`, tags: [`tag${index}`],
	}));
	let draws = 0;
	const selected = await sampleRandomReunionCandidates(candidates, {}, 10, {
		random: () => { draws++; return 0; },
	}, { yieldControl: async () => undefined });
	assert.deepEqual(selected.map(memo => memo.id), candidates.slice(0, 10).map(memo => memo.id));
	assert.equal(draws, 10);
});

function makeMemo(
	id: string,
	overrides: {
		createdAt?: string;
		contentSnapshot?: string;
		tags?: string[];
		sourcePath?: string;
		status?: MemoViewItem["status"];
	} = {},
): MemoViewItem {
	const createdAt = overrides.createdAt ?? "2026-05-20T09:00:00";
	const sourcePath = overrides.sourcePath ?? `Daily/${createdAt.slice(0, 10)}.md`;
	return {
		id,
		createdAt,
		updatedAt: createdAt,
		contentSnapshot: overrides.contentSnapshot ?? "这是一条足够长的 memo",
		contentHash: `hash-${id}`,
		status: overrides.status ?? "active",
		tags: overrides.tags ?? [],
		links: [],
		images: [],
		dailyRef: {
			path: sourcePath,
			heading: "## Knomo",
			lineNumberHint: 3,
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

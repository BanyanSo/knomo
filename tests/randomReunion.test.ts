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

test("ISO 回看按实际时刻的本地日历降权，覆盖冷却与恢复边界", () => {
	const today = new Date(2026, 4, 21, 12);
	const memo = makeMemo("reviewed", { createdAt: "2025-05-21T09:00:00" });
	for (const days of [0, 3, 4, 30, 60, -1]) {
		const reviewedAt = new Date(2026, 4, 21 - days, 12).toISOString();
		const expected = days <= 3 ? 0.01 : 5 * (0.01 + 1.19 * Math.min(1, (days - 3) / 27));
		assert.equal(calculateRandomReunionWeight(memo, {
			memoId: memo.id, reviewCount: 1, lastReviewedAt: reviewedAt,
		}, today), expected, `days=${days}`);
	}
	assert.equal(calculateRandomReunionWeight(memo, { memoId: memo.id, reviewCount: 1, lastReviewedAt: "invalid" }, today), 5);
	assert.equal(calculateRandomReunionWeight(memo, { memoId: memo.id, reviewCount: 1, lastReviewedAt: "2026-02-30T10:00:00Z" }, today), 5);
});

test("回看 ISO 跨 UTC 午夜、纯日期和读取层可接受的日期形式均按本地日差处理", () => {
	const previous = process.env.TZ;
	process.env.TZ = "America/Los_Angeles";
	try {
		const memo = makeMemo("reviewed");
		for (const [now, reviewedAt, days] of [
			["2026-05-24T12:00:00-07:00", "2026-05-21T01:00:00Z", 4],
			["2026-05-24T12:00:00-07:00", "2026-05-21", 3],
			["2026-03-11T12:00:00-07:00", "2026-03-07T12:00:00-08:00", 4],
			["2024-03-03T12:00:00-08:00", "2024-02-29", 3],
			["2026-05-24T12:00:00-07:00", "Thu, 21 May 2026 01:00:00 GMT", 4],
		] as const) {
			const expected = days <= 3 ? 0.01 : 0.01 + 1.19 * (days - 3) / 27;
			assert.ok(Math.abs(calculateRandomReunionWeight(memo, {
				memoId: memo.id, reviewCount: 1, lastReviewedAt: reviewedAt,
			}, new Date(now)) - expected) < 1e-12, reviewedAt);
		}
		assert.equal(calculateRandomReunionWeight(makeMemo("anniversary", { createdAt: "2025-05-21" }), undefined, new Date(2026, 4, 21)), 7.5);
	} finally {
		if (previous === undefined) delete process.env.TZ;
		else process.env.TZ = previous;
	}
});

test("准入保留图片与链接例外、短文本门槛和黑名单，未来日期排除", () => {
	const memos = [
		makeMemo("image", { contentSnapshot: "![[a.png]]", images: [{ path: "a.png", altText: "", syntax: "obsidian_embed" }] }),
		makeMemo("wiki", { contentSnapshot: "[[a]]", links: [{ target: "a", displayText: null, syntax: "wiki_link" }] }),
		makeMemo("markdown", { contentSnapshot: "[a](https://example.com)", links: [{ target: "https://example.com", displayText: "a", syntax: "markdown_link" }] }),
		makeMemo("short", { contentSnapshot: "short" }),
		makeMemo("blocked", { tags: ["#Draft/work"], images: [{ path: "a.png", altText: "", syntax: "obsidian_embed" }] }),
		makeMemo("future", { createdAt: "2026-05-22T09:00:00" }),
	];
	assert.deepEqual(filterRandomReunionCandidates(memos, { today: new Date(2026, 4, 21) }).map(memo => memo.id), ["image", "wiki", "markdown"]);
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

test("0～40 条候选按实际数量提交，新鲜度优先满足相邻批次最少重复", async () => {
	for (const count of [0, 1, 6, 9, 10, 15, 20, 40]) {
		const candidates = Array.from({ length: count }, (_, index) => makeMemo(String(index), { tags: ["same/root"] }));
		let batches: string[][] = [];
		for (let turn = 0; turn < 6; turn++) {
			const picked = await sampleRandomReunionCandidates(candidates, {}, 10, { random: () => 0, shownBatches: batches }, { yieldControl: async () => {} });
			const keys = picked.map(memo => memo.id);
			assert.equal(keys.length, Math.min(count, 10));
			assert.equal(new Set(keys).size, keys.length);
			const previous = batches.at(-1) ?? [];
			if (turn > 0) assert.equal(keys.filter(key => previous.includes(key)).length, Math.max(0, 2 * keys.length - count), `N=${count}`);
			if (count === 40) assert.ok(keys.every(key => !batches.flat().includes(key)));
			batches = [...batches, keys].slice(-3);
		}
	}
});

test("使用全部根标签且与顺序无关，优先放宽标签再放宽来源日期", async () => {
	const candidates = [
		makeMemo("a", { createdAt: "2020-01-01T09:00", tags: ["work/a", "#Life/x", "life/y"] }),
		makeMemo("b", { createdAt: "2020-01-02T09:00", tags: ["life/b", "work/b"] }),
		makeMemo("c", { createdAt: "2020-01-03T09:00", tags: ["other", "life/c"] }),
		makeMemo("d", { createdAt: "2020-01-04T09:00", tags: [] }),
	];
	const runtime = { yieldControl: async () => {} };
	assert.deepEqual((await sampleRandomReunionCandidates(candidates, {}, 3, { random: () => 0 }, runtime)).map(memo => memo.id), ["a", "b", "d"]);
	candidates.forEach(memo => memo.tags.reverse());
	assert.deepEqual((await sampleRandomReunionCandidates(candidates, {}, 3, { random: () => 0 }, runtime)).map(memo => memo.id), ["a", "b", "d"]);
	const sameDate = candidates.map(memo => ({ ...memo, createdAt: "2020-01-01T09:00", dailyRef: { ...memo.dailyRef, path: "Daily/same.md" } }));
	assert.equal((await sampleRandomReunionCandidates(sameDate, {}, 10, { random: () => 0 }, runtime)).length, 4);
	const stages = [makeMemo("a"), makeMemo("b"), makeMemo("c"), makeMemo("other-date", { createdAt: "2020-01-02T09:00" })].map(memo => ({ ...memo, tags: ["topic"] }));
	assert.deepEqual((await sampleRandomReunionCandidates(stages, {}, 4, { random: () => 0 }, runtime)).map(memo => memo.id), ["a", "b", "other-date", "c"]);
});

test("重复批次 key 按最后出现分层；新 revision key 不继承旧展示历史", async () => {
	const candidates = [makeMemo("latest"), makeMemo("middle"), makeMemo("old"), makeMemo("new-revision")];
	const picked = await sampleRandomReunionCandidates(candidates, {}, 3, {
		random: () => 0, shownBatches: [["latest", "old", "old-revision"], ["middle"], ["latest"]],
	}, { yieldControl: async () => {} });
	assert.deepEqual(picked.map(memo => memo.id), ["new-revision", "old", "middle"]);
});

test("抽样在协作检查点停止取消后的权重与随机工作", async () => {
	const abort = new AbortController();
	let reads = 0;
	let readsBeforeAbort = 0;
	let draws = 0;
	const reviews = new Proxy({}, { get: () => { reads++; return undefined; } });
	await assert.rejects(sampleRandomReunionCandidates(Array.from({ length: 10000 }, (_, i) => makeMemo(String(i))), reviews, 10, {
		signal: abort.signal, random: () => { draws++; return 0; },
	}, { maxOperationsPerSlice: 100, yieldControl: async () => { readsBeforeAbort = reads; abort.abort(); } }), { name: "AbortError" });
	assert.ok(readsBeforeAbort > 0 && readsBeforeAbort < 10000);
	assert.equal(reads, readsBeforeAbort);
	assert.equal(draws, 0);
});

function makeMemo(
	id: string,
	overrides: {
		createdAt?: string;
		contentSnapshot?: string;
		tags?: string[];
		sourcePath?: string;
		status?: MemoViewItem["status"];
		images?: MemoViewItem["images"];
		links?: MemoViewItem["links"];
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
		links: overrides.links ?? [],
		images: overrides.images ?? [],
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

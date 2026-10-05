import assert from "node:assert/strict";
import test from "node:test";

import { toCatalogMemoView, type MemoViewItem } from "../src/types/memoView";
import { filterVisibleMemos, memoMatchesSearch } from "../src/ui/KnomoMemoFilter";
import { ensureObsidianStub } from "./helpers/obsidianStub";
import { CATALOG_PARSER_VERSION, DiaryMemoParser } from "../src/services/DiaryMemoParser";
import { MemoCatalogService } from "../src/services/MemoCatalogService";
import { InMemoryMemoCatalogStore } from "../src/services/MemoCatalogStore";

test("Catalog Memo 搜索统一全角字符、大小写和跨行空白", async () => {
	const memo = await makeMemo("normalized", { contentSnapshot: "ＡＬＰＨＡ\n\t beta" });
	for (const query of ["alpha beta", "ＡＬＰＨＡ   BETA"]) {
		assert.equal(memoMatchesSearch(memo, query, null, null, disabledDailyStatus()), true);
	}
	assert.equal(memoMatchesSearch(memo, "alpha gamma", null, null, disabledDailyStatus()), false);
});

test("filterVisibleMemos returns random, trash, and record stats branches directly", async () => {
	const memos = [await makeMemo("regular")];
	const randomMemos = [await makeMemo("random")];
	const shuffleDayMemos = [await makeMemo("shuffle")];

	assert.deepEqual(filterVisibleMemos({
		...baseOptions(memos),
		activeNav: "random",
		randomMemos,
	}), randomMemos);
	assert.deepEqual(filterVisibleMemos({
		...baseOptions(memos),
		activeNav: "shuffleDay",
		shuffleDayMemos,
	}), shuffleDayMemos);
	assert.deepEqual(filterVisibleMemos({
		...baseOptions(memos),
		activeNav: "trash",
	}), []);
	assert.deepEqual(filterVisibleMemos({
		...baseOptions(memos),
		activeNav: "record-stats",
	}), []);
});

test("filterVisibleMemos applies regular tag, query, and scope filters", async () => {
	const tagged = await makeMemo("tagged", {
		contentSnapshot: "Alpha memo",
		tags: ["Project/Knomo"],
	});
	const childTagged = await makeMemo("child-tagged", {
		contentSnapshot: "Beta memo",
		tags: ["Project/Knomo/UI"],
	});
	const untagged = await makeMemo("untagged", {
		contentSnapshot: "Alpha memo",
		tags: [],
	});

	assert.deepEqual(filterVisibleMemos({
		...baseOptions([tagged, childTagged, untagged]),
		activeTagKey: "project/knomo",
		normalizedQuery: "alpha",
	}).map((memo) => memo.id), ["tagged", "untagged"]);
	assert.deepEqual(filterVisibleMemos({
		...baseOptions([tagged, childTagged, untagged]),
		activeTagKey: "project/knomo",
	}).map((memo) => memo.id), ["tagged", "child-tagged"]);
	assert.deepEqual(filterVisibleMemos({
		...baseOptions([tagged, childTagged, untagged]),
		scopeFilter: "no-tag",
	}).map((memo) => memo.id), ["untagged"]);
});

test("filterVisibleMemos returns historical same-day review memos in newest order", async () => {
	const today = await makeMemo("today", { createdAt: "2026-05-21T09:00:00" });
	const lastYear = await makeMemo("last-year", { createdAt: "2025-05-21T09:00:00" });
	const older = await makeMemo("older", { createdAt: "2024-05-21T09:00:00" });
	const otherDay = await makeMemo("other-day", { createdAt: "2025-05-22T09:00:00" });

	assert.deepEqual(filterVisibleMemos({
		...baseOptions([older, today, otherDay, lastYear]),
		activeNav: "review",
		today: new Date(2026, 4, 21),
	}).map((memo) => memo.id), ["last-year", "older"]);
});

test("memoMatchesSearch uses query, date, and record stats filters together", async () => {
	const memo = await makeMemo("memo", {
		createdAt: "2026-06-08T09:15:00",
		contentSnapshot: "Alpha memo",
		tags: ["Work"],
	});

	assert.equal(memoMatchesSearch(
		memo,
		"alpha",
		"week",
		{ type: "tag", startDate: "2026-06-01", endDateExclusive: "2026-07-01", tagKey: "work", tagLabel: "Work" },
		disabledDailyStatus(),
		new Date(2026, 5, 10),
	), true);
	assert.equal(memoMatchesSearch(
		memo,
		"missing",
		"week",
		null,
		disabledDailyStatus(),
		new Date(2026, 5, 10),
	), false);
});

function baseOptions(memos: MemoViewItem[]) {
	return {
		memos,
		randomMemos: [],
		shuffleDayMemos: [],
		activeNav: "all" as const,
		activeTagKey: null,
		scopeFilter: "all" as const,
		normalizedQuery: "",
		searchDateFilter: null,
		recordStatsFilter: null,
		dailyStatus: disabledDailyStatus(),
		today: new Date(2026, 4, 21),
	};
}

function disabledDailyStatus(): { enabled: false; folder: null; format: null } {
	return { enabled: false, folder: null, format: null };
}

async function makeMemo(
	id: string,
	overrides: {
		createdAt?: string;
		contentSnapshot?: string;
		tags?: MemoViewItem["tags"];
		links?: MemoViewItem["links"];
		images?: MemoViewItem["images"];
	} = {},
): Promise<MemoViewItem> {
	await ensureObsidianStub();
	const { CatalogReadService } = await import("../src/services/CatalogReadService");
	const createdAt = overrides.createdAt ?? "2026-05-20T09:00:00";
	const sourcePath = `Daily/${createdAt.slice(0, 10)}.md`;
	const logicalDate = createdAt.slice(0, 10);
	const content = `- ${createdAt.slice(11)} ${(overrides.contentSnapshot ?? "memo").replace(/\n/gu, "\n  ")}\n`;
	const parsed = new DiaryMemoParser().parseRevision({ sourcePath, logicalDate, content, sourceRevision: "revision" });
	const observations = parsed.observations.map(observation => ({
		...observation,
		tags: overrides.tags ?? observation.tags,
		links: overrides.links ?? observation.links,
		images: overrides.images ?? observation.images,
	}));
	const store = new InMemoryMemoCatalogStore();
	const catalog = new MemoCatalogService(store);
	await catalog.open();
	await catalog.replaceFile({
		inventory: { sourcePath, logicalDate, mtime: 1, size: content.length },
		observations,
		sourceRevision: "revision",
		parserVersion: CATALOG_PARSER_VERSION,
		settingsFingerprint: "test",
		auditedAt: 1,
	});
	const page = await new CatalogReadService({ catalog }).query({ limit: 1 });
	catalog.close();
	assert.equal(page.items.length, 1);
	return { ...toCatalogMemoView(page.items[0]), id };
}

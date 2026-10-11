import assert from "node:assert/strict";
import test from "node:test";

import { toCatalogMemoView, type MemoViewItem } from "../src/types/memoView";
import { filterCatalogMemos } from "../src/ui/KnomoMemoFilter";
import { KnomoViewStateController } from "../src/ui/KnomoViewStateController";
import { ensureObsidianStub } from "./helpers/obsidianStub";
import { CATALOG_PARSER_VERSION, DiaryMemoParser } from "../src/services/DiaryMemoParser";
import { MemoCatalogService } from "../src/services/MemoCatalogService";
import { InMemoryMemoCatalogStore } from "../src/services/MemoCatalogStore";

test("Catalog 卡片筛选统一全角字符、大小写和跨行空白", async () => {
	const memo = await makeMemo("normalized", { contentSnapshot: "ＡＬＰＨＡ\n\t beta" });
	for (const query of ["alpha beta", "ＡＬＰＨＡ   BETA"]) {
		assert.deepEqual(filterCatalogMemos([memo], { text: query }), [memo]);
	}
	assert.deepEqual(filterCatalogMemos([memo], { text: "alpha gamma" }), []);
});

test("实际视图直接返回随机重逢、Shuffle Day，回收站和统计页不返回普通卡片", async () => {
	const memos = [await makeMemo("regular")];
	const randomMemos = [await makeMemo("random")];
	const shuffleDayMemos = [await makeMemo("shuffle")];
	const { KnomoView } = await import("../src/ui/KnomoView");
	const state = new KnomoViewStateController();
	const view = Object.assign(Object.create(KnomoView.prototype) as { getFilteredMemos(): MemoViewItem[] }, {
		viewStateController: state, memos,
		randomReunionController: { getSnapshot: () => ({ memos: randomMemos }) },
		shuffleDayController: { getSnapshot: () => ({ memos: shuffleDayMemos }) },
	});
	for (const [nav, expected] of [["random", randomMemos], ["shuffleDay", shuffleDayMemos], ["trash", []], ["record-stats", []]] as const) {
		state.activeNav = nav;
		assert.deepEqual(view.getFilteredMemos(), expected);
	}
});

test("当前来源和搜索条件共同筛选标签、文字及无标签范围", async () => {
	const tagged = await makeMemo("tagged", { contentSnapshot: "Alpha memo", tags: ["Project/Knomo"] });
	const childTagged = await makeMemo("child-tagged", { contentSnapshot: "Beta memo", tags: ["Project/Knomo/UI"] });
	const untagged = await makeMemo("untagged", { contentSnapshot: "Alpha memo", tags: [] });
	const memos = [tagged, childTagged, untagged];
	const state = new KnomoViewStateController();
	state.activeTagKey = "project/knomo";
	state.searchQuery = "alpha";
	assert.deepEqual(filterCatalogMemos(memos, state.search.getFilter(state.getSearchSource())).map(memo => memo.id), ["tagged"]);
	state.searchQuery = "";
	assert.deepEqual(filterCatalogMemos(memos, state.search.getFilter(state.getSearchSource())).map(memo => memo.id), ["tagged", "child-tagged"]);
	state.activeTagKey = null;
	state.scopeFilter = "no-tag";
	assert.deepEqual(filterCatalogMemos(memos, state.search.getFilter(state.getSearchSource())).map(memo => memo.id), ["untagged"]);
});

test("回顾范围排除今天和其他日期，卡片保留 Catalog 的排序", async () => {
	const today = await makeMemo("today", { createdAt: "2026-05-21T09:00:00" });
	const lastYear = await makeMemo("last-year", { createdAt: "2025-05-21T09:00:00" });
	const older = await makeMemo("older", { createdAt: "2024-05-21T09:00:00" });
	const otherDay = await makeMemo("other-day", { createdAt: "2025-05-22T09:00:00" });
	const state = new KnomoViewStateController();
	state.activeNav = "review";
	assert.deepEqual(filterCatalogMemos([lastYear, today, otherDay, older], state.getSearchSource(new Date(2026, 4, 21)))
		.map(memo => memo.id), ["last-year", "older"]);
});

test("文字、快捷日期和统计钻取条件取交集", async () => {
	const memo = await makeMemo("memo", { createdAt: "2026-06-08T09:15:00", contentSnapshot: "Alpha memo", tags: ["Work"] });
	const state = new KnomoViewStateController();
	const today = new Date(2026, 5, 10);
	state.searchDateFilter = "week";
	state.searchQuery = "alpha";
	state.recordStatsSearchFilter = { type: "tag", startDate: "2026-06-01", endDateExclusive: "2026-07-01", tagKey: "work", tagLabel: "Work" };
	assert.deepEqual(filterCatalogMemos([memo], state.search.getFilter(state.getSearchSource(today), today)), [memo]);
	state.searchQuery = "missing";
	state.recordStatsSearchFilter = null;
	assert.deepEqual(filterCatalogMemos([memo], state.search.getFilter(state.getSearchSource(today), today)), []);
});

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

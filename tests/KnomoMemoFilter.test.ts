import assert from "node:assert/strict";
import test from "node:test";

import { toCatalogMemoView, type MemoViewItem } from "../src/types/memoView";
import { filterCatalogMemos } from "../src/ui/KnomoMemoFilter";
import { KnomoViewStateController } from "../src/ui/KnomoViewStateController";
import { ensureObsidianStub } from "./helpers/obsidianStub";
import { CATALOG_PARSER_VERSION, DiaryMemoParser } from "../src/services/DiaryMemoParser";
import { MemoCatalogService } from "../src/services/MemoCatalogService";
import { InMemoryMemoCatalogStore } from "../src/services/MemoCatalogStore";
import { buildRecordStatsCatalogQuery } from "../src/services/CatalogReadService";
import { getSearchShortcutDate } from "../src/ui/SearchSession";
import { buildSearchSourceScope } from "../src/ui/SearchSourceScope";
import type { RecordStatsSearchFilter, ScopeFilter, SearchDateFilter } from "../src/ui/viewFilters";

test.before(ensureObsidianStub);

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

test("统计钻取取 observation 的本地日期和小时，不从旧 createdAt 换日", async () => {
	const memo = await makeMemo("current", { createdAt: "2026-09-01T06:04" });
	memo.createdAt = "2020-01-01T23:59:59Z";
	for (const [filter, expected] of [
		[{ type: "day", date: "2026-09-01" }, ["current"]],
		[{ type: "day", date: "2026-08-31" }, []],
		[{ type: "hour", startDate: "2026-09-01", endDateExclusive: "2026-09-02", hour: 6 }, ["current"]],
		[{ type: "hour", startDate: "2026-09-01", endDateExclusive: "2026-09-02", hour: 23 }, []],
	] satisfies [RecordStatsSearchFilter, string[]][]) {
		assert.deepEqual(filterCatalogMemos([memo], buildRecordStatsCatalogQuery(filter).query).map(item => item.id), expected);
	}
});

test("来源范围和快捷日期保留固定的日历边界，本周和本月截至今天", async () => {
	const dates = ["2025-05-21", "2026-04-21", "2026-04-22", "2026-04-30", "2026-05-01", "2026-05-11", "2026-05-17", "2026-05-18", "2026-05-21", "2026-05-22", "2026-05-31", "2026-06-01"];
	const memos = await Promise.all(dates.map(date => makeMemo(date, { createdAt: `${date}T23:59:59` })));
	const today = new Date(2026, 4, 21, 0, 1);
	const cases: [SearchDateFilter, string[]][] = [
		["week", ["2026-05-18", "2026-05-21"]],
		["last-week", ["2026-05-11", "2026-05-17"]],
		["month", ["2026-05-01", "2026-05-11", "2026-05-17", "2026-05-18", "2026-05-21"]],
		["last-month", ["2026-04-21", "2026-04-22", "2026-04-30"]],
		["last-7", ["2026-05-17", "2026-05-18", "2026-05-21"]],
		["last-30", ["2026-04-22", "2026-04-30", "2026-05-01", "2026-05-11", "2026-05-17", "2026-05-18", "2026-05-21"]],
	];
	for (const [filter, expected] of cases) {
		assert.deepEqual(filterCatalogMemos(memos, { searchDate: getSearchShortcutDate(filter, today) }).map(item => item.id), expected, filter);
		if (filter === "last-week") continue;
		assert.deepEqual(filterCatalogMemos(memos, sourceScope(filter, today)).map(item => item.id), expected, `scope ${filter}`);
	}
	assert.deepEqual(filterCatalogMemos(memos, sourceScope("all", today)).map(item => item.id), dates);
	assert.deepEqual(filterCatalogMemos(memos, sourceScope("anniversary", today)).map(item => item.id), ["2025-05-21"]);
});

for (const { today, filter, dates, expected } of [
	{ today: new Date(2024, 2, 1), filter: "last-month", dates: ["2024-01-31", "2024-02-01", "2024-02-29", "2024-03-01"], expected: ["2024-02-01", "2024-02-29"] },
	{ today: new Date(2027, 0, 1), filter: "week", dates: ["2026-12-27", "2026-12-28", "2026-12-31", "2027-01-01", "2027-01-02"], expected: ["2026-12-28", "2026-12-31", "2027-01-01"] },
	{ today: new Date(2027, 0, 1), filter: "last-7", dates: ["2026-12-25", "2026-12-26", "2026-12-31", "2027-01-01", "2027-01-02"], expected: ["2026-12-26", "2026-12-31", "2027-01-01"] },
] satisfies { today: Date; filter: SearchDateFilter; dates: string[]; expected: string[] }[]) {
	test(`快捷日期 ${filter} 覆盖月末、跨年和闰日：${expected.join(",")}`, async () => {
		const memos = await Promise.all(dates.map(date => makeMemo(date, { createdAt: `${date}T00:00` })));
		assert.deepEqual(filterCatalogMemos(memos, { searchDate: getSearchShortcutDate(filter, today) }).map(item => item.id), expected);
	});
}

test("统计钻取保留末日、小时、标签层级、正文引用和图片的固定命中", async () => {
	const memos = await Promise.all([
		makeMemo("before", { createdAt: "2026-05-31T23:59:59" }),
		makeMemo("first", { createdAt: "2026-06-01T00:00" }),
		makeMemo("morning", { createdAt: "2026-06-08T09:15" }),
		makeMemo("reference", { createdAt: "2026-06-09T09:00", contentSnapshot: "[[Daily#^source|custom alias]]" }),
		makeMemo("tagged", { createdAt: "2026-06-10T09:00", contentSnapshot: "#Work" }),
		makeMemo("child", { createdAt: "2026-06-10T10:00", contentSnapshot: "#work/project" }),
		makeMemo("image", { createdAt: "2026-06-11T09:00", contentSnapshot: "![[photo.png]]" }),
		makeMemo("pdf", { createdAt: "2026-06-11T09:00", contentSnapshot: "![[document.pdf]]" }),
		makeMemo("last", { createdAt: "2026-06-30T23:59:59" }),
		makeMemo("after", { createdAt: "2026-07-01T00:00" }),
	]);
	const range = { startDate: "2026-06-01", endDateExclusive: "2026-07-01" };
	const inRange = ["first", "morning", "reference", "tagged", "child", "image", "pdf", "last"];
	const cases: [RecordStatsSearchFilter, string[]][] = [
		[{ type: "day", date: "2026-06-08" }, ["morning"]],
		[{ type: "month", month: "2026-06" }, inRange],
		[{ type: "range", ...range }, inRange],
		[{ type: "hour", ...range, hour: 23 }, ["last"]],
		[{ type: "references", ...range }, ["reference"]],
		[{ type: "with-tag", ...range }, ["tagged", "child"]],
		[{ type: "no-tag", ...range }, ["first", "morning", "reference", "image", "pdf", "last"]],
		[{ type: "with-image", ...range }, ["image"]],
		[{ type: "tag", ...range, tagKey: "work", tagLabel: "Work" }, ["tagged", "child"]],
		[{ type: "max-daily-notes", dates: ["2026-06-08", "2026-06-09"] }, ["morning", "reference"]],
		[{ type: "max-daily-words", dates: ["2026-06-30"] }, ["last"]],
		[{ type: "max-daily-notes", dates: [] }, []],
	];
	for (const [filter, expected] of cases) {
		assert.deepEqual(filterCatalogMemos(memos, buildRecordStatsCatalogQuery(filter).query).map(item => item.id), expected, filter.type);
	}
	const today = new Date(2026, 5, 11);
	for (const [filter, expected] of [
		["no-tag", ["before", "first", "morning", "reference", "image", "pdf", "last", "after"]],
		["with-link", ["reference"]],
		["with-image", ["image"]],
	] satisfies [ScopeFilter, string[]][]) {
		assert.deepEqual(filterCatalogMemos(memos, sourceScope(filter, today)).map(item => item.id), expected, filter);
	}
});

test("卡片筛选消费 Catalog observation；旧记录和回收站不进入普通列表", async () => {
	const active = await makeMemo("active", { contentSnapshot: "Visit https://example.com" });
	const { catalog: _catalog, ...legacy } = active;
	const trash = { ...legacy, id: "trash", status: "deleted" as const };
	assert.deepEqual(filterCatalogMemos([legacy, trash, active], {}).map(item => item.id), ["active"]);
	assert.deepEqual(filterCatalogMemos([active], sourceScope("with-link", new Date())).map(item => item.id), ["active"]);
});

function sourceScope(scopeFilter: ScopeFilter, today: Date) {
	return buildSearchSourceScope({ activeTag: null, activeTagKey: null, recordStatsSearchFilter: null, scopeFilter }, today);
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

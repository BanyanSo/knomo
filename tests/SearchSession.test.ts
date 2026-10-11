import test from "node:test";
import assert from "node:assert/strict";
import { SearchSession, getSearchShortcutDate } from "../src/ui/SearchSession";
import { buildSearchSourceScope } from "../src/ui/SearchSourceScope";
import { getCatalogQueryKey, narrowCatalogQuery } from "../src/services/SearchMatching";

test("非法草稿与关闭不提交，结果保留自己的指纹", () => {
	const session = new SearchSession();
	session.updateDraft("2026 复盘"); session.submit();
	const filter = session.getFilter();
	session.commitResult(filter, 4, "complete");
	session.updateDraft("2026-");
	assert.equal(session.submit(), false);
	assert.equal(session.applied.input, "2026 复盘");
	assert.equal(session.result!.key, getCatalogQueryKey(filter));
	const version = session.version;
	session.close();
	assert.ok(session.version > version);
	assert.equal(session.draft.text, "2026-");
	assert.equal(session.applied.input, "2026 复盘");
});

test("B：快捷日期与手输互斥，按钮只删除日期原文，原生清空保留快捷日期", () => {
	const session = new SearchSession();
	session.toggleShortcut("week");
	session.updateDraft("项目 ２０２６１００９ 复盘"); session.submit();
	assert.equal(session.applied.shortcut, null);
	session.toggleShortcut("month");
	assert.equal(session.draft.text, "项目  复盘");
	assert.deepEqual(session.applied.terms, ["项目 复盘"]);
	assert.equal(session.applied.dateOrigin, "shortcut");
	session.updateDraft(""); session.submit();
	assert.equal(session.applied.shortcut, "month");
	session.toggleShortcut("month");
	assert.equal(session.applied.shortcut, null);
	session.updateDraft("2026 发布"); session.submit();
	session.updateDraft(""); session.submit();
	assert.equal(session.hasConditions, false);
	session.updateDraft("2026-");
	assert.equal(session.toggleShortcut("week"), false);
	session.beginComposition();
	assert.equal(session.submit(), false);
	assert.equal(session.toggleShortcut("month"), false);
	session.reset();
	assert.equal(session.draft.text, "");
	assert.equal(session.draft.composing, false);
});

test("来源与日期取交集且不丢失日期集合、小时和回顾口径", () => {
	const today = new Date(2026, 9, 9);
	const base = { activeNav: "things" as const, activeTag: "工作", activeTagKey: "工作", scopeFilter: "with-image" as const,
		recordStatsSearchFilter: { type: "hour" as const, startDate: "2026-10-01", endDateExclusive: "2026-11-01", hour: 9 } };
	const scope = buildSearchSourceScope(base, today);
	const session = new SearchSession();
	session.updateDraft("202611 发布"); session.submit();
	const filter = session.getFilter(scope, today);
	assert.equal(filter.hasTask, true);
	assert.equal(filter.hasImage, true);
	assert.equal(filter.hour, 9);
	assert.deepEqual(filter.tags, ["工作"]);
	assert.equal(filter.matchNone, true);
	assert.equal(narrowCatalogQuery({ logicalDates: ["2026-10-02", "2026-11-02"], searchDate: { kind: "range", granularity: "month", fromDate: "2026-10-01", toDate: "2026-10-31" } }).logicalDates?.join(), "2026-10-02");
	const review = buildSearchSourceScope({ ...base, activeNav: "review", activeTag: null, activeTagKey: null, scopeFilter: "all", recordStatsSearchFilter: null }, today);
	assert.equal(review.dayOfMonth, "09");
	assert.equal(review.toDate, "2026-10-08");
	const leap = buildSearchSourceScope({ ...base, activeNav: "review", activeTag: null, activeTagKey: null, scopeFilter: "all", recordStatsSearchFilter: null }, new Date(2024, 1, 29));
	assert.equal(leap.monthDay, "02-29");
	assert.equal(leap.dayOfMonth, undefined);
	const anniversary = buildSearchSourceScope({ ...base, activeNav: "all", activeTag: null, activeTagKey: null, scopeFilter: "anniversary", recordStatsSearchFilter: null }, today);
	assert.equal(anniversary.excludeDate, "2026-10-09");
	assert.equal(anniversary.toDate, undefined);
});

test("相对日期按本地日刷新，固定日期不漂移", () => {
	assert.deepEqual(getSearchShortcutDate("last-7", new Date(2026, 9, 9)), { kind: "range", granularity: "day", fromDate: "2026-10-03", toDate: "2026-10-09" });
	assert.equal(getSearchShortcutDate("week", new Date(2026, 9, 11)).kind, "range");
	const session = new SearchSession();
	session.toggleShortcut("last-7");
	assert.notEqual(getCatalogQueryKey(session.getFilter({}, new Date(2026, 9, 9))), getCatalogQueryKey(session.getFilter({}, new Date(2026, 9, 10))));
	session.updateDraft("20261009"); session.submit();
	assert.equal(getCatalogQueryKey(session.getFilter({}, new Date(2026, 9, 9))), getCatalogQueryKey(session.getFilter({}, new Date(2026, 9, 10))));
});

test("最终查询指纹消除日期入口差异与 AND 词顺序，日历空交集可先行证明", () => {
	const from = "2026-10-01", to = "2026-10-31";
	assert.equal(getCatalogQueryKey({ textTerms: ["Ｂeta", "alpha", "alpha"], searchDate: { kind: "range", granularity: "month", fromDate: from, toDate: to } }),
		getCatalogQueryKey({ textTerms: ["alpha", "beta"], fromDate: from, toDate: to }));
	assert.equal(narrowCatalogQuery({ dayOfMonth: "31", fromDate: "2026-02-01", toDate: "2026-02-28" }).matchNone, true);
	assert.equal(narrowCatalogQuery({ monthDay: "02-29", fromDate: "2025-01-01", toDate: "2025-12-31" }).matchNone, true);
	assert.equal(narrowCatalogQuery({ monthDay: "02-29", fromDate: "2024-01-01", toDate: "2024-12-31" }).matchNone, undefined);
	assert.equal(narrowCatalogQuery({ tags: ["work"], hasTag: false }).matchNone, true);
});

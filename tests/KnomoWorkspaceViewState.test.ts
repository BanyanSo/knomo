import test from "node:test";
import assert from "node:assert/strict";
import {
	parseKnomoWorkspaceViewState,
	sanitizeWorkspaceRecordStatsFilter,
	sanitizeWorkspaceSearchState,
} from "../src/ui/KnomoWorkspaceViewState";

const now = new Date(2026, 9, 17);
const range = { startDate: "2024-01-01", endDateExclusive: "2025-01-01" };

function validState() {
	return { version: 1, navigation: { activeNav: "things", scopeFilter: "with-image", activeTag: "Work/Project", activeTagKey: "#Work/Project",
		search: { input: "20261009 项目", shortcut: "week" }, recordStatsSearchFilter: { type: "hour", ...range, hour: 23 } },
		recordStats: { view: "month", selectedDate: "2024-02-29" }, recordStatsReturn: null,
		mobileSearch: { input: "mobile only", shortcut: "last-month", recordStatsSearchFilter: { type: "day", date: "2026-10-10" } } };
}

test("Workspace 未知版本和无效根状态整体恢复默认，不吸收旧字段", () => {
	const expected = parseKnomoWorkspaceViewState(undefined, { now });
	assert.deepEqual(expected, { version: 1,
		navigation: { activeNav: "all", scopeFilter: "all", activeTag: null, activeTagKey: null, search: { input: "", shortcut: null }, recordStatsSearchFilter: null },
		recordStats: { view: "week", selectedDate: "2026-10-17" }, recordStatsReturn: null,
		mobileSearch: { input: "", shortcut: null, recordStatsSearchFilter: null } });
	for (const value of [null, [], "raw", 42, { ...validState(), version: 0 }, { ...validState(), version: 2 }, { ...validState(), version: "1" }]) {
		assert.deepEqual(parseKnomoWorkspaceViewState(value, { now }), expected);
	}
});

test("Workspace 白名单保留主与移动已提交条件、真实日期和标签，不透传临时对象", () => {
	const raw = { ...validState(), menu: true, drawer: true, composer: { draft: "private" }, observationHandle: { rawBlockHash: "old" }, cursor: "old" };
	Object.assign(raw.navigation.search, { terms: ["forged"], date: { kind: "range", fromDate: "2000-01-01" }, draft: "unsubmitted", result: "old" });
	const state = parseKnomoWorkspaceViewState(raw, { now });
	assert.deepEqual(Object.keys(state), ["version", "navigation", "recordStats", "recordStatsReturn", "mobileSearch"]);
	assert.deepEqual(Object.keys(state.navigation.search), ["input", "shortcut"]);
	assert.deepEqual(state.navigation.search, { input: "20261009 项目", shortcut: null }, "输入日期优先于不一致的旧 shortcut");
	assert.deepEqual(state.mobileSearch, { input: "mobile only", shortcut: "last-month", recordStatsSearchFilter: { type: "day", date: "2026-10-10" } });
	assert.equal(state.navigation.activeTag, "Work/Project");
	assert.equal(state.navigation.activeTagKey, "work/project");
	assert.deepEqual(state.recordStats, { view: "month", selectedDate: "2024-02-29" });
	assert.deepEqual(state.navigation.recordStatsSearchFilter, { type: "hour", ...range, hour: 23 });
	assert.deepEqual(parseKnomoWorkspaceViewState(JSON.parse(JSON.stringify(state)), { now }), state);
});

test("无效导航和禁用浮标回全部；合法 tag 不依赖未就绪的 facet 而被清空", () => {
	for (const activeNav of ["ai", "wechat", "unknown", 1]) {
		assert.equal(parseKnomoWorkspaceViewState({ ...validState(), navigation: { ...validState().navigation, activeNav } }, { now }).navigation.activeNav, "all");
	}
	const buoy = { ...validState(), navigation: { ...validState().navigation, activeNav: "time-buoy" } };
	const fallback = parseKnomoWorkspaceViewState(buoy, { now, timeBuoyEnabled: false });
	assert.deepEqual(fallback.navigation, parseKnomoWorkspaceViewState(undefined, { now }).navigation);
	assert.equal(parseKnomoWorkspaceViewState(buoy, { now, timeBuoyEnabled: true }).navigation.activeNav, "time-buoy");
	const partial = parseKnomoWorkspaceViewState({ ...validState(), navigation: { ...validState().navigation, scopeFilter: "bad",
		activeTag: "Missing/Tag", activeTagKey: "missing/tag" }, facets: [], coverage: "partial" }, { now });
	assert.equal(partial.navigation.scopeFilter, "all");
	assert.equal(partial.navigation.activeTagKey, "missing/tag");
	assert.equal(partial.navigation.activeTag, "Missing/Tag");
	for (const activeTagKey of ["", "#", "white space", null, 1]) {
		const state = parseKnomoWorkspaceViewState({ ...validState(), navigation: { ...validState().navigation, activeTagKey } }, { now });
		assert.equal(state.navigation.activeTag, null);
		assert.equal(state.navigation.activeTagKey, null);
	}
});

test("专用导航清除遗留列表组合，Things 保留 tag/已提交搜索并转换旧日期 scope", () => {
	for (const activeNav of ["random", "shuffleDay", "time-buoy", "record-stats", "trash"]) {
		const navigation = parseKnomoWorkspaceViewState({ ...validState(), navigation: { ...validState().navigation, activeNav } }, { now }).navigation;
		assert.deepEqual(navigation, { activeNav, scopeFilter: "all", activeTag: null, activeTagKey: null,
			search: { input: "", shortcut: null }, recordStatsSearchFilter: null });
	}
	const things = parseKnomoWorkspaceViewState({ ...validState(), navigation: { ...validState().navigation, scopeFilter: "last-30",
		search: { input: "release", shortcut: null } } }, { now }).navigation;
	assert.equal(things.scopeFilter, "all");
	assert.equal(things.activeTagKey, "work/project");
	assert.deepEqual(things.search, { input: "release", shortcut: "last-30" });
	const explicitDate = parseKnomoWorkspaceViewState({ ...validState(), navigation: { ...validState().navigation, scopeFilter: "last-30" } }, { now }).navigation;
	assert.deepEqual(explicitDate.search, { input: "20261009 项目", shortcut: null });
});

test("Workspace tag 长度上限只限制弱状态恢复，合法边界与 label 按 key 规范化", () => {
	const navigation = { ...validState().navigation, activeNav: "all", activeTag: "x".repeat(1024), activeTagKey: "x".repeat(1024) };
	assert.equal(parseKnomoWorkspaceViewState({ ...validState(), navigation }, { now }).navigation.activeTagKey?.length, 1024);
	const tooLong = parseKnomoWorkspaceViewState({ ...validState(), navigation: { ...navigation, activeTagKey: "x".repeat(1025) } }, { now }).navigation;
	assert.equal(tooLong.activeTagKey, null);
	assert.equal(tooLong.activeTag, null);
	const mismatchedLabel = parseKnomoWorkspaceViewState({ ...validState(), navigation: { ...navigation, activeTagKey: "project", activeTag: "Different" } }, { now });
	assert.equal(mismatchedLabel.navigation.activeTag, "project");
});

test("搜索从当前 parser 恢复，非法或未完成日期不提交，Workspace 文本有界且不截断", () => {
	for (const input of ["20260230", "2025-02-29", "2026-", "20261009~", "20261010~20261009", '"20261009']) {
		assert.deepEqual(sanitizeWorkspaceSearchState({ input, shortcut: "week", terms: ["forged"] }), { input: "", shortcut: null });
	}
	assert.deepEqual(sanitizeWorkspaceSearchState({ input: "项目 复盘", shortcut: "month" }), { input: "项目 复盘", shortcut: "month" });
	assert.deepEqual(sanitizeWorkspaceSearchState({ input: '"20261009"', shortcut: "month" }), { input: '"20261009"', shortcut: "month" });
	assert.equal(sanitizeWorkspaceSearchState({ input: "x".repeat(4096) }).input.length, 4096);
	assert.equal(sanitizeWorkspaceSearchState({ input: "x".repeat(4097) }).input, "");
});

test("Stats 白名单覆盖全部当前 filter，日期、范围、小时和 tag 逐项校验", () => {
	const values = [
		{ type: "day", date: "2024-02-29" }, { type: "month", month: "2024-02" },
		...["range", "with-tag", "no-tag", "with-image", "references"].map(type => ({ type, ...range })),
		{ type: "hour", ...range, hour: 0 }, { type: "hour", ...range, hour: 23 },
		{ type: "tag", ...range, tagKey: "work", tagLabel: "Work" },
		{ type: "max-daily-notes", dates: ["2024-02-29", "2024-12-31"] }, { type: "max-daily-words", dates: ["2024-02-29"] },
	];
	for (const value of values) assert.deepEqual(sanitizeWorkspaceRecordStatsFilter({ ...value, cursor: "ignored", observationHandle: "ignored" }), value);
	const invalid = [
		{ type: "unknown", ...range }, { type: "day", date: "2025-02-29" }, { type: "day", date: "2024-02-30" },
		{ type: "month", month: "2024-13" }, { type: "month", month: "2024-2" },
		{ type: "range", startDate: "2024-02-29", endDateExclusive: "2024-02-29" },
		{ type: "range", startDate: "2024-03-01", endDateExclusive: "2024-02-29" },
		{ type: "range", startDate: "2024-02-30", endDateExclusive: "2024-03-01" },
		...[24, -1, 1.5, "12"].map(hour => ({ type: "hour", ...range, hour })),
		{ type: "tag", ...range, tagKey: "", tagLabel: "Empty" },
		{ type: "max-daily-notes", dates: [] }, { type: "max-daily-notes", dates: ["2025-02-29"] },
		{ type: "max-daily-notes", dates: [1] },
		{ type: "max-daily-notes", dates: Array(367).fill("2024-01-01") },
	];
	for (const value of invalid) assert.equal(sanitizeWorkspaceRecordStatsFilter(value), null);
	const leapYear = Array.from({ length: 366 }, (_, index) => new Date(Date.UTC(2024, 0, index + 1)).toISOString().slice(0, 10));
	assert.deepEqual(sanitizeWorkspaceRecordStatsFilter({ type: "max-daily-notes", dates: leapYear }), { type: "max-daily-notes", dates: leapYear });
	const invalidStats = parseKnomoWorkspaceViewState({ ...validState(), recordStats: { view: "day", selectedDate: "2025-02-29" } }, { now });
	assert.deepEqual(invalidStats.recordStats, { view: "week", selectedDate: "2026-10-17" });
});

test("Stats 只保存一层返回状态，多个 leaf 与输入对象深拷贝隔离", () => {
	const raw = { ...validState(), navigation: { ...validState().navigation, activeNav: "record-stats" },
		recordStatsReturn: { ...validState().navigation, recordStatsSearchFilter: { type: "max-daily-notes", dates: ["2024-02-29"] }, nestedReturn: "ignored" } };
	const first = parseKnomoWorkspaceViewState(raw, { now }), second = parseKnomoWorkspaceViewState(raw, { now });
	assert.equal(first.recordStatsReturn?.activeNav, "things");
	const filter = first.recordStatsReturn!.recordStatsSearchFilter!;
	assert.equal(filter.type, "max-daily-notes");
	if (filter.type === "max-daily-notes") filter.dates[0] = "2000-01-01";
	assert.deepEqual(second.recordStatsReturn?.recordStatsSearchFilter, { type: "max-daily-notes", dates: ["2024-02-29"] });
	assert.deepEqual(raw.recordStatsReturn.recordStatsSearchFilter.dates, ["2024-02-29"]);
	assert.equal(parseKnomoWorkspaceViewState({ ...raw, recordStatsReturn: { ...raw.recordStatsReturn, activeNav: "record-stats" } }, { now }).recordStatsReturn, null);
	assert.equal(parseKnomoWorkspaceViewState({ ...raw, navigation: { ...raw.navigation, activeNav: "all" } }, { now }).recordStatsReturn, null);
});

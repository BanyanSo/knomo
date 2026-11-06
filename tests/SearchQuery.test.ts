import test from "node:test";
import assert from "node:assert/strict";
import { parseSearchInput } from "../src/services/SearchQuery";
import { getCatalogQueryKey } from "../src/services/SearchMatching";
import { normalizeSearchText } from "../src/utils/searchText";

for (const [input, fromDate, toDate] of [
	["20261009", "2026-10-09", "2026-10-09"], ["2026-10-09", "2026-10-09", "2026-10-09"],
	["202610", "2026-10-01", "2026-10-31"], ["2026-10", "2026-10-01", "2026-10-31"],
	["2026", "2026-01-01", "2026-12-31"], ["２０２６－１０－０９", "2026-10-09", "2026-10-09"],
	["20261001~20261009", "2026-10-01", "2026-10-09"], ["2026-10-01 至 20261009", "2026-10-01", "2026-10-09"],
	["202601 ～ 202603", "2026-01-01", "2026-03-31"], ["2024~2026", "2024-01-01", "2026-12-31"],
	["2024-02~2024-02", "2024-02-01", "2024-02-29"], ["1899-01-01~1899-12-31", "1899-01-01", "1899-12-31"],
] as const) test("日期契约：" + input, () => {
	const parsed = parseSearchInput(input);
	assert.equal(parsed.status, "valid");
	assert.equal(parsed.date?.kind, "range");
	if (parsed.date?.kind === "range") assert.deepEqual([parsed.date.fromDate, parsed.date.toDate], [fromDate, toDate]);
	assert.deepEqual(parsed.terms, []);
});

for (const [input, from, to] of [["1009", "10-09", "10-09"], ["10-09", "10-09", "10-09"],
	["0229", "02-29", "02-29"], ["1220~0110", "12-20", "01-10"], ["1001~10-09", "10-01", "10-09"]] as const) {
	test("跨年月日：" + input, () => assert.deepEqual(parseSearchInput(input).date, { kind: "month-day", fromMonthDay: from, toMonthDay: to }));
}

for (const input of ["1232", "0230", "0000", "1899", "2100", "123", "20261", "1234567", "项目2026", "build-20261009", "123-456", "20261009,复盘", "项目~复盘", "甲至乙"]) {
	test("保守编号和普通文字：" + input, () => {
		assert.deepEqual(parseSearchInput(input).terms, [input.toLowerCase()]);
		assert.equal(parseSearchInput(input).date, null);
	});
}
for (const input of ["1900", "2099"]) test("固定年份窗口：" + input, () => assert.equal(parseSearchInput(input).date?.kind, "range"));
for (const input of [
	"2026-", "2026-10-", "20261001~", "20261001 ~", "~20261009", "2026-13", "202613", "20260229", "20260230", "02-30",
	"2026-10-99", "2026~202610", "1009~20261012", "20261009~20261001", "2026 1009", "2026 2027",
	"1232~2026", "20261009~项目", "2026~~2027", '"2026', '“2026',
	"项目 2026-13 后续", "20261009 项目 2026-13 后续", "2026-13 项目 20261009", '"2026" 20261009 2026-',
	'  Ａ  项目　２０２６１００９　２０２６－１３  “2026” ',
]) test("解析失败整条回退为连续文字：" + input, () => {
	assert.deepEqual(parseSearchInput(input), {
		status: "valid", terms: [normalizeSearchText(input)], date: null, dateRange: null,
	});
});

test("空白输入仍为空条件", () => {
	for (const input of ["", " \t\n　"]) assert.deepEqual(parseSearchInput(input), { status: "empty", terms: [], date: null, dateRange: null });
});

test("日期转义与 NFKC 保留原始删除区间", () => {
	for (const input of ['"2026"', '“1009”', '"2026-10-09"', '“2024 ~ 2026”', '＂２０２６＂']) {
		assert.equal(parseSearchInput(input).date, null);
		assert.deepEqual(parseSearchInput(input).terms, [input.slice(1, -1).normalize("NFKC")]);
	}
	for (const input of ['"未闭合', '项目"复盘"', "”", "“错配\""]) assert.deepEqual(parseSearchInput(input).terms, [input.toLowerCase()]);
	const input = 'ﬃ项 ２０２６１００９ "Ａ  B"';
	const parsed = parseSearchInput(input);
	assert.equal(input.slice(parsed.dateRange!.from, parsed.dateRange!.to), "２０２６１００９");
	assert.deepEqual(parsed.terms, ['ffi项 "a b"']);
	assert.equal(getCatalogQueryKey({ searchDate: parseSearchInput("20261009").date! }),
		getCatalogQueryKey({ searchDate: parseSearchInput("２０２６－１０－０９").date! }));
});

test("恢复连续文字：空格不再拆成默认 AND，日期之外的引号属于文字", () => {
 assert.deepEqual(parseSearchInput("项目 复盘").terms, ["项目 复盘"]);
 assert.deepEqual(parseSearchInput("项目 20261009 复盘").terms, ["项目 复盘"]);
 assert.deepEqual(parseSearchInput('项目"复盘"').terms, ['项目"复盘"']);
 assert.deepEqual(parseSearchInput('"2026" 项目').terms, ["2026 项目"]);
});

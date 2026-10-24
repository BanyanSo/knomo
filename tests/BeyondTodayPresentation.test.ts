import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import type { MemoViewItem } from "../src/types/memoView";
import { BeyondTodayDecorations, createBeyondTodayContext, getBeyondTodayGroup } from "../src/ui/BeyondTodayPresentation";
import { ensureObsidianStub } from "./helpers/obsidianStub";

function memo(date: string): MemoViewItem {
	return { createdAt: "2099-01-01T12:34", catalog: { observation: { logicalDate: date } } } as MemoViewItem;
}

// 每行按一月至当前月前两个月列出预期，单独固定产品月份矩阵。
const currentYearPeriods = [
	[], [], ["firstQuarter"], ["firstQuarter", "firstQuarter"],
	["firstQuarter", "firstQuarter", "firstQuarter"],
	["firstQuarter", "firstQuarter", "firstQuarter", "secondQuarter"],
	["firstQuarter", "firstQuarter", "firstQuarter", "secondQuarter", "secondQuarter"],
	["firstHalf", "firstHalf", "firstHalf", "firstHalf", "firstHalf", "firstHalf"],
	["firstHalf", "firstHalf", "firstHalf", "firstHalf", "firstHalf", "firstHalf", "secondHalf"],
	["firstHalf", "firstHalf", "firstHalf", "firstHalf", "firstHalf", "firstHalf", "secondHalf", "secondHalf"],
	["firstHalf", "firstHalf", "firstHalf", "firstHalf", "firstHalf", "firstHalf", "secondHalf", "secondHalf", "secondHalf"],
	["firstHalf", "firstHalf", "firstHalf", "firstHalf", "firstHalf", "firstHalf", "secondHalf", "secondHalf", "secondHalf", "secondHalf"],
];

for (let month = 1; month <= 12; month++) {
	test(`今日之外 ${month} 月按自然季度或半年分组，上个月优先无标题`, () => {
		const context = createBeyondTodayContext(new Date(2026, month - 1, 21, 23, 59));
		const periods = currentYearPeriods[month - 1];
		assert.deepEqual(Array.from({ length: Math.max(0, month - 2) }, (_, index) =>
			getBeyondTodayGroup(memo(`2026-${String(index + 1).padStart(2, "0")}-21`), context)?.period), periods);
		assert.equal(getBeyondTodayGroup(memo(`${context.previousMonth}-21`), context), null);
		for (const year of [2025, 2024, 2000, 1900, 1]) {
			for (const historicalMonth of [1, 6, 7, 11, 12]) {
				const date = `${String(year).padStart(4, "0")}-${String(historicalMonth).padStart(2, "0")}-21`;
				const group = getBeyondTodayGroup(memo(date), context);
				if (date.slice(0, 7) === context.previousMonth) assert.equal(group, null);
				else assert.deepEqual(group, { year: date.slice(0, 4), key: `${date.slice(0, 4)}:${historicalMonth <= 6 ? "firstHalf" : "secondHalf"}`, period: historicalMonth <= 6 ? "firstHalf" : "secondHalf" });
			}
		}
	});
}

test("跨年与稀疏历史仅在实际有记录的分组首次出现标题", () => {
	const state = new BeyondTodayDecorations(createBeyondTodayContext(new Date(2027, 0, 21)));
	assert.deepEqual(["2026-12-21", "2026-11-21", "2026-07-21", "2026-06-21", "2024-04-21"].map(date => state.next(memo(date))?.key ?? null),
		[null, "2026:secondHalf", null, "2026:firstHalf", "2024:firstHalf"]);
	const onlyPrevious = new BeyondTodayDecorations(createBeyondTodayContext(new Date(2026, 6, 31)));
	assert.deepEqual(["2026-06-30", "2026-06-28"].map(date => onlyPrevious.next(memo(date))), [null, null]);
	const historicalFirst = new BeyondTodayDecorations(createBeyondTodayContext(new Date(2026, 6, 31)));
	assert.equal(historicalFirst.next(memo("2026-04-30"))?.key, "2026:secondQuarter");
});

test("无效日期不臆造分组且不打断正常边界，只采用 Daily logicalDate", () => {
	const context = createBeyondTodayContext(new Date(2026, 9, 31));
	const state = new BeyondTodayDecorations(context);
	assert.equal(state.next(memo("2026-08-31"))?.key, "2026:secondHalf");
	for (const date of ["", "unknown", "2026-02-29", "2026-04-31", "0000-01-01", "2026-13-01", "2026-10-01", "2027-01-01"]) {
		assert.equal(state.next(memo(date)), null, date);
	}
	assert.equal(state.next({ createdAt: "2026-01-21" } as MemoViewItem), null);
	assert.equal(state.next(memo("2026-07-31")), null);
	assert.equal(state.next(memo("2024-02-29"))?.key, "2024:firstHalf");
	assert.equal(new BeyondTodayDecorations(null).next(memo("2024-02-29")), null);
});

test("分组快照不随外部日期对象变化", () => {
	const date = new Date(2026, 6, 31, 23, 59, 59);
	const july = createBeyondTodayContext(date);
	date.setMonth(7, 1);
	assert.equal(july.today, "2026-07-31");
	assert.equal(getBeyondTodayGroup(memo("2026-04-30"), july)?.period, "secondQuarter");
	assert.equal(getBeyondTodayGroup(memo("2026-04-30"), createBeyondTodayContext(date))?.period, "firstHalf");
});

test("非 UTC 时区在本地月界切换，夏令时跳时与重复小时不改变日历分组", () => {
	for (const [zone, instants, expected] of [
		["America/New_York", ["2026-08-01T03:30:00Z", "2026-08-01T04:30:00Z", "2026-03-08T06:30:00Z", "2026-03-08T07:30:00Z", "2026-11-01T05:30:00Z", "2026-11-01T06:30:00Z"],
			[["2026-07-31", "2026-06"], ["2026-08-01", "2026-07"], ["2026-03-08", "2026-02"], ["2026-03-08", "2026-02"], ["2026-11-01", "2026-10"], ["2026-11-01", "2026-10"]]],
		["Pacific/Kiritimati", ["2026-07-31T09:30:00Z", "2026-07-31T10:30:00Z"], [["2026-07-31", "2026-06"], ["2026-08-01", "2026-07"]]],
	] as const) {
		const result = spawnSync(process.execPath, ["-e", [
			"const { createBeyondTodayContext } = require(process.argv[1]);",
			"const contexts = JSON.parse(process.argv[2]).map(value => createBeyondTodayContext(new Date(value)));",
			"process.stdout.write(JSON.stringify(contexts.map(context => [context.today, context.previousMonth])));",
		].join("\n"), require.resolve("../src/ui/BeyondTodayPresentation"), JSON.stringify(instants)], { env: { ...process.env, TZ: zone }, encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(JSON.parse(result.stdout), expected, zone);
	}
});

test("季度与半年标题通过现有 i18n 生成中英文文案", async () => {
	await ensureObsidianStub();
	const { translate } = await import("../src/i18n");
	for (const [period, zh, en] of [
		["firstQuarter", "2026·第一季", "2026 · First Quarter"],
		["secondQuarter", "2026·第二季", "2026 · Second Quarter"],
		["firstHalf", "2026·前半程", "2026 · First Half"],
		["secondHalf", "2026·后半程", "2026 · Second Half"],
	] as const) {
		assert.equal(translate("zh-CN", `beyondToday.${period}`, { year: 2026 }), zh);
		assert.equal(translate("en", `beyondToday.${period}`, { year: 2026 }), en);
	}
});

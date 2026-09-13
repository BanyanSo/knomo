import assert from "node:assert/strict";
import test from "node:test";
import type { MemoViewItem } from "../src/types/memoView";
import { createRecentTimeFlowContext, formatRecentCalendarDate, getRecentMemoPresentation, RecentTimeFlowDecorations } from "../src/ui/RecentTimeFlowPresentation";

test("日期与星期按中英文自然词序呈现", () => {
	assert.equal(formatRecentCalendarDate("2026-09-11", "zh-CN"), "9月11日 周五");
	assert.equal(formatRecentCalendarDate("2026-09-11", "en"), "Fri, Sep 11");
	assert.equal(formatRecentCalendarDate("2024-02-29", "zh-CN"), "2月29日 周四");
});

function memo(id: string, date: string, time = "12:34:56"): MemoViewItem {
	return { id, catalog: { renderKey: id, observation: { logicalDate: date, time } } } as MemoViewItem;
}

test("近三天按本地日历跨年闰日，24 小时图标不换算墙上时间", () => {
	assert.deepEqual(createRecentTimeFlowContext(new Date(2026, 0, 1), true, new Set()).dates, ["2026-01-01", "2025-12-31", "2025-12-30"]);
	const context = createRecentTimeFlowContext(new Date(2024, 2, 1), true, new Set());
	assert.deepEqual(context.dates, ["2024-03-01", "2024-02-29", "2024-02-28"]);
	for (let hour = 0; hour < 24; hour++) {
		for (const suffix of ["", ":59"]) {
			const time = `${String(hour).padStart(2, "0")}:23`;
			assert.deepEqual(getRecentMemoPresentation(memo("a", context.dates[0], time + suffix), context).time,
				{ mode: "recent", time, icon: `knomo-clock-${hour % 12}` });
		}
	}
	assert.equal(getRecentMemoPresentation(memo("a", context.dates[0], "invalid"), context).time.mode, "full");
});

test("实际前缀推导仅一次 Header 和历史分界，浮标未来空日期不触发", () => {
	const context = createRecentTimeFlowContext(new Date(2026, 8, 10), true, new Set(["pin"]));
	const items = [memo("pin", "2020-01-01"), memo("future", "2027-01-01"), memo("a", "2026-09-10"), memo("b", "2026-09-10"), memo("c", "2026-09-07"), memo("d", "2026-09-06")];
	const state = new RecentTimeFlowDecorations(context);
	assert.deepEqual(items.map((item) => state.next(item)), [null, null, { kind: "date", date: "2026-09-10", day: 0 }, null, { kind: "history" }, null]);
	assert.equal(items.length, 6);
	assert.equal(getRecentMemoPresentation(memo("pin", "2026-09-10"), context).time.mode, "full");
	assert.equal(getRecentMemoPresentation(memo("empty", ""), context).history, false);
	const onlyHistory = new RecentTimeFlowDecorations(context);
	assert.equal(onlyHistory.next(items[0]), null);
	assert.equal(onlyHistory.next(items[4]), null);
	const disabled = new RecentTimeFlowDecorations({ ...context, enabled: false });
	assert.deepEqual(items.map((item) => disabled.next(item)), items.map(() => null));
});

import test from "node:test";
import assert from "node:assert/strict";

import {
	addTimeBuoyCalendarDays,
	formatTimeBuoyDate,
	getTimeBuoyCardStatus,
	getTimeBuoyDateStatus,
	isValidTimeBuoyDate,
} from "../src/utils/timeBuoyDate";

test("validates real Gregorian date keys", () => {
	assert.equal(isValidTimeBuoyDate("2024-02-29"), true);
	assert.equal(isValidTimeBuoyDate("2026-02-29"), false);
	assert.equal(isValidTimeBuoyDate("2026-02-30"), false);
	assert.equal(isValidTimeBuoyDate("2026-13-01"), false);
	assert.equal(isValidTimeBuoyDate("2026-7-01"), false);
	assert.equal(isValidTimeBuoyDate("0000-01-01"), false);
});

test("uses local calendar dates without UTC conversion", () => {
	const today = new Date(2026, 6, 20, 23, 30);
	assert.equal(formatTimeBuoyDate(today), "2026-07-20");
	assert.equal(getTimeBuoyDateStatus("2026-07-20", today), "today");
	assert.equal(getTimeBuoyDateStatus("2026-07-21", today), "upcoming");
	assert.equal(getTimeBuoyDateStatus("2026-07-19", today), "past");
});

test("日期格式化保留四位年份补零", () => {
	const date = new Date(0);
	date.setHours(12, 0, 0, 0);
	date.setFullYear(5, 0, 2);
	assert.equal(formatTimeBuoyDate(date), "0005-01-02");
});

test("prioritizes today, then upcoming, for multi-date card states", () => {
	const today = new Date(2026, 6, 20, 23, 30);
	assert.equal(getTimeBuoyCardStatus(["2026-07-18", "2026-07-19"], today), "past");
	assert.equal(getTimeBuoyCardStatus(["2026-07-18", "2026-07-22"], today), "upcoming");
	assert.equal(getTimeBuoyCardStatus(["2026-07-22", "2026-07-20"], today), "today");
	assert.equal(getTimeBuoyCardStatus(["invalid"], today), null);
});

test("adds natural local calendar days", () => {
	assert.equal(formatTimeBuoyDate(addTimeBuoyCalendarDays(new Date(2026, 0, 31, 18), 1)), "2026-02-01");
	assert.equal(formatTimeBuoyDate(addTimeBuoyCalendarDays(new Date(2024, 1, 28, 18), 1)), "2024-02-29");
});

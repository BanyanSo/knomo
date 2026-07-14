import test from "node:test";
import assert from "node:assert/strict";

import {
	extractTimeBuoyDates,
	getTimeBuoyRevision,
	isTimeBuoyTriggerAt,
	parseTimeBuoyMatches,
} from "../src/utils/timeBuoyParser";

test("revision changes only when the normalized buoy date set changes", () => {
	assert.equal(
		getTimeBuoyRevision("- [ ] 回看 @2026-07-20 @2026-08-15"),
		getTimeBuoyRevision("- [x] 正文变化 @2026-08-15 @2026-07-20 @2026-07-20"),
	);
	assert.notEqual(
		getTimeBuoyRevision("回看 @2026-07-20"),
		getTimeBuoyRevision("回看 @2026-07-21"),
	);
});

test("parses half-width and full-width date tokens and dedupes dates", () => {
	assert.deepEqual(
		extractTimeBuoyDates("回看 @2026-07-20，再看 ＠2026-08-15，重复 @2026-07-20"),
		["2026-07-20", "2026-08-15"],
	);
});

test("parses complete date tokens adjacent to plain text", () => {
	assert.deepEqual(
		extractTimeBuoyDates("回看@2026-07-20 review@2026-08-15"),
		["2026-07-20", "2026-08-15"],
	);
});

test("rejects invalid formats, dates, escapes, and token boundaries", () => {
	const content = [
		"@2026/07/20 @2026-7-20 @20260220 @2026-02-30",
		"user@2026-07-20.com release-@2026-07-21-beta @2026-07-22extra",
		"\\@2026-07-23 \\＠2026-07-24",
		"有效（@2026-07-25）。",
	].join("\n");
	assert.deepEqual(extractTimeBuoyDates(content), ["2026-07-25"]);
});

test("excludes protected Markdown regions", () => {
	const content = [
		"普通 @2026-07-20",
		"`inline @2026-07-21`",
		"```ts",
		"const date = '@2026-07-22';",
		"```",
		"[label @2026-07-23](target-@2026-07-24)",
		"![image @2026-07-25](image-@2026-07-26.png)",
		"[[Note @2026-07-27]] ![[Embed @2026-07-28]]",
		"<!-- @2026-07-29 --> <span data-date=\"@2026-07-30\">",
		"> quote @2026-07-31",
		"结束 @2026-08-01",
	].join("\n");
	assert.deepEqual(extractTimeBuoyDates(content), ["2026-07-20", "2026-08-01"]);
});

test("excludes multiline comments, paths, URLs, email, and filenames", () => {
	const content = [
		"<!-- start @2026-07-20",
		"still hidden @2026-07-21 --> visible @2026-07-22",
		"https://example.com/@2026-07-23",
		"/tmp/(@2026-07-24).md",
		"memo-@2026-07-25.md",
		"mail user@2026-07-26.com",
	].join("\n");
	assert.deepEqual(extractTimeBuoyDates(content), ["2026-07-22"]);
});

test("reports source ranges without rewriting full-width markers", () => {
	const content = "A ＠2026-07-20 B";
	assert.deepEqual(parseTimeBuoyMatches(content), [{
		targetDate: "2026-07-20",
		start: 2,
		end: 13,
	}]);
});

test("detects direct at-sign trigger only at a legal unprotected token start", () => {
	assert.equal(isTimeBuoyTriggerAt("回看 @", 3), true);
	assert.equal(isTimeBuoyTriggerAt("回看 ＠", 3), true);
	assert.equal(isTimeBuoyTriggerAt("回看@", 2), false);
	assert.equal(isTimeBuoyTriggerAt("user@", 4), false);
	assert.equal(isTimeBuoyTriggerAt("\\@", 1), false);
	assert.equal(isTimeBuoyTriggerAt("`@`", 1), false);
	assert.equal(isTimeBuoyTriggerAt("> @", 2), false);
	assert.equal(isTimeBuoyTriggerAt("https://example.com/@", 20), false);
});

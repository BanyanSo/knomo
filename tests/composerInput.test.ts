import test from "node:test";
import assert from "node:assert/strict";

import { applyListFormatToText, getHashInsertionText, getListEnterPatch, getTagQueryAtCursor, replaceTagQueryWithSuggestion } from "../src/utils/composerInput";
import { parseMemoTags } from "../src/utils/markdown";

test("inserts a spaced hash after existing content", () => {
	assert.equal(getHashInsertionText("今天记录", 4), " #");
});

test("keeps hash at the start of text and after whitespace", () => {
	assert.equal(getHashInsertionText("", 0), "#");
	assert.equal(getHashInsertionText("今天记录 ", 5), "#");
	assert.equal(getHashInsertionText("第一行\n", 4), "#");
});

test("detects tag query around the cursor", () => {
	assert.deepEqual(getTagQueryAtCursor("今天 #pro", 7), {
		from: 3,
		to: 7,
		query: "pro",
	});
	assert.deepEqual(getTagQueryAtCursor("#project", 8), {
		from: 0,
		to: 8,
		query: "project",
	});
	assert.deepEqual(getTagQueryAtCursor("第一行\n#daily", 10), {
		from: 4,
		to: 10,
		query: "daily",
	});
	assert.equal(getTagQueryAtCursor("今天#pro", 6), null);
});

test("replaces current tag query with selected suggestion", () => {
	assert.deepEqual(replaceTagQueryWithSuggestion("今天 #pro 明天", { from: 3, to: 7, query: "pro" }, "project/knomo"), {
		value: "今天 #project/knomo 明天",
		cursor: 18,
	});
	assert.deepEqual(replaceTagQueryWithSuggestion("今天 #pro明天", { from: 3, to: 7, query: "pro" }, "project/knomo"), {
		value: "今天 #project/knomo 明天",
		cursor: 18,
	});
});

test("formats the current line as a Markdown list", () => {
	assert.deepEqual(applyListFormatToText("hello", 5, 5, "bullet"), {
		value: "- hello",
		cursor: 7,
	});
	assert.deepEqual(applyListFormatToText("hello", 5, 5, "ordered"), {
		value: "1. hello",
		cursor: 8,
	});
	assert.deepEqual(applyListFormatToText("- hello", 7, 7, "ordered"), {
		value: "1. hello",
		cursor: 8,
	});
});

test("formats selected lines as a Markdown list", () => {
	assert.deepEqual(applyListFormatToText("a\nb\nc", 0, 5, "bullet"), {
		value: "- a\n- b\n- c",
		cursor: 11,
	});
	assert.deepEqual(applyListFormatToText("a\nb\nc", 0, 5, "ordered"), {
		value: "1. a\n2. b\n3. c",
		cursor: 14,
	});
});

test("continues and exits Markdown bullet lists", () => {
	assert.deepEqual(getListEnterPatch("- abc", 5, 5), {
		value: "- abc\n- ",
		cursor: 8,
	});
	assert.deepEqual(getListEnterPatch("- abc\n- ", 8, 8), {
		value: "- abc\n",
		cursor: 6,
	});
	assert.deepEqual(getListEnterPatch("-", 1, 1), {
		value: "",
		cursor: 0,
	});
	assert.deepEqual(getListEnterPatch("  - abc", 7, 7), {
		value: "  - abc\n  - ",
		cursor: 12,
	});
	assert.deepEqual(getListEnterPatch("  - ", 4, 4), {
		value: "  ",
		cursor: 2,
	});
});

test("continues and exits Markdown ordered lists", () => {
	assert.deepEqual(getListEnterPatch("1. abc", 6, 6), {
		value: "1. abc\n2. ",
		cursor: 10,
	});
	assert.deepEqual(getListEnterPatch("1. abc\n2. ", 10, 10), {
		value: "1. abc\n",
		cursor: 7,
	});
	assert.deepEqual(getListEnterPatch("2.", 2, 2), {
		value: "",
		cursor: 0,
	});
	assert.equal(getListEnterPatch("plain", 5, 5), null);
	assert.equal(getListEnterPatch("- hello", 0, 7), null);
});

test("parses tags at content and line starts", () => {
	assert.deepEqual(parseMemoTags("#daily\n第二行 #project/knomo\n#idea"), ["daily", "project/knomo", "idea"]);
});

import test from "node:test";
import assert from "node:assert/strict";

import { getHashInsertionText, getTagQueryAtCursor, replaceTagQueryWithSuggestion } from "../src/utils/composerInput";
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
		cursor: 17,
	});
});

test("parses tags at content and line starts", () => {
	assert.deepEqual(parseMemoTags("#daily\n第二行 #project/knomo\n#idea"), ["daily", "project/knomo", "idea"]);
});

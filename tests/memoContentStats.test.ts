import test from "node:test";
import assert from "node:assert/strict";

import { getMemoContentStats } from "../src/utils/memoContentStats";

test("counts Chinese characters, English words, and numbers", () => {
	assert.deepEqual(getMemoContentStats(makeSource("今天写 Knomo notes，don't stop！2026")), {
		chineseCharacterCount: 3,
		englishWordCount: 4,
		numberCount: 1,
		wordCount: 8,
	});
	assert.equal(getMemoContentStats(makeSource("state-of-the-art GPT-5")).wordCount, 3);
});

test("counts text inside Markdown structures but ignores their punctuation", () => {
	const content = [
		"## 标题 Heading",
		"- 列表 item",
		"> 引用 quote",
		"**粗体 bold**",
		"#计划",
	].join("\n");

	assert.deepEqual(getMemoContentStats(makeSource(content)), {
		chineseCharacterCount: 10,
		englishWordCount: 4,
		numberCount: 0,
		wordCount: 14,
	});
});

test("counts link labels while ignoring images, URLs, code, and block IDs", () => {
	const content = [
		"[[项目计划]] [[Daily/Note|每日记录]] [OpenAI docs](https://example.com/docs)",
		"![[image.png]] ![photo](https://example.com/photo.png) https://example.com/path",
		"`inline code` ^block-id",
		"```ts",
		"const hidden = 123;",
		"```",
	].join("\n");

	assert.deepEqual(getMemoContentStats(makeSource(content)), {
		chineseCharacterCount: 8,
		englishWordCount: 2,
		numberCount: 0,
		wordCount: 10,
	});
});

test("ignores the internal trailing block reference for referenced memos", () => {
	const stats = getMemoContentStats({
		contentSnapshot: "正文 text [[Daily/2026-06-19#^abc123|memo-1]]",
		references: [{ memoId: "memo-1", referenceText: "[[Daily/2026-06-19#^abc123]]" }],
	});

	assert.deepEqual(stats, {
		chineseCharacterCount: 2,
		englishWordCount: 1,
		numberCount: 0,
		wordCount: 3,
	});
});

test("ignores punctuation, whitespace, and emoji", () => {
	assert.equal(getMemoContentStats(makeSource("，。！？；：、,.!? 😄\n\t")).wordCount, 0);
});

test("reuses cached statistics until countable memo content changes", () => {
	const memo = makeSource("one two");
	const first = getMemoContentStats(memo);
	assert.equal(getMemoContentStats(memo), first);

	memo.contentSnapshot = "one two three";
	const updated = getMemoContentStats(memo);
	assert.notEqual(updated, first);
	assert.equal(updated.wordCount, 3);
});

function makeSource(contentSnapshot: string): { contentSnapshot: string; references: [] } {
	return { contentSnapshot, references: [] };
}

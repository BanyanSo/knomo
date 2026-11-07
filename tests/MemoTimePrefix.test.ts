import assert from "node:assert/strict";
import test from "node:test";
import MarkdownIt from "markdown-it";
import { MarkdownBlockService } from "../src/services/MarkdownBlockService";
import { DiaryMemoParser } from "../src/services/DiaryMemoParser";
import { memoLevelRelationBlockId } from "../src/utils/memoRelations";
import { memoMarkdownConsistencyFixtures, expectedLegacyDailyMemo } from "./fixtures/memoMarkdownConsistency";

const blocks = new MarkdownBlockService();
const parser = new DiaryMemoParser();
const markdown = new MarkdownIt({ html: true });
function read(raw: string) {
	return parser.parseRevision({ sourcePath: "Daily/2026-11-07.md", logicalDate: "2026-11-07", content: raw, sourceRevision: "test" }).observations;
}

test("两列候选和保留的四列格式均保留实际 Markdown、代码空白及原生锚点范围", () => {
	for (const fixture of memoMarkdownConsistencyFixtures) for (const blockId of [null, "memo-anchor"]) {
		const raw = blocks.buildMemoBlockWithBlockId(fixture.content, "12:34", blockId);
		const legacy = expectedLegacyDailyMemo(fixture, "12:34", blockId);
		assert.equal(markdown.render(raw), markdown.render(legacy), fixture.name);
		assert.equal(memoLevelRelationBlockId(raw), memoLevelRelationBlockId(legacy), fixture.name);
		const parsed = read(`${raw}\n- 13:00 neighbor`);
		assert.equal(parsed.length, 2, fixture.name);
		assert.equal(parsed[0].content, fixture.content, fixture.name);
		assert.equal(parsed[0].existingBlockId, blockId, fixture.name);
		assert.equal(parsed[1].content, "neighbor");
	}
});

test("能直接开始的引用、列表、任务、标题、围栏不增加时间行后的空行", () => {
	for (const body of ["> quote", "- parent\n  - child", "- [ ] task", "# Heading", "```js\ncode\n```", "***"]) {
		const raw = blocks.buildMemoBlock(body, "12:34");
		assert.equal(raw, "- 12:34\n" + body.split("\n").map(line => `  ${line}`).join("\n"));
		assert.equal(read(raw)[0].content, body);
	}
});

test("普通文本 Tab 与围栏字面 Tab 可以使用两列，结构性 Tab 逐例保留语义", () => {
	assert.equal(blocks.buildMemoBlock("first\tsecond", "12:34"), "- 12:34 first\tsecond");
	const fence = blocks.buildMemoBlock("```md\n\tcode\n```", "12:34");
	assert.ok(fence.startsWith("- 12:34\n  ```md\n"));
	assert.match(markdown.render(fence), /<code class="language-md">\tcode\n/u);
	const quote = ">\t\tcode";
	assert.match(markdown.render("- 12:34\n  " + quote), /<code>code\n/u);
	const savedQuote = blocks.buildMemoBlock(quote, "12:34");
	assert.ok(savedQuote.startsWith("-   12:34\n"));
	assert.match(markdown.render(savedQuote), /<code>  code\n/u);
	const code = "\tcode";
	assert.doesNotMatch(markdown.render("- 12:34\n  \n  " + code), /<pre>/u);
	assert.match(markdown.render(blocks.buildMemoBlock(code, "12:34")), /<pre><code>code\n/u);
	assert.equal(read(savedQuote)[0].content, quote);
});

test("表格、缩进代码、Setext 标题及非 1 有序列表分别保留必要段落边界", () => {
	for (const body of ["| A | B |\n| --- | --- |\n| C | D |", "    code", "Title\n===", "3. first\n4. second", "---", "<custom>\nbody\n</custom>"]) {
		const raw = blocks.buildMemoBlock(body, "12:34");
		assert.ok(raw.startsWith("-   12:34\n\t\n"), body);
		const noSeparator = "- 12:34\n" + body.split("\n").map(line => `  ${line}`).join("\n");
		assert.notEqual(markdown.render(noSeparator), markdown.render(raw), body);
		assert.equal(read(raw)[0].content, body);
	}
});

test("必要分隔空行与历史正文空行存在字节歧义，不能借空白协议将其删除", () => {
	const table = "| A | B |\n| --- | --- |\n| C | D |";
	const raw = "- 12:34\n  \n" + table.split("\n").map(line => `  ${line}`).join("\n");
	assert.equal(read(raw)[0].content, "\n" + table);
	assert.equal(blocks.buildMemoBlock("\n" + table, "12:34"), raw);
	assert.ok(blocks.buildMemoBlock(table, "12:34").startsWith("-   12:34\n"));
});

test("块 ID 不从原段落移走，不被旧两列规则吞掉或提升为另一个 Memo ID", () => {
	assert.equal(blocks.buildMemoBlockWithBlockId("first\nsecond", "12:34", "memo"), "- 12:34 first\n  second ^memo");
	const quote = blocks.buildMemoBlockWithBlockId("> quote", "12:34", "memo");
	assert.equal(quote, "-   12:34 ^memo\n\t> quote");
	const unsafeQuote = read("- 12:34 ^memo\n  > quote")[0];
	assert.equal(unsafeQuote.existingBlockId, null);
	assert.equal(unsafeQuote.content, "^memo\n> quote");
	for (const [body, blockId] of [["intro\n\n- child ^child", null], ["first\nsecond  ", "memo"]] as const) {
		const raw = blocks.buildMemoBlockWithBlockId(body, "12:34", blockId);
		assert.ok(raw.startsWith("-   12:34 "));
		assert.equal(read(raw)[0].content, body);
		assert.equal(read(raw)[0].existingBlockId, blockId);
	}
});

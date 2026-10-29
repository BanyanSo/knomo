import assert from "node:assert/strict";
import test from "node:test";
import { parser, GFM } from "@lezer/markdown";
import type { SyntaxNode } from "@lezer/common";
import { MarkdownBlockService } from "../src/services/MarkdownBlockService";
import { DiaryMemoParser } from "../src/services/DiaryMemoParser";
import { memoMarkdownConsistencyFixtures, expectedDailyMemo } from "./fixtures/memoMarkdownConsistency";

const markdown = parser.configure(GFM);
const blocks = new MarkdownBlockService();
const diary = new DiaryMemoParser();

function parseDaily(content: string) {
	return diary.parseRevision({ sourcePath: "Daily/2026-10-24.md", logicalDate: "2026-10-24", content, sourceRevision: "revision" }).observations;
}

// 只比较块结构和行内语法；Daily 的列表 marker 与时间段落单独移除。
function structure(node: SyntaxNode): string {
	const children: string[] = [];
	for (let child = node.firstChild; child; child = child.nextSibling) {
		const value = structure(child);
		if (value !== "CodeText" || children.at(-1) !== "CodeText") children.push(value);
	}
	return `${node.name}${children.length ? `(${children.join(",")})` : ""}`;
}

for (const fixture of memoMarkdownConsistencyFixtures) {
	test(`B0/B1 四阶段样例：${fixture.name}`, async () => {
		const raw = blocks.buildMemoBlock(fixture.content, "12:34:56");
		assert.equal(raw, expectedDailyMemo(fixture, "12:34:56"), "Daily 原文");
		const observations = parseDaily(`${raw}\n- 13:00 neighbor\nordinary diary\n  outside`);
		assert.equal(observations.length, 2);
		assert.equal(observations[0].content, fixture.content, "逻辑正文不裁剪或增删空行");
		assert.equal(observations[1].content, "neighbor");
		const cooperative = await diary.parse({ sourcePath: "Daily/2026-10-24.md", logicalDate: "2026-10-24", bytes: Buffer.from(raw) }, { maxLinesPerSlice: 1, yieldControl: async () => {} });
		assert.equal(cooperative.observations[0].content, fixture.content);
		{
			const item = markdown.parse(raw).topNode.firstChild!.firstChild!;
			assert.equal(item.name, "ListItem");
			const actual: string[] = [];
			let first = item.firstChild!.nextSibling;
			const inputTree = markdown.parse(fixture.content).topNode;
			if (fixture.layout === "separated" || inputTree.firstChild?.name !== "Paragraph") {
				assert.equal(first?.name, "Paragraph", "时间保持独立段落");
				first = first!.nextSibling;
			}
			for (let child = first; child; child = child.nextSibling) actual.push(structure(child));
			const expected: string[] = [];
			for (let child = inputTree.firstChild; child; child = child.nextSibling) expected.push(structure(child));
			assert.deepEqual(actual, expected, "Daily 子块的 Markdown 结构");
		}
	});
}

test("旧 continuation 的首尾空行保持原义，不误认成结构分隔符", () => {
	for (const indent of ["  ", "\t"]) {
		const raw = `- 12:34\n${indent}\n${indent}Title\n${indent}===\n${indent}`;
		assert.equal(parseDaily(raw)[0].content, "\nTitle\n===\n");
	}
	assert.equal(parseDaily("- 12:34\n\nordinary diary\n  outside").length, 0);
	assert.equal(parseDaily("- 12:34 body\n\n  outside")[0].content, "body");
});

test("仅规范化 CRLF/CR；首行缩进及行尾硬换行空格保留", () => {
	const content = "  first  \r\nsecond\\\rthird\n\n";
	assert.equal(parseDaily(blocks.buildMemoBlock(content, "12:34"))[0].content, content.replace(/\r\n|\r/g, "\n"));
});

test("已有 blockId 在各布局与 cooperative Parser 中保持正文、引用及任务位置", async () => {
	for (const fixture of memoMarkdownConsistencyFixtures) {
		const raw = blocks.buildMemoBlockWithBlockId(fixture.content, "12:34", "existing-anchor");
		assert.equal(raw, expectedDailyMemo(fixture, "12:34", "existing-anchor"));
		const parsed = parseDaily(raw)[0];
		assert.equal(parsed.content, fixture.content);
		assert.equal(parsed.existingBlockId, "existing-anchor");
		const cooperative = await diary.parse({ sourcePath: "Daily/2026-10-24.md", logicalDate: "2026-10-24", bytes: Buffer.from(raw) }, { maxLinesPerSlice: 1, yieldControl: async () => {} });
		assert.equal(cooperative.observations[0].content, parsed.content);
		assert.equal(cooperative.observations[0].existingBlockId, parsed.existingBlockId);
		assert.deepEqual(cooperative.observations[0].tasks, parsed.tasks);
	}
});

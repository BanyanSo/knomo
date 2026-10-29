import assert from "node:assert/strict";
import test from "node:test";
import { MarkdownBlockService } from "../src/services/MarkdownBlockService";
import { DiaryMemoParser } from "../src/services/DiaryMemoParser";
import { parseMemoMarkdown } from "../src/utils/markdown";

const blocks = new MarkdownBlockService();
const parser = new DiaryMemoParser();
function read(raw: string) {
	return parser.parseRevision({ sourcePath: "Daily/2026-10-25.md", logicalDate: "2026-10-25", content: raw, sourceRevision: "test" }).observations[0];
}

test("四列容器的空格和混合缩进保留正文、分隔空行、引用与任务偏移", async () => {
	for (const content of ["  # title", "    code\n\tmore", "\n  # title\n\n", "| A | B |\n| --- | --- |\n| C | D |", "intro\n\n- [ ] task\n  - [x] nested"]) {
		for (const blockId of [null, "anchor"]) {
			const canonical = blocks.buildMemoBlockWithBlockId(content, "12:34", blockId);
			const expected = read(canonical);
			for (const indent of ["    ", " \t", "  \t", "   \t"]) for (const eol of ["\n", "\r\n"]) {
				const raw = canonical.replace(/^\t/gmu, indent).replace(/\n/gu, eol);
				const actual = read(raw);
				assert.equal(actual.content, content, JSON.stringify({ content, indent, eol }));
				assert.equal(actual.existingBlockId, blockId);
				assert.deepEqual(actual.tasks, expected.tasks);
				const cooperative = await parser.parse({ sourcePath: "Daily/2026-10-25.md", logicalDate: "2026-10-25", bytes: Buffer.from(raw) }, { maxLinesPerSlice: 1, yieldControl: async () => {} });
				assert.equal(cooperative.observations[0].content, content);
				assert.equal(cooperative.observations[0].existingBlockId, blockId);
				assert.deepEqual(cooperative.observations[0].tasks, actual.tasks);
			}
		}
	}
});

test("空格缩进的四列标题再次写回仍是标题，旧两列空格正文保持原义", () => {
	const raw = "-   12:34\n      # title";
	assert.match(parseMemoMarkdown(raw).toString(), /ATXHeading1/u);
	const parsed = read(raw);
	assert.equal(parsed.content, "  # title");
	assert.match(parseMemoMarkdown(blocks.buildMemoBlock(parsed.content, parsed.time)).toString(), /ATXHeading1/u);
	assert.equal(read("- 12:34\n      # title").content, "    # title");
	assert.equal(read("- 12:34\n  \n    text\n  ").content, "\n  text\n");
});

test("可直接开启子块的语法紧接时间行，不机械添加空行", () => {
	for (const content of ["> quote\n> continued", "# Heading", "```js\nx\n```", "- first\n- second", "- [ ] task", "1. first\n2. second", "***"]) {
		for (const blockId of [null, "anchor"]) {
			const raw = blocks.buildMemoBlockWithBlockId(content, "12:34", blockId);
			assert.equal(raw, `-   12:34${blockId === null ? "" : " ^anchor"}\n${content.split("\n").map(line => `\t${line}`).join("\n")}`);
			assert.equal(read(raw).content, content);
			assert.equal(read(raw).existingBlockId, blockId);
		}
	}
});

test("后续块和 Tab 不迫使安全的首段另起一行，有引用的普通多行也保持紧凑", () => {
	for (const content of ["intro\n\n> quote", "intro\n\n- first\n  - nested", "intro\n\n```md\nliteral ^code", "first\n\tcontinued"]) {
		const raw = blocks.buildMemoBlock(content, "12:34");
		assert.ok(raw.startsWith("-   12:34 " + content.split("\n")[0] + "\n"), raw);
		assert.equal(read(raw).content, content);
	}
	assert.equal(blocks.buildMemoBlockWithBlockId("first\nsecond", "12:34", "anchor"), "-   12:34 first\n\tsecond ^anchor");
});

test("有引用的硬换行保留在正文中，ID 放在首段结束处且不额外空一行", () => {
	const content = "first  \nsecond\\\nthird";
	const raw = blocks.buildMemoBlockWithBlockId(content, "12:34", "anchor");
	assert.equal(raw, "-   12:34 first  \n\tsecond\\\n\tthird ^anchor");
	assert.equal(read(raw).content, content);
	assert.equal(read(raw).existingBlockId, "anchor");
});

test("段落结束处的尾随空白仍完整保留，后续围栏中的 caret 不被识别为 Memo ID", () => {
	const content = "first\nsecond \t\n\n```md\nliteral ^code";
	const raw = blocks.buildMemoBlockWithBlockId(content, "12:34", "anchor");
	assert.ok(raw.startsWith("-   12:34 first\n\tsecond \t ^anchor\n"), raw);
	assert.equal(read(raw).content, content);
	assert.equal(read(raw).existingBlockId, "anchor");
});

test("正文首行的裸 caret 不与独立时间头 ID 混淆，脚注定义保持必要边界", () => {
	for (const content of ["^literal\n\n> quote", "^literal\ncontinued\n\n```md\nbody\n```", "[^a]: two words\n\ntext[^a]"]) {
		for (const blockId of [null, "anchor"]) {
			const raw = blocks.buildMemoBlockWithBlockId(content, "12:34", blockId);
			assert.equal(read(raw).content, content);
			assert.equal(read(raw).existingBlockId, blockId);
		}
	}
});

test("依赖段落边界的语法保留必要空行", () => {
	for (const content of ["Title\n===", "| A | B |\n| --- | --- |\n| C | D |", "    code", "3. first\n4. second", "---", "<custom>\nbody\n</custom>"]) {
		const raw = blocks.buildMemoBlock(content, "12:34");
		assert.ok(raw.startsWith("-   12:34\n\t\n"), raw);
		assert.equal(read(raw).content, content);
	}
});

test("读取上一轮已保存的分隔空行，同时保留用户自己的前后空行", () => {
	for (const blockId of ["", " ^anchor"]) {
		const raw = `-   12:34${blockId}\n\t\n\t\n\tfirst  \n\tsecond\n\t`;
		assert.equal(read(raw).content, "\nfirst  \nsecond\n");
		assert.equal(read(raw).existingBlockId, blockId ? "anchor" : null);
	}
});

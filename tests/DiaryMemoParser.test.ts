import { MarkdownBlockService } from "../src/services/MarkdownBlockService";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { CATALOG_PARSER_VERSION, DiaryMemoParser } from "../src/services/DiaryMemoParser";

const FIXTURE_DIR = path.join("tests", "fixtures", "catalog", "phase1");
const parser = new DiaryMemoParser(async (bytes) => sha256(bytes));

test("Things 的 Daily 任务位置保留首行、引用与续行原始偏移", async () => {
	const content = "- 09:00 - [ ] first\n  > - [-] quoted\n  ```md\n  - [x] example\n  ```\n  - parent\n    1. [X] nested\n";
	const result = await parser.parse({ sourcePath: "Daily/2026-09-20.md", logicalDate: "2026-09-20", bytes: Buffer.from(content) });
	assert.equal(result.observations.length, 1);
	assert.equal(result.observations[0].time, "09:00");
	assert.deepEqual(result.observations[0].tasks.map(task => [task.taskIndex, task.lineOffset, task.marker]), [[0, 0, " "], [1, 1, "-"], [2, 6, "X"]]);
});

test("PARSE-CUSTOM-ROOT：识别根层和所有 heading，排除 frontmatter 与代码块", async () => {
	const result = await parseFixture("PARSE-CUSTOM-ROOT", {
		sourcePath: "Journal/2026/08/2026-08-09.md",
		logicalDate: "2026-08-09",
	});

	assert.deepEqual(result.observations.map((item) => ({
		section: item.section,
		startLine: item.startLine,
		content: item.content,
	})), [
		{ section: null, startLine: 4, content: "root memo #root" },
		{ section: "## Custom Memos", startLine: 7, content: "heading memo" },
		{ section: "## Other", startLine: 9, content: "ignored memo" },
	]);
	assert.equal(result.observations[0].logicalDate, "2026-08-09");
	assert.equal(result.observations[0].sourcePath, "Journal/2026/08/2026-08-09.md");
});

test("所有 H1-H6 与根区域识别合法时间 memo，并排除嵌套、引用、任务、非法时间和空正文", async () => {
	const content = [
		"---",
		"- 01:00 frontmatter fake",
		"---",
		"- 12:58 root",
		"  root continuation",
		"# H1",
		"- 14:26 h1",
		"## H2",
		"- 14:26:30 h2",
		"### H3",
		"- 03:03 h3",
		"#### H4",
		"- 04:04 h4",
		"##### H5",
		"- 05:05 h5",
		"###### H6",
		"- 06:06 h6",
		"  second line",
		"```md",
		"- 07:07 fenced fake",
		"```",
		"  - 08:08 nested fake",
		"> - 09:09 quoted fake",
		"- [ ] 10:10 task fake",
		"- 24:00 invalid hour",
		"- 12:60 invalid minute",
		"- 11:11",
		"ordinary text",
	].join("\n");
	const result = await parser.parse({
		sourcePath: "Daily/2026-08-27.md",
		logicalDate: "2026-08-27",
		bytes: Buffer.from(content, "utf8"),
	});

	assert.deepEqual(result.observations.map((item) => ({
		time: item.time,
		section: item.section,
		content: item.content,
	})), [
		{ time: "12:58", section: null, content: "root\nroot continuation" },
		{ time: "14:26", section: "# H1", content: "h1" },
		{ time: "14:26:30", section: "## H2", content: "h2" },
		{ time: "03:03", section: "### H3", content: "h3" },
		{ time: "04:04", section: "#### H4", content: "h4" },
		{ time: "05:05", section: "##### H5", content: "h5" },
		{ time: "06:06", section: "###### H6", content: "h6\nsecond line" },
	]);
});

test("Catalog 本机缓存版本包含混排搜索短 token 更新", () => {
	assert.ok(CATALOG_PARSER_VERSION >= 7);
});

test("PARSE-DUPLICATE-TIME-CONTENT：不按时间或 contentHash 去重", async () => {
	const result = await parseFixture("PARSE-DUPLICATE-TIME-CONTENT");
	assert.equal(result.observations.length, 3);
	assert.equal(result.observations[0].contentHash, result.observations[1].contentHash);
	assert.notEqual(result.observations[1].startLine, result.observations[0].startLine);
	assert.notEqual(result.observations[1].contentHash, result.observations[2].contentHash);
	assert.deepEqual(result.observations.map((observation) => [observation.occurrenceIndex, observation.occurrenceCount]), [[0, 2], [1, 2], [0, 1]]);
});

test("ObservationHandle 的 rawBlockHash 覆盖时间行与完整原始 block", async () => {
	const first = await parser.parse({
		sourcePath: "2026-08-09.md",
		logicalDate: "2026-08-09",
		bytes: Buffer.from("## Memos\n- 09:00 same", "utf8"),
	});
	const second = await parser.parse({
		sourcePath: "2026-08-09.md",
		logicalDate: "2026-08-09",
		bytes: Buffer.from("## Memos\n- 10:00 same", "utf8"),
	});

	assert.equal(first.observations[0]?.contentHash, second.observations[0]?.contentHash);
	assert.notEqual(first.observations[0]?.rawBlockHash, second.observations[0]?.rawBlockHash);
});

test("PARSE-MULTILINE-TASK：保留正文、行范围和稳定 taskIndex", async () => {
	const result = await parseFixture("PARSE-MULTILINE-TASK");
	const observation = result.observations[0];
	assert.equal(observation.startLine, 1);
	assert.equal(observation.endLine, 5);
	assert.equal(observation.content, "first line\ncontinuation\n- [ ] first task\n  - [x] nested task\n- [-] cancelled task");
	assert.deepEqual(observation.tasks, [
		{ taskIndex: 0, lineOffset: 2, marker: " ", text: "first task" },
		{ taskIndex: 1, lineOffset: 3, marker: "x", text: "nested task" },
		{ taskIndex: 2, lineOffset: 4, marker: "-", text: "cancelled task" },
	]);
});

test("任务列表起始的 memo 使用原始 block 行偏移", async () => {
	const result = parser.parseRevision({
		sourcePath: "2026-08-09.md",
		logicalDate: "2026-08-09",
		content: "## Memos\n- 09:00\n\t- [ ] first task\n\t- [x] second task\n",
		sourceRevision: "revision",
	});

	assert.deepEqual(result.observations[0]?.tasks, [
		{ taskIndex: 0, lineOffset: 1, marker: " ", text: "first task" },
		{ taskIndex: 1, lineOffset: 2, marker: "x", text: "second task" },
	]);
});

test("PARSE-MEDIA-LINKS：建立图片、链接和标签元数据，不读取图片文件", async () => {
	const result = await parseFixture("PARSE-MEDIA-LINKS");
	const observation = result.observations[0];
	assert.deepEqual(observation.tags, ["media"]);
	assert.deepEqual(observation.images.map((image) => image.path), ["photo.png", "assets/image.webp"]);
	assert.deepEqual(observation.links.map((link) => [link.syntax, link.target]), [
		["markdown_link", "https://example.com/a"],
		["wiki_link", "Note"],
		["url", "https://example.org/path"],
	]);
});

test("PARSE-CODE-FENCES：代码块中的伪 memo、task、link、image 与浮标均不入索引", async () => {
	const result = await parseFixture("PARSE-CODE-FENCES");
	assert.equal(result.observations.length, 1);
	const observation = result.observations[0];
	assert.deepEqual(observation.tasks.map((task) => task.text), ["real task"]);
	assert.deepEqual(observation.links.map((link) => link.target), ["Real Link"]);
	assert.deepEqual(observation.images, []);
	assert.deepEqual(observation.timeBuoyDates, ["2026-08-02"]);
});

test("PARSE-EXISTING-BLOCK-ID：content 剥离 trailing ID，existingBlockId 单独保留且源字节不变", async () => {
	const filePath = fixturePath("PARSE-EXISTING-BLOCK-ID");
	const before = fs.readFileSync(filePath);
	const beforeDigest = sha256(before);
	const result = await parser.parse({
		sourcePath: "2026-08-09.md",
		logicalDate: "2026-08-09",
		bytes: before,
	});
	const after = fs.readFileSync(filePath);

	assert.equal(sha256(after), beforeDigest);
	assert.deepEqual(result.observations.map((item) => [item.content, item.existingBlockId]), [
		["one line", "single-id"],
		["multi line\nkeeps content\nfinal line", "multi_id"],
	]);
});

test("PARSE-LINE-ENDINGS：原始 SHA 区分 LF/CRLF/BOM，contentHash 保持规范稳定", async () => {
	const text = "## Memos\n- 15:00 Unicode 中文 🧭";
	const lf = Buffer.from(text, "utf8");
	const crlf = Buffer.from(text.replace(/\n/gu, "\r\n"), "utf8");
	const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), lf]);
	const withFinalLf = Buffer.from(`${text}\n`, "utf8");
	const results = await Promise.all([lf, crlf, bom, withFinalLf].map((bytes) => parser.parse({
		sourcePath: "2026-08-09.md",
		logicalDate: "2026-08-09",
		bytes,
	})));

	assert.equal(new Set(results.map((result) => result.sourceRevision)).size, 4);
	assert.equal(new Set(results.map((result) => result.observations[0].contentHash)).size, 1);
	assert.ok(results.every((result) => result.observations[0].content === "Unicode 中文 🧭"));
	assert.equal(results[2].sourceRevision, sha256(bom));
});

test("大 Daily 解析会协作式让出事件循环且结果保持一致", async () => {
	const content = [
		"## Memos",
		"- 09:00 large memo",
		...Array.from({ length: 2_000 }, (_, index) => `  continuation ${index}`),
	].join("\n");
	const bytes = Buffer.from(content, "utf8");
	const expected = await parser.parse({
		sourcePath: "Journal/2026-08-09.md",
		logicalDate: "2026-08-09",
		bytes,
	});
	let yieldCount = 0;
	const actual = await parser.parse({
		sourcePath: "Journal/2026-08-09.md",
		logicalDate: "2026-08-09",
		bytes,
	}, {
		maxLinesPerSlice: 32,
		yieldControl: async () => { yieldCount += 1; },
	});

	assert.ok(yieldCount > 0);
	assert.deepEqual(actual, expected);
});

async function parseFixture(
	name: string,
	overrides: Partial<{ sourcePath: string; logicalDate: string }> = {},
) {
	const bytes = fs.readFileSync(fixturePath(name));
	return parser.parse({
		sourcePath: overrides.sourcePath ?? "2026-08-09.md",
		logicalDate: overrides.logicalDate ?? "2026-08-09",
		bytes,
	});
}

function fixturePath(name: string): string {
	return path.join(FIXTURE_DIR, `${name}.md`);
}

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}


test("parses list-leading memo content from a detached timestamp line", () => {
	const parsed = parseCurrentDiary([
		"- 12:00:00",
		"  - 第一项",
		"  - 第二项 ^abc123",
	].join("\n"))[0];

	assert.ok(parsed);
	assert.equal(parsed.existingBlockId, "abc123");
	assert.equal(parsed.content, "- 第一项\n- 第二项");
});

test("parses tab-indented memo continuation lines", () => {
	const parsed = parseCurrentDiary([
		"- 12:00:00 第一行",
		"\t- 子项",
		"\t\t- 嵌套子项 ^abc123",
	].join("\n"))[0];

	assert.ok(parsed);
	assert.equal(parsed.existingBlockId, "abc123");
	assert.equal(parsed.content, "第一行\n- 子项\n\t- 嵌套子项");
});

test("does not parse an empty detached timestamp line as a memo", () => {
	assert.equal(parseCurrentDiary("- 12:00:00").length, 0);
});

test("parses a three-line memo block with tags and links", () => {
	const parsed = parseCurrentDiary([
			"- 12:00:00 第一行",
			"  第二行包含 #tag",
			"  第三行包含 [[链接]]",
		].join("\n"))[0];

	assert.ok(parsed);
	assert.equal(parsed.time, "12:00:00");
	assert.equal(parsed.content, "第一行\n第二行包含 #tag\n第三行包含 [[链接]]");
	assert.deepEqual(parsed.tags, ["tag"]);
	assert.deepEqual(parsed.links, [
		{
			target: "链接",
			displayText: null,
			syntax: "wiki_link",
		},
	]);
});

test("parses bare web URLs without duplicating wrapped links", () => {
	const metadata = parseCurrentDiary(new MarkdownBlockService().buildMemoBlock("裸链接 https://example.com/docs?q=1，括号 (http://example.org/a_(b)). "
		+ "Markdown [官网](https://knomo.app) 图片 ![封面](https://example.com/a.png) www.example.com", "12:00:00"))[0];

	assert.deepEqual(metadata.links, [
		{
			target: "https://example.com/docs?q=1",
			displayText: null,
			syntax: "url",
		},
		{
			target: "http://example.org/a_(b)",
			displayText: null,
			syntax: "url",
		},
		{
			target: "https://knomo.app",
			displayText: "官网",
			syntax: "markdown_link",
		},
	]);
});

test("parses memo time in HH:mm format", () => {
	const parsed = parseCurrentDiary(["- 18:30 内容"].join("\n"))[0];

	assert.ok(parsed);
	assert.equal(parsed.time, "18:30");
	assert.equal(parsed.content, "内容");
});

test("parses memo time in HH:mm:ss format", () => {
	const parsed = parseCurrentDiary(["- 18:30:12 内容"].join("\n"))[0];

	assert.ok(parsed);
	assert.equal(parsed.time, "18:30:12");
	assert.equal(parsed.content, "内容");
});

test("parses multiple memos in the same minute and second", () => {
	const blocks = parseCurrentDiary([
		"- 18:30 同一分钟第一条",
		"- 18:30 同一分钟第二条",
		"- 18:30:12 同一秒第一条",
		"- 18:30:12 同一秒第二条",
	].join("\n"));

	assert.deepEqual(blocks.map((block) => block.content), [
		"同一分钟第一条",
		"同一分钟第二条",
		"同一秒第一条",
		"同一秒第二条",
	]);
});

test("parses Obsidian image embeds", () => {
	const parsed = parseCurrentDiary(["- 12:00:00 第一行", "  第二行 ![[Assets/a.png]]"].join("\n"))[0];

	assert.ok(parsed);
	assert.deepEqual(parsed.images, [
		{
			path: "Assets/a.png",
			altText: "",
			syntax: "obsidian_embed",
		},
	]);
	assert.deepEqual(parsed.links, []);
});

test("decodes percent-encoded Obsidian image embed paths", () => {
	const parsed = parseCurrentDiary(["- 12:00:00 图片 ![[Assets/a%20b%20c.jpg|300]]"].join("\n"))[0];

	assert.ok(parsed);
	assert.deepEqual(parsed.images, [
		{
			path: "Assets/a b c.jpg",
			altText: "",
			syntax: "obsidian_embed",
		},
	]);
});

test("parses supported Obsidian image embeds", () => {
	const parsed = parseCurrentDiary([
		"- 12:00:00 图片 ![[Assets/a.avif]] ![[Assets/a.bmp]] ![[Assets/a.gif]] ![[Assets/a.jpeg]]",
		"  ![[Assets/a.jpg]] ![[Assets/a.png]] ![[Assets/a.svg]] ![[Assets/a.webp]] ![[Assets/a.WEBP|300]]",
	].join("\n"))[0];

	assert.ok(parsed);
	assert.deepEqual(parsed.images.map((image) => image.path), [
		"Assets/a.avif",
		"Assets/a.bmp",
		"Assets/a.gif",
		"Assets/a.jpeg",
		"Assets/a.jpg",
		"Assets/a.png",
		"Assets/a.svg",
		"Assets/a.webp",
		"Assets/a.WEBP",
	]);
});

test("does not treat Obsidian block embeds as images", () => {
	const parsed = parseCurrentDiary(["- 12:00:00 引用 ![[2026-05-18#^5i3h99]]"].join("\n"))[0];

	assert.ok(parsed);
	assert.deepEqual(parsed.images, []);
});

test("parses Markdown images", () => {
	const parsed = parseCurrentDiary(["- 12:00:00 第一行", "  第二行 ![alt](Assets/a.png)"].join("\n"))[0];

	assert.ok(parsed);
	assert.deepEqual(parsed.images, [
		{
			path: "Assets/a.png",
			altText: "alt",
			syntax: "markdown_image",
		},
	]);
});

test("decodes percent-encoded local Markdown image paths", () => {
	const parsed = parseCurrentDiary(["- 12:00:00 图片 ![](Pasted%20image%2020260606110900.png)"].join("\n"))[0];

	assert.ok(parsed);
	assert.deepEqual(parsed.images, [
		{
			path: "Pasted image 20260606110900.png",
			altText: "",
			syntax: "markdown_image",
		},
	]);
});

test("keeps remote Markdown image URLs percent-encoded", () => {
	const metadata = parseCurrentDiary(new MarkdownBlockService().buildMemoBlock("![remote](https://example.com/Pasted%20image%2020260606110900.png)", "12:00:00"))[0];

	assert.deepEqual(metadata.images, [
		{
			path: "https://example.com/Pasted%20image%2020260606110900.png",
			altText: "remote",
			syntax: "markdown_image",
		},
	]);
});

test("treats numeric-only Markdown image labels as sizes for local and remote images", () => {
	const metadata = parseCurrentDiary(new MarkdownBlockService().buildMemoBlock([
		"![200](Assets/local.png)",
		"![ 320 ](https://example.com/remote.png)",
		"![图 200](Assets/labeled.png)",
	].join(" "), "12:00:00"))[0];

	assert.deepEqual(metadata.images, [
		{
			path: "Assets/local.png",
			altText: "",
			syntax: "markdown_image",
		},
		{
			path: "https://example.com/remote.png",
			altText: "",
			syntax: "markdown_image",
		},
		{
			path: "Assets/labeled.png",
			altText: "图 200",
			syntax: "markdown_image",
		},
	]);
});

test("ignores blockId on the first line", () => {
	const parsed = parseCurrentDiary(["- 12:00:00 第一行 ^abc123", "  第二行"].join("\n"))[0];

	assert.ok(parsed);
	assert.equal(parsed.existingBlockId, "abc123");
	assert.equal(parsed.content, "第一行\n第二行");
});

test("ignores blockId on the last effective content line", () => {
	const parsed = parseCurrentDiary(["- 12:00:00 第一行", "  第二行 ^abc123"].join("\n"))[0];

	assert.ok(parsed);
	assert.equal(parsed.existingBlockId, "abc123");
	assert.equal(parsed.content, "第一行\n第二行");
});

test("contentSnapshot has no time prefix or blockId", () => {
	const parsed = parseCurrentDiary(["- 12:00:00 第一行 ^abc123"].join("\n"))[0];

	assert.ok(parsed);
	assert.equal(parsed.content, "第一行");
});

test("unindented paragraphs do not belong to the previous memo", () => {
	const parsed = parseCurrentDiary(["- 12:00:00 第一行", "普通段落", "  不是 continuation"].join("\n"))[0];

	assert.ok(parsed);
	assert.equal(parsed.endLine, 0);
	assert.equal(parsed.content, "第一行");
});

test("a new Markdown heading stops memo parsing", () => {
	const parsed = parseCurrentDiary(["- 12:00:00 第一行", "  第二行", "## Next", "  不是 continuation"].join("\n"))[0];

	assert.ok(parsed);
	assert.equal(parsed.endLine, 1);
	assert.equal(parsed.content, "第一行\n第二行");
});

test("parses all memo blocks in content", () => {
	const blocks = parseCurrentDiary("- 12:00:00 第一行\n  第二行\n普通段落\n- 13:00:00 下一条");

	assert.equal(blocks.length, 2);
	assert.equal(blocks[0].content, "第一行\n第二行");
	assert.equal(blocks[1].content, "下一条");
});

function parseCurrentDiary(content: string) {
	return parser.parseRevision({
		sourcePath: "Daily/2026-05-14.md", logicalDate: "2026-05-14",
		content, sourceRevision: sha256(Buffer.from(content)),
	}).observations;
}

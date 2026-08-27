import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { CATALOG_PARSER_VERSION, DiaryMemoParser } from "../src/services/DiaryMemoParser";

const FIXTURE_DIR = path.join("tests", "fixtures", "catalog", "phase1");
const parser = new DiaryMemoParser(async (bytes) => sha256(bytes));

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

test("Catalog Parser 本机缓存标记随全区域识别契约更新", () => {
	assert.equal(CATALOG_PARSER_VERSION, 4);
});

test("PARSE-DUPLICATE-TIME-CONTENT：不按时间或 contentHash 去重", async () => {
	const result = await parseFixture("PARSE-DUPLICATE-TIME-CONTENT");
	assert.equal(result.observations.length, 3);
	assert.equal(result.observations[0].contentHash, result.observations[1].contentHash);
	assert.notEqual(result.observations[1].startLine, result.observations[0].startLine);
	assert.notEqual(result.observations[1].contentHash, result.observations[2].contentHash);
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

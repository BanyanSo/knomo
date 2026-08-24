import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { DiaryMemoParser } from "../src/services/DiaryMemoParser";

const FIXTURE_DIR = path.join("tests", "fixtures", "catalog", "phase1");
const parser = new DiaryMemoParser(async (bytes) => sha256(bytes));

test("PARSE-CUSTOM-ROOT：识别根层和自定义 heading，排除 frontmatter、其他 heading 与代码块", async () => {
	const result = await parseFixture("PARSE-CUSTOM-ROOT", {
		sourcePath: "Journal/2026/08/2026-08-09.md",
		logicalDate: "2026-08-09",
		headings: ["## Custom Memos"],
	});

	assert.deepEqual(result.observations.map((item) => ({
		section: item.section,
		startLine: item.startLine,
		content: item.content,
	})), [
		{ section: null, startLine: 4, content: "root memo #root" },
		{ section: "## Custom Memos", startLine: 7, content: "heading memo" },
	]);
	assert.equal(result.observations[0].logicalDate, "2026-08-09");
	assert.equal(result.observations[0].sourcePath, "Journal/2026/08/2026-08-09.md");
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
		headings: ["## Memos"],
		bytes: Buffer.from("## Memos\n- 09:00 same", "utf8"),
	});
	const second = await parser.parse({
		sourcePath: "2026-08-09.md",
		logicalDate: "2026-08-09",
		headings: ["## Memos"],
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
		headings: ["## Memos"],
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
		headings: ["## Memos"],
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
		headings: ["## Memos"],
		bytes,
	})));

	assert.equal(new Set(results.map((result) => result.sourceRevision)).size, 4);
	assert.equal(new Set(results.map((result) => result.observations[0].contentHash)).size, 1);
	assert.ok(results.every((result) => result.observations[0].content === "Unicode 中文 🧭"));
	assert.equal(results[2].sourceRevision, sha256(bom));
});

async function parseFixture(
	name: string,
	overrides: Partial<{ sourcePath: string; logicalDate: string; headings: string[] }> = {},
) {
	const bytes = fs.readFileSync(fixturePath(name));
	return parser.parse({
		sourcePath: overrides.sourcePath ?? "2026-08-09.md",
		logicalDate: overrides.logicalDate ?? "2026-08-09",
		headings: overrides.headings ?? ["## Memos"],
		bytes,
	});
}

function fixturePath(name: string): string {
	return path.join(FIXTURE_DIR, `${name}.md`);
}

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

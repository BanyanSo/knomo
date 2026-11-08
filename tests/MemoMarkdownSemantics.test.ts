import assert from "node:assert/strict";
import test from "node:test";
import MarkdownIt from "markdown-it";
import { DiaryMemoParser } from "../src/services/DiaryMemoParser";
import { MarkdownBlockService } from "../src/services/MarkdownBlockService";
import { hashMemoContent } from "../src/utils/hash";
import { memoPrefixHistory } from "./fixtures/memoPrefix/history";
import { memoPrefixTargets } from "./fixtures/memoPrefix/targets";

const parser = new DiaryMemoParser();
const writer = new MarkdownBlockService();
const markdown = new MarkdownIt({ html: true });
function read(raw: string) {
	return parser.parseRevision({ sourcePath: "Daily/2026-11-08.md", logicalDate: "2026-11-08",
		content: raw, sourceRevision: "revision" }).observations;
}

test("旧式空时间行的首段 ID 保留逻辑前导空行及原生段落范围", () => {
	for (const time of ["09:00", "09:00:12"]) {
		const original = `- ${time} \n  text ^legacy-leading-space`;
		let raw = original;
		for (let save = 0; save < 2; save++) {
			const memo = read(raw)[0];
			assert.equal(memo.content, "\ntext");
			assert.equal(memo.blockAnchor?.kind, "paragraph");
			assert.equal(memo.endLine, 1);
			raw = writer.serializeObservation(memo).rawBlock;
			assert.equal(raw, original);
			assert.equal(markdown.render(raw), markdown.render(original));
		}
		const edited = writer.serializeObservation(read(raw)[0], "\nchanged\ncontinued\n\n- [ ] task").rawBlock;
		assert.equal(read(edited)[0].content, "\nchanged\ncontinued\n\n- [ ] task");
		assert.equal(read(edited)[0].blockAnchor?.kind, "paragraph");
		assert.match(edited, /continued \^legacy-leading-space/u);
		assert.equal(read(edited)[0].time, time);
		assert.throws(() => writer.serializeObservation(read(raw)[0], "\n\ntext"));
	}
});

test("25 类目标 raw 与输入逐项对应，锚点源范围及任务偏移可直接核对", () => {
	for (const target of memoPrefixTargets) {
		const source = memoPrefixHistory[0].samples.find(sample => sample.category === target.category)!;
		for (const [raw, id] of [[target.raw, null], [target.anchoredRaw, "memo-anchor"]] as const) {
			assert.equal(writer.buildMemoBlockWithBlockId(source.content, "12:34:56", id), raw, target.name);
			const memo = read(raw)[0];
			assert.equal(memo.content, source.content, target.name);
			assert.equal(memo.time, "12:34:56");
			assert.equal(memo.existingBlockId, id ?? (target.category === "20" ? "child-anchor" : null));
			if (memo.blockAnchor) {
				const anchor = memo.blockAnchor;
				assert.equal(raw.slice(anchor.from, anchor.to), "^" + anchor.blockId);
				if (anchor.kind === "body") assert.ok(memo.content.includes("^" + anchor.blockId));
			}
			for (const task of memo.tasks) assert.match(raw.split("\n")[task.lineOffset], new RegExp(`\\[${task.marker}\\]`, "u"));
		}
	}
});

test("两个历史提交的 25 类固定 raw 保留正文、时间精度、完整范围及协作式读取", async () => {
	for (const version of memoPrefixHistory) for (const sample of version.samples) {
		for (const [raw, expectedId] of [[sample.raw, sample.category === "20" ? "child-anchor" : null],
			[sample.anchoredRaw, "memo-anchor"]] as const) {
			const label = `${version.sourceCommit.slice(0, 7)}/${sample.category}/${expectedId}`;
			const parsed = read(raw)[0];
			assert.equal(parsed.content, sample.content, label);
			assert.equal(parsed.time, "12:34:56", label);
			assert.equal(parsed.existingBlockId, expectedId, label);
			assert.equal(parsed.endLine, raw.split("\n").length - 1, label);
			const cooperative = await parser.parse({ sourcePath: parsed.sourcePath, logicalDate: parsed.logicalDate,
				bytes: Buffer.from(raw) }, { maxLinesPerSlice: 1, yieldControl: async () => {} });
			assert.deepEqual(cooperative.observations, [{ ...parsed, sourceRevision: cooperative.sourceRevision }], label);
		}
	}
});

test("两列独立时间头识别合法 ID，首段 ID 只移除 token 和一个分隔空格", () => {
	for (const raw of ["- 09:04 ^quote-of-the-day\n  > quote", "-   09:04 ^quote-of-the-day\n\t> quote"]) {
		const memo = read(raw)[0];
		assert.equal(memo.content, "> quote");
		assert.equal(memo.existingBlockId, "quote-of-the-day");
	}
	for (const prefix of ["- 09:05 first\n  ", "-   09:05 first\n\t"]) {
		const memo = read(prefix + "second   ^Memo-1 \t")[0];
		assert.equal(memo.content, "first\nsecond   \t");
		assert.equal(memo.existingBlockId, "Memo-1");
	}
});

test("子块 ID 原文保留，首段优先，伪 ID 与非法 token 不从正文剥离", () => {
	for (const [raw, body, id] of [
		["- 09:06 intro\n  \n  - child ^child-anchor \t", "intro\n\n- child ^child-anchor \t", "child-anchor"],
		["- 09:06 intro ^main\n  \n  - child ^child-anchor", "intro\n\n- child ^child-anchor", "main"],
		["- 09:06 intro\n  ```md\n  code ^pseudo", "intro\n```md\ncode ^pseudo", null],
		["- 09:06 text ^invalid_id", "text ^invalid_id", null],
		["- 09:06 text \\^escaped", "text \\^escaped", null],
		["- 09:06 %% hidden ^comment", "%% hidden ^comment", null],
		["- 09:06 `code ^pseudo", "`code", "pseudo"],
		["- 09:06 `code ^pseudo`", "`code ^pseudo`", null],
	] as const) {
		const memo = read(raw)[0];
		assert.equal(memo.content, body);
		assert.equal(memo.existingBlockId, id);
	}
});

test("裸空行仍结束 occurrence，缩进空行及围栏中的伪时间仍按历史范围读取", () => {
	for (const outside of ["  outside", "      code", "- 11:00 next", "# Heading", "ordinary", "- list", ""]) {
		const raw = "- 10:00 body\n\n" + outside;
		assert.equal(read(raw)[0].content, "body");
		assert.equal(read(raw)[0].endLine, 0);
	}
	assert.equal(read("- 10:00\n  ```md\n  - 11:00 fake\n  ```\n  \n  ")[0].content,
		"```md\n- 11:00 fake\n```\n\n");
});

test("正文仅含 ID token 的新建不吞正文，连续保存不增加空行", () => {
	for (const body of ["^abc123", "^quote-of-the-day", "^abc123 \t", "^abc123\ncontinued", "\\^abc123", "text ^my-id",
		"text ^my-id\n\n- child"]) {
		let raw = writer.buildMemoBlock(body, "09:00");
		for (let save = 0; save < 3; save++) {
			assert.equal(read(raw)[0]?.content, body);
			const next = writer.buildMemoBlock(read(raw)[0].content, "09:00");
			assert.equal(next, raw);
			raw = next;
		}
	}
});

test("序列化意外丢失、重复或移动隐式锚点时拒绝输出", () => {
	const source = read("- 09:00 intro ^main\n  \n  - child ^child")[0];
	for (const broken of ["- 09:00 intro\n  \n  - child ^child", "- 09:00 intro ^main\n  \n  - child ^child\n  \n  duplicate ^main",
		"- 09:00 intro\n  \n  - child ^child\n  \n  ^main"]) {
		const brokenWriter = new MarkdownBlockService();
		(brokenWriter as unknown as { build: () => string }).build = () => broken;
		assert.throws(() => brokenWriter.serializeObservation(source), /preserving the existing block reference/u);
	}
});

test("hash 使用解码正文，不再次剥离可见首段、子块、代码、注释或非法 token", () => {
	assert.equal(read("- 09:00 first\n  last   ^memo \t")[0].contentHash, hashMemoContent("first\nlast   \t"));
	assert.equal(read("- 09:00 text ^visible ^main")[0].contentHash, hashMemoContent("text ^visible"));
	for (const body of ["text ^visible", "\ntext ^child", "intro\n\n- child ^child", "```md\ncode ^code", "%%\nhidden ^comment", "text ^bad_id"]) {
		assert.notEqual(hashMemoContent(body), hashMemoContent(body.replace(/\^[A-Za-z0-9_-]+/u, "^changed")), body);
	}
});

test("语法必要边界分别验收块类型，表格解析差异单独保留", () => {
	for (const [body, tag] of [["    code", "pre"], ["Title\n===", "h1"], ["3. first\n4. second", "ol"],
		["---", "hr"], ["<custom>\nbody\n</custom>", "custom"]] as const) {
		const raw = writer.buildMemoBlock(body, "09:00");
		assert.ok(raw.startsWith("-   09:00\n\t\n"));
		assert.match(markdown.render(raw), new RegExp(`<${tag}(?:>| )`, "u"));
		assert.doesNotMatch(markdown.render(raw), /<h[12]>09:00/u);
		assert.equal(read(raw)[0].content, body);
	}
	const table = "- 09:00\n  | A | B |\n  | --- | --- |\n  | C | D |";
	assert.match(markdown.render(table), /<table>/u);
});

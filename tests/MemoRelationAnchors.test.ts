import assert from "node:assert/strict";
import test from "node:test";
import { DiaryMemoParser } from "../src/services/DiaryMemoParser";
import { MarkdownBlockService } from "../src/services/MarkdownBlockService";
import { collectRelationBlockAnchors } from "../src/utils/memoRelations";

const parser = new DiaryMemoParser();
const cases: Array<[string, string, string | null]> = [
	["单行", "- 10:00 text ^memo", "memo"],
	["连续段落", "- 10:00 first\n  last ^memo", "memo"],
	["Tab 续行", "- 10:00 first\n\tlast ^memo", "memo"],
	["首段后有子块 ID", "- 10:00 first\n  last ^memo\n  - child ^child", "memo"],
	["首段后有其他段落 ID", "- 10:00 first\n  last ^memo\n  \n  second ^child", "memo"],
	["独立注释后的末段兼容", "- 10:00 first\n  %% hidden %%\n  last ^memo", "memo"],
	["首段内联代码不制造段落边界", "- 10:00 first\n  `hidden`\n  last ^memo", "memo"],
	["两空格独占锚点", "- 10:00 first\n  \n  ^memo", "memo"],
	["Tab 独占锚点", "- 10:00 first\n\t\n\t^memo", "memo"],
	["混合内容后独占锚点", "- 10:00 first\n\t- child\n\t\n\t^memo", "memo"],
	["混合缩进子列表末段兼容", "- 10:00 first\n  - child\n  \n\t^memo", "memo"],
	["首行锚点保留", "- 10:00 first ^memo\n  - child ^child", "memo"],
	["首行非段末 ID", "- 10:00 first ^memo\n  more text", null],
	["后续段落末行兼容", "- 10:00 first\n  \n  last ^memo", "memo"],
	["无序列表末项", "- 10:00\n  - first\n  - last ^memo", "memo"],
	["有序列表末项", "- 10:00\n  1. first\n  2. last ^memo", "memo"],
	["任务列表末项", "- 10:00\n  - [ ] first\n  - [x] last ^memo", "memo"],
	["嵌套列表末项", "- 10:00\n  - parent\n    - child ^memo", "memo"],
	["子列表独占锚点", "- 10:00 first\n  - child\n    \n    ^memo", "memo"],
	["末项续行", "- 10:00 first\n\t- child\n\t  continuation ^memo", "memo"],
	["Tab 嵌套有序任务末项", "- 10:00 first\n\t- parent\n\t  1. [x] last ^memo", "memo"],
	["混合内容回到末段", "- 10:00 first\n  > quote\n  \n  last ^memo", "memo"],
	["非末项的 ID 不兼容", "- 10:00 first\n  - child ^internal\n  - last", null],
	["末项 ID 后还有正文", "- 10:00 first\n  - child ^internal\n  \n  last", null],
	["末项 ID 后还有注释", "- 10:00 first\n  - child ^internal\n  <!-- tail -->", null],
	["末项 ID 后还有代码", "- 10:00 first\n  - child ^internal\n  ```\n  code\n  ```", null],
	["正常 Memo 级锚点优先于末项", "- 10:00 first ^memo\n  - last ^terminal", "memo"],
	["引用块末行", "- 10:00 first\n  > quote ^memo", null],
	["历史单行引用符号实际仍在时间段落", "- 10:00 > quote ^memo", "memo"],
	["历史多行引用块", "- 10:00 > first\n  > last ^memo", null],
	["Callout 末行", "- 10:00 first\n  > [!note]\n  > text ^memo", null],
	["历史 Callout", "- 10:00 > [!note]\n  > text ^memo", null],
	["代码内容", "- 10:00 first\n  ```md\n  text ^memo\n  ```", null],
	["代码围栏末行", "- 10:00 first\n  ```md\n  text\n  ``` ^memo", null],
	["历史代码围栏末行", "- 10:00 ```md\n  text\n  ``` ^memo", null],
	["缩进代码", "- 10:00 first\n  \n      code ^memo", null],
	["表格末行", "- 10:00 first\n  \n  | a |\n  | - |\n  | b | ^memo", null],
	["历史管线文本未构成原生表格", "- 10:00 | a |\n  | - |\n  | b | ^memo", "memo"],
	["内部标题", "- 10:00 first\n  # heading ^memo", null],
	["混合内容末项兼容", "- 10:00 first\n  \n  second\n  - [ ] task ^memo", "memo"],
	["内联代码中的 ID", "- 10:00 `^memo`", null],
	["代码在 ID 后", "- 10:00 text ^memo `tail`", null],
	["注释在 ID 后", "- 10:00 text ^memo %% tail %%", null],
	["HTML 注释在 ID 后", "- 10:00 text ^memo <!-- tail -->", null],
	["转义 ID", "- 10:00 text \\^memo", null],
	["下划线不是原生 ID", "- 10:00 text ^memo_id", null],
	["中文不是原生 ID", "- 10:00 text ^引用", null],
	["末项无效 ID", "- 10:00 first\n  - child ^memo_id", null],
	["末项转义 ID", "- 10:00 first\n  - child \\^memo", null],
	["末项内联代码 ID", "- 10:00 first\n  - child `^memo`", null],
	["末项代码在 ID 后", "- 10:00 first\n  - child ^memo `tail`", null],
	["引用块内的末项", "- 10:00 first\n  > - child ^memo", null],
	["Callout 内的末项", "- 10:00 first\n  > [!note]\n  > - child ^memo", null],
	["结构引用后的独占末段", "- 10:00 first\n  > quote\n  \n  ^memo", "memo"],
	["表格后的独占末段", "- 10:00 first\n  \n  | a |\n  | - |\n  | b |\n  \n  ^memo", "memo"],
	["公式末行不能按普通段落提升", "- 10:00 first\n  \n  $$\n  x + y\n  $$ ^memo", null],
	["未闭合公式内的 ID", "- 10:00 first\n  \n  $$\n  x ^memo", null],
	["脚注定义末行不能按普通段落提升", "- 10:00 first\n  \n  [^f]: footnote ^memo", null],
	["公式后普通末段兼容", "- 10:00 first\n  \n  $$\n  x + y\n  $$\n  \n  last ^memo", "memo"],
	["保留原生 ID 大小写与连字符", "- 10:00 first\n  - child ^Memo-1", "Memo-1"],
	["公式前正常时间行锚点", "-   10:00 ^memo\n\t$$\n\tx + y\n\t$$", "memo"],
	["脚注前正常时间行锚点", "-   10:00 ^memo\n\t\n\t[^f]: footnote", "memo"],
];

for (const [name, content, expected] of cases) test(`关联锚点：${name}`, async () => {
	const input = { sourcePath: "Daily/2026-11-02.md", logicalDate: "2026-11-02", bytes: Buffer.from(content + "\n") };
	const result = await parser.parse(input);
	assert.equal(result.observations.length, 1);
	assert.equal(result.observations[0].relationBlockId, expected);
	assert.deepEqual(await parser.parse(input, { maxLinesPerSlice: 1, yieldControl: async () => {} }), result);
});

test("用户实际旧版 Tab 列表样例恢复关系锚点，分钟秒精度及任务正文解析保持原样", async () => {
	const content = [
		"- 10:50:45 赚不到钱的表现（做成的反愿景）：",
		"\t- 看啥都是机会，看啥又赚不到钱，注意力游离又没有行动。",
		"\t- 精力分散。",
		"\t- 爱打退堂鼓。",
		"\t- 玻璃心，容易情绪内耗，而不是把时间精力花在行动上。",
		"\t- 分不清矛盾主次。  ^no1wu1",
	].join("\n");
	for (const ending of ["", "\n\t\n  ", "\r\n\t\r\n  "]) {
		const raw = ending.startsWith("\r") ? content.replace(/\n/gu, "\r\n") : content;
		const result = await parser.parse({ sourcePath: "A.md", logicalDate: "2026-11-02", bytes: Buffer.from(raw + ending) });
		const memo = result.observations[0];
		assert.equal(memo.relationBlockId, "no1wu1");
		assert.equal(memo.existingBlockId, "no1wu1");
		assert.equal(memo.time, "10:50:45");
		assert.equal(result.blockAnchors!.no1wu1, 1);
		assert.deepEqual(memo.tasks, []);
		assert.match(memo.content, /- 分不清矛盾主次。/u);
	}
});

test("原文行尾及可见性决定锚点计数，遮罩不制造 ID 或重复", () => {
	const content = "- 10:00 real ^memo\n- 11:00 text ^memo `tail`\n- 12:00 text ^memo %% tail %%\n"
		+ "- 13:00 `^code`\n- 14:00 \\^escaped\n- 15:00 text ^invalid_id\n"
		+ "outside ^memo\n> quote ^quote\n<!-- text ^comment -->\n";
	assert.deepEqual({ ...collectRelationBlockAnchors(content) }, { memo: 2, quote: 1 });
});

test("当前创建器的 Memo 级锚点不受正文结构影响，内部子块 ID 不替代主锚点", async () => {
	const writer = new MarkdownBlockService();
	for (const body of ["one", "first\nsecond", "first\n\nlast", "- first\n- last ^child", "1. first\n2. last",
		"- [ ] task\n  - nested", "> quote", "> [!note]\n> text", "```md\ncode\n```", "| a |\n| - |\n| b |", "# heading\n\n- list",
		"$$\nx + y\n$$", "[^f]: footnote"]) {
		const raw = writer.buildMemoBlockWithBlockId(body, "10:00", "memo");
		const result = await parser.parse({ sourcePath: "A.md", logicalDate: "2026-11-02", bytes: Buffer.from(raw) });
		assert.equal(result.observations[0].relationBlockId, "memo", body);
		assert.equal(result.observations[0].content, body, body);
	}
});

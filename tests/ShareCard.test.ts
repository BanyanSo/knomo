import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createCardMemo } from "./helpers/memoCardFixture";
import { isCjkMemoContent } from "../src/ui/KnomoCardMetadata";
import { createShareCardSnapshot, getShareCardImagePaths, renderShareCard, ShareCardError, shareCardTokens } from "../src/ui/share/ShareCardContent";
import { SHARE_CARD_TEMPLATES } from "../src/ui/share/ShareCardTemplates";
import { ShareCardSession } from "../src/ui/share/ShareCardSession";
import { checkShareCardDimensions } from "../src/ui/share/ShareCardRenderer";
import { getShareCardCapabilities, outputShareCard, shareCardFile } from "../src/ui/share/ShareCardOutput";
import { shareCardImageDimensions } from "../src/ui/share/ShareCardImageDimensions";
import { zhCN } from "../src/i18n/zh-CN";
import { en } from "../src/i18n/en";

const memo = (content: string, time = "08:30") => createCardMemo({ contentSnapshot: content, createdAt: "2026-10-27T" + time });
const tick = () => new Promise(resolve => setImmediate(resolve));

test("template names and content/date order distinguish the four layouts without inventing headings", () => {
	assert.deepEqual(SHARE_CARD_TEMPLATES.map(template => [zhCN[`share.${template.id}`], en[`share.${template.id}`]]),
		[["素页", "Paper"], ["日序", "Daybook"], ["观照", "Reflection"], ["墨夜", "Midnight"]]);
	const snapshot = createShareCardSnapshot(memo("第一句保持普通正文。\n原有换行。\n\n第二段只有 **这里加粗**。"), "zh-CN");
	for (const template of SHARE_CARD_TEMPLATES) {
		const card = renderShareCard(new JSDOM().window.document, snapshot, template.id, new Map(), "data:image/png;base64,AA==");
		const expected = template.id === "midnight" ? ["meta midnight-time", "content", "share-brand"]
			: template.id === "reflection" ? ["hero", "content", "meta reflection-time", "share-brand"]
			: template.id === "daybook" ? ["date-head", "content", "share-brand"] : ["meta paper-time", "content", "share-brand"];
		assert.deepEqual(Array.from(card.children, el => el.className), expected);
		assert.equal(card.querySelectorAll(".content > p").length, 2);
		assert.equal(card.querySelectorAll(".content br").length, 1);
		assert.equal(card.querySelector(".content strong")!.textContent, "这里加粗");
		assert.equal(card.querySelectorAll(".content strong").length, 1);
		assert.equal(card.querySelectorAll("h1,h2,h3,h4,h5,h6").length, 0);
	}
});

test("export names use frozen Memo date and precision, including minute-only and midnight records", () => {
	for (const [createdAt, expected] of [
		["2026-10-27T14:30:25", "Knomo-20261027-143025.png"],
		["2026-10-27T08:30", "Knomo-20261027-083000.png"],
		["2024-02-29T00:00", "Knomo-20240229-000000.png"],
		["2024-12-31T23:59:59", "Knomo-20241231-235959.png"],
	]) {
		const selected = { ...memo("正文"), createdAt };
		const snapshot = createShareCardSnapshot(selected, "zh-CN");
		selected.createdAt = "2030-01-01T12:00:00";
		assert.equal(snapshot.time, createdAt.slice(11));
		assert.equal(shareCardFile(new Blob(["same PNG"]), snapshot, { File } as unknown as Window).name, expected);
	}
});

test("highlighted reference links and images keep the outer reference definitions", () => {
	const snapshot = createShareCardSnapshot(memo("==[标签][link] 和 ![图片][image]==\n\n[link]: https://example.test\n[image]: photo.png"), "en");
	assert.deepEqual(getShareCardImagePaths(snapshot), ["photo.png"]);
	const card = renderShareCard(new JSDOM().window.document, snapshot, "paper", new Map([["photo.png", "data:image/png;base64,AA=="]]));
	assert.equal(card.querySelector("mark .link")!.textContent, "标签");
	assert.equal(card.querySelectorAll("mark img").length, 1);
	assert.ok(!card.textContent!.includes("[image]"));
});

test("escaped dollar text remains literal while actual formulas still fail closed", () => {
	for (const text of [String.raw`Literal \$x\$`, String.raw`==Literal \$x\$==`, String.raw`**\$\$**`, "&#36;x&#36;", "`$x$`", "```txt\n$x$\n``` "]) {
		const snapshot = createShareCardSnapshot(memo(text), "en");
		const card = renderShareCard(new JSDOM().window.document, snapshot, "paper", new Map());
		assert.match(card.querySelector(".content")!.textContent!, /\$/u);
	}
	for (const text of ["$x$", "$$x$$", "==$x$==", "**$x$**", String.raw`$\alpha$`, String.raw`==$\frac{a}{b}$==`, String.raw`$\$x$`]) assert.throws(() => shareCardTokens(text), error => error instanceof ShareCardError && error.kind === "math");
});

test("callout titles end before body lines and preserve explicit inline formatting", () => {
	for (const marker of ["[!note] Title", "[!note]- **Title**", "[!note]+ *Title*"]) {
		const card = renderShareCard(new JSDOM().window.document, createShareCardSnapshot(memo(`> ${marker}\n> Body **strong**\n> Next line\n>\n> Last paragraph`), "en"), "paper", new Map());
		const callout = card.querySelector(".callout")!;
		assert.equal(callout.querySelector(".callout-title")!.textContent, "Title");
		assert.equal(callout.querySelectorAll(":scope > p").length, 3);
		assert.equal(callout.children[1].textContent, "Body strongNext line");
		assert.equal(callout.children[1].querySelector("strong")!.textContent, "strong");
		assert.equal(callout.children[1].querySelectorAll("br").length, 1);
		assert.equal(callout.lastElementChild!.textContent, "Last paragraph");
	}
});

test("share alignment follows card language detection for Chinese, mixed and English content", () => {
	for (const text of ["中文正文排版与卡片保持一致。", "中文与 English 混排也沿用卡片现有对齐规则。", "A mostly English Memo with 中文 and a readable ending.", "短文"]) {
		const snapshot = createShareCardSnapshot(memo(text), "en");
		assert.equal(snapshot.isCjkContent, isCjkMemoContent(text));
		for (const template of SHARE_CARD_TEMPLATES) {
			const card = renderShareCard(new JSDOM().window.document, snapshot, template.id, new Map(), "data:image/png;base64,AA==");
			assert.equal(card.classList.contains("is-cjk-content"), isCjkMemoContent(text));
		}
	}
});

test("four templates preserve full ordered content, repeated images, nested images and literal code", () => {
	const text = "开头 Knomo **粗体** *斜体* ~~删除~~ ==高亮== #标签 [[笔记|可读别名]] [链接](note.pdf)\n\n![第一张](a.png)\n\n中间文字\n\n> 引用\n> ![[b.png]]\n\n- [x] 已完成\n- [ ] 待办\n\n![重复图片](a.png)\n\n```js\n![[代码不是嵌入]]\n```\n\n| 列一 | 列二 |\n| --- | --- |\n| 完整一 | 完整二 |";
	const snapshot = createShareCardSnapshot(memo(text), "zh-CN");
	assert.deepEqual(getShareCardImagePaths(snapshot), ["a.png", "b.png", "a.png"]);
	const contents = SHARE_CARD_TEMPLATES.map(template => {
		const doc = new JSDOM().window.document;
		const card = renderShareCard(doc, snapshot, template.id, new Map([["a.png", "data:image/png;base64,AA=="], ["b.png", "data:image/png;base64,AA=="]]), "data:image/png;base64,AA==");
		const body = card.querySelector(".content")!;
		assert.equal(card.querySelectorAll(".share-brand").length, 1);
		assert.equal(card.lastElementChild!.className, "share-brand");
		assert.equal(card.lastElementChild!.textContent, "Knomo");
		assert.equal(card.lastElementChild!.childElementCount, 0);
		assert.equal(body.textContent!.match(/Knomo/gu)?.length, 1, "正文中的品牌文字不与模板标志去重");
		assert.equal(body.querySelectorAll("img").length, 3);
		assert.equal(card.querySelectorAll(".hero").length, template.id === "reflection" ? 1 : 0);
		assert.equal(body.querySelectorAll("blockquote img").length, 1);
		assert.equal(body.querySelectorAll("input,button,iframe,a,script").length, 0);
		assert.equal(body.querySelector("mark")!.textContent, "高亮");
		assert.deepEqual(Array.from(body.querySelectorAll(".task"), el => el.textContent), ["☑", "☐"]);
		assert.equal(body.querySelector("code")!.textContent, "![[代码不是嵌入]]\n");
		assert.equal(body.querySelectorAll("td").length, 2);
		assert.ok(body.textContent!.includes("可读别名 链接"));
		assert.ok(!body.textContent!.includes("note.pdf"));
		return body.textContent;
	});
	assert.equal(new Set(contents).size, 1);
});

test("source metadata is excluded, user repeated body links are not deduplicated", () => {
	const snapshot = createShareCardSnapshot(memo("引用 [[Daily/2026-10-26#^block|原记录]]\n> 原文"), "zh-CN");
	const card = renderShareCard(new JSDOM().window.document, snapshot, "paper", new Map());
	assert.equal(card.querySelector(".source"), null);
	assert.ok(!card.textContent!.includes("原记录"));
	assert.ok(!("source" in snapshot));
	const excluded = createShareCardSnapshot(memo("正文\n![[missing.png#^block|$x$]]"), "en");
	assert.deepEqual(getShareCardImagePaths(excluded), []);
	assert.equal(renderShareCard(new JSDOM().window.document, excluded, "paper", new Map()).querySelector(".content")!.textContent, "正文");
	const repeated = createShareCardSnapshot(memo("[[笔记|同文]] 和 [[笔记|同文]]"), "en");
	assert.equal(renderShareCard(new JSDOM().window.document, repeated, "paper", new Map()).textContent!.match(/同文/gu)?.length, 2);
});

test("snapshot freezes actual date, original time precision and content without displaying recorded time", () => {
	for (const time of ["08:30", "08:30:42"]) {
		const selected = memo("原始全文", time); const snapshot = createShareCardSnapshot(selected, "zh-CN");
		selected.contentSnapshot = "后续修改";
		const card = renderShareCard(new JSDOM().window.document, snapshot, "daybook", new Map());
		assert.equal(snapshot.date, "2026-10-27"); assert.equal(snapshot.time, time); assert.ok(!card.textContent!.includes(time)); assert.match(snapshot.weekday, /二/u);
		assert.ok(card.textContent!.includes("原始全文")); assert.ok(!card.textContent!.includes("后续修改"));
		assert.equal(card.querySelectorAll(".date-head").length, 1); assert.equal(card.querySelectorAll(".source").length, 0);
	}
	assert.throws(() => createShareCardSnapshot({ ...memo("x"), createdAt: "2026-02-30T12:00" }, "en"), ShareCardError);
});

test("callouts expand while unsupported dynamic content and HTML fail closed; regular PDF links remain readable", () => {
	for (const body of ["```dataview\nLIST\n```", "<img src=x onerror=alert(1)>", "$$a+b$$", "[^note]: test"]) assert.throws(() => shareCardTokens(body), ShareCardError);
	const card = renderShareCard(new JSDOM().window.document, createShareCardSnapshot(memo("> [!note]- 说明\n> 完整折叠内容\n\n[PDF](file.pdf)"), "en"), "paper", new Map());
	assert.ok(card.querySelector(".callout")!.textContent!.includes("完整折叠内容"));
	assert.ok(card.textContent!.includes("PDF")); assert.equal(card.querySelectorAll("details,input").length, 0);
	assert.doesNotThrow(() => shareCardTokens("Lunch $5 and taxi $10. A literal [^undefined] remains text."));
});

test("missing resources and image dimensions fail without producing partial output", () => {
	const snapshot = createShareCardSnapshot(memo("文字 ![[missing.png]] 后续文字"), "en");
	assert.throws(() => renderShareCard(new JSDOM().window.document, snapshot, "paper", new Map()), ShareCardError);
	checkShareCardDimensions(780, 10000, true);
	for (const dims of [[780, 17000], [780, 16000], [0, 1], [NaN, 10]]) assert.throws(() => checkShareCardDimensions(dims[0], dims[1], true), ShareCardError);
});

test("compressed PNG/GIF/JPEG headers are checked before bitmap allocation", () => {
	const png = new Uint8Array(24); png.set([137, 80, 78, 71, 13, 10, 26, 10]);
	new DataView(png.buffer).setUint32(16, 100_000); new DataView(png.buffer).setUint32(20, 100_000);
	assert.deepEqual(shareCardImageDimensions(png), [100_000, 100_000]);
	const gif = new Uint8Array([71, 73, 70, 56, 57, 97, 88, 2, 64, 1]);
	assert.deepEqual(shareCardImageDimensions(gif), [600, 320]);
	const jpeg = new Uint8Array([255, 216, 255, 192, 0, 17, 8, 1, 64, 2, 88, 3]);
	assert.deepEqual(shareCardImageDimensions(jpeg), [600, 320]);
	assert.equal(shareCardImageDimensions(new Uint8Array([1, 2])), null);
});

test("rapid template switches publish only latest result, serialize encoding and survive retry", async () => {
	const completed: string[] = []; const errors: unknown[] = []; let release!: () => void; let renders = 0;
	const session = new ShareCardSession(async template => { renders++; if (renders === 1) await new Promise<void>(resolve => { release = resolve; }); return template; }, value => completed.push(value), error => errors.push(error));
	session.select("paper"); session.select("reflection"); session.select("daybook");
	assert.equal(renders, 1); release(); await tick();
	assert.deepEqual(completed, ["daybook"]); assert.equal(renders, 2); assert.equal(errors.length, 0);
	let fail = true;
	const retry = new ShareCardSession(async () => { if (fail) throw new Error("encode"); return "ready"; }, value => completed.push(value), error => errors.push(error));
	retry.select("paper"); await tick(); assert.equal(errors.length, 1);
	fail = false; retry.select("paper"); await tick(); assert.equal(completed.at(-1), "ready");
});

test("closing suppresses pending publication and failures", async () => {
	for (const fail of [false, true]) {
		let finish!: () => void; const results: unknown[] = [];
		const session = new ShareCardSession(async () => { await new Promise<void>(resolve => { finish = resolve; }); if (fail) throw Error("closed"); return "late"; }, value => results.push(value), error => results.push(error));
		session.select("paper"); session.close(); finish(); await tick(); session.select("reflection");
		assert.deepEqual(results, []);
	}
});

test("output capability detection and click-stack dispatch use PNG files, never text or automatic Vault writes", async () => {
	const calls: string[] = [];
	class Item { static supports(type: string) { return type === "image/png"; } constructor(readonly value: unknown) {} }
	const win = { File, ClipboardItem: Item, navigator: { canShare: ({ files }: { files: File[] }) => files[0].type === "image/png", share: () => { calls.push("share"); return Promise.resolve(); }, clipboard: { write: () => { calls.push("copy"); return Promise.resolve(); } } } } as unknown as Window;
	assert.deepEqual(getShareCardCapabilities(win, true), { share: true, copy: true, save: false });
	const file = new File(["png"], "Knomo-20261027-083000.png", { type: "image/png" });
	const sharing = outputShareCard("share", file, win); assert.deepEqual(calls, ["share"]); await sharing;
	await outputShareCard("copy", file, win); assert.deepEqual(calls, ["share", "copy"]);
	const blocked = { File, navigator: { canShare: () => { throw Error("denied"); }, share() {} } } as unknown as Window;
	assert.deepEqual(getShareCardCapabilities(blocked, true), { share: false, copy: false, save: false });
});

test("ordinary templates show date only while filenames retain the recorded time", () => {
	const snapshot = createShareCardSnapshot(memo("正文 08:30 #标签 引用来源 [[笔记|中间链接]] 后文", "08:30:42"), "en");
	for (const template of ["paper", "midnight", "reflection"] as const) {
		const card = renderShareCard(new JSDOM().window.document, snapshot, template, new Map(), "data:image/png;base64,AA==");
		assert.equal(card.querySelector(".meta")!.textContent, "2026/10/27");
		assert.ok(card.querySelector(".content")!.textContent!.includes("08:30 #标签 引用来源 中间链接 后文"));
	}
	assert.equal(shareCardFile(new Blob(["png"]), snapshot, { File } as unknown as Window).name, "Knomo-20261027-083042.png");
	assert.throws(() => renderShareCard(new JSDOM().window.document, snapshot, "reflection", new Map()), /cover/u);
	const end = createShareCardSnapshot({ ...memo("月末"), createdAt: "2024-02-29T23:59:59" }, "en");
	assert.equal(end.date, "2024-02-29"); assert.equal(end.weekday, "Thursday");
});

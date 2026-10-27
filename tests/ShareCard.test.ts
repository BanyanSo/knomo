import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createCardMemo } from "./helpers/memoCardFixture";
import { createShareCardSnapshot, getShareCardImagePaths, renderShareCard, ShareCardError, shareCardTokens } from "../src/ui/share/ShareCardContent";
import { SHARE_CARD_TEMPLATES } from "../src/ui/share/ShareCardTemplates";
import { ShareCardSession } from "../src/ui/share/ShareCardSession";
import { checkShareCardDimensions } from "../src/ui/share/ShareCardRenderer";
import { getShareCardCapabilities, outputShareCard } from "../src/ui/share/ShareCardOutput";
import { shareCardImageDimensions } from "../src/ui/share/ShareCardImageDimensions";

const memo = (content: string, time = "08:30") => createCardMemo({ contentSnapshot: content, createdAt: "2026-10-27T" + time });
const tick = () => new Promise(resolve => setImmediate(resolve));

test("three templates preserve full ordered content, repeated images, nested images and literal code", () => {
	const text = "开头 Knomo **粗体** *斜体* ~~删除~~ ==高亮== #标签 [[笔记|可读别名]] [链接](note.pdf)\n\n![第一张](a.png)\n\n中间文字\n\n> 引用\n> ![[b.png]]\n\n- [x] 已完成\n- [ ] 待办\n\n![重复图片](a.png)\n\n```js\n![[代码不是嵌入]]\n```\n\n| 列一 | 列二 |\n| --- | --- |\n| 完整一 | 完整二 |";
	const snapshot = createShareCardSnapshot(memo(text), "zh-CN");
	assert.deepEqual(getShareCardImagePaths(snapshot), ["a.png", "b.png", "a.png"]);
	const contents = SHARE_CARD_TEMPLATES.map(template => {
		const doc = new JSDOM().window.document;
		const card = renderShareCard(doc, snapshot, template.id, new Map([["a.png", "data:image/png;base64,AA=="], ["b.png", "data:image/png;base64,AA=="]]));
		const body = card.querySelector(".content")!;
		assert.equal(card.querySelectorAll(".share-brand").length, 1);
		assert.equal(card.lastElementChild!.className, "share-brand");
		assert.equal(card.lastElementChild!.textContent, "Knomo");
		assert.equal(card.lastElementChild!.childElementCount, 0);
		assert.equal(body.textContent!.match(/Knomo/gu)?.length, 1, "正文中的品牌文字不与模板标志去重");
		assert.equal(card.querySelectorAll("img").length, 3);
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

test("source metadata appears once, user repeated source links are not deduplicated", () => {
	const snapshot = createShareCardSnapshot(memo("引用 [[Daily/2026-10-26#^block|原记录]]\n> 原文"), "zh-CN");
	const card = renderShareCard(new JSDOM().window.document, snapshot, "paper", new Map());
	assert.equal(card.querySelector(".source")!.textContent, "原记录");
	assert.equal(card.textContent!.match(/原记录/gu)?.length, 1);
	const repeated = createShareCardSnapshot(memo("[[笔记|同文]] 和 [[笔记|同文]]"), "en");
	assert.equal(renderShareCard(new JSDOM().window.document, repeated, "paper", new Map()).textContent!.match(/同文/gu)?.length, 2);
});

test("snapshot freezes actual date, minute/second precision and content independently of source changes", () => {
	for (const time of ["08:30", "08:30:42"]) {
		const selected = memo("原始全文", time); const snapshot = createShareCardSnapshot(selected, "zh-CN");
		selected.contentSnapshot = "后续修改";
		const card = renderShareCard(new JSDOM().window.document, snapshot, "nocturne", new Map());
		assert.equal(snapshot.date, "2026-10-27"); assert.equal(snapshot.time, time); assert.match(snapshot.weekday, /二/u);
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
	session.select("paper"); session.select("editorial"); session.select("nocturne");
	assert.equal(renders, 1); release(); await tick();
	assert.deepEqual(completed, ["nocturne"]); assert.equal(renders, 2); assert.equal(errors.length, 0);
	let fail = true;
	const retry = new ShareCardSession(async () => { if (fail) throw new Error("encode"); return "ready"; }, value => completed.push(value), error => errors.push(error));
	retry.select("paper"); await tick(); assert.equal(errors.length, 1);
	fail = false; retry.select("paper"); await tick(); assert.equal(completed.at(-1), "ready");
});

test("closing suppresses pending publication and failures", async () => {
	for (const fail of [false, true]) {
		let finish!: () => void; const results: unknown[] = [];
		const session = new ShareCardSession(async () => { await new Promise<void>(resolve => { finish = resolve; }); if (fail) throw Error("closed"); return "late"; }, value => results.push(value), error => results.push(error));
		session.select("paper"); session.close(); finish(); await tick(); session.select("editorial");
		assert.deepEqual(results, []);
	}
});

test("output capability detection and click-stack dispatch use PNG files, never text or automatic Vault writes", async () => {
	const calls: string[] = [];
	class Item { static supports(type: string) { return type === "image/png"; } constructor(readonly value: unknown) {} }
	const win = { File, ClipboardItem: Item, navigator: { canShare: ({ files }: { files: File[] }) => files[0].type === "image/png", share: () => { calls.push("share"); return Promise.resolve(); }, clipboard: { write: () => { calls.push("copy"); return Promise.resolve(); } } } } as unknown as Window;
	assert.deepEqual(getShareCardCapabilities(win, true), { share: true, copy: true, save: false });
	const file = new File(["png"], "Memo-2026-10-27-0830.png", { type: "image/png" });
	const sharing = outputShareCard("share", file, win); assert.deepEqual(calls, ["share"]); await sharing;
	await outputShareCard("copy", file, win); assert.deepEqual(calls, ["share", "copy"]);
	const blocked = { File, navigator: { canShare: () => { throw Error("denied"); }, share() {} } } as unknown as Window;
	assert.deepEqual(getShareCardCapabilities(blocked, true), { share: false, copy: false, save: false });
});

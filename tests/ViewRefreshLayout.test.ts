import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { build } from "esbuild";
import type { Browser, Page } from "playwright";
import type * as Fixture from "./helpers/viewRefreshBrowserFixture";

declare global { interface Window { refreshFixture: typeof Fixture } }

async function browserFixture() {
	const bundle = await build({
		stdin: { contents: 'import * as fixture from "./tests/helpers/viewRefreshBrowserFixture"; window.refreshFixture = fixture; fixture.installDomHelpers();', resolveDir: process.cwd() },
		alias: { obsidian: path.resolve(".tmp/knomo-tests/node_modules/obsidian/index.js") },
		bundle: true, write: false, format: "iife", platform: "browser",
		loader: { ".png": "dataurl", ".jpg": "dataurl", ".webp": "dataurl" },
	});
	const { chromium } = require(process.env.KNOMO_LAYOUT_PLAYWRIGHT!) as typeof import("playwright");
	const browser: Browser = await chromium.launch({ headless: true, channel: process.env.KNOMO_LAYOUT_BROWSER || "chromium" });
	const page: Page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
	await page.setContent('<body class="theme-light"><main class="knomo-plugin is-layout-desktop-wide"><div id="flow" class="knomo-card-flow"></div></main></body>');
	await page.addStyleTag({ content: readFileSync("styles.css", "utf8") + `
		* { box-sizing: border-box; }
		body { margin:0; font:16px/1.5 Arial; --background-primary:white; --background-secondary:#eee;
			--text-normal:#222; --text-muted:#777; --font-text-size:16px; --font-ui-small:14px;
			--font-ui-medium:16px; --font-text:Arial; --font-interface:Arial; --size-4-2:8px; }
		main.knomo-plugin { display:block; width:700px; height:600px; }
		#flow { height:600px; width:700px; }
	` });
	await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
	return { page, close: () => browser.close() };
}

test("日期流与今日之外重复接纳新 Daily revision 时不累计滚动漂移", { skip: !process.env.KNOMO_LAYOUT_PLAYWRIGHT }, async () => {
	const h = await browserFixture();
	try {
		for (const mobile of [false, true]) for (const [review, recent, image] of [
			[false, true, true], [false, true, false], [true, false, true], [true, true, true], [true, false, false],
		]) for (const position of [0, 780, -1]) {
			const options = { review: review!, recent: recent!, image: image!, position, mobile };
			const result = await h.page.evaluate(options => window.refreshFixture.geometry(options), options);
			const first = result.samples[0]!;
			for (const sample of result.samples) {
				const evidence = JSON.stringify({ options, result });
				assert.ok(Math.abs(sample.scroll - first.scroll) <= 1, evidence);
				assert.ok(Math.abs(sample.height - first.height) <= 1, evidence);
				assert.equal(sample.anchor, first.anchor, evidence);
				assert.ok(Math.abs(sample.offset - first.offset) <= 1, evidence);
			}
			assert.equal(result.sameImage, true);
			assert.equal(result.loads, image ? 1 : 0);
		}
	} finally { await h.close(); }
});

test("浮标与关联当前记录接续已就绪图片，等待期间不缩回加载占位", { skip: !process.env.KNOMO_LAYOUT_PLAYWRIGHT }, async () => {
	const h = await browserFixture();
	try {
		for (const surface of ["buoy", "subject"] as const) {
			const result = await h.page.evaluate(surface => window.refreshFixture.surface(surface), surface);
			assert.ok(result.before.imageHeight > 96);
			for (const state of [result.waiting, result.after]) {
				assert.equal(state.sameImage, true, JSON.stringify({ surface, result }));
				assert.equal(state.loads, 1);
				assert.ok(Math.abs(state.imageHeight - result.before.imageHeight) <= 1);
				assert.ok(Math.abs(state.cardHeight - result.before.cardHeight) <= 1);
			}
			assert.equal(result.buttonMemo, result.memoId);
		}
	} finally { await h.close(); }
});

test("排队的下一帧滚动恢复不覆盖用户的新位置", { skip: !process.env.KNOMO_LAYOUT_PLAYWRIGHT }, async () => {
	const h = await browserFixture();
	try { assert.equal(await h.page.evaluate(() => window.refreshFixture.scrollRestoreRace()), 400); }
	finally { await h.close(); }
});

test("浮标与关联当前记录的正文未变时，延迟 Markdown 不收缩正文与来源引用", { skip: !process.env.KNOMO_LAYOUT_PLAYWRIGHT }, async () => {
	const h = await browserFixture();
	try {
		for (const surface of ["buoy", "subject"] as const) {
			const result = await h.page.evaluate(surface => window.refreshFixture.surface(surface, true), surface);
			assert.ok(Math.abs(result.waiting.cardHeight - result.before.cardHeight) <= 1, JSON.stringify({ surface, result }));
			assert.equal(result.waiting.sameImage, true);
		}
	} finally { await h.close(); }
});

test("关联窗口内引用者实际编辑时接续已就绪图片", { skip: !process.env.KNOMO_LAYOUT_PLAYWRIGHT }, async () => {
	const h = await browserFixture();
	try {
		const result = await h.page.evaluate(() => window.refreshFixture.referrerImages());
		assert.equal(result.sameImage, true, JSON.stringify(result));
		assert.equal(result.loads, 1);
		assert.ok(Math.abs(result.waiting - result.before) <= 1);
	} finally { await h.close(); }
});

test("浮标和关联图片资源变化正常重载或移除，相同 render key 重建仍可交接", { skip: !process.env.KNOMO_LAYOUT_PLAYWRIGHT }, async () => {
	const h = await browserFixture();
	try {
		for (const surface of ["buoy", "subject"] as const) for (const change of ["modified", "removed", "same-key"] as const) {
			const result = await h.page.evaluate(({ surface, change }) => window.refreshFixture.surface(surface, false, change), { surface, change });
			assert.equal(result.waiting.sameImage, change === "same-key", JSON.stringify({ surface, change, result }));
			assert.equal(result.after.loads, change === "modified" ? 2 : 1);
			if (change === "removed") assert.equal(result.after.imageHeight, 0);
		}
	} finally { await h.close(); }
});

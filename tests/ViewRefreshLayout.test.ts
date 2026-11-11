import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { build } from "esbuild";
import type { Browser, Page } from "playwright";
import type * as Fixture from "./helpers/viewRefreshBrowserFixture";

declare global { interface Window { refreshFixture: typeof Fixture } }

async function browserFixture(locale = "en") {
	const bundle = await build({
		stdin: { contents: `import { getLanguage } from "obsidian"; getLanguage.set(${JSON.stringify(locale)}); import("./tests/helpers/viewRefreshBrowserFixture").then(fixture => { window.refreshFixture = fixture; fixture.installDomHelpers(); });`, resolveDir: process.cwd() },
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
	await page.waitForFunction(() => !!window.refreshFixture);
	return { page, close: () => browser.close() };
}

test("普通列表与移动搜索的摘要保持中英文自然数字间距与换行，过渡只产生原句布局变化", { skip: !process.env.KNOMO_LAYOUT_PLAYWRIGHT }, async () => {
	const traces: unknown[] = [];
	for (const locale of ["en", "zh-CN"]) {
		const h = await browserFixture(locale);
		try {
			for (const mobile of [false, true]) for (const options of [
				{ width: 700, fontSize: 14, position: 0, count: 7 },
				{ width: 700, fontSize: 14, position: 400, count: 999999 },
				{ width: 320, fontSize: 14, position: 0, count: 12345 },
				{ width: 320, fontSize: 24, position: 400, count: 999999 },
				{ width: 245, fontSize: 24, position: 0, count: 999999 },
				{ width: 320, fontSize: 24, position: 400, count: null },
			]) {
				const result = await h.page.evaluate(options => window.refreshFixture.resultSummaryGeometry(options), { ...options, mobile });
				traces.push({ locale, mobile, options, result });
				const evidence = JSON.stringify({ locale, mobile, options, result });
				assert.equal(result.locale, locale, evidence);
				assert.equal(result.sameSummary, true, evidence); assert.equal(result.sameFixed, true, evidence);
				assert.equal(result.sameSlot, true, evidence); assert.equal(result.sameCard, true, evidence);
				assert.ok(result.countWidthError <= 1, evidence);
				const first = result.samples[0]!;
				for (const [index, sample] of result.samples.entries()) {
					const naturalHeight = (index < 4 ? result.pendingLayout : result.finalLayout).height;
					assert.ok(Math.abs(sample.height - naturalHeight) <= 1, evidence);
					const naturalShift = naturalHeight - result.pendingLayout.height;
					assert.ok(Math.abs(sample.offset - first.offset + sample.scroll - first.scroll - naturalShift) <= 1, evidence);
					assert.ok(sample.dots + sample.value >= 0.95 || options.count === null, evidence);
				}
				if (options.count !== null) assert.ok(result.samples.some(sample => sample.dots > 0 && sample.dots < 1 && sample.value > 0 && sample.value < 1), evidence);
				assert.ok(result.maxNaturalLayoutError <= 1, evidence);
				if (options.width === 320 && options.count === 12345) await h.page.screenshot({ path: `.tmp/result-summary-${locale}-${mobile ? "mobile" : "desktop"}.png` });
			}
			await h.page.emulateMedia({ reducedMotion: "reduce" });
			const reduced = await h.page.evaluate(() => window.refreshFixture.resultSummaryGeometry({ mobile: true, width: 320, fontSize: 24, position: 0, count: 12345 }));
			traces.push({ locale, reducedMotion: true, result: reduced });
			assert.equal(reduced.dotAnimation, "none"); assert.equal(reduced.revealAnimation, "none");
			assert.equal(reduced.samples.at(-1)!.value, 1); assert.equal(reduced.samples.at(-1)!.dots, 0);
		} finally {
			await h.close();
			writeFileSync(".tmp/result-summary-layout.json", JSON.stringify(traces, null, 2));
		}
	}
});

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

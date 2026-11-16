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
	// 本地安全来源提供与宿主一致的 Web Crypto；请求由测试直接响应，不访问服务端。
	await page.route("http://localhost/knomo-layout", route => route.fulfill({ contentType: "text/html", body: "" }));
	await page.goto("http://localhost/knomo-layout");
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

test("多页列表及浮标编辑可见卡片或上方长正文后，局部提交与后台接续保持阅读位置", { skip: !process.env.KNOMO_LAYOUT_PLAYWRIGHT }, async () => {
	const h = await browserFixture();
	try {
		for (const surface of ["feed", "buoy"] as const) for (const mobile of [false, true]) for (const editAbove of [false, true]) for (const external of [false, true]) {
			const options = { surface, mobile, editAbove, external };
			const result = await h.page.evaluate(options => window.refreshFixture.pagedEditGeometry(options), options);
			const first = result.samples[0]!, evidence = JSON.stringify({ options, result });
			for (const sample of result.samples) {
				assert.equal(sample.count, first.count, evidence);
				assert.equal(sample.anchor, first.anchor, evidence);
				assert.ok(Math.abs(sample.offset - first.offset) <= 1, evidence);
			}
		}
	} finally { await h.close(); }
});

test("普通列表保留 A 的只读画面时更新上方 B，重建仍保留 A 的阅读位置和图片，换范围释放", { skip: !process.env.KNOMO_LAYOUT_PLAYWRIGHT }, async () => {
	const h = await browserFixture();
	try {
		for (const mobile of [false, true]) {
			const result = await h.page.evaluate(mobile => window.refreshFixture.pagedEditGeometry({ surface: "feed", mobile, editAbove: true, readonlySource: true }), mobile);
			const first = result.samples[0]!, evidence = JSON.stringify({ mobile, result });
			assert.equal(result.updated, true, evidence);
			assert.equal(result.readonlyCount, 90, evidence);
			assert.equal(result.sameReadonlyCard, true, evidence); assert.equal(result.sameImage, true, evidence);
			assert.equal(result.releasedOnScopeChange, true, evidence);
			for (const sample of result.samples) {
				assert.equal(sample.count, first.count, evidence); assert.equal(sample.anchor, first.anchor, evidence);
				assert.ok(Math.abs(sample.offset - first.offset) <= 1, evidence);
			}
		}
	} finally { await h.close(); }
});

test("真实被引用关系重查分别保留数据深度、挂载数量和屏上卡片，再沿新游标翻页", { skip: !process.env.KNOMO_LAYOUT_PLAYWRIGHT }, async () => {
	const h = await browserFixture();
	try {
		for (const mobile of [false, true]) for (const position of [0, 70, 140]) {
			const result = await h.page.evaluate(options => window.refreshFixture.referrerRefreshGeometry(options), { mobile, position, remaining: 200 });
			const evidence = JSON.stringify({ mobile, position, result });
			assert.equal(result.samples[0]!.data, 150, evidence);
			assert.equal(result.samples[1]!.data, 150, evidence);
			assert.equal(result.samples[1]!.mounted, result.samples[0]!.mounted, evidence);
			assert.equal(result.samples[1]!.anchor, result.samples[0]!.anchor, evidence);
			assert.ok(Math.abs(result.samples[1]!.offset - result.samples[0]!.offset) <= 1, evidence);
			assert.equal(result.next, true, evidence); assert.equal(result.nextCount, 200, evidence); assert.equal(result.unique, 200, evidence);
		}
		const fewer = await h.page.evaluate(() => window.refreshFixture.referrerRefreshGeometry({ mobile: false, position: 70, remaining: 80 }));
		assert.equal(fewer.samples[1]!.data, 80); assert.equal(fewer.samples[1]!.mounted, 80);
		assert.equal(fewer.next, false); assert.equal(fewer.nextCount, 80);
	} finally { await h.close(); }
});

test("独立移动搜索按阅读卡偏移接续内部提交及外部全换键，各过渡帧不漂移", { skip: !process.env.KNOMO_LAYOUT_PLAYWRIGHT }, async t => {
	const h = await browserFixture();
	const traces: unknown[] = [];
	try {
		for (const entry of ["internal", "external", "cross-file"] as const) for (const edit of ["grow", "shrink", "below", "same"] as const) {
			const options = { entry, edit, chunked: entry !== "internal" };
			const result = await h.page.evaluate(options => window.refreshFixture.mobileRevisionGeometry(options), options);
			const evidence = JSON.stringify({ options, result });
			traces.push({ options, result });
			for (const sample of result.samples) assert.ok(Math.abs(sample.offset! - result.samples[0]!.offset!) <= 1, evidence);
			const last = result.samples.at(-1)!;
			assert.equal(last.count, 30, evidence);
			assert.equal(entry === "external" ? last.focus === "results" : last.readerFocus, true, evidence);
		}
		writeFileSync(".tmp/revision-continuity-mobile-geometry.json", JSON.stringify(traces, null, 2));
		t.diagnostic("12 geometry scenarios: each sampled frame stays within 1 CSS px.");
	} finally { await h.close(); }
});

test("移动搜索分帧收尾尊重无前导事件的滚动、键盘、触摸与新输入焦点", { skip: !process.env.KNOMO_LAYOUT_PLAYWRIGHT }, async () => {
	const h = await browserFixture();
	const traces: unknown[] = [];
	try {
		for (const input of ["scroll", "wheel", "keyboard", "pointer", "touch", "focus", "composition"] as const) {
			const options = { entry: "external" as const, edit: "same" as const, chunked: true, input };
			const result = await h.page.evaluate(options => window.refreshFixture.mobileRevisionGeometry(options), options);
			const evidence = JSON.stringify({ options, result }), last = result.samples.at(-1)!;
			traces.push({ options, result });
			if (result.userPosition !== null) assert.equal(last.scroll, result.userPosition, evidence);
			else assert.match(String(last.focus), /knomo-search-input/, evidence);
		}
		writeFileSync(".tmp/revision-continuity-mobile-intent.json", JSON.stringify(traces, null, 2));
	} finally { await h.close(); }
});

test("移动搜索外部覆盖的只读画面在读取失败时保持可读，查询接纳后恢复新绑定", { skip: !process.env.KNOMO_LAYOUT_PLAYWRIGHT }, async () => {
	const h = await browserFixture();
	try {
		for (const resourceChanged of [false, true]) {
			const result = await h.page.evaluate(resourceChanged => window.refreshFixture.mobileRevisionGeometry({ entry: "external", edit: "same", readonly: true, resourceChanged }), resourceChanged);
			assert.equal(result.readonlyBindings, 0);
			assert.equal(result.imageLoads, resourceChanged ? 2 : 1, "同版本不重载，资源改变必须加载新图片");
			assert.equal(result.sameImage, !resourceChanged);
			for (const sample of result.samples) assert.equal(sample.count, 30, JSON.stringify(result));
			for (const sample of result.samples) assert.ok(Math.abs(sample.offset! - result.samples[0]!.offset!) <= 1, JSON.stringify(result));
			assert.equal(result.samples.at(-1)!.focus, "results");
		}
	} finally { await h.close(); }
});

test("同字节保存的三次查询通知不替换卡片或重载已就绪图片", { skip: !process.env.KNOMO_LAYOUT_PLAYWRIGHT }, async () => {
	const h = await browserFixture();
	try {
		const result = await h.page.evaluate(() => window.refreshFixture.mobileRevisionGeometry({ entry: "external", edit: "same", sameBytes: true }));
		assert.equal(result.replacements, 0);
		assert.equal(result.imageLoads, 1);
		for (const sample of result.samples) assert.ok(Math.abs(sample.offset! - result.samples[0]!.offset!) <= 1, JSON.stringify(result));
	} finally { await h.close(); }
});

test("移动搜索只读交接恢复三页窗口和深处阅读卡，再用新游标继续翻页", { skip: !process.env.KNOMO_LAYOUT_PLAYWRIGHT }, async () => {
	const h = await browserFixture();
	try {
		const result = await h.page.evaluate(() => window.refreshFixture.mobileRevisionGeometry({
			entry: "external", edit: "same", readonly: true, expanded: true,
		}));
		assert.equal(result.readonlyBindings, 0);
		assert.equal(result.finalCount, 150);
		assert.equal(result.nextCount, 200);
		assert.deepEqual(result.requests, [0, 50, 100, 0, 50, 100, 150]);
		for (const sample of result.samples) {
			assert.equal(sample.count, 150);
			assert.notEqual(sample.offset, null);
			assert.ok(Math.abs(sample.offset! - result.samples[0]!.offset!) <= 1, JSON.stringify(result));
		}
	} finally { await h.close(); }
});

test("移动搜索只读交接后原字节与原 Key 重现时恢复当前任务和菜单", { skip: !process.env.KNOMO_LAYOUT_PLAYWRIGHT }, async () => {
	const h = await browserFixture();
	try {
		const result = await h.page.evaluate(() => window.refreshFixture.mobileRevisionGeometry({
			entry: "external", edit: "same", readonly: true, restoreSameBytes: true,
		}));
		assert.equal(result.readonlyCount, 0);
		assert.equal(result.disabledCount, 0);
		assert.equal(result.taskBindings.length, 1, "过渡时点击无操作，接纳后恰好触发一次当前任务");
		assert.ok(result.taskBindings[0]!.endsWith("revision-0"));
		assert.equal(result.imageLoads, 1);
		assert.equal(result.sameImage, true);
	} finally { await h.close(); }
});

test("移动搜索只读交接在跨文件减员后仍补足窗口，真实剩余不足时读尽", { skip: !process.env.KNOMO_LAYOUT_PLAYWRIGHT }, async () => {
	const h = await browserFixture();
	try {
		const mixed = await h.page.evaluate(() => window.refreshFixture.mobileRevisionGeometry({
			entry: "cross-file", edit: "same", readonly: true, expanded: true,
		}));
		assert.equal(mixed.readonlyBindings, 50);
		assert.equal(mixed.finalCount, 150);
		assert.equal(mixed.nextCount, 200);
		for (const sample of mixed.samples) assert.ok(Math.abs(sample.offset! - mixed.samples[0]!.offset!) <= 1, JSON.stringify(mixed));
		const fewer = await h.page.evaluate(() => window.refreshFixture.mobileRevisionGeometry({
			entry: "external", edit: "same", readonly: true, expanded: true, remaining: 80,
		}));
		assert.equal(fewer.finalCount, 80);
		assert.equal(fewer.nextCount, 80);
		assert.deepEqual(fewer.requests, [0, 50, 100, 0, 50]);
	} finally { await h.close(); }
});

test("移动搜索连续加长与缩短上方正文时不累计像素取整漂移", { skip: !process.env.KNOMO_LAYOUT_PLAYWRIGHT }, async () => {
	const h = await browserFixture();
	try {
		const result = await h.page.evaluate(() => window.refreshFixture.mobileRevisionGeometry({ entry: "internal", edit: "grow", repeatEdits: 8 }));
		for (const sample of result.samples) assert.ok(Math.abs(sample.offset! - result.samples[0]!.offset!) <= 1, JSON.stringify(result));
	} finally { await h.close(); }
});

test("分片期间用户读到下方后正文缩短，仅自然限幅到新边界，不恢复旧阅读位置", { skip: !process.env.KNOMO_LAYOUT_PLAYWRIGHT }, async () => {
	const h = await browserFixture();
	try {
		const result = await h.page.evaluate(() => window.refreshFixture.mobileRevisionGeometry({
			entry: "external", edit: "shrink", shrinkBelow: true, input: "scroll", scrollToBottom: true,
		}));
		const last = result.samples.at(-1)!, evidence = JSON.stringify(result);
		assert.ok(result.userPosition! > last.maxScroll, evidence);
		assert.equal(last.scroll, last.maxScroll, evidence);
		assert.notEqual(last.scroll, result.samples[0]!.scroll, evidence);
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

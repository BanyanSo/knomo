import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// 宿主结构自包含；额外主题快照只用于扩大样式覆盖，不是测试依赖。
const hostFixture = `
 * { box-sizing:border-box; }
 body.is-mobile { margin:0; --background-primary:#fffef3; --background-secondary:#f2f0e3;
   --text-normal:#222; --text-muted:#666; --view-header-height:44px; --view-header-top-offset:var(--fixture-safe); --safe-area-inset-top:var(--fixture-safe);
   --size-4-2:8px; --size-4-4:16px; --size-4-6:24px; }
 body.theme-dark { --background-primary:#242424; --background-secondary:#303030; --text-normal:#eee; }
 .workspace-leaf-content { height:100vh; width:100%; position:relative; display:flex; flex-direction:column; overflow:hidden; }
 .view-header { position:relative; height:44px; z-index:1; display:flex; align-items:center; flex-shrink:0; }
 .is-phone .view-header { position:static; padding-top:var(--fixture-safe); height:auto; }
 .view-header-title-container { height:44px; flex:1; display:flex; align-items:center; justify-content:center; }
 .view-actions { display:flex; height:44px; }
 .view-action { width:44px; height:44px; }
 .is-floating-nav .view-header { position:fixed; margin-top:var(--fixture-safe); padding-top:0; width:100%; }
 .auto-full-screen .view-header { position:fixed; width:100%; }
 .view-content { height:calc(100% - 44px); min-height:0; overflow:hidden; padding:0; }
 .is-floating-nav .view-content, .auto-full-screen .view-content { margin-top:calc(var(--fixture-safe) + 44px + 8px); }
 .knomo-plugin, .knomo-shell, .knomo-main, .knomo-content-column { height:100%; }
 .knomo-shell, .knomo-main, .knomo-content-column { display:flex; }
 .knomo-main, .knomo-content-column { flex-direction:column; flex:1; min-height:0; }
 .knomo-content-column { padding:0 12px; }
 .knomo-card-flow { flex:1; overflow:auto; min-height:0; }
 .fixture-card { height:160px; background:var(--background-primary); margin-bottom:12px; }
 .fixture-underlay { position:fixed; inset:0; background:repeating-linear-gradient(black 0 3px, white 3px 6px); pointer-events:none; }
 .fixture-overlay { position:fixed; inset:0; z-index:9990; background:var(--background-primary); }
`;

test("mobile surface preserves native controls and adds only the missing lower clearance in every phone viewport", { skip: !process.env.KNOMO_LAYOUT_PLAYWRIGHT }, async () => {
	const { chromium } = require(process.env.KNOMO_LAYOUT_PLAYWRIGHT!);
	const browser = await chromium.launch({ headless: true });
	const css = readFileSync(process.env.KNOMO_LAYOUT_CSS || "styles.css", "utf8");
	// 对照保留其余插件样式，避免把原有主题适配误判为本次材质造成的布局变化。
	const start = css.indexOf('body.is-mobile .workspace-leaf-content[data-type="knomo-view"] .view-header {');
	const end = css.indexOf('body.is-mobile .workspace-leaf-content[data-type="knomo-view"] .view-header.knomo-record-stats-header {');
	assert.ok(start >= 0 && end > start);
	const baselineCss = css.slice(0, start) + 'body.is-mobile .workspace-leaf-content[data-type="knomo-view"] .view-header { border-bottom:0; backdrop-filter:blur(18px) saturate(1.4); -webkit-backdrop-filter:blur(18px) saturate(1.4); }\n' + css.slice(end);
	const extraHost = process.env.KNOMO_LAYOUT_HOST_CSS ? readFileSync(process.env.KNOMO_LAYOUT_HOST_CSS, "utf8") : "";
	try {
		const page = await browser.newPage({ deviceScaleFactor: 1 });
		const cdp = await page.context().newCDPSession(page);
		for (const theme of ["theme-light", "theme-dark"]) for (const mode of ["", "is-floating-nav", "auto-full-screen"]) for (const width of [390, 844]) {
			const safe = width === 390 ? 59 : 20;
			await page.setViewportSize({ width, height: width === 390 ? 844 : 390 });
			await page.setContent(`<style>${extraHost}${hostFixture}${baselineCss}</style><body class="is-mobile is-phone show-view-header ${theme} ${mode}" style="--fixture-safe:${safe}px">
			 <div class="workspace-leaf-content" data-type="knomo-view"><div class="fixture-underlay"></div>
			 <div class="view-header"><div class="view-header-title-container"><span class="view-header-title knomo-mobile-title">全部笔记</span></div><div class="view-actions"><button class="view-action knomo-mobile-header-action">搜索</button></div></div>
			 <div class="view-content knomo-view-host"><div class="knomo-plugin knomo-view is-layout-mobile"><div class="knomo-shell"><div class="knomo-main"><div class="knomo-content-column"><div class="knomo-page-feedback" hidden>提示</div><div class="knomo-card-flow">${Array.from({ length: 12 }, () => '<div class="fixture-card knomo-card">Memo</div>').join("")}</div></div></div></div></div></div>
			 <div class="fixture-overlay" hidden>搜索页</div></div></body>`);
			const geometry = () => page.evaluate(() => [".view-header", ".view-action", ".view-content", ".fixture-card"].map(selector => {
				const rect = document.querySelector(selector)!.getBoundingClientRect();
				return [rect.x, rect.y, rect.width, rect.height];
			}));
			const before = await geometry();
			await page.addStyleTag({ content: css });
			const context = `${theme}/${mode}/${width}`;
			const after = await geometry();
			assert.deepEqual(after[0], [before[0][0], before[0][1], before[0][2], before[0][3] + 8], `${context}: header adds lower breathing room`);
			assert.deepEqual(after[1], before[1], `${context}: native button`);
			const headerBottom = after[0][1] + after[0][3];
			assert.deepEqual(after[3], [before[3][0], Math.max(before[3][1], headerBottom + 8), before[3][2], before[3][3]], `${context}: first card clears header with 8px spacing`);
			{
				assert.equal(after[2][1], 0, `${context}: viewport extends to top`);
				assert.equal(after[2][3], width === 390 ? 844 : 390, `${context}: viewport fills leaf`);
			}
			await page.locator(".knomo-mobile-header-action").click();
			for (const preference of ["no-preference", "reduce"]) {
				await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-transparency", value: preference }] });
				const style = await page.locator(".view-header").evaluate((el: HTMLElement) => {
					const surface = getComputedStyle(el, "::before");
					return { blur: surface.backdropFilter, pointer: surface.pointerEvents, headerBlur: getComputedStyle(el).backdropFilter };
				});
				if (preference === "reduce") assert.equal(style.blur, "none", context);
				else assert.match(style.blur, /blur\([\d.]+px\)/, `${context}: only the background softens the feed`);
				assert.equal(style.headerBlur, "none", context);
				assert.equal(style.pointer, "none", context);
				if (preference === "reduce") {
					const screenshot = await page.screenshot();
					const paint = await page.evaluate(async ({ png, safe, x }: { png: string; safe: number; x: number }) => {
						const bytes = Uint8Array.from(atob(png), char => char.charCodeAt(0));
						const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
						const canvas = document.createElement("canvas");
						canvas.width = bitmap.width; canvas.height = bitmap.height;
						const ctx = canvas.getContext("2d")!;
						ctx.drawImage(bitmap, 0, 0);
						bitmap.close();
						const pixels = [4, Math.floor(safe / 2), safe - 1].map(y => Array.from(ctx.getImageData(x, y, 1, 1).data));
						ctx.fillStyle = getComputedStyle(document.querySelector(".view-header")!).getPropertyValue("--background-secondary").trim();
						ctx.fillRect(0, 0, 1, 1);
						return { pixels, expected: Array.from(ctx.getImageData(0, 0, 1, 1).data) };
					}, { png: screenshot.toString("base64"), safe, x: Math.floor(width / 2) });
					for (const pixel of paint.pixels) assert.deepEqual(pixel, paint.expected, context);
				}
			}
			{
				await page.locator(".knomo-page-feedback").evaluate((el: HTMLElement) => { el.hidden = false; });
				assert.ok(await page.evaluate(() => document.querySelector(".knomo-page-feedback")!.getBoundingClientRect().top >= document.querySelector(".view-header")!.getBoundingClientRect().bottom), `${context}: feedback clears header`);
				await page.locator(".knomo-page-feedback").evaluate((el: HTMLElement) => { el.hidden = true; });
				await page.locator(".knomo-card-flow").evaluate((el: HTMLElement) => { el.scrollTop = 0; });
				assert.deepEqual((await geometry())[3], after[3], `${context}: dismissing feedback restores first card`);
			}
			await page.locator(".fixture-overlay").evaluate((el: HTMLElement) => { el.hidden = false; });
			assert.equal(await page.evaluate(() => document.elementFromPoint(100, 10)?.className), "fixture-overlay", context);
			await page.locator(".workspace-leaf-content").evaluate((el: HTMLElement) => el.setAttribute("data-type", "markdown"));
			assert.equal(await page.locator(".view-header").evaluate((el: HTMLElement) => getComputedStyle(el, "::before").content), "none", context);
		}
	} finally {
		await browser.close();
	}
});

test("phone header softly veils background strokes while preserving clearance and normal card pixels", { skip: !process.env.KNOMO_LAYOUT_PLAYWRIGHT }, async () => {
	const { chromium } = require(process.env.KNOMO_LAYOUT_PLAYWRIGHT!);
	const browser = await chromium.launch({ headless: true });
	const css = readFileSync(process.env.KNOMO_LAYOUT_CSS || "styles.css", "utf8");
	const extraHost = process.env.KNOMO_LAYOUT_HOST_CSS ? readFileSync(process.env.KNOMO_LAYOUT_HOST_CSS, "utf8") : "";
	try {
		const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
		for (const theme of ["theme-light", "theme-dark"]) for (const mode of ["", "is-floating-nav", "auto-full-screen"]) {
			await page.setContent(`<style>${extraHost}${hostFixture}${css}
			 .fixture-card:first-child { height:300px; }
			 .fixture-ink { height:260px; background:linear-gradient(to right, #000 0 96px, transparent 96px), repeating-linear-gradient(to right, #000 0 6px, #fff 6px 12px); }
			</style><body class="is-mobile is-phone ${mode} show-view-header ${theme}" style="--fixture-safe:59px">
			 <div class="workspace-leaf-content" data-type="knomo-view">
			 <div class="view-header"><div class="view-header-left"><button class="view-action">菜单</button></div><div class="view-header-title-container">全部笔记</div><div class="view-actions"><button class="view-action knomo-mobile-header-action">搜索</button></div></div>
			 <div class="view-content knomo-view-host"><div class="knomo-plugin knomo-view is-layout-mobile"><div class="knomo-shell"><div class="knomo-main"><div class="knomo-content-column"><div class="knomo-card-flow"><div class="fixture-card knomo-card"><div class="fixture-ink"></div></div>${'<div class="fixture-card knomo-card">Memo</div>'.repeat(10)}</div></div></div></div></div></div>
			 </div></body>`);
			const bottom = await page.locator(".view-header").evaluate((el: HTMLElement) => Math.round(el.getBoundingClientRect().bottom));
			for (const buttonBottom of await page.locator(".view-action").evaluateAll((buttons: HTMLElement[]) => buttons.map(el => Math.round(el.getBoundingClientRect().bottom)))) {
				assert.equal(bottom - buttonBottom, 8, `${theme}/${mode}: header reserves space below both buttons`);
			}
			const sample = async () => {
				const screenshot = await page.screenshot();
				return page.evaluate(async ({ png, bottom }: { png: string; bottom: number }) => {
					const bytes = Uint8Array.from(atob(png), char => char.charCodeAt(0));
					const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
					const canvas = document.createElement("canvas");
					canvas.width = bitmap.width; canvas.height = bitmap.height;
					const ctx = canvas.getContext("2d")!;
					ctx.drawImage(bitmap, 0, 0); bitmap.close();
					const stroke = (y: number) => {
						const pixels = Array.from(ctx.getImageData(140, y, 200, 1).data).filter((_, i) => i % 4 === 0);
						const mean = pixels.reduce((sum, value) => sum + value, 0) / pixels.length;
						return { contrast: Math.sqrt(pixels.reduce((sum, value) => sum + (value - mean) ** 2, 0) / pixels.length),
							outline: Math.abs(ctx.getImageData(70, y, 1, 1).data[0] - mean) };
					};
					// 轻度柔化细笔画、允许宽轮廓更清楚；同时约束过透明和完全遮盖两端。
					return { behindStatus: stroke(40), behindTab: stroke(bottom - 4), belowHeader: stroke(bottom + 3), visiblePixels: Array.from(ctx.getImageData(40, bottom + 1, 300, 30).data) };
				}, { png: screenshot.toString("base64"), bottom });
			};
			const firstTop = await page.locator(".fixture-ink").evaluate((el: HTMLElement) => el.getBoundingClientRect().top);
			assert.ok(firstTop >= bottom, `${theme}: initial card clears tab`);
			await page.locator(".knomo-card-flow").evaluate((el: HTMLElement) => { el.scrollTop = 150; });
			assert.ok(await page.locator(".fixture-ink").evaluate((el: HTMLElement) => el.getBoundingClientRect().top) < bottom - 4, `${theme}: real card reaches behind tab`);
			const glass = await sample();
			for (const area of [glass.behindStatus, glass.behindTab]) {
				assert.ok(area.outline > 4 && area.outline < 50, `${theme}/${mode}: background silhouettes remain visible through the tint (${area.outline})`);
			}
			assert.equal(await page.evaluate((y: number) => document.elementFromPoint(100, y)?.className, bottom + 1), "fixture-ink", theme);
			await page.addStyleTag({ content: '.view-header, .view-header::before { backdrop-filter:none !important; -webkit-backdrop-filter:none !important; }' });
			const sharp = await sample();
			assert.ok(glass.behindTab.contrast < sharp.behindTab.contrast * 0.8, `${theme}: text detail softens behind the header`);
			assert.deepEqual(glass.belowHeader, sharp.belowHeader, `${theme}/${mode}: normal card below the padded header stays sharp`);
			assert.deepEqual(glass.visiblePixels, sharp.visiblePixels, `${theme}/${mode}: all card pixels beyond the header edge must be unchanged`);
			await page.locator(".knomo-card-flow").evaluate((el: HTMLElement) => { el.scrollTop = 0; });
			assert.equal(await page.locator(".fixture-ink").evaluate((el: HTMLElement) => el.getBoundingClientRect().top), firstTop, `${theme}: returning to top restores first card`);
		}
	} finally {
		await browser.close();
	}
});

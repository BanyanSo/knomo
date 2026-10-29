import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { build } from "esbuild";

test("reflection PNGs retain the cover on first selection and return even when SVG rasterization omits it", { skip: !process.env.KNOMO_LAYOUT_PLAYWRIGHT }, async () => {
	const { chromium, webkit } = require(process.env.KNOMO_LAYOUT_PLAYWRIGHT!);
	const bundle = await build({ stdin: { contents: `
import { ShareCardRenderer } from './src/ui/share/ShareCardRenderer';
import { createShareCardSnapshot } from './src/ui/share/ShareCardContent';
import { SHARE_CARD_REFLECTION_COVER } from './src/ui/share/ShareCardTemplateResources';
window.coverTest = { ShareCardRenderer, createShareCardSnapshot, cover: SHARE_CARD_REFLECTION_COVER, omissions: 0 };`, resolveDir: process.cwd() },
		loader: { ".webp": "dataurl" }, bundle: true, write: false, format: "iife", platform: "browser",
		plugins: [{ name: "omit-svg-cover", setup(build) {
			build.onResolve({ filter: /^html-to-image$/ }, () => ({ path: "raster", namespace: "omit-svg-cover" }));
			build.onLoad({ filter: /.*/, namespace: "omit-svg-cover" }, () => ({ loader: "js", resolveDir: process.cwd(), contents: `
import { toCanvas as rasterize } from ${JSON.stringify(require.resolve("html-to-image"))};
export async function toCanvas(card, options) {
	const canvas = await rasterize(card, options);
	const cover = card.querySelector('.hero');
	if (cover) {
		// 模拟 WebKit 已生成正文、但封面区域仍为空白的转换结果。
		const rect = cover.getBoundingClientRect(), origin = card.getBoundingClientRect();
		const ctx = canvas.getContext('2d');
		ctx.fillStyle = card.ownerDocument.defaultView.getComputedStyle(card).backgroundColor;
		ctx.fillRect((rect.left - origin.left) * 2, (rect.top - origin.top) * 2, rect.width * 2, rect.height * 2);
		window.coverTest.omissions++;
	}
	return canvas;
}` }));
		} }] });
	const browserName = process.env.KNOMO_LAYOUT_BROWSER || "msedge";
	const browser = await (browserName === "webkit" ? webkit.launch({ headless: true }) : chromium.launch({ channel: browserName, headless: true }));
	try {
		const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
		for (const { kind, mobile, withBodyImage } of [
			{ kind: "bundled", mobile: true, withBodyImage: false },
			{ kind: "bundled", mobile: true, withBodyImage: true },
			{ kind: "bundled", mobile: false, withBodyImage: true },
			{ kind: "landscape", mobile: true, withBodyImage: true },
			{ kind: "portrait", mobile: true, withBodyImage: true },
		]) {
			await page.setContent("<main></main>");
			await page.addStyleTag({ content: readFileSync("styles.css", "utf8") });
			await page.addScriptTag({ content: bundle.outputFiles[0].text });
			const result = await page.evaluate(async ({ kind, mobile, withBodyImage }: { kind: string; mobile: boolean; withBodyImage: boolean }) => {
				const api = (window as any).coverTest;
				let cover = api.cover;
				if (kind !== "bundled") {
					const source = document.createElement("canvas");
					source.width = kind === "landscape" ? 1200 : 200; source.height = kind === "landscape" ? 200 : 800;
					const ctx = source.getContext("2d")!;
					ctx.fillStyle = "red"; ctx.fillRect(0, 0, source.width, source.height);
					ctx.fillStyle = "lime";
					if (kind === "landscape") ctx.fillRect(200, 0, 800, 200); else ctx.fillRect(0, 200, 200, 400);
					ctx.fillStyle = "blue";
					if (kind === "landscape") ctx.fillRect(500, 0, 200, 200); else ctx.fillRect(0, 380, 200, 40);
					cover = source.toDataURL("image/png");
				}
				const renderer = new api.ShareCardRenderer(document.querySelector("main"), mobile, async () => new Blob([
					'<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><rect width="100" height="50" fill="#465c92"/></svg>',
				], { type: "image/svg+xml" }), cover);
				const snapshot = api.createShareCardSnapshot({ contentSnapshot: "Readable content remains here." + (withBodyImage ? "\n\n![[body.png]]" : ""), createdAt: "2026-10-28T08:30", dailyRef: { path: "Daily/test.md" } }, "en");
				const captures: Array<{ width: number; height: number; heroPixels: number[]; coverInk: number; textInk: number;
					probes: number[][]; gap: number[]; body: number[] | null; data: string }> = [];
				try {
					await renderer.render(snapshot, "paper");
					for (let index = 0; index < 2; index++) {
						const blob = await renderer.render(snapshot, "reflection");
						const url = URL.createObjectURL(blob); const image = new Image(); image.src = url;
						await image.decode(); URL.revokeObjectURL(url);
						const canvas = document.createElement("canvas"); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
						const ctx = canvas.getContext("2d")!; ctx.drawImage(image, 0, 0);
						const doc = document.querySelector("iframe")!.contentDocument!;
						const bodyImage = doc.querySelector(".content img")?.getBoundingClientRect();
						const text = doc.querySelector(".content p")!.getBoundingClientRect();
						const textPixels = ctx.getImageData(Math.round(text.left * 2), Math.round(text.top * 2), Math.round(text.width * 2), Math.round(text.height * 2)).data;
						let textInk = 0; for (let p = 0; p < textPixels.length; p += 4) if (textPixels[p] < 180) textInk++;
						const heroPixels = Array.from(ctx.getImageData(0, 0, 780, 410).data);
						let coverInk = 0; for (let p = 0; p < heroPixels.length; p += 4) if (heroPixels[p] !== 250 || heroPixels[p + 1] !== 250 || heroPixels[p + 2] !== 248) coverInk++;
						const pixel = (x: number, y: number) => Array.from(ctx.getImageData(x, y, 1, 1).data);
						const data = await new Promise<string>(resolve => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsDataURL(blob); });
						captures.push({ width: image.naturalWidth, height: image.naturalHeight, heroPixels, coverInk, textInk,
							probes: kind === "portrait" ? [pixel(390, 10), pixel(390, 205), pixel(390, 400)] : [pixel(10, 205), pixel(390, 205), pixel(770, 205)],
							gap: pixel(390, 430), body: bodyImage ? pixel(Math.round((bodyImage.left + bodyImage.width / 2) * 2), Math.round((bodyImage.top + bodyImage.height / 2) * 2)) : null, data });
						if (index === 0) await renderer.render(snapshot, "daybook");
					}
					return { omissions: api.omissions, captures: captures.map(({ heroPixels, ...capture }) => capture), sameCover: captures[0].heroPixels.every((value, index) => value === captures[1].heroPixels[index]) };
				} finally { renderer.close(); }
			}, { kind, mobile, withBodyImage });
			assert.equal(result.omissions, 2, "两次观照生成均注入封面漏绘，避免依赖缓存而通过");
			assert.equal(result.sameCover, true, "首次与切回后的封面像素必须一致");
			for (const capture of result.captures) {
				assert.equal(capture.width, 780); assert.ok(capture.height > 410);
				assert.ok(capture.coverInk > 780 * 410 / 2, `${kind}/${mobile}: PNG 必须包含封面像素`);
				if (kind !== "bundled") for (let index = 0; index < capture.probes.length; index++) {
					const expected = index === 1 ? [0, 0, 255, 255] : [0, 255, 0, 255];
					// 不同引擎的图像颜色转换允许少量舍入差异，裁切错误仍会产生不同色带。
					assert.ok(capture.probes[index].every((value: number, channel: number) => Math.abs(value - expected[channel]) <= 3), `${kind}: 宽图和竖图均保持居中 cover 裁切`);
				}
				assert.deepEqual(capture.gap, [250, 250, 248, 255], "封面不能绘入下方留白");
				assert.deepEqual(capture.body, withBodyImage ? [70, 92, 146, 255] : null, "正文图片保留原位置与像素");
				assert.ok(capture.textInk > 30, "正文文字仍须进入实际 PNG");
			}
			if (kind === "bundled" && mobile && withBodyImage) {
				mkdirSync(".tmp/share-card-samples", { recursive: true });
				for (let index = 0; index < result.captures.length; index++) writeFileSync(`.tmp/share-card-samples/reflection-cover-${index ? "return" : "first"}.png`, Buffer.from(result.captures[index].data.split(",")[1], "base64"));
			}
		}
	} finally { await browser.close(); }
});

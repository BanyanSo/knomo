import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { build } from "esbuild";

test("actual PNGs preserve three layouts, ordered images and readable long content, with nine representative samples", { skip: !process.env.KNOMO_LAYOUT_PLAYWRIGHT }, async context => {
	const { chromium } = require(process.env.KNOMO_LAYOUT_PLAYWRIGHT!);
	const bundle = await build({ stdin: { contents: `
import { ShareCardRenderer } from './src/ui/share/ShareCardRenderer';
import { createShareCardSnapshot } from './src/ui/share/ShareCardContent';
window.shareTest = { ShareCardRenderer, createShareCardSnapshot };`, resolveDir: process.cwd() }, bundle: true, write: false, format: "iife", platform: "browser" });
	const paragraph = "傍晚散步时，树叶间的光落在路面上。停下来观察一会儿，会发现每天熟悉的地方仍有细小的变化。记录这些瞬间，不需要急着得出结论，只要把当下看见的、想到的认真留下。阅读也是如此，先理解一句话，再试着用自己的经验回答它。";
	const samples = [
		"今天整理书桌，翻到去年留下的便签。那些当时觉得重要的小事，已经变成了生活的一部分。\n\n把注意力放回眼前：读完一页书，照顾一盆植物，认真听完一段话。 #日常",
		"![[blue.png]]\n\n" + paragraph.repeat(3) + "\n\n![[green.png]]\n\n周二，留一点时间观察。",
		Array.from({ length: 5 }, (_, i) => paragraph.repeat(2) + `\n\n![[${i % 2 ? "green" : "blue"}.png]]`).join("\n\n"),
	];
	mkdirSync(".tmp/share-card-samples", { recursive: true });
	const browser = await chromium.launch({ channel: process.env.KNOMO_LAYOUT_BROWSER || "msedge", headless: true });
	try {
		const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
		await page.setContent("<html><body><main></main></body></html>");
		await page.addStyleTag({ content: readFileSync("styles.css", "utf8") });
		await page.addScriptTag({ content: bundle.outputFiles[0].text });
		for (const template of ["paper", "editorial", "nocturne"]) for (let index = 0; index < samples.length; index++) {
			const result = await page.evaluate(async ({ template, body }: { template: string; body: string }) => {
				const api = (window as any).shareTest;
				let loads = 0;
				const renderer = new api.ShareCardRenderer(document.querySelector("main"), true, async (path: string) => {
					loads++;
					return new Blob([`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="320"><rect width="600" height="320" fill="${path === "blue.png" ? "#547788" : "#65856b"}"/><circle cx="300" cy="160" r="90" fill="#e9dfc8"/></svg>`], { type: "image/svg+xml" });
				});
				const snapshot = api.createShareCardSnapshot({ contentSnapshot: body, createdAt: "2026-10-27T08:30", dailyRef: { path: "Daily/2026-10-27.md" } }, "zh-CN");
				try {
					const blob = await renderer.render(snapshot, template);
					const bitmap = await createImageBitmap(blob);
					const canvas = document.createElement("canvas"); canvas.width = bitmap.width; canvas.height = bitmap.height;
					const ctx = canvas.getContext("2d")!; ctx.drawImage(bitmap, 0, 0);
					const rgba = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
					let ink = 0; for (let p = 0; p < rgba.length; p += 4) if (rgba[p] !== rgba[0] || rgba[p + 1] !== rgba[1] || rgba[p + 2] !== rgba[2]) ink++;
					const frame = document.querySelector("iframe") as HTMLIFrameElement; const doc = frame.contentDocument!;
					const card = doc.querySelector(".share-card")!;
					const brand = card.querySelector(".share-brand")!;
					const rect = brand.getBoundingClientRect(); const cardRect = card.getBoundingClientRect();
					const brandStyle = doc.defaultView!.getComputedStyle(brand);
					const background = ctx.getImageData(0, bitmap.height - 1, 1, 1).data;
					const brandPixels = ctx.getImageData(Math.round(rect.x * 2), Math.round(rect.y * 2), Math.round(rect.width * 2), Math.round(rect.height * 2)).data;
					let brandInk = 0;
					for (let p = 0; p < brandPixels.length; p += 4) if (brandPixels[p] !== background[0] || brandPixels[p + 1] !== background[1] || brandPixels[p + 2] !== background[2]) brandInk++;
					const meta = { width: bitmap.width, height: bitmap.height, ink, loads, images: card.querySelectorAll("img").length, hero: card.querySelectorAll(".hero").length,
						bg: Array.from(rgba.slice(0, 4)), text: card.querySelector(".content")!.textContent, day: card.querySelectorAll(".date-head").length,
						brand: { count: card.querySelectorAll(".share-brand").length, text: brand.textContent, last: card.lastElementChild === brand,
							fontSize: brandStyle.fontSize, weight: brandStyle.fontWeight, color: brandStyle.color, align: brandStyle.textAlign,
							gap: rect.top - brand.previousElementSibling!.getBoundingClientRect().bottom, bottom: cardRect.bottom - rect.bottom, ink: brandInk } };
					const data = await new Promise<string>(resolve => { const reader = new FileReader(); reader.onload = () => resolve(reader.result as string); reader.readAsDataURL(blob); });
					return { ...meta, data };
				} finally { renderer.close(); }
			}, { template, body: samples[index] });
			assert.equal(result.width, 780); assert.ok(result.height > 200); assert.ok(result.ink > 1000, "PNG must contain actual text and images");
			assert.equal(result.images, [0, 2, 5][index]); assert.equal(result.hero, template === "editorial" && index === 1 ? 1 : 0);
			assert.equal(result.loads, index ? 2 : 0); assert.equal(result.day, template === "nocturne" ? 1 : 0);
			assert.ok(result.text.includes(index ? "傍晚散步" : "今天整理书桌"));
			assert.deepEqual({ ...result.brand, ink: undefined }, { count: 1, text: "Knomo", last: true, fontSize: "12px", weight: "400",
				color: template === "paper" ? "rgb(118, 107, 93)" : template === "editorial" ? "rgb(98, 104, 107)" : "rgb(183, 172, 152)",
				align: "center", gap: 24, bottom: 36, ink: undefined });
			assert.ok(result.brand.ink > 20, "实际 PNG 的底部标志区域必须含有文字像素");
			assert.deepEqual(result.bg, template === "paper" ? [246, 242, 232, 255] : template === "editorial" && index === 1 ? [84, 119, 136, 255] : template === "editorial" ? [247, 247, 243, 255] : [37, 38, 40, 255]);
			writeFileSync(`.tmp/share-card-samples/${template}-${"ABC"[index]}.png`, Buffer.from(result.data.split(",")[1], "base64"));
			context.diagnostic(`${template}-${"ABC"[index]}: ${result.width}×${result.height}, images=${result.images}`);
		}
		const retry = await page.evaluate(async () => {
			const api = (window as any).shareTest;
			const loads: string[] = []; let missing = true;
			const renderer = new api.ShareCardRenderer(document.querySelector("main"), true, async (path: string) => {
				loads.push(path); if (path === "b.png" && missing) throw Error("missing");
				return new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="600" height="200"><rect width="600" height="200" fill="green"/></svg>'], { type: "image/svg+xml" });
			});
			const snapshot = api.createShareCardSnapshot({ contentSnapshot: "![[a.png]]\n\n![[b.png]]\n\n![[a.png]]", createdAt: "2026-10-27T08:30", dailyRef: { path: "Daily/test.md" } }, "en");
			try {
				let failed = false; try { await renderer.render(snapshot, "paper"); } catch { failed = true; }
				missing = false; await renderer.render(snapshot, "editorial");
				const frame = document.querySelector("iframe") as HTMLIFrameElement;
				const hero = frame.contentDocument!.querySelectorAll(".hero").length;
				const images = frame.contentDocument!.querySelectorAll("img").length;
				await renderer.render(snapshot, "nocturne");
				const brand = frame.contentDocument!.querySelector(".share-brand")!;
				const lastImage = Array.from(frame.contentDocument!.querySelectorAll(".content img")).at(-1)!;
				const pureImageGap = brand.getBoundingClientRect().top - lastImage.getBoundingClientRect().bottom;
				const color = frame.contentWindow!.getComputedStyle(brand).color;
				const source = api.createShareCardSnapshot({ contentSnapshot: "已有来源", createdAt: "2026-10-27T08:30", dailyRef: { path: "Daily/test.md" } }, "en").body;
				const sourceGaps = [];
				for (const template of ["paper", "editorial", "nocturne"]) {
					await renderer.render({ ...snapshot, source }, template);
					const footer = frame.contentDocument!.querySelector(".share-brand")!;
					const preceding = template === "editorial" ? footer.previousElementSibling! : frame.contentDocument!.querySelector(".source p")!;
					sourceGaps.push(footer.getBoundingClientRect().top - preceding.getBoundingClientRect().bottom);
				}
				return { failed, loads, hero, images, pureImageGap, color, sourceGaps };
			} finally { renderer.close(); }
		});
		assert.deepEqual(retry, { failed: true, loads: ["a.png", "b.png", "b.png"], hero: 1, images: 3, pureImageGap: 24, color: "rgb(183, 172, 152)", sourceGaps: [24, 24, 24] });
	} finally { await browser.close(); }
});

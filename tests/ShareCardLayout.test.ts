import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { build } from "esbuild";

test("actual PNGs preserve four layouts, ordered images and readable long content, with twelve representative samples", { skip: !process.env.KNOMO_LAYOUT_PLAYWRIGHT }, async context => {
	const { chromium } = require(process.env.KNOMO_LAYOUT_PLAYWRIGHT!);
	const bundle = await build({ stdin: { contents: `
import { ShareCardRenderer } from './src/ui/share/ShareCardRenderer';
import { createShareCardSnapshot } from './src/ui/share/ShareCardContent';
import { SHARE_CARD_REFLECTION_COVER } from "./src/ui/share/ShareCardTemplateResources";
window.shareTest = { ShareCardRenderer, createShareCardSnapshot, cover: SHARE_CARD_REFLECTION_COVER };`, resolveDir: process.cwd() }, loader: { ".png": "dataurl", ".jpg": "dataurl", ".webp": "dataurl" }, bundle: true, write: false, format: "iife", platform: "browser" });
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
		for (const template of ["paper", "daybook", "reflection", "midnight"]) for (let index = 0; index < samples.length; index++) {
			const result = await page.evaluate(async ({ template, body }: { template: string; body: string }) => {
				const api = (window as any).shareTest;
				let loads = 0;
				const renderer = new api.ShareCardRenderer(document.querySelector("main"), true, async (path: string) => {
					loads++;
					return new Blob([`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="320"><rect width="600" height="320" fill="${path === "blue.png" ? "#547788" : "#65856b"}"/><circle cx="300" cy="160" r="90" fill="#e9dfc8"/></svg>`], { type: "image/svg+xml" });
				}, api.cover);
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
					const contentRect = card.querySelector(".content")!.getBoundingClientRect();
					const dateEl = card.querySelector(".meta")!;
					const dateRect = dateEl.getBoundingClientRect();
					const dateStyle = doc.defaultView!.getComputedStyle(dateEl);
					const background = ctx.getImageData(0, bitmap.height - 1, 1, 1).data;
					const brandPixels = ctx.getImageData(Math.round(rect.x * 2), Math.round(rect.y * 2), Math.round(rect.width * 2), Math.round(rect.height * 2)).data;
					let brandInk = 0;
					for (let p = 0; p < brandPixels.length; p += 4) if (brandPixels[p] !== background[0] || brandPixels[p + 1] !== background[1] || brandPixels[p + 2] !== background[2]) brandInk++;
					const meta = { width: bitmap.width, height: bitmap.height, ink, loads, images: card.querySelectorAll("img").length, hero: card.querySelectorAll(".hero").length,
						bg: Array.from(rgba.slice(0, 4)), text: card.querySelector(".content")!.textContent, day: card.querySelectorAll(".date-head").length,
						date: { top: dateRect.top, bottom: dateRect.bottom, align: dateStyle.textAlign, size: parseFloat(dateStyle.fontSize), color: dateStyle.color,
							gap: dateRect.top - contentRect.bottom, border: dateStyle.borderTopWidth },
						contentTop: contentRect.top, bodySize: parseFloat(doc.defaultView!.getComputedStyle(card).fontSize),
						brand: { count: card.querySelectorAll(".share-brand").length, text: brand.textContent, last: card.lastElementChild === brand,
							fontSize: brandStyle.fontSize, weight: brandStyle.fontWeight, color: brandStyle.color, align: brandStyle.textAlign,
							gap: rect.top - brand.previousElementSibling!.getBoundingClientRect().bottom, bottom: cardRect.bottom - rect.bottom, ink: brandInk } };
					const data = await new Promise<string>(resolve => { const reader = new FileReader(); reader.onload = () => resolve(reader.result as string); reader.readAsDataURL(blob); });
					return { ...meta, data };
				} finally { renderer.close(); }
			}, { template, body: samples[index] });
			assert.equal(result.width, 780); assert.ok(result.height > 200); assert.ok(result.ink > 1000, "PNG must contain actual text and images");
			assert.equal(result.images, [0, 2, 5][index] + (template === "reflection" ? 1 : 0)); assert.equal(result.hero, template === "reflection" ? 1 : 0);
			assert.equal(result.loads, index ? 2 : 0); assert.equal(result.day, template === "daybook" ? 1 : 0);
			assert.ok(result.text.includes(index ? "傍晚散步" : "今天整理书桌"));
			if (template === "midnight") {
				assert.equal(result.date.top, 36); assert.equal(result.contentTop - result.date.bottom, 28);
				assert.equal(result.date.align, "right");
				assert.equal(result.date.size, result.bodySize * .875); assert.equal(result.date.border, "0px");
				assert.equal(result.date.color, "rgb(207, 193, 167)");
			} else if (template === "paper") {
				assert.equal(result.date.top, 36); assert.equal(result.contentTop - result.date.bottom, 28);
				assert.equal(result.date.size, result.bodySize * .875); assert.equal(result.date.border, "0px");
				assert.equal(result.date.color, "rgb(102, 90, 76)");
			} else if (template === "reflection") {
				assert.equal(result.date.gap, 24); assert.equal(result.date.border, "1px"); assert.equal(result.date.color, "rgb(80, 88, 92)");
				assert.equal(result.date.size, result.bodySize * .875);
			}
			assert.deepEqual({ ...result.brand, ink: undefined }, { count: 1, text: "Knomo", last: true, fontSize: "12px", weight: "400",
				color: template === "midnight" ? "rgb(119, 117, 111)" : template === "reflection" ? "rgb(160, 164, 165)" : "rgb(166, 158, 145)",
				align: "center", gap: 24, bottom: 30, ink: undefined });
			assert.ok(result.brand.ink > 20, "实际 PNG 的底部标志区域必须含有文字像素");
			if (template !== "reflection") assert.deepEqual(result.bg, template === "paper" ? [246, 242, 232, 255] : template === "daybook" ? [243, 240, 229, 255] : [27, 29, 31, 255]);
			writeFileSync(`.tmp/share-card-samples/${template}-${"ABC"[index]}.png`, Buffer.from(result.data.split(",")[1], "base64"));
			context.diagnostic(`${template}-${"ABC"[index]}: ${result.width}×${result.height}, images=${result.images}`);
		}
		const retry = await page.evaluate(async () => {
			const api = (window as any).shareTest;
			const loads: string[] = []; let missing = true;
			const renderer = new api.ShareCardRenderer(document.querySelector("main"), true, async (path: string) => {
				loads.push(path); if (path === "b.png" && missing) throw Error("missing");
				return new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="600" height="200"><rect width="600" height="200" fill="green"/></svg>'], { type: "image/svg+xml" });
			}, api.cover);
			const snapshot = api.createShareCardSnapshot({ contentSnapshot: "![[a.png]]\n\n![[b.png]]\n\n![[a.png]]", createdAt: "2026-10-27T08:30", dailyRef: { path: "Daily/test.md" } }, "en");
			try {
				let failed = false; try { await renderer.render(snapshot, "paper"); } catch { failed = true; }
				missing = false; await renderer.render(snapshot, "reflection");
				const frame = document.querySelector("iframe") as HTMLIFrameElement;
				const hero = frame.contentDocument!.querySelectorAll(".hero").length;
				const images = frame.contentDocument!.querySelectorAll("img").length;
				await renderer.render(snapshot, "daybook");
				const brand = frame.contentDocument!.querySelector(".share-brand")!;
				const lastImage = Array.from(frame.contentDocument!.querySelectorAll(".content img")).at(-1)!;
				const pureImageGap = brand.getBoundingClientRect().top - lastImage.getBoundingClientRect().bottom;
				const color = frame.contentWindow!.getComputedStyle(brand).color;
				const sourced = api.createShareCardSnapshot({ contentSnapshot: "已有来源 [[Daily/original#^source|原记录]]\n> 引用正文", createdAt: "2026-10-27T08:30", dailyRef: { path: "Daily/test.md" } }, "en");
				const sourceGaps = [];
				for (const template of ["paper", "daybook", "reflection", "midnight"]) {
					await renderer.render(sourced, template);
					const footer = frame.contentDocument!.querySelector(".share-brand")!;
					const preceding = footer.previousElementSibling!;
					if (frame.contentDocument!.querySelector(".source")) throw Error("source leaked");
					if (frame.contentDocument!.querySelector(".content")!.textContent!.includes("原记录")) throw Error("source metadata leaked into body");
					sourceGaps.push(footer.getBoundingClientRect().top - preceding.getBoundingClientRect().bottom);
				}
				return { failed, loads, hero, images, pureImageGap, color, sourceGaps };
			} finally { renderer.close(); }
		});
		assert.deepEqual(retry, { failed: true, loads: ["a.png", "b.png", "b.png"], hero: 1, images: 4, pureImageGap: 24, color: "rgb(166, 158, 145)", sourceGaps: [24, 24, 24, 24] });
		for (const template of ["paper", "daybook", "reflection", "midnight"]) for (const cjk of [true, false]) {
			const result = await page.evaluate(async ({ template, cjk }: { template: string; cjk: boolean }) => {
				const api = (window as any).shareTest;
				const prose = cjk ? "中文为主的正文混排 English 词语，应该与卡片保持相同的两端对齐方式，最后一行仍然靠起始边排列。" : "English prose with a few 中文 characters follows the card's start alignment. Each line stays naturally spaced and the final line remains at the start.";
				const body = `# Heading\n\n${prose.repeat(3)}\n\n- ${prose}\n\n> ${prose}\n\nInline \`code\`\n\n\`\`\`js\nconst value = 42;\n\`\`\`\n\n| A | B |\n| - | - |\n| one | two |`;
				const snapshot = api.createShareCardSnapshot({ contentSnapshot: body, createdAt: "2026-10-27T08:30", dailyRef: { path: "Daily/test.md" } }, "en");
				const renderer = new api.ShareCardRenderer(document.querySelector("main"), true, async () => { throw Error("unexpected image"); }, api.cover);
				try {
					const blob = await renderer.render(snapshot, template);
					const doc = document.querySelector("iframe")!.contentDocument!;
					const style = (selector: string) => doc.defaultView!.getComputedStyle(doc.querySelector(selector)!);
					const data = await new Promise<string>(resolve => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsDataURL(blob); });
					return { cjk: snapshot.isCjkContent, align: [".content > p", "li", "blockquote"].map(selector => style(selector).textAlign),
						last: style(".content > p").textAlignLast, exceptions: ["h1", "pre", "code", "table"].map(selector => style(selector).textAlign), data };
				} finally { renderer.close(); }
			}, { template, cjk });
			assert.equal(result.cjk, cjk);
			// LTR 列表的宿主 UA 规则可能将起始边计算为 left，语义与 start 相同。
			assert.deepEqual(result.align.map((align: string) => align === "left" ? "start" : align), Array(3).fill(cjk ? "justify" : "start"));
			assert.equal(result.last, cjk ? "start" : "auto");
			assert.deepEqual(result.exceptions, Array(4).fill("start"));
			writeFileSync(`.tmp/share-card-samples/${template}-align-${cjk ? "cjk" : "en"}.png`, Buffer.from(result.data.split(",")[1], "base64"));
		}
		for (const template of ["paper", "daybook", "reflection", "midnight"]) for (const word of [
			"https://example.test/VeryLongMixedWord", "[https://example.test/VeryLongMixedWord](https://example.test)", "**https://example.test/VeryLongMixedWord**",
		]) {
			const result = await page.evaluate(async ({ template, word }: { template: string; word: string }) => {
				const api = (window as any).shareTest;
				const body = "中文阅读 " + word + "，保留标点与正常的中文两端对齐。".repeat(4) + "\n原有换行，不要拉伸。\n\n收尾 English 2026/10/27 与 **原文加粗**。";
				const snapshot = api.createShareCardSnapshot({ contentSnapshot: body, createdAt: "2026-10-27T08:30", dailyRef: { path: "Daily/test.md" } }, "zh-CN");
				const renderer = new api.ShareCardRenderer(document.querySelector("main"), true, async () => { throw Error("unexpected image"); }, api.cover);
				try {
					const blob = await renderer.render(snapshot, template);
					const doc = document.querySelector("iframe")!.contentDocument!;
					const content = doc.querySelector(".content")!;
					const p = content.querySelector("p")!;
					const advances = () => Array.from({ length: 4 }, (_, index) => {
						const range = doc.createRange(); range.setStart(p.firstChild!, index); range.setEnd(p.firstChild!, index + 1);
						return range.getBoundingClientRect().width;
					});
					const actual = advances();
					const style = doc.defaultView!.getComputedStyle(content);
					const size = parseFloat(style.fontSize); const align = style.textAlign;
					// 对照保留两端对齐，只恢复旧断词规则，证明该输入确实会拉开汉字。
					const control = doc.createElement("style"); control.textContent = ".is-cjk-content .content { word-break:normal; }"; doc.head.append(control);
					const before = advances(); control.remove();
					const data = await new Promise<string>(resolve => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsDataURL(blob); });
					return { actual, before, size, align, text: content.textContent, breaks: p.querySelectorAll("br").length, data };
				} finally { renderer.close(); }
			}, { template, word });
			assert.equal(result.align, "justify");
			assert.ok(Math.max(...result.before) > result.size * 2, "旧断词规则应复现极端字距");
			assert.ok(Math.max(...result.actual) <= result.size * 1.5, "保留两端对齐时，混排不应把少量汉字拉满整行");
			assert.equal(result.breaks, 1); assert.ok(result.text.includes("收尾 English 2026/10/27 与 原文加粗。"));
			if (word.startsWith("[")) writeFileSync(`.tmp/share-card-samples/${template}-mixed.png`, Buffer.from(result.data.split(",")[1], "base64"));
		}
	} finally { await browser.close(); }
});

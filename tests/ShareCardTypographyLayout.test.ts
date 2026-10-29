import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { build } from "esbuild";

test("PNG typography inherits resolved host settings, freezes the session and rejects unavailable fonts/covers", { skip: !process.env.KNOMO_LAYOUT_PLAYWRIGHT }, async context => {
	const { chromium } = require(process.env.KNOMO_LAYOUT_PLAYWRIGHT!);
	const bundle = await build({ stdin: { contents: `
import { ShareCardRenderer } from './src/ui/share/ShareCardRenderer';
import { createShareCardSnapshot } from './src/ui/share/ShareCardContent';
window.fontTest={ShareCardRenderer,createShareCardSnapshot};`, resolveDir: process.cwd() }, bundle: true, write: false, format: "iife", platform: "browser" });
	const browser = await chromium.launch({ channel: process.env.KNOMO_LAYOUT_BROWSER || "msedge", headless: true });
	try {
		const page = await browser.newPage();
		let remoteRequests = 0;
		await page.route("https://invalid.example.test/**", (route: { abort(): Promise<void> }) => { remoteRequests++; return route.abort(); });
		await page.setContent("<main></main>");
		await page.addStyleTag({ content: readFileSync("styles.css", "utf8") });
		await page.addScriptTag({ content: bundle.outputFiles[0].text });
		const fontData = process.env.KNOMO_SHARE_TEST_FONT ? "data:font/ttf;base64," + readFileSync(process.env.KNOMO_SHARE_TEST_FONT).toString("base64") : null;
		const result = await page.evaluate(async ({ fontData, systemFont }: { fontData: string | null; systemFont: string }) => {
			const { ShareCardRenderer, createShareCardSnapshot } = (window as any).fontTest;
			const host = document.querySelector("main")!;
			host.style.cssText = `--font-text:"${systemFont}",sans-serif;--font-interface:"${systemFont}",sans-serif;--font-monospace:monospace`;
			const snapshot = createShareCardSnapshot({ contentSnapshot: "正文中文 🌱 English 08:30 #标签\n\n" + "Readable lines wrap naturally. ".repeat(10) + "\n\n- [x] Done\n\n> [!note] Note\n> 全文保留\n\n```js\nconst value = 42;\n```\n\n| A | B |\n| - | - |\n| one | two |\n\nTHE END", createdAt: "2026-10-27T23:59:42", dailyRef: { path: "Daily/test.md" } }, "en");
			const plain = createShareCardSnapshot({ contentSnapshot: "Reading a quiet page. The quick brown fox jumps over the lazy dog. 0123456789", createdAt: "2026-10-27T23:59:42", dailyRef: { path: "Daily/test.md" } }, "en");
			const png = async (renderer: any, template = "paper", input = snapshot) => {
				const blob = await renderer.render(input, template);
				return new Promise<string>(resolve => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsDataURL(blob); });
			};
			const samples = [];
			for (const size of [16, 18, 24]) {
				host.style.setProperty("--font-text-size", size + "px");
				const renderer = new ShareCardRenderer(host, true, async () => { throw Error("unexpected image"); });
				try {
					const data = await png(renderer);
					const doc = host.querySelector("iframe")!.contentDocument!;
					const card = doc.querySelector(".share-card")!;
					const fontSize = doc.defaultView!.getComputedStyle(card).fontSize;
					const height = card.getBoundingClientRect().height;
					host.style.setProperty("--font-text-size", "32px");
					const frozen = await png(renderer);
					samples.push({ size, fontSize, height, data, frozen: frozen === data, end: card.textContent!.includes("THE END") });
				} finally { renderer.close(); }
			}
			host.style.setProperty("--font-text-size", "18px");
			const fontStyle = document.createElement("style"); document.head.append(fontStyle);
			const renderWith = async (family: string, css: string) => {
				fontStyle.textContent = css; host.style.setProperty("--font-text", family);
				const renderer = new ShareCardRenderer(host, true, async () => { throw Error("unexpected image"); });
				try { return await png(renderer, "paper", plain); } finally { renderer.close(); }
			};
			const system = await renderWith(`${systemFont},sans-serif`, "");
			const local = await renderWith("ShareLocal,sans-serif", `@font-face{font-family:ShareLocal;src:local("${systemFont}")}`);
			const unused = await renderWith(`${systemFont},ShareUnused,sans-serif`, '@font-face{font-family:ShareUnused;src:url("https://invalid.example.test/unused.woff2")}');
			const localFirst = await renderWith("ShareLocal,sans-serif", `@font-face{font-family:ShareLocal;src:local("${systemFont}"),url("https://invalid.example.test/fallback.woff2")}`);
			const localFallback = await renderWith("ShareLocal,sans-serif", `@font-face{font-family:ShareLocal;src:local("ShareMissingFont"),local("${systemFont}"),url("https://invalid.example.test/fallback.woff2")}`);
			const sourceFallback = await renderWith("ShareLocal,sans-serif", `@font-face{font-family:ShareLocal;src:url("data:font/woff2;base64,AAAA") format("woff2"),local("${systemFont}")}`);
			const unusedSubset = await renderWith(`ShareSubset,${systemFont},sans-serif`, '@font-face{font-family:ShareSubset;src:url("https://invalid.example.test/subset.woff2");unicode-range:U+4E00-9FFF}');
			fontStyle.textContent = "";
			host.style.setProperty("--font-text", "ShareImported,sans-serif");
			const importedCSS = `@font-face{font-family:ShareImported;src:local("${systemFont}")}`;
			await new Promise<void>((resolve, reject) => {
				fontStyle.onload = () => resolve(); fontStyle.onerror = () => reject(Error("import failed"));
				fontStyle.textContent = `@import url("data:text/css,${encodeURIComponent(importedCSS)}");`;
			});
			const importedRenderer = new ShareCardRenderer(host, true, async () => { throw Error("unexpected image"); });
			let imported: string;
			try { imported = await png(importedRenderer, "paper", plain); } finally { importedRenderer.close(); }
			fontStyle.onload = fontStyle.onerror = null;
			const embedded = fontData ? await renderWith("ShareEmbedded,sans-serif", `@font-face{font-family:ShareEmbedded;src:url("${fontData}")}`) : null;
			const failures = [];
			for (const src of ['url("data:font/woff2;base64,AAAA")', 'url("https://invalid.example.test/font.woff2")']) {
				try { await renderWith("ShareBroken,sans-serif", `@font-face{font-family:ShareBroken;src:${src}}`); failures.push("unexpected success"); }
				catch (error) { failures.push((error as any).reason); }
			}
			fontStyle.remove(); host.style.setProperty("--font-text", `${systemFont},sans-serif`);
			const renderer = new ShareCardRenderer(host, true, async () => { throw Error("unexpected image"); }, "data:image/png;base64,AAAA");
			try { await png(renderer, "reflection"); failures.push("unexpected success"); } catch (error) { failures.push((error as any).reason); } finally { renderer.close(); }
			return { samples, system, local, embedded, localMatches: system === local, embeddedMatches: embedded === null ? null : system === embedded,
				fallbackMatches: [unused, localFirst, localFallback, sourceFallback, unusedSubset, imported].map(value => value === system), failures };
		}, { fontData, systemFont: process.platform === "linux" ? "Liberation Sans" : "Arial" });
		mkdirSync(".tmp/share-card-samples", { recursive: true });
		for (const kind of ["system", "local", "embedded"] as const) if (result[kind]) writeFileSync(`.tmp/share-card-samples/font-${kind}.png`, Buffer.from(result[kind]!.split(",")[1], "base64"));
		assert.deepEqual(result.failures, ["font", "font", "cover"]);
		assert.equal(result.localMatches, true, "本地别名字体必须与系统目标字体产生同一 PNG");
		assert.deepEqual(result.fallbackMatches, [true, true, true, true, true, true], "未使用的候补字体、字源顺序及导入字体必须保留实际字体");
		assert.equal(remoteRequests, 0, "分享图片不得下载远程字体");
		if (fontData) assert.equal(result.embeddedMatches, true, "嵌入字体必须与同一系统字体产生同一 PNG");
		else context.diagnostic("KNOMO_SHARE_TEST_FONT unset: binary embedded font pixel comparison not run");
		mkdirSync(".tmp/share-card-samples", { recursive: true });
		for (const sample of result.samples) {
			assert.equal(sample.fontSize, sample.size + "px"); assert.ok(sample.frozen); assert.ok(sample.end);
			writeFileSync(`.tmp/share-card-samples/font-${sample.size}.png`, Buffer.from(sample.data.split(",")[1], "base64"));
		}
		assert.ok(result.samples[0].height < result.samples[1].height && result.samples[1].height < result.samples[2].height);
	} finally { await browser.close(); }
});

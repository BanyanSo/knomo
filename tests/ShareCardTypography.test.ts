import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { embedShareCardFonts, type ShareCardFontInput } from "../src/ui/share/ShareCardTypography";

test("同一分享会话复用字体 URL，不跨会话保留字源且取消后不继续读取", async () => {
	const dom = new JSDOM();
	const originalFetch = globalThis.fetch, originalReader = globalThis.FileReader;
	const urls: string[] = [];
	Object.assign(globalThis, { FileReader: dom.window.FileReader });
	globalThis.fetch = async input => {
		urls.push(String(input));
		return { ok: true, blob: async () => new dom.window.Blob(["font bytes"]) } as unknown as Response;
	};
	const input: ShareCardFontInput = {
		typography: { text: "Shared, sans-serif", ui: "Shared, sans-serif", mono: "monospace", size: 16 }, unavailable: false,
		rules: ["400", "600", "700"].map(weight => ({ family: "shared", base: "app://vault/theme.css",
			css: `@font-face{font-family:Shared;font-weight:${weight};src:local("Missing"),url("./font.woff2")}` })),
	};
	try {
		const css = await embedShareCardFonts(input, new AbortController().signal);
		assert.deepEqual(urls, ["app://vault/font.woff2"]);
		assert.equal(css.match(/data:/gu)?.length, 3);
		assert.equal(css.match(/local\("Missing"\)/gu)?.length, 3);
		await embedShareCardFonts(input, new AbortController().signal);
		assert.equal(urls.length, 2);
		const subset = { ...input, rules: input.rules.map(rule => ({ ...rule, unicodeRange: "U+4???" })) };
		await embedShareCardFonts(subset, new AbortController().signal, "Knomo 2026/10/28 October Wednesday");
		assert.equal(urls.length, 2, "不会使用的 CJK 子集不读取本地字源");
		await embedShareCardFonts(subset, new AbortController().signal, "中文");
		assert.equal(urls.length, 3, "实际字形命中子集时仍读取并复用字源");
		const emoji = { ...input, rules: input.rules.map(rule => ({ ...rule, unicodeRange: "U+1F300-1FAFF" })) };
		await embedShareCardFonts(emoji, new AbortController().signal, "🌱");
		assert.equal(urls.length, 4, "Unicode 范围按码点匹配 Emoji");
		const cancelled = new AbortController(); cancelled.abort();
		await assert.rejects(embedShareCardFonts(input, cancelled.signal), { name: "AbortError" });
		assert.equal(urls.length, 4);
	} finally {
		globalThis.fetch = originalFetch; Object.assign(globalThis, { FileReader: originalReader }); dom.window.close();
	}
});

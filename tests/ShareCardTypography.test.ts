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
		const protocols = { ...input, rules: [{ family: "shared", base: "app://vault/theme.css",
			css: '@font-face{font-family:Shared;src:url("https://example.test/font.woff2"),url("http://example.test/font.woff2"),url("data:font/woff2;base64,AQID"),url("blob:local-font"),url("file:///font.woff2"),url("capacitor://localhost/font.woff2")}' }] };
		const cssProtocols = await embedShareCardFonts(protocols, new AbortController().signal);
		assert.deepEqual(urls.slice(4), ["blob:local-font", "file:///font.woff2", "capacitor://localhost/font.woff2"]);
		assert.ok(cssProtocols.includes("data:font/woff2;base64,AQID"));
		assert.ok(!cssProtocols.includes("example.test"));
	} finally {
		globalThis.fetch = originalFetch; Object.assign(globalThis, { FileReader: originalReader }); dom.window.close();
	}
});

test("本地字体加载中途取消后拒绝输出，不继续读取后续字源", async () => {
	const originalFetch = globalThis.fetch;
	const controller = new AbortController();
	const urls: string[] = [];
	let started!: () => void;
	const ready = new Promise<void>(resolve => { started = resolve; });
	globalThis.fetch = async (url, init) => {
		urls.push(String(url));
		return new Promise<Response>((_resolve, reject) => {
			init!.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
			started();
		});
	};
	const input: ShareCardFontInput = { typography: { text: "Shared", ui: "Shared", mono: "Shared", size: 16 }, unavailable: false,
		rules: ["first", "second"].map(name => ({ family: "shared", base: "app://vault/theme.css", css: `@font-face{font-family:Shared;src:url("./${name}.woff2")}` })) };
	try {
		const rejected = assert.rejects(embedShareCardFonts(input, controller.signal), { name: "AbortError" });
		await ready; controller.abort(); await rejected;
		assert.deepEqual(urls, ["app://vault/first.woff2"]);
	} finally { globalThis.fetch = originalFetch; }
});

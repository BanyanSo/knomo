import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { build, type Plugin } from "esbuild";
import { JSDOM } from "jsdom";
import * as original from "../src/ui/share/ShareCardContent";
import { createCardMemo } from "./helpers/memoCardFixture";

test("分享生产构建移除自动链接依赖，保留显式 Markdown 与 WikiLink 的内容及拒绝边界", async () => {
	const importModule = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<{ shareCardBuildPlugin: Plugin }>;
	const { shareCardBuildPlugin } = await importModule(pathToFileURL(path.resolve("scripts/share-card-build.mjs")).href);
	const bundle = await build({ entryPoints: ["src/ui/share/ShareCardContent.ts"], plugins: [shareCardBuildPlugin],
		bundle: true, write: false, metafile: true, format: "cjs", platform: "browser", target: "es2018" });
	assert.ok(!Object.keys(bundle.metafile!.inputs).some(file => /node_modules\/linkify-it\//u.test(file)));
	const module = { exports: {} };
	const dom = new JSDOM();
	const previousCreateEl = Object.getOwnPropertyDescriptor(globalThis, "createEl");
	const createEl = (tag: string) => dom.window.document.createElement(tag);
	Object.defineProperty(globalThis, "createEl", { configurable: true, value: createEl });
	runInNewContext(bundle.outputFiles[0].text, { module, createEl });
	const production = module.exports as typeof original;
	try {
		for (const content of [
			"https://example.test bare URL stays literal",
			"[explicit](https://example.test) [[Note|别名]] ==**高亮**==",
			"[label][ref]\n\n[ref]: https://example.test",
			"- [x] Task\n- [ ] Other\n\n> [!note] Title\n> Body",
			"![[photo.png]]\n\n![again](photo.png)\n\n`$literal$`",
		]) {
			const memo = createCardMemo({ contentSnapshot: content, createdAt: "2026-10-28T08:30" });
			const images = new Map([["photo.png", "data:image/png;base64,AA=="]]);
			const expected = original.renderShareCard(dom.window.document, original.createShareCardSnapshot(memo, "en"), "paper", images);
			const actual = production.renderShareCard(dom.window.document, production.createShareCardSnapshot(memo, "en"), "paper", images);
			assert.equal(actual.outerHTML, expected.outerHTML, content);
			if (content.startsWith("https:")) assert.equal(actual.querySelector(".link"), null);
		}
		for (const content of ["$a *b* c$", "<script>alert(1)</script>", "```dataview\nLIST\n```", "[^note]: footnote"]) {
			assert.throws(() => production.shareCardTokens(content), error => (error as original.ShareCardError).reason === "unsupported");
		}
	} finally {
		dom.window.close();
		if (previousCreateEl) Object.defineProperty(globalThis, "createEl", previousCreateEl); else Reflect.deleteProperty(globalThis, "createEl");
	}
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { build } from "esbuild";

test("引用预览返回后的实际 CSS 不显示指针焦点环，键盘立即恢复提示", { skip: !process.env.KNOMO_LAYOUT_PLAYWRIGHT }, async () => {
	const { chromium } = require(process.env.KNOMO_LAYOUT_PLAYWRIGHT!);
	const bundle = await build({ stdin: { contents: 'export { focusForNavigation } from "./src/ui/NavigationFocus";', resolveDir: process.cwd() }, bundle: true, write: false, format: "iife", globalName: "NavigationFocusTest" });
	const browser = await chromium.launch({ channel: process.env.KNOMO_LAYOUT_BROWSER || "msedge", headless: true });
	try {
		const page = await browser.newPage();
		for (const theme of ["theme-light", "theme-dark"]) {
			await page.setContent(`<body class="${theme}"><main class="knomo-plugin"><button class="knomo-referrer-preview">引用预览</button><button id="next">下一项</button></main></body>`);
			await page.addStyleTag({ content: "body { --interactive-accent: #f4cabc; }" + readFileSync("styles.css", "utf8") });
			await page.addScriptTag({ content: bundle.outputFiles[0].text });
			await page.keyboard.press("Tab");
			assert.equal(await page.locator(".knomo-referrer-preview").evaluate((el: HTMLElement) => getComputedStyle(el).outlineStyle), "solid");
			await page.evaluate(() => (window as any).NavigationFocusTest.focusForNavigation(document.querySelector(".knomo-referrer-preview"), false));
			assert.deepEqual(await page.locator(".knomo-referrer-preview").evaluate((el: HTMLElement) => [document.activeElement === el, getComputedStyle(el).outlineStyle, getComputedStyle(el).boxShadow]), [true, "none", "none"]);
			await page.keyboard.press("Tab"); await page.keyboard.press("Shift+Tab");
			assert.equal(await page.locator(".knomo-referrer-preview").evaluate((el: HTMLElement) => getComputedStyle(el).outlineStyle), "solid");
		}
	} finally { await browser.close(); }
});

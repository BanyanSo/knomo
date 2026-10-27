import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdirSync } from "node:fs";
import { build } from "esbuild";

// 原生 Modal 的系统行为仍由实机验收负责；此宿主夹具验证真实产品控制器与 CSS。
const host = `
export const Platform = { isMobile:false };
export function getLanguage() { return 'en'; }
export class TFile {}
export class Modal {
 constructor(app) { this.app=app; this.containerEl=document.createElement('div'); this.containerEl.className='modal-container';
 this.modalEl=this.containerEl.createDiv({cls:'modal'}); this.titleEl=this.modalEl.createDiv({cls:'modal-title'}); this.contentEl=this.modalEl.createDiv({cls:'modal-content'}); }
 open() { document.body.append(this.containerEl); this.onOpen(); }
 close() { this.onClose(); this.containerEl.remove(); }
}
`;

test("share modal keeps current PNG, output failures, focus, independent scrolling and reachable controls across widths and themes", { skip: !process.env.KNOMO_LAYOUT_PLAYWRIGHT }, async () => {
	const { chromium } = require(process.env.KNOMO_LAYOUT_PLAYWRIGHT!);
	const bundle = await build({ stdin: { contents: `import { KnomoShareCardModal } from './src/ui/KnomoShareCardModal';
import { createShareCardSnapshot } from './src/ui/share/ShareCardContent'; import { Platform } from 'obsidian';
window.shareModalTest={KnomoShareCardModal,createShareCardSnapshot,Platform};`, resolveDir: process.cwd() }, bundle: true, write: false, format: "iife", platform: "browser",
		plugins: [{ name: "share-modal-host", setup(build) { build.onResolve({ filter: /^obsidian$/ }, () => ({ path: "host", namespace: "share-host" })); build.onLoad({ filter: /.*/, namespace: "share-host" }, () => ({ contents: host, loader: "js" })); } }] });
	mkdirSync(".tmp/share-card-samples", { recursive: true });
	const browser = await chromium.launch({ channel: process.env.KNOMO_LAYOUT_BROWSER || "msedge", headless: true });
	try {
		const page = await browser.newPage({ acceptDownloads: true });
		for (const [width, height] of [[320, 568], [390, 844], [844, 390], [1100, 800]]) for (const theme of ["theme-light", "theme-dark"]) {
			await page.setViewportSize({ width, height });
			await page.setContent(`<body class="${theme}"><button id="return">Card menu</button></body>`);
			await page.addStyleTag({ content: `*{box-sizing:border-box} body{margin:0;--background-primary:#fff;--background-secondary:#eee;--text-normal:#222;--text-muted:#666;--interactive-accent:#7860b8;--text-accent:#7860b8;--font-ui-small:13px;font:15px Arial}.theme-dark{--background-primary:#222;--background-secondary:#333;--text-normal:#eee;--text-muted:#bbb}.modal-container{position:fixed;inset:0;display:flex;align-items:center;justify-content:center}.modal{position:relative;background:var(--background-primary);color:var(--text-normal)}button{font:inherit} .modal-title{font-size:20px;line-height:28px}` + readFileSync("styles.css", "utf8") });
			await page.evaluate(() => {
				Object.defineProperty(HTMLElement.prototype, "win", { configurable: true, get() { return this.ownerDocument.defaultView; } });
				Object.assign(HTMLElement.prototype, {
					createEl(this: HTMLElement, tag: string, options: any = {}) { const el = this.ownerDocument.createElement(tag); if (options.cls) el.className = options.cls; if (options.text) el.textContent = options.text; for (const [key, value] of Object.entries(options.attr ?? {})) el.setAttribute(key, String(value)); this.append(el); return el; },
					createDiv(this: HTMLElement, options: any) { return this.createEl("div", options); }, addClass(this: HTMLElement, cls: string) { this.classList.add(cls); },
					setText(this: HTMLElement, value: string) { this.textContent = value; }, empty(this: HTMLElement) { this.replaceChildren(); }, instanceOf(this: HTMLElement, type: any) { return this instanceof type; },
				});
			});
			await page.addScriptTag({ content: bundle.outputFiles[0].text });
			await page.evaluate(({ mobile }: { mobile: boolean }) => {
				const api = (window as any).shareModalTest; api.Platform.isMobile = mobile;
				const state = (window as any).shareModalState = { reads: 0, locks: 0, unlocks: 0 };
				const snapshot = api.createShareCardSnapshot({ contentSnapshot: ("完整长文，保留本来的顺序与段落。Emoji 🌱 EnglishLongTextWithoutSpacesForWrapping。\n\n").repeat(45), createdAt: "2026-10-27T08:30", dailyRef: { path: "Daily/today.md" } }, "zh-CN");
				const modal = (window as any).shareModal = new api.KnomoShareCardModal({}, {
					loadSnapshot: async () => { state.reads++; return snapshot; }, loadImage: async () => { throw Error("unexpected image"); },
					lockScroll: () => { state.locks++; }, onClose: () => { state.unlocks++; }, returnFocusEl: document.getElementById("return"),
				}); modal.open();
			}, { mobile: width < 1000 });
			await page.locator(".knomo-share-preview > img").waitFor();
			const geometry = await page.evaluate(() => {
				const footer = document.querySelector(".knomo-share-footer")!.getBoundingClientRect();
				const preview = document.querySelector(".knomo-share-preview") as HTMLElement;
				return { footerBottom: footer.bottom, footerTop: footer.top, scroll: preview.scrollHeight > preview.clientHeight, previewHeight: preview.clientHeight,
					left: footer.left, right: footer.right };
			});
			assert.ok(geometry.footerBottom <= height && geometry.footerTop >= 0, `${width}/${height}/${theme}: footer within screen`);
			assert.ok(geometry.left >= 0 && geometry.right <= width); assert.ok(geometry.scroll); assert.ok(geometry.previewHeight >= 40);
			await page.locator('[data-template="editorial"]').click();
			await page.locator('[data-template="nocturne"]').click();
			await page.locator(".knomo-share-preview > img").waitFor();
			assert.equal(await page.locator('[data-template="nocturne"]').getAttribute("aria-pressed"), "true");
			assert.equal(await page.evaluate(() => (window as any).shareModalState.reads), 1);
			if (width === 1100 && theme === "theme-light") {
				// 重新探测时才显示图片剪贴板接口，操作拒绝不清除已生成的 PNG。
				await page.evaluate(() => {
					(window as any).ClipboardItem = class { static supports() { return true; } constructor(value: unknown) {} };
					(window as any).copyCalls = 0;
					Object.defineProperty(navigator, "clipboard", { configurable: true, value: { write() { (window as any).copyCalls++; return (window as any).copyCalls === 1 ? Promise.reject(Error("denied")) : Promise.resolve(); } } });
				});
				await page.locator('[data-template="paper"]').click(); await page.locator(".knomo-share-preview > img").waitFor();
				const source = await page.locator(".knomo-share-preview > img").getAttribute("src");
				await page.getByRole("button", { name: "Copy image", exact: true }).click();
				await page.getByRole("status").filter({ hasText: "Image output failed" }).waitFor();
				assert.equal(await page.locator(".knomo-share-preview > img").getAttribute("src"), source);
				await page.getByRole("button", { name: "Copy image", exact: true }).click();
				await page.getByRole("status").filter({ hasText: "Image copied" }).waitFor();
				const downloadEvent = page.waitForEvent("download"); await page.getByRole("button", { name: "Save PNG", exact: true }).click();
				const download = await downloadEvent; assert.equal(download.suggestedFilename(), "Memo-2026-10-27-0830.png");
				await download.saveAs(".tmp/share-card-samples/modal-download.png");
				assert.deepEqual(Array.from(readFileSync(".tmp/share-card-samples/modal-download.png").subarray(0, 8)), [137, 80, 78, 71, 13, 10, 26, 10]);
				await page.screenshot({ path: ".tmp/share-card-samples/modal-desktop.png" });
			}
			if (width === 390 && theme === "theme-light") {
				await page.screenshot({ path: ".tmp/share-card-samples/modal-mobile.png" });
				await page.evaluate(() => {
					let calls = 0;
					Object.defineProperty(navigator, "canShare", { configurable: true, value: () => true });
					Object.defineProperty(navigator, "share", { configurable: true, value: () => ++calls === 1 ? Promise.reject(new DOMException("cancel", "AbortError")) : Promise.reject(Error("unavailable")) });
				});
				await page.locator('[data-template="paper"]').click(); await page.locator(".knomo-share-preview > img").waitFor();
				await page.getByRole("button", { name: "Share image", exact: true }).click();
				assert.equal(await page.locator('[data-share-action="vault"]').count(), 0, "system cancellation is not a failure");
				await page.getByRole("button", { name: "Share image", exact: true }).click();
				await page.getByRole("button", { name: "Save to Vault root", exact: true }).waitFor();
				assert.equal(await page.locator(".knomo-share-preview > img").count(), 1);
			}
			await page.getByRole("button", { name: "Close image sharing", exact: true }).click();
			assert.equal(await page.locator("iframe").count(), 0);
			assert.equal(await page.evaluate(() => document.activeElement?.id), "return");
			assert.deepEqual(await page.evaluate(() => (window as any).shareModalState), { reads: 1, locks: 1, unlocks: 1 });
		}
	} finally { await browser.close(); }
});

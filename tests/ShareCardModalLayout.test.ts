import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdirSync } from "node:fs";
import { build } from "esbuild";

// 原生 Modal 的系统行为仍由实机验收负责；此宿主夹具验证真实产品控制器与 CSS。
const host = `
export const Platform = { isMobile:false };
export function getLanguage() { return 'en'; }
export class TFile {}
export function setIcon(el, icon) { el.textContent="↗"; el.dataset.icon=icon; }
export class Modal {
 constructor(app) { this.app=app; this.containerEl=document.createElement('div'); this.containerEl.className='modal-container';
 this.modalEl=this.containerEl.createDiv({cls:'modal'}); this.headerEl=this.modalEl.createDiv({cls:'modal-header'}); this.titleEl=this.headerEl.createDiv({cls:'modal-title'}); this.contentEl=this.modalEl.createDiv({cls:'modal-content'}); }
 open() { document.body.append(this.containerEl); this.onOpen(); }
 close() { this.onClose(); this.containerEl.remove(); }
}
`;

// 保留宿主原生标题容器及手机端内边距，覆盖自定义标题栏嵌套时的真实布局约束。
const mobileModalCss = `
.modal-header { margin-bottom: .75em; }
.is-phone .modal-header { margin-bottom: 0; padding: 24px 20px 16px; position: relative; width: 100%; display: flex; align-items: flex-end; }
.is-phone .modal-title { display: block; text-align: center; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 70vw; }
.is-phone .modal-content { display: flex; position: relative; flex-direction: column; margin-top: 0; overflow: auto; padding: 16px; }
`;

test("share modal keeps current PNG, output failures, focus, independent scrolling and reachable controls across widths and themes", { skip: !process.env.KNOMO_LAYOUT_PLAYWRIGHT }, async () => {
	const { chromium } = require(process.env.KNOMO_LAYOUT_PLAYWRIGHT!);
	const bundle = await build({ stdin: { contents: `import { KnomoShareCardModal } from './src/ui/KnomoShareCardModal';
import { createShareCardSnapshot, ShareCardError } from './src/ui/share/ShareCardContent'; import { Platform } from 'obsidian';
window.shareModalTest={KnomoShareCardModal,createShareCardSnapshot,ShareCardError,Platform};`, resolveDir: process.cwd() }, loader: { ".png": "dataurl", ".jpg": "dataurl", ".webp": "dataurl" }, bundle: true, write: false, format: "iife", platform: "browser",
		plugins: [{ name: "share-modal-host", setup(build) { build.onResolve({ filter: /^obsidian$/ }, () => ({ path: "host", namespace: "share-host" })); build.onLoad({ filter: /.*/, namespace: "share-host" }, () => ({ contents: host, loader: "js" })); } }] });
	mkdirSync(".tmp/share-card-samples", { recursive: true });
	const browser = await chromium.launch({ channel: process.env.KNOMO_LAYOUT_BROWSER || "msedge", headless: true });
	try {
		const page = await browser.newPage({ acceptDownloads: true });
		for (const [width, height] of [[320, 568], [390, 844], [844, 390], [768, 1024], [1100, 800]]) for (const theme of ["theme-light", "theme-dark", "theme-custom"]) {
			await page.setViewportSize({ width, height });
			await page.setContent(`<body class="${theme} ${width < 1000 ? "is-mobile is-phone" : ""}"><button id="return">Card menu</button></body>`);
			await page.addStyleTag({ content: mobileModalCss });
			await page.addStyleTag({ content: `*{box-sizing:border-box} body{margin:0;--background-primary:#fff;--background-secondary:#eee;--text-normal:#222;--text-muted:#666;--interactive-accent:#7860b8;--text-accent:#7860b8;--font-ui-small:13px;font:15px Arial}.theme-dark{--background-primary:#222;--background-secondary:#333;--text-normal:#eee;--text-muted:#bbb}.theme-custom{--background-primary:#f5f1dc;--background-secondary:#e8e1c4;--text-normal:#493c27;--interactive-accent:#086f65;--text-accent:#086f65;font-size:24px}.modal-container{position:fixed;inset:0;display:flex;align-items:center;justify-content:center}.modal{position:relative;background:var(--background-primary);color:var(--text-normal)}button{font:inherit} .modal-title{font-size:20px;line-height:28px}` + readFileSync("styles.css", "utf8") });
			await page.evaluate(() => {
				Object.defineProperty(HTMLElement.prototype, "win", { configurable: true, get() { return this.ownerDocument.defaultView; } });
				Object.assign(HTMLElement.prototype, {
					createEl(this: HTMLElement, tag: string, options: any = {}) { const el = this.ownerDocument.createElement(tag); if (options.cls) el.className = options.cls; if (options.text) el.textContent = options.text; for (const [key, value] of Object.entries(options.attr ?? {})) el.setAttribute(key, String(value)); this.append(el); return el; },
					createSpan(this: HTMLElement, options: any) { return this.createEl("span", options); },
					createDiv(this: HTMLElement, options: any) { return this.createEl("div", options); }, addClass(this: HTMLElement, cls: string) { this.classList.add(cls); },
					setText(this: HTMLElement, value: string) { this.textContent = value; }, empty(this: HTMLElement) { this.replaceChildren(); }, instanceOf(this: HTMLElement, type: any) { return this instanceof type; },
				});
			});
			await page.addScriptTag({ content: bundle.outputFiles[0].text });
			if (theme === "theme-custom") await page.addStyleTag({ content: ".theme-custom .modal-title{font-size:28px;line-height:40px}" });
			await page.evaluate(({ mobile }: { mobile: boolean }) => {
				const api = (window as any).shareModalTest; api.Platform.isMobile = mobile;
				const state = (window as any).shareModalState = { reads: 0, locks: 0, unlocks: 0 };
				const writes = (window as any).vaultWrites = [] as string[];
				const snapshot = api.createShareCardSnapshot({ contentSnapshot: ("完整长文，保留本来的顺序与段落。Emoji 🌱 EnglishLongTextWithoutSpacesForWrapping。\n\n").repeat(45), createdAt: "2026-10-27T08:30", dailyRef: { path: "Daily/today.md" } }, "zh-CN");
				const modal = (window as any).shareModal = new api.KnomoShareCardModal({ vault: {
					getAbstractFileByPath: (path: string) => path === "Knomo-20261027-083000.png" || writes.includes(path) ? {} : null,
					createBinary: async (path: string) => { writes.push(path); },
				} }, {
					loadSnapshot: async () => { state.reads++; return snapshot; }, loadImage: async () => { throw Error("unexpected image"); },
					lockScroll: () => { state.locks++; }, onClose: () => { state.unlocks++; }, returnFocusEl: document.getElementById("return"),
				}); modal.open();
			}, { mobile: width < 1000 });
			await page.locator(".knomo-share-preview > img").waitFor();
			assert.equal(await page.locator(".knomo-share-status").textContent(), "");
			assert.equal(await page.getByRole("button", { name: "Retry", exact: true }).count(), 0);
			assert.equal(await page.locator(".knomo-share-templates > button").count(), 4);
			assert.deepEqual(await page.locator(".knomo-share-templates > button").allTextContents(), ["Paper", "Daybook", "Reflection", "Midnight"]);
			assert.ok(await page.locator(".knomo-share-templates > button").evaluateAll((buttons: HTMLElement[]) => buttons.every(button => {
				const decoration = getComputedStyle(button, "::after").content;
				return decoration === "none" || decoration === "normal" || decoration === '""';
			})));
			await page.locator(".knomo-share-actions button").last().scrollIntoViewIfNeeded();
			const geometry = await page.evaluate(() => {
				const footer = document.querySelector(".knomo-share-footer")!.getBoundingClientRect();
				const preview = document.querySelector(".knomo-share-preview") as HTMLElement;
				const modal = document.querySelector(".knomo-share-modal")!.getBoundingClientRect();
				const title = document.querySelector(".knomo-share-modal .modal-title")!;
				const titleRect = title.getBoundingClientRect();
				const close = document.querySelector(".knomo-share-close")!.getBoundingClientRect();
				const header = document.querySelector(".knomo-share-header")!.getBoundingClientRect();
				const previewRect = preview.getBoundingClientRect();
				const range = document.createRange(); range.selectNodeContents(title);
				const titleText = range.getBoundingClientRect();
				return { footerBottom: footer.bottom, footerTop: footer.top, scroll: preview.scrollHeight > preview.clientHeight, previewHeight: preview.clientHeight,
					left: footer.left, right: footer.right, background: getComputedStyle(preview).backgroundColor, buttonHeights: Array.from(document.querySelectorAll(".knomo-share-templates button"), el => el.getBoundingClientRect().height),
					titleCenterOffset: Math.abs(titleText.left + titleText.width / 2 - modal.left - modal.width / 2),
					closeCenterOffset: Math.abs(close.top + close.height / 2 - titleRect.top - titleRect.height / 2),
					headerTopGap: header.top - modal.top, previewTopGap: previewRect.top - header.bottom,
					closeRightGap: modal.right - close.right,
					buttonCursors: Array.from(document.querySelectorAll(".knomo-share-modal button:not(:disabled)"), el => getComputedStyle(el).cursor) };
			});
			assert.ok(geometry.footerBottom <= height && geometry.footerTop >= 0, `${width}/${height}/${theme}: footer within screen`);
			assert.equal(geometry.background, "rgba(0, 0, 0, 0)");
			assert.ok(geometry.buttonHeights.every((height: number) => height >= 44));
			assert.ok(geometry.left >= 0 && geometry.right <= width); assert.ok(geometry.scroll); assert.ok(geometry.previewHeight >= 40);
			assert.ok(geometry.titleCenterOffset < 1, `${width}/${height}/${theme}: title text centered within modal`);
			assert.ok(geometry.closeCenterOffset < 1, `${width}/${height}/${theme}: close button vertically aligned with title`);
			if (width < 1000) {
				assert.ok(geometry.headerTopGap <= 20, `${width}/${height}/${theme}: compact mobile header inset`);
				assert.ok(geometry.previewTopGap <= 12, `${width}/${height}/${theme}: preview directly below header`);
				assert.ok(geometry.closeRightGap <= 20, `${width}/${height}/${theme}: close button at right edge`);
			}
			assert.ok(geometry.buttonCursors.every((cursor: string) => cursor === "pointer"));
			assert.equal(await page.locator(".knomo-share-close[aria-label], .knomo-share-preview[aria-label], .knomo-share-templates[aria-label]").count(), 0);
			assert.equal(await page.locator(".knomo-share-preview > img").getAttribute("alt"), "");
			await page.locator('[data-template="reflection"]').click();
			await page.locator('[data-template="daybook"]').click();
			await page.locator(".knomo-share-preview > img").waitFor();
			assert.equal(await page.locator('[data-template="daybook"]').getAttribute("aria-pressed"), "true");
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
				await page.getByRole("button", { name: "Copy", exact: true }).click();
				await page.getByRole("status").filter({ hasText: "Image output failed" }).waitFor();
				assert.equal(await page.locator(".knomo-share-status").textContent(), "Image output failed. Retry or use another action.");
				assert.equal(await page.locator(".knomo-share-status").evaluate((el: HTMLElement) => el.classList.contains("is-error")), true);
				assert.equal(await page.locator(".knomo-share-preview > img").getAttribute("src"), source);
				await page.getByRole("button", { name: "Copy", exact: true }).click();
				assert.equal(await page.locator(".knomo-share-status").textContent(), "");
				assert.equal(await page.locator(".knomo-share-status").evaluate((el: HTMLElement) => el.classList.contains("is-error")), false);
				const downloadEvent = page.waitForEvent("download"); await page.getByRole("button", { name: "Save", exact: true }).click();
				const download = await downloadEvent; assert.equal(download.suggestedFilename(), "Knomo-20261027-083000.png");
				assert.equal(await page.locator(".knomo-share-status").textContent(), "");
				await download.saveAs(".tmp/share-card-samples/modal-download.png");
				assert.deepEqual(Array.from(readFileSync(".tmp/share-card-samples/modal-download.png").subarray(0, 8)), [137, 80, 78, 71, 13, 10, 26, 10]);
				const previewBytes = await page.evaluate(async () => {
					const modal = (window as any).shareModal;
					const preview = await (await fetch(document.querySelector<HTMLImageElement>(".knomo-share-preview > img")!.src)).arrayBuffer();
					return { preview: Array.from(new Uint8Array(preview)), file: Array.from(new Uint8Array(await modal.file.arrayBuffer())) };
				});
				assert.deepEqual(previewBytes.preview, previewBytes.file);
				assert.deepEqual(Array.from(readFileSync(".tmp/share-card-samples/modal-download.png")), previewBytes.file);
				await page.screenshot({ path: ".tmp/share-card-samples/modal-desktop.png" });
			}
			if (width === 390 && theme === "theme-light") {
				await page.screenshot({ path: ".tmp/share-card-samples/modal-mobile.png" });
				await page.evaluate(() => {
					let calls = 0;
					Object.defineProperty(navigator, "canShare", { configurable: true, value: () => true });
					(window as any).sharedFiles = [];
					Object.defineProperty(navigator, "share", { configurable: true, value: ({ files }: { files: File[] }) => {
						if (files[0] !== (window as any).shareModal.file) throw Error("share must use the ready PNG File");
						(window as any).sharedFiles.push(files[0].name);
						return ++calls === 1 ? Promise.reject(new DOMException("cancel", "AbortError")) : calls === 2 ? Promise.reject(Error("unavailable")) : Promise.resolve();
					} });
				});
				await page.locator('[data-template="paper"]').click(); await page.locator(".knomo-share-preview > img").waitFor();
				await page.getByRole("button", { name: "Share", exact: true }).click();
				assert.equal(await page.locator('[data-share-action="vault"]').count(), 0, "system cancellation is not a failure");
				assert.equal(await page.locator(".knomo-share-status").textContent(), "");
				await page.getByRole("button", { name: "Share", exact: true }).click();
				await page.getByRole("button", { name: "Save to Vault root", exact: true }).waitFor();
				assert.equal(await page.locator(".knomo-share-preview > img").count(), 1);
				for (let attempt = 0; attempt < 2; attempt++) {
					await page.getByRole("button", { name: "Save to Vault root", exact: true }).click();
					await page.waitForFunction((expected: number) => (window as any).vaultWrites.length === expected
						&& document.querySelector('[data-share-action="vault"]:not(:disabled)') !== null, attempt + 1, { timeout: 10000 });
					assert.equal(await page.locator(".knomo-share-status").textContent(), "");
					assert.equal(await page.evaluate(() => (window as any).vaultWrites.length), attempt + 1);
					assert.equal(await page.locator(".knomo-share-status").evaluate((el: HTMLElement) => el.classList.contains("is-error")), false);
				}
				assert.deepEqual(await page.evaluate(() => (window as any).vaultWrites), ["Knomo-20261027-083000-2.png", "Knomo-20261027-083000-3.png"]);
				await page.getByRole("button", { name: "Share", exact: true }).click();
				assert.equal(await page.locator(".knomo-share-status").textContent(), "");
				assert.deepEqual(await page.evaluate(() => (window as any).sharedFiles), Array(3).fill("Knomo-20261027-083000.png"));
			}
			await page.locator(".knomo-share-close").click();
			assert.equal(await page.locator("iframe").count(), 0);
			assert.equal(await page.evaluate(() => document.activeElement?.id), "return");
			assert.deepEqual(await page.evaluate(() => (window as any).shareModalState), { reads: 1, locks: 1, unlocks: 1 });
		}
		for (const mode of ["stale", "retry", "close"] as const) {
			await page.evaluate((mode: string) => {
				const api = (window as any).shareModalTest;
				const state = (window as any).failureState = { reads: 0, images: 0 };
				const modal = (window as any).failureModal = new api.KnomoShareCardModal({}, {
					loadSnapshot: async () => {
						state.reads++;
						if (mode === "stale") throw new api.ShareCardError("stale");
						if (mode === "close") await new Promise(resolve => { (window as any).finishSnapshot = resolve; });
						return api.createShareCardSnapshot({ contentSnapshot: "![[photo.png]]", createdAt: "2026-10-27T08:30", dailyRef: { path: "Daily/test.md" } }, "en");
					},
					loadImage: async () => {
						if (++state.images === 1) throw new api.ShareCardError("image");
						return new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="green"/></svg>'], { type: "image/svg+xml" });
					}, lockScroll() {}, onClose() {}, returnFocusEl: document.getElementById("return"),
				}); modal.open();
			}, mode);
			assert.equal(await page.locator(".knomo-share-actions button:not(:disabled)").count(), 0);
			if (mode === "close") {
				await page.evaluate(() => { (window as any).failureModal.close(); (window as any).finishSnapshot(); });
				await page.waitForTimeout(100);
				assert.equal(await page.locator("iframe, .knomo-share-preview img").count(), 0);
				assert.equal(await page.evaluate(() => (window as any).failureState.images), 0);
				continue;
			}
			await page.locator(".knomo-share-status:not(:empty)").waitFor();
			if (mode === "stale") {
				assert.equal(await page.locator(".knomo-share-templates button:not(:disabled)").count(), 0);
				await page.evaluate(() => (window as any).failureModal.select("midnight"));
				assert.equal(await page.evaluate(() => (window as any).failureState.reads), 1);
			} else {
				await page.locator('[data-template="paper"]').click();
				await page.locator(".knomo-share-preview img").waitFor();
				assert.equal(await page.locator(".knomo-share-status").textContent(), "");
				assert.deepEqual(await page.evaluate(() => (window as any).failureState), { reads: 1, images: 2 });
			}
			await page.evaluate(() => (window as any).failureModal.close());
		}

		// 控制器与真实 DOM 的交接回归；强制失焦只模拟已知时序，不替代移动设备证据。
		await page.setViewportSize({ width: 390, height: 844 });
		for (let cycle = 0; cycle < 3; cycle++) {
			await page.evaluate(() => {
				const api = (window as any).shareModalTest; api.Platform.isMobile = true;
				const state = (window as any).handoff = { focused: false, requests: 0, selects: 0, shares: 0, activation: false, trace: [] as string[] };
				Object.defineProperty(document, "hasFocus", { configurable: true, value: () => state.focused });
				window.focus = () => { state.requests++; };
				Object.defineProperty(navigator, "canShare", { configurable: true, value: () => true });
				Object.defineProperty(navigator, "share", { configurable: true, value: () => {
					state.shares++; state.activation = navigator.userActivation.isActive; state.trace.push("share-handler"); return Promise.resolve();
				} });
				const modal = (window as any).handoffModal = new api.KnomoShareCardModal({}, {
					loadSnapshot: async () => api.createShareCardSnapshot({ contentSnapshot: "short", createdAt: "2026-10-28T19:38", dailyRef: { path: "Daily/test.md" } }, "en"),
					loadImage: async () => { throw Error("unexpected image"); }, lockScroll() {}, onClose() {}, focusVisible: false,
					returnFocusEl: document.getElementById("return"),
				});
				const select = modal.select.bind(modal);
				modal.select = (id: string) => { state.selects++; state.trace.push("select-handler"); select(id); };
				modal.open();
			});
			await page.locator(".knomo-share-preview img").waitFor();
			assert.ok(await page.evaluate(() => (window as any).handoff.requests > 0));
			assert.equal(await page.locator(".knomo-share-close").evaluate((el: HTMLElement) => document.activeElement === el && el.hasAttribute("data-knomo-pointer-focus")), true);
			assert.equal(await page.locator(".knomo-share-close").evaluate((el: HTMLElement) => getComputedStyle(el).outlineStyle), "none");
			await page.keyboard.press("Tab"); await page.keyboard.press("Shift+Tab");
			assert.equal(await page.locator(".knomo-share-close").evaluate((el: HTMLElement) => document.activeElement === el), true);
			assert.equal(await page.locator(".knomo-share-close").evaluate((el: HTMLElement) => getComputedStyle(el).outlineStyle), "solid");
			const tapMissingClick = async (selector: string) => {
				await page.evaluate((selector: string) => {
					const state = (window as any).handoff; state.focused = false;
					const target = document.querySelector(selector)!; const rect = target.getBoundingClientRect();
					const point = { identifier: 1, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
					state.point = point;
					for (const type of ["touchstart", "touchend"]) {
						const event = new Event(type, { bubbles: true, cancelable: true });
						Object.defineProperties(event, { touches: { value: type === "touchend" ? [] : [point] }, changedTouches: { value: [point] } });
						state.trace.push(type); target.dispatchEvent(event);
					}
					setTimeout(() => { state.focused = true; state.trace.push("window-focus"); window.dispatchEvent(new Event("focus")); }, 46);
				}, selector);
				await page.waitForTimeout(180);
			};
			await tapMissingClick('[data-template="daybook"]');
			assert.equal(await page.locator('[data-template="daybook"]').getAttribute("aria-pressed"), "true");
			assert.equal(await page.evaluate(() => (window as any).handoff.selects), 2);
			await page.evaluate(() => {
				const point = (window as any).handoff.point;
				document.elementFromPoint(point.clientX, point.clientY)!.dispatchEvent(new MouseEvent("click", { ...point, detail: 1, bubbles: true, cancelable: true }));
			});
			assert.equal(await page.evaluate(() => (window as any).handoff.selects), 2);
			await page.locator(".knomo-share-preview img").waitFor();
			await tapMissingClick('[data-share-action="share"]');
			assert.equal(await page.evaluate(() => (window as any).handoff.shares), 0, "系统分享不通过延时 click 补执行");
			await page.getByRole("button", { name: "Share", exact: true }).click();
			assert.deepEqual(await page.evaluate(() => [(window as any).handoff.shares, (window as any).handoff.activation]), [1, true]);
			await page.keyboard.press("Tab");
			assert.equal(await page.locator("[data-knomo-pointer-focus]").count(), 0);
			assert.equal(await page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle), "solid");
			await tapMissingClick(".knomo-share-close");
			assert.equal(await page.locator(".knomo-share-modal").count(), 0);
			assert.equal(await page.evaluate(() => document.activeElement?.id), "return");
			assert.equal(await page.locator("#return").evaluate((el: HTMLElement) => el.hasAttribute("data-knomo-pointer-focus")), true);
			await page.evaluate(() => {
				(window as any).handoff.focused = true;
				window.dispatchEvent(new Event("focus"));
			});
			await page.waitForTimeout(120);
			assert.equal(await page.evaluate(() => document.activeElement?.id), "return");
		}
	} finally { await browser.close(); }
});

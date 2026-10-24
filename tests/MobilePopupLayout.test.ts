import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { build } from "esbuild";
import { createMobilePopupFixture } from "./helpers/mobilePopupFixture";

// 宿主 Menu 的实际呈现需在 Obsidian 验收；这里验证 Knomo 的命中区、层级和桌面样式。
test("mobile touch targets and confirm layering work across themes, host font overrides, Knomo Token scales and orientations; desktop popovers share the menu width", { skip: !process.env.KNOMO_LAYOUT_PLAYWRIGHT }, async () => {
	const editFixture = await createMobilePopupFixture("cancel-edit");
	const editingHtml = editFixture.layer.innerHTML, cardHtml = editFixture.card.outerHTML, scopeHtml = editFixture.scopeMenu.outerHTML;
	editFixture.close();
	const referenceFixture = await createMobilePopupFixture("clear-reference");
	const referenceHtml = referenceFixture.layer.innerHTML;
	referenceFixture.close();
	const { chromium } = require(process.env.KNOMO_LAYOUT_PLAYWRIGHT!);
	const browser = await chromium.launch({ channel: process.env.KNOMO_LAYOUT_BROWSER || "msedge", headless: true });
	const css = readFileSync("styles.css", "utf8");
	const bundle = await build({ stdin: { contents: 'export { MobileComposerController } from "./src/ui/MobileComposerController";', resolveDir: process.cwd(), loader: "ts" }, bundle: true, write: false, format: "iife", globalName: "TouchFixture" });
	const hostCss = process.env.KNOMO_HOST_CSS ? readFileSync(process.env.KNOMO_HOST_CSS, "utf8") : "";
	if (process.env.KNOMO_POPUP_SCREENSHOTS) mkdirSync(process.env.KNOMO_POPUP_SCREENSHOTS, { recursive: true });
	try {
		const page = await browser.newPage();
		const errors: string[] = [];
		page.on("pageerror", (error: Error) => errors.push(error.message));
		for (const theme of ["theme-light", "theme-dark"]) for (const { size, scale } of [{ size: 15, scale: 1 }, { size: 22, scale: 1 }, { size: 15, scale: 1.5 }, { size: 15, scale: 2 }]) for (const [width, height] of [[320, 700], [740, 320], [240, 500]]) {
			await page.setViewportSize({ width, height });
			for (const [mode, html] of [["edit", editingHtml], ["reference", referenceHtml]]) {
				await page.setContent(`<style>${hostCss}${css}
					body { margin:0; display:block; font:${size}px Arial; --font-ui-medium:${size}px; --font-preferred-size:${size}px; --font-ui-small:14px; --border-width:1px; --size-4-3:12px; --size-4-4:16px; --size-4-8:32px; --layer-modal:50; }
					body { --knomo-text-ui-medium:${15 * scale}px; --knomo-text-ui-base:${14 * scale}px; --knomo-text-meta:${13 * scale}px; --knomo-text-caption:${12 * scale}px; }
					.theme-light { --background-primary:#fff; --background-secondary:#f6f6f6; --background-modifier-border:#ddd; --text-normal:#222; --text-muted:#666; --text-faint:#888; --interactive-accent:#6479e5; }
					.theme-dark { --background-primary:#202020; --background-secondary:#282828; --background-modifier-border:#444; --text-normal:#eee; --text-muted:#bbb; --text-faint:#999; --interactive-accent:#8290f0; }
					#root { display:block; height:100vh; width:100%; } .modal-container { position:fixed; inset:0; display:flex; align-items:center; justify-content:center; z-index:var(--layer-modal); }
				</style><body class="is-mobile ${theme}"><div id="root" class="knomo-plugin is-layout-mobile">${scopeHtml}${cardHtml}</div>
					<div class="knomo-plugin is-layout-mobile knomo-mobile-composer-layer is-active is-open"><div class="knomo-mobile-composer-backdrop"></div><div class="knomo-mobile-composer-stage"><div class="knomo-mobile-composer-content">${html}</div></div></div>
					<div id="confirm" class="modal-container knomo-confirm-backdrop" style="display:none"><div class="modal knomo-confirm-modal"><div class="knomo-confirm-message">确认操作</div><div class="knomo-confirm-actions"><button class="knomo-confirm-button" id="cancel">取消</button><button class="knomo-confirm-button mod-warning">确认</button></div></div></div></body>`);
				await page.addScriptTag({ content: bundle.outputFiles[0].text });
				await page.evaluate(() => {
					Object.assign(HTMLElement.prototype, {
						createDiv(this: HTMLElement, options: { cls?: string; attr?: Record<string,string> } = {}) {
							const el=document.createElement("div");el.className=options.cls ?? "";
							for(const [key,value] of Object.entries(options.attr ?? {})) el.setAttribute(key,value);
							return this.appendChild(el);
						},
						setAttr(this: HTMLElement,key:string,value:string){this.setAttribute(key,value);},
						toggleClass(this: HTMLElement,key:string,value:boolean){this.classList.toggle(key,value);},
						hasClass(this: HTMLElement,key:string){return this.classList.contains(key);},
						setCssProps(this: HTMLElement,props:Record<string,string>){for(const [key,value] of Object.entries(props))this.style.setProperty(key,value);},
						detach(this: HTMLElement){this.remove();},
					});
					type Controller = { prepare():void;open():void;getMaxInputHeight():number;dispose():void };
					const win=window as unknown as { TouchFixture: { MobileComposerController:new(options:object)=>Controller };touchController:Controller };
					const root=document.getElementById("root")!,composer=document.querySelector<HTMLElement>(".knomo-composer")!,input=composer.querySelector<HTMLElement>(".cm-content")!;
					root.appendChild(composer);document.querySelector(".knomo-mobile-composer-layer")!.remove();
					let open=false;
					const controller=new win.TouchFixture.MobileComposerController({
						getWindow:()=>window,getDocument:()=>document,getContainerEl:()=>root,getRootEl:()=>root,
						getComposerEl:()=>composer,getInputEl:()=>input,getComposerBarEl:()=>composer.querySelector(".knomo-composer-bar"),getReferencePreviewEl:()=>composer.querySelector(".knomo-reference-preview"),
						getLayout:()=>"mobile",isComposerOpen:()=>open,setComposerOpen:(value:boolean)=>{open=value;},getCardFlowScrollTop:()=>0,
						registerBackdropClick:()=>{},closeComposerKeepingDraft:()=>{},focusInputNow:()=>input.focus(),
						resizeInput:()=>{composer.querySelector<HTMLElement>(".cm-scroller")!.style.maxHeight=controller.getMaxInputHeight()+"px";},
						syncRootState:()=>{},syncComposerMode:()=>{},updateSendButtonState:()=>{},updateCancelEditButtonState:()=>{},
					});
					win.touchController=controller;controller.prepare();controller.open();
				});
				await page.waitForTimeout(280);
				assert.equal(await page.locator(".knomo-cancel-edit-button").evaluate((el: HTMLElement) => getComputedStyle(el).fontSize), `${14 * scale}px`);
				if (mode === "reference") assert.equal(await page.locator(".knomo-reference-preview-text").evaluate((el: HTMLElement) => getComputedStyle(el).fontSize), `${13 * scale}px`);
				const selectors = [".knomo-send-button", ".knomo-tool-button", mode === "edit" ? ".knomo-cancel-edit-button" : ".knomo-reference-clear"];
				for (const selector of selectors) {
					const target = await page.locator(selector).first().evaluate((button: HTMLElement) => {
						const rect = button.getBoundingClientRect();
						return { width:rect.width, height:rect.height, x:rect.left,y:rect.top, hitElement:document.elementFromPoint(rect.left + rect.width/2, rect.top + rect.height/2)?.outerHTML.slice(0,180), hit:button.contains(document.elementFromPoint(rect.left + rect.width/2, rect.top + rect.height/2)) };
					});
					assert.ok(target.width >= 44 && target.height >= 44 && target.hit, JSON.stringify({ theme, size, width, height, mode, selector, target }));
				}
				const keyboardHeight = height > 500 ? 300 : height > 320 ? 200 : 120;
				await page.evaluate((keyboardHeight: number) => {
					window.dispatchEvent(new CustomEvent("keyboardWillShow", { detail: { keyboardHeight } }));
					window.dispatchEvent(new CustomEvent("keyboardDidShow", { detail: { keyboardHeight } }));
				}, keyboardHeight);
				await page.waitForTimeout(280);
				for (const selector of [".knomo-send-button", mode === "edit" ? ".knomo-cancel-edit-button" : ".knomo-reference-clear"]) {
					const target = await page.locator(selector).first().evaluate((button: HTMLElement) => {
						const rect = button.getBoundingClientRect();
						return { top:rect.top, bottom:rect.bottom, hit:button.contains(document.elementFromPoint(rect.left+rect.width/2, rect.top+rect.height/2)) };
					});
					assert.ok(target.top>=0 && target.bottom<=height-keyboardHeight+6 && target.hit, JSON.stringify({ theme,size,width,height,mode,selector,keyboardHeight,target }));
				}
				await page.evaluate(() => {
					window.dispatchEvent(new Event("keyboardWillHide"));
					window.dispatchEvent(new Event("keyboardDidHide"));
				});
				await page.waitForTimeout(280);
				assert.equal(await page.locator(".knomo-card-actions").evaluate((menu: HTMLElement) => getComputedStyle(menu).display), "none");
				assert.equal(await page.locator(".knomo-mobile-scope-popover").evaluate((menu: HTMLElement) => getComputedStyle(menu).display), "none");
				const alpha = await page.locator(".knomo-mobile-composer-backdrop").evaluate((el: HTMLElement) => getComputedStyle(el).backgroundColor);
				assert.match(alpha, /0\.4\)/u);
				await page.locator("#confirm").evaluate((el: HTMLElement) => el.style.display = "flex");
				const modalHit = await page.locator("#cancel").evaluate((button: HTMLElement) => {
					const rect=button.getBoundingClientRect();return button.contains(document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2));
				});
				assert.equal(modalHit, true, "确认框必须在 Composer 上方并可操作");
				if (process.env.KNOMO_POPUP_SCREENSHOTS && width === 320 && size === 15 && mode === "edit") await page.screenshot({ path: resolve(process.env.KNOMO_POPUP_SCREENSHOTS, `${theme}-confirm.png`) });
				await page.locator("#confirm").evaluate((el: HTMLElement) => el.style.display = "none");
				await page.evaluate(() => { (window as unknown as { touchController:{dispose():void} }).touchController.dispose();document.querySelector<HTMLElement>(".knomo-composer")!.style.display="none"; });
				await page.locator("#root").evaluate((root: HTMLElement) => {
					root.classList.add("is-drawer-open");
					const sidebar=document.createElement("aside");sidebar.className="knomo-sidebar";
					sidebar.innerHTML='<button class="knomo-sidebar-action">刷新</button><div class="knomo-tag-row"><button class="knomo-tag-nav">标签</button><button class="knomo-tag-toggle">展开</button></div><button class="knomo-mobile-search-chip">本周</button>';
					root.appendChild(sidebar);
				});
				await page.waitForTimeout(280);
				for (const selector of [".knomo-sidebar-action", ".knomo-tag-nav", ".knomo-tag-toggle", ".knomo-mobile-search-chip"]) {
					const geometry=await page.locator(selector).evaluate((button: HTMLElement) => {
						const rect=button.getBoundingClientRect();return { width:rect.width,height:rect.height,hit:button.contains(document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2)) };
					});
					assert.ok(geometry.width>=44 && geometry.height>=44 && geometry.hit,JSON.stringify({ selector,geometry,width,height }));
				}
				assert.equal(await page.locator(".knomo-tag-nav").evaluate((el: HTMLElement) => getComputedStyle(el).fontSize), `${14 * scale}px`);
				assert.equal(await page.locator(".knomo-mobile-search-chip").evaluate((el: HTMLElement) => getComputedStyle(el).fontSize), `${13 * scale}px`);
			}
		}
		await page.setViewportSize({ width:1000,height:720 });
		await page.setContent(`<style>${hostCss}${css}body{display:block;--font-ui-medium:15px;--border-width:1px;--background-primary:white}</style><body><div class="knomo-plugin is-layout-desktop-wide is-scope-open">${scopeHtml.replace("knomo-mobile-scope-popover","knomo-desktop-scope-popover")}${cardHtml}</div></body>`);
		await page.locator(".knomo-card").evaluate((card: HTMLElement) => card.classList.add("is-menu-open"));
		await page.waitForTimeout(200);
		const desktop=await page.locator(".knomo-card-actions").evaluate((menu: HTMLElement) => ({ width:menu.getBoundingClientRect().width,display:getComputedStyle(menu).display }));
		assert.equal(desktop.width,168);assert.equal(desktop.display,"flex");
		assert.equal(await page.locator(".knomo-reference-clear").count(),0);
		assert.deepEqual(errors,[]);
	} finally { await browser.close(); }
});

test("Composer coordinates keyboard dismissal, visual exit and reentry in a real browser", { skip: !process.env.KNOMO_LAYOUT_PLAYWRIGHT }, async (t) => {
	const f = await createMobilePopupFixture();
	const html = f.layer.innerHTML;
	f.close();
	const bundle = await build({
		stdin: { contents: 'export { MobileComposerController } from "./src/ui/MobileComposerController";', resolveDir: process.cwd(), loader: "ts" },
		bundle: true, write: false, format: "iife", globalName: "ComposerFixture",
	});
	const { chromium } = require(process.env.KNOMO_LAYOUT_PLAYWRIGHT!);
	const browser = await chromium.launch({ channel: process.env.KNOMO_LAYOUT_BROWSER || "msedge", headless: true });
	try {
		const page = await browser.newPage({ viewport: { width: 390, height: 720 } });
		const errors: string[] = [];
		page.on("pageerror", (error: Error) => errors.push(error.message));
		await page.setContent(`<style>${readFileSync("styles.css", "utf8")}body{margin:0;display:block}#root{height:100vh}</style><body><div id="root" class="knomo-plugin is-layout-mobile">${html}</div><button id="underlying">Underlying</button></body>`);
		await page.addScriptTag({ content: bundle.outputFiles[0].text });
		await page.evaluate(() => {
			Object.assign(HTMLElement.prototype, {
				createDiv(this: HTMLElement, options: { cls?: string; attr?: Record<string, string> } = {}) {
					const el = document.createElement("div"); el.className = options.cls ?? "";
					for (const [key, value] of Object.entries(options.attr ?? {})) el.setAttribute(key, value);
					return this.appendChild(el);
				},
				setAttr(this: HTMLElement, key: string, value: string) { this.setAttribute(key, value); },
				hasClass(this: HTMLElement, cls: string) { return this.classList.contains(cls); },
				toggleClass(this: HTMLElement, cls: string, enabled: boolean) { this.classList.toggle(cls, enabled); },
				setCssProps(this: HTMLElement, props: Record<string, string>) { for (const [key, value] of Object.entries(props)) this.style.setProperty(key, value); },
				detach(this: HTMLElement) { this.remove(); },
			});
			const win = window as unknown as { ComposerFixture: { MobileComposerController: new (options: object) => object }; composerController: object; viewportProbe: EventTarget & { height: number }; closedCalls: number; keyboardOnFocus: boolean };
			const viewport = Object.assign(new EventTarget(), { height: 720, width: 390, offsetTop: 0, offsetLeft: 0 });
			Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
			win.viewportProbe = viewport; win.closedCalls = 0; win.keyboardOnFocus = true;
			const root = document.getElementById("root")!, composer = root.querySelector<HTMLElement>(".knomo-composer")!, input = composer.querySelector<HTMLElement>(".cm-content")!;
			let open = false;
			const controller = new win.ComposerFixture.MobileComposerController({
				getWindow: () => window, getDocument: () => document, getContainerEl: () => root, getRootEl: () => root,
				getComposerEl: () => composer, getInputEl: () => input, getComposerBarEl: () => composer.querySelector(".knomo-composer-bar"),
				getReferencePreviewEl: () => null, getLayout: () => "mobile", isComposerOpen: () => open, setComposerOpen: (value: boolean) => { open = value; },
				getCardFlowScrollTop: () => 0, registerBackdropClick: () => {}, closeComposerKeepingDraft: () => {},
				focusInputNow: () => {
					input.focus();
					if (win.keyboardOnFocus) window.dispatchEvent(new CustomEvent("keyboardWillShow", { detail: { keyboardHeight: 300 } }));
				}, resizeInput: () => {}, syncRootState: () => {}, syncComposerMode: () => {}, updateSendButtonState: () => {}, updateCancelEditButtonState: () => {}, onClosed: () => { win.closedCalls++; },
			}) as { prepare: () => void; open: () => void };
			controller.prepare(); win.composerController = controller;
		});
		// 记录完整入场，而非只检查首尾：位置动画不能逐帧触发布局或反向修正。
		const metricsSession = await page.context().newCDPSession(page);
		await metricsSession.send("Performance.enable");
		const layoutCount = async (): Promise<number> => {
			const result = await metricsSession.send("Performance.getMetrics");
			return result.metrics.find((metric: { name: string; value: number }) => metric.name === "LayoutCount")!.value;
		};
		const layoutsBefore = await layoutCount();
		const entering = await page.evaluate(async () => {
			const content = document.querySelector<HTMLElement>(".knomo-mobile-composer-content")!;
			const top = content.getBoundingClientRect().top;
			(window as unknown as { composerController: { open: () => void } }).composerController.open();
			await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
			const after = content.getBoundingClientRect().top;
			const samples: Array<{ top: number; toolbarInset: number; opacity: number }> = [];
			const toolbar = document.querySelector<HTMLElement>(".knomo-composer-bar")!;
			const started = performance.now();
			while (performance.now() - started < 360) {
				await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
				const rect = content.getBoundingClientRect();
				samples.push({ top: rect.top, toolbarInset: rect.bottom - toolbar.getBoundingClientRect().bottom, opacity: Number(getComputedStyle(content).opacity) });
			}
			return { before: top, after, samples };
		});
		const entryLayouts = await layoutCount() - layoutsBefore;
		t.diagnostic(`Composer entry layouts: ${entryLayouts}`);
		assert.ok(entryLayouts <= 6, `入场位置动画不应逐帧重排，本轮布局次数：${entryLayouts}`);
		assert.ok(entering.samples.length >= 6, "须覆盖多个入场帧");
		for (let index = 1; index < entering.samples.length; index++) {
			const previous = entering.samples[index - 1], current = entering.samples[index];
			assert.ok(current.top <= previous.top + 0.5, "打开期间不能反向下移");
			assert.ok(current.opacity >= previous.opacity, "打开期间不能再次变透明");
			assert.ok(Math.abs(current.toolbarInset - previous.toolbarInset) < 0.5, "工具栏须与面板同步移动");
		}
		assert.ok(entering.before - entering.after < 150, "首帧不能跳过大半键盘行程");
		const openedTop = await page.locator(".knomo-mobile-composer-content").evaluate((el: HTMLElement) => el.getBoundingClientRect().top);
		assert.ok(openedTop < entering.before - 200, "最终应贴近键盘上沿");
		await page.evaluate(() => (window as unknown as { composerController: { closeKeepingDraft: () => void } }).composerController.closeKeepingDraft());
		assert.equal(await page.locator(".knomo-mobile-composer-layer").getAttribute("data-close-stage"), "exit");
		assert.equal(await page.locator(".knomo-mobile-composer-content").evaluate((el: HTMLElement) => el.inert), true);
		await page.waitForTimeout(80);
		const exiting = await page.evaluate(() => {
			const content = document.querySelector<HTMLElement>(".knomo-mobile-composer-content")!;
			return { top: content.getBoundingClientRect().top, opacity: Number(getComputedStyle(document.querySelector(".knomo-mobile-composer-backdrop")!).opacity) };
		});
		assert.ok(exiting.top > openedTop + 10, "键盘未发出 didHide 时面板已开始退场");
		assert.ok(exiting.opacity < 0.95, "蒙版必须同时淡出");
		await page.evaluate(() => {
			window.dispatchEvent(new Event("keyboardWillHide"));
			const win = window as unknown as { viewportProbe: EventTarget & { height: number } };
			win.viewportProbe.height = 720; win.viewportProbe.dispatchEvent(new Event("resize"));
		});
		assert.equal(await page.locator(".knomo-mobile-composer-content").evaluate((el: HTMLElement) => getComputedStyle(el).transitionProperty), "transform, opacity");
		await page.waitForFunction(() => (window as unknown as { closedCalls: number }).closedCalls === 1);
		assert.equal(await page.locator(".knomo-mobile-composer-layer").evaluate((el: HTMLElement) => el.inert && !el.classList.contains("is-active")), true);
		await page.locator("#underlying").click();
		assert.equal(await page.evaluate(() => document.activeElement?.id), "underlying", "hidden layer cannot intercept a fresh click");
		// 完整关闭后交替使用原生键盘、实时视口；变化的工具栏间距须在首帧生效。
		for (let cycle = 0; cycle < 3; cycle += 1) {
			const early = await page.evaluate(async (native: boolean) => {
				const win = window as unknown as { composerController: { open: () => void }; keyboardOnFocus: boolean; viewportProbe: EventTarget & { height: number } };
				win.keyboardOnFocus = native;
				win.viewportProbe.height = native ? 720 : 420;
				const composer = document.querySelector<HTMLElement>(".knomo-composer")!;
				composer.style.paddingBottom = native ? "20px" : "12px";
				win.composerController.open();
				await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
				const layer = document.querySelector<HTMLElement>(".knomo-mobile-composer-layer")!;
				const content = document.querySelector<HTMLElement>(".knomo-mobile-composer-content")!;
				const buttons = Array.from(composer.querySelectorAll<HTMLElement>(".knomo-tool-button, .knomo-send-button, .knomo-cancel-edit-button"));
				const anchorBottom = Math.max(...buttons.map(button => button.getBoundingClientRect().bottom));
				const inset = content.getBoundingClientRect().bottom - anchorBottom;
				return { target: parseFloat(layer.style.getPropertyValue("--knomo-mobile-composer-bottom-offset")), expected: Math.round(300 + 4 - inset) };
			}, cycle % 2 === 0);
			assert.equal(early.target, early.expected, "首帧不能按零间距或上一模式定位");
			await page.waitForTimeout(320);
			assert.equal(await page.locator(".knomo-mobile-composer-layer").evaluate((el: HTMLElement) => parseFloat(el.style.getPropertyValue("--knomo-mobile-composer-bottom-offset"))), early.target, "键盘稳定后不应二次下移");
			const tracking = await page.evaluate(async () => {
				const win = window as unknown as { viewportProbe: EventTarget & { height: number } };
				win.viewportProbe.height = 420; win.viewportProbe.dispatchEvent(new Event("resize"));
				await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
				const layer = document.querySelector<HTMLElement>(".knomo-mobile-composer-layer")!;
				const content = document.querySelector<HTMLElement>(".knomo-mobile-composer-content")!;
				return { target: parseFloat(layer.style.getPropertyValue("--knomo-mobile-composer-bottom-offset")), actual: -new DOMMatrixReadOnly(getComputedStyle(content).transform).m42, bottom: parseFloat(getComputedStyle(content).bottom) };
			});
			assert.ok(Math.abs(tracking.target - tracking.actual) < 1, "实时视口逐帧跟随，不再额外缓动");
			assert.equal(tracking.bottom, 0, "布局锚点固定，键盘位移仅作用于变换");
			await page.evaluate(() => (window as unknown as { composerController: { closeKeepingDraft: () => void } }).composerController.closeKeepingDraft());
			await page.waitForTimeout(70);
			// 在退场中途重开：沿当前动画位置反向恢复，旧收尾不得隐藏新一轮。
			const reentry = await page.evaluate(() => {
				const content = document.querySelector<HTMLElement>(".knomo-mobile-composer-content")!;
				const before = content.getBoundingClientRect().top;
				(window as unknown as { composerController: { open: () => void } }).composerController.open();
				return { before, after: content.getBoundingClientRect().top };
			});
			assert.ok(Math.abs(reentry.after - reentry.before) < 2, "中途重开不得瞬移回动画起点");
			await page.waitForTimeout(380);
			assert.equal(await page.evaluate(() => (window as unknown as { closedCalls: number }).closedCalls), cycle + 1);
			assert.equal(await page.locator(".knomo-mobile-composer-layer").getAttribute("aria-hidden"), "false");
			if (cycle < 2) {
				await page.evaluate(() => (window as unknown as { composerController: { closeKeepingDraft: () => void } }).composerController.closeKeepingDraft());
				await page.waitForFunction((expected: number) => (window as unknown as { closedCalls: number }).closedCalls === expected, cycle + 2);
				await page.evaluate(() => {
					const win = window as unknown as { viewportProbe: EventTarget & { height: number } };
					win.viewportProbe.height = 720;
				});
			}
		}
		await page.emulateMedia({ reducedMotion: "reduce" });
		await page.evaluate(() => (window as unknown as { composerController: { closeKeepingDraft: () => void } }).composerController.closeKeepingDraft());
		assert.equal(await page.evaluate(() => (window as unknown as { closedCalls: number }).closedCalls), 4);
		assert.deepEqual(errors, []);
	} finally { await browser.close(); }
});


test("Desktop and mobile Scope current items share Sidebar accent, background and weight across themes without changing other host menus", { skip: !process.env.KNOMO_LAYOUT_PLAYWRIGHT }, async () => {
	const fixture = await createMobilePopupFixture();
	const currentScope = fixture.scopeMenu.querySelector<HTMLElement>('[data-title-mode="all"]')!;
	currentScope.classList.add("is-active");
	currentScope.setAttribute("aria-checked", "true");
	const scopeHtml = fixture.scopeMenu.outerHTML;
	fixture.close();
	const { chromium } = require(process.env.KNOMO_LAYOUT_PLAYWRIGHT!);
	const browser = await chromium.launch({ channel: process.env.KNOMO_LAYOUT_BROWSER || "msedge", headless: true });
	const css = readFileSync("styles.css", "utf8");
	const hostCss = process.env.KNOMO_HOST_CSS ? readFileSync(process.env.KNOMO_HOST_CSS, "utf8") : "";
	try {
		const page = await browser.newPage({ viewport: { width: 390, height: 700 } });
		for (const theme of ["theme-light", "theme-dark"]) for (const layout of ["mobile", "desktop-wide", "desktop-narrow"]) {
			const scope = layout === "desktop-wide" ? scopeHtml.replace("knomo-mobile-scope-popover", "knomo-desktop-scope-popover") : scopeHtml;
			await page.setContent(`<style>${hostCss}${css}
				body { display:block; margin:0; --text-accent:rgb(97, 71, 217); --text-normal:rgb(111, 112, 113); --background-modifier-hover:rgba(97, 71, 217, 0.15); --font-semibold:600; }
				#scope-root { display:block; position:relative; width:300px; height:360px; }
				.menu { position:static; }
			</style><body class="${layout === "mobile" ? "is-mobile" : ""} ${theme}">
				<div id="scope-root" class="knomo-plugin is-layout-${layout} is-scope-open"><button class="knomo-nav-button is-active">当前侧边栏项</button>${layout === "mobile" ? "" : scope}</div>
				<div class="menu knomo-mobile-menu knomo-mobile-menu-scope">
					<div id="current" class="menu-item mod-checked"><div class="menu-item-icon">图标</div><div class="menu-item-title"><span>全部笔记</span></div></div>
					<div id="other" class="menu-item"><div class="menu-item-title">其他范围</div></div>
				</div>
				<div class="menu"><div id="host-current" class="menu-item mod-checked">其他宿主菜单</div></div>
			</body>`);
			const colors = await page.evaluate(() => {
				const style = (selector: string) => {
					const css = getComputedStyle(document.querySelector(selector)!);
					return { color:css.color, background:css.backgroundColor, weight:css.fontWeight };
				};
				return { sidebar:style(".knomo-nav-button.is-active"), current:style("#current"), icon:style("#current .menu-item-icon"), other:style("#other"), host:style("#host-current") };
			});
			assert.deepEqual(colors.current, colors.sidebar, theme);
			assert.equal(colors.icon.color, colors.sidebar.color, theme);
			assert.notEqual(colors.other.color, colors.sidebar.color, theme);
			assert.notEqual(colors.host.color, colors.sidebar.color, theme);
			if (layout !== "mobile") {
				const current = page.locator('.knomo-scope-option[data-title-mode="all"]');
				for (const state of ["rest", "hover", "focus"]) {
					if (state === "hover") await current.hover();
					if (state === "focus") {
						await page.keyboard.press("Tab");
						await current.focus();
					}
					const desktop = await current.evaluate((element: HTMLElement) => {
						const style = getComputedStyle(element);
						return {
							color: style.color, background: style.backgroundColor, weight: style.fontWeight,
							icon: getComputedStyle(element.querySelector(".knomo-button-icon")!).color,
							label: getComputedStyle(element.querySelector(".knomo-button-label")!).color,
							focusVisible: element.matches(":focus-visible"),
						};
					});
					const context = `${theme}/${layout}/${state}`;
					assert.deepEqual({ color: desktop.color, background: desktop.background, weight: desktop.weight }, colors.current, context);
					assert.equal(desktop.icon, colors.current.color, context);
					assert.equal(desktop.label, colors.current.color, context);
					if (state === "focus") assert.equal(desktop.focusVisible, true, context);
				}
				assert.notEqual(await page.locator('.knomo-scope-option[data-title-mode="things"]').evaluate((element: HTMLElement) => getComputedStyle(element).color), colors.current.color, `${theme}/${layout}/other`);
			}
		}
	} finally { await browser.close(); }
});


test("trusted touchscreen taps activate once, preserve focus, and leave scrolling to the menu", { skip: !process.env.KNOMO_LAYOUT_PLAYWRIGHT }, async () => {
	const { chromium } = require(process.env.KNOMO_LAYOUT_PLAYWRIGHT!);
	const browser = await chromium.launch({ channel: process.env.KNOMO_LAYOUT_BROWSER || "msedge", headless: true });
	const bundle = await build({ stdin: { contents: 'export { registerMobileMenuTap } from "./src/ui/MobileMenuTap";', resolveDir: process.cwd(), loader: "ts" }, bundle: true, write: false, format: "iife", globalName: "MenuTouch" });
	try {
		const page = await browser.newPage({ viewport: { width: 390, height: 700 }, isMobile: true, hasTouch: true });
		const errors: string[] = [];
		page.on("pageerror", (error: Error) => errors.push(error.message));
		await page.setContent('<meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0} #under{position:fixed;inset:0} .menu{position:fixed;left:0;right:0;bottom:0;height:220px;overflow:auto;z-index:2;background:white;touch-action:pan-y} .suggestion-bg{position:fixed;inset:0;z-index:1;background:#0006} .menu-item{height:52px;display:flex;align-items:center} #editor{position:fixed;top:0;left:0}</style><button id="under">底层页面</button><input id="editor">');
		await page.addScriptTag({ content: bundle.outputFiles[0].text });
		await page.evaluate(() => {
			const state = { actions: 0, closes: 0, underlying: 0, trustedEnds: 0 };
			Object.assign(window, { touchState: state });
			document.querySelector("#under")!.addEventListener("click", () => state.underlying++);
			window.addEventListener("touchend", event => { if (event.isTrusted) state.trustedEnds++; });
			Object.assign(window, { openTouchMenu: () => {
				const menu = document.body.appendChild(document.createElement("div")); menu.className = "menu";
				const background = document.body.appendChild(document.createElement("div")); background.className = "suggestion-bg";
				const close = () => { release(); menu.remove(); background.remove(); state.closes++; };
				for (let i = 0; i < 12; i++) {
					const row = menu.appendChild(document.createElement("div")); row.className = "menu-item tappable";
					row.innerHTML = '<svg width="20" height="20"><path d="M2 2L18 18"/></svg><span>菜单项</span>';
					row.addEventListener("click", () => { state.actions++; close(); (document.querySelector("#editor") as HTMLInputElement).focus(); });
				}
				const release = (window as unknown as { MenuTouch: { registerMobileMenuTap: (menu: HTMLElement, backdrop: HTMLElement, close: () => void) => () => void } }).MenuTouch.registerMobileMenuTap(menu, background, close);
			} });
		});
		const snapshot = () => page.evaluate(() => (window as unknown as { touchState: { actions: number; closes: number; underlying: number; trustedEnds: number } }).touchState);
		const open = () => page.evaluate(() => (window as unknown as { openTouchMenu: () => void }).openTouchMenu());
		for (const [width, height] of [[390, 700], [740, 390]]) {
			await page.setViewportSize({ width, height });
			await open();
			const before = await snapshot();
			await page.touchscreen.tap(width / 2, 80);
			await page.waitForTimeout(400);
			assert.equal(await page.locator(".menu").count(), 0);
			assert.equal((await snapshot()).closes, before.closes + 1);
			assert.equal((await snapshot()).underlying, before.underlying, "关闭时不能有兼容点击穿透");
			for (const selector of [".menu-item svg", ".menu-item span", ".menu-item"]) {
				await open();
				const item = await page.locator(selector).first().boundingBox();
				const initial = await snapshot();
				await page.touchscreen.tap(item.x + item.width / 2, item.y + item.height / 2);
				await page.waitForTimeout(400);
				assert.equal((await snapshot()).actions, initial.actions + 1);
				assert.equal((await snapshot()).underlying, initial.underlying);
				assert.equal(await page.evaluate(() => document.activeElement?.id), "editor");
			}
		}
		await open();
		const beforeScroll = await snapshot();
		const rect = await page.locator(".menu").boundingBox();
		const cdp = await page.context().newCDPSession(page);
		await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 160, y: rect.y + 180 }] });
		for (const distance of [20, 50, 90, 130]) {
			await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 160, y: rect.y + 180 - distance }] });
		}
		await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
		await page.waitForTimeout(200);
		assert.ok(await page.locator(".menu").evaluate((menu: HTMLElement) => menu.scrollTop > 0));
		assert.equal((await snapshot()).actions, beforeScroll.actions, "滚动不执行菜单项");
		await page.touchscreen.tap(200, 80);
		const beforeOrdinary = await snapshot();
		await page.touchscreen.tap(200, 80);
		assert.equal((await snapshot()).underlying, beforeOrdinary.underlying + 1, "关闭后的首次普通点击不能被吞");
		assert.ok((await snapshot()).trustedEnds >= 10);
		assert.deepEqual(errors, []);
	} finally { await browser.close(); }
});

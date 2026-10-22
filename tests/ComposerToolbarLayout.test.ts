import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { ensureObsidianStub } from "./helpers/obsidianStub";
import type { ComposerEditor, ComposerInput } from "../src/ui/ComposerEditor";
import { normalizeComposerToolbar } from "../src/settings/composerToolbar";
import { registerComposerToolGesture } from "../src/ui/ComposerToolGesture";

// 使用真实 Composer 渲染器与项目样式；浏览器依赖与宿主样式快照均为可选输入。
async function composerHtml() {
	await ensureObsidianStub();
	const { renderKnomoComposer } = await import("../src/ui/KnomoComposer");
	const dom = new JSDOM("<div id='composer'></div>");
	Object.assign(dom.window.HTMLElement.prototype, {
		createEl(this: HTMLElement, tag: string, options: { cls?: string; text?: string; attr?: Record<string, string> } = {}) {
			const el = this.ownerDocument.createElement(tag);
			if (options.cls) el.className = options.cls;
			if (options.text) el.textContent = options.text;
			for (const [key, value] of Object.entries(options.attr ?? {})) el.setAttribute(key, value);
			return this.appendChild(el);
		},
		createDiv(this: HTMLElement, options?: { cls?: string; text?: string; attr?: Record<string, string> }) { return this.createEl("div", options); },
		createSpan(this: HTMLElement, options?: { cls?: string; text?: string; attr?: Record<string, string> }) { return this.createEl("span", options); },
		setAttrs(this: HTMLElement, options: Record<string, string>) { for (const [key, value] of Object.entries(options)) this.setAttribute(key, value); },
	});
	try {
		const root = dom.window.document.getElementById("composer")!;
		renderKnomoComposer(root, {
			dailyEnabled: true, timeBuoyEnabled: true, toolbar: normalizeComposerToolbar({ hidden: [] }), draftContent: "draft",
			createEditor: parent => parent.createDiv() as unknown as ComposerInput,
			createHiddenText: (parent, id, text) => { parent.createSpan({ cls: "knomo-visually-hidden", text, attr: { id } }); return id; },
			createIconButton: (parent, _icon, label, cls, action) => parent.createEl("button", { cls, attr: { "data-action": action, "aria-label": label, type: "button" } }),
		});
		return root.innerHTML;
	} finally { dom.window.close(); }
}

test("mobile Composer tool focus remains visible inside scrolling tools, including expanded and pressed states", { skip: !process.env.KNOMO_LAYOUT_PLAYWRIGHT }, async () => {
	const { chromium } = require(process.env.KNOMO_LAYOUT_PLAYWRIGHT!);
	const html = await composerHtml();
	const css = readFileSync(process.env.KNOMO_LAYOUT_CSS || "styles.css", "utf8");
	const host = process.env.KNOMO_LAYOUT_HOST_CSS ? readFileSync(process.env.KNOMO_LAYOUT_HOST_CSS, "utf8") : "";
	const browser = await chromium.launch({ channel: process.env.KNOMO_LAYOUT_BROWSER || "msedge", headless: true });
	try {
		const page = await browser.newPage();
		await page.emulateMedia({ reducedMotion: "reduce" });
		for (const theme of ["theme-light", "theme-dark"]) for (const mountedOnBody of [false, true]) for (const width of [320, 390]) {
			await page.setViewportSize({ width, height: 700 });
			// 页内原位与 body 浮层使用真实挂载类；显式展示原位 Composer 以验证迁移前后的同一组按钮。
			await page.setContent(`<style>${host}${css}
				body { display:block; margin:0; --size-2-1:2px; --background-primary:#fff; --background-secondary:#eee; --text-normal:#222; }
				body.theme-dark { --background-primary:#202020; --background-secondary:#303030; --text-normal:#eee; }
				.fixture-page { height:700px; }
				.fixture-page.knomo-plugin.is-layout-mobile > .knomo-composer { display:flex; }
			</style><body class="is-mobile is-phone ${theme}" style="--interactive-accent:#7755cc">${mountedOnBody
				? `<div class="knomo-plugin knomo-mobile-composer-layer is-layout-mobile is-active is-open"><div class="knomo-mobile-composer-stage"><div class="knomo-mobile-composer-content">${html}</div></div></div>`
				: `<div class="knomo-plugin is-layout-mobile fixture-page">${html}</div>`}</body>`);
			const context = `${theme}/${mountedOnBody ? "body" : "page"}/${width}`;
			const tools = page.locator(".knomo-tool-button:not([hidden])");
			await page.keyboard.press("Tab");
			for (let index = 0; index < await tools.count(); index++) {
				const tool = tools.nth(index);
				assert.equal(await tool.evaluate((el: HTMLElement) => el === document.activeElement && el.matches(":focus-visible")), true, context);
				assert.equal(await tool.evaluate((el: HTMLElement) => getComputedStyle(el).backgroundImage), "none", `${context}/${index}: default tool stays quiet`);
				// 将工具滚入可视区后验证焦点环没有向外越过裁切边界，不改变生产滚动逻辑。
				await tool.scrollIntoViewIfNeeded();
				const expandable = await tool.getAttribute("aria-expanded") !== null;
				if (expandable) await tool.evaluate((el: HTMLElement) => el.setAttribute("aria-expanded", "true"));
				for (const pressed of [false, true]) {
					if (pressed) await page.keyboard.down("Space");
					const focus = await tool.evaluate((el: HTMLElement) => {
						const style = getComputedStyle(el);
						const rect = el.getBoundingClientRect();
						const clip = el.closest(".knomo-tool-group")!.getBoundingClientRect();
						return {
							style: style.outlineStyle, width: style.outlineWidth, offset: style.outlineOffset,
							color: style.outlineColor,
							image: style.backgroundImage, shadow: style.boxShadow, background: style.backgroundColor,
							contained: rect.left >= clip.left - 1 && rect.right <= clip.right + 1 && rect.top >= clip.top - 1 && rect.bottom <= clip.bottom + 1,
							size: [rect.width, rect.height],
						};
					});
					assert.equal(focus.style, "solid", `${context}/${index}: expanded=${expandable}, pressed=${pressed}`);
					assert.equal(focus.width, "2px", context);
					assert.equal(focus.offset, "-2px", `${context}: focus stays inside the scroll clip`);
					assert.equal(focus.color, "rgb(119, 85, 204)", context);
					assert.equal(focus.contained, true, `${context}/${index}: visible tool contains its focus ring`);
					assert.deepEqual(focus.size, [44, 44], context);
					assert.equal(focus.image, "none", `${context}: tool state adds no glass shell`);
					assert.equal(focus.shadow, "none", context);
					if (expandable || pressed) assert.notEqual(focus.background, "rgba(0, 0, 0, 0)", `${context}/${index}: state fill stays visible`);
					if (pressed) await page.keyboard.up("Space");
				}
				if (expandable) {
					await tool.evaluate((el: HTMLButtonElement) => { el.disabled = true; });
					assert.equal(await tool.evaluate((el: HTMLElement) => getComputedStyle(el).backgroundImage), "none", `${context}: disabled tools do not retain an expanded surface`);
					assert.equal(await tool.evaluate((el: HTMLElement) => getComputedStyle(el).opacity), "1", `${context}: disabled tools use a state color without fading their foreground`);
					await tool.evaluate((el: HTMLButtonElement) => { el.disabled = false; el.setAttribute("aria-expanded", "false"); });
				}
				await page.keyboard.press("Tab");
			}
		}
	} finally { await browser.close(); }
});

test("mobile Glass sample shares accent across independent mounts, honors solid preferences and keeps controls reachable", { skip: !process.env.KNOMO_LAYOUT_PLAYWRIGHT }, async () => {
	const { chromium } = require(process.env.KNOMO_LAYOUT_PLAYWRIGHT!);
	const html = await composerHtml();
	const css = readFileSync(process.env.KNOMO_LAYOUT_CSS || "styles.css", "utf8");
	const host = process.env.KNOMO_LAYOUT_HOST_CSS ? readFileSync(process.env.KNOMO_LAYOUT_HOST_CSS, "utf8") : "";
	const browser = await chromium.launch({ channel: process.env.KNOMO_LAYOUT_BROWSER || "msedge", headless: true });
	try {
		const page = await browser.newPage({ viewport: { width: 390, height: 700 } });
		const cdp = await page.context().newCDPSession(page);
		for (const theme of ["theme-light", "theme-dark"]) for (const accent of ["#7852c9", "#ad591d"]) for (const manual of [false, true]) for (const system of ["no-preference", "reduce"]) {
			await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-transparency", value: system }] });
			const reduced = manual ? "knomo-reduce-glass" : "";
			await page.setContent(`<style>${host}${css}
				body { display:block; margin:0; --background-primary:#fff; --background-secondary:#eee; }
				.workspace-leaf-content { position:relative; height:700px; }
			</style><body class="is-mobile is-phone ${theme}" style="--interactive-accent:${accent};--text-on-accent:white">
				<div class="workspace-leaf-content ${reduced}" data-type="knomo-view"><div class="view-header"></div><div class="knomo-plugin is-layout-mobile ${reduced}"></div><button class="knomo-mobile-create-fab" type="button" aria-label="Create">+</button></div>
				<div class="knomo-plugin knomo-mobile-composer-layer is-layout-mobile is-active is-open ${reduced}" hidden><div class="knomo-mobile-composer-stage"><div class="knomo-mobile-composer-content">${html}</div></div></div>
			</body>`);
			const context = `${theme}/${accent}/manual=${manual}/system=${system}`;
			const fab = page.locator(".knomo-mobile-create-fab");
			const fabStyle = await fab.evaluate((el: HTMLElement) => {
				const style = getComputedStyle(el);
				return { size: [el.offsetWidth, el.offsetHeight], image: style.backgroundImage, filter: style.backdropFilter };
			});
			assert.deepEqual(fabStyle.size, [60, 60], context);
			assert.equal(fabStyle.image === "none", manual || system === "reduce", `${context}: solid preferences remove the optical sheen`);
			assert.equal(fabStyle.filter, "none", `${context}: sample adds no FAB blur`);
			await page.evaluate(() => {
				const button = document.querySelector<HTMLButtonElement>(".knomo-mobile-create-fab")!;
				button.addEventListener("click", () => button.dataset.calls = String(Number(button.dataset.calls ?? 0) + 1));
			});
			await fab.click();
			assert.equal(await fab.getAttribute("data-calls"), "1", context);
			await page.evaluate(() => {
				document.querySelector(".knomo-mobile-create-fab")!.classList.add("is-hidden");
				document.querySelector<HTMLElement>(".knomo-mobile-composer-layer")!.hidden = false;
			});
			const surface = await page.evaluate(() => {
				const fab = getComputedStyle(document.querySelector(".knomo-mobile-create-fab")!);
				const send = document.querySelector<HTMLButtonElement>(".knomo-send-button")!;
				const paint = getComputedStyle(send, "::before");
				const ctx = document.createElement("canvas").getContext("2d")!;
				const alpha = (color: string) => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1); return ctx.getImageData(0, 0, 1, 1).data[3]; };
				return { fabAlpha: alpha(fab.backgroundColor), sendAlpha: alpha(paint.backgroundColor), sendImage: paint.backgroundImage,
					headerFilter: getComputedStyle(document.querySelector(".view-header")!, "::before").backdropFilter,
					size: [send.offsetWidth, send.offsetHeight], pointer: paint.pointerEvents, hiddenFabPointer: fab.pointerEvents,
				};
			});
			const solid = manual || system === "reduce";
			assert.equal(surface.fabAlpha, solid ? 255 : 224, context);
			assert.equal(surface.sendAlpha, surface.fabAlpha, `${context}: body layer has the same material`);
			if (solid) assert.equal(surface.headerFilter, "none", context);
			else assert.match(surface.headerFilter, /blur\([\d.]+px\)/, `${context}: header uses its own soft backdrop while actions remain clear`);
			assert.equal(surface.sendImage === "none", solid, `${context}: detached send follows the same solid preference`);
			assert.deepEqual(surface.size, [58, 44], context);
			assert.equal(surface.pointer, "none", context);
			assert.equal(surface.hiddenFabPointer, "none", context);
			const send = page.locator(".knomo-send-button");
			await send.evaluate((el: HTMLButtonElement) => { el.disabled = true; });
			assert.equal(await send.evaluate((el: HTMLElement) => getComputedStyle(el, "::before").backgroundImage), "none", `${context}: disabled surface stays quiet`);
			await send.evaluate((el: HTMLElement) => el.classList.add("is-saving"));
			assert.equal(await send.evaluate((el: HTMLElement) => getComputedStyle(el, "::before").backgroundImage), "none", `${context}: saving retains the existing progress surface`);
		}
		await page.emulateMedia({ reducedMotion: "reduce" });
		assert.equal(await page.locator(".knomo-mobile-create-fab").evaluate((el: HTMLElement) => getComputedStyle(el).transitionDuration), "0s");
		await page.evaluate(() => {
			document.body.classList.remove("is-mobile", "is-phone");
			document.querySelector(".knomo-plugin.is-layout-mobile")!.classList.replace("is-layout-mobile", "is-layout-desktop-wide");
		});
		assert.equal(await page.locator(".knomo-mobile-create-fab").evaluate((el: HTMLElement) => getComputedStyle(el).backgroundImage), "none", "mobile material does not leak into desktop");
	} finally { await browser.close(); }
});

test("Composer keeps scrollable tools and send actions on one row across desktop and mobile widths", { skip: !process.env.KNOMO_LAYOUT_PLAYWRIGHT }, async () => {
	const { chromium } = require(process.env.KNOMO_LAYOUT_PLAYWRIGHT!);
	const browser = await chromium.launch({ channel: process.env.KNOMO_LAYOUT_BROWSER || "msedge", headless: true });
	const html = await composerHtml();
	const css = readFileSync(process.env.KNOMO_LAYOUT_CSS || "styles.css", "utf8");
	const host = process.env.KNOMO_LAYOUT_HOST_CSS ? readFileSync(process.env.KNOMO_LAYOUT_HOST_CSS, "utf8") : "";
	try {
		const page = await browser.newPage({ viewport: { width: 1000, height: 720 } });
		for (const mobile of [false, true]) for (const width of [240, 320, 480, 900]) for (const editing of [false, true]) {
			await page.setContent(`<style>${host}${css}
				body { display:block; margin:0; padding:0; font:16px Arial; }
				.probe { position:relative; display:block; height:auto; width:${width}px; }
			</style><body class='theme-light ${mobile ? "is-mobile is-phone" : ""}'><div class='probe knomo-plugin ${mobile ? "is-layout-mobile knomo-mobile-composer-layer" : width < 780 ? "is-layout-desktop-narrow" : "is-layout-desktop-wide"}'>${html}</div></body>`);
			const geometry = await page.evaluate((editing: boolean) => {
				document.querySelector<HTMLButtonElement>(".knomo-cancel-edit-button")!.hidden = !editing;
				const tools = document.querySelector<HTMLElement>(".knomo-tool-group")!;
				const actions = document.querySelector<HTMLElement>(".knomo-composer-actions")!;
				const bar = document.querySelector<HTMLElement>(".knomo-composer-bar")!;
				const buttons = [...tools.querySelectorAll<HTMLElement>("button")];
				tools.scrollLeft = 50;
				return {
					rows: new Set(buttons.map(button => Math.round(button.getBoundingClientRect().top))).size,
					actionsBelow: actions.getBoundingClientRect().top >= tools.getBoundingClientRect().bottom,
					toolsWidth: tools.clientWidth, overflow: tools.scrollWidth > tools.clientWidth, scrollLeft: tools.scrollLeft,
					barOverflow: bar.scrollWidth > bar.clientWidth + 1,
				};
			}, editing);
			assert.equal(geometry.rows, 1, JSON.stringify({ mobile, width, editing, geometry }));
			assert.equal(geometry.actionsBelow, false, JSON.stringify({ mobile, width, editing, geometry }));
			assert.ok(geometry.toolsWidth >= 22);
			assert.equal(geometry.barOverflow, false);
			if (width <= 320) { assert.equal(geometry.overflow, true); assert.ok(geometry.scrollLeft > 0); }
		}
		await page.setContent(`<style>${css}body{display:block}.probe{width:240px;display:block}</style><div class='probe knomo-plugin is-layout-desktop-narrow'>${html}</div>`);
		await page.addScriptTag({ content: `const registerGesture = ${registerComposerToolGesture.toString()}; window.toolCalls = 0; registerGesture(document.querySelector('.knomo-tool-group'), () => window.toolCalls++, undefined, true);` });
		const tool = page.locator('.knomo-tool-button').first();
		const box = await tool.boundingBox();
		assert.ok(box);
		await page.mouse.move(box.x + 14, box.y + 11); await page.mouse.down();
		await page.mouse.move(box.x - 70, box.y + 11, { steps: 10 }); await page.mouse.up();
		const dragged = await page.evaluate(() => ({ left: document.querySelector<HTMLElement>(".knomo-tool-group")!.scrollLeft, calls: (window as unknown as { toolCalls: number }).toolCalls }));
		assert.ok(dragged.left > 0);
		assert.equal(dragged.calls, 0);
		await page.locator('.knomo-tool-button[data-action="insert-highlight"]').click();
		assert.equal(await page.evaluate(() => (window as unknown as { toolCalls: number }).toolCalls), 1);
	} finally { await browser.close(); }
});

test("mobile Composer keeps send reachable when the keyboard reduces the input height below its default minimum", { skip: !process.env.KNOMO_LAYOUT_PLAYWRIGHT }, async () => {
	const { build } = await import("esbuild");
	// 在内存中打包真实编辑器、移动端层和高度计算；不依赖本地构建产物。
	const bundle = await build({
		stdin: { contents: `
			export { ComposerEditor } from "./src/ui/ComposerEditor";
			export { createMobileComposerLayer } from "./src/ui/MobileComposerLayer";
			export { calculateMobileComposerMeasurements, calculateMobileComposerDockOffset } from "./src/ui/mobileComposerMetrics";
		`, resolveDir: process.cwd(), loader: "ts" },
		bundle: true, write: false, format: "iife", globalName: "KnomoComposerLayoutFixture",
		plugins: [{ name: "host-api-fixture", setup(build) {
			build.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "fixture" }));
			build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: 'export const getLanguage = () => "en";', loader: "js" }));
		} }],
	});
	const { chromium } = require(process.env.KNOMO_LAYOUT_PLAYWRIGHT!);
	const browser = await chromium.launch({ channel: process.env.KNOMO_LAYOUT_BROWSER || "msedge", headless: true });
	try {
		const page = await browser.newPage();
		const errors: string[] = [];
		page.on("pageerror", (error: Error) => errors.push(error.message));
		const html = await composerHtml();
		const css = readFileSync(process.env.KNOMO_LAYOUT_CSS || "styles.css", "utf8");
		const host = process.env.KNOMO_LAYOUT_HOST_CSS ? readFileSync(process.env.KNOMO_LAYOUT_HOST_CSS, "utf8") : "";
		for (const [width, height] of [[390, 700], [700, 400]]) for (const dockTop of [248, 272, height]) for (const empty of [false, true]) {
			await page.setViewportSize({ width, height });
			await page.setContent(`<style>${host}${css}
				* { box-sizing:border-box; }
				body { display:block; margin:0; padding:0; font:16px Arial; --font-text:Arial; --font-preferred-size:16px; }
			</style><body class="theme-light is-mobile"><div class="knomo-plugin is-layout-mobile">${html}</div></body>`);
			await page.addScriptTag({ content: bundle.outputFiles[0].text });
			await page.evaluate(({ dockTop, empty }: { dockTop: number; empty: boolean }) => {
				const win = window as unknown as {
					KnomoComposerLayoutFixture: {
						ComposerEditor: typeof ComposerEditor;
						createMobileComposerLayer: typeof import("../src/ui/MobileComposerLayer").createMobileComposerLayer;
						calculateMobileComposerMeasurements: typeof import("../src/ui/mobileComposerMetrics").calculateMobileComposerMeasurements;
					};
					layoutEditor: ComposerEditor;
					sendCalls: number;
				};
				Object.assign(HTMLElement.prototype, {
					createDiv(this: HTMLElement, options: { cls?: string; attr?: Record<string, string> } = {}) {
						const el = document.createElement("div");
						el.className = options.cls ?? "";
						for (const [key, value] of Object.entries(options.attr ?? {})) el.setAttribute(key, value);
						return this.appendChild(el);
					},
					setAttr(this: HTMLElement, key: string, value: string) { this.setAttribute(key, value); },
				});
				const fixture = win.KnomoComposerLayoutFixture;
				const layer = fixture.createMobileComposerLayer(document);
				layer.layerEl.classList.add("is-active", "is-open");
				layer.contentEl.appendChild(document.querySelector(".knomo-composer")!);
				const area = layer.contentEl.querySelector<HTMLElement>(".knomo-composer-input-area")!;
				const placeholder = area.children[1];
				win.layoutEditor = new fixture.ComposerEditor(area, empty ? "" : Array.from({ length: 20 }, (_, i) => "row " + i).join("\n"), "composer-input-label", "Write here");
				placeholder.replaceWith(win.layoutEditor.view.dom);
				const sizes = fixture.calculateMobileComposerMeasurements({
					baselineHeight: innerHeight, windowHeight: innerHeight, viewportOffsetTop: 0, viewportHeight: dockTop,
					containerTop: 0, composerDockTop: dockTop,
					toolbarHeight: layer.contentEl.querySelector<HTMLElement>(".knomo-composer-bar")!.offsetHeight,
					referenceHeight: 0, topGuard: 52,
				});
				layer.layerEl.style.setProperty("--knomo-composer-content-max-height", sizes.contentMaxHeight + "px");
				layer.layerEl.style.setProperty("--knomo-composer-input-max-height", sizes.inputMaxHeight + "px");
				layer.layerEl.style.setProperty("--knomo-mobile-composer-bottom-offset", innerHeight - dockTop + "px");
				win.layoutEditor.view.scrollDOM.style.maxHeight = sizes.inputMaxHeight + "px";
				win.layoutEditor.view.requestMeasure();
				win.sendCalls = 0;
				layer.contentEl.querySelector(".knomo-send-button")!.addEventListener("click", () => win.sendCalls++);
			}, { dockTop, empty });
			// 等待真实编辑器测量后，沿用生产代码的工具栏锚定方式。
			await page.evaluate(async (dockTop: number) => {
				await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
				const win = window as unknown as { KnomoComposerLayoutFixture: { calculateMobileComposerDockOffset: typeof import("../src/ui/mobileComposerMetrics").calculateMobileComposerDockOffset } };
				const layer = document.querySelector<HTMLElement>(".knomo-mobile-composer-layer")!;
				const inset = layer.querySelector(".knomo-mobile-composer-content")!.getBoundingClientRect().bottom
					- layer.querySelector(".knomo-composer-bar")!.getBoundingClientRect().bottom;
				const offset = win.KnomoComposerLayoutFixture.calculateMobileComposerDockOffset({ layerBottom: innerHeight, composerDockTop: dockTop, toolbarAnchorInset: inset, targetGap: 4 });
				layer.style.setProperty("--knomo-mobile-composer-bottom-offset", offset + "px");
				layer.querySelector<HTMLElement>(".knomo-mobile-composer-content")!.style.transition = "none";
			}, dockTop);
			const send = await page.locator(".knomo-send-button").boundingBox();
			assert.ok(send);
			await page.mouse.click(send.x + send.width / 2, send.y + send.height / 2);
			const geometry = await page.evaluate(() => {
				const win = window as unknown as { layoutEditor: ComposerEditor; sendCalls: number };
				const area = document.querySelector(".knomo-composer-input-area")!.getBoundingClientRect();
				const bar = document.querySelector(".knomo-composer-bar")!.getBoundingClientRect();
				return {
					sendCalls: win.sendCalls, toolbarVisible: bar.top >= area.top && bar.bottom <= area.bottom,
					inputHeight: win.layoutEditor.view.scrollDOM.clientHeight,
					inputMaxHeight: parseFloat(win.layoutEditor.view.scrollDOM.style.maxHeight),
					source: win.layoutEditor.input.value,
				};
			});
			const context = JSON.stringify({ width, dockTop, empty, geometry });
			assert.equal(geometry.sendCalls, 1, context);
			assert.equal(geometry.toolbarVisible, true, context);
			assert.ok(geometry.inputHeight <= geometry.inputMaxHeight + 1, context);
			if (empty) {
				assert.equal(geometry.source, "");
				if (geometry.inputMaxHeight >= 150) assert.ok(geometry.inputHeight >= 150, context);
				const input = await page.locator(".cm-scroller").boundingBox();
				assert.ok(input);
				await page.mouse.click(input.x + 10, input.y + input.height - 8);
				await page.keyboard.type("typed");
				assert.equal(await page.evaluate(() => (window as unknown as { layoutEditor: ComposerEditor }).layoutEditor.input.value), "typed", context);
			} else assert.equal(geometry.source, Array.from({ length: 20 }, (_, i) => "row " + i).join("\n"));
			await page.evaluate(() => (window as unknown as { layoutEditor: ComposerEditor }).layoutEditor.destroy());
		}
		assert.deepEqual(errors, []);
	} finally { await browser.close(); }
});

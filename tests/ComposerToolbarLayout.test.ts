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

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { ensureObsidianStub } from "./helpers/obsidianStub";
import type { ComposerInput } from "../src/ui/ComposerEditor";
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
	const css = readFileSync("styles.css", "utf8");
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

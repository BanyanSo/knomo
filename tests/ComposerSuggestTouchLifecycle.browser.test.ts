import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { build } from "esbuild";

test("真实浏览器触摸选择保留光标和输入层，候选仍可原生滚动", { skip: !process.env.KNOMO_LAYOUT_PLAYWRIGHT }, async () => {
	const { chromium } = require(process.env.KNOMO_LAYOUT_PLAYWRIGHT!);
	const bundle = await build({
		stdin: { contents: 'export { renderKnomoComposer } from "./src/ui/KnomoComposer"; export { MobileComposerController } from "./src/ui/MobileComposerController"; export { KnomoTagSuggest } from "./src/ui/KnomoTagSuggest"; export { KnomoWikiLinkSuggest } from "./src/ui/KnomoWikiLinkSuggest";', resolveDir: process.cwd(), loader: "ts" },
		bundle: true, write: false, format: "iife", globalName: "SuggestTouch",
		plugins: [{ name: "obsidian-host", setup(builder) {
			builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "host" }));
			builder.onLoad({ filter: /.*/, namespace: "host" }, () => ({ contents: 'export const Platform={isMobile:true}; export const getLanguage=()=>"en"; export const requireApiVersion=()=>true; export const setIcon=()=>{}; export const addIcon=()=>{}; export const prepareFuzzySearch=q=>text=>text.toLowerCase().includes(q.toLowerCase())?{score:0,matches:[]}:null; export const renderResults=(el,text)=>{el.textContent=text;};' }));
		} }],
	});
	const browser = await chromium.launch({ channel: process.env.KNOMO_LAYOUT_BROWSER || "msedge", headless: true });
	try {
		const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
		const errors: string[] = [];
		page.on("pageerror", (error: Error) => errors.push(error.message));
		const css = readFileSync("styles.css", "utf8");
		for (const theme of ["theme-light", "theme-dark"]) {
			await page.setContent(`<meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}
				body{margin:0;font:16px Arial;--background-primary:#fff;--background-secondary:#eee;--text-normal:#222;--text-muted:#666;--background-modifier-border:#ccc;--interactive-accent:#6479e5;--input-height:32px;--font-ui-small:14px;--font-ui-medium:16px;--size-4-2:8px;--size-4-3:12px;--size-4-4:16px}
				body.theme-dark{--background-primary:#222;--background-secondary:#333;--text-normal:#eee;--text-muted:#bbb}
				#root{height:100vh}.suggestion-container{padding:4px;background:var(--background-primary);border-radius:8px}.suggestion{overflow-y:auto;max-height:inherit}.suggestion-item{padding:8px;line-height:20px}
			</style><body class="is-mobile ${theme}"><div id="root" class="knomo-plugin is-layout-mobile"></div></body>`);
			await page.addScriptTag({ content: bundle.outputFiles[0].text });
			await page.evaluate(() => {
				Object.assign(Node.prototype, { instanceOf(this: Node, constructor: typeof Node) { return this instanceof constructor; } });
				Object.assign(HTMLElement.prototype, {
					createEl(this: HTMLElement, tag: string, options: any = {}) {
						const element = document.createElement(tag); element.className = options.cls ?? "";
						if (options.text) element.textContent = options.text;
						for (const [key, value] of Object.entries(options.attr ?? {})) element.setAttribute(key, String(value));
						return this.appendChild(element);
					},
					createDiv(this: any, options: any) { return this.createEl("div", options); },
					createSpan(this: any, options: any) { return this.createEl("span", options); },
					setAttr(this: HTMLElement, key: string, value: string) { this.setAttribute(key, value); },
					setAttrs(this: HTMLElement, values: Record<string, string>) { for (const [key, value] of Object.entries(values)) this.setAttribute(key, value); },
					setCssProps(this: HTMLElement, values: Record<string, string>) { for (const [key, value] of Object.entries(values)) this.style.setProperty(key, value); },
					setText(this: HTMLElement, text: string) { this.textContent = text; }, empty(this: HTMLElement) { this.replaceChildren(); },
					addClass(this: HTMLElement, cls: string) { this.classList.add(cls); }, removeClass(this: HTMLElement, cls: string) { this.classList.remove(cls); },
					toggleClass(this: HTMLElement, cls: string, value: boolean) { this.classList.toggle(cls, value); },
					hasClass(this: HTMLElement, cls: string) { return this.classList.contains(cls); }, detach(this: HTMLElement) { this.remove(); },
				});
				const api = (window as any).SuggestTouch;
				const root = document.getElementById("root")!;
				const parts = api.renderKnomoComposer(root, { dailyEnabled: true, draftContent: "", createHiddenText: (parent: HTMLElement, name: string, text: string) => {
					const label = parent.appendChild(document.createElement("span")); label.id = name; label.textContent = text; return name;
				}, createIconButton: (parent: any, _icon: string, label: string, cls: string, action: string) => parent.createEl("button", { cls, attr: { "aria-label": label, "data-action": action } }) });
				const input = parts.inputEl;
				const state = { open: false, closes: 0, nativeEnds: 0, removedEarly: 0 };
				const events: unknown[] = [];
				for (const type of ["pointerdown", "touchstart", "pointerup", "touchend", "mousedown", "click", "blur"]) window.addEventListener(type, event => {
					const e = event as any;
					events.push({ type, target: e.target.className, prevented: e.defaultPrevented, cancelable: e.cancelable, focused: document.activeElement === input, x: e.clientX ?? e.changedTouches?.[0]?.clientX, y: e.clientY ?? e.changedTouches?.[0]?.clientY });
				}, true);
				let suggest: any;
				let releaseSuggest: (() => void) | undefined;
				const controller = new api.MobileComposerController({
					getWindow: () => window, getDocument: () => document, getContainerEl: () => root, getRootEl: () => root,
					getComposerEl: () => parts.composerEl, getInputEl: () => input, getComposerBarEl: () => parts.composerBarEl, getReferencePreviewEl: () => parts.referencePreviewEl,
					getLayout: () => "mobile", isComposerOpen: () => state.open, setComposerOpen: (open: boolean) => { state.open = open; }, getCardFlowScrollTop: () => 0,
					registerBackdropClick: (element: HTMLElement, handler: EventListener) => element.addEventListener("click", handler),
					closeComposerKeepingDraft: () => { state.closes++; suggest?.close(); controller.closeKeepingDraft(); },
					focusInputNow: () => input.composer.view.focus(), resizeInput: () => { input.composer.view.scrollDOM.style.maxHeight = controller.getMaxInputHeight() + "px"; },
					syncRootState() {}, syncComposerMode() {}, updateSendButtonState() {}, updateCancelEditButtonState() {},
				});
				controller.prepare(); controller.open();
				window.dispatchEvent(new CustomEvent("keyboardDidShow", { detail: { keyboardHeight: 300 } }));
				input.addEventListener("composer-change", () => { if (suggest?.refresh) suggest.refresh(); else suggest?.refreshForCursor(); });
				let activePopup: Element | null = null;
				window.addEventListener("touchend", event => { if (event.isTrusted) { state.nativeEnds++; if (activePopup && !activePopup.isConnected) state.removedEarly++; } }, true);
				const names = ["alpha", "beta", ...Array.from({ length: 24 }, (_, i) => `tag${i}`)];
				const files = names.map(basename => ({ basename, path: basename + ".md", extension: "md" }));
				const app = { vault: { on() {}, getMarkdownFiles: () => files }, metadataCache: { fileToLinktext: (file: any) => file.basename, getFirstLinkpathDest: (name: string) => files.find(file => file.basename === name) } };
				(window as any).suggestFixture = {
					open(kind: string) {
						releaseSuggest?.();
						suggest?.destroy?.(); suggest?.close();
						input.composer.reset(kind === "tag" ? "prefix # suffix" : "prefix [[]] suffix"); input.setSelectionRange(kind === "tag" ? 8 : 9, kind === "tag" ? 8 : 9); input.composer.view.focus();
						suggest = kind === "tag" ? new api.KnomoTagSuggest(app, input, () => {}, { watchSuggestions: () => () => {}, getSnapshot: () => ({ status: "ready", revision: 1, suggestions: names }) })
							: new api.KnomoWikiLinkSuggest(app, input, { listboxId: "browser-links", getSourcePath: () => "Daily/today.md", onInputChanged() {}, closeTagSuggest() {}, registerVaultEvent() {} });
						if (kind === "tag") { releaseSuggest = suggest.registerLifecycle(); suggest.open(); } else { releaseSuggest = undefined; suggest.openForCurrentRange(); }
						activePopup = document.querySelector(".knomo-native-suggest");
					},
					snapshot: () => ({ ...state, events, phase: controller.getPhase(), value: input.value, cursor: input.selectionStart, focused: document.activeElement === input }),
				};
			});
			await page.waitForTimeout(300);
			const open = async (kind: string) => { await page.evaluate((kind: string) => (window as any).suggestFixture.open(kind), kind); await page.waitForTimeout(100); };
			const snapshot = () => page.evaluate(() => (window as any).suggestFixture.snapshot());
			const cdp = await page.context().newCDPSession(page);
			for (const kind of ["tag", "link"]) {
				for (const hold of [0, 650]) {
					await open(kind);
					const rect = await page.locator(".knomo-native-suggest .suggestion-item").nth(1).boundingBox();
					assert.ok(rect);
					const point = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
					const geometry = await page.evaluate((point: { x: number; y: number }) => ({ hit: document.elementFromPoint(point.x, point.y)?.outerHTML.slice(0, 150), elements: [".cm-content", ".knomo-mobile-composer-layer", ".knomo-mobile-composer-content", ".knomo-native-suggest"].map(selector => { const element = document.querySelector<HTMLElement>(selector)!; return { selector, rect: element.getBoundingClientRect().toJSON(), style: element.getAttribute("style"), classes: element.className }; }) }), point);
					assert.equal(await page.evaluate((point: { x: number; y: number }) => document.elementFromPoint(point.x, point.y)?.closest(".suggestion-item")?.getAttribute("data-action"), point), "1", JSON.stringify({ rect, point, geometry }));
					await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
					if (hold) await page.waitForTimeout(hold);
					await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
					await page.waitForTimeout(150);
					const state = await snapshot();
					assert.equal(state.value, kind === "tag" ? "prefix #beta suffix" : "prefix [[beta]] suffix", JSON.stringify(state));
					assert.equal(state.cursor, kind === "tag" ? 13 : 15);
					assert.equal(state.focused, true); assert.equal(state.open, true); assert.equal(state.closes, 0); assert.equal(state.removedEarly, 0);
				}
				await open(kind);
				const list = page.locator(".knomo-suggest-list");
				const rect = await list.boundingBox(); assert.ok(rect);
				const point = { x: rect.x + rect.width / 2, y: rect.y + rect.height - 20 };
				await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
				for (let i = 1; i <= 6; i++) { await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: point.x, y: point.y - i * 14 }] }); await page.waitForTimeout(20); }
				await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
				assert.ok(await list.evaluate((element: HTMLElement) => element.scrollTop) > 0);
				assert.equal((await snapshot()).value, kind === "tag" ? "prefix # suffix" : "prefix [[]] suffix");
			}
			assert.ok((await snapshot()).nativeEnds > 0);
			await cdp.detach();
		}
		assert.deepEqual(errors, []);
	} finally { await browser.close(); }
});

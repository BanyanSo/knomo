import { controlWindowClock } from "./helpers/windowClock";
import test from "node:test";
import assert from "node:assert/strict";
import { undoDepth } from "@codemirror/commands";
import { MobileComposerController } from "../src/ui/MobileComposerController";
import { ComposerSaveShortcutController } from "../src/ui/ComposerSaveShortcutController";
import { formatTimeBuoyDate } from "../src/utils/timeBuoyDate";
import { createMobilePopupFixture } from "./helpers/mobilePopupFixture";
import { readFileSync } from "node:fs";
import { build } from "esbuild";

// 复用生产 Composer 接线，并接入真实浮层控制器、窗口焦点入口和首击恢复。
async function fixture(kind: "tag" | "link") {
	const f = await createMobilePopupFixture();
	const clock = controlWindowClock(f.win as unknown as Window);
	const { Platform } = await import("obsidian");
	const wasMobile = Platform.isMobile;
	Platform.isMobile = true;
	const view = f.view as any;
	const cleanups: Array<() => void> = [];
	Object.assign(f.win.HTMLElement.prototype, {
		hasClass(this: HTMLElement, cls: string) { return this.classList.contains(cls); },
		setCssProps(this: HTMLElement, props: Record<string, string>) { for (const [key, value] of Object.entries(props)) this.style.setProperty(key, value); },
		scrollIntoView() {},
	});
	view.rootEl = f.root;
	view.containerEl = Object.assign(f.root, { doc: f.win.document, win: f.win });
	view.trashViewClosed = false;
	view.mobileViewFocusRecovery = null;
	view.mobileSearchController = { isOpen: false };
	view.mobileHeaderTitleController = { getAnchor: () => null };
	view.composerSaveShortcutController = new ComposerSaveShortcutController();
	view.app.workspace = { getActiveViewOfType: () => view };
	view.register = (cleanup: () => void) => cleanups.push(cleanup);
	view.registerDomEvent = view.getRenderScope().registerDomEvent;
	view.lastKnownLocalDate = formatTimeBuoyDate(new Date());
	// 日期计时器和后台卡片绘制不参与候选触摸；焦点回调与恢复判断使用生产方法。
	view.stopDateChangeWatcher = view.startDateChangeWatcher = view.renderCardFlow = () => {};
	for (const name of ["focusComposerInputNow", "handleComposerInputFocus", "syncInputState"]) delete view[name];
	const input = view.inputEl;
	const controller = new MobileComposerController({
		getWindow: () => f.win as unknown as Window, getDocument: () => f.win.document,
		getContainerEl: () => f.root, getRootEl: () => f.root, getComposerEl: () => view.composerEl,
		getInputEl: () => input, getComposerBarEl: () => view.composerEl.querySelector(".knomo-composer-bar"),
		getReferencePreviewEl: () => view.referencePreviewEl, getLayout: () => "mobile",
		isComposerOpen: () => view.composerOpen, setComposerOpen: open => { view.composerOpen = open; },
		registerBackdropClick: (element, handler) => view.getRenderScope().registerDomEvent(element, "click", handler),
		closeComposerKeepingDraft: () => view.closeComposerKeepingDraft(),
		focusInputNow: (...args) => view.focusComposerInputNow(...args), resizeInput: () => view.resizeInput(),
		syncRootState: () => f.root.classList.toggle("is-composer-open", view.composerOpen),
		syncComposerMode: () => {}, updateSendButtonState: () => view.updateSendButtonState(), updateCancelEditButtonState: () => {},
		onClosing: () => input.dispatchEvent(new f.win.Event("composer-action-cancel", { bubbles: true })),
	});
	view.mobileComposerController = controller;
	f.root.appendChild(view.composerEl);
	f.layer.remove();
	view.composerOpen = false;
	view.recoverMobileViewFocus(() => true, true);
	view.registerWindowFocusEvent();
	view.registerMobileMenuTriggerEvents();
	controller.prepare();
	controller.open();
	const layer = controller.getLayerEl()!;
	const backdrop = layer.querySelector<HTMLElement>(".knomo-mobile-composer-backdrop")!;
	const names = ["Alpha", "Beta", "Gamma"];
	const files = names.map(basename => ({ basename, path: `Notes/${basename}.md`, extension: "md" }));
	view.tagSuggest.vaultTagIndex = { getSnapshot: () => ({ status: "ready", revision: 1, suggestions: names.map(name => name.toLowerCase()) }) };
	view.app.vault.getMarkdownFiles = () => files;
	view.app.metadataCache = { fileToLinktext: (file: { basename: string }) => file.basename,
		getFirstLinkpathDest: (text: string) => files.find(file => file.basename === text) ?? null };
	view.getWikiLinkSourcePath = () => "Daily/2026-10-24.md";
	const initial = kind === "tag" ? "prefix # suffix" : "prefix [[]] suffix";
	const cursor = kind === "tag" ? 8 : 9;
	input.composer.reset(initial);
	input.setSelectionRange(cursor, cursor);
	input.composer.view.focus();
	if (kind === "tag") view.tagSuggest.open(); else view.wikiLinkSuggest.openForCurrentRange();
	const popup = f.win.document.querySelector<HTMLElement>(".knomo-native-suggest")!;
	assert.ok(popup);
	const list = popup.querySelector<HTMLElement>(".knomo-suggest-list")!;
	const row = list.children[1] as HTMLElement;
	const target = row.firstElementChild ?? row;
	const touch = (type: "touchstart" | "touchend" | "touchcancel", element: Element = target,
		options: { cancelable?: boolean; multiple?: boolean; x?: number } = {}) => {
		const point = { identifier: 7, clientX: options.x ?? 20, clientY: 20, target };
		const event = new f.win.Event(type, { bubbles: true, cancelable: options.cancelable ?? true });
		Object.defineProperties(event, { touches: { value: options.multiple ? [point, { ...point, identifier: 8 }] : type === "touchstart" ? [point] : [] }, changedTouches: { value: [point] } });
		element.dispatchEvent(event);
		return event;
	};
	const tail = (type: string, element: Element) => {
		const event = new f.win.MouseEvent(type, { bubbles: true, cancelable: true, clientX: 20, clientY: 20, detail: 1 });
		element.dispatchEvent(event);
		return event;
	};
	return { ...f, clock, view, input, controller, layer, backdrop, popup, list, row, target, initial, cursor, touch, tail,
		close() {
			view.mobileViewFocusRecovery?.cancel(); controller.dispose();
			for (const cleanup of cleanups.reverse()) cleanup();
			clock.restore();
			Platform.isMobile = wasMobile;
			f.close();
		},
	};
}

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
						suggest = kind === "tag" ? new api.KnomoTagSuggest(app, input, () => {}, { getSnapshot: () => ({ status: "ready", revision: 1, suggestions: names }) })
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

for (const kind of ["tag", "link"] as const) {
	for (const invalid of ["swipe", "scroll", "outside", "multitouch", "pointercancel", "touchcancel", "selection", "composition", "readonly", "reset", "uncancelable"] as const) test(`${kind}: 原生触摸 ${invalid} 不补全且下一次独立点选可用`, async () => {
		const f = await fixture(kind);
		try {
			f.pointer(f.target, "pointerdown"); f.touch("touchstart");
			if (invalid === "swipe") f.pointer(f.target, "pointermove", { x: 50 });
			if (invalid === "scroll") { f.list.scrollTop = 24; f.list.dispatchEvent(new f.win.Event("scroll")); }
			if (invalid === "outside") f.win.document.elementFromPoint = () => f.backdrop;
			if (invalid === "multitouch") f.touch("touchstart", f.target, { multiple: true });
			if (invalid === "pointercancel") f.pointer(f.target, "pointercancel");
			if (invalid === "touchcancel") f.touch("touchcancel");
			if (invalid === "selection") f.input.setSelectionRange(0, 0);
			if (invalid === "composition") f.input.dispatchEvent(new f.win.CompositionEvent("compositionstart", { bubbles: true }));
			if (invalid === "readonly") f.input.composer.setSaving(true);
			if (invalid === "reset") f.input.composer.reset("new draft");
			f.pointer(f.target, "pointerup");
			f.touch("touchend", f.target, { cancelable: invalid !== "uncancelable" });
			f.tail("click", f.target);
			assert.equal(f.input.value, invalid === "reset" ? "new draft" : f.initial);
			assert.equal(undoDepth(f.input.composer.view.state), 0);
			assert.equal(f.view.composerOpen, true);
			if (["swipe", "scroll", "outside", "multitouch", "pointercancel", "touchcancel", "uncancelable"].includes(invalid)) {
				f.win.document.elementFromPoint = () => f.target;
				f.pointer(f.target, "pointerdown"); f.touch("touchstart");
				f.pointer(f.target, "pointerup"); f.touch("touchend");
				assert.equal(f.input.value, kind === "tag" ? "prefix #beta suffix" : "prefix [[Beta]] suffix");
			}
		} finally { f.close(); }
	});
	test(`${kind}: 稍长点按和 pointerup 后隐式释放捕获仍只选择一次`, async () => {
		const f = await fixture(kind);
		try {
			f.pointer(f.target, "pointerdown"); f.touch("touchstart");
			await f.clock.advance(650);
			f.pointer(f.target, "pointerup"); f.pointer(f.target, "lostpointercapture");
			f.touch("touchend"); f.tail("click", f.backdrop);
			assert.equal(f.input.value, kind === "tag" ? "prefix #beta suffix" : "prefix [[Beta]] suffix");
			assert.equal(f.input.selectionStart, kind === "tag" ? 13 : 15);
			assert.equal(undoDepth(f.input.composer.view.state), 1);
			assert.equal(f.controller.getPhase(), "open");
		} finally { f.close(); }
	});
	test(`${kind}: 宿主取消原生 touchend 后不能提前补全或移动光标`, async () => {
		const f = await fixture(kind);
		try {
			f.win.addEventListener("touchend", event => event.preventDefault(), { capture: true, once: true });
			f.pointer(f.target, "pointerdown"); f.touch("touchstart");
			f.pointer(f.target, "pointerup"); f.touch("touchend");
			assert.equal(f.input.value, f.initial);
			assert.equal(f.input.selectionStart, f.cursor);
			assert.equal(undoDepth(f.input.composer.view.state), 0);
			assert.equal(f.view.composerOpen, true);
		} finally { f.close(); }
	});
	for (const focusAt of ["pointerdown", "pointerup", "after-selection"] as const) test(`${kind}: 原生 touchend 前保留候选，${focusAt} 窗口焦点及尾随事件不移动光标或关闭输入层`, async () => {
		const f = await fixture(kind);
		try {
			const focus = () => f.win.dispatchEvent(new f.win.Event("focus"));
			f.pointer(f.target, "pointerdown"); f.touch("touchstart");
			if (focusAt === "pointerdown") focus();
			f.pointer(f.target, "pointerup");
			if (focusAt === "pointerup") focus();
			assert.equal(f.popup.isConnected, true, "原生触摸未结束时不能拆除候选并暴露下层");
			assert.equal(f.input.value, f.initial, "原生触摸在 touchend 中确认");
			assert.equal(f.touch("touchend").defaultPrevented, true);
			if (focusAt === "after-selection") focus();
			assert.equal(f.popup.isConnected, false);
			// 尾随事件分别到达脱离文档的候选、编辑器及真实蒙层。
			assert.equal(f.tail("mousedown", f.target).defaultPrevented, true);
			if (!f.tail("mousedown", f.input).defaultPrevented) f.input.setSelectionRange(0, 0);
			f.tail("mouseup", f.input); f.tail("click", f.backdrop);
			await f.clock.advance(130);
			assert.equal(f.input.value, kind === "tag" ? "prefix #beta suffix" : "prefix [[Beta]] suffix");
			assert.equal(f.input.selectionStart, kind === "tag" ? 13 : 15);
			assert.equal(f.win.document.activeElement, f.input);
			assert.equal(undoDepth(f.input.composer.view.state), 1);
			assert.equal(f.view.composerOpen, true);
			assert.equal(f.controller.getPhase(), "open");
			// 下一次主动触摸可以关闭真实输入层，不能被上一手势吞掉。
			f.pointer(f.backdrop, "pointerdown"); f.tail("click", f.backdrop);
			assert.ok(["closing", "closed"].includes(f.controller.getPhase()));
		} finally { f.close(); }
	});
}

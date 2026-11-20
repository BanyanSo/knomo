import { controlWindowClock } from "./helpers/windowClock";
import test from "node:test";
import assert from "node:assert/strict";
import { undoDepth } from "@codemirror/commands";
import { MobileComposerController } from "../src/ui/MobileComposerController";
import { ComposerSaveShortcutController } from "../src/ui/ComposerSaveShortcutController";
import { formatTimeBuoyDate } from "../src/utils/timeBuoyDate";
import { createMobilePopupFixture } from "./helpers/mobilePopupFixture";

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
	view.register(view.registerWindowFocusEvent());
	view.registerMobileMenuTriggerEvents();
	controller.prepare();
	controller.open();
	f.win.dispatchEvent(new f.win.CustomEvent("keyboardDidShow", { detail: { keyboardHeight: 300 } }));
	await clock.advance(16);
	const layer = controller.getLayerEl()!;
	const backdrop = layer.querySelector<HTMLElement>(".knomo-mobile-composer-backdrop")!;
	const names = ["Alpha", "Beta", "Gamma"];
	const files = names.map(basename => ({ basename, path: `Notes/${basename}.md`, extension: "md" }));
	view.tagSuggest.vaultTagIndex = { watchSuggestions: () => () => {}, getSnapshot: () => ({ status: "ready", revision: 1, suggestions: names.map(name => name.toLowerCase()) }) };
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

import test from "node:test";
import assert from "node:assert/strict";

import { MobileComposerController } from "../src/ui/MobileComposerController";
import { KnomoViewStateController } from "../src/ui/KnomoViewStateController";
import { ensureObsidianStub } from "./helpers/obsidianStub";

test("prepares a persistent mobile layer before opening", () => {
	const harness = createHarness();

	harness.controller.prepare();

	const layer = harness.getLayer();
	assert.equal(harness.controller.isLayered(), true);
	assert.equal(layer?.hasClass("is-active"), false);
	assert.equal(layer?.attrs.get("aria-hidden"), "true");
	assert.equal(harness.doc.body.children.length, 1);
});

test("body Composer inherits the current glass preference on first mount, reuse and reopening", () => {
	const harness = createHarness();
	harness.root.toggleClass("knomo-reduce-glass", true);
	harness.controller.prepare();
	const layer = harness.getLayer();
	assert.equal(layer?.hasClass("knomo-reduce-glass"), true);
	harness.root.toggleClass("knomo-reduce-glass", false);
	harness.controller.syncLayer();
	assert.equal(harness.getLayer(), layer);
	assert.equal(layer?.hasClass("knomo-reduce-glass"), false);
	harness.controller.open();
	harness.controller.closeKeepingDraft();
	harness.root.toggleClass("knomo-reduce-glass", true);
	harness.controller.open();
	assert.equal(harness.getLayer(), layer);
	assert.equal(layer?.hasClass("knomo-reduce-glass"), true);
	assert.equal(harness.composer.parentElement, harness.getContent());
});

test("does not prepare a composer layer for desktop layouts", () => {
	const harness = createHarness("desktop-wide");

	harness.controller.prepare();

	assert.equal(harness.controller.isLayered(), false);
	assert.equal(harness.getLayer(), null);
	assert.equal(harness.composer.parentElement, harness.home);
});

test("opens the prepared mobile composer and focuses synchronously", () => {
	const harness = createHarness();
	harness.controller.prepare();

	harness.controller.open();

	const layer = harness.getLayer();
	assert.equal(harness.getComposerOpen(), true);
	assert.equal(harness.controller.getPhase(), "focusing");
	assert.equal(harness.controller.isLayered(), true);
	assert.equal(layer?.hasClass("is-open"), true);
	assert.equal(layer?.hasClass("is-active"), true);
	assert.equal(layer?.hasClass("is-keyboard-tracking"), true);
	assert.equal(layer?.attrs.get("aria-hidden"), "false");
	assert.equal(harness.syncRootCalls, 0);
	assert.equal(harness.focusCalls, 1);
	assert.equal(harness.doc.body.children.length, 1);
	assert.equal(harness.win.visualViewport.listenerCount("resize"), 1);
	assert.equal(harness.win.visualViewport.listenerCount("scroll"), 1);

	harness.win.flushAnimationFrames();
	assert.equal(harness.controller.getPhase(), "open");
	assert.equal(harness.syncRootCalls, 0);
	assert.equal(layer?.hasClass("is-open"), true);
	assert.equal(layer?.style.values.get("--knomo-keyboard-height"), "0px");
	assert.equal(layer?.style.values.get("--knomo-mobile-composer-bottom-offset"), "0px");

	harness.win.flushAnimationFrames();
	assert.equal(harness.syncRootCalls, 1);
	assert.deepEqual(harness.syncRootLayerOpenStates, [true]);
});

test("requests the draft end only when expanding or reopening a closing mobile composer", () => {
	const focusIntents: Array<boolean | undefined> = [];
	const h = createHarness("mobile", { onFocusInput: moveToEnd => focusIntents.push(moveToEnd) });
	h.controller.prepare();
	h.controller.open();
	h.controller.open();
	h.controller.closeKeepingDraft();
	assert.equal(h.controller.getPhase(), "closing");
	assert.equal(h.getComposerOpen(), true, "退出过渡结束前，打开标记仍为 true");
	h.controller.open();
	h.controller.closeKeepingDraft();
	h.win.flushAllTimers();
	assert.equal(h.controller.getPhase(), "closed");
	h.controller.open();
	assert.deepEqual(focusIntents, [true, false, true, true]);
	h.controller.dispose();
});

test("positions the mobile composer from the toolbar anchor inset", () => {
	const harness = createHarness();
	prepareComposerGeometry(harness, 500, 480);
	harness.win.visualViewport.height = 500;

	harness.controller.open();
	harness.win.flushAnimationFrames();

	const layer = harness.getLayer();
	assert.equal(layer?.style.values.get("--knomo-mobile-composer-bottom-offset"), "284px");

	harness.win.flushAnimationFrames();

	assert.equal(layer?.style.values.get("--knomo-mobile-composer-bottom-offset"), "284px");
});

test("measures the current toolbar before an immediate keyboard signal on every open", () => {
	const h = createHarness("mobile", { onFocusInput: () => h.win.dispatchKeyboardEvent("keyboardWillShow", 300) });
	prepareComposerGeometry(h, 500, 480);
	for (let cycle = 0; cycle < 3; cycle += 1) {
		// 首次准备后工具栏可能因字号、编辑/引用模式变化；关闭也会清空锚点。
		h.composerBar.bottom = 475 - cycle * 5;
		const expectedOffset = `${300 + 4 - (500 - h.composerBar.bottom)}px`;
		h.controller.open();
		h.win.flushAnimationFrames();
		assert.equal(h.getLayer()?.style.values.get("--knomo-mobile-composer-bottom-offset"), expectedOffset, "首帧必须使用当前工具栏间距");
		h.win.flushAllTimers();
		assert.equal(h.getLayer()?.style.values.get("--knomo-mobile-composer-bottom-offset"), expectedOffset, "键盘稳定后不能再补算出另一位置");
		h.controller.closeKeepingDraft(); h.win.flushAllTimers();
		assert.equal(h.controller.getPhase(), "closed");
	}
});

test("positions the mobile composer from the toolbar button row visual bottom", () => {
	const harness = createHarness();
	const toolButton = harness.composerBar.createDiv({ cls: "knomo-tool-button" });
	const sendButton = harness.composerBar.createDiv({ cls: "knomo-send-button" });
	toolButton.bottom = 476;
	sendButton.bottom = 480;
	prepareComposerGeometry(harness, 500, 500);
	harness.win.visualViewport.height = 500;

	harness.controller.open();
	harness.win.flushAnimationFrames();

	const layer = harness.getLayer();
	assert.equal(layer?.style.values.get("--knomo-mobile-composer-bottom-offset"), "284px");
	assert.equal(layer?.style.values.get("--knomo-mobile-composer-toolbar-anchor-inset"), "20px");
	assert.equal(layer?.style.values.get("--knomo-mobile-composer-toolbar-anchor-bottom"), "480px");
	assert.equal(layer?.style.values.get("--knomo-mobile-composer-toolbar-wrapper-bottom"), "500px");
	assert.equal(layer?.attrs.get("data-knomo-composer-toolbar-anchor-source"), "button-row");
});

test("refreshes the toolbar anchor after the keyboard layout settles", () => {
	const harness = createHarness();
	const toolButton = harness.composerBar.createDiv({ cls: "knomo-tool-button" });
	const sendButton = harness.composerBar.createDiv({ cls: "knomo-send-button" });
	toolButton.bottom = 476;
	sendButton.bottom = 480;
	prepareComposerGeometry(harness, 500, 500);
	harness.win.visualViewport.height = 500;

	harness.controller.open();
	harness.win.flushAnimationFrames();
	harness.win.dispatchKeyboardEvent("keyboardWillShow", 300);
	harness.win.flushAnimationFrames();

	const content = harness.getContent();
	assert.notEqual(content, null);
	content!.bottom = 500;
	toolButton.bottom = 466;
	sendButton.bottom = 470;
	harness.win.flushNextTimer();

	const layer = harness.getLayer();
	assert.equal(layer?.style.values.get("--knomo-mobile-composer-toolbar-anchor-inset"), "30px");
	assert.equal(layer?.style.values.get("--knomo-mobile-composer-bottom-offset"), "274px");
});

test("derives a resized fixed layer bottom from the layout viewport without reading the layer", () => {
	const harness = createHarness();
	prepareComposerGeometry(harness, 500, 480);

	harness.controller.open();
	const layer = harness.getLayer();
	assert.notEqual(layer, null);
	harness.win.flushAnimationFrames();

	harness.win.innerHeight = 500;
	harness.win.visualViewport.height = 800;
	harness.win.dispatchEvent("resize");
	harness.win.flushAnimationFrames();

	assert.equal(layer?.style.values.get("--knomo-mobile-composer-bottom-offset"), "-16px");
	assert.equal(layer?.attrs.get("data-knomo-composer-dock-source"), "layout-viewport");
});

test("tracks the composer dock top while the visual viewport is animating", () => {
	const harness = createHarness();
	prepareComposerGeometry(harness, 500, 480);
	harness.win.visualViewport.height = 650;

	harness.controller.open();
	harness.win.flushAnimationFrames();

	const layer = harness.getLayer();
	assert.equal(layer?.hasClass("is-keyboard-tracking"), true);
	assert.equal(layer?.style.values.get("--knomo-mobile-composer-bottom-offset"), "134px");

	harness.win.visualViewport.height = 500;
	harness.win.visualViewport.dispatchEvent("resize");
	harness.win.flushAnimationFrames();

	assert.equal(layer?.style.values.get("--knomo-mobile-composer-bottom-offset"), "284px");
});

test("samples delayed first-open viewport geometry without waiting for a resize event", () => {
	const harness = createHarness();
	prepareComposerGeometry(harness, 500, 480);

	harness.controller.open();
	harness.win.flushAnimationFrames();

	harness.win.visualViewport.height = 500;
	harness.win.flushNextTimer();
	harness.win.flushAnimationFrames();

	const layer = harness.getLayer();
	assert.equal(layer?.style.values.get("--knomo-keyboard-height"), "300px");
	assert.equal(layer?.style.values.get("--knomo-mobile-composer-bottom-offset"), "284px");
	assert.equal(layer?.attrs.get("data-knomo-composer-dock-source"), "visual-viewport");

	harness.win.flushNextTimer();
	assert.equal(layer?.hasClass("is-keyboard-tracking"), false);
	assert.equal(harness.controller.getPhase(), "open");
});

test("keeps the opening baseline when the keyboard triggers a window resize", () => {
	const harness = createHarness();
	prepareComposerGeometry(harness, 500, 480);

	harness.controller.open();
	harness.win.flushAnimationFrames();

	harness.win.innerHeight = 500;
	harness.win.visualViewport.height = 500;
	harness.win.dispatchEvent("resize");
	harness.win.flushAnimationFrames();

	const layer = harness.getLayer();
	assert.equal(layer?.style.values.get("--knomo-mobile-composer-bottom-offset"), "284px");
});

test("uses the layout viewport when the visual viewport stays stale during keyboard resize", () => {
	const harness = createHarness();
	prepareComposerGeometry(harness, 500, 480);

	harness.controller.open();
	harness.win.flushAnimationFrames();

	harness.win.innerHeight = 500;
	harness.win.visualViewport.height = 800;
	harness.win.dispatchEvent("resize");
	harness.win.flushAnimationFrames();

	const layer = harness.getLayer();
	assert.equal(layer?.style.values.get("--knomo-keyboard-height"), "300px");
	assert.equal(layer?.style.values.get("--knomo-mobile-composer-bottom-offset"), "-16px");
	assert.equal(layer?.attrs.get("data-knomo-composer-dock-source"), "layout-viewport");
});

test("uses the virtual keyboard rect as the composer dock source", () => {
	const harness = createHarness();
	prepareComposerGeometry(harness, 500, 480);
	harness.win.virtualKeyboard.boundingRect = { y: 520, height: 280 };

	harness.controller.open();
	harness.win.flushAnimationFrames();

	const layer = harness.getLayer();
	assert.equal(layer?.style.values.get("--knomo-keyboard-height"), "280px");
	assert.equal(layer?.style.values.get("--knomo-mobile-composer-bottom-offset"), "264px");
});

test("uses Capacitor keyboard events as the first composer dock source", () => {
	const harness = createHarness();
	prepareComposerGeometry(harness, 500, 480);
	harness.win.visualViewport.height = 500;
	harness.win.virtualKeyboard.boundingRect = { y: 520, height: 280 };

	harness.controller.open();
	harness.win.flushAnimationFrames();
	harness.win.dispatchKeyboardEvent("keyboardWillShow", 260);
	harness.win.flushAnimationFrames();

	const layer = harness.getLayer();
	assert.equal(layer?.style.values.get("--knomo-keyboard-height"), "260px");
	assert.equal(layer?.style.values.get("--knomo-mobile-composer-bottom-offset"), "244px");
	assert.equal(layer?.attrs.get("data-knomo-composer-dock-source"), "capacitor-keyboard");
});

test("clears the Capacitor keyboard dock source when the keyboard hides", () => {
	const harness = createHarness();
	prepareComposerGeometry(harness, 800, 780);
	harness.win.visualViewport.height = 500;

	harness.controller.open();
	harness.win.flushAnimationFrames();
	harness.win.dispatchKeyboardEvent("keyboardWillShow", 260);
	harness.win.flushAnimationFrames();
	harness.win.dispatchEvent("keyboardWillHide");
	harness.win.flushAnimationFrames();

	const layer = harness.getLayer();
	assert.equal(layer?.style.values.get("--knomo-keyboard-height"), "0px");
	assert.equal(layer?.style.values.get("--knomo-mobile-composer-bottom-offset"), "0px");
	assert.equal(layer?.attrs.get("data-knomo-composer-dock-source"), "fallback");
});

test("waits for keyboardDidHide before completing a Capacitor keyboard dismissal", () => {
	const harness = createHarness();
	prepareComposerGeometry(harness, 800, 780);
	harness.win.visualViewport.height = 500;
	harness.controller.open();
	harness.win.flushAnimationFrames();
	harness.win.dispatchKeyboardEvent("keyboardWillShow", 260);
	harness.win.flushAnimationFrames();
	let settledCalls = 0;
	harness.controller.waitForKeyboardDismissal(() => {
		settledCalls += 1;
	});

	harness.win.dispatchEvent("keyboardWillHide");
	harness.win.flushAnimationFrameCycles(4);
	assert.equal(settledCalls, 0);

	harness.win.dispatchEvent("keyboardDidHide");
	harness.win.flushAnimationFrameCycles(4);
	assert.equal(settledCalls, 1);
});

test("completes a visual viewport keyboard dismissal after stable frames", () => {
	const harness = createHarness();
	prepareComposerGeometry(harness, 800, 780);
	harness.win.visualViewport.height = 500;
	harness.controller.open();
	harness.win.flushAnimationFrames();
	let settledCalls = 0;
	const cancel = harness.controller.waitForKeyboardDismissal(() => {
		settledCalls += 1;
	});

	harness.win.visualViewport.height = 800;
	harness.win.visualViewport.dispatchEvent("resize");
	harness.win.flushAnimationFrameCycles(4);
	assert.equal(settledCalls, 1);

	cancel();
	assert.equal(settledCalls, 1);
});

test("cancels a pending keyboard dismissal callback", () => {
	const harness = createHarness();
	prepareComposerGeometry(harness, 800, 780);
	harness.win.visualViewport.height = 500;
	harness.controller.open();
	harness.win.flushAnimationFrames();
	let settledCalls = 0;
	const cancel = harness.controller.waitForKeyboardDismissal(() => {
		settledCalls += 1;
	});

	cancel();
	harness.win.visualViewport.height = 800;
	harness.win.visualViewport.dispatchEvent("resize");
	harness.win.flushAnimationFrameCycles(4);
	harness.win.flushAllTimers();
	assert.equal(settledCalls, 0);
});

test("keeps the composer docked when a focused input receives no keyboard signal", () => {
	const harness = createHarness();
	prepareComposerGeometry(harness, 800, 780);

	harness.controller.open();
	harness.win.flushAnimationFrames();
	harness.win.flushNextTimer();
	harness.win.flushAnimationFrames();

	const layer = harness.getLayer();
	assert.equal(layer?.hasClass("is-open"), true);
	assert.equal(layer?.style.values.get("--knomo-keyboard-height"), "0px");
	assert.equal(layer?.style.values.get("--knomo-mobile-composer-bottom-offset"), "0px");
	assert.equal(layer?.attrs.get("data-knomo-composer-dock-source"), "fallback");

	harness.win.flushNextTimer();
	assert.equal(layer?.hasClass("is-keyboard-tracking"), false);
	assert.equal(harness.controller.getPhase(), "open");
});

test("delegates backdrop clicks back to the view close-draft path", () => {
	const harness = createHarness();
	harness.controller.open();
	const handler = harness.backdropHandlers[0];
	assert.notEqual(handler, undefined);

	handler.handler({ target: handler.element } as unknown as MouseEvent);

	assert.equal(harness.closeDraftCalls, 1);
	assert.equal(harness.controller.getPhase(), "focusing");
});

test("closes the mobile composer while keeping the prepared layer mounted", () => {
	const harness = createHarness();
	prepareComposerGeometry(harness, 500, 480);
	harness.win.visualViewport.height = 500;
	harness.controller.open();
	harness.win.flushAnimationFrames();
	harness.win.flushAnimationFrames();

	harness.controller.closeKeepingDraft();

	const layer = harness.getLayer();
	assert.equal(harness.controller.getPhase(), "closing");
	assert.equal(layer?.hasClass("is-open"), false);
	assert.equal(layer?.hasClass("is-closing"), true);
	assert.equal(layer?.hasClass("is-keyboard-tracking"), false);
	assert.equal(harness.input.blurCount, 1);

	harness.win.visualViewport.height = 800;
	harness.win.visualViewport.dispatchEvent("resize");
	harness.win.flushAnimationFrameCycles(5);

	assert.equal(layer?.hasClass("is-open"), false);

	harness.win.flushNextTimer();

	assert.equal(harness.getComposerOpen(), false);
	assert.equal(harness.controller.getPhase(), "closed");
	assert.equal(harness.controller.isLayered(), true);
	assert.equal(harness.composer.parentElement, harness.getContent());
	assert.equal(layer?.detached, false);
	assert.equal(layer?.hasClass("is-active"), false);
	assert.equal(layer?.attrs.get("aria-hidden"), "true");
	assert.equal(harness.syncRootCalls, 2);
	assert.equal(harness.syncComposerModeCalls, 1);
	assert.equal(harness.updateSendButtonCalls, 1);
	assert.equal(harness.updateCancelEditButtonCalls, 1);
	assert.equal(harness.closedCalls, 1);
});

test("repeated close does not blur twice or restart the closing sequence", () => {
	const h = createHarness(); h.controller.open(); h.win.flushAnimationFrames();
	h.controller.closeKeepingDraft(); h.controller.closeKeepingDraft();
	assert.equal(h.input.blurCount, 1);
	h.win.flushAllTimers(); assert.equal(h.closedCalls, 1);
});

test("closing starts visual exit immediately while the keyboard is still visible", () => {
	const h = createHarness(); prepareComposerGeometry(h, 500, 480);
	h.win.visualViewport.height = 500; h.controller.open(); h.win.flushAnimationFrameCycles(2);
	h.win.dispatchKeyboardEvent("keyboardWillShow", 300); h.win.flushAnimationFrames();
	const offset = h.getLayer()?.style.values.get("--knomo-mobile-composer-bottom-offset");
	h.controller.closeKeepingDraft();
	assert.equal(h.getLayer()?.hasClass("is-open"), false, "退场不能等待 keyboardDidHide 或兜底计时器");
	assert.equal(h.controller.getPhase(), "closing");
	assert.equal(h.closedCalls, 0);
	h.win.dispatchEvent("keyboardWillHide");
	h.win.visualViewport.height = 800; h.win.visualViewport.dispatchEvent("resize");
	h.win.flushAnimationFrameCycles(4);
	assert.equal(h.getLayer()?.style.values.get("--knomo-mobile-composer-bottom-offset"), offset, "退场期间键盘回调不能重新定位面板");
	h.win.flushAllTimers(); assert.equal(h.closedCalls, 1);
});

test("exit waits for both own properties and ignores child or previous-round events", () => {
	const h = createHarness(); h.controller.prepare(); h.controller.open(); h.win.flushAnimationFrameCycles(3);
	h.controller.closeKeepingDraft();
	const content = h.getContent()!, backdrop = h.getBackdrop()!;
	backdrop.transition("opacity", "transitioncancel");
	assert.equal(h.closedCalls, 0, "旧过渡取消不是本轮收尾条件");
	content.transition("transform", "transitionrun"); content.transition("opacity", "transitionrun"); backdrop.transition("opacity", "transitionrun");
	content.transition("transform", "transitionend", h.input);
	assert.equal(h.closedCalls, 0);
	content.transition("transform"); assert.equal(h.closedCalls, 0);
	content.transition("opacity"); assert.equal(h.closedCalls, 0, "面板结束仍需等待蒙版");
	backdrop.transition("opacity"); assert.equal(h.closedCalls, 1);
	h.win.flushAllTimers(); assert.equal(h.closedCalls, 1);
	assert.equal(h.getLayer()?.inert, true);
});

test("zero transitions and reduced motion close immediately; each new visual stage rereads preference", () => {
	for (const reduced of [false, true]) {
		const h = createHarness(); h.win.reducedMotion = reduced;
		if (!reduced) h.win.transitionDuration = "0s";
		h.controller.open(); h.win.flushAnimationFrameCycles(3); h.controller.closeKeepingDraft();
		assert.equal(h.closedCalls, 1); assert.equal(h.controller.getPhase(), "closed");
		h.win.reducedMotion = false; h.win.transitionDuration = "240ms, 220ms";
		h.controller.open(); h.win.flushAnimationFrameCycles(3); h.controller.closeKeepingDraft();
		assert.equal(h.closedCalls, 1, "新的退出仍须等实际过渡");
		h.win.flushAllTimers(); assert.equal(h.closedCalls, 2);
	}
});

test("reopening invalidates old exit callbacks without resetting dock geometry or editor", () => {
	const h = createHarness(); prepareComposerGeometry(h, 500, 480);
	h.win.visualViewport.height = 500; h.controller.open(); h.win.flushAnimationFrameCycles(3);
	const offset = h.getLayer()?.style.values.get("--knomo-mobile-composer-bottom-offset");
	h.controller.closeKeepingDraft(); h.controller.open();
	assert.equal(h.getLayer()?.style.values.get("--knomo-mobile-composer-bottom-offset"), offset);
	assert.equal(h.getContent()?.inert, false);
	h.win.flushAllTimers(); h.win.flushAnimationFrameCycles(3);
	assert.equal(h.getComposerOpen(), true); assert.equal(h.closedCalls, 0);
	h.win.visualViewport.height = 800; h.win.visualViewport.dispatchEvent("resize"); h.win.flushAnimationFrameCycles(3);
	h.controller.closeKeepingDraft(); h.getContent()!.transition("transform", "transitionrun");
	h.controller.open(); h.getContent()!.transition("transform"); h.getBackdrop()!.transition("opacity");
	h.win.flushAllTimers(); assert.equal(h.closedCalls, 0); assert.equal(h.getComposerOpen(), true);
	h.controller.closeKeepingDraft(); h.controller.dispose(); h.win.flushAllTimers();
	assert.equal(h.closedCalls, 0, "销毁不补发关闭通知");
});

test("visual exit freezes measurements even if a host resize requests another layout", () => {
	const h = createHarness(); h.controller.prepare(); h.controller.open(); h.win.flushAnimationFrameCycles(3);
	h.controller.closeKeepingDraft();
	const before = new Map(h.getLayer()!.style.values);
	h.win.visualViewport.height = 300;
	h.controller.scheduleResize(); h.win.flushAnimationFrameCycles(3);
	assert.deepEqual(h.getLayer()!.style.values, before, "exit 不再受键盘/宿主布局调整驱动");
	h.win.flushAllTimers(); assert.equal(h.closedCalls, 1);
});

function prepareComposerGeometry(
	harness: ReturnType<typeof createHarness>,
	contentBottom: number,
	toolbarBottom: number,
): void {
	harness.controller.prepare();
	const content = harness.getContent();
	assert.notEqual(content, null);
	content!.bottom = contentBottom;
	harness.composerBar.bottom = toolbarBottom;
	harness.controller.scheduleResize();
	harness.win.flushAnimationFrames();
	harness.win.flushAnimationFrames();
}

test("keyboard tracking pauses background work before focus and resumes only after settling or disposal", () => {
	const changes: boolean[] = [];
	const harness = createHarness("mobile", { onKeyboardTrackingChange: busy => changes.push(busy) });
	harness.controller.open();
	assert.deepEqual(changes, [true]);
	harness.win.flushAnimationFrames();
	assert.equal(harness.controller.getPhase(), "open");
	assert.deepEqual(changes, [true], "open 阶段不等于键盘已经稳定");
	harness.win.visualViewport.dispatchEvent("resize");
	harness.win.flushAllTimers();
	assert.deepEqual(changes, [true, false]);
	harness.win.visualViewport.dispatchEvent("resize");
	assert.deepEqual(changes, [true, false, true]);
	harness.controller.dispose();
	assert.deepEqual(changes, [true, false, true, false]);
});

test("parallel exit keeps background work paused until completion or disposal", () => {
	for (const dispose of [false, true]) {
		const changes: boolean[] = [];
		const h = createHarness("mobile", { onKeyboardTrackingChange: busy => changes.push(busy) });
		h.controller.prepare(); h.controller.open(); h.win.flushAnimationFrameCycles(3); h.win.flushAllTimers();
		changes.length = 0;
		h.controller.closeKeepingDraft();
		assert.deepEqual(changes, [true], "停止键盘定位不能提前恢复后台索引");
		if (dispose) h.controller.dispose();
		h.win.flushAllTimers();
		assert.deepEqual(changes, [true, false]);
		assert.equal(h.closedCalls, dispose ? 0 : 1);
	}
});

test("稳定关闭的 Composer 连续十次真实 View root 同步不测量或重写图层指标", async context => {
	const h = createHarness();
	const view = await createRootView(h);
	try {
		h.controller.prepare();
		view.syncRootState();
		let measurements = 0, reads = 0, writes = 0;
		const measure = h.controller.updateMeasurements.bind(h.controller);
		h.controller.updateMeasurements = () => { measurements++; return measure(); };
		const rect = h.container.getBoundingClientRect.bind(h.container);
		h.container.getBoundingClientRect = () => { reads++; return rect(); };
		const layer = h.getLayer()!;
		const setCss = layer.setCssProps.bind(layer);
		layer.setCssProps = props => { writes++; setCss(props); };
		for (let index = 0; index < 10; index++) view.syncRootState();
		assert.equal(measurements, 0);
		assert.equal(reads, 0);
		assert.equal(writes, 0);
		context.diagnostic(`10 closed root syncs: ${measurements} measurements, ${reads} container reads, ${writes} layer metric writes`);
		assert.ok(h.controller.getMaxInputHeight() > 0);
		assert.equal(measurements, 0);
	} finally { h.controller.dispose(); }
});

test("关闭后实际布局、引用和工具栏变化通过既有 View 入口更新，桌面切换后仍可重开", async () => {
	const h = createHarness();
	const view = await createRootView(h);
	try {
		h.controller.prepare();
		view.syncRootState();
		const initial = h.controller.getMaxInputHeight();
		h.win.innerHeight = h.win.visualViewport.height = 480;
		view.syncLayoutMeasurements();
		const rotated = h.controller.getMaxInputHeight();
		assert.ok(rotated < initial);
		h.composerBar.offsetHeight += 36;
		view.syncComposerMode();
		assert.equal(h.controller.getMaxInputHeight(), rotated - 36);
		h.referencePreview.toggleClass("is-visible", true);
		h.referencePreview.offsetHeight = 40;
		view.syncComposerMode();
		assert.equal(h.controller.getMaxInputHeight(), rotated - 76);
		h.setLayout("desktop-wide"); view.currentLayout = "desktop-wide";
		view.syncRootState();
		assert.equal(h.composer.parentElement, h.home);
		h.setLayout("mobile"); view.currentLayout = "mobile";
		view.syncLayoutMeasurements();
		assert.equal(h.controller.isLayered(), true);
		h.controller.open();
		h.win.flushAnimationFrameCycles(3);
		assert.equal(h.controller.getPhase(), "open");
		assert.equal(h.win.visualViewport.listenerCount("resize"), 1);
	} finally { h.controller.dispose(); }
});

test("实际关闭会清除键盘指标并保留一次归一化更新，此后停止跟踪不再测量", () => {
	const h = createHarness();
	try {
		h.controller.prepare(); h.controller.open(); h.win.flushAnimationFrameCycles(3);
		h.win.visualViewport.height = 480;
		h.win.visualViewport.dispatchEvent("resize"); h.win.flushAnimationFrameCycles(3);
		assert.equal(h.controller.isKeyboardOpen(), true);
		h.controller.closeKeepingDraft();
		h.win.flushAllTimers();
		assert.equal(h.controller.getPhase(), "closed");
		assert.equal(h.controller.isKeyboardOpen(), false);
		assert.equal(h.win.visualViewport.listenerCount("resize"), 0);
		assert.equal(h.getLayer()?.style.values.get("--knomo-keyboard-height"), "0px");
		let measurements = 0;
		const measure = h.controller.updateMeasurements.bind(h.controller);
		h.controller.updateMeasurements = () => { measurements++; return measure(); };
		for (let index = 0; index < 10; index++) h.controller.syncViewportTracking();
		assert.equal(measurements, 0);
		h.controller.open(); h.win.flushAnimationFrameCycles(3);
		assert.ok(measurements > 0);
		assert.equal(h.win.visualViewport.listenerCount("resize"), 1);
	} finally { h.controller.dispose(); }
});

test("detach 保留可复用图层和编辑器，remove 清空引用且下次 prepare 创建新图层", () => {
	const h = createHarness();
	const editor = Object.assign(h.input, { value: "保留草稿", selectionStart: 2, selectionEnd: 3 });
	try {
		h.controller.prepare();
		const layer = h.controller.getLayerEl();
		h.controller.open(); h.win.flushAnimationFrameCycles(3);
		h.controller.closeKeepingDraft(); h.win.flushAllTimers();
		h.setLayout("desktop-wide"); h.controller.syncLayer();
		assert.equal(h.controller.getLayerEl(), layer);
		assert.equal(h.composer.parentElement, h.home);
		assert.equal(h.getLayer(), null);
		h.setLayout("mobile"); h.controller.syncLayer();
		assert.equal(h.controller.getLayerEl(), layer);
		assert.equal(h.controller.isLayered(), true);
		assert.equal(h.input, editor);
		assert.deepEqual([editor.value, editor.selectionStart, editor.selectionEnd], ["保留草稿", 2, 3]);
		h.controller.dispose();
		assert.equal(h.controller.getLayerEl(), null);
		assert.equal(h.composer.parentElement, h.home);
		assert.equal(h.doc.body.children.length, 0);
		assert.equal(h.win.visualViewport.listenerCount("resize"), 0);
		h.controller.prepare();
		assert.notEqual(h.controller.getLayerEl(), layer);
		assert.equal(h.doc.body.children.length, 1);
		assert.equal(h.input, editor);
		assert.deepEqual([editor.value, editor.selectionStart, editor.selectionEnd], ["保留草稿", 2, 3]);
	} finally { h.controller.dispose(); }
});

async function createRootView(h: ReturnType<typeof createHarness>) {
	await ensureObsidianStub();
	const { KnomoView } = await import("../src/ui/KnomoView");
	const view = Object.create(KnomoView.prototype);
	Object.assign(view, {
		rootEl: Object.assign(h.root, { findAll: () => [] }), currentLayout: "mobile",
		viewStateController: new KnomoViewStateController(), popupState: { scopeMenuOpen: false },
		mobileSearchController: { isOpen: false }, desktopSidebarStateController: { getSnapshot: () => ({ width: 200, collapsed: false }) },
		settingsService: { getSettings: () => ({ mobileCompactMode: "off" }) },
		mobileComposerController: h.controller, sidebarResizerEl: null, referencePreviewEl: null,
		desktopDrawerFocus: { sync: () => {} }, timeBuoyPickerEl: null,
	});
	Object.defineProperty(view, "composerOpen", { get: () => h.getComposerOpen() });
	for (const name of ["syncPageFeedback", "syncTooltipState", "syncManualRefreshButtonState", "syncMobileHeaderActions",
		"syncMobileHeaderTitle", "syncMobileTopOffsets", "syncTitlePopoverPosition", "syncMobileSearchPage", "syncSearchControls",
		"positionOpenCardMenus", "updateCurrentLayout", "resizeInput", "scheduleLocalDraft"]) view[name] = () => {};
	return view;
}

function createHarness(layout: "mobile" | "desktop-wide" = "mobile", options: { onKeyboardTrackingChange?: (busy: boolean) => void; onFocusInput?: (moveToEnd?: boolean) => void } = {}) {
	const win = new FakeWindow();
	const doc = new FakeDocument();
	const root = new FakeElement("div");
	const container = new FakeElement("div");
	container.top = 12;
	const home = new FakeElement("div");
	const composer = new FakeElement("section");
	const input = new FakeTextArea(doc);
	const composerBar = new FakeElement("div");
	composerBar.offsetHeight = 52;
	const referencePreview = new FakeElement("div");
	home.appendChild(composer);
	let composerOpen = false;
	let syncRootCalls = 0;
	let syncComposerModeCalls = 0;
	let updateSendButtonCalls = 0;
	let updateCancelEditButtonCalls = 0;
	let focusCalls = 0;
	let closeDraftCalls = 0;
	let closedCalls = 0;
	const syncRootLayerOpenStates: boolean[] = [];
	const backdropHandlers: Array<{ element: HTMLElement; handler: (event: MouseEvent) => void }> = [];
	const controller = new MobileComposerController({
		...options,
		getWindow: () => win.asWindow(),
		getDocument: () => doc.asDocument(),
		getContainerEl: () => container.asHtml(),
		getRootEl: () => root.asHtml(),
		getComposerEl: () => composer.asHtml(),
		getInputEl: () => input.asTextArea(),
		getComposerBarEl: () => composerBar.asHtml(),
		getReferencePreviewEl: () => referencePreview.asHtml(),
		getLayout: () => layout,
		isComposerOpen: () => composerOpen,
		setComposerOpen: (open) => {
			composerOpen = open;
		},
		registerBackdropClick: (element, handler) => {
			backdropHandlers.push({ element, handler });
		},
		closeComposerKeepingDraft: () => {
			closeDraftCalls += 1;
		},
		focusInputNow: (_resize, _viewport, moveToEnd) => {
			focusCalls += 1;
			options.onFocusInput?.(moveToEnd);
		},
		resizeInput: () => undefined,
		syncRootState: () => {
			syncRootCalls += 1;
			syncRootLayerOpenStates.push(
				doc.body.children
					.find((child) => child.hasClass("knomo-mobile-composer-layer"))
					?.hasClass("is-open") ?? false,
			);
		},
		syncComposerMode: () => {
			syncComposerModeCalls += 1;
		},
		updateSendButtonState: () => {
			updateSendButtonCalls += 1;
		},
		updateCancelEditButtonState: () => {
			updateCancelEditButtonCalls += 1;
		},
		onClosed: () => {
			closedCalls += 1;
		},
	});
	return {
		win,
		doc,
		root,
		container,
		home,
		composer,
		composerBar,
		referencePreview,
		input,
		backdropHandlers,
		syncRootLayerOpenStates,
		controller,
		setLayout: (next: "mobile" | "desktop-wide") => { layout = next; },
		getComposerOpen: () => composerOpen,
		getLayer: () => doc.body.children.find((child) => child.hasClass("knomo-mobile-composer-layer")) ?? null,
		getBackdrop: () => {
			const layer = doc.body.children.find(child => child.hasClass("knomo-mobile-composer-layer"));
			return layer?.children.find(child => child.hasClass("knomo-mobile-composer-backdrop")) ?? null;
		},
		getContent: () => {
			const layer = doc.body.children.find((child) => child.hasClass("knomo-mobile-composer-layer")) ?? null;
			const stage = layer?.children.find((child) => child.hasClass("knomo-mobile-composer-stage")) ?? null;
			return stage?.children.find((child) => child.hasClass("knomo-mobile-composer-content")) ?? null;
		},
		get syncRootCalls() {
			return syncRootCalls;
		},
		get syncComposerModeCalls() {
			return syncComposerModeCalls;
		},
		get updateSendButtonCalls() {
			return updateSendButtonCalls;
		},
		get updateCancelEditButtonCalls() {
			return updateCancelEditButtonCalls;
		},
		get focusCalls() {
			return focusCalls;
		},
		get closeDraftCalls() {
			return closeDraftCalls;
		},
		get closedCalls() {
			return closedCalls;
		},
	};
}

interface CreateElementOptions {
	cls?: string;
	text?: string;
	attr?: Record<string, string>;
}

class FakeStyle {
	display = "";
	readonly values = new Map<string, string>();

	setProperty(name: string, value: string): void {
		this.values.set(name, value);
	}
}

class FakeElement {
	inert = false;
	private readonly transitionListeners = new Map<string, Set<(event: TransitionEvent) => void>>();
	addEventListener(type: string, handler: (event: TransitionEvent) => void): void {
		const handlers = this.transitionListeners.get(type) ?? new Set(); handlers.add(handler); this.transitionListeners.set(type, handlers);
	}
	removeEventListener(type: string, handler: (event: TransitionEvent) => void): void { this.transitionListeners.get(type)?.delete(handler); }
	transition(propertyName: string, type = "transitionend", target: FakeElement = this): void {
		for (const handler of this.transitionListeners.get(type) ?? []) handler({ type, target, propertyName, timeStamp: 10 } as unknown as TransitionEvent);
	}

	readonly children: FakeElement[] = [];
	readonly classes = new Set<string>();
	readonly attrs = new Map<string, string>();
	readonly style = new FakeStyle();
	parentElement: FakeElement | null = null;
	detached = false;
	offsetHeight = 0;
	top = 0;
	bottom = 0;

	constructor(private readonly tagName: string) {}

	asHtml(): HTMLElement {
		return this as unknown as HTMLElement;
	}

	get parentNode(): FakeElement | null {
		return this.parentElement;
	}

	get nextSibling(): FakeElement | null {
		if (this.parentElement === null) {
			return null;
		}
		const index = this.parentElement.children.indexOf(this);
		return index < 0 ? null : this.parentElement.children[index + 1] ?? null;
	}

	createDiv(options: CreateElementOptions = {}): FakeElement {
		return this.createEl("div", options);
	}

	createEl(tagName: string, options: CreateElementOptions = {}): FakeElement {
		const child = new FakeElement(tagName);
		if (options.cls !== undefined) {
			for (const cls of options.cls.split(/\s+/)) {
				if (cls.length > 0) {
					child.classes.add(cls);
				}
			}
		}
		for (const [key, value] of Object.entries(options.attr ?? {})) {
			child.attrs.set(key, value);
		}
		this.appendChild(child);
		return child;
	}

	appendChild(child: FakeElement): FakeElement {
		child.parentElement?.removeChild(child);
		child.parentElement = this;
		child.detached = false;
		this.children.push(child);
		return child;
	}

	insertBefore(child: FakeElement, nextSibling: FakeElement): FakeElement {
		child.parentElement?.removeChild(child);
		child.parentElement = this;
		child.detached = false;
		const index = this.children.indexOf(nextSibling);
		if (index < 0) {
			this.children.push(child);
		} else {
			this.children.splice(index, 0, child);
		}
		return child;
	}

	removeChild(child: FakeElement): void {
		const index = this.children.indexOf(child);
		if (index >= 0) {
			this.children.splice(index, 1);
		}
		child.parentElement = null;
	}

	detach(): void {
		this.parentElement?.removeChild(this);
		this.detached = true;
	}

	setAttr(key: string, value: string): void {
		this.attrs.set(key, value);
	}

	removeAttribute(key: string): void {
		this.attrs.delete(key);
	}

	setCssProps(props: Record<string, string>): void {
		const style = this.style;
		for (const [key, value] of Object.entries(props)) {
			style.setProperty(key, value);
		}
	}

	querySelectorAll(selector: string): FakeElement[] {
		const selectors = selector.split(",").map((part) => part.trim());
		const matches: FakeElement[] = [];
		const visit = (element: FakeElement) => {
			for (const child of element.children) {
				if (selectors.some((part) => child.matches(part))) {
					matches.push(child);
				}
				visit(child);
			}
		};
		visit(this);
		return matches;
	}

	toggleClass(cls: string, active?: boolean): void {
		const shouldAdd = active ?? !this.classes.has(cls);
		if (shouldAdd) {
			this.classes.add(cls);
		} else {
			this.classes.delete(cls);
		}
	}

	hasClass(cls: string): boolean {
		return this.classes.has(cls);
	}

	getBoundingClientRect(): Pick<DOMRect, "top" | "bottom"> {
		return { top: this.top, bottom: this.bottom };
	}

	private matches(selector: string): boolean {
		if (selector.startsWith(".")) {
			return this.classes.has(selector.slice(1));
		}
		return this.tagName === selector;
	}
}

class FakeTextArea extends FakeElement {
	blurCount = 0;

	constructor(private readonly doc: FakeDocument) {
		super("textarea");
	}

	asTextArea(): HTMLTextAreaElement {
		return this as unknown as HTMLTextAreaElement;
	}

	focus(): void {
		this.doc.activeElement = this.asHtml();
	}

	blur(): void {
		this.blurCount += 1;
		if (this.doc.activeElement === this.asHtml()) {
			this.doc.activeElement = null;
		}
	}
}

class FakeDocument {
	readonly body = new FakeElement("body");
	activeElement: Element | null = null;

	asDocument(): Document {
		return this as unknown as Document;
	}
}

class FakeVisualViewport {
	offsetTop = 0;
	height = 800;
	private readonly listeners = new Map<string, Set<() => void>>();

	addEventListener(type: string, handler: () => void): void {
		const handlers = this.listeners.get(type) ?? new Set<() => void>();
		handlers.add(handler);
		this.listeners.set(type, handlers);
	}

	removeEventListener(type: string, handler: () => void): void {
		this.listeners.get(type)?.delete(handler);
	}

	listenerCount(type: string): number {
		return this.listeners.get(type)?.size ?? 0;
	}

	dispatchEvent(type: string): void {
		for (const handler of this.listeners.get(type) ?? []) {
			handler();
		}
	}
}

class FakeVirtualKeyboard {
	boundingRect: { y: number; height: number } = { y: 0, height: 0 };
	private readonly listeners = new Map<string, Set<() => void>>();

	addEventListener(type: string, handler: () => void): void {
		const handlers = this.listeners.get(type) ?? new Set<() => void>();
		handlers.add(handler);
		this.listeners.set(type, handlers);
	}

	removeEventListener(type: string, handler: () => void): void {
		this.listeners.get(type)?.delete(handler);
	}

	listenerCount(type: string): number {
		return this.listeners.get(type)?.size ?? 0;
	}
}

class FakeWindow {
	reducedMotion = false;
	transitionDuration = "240ms, 220ms";
	readonly performance = { now: () => 0 };
	matchMedia(): { matches: boolean } { return { matches: this.reducedMotion }; }
	getComputedStyle(): { transitionProperty: string; transitionDuration: string; transitionDelay: string } {
		return { transitionProperty: "transform, opacity", transitionDuration: this.reducedMotion ? "0s" : this.transitionDuration, transitionDelay: "0s" };
	}

	innerHeight = 800;
	readonly visualViewport = new FakeVisualViewport();
	readonly virtualKeyboard = new FakeVirtualKeyboard();
	readonly navigator = {
		virtualKeyboard: this.virtualKeyboard,
	};
	private nextFrameId = 1;
	private nextTimerId = 1;
	private frameTime = 0;
	private readonly frames = new Map<number, FrameRequestCallback>();
	private readonly timers = new Map<number, { delay: number; order: number; handler: () => void }>();
	private readonly listeners = new Map<string, Set<(event: Event) => void>>();

	asWindow(): Window {
		return this as unknown as Window;
	}

	requestAnimationFrame(callback: FrameRequestCallback): number {
		const id = this.nextFrameId;
		this.nextFrameId += 1;
		this.frames.set(id, callback);
		return id;
	}

	cancelAnimationFrame(id: number): void {
		this.frames.delete(id);
	}

	flushAnimationFrames(): void {
		const frames = Array.from(this.frames.entries());
		this.frames.clear();
		this.frameTime += 16;
		for (const [, callback] of frames) {
			callback(this.frameTime);
		}
	}

	flushAnimationFrameCycles(count: number): void {
		for (let index = 0; index < count; index += 1) {
			this.flushAnimationFrames();
		}
	}

	setTimeout(handler: () => void, delay = 0): number {
		const id = this.nextTimerId;
		this.nextTimerId += 1;
		this.timers.set(id, { delay, order: id, handler });
		return id;
	}

	clearTimeout(id: number): void {
		this.timers.delete(id);
	}

	flushNextTimer(): void {
		const next = Array.from(this.timers.entries())
			.sort((left, right) => left[1].delay - right[1].delay || left[1].order - right[1].order)[0];
		if (next === undefined) {
			return;
		}
		this.timers.delete(next[0]);
		next[1].handler();
	}

	flushAllTimers(): void {
		while (this.timers.size > 0) {
			this.flushNextTimer();
		}
	}

	addEventListener(type: string, handler: (event: Event) => void): void {
		const handlers = this.listeners.get(type) ?? new Set<(event: Event) => void>();
		handlers.add(handler);
		this.listeners.set(type, handlers);
	}

	removeEventListener(type: string, handler: (event: Event) => void): void {
		this.listeners.get(type)?.delete(handler);
	}

	dispatchEvent(type: string, event = { type } as Event): void {
		for (const handler of this.listeners.get(type) ?? []) {
			handler(event);
		}
	}

	dispatchKeyboardEvent(type: string, keyboardHeight: number): void {
		this.dispatchEvent(type, {
			type,
			keyboardHeight,
			detail: { keyboardHeight },
		} as unknown as Event);
	}
}

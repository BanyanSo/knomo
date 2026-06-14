import test from "node:test";
import assert from "node:assert/strict";

import { MobileComposerController } from "../src/ui/MobileComposerController";

test("prepares a persistent mobile layer before opening", () => {
	const harness = createHarness();

	harness.controller.prepare();

	const layer = harness.getLayer();
	assert.equal(harness.controller.isLayered(), true);
	assert.equal(layer?.hasClass("is-active"), false);
	assert.equal(layer?.attrs.get("aria-hidden"), "true");
	assert.equal(harness.doc.body.children.length, 1);
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
	assert.equal(harness.controller.getOpenScrollTop(), 42);
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
	assert.equal(layer?.hasClass("is-open"), true);
	assert.equal(layer?.hasClass("is-closing"), true);
	assert.equal(layer?.hasClass("is-keyboard-tracking"), true);
	assert.equal(harness.input.blurCount, 1);

	harness.win.visualViewport.height = 800;
	harness.win.visualViewport.dispatchEvent("resize");
	harness.win.flushAnimationFrames();

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

function createHarness(layout: "mobile" | "desktop-wide" = "mobile") {
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
	referencePreview.style.display = "none";
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
		getCardFlowScrollTop: () => 42,
		registerBackdropClick: (element, handler) => {
			backdropHandlers.push({ element, handler });
		},
		closeComposerKeepingDraft: () => {
			closeDraftCalls += 1;
		},
		focusInputNow: () => {
			focusCalls += 1;
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
		input,
		backdropHandlers,
		syncRootLayerOpenStates,
		controller,
		getComposerOpen: () => composerOpen,
		getLayer: () => doc.body.children.find((child) => child.hasClass("knomo-mobile-composer-layer")) ?? null,
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
	readonly children: FakeElement[] = [];
	readonly classes = new Set<string>();
	readonly attrs = new Map<string, string>();
	readonly style = new FakeStyle();
	parentElement: FakeElement | null = null;
	detached = false;
	offsetHeight = 0;
	top = 0;
	bottom = 0;
	private text = "";

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
		if (options.text !== undefined) {
			child.text = options.text;
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
		for (const [id, callback] of frames) {
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

	dispatchEvent(type: string, event = {} as Event): void {
		for (const handler of this.listeners.get(type) ?? []) {
			handler(event);
		}
	}

	dispatchKeyboardEvent(type: string, keyboardHeight: number): void {
		this.dispatchEvent(type, {
			keyboardHeight,
			detail: { keyboardHeight },
		} as unknown as Event);
	}
}

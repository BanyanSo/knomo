import test from "node:test";
import assert from "node:assert/strict";

import { MobileComposerController } from "../src/ui/MobileComposerController";

test("opens the mobile composer in a body layer and records the flow scroll top", () => {
	const harness = createHarness();

	harness.controller.open();

	const layer = harness.getLayer();
	assert.equal(harness.getComposerOpen(), true);
	assert.equal(harness.controller.getPhase(), "opening");
	assert.equal(harness.controller.getOpenScrollTop(), 42);
	assert.equal(harness.controller.isLayered(), true);
	assert.equal(layer?.hasClass("is-open"), false);
	assert.equal(harness.syncRootCalls, 1);

	harness.win.flushAnimationFrames();
	assert.equal(layer?.hasClass("is-open"), true);

	harness.win.flushNextTimer();
	assert.equal(harness.controller.getPhase(), "focusing");
	assert.equal(harness.focusCalls, 1);
	assert.equal(harness.win.visualViewport.listenerCount("resize"), 1);
	assert.equal(harness.win.visualViewport.listenerCount("scroll"), 1);
	assert.equal(layer?.style.values.get("--knomo-keyboard-height"), "300px");
	assert.equal(layer?.style.values.get("--knomo-keyboard-toolbar-gap-correction"), "20px");
});

test("delegates backdrop clicks back to the view close-draft path", () => {
	const harness = createHarness();
	harness.controller.open();
	const handler = harness.backdropHandlers[0];
	assert.notEqual(handler, undefined);

	handler.handler({ target: handler.element } as unknown as MouseEvent);

	assert.equal(harness.closeDraftCalls, 1);
	assert.equal(harness.controller.getPhase(), "opening");
});

test("closes the mobile composer after the closing timer and restores the original DOM", () => {
	const harness = createHarness();
	harness.controller.open();
	harness.win.flushAnimationFrames();

	harness.controller.closeKeepingDraft();

	const layer = harness.getLayer();
	assert.equal(harness.controller.getPhase(), "closing");
	assert.equal(layer?.hasClass("is-open"), false);
	assert.equal(layer?.hasClass("is-closing"), true);
	assert.equal(harness.input.blurCount, 1);

	harness.win.flushAllTimers();

	assert.equal(harness.getComposerOpen(), false);
	assert.equal(harness.controller.getPhase(), "closed");
	assert.equal(harness.controller.isLayered(), false);
	assert.equal(harness.composer.parentElement, harness.home);
	assert.equal(layer?.detached, true);
	assert.equal(harness.syncRootCalls, 2);
	assert.equal(harness.syncComposerModeCalls, 1);
	assert.equal(harness.updateSendButtonCalls, 1);
	assert.equal(harness.updateCancelEditButtonCalls, 1);
});

function createHarness() {
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
		getLayout: () => "mobile",
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
	});
	return {
		win,
		doc,
		root,
		container,
		home,
		composer,
		input,
		backdropHandlers,
		controller,
		getComposerOpen: () => composerOpen,
		getLayer: () => doc.body.children.find((child) => child.hasClass("knomo-mobile-composer-layer")) ?? null,
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

	getBoundingClientRect(): Pick<DOMRect, "top"> {
		return { top: this.top };
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
	height = 500;
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
	private nextFrameId = 1;
	private nextTimerId = 1;
	private readonly frames = new Map<number, FrameRequestCallback>();
	private readonly timers = new Map<number, { delay: number; order: number; handler: () => void }>();
	private readonly listeners = new Map<string, Set<() => void>>();

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
		for (const [id, callback] of frames) {
			callback(id);
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

	addEventListener(type: string, handler: () => void): void {
		const handlers = this.listeners.get(type) ?? new Set<() => void>();
		handlers.add(handler);
		this.listeners.set(type, handlers);
	}

	removeEventListener(type: string, handler: () => void): void {
		this.listeners.get(type)?.delete(handler);
	}
}

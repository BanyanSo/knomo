import test from "node:test";
import assert from "node:assert/strict";
import type { App, EventRef, TFile } from "obsidian";

import { KnomoWikiLinkSuggest } from "../src/ui/KnomoWikiLinkSuggest";

test("does not modify textarea while composing and completes after compositionend", () => {
	const harness = createHarness([makeFile("Notes/Alpha.md")]);
	harness.input.value = "【【";
	harness.input.setSelectionRange(2, 2);
	harness.suggest.handleCompositionStart();
	assert.equal(harness.suggest.handleInput(), false);
	assert.equal(harness.input.value, "【【");
	assert.equal(harness.suggest.handleCompositionEnd(), true);
	assert.equal(harness.input.value, "[[]]");
	assert.equal(harness.input.selectionStart, 2);
});

test("selects a candidate with fileToLinktext", () => {
	const file = makeFile("Projects/Alpha.md");
	const harness = createHarness([file], {
		fileToLinktext: () => "Alpha alias",
	});
	harness.input.value = "[[alp]]";
	harness.input.setSelectionRange(5, 5);
	harness.suggest.openForCurrentRange();
	harness.win.flushAnimationFrames();
	assert.equal(harness.suggest.handleKeydown(createKeyboardEvent("Enter")), true);
	assert.equal(harness.input.value, "[[Alpha alias]]");
	assert.equal(harness.input.selectionStart, 15);
	assert.deepEqual(harness.fileToLinktextCalls, [{ file, sourcePath: "Daily/2026-06-05.md", omitMdExtension: true }]);
});

test("handles ArrowUp ArrowDown Enter Tab and Escape", () => {
	const harness = createHarness([
		makeFile("Projects/Alpha.md"),
		makeFile("Projects/Beta.md"),
	]);
	harness.input.value = "[[]]";
	harness.input.setSelectionRange(2, 2);
	harness.suggest.openForCurrentRange();
	harness.win.flushAnimationFrames();

	const down = createKeyboardEvent("ArrowDown");
	assert.equal(harness.suggest.handleKeydown(down), true);
	assert.equal(harness.suggest.getSelectedIndex(), 1);
	assert.equal(down.prevented, true);

	const up = createKeyboardEvent("ArrowUp");
	assert.equal(harness.suggest.handleKeydown(up), true);
	assert.equal(harness.suggest.getSelectedIndex(), 0);

	assert.equal(harness.suggest.handleKeydown(createKeyboardEvent("Enter")), true);
	assert.equal(harness.input.value, "[[Projects/Alpha]]");

	const tabHarness = createHarness([makeFile("Projects/Beta.md")]);
	tabHarness.input.value = "[[]]";
	tabHarness.input.setSelectionRange(2, 2);
	tabHarness.suggest.openForCurrentRange();
	assert.equal(tabHarness.suggest.handleKeydown(createKeyboardEvent("Tab")), true);
	assert.equal(tabHarness.input.value, "[[Projects/Beta]]");

	const escapeHarness = createHarness([makeFile("Projects/Beta.md")]);
	escapeHarness.input.value = "[[]]";
	escapeHarness.input.setSelectionRange(2, 2);
	escapeHarness.suggest.openForCurrentRange();
	assert.equal(escapeHarness.suggest.handleKeydown(createKeyboardEvent("Escape")), true);
	assert.equal(escapeHarness.suggest.isOpen(), false);
});

test("does not insert on Tab when there are no candidates", () => {
	const harness = createHarness([makeFile("Projects/Alpha.md")]);
	harness.input.value = "[[missing]]";
	harness.input.setSelectionRange(9, 9);
	harness.suggest.openForCurrentRange();
	const tab = createKeyboardEvent("Tab");
	assert.equal(harness.suggest.handleKeydown(tab), false);
	assert.equal(harness.input.value, "[[missing]]");
	assert.equal(tab.prevented, false);
});

test("closes tag suggest when WikiLink suggest opens", () => {
	const harness = createHarness([makeFile("Projects/Alpha.md")]);
	harness.input.value = "[[]]";
	harness.input.setSelectionRange(2, 2);
	harness.suggest.openForCurrentRange();
	assert.equal(harness.closeTagSuggestCount, 1);
});

test("uses cached markdown files until vault events invalidate the cache", () => {
	const file = makeFile("Projects/Alpha.md");
	const harness = createHarness([file]);
	harness.input.value = "[[]]";
	harness.input.setSelectionRange(2, 2);
	harness.suggest.openForCurrentRange();
	harness.suggest.refreshForCursor();
	assert.equal(harness.getMarkdownFilesCount, 1);
	harness.emitVaultEvent("rename");
	assert.equal(harness.getMarkdownFilesCount, 2);
});

test("touch candidate selection prevents blur and keeps focus", () => {
	const file = makeFile("Projects/Alpha.md");
	const harness = createHarness([file], { mobileLayer: true });
	harness.input.value = "[[]]";
	harness.input.setSelectionRange(2, 2);
	harness.input.focus();
	harness.suggest.openForCurrentRange();
	harness.win.flushAnimationFrames();
	const popover = harness.suggest.getPopoverForTest();
	assert.notEqual(popover, null);
	const item = (popover as unknown as FakeElement).children[0];
	const pointerDown = createDomEvent();
	item.dispatchTestEvent("pointerdown", pointerDown);
	assert.equal(pointerDown.prevented, true);
	assert.equal(harness.doc.activeElement, harness.input.asHtml());
	const touchEnd = createDomEvent();
	item.dispatchTestEvent("touchend", touchEnd);
	assert.equal(touchEnd.prevented, true);
	assert.equal(harness.input.value, "[[Projects/Alpha]]");
	assert.equal(harness.doc.activeElement, harness.input.asHtml());
});

test("positions WikiLink popover at the current textarea cursor", () => {
	const harness = createHarness([makeFile("Projects/Alpha.md")]);
	harness.win.innerWidth = 800;
	harness.win.visualViewport.width = 800;
	harness.input.value = "[[Al]]";
	harness.input.setSelectionRange(4, 4);
	harness.suggest.openForCurrentRange();
	harness.win.flushAnimationFrames();
	const popover = harness.suggest.getPopoverForTest();
	assert.notEqual(popover, null);
	const style = (popover as unknown as FakeElement).style.values;
	assert.equal(style.get("left"), "52px");
	assert.equal(style.get("top"), "318px");
});

interface HarnessOptions {
	fileToLinktext?: (file: TFile, sourcePath: string, omitMdExtension?: boolean) => string;
	mobileLayer?: boolean;
}

interface FileToLinktextCall {
	file: TFile;
	sourcePath: string;
	omitMdExtension: boolean | undefined;
}

function createHarness(files: TFile[], options: HarnessOptions = {}) {
	const win = new FakeWindow();
	const doc = new FakeDocument(win);
	const layer = options.mobileLayer ? doc.body.createDiv({ cls: "knomo-mobile-composer-layer" }) : doc.body;
	const input = new FakeTextArea(doc);
	layer.appendChild(input);
	const vaultHandlers = new Map<string, Array<() => void>>();
	const fileToLinktextCalls: FileToLinktextCall[] = [];
	let getMarkdownFilesCount = 0;
	let closeTagSuggestCount = 0;
	const app = {
		vault: {
			getMarkdownFiles: () => {
				getMarkdownFilesCount += 1;
				return files;
			},
			on: (name: string, handler: () => void) => {
				const handlers = vaultHandlers.get(name) ?? [];
				handlers.push(handler);
				vaultHandlers.set(name, handlers);
				return {} as EventRef;
			},
		},
		metadataCache: {
			fileToLinktext: (file: TFile, sourcePath: string, omitMdExtension?: boolean) => {
				fileToLinktextCalls.push({ file, sourcePath, omitMdExtension });
				return options.fileToLinktext?.(file, sourcePath, omitMdExtension) ?? file.path.replace(/\.md$/i, "");
			},
			getFirstLinkpathDest: (linktext: string) => {
				return files.find((file) => file.path.replace(/\.md$/i, "") === linktext || file.basename === linktext || linktext === "Alpha alias") ?? null;
			},
		},
	} as unknown as App;
	const suggest = new KnomoWikiLinkSuggest(app, input.asTextArea(), {
		getSourcePath: () => "Daily/2026-06-05.md",
		onInputChanged: () => undefined,
		closeTagSuggest: () => {
			closeTagSuggestCount += 1;
		},
		registerVaultEvent: () => undefined,
	});
	return {
		win,
		doc,
		input,
		suggest,
		fileToLinktextCalls,
		emitVaultEvent: (name: string) => {
			for (const handler of vaultHandlers.get(name) ?? []) {
				handler();
			}
		},
		get getMarkdownFilesCount() {
			return getMarkdownFilesCount;
		},
		get closeTagSuggestCount() {
			return closeTagSuggestCount;
		},
	};
}

function makeFile(path: string): TFile {
	const name = path.split("/").pop() ?? path;
	const basename = name.replace(/\.md$/i, "");
	return {
		path,
		name,
		basename,
		extension: "md",
	} as unknown as TFile;
}

function createKeyboardEvent(key: string): KeyboardEvent & { prevented: boolean } {
	return {
		key,
		prevented: false,
		preventDefault() {
			this.prevented = true;
		},
		stopPropagation() {},
		stopImmediatePropagation() {},
	} as KeyboardEvent & { prevented: boolean };
}

function createDomEvent(): Event & { prevented: boolean } {
	return {
		prevented: false,
		preventDefault() {
			this.prevented = true;
		},
	} as Event & { prevented: boolean };
}

class FakeStyle {
	readonly values = new Map<string, string>();

	set position(value: string) {
		this.values.set("position", value);
	}

	set zIndex(value: string) {
		this.values.set("zIndex", value);
	}

	set left(value: string) {
		this.values.set("left", value);
	}

	set right(value: string) {
		this.values.set("right", value);
	}

	set top(value: string) {
		this.values.set("top", value);
	}

	set bottom(value: string) {
		this.values.set("bottom", value);
	}

	set width(value: string) {
		this.values.set("width", value);
	}

	set maxHeight(value: string) {
		this.values.set("maxHeight", value);
	}
}

interface FakeElementOptions {
	cls?: string;
	text?: string;
	attr?: Record<string, string>;
}

class FakeElement {
	readonly children: FakeElement[] = [];
	readonly classes = new Set<string>();
	readonly attrs = new Map<string, string>();
	readonly style = new FakeStyle();
	readonly listeners = new Map<string, Array<(event: Event) => void>>();
	parentElement: FakeElement | null = null;
	scrollHeight = 88;
	scrollWidth = 300;
	offsetWidth = 100;
	clientWidth = 88;
	private text = "";

	constructor(
		private readonly tagName: string,
		readonly ownerDocument: FakeDocument,
	) {}

	asHtml(): HTMLElement {
		return this as unknown as HTMLElement;
	}

	createDiv(options: FakeElementOptions = {}): FakeElement {
		return this.createEl("div", options);
	}

	createSpan(options: FakeElementOptions = {}): FakeElement {
		return this.createEl("span", options);
	}

	createEl(tagName: string, options: FakeElementOptions = {}): FakeElement {
		const child = new FakeElement(tagName, this.ownerDocument);
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

	setText(text: string): void {
		this.text = text;
	}

	appendChild(child: FakeElement): FakeElement {
		child.parentElement?.removeChild(child);
		child.parentElement = this;
		this.children.push(child);
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
	}

	empty(): void {
		for (const child of this.children) {
			child.parentElement = null;
		}
		this.children.length = 0;
	}

	toggleClass(cls: string, active?: boolean): void {
		const shouldAdd = active ?? !this.classes.has(cls);
		if (shouldAdd) {
			this.classes.add(cls);
		} else {
			this.classes.delete(cls);
		}
	}

	addEventListener(type: string, handler: (event: Event) => void): void {
		const handlers = this.listeners.get(type) ?? [];
		handlers.push(handler);
		this.listeners.set(type, handlers);
	}

	dispatchTestEvent(type: string, event: Event): void {
		for (const handler of this.listeners.get(type) ?? []) {
			handler(event);
		}
	}

	querySelectorAll(selector: string): FakeElement[] {
		const matches: FakeElement[] = [];
		const visit = (element: FakeElement) => {
			for (const child of element.children) {
				if (selector.startsWith(".") && child.classes.has(selector.slice(1))) {
					matches.push(child);
				}
				visit(child);
			}
		};
		visit(this);
		return matches;
	}

	cloneNode(deep = false): FakeElement {
		const clone = new FakeElement(this.tagName, this.ownerDocument);
		clone.text = this.text;
		clone.scrollHeight = this.scrollHeight;
		clone.scrollWidth = this.scrollWidth;
		clone.offsetWidth = this.offsetWidth;
		clone.clientWidth = this.clientWidth;
		for (const cls of this.classes) {
			clone.classes.add(cls);
		}
		for (const [key, value] of this.attrs) {
			clone.attrs.set(key, value);
		}
		if (deep) {
			for (const child of this.children) {
				clone.appendChild(child.cloneNode(true));
			}
		}
		return clone;
	}

	getBoundingClientRect(): Pick<DOMRect, "left" | "top" | "right" | "bottom" | "width" | "height"> {
		if (this.tagName === "span" && this.parentElement !== null) {
			const left = 24 + this.parentElement.text.length * 7;
			return {
				left,
				top: 300,
				right: left + 1,
				bottom: 318,
				width: 1,
				height: 18,
			};
		}
		return {
			left: 24,
			top: 300,
			right: 324,
			bottom: 344,
			width: 300,
			height: 44,
		};
	}

	closest(selector: string): FakeElement | null {
		let current: FakeElement | null = this;
		while (current !== null) {
			if (selector === ".knomo-mobile-composer-layer" && current.classes.has("knomo-mobile-composer-layer")) {
				return current;
			}
			current = current.parentElement;
		}
		return null;
	}

	instanceOf(constructor: unknown): boolean {
		return constructor === FakeElement;
	}
}

class FakeTextArea extends FakeElement {
	value = "";
	selectionStart = 0;
	selectionEnd = 0;
	scrollLeft = 0;
	scrollTop = 0;

	constructor(doc: FakeDocument) {
		super("textarea", doc);
	}

	asTextArea(): HTMLTextAreaElement {
		return this as unknown as HTMLTextAreaElement;
	}

	setSelectionRange(start: number, end: number): void {
		this.selectionStart = start;
		this.selectionEnd = end;
	}

	focus(): void {
		this.ownerDocument.activeElement = this.asHtml();
	}

	dispatchEvent(_event: Event): boolean {
		return true;
	}
}

class FakeDocument {
	readonly body: FakeElement;
	readonly documentElement = {
		clientWidth: 390,
		clientHeight: 800,
	};
	activeElement: Element | null = null;

	constructor(readonly defaultView: FakeWindow) {
		this.body = new FakeElement("body", this);
	}

	createEvent(_type: string): Event {
		return {
			initEvent() {},
		} as unknown as Event;
	}
}

class FakeWindow {
	innerWidth = 390;
	innerHeight = 800;
	readonly HTMLElement = FakeElement;
	readonly visualViewport = {
		offsetTop: 0,
		offsetLeft: 0,
		width: 390,
		height: 800,
	};
	private nextFrameId = 1;
	private readonly frames = new Map<number, FrameRequestCallback>();

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

	getComputedStyle(_element: Element): CSSStyleDeclaration {
		return {
			wordBreak: "normal",
			boxSizing: "border-box",
			minHeight: "0px",
			padding: "0px",
			paddingTop: "0px",
			paddingBottom: "0px",
			paddingLeft: "0px",
			paddingRight: "0px",
			border: "0px",
			borderTopWidth: "0px",
			borderBottomWidth: "0px",
			borderLeftWidth: "0px",
			borderRightWidth: "0px",
			font: "14px sans-serif",
			lineHeight: "18px",
			letterSpacing: "0px",
			textTransform: "none",
		} as unknown as CSSStyleDeclaration;
	}
}

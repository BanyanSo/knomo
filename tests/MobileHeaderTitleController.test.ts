import test from "node:test";
import assert from "node:assert/strict";

import {
	MobileHeaderTitleController,
	type MobileHeaderTitleRegisterDomEvent,
} from "../src/ui/MobileHeaderTitleController";

test("mobile header title renders scope title and reuses existing event registration", () => {
	const harness = createHarness();

	harness.controller.sync({
		headerEl: harness.header.asHtml(),
		titleEl: harness.title.asHtml(),
		isRecordStats: false,
		scopeMenuOpen: false,
		label: "All memos",
	});
	harness.controller.sync({
		headerEl: harness.header.asHtml(),
		titleEl: harness.title.asHtml(),
		isRecordStats: false,
		scopeMenuOpen: true,
		label: "Tagged",
	});

	assert.equal(harness.controller.getAnchor(), harness.title.asHtml());
	assert.equal(harness.title.hasClass("knomo-mobile-title"), true);
	assert.equal(harness.title.getAttr("role"), "button");
	assert.equal(harness.title.getAttr("aria-haspopup"), "menu");
	assert.equal(harness.title.getAttr("aria-expanded"), "true");
	assert.equal(harness.title.getAttr("tabindex"), "0");
	assert.equal(harness.title.getText(), "Tagged");
	assert.notEqual(harness.title.find(".knomo-title-chevron"), null);
	assert.equal(harness.registrations.length, 2);
});

test("mobile header title ignores menu events while showing record stats", () => {
	const harness = createHarness();
	harness.controller.sync({
		headerEl: harness.header.asHtml(),
		titleEl: harness.title.asHtml(),
		isRecordStats: false,
		scopeMenuOpen: false,
		label: "All memos",
	});

	harness.dispatch("click");
	harness.dispatch("keydown", { key: "Escape" });
	harness.dispatch("keydown", { key: "Enter" });
	assert.equal(harness.toggleCount, 2);

	harness.setCanToggleScopeMenu(false);
	harness.controller.sync({
		headerEl: harness.header.asHtml(),
		titleEl: harness.title.asHtml(),
		isRecordStats: true,
		scopeMenuOpen: false,
		label: "Record stats",
	});
	harness.dispatch("click");
	harness.dispatch("keydown", { key: "Enter" });

	assert.equal(harness.toggleCount, 2);
	assert.equal(harness.header.hasClass("knomo-record-stats-header"), true);
	assert.equal(harness.title.getAttr("role"), null);
	assert.equal(harness.title.getAttr("aria-haspopup"), null);
	assert.equal(harness.title.getAttr("aria-expanded"), null);
	assert.equal(harness.title.getAttr("tabindex"), null);
	assert.equal(harness.title.getText(), "Record stats");
});

test("mobile header title remove restores the original Obsidian title", () => {
	const harness = createHarness();
	harness.title.setText("Knomo");
	harness.controller.sync({
		headerEl: harness.header.asHtml(),
		titleEl: harness.title.asHtml(),
		isRecordStats: true,
		scopeMenuOpen: false,
		label: "Record stats",
	});

	harness.controller.remove();

	assert.equal(harness.controller.getAnchor(), null);
	assert.equal(harness.header.hasClass("knomo-record-stats-header"), false);
	assert.equal(harness.title.hasClass("knomo-mobile-title"), false);
	assert.equal(harness.title.getText(), "Knomo");
	assert.equal(harness.title.getAttr("role"), null);
	assert.equal(harness.title.getAttr("aria-haspopup"), null);
	assert.equal(harness.title.getAttr("aria-expanded"), null);
	assert.equal(harness.title.getAttr("tabindex"), null);
});

test("mobile header title rebinds events after a render-scope reset", () => {
	const harness = createHarness();
	harness.controller.sync({
		headerEl: harness.header.asHtml(),
		titleEl: harness.title.asHtml(),
		isRecordStats: false,
		scopeMenuOpen: false,
		label: "All memos",
	});
	harness.controller.remove();
	harness.controller.sync({
		headerEl: harness.header.asHtml(),
		titleEl: harness.title.asHtml(),
		isRecordStats: false,
		scopeMenuOpen: false,
		label: "All memos",
	});

	assert.equal(harness.registrations.length, 4);
});

test("mobile header title restores old title before binding a replacement element", () => {
	const harness = createHarness();
	const nextHeader = new TestElement("header");
	const nextTitle = new TestElement("div");
	harness.title.setText("First");
	nextTitle.setText("Second");

	harness.controller.sync({
		headerEl: harness.header.asHtml(),
		titleEl: harness.title.asHtml(),
		isRecordStats: false,
		scopeMenuOpen: false,
		label: "All memos",
	});
	harness.controller.sync({
		headerEl: nextHeader.asHtml(),
		titleEl: nextTitle.asHtml(),
		isRecordStats: false,
		scopeMenuOpen: false,
		label: "Review",
	});

	assert.equal(harness.title.getText(), "First");
	assert.equal(harness.title.hasClass("knomo-mobile-title"), false);
	assert.equal(nextTitle.getText(), "Review");
	assert.equal(harness.registrations.length, 4);
});

interface Registration {
	target: HTMLElement;
	type: "click" | "keydown";
	listener: (event: MouseEvent | KeyboardEvent) => void;
}

function createHarness(): {
	controller: MobileHeaderTitleController;
	header: TestElement;
	title: TestElement;
	registrations: Registration[];
	readonly toggleCount: number;
	setCanToggleScopeMenu: (enabled: boolean) => void;
	dispatch: (type: "click" | "keydown", event?: Partial<KeyboardEvent>) => void;
} {
	const header = new TestElement("header");
	const title = new TestElement("div");
	const registrations: Registration[] = [];
	let toggleCount = 0;
	let canToggleScopeMenu = true;
	const registerDomEvent: MobileHeaderTitleRegisterDomEvent = (target, type, listener) => {
		registrations.push({
			target,
			type,
			listener: listener as (event: MouseEvent | KeyboardEvent) => void,
		});
	};
	const controller = new MobileHeaderTitleController({
		registerDomEvent,
		renderChevron: (container) => {
			container.createSpan({ cls: "knomo-title-chevron" });
		},
		canToggleScopeMenu: () => canToggleScopeMenu,
		onToggleScopeMenu: () => {
			toggleCount += 1;
		},
	});
	return {
		controller,
		header,
		title,
		registrations,
		get toggleCount() {
			return toggleCount;
		},
		setCanToggleScopeMenu: (enabled) => {
			canToggleScopeMenu = enabled;
		},
		dispatch: (type, event = {}) => {
			const registration = registrations.find((item) => item.target === title.asHtml() && item.type === type);
			assert.notEqual(registration, undefined);
			registration?.listener({
				preventDefault: () => undefined,
				...event,
			} as MouseEvent | KeyboardEvent);
		},
	};
}

interface CreateElementOptions {
	cls?: string;
	text?: string;
}

class TestElement {
	private readonly children: TestElement[] = [];
	private readonly classes = new Set<string>();
	private readonly attrs = new Map<string, string>();
	private text = "";

	constructor(private readonly tagName: string) {}

	get textContent(): string {
		return this.getText();
	}

	asHtml(): HTMLElement {
		return this as unknown as HTMLElement;
	}

	createSpan(options: CreateElementOptions = {}): TestElement {
		const child = new TestElement("span");
		if (options.cls !== undefined) {
			for (const cls of options.cls.split(/\s+/)) {
				if (cls.length > 0) {
					child.addClass(cls);
				}
			}
		}
		if (options.text !== undefined) {
			child.setText(options.text);
		}
		this.children.push(child);
		return child;
	}

	empty(): void {
		this.children.length = 0;
		this.text = "";
	}

	setText(value: string): void {
		this.text = value;
	}

	getText(): string {
		return this.text + this.children.map((child) => child.getText()).join("");
	}

	setAttr(key: string, value: string): void {
		this.attrs.set(key, value);
	}

	getAttr(key: string): string | null {
		return this.attrs.get(key) ?? null;
	}

	removeAttribute(key: string): void {
		this.attrs.delete(key);
	}

	addClass(cls: string): void {
		this.classes.add(cls);
	}

	removeClass(cls: string): void {
		this.classes.delete(cls);
	}

	hasClass(cls: string): boolean {
		return this.classes.has(cls);
	}

	find(selector: string): TestElement | null {
		return this.findAll(selector)[0] ?? null;
	}

	findAll(selector: string): TestElement[] {
		const result: TestElement[] = [];
		for (const child of this.children) {
			child.collect(selector, result);
		}
		return result;
	}

	private collect(selector: string, result: TestElement[]): void {
		if (this.matches(selector)) {
			result.push(this);
		}
		for (const child of this.children) {
			child.collect(selector, result);
		}
	}

	private matches(selector: string): boolean {
		if (selector.startsWith(".")) {
			return this.classes.has(selector.slice(1));
		}
		return this.tagName === selector;
	}
}

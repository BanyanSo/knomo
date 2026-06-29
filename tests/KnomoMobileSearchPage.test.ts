import test from "node:test";
import assert from "node:assert/strict";
import { ensureObsidianStub } from "./helpers/obsidianStub";

test("renders mobile search page input, close action, quick chips, and results", async () => {
	await ensureObsidianStub();
	const { renderKnomoMobileSearchPage } = await import("../src/ui/KnomoMobileSearchPage");
	const root = new TestElement("div");

	const elements = renderKnomoMobileSearchPage(root.asHtml(), {
		createHiddenText: (container, id, text) => {
			container.createSpan({ cls: "sr-only", text, attr: { id } });
			return id;
		},
	});

	assert.equal(elements.pageEl.hasClass("knomo-mobile-search-page"), true);
	assert.equal(elements.pageEl.getAttr("aria-hidden"), "true");
	assert.equal(elements.pageEl.getAttr("inert"), "");
	assert.equal(elements.pageEl.find(".knomo-mobile-search-surface")?.getAttr("aria-hidden"), "true");
	assert.equal(elements.pageEl.find(".knomo-mobile-search-content")?.hasClass("knomo-mobile-search-content"), true);
	assert.equal(elements.inputEl.getAttr("type"), "search");
	assert.equal(elements.inputEl.getAttr("aria-labelledby"), "mobile-search-label");
	assert.equal(elements.closeButtonEl.getAttr("data-action"), "close-mobile-search");
	assert.equal(elements.closeButtonEl.getAttr("data-icon"), "x");
	assert.deepEqual(elements.quickListEl.findAll("[data-search-date]").map((item) => item.getAttr("data-search-date")), [
		"week",
		"month",
		"last-7",
		"last-30",
		"last-week",
		"last-month",
	]);
	assert.equal(elements.quickListEl.find("[data-search-date='last-7']")?.getText(), "7 days");
	assert.equal(elements.resultsEl.hasClass("knomo-mobile-search-results"), true);
});

interface CreateElementOptions {
	cls?: string;
	text?: string;
	attr?: Record<string, string>;
}

class TestElement {
	private readonly children: TestElement[] = [];
	private readonly classes = new Set<string>();
	private readonly attrs = new Map<string, string>();
	private text = "";

	constructor(private readonly tagName: string) {}

	asHtml(): HTMLElement {
		return this as unknown as HTMLElement;
	}

	createDiv(options: CreateElementOptions = {}): TestElement {
		return this.createEl("div", options);
	}

	createSpan(options: CreateElementOptions = {}): TestElement {
		return this.createEl("span", options);
	}

	createEl(tagName: string, options: CreateElementOptions = {}): TestElement {
		const child = new TestElement(tagName);
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
		for (const [key, value] of Object.entries(options.attr ?? {})) {
			child.setAttr(key, value);
		}
		this.children.push(child);
		return child;
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

	addClass(cls: string): void {
		this.classes.add(cls);
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
		const attrMatch = selector.match(/^\[([^=\]]+)(?:='([^']*)')?\]$/);
		if (attrMatch !== null) {
			const value = this.attrs.get(attrMatch[1]);
			return attrMatch[2] === undefined ? value !== undefined : value === attrMatch[2];
		}
		return this.tagName === selector;
	}
}

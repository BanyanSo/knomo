import test from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

test("renders feed summary, toolbar, load more buttons, and empty states", async () => {
	await ensureObsidianStub();
	const {
		renderKnomoEmptyState,
		renderKnomoListSummary,
		renderKnomoLoadMoreButton,
		renderKnomoRandomReunionToolbar,
	} = await import("../src/ui/KnomoFeed");
	const root = new TestElement("div");

	const summary = renderKnomoListSummary(root.asHtml(), "Filtered 3 memos");
	assert.equal(summary.hasClass("knomo-list-summary"), true);
	assert.equal(summary.getText(), "Filtered 3 memos");

	const toolbar = renderKnomoRandomReunionToolbar(root.asHtml(), 5);
	assert.equal(toolbar.hasClass("knomo-list-toolbar"), true);
	assert.equal(toolbar.find(".knomo-list-summary")?.getText(), "5 memos found for a random revisit");
	assert.equal(toolbar.find("[data-action='refresh-random-reunion']")?.getText(), "Shuffle");

	const sentinel = renderKnomoLoadMoreButton(root.asHtml(), {
		remainingCount: 12,
		action: "load-more",
		sentinel: true,
	});
	assert.equal(sentinel.hasClass("knomo-load-more"), true);
	assert.equal(sentinel.getAttr("data-action"), "load-more");
	assert.equal(sentinel.getAttr("data-load-more-sentinel"), "true");
	assert.equal(sentinel.getText(), "Load more (12 remaining)");

	const mobileMore = renderKnomoLoadMoreButton(root.asHtml(), {
		remainingCount: 2,
		action: "load-more-mobile-search",
		extraClass: "knomo-mobile-search-more",
	});
	assert.equal(mobileMore.hasClass("knomo-load-more"), true);
	assert.equal(mobileMore.hasClass("knomo-mobile-search-more"), true);
	assert.equal(mobileMore.getAttr("data-action"), "load-more-mobile-search");
	assert.equal(mobileMore.getAttr("data-load-more-sentinel"), null);

	const emptyState = renderKnomoEmptyState(root.asHtml(), "No memos", "Try a different filter");
	assert.equal(emptyState.find(".knomo-empty-title")?.getText(), "No memos");
	assert.equal(emptyState.find(".knomo-empty-description")?.getText(), "Try a different filter");

	const defaultEmptyState = renderKnomoEmptyState(root.asHtml());
	assert.equal(defaultEmptyState.find(".knomo-empty-title")?.getText(), "Nothing here yet");
	assert.equal(defaultEmptyState.find(".knomo-empty-description"), null);
});

async function ensureObsidianStub(): Promise<void> {
	const stubPath = resolve(__dirname, "../node_modules/obsidian/index.js");
	await mkdir(dirname(stubPath), { recursive: true });
	await writeFile(
		stubPath,
		[
			"class TFile {}",
			"class TFolder { constructor() { this.children = []; } }",
			"const Vault = { recurseChildren() {} };",
			"const normalizePath = (value) => value.replace(/\\\\/g, '/').replace(/\\/+/g, '/').replace(/^\\//, '').replace(/\\/$/, '');",
			"function setIcon(el, icon) { if (el && typeof el.setAttr === 'function') el.setAttr('data-icon', icon); return el; }",
			"function addIcon() {}",
			"let languageValue = 'en';",
			"function getLanguage() { return languageValue; }",
			"getLanguage.set = (value) => { languageValue = value; };",
			"let localeValue = 'en';",
			"const moment = (date = new Date()) => ({ format: () => date.toISOString().slice(0, 10) });",
			"moment.locale = (value) => { if (typeof value === 'string') localeValue = value; return localeValue; };",
			"module.exports = { TFile, TFolder, Vault, normalizePath, setIcon, addIcon, getLanguage, moment };",
		].join("\n"),
	);
}

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

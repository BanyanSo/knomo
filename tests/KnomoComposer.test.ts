import test from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

test("renders composer input, tools, actions, and reference preview", async () => {
	await ensureObsidianStub();
	const { renderComposerReferencePreview, renderKnomoComposer } = await import("../src/ui/KnomoComposer");
	const root = new TestElement("div");

	const elements = renderKnomoComposer(root.asHtml(), {
		dailyEnabled: false,
		draftContent: "draft memo",
		createHiddenText: (container, id, text) => {
			container.createSpan({ cls: "sr-only", text, attr: { id } });
			return id;
		},
		createIconButton: (container, icon, ariaLabel, cls, action) => {
			const button = container.createEl("button", {
				cls,
				attr: {
					type: "button",
					"aria-label": ariaLabel,
					"data-action": action,
				},
			});
			button.setAttr("data-icon", icon);
			return button as HTMLButtonElement;
		},
	});

	assert.equal(elements.inputEl.value, "draft memo");
	assert.equal(elements.inputEl.disabled, true);
	assert.equal(elements.inputEl.getAttr("aria-labelledby"), "composer-input-label");
	assert.deepEqual(elements.toolsEl.findAll("[data-action]").map((item) => item.getAttr("data-action")), [
		"insert-tag",
		"insert-image",
		"insert-list",
		"insert-numbered-list",
	]);
	assert.equal(elements.cancelEditButtonEl.getAttr("data-action"), "cancel-edit");
	assert.equal(elements.statusEl.hasClass("is-error"), true);
	assert.equal(elements.sendButtonEl.getAttr("data-action"), "save-input");
	assert.equal(elements.sendButtonEl.getAttr("data-icon"), "send");

	renderComposerReferencePreview(elements.referencePreviewEl, "> source memo", {
		setTooltipIfDesktopOnly: (element) => element.setAttr("data-tooltip-position", "top"),
	});
	assert.equal(elements.referencePreviewEl.hasClass("is-visible"), true);
	assert.equal(elements.referencePreviewEl.find(".knomo-reference-content")?.getText(), "source memo");
	assert.equal(elements.referencePreviewEl.find(".knomo-reference-clear")?.getAttr("data-icon"), "x");
	assert.equal(elements.referencePreviewEl.find(".knomo-reference-clear")?.getAttr("data-tooltip-position"), "top");

	renderComposerReferencePreview(elements.referencePreviewEl, null, {
		setTooltipIfDesktopOnly: (element) => element.setAttr("data-tooltip-position", "top"),
	});
	assert.equal(elements.referencePreviewEl.hasClass("is-visible"), false);
	assert.equal(elements.referencePreviewEl.find(".knomo-reference-content"), null);
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
			"module.exports = { TFile, TFolder, Vault, setIcon, addIcon, getLanguage, moment, normalizePath };",
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
	readonly style: { display?: string } = {};
	value = "";
	disabled = false;
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
		const attrMatch = selector.match(/^\[([^=\]]+)(?:='([^']*)')?\]$/);
		if (attrMatch !== null) {
			const value = this.attrs.get(attrMatch[1]);
			return attrMatch[2] === undefined ? value !== undefined : value === attrMatch[2];
		}
		return this.tagName === selector;
	}
}

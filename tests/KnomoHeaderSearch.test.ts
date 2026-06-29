import test from "node:test";
import assert from "node:assert/strict";
import { ensureObsidianStub } from "./helpers/obsidianStub";

test("renders desktop and compact header search structure", async () => {
	await ensureObsidianStub();
	const {
		renderKnomoCompactHeader,
		renderKnomoCompactSearchPanel,
		renderKnomoDesktopTopbar,
		renderKnomoScopePopover,
		renderSearchDateButton,
	} = await import("../src/ui/KnomoHeaderSearch");
	const root = new TestElement("div");
	const options = {
		createHiddenText: (container: HTMLElement, id: string, text: string) => {
			container.createSpan({ cls: "sr-only", text, attr: { id } });
			return id;
		},
		createIconButton: (container: HTMLElement, icon: string, ariaLabel: string, cls: string, action: string) => {
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
	};

	const desktop = renderKnomoDesktopTopbar(root.asHtml(), options);
	assert.equal(root.find("[data-action='toggle-sidebar']")?.hasClass("knomo-sidebar-toggle"), true);
	assert.equal(root.find("[data-action='record-stats-back']")?.hasClass("knomo-record-stats-back"), true);
	assert.equal(desktop.titleHostEl.hasClass("knomo-title-host"), true);
	assert.equal(desktop.searchInputEl.getAttr("type"), "search");
	assert.equal(desktop.searchInputEl.getAttr("aria-labelledby"), "desktop-search-label");
	assert.deepEqual(root.findAll("[data-search-date]").map((item) => item.getAttr("data-search-date")), [
		"week",
		"month",
		"last-7",
		"last-30",
		"last-week",
		"last-month",
	]);

	const scopeHost = new TestElement("div");
	renderKnomoScopePopover(scopeHost.asHtml(), "knomo-scope-popover knomo-mobile-scope-popover");
	assert.deepEqual(scopeHost.findAll("[data-title-mode]").map((item) => item.getAttr("data-title-mode")), [
		"all",
		"no-tag",
		"with-link",
		"with-image",
		"anniversary",
		"review",
		"random",
	]);

	const compact = renderKnomoCompactHeader(root.asHtml(), options);
	assert.equal(root.find("[data-action='open-drawer']")?.hasClass("knomo-compact-menu-btn"), true);
	assert.equal(root.find("[data-action='toggle-compact-search']")?.hasClass("knomo-compact-search-btn"), true);
	assert.equal(root.findAll("[data-action='record-stats-back']").length, 2);
	assert.equal(compact.titleHostEl.hasClass("knomo-compact-title"), true);
	assert.equal(compact.inlineSearchInputEl.getAttr("aria-labelledby"), "compact-inline-search-label");

	const panel = renderKnomoCompactSearchPanel(root.asHtml(), options);
	assert.equal(panel.searchInputEl.getAttr("aria-labelledby"), "compact-search-label");

	const customButtonHost = new TestElement("div");
	renderSearchDateButton(customButtonHost.asHtml(), {
		filter: "last-7",
		label: "Last 7 days",
		mobileLabel: "7 days",
		icon: "calendar-clock",
	}, "knomo-mobile-search-chip", "7 days");
	assert.equal(customButtonHost.find("[data-search-date='last-7']")?.getText(), "7 days");
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

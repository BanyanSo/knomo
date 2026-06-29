import test from "node:test";
import assert from "node:assert/strict";

import type { MemoRecord } from "../src/types/memo";
import { ensureObsidianStub } from "./helpers/obsidianStub";

test("post-processes memo markdown DOM metadata", async () => {
	await ensureObsidianStub();
	const { prepareRenderedMemoMarkdown, applyTaskCheckboxDomState } = await import("../src/ui/MemoMarkdownRenderer");
	setDomGlobals();
	const container = new TestElement("div");
	container.addClass("knomo-card-content");
	const link = container.createEl("a", {
		cls: "internal-link",
		attr: { href: "Project" },
	});
	const tag = container.createSpan({ cls: "tag", text: "#Project/Knomo" });
	const image = container.createEl("img");
	const taskItem = container.createEl("li");
	const checkbox = taskItem.createEl("input", { attr: { type: "checkbox" } });

	prepareRenderedMemoMarkdown(container.asHtml(), makeMemo({ contentSnapshot: "- [ ] task" }));

	assert.equal(link.getAttr("data-knomo-source-path"), "Daily/2026-06-02.md");
	assert.equal(image.getAttr("loading"), "lazy");
	assert.equal(tag.getAttr("data-tag"), "Project/Knomo");
	assert.equal(tag.getAttr("data-tag-key"), "project/knomo");
	assert.equal(checkbox.hasClass("knomo-task-checkbox"), true);
	assert.equal(checkbox.getAttr("data-knomo-memo-id"), "memo-1");
	assert.equal(checkbox.getAttr("data-knomo-task-index"), "0");
	assert.equal(taskItem.getAttr("data-knomo-task-index"), "0");

	applyTaskCheckboxDomState(checkbox.asInput(), "-");

	assert.equal(checkbox.checked, true);
	assert.equal(checkbox.indeterminate, true);
	assert.equal(checkbox.getAttr("data-task"), "-");
	assert.equal(taskItem.getAttr("data-task"), "-");
});

test("recognizes delegated task checkbox inputs", async () => {
	await ensureObsidianStub();
	const { MemoMarkdownRenderer } = await import("../src/ui/MemoMarkdownRenderer");
	setDomGlobals();
	const renderer = new MemoMarkdownRenderer({
		app: {} as never,
		component: {} as never,
		getDocument: () => ({ createElement: (tagName: string) => new TestElement(tagName).asHtml() }) as Document,
		getGeneration: () => 0,
		concurrency: 1,
	});
	const content = new TestElement("div");
	content.addClass("knomo-card-content");
	const input = content.createEl("input", {
		attr: {
			type: "checkbox",
			"data-knomo-task-index": "2",
		},
	});
	const outside = new TestElement("input", {
		attr: {
			type: "checkbox",
			"data-knomo-task-index": "2",
		},
	});

	assert.equal(renderer.getTaskCheckboxInput(input.asHtml()), input.asInput());
	assert.equal(renderer.getTaskCheckboxIndex(input.asInput()), 2);
	assert.equal(renderer.getTaskCheckboxInput(outside.asHtml()), null);
});

function setDomGlobals(): void {
	(globalThis as unknown as { HTMLElement: typeof TestElement }).HTMLElement = TestElement;
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
	checked = false;
	indeterminate = false;
	type = "";

	constructor(
		readonly tagName: string,
		options: CreateElementOptions = {},
		private readonly parent: TestElement | null = null,
	) {
		if (options.cls !== undefined) {
			for (const cls of options.cls.split(/\s+/)) {
				if (cls.length > 0) {
					this.addClass(cls);
				}
			}
		}
		if (options.text !== undefined) {
			this.setText(options.text);
		}
		for (const [key, value] of Object.entries(options.attr ?? {})) {
			this.setAttr(key, value);
		}
	}

	asHtml(): HTMLElement {
		return this as unknown as HTMLElement;
	}

	asInput(): HTMLInputElement {
		return this as unknown as HTMLInputElement;
	}

	createSpan(options: CreateElementOptions = {}): TestElement {
		return this.createEl("span", options);
	}

	createEl(tagName: string, options: CreateElementOptions = {}): TestElement {
		const child = new TestElement(tagName.toUpperCase(), options, this);
		this.children.push(child);
		return child;
	}

	querySelectorAll<T extends Element = Element>(selector: string): T[] {
		return this.findAll(selector) as unknown as T[];
	}

	findAll(selector: string): TestElement[] {
		const result: TestElement[] = [];
		for (const child of this.children) {
			child.collect(selector, result);
		}
		return result;
	}

	closest(selector: string): TestElement | null {
		let current: TestElement | null = this;
		while (current !== null) {
			if (current.matches(selector)) {
				return current;
			}
			current = current.parent;
		}
		return null;
	}

	instanceOf<T>(constructor: abstract new (...args: never[]) => T): this is T {
		return this instanceof constructor;
	}

	setText(value: string): void {
		this.text = value;
	}

	getText(): string {
		return this.text + this.children.map((child) => child.getText()).join("");
	}

	setAttr(key: string, value: string): void {
		this.attrs.set(key, value);
		if (key === "type") {
			this.type = value;
		}
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
		const tagClassMatch = selector.match(/^([a-z]+)\.([a-z0-9-]+)$/i);
		if (tagClassMatch !== null) {
			return this.tagName === tagClassMatch[1].toUpperCase() && this.classes.has(tagClassMatch[2]);
		}
		const tagAttrMatch = selector.match(/^([a-z]+)\[([^=\]]+)='([^']*)'\]$/i);
		if (tagAttrMatch !== null) {
			return this.tagName === tagAttrMatch[1].toUpperCase() && this.attrs.get(tagAttrMatch[2]) === tagAttrMatch[3];
		}
		return this.tagName === selector.toUpperCase();
	}
}

function makeMemo(overrides: Partial<MemoRecord> = {}): MemoRecord {
	return {
		id: "memo-1",
		createdAt: "2026-06-02T00:00:00+08:00",
		updatedAt: "2026-06-02T00:00:00+08:00",
		contentSnapshot: "memo",
		contentHash: "hash",
		status: "active",
		syncStatus: "synced",
		source: "plugin_input",
		version: 1,
		tags: [],
		links: [],
		images: [],
		references: [],
		sourceMemoId: null,
		issue: null,
		lastMarkdownSyncAt: null,
		lastMarkdownSyncSource: null,
		dailyRef: {
			path: "Daily/2026-06-02.md",
			heading: "Memos",
			sectionType: "heading",
			lastKnownBlock: "- [ ] task",
			lastKnownHash: "hash",
			lineNumberHint: 1,
			lastSyncedAt: null,
		},
		monthlyRef: {
			path: "Memos/Memos-2026-06.md",
			dateHeading: "2026-06-02",
			lastKnownBlock: "- [ ] task",
			lastKnownHash: "hash",
			lineNumberHint: 1,
			lastSyncedAt: null,
		},
		...overrides,
	};
}

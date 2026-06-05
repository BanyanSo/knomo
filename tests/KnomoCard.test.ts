import test from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

import type { MemoRecord } from "../src/types/memo";

test("adds is-cjk-content to long Chinese memo cards", async () => {
	const { card, queued, content } = await renderMemoCard("## 标题\n这是一段**中文 Memo**，包含[[页面|内部链接]]和 #标签，用来验证卡片级判断。");

	assert.equal(card.hasClass("is-cjk-content"), true);
	assert.equal(queued?.container, content?.asHtml());
});

test("adds is-cjk-content when Chinese text includes a few English technical words", async () => {
	const { card } = await renderMemoCard("今天排查 MarkdownRenderer render queue 的表现，确认中文正文仍然应该两端对齐。");

	assert.equal(card.hasClass("is-cjk-content"), true);
});

test("does not add is-cjk-content to English memo cards", async () => {
	const { card } = await renderMemoCard("This memo is mostly English with MarkdownRenderer, CSS, and several technical notes.");

	assert.equal(card.hasClass("is-cjk-content"), false);
});

test("does not add is-cjk-content to short Chinese memo cards below the threshold", async () => {
	const { card } = await renderMemoCard("中文太短");

	assert.equal(card.hasClass("is-cjk-content"), false);
});

test("card content CSS justifies CJK cards while list items inherit the card alignment", async () => {
	const css = await readFile(resolve(process.cwd(), "styles.css"), "utf8");

	assert.match(getStyleRule(css, ".knomo-plugin .knomo-card-content"), /text-align:\s*start;/);
	assert.match(getStyleRule(css, ".knomo-plugin .knomo-card.is-cjk-content .knomo-card-content"), /text-align:\s*justify;/);
	assert.match(getStyleRule(css, ".knomo-plugin .knomo-card.is-cjk-content .knomo-card-content"), /text-align-last:\s*start;/);
	assert.equal(css.includes("text-justify"), false);
	assert.doesNotMatch(getCjkSelectors(css), /\bli\b/);
});

test("CJK card CSS keeps headings, code, and tables start-aligned", async () => {
	const css = await readFile(resolve(process.cwd(), "styles.css"), "utf8");
	const selectors = getCjkSelectors(css);
	const resetRule = getStyleRule(css, ".knomo-plugin .knomo-card.is-cjk-content .knomo-card-content table");

	for (const tagName of ["h1", "h2", "h3", "h4", "h5", "h6", "pre", "code", "table"]) {
		assert.match(selectors, new RegExp(`\\.knomo-card-content ${tagName}\\b`));
	}
	assert.match(resetRule, /text-align:\s*start;/);
});

test("memo markdown post-processing still keeps internal links, tags, and lazy images", async () => {
	const source = await readFile(resolve(process.cwd(), "src/ui/KnomoView.ts"), "utf8");

	assert.match(source, /this\.prepareInternalLinks\(container, memo\.dailyRef\.path\);/);
	assert.match(source, /event\.preventDefault\(\);\s*await this\.app\.workspace\.openLinkText\(linktext, sourcePath, Keymap\.isModEvent\(event\)\);/);
	assert.match(source, /imageEl\.setAttr\("loading", "lazy"\);/);
	assert.match(source, /tagEl\.setAttr\("data-tag", tag\);/);
	assert.match(source, /tagEl\.setAttr\("data-tag-key", tagKey\);/);
});

async function renderMemoCard(contentSnapshot: string): Promise<{
	card: TestElement;
	content: TestElement | null;
	queued: { container: HTMLElement; memo: MemoRecord } | null;
}> {
	await ensureObsidianStub();
	const { renderKnomoMemoCard } = await import("../src/ui/KnomoCard");
	const root = new TestElement("div");
	const memo = makeMemo({ contentSnapshot });
	let queued: { container: HTMLElement; memo: MemoRecord } | null = null;

	renderKnomoMemoCard(root.asHtml(), memo, {
		generation: 7,
		renderIndex: 0,
		includeActions: false,
		randomCard: false,
		activeMenuMemoId: null,
		deletedMemoIds: new Set(),
		getA11yId: (id) => `a11y-${id}`,
		formatDisplayTime: (value) => value,
		formatSettingsText: (value) => value,
		getMarkdownPriority: () => "normal" as const,
		queueMemoMarkdown: (queuedMemo, container) => {
			queued = { container, memo: queuedMemo };
		},
		queueSourceReferenceMarkdown: () => {
			throw new Error("Unexpected source reference render");
		},
	});

	const card = root.find("article");
	if (card === null) {
		throw new Error("Expected memo card to render");
	}
	return {
		card,
		content: root.find(".knomo-card-content"),
		queued,
	};
}

function getStyleRule(css: string, selector: string): string {
	const pattern = new RegExp(`${escapeRegExp(selector)}\\s*\\{([^}]*)\\}`, "s");
	const match = css.match(pattern);
	if (match === null) {
		throw new Error(`Expected CSS rule for ${selector}`);
	}
	return match[1];
}

function getCjkSelectors(css: string): string {
	const selectors: string[] = [];
	const pattern = /([^{}]+)\{[^{}]*\}/g;
	let match: RegExpExecArray | null = pattern.exec(css);
	while (match !== null) {
		if (match[1].includes(".is-cjk-content")) {
			selectors.push(match[1].trim());
		}
		match = pattern.exec(css);
	}
	return selectors.join("\n");
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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
			heading: null,
			lastKnownBlock: "",
			lastKnownHash: "",
			lineNumberHint: null,
			lastSyncedAt: null,
		},
		monthlyRef: {
			path: "Knomo/2026-06.md",
			dateHeading: "2026-06-02",
			lastKnownBlock: "",
			lastKnownHash: "",
			lineNumberHint: null,
			lastSyncedAt: null,
		},
		...overrides,
	};
}

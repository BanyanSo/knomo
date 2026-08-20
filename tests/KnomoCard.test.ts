import test from "node:test";
import assert from "node:assert/strict";

import type { MemoRecord } from "./helpers/memoViewFixture";
import type { MemoCardPreview } from "../src/ui/MemoCardPreview";
import { ensureObsidianStub } from "./helpers/obsidianStub";

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

test("memo card body queues preview text instead of the raw content snapshot", async () => {
	const { queued } = await renderMemoCard("raw ![[image.png]]", {
		text: "raw",
		images: [
			{
				raw: "![[image.png]]",
				path: "image.png",
				isRemote: false,
				unresolved: true,
			},
		],
	});

	assert.equal(queued?.previewText, "raw");
});

test("image-only memo cards do not render an empty card content container", async () => {
	const { body, content, images } = await renderMemoCard("![[image.png]]", {
		text: "",
		images: [
			{
				raw: "![[image.png]]",
				path: "image.png",
				isRemote: false,
				unresolved: true,
			},
		],
	});

	assert.notEqual(body, null);
	assert.equal(content, null);
	assert.notEqual(images, null);
});

test("memo card action menu includes open daily in the requested order", async () => {
	await ensureObsidianStub();
	const { renderKnomoMemoCard } = await import("../src/ui/KnomoCard");
	const root = new TestElement("div");

	renderKnomoMemoCard(root.asHtml(), makeMemo(), {
		generation: 7,
		renderIndex: 0,
		includeActions: true,
		randomCard: false,
		activeMenuMemoId: null,
		deletedMemoIds: new Set(),
		formatDisplayTime: (value) => value,
		getMarkdownPriority: () => "normal" as const,
		getMemoCardPreview: (memo) => ({ text: memo.contentSnapshot, images: [] }),
		queueMemoMarkdown: () => undefined,
		renderMemoCardImages: () => undefined,
		queueSourceReferenceMarkdown: () => undefined,
	});

	const actions = root.findAll("[data-memo-action]");
	assert.deepEqual(actions.map((action) => action.getAttr("data-memo-action")), [
		"edit",
		"reference",
		"open-daily",
		"copy-text",
		"copy-link",
		"delete",
	]);
	assert.equal(root.find("[data-memo-action='open-daily']")?.getText(), "Open daily note");
	assert.equal(root.find(".knomo-card-word-count")?.getText(), "Words: 1");
	assert.equal(root.find(".knomo-card-actions")?.getText().endsWith("DeleteWords: 1"), true);
	const card = root.find("article");
	assert.equal(card?.getAttr("data-memo-card-open"), null);
	assert.equal(card?.getAttr("tabindex"), null);
	const timeButton = root.find("[data-memo-time-open='daily']");
	assert.equal(timeButton?.getText(), "2026-06-02T00:00:00+08:00");
	assert.equal(timeButton?.getAttr("aria-label"), "Open daily note");
	assert.equal(timeButton?.getAttr("data-memo-id"), "memo-1");
	assert.equal(timeButton?.getAttr("data-random-reunion-card"), null);
});

test("random memo card keeps random review marking on the time opener", async () => {
	await ensureObsidianStub();
	const { renderKnomoMemoCard } = await import("../src/ui/KnomoCard");
	const root = new TestElement("div");

	renderKnomoMemoCard(root.asHtml(), makeMemo({ id: "random-1" }), {
		generation: 7,
		renderIndex: 0,
		includeActions: false,
		randomCard: true,
		activeMenuMemoId: null,
		deletedMemoIds: new Set(),
		formatDisplayTime: (value) => value,
		getMarkdownPriority: () => "normal" as const,
		getMemoCardPreview: (memo) => ({ text: memo.contentSnapshot, images: [] }),
		queueMemoMarkdown: () => undefined,
		renderMemoCardImages: () => undefined,
		queueSourceReferenceMarkdown: () => undefined,
	});

	const card = root.find("article");
	const timeButton = root.find("[data-memo-time-open='daily']");
	assert.equal(card?.getAttr("data-random-reunion-card"), null);
	assert.equal(timeButton?.getAttr("data-memo-id"), "random-1");
	assert.equal(timeButton?.getAttr("data-random-reunion-card"), "true");
});

test("renders Time buoy card states with the project icon and a today wave", async () => {
	await ensureObsidianStub();
	const { renderKnomoMemoCard } = await import("../src/ui/KnomoCard");
	const { KNOMO_TIME_BUOY_ICON } = await import("../src/icons");
	const renderState = (status: "today" | "upcoming" | "past"): TestElement => {
		const root = new TestElement("div");
		renderKnomoMemoCard(root.asHtml(), makeMemo(), {
			generation: 7,
			renderIndex: 0,
			includeActions: false,
			randomCard: false,
			timeBuoy: { status, label: `Time buoy ${status}` },
			activeMenuMemoId: null,
			deletedMemoIds: new Set(),
			formatDisplayTime: (value) => value,
			getMarkdownPriority: () => "normal" as const,
			getMemoCardPreview: (memo) => ({ text: memo.contentSnapshot, images: [] }),
			queueMemoMarkdown: () => undefined,
			renderMemoCardImages: () => undefined,
			queueSourceReferenceMarkdown: () => undefined,
		});
		return root;
	};

	const today = renderState("today");
	const upcoming = renderState("upcoming");
	const past = renderState("past");
	const indicator = today.find("[data-time-buoy-card='true']");
	assert.equal(indicator?.getAttr("data-icon"), KNOMO_TIME_BUOY_ICON);
	assert.equal(indicator?.getAttr("role"), "img");
	assert.equal(indicator?.getAttr("aria-label"), "Time buoy today");
	assert.equal(today.find("article")?.hasClass("is-time-buoy-today"), true);
	assert.notEqual(today.find(".knomo-card-time-buoy-wave"), null);
	assert.equal(upcoming.find("article")?.hasClass("is-time-buoy-upcoming"), true);
	assert.equal(upcoming.find(".knomo-card-time-buoy-wave"), null);
	assert.equal(past.find("article")?.hasClass("is-time-buoy-past"), true);
	assert.equal(past.find(".knomo-card-time-buoy-wave"), null);
});

test("trash memo cards do not get daily note card-open attributes", async () => {
	await ensureObsidianStub();
	const { renderKnomoTrashMemoCard } = await import("../src/ui/KnomoCard");
	const root = new TestElement("div");

	renderKnomoTrashMemoCard(root.asHtml(), makeMemo({ status: "deleted" }), {
		generation: 7,
		renderIndex: 0,
		busyAction: null,
		formatDisplayTime: (value) => value,
		formatOptionalTime: (value) => value ?? "",
		formatDeleteSource: (value) => value,
		getMarkdownPriority: () => "normal" as const,
		getMemoCardPreview: (memo) => ({ text: memo.contentSnapshot, images: [] }),
		queueMemoMarkdown: () => undefined,
		renderMemoCardImages: () => undefined,
	});

	const card = root.find("article");
	assert.equal(card?.getAttr("data-memo-card-open"), null);
	assert.equal(card?.getAttr("data-random-reunion-card"), null);
	assert.equal(card?.getAttr("tabindex"), null);
	assert.equal(root.find("[data-memo-time-open='daily']"), null);
});

async function renderMemoCard(
	contentSnapshot: string,
	preview?: MemoCardPreview,
): Promise<{
	card: TestElement;
	body: TestElement | null;
	content: TestElement | null;
	images: TestElement | null;
	queued: { container: HTMLElement; memo: MemoRecord; previewText: string } | null;
}> {
	await ensureObsidianStub();
	const { renderKnomoMemoCard } = await import("../src/ui/KnomoCard");
	const root = new TestElement("div");
	const memo = makeMemo({ contentSnapshot });
	let queued: { container: HTMLElement; memo: MemoRecord; previewText: string } | null = null;

	renderKnomoMemoCard(root.asHtml(), memo, {
		generation: 7,
		renderIndex: 0,
		includeActions: false,
		randomCard: false,
		activeMenuMemoId: null,
		deletedMemoIds: new Set(),
		formatDisplayTime: (value) => value,
		getMarkdownPriority: () => "normal" as const,
		getMemoCardPreview: (queuedMemo) => preview ?? { text: queuedMemo.contentSnapshot, images: [] },
		queueMemoMarkdown: (queuedMemo, container, _generation, _priority, previewText) => {
			queued = { container, memo: queuedMemo, previewText };
		},
		renderMemoCardImages: (container, _memo, images) => {
			if (images.length > 0) {
				container.createDiv({ cls: "knomo-card-images" });
			}
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
		body: root.find(".knomo-card-body"),
		content: root.find(".knomo-card-content"),
		images: root.find(".knomo-card-images"),
		queued,
	};
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

	createSpan(options: CreateElementOptions = {}): TestElement {
		return this.createEl("span", options);
	}

	createSvg(tagName: string, options: CreateElementOptions = {}): TestElement {
		return this.createEl(tagName, options);
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

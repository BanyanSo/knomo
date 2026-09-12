import test from "node:test";
import assert from "node:assert/strict";

import { createCatalogCapabilities, createResolvedMemoCapabilities } from "../src/services/MemoCapabilityModel";
import type { MemoViewItem } from "../src/types/memoView";
import type { MemoCardPreview } from "../src/ui/MemoCardPreview";
import { ensureObsidianStub } from "./helpers/obsidianStub";
import { createRecentTimeFlowContext, getRecentMemoPresentation } from "../src/ui/RecentTimeFlowPresentation";
import { KnomoCardFlowBatcher, runCardFlowBatch } from "../src/ui/KnomoCardFlow";

test("真实卡片时间按钮保留 Daily 操作，近三天只显示墙上分钟与装饰图标", async () => {
	await ensureObsidianStub();
	const { renderKnomoMemoCard } = await import("../src/ui/KnomoCard");
	for (let hour = 0; hour < 24; hour++) {
		const root = new TestElement("div");
		const time = `${String(hour).padStart(2, "0")}:34:56`;
		const memo = makeMemo({ catalog: { observation: { logicalDate: "2026-09-10", time } } as NonNullable<MemoViewItem["catalog"]> });
		const context = createRecentTimeFlowContext(new Date(2026, 8, 10), true, new Set());
		renderKnomoMemoCard(root.asHtml(), memo, {
			generation: 1, renderIndex: 0, includeActions: false, randomCard: false, activeMenuMemoId: null,
			timePresentation: getRecentMemoPresentation(memo, context).time,
			formatDisplayTime: (value) => value, getMarkdownPriority: () => "normal",
			getMemoCardPreview: () => ({ text: "memo", images: [] }), queueMemoMarkdown: () => {},
			renderMemoCardImages: () => {}, queueSourceReferenceMarkdown: () => {},
		});
		const button = root.find("[data-memo-time-open='daily']");
		assert.equal(button?.getText(), time.slice(0, 5));
		assert.equal(button?.getAttr("data-memo-id"), memo.id);
		assert.equal(root.find(".knomo-recent-time-icon")?.getAttr("data-icon"), `knomo-clock-${hour % 12}`);
		assert.equal(root.find(".knomo-recent-time-icon")?.getAttr("aria-hidden"), "true");
	}
});

test("View 真实追加序列跨批次只在卡片到达时输出 Header 与历史分界", async () => {
	await ensureObsidianStub();
	const { KnomoView } = await import("../src/ui/KnomoView");
	const root = new TestElement("div");
	const context = createRecentTimeFlowContext(new Date(2026, 8, 10), true, new Set());
	const { RecentTimeFlowDecorations } = await import("../src/ui/RecentTimeFlowPresentation");
	const view = Object.create(KnomoView.prototype) as {
		cardFlowEl: HTMLElement; recentDecorations: InstanceType<typeof RecentTimeFlowDecorations>;
		renderedCardMemos: Map<string, MemoViewItem>;
		renderMemoCard: (memo: MemoViewItem, generation: number, index: number) => void;
		renderMemoCardInContainer: (container: HTMLElement, memo: MemoViewItem) => void;
	};
	Object.assign(view, { viewStateController: { activeNav: "all" } });
	view.cardFlowEl = root.asHtml();
	view.recentDecorations = new RecentTimeFlowDecorations(context);
	view.renderedCardMemos = new Map();
	view.renderMemoCardInContainer = (container, memo) => { container.createEl("article", { text: memo.id }); };
	const memos = ["2026-09-10", "2026-09-10", "2026-09-09", "2026-09-07"].map((logicalDate, i) => makeMemo({ id: `memo-${i}`, catalog: { observation: { logicalDate, time: "12:34" } } as NonNullable<MemoViewItem["catalog"]> }));
	const batcher = new KnomoCardFlowBatcher();
	const render = (batch: ReturnType<typeof batcher.start>) => runCardFlowBatch({
		batch, generation: 1, hasRenderTarget: true, isCurrentGeneration: () => true,
		removeSentinel: () => {}, cancelBatch: () => {}, completeBatch: (value) => batcher.completeBatch(value),
		renderItem: (item) => view.renderMemoCard(item.memo, 1, item.renderIndex),
	});
	render(batcher.start(memos, "memo", 1));
	assert.equal(root.findAll(".knomo-recent-flow-date").length, 1);
	assert.equal(root.findAll(".knomo-recent-flow-history").length, 0);
	render(batcher.beginNextBatch(2));
	assert.equal(root.findAll(".knomo-recent-flow-date").length, 2);
	assert.equal(root.findAll(".knomo-recent-flow-history").length, 0);
	render(batcher.beginNextBatch(1));
	assert.equal(root.findAll(".knomo-recent-flow-history").length, 1);
	assert.equal(root.getText(), "Today Thu, Sep 10memo-0memo-1Yesterday Wed, Sep 9memo-2More Ripples in Timememo-3");
	assert.equal(root.find(".knomo-recent-flow-relative")?.getText(), "Today");
	assert.equal(root.find(".knomo-recent-flow-calendar")?.getText(), " Thu, Sep 10");
});

test("adds is-cjk-content to long Chinese memo cards", async () => {
	const { card, queued, content } = await renderMemoCard("## 标题\n这是一段**中文 Memo**，包含[[页面|内部链接]]和 #标签，用来验证卡片级判断。");

	assert.equal(card.hasClass("is-cjk-content"), true);
	assert.equal(queued?.container, content?.asHtml());
});

test("View 完整同步删除与置顶组内最后卡片后移除空装饰，窗口替换重新分组", async () => {
	await ensureObsidianStub();
	const { KnomoView } = await import("../src/ui/KnomoView");
	const previousHTMLElement = globalThis.HTMLElement;
	globalThis.HTMLElement = TestElement as unknown as typeof HTMLElement;
	try {
		const root = new TestElement("div");
		const context = createRecentTimeFlowContext(new Date(2026, 8, 10), true, new Set());
		const { RecentTimeFlowDecorations } = await import("../src/ui/RecentTimeFlowPresentation");
		const view = Object.create(KnomoView.prototype);
		const render = (container: HTMLElement, memo: MemoViewItem) => {
			const card = container.createEl("article", { cls: "knomo-card", text: memo.id });
			card.setAttr("data-memo-render-key", memo.id);
			card.setAttr("data-time-presentation", JSON.stringify(getRecentMemoPresentation(memo, context).time));
			return card;
		};
		Object.assign(view, { cardFlowEl: root.asHtml(), containerEl: { win: {} }, renderedCardMemos: new Map(),
			cardFlowCoordinator: { generation: 1, clearMobileBatchContinuation: () => {}, removeSentinel: () => {}, getPendingVisibleCount: () => null, syncBatch: () => {} },
			prepareRecentTimeFlow: () => { view.recentTimeFlowContext = context; view.recentDecorations = new RecentTimeFlowDecorations(context); },
			getInitialCardBatchSize: () => 10, renderCardForMode: render,
			replaceMemoCard: (old: TestElement, _previous: MemoViewItem, memo: MemoViewItem) => { old.remove(); return render(root.asHtml(), memo); },
			removeCardImageTargets: () => {}, renderTimeBuoyIntro: () => null, renderCardFlowSentinelIfNeeded: () => {},
			renderHistoryLoadMore: () => {}, syncCardMenuState: () => {}, restorePendingCardFlowScrollTop: () => {},
		});
		const recent = makeMemo({ id: "today", catalog: { observation: { logicalDate: "2026-09-10", time: "12:34" } } as NonNullable<MemoViewItem["catalog"]> });
		const old = makeMemo({ id: "old", catalog: { observation: { logicalDate: "2026-09-01", time: "12:34" } } as NonNullable<MemoViewItem["catalog"]> });
		const sync = (memos: MemoViewItem[]) => view.syncCardFlowPresentation({ type: "items", mode: "memo", headers: [], memos }, null);
		sync([recent]);
		const existingRecentCard = root.find("article");
		sync([recent, old]);
		assert.equal(root.find("article"), existingRecentCard);
		assert.equal(root.findAll(".knomo-recent-flow-history").length, 1);
		sync([recent]);
		assert.equal(root.findAll(".knomo-recent-flow-history").length, 0);
		sync([old]);
		assert.equal(root.findAll(".knomo-recent-flow-date").length, 0);
		sync([recent, old]);
		(context.pinnedKeys as Set<string>).add("old");
		sync([old, recent]);
		assert.equal(root.findAll(".knomo-recent-flow-history").length, 0);
		context.enabled = false;
		sync([old, recent]);
		assert.equal(root.findAll(".knomo-recent-flow-decoration").length, 0);
	} finally { globalThis.HTMLElement = previousHTMLElement; }
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

test("普通卡片时间使用 observation 分钟精度，不读取旧创建时间或 instant formatter", async () => {
	await ensureObsidianStub();
	const { renderKnomoMemoCard } = await import("../src/ui/KnomoCard");
	const { formatMemoDisplayTime } = await import("../src/ui/MemoDisplayFormatters");
	const root = new TestElement("div");

	renderKnomoMemoCard(root.asHtml(), makeMemo({
		createdAt: "2026-06-02T12:34:56.789+08:00",
		catalog: { observation: { logicalDate: "2026-06-03", time: "12:34" } } as never,
	}), {
		generation: 7,
		renderIndex: 0,
		includeActions: false,
		randomCard: false,
		activeMenuMemoId: null,
		formatDisplayTime: formatMemoDisplayTime,
		getMarkdownPriority: () => "normal" as const,
		getMemoCardPreview: (memo) => ({ text: memo.contentSnapshot, images: [] }),
		queueMemoMarkdown: () => undefined,
		renderMemoCardImages: () => undefined,
		queueSourceReferenceMarkdown: () => undefined,
	});

	assert.equal(root.find("[data-memo-time-open='daily']")?.getText(), "2026-06-03 12:34");
});

test("memo card menu keeps Markdown actions available with Catalog capabilities", async () => {
	await ensureObsidianStub();
	const { renderKnomoMemoCard } = await import("../src/ui/KnomoCard");
	const root = new TestElement("div");
	const capabilities = makeCapabilities();

	renderKnomoMemoCard(root.asHtml(), makeMemo({
		catalog: { capabilities, observation: { logicalDate: "2026-06-02", time: "12:34" } } as never,
	}), {
		generation: 7,
		renderIndex: 0,
		includeActions: true,
		randomCard: false,
		activeMenuMemoId: "memo-1",
		formatDisplayTime: (value) => value,
		getMarkdownPriority: () => "normal" as const,
		getMemoCardPreview: (memo) => ({ text: memo.contentSnapshot, images: [] }),
		queueMemoMarkdown: () => undefined,
		renderMemoCardImages: () => undefined,
		queueSourceReferenceMarkdown: () => undefined,
	});

	const menu = root.find(".knomo-card-menu");
	assert.equal(menu?.getAttr("aria-label"), "More actions");
	assert.equal(menu?.getAttr("aria-disabled"), null);
	assert.equal(menu?.getAttr("title"), null);
	assert.equal(menu?.getAttr("data-action"), "toggle-card-menu");
	assert.notEqual(root.find(".knomo-card-actions"), null);
	assert.equal(root.find("article")?.hasClass("is-menu-open"), true);
});

test("random memo card marks the time opener without rendering a manual review action", async () => {
	await ensureObsidianStub();
	const { renderKnomoMemoCard } = await import("../src/ui/KnomoCard");
	const root = new TestElement("div");

	renderKnomoMemoCard(root.asHtml(), makeMemo({ id: "random-1" }), {
		generation: 7,
		renderIndex: 0,
		includeActions: true,
		randomCard: true,
		activeMenuMemoId: null,
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
	assert.equal(root.find("[data-memo-action='mark-reviewed']"), null);
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

test("trash memo cards expose restore and single-item permanent purge actions", async () => {
	await ensureObsidianStub();
	const { renderKnomoTrashMemoCard } = await import("../src/ui/KnomoCard");
	const { formatMemoDisplayTime, formatOptionalMemoTime } = await import("../src/ui/MemoDisplayFormatters");
	const root = new TestElement("div");

	renderKnomoTrashMemoCard(root.asHtml(), makeMemo({
		status: "deleted",
		createdAt: "2026-06-02T12:34:56.789+08:00",
		deletedAt: "2026-06-03T00:00:00.123",
		trashItem: {
			rawBlock: "- 12:34:56 memo",
			key: "memo-1:delete-1",
			snapshotId: "memo-1",
			createdAt: "2026-06-02T12:34:56.789+08:00",
			deletedAt: "2026-06-03T00:00:00+08:00",
			logicalDate: "2026-06-02",
			sourcePath: "Daily/2026-06-02.md",
			section: "Memos",
			content: "memo-1",
			contentHash: "hash-memo-1",
			purgeAllowed: true,
		},
	}), {
		generation: 7,
		renderIndex: 0,
		busyAction: null,
		formatDisplayTime: formatMemoDisplayTime,
		formatOptionalTime: formatOptionalMemoTime,
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
	assert.equal(root.find("[data-trash-action='restore']")?.getText(), "Restore");
	assert.equal(root.find("[data-trash-action='purge']")?.getText(), "Permanently delete");
	assert.equal(root.find(".knomo-card-time")?.getText(), "Created: 2026-06-02 12:34:56");
	assert.equal(root.find(".knomo-card-meta")?.getText(), "Deleted: 2026-06-03 00:00:00");
});

async function renderMemoCard(
	contentSnapshot: string,
	preview?: MemoCardPreview,
): Promise<{
	card: TestElement;
	body: TestElement | null;
	content: TestElement | null;
	images: TestElement | null;
	queued: { container: HTMLElement; memo: MemoViewItem; previewText: string } | null;
}> {
	await ensureObsidianStub();
	const { renderKnomoMemoCard } = await import("../src/ui/KnomoCard");
	const root = new TestElement("div");
	const memo = makeMemo({ contentSnapshot });
	let queued: { container: HTMLElement; memo: MemoViewItem; previewText: string } | null = null;

	renderKnomoMemoCard(root.asHtml(), memo, {
		generation: 7,
		renderIndex: 0,
		includeActions: false,
		randomCard: false,
		activeMenuMemoId: null,
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
	private parent: TestElement | null = null;
	get firstElementChild(): TestElement | null { return this.children[0] ?? null; }
	get nextElementSibling(): TestElement | null {
		return this.parent?.children[this.parent.children.indexOf(this) + 1] ?? null;
	}
	instanceOf(): boolean { return true; }
	remove(): void {
		if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);
		this.parent = null;
	}
	insertBefore(child: TestElement, before: TestElement | null): void {
		child.remove();
		const index = before ? this.children.indexOf(before) : this.children.length;
		this.children.splice(index, 0, child);
		child.parent = this;
	}
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
		child.parent = this;
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

function makeMemo(overrides: Partial<MemoViewItem> = {}): MemoViewItem {
	return {
		id: "memo-1",
		createdAt: "2026-06-02T00:00:00+08:00",
		updatedAt: "2026-06-02T00:00:00+08:00",
		contentSnapshot: "memo",
		contentHash: "hash",
		status: "active",
		tags: [],
		links: [],
		images: [],
		dailyRef: {
			path: "Daily/2026-06-02.md",
			heading: null,
			lineNumberHint: null,
		},
		...overrides,
	};
}

function makeCapabilities() {
	return {
		...createResolvedMemoCapabilities(),
		catalog: createCatalogCapabilities({
			kind: "complete",
			coveredFromDate: "2026-06-02",
			pendingFileCount: 0,
			coveredFileCount: 1,
			totalFileCount: 1,
		}),
	};
}

import test from "node:test";
import assert from "node:assert/strict";
import { ensureObsidianStub } from "./helpers/obsidianStub";
import { createMobilePopupFixture } from "./helpers/mobilePopupFixture";
import type { CardFlowHeader } from "../src/ui/KnomoCardFlowPresenter";

test("前置提示重复、变化及移除时，历史操作头部保持连接、焦点和正确顺序", async () => {
	const fixture = await createMobilePopupFixture();
	const { syncKnomoCardFlowHeaders } = await import("../src/ui/KnomoFeed");
	try {
		for (const header of [
			{ type: "random-toolbar", count: 1 },
			{ type: "random-day", selectedDate: "2026-10-22", stats: null },
		] satisfies CardFlowHeader[]) {
			const root = fixture.root.createDiv();
			const render = (messages: string[]) => syncKnomoCardFlowHeaders(root, [
				...messages.map(text => ({ type: "summary" as const, text })), header,
			], "random");
			render(["Monthly failed"]);
			const actionHeader = root.lastElementChild!;
			const button = actionHeader.querySelector("button")!;
			const card = root.createEl("article", { cls: "knomo-card" });
			button.focus();
			const observer = new fixture.win.MutationObserver(() => {});
			observer.observe(root, { childList: true, subtree: true });
			for (const messages of [["Monthly failed"], ["Retry pending", "Source changed"], [], ["Monthly failed"]]) {
				const elements = render(messages);
				assert.deepEqual(Array.from(root.children), [...elements, card], "移除过期提示且不重复添加头部，卡片保持在头部之后");
				assert.equal(elements.at(-1), actionHeader);
				assert.equal(fixture.win.document.activeElement, button, "更新提示不丢失当前按钮焦点");
				const removed = observer.takeRecords().flatMap(record => Array.from(record.removedNodes));
				assert.ok(!removed.some(node => node === button || node.contains(button)), "不能移除按钮或包含按钮的父节点");
			}
			observer.disconnect();
		}
	} finally { fixture.close(); }
});

test("日期详情的日期、原时间精度与返回在加载、失败和空态中可见，且不提供换日", async () => {
	await ensureObsidianStub();
	const { renderKnomoCardFlowHeaders } = await import("../src/ui/KnomoFeed");
	const root = new TestElement("div");
	renderKnomoCardFlowHeaders(root.asHtml(), [{ type: "random-day", selectedDate: "2026-10-22", stats: null }]);
	assert.ok(root.find(".knomo-shuffle-day-date")?.getText().includes("2026"));
	assert.equal(root.find("[data-action='random-day-back']")?.getAttr("type"), "button");
	assert.equal(root.find("[data-action='random-day-back']")?.getText(), "Back");
	assert.equal(root.find("[data-action='refresh-random-reunion']"), null);
	assert.equal(root.find("[data-action='refresh-shuffle-day']"), null);
	const ready = new TestElement("div");
	renderKnomoCardFlowHeaders(ready.asHtml(), [{ type: "random-day", selectedDate: "2026-10-22", stats: {
		memoCount: 7, wordCount: 200, tagCount: 1, imageCount: 0, linkCount: 0, firstMemoTime: null, lastMemoTime: null,
	} }]);
	const toolbar = ready.find(".knomo-list-toolbar")!;
	assert.ok(toolbar.find(".knomo-shuffle-day-summary"), "摘要与返回按钮放在同一工具栏");
	assert.ok(toolbar.find("[data-action='random-day-back']"));
});

test("页面问题有状态语义，同一说明重绘不重复播报，新问题重新播报", async () => {
	await ensureObsidianStub(); const { renderKnomoCardFlowHeaders } = await import("../src/ui/KnomoFeed");
	const root = new TestElement("div");
	const render = (text: string) => renderKnomoCardFlowHeaders(root.asHtml(), [{ type: "summary", text, feedback: true }])[0]!;
	const first = render("Previous results are still shown");
	assert.equal(first.getAttr("role"), "status"); assert.equal(first.getAttr("aria-live"), "polite");
	assert.equal(render("Previous results are still shown").getAttr("aria-live"), "off");
	assert.equal(render("Source changed").getAttr("aria-live"), "polite");
	const announcement = { key: "", context: "random" };
	const remount = () => renderKnomoCardFlowHeaders(new TestElement("div").asHtml(), [{ type: "summary", text: "Source changed", feedback: true }], announcement)[0]!;
	assert.equal(remount().getAttr("aria-live"), "polite");
	assert.equal(remount().getAttr("aria-live"), "off", "整个容器重建也不重复播报");
	announcement.context = "shuffleDay";
	assert.equal(remount().getAttr("aria-live"), "polite");
});

test("renders feed summary, toolbar, load more buttons, and empty states", async () => {
	await ensureObsidianStub();
	const {
		renderKnomoCardFlowHeaders,
		renderKnomoActionableListSummary,
		renderKnomoEmptyState,
		renderKnomoListSummary,
		renderKnomoLoadMoreButton,
		renderKnomoRandomReunionToolbar,
		renderKnomoShuffleDayHeader,
	} = await import("../src/ui/KnomoFeed");
	const root = new TestElement("div");

	const summary = renderKnomoListSummary(root.asHtml(), "Filtered 3 memos");
	assert.equal(summary.hasClass("knomo-list-summary"), true);
	assert.equal(summary.getText(), "Filtered 3 memos");
	const actionable = renderKnomoActionableListSummary(root.asHtml(), "Local storage unavailable", {
		label: "Retry",
		action: "refresh-catalog-sync-state",
	});
	assert.equal(actionable.find("[data-action='refresh-catalog-sync-state']")?.getText(), "Retry");

	const toolbar = renderKnomoRandomReunionToolbar(root.asHtml(), 5);
	assert.equal(toolbar.hasClass("knomo-list-toolbar"), true);
	assert.equal(toolbar.find(".knomo-list-summary")?.getText(), "5 memos found for a random revisit");
	assert.equal(toolbar.find("[data-action='refresh-random-reunion']")?.getText(), "Shuffle");

	const headerRoot = new TestElement("div");
	const headers = renderKnomoCardFlowHeaders(headerRoot.asHtml(), [
		{ type: "summary", text: "3 memos were written on this day" },
		{ type: "random-toolbar", count: 2 },
	]);
	assert.equal(headers.length, 2);
	assert.equal(headers[0].hasClass("knomo-list-summary"), true);
	assert.equal(headers[0].getText(), "3 memos were written on this day");
	assert.equal(headers[1].hasClass("knomo-list-toolbar"), true);
	const headerSummaryTexts = headerRoot.findAll(".knomo-list-summary").map((item) => item.getText());
	assert.deepEqual(headerSummaryTexts, [
		"3 memos were written on this day",
		"2 memos found for a random revisit",
	]);

	const shuffleHeader = renderKnomoShuffleDayHeader(root.asHtml(), "2026-06-02", {
		memoCount: 2,
		wordCount: 5,
		tagCount: 1,
		imageCount: 0,
		linkCount: 1,
		firstMemoTime: "09:00",
		lastMemoTime: "10:00",
	});
	assert.equal(shuffleHeader.hasClass("knomo-shuffle-day-header"), true);
	assert.equal(shuffleHeader.find(".knomo-shuffle-day-date")?.getText(), "Jun 2, 2026 · Tuesday");
	assert.equal(shuffleHeader.find(".knomo-shuffle-day-summary")?.getText(), "2 memos · 5 words · 1 tag · 1 link");

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

test("回收站工具栏显示完整数量、单复数及危险按钮，busy 禁止再次触发", async () => {
	await ensureObsidianStub();
	const { renderKnomoCardFlowHeaders } = await import("../src/ui/KnomoFeed");
	for (const [count, busy, expected] of [[1, false, "1 memo in Trash"], [101, true, "101 memos in Trash"]] as const) {
		const root = new TestElement("div");
		renderKnomoCardFlowHeaders(root.asHtml(), [{ type: "trash-toolbar", count, busy }]);
		assert.equal(root.find(".knomo-list-summary")?.getText(), expected);
		const button = root.find("[data-action='clear-trash']")!;
		assert.equal(button.getText(), "Empty Trash"); assert.equal(button.hasClass("is-danger"), true);
		assert.equal((button.asHtml() as HTMLButtonElement).disabled, busy);
		assert.equal(button.getAttr("aria-busy"), String(busy));
	}
});

test("重逢组失效或删除为空后两种视图渲染仍保留换一组入口", async () => {
	const fixture = await createMobilePopupFixture();
	const root = fixture.root;
	const view = Object.assign(fixture.view, {
		cardFlowEl: root, containerEl: { win: fixture.win }, renderedCardMemos: new Map(),
		cardFlowCoordinator: { setPendingScrollRestore: () => {}, resetFlowRuntime: () => {} },
		getDirectCardElements: () => [], renderHistoryLoadMore: () => {}, restorePendingCardFlowScrollTop: () => {},
		clearLoadingIndicators: () => {},
	}) as typeof fixture.view & Record<string, any>;
	view.viewStateController.activeNav = "random";
	const presentation: Extract<import("../src/ui/KnomoCardFlowPresenter").CardFlowPresentation, { type: "empty" }> = {
		type: "empty", title: "No current cards", description: "Source changed", headers: [{ type: "random-toolbar", count: 0 }],
	};
	try {
		for (const incremental of [true, false]) {
			root.replaceChildren();
			if (incremental) view.renderEmptyCardFlow(presentation);
			else view.renderCardFlowPresentation(presentation, 0, 1);
			assert.equal(root.querySelector("[data-action='refresh-random-reunion']")?.textContent, "Shuffle");
			assert.equal(root.querySelector(".knomo-empty-description")?.textContent, "Source changed");
		}
	} finally { fixture.close(); }
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

	empty(): void {
		this.children.length = 0;
		this.text = "";
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
	setAttrs(attributes: Record<string, string>): void { for (const [key, value] of Object.entries(attributes)) this.setAttr(key, value); }

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

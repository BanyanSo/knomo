import test from "node:test";
import assert from "node:assert/strict";

import type { MemoRecord } from "./helpers/memoViewFixture";
import type { RecordStatsSearchFilter } from "../src/ui/viewFilters";
import { ensureObsidianStub } from "./helpers/obsidianStub";

type MobileSearchControllerConstructor = typeof import("../src/ui/MobileSearchController").MobileSearchController;
type MobileSearchControllerInstance = InstanceType<MobileSearchControllerConstructor>;
type MobileSearchControllerOptions = ConstructorParameters<MobileSearchControllerConstructor>[0];
type LoadRemoteResults = NonNullable<MobileSearchControllerOptions["loadRemoteResults"]>;

test("mobile search controller keys only the visible matched memos", async () => {
	await ensureObsidianStub();
	const { MobileSearchController } = await import("../src/ui/MobileSearchController");
	const memos = [makeMemo("memo-1", "alpha memo"), makeMemo("memo-2", "beta memo"), makeMemo("note-1", "other")];
	const { controller } = createControllerHarness(MobileSearchController, memos);

	controller.isOpen = true;
	controller.searchQuery = "memo";

	assert.equal(controller.getIdsKey(), "memo-1");

	controller.loadMore();
	assert.equal(controller.getIdsKey(), "memo-1\nmemo-2");
});

test("mobile search summary uses the complete remote match count before later pages load", async () => {
	await ensureObsidianStub();
	const { MobileSearchController } = await import("../src/ui/MobileSearchController");
	const memos = Array.from({ length: 50 }, (_, index) => makeMemo(`memo-${index + 1}`, "project memo"));
	const { controller, root } = createControllerHarness(MobileSearchController, memos, () => 90);

	controller.searchQuery = "project";
	controller.openPage({ focusInput: false });

	assert.equal(root.find(".knomo-list-summary")?.getText(), "Found 90 Memos for “project”");
});

test("mobile record stats filter refreshes remote results and renders its summary", async () => {
	await ensureObsidianStub();
	const { MobileSearchController } = await import("../src/ui/MobileSearchController");
	const recordStatsFilter: RecordStatsSearchFilter = {
		type: "range",
		startDate: "2026-06-01",
		endDateExclusive: "2026-07-01",
	};
	const remoteCalls: unknown[][] = [];
	const { controller, root } = createControllerHarness(
		MobileSearchController,
		[makeMemo("memo-1", "project memo")],
		() => 13,
		async (...args) => {
			remoteCalls.push(args);
		},
	);

	controller.searchRecordStatsFilter = recordStatsFilter;
	controller.openPage({
		focusInput: false,
		changeIntent: "view-scope-change",
		refreshRemoteResults: true,
	});
	await Promise.resolve();

	assert.deepEqual(remoteCalls, [["", null, recordStatsFilter, true]]);
	assert.equal(root.find(".knomo-list-summary")?.getText(), "2026-06-01 to 2026-06-30: 13 Memos");
});

test("mobile search opens, syncs the page, and closes from Escape", async () => {
	await ensureObsidianStub();
	const { MobileSearchController } = await import("../src/ui/MobileSearchController");
	const { controller, root, state, dispatch } = createControllerHarness(MobileSearchController, [
		makeMemo("memo-1", "alpha memo"),
	]);

	controller.searchQuery = "alpha";
	controller.openPage();

	const page = controller.page as unknown as TestElement;
	const input = controller.input as unknown as TestElement;
	const results = controller.results as unknown as TestElement;
	assert.equal(controller.isOpen, true);
	assert.equal(root.find(".knomo-mobile-search-page"), page);
	assert.equal(input.value, "alpha");
	assert.equal(input.focusCount, 1);
	assert.deepEqual(state.pausedStates, [true]);
	assert.equal(state.closeSurroundingChromeCount, 1);
	assert.equal(state.syncRootStateCount, 1);
	assert.deepEqual(state.renderedMemoIds, ["memo-1"]);

	controller.syncPage();
	assert.equal(page.hasClass("is-open"), true);
	assert.equal(page.getAttr("aria-hidden"), "false");
	assert.equal(page.getAttr("inert"), null);
	assert.deepEqual(state.bodyToggleCalls, [{ cls: "knomo-mobile-search-active", active: true }]);

	const event = createKeyboardEvent("Escape");
	dispatch(input, "keydown", event);

	assert.equal(event.defaultPrevented, true);
	assert.equal(event.propagationStopped, true);
	assert.equal(controller.isOpen, false);
	assert.equal(controller.searchQuery, "");
	assert.equal(input.value, "");
	assert.equal(results.childCount, 0);
	assert.deepEqual(state.pausedStates, [true, false]);
	assert.equal(state.closeCardMenuCount, 1);
	assert.equal(state.syncRootStateCount, 2);
	assert.deepEqual(state.restoredCardFlowScrolls, [48]);
});

test("mobile search date filters reset visible results and clear record stats filters", async () => {
	await ensureObsidianStub();
	const { MobileSearchController } = await import("../src/ui/MobileSearchController");
	const { controller, root } = createControllerHarness(MobileSearchController, [
		makeMemo("memo-1", "alpha memo"),
		makeMemo("memo-2", "beta memo"),
		makeMemo("memo-3", "other"),
	]);
	const recordStatsFilter: RecordStatsSearchFilter = {
		type: "range",
		startDate: "2026-06-01",
		endDateExclusive: "2026-07-01",
	};

	controller.searchQuery = "memo";
	controller.openPage({ focusInput: false });
	controller.loadMore();
	assert.equal(controller.searchVisibleCount, 2);
	assert.equal(controller.getIdsKey(), "memo-1\nmemo-2");

	controller.searchRecordStatsFilter = recordStatsFilter;
	controller.setDateFilter("week");

	assert.equal(controller.searchVisibleCount, 1);
	assert.equal(controller.searchDateFilter, "week");
	assert.equal(controller.searchRecordStatsFilter, null);
	assert.equal(controller.getIdsKey(), "memo-1");
	const weekButton = root.find("[data-search-date='week']");
	assert.equal(weekButton?.hasClass("is-active"), true);
	assert.equal(weekButton?.getAttr("aria-pressed"), "true");
});

function makeMemo(id: string, content: string): MemoRecord {
	return {
		id,
		createdAt: "2026-06-02T00:00:00+08:00",
		updatedAt: "2026-06-02T00:00:00+08:00",
		contentSnapshot: content,
		contentHash: id,
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
			path: "Journal/2026-06-02.md",
			heading: null,
			lastKnownBlock: contentBlock(content),
			lastKnownHash: id,
			lineNumberHint: 1,
			lastSyncedAt: null,
		},
		monthlyRef: {
			path: "Knomo/2026-06.md",
			dateHeading: "2026-06-02",
			lastKnownBlock: contentBlock(content),
			lastKnownHash: id,
			lineNumberHint: 1,
			lastSyncedAt: null,
		},
	};
}

function contentBlock(content: string): string {
	return `- 00:00 ${content}`;
}

function createControllerHarness(
	Controller: MobileSearchControllerConstructor,
	memos: MemoRecord[],
	getMatchedTotalCount?: () => number | null,
	loadRemoteResults?: LoadRemoteResults,
): {
	controller: MobileSearchControllerInstance;
	root: TestElement;
	state: ControllerHarnessState;
	dispatch: (target: TestElement, type: string, event: FakeEvent) => void;
} {
	const root = new TestElement("div");
	const body = new TestElement("body");
	const events: RegisteredEvent[] = [];
	const state: ControllerHarnessState = {
		pausedStates: [],
		bodyToggleCalls: [],
		renderedMemoIds: [],
		restoredCardFlowScrolls: [],
		closeSurroundingChromeCount: 0,
		closeCardMenuCount: 0,
		syncRootStateCount: 0,
	};
	const controller = new Controller({
		batchSize: 1,
		debounceMs: 10,
		getWindow: () => fakeWindow(),
		getDocument: () => ({
			body: body.asHtml(),
		} as Document),
		getRootEl: () => root.asHtml(),
		isMobileLayout: () => true,
		getMemos: () => memos,
		getMatchedTotalCount,
		loadRemoteResults,
		registerDomEvent: (target, type, listener) => {
			events.push({
				target: target as unknown as TestElement,
				type,
				listener: listener as unknown as (event: FakeEvent) => void,
			});
		},
		createHiddenText: (container, name, text) => {
			container.createSpan({ cls: "sr-only", text, attr: { id: name } });
			return name;
		},
		memoMatchesSearch: (memo, normalizedQuery) => {
			return normalizedQuery.length === 0 || memo.contentSnapshot.includes(normalizedQuery);
		},
		renderMemoCard: (container, memo) => {
			state.renderedMemoIds.push(memo.id);
			container.createDiv({ cls: "knomo-card", text: memo.id, attr: { "data-memo-id": memo.id } });
		},
		clearMarkdown: () => undefined,
		clearImages: () => undefined,
		setCardFlowPaused: (paused) => {
			state.pausedStates.push(paused);
		},
		closeSurroundingChrome: () => {
			state.closeSurroundingChromeCount += 1;
		},
		closeCardMenu: () => {
			state.closeCardMenuCount += 1;
		},
		syncRootState: () => {
			state.syncRootStateCount += 1;
		},
		getCardFlowScrollTop: () => 48,
		restoreCardFlowScrollTop: (scrollTop) => {
			state.restoredCardFlowScrolls.push(scrollTop);
		},
		restoreElementScrollTop: (element, scrollTop) => {
			if (element !== null) {
				(element as unknown as TestElement).scrollTop = scrollTop ?? 0;
			}
		},
		handleMarkdownInternalLinkClick: () => undefined,
		handleTaskCheckboxClick: () => undefined,
		handleTaskCheckboxChange: () => undefined,
	});
	body.toggleClass = (cls: string, active: boolean) => {
		state.bodyToggleCalls.push({ cls, active });
	};
	return {
		controller,
		root,
		state,
		dispatch: (target, type, event) => {
			for (const registered of events) {
				if (registered.target === target && registered.type === type) {
					registered.listener(event);
				}
			}
		},
	};
}

interface ControllerHarnessState {
	pausedStates: boolean[];
	bodyToggleCalls: Array<{ cls: string; active: boolean }>;
	renderedMemoIds: string[];
	restoredCardFlowScrolls: Array<number | null>;
	closeSurroundingChromeCount: number;
	closeCardMenuCount: number;
	syncRootStateCount: number;
}

interface RegisteredEvent {
	target: TestElement;
	type: string;
	listener: (event: FakeEvent) => void;
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
	isConnected = true;
	scrollTop = 0;
	value = "";
	focusCount = 0;

	constructor(private readonly tagName: string) {}

	get childCount(): number {
		return this.children.length;
	}

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

	removeAttribute(key: string): void {
		this.attrs.delete(key);
	}

	addClass(cls: string): void {
		this.classes.add(cls);
	}

	removeClass(cls: string): void {
		this.classes.delete(cls);
	}

	toggleClass(cls: string, active: boolean): void {
		if (active) {
			this.addClass(cls);
		} else {
			this.removeClass(cls);
		}
	}

	hasClass(cls: string): boolean {
		return this.classes.has(cls);
	}

	focus(): void {
		this.focusCount += 1;
	}

	empty(): void {
		this.children.length = 0;
		this.text = "";
	}

	detach(): void {
		this.isConnected = false;
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

interface FakeEvent {
	readonly key?: string;
	defaultPrevented: boolean;
	propagationStopped: boolean;
	preventDefault(): void;
	stopPropagation(): void;
}

function createKeyboardEvent(key: string): FakeEvent {
	return {
		key,
		defaultPrevented: false,
		propagationStopped: false,
		preventDefault() {
			this.defaultPrevented = true;
		},
		stopPropagation() {
			this.propagationStopped = true;
		},
	};
}

function fakeWindow(): Window {
	return {
		setTimeout: () => 1,
		clearTimeout: () => undefined,
	} as unknown as Window;
}

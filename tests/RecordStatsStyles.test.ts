import test from "node:test";
import assert from "node:assert/strict";
import type { RecordStatsSnapshot, SelectedRecordStats } from "../src/services/RecordStatsService";
import { ensureObsidianStub } from "./helpers/obsidianStub";

test("record statistics renders loading state with reserved skeleton sections", async () => {
	await ensureObsidianStub();
	const { renderKnomoRecordStatsPage } = await import("../src/ui/KnomoRecordStatsPage");
	const root = new TestElement("div");

	renderKnomoRecordStatsPage(root.asHtml(), {
		snapshot: { state: "loading", error: null, updating: false },
		selected: null,
		view: "month",
		canAdvance: false,
		canRetreat: false,
		createHiddenText,
	});

	assert.equal(root.find("[role='status']")?.hasClass("knomo-record-stats-loading"), true);
	assert.equal(root.findAll(".knomo-record-stats-skeleton-chart").length, 2);
	assert.notEqual(root.find(".knomo-record-stats-skeleton-tag-chart"), null);
});

test("record statistics renders actionable range metrics, charts, hours, and common tags", async () => {
	await ensureObsidianStub();
	const { renderKnomoRecordStatsPage } = await import("../src/ui/KnomoRecordStatsPage");
	const root = new TestElement("div");

	renderKnomoRecordStatsPage(root.asHtml(), {
		snapshot: { state: "ready", error: null, updating: false } satisfies RecordStatsSnapshot,
		selected: makeSelectedStats(),
		view: "month",
		canAdvance: false,
		canRetreat: true,
		createHiddenText,
	});

	assert.equal(root.find("[data-action='reset-list-state']")?.getAttr("aria-label"), "Back to all notes");
	assert.equal(root.find("[data-action='record-stats-view-month']")?.getAttr("aria-pressed"), "true");
	assert.equal(root.find("[data-action='record-stats-next']")?.disabled, true);
	assert.equal(root.find("[data-action='record-stats-previous']")?.disabled, false);
	assert.equal(root.find("[data-record-stats-key='2026-06-01']")?.getAttr("data-record-stats-unit"), "day");
	assert.equal(root.find("[data-record-stats-hour='8']")?.getAttr("data-action"), "record-stats-filter-hour");

	const tagButton = root.find("[data-record-stats-tag-key='work']");
	assert.equal(tagButton?.getAttr("data-action"), "record-stats-filter-tag");
	assert.equal(tagButton?.getText(), "#Work3");
	assert.equal(tagButton?.find(".knomo-record-stats-tag-bar")?.getCssProp("--knomo-record-stats-tag-ratio"), "1");
});

test("record statistics keeps the committed page visible with an updating marker", async () => {
	await ensureObsidianStub();
	const { renderKnomoRecordStatsPage } = await import("../src/ui/KnomoRecordStatsPage");
	const root = new TestElement("div");

	renderKnomoRecordStatsPage(root.asHtml(), {
		snapshot: { state: "ready", error: null, updating: true },
		selected: makeSelectedStats(),
		view: "month",
		canAdvance: false,
		canRetreat: true,
		createHiddenText,
	});

	assert.equal(root.find(".knomo-record-stats-updating")?.getText(), "Updating");
	assert.equal(root.find("[data-action='reset-list-state']")?.getText(), "13All notes");
});

function createHiddenText(container: HTMLElement, id: string, text: string): string {
	container.createSpan({ cls: "sr-only", text, attr: { id } });
	return id;
}

function makeSelectedStats(): SelectedRecordStats {
	return {
		startDate: "2026-06-01",
		endDateExclusive: "2026-07-01",
		overview: {
			memoCount: 13,
			wordCount: 233,
			recordDayCount: 4,
		},
		range: {
			memoCount: 8,
			wordCount: 144,
			recordDayCount: 3,
			referenceMemoCount: 2,
			taggedMemoCount: 5,
			untaggedMemoCount: 3,
			imageMemoCount: 1,
			maxDailyMemoCount: 4,
			maxDailyWordCount: 88,
			maxDailyMemoDates: ["2026-06-01"],
			maxDailyWordDates: ["2026-06-02"],
		},
		trend: [
			{ key: "2026-06-01", label: "1", count: 4 },
			{ key: "2026-06-02", label: "2", count: 0 },
			{ key: "2026-06-03", label: "3", count: 2 },
		],
		activeHours: Array.from({ length: 24 }, (_, hour) => ({
			hour,
			count: hour === 8 ? 3 : 0,
		})),
		commonTags: [
			{ key: "work", label: "Work", count: 3 },
			{ key: "life", label: "Life", count: 1 },
		],
	};
}

interface CreateElementOptions {
	cls?: string;
	text?: string;
	attr?: Record<string, string>;
}

class TestElement {
	private readonly childElements: TestElement[] = [];
	private readonly classes = new Set<string>();
	private readonly attrs = new Map<string, string>();
	private readonly cssProps = new Map<string, string>();
	readonly children = {
		item: (index: number): Element | null => this.childElements[index]?.asHtml() ?? null,
	};
	disabled = false;
	scrollLeft = 0;
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
		this.childElements.push(child);
		return child;
	}

	setText(value: string): void {
		this.text = value;
	}

	getText(): string {
		return this.text + this.childElements.map((child) => child.getText()).join("");
	}

	setAttr(key: string, value: string): void {
		this.attrs.set(key, value);
	}

	getAttr(key: string): string | null {
		return this.attrs.get(key) ?? null;
	}

	setCssProps(props: Record<string, string>): void {
		for (const [key, value] of Object.entries(props)) {
			this.cssProps.set(key, value);
		}
	}

	getCssProp(key: string): string | null {
		return this.cssProps.get(key) ?? null;
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
		for (const child of this.childElements) {
			child.collect(selector, result);
		}
		return result;
	}

	getBoundingClientRect(): DOMRect {
		return {
			left: 0,
			right: 0,
			top: 0,
			bottom: 0,
			width: 0,
			height: 0,
			x: 0,
			y: 0,
			toJSON: () => ({}),
		} as DOMRect;
	}

	private collect(selector: string, result: TestElement[]): void {
		if (this.matches(selector)) {
			result.push(this);
		}
		for (const child of this.childElements) {
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

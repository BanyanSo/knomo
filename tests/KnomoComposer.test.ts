import test from "node:test";
import assert from "node:assert/strict";
import { ensureObsidianStub } from "./helpers/obsidianStub";

const obsidianStubReady = ensureObsidianStub();

test("renders composer input, tools, actions, and reference preview", async () => {
	await obsidianStubReady;
	const { KNOMO_TIME_BUOY_ICON } = await import("../src/icons");
	const { renderComposerReferencePreview, renderKnomoComposer } = await import("../src/ui/KnomoComposer");
	const root = new TestElement("div");

	const elements = renderKnomoComposer(root.asHtml(), {
		dailyEnabled: false,
		timeBuoyEnabled: true,
		timeBuoyPickerId: "time-buoy-picker",
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
		"insert-time-buoy",
		"insert-list",
		"insert-numbered-list",
	]);
	assert.equal(elements.timeBuoyButtonEl?.disabled, true);
	assert.equal(elements.timeBuoyButtonEl?.getAttr("data-icon"), KNOMO_TIME_BUOY_ICON);
	assert.equal(elements.timeBuoyButtonEl?.getAttr("aria-haspopup"), "dialog");
	assert.equal(elements.timeBuoyButtonEl?.getAttr("aria-expanded"), "false");
	assert.equal(elements.timeBuoyButtonEl?.getAttr("aria-controls"), "time-buoy-picker");
	assert.equal(elements.timeBuoyMonthStatusEl?.getAttr("role"), "status");
	assert.equal(elements.timeBuoyMonthStatusEl?.getAttr("aria-live"), "polite");
	assert.equal(elements.timeBuoyMonthStatusEl?.getAttr("aria-atomic"), "true");
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

test("renders mobile Time buoy pickers with future-only dates and direct selection", async () => {
	await obsidianStubReady;
	const { renderTimeBuoyDatePicker } = await import("../src/ui/TimeBuoyDatePicker");
	const root = new TestElement("div");

	const picker = renderTimeBuoyDatePicker(root.asHtml(), "time-buoy-picker", {
		source: "button",
		mobile: true,
		browseYear: 2026,
		browseMonth: 6,
		today: new Date(2026, 6, 11),
	}) as unknown as TestElement;

	assert.equal(picker.getAttr("role"), "dialog");
	assert.equal(picker.getAttr("aria-modal"), "true");
	assert.equal(picker.hasClass("is-modal"), true);
	const shortcuts = picker.findAll(".knomo-time-buoy-picker-shortcut");
	assert.deepEqual(shortcuts.map((shortcut) => shortcut.getText()), ["Tomorrow", "In 7 days", "In 30 days", "In 90 days"]);
	assert.deepEqual(shortcuts.map((shortcut) => shortcut.getAttr("data-time-buoy-date")), [
		"2026-07-12",
		"2026-07-18",
		"2026-08-10",
		"2026-10-09",
	]);
	assert.equal(picker.findAll(".knomo-time-buoy-picker-day").length, 42);
	assert.equal(picker.find("[data-time-buoy-date='2026-07-10']")?.disabled, true);
	assert.equal(picker.find("[data-time-buoy-date='2026-07-10']")?.getAttr("aria-disabled"), "true");
	assert.equal(picker.find("[data-time-buoy-date='2026-07-11']")?.disabled, false);
	assert.equal(picker.find("[data-time-buoy-picker-action='confirm']"), null);
	assert.notEqual(picker.find("[data-time-buoy-picker-action='cancel']"), null);

	const contextPicker = renderTimeBuoyDatePicker(root.asHtml(), "time-buoy-context-picker", {
		source: "at-input",
		mobile: true,
		browseYear: 2026,
		browseMonth: 6,
		today: new Date(2026, 6, 11),
	}) as unknown as TestElement;
	assert.equal(contextPicker.getAttr("aria-modal"), "true");
	assert.equal(contextPicker.hasClass("is-modal"), true);
	assert.equal(contextPicker.find("[data-time-buoy-picker-action='confirm']"), null);

	const desktopContextPicker = renderTimeBuoyDatePicker(root.asHtml(), "time-buoy-desktop-context-picker", {
		source: "at-input",
		mobile: false,
		browseYear: 2026,
		browseMonth: 6,
		today: new Date(2026, 6, 11),
	}) as unknown as TestElement;
	assert.equal(desktopContextPicker.getAttr("aria-modal"), "false");
	assert.equal(desktopContextPicker.hasClass("is-context"), true);
});

test("clamps desktop Time buoy pickers within the composer", async () => {
	await obsidianStubReady;
	const { getTimeBuoyPickerLeft } = await import("../src/ui/TimeBuoyDatePicker");

	assert.equal(getTimeBuoyPickerLeft(720, 100, 328), 100);
	assert.equal(getTimeBuoyPickerLeft(720, 680, 328), 380);
	assert.equal(getTimeBuoyPickerLeft(280, 260, 256), 12);
	assert.equal(getTimeBuoyPickerLeft(280, -10, 256), 12);
});

test("narrows Time buoy input events with the composer window constructor", async () => {
	await obsidianStubReady;
	const { KnomoView } = await import("../src/ui/KnomoView");
	class ComposerInputEvent {
		readonly inputType = "insertText";
		readonly data = "@";
		readonly isComposing = false;
	}
	class ForeignInputEvent {
		readonly inputType = "insertText";
		readonly data = "@";
		readonly isComposing = false;
	}
	const opened: Array<{ source: string; triggerStart: number | null }> = [];
	const view = Object.create(KnomoView.prototype) as {
		suppressTimeBuoyAutoOpen: boolean;
		inputEl: HTMLTextAreaElement | null;
		timeBuoyPickerState: null;
		settingsService: { getSettings: () => { timeBuoyEnabled: boolean } };
		isSaving: boolean;
		openTimeBuoyPicker: (source: string, triggerStart: number | null) => void;
		handleTimeBuoyComposerInput: (event: Event) => boolean;
	};
	view.suppressTimeBuoyAutoOpen = false;
	view.inputEl = {
		value: "@",
		selectionStart: 1,
		selectionEnd: 1,
		ownerDocument: {
			defaultView: { InputEvent: ComposerInputEvent },
		},
	} as unknown as HTMLTextAreaElement;
	view.timeBuoyPickerState = null;
	view.settingsService = { getSettings: () => ({ timeBuoyEnabled: true }) };
	view.isSaving = false;
	view.openTimeBuoyPicker = (source, triggerStart) => {
		opened.push({ source, triggerStart });
	};

	assert.equal(view.handleTimeBuoyComposerInput(new ComposerInputEvent() as unknown as Event), true);
	assert.deepEqual(opened, [{ source: "at-input", triggerStart: 0 }]);
	assert.equal(view.handleTimeBuoyComposerInput(new ForeignInputEvent() as unknown as Event), false);
	assert.equal(opened.length, 1);
});

test("renders a retry action for a Time buoy Catalog error", async () => {
	await obsidianStubReady;
	const { renderTimeBuoyPage } = await import("../src/ui/TimeBuoyPage");
	const root = new TestElement("div");

	renderTimeBuoyPage(root.asHtml(), {
		loading: false,
		error: new Error("corrupt shard"),
		todayError: null,
		activeTab: "today",
		today: [],
		upcoming: [],
		past: [],
	}, { idPrefix: "time-buoy-test" });

	assert.notEqual(root.find("[data-action='retry-time-buoy']"), null);
	assert.equal(root.find("[data-action='rebuild-time-buoy']"), null);
});

test("renders accessible Time buoy tabs and the active tab empty state", async () => {
	await obsidianStubReady;
	const { renderTimeBuoyPage } = await import("../src/ui/TimeBuoyPage");
	const root = new TestElement("div");

	const result = renderTimeBuoyPage(root.asHtml(), {
		loading: false,
		error: null,
		todayError: null,
		activeTab: "upcoming",
		today: [],
		upcoming: [],
		past: [],
	}, { idPrefix: "time-buoy-test" });

	assert.equal(result.panelEl, null);
	assert.equal(root.find("[role='tablist']")?.getAttr("aria-label"), "Time buoy views");
	assert.equal(root.find("[data-action='time-buoy-tab-upcoming']")?.getAttr("aria-selected"), "true");
	assert.equal(root.find("[data-action='time-buoy-tab-today']")?.getAttr("tabindex"), "-1");
	assert.equal(root.find("[id='time-buoy-test-panel-today']")?.getAttr("hidden"), "");
	assert.equal(root.getText().includes("No upcoming buoys"), true);
	assert.equal(root.getText().includes("Memos set for a future date will surface when the day arrives."), true);
});

test("appends Time buoy cards directly without date titles or grouping containers", async () => {
	await obsidianStubReady;
	const { appendTimeBuoyItems } = await import("../src/ui/TimeBuoyPage");
	const root = new TestElement("div");
	const renderIndexes: number[] = [];
	const items = [
		{ primaryTargetDate: "2026-07-20", targetDates: ["2026-07-20"], memo: { id: "memo-1" } },
		{ primaryTargetDate: "2026-07-21", targetDates: ["2026-07-21"], memo: { id: "memo-2" } },
	] as never;

	appendTimeBuoyItems(root.asHtml(), items, 3, (container, _item, renderIndex) => {
		assert.equal(container, root.asHtml());
		renderIndexes.push(renderIndex);
		container.createDiv({ cls: "knomo-card" });
	});

	assert.deepEqual(renderIndexes, [3, 4]);
	assert.equal(root.find("h3"), null);
	assert.equal(root.find("[data-time-buoy-date-group]"), null);
	assert.equal(root.findAll(".knomo-card").length, 2);
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

	setAttrs(attrs: Record<string, string>): void {
		for (const [key, value] of Object.entries(attrs)) {
			this.setAttr(key, value);
		}
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

	toggleClass(cls: string, active: boolean): void {
		if (active) {
			this.classes.add(cls);
		} else {
			this.classes.delete(cls);
		}
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

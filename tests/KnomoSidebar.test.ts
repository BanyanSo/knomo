import test from "node:test";
import assert from "node:assert/strict";
import { ensureObsidianStub } from "./helpers/obsidianStub";

test("renders sidebar navigation, trash, stats, tags, and resizer structure", async () => {
	await ensureObsidianStub();
	const {
		renderKnomoSidebar,
		renderSidebarStat,
		renderSidebarTags,
		SIDEBAR_MAX_WIDTH,
		SIDEBAR_MIN_WIDTH,
		syncSidebarNavButtons,
		syncSidebarTagGroupExpanded,
	} = await import("../src/ui/KnomoSidebar");
	const sidebar = new TestElement("aside");
	const elements = renderKnomoSidebar(sidebar.asHtml(), {
		sidebarMinWidth: SIDEBAR_MIN_WIDTH,
		sidebarMaxWidth: SIDEBAR_MAX_WIDTH,
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
			return button;
		},
	});

	assert.equal(elements.statsEl.getAttr("aria-labelledby"), "stats-label");
	renderSidebarStat(elements.statsEl, "12", "Notes");
	assert.equal(elements.statsEl.find(".knomo-stat-value")?.getText(), "12");

	assert.deepEqual(sidebar.findAll("[data-nav]").map((item) => item.getAttr("data-nav")), [
		"all",
		"review",
		"random",
		"shuffleDay",
		"record-stats",
		"trash",
	]);
	assert.equal(sidebar.find("[data-nav='trash']")?.hasClass("knomo-trash-nav-button"), true);
	assert.equal(elements.resizerEl.getAttr("role"), "separator");
	assert.equal(elements.resizerEl.getAttr("aria-valuemin"), String(SIDEBAR_MIN_WIDTH));
	assert.equal(elements.resizerEl.getAttr("aria-valuemax"), String(SIDEBAR_MAX_WIDTH));

	renderSidebarTags(elements.allTagsEl, [
		{ key: "project/knomo", name: "Project/Knomo", count: 2 },
		{ key: "life", name: "life", count: 1 },
	], {
		activeTagKey: "project/knomo",
		expandedTagGroups: new Set<string>(),
		emptyText: "No tags",
	});
	const projectNode = elements.allTagsEl.find(".knomo-tag-node");
	const projectToggle = elements.allTagsEl.find("[data-tag-toggle='project']");
	const projectChild = elements.allTagsEl.find("[data-tag-key='project/knomo']");
	assert.notEqual(projectNode, null);
	assert.notEqual(projectToggle, null);
	assert.equal(projectNode?.hasClass("is-collapsed"), true);
	assert.equal(projectToggle?.getAttr("aria-expanded"), "false");
	assert.equal(elements.allTagsEl.find("[data-tag-key='project/knomo']")?.hasClass("is-active"), true);
	assert.equal(elements.allTagsEl.find("[data-tag-key='project/knomo']")?.getAttr("aria-pressed"), "true");

	const collapsedLabel = projectToggle?.getAttr("aria-label");
	syncSidebarTagGroupExpanded(projectNode!, projectToggle!, true);
	assert.equal(projectNode?.hasClass("is-collapsed"), false);
	assert.equal(projectToggle?.getAttr("aria-expanded"), "true");
	assert.notEqual(projectToggle?.getAttr("aria-label"), collapsedLabel);
	assert.equal(elements.allTagsEl.find("[data-tag-key='project/knomo']"), projectChild);

	syncSidebarTagGroupExpanded(projectNode!, projectToggle!, false);
	assert.equal(projectNode?.hasClass("is-collapsed"), true);
	assert.equal(projectToggle?.getAttr("aria-expanded"), "false");
	assert.equal(projectToggle?.getAttr("aria-label"), collapsedLabel);

	syncSidebarNavButtons(sidebar.asHtml(), "review");
	assert.equal(sidebar.find("[data-nav='review']")?.hasClass("is-active"), true);
	assert.equal(sidebar.find("[data-nav='review']")?.getAttr("aria-pressed"), "true");
	assert.equal(sidebar.find("[data-nav='all']")?.getAttr("aria-pressed"), "false");
});

test("renders sidebar tag empty state", async () => {
	await ensureObsidianStub();
	const { renderSidebarTags } = await import("../src/ui/KnomoSidebar");
	const container = new TestElement("div");

	renderSidebarTags(container.asHtml(), [], {
		activeTagKey: null,
		expandedTagGroups: new Set<string>(),
		emptyText: "No tags",
	});

	assert.equal(container.find(".knomo-muted-text")?.getText(), "No tags");
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

	toggleClass(cls: string, active: boolean): void {
		if (active) {
			this.classes.add(cls);
		} else {
			this.classes.delete(cls);
		}
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

import test from "node:test";
import assert from "node:assert/strict";

import type { MemoRecord } from "./helpers/memoViewFixture";
import {
	parseCardImageIndex,
	planMemoCardImageLoads,
	renderMemoCardImages,
	type RenderedMemoCardImages,
} from "../src/ui/KnomoCardImages";
import type { MemoPreviewImage } from "../src/ui/MemoCardPreview";

const labels = {
	previewLabel: "Preview image",
	unavailableLabel: "Image unavailable",
};

test("renderMemoCardImages skips empty image lists", () => {
	const root = new TestElement("div");
	const rendered = renderMemoCardImages(root.asHtml(), makeMemo(), [], labels);

	assert.equal(rendered, null);
	assert.equal(root.find(".knomo-card-images"), null);
});

test("renderMemoCardImages renders a single local image load item", () => {
	const root = new TestElement("div");
	const rendered = renderMemoCardImages(root.asHtml(), makeMemo(), [
		makeImage({
			url: "app://local.png",
			alt: "Local image",
			resourcePath: "Images/local.png",
		}),
	], labels);

	assertRendered(rendered);
	assert.equal(rendered.imagesEl.hasClass("knomo-card-images--single"), true);
	assert.equal(rendered.imagesEl.hasClass("knomo-card-images--grid"), false);
	assert.equal(root.findAll(".knomo-card-image-button").length, 1);
	const button = root.find(".knomo-card-image-button");
	assert.equal(button?.getAttr("aria-label"), "Preview image");
	assert.equal(button?.getAttr("data-memo-id"), "memo-1");
	assert.equal(button?.getAttr("data-image-index"), "0");
	const imageEl = root.find("img");
	assert.equal(imageEl?.getAttr("alt"), "Local image");
	assert.equal(imageEl?.getAttr("decoding"), "async");
	assert.equal(imageEl?.getAttr("fetchpriority"), null);
	assert.equal(rendered.loadItems.length, 1);
	assert.equal(rendered.loadItems[0].src, "app://local.png");
	assert.equal(rendered.loadItems[0].resourcePath, "Images/local.png");
	assert.equal(rendered.loadItems[0].priority, "high");
	assert.equal(root.find(".knomo-card-image-item")?.hasClass("is-loading"), true);

	rendered.loadItems[0].onLoad?.();
	assert.equal(root.find(".knomo-card-image-item")?.hasClass("is-loading"), false);
});

test("renderMemoCardImages reuses loaded image items with unchanged keys", () => {
	const root = new TestElement("div");
	const image = makeImage({
		url: "app://local.png?knomo-mtime=100",
		resourcePath: "Images/local.png",
		mtime: 100,
	});
	const rendered = renderMemoCardImages(root.asHtml(), makeMemo(), [image], labels);
	assertRendered(rendered);
	const item = root.find(".knomo-card-image-item");
	const imageEl = root.find("img");
	assert.notEqual(item, null);
	assert.notEqual(imageEl, null);
	rendered.loadItems[0].imageEl.setAttr("src", rendered.loadItems[0].src);
	rendered.loadItems[0].onLoad?.();

	const rerendered = renderMemoCardImages(root.asHtml(), makeMemo(), [image], labels, rendered.imagesEl);

	assertRendered(rerendered);
	assert.equal(rerendered.imagesEl, rendered.imagesEl);
	assert.equal(rerendered.loadItems.length, 0);
	assert.equal(root.find(".knomo-card-image-item"), item);
	assert.equal(root.find("img"), imageEl);
	assert.equal(root.find(".knomo-card-image-item")?.hasClass("is-loading"), false);
});

test("renderMemoCardImages limits visible images and shows the hidden count", () => {
	const root = new TestElement("div");
	const rendered = renderMemoCardImages(root.asHtml(), makeMemo(), [
		makeImage({ url: "https://example.com/1.png", isRemote: true }),
		makeImage({ url: "https://example.com/2.png", isRemote: true }),
		makeImage({ url: "https://example.com/3.png", isRemote: true }),
		makeImage({ url: "https://example.com/4.png", isRemote: true }),
		makeImage({ url: "https://example.com/5.png", isRemote: true }),
	], labels);

	assertRendered(rendered);
	assert.equal(rendered.imagesEl.hasClass("knomo-card-images--grid"), true);
	assert.equal(root.findAll(".knomo-card-image-button").length, 3);
	assert.deepEqual(root.findAll(".knomo-card-image-button").map((button) => button.getAttr("data-image-index")), [
		"0",
		"1",
		"2",
	]);
	assert.equal(root.find(".knomo-card-image-more")?.getText(), "+2");
	assert.deepEqual(rendered.loadItems.map((item) => item.priority), ["high", "low", "low"]);
	assert.equal(root.find("img")?.getAttr("fetchpriority"), "low");
});

test("planMemoCardImageLoads splits only the first load item for eager loading", () => {
	const root = new TestElement("div");
	const rendered = renderMemoCardImages(root.asHtml(), makeMemo(), [
		makeImage({ url: "app://first.png" }),
		makeImage({ url: "app://second.png" }),
		makeImage({ url: "app://third.png" }),
	], labels);

	assertRendered(rendered);
	const regularPlan = planMemoCardImageLoads(rendered.loadItems, false);
	assert.deepEqual(regularPlan.eagerLoadItems.map((item) => item.src), []);
	assert.deepEqual(regularPlan.observedLoadItems.map((item) => item.src), [
		"app://first.png",
		"app://second.png",
		"app://third.png",
	]);

	const eagerPlan = planMemoCardImageLoads(rendered.loadItems, true);
	assert.deepEqual(eagerPlan.eagerLoadItems.map((item) => item.src), ["app://first.png"]);
	assert.deepEqual(eagerPlan.observedLoadItems.map((item) => item.src), [
		"app://second.png",
		"app://third.png",
	]);
});

test("renderMemoCardImages renders placeholders for unresolved images", () => {
	const root = new TestElement("div");
	const rendered = renderMemoCardImages(root.asHtml(), makeMemo(), [
		makeImage({ url: undefined, unresolved: true }),
	], labels);

	assertRendered(rendered);
	assert.equal(rendered.loadItems.length, 0);
	assert.equal(root.find(".knomo-card-image-placeholder")?.getText(), "Image unavailable");
	assert.equal(root.find("img"), null);
});

test("renderMemoCardImages replaces failed loads with placeholders", () => {
	const root = new TestElement("div");
	const rendered = renderMemoCardImages(root.asHtml(), makeMemo(), [
		makeImage({ url: "app://local.png" }),
	], labels);

	assertRendered(rendered);
	const item = root.find(".knomo-card-image-item");
	const button = root.find(".knomo-card-image-button");
	assert.equal(item?.hasClass("is-loading"), true);

	rendered.loadItems[0].onError?.();

	assert.equal(item?.hasClass("is-error"), true);
	assert.equal(item?.hasClass("is-loading"), false);
	assert.equal(button?.find("img"), null);
	assert.equal(button?.find(".knomo-card-image-placeholder")?.getText(), "Image unavailable");
});

test("parseCardImageIndex falls back to the first image for invalid values", () => {
	assert.equal(parseCardImageIndex(null), 0);
	assert.equal(parseCardImageIndex("2"), 2);
	assert.equal(parseCardImageIndex("-1"), 0);
	assert.equal(parseCardImageIndex("1.5"), 0);
	assert.equal(parseCardImageIndex("bad"), 0);
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
	private parent: TestElement | null = null;

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
		child.parent = this;
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
		for (const child of this.children) {
			child.parent = null;
		}
		this.children.length = 0;
		this.text = "";
	}

	appendChild(child: TestElement): TestElement {
		child.remove();
		child.parent = this;
		this.children.push(child);
		return child;
	}

	remove(): void {
		if (this.parent === null) {
			return;
		}
		const index = this.parent.children.indexOf(this);
		if (index !== -1) {
			this.parent.children.splice(index, 1);
		}
		this.parent = null;
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

	removeClass(cls: string): void {
		this.classes.delete(cls);
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
		return this.tagName === selector;
	}
}

function makeImage(overrides: Partial<MemoPreviewImage> = {}): MemoPreviewImage {
	return {
		raw: "![[image.png]]",
		path: "image.png",
		url: "app://image.png",
		isRemote: false,
		...overrides,
	};
}

function assertRendered(rendered: RenderedMemoCardImages | null): asserts rendered is RenderedMemoCardImages {
	assert.notEqual(rendered, null);
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

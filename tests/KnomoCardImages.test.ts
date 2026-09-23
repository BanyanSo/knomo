import test from "node:test";
import assert from "node:assert/strict";

import type { MemoViewItem } from "../src/types/memoView";
import {
	MemoCardImageCache,
	parseCardImageIndex,
	renderMemoCardImages,
	type RenderedMemoCardImages,
} from "../src/ui/KnomoCardImages";
import type { MemoPreviewImage } from "../src/ui/MemoCardPreview";
import type { CardImageLoadRequest } from "../src/ui/CardImageLoadQueue";
import { ensureObsidianStub } from "./helpers/obsidianStub";

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

test("filter handoff preserves only ready nodes of the same observed occurrence", () => {
	const root = new TestElement("div");
	const memo = makeObservedMemo(1);
	const other = makeObservedMemo(4);
	const image = makeImage({ resourcePath: "image.png", mtime: 100 });
	const first = renderMemoCardImages(root.asHtml(), memo, [image, image], labels);
	const second = renderMemoCardImages(root.asHtml(), other, [image], labels);
	assertRendered(first); assertRendered(second);
	first.loadItems[0].imageEl.setAttr("src", image.url!);
	first.loadItems[0].onLoad?.();
	const node = first.loadItems[0].imageEl;
	const handoff = new MemoCardImageCache();
	handoff.capture(root.asHtml());
	root.empty();
	assert.equal(handoff.take(makeObservedMemo(1, "new-revision")), null);
	assert.equal(handoff.take(other), null);
	const reused = renderMemoCardImages(root.asHtml(), memo, [image, image], labels, handoff.take(memo));
	assertRendered(reused);
	assert.equal(root.find("img")?.asHtml(), node);
	assert.equal(reused.loadItems.length, 1);
	assert.equal(handoff.take(memo), null);
});

test("handoff rejects unknown occurrences and changed resource versions", () => {
	const root = new TestElement("div");
	const memo = makeObservedMemo(1);
	const image = makeImage({mtime: 100});
	const first = renderMemoCardImages(root.asHtml(), memo, [image], labels);
	assertRendered(first);
	first.loadItems[0].imageEl.setAttr("src", image.url!);
	first.loadItems[0].onLoad?.();
	const handoff = new MemoCardImageCache();
	handoff.capture(root.asHtml());
	root.empty();
	const next = renderMemoCardImages(root.asHtml(), memo, [{...image, mtime: 200}], labels, handoff.take(memo));
	assertRendered(next);
	assert.equal(next.loadItems.length, 1);
	assert.notEqual(next.loadItems[0].imageEl, first.loadItems[0].imageEl);
});

test("image cache does not retain ready images without an observation handle", () => {
	const root = new TestElement("div");
	const cache = new MemoCardImageCache();
	const memo = makeMemo();
	const rendered = renderMemoCardImages(root.asHtml(), memo, [makeImage()], labels);
	assertRendered(rendered);
	rendered.loadItems[0].imageEl.setAttr("src", rendered.loadItems[0].src);
	rendered.loadItems[0].onLoad?.();
	cache.capture(root.asHtml()); root.empty();
	assert.equal(cache.take(memo), null);
});

test("image cache survives an empty intermediate view and releases on clear", () => {
	const root = new TestElement("div");
	const cache = new MemoCardImageCache();
	const memo = makeObservedMemo(1);
	const image = makeImage();
	const first = renderMemoCardImages(root.asHtml(), memo, [image], labels);
	assertRendered(first);
	first.loadItems[0].imageEl.setAttr("src", first.loadItems[0].src);
	first.loadItems[0].onLoad?.();
	const node = first.loadItems[0].imageEl;
	cache.capture(root.asHtml()); root.empty();
	cache.capture(root.asHtml()); root.empty();
	const returned = renderMemoCardImages(root.asHtml(), memo, [image], labels, cache.take(memo));
	assertRendered(returned);
	assert.equal(returned.loadItems.length, 0);
	assert.equal(root.find("img")?.asHtml(), node);
	cache.capture(root.asHtml()); root.empty(); cache.clear();
	assert.equal(cache.take(memo), null);
});

test("image cache counts individual images and evicts the least recently retained occurrence", () => {
	const root = new TestElement("div");
	const cache = new MemoCardImageCache(3);
	const first = makeObservedMemo(1), second = makeObservedMemo(4), third = makeObservedMemo(7);
	const retain = (memo: MemoViewItem, count: number) => {
		const rendered = renderMemoCardImages(root.asHtml(), memo, Array.from({length: count}, () => makeImage()), labels);
		assertRendered(rendered);
		for (const item of rendered.loadItems) { item.imageEl.setAttr("src", item.src); item.onLoad?.(); }
		cache.capture(root.asHtml()); root.empty();
	};
	retain(first, 2); retain(second, 1);
	const reused = cache.take(first);
	assert.notEqual(reused, null);
	renderMemoCardImages(root.asHtml(), first, [makeImage(), makeImage()], labels, reused);
	cache.capture(root.asHtml()); root.empty();
	retain(third, 1);
	assert.equal(cache.take(second), null);
	assert.notEqual(cache.take(first), null);
	assert.notEqual(cache.take(third), null);
});

test("本地三张原图经过其他筛选和空页面后复用同一批已加载节点", () => {
	const root = new TestElement("div");
	const cache = new MemoCardImageCache();
	const memo = makeObservedMemo(1);
	const images = Array.from({ length: 3 }, (_, index) => makeImage({ resourcePath: `${index}.jpg` }));
	const first = renderMemoCardImages(root.asHtml(), memo, images, labels)!;
	const nodes = first.loadItems.map(item => item.imageEl);
	for (const item of first.loadItems) {
		Object.assign(item.imageEl, { naturalWidth: 4000, naturalHeight: 3000 });
		item.imageEl.setAttr("src", item.src); item.onLoad?.();
	}
	cache.capture(root.asHtml()); root.empty();
	const other = renderMemoCardImages(root.asHtml(), makeObservedMemo(4), [makeImage()], labels)!;
	other.loadItems[0].imageEl.setAttr("src", other.loadItems[0].src); other.loadItems[0].onLoad?.();
	cache.capture(root.asHtml()); root.empty();
	cache.capture(root.asHtml());
	const returned = renderMemoCardImages(root.asHtml(), memo, images, labels, cache.take(memo))!;
	assert.equal(returned.loadItems.length, 0);
	assert.deepEqual(root.findAll("img").map(node => node.asHtml()), nodes);
});

test("失败卡片点击后仅重试自身，恢复加载占位且不冒泡打开预览", () => {
	const root = new TestElement("div");
	const rendered = renderMemoCardImages(root.asHtml(), makeMemo(), [makeImage(), makeImage()], {
		...labels, retryLabel: "Tap to retry",
	})!;
	const [failed, ready] = rendered.loadItems;
	ready.imageEl.setAttr("src", ready.src); ready.onLoad?.();
	let retries = 0;
	failed.onError?.(() => { retries++; failed.imageEl.setAttr("src", failed.src); return true; });
	const [button] = root.findAll(".knomo-card-image-button");
	assert.equal(button.find(".knomo-card-image-placeholder")?.getText(), "Tap to retry");
	assert.equal(button.click(), true);
	assert.equal(retries, 1);
	assert.equal(button.find("img")?.asHtml(), failed.imageEl);
	assert.equal(root.findAll(".knomo-card-image-item")[0].hasClass("is-loading"), true);
	assert.equal(ready.imageEl.getAttr("src"), ready.src);
	assert.equal(button.click(), false);
	failed.onLoad?.();
	assert.equal(root.findAll(".knomo-card-image-item")[0].hasClass("is-error"), false);
	failed.onError?.(() => false);
	button.click();
	assert.equal(root.findAll(".knomo-card-image-item")[0].hasClass("is-loading"), false);
	assert.equal(root.findAll(".knomo-card-image-item")[0].hasClass("is-error"), true);
});

test("移动 View 的实际重建入口经过其他筛选与空页后复用原图", async () => {
	await ensureObsidianStub();
	const { Platform } = await import("obsidian");
	const { KnomoView } = await import("../src/ui/KnomoView");
	const oldMobile = Platform.isMobile;
	Platform.isMobile = true;
	const root = new TestElement("div");
	const memo = makeObservedMemo(1), other = makeObservedMemo(4);
	const images = Array.from({ length: 3 }, (_, index) => makeImage({ resourcePath: `${index}.jpg` }));
	let current: MemoViewItem | null = memo, loads = 0;
	const view = Object.create(KnomoView.prototype);
	Object.assign(view, {
		viewStateController: { activeNav: "all" }, cardFlowEl: root.asHtml(), containerEl: { win: {} },
		cardImageCache: new MemoCardImageCache(), renderedCardMemos: new Map(), renderedPreviewImages: new WeakMap(),
		cardFlowCoordinator: { generation: 0, setPendingScrollRestore() {}, resetFlowRuntime() {} },
		memoMarkdownRenderer: { clear() {} }, recordStatsViewStateController: { clearRendered() {} },
		deferMobileCardFlowRender: () => false, getInitialCardBatchSize: () => 30,
		restoreCardFlowScrollTop() {}, resetTimeBuoyCardFlow() {},
		getDirectCardElements: () => root.findAll(".knomo-card"), getCurrentCardFlowPresentation: () => ({}),
		cardImageLoadQueue: {
			clear() {}, forget() {},
			observe(request: CardImageLoadRequest) {
				for (const item of request.images) {
					loads++; Object.assign(item.imageEl, { naturalWidth: 4000, naturalHeight: 3000 });
					item.imageEl.setAttr("src", item.src); item.onLoad?.();
				}
			},
		},
		renderCardFlowPresentation: () => {
			if (!current) return;
			const card = root.createDiv({ cls: "knomo-card", attr: { "data-memo-id": current.id } });
			view.renderMemoCardImages(card.asHtml(), current, images, view.renderGeneration, "card-flow");
			view.renderedCardMemos.set(current.id, current);
		},
	});
	try {
		view.forceRebuildCardFlow("view-scope-change");
		const original = root.findAll("img");
		assert.equal(loads, 3);
		current = other; view.forceRebuildCardFlow("view-scope-change");
		assert.equal(loads, 6);
		current = null; view.forceRebuildCardFlow("view-scope-change");
		current = memo; view.forceRebuildCardFlow("view-scope-change");
		assert.equal(loads, 6);
		assert.deepEqual(root.findAll("img"), original);
	} finally { Platform.isMobile = oldMobile; }
});

test("资源变化只清理相关缓存节点", () => {
	const root = new TestElement("div");
	const cache = new MemoCardImageCache(1);
	const first = makeObservedMemo(1), second = makeObservedMemo(4);
	for (const [memo, path] of [[first, "a.jpg"], [second, "b.jpg"]] as const) {
		const rendered = renderMemoCardImages(root.asHtml(), memo, [makeImage({ path, resourcePath: path })], labels)!;
		const item = rendered.loadItems[0];
		Object.assign(item.imageEl, { naturalWidth: 4000, naturalHeight: 3000 });
		item.imageEl.setAttr("src", item.src); item.onLoad?.();
		cache.capture(root.asHtml()); root.empty();
	}
	assert.equal(cache.take(first), null);
	cache.invalidateResourcePaths(["unrelated.jpg"]);
	assert.notEqual(cache.take(second), null);
	const rendered = renderMemoCardImages(root.asHtml(), second, [makeImage({resourcePath:"b.jpg"})], labels)!;
	rendered.loadItems[0].imageEl.setAttr("src", "app://image.png"); rendered.loadItems[0].onLoad?.();
	cache.capture(root.asHtml()); root.empty();
	cache.invalidateResourcePaths(["b.jpg"]);
	assert.equal(cache.take(second), null);
});

test("超过缓存容量时优先保留视口附近图片而非列表尾部", () => {
	const root = new TestElement("div");
	const cache = new MemoCardImageCache(2);
	const memos = [makeObservedMemo(1), makeObservedMemo(4), makeObservedMemo(7)];
	memos.forEach((memo, index) => {
		const rendered = renderMemoCardImages(root.asHtml(), memo, [makeImage()], labels)!;
		Object.assign(rendered.imagesEl, { getBoundingClientRect: () => ({ top:index * 500, bottom:index * 500 + 100 }) });
		rendered.loadItems[0].imageEl.setAttr("src", "app://image.png"); rendered.loadItems[0].onLoad?.();
	});
	const viewport = { getBoundingClientRect: () => ({top:0, bottom:200}) } as HTMLElement;
	cache.capture(root.asHtml(), viewport); root.empty();
	assert.notEqual(cache.take(memos[0]), null);
	assert.notEqual(cache.take(memos[1]), null);
	assert.equal(cache.take(memos[2]), null);
});

function makeObservedMemo(startLine: number, sourceRevision = "revision"): MemoViewItem {
	return makeMemo({catalog: {
		observationHandle: { sourcePath: "Daily/2026-06-02.md", sourceRevision, startLine, endLine: startLine + 1, rawBlockHash: "same-content" },
	} as MemoViewItem["catalog"]});
}

interface CreateElementOptions {
	cls?: string;
	text?: string;
	attr?: Record<string, string>;
}

class TestElement {
	scrollTop = 0;
	getBoundingClientRect(): DOMRect { return { top: 0, bottom: 200 } as DOMRect; }
	querySelector(selector: string): TestElement | null { return this.find(selector); }
	private readonly clickListeners: Array<(event: MouseEvent) => void> = [];
	addEventListener(type: string, listener: (event: MouseEvent) => void): void {
		if (type === "click") this.clickListeners.push(listener);
	}
	click(): boolean {
		let stopped = false;
		const event = { preventDefault() {}, stopPropagation() { stopped = true; } } as MouseEvent;
		for (const listener of this.clickListeners) listener(event);
		return stopped;
	}
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

import type { MemoViewItem as MemoRecord } from "../types/memoView";
import type { CardImageLoadItem } from "./CardImageLoadQueue";
import type { MemoPreviewImage } from "./MemoCardPreview";

const MAX_CARD_PREVIEW_IMAGES = 3;

interface RenderMemoCardImagesLabels {
	previewLabel: string;
	unavailableLabel: string;
	retryLabel?: string;
}

export interface RenderedMemoCardImages {
	removedImages: HTMLImageElement[];
	imagesEl: HTMLElement;
	loadItems: CardImageLoadItem[];
}

const previewNodes = new WeakMap<HTMLElement, HTMLImageElement>();
const readyPreviews = new WeakSet<HTMLImageElement>();

function previewResourceKey(image: MemoPreviewImage): string {
	return encodeImageKeyParts([
		image.isRemote ? "remote" : "local", image.isRemote ? "" : image.resourcePath ?? image.path, image.url ?? "",
		image.isRemote ? "" : String(image.mtime ?? ""), image.unresolved ? "unresolved" : "resolved",
	]);
}

// 只为本轮已接纳的展示记录候选。成功任务已从队列移除，候选不携带按钮或绑定。
export class ReadyCardImageHandoff {
	private candidates: { item: HTMLElement; img: HTMLImageElement }[];

	constructor(cards: readonly HTMLElement[], viewport: HTMLElement, maxImages = 24) {
		const ready = cards.flatMap(card => card.findAll(".knomo-card-image-item")).flatMap(item => {
			const img = previewNodes.get(item);
			return img && this.isReady(item, img) ? [{ item, img }] : [];
		});
		this.candidates = ready;
		if (ready.length === 0) return;
		const bounds = viewport.getBoundingClientRect();
		this.candidates = ready.map(({ item, img }) => {
			const rect = item.getBoundingClientRect();
			return { item, img, distance: Math.max(bounds.top - rect.bottom, rect.top - bounds.bottom, 0) };
		}).sort((a, b) => a.distance - b.distance).slice(0, maxImages);
	}

	take(image: MemoPreviewImage): HTMLImageElement | null {
		if (!image.url || image.unresolved || (!image.isRemote && image.resourcePath === undefined)) return null;
		const key = previewResourceKey(image);
		const index = this.candidates.findIndex(({ item, img }) =>
			item.getAttr("data-preview-resource") === key && img.getAttr("src") === image.url && this.isReady(item, img));
		return index < 0 ? null : this.candidates.splice(index, 1)[0].img;
	}

	invalidate(paths: readonly string[]): void {
		const changed = new Set(paths.map(normalizeImagePath));
		this.candidates = this.candidates.filter(({ item }) =>
			!changed.has(normalizeImagePath(item.getAttr("data-knomo-image-resource") ?? "")));
	}

	private isReady(item: HTMLElement, img: HTMLImageElement): boolean {
		return item.contains(img) && readyPreviews.has(img) && img.complete && img.naturalWidth > 0;
	}
}

export function normalizeImagePath(path: string): string {
	return path.replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase();
}

// 仅缓存当前视图移除的已就绪节点；取出即转移所有权，按图片数量保持有界。
export class MemoCardImageCache {
	private readonly images = new Map<string, { holder: HTMLElement; count: number; paths: Set<string> }>();
	private imageCount = 0;

	constructor(private readonly maxImages = 24) {}

	capture(root: HTMLElement, viewport?: HTMLElement | null, restoreScrollTop?: number): void {
		const bounds = viewport?.getBoundingClientRect();
		const offset = viewport && restoreScrollTop !== undefined ? viewport.scrollTop - restoreScrollTop : 0;
		// 先批量读位置，再移动节点；最靠近当前视口的图片最后收集，优先保留。
		const candidates = root.findAll(".knomo-card-images").map(imagesEl => {
			const rect = bounds ? imagesEl.getBoundingClientRect() : null;
			const distance = rect && bounds ? Math.max(bounds.top - rect.bottom - offset, rect.top + offset - bounds.bottom, 0) : 0;
			return { imagesEl, distance };
		}).sort((a, b) => b.distance - a.distance);
		for (const { imagesEl } of candidates) {
			const key = imagesEl.getAttr("data-knomo-image-occurrence");
			if (!key) continue;
			const ready = imagesEl.findAll(".knomo-card-image-item").filter((item) =>
				!item.hasClass("is-loading") && !item.hasClass("is-error") && item.find("img")?.getAttr("src"));
			if (ready.length === 0 || ready.length > this.maxImages) continue;
			this.remove(key);
			const paths = new Set(ready.map(item => item.getAttr("data-knomo-image-resource")).filter((path): path is string => !!path));
			const holder = root.createDiv();
			holder.remove();
			for (const item of ready) holder.appendChild(item);
			this.images.set(key, { holder, count: ready.length, paths });
			this.imageCount += ready.length;
			while (this.imageCount > this.maxImages) {
				const oldest = this.images.keys().next().value;
				if (oldest === undefined) break;
				this.remove(oldest);
			}
		}
	}

	take(memo: MemoRecord): HTMLElement | null {
		const key = getMemoImageOccurrenceKey(memo);
		return key === null ? null : this.remove(key);
	}

	clear(): void {
		this.images.clear();
		this.imageCount = 0;
	}

	invalidateResourcePaths(paths: readonly string[]): void {
		const normalize = (path: string) => path.replace(/\\/g, "/").toLowerCase();
		const changed = new Set(paths.map(normalize));
		const basenames = new Set([...changed].map(path => path.split("/").pop()));
		for (const [key, entry] of this.images) {
			if ([...entry.paths].some(path => changed.has(normalize(path)) || basenames.has(normalize(path).split("/").pop()))) this.remove(key);
		}
	}

	private remove(key: string): HTMLElement | null {
		const entry = this.images.get(key);
		if (entry === undefined) return null;
		this.images.delete(key);
		this.imageCount -= entry.count;
		return entry.holder;
	}
}

function getMemoImageOccurrenceKey(memo: MemoRecord): string | null {
	const handle = memo.catalog?.observationHandle;
	if (handle === undefined) return null;
	return encodeImageKeyParts([handle.sourcePath, handle.sourceRevision, String(handle.startLine), String(handle.endLine), handle.rawBlockHash]);
}

export function rebindMemoImageOccurrence(card: HTMLElement, memo: MemoRecord): void {
	for (const images of Array.from(card.querySelectorAll(".knomo-card-images"))) {
		images.setAttribute("data-knomo-image-occurrence", getMemoImageOccurrenceKey(memo) ?? "");
	}
}

export function renderMemoCardImages(
	container: HTMLElement,
	memo: MemoRecord,
	images: readonly MemoPreviewImage[],
	labels: RenderMemoCardImagesLabels,
	reusedImagesEl: HTMLElement | null = null,
	handoff?: ReadyCardImageHandoff,
	invalidatedPaths?: ReadonlySet<string>,
): RenderedMemoCardImages | null {
	if (images.length === 0) {
		return null;
	}
	const visibleImages = images.slice(0, MAX_CARD_PREVIEW_IMAGES);
	const sameTarget = reusedImagesEl?.parentElement === container;
	const imagesEl = prepareImagesElement(container, images.length, reusedImagesEl);
	const occurrenceKey = getMemoImageOccurrenceKey(memo);
	imagesEl.setAttr("data-knomo-image-occurrence", occurrenceKey ?? "");
	const previousItems = imagesEl.findAll(".knomo-card-image-item");
	const reusableItems = previousItems.filter(item => {
		if (invalidatedPaths?.has(normalizeImagePath(item.getAttr("data-knomo-image-resource") ?? ""))) return false;
		return sameTarget || (!item.hasClass("is-loading") && !item.hasClass("is-error") && item.find("img")?.getAttr("src"));
	});
	const loadItems: CardImageLoadItem[] = [];
	const desiredItems: HTMLElement[] = [];
	visibleImages.forEach((image, index) => {
		const hiddenCount = index === MAX_CARD_PREVIEW_IMAGES - 1 ? images.length - MAX_CARD_PREVIEW_IMAGES : 0;
		const resourceKey = previewResourceKey(image);
		const match = reusableItems.findIndex(item => item.getAttr("data-preview-resource") === resourceKey);
		let item: HTMLElement;
		if (match >= 0) {
			item = reusableItems.splice(match, 1)[0];
			updateMemoCardImage(item, memo, image, index, hiddenCount);
		} else {
			const loadItem = renderMemoCardImage(imagesEl, memo, image, index, hiddenCount, labels, handoff);
			item = imagesEl.lastElementChild as HTMLElement;
			if (loadItem !== null) loadItems.push(loadItem);
		}
		desiredItems.push(item);
	});
	const removedImages: HTMLImageElement[] = [];
	for (const item of previousItems) {
		if (desiredItems.includes(item)) continue;
		const img = previewNodes.get(item);
		if (img) removedImages.push(img);
		item.remove();
	}
	let next = imagesEl.firstElementChild;
	for (const item of desiredItems) {
		if (item !== next) imagesEl.insertBefore(item, next);
		next = item.nextElementSibling;
	}
	return { imagesEl, loadItems, removedImages };
}

export function parseCardImageIndex(value: string | null): number {
	if (value === null) {
		return 0;
	}
	const index = Number(value);
	return Number.isInteger(index) && index >= 0 ? index : 0;
}

function prepareImagesElement(container: HTMLElement, imageCount: number, reusedImagesEl: HTMLElement | null): HTMLElement {
	const imagesEl = reusedImagesEl ?? container.createDiv();
	imagesEl.removeClass("knomo-card-images--single");
	imagesEl.removeClass("knomo-card-images--grid");
	imagesEl.addClass("knomo-card-images");
	imagesEl.addClass(imageCount === 1 ? "knomo-card-images--single" : "knomo-card-images--grid");
	if (reusedImagesEl !== null && reusedImagesEl.parentElement !== container) {
		container.appendChild(reusedImagesEl);
	}
	return imagesEl;
}

function renderMemoCardImage(
	container: HTMLElement,
	memo: MemoRecord,
	image: MemoPreviewImage,
	index: number,
	hiddenCount: number,
	labels: RenderMemoCardImagesLabels,
	handoff?: ReadyCardImageHandoff,
): CardImageLoadItem | null {
	const item = container.createDiv({
		cls: "knomo-card-image-item",
		attr: { "data-knomo-image-resource": image.isRemote ? "" : image.resourcePath ?? image.path },
	});
	item.setAttr("data-preview-resource", previewResourceKey(image));
	item.setAttr("data-hidden-count", String(hiddenCount));
	const button = item.createEl("button", {
		cls: "knomo-card-image-button",
		attr: {
			type: "button",
			"aria-label": labels.previewLabel,
			"data-knomo-card-image": "true",
			"data-memo-id": memo.id,
			"data-image-index": String(index),
		},
	});
	if (image.url === undefined || image.unresolved === true) {
		button.setAttr("aria-label", labels.unavailableLabel);
		renderMemoCardImagePlaceholder(button, hiddenCount, labels.unavailableLabel);
		return null;
	}
	const readyImage = handoff?.take(image);
	if (readyImage) {
		readyImage.setAttr("alt", image.alt ?? "");
		button.appendChild(readyImage);
		previewNodes.set(item, readyImage);
		if (hiddenCount > 0) renderMemoCardImageMore(button, hiddenCount);
		return null;
	}
	item.addClass("is-loading");
	const imageEl = button.createEl("img", {
		attr: {
			alt: image.alt ?? "",
			decoding: "async",
		},
	});
	previewNodes.set(item, imageEl);
	if (image.isRemote) {
		imageEl.setAttr("fetchpriority", "low");
	}
	const handleLoad = () => {
		readyPreviews.add(imageEl);
		item.removeClass("is-loading");
	};
	let retryLoad: (() => boolean) | undefined;
	const handleError = (retry?: () => boolean) => {
		retryLoad = retry;
		item.removeClass("is-loading");
		item.addClass("is-error");
		button.empty();
		const label = retry && labels.retryLabel ? labels.retryLabel : labels.unavailableLabel;
		button.setAttr("aria-label", label);
		renderMemoCardImagePlaceholder(button, Number(item.getAttr("data-hidden-count")), label);
	};
	button.addEventListener("click", event => {
		if (!retryLoad) return;
		event.preventDefault();
		event.stopPropagation();
		const retry = retryLoad;
		retryLoad = undefined;
		item.removeClass("is-error");
		item.addClass("is-loading");
		button.empty();
		button.appendChild(imageEl);
		button.setAttr("aria-label", labels.previewLabel);
		syncMemoCardImageMore(button, Number(item.getAttr("data-hidden-count")));
		if (!retry()) handleError();
	});
	if (hiddenCount > 0) {
		renderMemoCardImageMore(button, hiddenCount);
	}
	return {
		imageEl,
		src: image.url,
		resourcePath: image.resourcePath,
		priority: index === 0 ? "high" : "low",
		onLoad: handleLoad,
		onError: handleError,
	};
}

function updateMemoCardImage(
	item: HTMLElement,
	memo: MemoRecord,
	image: MemoPreviewImage,
	index: number,
	hiddenCount: number,
): void {
	const button = item.find(".knomo-card-image-button")!;
	const imageEl = previewNodes.get(item);
	button.setAttr("data-memo-id", memo.id);
	button.setAttr("data-image-index", String(index));
	imageEl?.setAttr("alt", image.alt ?? "");
	if (item.getAttr("data-hidden-count") !== String(hiddenCount)) {
		item.setAttr("data-hidden-count", String(hiddenCount));
		syncMemoCardImageMore(button, hiddenCount);
	}
}

function renderMemoCardImagePlaceholder(container: HTMLElement, hiddenCount: number, unavailableLabel: string): void {
	container.createDiv({
		cls: "knomo-card-image-placeholder",
		text: unavailableLabel,
	});
	if (hiddenCount > 0) {
		renderMemoCardImageMore(container, hiddenCount);
	}
}

function renderMemoCardImageMore(container: HTMLElement, hiddenCount: number): void {
	container.createSpan({
		cls: "knomo-card-image-more",
		text: `+${hiddenCount}`,
	});
}

function syncMemoCardImageMore(container: HTMLElement, hiddenCount: number): void {
	for (const moreEl of container.findAll(".knomo-card-image-more")) {
		moreEl.remove();
	}
	if (hiddenCount > 0) {
		renderMemoCardImageMore(container, hiddenCount);
	}
}

function encodeImageKeyParts(parts: readonly string[]): string {
	return parts.map((part) => `${part.length}:${part}`).join("");
}

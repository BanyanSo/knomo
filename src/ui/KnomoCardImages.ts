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
	imagesEl: HTMLElement;
	loadItems: CardImageLoadItem[];
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

export function renderMemoCardImages(
	container: HTMLElement,
	memo: MemoRecord,
	images: readonly MemoPreviewImage[],
	labels: RenderMemoCardImagesLabels,
	reusedImagesEl: HTMLElement | null = null,
): RenderedMemoCardImages | null {
	if (images.length === 0) {
		return null;
	}
	const visibleImages = images.slice(0, MAX_CARD_PREVIEW_IMAGES);
	const imagesEl = prepareImagesElement(container, images.length, reusedImagesEl);
	const occurrenceKey = getMemoImageOccurrenceKey(memo);
	imagesEl.setAttr("data-knomo-image-occurrence", occurrenceKey ?? "");
	const reusableItems = collectReusableImageItems(imagesEl);
	if (reusedImagesEl !== null) {
		imagesEl.empty();
	}
	const loadItems: CardImageLoadItem[] = [];
	visibleImages.forEach((image, index) => {
		const hiddenCount = index === MAX_CARD_PREVIEW_IMAGES - 1 ? images.length - MAX_CARD_PREVIEW_IMAGES : 0;
		const imageKey = getMemoPreviewImageKey(occurrenceKey ?? memo.id, image, index);
		const reusedItem = reusableItems.get(imageKey);
		const loadItem = reusedItem !== undefined && reuseMemoCardImage(imagesEl, reusedItem, memo, image, index, hiddenCount, imageKey, labels)
			? null
			: renderMemoCardImage(imagesEl, memo, image, index, hiddenCount, imageKey, labels);
		if (loadItem !== null) {
			loadItems.push(loadItem);
		}
	});
	return { imagesEl, loadItems };
}

export function parseCardImageIndex(value: string | null): number {
	if (value === null) {
		return 0;
	}
	const index = Number(value);
	return Number.isInteger(index) && index >= 0 ? index : 0;
}

export function getMemoPreviewImageKey(memoId: string, image: MemoPreviewImage, index: number): string {
	const kind = image.isRemote ? "remote" : "local";
	const source = image.isRemote
		? image.url ?? image.path
		: image.resourcePath ?? image.path;
	const version = image.isRemote ? "" : String(image.mtime ?? "");
	const status = image.unresolved === true ? "unresolved" : "resolved";
	return encodeImageKeyParts([memoId, String(index), kind, source, version, status]);
}

function prepareImagesElement(container: HTMLElement, imageCount: number, reusedImagesEl: HTMLElement | null): HTMLElement {
	const imagesEl = reusedImagesEl ?? container.createDiv();
	imagesEl.removeClass("knomo-card-images--single");
	imagesEl.removeClass("knomo-card-images--grid");
	imagesEl.addClass("knomo-card-images");
	imagesEl.addClass(imageCount === 1 ? "knomo-card-images--single" : "knomo-card-images--grid");
	if (reusedImagesEl !== null) {
		container.appendChild(reusedImagesEl);
	}
	return imagesEl;
}

function collectReusableImageItems(imagesEl: HTMLElement): Map<string, HTMLElement> {
	const items = new Map<string, HTMLElement>();
	for (const item of imagesEl.findAll(".knomo-card-image-item")) {
		const imageKey = item.getAttr("data-knomo-image-key");
		if (imageKey !== null && !items.has(imageKey)) {
			items.set(imageKey, item);
		}
	}
	return items;
}

function renderMemoCardImage(
	container: HTMLElement,
	memo: MemoRecord,
	image: MemoPreviewImage,
	index: number,
	hiddenCount: number,
	imageKey: string,
	labels: RenderMemoCardImagesLabels,
): CardImageLoadItem | null {
	const item = container.createDiv({
		cls: "knomo-card-image-item",
		attr: { "data-knomo-image-key": imageKey, "data-knomo-image-resource": image.isRemote ? "" : image.resourcePath ?? image.path },
	});
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
		renderMemoCardImagePlaceholder(button, hiddenCount, labels.unavailableLabel);
		return null;
	}
	item.addClass("is-loading");
	const imageEl = button.createEl("img", {
		attr: {
			alt: image.alt ?? "",
			decoding: "async",
		},
	});
	if (image.isRemote) {
		imageEl.setAttr("fetchpriority", "low");
	}
	const handleLoad = () => {
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
		renderMemoCardImagePlaceholder(button, hiddenCount, label);
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
		if (hiddenCount > 0) renderMemoCardImageMore(button, hiddenCount);
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

function reuseMemoCardImage(
	container: HTMLElement,
	item: HTMLElement,
	memo: MemoRecord,
	image: MemoPreviewImage,
	index: number,
	hiddenCount: number,
	imageKey: string,
	labels: RenderMemoCardImagesLabels,
): boolean {
	if (image.url === undefined || image.unresolved === true || item.hasClass("is-loading") || item.hasClass("is-error")) {
		return false;
	}
	const button = item.find(".knomo-card-image-button");
	const imageEl = item.find("img");
	if (
		button === null
		|| imageEl === null
		|| imageEl.getAttr("src") !== image.url
	) {
		return false;
	}
	item.setAttr("data-knomo-image-key", imageKey);
	button.setAttr("aria-label", labels.previewLabel);
	button.setAttr("data-memo-id", memo.id);
	button.setAttr("data-image-index", String(index));
	imageEl.setAttr("alt", image.alt ?? "");
	syncMemoCardImageMore(button, hiddenCount);
	container.appendChild(item);
	return true;
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

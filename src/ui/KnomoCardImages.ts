import type { MemoViewItem as MemoRecord } from "../types/memoView";
import type { CardImageLoadItem } from "./CardImageLoadQueue";
import type { MemoPreviewImage } from "./MemoCardPreview";

const MAX_CARD_PREVIEW_IMAGES = 3;

interface RenderMemoCardImagesLabels {
	previewLabel: string;
	unavailableLabel: string;
}

export interface RenderedMemoCardImages {
	imagesEl: HTMLElement;
	loadItems: CardImageLoadItem[];
}

export interface MemoCardImageLoadPlan {
	observedLoadItems: CardImageLoadItem[];
	eagerLoadItems: CardImageLoadItem[];
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
	const reusableItems = collectReusableImageItems(imagesEl);
	if (reusedImagesEl !== null) {
		imagesEl.empty();
	}
	const loadItems: CardImageLoadItem[] = [];
	visibleImages.forEach((image, index) => {
		const hiddenCount = index === MAX_CARD_PREVIEW_IMAGES - 1 ? images.length - MAX_CARD_PREVIEW_IMAGES : 0;
		const imageKey = getMemoPreviewImageKey(memo.id, image, index);
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

export function planMemoCardImageLoads(
	loadItems: readonly CardImageLoadItem[],
	eagerFirstImage: boolean,
): MemoCardImageLoadPlan {
	if (!eagerFirstImage || loadItems.length === 0) {
		return {
			observedLoadItems: [...loadItems],
			eagerLoadItems: [],
		};
	}
	const firstLoadItem = loadItems[0];
	if (firstLoadItem === undefined) {
		return {
			observedLoadItems: [],
			eagerLoadItems: [],
		};
	}
	return {
		observedLoadItems: loadItems.slice(1),
		eagerLoadItems: [firstLoadItem],
	};
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
		attr: { "data-knomo-image-key": imageKey },
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
	const handleError = () => {
		item.removeClass("is-loading");
		item.addClass("is-error");
		button.empty();
		renderMemoCardImagePlaceholder(button, hiddenCount, labels.unavailableLabel);
	};
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

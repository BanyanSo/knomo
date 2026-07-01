import type { MemoRecord } from "../types/memo";
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

export function renderMemoCardImages(
	container: HTMLElement,
	memo: MemoRecord,
	images: readonly MemoPreviewImage[],
	labels: RenderMemoCardImagesLabels,
): RenderedMemoCardImages | null {
	if (images.length === 0) {
		return null;
	}
	const visibleImages = images.slice(0, MAX_CARD_PREVIEW_IMAGES);
	const imagesEl = container.createDiv({
		cls: images.length === 1
			? "knomo-card-images knomo-card-images--single"
			: "knomo-card-images knomo-card-images--grid",
	});
	const loadItems: CardImageLoadItem[] = [];
	visibleImages.forEach((image, index) => {
		const hiddenCount = index === MAX_CARD_PREVIEW_IMAGES - 1 ? images.length - MAX_CARD_PREVIEW_IMAGES : 0;
		const loadItem = renderMemoCardImage(imagesEl, memo, image, index, hiddenCount, labels);
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

function renderMemoCardImage(
	container: HTMLElement,
	memo: MemoRecord,
	image: MemoPreviewImage,
	index: number,
	hiddenCount: number,
	labels: RenderMemoCardImagesLabels,
): CardImageLoadItem | null {
	const item = container.createDiv({ cls: "knomo-card-image-item" });
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
	const imageEl = button.createEl("img", {
		attr: {
			alt: image.alt ?? "",
			decoding: "async",
		},
	});
	if (image.isRemote) {
		imageEl.setAttr("fetchpriority", "low");
	}
	const handleError = () => {
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
		onError: handleError,
	};
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

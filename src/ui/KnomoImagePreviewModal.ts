import { Modal, Platform, setIcon } from "obsidian";
import type { App } from "obsidian";

import { t } from "../i18n";
import type { MemoPreviewImage } from "./MemoCardPreview";

interface KnomoImagePreviewModalOptions {
	images: readonly MemoPreviewImage[];
	initialIndex: number;
	lockCardFlowScroll: () => void;
	unlockCardFlowScroll: () => void;
	loadImage: (request: ImagePreviewLoadRequest) => void;
	clearImageLoads: () => void;
}

interface ImagePreviewLoadRequest {
	targetEl: HTMLElement;
	imageEl: HTMLImageElement;
	image: MemoPreviewImage;
	priority: "high" | "low";
	allowDisconnected?: boolean;
	onLoad?: () => void;
	onError?: () => void;
}

interface TouchStartState {
	x: number;
	y: number;
	startedAt: number;
	horizontal: boolean;
}

type ImageConstructor = new (width?: number, height?: number) => HTMLImageElement;

const TOUCH_EDGE_GUARD = 24;
const TOUCH_INTENT_THRESHOLD = 12;
const TOUCH_INTENT_RATIO = 1.25;
const TOUCH_SWIPE_THRESHOLD = 48;
const TOUCH_QUICK_SWIPE_THRESHOLD = 24;
const TOUCH_QUICK_SWIPE_DURATION = 220;
const TOUCH_HORIZONTAL_RATIO = 1.5;
const TOUCH_CLICK_SUPPRESSION_MS = 400;

export class KnomoImagePreviewModal extends Modal {
	private readonly images: readonly MemoPreviewImage[];
	private readonly lockCardFlowScroll: () => void;
	private readonly unlockCardFlowScroll: () => void;
	private readonly loadImage: (request: ImagePreviewLoadRequest) => void;
	private readonly clearImageLoads: () => void;
	private currentIndex: number;
	private stageEl: HTMLElement | null = null;
	private counterEl: HTMLElement | null = null;
	private touchStart: TouchStartState | null = null;
	private suppressStageClickUntil = 0;
	private renderGeneration = 0;
	private readonly preloadedImageUrls = new Set<string>();
	private readonly preloadImages = new Map<string, HTMLImageElement>();

	constructor(app: App, options: KnomoImagePreviewModalOptions) {
		super(app);
		this.images = options.images;
		this.currentIndex = clampImageIndex(options.initialIndex, options.images.length);
		this.lockCardFlowScroll = options.lockCardFlowScroll;
		this.unlockCardFlowScroll = options.unlockCardFlowScroll;
		this.loadImage = options.loadImage;
		this.clearImageLoads = options.clearImageLoads;
	}

	onOpen(): void {
		this.lockCardFlowScroll();
		this.containerEl.addClass("knomo-image-preview-backdrop");
		this.containerEl.toggleClass("knomo-image-preview-backdrop--mobile", Platform.isMobile);
		this.modalEl.addClass("knomo-image-preview-modal");
		this.titleEl.setText(t("image.previewLabel"));
		this.contentEl.empty();

		const closeButton = this.modalEl.createEl("button", {
			cls: "knomo-image-preview-close",
			attr: {
				type: "button",
				"aria-label": t("image.closePreview"),
			},
		});
		setIcon(closeButton, "x");
		closeButton.addEventListener("click", this.handleCloseClick);

		const stage = this.contentEl.createDiv({ cls: "knomo-image-preview-stage" });
		this.stageEl = stage;
		stage.addEventListener("click", this.handleStageClick);
		stage.addEventListener("touchstart", this.handleTouchStart);
		stage.addEventListener("touchmove", this.handleTouchMove, { passive: false });
		stage.addEventListener("touchend", this.handleTouchEnd);
		stage.addEventListener("touchcancel", this.handleTouchCancel);

		if (this.images.length > 1) {
			const previousButton = this.contentEl.createEl("button", {
				cls: "knomo-image-preview-nav knomo-image-preview-nav--previous",
				attr: {
					type: "button",
					"aria-label": t("image.previous"),
				},
			});
			setIcon(previousButton, "chevron-left");
			previousButton.addEventListener("click", this.handlePreviousClick);

			const nextButton = this.contentEl.createEl("button", {
				cls: "knomo-image-preview-nav knomo-image-preview-nav--next",
				attr: {
					type: "button",
					"aria-label": t("image.next"),
				},
			});
			setIcon(nextButton, "chevron-right");
			nextButton.addEventListener("click", this.handleNextClick);
		}

		const footer = this.contentEl.createDiv({ cls: "knomo-image-preview-footer" });
		this.counterEl = footer.createDiv({ cls: "knomo-image-preview-counter" });

		this.containerEl.win.addEventListener("keydown", this.handleKeydown);
		this.renderCurrentImage();
	}

	onClose(): void {
		this.containerEl.win.removeEventListener("keydown", this.handleKeydown);
		if (this.stageEl !== null) {
			this.stageEl.removeEventListener("click", this.handleStageClick);
			this.stageEl.removeEventListener("touchstart", this.handleTouchStart);
			this.stageEl.removeEventListener("touchmove", this.handleTouchMove);
			this.stageEl.removeEventListener("touchend", this.handleTouchEnd);
			this.stageEl.removeEventListener("touchcancel", this.handleTouchCancel);
		}
		this.stageEl = null;
		this.counterEl = null;
		this.touchStart = null;
		this.suppressStageClickUntil = 0;
		this.renderGeneration += 1;
		this.clearImageLoads();
		this.preloadedImageUrls.clear();
		this.preloadImages.clear();
		this.unlockCardFlowScroll();
		this.contentEl.empty();
	}

	private renderCurrentImage(): void {
		const stage = this.stageEl;
		if (stage === null) {
			return;
		}
		const image = this.images[this.currentIndex];
		const renderGeneration = ++this.renderGeneration;
		this.clearImageLoads();
		setImagePreviewLoadingState(stage, false);
		stage.empty();
		if (image === undefined || image.url === undefined || image.unresolved === true) {
			this.renderPlaceholder(stage);
		} else {
			setImagePreviewLoadingState(stage, true);
			this.preloadedImageUrls.add(image.url);
			const img = stage.createEl("img", {
				cls: "knomo-image-preview-img",
				attr: {
					alt: image.alt ?? "",
					decoding: "async",
				},
			});
			this.loadImage({
				targetEl: stage,
				imageEl: img,
				image,
				priority: "high",
				onLoad: () => {
					if (this.stageEl === stage && this.renderGeneration === renderGeneration) {
						setImagePreviewLoadingState(stage, false);
						this.preloadAdjacentImage(stage);
					}
				},
				onError: () => {
					if (this.stageEl === stage && this.renderGeneration === renderGeneration) {
						setImagePreviewLoadingState(stage, false);
						stage.empty();
						this.renderLoadError(stage);
					}
				},
			});
		}
		this.syncFooter();
	}

	private renderPlaceholder(container: HTMLElement): void {
		container.createDiv({
			cls: "knomo-card-image-placeholder knomo-image-preview-placeholder",
			text: t("image.unavailable"),
		});
	}

	private renderLoadError(container: HTMLElement): void {
		container.createDiv({
			cls: "knomo-image-preview-error",
			text: t("image.loadFailed"),
			attr: {
				role: "status",
				"aria-live": "polite",
			},
		});
	}

	private preloadAdjacentImage(stage: HTMLElement): void {
		for (const index of getAdjacentImageIndexes(this.currentIndex, this.images.length)) {
			const image = this.images[index];
			if (image === undefined || image.url === undefined || image.unresolved === true) {
				continue;
			}
			if (this.preloadedImageUrls.has(image.url)) {
				continue;
			}
			this.preloadedImageUrls.add(image.url);
			const ImageClass = (this.containerEl.win as Window & { Image: ImageConstructor }).Image;
			const preloadImage = new ImageClass();
			preloadImage.decoding = "async";
			this.preloadImages.set(image.url, preloadImage);
			this.loadImage({
				targetEl: stage,
				imageEl: preloadImage,
				image,
				priority: "low",
				allowDisconnected: true,
			});
			return;
		}
	}

	private syncFooter(): void {
		if (this.counterEl !== null) {
			this.counterEl.setText(t("image.counter", { current: this.currentIndex + 1, total: this.images.length }));
		}
	}

	private showPreviousImage(): void {
		if (this.images.length <= 1) {
			return;
		}
		this.currentIndex = (this.currentIndex - 1 + this.images.length) % this.images.length;
		this.renderCurrentImage();
	}

	private showNextImage(): void {
		if (this.images.length <= 1) {
			return;
		}
		this.currentIndex = (this.currentIndex + 1) % this.images.length;
		this.renderCurrentImage();
	}

	private readonly handleCloseClick = (event: MouseEvent): void => {
		event.preventDefault();
		this.close();
	};

	private readonly handleStageClick = (event: MouseEvent): void => {
		if (this.containerEl.win.performance.now() < this.suppressStageClickUntil) {
			this.suppressStageClickUntil = 0;
			event.preventDefault();
			event.stopPropagation();
			return;
		}
		this.suppressStageClickUntil = 0;
		if (event.target === this.stageEl) {
			event.preventDefault();
			this.close();
		}
	};

	private readonly handlePreviousClick = (event: MouseEvent): void => {
		event.preventDefault();
		event.stopPropagation();
		this.showPreviousImage();
	};

	private readonly handleNextClick = (event: MouseEvent): void => {
		event.preventDefault();
		event.stopPropagation();
		this.showNextImage();
	};

	private readonly handleKeydown = (event: KeyboardEvent): void => {
		if (event.key === "Escape") {
			event.preventDefault();
			this.close();
			return;
		}
		if (event.key === "ArrowLeft") {
			event.preventDefault();
			this.showPreviousImage();
			return;
		}
		if (event.key === "ArrowRight") {
			event.preventDefault();
			this.showNextImage();
		}
	};

	private readonly handleTouchStart = (event: TouchEvent): void => {
		if (event.touches.length !== 1) {
			this.touchStart = null;
			return;
		}
		const touch = event.touches[0];
		const width = this.containerEl.win.innerWidth;
		if (touch.clientX <= TOUCH_EDGE_GUARD || touch.clientX >= width - TOUCH_EDGE_GUARD) {
			this.touchStart = null;
			return;
		}
		this.touchStart = {
			x: touch.clientX,
			y: touch.clientY,
			startedAt: event.timeStamp,
			horizontal: false,
		};
	};

	private readonly handleTouchMove = (event: TouchEvent): void => {
		if (this.touchStart === null || event.touches.length !== 1) {
			this.touchStart = null;
			return;
		}
		const touch = event.touches[0];
		const deltaX = touch.clientX - this.touchStart.x;
		const deltaY = touch.clientY - this.touchStart.y;
		if (hasHorizontalIntent(deltaX, deltaY)) {
			this.touchStart.horizontal = true;
			event.preventDefault();
			event.stopPropagation();
		}
	};

	private readonly handleTouchEnd = (event: TouchEvent): void => {
		if (this.touchStart === null) {
			return;
		}
		const touchStart = this.touchStart;
		this.touchStart = null;
		if (event.touches.length !== 0 || event.changedTouches.length !== 1) {
			return;
		}
		const touch = event.changedTouches[0];
		const deltaX = touch.clientX - touchStart.x;
		const deltaY = touch.clientY - touchStart.y;
		const direction = getImageSwipeDirection(deltaX, deltaY, event.timeStamp - touchStart.startedAt);
		if (touchStart.horizontal || direction !== null) {
			event.preventDefault();
			event.stopPropagation();
			this.suppressStageClickUntil = this.containerEl.win.performance.now() + TOUCH_CLICK_SUPPRESSION_MS;
		}
		if (direction === "next") {
			this.showNextImage();
		} else if (direction === "previous") {
			this.showPreviousImage();
		}
	};

	private readonly handleTouchCancel = (): void => {
		this.touchStart = null;
	};
}

function clampImageIndex(index: number, imageCount: number): number {
	if (imageCount <= 0) {
		return 0;
	}
	return Math.min(Math.max(index, 0), imageCount - 1);
}

function hasHorizontalIntent(deltaX: number, deltaY: number): boolean {
	const absX = Math.abs(deltaX);
	const absY = Math.abs(deltaY);
	return absX >= TOUCH_INTENT_THRESHOLD && absX > absY * TOUCH_INTENT_RATIO;
}

export function getImageSwipeDirection(
	deltaX: number,
	deltaY: number,
	duration: number,
): "previous" | "next" | null {
	const absX = Math.abs(deltaX);
	const absY = Math.abs(deltaY);
	const threshold = duration <= TOUCH_QUICK_SWIPE_DURATION
		? TOUCH_QUICK_SWIPE_THRESHOLD
		: TOUCH_SWIPE_THRESHOLD;
	if (absX < threshold || absX <= absY * TOUCH_HORIZONTAL_RATIO) {
		return null;
	}
	return deltaX < 0 ? "next" : "previous";
}

export function getAdjacentImageIndexes(currentIndex: number, imageCount: number): number[] {
	if (imageCount <= 1) {
		return [];
	}
	const current = clampImageIndex(currentIndex, imageCount);
	const indexes = [
		(current + 1) % imageCount,
		(current - 1 + imageCount) % imageCount,
	];
	return indexes.filter((index, position) => index !== current && indexes.indexOf(index) === position);
}

export function setImagePreviewLoadingState(stage: HTMLElement, loading: boolean): void {
	stage.toggleClass("is-loading", loading);
	if (loading) {
		stage.setAttr("aria-busy", "true");
		return;
	}
	stage.removeAttribute("aria-busy");
}

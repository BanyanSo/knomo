import { Modal, Platform, setIcon } from "obsidian";
import type { App } from "obsidian";

import { t } from "../i18n";
import type { MemoPreviewImage } from "./MemoCardPreview";
import { removeObsidianModalCloseButtons } from "./ObsidianModalCloseButton";

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

interface CachedPreviewImage {
	imageEl: HTMLImageElement;
	ready: boolean;
}

interface PanStartState { x: number; y: number; panX: number; panY: number; startedAt?: number; dragging?: boolean }

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
	private readonly preloadImages = new Map<string, CachedPreviewImage>();
	private currentImageEl: HTMLImageElement | null = null;
	private zoomScale = 1;
	private panX = 0;
	private panY = 0;
	private panStart: PanStartState | null = null;
	private pinchStart: { distance: number; scale: number; x: number; y: number; anchorX: number; anchorY: number; panX: number; panY: number } | null = null;
	private lastTap: { at: number; x: number; y: number } | null = null;

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
		removeObsidianModalCloseButtons(this.modalEl);
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
		stage.addEventListener("dblclick", this.handleDoubleClick);
		stage.addEventListener("pointerdown", this.handlePointerDown);
		stage.addEventListener("pointermove", this.handlePointerMove);
		stage.addEventListener("pointerup", this.handlePointerEnd);
		stage.addEventListener("pointercancel", this.handlePointerEnd);
		stage.addEventListener("touchstart", this.handleTouchStart, { passive: false });
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
			this.stageEl.removeEventListener("dblclick", this.handleDoubleClick);
			this.stageEl.removeEventListener("pointerdown", this.handlePointerDown);
			this.stageEl.removeEventListener("pointermove", this.handlePointerMove);
			this.stageEl.removeEventListener("pointerup", this.handlePointerEnd);
			this.stageEl.removeEventListener("pointercancel", this.handlePointerEnd);
			this.stageEl.removeEventListener("touchstart", this.handleTouchStart);
			this.stageEl.removeEventListener("touchmove", this.handleTouchMove);
			this.stageEl.removeEventListener("touchend", this.handleTouchEnd);
			this.stageEl.removeEventListener("touchcancel", this.handleTouchCancel);
		}
		this.stageEl = null;
		this.counterEl = null;
		this.currentImageEl = null;
		this.panStart = null;
		this.pinchStart = null;
		this.lastTap = null;
		this.touchStart = null;
		this.suppressStageClickUntil = 0;
		this.renderGeneration += 1;
		this.clearImageLoads();
		for (const entry of this.preloadImages.values()) entry.imageEl.removeAttribute("src");
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
		// 仅保留已解码的当前及前后邻图；取消中的预载不得被误当作成功。
		const retained = new Set([this.currentIndex, ...getAdjacentImageIndexes(this.currentIndex, this.images.length)]
			.map(index => this.images[index]?.url));
		for (const [url, entry] of this.preloadImages) {
			if (!entry.ready || !retained.has(url)) {
				entry.imageEl.removeAttribute("src");
				this.preloadImages.delete(url);
			}
		}
		this.panStart = null;
		this.pinchStart = null;
		this.touchStart = null;
		this.lastTap = null;
		this.currentImageEl = null;
		this.setZoom(1);
		setImagePreviewLoadingState(stage, false);
		stage.toggleClass("is-error", false);
		stage.empty();
		if (image === undefined || image.url === undefined || image.unresolved === true) {
			this.renderPlaceholder(stage);
		} else {
			setImagePreviewLoadingState(stage, true);
			const cached = this.preloadImages.get(image.url);
			const img = cached?.imageEl ?? stage.createEl("img");
			stage.appendChild(img);
			img.addClass("knomo-image-preview-img");
			img.alt = image.alt ?? "";
			img.decoding = "async";
			img.draggable = false;
			this.currentImageEl = img;
			this.setZoom(1);
			if (cached?.ready) {
				setImagePreviewLoadingState(stage, false);
				this.preloadAdjacentImage(stage);
				this.syncFooter();
				return;
			}
			const entry = { imageEl: img, ready: false };
			this.preloadImages.set(image.url, entry);
			this.loadImage({
				targetEl: stage,
				imageEl: img,
				image,
				priority: "high",
				onLoad: () => {
					if (this.stageEl === stage && this.renderGeneration === renderGeneration) {
						entry.ready = true;
						setImagePreviewLoadingState(stage, false);
						this.preloadAdjacentImage(stage);
					}
				},
				onError: () => {
					if (this.stageEl === stage && this.renderGeneration === renderGeneration) {
						this.preloadImages.delete(image.url!);
						img.removeAttribute("src");
						this.currentImageEl = null;
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
		container.addClass("is-error");
		container.createDiv({
			cls: "knomo-image-preview-error",
			text: t("image.loadFailed"),
			attr: {
				role: "status",
				"aria-live": "polite",
			},
		});
		const generation = this.renderGeneration;
		const retry = container.createEl("button", { cls: "knomo-image-preview-action knomo-image-preview-retry",
			text: t("image.retry"), attr: { type: "button" } });
		retry.addEventListener("click", event => {
			event.preventDefault();
			event.stopPropagation();
			if (retry.disabled || generation !== this.renderGeneration || container !== this.stageEl) return;
			retry.disabled = true;
			this.renderCurrentImage();
		});
	}

	private preloadAdjacentImage(stage: HTMLElement): void {
		for (const index of getAdjacentImageIndexes(this.currentIndex, this.images.length)) {
			const image = this.images[index];
			if (image === undefined || image.url === undefined || image.unresolved === true) {
				continue;
			}
			if (this.preloadImages.has(image.url)) {
				continue;
			}
			const ImageClass = (this.containerEl.win as Window & { Image: ImageConstructor }).Image;
			const preloadImage = new ImageClass();
			preloadImage.decoding = "async";
			const entry = { imageEl: preloadImage, ready: false };
			const generation = this.renderGeneration;
			this.preloadImages.set(image.url, entry);
			this.loadImage({
				targetEl: stage,
				imageEl: preloadImage,
				image,
				priority: "low",
				allowDisconnected: true,
				onLoad: () => {
					if (this.renderGeneration === generation && this.preloadImages.get(image.url!) === entry) entry.ready = true;
				},
				onError: () => {
					if (this.renderGeneration === generation && this.preloadImages.get(image.url!) === entry) {
						preloadImage.removeAttribute("src");
						this.preloadImages.delete(image.url!);
					}
				},
			});
			return;
		}
	}

	private syncFooter(): void {
		if (this.counterEl !== null) {
			this.counterEl.setText(t("image.counter", { current: this.currentIndex + 1, total: this.images.length }));
		}
	}

	private setZoom(scale: number, x = 0, y = 0): void {
		this.zoomScale = Math.max(1, Math.min(8, scale));
		const img = this.currentImageEl;
		const stage = this.stageEl;
		const maxX = Math.max(0, ((img?.offsetWidth ?? 0) * this.zoomScale - (stage?.clientWidth ?? 0)) / 2);
		const maxY = Math.max(0, ((img?.offsetHeight ?? 0) * this.zoomScale - (stage?.clientHeight ?? 0)) / 2);
		this.panX = this.zoomScale === 1 ? 0 : Math.max(-maxX, Math.min(maxX, x));
		this.panY = this.zoomScale === 1 ? 0 : Math.max(-maxY, Math.min(maxY, y));
		img?.setCssProps({ "--knomo-preview-scale": String(this.zoomScale),
			"--knomo-preview-x": `${this.panX}px`, "--knomo-preview-y": `${this.panY}px` });
		stage?.toggleClass("is-zoomed", this.zoomScale > 1);
	}

	private toggleZoom(): void {
		if (!this.currentImageEl) return;
		const widthScale = (this.stageEl?.clientWidth ?? 0) / Math.max(1, this.currentImageEl.offsetWidth);
		this.setZoom(this.zoomScale > 1 ? 1 : Math.max(2, widthScale));
	}

	private movePan(x: number, y: number): void {
		if (this.panStart) this.setZoom(this.zoomScale,
			this.panStart.panX + x - this.panStart.x, this.panStart.panY + y - this.panStart.y);
	}

	private handleTap(x: number, y: number, at: number): void {
		if (this.lastTap && at - this.lastTap.at < 300 && Math.hypot(x - this.lastTap.x, y - this.lastTap.y) < 40) {
			this.lastTap = null;
			this.toggleZoom();
			this.suppressStageClickUntil = this.containerEl.win.performance.now() + TOUCH_CLICK_SUPPRESSION_MS;
		} else this.lastTap = { at, x, y };
	}

	private readonly handleDoubleClick = (event: MouseEvent): void => {
		if (this.containerEl.win.performance.now() < this.suppressStageClickUntil) return;
		if (event.target !== this.currentImageEl) return;
		event.preventDefault();
		this.toggleZoom();
	};

	private readonly handlePointerDown = (event: PointerEvent): void => {
		if (event.pointerType !== "mouse" || this.zoomScale <= 1 || event.button !== 0) return;
		this.panStart = { x: event.clientX, y: event.clientY, panX: this.panX, panY: this.panY };
	};
	private readonly handlePointerMove = (event: PointerEvent): void => {
		const pan = this.panStart;
		if (event.pointerType !== "mouse" || !pan) return;
		if ((event.buttons & 1) === 0) { this.handlePointerEnd(event); return; }
		// 确认拖动后再捕获，避免普通双击被重定向到舞台或触发点击抑制。
		if (!pan.dragging) {
			if (Math.hypot(event.clientX - pan.x, event.clientY - pan.y) < TOUCH_INTENT_THRESHOLD) return;
			pan.dragging = true;
			this.stageEl?.setPointerCapture(event.pointerId);
		}
		event.preventDefault();
		this.movePan(event.clientX, event.clientY);
	};
	private readonly handlePointerEnd = (event: PointerEvent): void => {
		if (event.pointerType !== "mouse") return;
		if (this.panStart?.dragging) this.suppressStageClickUntil = this.containerEl.win.performance.now() + TOUCH_CLICK_SUPPRESSION_MS;
		this.panStart = null;
	};

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
			event.preventDefault();
			event.stopPropagation();
			return;
		}
		this.suppressStageClickUntil = 0;
		if (event.target === this.stageEl && this.zoomScale === 1) {
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
		if (event.key === "+" || event.key === "=") {
			event.preventDefault(); this.setZoom(this.zoomScale * 1.5, this.panX, this.panY); return;
		}
		if (event.key === "-" || event.key === "0") {
			event.preventDefault(); this.setZoom(event.key === "0" ? 1 : this.zoomScale / 1.5, this.panX, this.panY); return;
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
		if (event.touches.length === 2 && this.currentImageEl) {
			const [first, second] = [event.touches[0], event.touches[1]];
			const rect = this.stageEl!.getBoundingClientRect();
			const x = (first.clientX + second.clientX) / 2;
			const y = (first.clientY + second.clientY) / 2;
			this.touchStart = null;
			this.panStart = null;
			this.lastTap = null;
			this.pinchStart = { distance: Math.max(1, Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY)),
				scale: this.zoomScale, x, y, anchorX: x - rect.left - rect.width / 2, anchorY: y - rect.top - rect.height / 2,
				panX: this.panX, panY: this.panY };
			event.preventDefault();
			return;
		}
		if (event.touches.length !== 1) {
			this.touchStart = null;
			this.panStart = null;
			this.pinchStart = null;
			return;
		}
		const touch = event.touches[0];
		if (this.zoomScale > 1) {
			this.touchStart = null;
			this.panStart = { x: touch.clientX, y: touch.clientY, panX: this.panX, panY: this.panY, startedAt: event.timeStamp };
			event.preventDefault();
			return;
		}
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
		if (this.pinchStart && event.touches.length === 2) {
			const [first, second] = [event.touches[0], event.touches[1]];
			const distance = Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY);
			const scale = Math.max(1, Math.min(8, this.pinchStart.scale * distance / this.pinchStart.distance));
			const factor = scale / this.pinchStart.scale;
			this.setZoom(scale,
				this.pinchStart.anchorX - (this.pinchStart.anchorX - this.pinchStart.panX) * factor + (first.clientX + second.clientX) / 2 - this.pinchStart.x,
				this.pinchStart.anchorY - (this.pinchStart.anchorY - this.pinchStart.panY) * factor + (first.clientY + second.clientY) / 2 - this.pinchStart.y);
			event.preventDefault(); event.stopPropagation(); return;
		}
		if (this.panStart && event.touches.length === 1) {
			this.movePan(event.touches[0].clientX, event.touches[0].clientY);
			event.preventDefault(); event.stopPropagation(); return;
		}
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
		if (this.pinchStart || this.panStart) {
			const pan = this.panStart;
			const touch = event.changedTouches[0];
			if (!this.pinchStart && pan?.startedAt !== undefined && event.changedTouches.length === 1 && event.touches.length === 0
				&& event.timeStamp - pan.startedAt < 250 && Math.hypot(touch.clientX - pan.x, touch.clientY - pan.y) < TOUCH_INTENT_THRESHOLD) {
				this.handleTap(touch.clientX, touch.clientY, event.timeStamp);
			} else this.lastTap = null;
			// 缩放和平移结束不交给翻页手势；余下一指也需重新起手。
			this.pinchStart = null;
			this.panStart = null;
			this.touchStart = null;
			this.suppressStageClickUntil = this.containerEl.win.performance.now() + TOUCH_CLICK_SUPPRESSION_MS;
			return;
		}
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
		if (Math.hypot(deltaX, deltaY) < TOUCH_INTENT_THRESHOLD && event.timeStamp - touchStart.startedAt < 250) {
			this.handleTap(touch.clientX, touch.clientY, event.timeStamp);
			return;
		}
		this.lastTap = null;
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
		this.panStart = null;
		this.pinchStart = null;
		this.lastTap = null;
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

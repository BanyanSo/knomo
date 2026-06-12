import { Modal, setIcon } from "obsidian";
import type { App } from "obsidian";

import { t } from "../i18n";
import type { MemoPreviewImage } from "./MemoCardPreview";

interface KnomoImagePreviewModalOptions {
	images: MemoPreviewImage[];
	initialIndex: number;
	lockCardFlowScroll: () => void;
	unlockCardFlowScroll: () => void;
}

interface TouchStartState {
	x: number;
	y: number;
	horizontal: boolean;
}

const TOUCH_EDGE_GUARD = 28;
const TOUCH_SWIPE_THRESHOLD = 40;
const TOUCH_HORIZONTAL_RATIO = 1.5;

export class KnomoImagePreviewModal extends Modal {
	private readonly images: MemoPreviewImage[];
	private readonly lockCardFlowScroll: () => void;
	private readonly unlockCardFlowScroll: () => void;
	private currentIndex: number;
	private stageEl: HTMLElement | null = null;
	private counterEl: HTMLElement | null = null;
	private touchStart: TouchStartState | null = null;

	constructor(app: App, options: KnomoImagePreviewModalOptions) {
		super(app);
		this.images = options.images;
		this.currentIndex = clampImageIndex(options.initialIndex, options.images.length);
		this.lockCardFlowScroll = options.lockCardFlowScroll;
		this.unlockCardFlowScroll = options.unlockCardFlowScroll;
	}

	onOpen(): void {
		this.lockCardFlowScroll();
		this.containerEl.addClass("knomo-image-preview-backdrop");
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
		this.unlockCardFlowScroll();
		this.contentEl.empty();
	}

	private renderCurrentImage(): void {
		const stage = this.stageEl;
		if (stage === null) {
			return;
		}
		const image = this.images[this.currentIndex];
		stage.empty();
		if (image === undefined || image.url === undefined || image.unresolved === true) {
			this.renderPlaceholder(stage);
		} else {
			const img = stage.createEl("img", {
				cls: "knomo-image-preview-img",
				attr: {
					src: image.url,
					alt: image.alt ?? "",
				},
			});
			img.addEventListener("error", () => {
				if (this.stageEl === stage && this.images[this.currentIndex] === image) {
					stage.empty();
					this.renderPlaceholder(stage);
				}
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
		const touch = event.touches[0];
		if (touch === undefined) {
			this.touchStart = null;
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
			horizontal: false,
		};
	};

	private readonly handleTouchMove = (event: TouchEvent): void => {
		if (this.touchStart === null) {
			return;
		}
		const touch = event.touches[0];
		if (touch === undefined) {
			return;
		}
		const deltaX = touch.clientX - this.touchStart.x;
		const deltaY = touch.clientY - this.touchStart.y;
		if (isHorizontalSwipe(deltaX, deltaY)) {
			this.touchStart.horizontal = true;
		}
		if (this.touchStart.horizontal) {
			event.preventDefault();
			event.stopPropagation();
		}
	};

	private readonly handleTouchEnd = (event: TouchEvent): void => {
		if (this.touchStart === null) {
			return;
		}
		const touch = event.changedTouches[0];
		const touchStart = this.touchStart;
		this.touchStart = null;
		if (touch === undefined) {
			return;
		}
		const deltaX = touch.clientX - touchStart.x;
		const deltaY = touch.clientY - touchStart.y;
		if (!touchStart.horizontal || !isHorizontalSwipe(deltaX, deltaY)) {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		if (deltaX < 0) {
			this.showNextImage();
		} else {
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

function isHorizontalSwipe(deltaX: number, deltaY: number): boolean {
	const absX = Math.abs(deltaX);
	const absY = Math.abs(deltaY);
	return absX > TOUCH_SWIPE_THRESHOLD && absX > absY * TOUCH_HORIZONTAL_RATIO;
}

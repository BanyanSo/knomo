import {
	attachMobileComposerLayer,
	clearMobileComposerLayerState,
	createMobileComposerLayer,
	isComposerInMobileLayer,
	moveComposerToMobileLayer,
	restoreComposerFromMobileLayer,
} from "./MobileComposerLayer";
import {
	calculateMobileComposerMeasurements,
	calculateMobileKeyboardMetrics,
	calculateMobileKeyboardToolbarGapCorrection,
	getMobileKeyboardFallbackHeight,
} from "./mobileComposerMetrics";

const MOBILE_COMPOSER_TOP_GUARD = 52;

export type MobileComposerPhase = "closed" | "opening" | "focusing" | "open" | "closing";
export type MobileComposerLayoutMode = "desktop-wide" | "desktop-medium" | "desktop-narrow" | "mobile";

export interface MobileComposerControllerOptions {
	getWindow: () => Window;
	getDocument: () => Document;
	getContainerEl: () => HTMLElement;
	getRootEl: () => HTMLElement | null;
	getComposerEl: () => HTMLElement | null;
	getInputEl: () => HTMLTextAreaElement | null;
	getComposerBarEl: () => HTMLElement | null;
	getReferencePreviewEl: () => HTMLElement | null;
	getLayout: () => MobileComposerLayoutMode;
	isComposerOpen: () => boolean;
	setComposerOpen: (open: boolean) => void;
	getCardFlowScrollTop: () => number | null;
	registerBackdropClick: (element: HTMLElement, handler: (event: MouseEvent) => void) => void;
	closeComposerKeepingDraft: () => void;
	focusInputNow: (shouldResize?: boolean, shouldQueueViewport?: boolean) => void;
	resizeInput: () => void;
	syncRootState: () => void;
	syncComposerMode: () => void;
	updateSendButtonState: () => void;
	updateCancelEditButtonState: () => void;
}

export class MobileComposerController {
	private mobileVisualViewport: VisualViewport | null = null;
	private mobileVisualViewportHandler: (() => void) | null = null;
	private mobileComposerFocusFrameId: number | null = null;
	private mobileComposerFocusTimerId: number | null = null;
	private mobileComposerResizeFrameId: number | null = null;
	private mobileViewportFrameId: number | null = null;
	private mobileKeyboardFocusStartedAt: number | null = null;
	private mobileComposerInputFocused = false;
	private mobileWindowResizeHandler: (() => void) | null = null;
	private mobileOrientationChangeHandler: (() => void) | null = null;
	private mobileComposerPhase: MobileComposerPhase = "closed";
	private mobileKeyboardHeight = 0;
	private mobileComposerViewportBaselineHeight: number | null = null;
	private mobileComposerInputMaxHeight: number | null = null;
	private mobileKeyboardMeasureTimers: number[] = [];
	private mobileComposerCloseTimer: number | null = null;
	private mobileComposerLayerEl: HTMLElement | null = null;
	private mobileComposerContentEl: HTMLElement | null = null;
	private mobileComposerHomeEl: HTMLElement | null = null;
	private mobileComposerNextSibling: ChildNode | null = null;
	private mobileComposerOpenScrollTop: number | null = null;

	constructor(private readonly options: MobileComposerControllerOptions) {}

	getPhase(): MobileComposerPhase {
		return this.mobileComposerPhase;
	}

	getOpenScrollTop(): number | null {
		return this.mobileComposerOpenScrollTop;
	}

	clearOpenScrollTop(): void {
		this.mobileComposerOpenScrollTop = null;
	}

	getMaxInputHeight(): number {
		if (this.options.getLayout() === "mobile" && this.mobileComposerInputMaxHeight !== null) {
			return this.mobileComposerInputMaxHeight;
		}
		return this.updateMeasurements();
	}

	prepareDesktopOpen(): void {
		this.clearCloseTimer();
		this.mobileComposerPhase = "closed";
	}

	resetInactiveState(): void {
		this.clearFocus();
		this.mobileComposerInputFocused = false;
		this.mobileKeyboardFocusStartedAt = null;
		this.stopViewportTracking();
	}

	dispose(): void {
		this.clearFocus();
		this.clearResizeFrame();
		this.clearCloseTimer();
		this.clearKeyboardMeasureTimers();
		this.stopViewportTracking();
		this.removeLayer();
	}

	isLayered(): boolean {
		return isComposerInMobileLayer(this.options.getComposerEl(), this.mobileComposerContentEl);
	}

	getLayerEl(): HTMLElement | null {
		return this.mobileComposerLayerEl;
	}

	syncViewportTracking(): void {
		const shouldTrackMobileViewport = this.options.getLayout() === "mobile"
			&& this.options.isComposerOpen()
			&& (this.mobileComposerPhase === "focusing" || this.mobileComposerPhase === "open");
		if (shouldTrackMobileViewport) {
			this.startViewportTracking();
			return;
		}
		if (this.mobileComposerPhase !== "closing") {
			this.stopViewportTracking();
		}
	}

	syncLayer(): void {
		const shouldShow = this.options.getLayout() === "mobile" && this.options.isComposerOpen();
		if (shouldShow) {
			if (this.mobileComposerPhase === "closing") {
				return;
			}
			this.ensureLayer();
			return;
		}
		if (this.mobileComposerPhase !== "closing") {
			this.detachLayer();
		}
	}

	open(): void {
		if (this.options.getLayout() === "mobile" && !this.options.isComposerOpen()) {
			this.mobileComposerOpenScrollTop = this.options.getCardFlowScrollTop();
		}
		this.clearCloseTimer();
		this.clearFocus();
		this.options.setComposerOpen(true);
		this.mobileComposerPhase = "opening";
		this.mobileComposerInputFocused = false;
		this.mobileKeyboardFocusStartedAt = null;
		this.ensureLayer();
		this.mobileComposerLayerEl?.toggleClass("is-open", false);
		this.mobileComposerLayerEl?.toggleClass("is-closing", false);
		this.clearKeyboardMetrics();
		this.mobileComposerViewportBaselineHeight = this.options.getWindow().innerHeight;
		this.updateMeasurements();
		this.options.syncRootState();
		this.mobileComposerFocusFrameId = this.options.getWindow().requestAnimationFrame(() => {
			this.mobileComposerFocusFrameId = null;
			if (this.mobileComposerPhase !== "opening") {
				return;
			}
			this.mobileComposerLayerEl?.toggleClass("is-open", true);
			this.mobileComposerFocusTimerId = this.options.getWindow().setTimeout(() => {
				this.mobileComposerFocusTimerId = null;
				if (this.mobileComposerPhase !== "opening") {
					return;
				}
				this.mobileComposerPhase = "focusing";
				this.options.focusInputNow(false, false);
				this.scheduleKeyboardMeasurements();
				this.startViewportTracking();
				this.mobileComposerFocusTimerId = this.options.getWindow().setTimeout(() => {
					this.mobileComposerFocusTimerId = null;
					if (this.mobileComposerPhase === "focusing") {
						this.updateKeyboardMetrics();
						this.mobileComposerPhase = "open";
					}
				}, 260);
			}, 100);
		});
	}

	closeKeepingDraft(): void {
		this.mobileComposerOpenScrollTop = null;
		this.clearFocus();
		this.clearKeyboardMeasureTimers();
		this.clearCloseTimer();
		this.mobileComposerPhase = "closing";
		this.mobileComposerLayerEl?.toggleClass("is-open", false);
		this.mobileComposerLayerEl?.toggleClass("is-closing", true);
		this.options.getInputEl()?.blur();
		this.mobileComposerInputFocused = false;
		this.mobileKeyboardFocusStartedAt = null;
		this.mobileComposerCloseTimer = this.options.getWindow().setTimeout(() => {
			this.mobileComposerCloseTimer = null;
			this.restoreLayer();
			this.clearLayerState();
			this.mobileComposerLayerEl?.detach();
			this.stopViewportTracking(false);
			this.clearKeyboardMetrics();
			this.options.setComposerOpen(false);
			this.mobileComposerPhase = "closed";
			this.options.syncRootState();
			this.options.syncComposerMode();
			this.options.updateSendButtonState();
			this.options.updateCancelEditButtonState();
		}, 240);
	}

	focusInputSoon(): void {
		this.clearFocus();
		if (this.options.getLayout() !== "mobile") {
			this.options.focusInputNow();
			return;
		}
		this.mobileComposerFocusFrameId = this.options.getWindow().requestAnimationFrame(() => {
			this.mobileComposerFocusFrameId = null;
			const inputEl = this.options.getInputEl();
			if (inputEl !== null && this.options.getDocument().activeElement !== inputEl) {
				this.options.focusInputNow();
			} else {
				this.queueViewportUpdate();
			}
		});
	}

	handleInputFocus(): boolean {
		if (this.options.getLayout() !== "mobile") {
			return true;
		}
		this.mobileComposerInputFocused = true;
		this.mobileKeyboardFocusStartedAt = Date.now();
		this.scheduleKeyboardMeasurements();
		if (this.mobileComposerPhase === "open") {
			this.queueViewportUpdate();
		}
		return this.mobileComposerPhase !== "opening" && this.mobileComposerPhase !== "focusing";
	}

	handleInputBlur(): boolean {
		if (this.options.getLayout() !== "mobile") {
			return true;
		}
		this.mobileComposerInputFocused = false;
		this.mobileKeyboardFocusStartedAt = null;
		this.clearKeyboardMeasureTimers();
		if (this.mobileComposerPhase === "closing") {
			return false;
		}
		this.clearKeyboardMetrics();
		return true;
	}

	startViewportTracking(): void {
		if (this.options.getRootEl() === null) {
			return;
		}
		const win = this.options.getWindow();
		if (this.mobileWindowResizeHandler === null) {
			this.mobileWindowResizeHandler = () => this.queueViewportUpdate();
			win.addEventListener("resize", this.mobileWindowResizeHandler);
		}
		if (this.mobileOrientationChangeHandler === null) {
			this.mobileOrientationChangeHandler = () => this.queueViewportUpdate();
			win.addEventListener("orientationchange", this.mobileOrientationChangeHandler);
		}
		const viewport = win.visualViewport;
		if (viewport === undefined || viewport === null) {
			this.updateKeyboardMetrics();
			return;
		}
		if (this.mobileVisualViewportHandler === null) {
			this.mobileVisualViewport = viewport;
			this.mobileVisualViewportHandler = () => this.queueViewportUpdate();
			viewport.addEventListener("resize", this.mobileVisualViewportHandler);
			viewport.addEventListener("scroll", this.mobileVisualViewportHandler);
		}
		this.updateKeyboardMetrics();
	}

	stopViewportTracking(clearMetrics = true): void {
		const win = this.options.getWindow();
		if (this.mobileVisualViewport !== null && this.mobileVisualViewportHandler !== null) {
			this.mobileVisualViewport.removeEventListener("resize", this.mobileVisualViewportHandler);
			this.mobileVisualViewport.removeEventListener("scroll", this.mobileVisualViewportHandler);
		}
		if (this.mobileWindowResizeHandler !== null) {
			win.removeEventListener("resize", this.mobileWindowResizeHandler);
		}
		if (this.mobileOrientationChangeHandler !== null) {
			win.removeEventListener("orientationchange", this.mobileOrientationChangeHandler);
		}
		this.mobileVisualViewport = null;
		this.mobileVisualViewportHandler = null;
		this.mobileWindowResizeHandler = null;
		this.mobileOrientationChangeHandler = null;
		this.clearViewportFrame();
		this.clearKeyboardMeasureTimers();
		this.mobileKeyboardFocusStartedAt = null;
		if (clearMetrics) {
			this.clearKeyboardMetrics();
		}
	}

	scheduleResize(): void {
		if (this.mobileComposerResizeFrameId !== null) {
			return;
		}
		this.mobileComposerResizeFrameId = this.options.getWindow().requestAnimationFrame(() => {
			this.mobileComposerResizeFrameId = null;
			this.updateMeasurements();
			this.options.resizeInput();
		});
	}

	clearFocus(): void {
		const win = this.options.getWindow();
		if (this.mobileComposerFocusFrameId !== null) {
			win.cancelAnimationFrame(this.mobileComposerFocusFrameId);
			this.mobileComposerFocusFrameId = null;
		}
		if (this.mobileComposerFocusTimerId !== null) {
			win.clearTimeout(this.mobileComposerFocusTimerId);
			this.mobileComposerFocusTimerId = null;
		}
	}

	clearResizeFrame(): void {
		if (this.mobileComposerResizeFrameId === null) {
			return;
		}
		this.options.getWindow().cancelAnimationFrame(this.mobileComposerResizeFrameId);
		this.mobileComposerResizeFrameId = null;
	}

	clearCloseTimer(): void {
		if (this.mobileComposerCloseTimer === null) {
			return;
		}
		this.options.getWindow().clearTimeout(this.mobileComposerCloseTimer);
		this.mobileComposerCloseTimer = null;
	}

	clearKeyboardMeasureTimers(): void {
		for (const timer of this.mobileKeyboardMeasureTimers) {
			this.options.getWindow().clearTimeout(timer);
		}
		this.mobileKeyboardMeasureTimers = [];
	}

	queueViewportUpdate(): void {
		if (this.mobileViewportFrameId !== null) {
			return;
		}
		this.mobileViewportFrameId = this.options.getWindow().requestAnimationFrame(() => {
			this.mobileViewportFrameId = null;
			this.updateKeyboardMetrics();
		});
	}

	updateMeasurements(): number {
		const win = this.options.getWindow();
		const viewport = this.mobileVisualViewport ?? win.visualViewport;
		const containerTop = Math.max(0, this.options.getContainerEl().getBoundingClientRect().top);
		const baselineHeight = this.mobileComposerViewportBaselineHeight ?? win.innerHeight;
		const toolbarHeight = this.options.getComposerBarEl()?.offsetHeight ?? 52;
		const referencePreviewEl = this.options.getReferencePreviewEl();
		const referenceHeight = referencePreviewEl !== null && referencePreviewEl.style.display !== "none"
			? referencePreviewEl.offsetHeight
			: 0;
		const measurements = calculateMobileComposerMeasurements({
			baselineHeight,
			windowHeight: win.innerHeight,
			viewportOffsetTop: viewport === undefined || viewport === null ? null : viewport.offsetTop,
			viewportHeight: viewport === undefined || viewport === null ? null : viewport.height,
			containerTop,
			keyboardHeight: this.mobileKeyboardHeight || 0,
			toolbarHeight,
			referenceHeight,
			topGuard: MOBILE_COMPOSER_TOP_GUARD,
		});
		const contentMaxHeightValue = `${measurements.contentMaxHeight}px`;
		this.mobileComposerInputMaxHeight = measurements.inputMaxHeight;
		const inputMaxHeightValue = `${this.mobileComposerInputMaxHeight}px`;
		for (const element of [this.options.getRootEl(), this.mobileComposerLayerEl]) {
			element?.style.setProperty("--knomo-composer-content-max-height", contentMaxHeightValue);
			element?.style.setProperty("--knomo-composer-input-max-height", inputMaxHeightValue);
		}
		return measurements.inputMaxHeight;
	}

	private ensureLayer(): void {
		const composerEl = this.options.getComposerEl();
		if (composerEl === null) {
			return;
		}
		if (this.mobileComposerLayerEl === null) {
			const layer = createMobileComposerLayer(this.options.getDocument());
			this.mobileComposerLayerEl = layer.layerEl;
			this.mobileComposerContentEl = layer.contentEl;
			this.options.registerBackdropClick(layer.backdropEl, (event) => {
				if (event.target === layer.backdropEl) {
					this.options.closeComposerKeepingDraft();
				}
			});
		} else {
			attachMobileComposerLayer(this.options.getDocument(), this.mobileComposerLayerEl);
		}
		if (this.mobileComposerContentEl === null) {
			return;
		}
		const placement = moveComposerToMobileLayer(composerEl, this.mobileComposerContentEl);
		if (placement === null) {
			return;
		}
		this.mobileComposerHomeEl = placement.homeEl;
		this.mobileComposerNextSibling = placement.nextSibling;
	}

	private restoreLayer(): void {
		restoreComposerFromMobileLayer(
			this.options.getComposerEl(),
			this.mobileComposerContentEl,
			this.mobileComposerHomeEl,
			this.mobileComposerNextSibling,
		);
		this.mobileComposerHomeEl = null;
		this.mobileComposerNextSibling = null;
	}

	private clearLayerState(): void {
		clearMobileComposerLayerState(this.mobileComposerLayerEl);
	}

	private detachLayer(): void {
		this.restoreLayer();
		this.clearResizeFrame();
		this.clearKeyboardMeasureTimers();
		this.mobileComposerViewportBaselineHeight = null;
		this.mobileComposerInputMaxHeight = null;
		this.clearLayerState();
		this.mobileComposerLayerEl?.detach();
	}

	private removeLayer(): void {
		this.restoreLayer();
		this.clearResizeFrame();
		this.clearKeyboardMeasureTimers();
		this.mobileComposerViewportBaselineHeight = null;
		this.mobileComposerInputMaxHeight = null;
		this.clearLayerState();
		this.mobileComposerLayerEl?.detach();
		this.mobileComposerLayerEl = null;
		this.mobileComposerContentEl = null;
	}

	private clearViewportFrame(): void {
		if (this.mobileViewportFrameId === null) {
			return;
		}
		this.options.getWindow().cancelAnimationFrame(this.mobileViewportFrameId);
		this.mobileViewportFrameId = null;
	}

	private scheduleKeyboardMeasurements(): void {
		this.clearKeyboardMeasureTimers();
		const delays = [80, 160, 320, 600];
		for (const delay of delays) {
			const timer = this.options.getWindow().setTimeout(() => {
				this.updateKeyboardMetrics();
			}, delay);
			this.mobileKeyboardMeasureTimers.push(timer);
		}
	}

	private updateKeyboardMetrics(): void {
		const win = this.options.getWindow();
		const viewport = this.mobileVisualViewport ?? win.visualViewport;
		const baselineHeight = this.mobileComposerViewportBaselineHeight ?? win.innerHeight;
		const metrics = calculateMobileKeyboardMetrics({
			baselineHeight,
			windowHeight: win.innerHeight,
			viewportOffsetTop: viewport === undefined || viewport === null ? null : viewport.offsetTop,
			viewportHeight: viewport === undefined || viewport === null ? null : viewport.height,
		});
		let { keyboardHeight } = metrics;
		const activeElement = this.options.getDocument().activeElement;
		const shouldUseFallback = this.options.getLayout() === "mobile"
			&& this.options.isComposerOpen()
			&& (this.mobileComposerInputFocused || activeElement === this.options.getInputEl())
			&& keyboardHeight === 0
			&& this.mobileKeyboardFocusStartedAt !== null
			&& Date.now() - this.mobileKeyboardFocusStartedAt > 220;
		if (shouldUseFallback) {
			keyboardHeight = getMobileKeyboardFallbackHeight(baselineHeight, win.innerHeight);
		}
		this.mobileKeyboardHeight = keyboardHeight;
		this.setKeyboardMetrics(metrics.visibleTop, metrics.visibleHeight, keyboardHeight);
		this.updateMeasurements();
		if (this.mobileComposerPhase === "focusing"
			&& this.mobileKeyboardFocusStartedAt !== null
			&& Date.now() - this.mobileKeyboardFocusStartedAt > 240) {
			this.mobileComposerPhase = "open";
		}
		if (this.options.getLayout() === "mobile"
			&& this.options.isComposerOpen()
			&& this.mobileComposerPhase !== "opening"
			&& this.mobileComposerPhase !== "closing") {
			this.options.resizeInput();
		}
	}

	private setKeyboardMetrics(visibleTop: number, visibleHeight: number, keyboardHeight: number): void {
		const visibleTopValue = `${Math.round(visibleTop)}px`;
		const visibleHeightValue = `${Math.round(visibleHeight)}px`;
		const keyboardHeightValue = `${Math.round(keyboardHeight)}px`;
		const toolbarGapCorrectionValue = `${calculateMobileKeyboardToolbarGapCorrection(keyboardHeight)}px`;
		for (const element of [this.options.getRootEl(), this.mobileComposerLayerEl]) {
			element?.style.setProperty("--knomo-visible-top", visibleTopValue);
			element?.style.setProperty("--knomo-visible-height", visibleHeightValue);
			element?.style.setProperty("--knomo-keyboard-height", keyboardHeightValue);
			element?.style.setProperty("--knomo-keyboard-toolbar-gap-correction", toolbarGapCorrectionValue);
			element?.style.setProperty("--knomo-vv-top", visibleTopValue);
			element?.style.setProperty("--knomo-vv-height", visibleHeightValue);
		}
		this.mobileComposerLayerEl?.toggleClass("is-keyboard-open", keyboardHeight > 0);
	}

	private clearKeyboardMetrics(): void {
		const win = this.options.getWindow();
		this.mobileKeyboardHeight = 0;
		this.mobileComposerViewportBaselineHeight = null;
		this.setKeyboardMetrics(0, win.innerHeight, 0);
		this.updateMeasurements();
	}
}

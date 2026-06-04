import {
	attachMobileComposerLayer,
	clearMobileComposerLayerState,
	createMobileComposerLayer,
	isComposerInMobileLayer,
	moveComposerToMobileLayer,
	restoreComposerFromMobileLayer,
} from "./MobileComposerLayer";
import {
	calculateMobileComposerDockTop,
	calculateMobileComposerDockOffset,
	calculateMobileComposerMeasurements,
	calculateMobileKeyboardMetrics,
	type MobileComposerDockTop,
} from "./mobileComposerMetrics";

const MOBILE_COMPOSER_TOP_GUARD = 52;
const MOBILE_COMPOSER_TOOLBAR_KEYBOARD_GAP = 4;
const MOBILE_COMPOSER_REVEAL_FALLBACK_DELAY = 70;
const MOBILE_COMPOSER_CLOSE_FALLBACK_DELAY = 420;
const MOBILE_COMPOSER_EXIT_TRANSITION_DELAY = 160;
const MOBILE_KEYBOARD_DOCK_TRACKING_DURATION = 780;
const MOBILE_KEYBOARD_DOCK_STABLE_FRAME_LIMIT = 8;
const MOBILE_KEYBOARD_DOCK_STABLE_DELTA = 1;
const MOBILE_KEYBOARD_DOCK_MAX_FRAMES = 90;
const MOBILE_KEYBOARD_CLOSE_STABLE_FRAME_LIMIT = 3;

interface VirtualKeyboardLike extends EventTarget {
	boundingRect?: DOMRectReadOnly;
	overlaysContent?: boolean;
}

interface NavigatorWithVirtualKeyboard extends Navigator {
	virtualKeyboard?: VirtualKeyboardLike;
}

interface CapacitorKeyboardEventLike extends Event {
	keyboardHeight?: unknown;
	detail?: {
		keyboardHeight?: unknown;
	};
}

type MobileComposerToolbarAnchorSource = "button-row" | "toolbar-wrapper" | "unknown";

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
	private mobileVirtualKeyboard: VirtualKeyboardLike | null = null;
	private mobileVirtualKeyboardHandler: (() => void) | null = null;
	private mobileVirtualKeyboardPreviousOverlaysContent: boolean | null = null;
	private mobileCapacitorKeyboardShowHandler: ((event: Event) => void) | null = null;
	private mobileCapacitorKeyboardHideHandler: (() => void) | null = null;
	private mobileCapacitorKeyboardHeight: number | null = null;
	private mobileComposerFocusFrameId: number | null = null;
	private mobileComposerFocusTimerId: number | null = null;
	private mobileComposerResizeFrameId: number | null = null;
	private mobileKeyboardDockFrameId: number | null = null;
	private mobileKeyboardDockStartedAt: number | null = null;
	private mobileKeyboardDockStableFrames = 0;
	private mobileKeyboardDockFrames = 0;
	private mobileKeyboardDockLastOffset: number | null = null;
	private mobileToolbarAnchorFrameId: number | null = null;
	private mobileKeyboardFocusStartedAt: number | null = null;
	private mobileComposerInputFocused = false;
	private mobileWindowResizeHandler: (() => void) | null = null;
	private mobileOrientationChangeHandler: (() => void) | null = null;
	private mobileComposerPhase: MobileComposerPhase = "closed";
	private mobileKeyboardHeight = 0;
	private mobileComposerDockTop: number | null = null;
	private mobileComposerDockSource: MobileComposerDockTop["source"] = "fallback";
	private mobileComposerLayerBottom: number | null = null;
	private mobileComposerRevealed = false;
	private mobileComposerViewportBaselineHeight: number | null = null;
	private mobileComposerInputMaxHeight: number | null = null;
	private mobileComposerCloseTimer: number | null = null;
	private mobileComposerLayerEl: HTMLElement | null = null;
	private mobileComposerContentEl: HTMLElement | null = null;
	private mobileComposerHomeEl: HTMLElement | null = null;
	private mobileComposerNextSibling: ChildNode | null = null;
	private mobileComposerOpenScrollTop: number | null = null;
	private mobileComposerBottomOffset = 0;
	private mobileComposerToolbarAnchorInset: number | null = null;
	private mobileComposerToolbarAnchorBottom: number | null = null;
	private mobileComposerToolbarAnchorSource: MobileComposerToolbarAnchorSource = "unknown";
	private mobileComposerToolbarWrapperBottom: number | null = null;

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
		this.stopKeyboardDockTracking();
		this.clearToolbarAnchorFrame();
		this.clearCloseTimer();
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
			&& (this.mobileComposerPhase === "opening" || this.mobileComposerPhase === "focusing" || this.mobileComposerPhase === "open");
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
		const win = this.options.getWindow();
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
		this.mobileComposerRevealed = false;
		this.mobileComposerLayerEl?.toggleClass("is-open", false);
		this.mobileComposerLayerEl?.toggleClass("is-closing", false);
		this.mobileComposerViewportBaselineHeight = win.innerHeight;
		this.mobileComposerDockTop = win.innerHeight;
		this.mobileComposerDockSource = "fallback";
		this.mobileComposerLayerBottom = null;
		this.mobileKeyboardHeight = 0;
		this.mobileCapacitorKeyboardHeight = null;
		this.mobileComposerToolbarAnchorInset = null;
		this.mobileComposerToolbarAnchorBottom = null;
		this.mobileComposerToolbarAnchorSource = "unknown";
		this.mobileComposerToolbarWrapperBottom = null;
		this.setKeyboardMetrics(0, win.innerHeight, 0);
		this.setComposerBottomOffset(0);
		this.updateMeasurements();
		this.updateToolbarAnchorInset();
		this.scheduleToolbarAnchorRefresh();
		this.options.syncRootState();
		this.startViewportTracking();
		this.startKeyboardDockTracking();
		this.mobileComposerFocusTimerId = win.setTimeout(() => {
			this.mobileComposerFocusTimerId = null;
			this.updateKeyboardMetrics();
			if (this.mobileComposerPhase === "opening" || this.mobileComposerPhase === "focusing") {
				this.revealMobileComposer();
			}
		}, MOBILE_COMPOSER_REVEAL_FALLBACK_DELAY);
		this.mobileComposerFocusFrameId = win.requestAnimationFrame(() => {
			this.mobileComposerFocusFrameId = null;
			if (this.mobileComposerPhase !== "opening") {
				return;
			}
			this.mobileComposerPhase = "focusing";
			this.mobileComposerInputFocused = true;
			this.mobileKeyboardFocusStartedAt = Date.now();
			this.options.focusInputNow(false, false);
			this.startKeyboardDockTracking();
			this.scheduleToolbarAnchorRefresh();
			this.updateKeyboardMetrics();
		});
	}

	closeKeepingDraft(): void {
		this.mobileComposerOpenScrollTop = null;
		this.clearFocus();
		this.clearCloseTimer();
		this.mobileComposerPhase = "closing";
		this.mobileComposerLayerEl?.toggleClass("is-closing", true);
		this.options.getInputEl()?.blur();
		this.mobileComposerInputFocused = false;
		this.mobileKeyboardFocusStartedAt = null;
		this.updateToolbarAnchorInset();
		this.startKeyboardDockTracking();
		this.mobileComposerCloseTimer = this.options.getWindow().setTimeout(() => {
			this.mobileComposerCloseTimer = null;
			this.completeClose();
		}, MOBILE_COMPOSER_CLOSE_FALLBACK_DELAY);
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
		this.startKeyboardDockTracking();
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
		if (this.mobileComposerPhase === "closing") {
			return false;
		}
		this.startKeyboardDockTracking();
		this.updateKeyboardMetrics();
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
			this.mobileOrientationChangeHandler = () => this.handleViewportOrientationChange();
			win.addEventListener("orientationchange", this.mobileOrientationChangeHandler);
		}
		this.startCapacitorKeyboardTracking(win);
		const virtualKeyboard = this.getVirtualKeyboard(win);
		if (virtualKeyboard !== null && this.mobileVirtualKeyboardHandler === null) {
			this.mobileVirtualKeyboard = virtualKeyboard;
			this.enableVirtualKeyboardOverlay(virtualKeyboard);
			this.mobileVirtualKeyboardHandler = () => this.queueViewportUpdate();
			virtualKeyboard.addEventListener("geometrychange", this.mobileVirtualKeyboardHandler);
		}
		const viewport = win.visualViewport;
		if (viewport === undefined || viewport === null) {
			this.updateKeyboardMetrics();
			this.startKeyboardDockTracking();
			return;
		}
		if (this.mobileVisualViewportHandler === null) {
			this.mobileVisualViewport = viewport;
			this.mobileVisualViewportHandler = () => this.queueViewportUpdate();
			viewport.addEventListener("resize", this.mobileVisualViewportHandler);
			viewport.addEventListener("scroll", this.mobileVisualViewportHandler);
		}
		this.updateKeyboardMetrics();
		this.startKeyboardDockTracking();
	}

	stopViewportTracking(clearMetrics = true): void {
		const win = this.options.getWindow();
		if (this.mobileVisualViewport !== null && this.mobileVisualViewportHandler !== null) {
			this.mobileVisualViewport.removeEventListener("resize", this.mobileVisualViewportHandler);
			this.mobileVisualViewport.removeEventListener("scroll", this.mobileVisualViewportHandler);
		}
		this.restoreVirtualKeyboardOverlay();
		if (this.mobileVirtualKeyboard !== null && this.mobileVirtualKeyboardHandler !== null) {
			this.mobileVirtualKeyboard.removeEventListener("geometrychange", this.mobileVirtualKeyboardHandler);
		}
		if (this.mobileWindowResizeHandler !== null) {
			win.removeEventListener("resize", this.mobileWindowResizeHandler);
		}
		if (this.mobileOrientationChangeHandler !== null) {
			win.removeEventListener("orientationchange", this.mobileOrientationChangeHandler);
		}
		this.stopCapacitorKeyboardTracking(win);
		this.mobileVisualViewport = null;
		this.mobileVisualViewportHandler = null;
		this.mobileVirtualKeyboard = null;
		this.mobileVirtualKeyboardHandler = null;
		this.mobileWindowResizeHandler = null;
		this.mobileOrientationChangeHandler = null;
		this.stopKeyboardDockTracking();
		this.clearToolbarAnchorFrame();
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
			this.scheduleToolbarAnchorRefresh();
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

	queueViewportUpdate(): void {
		this.startKeyboardDockTracking();
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
			composerDockTop: this.mobileComposerDockTop ?? this.getComposerDockTop(win, baselineHeight, viewport).dockTop,
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
		this.mobileComposerRevealed = false;
	}

	private detachLayer(): void {
		this.restoreLayer();
		this.clearResizeFrame();
		this.stopKeyboardDockTracking();
		this.clearToolbarAnchorFrame();
		this.mobileComposerViewportBaselineHeight = null;
		this.mobileComposerDockTop = null;
		this.mobileComposerDockSource = "fallback";
		this.mobileComposerLayerBottom = null;
		this.mobileCapacitorKeyboardHeight = null;
		this.mobileComposerRevealed = false;
		this.mobileComposerInputMaxHeight = null;
		this.mobileComposerToolbarAnchorInset = null;
		this.mobileComposerToolbarAnchorBottom = null;
		this.mobileComposerToolbarAnchorSource = "unknown";
		this.mobileComposerToolbarWrapperBottom = null;
		this.setComposerBottomOffset(0);
		this.clearLayerState();
		this.mobileComposerLayerEl?.detach();
	}

	private removeLayer(): void {
		this.restoreLayer();
		this.clearResizeFrame();
		this.stopKeyboardDockTracking();
		this.clearToolbarAnchorFrame();
		this.mobileComposerViewportBaselineHeight = null;
		this.mobileComposerDockTop = null;
		this.mobileComposerDockSource = "fallback";
		this.mobileComposerLayerBottom = null;
		this.mobileCapacitorKeyboardHeight = null;
		this.mobileComposerRevealed = false;
		this.mobileComposerInputMaxHeight = null;
		this.mobileComposerToolbarAnchorInset = null;
		this.mobileComposerToolbarAnchorBottom = null;
		this.mobileComposerToolbarAnchorSource = "unknown";
		this.mobileComposerToolbarWrapperBottom = null;
		this.setComposerBottomOffset(0);
		this.clearLayerState();
		this.mobileComposerLayerEl?.detach();
		this.mobileComposerLayerEl = null;
		this.mobileComposerContentEl = null;
	}

	private startKeyboardDockTracking(): void {
		if (this.options.getLayout() !== "mobile" || !this.options.isComposerOpen()) {
			return;
		}
		if (this.mobileKeyboardDockStartedAt === null) {
			this.mobileKeyboardDockStartedAt = Date.now();
			this.mobileKeyboardDockStableFrames = 0;
			this.mobileKeyboardDockFrames = 0;
			this.mobileKeyboardDockLastOffset = null;
		}
		this.mobileComposerLayerEl?.toggleClass("is-keyboard-tracking", true);
		this.scheduleKeyboardDockFrame();
	}

	private scheduleKeyboardDockFrame(): void {
		if (this.mobileKeyboardDockFrameId !== null) {
			return;
		}
		this.mobileKeyboardDockFrameId = this.options.getWindow().requestAnimationFrame(() => {
			this.mobileKeyboardDockFrameId = null;
			this.mobileKeyboardDockFrames += 1;
			this.updateKeyboardMetrics();
			if (this.shouldContinueKeyboardDockTracking()) {
				this.scheduleKeyboardDockFrame();
			} else {
				this.stopKeyboardDockTracking();
			}
		});
	}

	private shouldContinueKeyboardDockTracking(): boolean {
		if (this.mobileKeyboardDockStartedAt === null
			|| this.options.getLayout() !== "mobile"
			|| !this.options.isComposerOpen()) {
			return false;
		}
		if (this.mobileComposerPhase === "closing") {
			return true;
		}
		if (this.mobileKeyboardDockFrames >= MOBILE_KEYBOARD_DOCK_MAX_FRAMES) {
			return false;
		}
		const elapsed = Date.now() - this.mobileKeyboardDockStartedAt;
		return elapsed < MOBILE_KEYBOARD_DOCK_TRACKING_DURATION
			|| this.mobileKeyboardDockStableFrames < MOBILE_KEYBOARD_DOCK_STABLE_FRAME_LIMIT;
	}

	private stopKeyboardDockTracking(): void {
		if (this.mobileKeyboardDockFrameId !== null) {
			this.options.getWindow().cancelAnimationFrame(this.mobileKeyboardDockFrameId);
			this.mobileKeyboardDockFrameId = null;
		}
		this.mobileKeyboardDockStartedAt = null;
		this.mobileKeyboardDockStableFrames = 0;
		this.mobileKeyboardDockFrames = 0;
		this.mobileKeyboardDockLastOffset = null;
		this.mobileComposerLayerEl?.toggleClass("is-keyboard-tracking", false);
	}

	private updateKeyboardMetrics(): void {
		const win = this.options.getWindow();
		const viewport = this.mobileVisualViewport ?? win.visualViewport;
		const baselineHeight = this.mobileComposerViewportBaselineHeight ?? win.innerHeight;
		const composerDock = this.getComposerDockTop(win, baselineHeight, viewport);
		const metrics = calculateMobileKeyboardMetrics({
			baselineHeight,
			windowHeight: win.innerHeight,
			viewportOffsetTop: viewport === undefined || viewport === null ? null : viewport.offsetTop,
			viewportHeight: viewport === undefined || viewport === null ? null : viewport.height,
		});
		let { keyboardHeight } = metrics;
		if (this.mobileCapacitorKeyboardHeight === 0) {
			keyboardHeight = 0;
		} else if (composerDock.source === "capacitor-keyboard" && this.mobileCapacitorKeyboardHeight !== null) {
			keyboardHeight = Math.max(0, Math.round(this.mobileCapacitorKeyboardHeight));
		} else if (composerDock.source !== "fallback") {
			keyboardHeight = Math.max(keyboardHeight, Math.max(0, baselineHeight - composerDock.dockTop));
		}
		this.mobileComposerDockTop = composerDock.dockTop;
		this.mobileComposerDockSource = composerDock.source;
		this.mobileKeyboardHeight = keyboardHeight;
		this.setKeyboardMetrics(metrics.visibleTop, metrics.visibleHeight, keyboardHeight);
		if (this.mobileComposerToolbarAnchorInset === null || this.mobileComposerRevealed) {
			this.updateToolbarAnchorInset();
		}
		this.syncComposerDockOffset(composerDock.dockTop, baselineHeight);
		this.setComposerDockDiagnostics(composerDock, baselineHeight);
		this.updateKeyboardDockStability();
		this.revealMobileComposerForDock(composerDock, keyboardHeight, baselineHeight);
		this.updateMeasurements();
		this.maybeFinishClosingAfterDockSettles();
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
			this.scheduleToolbarAnchorRefresh();
		}
	}

	private handleViewportOrientationChange(): void {
		if (this.mobileKeyboardHeight === 0 && this.mobileComposerBottomOffset === 0) {
			this.mobileComposerViewportBaselineHeight = this.options.getWindow().innerHeight;
			this.mobileComposerDockTop = this.mobileComposerViewportBaselineHeight;
			this.mobileComposerDockSource = "fallback";
		}
		this.queueViewportUpdate();
	}

	private getComposerDockTop(win: Window, baselineHeight: number, viewport: VisualViewport | null | undefined): MobileComposerDockTop {
		const virtualKeyboardRect = this.getVirtualKeyboard(win)?.boundingRect;
		const composerDock = calculateMobileComposerDockTop({
			baselineHeight,
			windowHeight: win.innerHeight,
			viewportOffsetTop: viewport === undefined || viewport === null ? null : viewport.offsetTop,
			viewportHeight: viewport === undefined || viewport === null ? null : viewport.height,
			capacitorKeyboardHeight: this.mobileCapacitorKeyboardHeight,
			virtualKeyboardRectY: virtualKeyboardRect === undefined ? null : virtualKeyboardRect.y,
			virtualKeyboardRectHeight: virtualKeyboardRect === undefined ? null : virtualKeyboardRect.height,
		});
		return composerDock;
	}

	private getVirtualKeyboard(win: Window): VirtualKeyboardLike | null {
		const navigatorWithKeyboard = win.navigator as NavigatorWithVirtualKeyboard | undefined;
		return navigatorWithKeyboard?.virtualKeyboard ?? null;
	}

	private startCapacitorKeyboardTracking(win: Window): void {
		if (this.mobileCapacitorKeyboardShowHandler === null) {
			this.mobileCapacitorKeyboardShowHandler = (event) => this.handleCapacitorKeyboardShow(event);
			win.addEventListener("keyboardWillShow", this.mobileCapacitorKeyboardShowHandler);
			win.addEventListener("keyboardDidShow", this.mobileCapacitorKeyboardShowHandler);
		}
		if (this.mobileCapacitorKeyboardHideHandler === null) {
			this.mobileCapacitorKeyboardHideHandler = () => this.handleCapacitorKeyboardHide();
			win.addEventListener("keyboardWillHide", this.mobileCapacitorKeyboardHideHandler);
			win.addEventListener("keyboardDidHide", this.mobileCapacitorKeyboardHideHandler);
		}
	}

	private stopCapacitorKeyboardTracking(win: Window): void {
		if (this.mobileCapacitorKeyboardShowHandler !== null) {
			win.removeEventListener("keyboardWillShow", this.mobileCapacitorKeyboardShowHandler);
			win.removeEventListener("keyboardDidShow", this.mobileCapacitorKeyboardShowHandler);
			this.mobileCapacitorKeyboardShowHandler = null;
		}
		if (this.mobileCapacitorKeyboardHideHandler !== null) {
			win.removeEventListener("keyboardWillHide", this.mobileCapacitorKeyboardHideHandler);
			win.removeEventListener("keyboardDidHide", this.mobileCapacitorKeyboardHideHandler);
			this.mobileCapacitorKeyboardHideHandler = null;
		}
	}

	private handleCapacitorKeyboardShow(event: Event): void {
		if (this.options.getLayout() !== "mobile" || !this.options.isComposerOpen()) {
			return;
		}
		const keyboardHeight = this.getCapacitorKeyboardHeightFromEvent(event);
		if (keyboardHeight === null) {
			return;
		}
		this.mobileCapacitorKeyboardHeight = keyboardHeight;
		this.startKeyboardDockTracking();
		this.updateKeyboardMetrics();
	}

	private handleCapacitorKeyboardHide(): void {
		this.mobileCapacitorKeyboardHeight = 0;
		if (this.options.getLayout() !== "mobile" || !this.options.isComposerOpen()) {
			return;
		}
		this.startKeyboardDockTracking();
		this.updateKeyboardMetrics();
	}

	private getCapacitorKeyboardHeightFromEvent(event: Event): number | null {
		const keyboardEvent = event as CapacitorKeyboardEventLike;
		return this.normalizeCapacitorKeyboardHeight(
			keyboardEvent.keyboardHeight ?? keyboardEvent.detail?.keyboardHeight,
		);
	}

	private normalizeCapacitorKeyboardHeight(value: unknown): number | null {
		const height = typeof value === "number" ? value : Number.NaN;
		if (!Number.isFinite(height) || height <= 0) {
			return null;
		}
		return Math.round(height);
	}

	private enableVirtualKeyboardOverlay(virtualKeyboard: VirtualKeyboardLike): void {
		if (typeof virtualKeyboard.overlaysContent !== "boolean") {
			return;
		}
		this.mobileVirtualKeyboardPreviousOverlaysContent = virtualKeyboard.overlaysContent;
		try {
			virtualKeyboard.overlaysContent = true;
		} catch {
			this.mobileVirtualKeyboardPreviousOverlaysContent = null;
		}
	}

	private restoreVirtualKeyboardOverlay(): void {
		if (this.mobileVirtualKeyboard === null || this.mobileVirtualKeyboardPreviousOverlaysContent === null) {
			this.mobileVirtualKeyboardPreviousOverlaysContent = null;
			return;
		}
		try {
			this.mobileVirtualKeyboard.overlaysContent = this.mobileVirtualKeyboardPreviousOverlaysContent;
		} catch {
			// 忽略不同 WebView 对 virtual keyboard 恢复行为的差异。
		}
		this.mobileVirtualKeyboardPreviousOverlaysContent = null;
	}

	private revealMobileComposerForDock(composerDock: MobileComposerDockTop, keyboardHeight: number, baselineHeight: number): void {
		if (this.mobileComposerPhase !== "opening" && this.mobileComposerPhase !== "focusing") {
			return;
		}
		if (keyboardHeight > 0 || composerDock.dockTop < baselineHeight - 1) {
			this.revealMobileComposer();
		}
	}

	private revealMobileComposer(): void {
		if (this.mobileComposerRevealed) {
			return;
		}
		this.mobileComposerRevealed = true;
		this.mobileComposerLayerEl?.toggleClass("is-open", true);
		this.scheduleToolbarAnchorRefresh();
	}

	private maybeFinishClosingAfterDockSettles(): void {
		if (this.mobileComposerPhase !== "closing") {
			return;
		}
		if (Math.abs(this.mobileComposerBottomOffset) > MOBILE_KEYBOARD_DOCK_STABLE_DELTA
			|| this.mobileKeyboardDockStableFrames < MOBILE_KEYBOARD_CLOSE_STABLE_FRAME_LIMIT) {
			return;
		}
		this.finishClosingWithExitAnimation();
	}

	private finishClosingWithExitAnimation(): void {
		if (this.mobileComposerPhase !== "closing") {
			return;
		}
		this.clearCloseTimer();
		this.mobileComposerLayerEl?.toggleClass("is-open", false);
		this.stopViewportTracking(false);
		this.mobileComposerCloseTimer = this.options.getWindow().setTimeout(() => {
			this.mobileComposerCloseTimer = null;
			this.completeClose();
		}, MOBILE_COMPOSER_EXIT_TRANSITION_DELAY);
	}

	private completeClose(): void {
		if (this.mobileComposerPhase !== "closing") {
			return;
		}
		this.clearCloseTimer();
		this.mobileComposerLayerEl?.toggleClass("is-open", false);
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
	}

	private setKeyboardMetrics(visibleTop: number, visibleHeight: number, keyboardHeight: number): void {
		const visibleTopValue = `${Math.round(visibleTop)}px`;
		const visibleHeightValue = `${Math.round(visibleHeight)}px`;
		const keyboardHeightValue = `${Math.round(keyboardHeight)}px`;
		for (const element of [this.options.getRootEl(), this.mobileComposerLayerEl]) {
			element?.style.setProperty("--knomo-visible-top", visibleTopValue);
			element?.style.setProperty("--knomo-visible-height", visibleHeightValue);
			element?.style.setProperty("--knomo-keyboard-height", keyboardHeightValue);
			element?.style.setProperty("--knomo-vv-top", visibleTopValue);
			element?.style.setProperty("--knomo-vv-height", visibleHeightValue);
		}
		this.mobileComposerLayerEl?.toggleClass("is-keyboard-open", keyboardHeight > 0);
	}

	private syncComposerDockOffset(composerDockTop: number, baselineHeight: number): void {
		const layerBottom = this.getComposerLayerBottom(baselineHeight);
		this.mobileComposerLayerBottom = layerBottom;
		if (composerDockTop >= baselineHeight) {
			this.setComposerBottomOffset(0);
			return;
		}
		if (this.mobileComposerToolbarAnchorInset === null) {
			this.updateToolbarAnchorInset();
		}
		const toolbarAnchorInset = this.mobileComposerToolbarAnchorInset ?? 0;
		const nextBottomOffset = calculateMobileComposerDockOffset({
			layerBottom,
			composerDockTop,
			toolbarAnchorInset,
			targetGap: MOBILE_COMPOSER_TOOLBAR_KEYBOARD_GAP,
		});
		this.setComposerBottomOffset(nextBottomOffset);
	}

	private getComposerLayerBottom(fallbackBottom: number): number {
		const layerBottom = this.mobileComposerLayerEl?.getBoundingClientRect().bottom ?? fallbackBottom;
		if (!Number.isFinite(layerBottom) || layerBottom <= 0) {
			return fallbackBottom;
		}
		return layerBottom;
	}

	private updateKeyboardDockStability(): void {
		if (this.mobileKeyboardDockStartedAt === null) {
			return;
		}
		if (this.mobileKeyboardDockLastOffset !== null
			&& Math.abs(this.mobileComposerBottomOffset - this.mobileKeyboardDockLastOffset) <= MOBILE_KEYBOARD_DOCK_STABLE_DELTA) {
			this.mobileKeyboardDockStableFrames += 1;
		} else {
			this.mobileKeyboardDockStableFrames = 0;
		}
		this.mobileKeyboardDockLastOffset = this.mobileComposerBottomOffset;
	}

	private scheduleToolbarAnchorRefresh(): void {
		if (this.mobileToolbarAnchorFrameId !== null) {
			return;
		}
		this.mobileToolbarAnchorFrameId = this.options.getWindow().requestAnimationFrame(() => {
			this.mobileToolbarAnchorFrameId = null;
			this.updateToolbarAnchorInset();
			const baselineHeight = this.mobileComposerViewportBaselineHeight ?? this.options.getWindow().innerHeight;
			const viewport = this.mobileVisualViewport ?? this.options.getWindow().visualViewport;
			const composerDock = this.mobileComposerDockTop === null
				? this.getComposerDockTop(this.options.getWindow(), baselineHeight, viewport)
				: { dockTop: this.mobileComposerDockTop, source: this.mobileComposerDockSource };
			this.syncComposerDockOffset(composerDock.dockTop, baselineHeight);
			this.setComposerDockDiagnostics(composerDock, baselineHeight);
		});
	}

	private updateToolbarAnchorInset(): void {
		const contentEl = this.mobileComposerContentEl;
		const toolbarEl = this.options.getComposerBarEl();
		if (contentEl === null || toolbarEl === null) {
			return;
		}
		const contentBottom = contentEl.getBoundingClientRect().bottom;
		const toolbarWrapperBottom = toolbarEl.getBoundingClientRect().bottom;
		const toolbarAnchor = this.getToolbarVisualAnchorBottom(toolbarEl, toolbarWrapperBottom);
		if (!Number.isFinite(contentBottom)
			|| !Number.isFinite(toolbarWrapperBottom)
			|| !Number.isFinite(toolbarAnchor.bottom)
			|| (contentBottom > 0 && toolbarAnchor.bottom <= 0)) {
			return;
		}
		this.mobileComposerToolbarWrapperBottom = toolbarWrapperBottom;
		this.mobileComposerToolbarAnchorBottom = toolbarAnchor.bottom;
		this.mobileComposerToolbarAnchorSource = toolbarAnchor.source;
		this.mobileComposerToolbarAnchorInset = Math.max(0, contentBottom - toolbarAnchor.bottom);
	}

	private getToolbarVisualAnchorBottom(
		toolbarEl: HTMLElement,
		fallbackBottom: number,
	): { bottom: number; source: MobileComposerToolbarAnchorSource } {
		let buttonRowBottom = 0;
		const buttonEls = toolbarEl.querySelectorAll(".knomo-tool-button, .knomo-send-button, .knomo-cancel-edit-button");
		for (const buttonEl of Array.from(buttonEls)) {
			const buttonBottom = buttonEl.getBoundingClientRect().bottom;
			if (Number.isFinite(buttonBottom) && buttonBottom > 0) {
				buttonRowBottom = Math.max(buttonRowBottom, buttonBottom);
			}
		}
		if (buttonRowBottom > 0) {
			return { bottom: buttonRowBottom, source: "button-row" };
		}
		return { bottom: fallbackBottom, source: "toolbar-wrapper" };
	}

	private setComposerBottomOffset(bottomOffset: number): void {
		this.mobileComposerBottomOffset = Math.round(bottomOffset);
		const bottomOffsetValue = `${this.mobileComposerBottomOffset}px`;
		const fillHeightValue = `${Math.max(0, this.mobileComposerBottomOffset)}px`;
		for (const element of [this.options.getRootEl(), this.mobileComposerLayerEl]) {
			element?.style.setProperty("--knomo-mobile-composer-bottom-offset", bottomOffsetValue);
			element?.style.setProperty("--knomo-mobile-composer-fill-height", fillHeightValue);
		}
	}

	private setComposerDockDiagnostics(composerDock: MobileComposerDockTop, baselineHeight: number): void {
		const dockTopValue = `${Math.round(composerDock.dockTop)}px`;
		const baselineHeightValue = `${Math.round(baselineHeight)}px`;
		const layerBottomValue = `${Math.round(this.mobileComposerLayerBottom ?? baselineHeight)}px`;
		const bottomOffsetValue = `${Math.round(this.mobileComposerBottomOffset)}px`;
		const toolbarAnchorInsetValue = `${Math.round(this.mobileComposerToolbarAnchorInset ?? 0)}px`;
		const toolbarAnchorBottomValue = `${Math.round(this.mobileComposerToolbarAnchorBottom ?? 0)}px`;
		const toolbarWrapperBottomValue = `${Math.round(this.mobileComposerToolbarWrapperBottom ?? 0)}px`;
		const capacitorKeyboardHeightValue = `${Math.round(this.mobileCapacitorKeyboardHeight ?? 0)}px`;
		for (const element of [this.options.getRootEl(), this.mobileComposerLayerEl]) {
			element?.style.setProperty("--knomo-mobile-composer-dock-top", dockTopValue);
			element?.style.setProperty("--knomo-mobile-composer-baseline-height", baselineHeightValue);
			element?.style.setProperty("--knomo-mobile-composer-layer-bottom", layerBottomValue);
			element?.style.setProperty("--knomo-mobile-composer-applied-bottom-offset", bottomOffsetValue);
			element?.style.setProperty("--knomo-mobile-composer-toolbar-anchor-inset", toolbarAnchorInsetValue);
			element?.style.setProperty("--knomo-mobile-composer-toolbar-anchor-bottom", toolbarAnchorBottomValue);
			element?.style.setProperty("--knomo-mobile-composer-toolbar-wrapper-bottom", toolbarWrapperBottomValue);
			element?.style.setProperty("--knomo-mobile-composer-capacitor-keyboard-height", capacitorKeyboardHeightValue);
		}
		this.mobileComposerLayerEl?.setAttr("data-knomo-composer-dock-source", composerDock.source);
		this.mobileComposerLayerEl?.setAttr("data-knomo-composer-toolbar-anchor-source", this.mobileComposerToolbarAnchorSource);
	}

	private clearKeyboardMetrics(): void {
		const win = this.options.getWindow();
		this.mobileKeyboardHeight = 0;
		this.mobileComposerViewportBaselineHeight = null;
		this.mobileComposerDockTop = null;
		this.mobileComposerDockSource = "fallback";
		this.mobileComposerLayerBottom = null;
		this.mobileCapacitorKeyboardHeight = null;
		this.mobileComposerToolbarAnchorInset = null;
		this.mobileComposerToolbarAnchorBottom = null;
		this.mobileComposerToolbarAnchorSource = "unknown";
		this.mobileComposerToolbarWrapperBottom = null;
		this.setKeyboardMetrics(0, win.innerHeight, 0);
		this.setComposerBottomOffset(0);
		this.updateMeasurements();
	}

	private clearToolbarAnchorFrame(): void {
		if (this.mobileToolbarAnchorFrameId === null) {
			return;
		}
		this.options.getWindow().cancelAnimationFrame(this.mobileToolbarAnchorFrameId);
		this.mobileToolbarAnchorFrameId = null;
	}
}

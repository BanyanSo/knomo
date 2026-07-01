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
const MOBILE_COMPOSER_CLOSE_FALLBACK_DELAY = 420;
const MOBILE_COMPOSER_EXIT_TRANSITION_DELAY = 160;
const MOBILE_KEYBOARD_DOCK_STABLE_DELTA = 1;
const MOBILE_KEYBOARD_DOCK_SETTLE_DELAY = 120;
const MOBILE_KEYBOARD_VIEWPORT_FALLBACK_DELAY = 80;

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
	onClosed?: () => void;
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
	private mobileComposerOpenSyncFrameId: number | null = null;
	private mobileComposerResizeFrameId: number | null = null;
	private mobileKeyboardDockFrameId: number | null = null;
	private mobileKeyboardDockStopTimerId: number | null = null;
	private mobileKeyboardViewportFallbackTimerId: number | null = null;
	private mobileToolbarAnchorFrameId: number | null = null;
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
	private mobileComposerPrepared = false;

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

	prepare(): void {
		if (this.options.getLayout() !== "mobile") {
			return;
		}
		this.mobileComposerPrepared = true;
		this.ensureLayer();
		this.clearLayerState();
		this.initializeBaseMetrics();
		this.updateMeasurements();
		this.options.resizeInput();
		this.updateToolbarAnchorInset();
	}

	prepareDesktopOpen(): void {
		this.clearCloseTimer();
		this.mobileComposerPhase = "closed";
	}

	resetInactiveState(): void {
		this.clearFocus();
		this.stopViewportTracking();
	}

	dispose(): void {
		this.clearFocus();
		this.clearOpenSyncFrame();
		this.clearResizeFrame();
		this.stopKeyboardDockTracking();
		this.clearKeyboardViewportFallback();
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
		if (this.mobileComposerPrepared && this.options.getLayout() === "mobile") {
			this.ensureLayer();
			return;
		}
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
		this.clearOpenSyncFrame();
		this.options.setComposerOpen(true);
		this.mobileComposerPhase = "opening";
		this.ensureLayer();
		this.mobileComposerLayerEl?.toggleClass("is-active", true);
		this.mobileComposerLayerEl?.setAttr("aria-hidden", "false");
		this.mobileComposerRevealed = false;
		this.mobileComposerLayerEl?.toggleClass("is-open", false);
		this.mobileComposerLayerEl?.toggleClass("is-closing", false);
		this.mobileComposerViewportBaselineHeight = win.innerHeight;
		this.mobileComposerDockTop = win.innerHeight;
		this.mobileComposerDockSource = "fallback";
		this.mobileComposerLayerBottom = null;
		this.mobileKeyboardHeight = 0;
		this.mobileCapacitorKeyboardHeight = null;
		this.setKeyboardMetrics(0);
		this.setComposerBottomOffset(0);
		this.revealMobileComposer();
		this.mobileComposerPhase = "focusing";
		this.startViewportTracking();
		this.options.focusInputNow(false, false);
		this.queueViewportUpdate();
		this.scheduleKeyboardViewportFallback();
		this.scheduleOpenRootSync();
	}

	closeKeepingDraft(): void {
		this.mobileComposerOpenScrollTop = null;
		this.clearFocus();
		this.clearOpenSyncFrame();
		this.clearCloseTimer();
		this.mobileComposerPhase = "closing";
		this.clearKeyboardViewportFallback();
		this.mobileComposerLayerEl?.toggleClass("is-closing", true);
		this.options.getInputEl()?.blur();
		this.queueViewportUpdate();
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
		this.queueViewportUpdate();
		return this.mobileComposerPhase !== "opening" && this.mobileComposerPhase !== "focusing";
	}

	handleInputBlur(): boolean {
		if (this.options.getLayout() !== "mobile") {
			return true;
		}
		if (this.mobileComposerPhase === "closing") {
			return false;
		}
		this.queueViewportUpdate();
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
			return;
		}
		if (this.mobileVisualViewportHandler === null) {
			this.mobileVisualViewport = viewport;
			this.mobileVisualViewportHandler = () => this.queueViewportUpdate();
			viewport.addEventListener("resize", this.mobileVisualViewportHandler);
			viewport.addEventListener("scroll", this.mobileVisualViewportHandler);
		}
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
		this.clearKeyboardViewportFallback();
		this.clearToolbarAnchorFrame();
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
	}

	private clearOpenSyncFrame(): void {
		if (this.mobileComposerOpenSyncFrameId === null) {
			return;
		}
		this.options.getWindow().cancelAnimationFrame(this.mobileComposerOpenSyncFrameId);
		this.mobileComposerOpenSyncFrameId = null;
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

	private initializeBaseMetrics(): void {
		this.setKeyboardMetrics(0);
		this.setComposerBottomOffset(0);
	}

	private scheduleOpenRootSync(): void {
		this.clearOpenSyncFrame();
		const win = this.options.getWindow();
		this.mobileComposerOpenSyncFrameId = win.requestAnimationFrame(() => {
			this.mobileComposerOpenSyncFrameId = win.requestAnimationFrame(() => {
				this.mobileComposerOpenSyncFrameId = null;
				if (this.options.getLayout() !== "mobile" || !this.options.isComposerOpen()) {
					return;
				}
				this.options.syncRootState();
			});
		});
	}

	private scheduleKeyboardViewportFallback(): void {
		this.clearKeyboardViewportFallback();
		this.mobileKeyboardViewportFallbackTimerId = this.options.getWindow().setTimeout(() => {
			this.mobileKeyboardViewportFallbackTimerId = null;
			if (this.options.getLayout() === "mobile" && this.options.isComposerOpen()) {
				this.queueViewportUpdate();
			}
		}, MOBILE_KEYBOARD_VIEWPORT_FALLBACK_DELAY);
	}

	private clearKeyboardViewportFallback(): void {
		if (this.mobileKeyboardViewportFallbackTimerId === null) {
			return;
		}
		this.options.getWindow().clearTimeout(this.mobileKeyboardViewportFallbackTimerId);
		this.mobileKeyboardViewportFallbackTimerId = null;
	}

	updateMeasurements(): number {
		const win = this.options.getWindow();
		const viewport = this.mobileVisualViewport ?? win.visualViewport;
		const containerTop = Math.max(0, this.options.getContainerEl().getBoundingClientRect().top);
		const baselineHeight = this.mobileComposerViewportBaselineHeight ?? win.innerHeight;
		const toolbarHeight = this.options.getComposerBarEl()?.offsetHeight ?? 52;
		const referencePreviewEl = this.options.getReferencePreviewEl();
		const referenceHeight = referencePreviewEl !== null && referencePreviewEl.hasClass("is-visible")
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
			element?.setCssProps({
				"--knomo-composer-content-max-height": contentMaxHeightValue,
				"--knomo-composer-input-max-height": inputMaxHeightValue,
			});
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
		this.mobileComposerLayerEl?.toggleClass("is-active", false);
		this.mobileComposerLayerEl?.setAttr("aria-hidden", "true");
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
		this.mobileComposerPrepared = false;
	}

	private startKeyboardDockTracking(): void {
		if (this.options.getLayout() !== "mobile" || !this.options.isComposerOpen()) {
			return;
		}
		if (this.mobileKeyboardDockStopTimerId !== null) {
			this.options.getWindow().clearTimeout(this.mobileKeyboardDockStopTimerId);
			this.mobileKeyboardDockStopTimerId = null;
		}
		this.mobileComposerLayerEl?.toggleClass("is-keyboard-tracking", true);
		this.scheduleKeyboardDockFrame();
		this.mobileKeyboardDockStopTimerId = this.options.getWindow().setTimeout(() => {
			this.mobileKeyboardDockStopTimerId = null;
			this.stopKeyboardDockTracking();
		}, MOBILE_KEYBOARD_DOCK_SETTLE_DELAY);
	}

	private scheduleKeyboardDockFrame(): void {
		if (this.mobileKeyboardDockFrameId !== null) {
			return;
		}
		this.mobileKeyboardDockFrameId = this.options.getWindow().requestAnimationFrame(() => {
			this.mobileKeyboardDockFrameId = null;
			this.updateKeyboardMetrics();
			if (this.mobileComposerPhase === "opening" || this.mobileComposerPhase === "focusing") {
				this.mobileComposerPhase = "open";
			}
		});
	}

	private stopKeyboardDockTracking(): void {
		if (this.mobileKeyboardDockFrameId !== null) {
			this.options.getWindow().cancelAnimationFrame(this.mobileKeyboardDockFrameId);
			this.mobileKeyboardDockFrameId = null;
		}
		if (this.mobileKeyboardDockStopTimerId !== null) {
			this.options.getWindow().clearTimeout(this.mobileKeyboardDockStopTimerId);
			this.mobileKeyboardDockStopTimerId = null;
		}
		this.mobileComposerLayerEl?.toggleClass("is-keyboard-tracking", false);
		if (this.options.getLayout() === "mobile"
			&& this.options.isComposerOpen()
			&& this.mobileComposerPhase !== "closing") {
			this.updateMeasurements();
			this.options.resizeInput();
			this.refreshToolbarAnchorAndDock();
		}
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
		this.setKeyboardMetrics(keyboardHeight);
		this.syncComposerDockOffset(composerDock, baselineHeight);
		this.mobileComposerLayerEl?.setAttr("data-knomo-composer-dock-source", composerDock.source);
		this.maybeFinishClosingAfterDockSettles();
	}

	private handleViewportOrientationChange(): void {
		if (this.mobileKeyboardHeight === 0 && this.mobileComposerBottomOffset === 0) {
			this.mobileComposerViewportBaselineHeight = this.options.getWindow().innerHeight;
			this.mobileComposerDockTop = this.mobileComposerViewportBaselineHeight;
			this.mobileComposerDockSource = "fallback";
		}
		this.scheduleResize();
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
		this.clearKeyboardViewportFallback();
		this.queueViewportUpdate();
	}

	private handleCapacitorKeyboardHide(): void {
		this.mobileCapacitorKeyboardHeight = 0;
		if (this.options.getLayout() !== "mobile" || !this.options.isComposerOpen()) {
			return;
		}
		this.clearKeyboardViewportFallback();
		this.queueViewportUpdate();
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

	private revealMobileComposer(): void {
		if (this.mobileComposerRevealed) {
			return;
		}
		this.mobileComposerRevealed = true;
		this.mobileComposerLayerEl?.toggleClass("is-open", true);
	}

	private maybeFinishClosingAfterDockSettles(): void {
		if (this.mobileComposerPhase !== "closing") {
			return;
		}
		if (Math.abs(this.mobileComposerBottomOffset) > MOBILE_KEYBOARD_DOCK_STABLE_DELTA
			|| this.mobileKeyboardHeight > 0) {
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
		this.clearLayerState();
		if (!this.mobileComposerPrepared) {
			this.restoreLayer();
			this.mobileComposerLayerEl?.detach();
		}
		this.stopViewportTracking(false);
		this.clearKeyboardMetrics();
		this.options.setComposerOpen(false);
		this.mobileComposerPhase = "closed";
		this.options.syncRootState();
		this.options.syncComposerMode();
		this.options.updateSendButtonState();
		this.options.updateCancelEditButtonState();
		this.options.onClosed?.();
	}

	private setKeyboardMetrics(keyboardHeight: number): void {
		const keyboardHeightValue = `${Math.round(keyboardHeight)}px`;
		this.mobileComposerLayerEl?.setCssProps({ "--knomo-keyboard-height": keyboardHeightValue });
		this.mobileComposerLayerEl?.toggleClass("is-keyboard-open", keyboardHeight > 0);
	}

	private syncComposerDockOffset(composerDock: MobileComposerDockTop, baselineHeight: number): void {
		const layerBottom = composerDock.source === "layout-viewport"
			? this.options.getWindow().innerHeight
			: baselineHeight;
		this.mobileComposerLayerBottom = layerBottom;
		if (composerDock.dockTop >= baselineHeight) {
			this.setComposerBottomOffset(0);
			return;
		}
		const toolbarAnchorInset = this.mobileComposerToolbarAnchorInset ?? 0;
		const nextBottomOffset = calculateMobileComposerDockOffset({
			layerBottom,
			composerDockTop: composerDock.dockTop,
			toolbarAnchorInset,
			targetGap: MOBILE_COMPOSER_TOOLBAR_KEYBOARD_GAP,
		});
		this.setComposerBottomOffset(nextBottomOffset);
	}

	private scheduleToolbarAnchorRefresh(): void {
		if (this.mobileToolbarAnchorFrameId !== null) {
			return;
		}
		this.mobileToolbarAnchorFrameId = this.options.getWindow().requestAnimationFrame(() => {
			this.mobileToolbarAnchorFrameId = null;
			this.refreshToolbarAnchorAndDock();
		});
	}

	private refreshToolbarAnchorAndDock(): void {
		this.updateToolbarAnchorInset();
		const win = this.options.getWindow();
		const baselineHeight = this.mobileComposerViewportBaselineHeight ?? win.innerHeight;
		const viewport = this.mobileVisualViewport ?? win.visualViewport;
		const composerDock = this.mobileComposerDockTop === null
			? this.getComposerDockTop(win, baselineHeight, viewport)
			: { dockTop: this.mobileComposerDockTop, source: this.mobileComposerDockSource };
		this.syncComposerDockOffset(composerDock, baselineHeight);
		this.setComposerDockDiagnostics(composerDock, baselineHeight);
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
		this.mobileComposerLayerEl?.setCssProps({ "--knomo-mobile-composer-bottom-offset": bottomOffsetValue });
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
			element?.setCssProps({
				"--knomo-mobile-composer-dock-top": dockTopValue,
				"--knomo-mobile-composer-baseline-height": baselineHeightValue,
				"--knomo-mobile-composer-layer-bottom": layerBottomValue,
				"--knomo-mobile-composer-applied-bottom-offset": bottomOffsetValue,
				"--knomo-mobile-composer-toolbar-anchor-inset": toolbarAnchorInsetValue,
				"--knomo-mobile-composer-toolbar-anchor-bottom": toolbarAnchorBottomValue,
				"--knomo-mobile-composer-toolbar-wrapper-bottom": toolbarWrapperBottomValue,
				"--knomo-mobile-composer-capacitor-keyboard-height": capacitorKeyboardHeightValue,
			});
		}
		this.mobileComposerLayerEl?.setAttr("data-knomo-composer-dock-source", composerDock.source);
		this.mobileComposerLayerEl?.setAttr("data-knomo-composer-toolbar-anchor-source", this.mobileComposerToolbarAnchorSource);
	}

	private clearKeyboardMetrics(): void {
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
		this.setKeyboardMetrics(0);
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

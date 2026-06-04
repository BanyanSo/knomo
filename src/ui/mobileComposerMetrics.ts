export interface MobileKeyboardMetricsInput {
	baselineHeight: number;
	windowHeight: number;
	viewportOffsetTop: number | null;
	viewportHeight: number | null;
}

export interface MobileKeyboardMetrics {
	visibleTop: number;
	visibleHeight: number;
	keyboardHeight: number;
}

export interface MobileComposerMeasurementsInput {
	baselineHeight: number;
	windowHeight: number;
	viewportOffsetTop: number | null;
	viewportHeight: number | null;
	containerTop: number;
	composerDockTop: number;
	toolbarHeight: number;
	referenceHeight: number;
	topGuard: number;
}

export interface MobileComposerMeasurements {
	contentMaxHeight: number;
	inputMaxHeight: number;
}

export interface MobileComposerDockOffsetInput {
	layerBottom: number;
	composerDockTop: number;
	toolbarAnchorInset: number;
	targetGap: number;
}

export type MobileComposerDockTopSource = "capacitor-keyboard" | "virtual-keyboard" | "visual-viewport" | "layout-viewport" | "fallback";

const MOBILE_COMPOSER_DOCK_MIN_DELTA = 8;

export interface MobileComposerDockTopInput {
	baselineHeight: number;
	windowHeight: number;
	viewportOffsetTop: number | null;
	viewportHeight: number | null;
	capacitorKeyboardHeight: number | null;
	virtualKeyboardRectY: number | null;
	virtualKeyboardRectHeight: number | null;
}

export interface MobileComposerDockTop {
	dockTop: number;
	source: MobileComposerDockTopSource;
}

export function calculateMobileKeyboardMetrics(input: MobileKeyboardMetricsInput): MobileKeyboardMetrics {
	const visibleTop = input.viewportOffsetTop === null ? 0 : Math.max(0, input.viewportOffsetTop);
	const visibleHeight = input.viewportHeight === null ? input.windowHeight : Math.max(0, input.viewportHeight);
	const visibleBottom = visibleTop + visibleHeight;
	let keyboardHeight = Math.max(0, input.baselineHeight - visibleBottom);
	if (keyboardHeight < 80) {
		keyboardHeight = 0;
	}
	return {
		visibleTop,
		visibleHeight,
		keyboardHeight,
	};
}

export function calculateMobileComposerDockTop(input: MobileComposerDockTopInput): MobileComposerDockTop {
	const baselineHeight = Number.isFinite(input.baselineHeight) ? Math.max(0, input.baselineHeight) : 0;
	const windowHeight = Number.isFinite(input.windowHeight) ? Math.max(0, input.windowHeight) : baselineHeight;
	const dockLimit = Math.max(0, baselineHeight, windowHeight);
	if (input.capacitorKeyboardHeight !== null && Number.isFinite(input.capacitorKeyboardHeight)) {
		if (input.capacitorKeyboardHeight <= 0) {
			return {
				dockTop: Math.round(Math.max(0, baselineHeight || windowHeight)),
				source: "fallback",
			};
		}
		const capacitorDockTop = baselineHeight - input.capacitorKeyboardHeight;
		if (capacitorDockTop >= 0
			&& capacitorDockTop <= dockLimit
			&& isMovedDockTop(capacitorDockTop, baselineHeight)) {
			return {
				dockTop: Math.round(capacitorDockTop),
				source: "capacitor-keyboard",
			};
		}
	}
	if (input.virtualKeyboardRectY !== null
		&& input.virtualKeyboardRectHeight !== null
		&& Number.isFinite(input.virtualKeyboardRectY)
		&& Number.isFinite(input.virtualKeyboardRectHeight)
		&& input.virtualKeyboardRectHeight > 0
		&& input.virtualKeyboardRectY >= 0
		&& input.virtualKeyboardRectY <= dockLimit
		&& isMovedDockTop(input.virtualKeyboardRectY, baselineHeight)) {
		return {
			dockTop: Math.round(input.virtualKeyboardRectY),
			source: "virtual-keyboard",
		};
	}
	if (input.viewportOffsetTop !== null
		&& input.viewportHeight !== null
		&& Number.isFinite(input.viewportOffsetTop)
		&& Number.isFinite(input.viewportHeight)) {
		const visualViewportDockTop = Math.max(0, input.viewportOffsetTop + input.viewportHeight);
		if (visualViewportDockTop <= dockLimit && isMovedDockTop(visualViewportDockTop, baselineHeight)) {
			return {
				dockTop: Math.round(visualViewportDockTop),
				source: "visual-viewport",
			};
		}
	}
	if (windowHeight <= dockLimit && isMovedDockTop(windowHeight, baselineHeight)) {
		return {
			dockTop: Math.round(windowHeight),
			source: "layout-viewport",
		};
	}
	return {
		dockTop: Math.round(Math.max(0, baselineHeight || windowHeight)),
		source: "fallback",
	};
}

function isMovedDockTop(dockTop: number, baselineHeight: number): boolean {
	return Number.isFinite(dockTop) && baselineHeight - dockTop >= MOBILE_COMPOSER_DOCK_MIN_DELTA;
}

export function calculateMobileComposerDockOffset(input: MobileComposerDockOffsetInput): number {
	const nextBottomOffset = input.layerBottom - input.composerDockTop + input.targetGap - input.toolbarAnchorInset;
	return Math.round(nextBottomOffset);
}

export function calculateMobileComposerMeasurements(input: MobileComposerMeasurementsInput): MobileComposerMeasurements {
	const viewportTop = input.viewportOffsetTop === null ? 0 : Math.max(0, input.viewportOffsetTop);
	const topLimit = Math.max(viewportTop + input.topGuard, input.containerTop + 8);
	const contentMaxHeight = Math.round(Math.max(160, input.composerDockTop - topLimit));
	const inputMaxHeight = Math.round(Math.max(120, contentMaxHeight - input.toolbarHeight - input.referenceHeight - 32));
	return {
		contentMaxHeight,
		inputMaxHeight,
	};
}

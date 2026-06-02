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
	keyboardHeight: number;
	toolbarHeight: number;
	referenceHeight: number;
	topGuard: number;
}

export interface MobileComposerMeasurements {
	contentMaxHeight: number;
	inputMaxHeight: number;
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

export function getMobileKeyboardFallbackHeight(baselineHeight: number, windowHeight: number): number {
	const height = baselineHeight > 0 ? baselineHeight : windowHeight;
	return Math.round(Math.min(Math.max(height * 0.42, 300), 430));
}

export function calculateMobileComposerMeasurements(input: MobileComposerMeasurementsInput): MobileComposerMeasurements {
	const viewportTop = input.viewportOffsetTop === null ? 0 : Math.max(0, input.viewportOffsetTop);
	const topLimit = Math.max(viewportTop + input.topGuard, input.containerTop + 8);
	const keyboardTop = input.keyboardHeight > 0
		? input.baselineHeight - input.keyboardHeight
		: input.viewportHeight === null
			? input.windowHeight
			: viewportTop + input.viewportHeight;
	const contentMaxHeight = Math.round(Math.max(160, keyboardTop - topLimit));
	const inputMaxHeight = Math.round(Math.max(120, contentMaxHeight - input.toolbarHeight - input.referenceHeight - 32));
	return {
		contentMaxHeight,
		inputMaxHeight,
	};
}

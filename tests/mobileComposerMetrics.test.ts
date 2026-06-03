import test from "node:test";
import assert from "node:assert/strict";

import {
	calculateMobileComposerDockOffset,
	calculateMobileComposerMeasurements,
	calculateMobileKeyboardMetrics,
	getMobileKeyboardFallbackHeight,
} from "../src/ui/mobileComposerMetrics";

test("calculates mobile keyboard height from the visual viewport", () => {
	assert.deepEqual(calculateMobileKeyboardMetrics({
		baselineHeight: 800,
		windowHeight: 800,
		viewportOffsetTop: 0,
		viewportHeight: 500,
	}), {
		visibleTop: 0,
		visibleHeight: 500,
		keyboardHeight: 300,
	});
});

test("ignores tiny visual viewport differences as keyboard noise", () => {
	assert.deepEqual(calculateMobileKeyboardMetrics({
		baselineHeight: 800,
		windowHeight: 800,
		viewportOffsetTop: 0,
		viewportHeight: 730,
	}), {
		visibleTop: 0,
		visibleHeight: 730,
		keyboardHeight: 0,
	});
});

test("clamps mobile keyboard fallback height", () => {
	assert.equal(getMobileKeyboardFallbackHeight(500, 500), 300);
	assert.equal(getMobileKeyboardFallbackHeight(900, 900), 378);
	assert.equal(getMobileKeyboardFallbackHeight(1200, 1200), 430);
});

test("calculates mobile composer dock offset from the keyboard top", () => {
	assert.equal(calculateMobileComposerDockOffset({
		baselineHeight: 800,
		keyboardTop: 500,
		toolbarAnchorInset: 20,
		targetGap: 0,
	}), 280);
	assert.equal(calculateMobileComposerDockOffset({
		baselineHeight: 800,
		keyboardTop: 500,
		toolbarAnchorInset: 8,
		targetGap: 12,
	}), 304);
	assert.equal(calculateMobileComposerDockOffset({
		baselineHeight: 800,
		keyboardTop: 790,
		toolbarAnchorInset: 20,
		targetGap: 0,
	}), 0);
});

test("calculates mobile composer content and input heights", () => {
	assert.deepEqual(calculateMobileComposerMeasurements({
		baselineHeight: 800,
		windowHeight: 800,
		viewportOffsetTop: 0,
		viewportHeight: 500,
		containerTop: 20,
		keyboardHeight: 300,
		toolbarHeight: 52,
		referenceHeight: 20,
		topGuard: 52,
	}), {
		contentMaxHeight: 448,
		inputMaxHeight: 344,
	});
});

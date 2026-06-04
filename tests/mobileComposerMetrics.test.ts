import test from "node:test";
import assert from "node:assert/strict";

import {
	calculateMobileComposerDockTop,
	calculateMobileComposerDockOffset,
	calculateMobileComposerMeasurements,
	calculateMobileKeyboardMetrics,
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

test("calculates mobile composer dock offset from the composer dock top", () => {
	assert.equal(calculateMobileComposerDockOffset({
		layerBottom: 800,
		composerDockTop: 500,
		toolbarAnchorInset: 20,
		targetGap: 0,
	}), 280);
	assert.equal(calculateMobileComposerDockOffset({
		layerBottom: 800,
		composerDockTop: 500,
		toolbarAnchorInset: 8,
		targetGap: 12,
	}), 304);
	assert.equal(calculateMobileComposerDockOffset({
		layerBottom: 500,
		composerDockTop: 500,
		toolbarAnchorInset: 20,
		targetGap: 0,
	}), -20);
});

test("prefers a valid virtual keyboard rect for the composer dock top", () => {
	assert.deepEqual(calculateMobileComposerDockTop({
		baselineHeight: 800,
		windowHeight: 800,
		viewportOffsetTop: 0,
		viewportHeight: 800,
		capacitorKeyboardHeight: null,
		virtualKeyboardRectY: 520,
		virtualKeyboardRectHeight: 280,
	}), {
		dockTop: 520,
		source: "virtual-keyboard",
	});
});

test("prefers a valid Capacitor keyboard height for the composer dock top", () => {
	assert.deepEqual(calculateMobileComposerDockTop({
		baselineHeight: 800,
		windowHeight: 800,
		viewportOffsetTop: 0,
		viewportHeight: 500,
		capacitorKeyboardHeight: 260,
		virtualKeyboardRectY: 520,
		virtualKeyboardRectHeight: 280,
	}), {
		dockTop: 540,
		source: "capacitor-keyboard",
	});
});

test("treats zero Capacitor keyboard height as a closed keyboard signal", () => {
	assert.deepEqual(calculateMobileComposerDockTop({
		baselineHeight: 800,
		windowHeight: 800,
		viewportOffsetTop: 0,
		viewportHeight: 500,
		capacitorKeyboardHeight: 0,
		virtualKeyboardRectY: 520,
		virtualKeyboardRectHeight: 280,
	}), {
		dockTop: 800,
		source: "fallback",
	});
});

test("falls back from invalid virtual keyboard rects to the visual viewport bottom", () => {
	assert.deepEqual(calculateMobileComposerDockTop({
		baselineHeight: 800,
		windowHeight: 800,
		viewportOffsetTop: 24,
		viewportHeight: 500,
		capacitorKeyboardHeight: null,
		virtualKeyboardRectY: 0,
		virtualKeyboardRectHeight: 0,
	}), {
		dockTop: 524,
		source: "visual-viewport",
	});
});

test("uses the layout viewport when the visual viewport is stale", () => {
	assert.deepEqual(calculateMobileComposerDockTop({
		baselineHeight: 800,
		windowHeight: 500,
		viewportOffsetTop: 0,
		viewportHeight: 800,
		capacitorKeyboardHeight: null,
		virtualKeyboardRectY: 0,
		virtualKeyboardRectHeight: 0,
	}), {
		dockTop: 500,
		source: "layout-viewport",
	});
});

test("does not treat tiny viewport movement as a dock change", () => {
	assert.deepEqual(calculateMobileComposerDockTop({
		baselineHeight: 800,
		windowHeight: 796,
		viewportOffsetTop: 0,
		viewportHeight: 796,
		capacitorKeyboardHeight: null,
		virtualKeyboardRectY: 0,
		virtualKeyboardRectHeight: 0,
	}), {
		dockTop: 800,
		source: "fallback",
	});
});

test("calculates mobile composer content and input heights", () => {
	assert.deepEqual(calculateMobileComposerMeasurements({
		baselineHeight: 800,
		windowHeight: 800,
		viewportOffsetTop: 0,
		viewportHeight: 500,
		containerTop: 20,
		composerDockTop: 500,
		toolbarHeight: 52,
		referenceHeight: 20,
		topGuard: 52,
	}), {
		contentMaxHeight: 448,
		inputMaxHeight: 344,
	});
});

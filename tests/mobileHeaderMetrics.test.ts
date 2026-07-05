import test from "node:test";
import assert from "node:assert/strict";

import {
	measureMobileHeaderOffsets,
	MOBILE_DRAWER_TOP_DEFAULT,
	MOBILE_SEARCH_TOP_DEFAULT,
} from "../src/ui/mobileHeaderMetrics";

test("mobile header metrics align search top to Knomo header action", () => {
	const header = new TestElement(rect({ top: 20, bottom: 72, width: 400, height: 52 }));
	const action = new TestElement(rect({ top: 24, bottom: 68, width: 44, height: 44 }));
	header.setQuery(".view-actions .knomo-mobile-header-action", action);

	assert.deepEqual(measureMobileHeaderOffsets(header.asHtml(), 800), {
		drawerTop: 72,
		searchTop: 24,
	});
});

test("mobile header metrics fall back through header content anchors", () => {
	const header = new TestElement(rect({ top: 18, bottom: 70.2, width: 400, height: 52.2 }));
	const hiddenActions = new TestElement(rect({ top: 0, bottom: 0, width: 0, height: 0 }));
	const title = new TestElement(rect({ top: 25.6, bottom: 57.6, width: 110, height: 32 }));
	header.setQuery(".view-actions", hiddenActions);
	header.setQuery(".view-header-title", title);

	assert.deepEqual(measureMobileHeaderOffsets(header.asHtml(), 800), {
		drawerTop: 71,
		searchTop: 26,
	});
});

test("mobile header metrics fall back to header top when no content anchor is usable", () => {
	const header = new TestElement(rect({ top: 19.4, bottom: 68, width: 400, height: 48.6 }));

	assert.deepEqual(measureMobileHeaderOffsets(header.asHtml(), 800), {
		drawerTop: 68,
		searchTop: 19,
	});
});

test("mobile header metrics reject hidden or offscreen headers", () => {
	const hiddenHeader = new TestElement(rect({ top: 0, bottom: 0, width: 0, height: 0 }));
	const offscreenHeader = new TestElement(rect({ top: 420, bottom: 480, width: 400, height: 60 }));

	assert.equal(measureMobileHeaderOffsets(null, 800), null);
	assert.equal(measureMobileHeaderOffsets(hiddenHeader.asHtml(), 800), null);
	assert.equal(measureMobileHeaderOffsets(offscreenHeader.asHtml(), 800), null);
	assert.equal(MOBILE_DRAWER_TOP_DEFAULT.includes("safe-area-inset-top"), true);
	assert.equal(MOBILE_SEARCH_TOP_DEFAULT.includes("safe-area-inset-top"), true);
});

interface RectInput {
	top: number;
	bottom: number;
	width: number;
	height: number;
}

class TestElement {
	readonly win = {
		HTMLElement: TestElement as unknown as typeof HTMLElement,
	};
	private readonly queryResults = new Map<string, TestElement>();

	constructor(private readonly rectValue: DOMRect) {}

	asHtml(): HTMLElement {
		return this as unknown as HTMLElement;
	}

	setQuery(selector: string, element: TestElement): void {
		this.queryResults.set(selector, element);
	}

	querySelector(selector: string): TestElement | null {
		return this.queryResults.get(selector) ?? null;
	}

	getBoundingClientRect(): DOMRect {
		return this.rectValue;
	}

	instanceOf(constructor: unknown): boolean {
		return constructor === TestElement;
	}
}

function rect(input: RectInput): DOMRect {
	return {
		x: 0,
		y: input.top,
		left: 0,
		right: input.width,
		top: input.top,
		bottom: input.bottom,
		width: input.width,
		height: input.height,
		toJSON: () => ({}),
	} as DOMRect;
}

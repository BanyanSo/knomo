import test from "node:test";
import assert from "node:assert/strict";

import { ImagePreviewScrollLock } from "../src/ui/ImagePreviewScrollLock";

test("image preview scroll lock restores card flow and mobile search scroll", () => {
	const lock = new ImagePreviewScrollLock();
	const cardFlow = createScrollElement(128);
	const mobileSearch = createScrollElement(56);

	lock.lock(cardFlow.element, mobileSearch.element);

	assert.equal(cardFlow.hasClass("is-image-preview-open"), true);
	assert.equal(mobileSearch.hasClass("is-image-preview-open"), true);

	cardFlow.element.scrollTop = 12;
	mobileSearch.element.scrollTop = 8;
	let restoredCardFlowScrollTop: number | null | undefined;

	lock.unlock(cardFlow.element, mobileSearch.element, (scrollTop) => {
		restoredCardFlowScrollTop = scrollTop;
		cardFlow.element.scrollTop = scrollTop ?? 0;
	});

	assert.equal(restoredCardFlowScrollTop, 128);
	assert.equal(cardFlow.element.scrollTop, 128);
	assert.equal(mobileSearch.element.scrollTop, 56);
	assert.equal(cardFlow.hasClass("is-image-preview-open"), false);
	assert.equal(mobileSearch.hasClass("is-image-preview-open"), false);
});

test("image preview scroll lock handles missing card flow without restoring it", () => {
	const lock = new ImagePreviewScrollLock();
	const mobileSearch = createScrollElement(72);
	let restoredCardFlow = false;

	lock.lock(null, mobileSearch.element);
	mobileSearch.element.scrollTop = 6;
	lock.unlock(null, mobileSearch.element, () => {
		restoredCardFlow = true;
	});

	assert.equal(restoredCardFlow, false);
	assert.equal(mobileSearch.element.scrollTop, 72);
	assert.equal(mobileSearch.hasClass("is-image-preview-open"), false);
});

test("image preview scroll lock clears stale scroll state after unlock", () => {
	const lock = new ImagePreviewScrollLock();
	const cardFlow = createScrollElement(96);
	let restoredCardFlowScrollTop: number | null | undefined;

	lock.lock(cardFlow.element, null);
	lock.unlock(null, null, () => {
		throw new Error("card flow should not be restored when the element is missing");
	});
	lock.unlock(cardFlow.element, null, (scrollTop) => {
		restoredCardFlowScrollTop = scrollTop;
	});

	assert.equal(restoredCardFlowScrollTop, null);
	assert.equal(cardFlow.hasClass("is-image-preview-open"), false);
});

function createScrollElement(scrollTop: number): {
	element: HTMLElement;
	hasClass: (className: string) => boolean;
} {
	const classNames = new Set<string>();
	const element = {
		scrollTop,
		addClass(className: string): void {
			classNames.add(className);
		},
		removeClass(className: string): void {
			classNames.delete(className);
		},
	} as unknown as HTMLElement;
	return {
		element,
		hasClass: (className) => classNames.has(className),
	};
}

import test from "node:test";
import assert from "node:assert/strict";
import { ensureObsidianStub } from "./helpers/obsidianStub";

test("image preview swipe requires clear horizontal intent", async () => {
	const { getImageSwipeDirection } = await loadImagePreviewModule();

	assert.equal(getImageSwipeDirection(-64, 8, 420), "next");
	assert.equal(getImageSwipeDirection(64, 8, 420), "previous");
	assert.equal(getImageSwipeDirection(-28, 4, 160), "next");
	assert.equal(getImageSwipeDirection(-20, 2, 120), null);
	assert.equal(getImageSwipeDirection(-64, 48, 180), null);
	assert.equal(getImageSwipeDirection(-12, 64, 120), null);
});

test("image preview adjacent indexes wrap without duplicates or overflow", async () => {
	const { getAdjacentImageIndexes } = await loadImagePreviewModule();

	assert.deepEqual(getAdjacentImageIndexes(0, 0), []);
	assert.deepEqual(getAdjacentImageIndexes(0, 1), []);
	assert.deepEqual(getAdjacentImageIndexes(0, 2), [1]);
	assert.deepEqual(getAdjacentImageIndexes(0, 3), [1, 2]);
	assert.deepEqual(getAdjacentImageIndexes(2, 4), [3, 1]);
});

test("image preview loading state toggles class and aria busy", async () => {
	const { setImagePreviewLoadingState } = await loadImagePreviewModule();
	const stage = new TestElement();

	setImagePreviewLoadingState(stage.asHtml(), true);
	assert.equal(stage.hasClass("is-loading"), true);
	assert.equal(stage.getAttr("aria-busy"), "true");

	setImagePreviewLoadingState(stage.asHtml(), false);
	assert.equal(stage.hasClass("is-loading"), false);
	assert.equal(stage.getAttr("aria-busy"), null);
});

async function loadImagePreviewModule(): Promise<typeof import("../src/ui/KnomoImagePreviewModal")> {
	await ensureObsidianStub();
	return import("../src/ui/KnomoImagePreviewModal");
}

class TestElement {
	private readonly classes = new Set<string>();
	private readonly attributes = new Map<string, string>();

	asHtml(): HTMLElement {
		return this as unknown as HTMLElement;
	}

	toggleClass(cls: string, active: boolean): void {
		if (active) {
			this.classes.add(cls);
		} else {
			this.classes.delete(cls);
		}
	}

	hasClass(cls: string): boolean {
		return this.classes.has(cls);
	}

	setAttr(name: string, value: string): void {
		this.attributes.set(name, value);
	}

	getAttr(name: string): string | null {
		return this.attributes.get(name) ?? null;
	}

	removeAttribute(name: string): void {
		this.attributes.delete(name);
	}
}

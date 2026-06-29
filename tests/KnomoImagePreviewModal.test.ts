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
	assert.deepEqual(getAdjacentImageIndexes(0, 3), [2, 1]);
	assert.deepEqual(getAdjacentImageIndexes(2, 4), [1, 3]);
});

async function loadImagePreviewModule(): Promise<typeof import("../src/ui/KnomoImagePreviewModal")> {
	await ensureObsidianStub();
	return import("../src/ui/KnomoImagePreviewModal");
}

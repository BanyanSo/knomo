import test from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

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

async function ensureObsidianStub(): Promise<void> {
	const stubPath = resolve(__dirname, "../node_modules/obsidian/index.js");
	await mkdir(dirname(stubPath), { recursive: true });
	await writeFile(
		stubPath,
		[
			"class Modal {}",
			"const Platform = { isMobile: false };",
			"let languageValue = 'en';",
			"function getLanguage() { return languageValue; }",
			"function setIcon() {}",
			"module.exports = { Modal, Platform, getLanguage, setIcon };",
		].join("\n"),
	);
}

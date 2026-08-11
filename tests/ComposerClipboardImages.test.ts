import test from "node:test";
import assert from "node:assert/strict";

import {
	getClipboardImageFiles,
	handleComposerClipboardImagePaste,
	type ComposerClipboardImagePasteEvent,
} from "../src/ui/ComposerClipboardImages";

test("composer clipboard paste intercepts image items", () => {
	const image = createTestFile("screenshot.png", "image/png");
	const event = createPasteEvent({
		items: [createClipboardItem("file", "image/png", image)],
		files: [image],
	});
	const insertions: Array<readonly File[]> = [];

	const handled = handleComposerClipboardImagePaste(event, (files) => {
		insertions.push(files);
	});

	assert.equal(handled, true);
	assert.equal(event.prevented, true);
	assert.deepEqual(insertions, [[image]]);
});

test("composer clipboard paste keeps ordinary text paste native", () => {
	const event = createPasteEvent({
		items: [createClipboardItem("string", "text/plain", null)],
		files: [],
	});
	let insertionCount = 0;

	const handled = handleComposerClipboardImagePaste(event, () => {
		insertionCount += 1;
	});

	assert.equal(handled, false);
	assert.equal(event.prevented, false);
	assert.equal(insertionCount, 0);
});

test("composer clipboard paste ignores non-image files", () => {
	const document = createTestFile("notes.pdf", "application/pdf");
	const event = createPasteEvent({
		items: [createClipboardItem("file", "application/pdf", document)],
		files: [document],
	});

	assert.equal(handleComposerClipboardImagePaste(event, () => undefined), false);
	assert.equal(event.prevented, false);
});

test("clipboard image extraction falls back to the files list", () => {
	const image = createTestFile("photo.jpeg", "image/jpeg");
	const clipboardData = createClipboardData({
		items: [createClipboardItem("file", "image/jpeg", null)],
		files: [image],
	});

	assert.deepEqual(getClipboardImageFiles(clipboardData), [image]);
});

test("already handled paste events are left untouched", () => {
	const image = createTestFile("screenshot.png", "image/png");
	const event = createPasteEvent({
		items: [createClipboardItem("file", "image/png", image)],
		files: [image],
	});
	event.defaultPrevented = true;

	assert.equal(handleComposerClipboardImagePaste(event, () => undefined), false);
	assert.equal(event.prevented, false);
});

function createTestFile(name: string, type: string): File {
	return { name, type } as File;
}

function createClipboardItem(kind: DataTransferItem["kind"], type: string, file: File | null): DataTransferItem {
	return {
		kind,
		type,
		getAsFile: () => file,
	} as DataTransferItem;
}

function createClipboardData(options: {
	items: readonly DataTransferItem[];
	files: readonly File[];
}): DataTransfer {
	return {
		items: options.items,
		files: options.files,
	} as unknown as DataTransfer;
}

function createPasteEvent(options: {
	items: readonly DataTransferItem[];
	files: readonly File[];
}): ComposerClipboardImagePasteEvent & {
	defaultPrevented: boolean;
	prevented: boolean;
} {
	return {
		defaultPrevented: false,
		prevented: false,
		clipboardData: createClipboardData(options),
		preventDefault() {
			this.prevented = true;
			this.defaultPrevented = true;
		},
	};
}

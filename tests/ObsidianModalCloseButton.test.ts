import test from "node:test";
import assert from "node:assert/strict";

import { removeObsidianModalCloseButtons } from "../src/ui/ObsidianModalCloseButton";

test("removes Obsidian 1.12 and 1.13 native modal close buttons", () => {
	const queriedSelectors: string[] = [];
	const removedSelectors: string[] = [];
	const modalEl = {
		querySelector: (selector: string) => {
			queriedSelectors.push(selector);
			return {
				remove: () => {
					removedSelectors.push(selector);
				},
			};
		},
	} as unknown as HTMLElement;

	removeObsidianModalCloseButtons(modalEl);

	assert.deepEqual(queriedSelectors, [
		":scope > .modal-close-button",
		":scope > .modal-header-button",
	]);
	assert.deepEqual(removedSelectors, queriedSelectors);
});


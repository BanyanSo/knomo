import test from "node:test";
import assert from "node:assert/strict";

import { getPreferredComposerSourcePath } from "../src/ui/ComposerSourcePath";

test("composer source path prefers today's daily note", () => {
	assert.equal(getPreferredComposerSourcePath({
		todayDailyNotePath: "Daily/2026-06-02.md",
		activeFile: {
			path: "Notes/Active.md",
			extension: "md",
		},
	}), "Daily/2026-06-02.md");
});

test("composer source path falls back to the active Markdown file", () => {
	assert.equal(getPreferredComposerSourcePath({
		todayDailyNotePath: null,
		activeFile: {
			path: "Notes/Active.md",
			extension: "md",
		},
	}), "Notes/Active.md");
});

test("composer source path ignores non-Markdown active files", () => {
	assert.equal(getPreferredComposerSourcePath({
		todayDailyNotePath: null,
		activeFile: {
			path: "Images/photo.png",
			extension: "png",
		},
	}), null);
	assert.equal(getPreferredComposerSourcePath({
		todayDailyNotePath: null,
		activeFile: null,
	}), null);
});

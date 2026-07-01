import test from "node:test";
import assert from "node:assert/strict";

import { getMemoTaskCheckboxChangePlan } from "../src/ui/MemoTaskCheckboxChange";

test("memo task checkbox plan checks an unchecked task", () => {
	assert.deepEqual(getMemoTaskCheckboxChangePlan("- [ ] task", 0, true), {
		type: "apply",
		marker: "x",
		nextContent: "- [x] task",
		shouldEnqueue: true,
	});
});

test("memo task checkbox plan unchecks a completed task", () => {
	assert.deepEqual(getMemoTaskCheckboxChangePlan("- [x] task", 0, false), {
		type: "apply",
		marker: " ",
		nextContent: "- [ ] task",
		shouldEnqueue: true,
	});
});

test("memo task checkbox plan syncs the DOM when the task index is stale", () => {
	assert.deepEqual(getMemoTaskCheckboxChangePlan("- [ ] task", 3, true), {
		type: "sync-dom",
	});
});

test("memo task checkbox plan skips enqueue when content is already in the requested state", () => {
	assert.deepEqual(getMemoTaskCheckboxChangePlan("- [x] task", 0, true), {
		type: "apply",
		marker: "x",
		nextContent: "- [x] task",
		shouldEnqueue: false,
	});
});

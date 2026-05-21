import test from "node:test";
import assert from "node:assert/strict";

import { SelfWriteTracker } from "../src/services/SelfWriteTracker";
import { hashText } from "../src/utils/hash";

test("SelfWriteTracker matches create/update/delete writes by expectedHash instead of path FIFO", () => {
	const tracker = new SelfWriteTracker(1000);
	const now = Date.now();
	const createHash = hashText("create content");
	const updateHash = hashText("update content");
	const deleteHash = hashText("delete content");

	tracker.mark("Daily/today.md", {
		opId: "op-create",
		path: "Daily/today.md",
		reason: "create",
		writtenAt: now,
		expiresAt: now + 1000,
		expectedHash: createHash,
	});
	tracker.mark("Daily/today.md", {
		opId: "op-update",
		path: "Daily/today.md",
		reason: "edit",
		writtenAt: now,
		expiresAt: now + 1000,
		expectedHash: updateHash,
	});
	tracker.mark("Daily/today.md", {
		opId: "op-delete",
		path: "Daily/today.md",
		reason: "delete",
		writtenAt: now,
		expiresAt: now + 1000,
		expectedHash: deleteHash,
	});

	assert.equal(tracker.consumeByExpectedHash("Daily/today.md", updateHash)?.opId, "op-update");
	assert.equal(tracker.consumeByExpectedHash("Daily/today.md", createHash)?.opId, "op-create");
	assert.equal(tracker.consumeByExpectedHash("Daily/today.md", deleteHash)?.opId, "op-delete");
	assert.equal(tracker.consumeByExpectedHash("Daily/today.md", deleteHash), null);
});

test("SelfWriteTracker ignores expired scan markers", () => {
	const tracker = new SelfWriteTracker(10);
	const hash = hashText("scan content");
	tracker.mark("Daily/today.md", {
		opId: "op-scan",
		path: "Daily/today.md",
		reason: "scan",
		writtenAt: Date.now() - 1000,
		expiresAt: Date.now() - 500,
		expectedHash: hash,
	});

	assert.equal(tracker.consumeByExpectedHash("Daily/today.md", hash), null);
});

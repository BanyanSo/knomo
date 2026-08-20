import test from "node:test";
import assert from "node:assert/strict";

import { SelfWriteTracker } from "../src/services/SelfWriteTracker";
import { hashText } from "../src/utils/hash";

test("SelfWriteTracker matches projection writes by expectedHash instead of path FIFO", () => {
	const tracker = new SelfWriteTracker(1000);
	const now = Date.now();
	const firstHash = hashText("first projection");
	const secondHash = hashText("second projection");

	tracker.mark("Memos/2026-08.md", {
		opId: "projection-first",
		path: "Memos/2026-08.md",
		reason: "monthly_projection",
		writtenAt: now,
		expiresAt: now + 1000,
		expectedHash: firstHash,
	});
	tracker.mark("Memos/2026-08.md", {
		opId: "projection-second",
		path: "Memos/2026-08.md",
		reason: "monthly_projection",
		writtenAt: now,
		expiresAt: now + 1000,
		expectedHash: secondHash,
	});

	assert.equal(tracker.consumeByExpectedHash("Memos/2026-08.md", secondHash)?.opId, "projection-second");
	assert.equal(tracker.consumeByExpectedHash("Memos/2026-08.md", firstHash)?.opId, "projection-first");
});

test("SelfWriteTracker ignores expired projection markers", () => {
	const tracker = new SelfWriteTracker(10);
	const hash = hashText("projection content");
	tracker.mark("Memos/2026-08.md", {
		opId: "projection-expired",
		path: "Memos/2026-08.md",
		reason: "monthly_projection",
		writtenAt: Date.now() - 1000,
		expiresAt: Date.now() - 500,
		expectedHash: hash,
	});

	assert.equal(tracker.consumeByExpectedHash("Memos/2026-08.md", hash), null);
});

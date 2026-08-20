import test from "node:test";
import assert from "node:assert/strict";
import { ensureObsidianStub } from "./helpers/obsidianStub";

test("formats active service errors and ordinary error text", async () => {
	await ensureObsidianStub();
	const { KnomoError } = await import("../src/types/serviceError");
	const { formatServiceError } = await import("../src/utils/serviceText");

	assert.equal(
		formatServiceError(new KnomoError("daily_notes_disabled")),
		"Enable the Daily Notes core plugin in Obsidian settings. Knomo will read the Daily Notes settings automatically; you do not need to configure the daily note path in Knomo.",
	);
	assert.equal(
		formatServiceError(new KnomoError("auto_exclude_unsupported")),
		"This Obsidian environment does not support automatic exclude rule updates.",
	);
	assert.equal(
		formatServiceError(new Error("Memo content cannot be empty.")),
		"memo content cannot be empty.",
	);
});

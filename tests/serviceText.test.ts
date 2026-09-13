import test from "node:test";
import assert from "node:assert/strict";
import { ensureObsidianStub } from "./helpers/obsidianStub";

test("formats service text outside UI modules", async () => {
	await ensureObsidianStub();
	const { formatSettingsText } = await import("../src/utils/serviceText");

	assert.equal(
		formatSettingsText("memoId and blockId in _knomo-system"),
		"memo ID and block ID in Knomo system data folder",
	);
});

import test from "node:test";
import assert from "node:assert/strict";

import { ensureObsidianStub } from "./helpers/obsidianStub";

test("uses a smaller startup scan window on mobile instead of skipping recovery", async () => {
	await ensureObsidianStub();
	const { getStartupDailyScanDays } = await import("../src/main");

	assert.equal(getStartupDailyScanDays(true), 7);
	assert.equal(getStartupDailyScanDays(false), 30);
});

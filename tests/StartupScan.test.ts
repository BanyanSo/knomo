import test from "node:test";
import assert from "node:assert/strict";

import { ensureObsidianStub } from "./helpers/obsidianStub";

test("uses a smaller startup scan window on mobile instead of skipping recovery", async () => {
	await ensureObsidianStub();
	const { getStartupDailyScanDays } = await import("../src/main");

	assert.equal(getStartupDailyScanDays(true), 7);
	assert.equal(getStartupDailyScanDays(false), 30);
});

test("recent startup scans read only month indexes covered by the date range", async () => {
	await ensureObsidianStub();
	const { getMonthPeriodsInRange } = await import("../src/services/SyncOrchestrator");

	assert.deepEqual(
		getMonthPeriodsInRange(new Date(2026, 0, 28), new Date(2026, 1, 3)),
		["2026-01", "2026-02"],
	);
});

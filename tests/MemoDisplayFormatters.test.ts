import test from "node:test";
import assert from "node:assert/strict";
import { ensureObsidianStub } from "./helpers/obsidianStub";

test("memo display formatter converts zoned ISO timestamps to local time at second precision", async () => {
	const { formatMemoDisplayTime } = await loadModule();
	const originalTimeZone = process.env.TZ;
	process.env.TZ = "Asia/Shanghai";
	try {
		assert.equal(formatMemoDisplayTime("2026-08-31T22:04:15.986Z"), "2026-09-01 06:04:15");
		assert.equal(formatMemoDisplayTime("2026-06-30T12:34:56.789+08:00"), "2026-06-30 12:34:56");
		assert.equal(formatMemoDisplayTime("2026-06-30T12:34:56Z"), "2026-06-30 20:34:56");
	} finally {
		if (originalTimeZone === undefined) delete process.env.TZ;
		else process.env.TZ = originalTimeZone;
	}
});

test("memo display formatter keeps timezone-less Identity creation time as local wall time", async () => {
	const { formatMemoDisplayTime } = await loadModule();

	assert.equal(formatMemoDisplayTime("2026-09-01T06:04:11"), "2026-09-01 06:04:11");
});

test("memo display formatter uses unknown text for empty optional times", async () => {
	const { formatOptionalMemoTime } = await loadModule();

	assert.equal(formatOptionalMemoTime(undefined), "Unknown");
	assert.equal(formatOptionalMemoTime("  "), "Unknown");
	assert.equal(formatOptionalMemoTime("2026-06-30T12:34:56.789"), "2026-06-30 12:34:56");
});

test("memo display formatter maps proven trash delete sources", async () => {
	const { formatDeleteSource } = await loadModule();

	assert.equal(formatDeleteSource("knomo_ui"), "Knomo");
	assert.equal(formatDeleteSource("unknown"), "Unknown");
});

async function loadModule(): Promise<typeof import("../src/ui/MemoDisplayFormatters")> {
	await ensureObsidianStub();
	return import("../src/ui/MemoDisplayFormatters");
}

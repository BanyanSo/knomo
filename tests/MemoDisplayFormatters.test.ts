import test from "node:test";
import assert from "node:assert/strict";
import { ensureObsidianStub } from "./helpers/obsidianStub";

test("memo display formatter removes ISO separator and millisecond timezone suffix", async () => {
	const { formatMemoDisplayTime } = await loadModule();

	assert.equal(formatMemoDisplayTime("2026-06-30T12:34:56.789+08:00"), "2026-06-30 12:34:56");
	assert.equal(formatMemoDisplayTime("2026-06-30T12:34:56Z"), "2026-06-30 12:34:56Z");
});

test("memo display formatter uses unknown text for empty optional times", async () => {
	const { formatOptionalMemoTime } = await loadModule();

	assert.equal(formatOptionalMemoTime(undefined), "Unknown");
	assert.equal(formatOptionalMemoTime("  "), "Unknown");
	assert.equal(formatOptionalMemoTime("2026-06-30T12:34:56.789+08:00"), "2026-06-30 12:34:56");
});

async function loadModule(): Promise<typeof import("../src/ui/MemoDisplayFormatters")> {
	await ensureObsidianStub();
	return import("../src/ui/MemoDisplayFormatters");
}

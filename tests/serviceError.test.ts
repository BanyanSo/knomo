import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

test("formats structured service errors before falling back to legacy text", async () => {
	await ensureObsidianStub();
	const { KnomoError } = await import("../src/types/serviceError");
	const { formatServiceError } = await import("../src/utils/serviceText");

	assert.equal(
		formatServiceError(new KnomoError("monthly_archive_file_missing")),
		"Monthly archive file does not exist.",
	);
	assert.equal(
		formatServiceError(new KnomoError("target_path_conflicts", { paths: "Archive/A; Archive/B" })),
		"Target path has conflicts; migration stopped: Archive/A; Archive/B",
	);
	assert.equal(
		formatServiceError(new Error("Memo content cannot be empty.")),
		"memo content cannot be empty.",
	);
	assert.equal(
		formatServiceError(new KnomoError("rebuild_index_failed", { count: 2, backupPath: "Knomo/backups/run" })),
		"Rebuild index failed: 2 files did not sync; stopped refreshing the view.\nBackup path: Knomo/backups/run",
	);
});

test("formats persisted issue codes and keeps legacy messages compatible", async () => {
	await ensureObsidianStub();
	const { formatMemoIssue } = await import("../src/utils/serviceText");

	assert.equal(formatMemoIssue({
		type: "monthly_block_missing",
		code: "monthly_archive_block_missing",
		detectedAt: "2026-06-18T00:00:00.000Z",
		message: "Legacy text that should not be shown",
	}), "Monthly archive block does not exist.");
	assert.equal(formatMemoIssue({
		type: "monthly_sync_failed",
		detectedAt: "2026-06-18T00:00:00.000Z",
		message: "Monthly archive sync failed.",
	}), "Monthly archive sync failed.");
});

async function ensureObsidianStub(): Promise<void> {
	const stubPath = resolve(__dirname, "../node_modules/obsidian/index.js");
	await mkdir(dirname(stubPath), { recursive: true });
	await writeFile(
		stubPath,
		[
			"class TFile {}",
			"class TFolder {}",
			"const Vault = { recurseChildren() {} };",
			"const normalizePath = (value) => value;",
			"function setIcon() {}",
			"function addIcon() {}",
			"function getLanguage() { return 'en'; }",
			"const moment = () => ({ format: () => '2026-06-18' });",
			"moment.locale = () => 'en';",
			"module.exports = { TFile, TFolder, Vault, normalizePath, setIcon, addIcon, getLanguage, moment };",
		].join("\n"),
	);
}

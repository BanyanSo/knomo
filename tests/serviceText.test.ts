import test from "node:test";
import assert from "node:assert/strict";
import { ensureObsidianStub } from "./helpers/obsidianStub";

test("formats service text outside UI modules", async () => {
	await ensureObsidianStub();
	const { formatSettingsText } = await import("../src/utils/serviceText");

	assert.equal(
		formatSettingsText("memoId and blockId in _knomo-system"),
		"memo ID and block ID in system data folder",
	);
	assert.equal(
		formatSettingsText("备份位置：Vault/_knomo-system/backups"),
		"Backup path: Vault/system data folder/backups",
	);
	const indexWriteError = [
		"Failed to write memo-index while creating memo.",
		"The daily note may already be written: Daily/today.md;",
		"monthly archive: Backup path: Vault/_knomo-system/backups.",
		"Repair memo-index or run manual scan before sending again.",
		"Original error: memoId missing",
	].join(" ");
	const formattedIndexWriteError = [
		"Failed to write memo-index while creating memo.",
		"The daily note may already be written: Daily/today.md;",
		"monthly archive: Backup path: Vault/system data folder/backups.",
		"Repair memo-index or run manual scan before sending again.",
		"Original error: memo ID missing",
	].join(" ");
	assert.equal(
		formatSettingsText(indexWriteError),
		formattedIndexWriteError,
	);
});

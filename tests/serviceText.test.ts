import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

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

async function ensureObsidianStub(): Promise<void> {
	const stubPath = resolve(__dirname, "../node_modules/obsidian/index.js");
	await mkdir(dirname(stubPath), { recursive: true });
	await writeFile(
		stubPath,
		[
			"class TFile {}",
			"class TFolder { constructor() { this.children = []; } }",
			"const Vault = { recurseChildren() {} };",
			"const normalizePath = (value) => value.replace(/\\\\/g, '/').replace(/\\/+/g, '/').replace(/^\\//, '').replace(/\\/$/, '');",
			"function setIcon(el, icon) { if (el && typeof el.setAttr === 'function') el.setAttr('data-icon', icon); return el; }",
			"function addIcon() {}",
			"let languageValue = 'en';",
			"function getLanguage() { return languageValue; }",
			"getLanguage.set = (value) => { languageValue = value; };",
			"let localeValue = 'en';",
			"const moment = (date = new Date()) => ({ format: () => date.toISOString().slice(0, 10) });",
			"moment.locale = (value) => { if (typeof value === 'string') localeValue = value; return localeValue; };",
			"module.exports = { TFile, TFolder, Vault, normalizePath, setIcon, addIcon, getLanguage, moment };",
		].join("\n"),
	);
}

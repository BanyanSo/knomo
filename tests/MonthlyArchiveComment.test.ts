import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

test("creates monthly archive comments in the requested locale", async () => {
	await ensureObsidianStub();
	const { ensureReadOnlyComment, MONTHLY_ARCHIVE_MARKER } = await import("../src/services/MonthlyArchiveService");

	const english = ensureReadOnlyComment("# 2026-06", "en");
	const chinese = ensureReadOnlyComment("# 2026-06", "zh-CN");

	assert.equal(english.startsWith(`<!-- ${MONTHLY_ARCHIVE_MARKER}\nKnomo monthly archive file:`), true);
	assert.equal(chinese.startsWith(`<!-- ${MONTHLY_ARCHIVE_MARKER}\nKnomo 月度归档文件：`), true);
});

test("preserves existing localized and legacy comments without translation churn", async () => {
	await ensureObsidianStub();
	const {
		ensureReadOnlyComment,
		LEGACY_MONTHLY_ARCHIVE_READONLY_COMMENT,
	} = await import("../src/services/MonthlyArchiveService");
	const legacyContent = `${LEGACY_MONTHLY_ARCHIVE_READONLY_COMMENT}\n\n# 2026-06`;
	const chineseContent = ensureReadOnlyComment("# 2026-06", "zh-CN");

	assert.equal(ensureReadOnlyComment(legacyContent, "zh-CN"), legacyContent);
	assert.equal(ensureReadOnlyComment(chineseContent, "en"), chineseContent);
	assert.equal(ensureReadOnlyComment(chineseContent, "zh-CN"), chineseContent);
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
			"const normalizePath = (value) => value.replace(/\\\\/g, '/');",
			"function getLanguage() { return 'en'; }",
			"module.exports = { TFile, TFolder, Vault, normalizePath, getLanguage };",
		].join("\n"),
	);
}

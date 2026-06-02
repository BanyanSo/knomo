import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

test("normalizes invalid settings to safe defaults", async () => {
	await ensureObsidianStub();
	const {
		DEFAULT_KNOMO_SETTINGS,
		isValidMonthlyMemoFileFormat,
		normalizeSettings,
	} = await import("../src/settings/normalizeSettings");

	const settings = normalizeSettings({
		dailyHeading: "",
		dailyInsertPosition: "middle",
		memoTimeFormat: "HH",
		monthlyMemoFolder: " /Archive//Memos/ ",
		monthlyMemoFileFormat: "YYYY/Memos-YYYY-MM.md",
		monthlyDateHeadingFormat: "",
		monthlyDateOrder: "latest",
		legacyDailyHeadings: ["## Valid", "not a heading", 42],
		mobileCompactMode: "sometimes",
		syncDebounceMs: Number.NaN,
		desktopSidebarWidth: "wide",
		desktopSidebarCollapsed: "false",
		excludeMonthlyMemosFromObsidian: "yes",
		managedObsidianExcludeRule: "Memos/",
		managedSystemFolderExcludeRule: " ",
		pinnedTags: ["project", 1, "knomo"],
	});

	assert.equal(settings.dailyHeading, DEFAULT_KNOMO_SETTINGS.dailyHeading);
	assert.equal(settings.dailyInsertPosition, DEFAULT_KNOMO_SETTINGS.dailyInsertPosition);
	assert.equal(settings.memoTimeFormat, DEFAULT_KNOMO_SETTINGS.memoTimeFormat);
	assert.equal(settings.monthlyMemoFolder, "Archive/Memos");
	assert.equal(settings.monthlyMemoFileFormat, DEFAULT_KNOMO_SETTINGS.monthlyMemoFileFormat);
	assert.equal(settings.monthlyDateHeadingFormat, DEFAULT_KNOMO_SETTINGS.monthlyDateHeadingFormat);
	assert.equal(settings.monthlyDateOrder, DEFAULT_KNOMO_SETTINGS.monthlyDateOrder);
	assert.deepEqual(settings.legacyDailyHeadings, ["## Valid"]);
	assert.equal(settings.mobileCompactMode, DEFAULT_KNOMO_SETTINGS.mobileCompactMode);
	assert.equal(settings.syncDebounceMs, DEFAULT_KNOMO_SETTINGS.syncDebounceMs);
	assert.equal(settings.desktopSidebarWidth, DEFAULT_KNOMO_SETTINGS.desktopSidebarWidth);
	assert.equal(settings.desktopSidebarCollapsed, DEFAULT_KNOMO_SETTINGS.desktopSidebarCollapsed);
	assert.equal(settings.excludeMonthlyMemosFromObsidian, DEFAULT_KNOMO_SETTINGS.excludeMonthlyMemosFromObsidian);
	assert.equal(settings.managedObsidianExcludeRule, "Memos/");
	assert.equal(settings.managedSystemFolderExcludeRule, undefined);
	assert.deepEqual(settings.pinnedTags, ["project", "knomo"]);
	assert.equal(isValidMonthlyMemoFileFormat("Memos-YYYY-MM.md"), true);
	assert.equal(isValidMonthlyMemoFileFormat("YYYY/Memos-YYYY-MM.md"), false);
	assert.equal(isValidMonthlyMemoFileFormat("YYYY\\Memos-YYYY-MM.md"), false);
});

test("clones normalized settings arrays", async () => {
	await ensureObsidianStub();
	const { cloneSettings, normalizeSettings } = await import("../src/settings/normalizeSettings");
	const settings = normalizeSettings({
		legacyDailyHeadings: ["## One"],
		pinnedTags: ["project"],
	});
	const cloned = cloneSettings(settings);

	cloned.legacyDailyHeadings.push("## Two");
	cloned.pinnedTags.push("knomo");

	assert.deepEqual(settings.legacyDailyHeadings, ["## One"]);
	assert.deepEqual(settings.pinnedTags, ["project"]);
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

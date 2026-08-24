import test from "node:test";
import assert from "node:assert/strict";
import { ensureObsidianStub } from "./helpers/obsidianStub";

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
	assert.equal(DEFAULT_KNOMO_SETTINGS.excludeMonthlyMemosFromObsidian, true);
	assert.equal(settings.managedObsidianExcludeRule, "Memos/");
	assert.equal(settings.managedSystemFolderExcludeRule, undefined);
	assert.deepEqual(settings.pinnedTags, ["project", "knomo"]);
	assert.equal(isValidMonthlyMemoFileFormat("Memos-YYYY-MM.md"), true);
	assert.equal(isValidMonthlyMemoFileFormat("Memos-YYYY-MM"), true);
	assert.equal(isValidMonthlyMemoFileFormat("Memos.md"), false);
	assert.equal(isValidMonthlyMemoFileFormat("Memos-YYYY-MM-YYYY-MM.md"), false);
	assert.equal(isValidMonthlyMemoFileFormat("YYYY/Memos-YYYY-MM.md"), false);
	assert.equal(isValidMonthlyMemoFileFormat("YYYY\\Memos-YYYY-MM.md"), false);
});

test("preserves safe historical monthly filename formats for explicit migration", async () => {
	await ensureObsidianStub();
	const { isValidMonthlyMemoFileFormat, normalizeSettings } = await import("../src/settings/normalizeSettings");

	const settings = normalizeSettings({ monthlyMemoFileFormat: "Memos.md" });

	assert.equal(settings.monthlyMemoFileFormat, "Memos.md");
	assert.equal(isValidMonthlyMemoFileFormat(settings.monthlyMemoFileFormat), false);
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

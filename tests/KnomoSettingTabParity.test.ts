import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const expectedGroupKeys = [
	"settings.attention.heading",
	"settings.capture.heading",
	"settings.monthly.heading",
	"settings.files.heading",
	"settings.runtime.heading",
	"settings.maintenance.heading",
];

const expectedRenderOrder = [
	"renderSharedConfigSetting",
	"renderDailyHeadingSetting",
	"renderInsertPositionSetting",
	"renderTimeFormatSetting",
	"renderTimeBuoySetting",
	"renderDateOrderSetting",
	"renderMonthlyFileFormatSetting",
	"renderDateHeadingFormatSetting",
	"renderMonthlyLocaleSetting",
	"renderMonthlyExcludeSetting",
	"renderDataRootSetting",
	"renderRuntimeStatusSetting",
	"renderLocalHistorySetting",
	"renderMonthlyRebuildSetting",
	"renderLegacyIdentityImport",
];

test("keeps declarative and legacy setting groups in task order", () => {
	const source = readSettingTabSource();
	const declarativeSource = getSourceBetween(source, "\tgetSettingDefinitions():", "\n\tdisplay(): void");
	const legacySource = getSourceBetween(source, "\tdisplay(): void", "\n\thide(): void");

	assert.deepEqual(
		extractMatches(declarativeSource, /heading:\s*t\("([^"]+)"/g),
		expectedGroupKeys,
	);
	assert.deepEqual(
		extractMatches(legacySource, /\.setName\(t\("([^"]+\.heading)"\)\)[\s\S]*?\.setHeading\(\)/g),
		expectedGroupKeys,
	);
});

test("keeps declarative and legacy setting rows in parity", () => {
	const source = readSettingTabSource();
	const declarativeSource = getSourceBetween(source, "\tgetSettingDefinitions():", "\n\tdisplay(): void");
	const legacySource = getSourceBetween(source, "\tdisplay(): void", "\n\thide(): void");

	assert.deepEqual(extractRenderCalls(declarativeSource), expectedRenderOrder);
	assert.deepEqual(extractRenderCalls(legacySource), expectedRenderOrder);
});

test("only shows device-setting attention when shared settings need action", () => {
	const source = readSettingTabSource();
	const attentionSource = getSourceBetween(
		source,
		"\t\t\t{\n\t\t\t\ttype: \"group\",\n\t\t\t\theading: t(\"settings.attention.heading\")",
		"\n\t\t\t{\n\t\t\t\ttype: \"group\",\n\t\t\t\theading: t(\"settings.capture.heading\")",
	);

	assert.match(attentionSource, /visible:\s*\(\) => this\.shouldShowSharedConfigAttention\(\)/u);
	assert.match(source, /return this\.knomoSharedConfigService\.getStatus\(\) !== "ready";/u);
});

test("keeps monthly filename and date heading visible without a formatting expander", () => {
	const source = readSettingTabSource();
	assert.doesNotMatch(source, /monthlyFormattingExpanded|renderMonthlyFormattingSetting|settings\.monthlyFormatting/u);
});

test("requires an explicit action before changing the monthly filename", () => {
	const source = readSettingTabSource();
	const renderSource = getSourceBetween(
		source,
		"\tprivate renderMonthlyFileFormatSetting(",
		"\n\tprivate renderDateHeadingFormatSetting(",
	);

	assert.doesNotMatch(renderSource, /addEventListener\("blur"/u);
	assert.match(renderSource, /settings\.monthlyFileFormat\.apply/u);
});

test("refreshes search and statistics without a confirmation step", () => {
	const source = readSettingTabSource();
	const rebuildSource = getSourceBetween(
		source,
		"\tprivate async runRebuildIndex(",
		"\n\tprivate async runMonthlyArchiveRebuild(",
	);

	assert.doesNotMatch(rebuildSource, /showKnomoConfirmModal/u);
	assert.match(rebuildSource, /rebuildLocalCatalog\(\)/u);
});

function readSettingTabSource(): string {
	return fs.readFileSync(path.resolve("src/ui/KnomoSettingTab.ts"), "utf8");
}

function getSourceBetween(source: string, startMarker: string, endMarker: string): string {
	const start = source.indexOf(startMarker);
	const end = source.indexOf(endMarker, start);
	assert.notEqual(start, -1);
	assert.notEqual(end, -1);
	return source.slice(start, end);
}

function extractMatches(source: string, pattern: RegExp): string[] {
	return Array.from(source.matchAll(pattern), (match) => match[1]);
}

function extractRenderCalls(source: string): string[] {
	return extractMatches(source, /this\.(render[A-Z][A-Za-z]+Setting|renderLegacyIdentityImport)\(/g);
}

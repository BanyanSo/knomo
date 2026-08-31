import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const expectedGroupKeys = [
	"settings.attention.heading",
	"settings.capture.heading",
	"settings.monthly.heading",
	"settings.files.heading",
];

const expectedRenderOrder = [
	"renderAttentionSetting",
	"renderDailyHeadingSetting",
	"renderInsertPositionSetting",
	"renderTimeFormatSetting",
	"renderTimeBuoySetting",
	"renderDateOrderSetting",
	"renderMonthlyFileFormatSetting",
	"renderDateHeadingFormatSetting",
	"renderMonthlyExcludeSetting",
	"renderDataRootSetting",
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

test("only shows the attention group when actionable rows exist", () => {
	const source = readSettingTabSource();
	const attentionSource = getSourceBetween(
		source,
		"\t\t\t{\n\t\t\t\ttype: \"group\",\n\t\t\t\theading: t(\"settings.attention.heading\")",
		"\n\t\t\t{\n\t\t\t\ttype: \"group\",\n\t\t\t\theading: t(\"settings.capture.heading\")",
	);

	assert.match(attentionSource, /visible:\s*attentionItems\.length > 0/u);
	assert.match(source, /getKnomoSettingAttentionKinds/u);
});

test("routes the device-setting action through startup initialization and refreshes after failure", () => {
	const source = readSettingTabSource();
	const sharedConfigSource = getSourceBetween(
		source,
		"\tprivate renderSharedConfigSetting(",
		"\n\tprivate async syncSharedConfiguration(",
	);

	assert.match(sharedConfigSource, /this\.startupBootstrapService\.retryInitialization\(\)/u);
	assert.match(sharedConfigSource, /this\.startupBootstrapService\.useCurrentDeviceSettings\(\)/u);
	assert.match(sharedConfigSource, /new Notice\(t\("settings\.sharedConfig\.failed"\)\)/u);
	assert.match(sharedConfigSource, /finally[\s\S]*this\.refreshSettingTab\(\)/u);
	assert.match(source, /refreshAttentionIfVisible\(\): void[\s\S]*if \(this\.settingsVisible\) this\.refreshSettingTab\(\)/u);
});

test("does not expose permanent runtime, maintenance, or monthly locale rows", () => {
	const source = readSettingTabSource();
	const definitions = getSourceBetween(source, "\tgetSettingDefinitions():", "\n\tdisplay(): void");
	assert.doesNotMatch(definitions, /settings\.runtime|settings\.maintenance|settings\.monthlyLocale/u);
	assert.doesNotMatch(source, /renderRuntimeStatusSetting|renderMonthlyRebuildSetting|renderMonthlyLocaleSetting/u);
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
		"\n\tprivate async runRuntimeRetry(",
	);

	assert.doesNotMatch(rebuildSource, /showKnomoConfirmModal/u);
	assert.match(rebuildSource, /rebuildLocalCatalog\(\)/u);
	assert.match(source, /renderCatalogAttentionSetting[\s\S]*runRebuildIndex/u);
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
	return extractMatches(source, /this\.(render[A-Z][A-Za-z]+Setting)\(/g);
}

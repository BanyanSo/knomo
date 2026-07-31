import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

test("keeps declarative and legacy setting structures in parity", () => {
	const source = fs.readFileSync(path.resolve("src/ui/KnomoSettingTab.ts"), "utf8");
	const declarativeSource = getSourceBetween(source, "\tgetSettingDefinitions():", "\n\tdisplay(): void");
	const legacySource = getSourceBetween(source, "\tdisplay(): void", "\n\thide(): void");

	const declarativeSettingKeys = extractMatches(
		declarativeSource,
		/(?:heading|name):\s*t\("([^"]+)"/g,
	);
	const legacySettingKeys = extractMatches(
		legacySource,
		/\.setName\(t\("([^"]+)"/g,
	);
	assert.notEqual(declarativeSettingKeys.length, 0);
	assert.deepEqual(legacySettingKeys, declarativeSettingKeys);

	const declarativeControls = extractMatches(
		declarativeSource,
		/\.add(Text|Dropdown|Toggle|Button)\(/g,
	);
	const legacyControls = extractMatches(
		legacySource,
		/\.add(Text|Dropdown|Toggle|Button)\(/g,
	);
	assert.notEqual(declarativeControls.length, 0);
	assert.deepEqual(legacyControls, declarativeControls);
});

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

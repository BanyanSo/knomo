import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

test("parses localized month names through the current Obsidian Moment locale", async () => {
	await ensureObsidianMomentStub();
	const { moment } = await import("obsidian");
	const { parseDailyNoteDateFromPath } = await import("../src/utils/dailyNotes");
	moment.locale("fr");

	const fullMonth = parseDailyNoteDateFromPath("Daily/18 juin 2026.md", {
		folder: "Daily",
		format: "DD MMMM YYYY",
	});
	const abbreviatedMonth = parseDailyNoteDateFromPath("Daily/18 févr. 2026.md", {
		folder: "Daily",
		format: "DD MMM YYYY",
	});

	assert.deepEqual(toDateParts(fullMonth), [2026, 6, 18]);
	assert.deepEqual(toDateParts(abbreviatedMonth), [2026, 2, 18]);
	assert.equal(parseDailyNoteDateFromPath("Daily/18 inconnu 2026.md", {
		folder: "Daily",
		format: "DD MMMM YYYY",
	}), null);
});

test("keeps static English and Chinese month compatibility", async () => {
	await ensureObsidianMomentStub();
	const { parseDailyNoteDateFromPath } = await import("../src/utils/dailyNotes");

	assert.deepEqual(toDateParts(parseDailyNoteDateFromPath("18 February 2026.md", {
		folder: null,
		format: "DD MMMM YYYY",
	})), [2026, 2, 18]);
	assert.deepEqual(toDateParts(parseDailyNoteDateFromPath("2026-二月-18.md", {
		folder: null,
		format: "YYYY-MMMM-DD",
	})), [2026, 2, 18]);
});

test("parses ordinal-day and ISO week daily note formats through Obsidian Moment", async () => {
	await ensureObsidianMomentStub();
	const { parseDailyNoteDateFromPath } = await import("../src/utils/dailyNotes");

	assert.deepEqual(toDateParts(parseDailyNoteDateFromPath("Daily/2026-172.md", {
		folder: "Daily",
		format: "YYYY-DDD",
	})), [2026, 6, 21]);
	assert.deepEqual(toDateParts(parseDailyNoteDateFromPath("Daily/2026-W25-7.md", {
		folder: "Daily",
		format: "GGGG-[W]WW-E",
	})), [2026, 6, 21]);
});

function toDateParts(date: Date | null): [number, number, number] | null {
	return date === null ? null : [date.getFullYear(), date.getMonth() + 1, date.getDate()];
}

async function ensureObsidianMomentStub(): Promise<void> {
	const stubPath = resolve(__dirname, "../node_modules/obsidian/index.js");
	await mkdir(dirname(stubPath), { recursive: true });
	await writeFile(
		stubPath,
		[
			"let localeValue = 'en';",
			"const localizedMonths = {",
			"  fr: ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'],",
			"  frShort: ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'],",
			"};",
			"const momentDate = (date) => ({ isValid: () => !Number.isNaN(date.getTime()), toDate: () => new Date(date), month: () => date.getMonth() });",
			"const moment = (input = new Date(), _formats, strict) => {",
			"  if (strict === true && typeof input === 'string') {",
			"    if (_formats === 'YYYY-DDD') {",
			"      const match = input.match(/^(\\d{4})-(\\d{3})$/);",
			"      if (match === null) return momentDate(new Date(Number.NaN));",
			"      return momentDate(new Date(Number(match[1]), 0, Number(match[2])));",
			"    }",
			"    if (_formats === 'GGGG-[W]WW-E') {",
			"      const match = input.match(/^(\\d{4})-W(\\d{2})-(\\d)$/);",
			"      if (match === null) return momentDate(new Date(Number.NaN));",
			"      const jan4 = new Date(Number(match[1]), 0, 4);",
			"      const isoWeekday = jan4.getDay() || 7;",
			"      const date = new Date(Number(match[1]), 0, 4 - isoWeekday + 1);",
			"      date.setDate(date.getDate() + (Number(match[2]) - 1) * 7 + Number(match[3]) - 1);",
			"      return momentDate(date);",
			"    }",
			"    const normalized = input.trim().toLowerCase();",
			"    const names = localeValue === 'fr' ? [...localizedMonths.fr, ...localizedMonths.frShort] : [];",
			"    const index = names.indexOf(normalized);",
			"    const monthIndex = index < 0 ? -1 : index % 12;",
			"    return { isValid: () => monthIndex >= 0, month: () => monthIndex };",
			"  }",
			"  return { format: () => input instanceof Date ? input.toISOString().slice(0, 10) : String(input) };",
			"};",
			"moment.locale = (value) => { if (typeof value === 'string') localeValue = value; return localeValue; };",
			"module.exports = { moment };",
		].join("\n"),
	);
}

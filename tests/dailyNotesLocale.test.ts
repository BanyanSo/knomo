import test from "node:test";
import assert from "node:assert/strict";
import { ensureObsidianStub } from "./helpers/obsidianStub";

test("parses localized month names through the current Obsidian Moment locale", async () => {
	await ensureObsidianStub();
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
	await ensureObsidianStub();
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
	await ensureObsidianStub();
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

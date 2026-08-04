import assert from "node:assert/strict";
import test from "node:test";

import { ensureObsidianStub } from "./helpers/obsidianStub";

test("formats supported monthly date heading tokens while preserving Markdown", async () => {
	await ensureObsidianStub();
	const { moment } = await import("obsidian");
	const { formatMonthlyDateHeading } = await import("../src/services/MonthlyArchiveService");
	const previousLocale = moment.locale();
	moment.locale("en");
	try {
		const date = new Date(2026, 7, 3, 12);
		const cases: ReadonlyArray<readonly [string, string]> = [
			["## [[YYYY-MM-DD]]", "## [[2026-08-03]]"],
			["## [[YYYY年M月D日]]", "## [[2026年8月3日]]"],
			["## [[D MMMM YYYY]]", "## [[3 August 2026]]"],
			["## [[DD MMMM YYYY]]", "## [[03 August 2026]]"],
			["## [[MMMM D, YYYY]]", "## [[August 3, 2026]]"],
			["## [[dddd, D MMMM YYYY]]", "## [[Monday, 3 August 2026]]"],
			["## Memos [[YYYY-MM-DD]]", "## Memos [[2026-08-03]]"],
			["## YYYY-MM-DD", "## 2026-08-03"],
			["", "## [[2026-08-03]]"],
		];

		for (const [format, expected] of cases) {
			assert.equal(formatMonthlyDateHeading(format, date), expected, format);
		}
	} finally {
		moment.locale(previousLocale);
	}
});

test("formats localized month and weekday names through Obsidian Moment", async () => {
	await ensureObsidianStub();
	const { moment } = await import("obsidian");
	const { formatMonthlyDateHeading } = await import("../src/services/MonthlyArchiveService");
	const previousLocale = moment.locale();
	moment.locale("fr");
	try {
		assert.equal(
			formatMonthlyDateHeading("## [[dddd, D MMMM YYYY]]", new Date(2026, 7, 3, 12)),
			"## [[lundi, 3 août 2026]]",
		);
	} finally {
		moment.locale(previousLocale);
	}
});

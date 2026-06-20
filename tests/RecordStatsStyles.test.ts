import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

test("record statistics bars expand hit areas without changing chart widths", async () => {
	const css = await readFile(resolve(process.cwd(), "styles.css"), "utf8");

	assert.match(css, /\.knomo-record-stats-chart\.is-month\s*\{[^}]*min-width:\s*620px;/s);
	assert.match(css, /\.knomo-record-stats-chart\.is-year\s*\{[^}]*min-width:\s*420px;/s);
	assert.match(css, /\.knomo-record-stats-chart\.is-hours\s*\{[^}]*min-width:\s*540px;/s);
	assert.match(css, /--knomo-record-stats-column-gap:\s*var\(--size-2-2\);/);
	assert.match(css, /--knomo-record-stats-hit-inset:\s*var\(--size-2-1\);/);
	assert.match(css, /\.knomo-record-stats-bar-item\s*\{[^}]*display:\s*grid;/s);
	assert.match(css, /\.knomo-record-stats-bar-hit\s*\{[^}]*position:\s*absolute;/s);
	assert.match(css, /inset-inline:\s*calc\(0px - var\(--knomo-record-stats-hit-inset\)\);/);
	assert.match(css, /\.knomo-record-stats-bar-hit\s*\{[^}]*height:\s*auto;/s);
});

test("record statistics metric labels wrap consistently and chart headings do not create tooltips", async () => {
	const css = await readFile(resolve(process.cwd(), "styles.css"), "utf8");
	const source = await readFile(resolve(process.cwd(), "src/ui/KnomoRecordStatsPage.ts"), "utf8");

	assert.match(css, /\.knomo-record-stats-metric-label\s*\{[^}]*overflow-wrap:\s*anywhere;/s);
	assert.match(css, /\.knomo-record-stats-metric-label\s*\{[^}]*white-space:\s*normal;/s);
	assert.match(source, /attr:\s*\{\s*role:\s*"list",\s*"aria-labelledby":\s*options\.labelledBy\s*\}/);
	assert.doesNotMatch(source, /attr:\s*\{\s*role:\s*"list",\s*"aria-label":\s*options\.ariaLabel\s*\}/);
	assert.match(source, /"aria-label":\s*action\.ariaLabel/);
});

test("record statistics loading skeleton reserves the ready page structure", async () => {
	const css = await readFile(resolve(process.cwd(), "styles.css"), "utf8");
	const source = await readFile(resolve(process.cwd(), "src/ui/KnomoRecordStatsPage.ts"), "utf8");

	assert.match(source, /knomo-record-stats-skeleton-controls/);
	assert.match(source, /knomo-record-stats-skeleton-navigation/);
	assert.equal(source.match(/knomo-record-stats-skeleton-chart/g)?.length, 2);
	assert.match(css, /\.knomo-plugin \.knomo-record-stats-loading\s*\{[^}]*position:\s*absolute;/s);
	assert.match(css, /\.knomo-plugin \.knomo-record-stats-skeleton-item\s*\{[^}]*height:\s*76px;/s);
});

test("record statistics renders all-note navigation and feature metrics in the requested order", async () => {
	const source = await readFile(resolve(process.cwd(), "src/ui/KnomoRecordStatsPage.ts"), "utf8");

	assert.match(source, /recordStats\.overview\.notes[\s\S]*action:\s*"reset-list-state"/);
	assert.match(source, /renderSkeletonGrid\(metrics, 9\)/);
	assert.match(
		source,
		/recordStats\.metric\.recordDays[\s\S]*recordStats\.metric\.withTag[\s\S]*recordStats\.metric\.noTag[\s\S]*recordStats\.metric\.withImage[\s\S]*recordStats\.metric\.references/,
	);
});

test("record statistics renders accessible common-tag bars after active hours with an empty state", async () => {
	const css = await readFile(resolve(process.cwd(), "styles.css"), "utf8");
	const source = await readFile(resolve(process.cwd(), "src/ui/KnomoRecordStatsPage.ts"), "utf8");

	assert.match(source, /renderActiveHours\([\s\S]*renderCommonTags\(/);
	assert.match(source, /recordStats\.commonTags\.empty/);
	assert.match(source, /data-record-stats-tag-key/);
	assert.match(source, /--knomo-record-stats-tag-ratio/);
	assert.match(source, /knomo-record-stats-skeleton-tag-chart/);
	assert.match(css, /\.knomo-plugin \.knomo-record-stats-tag-button\s*\{[^}]*min-height:\s*var\(--knomo-touch-target\);/s);
	assert.match(css, /\.knomo-plugin \.knomo-record-stats-tag-button:focus-visible\s*\{[^}]*outline:/s);
	assert.match(css, /\.knomo-plugin \.knomo-record-stats-tag-track\s*\{[^}]*height:\s*18px;/s);
	assert.match(css, /\.knomo-plugin \.knomo-record-stats-tag-track\s*\{[^}]*border-radius:\s*var\(--radius-xl\);/s);
	assert.match(css, /\.knomo-plugin \.knomo-record-stats-tag-bar\s*\{[^}]*width:\s*calc\(var\(--knomo-record-stats-tag-ratio, 0\) \* 100%\);/s);
	assert.match(css, /\.knomo-plugin \.knomo-record-stats-tag-bar\s*\{[^}]*border-radius:\s*inherit;/s);
});

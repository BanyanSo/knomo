import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { getAllSidebarNavItems, TITLE_MODE_OPTIONS } from "../src/ui/viewNavigation";

const styles = fs.readFileSync(path.resolve("styles.css"), "utf8");
const knomoViewSource = fs.readFileSync(path.resolve("src/ui/KnomoView.ts"), "utf8");

test("main card flows use a 60px minimum end space and only expand for occlusion", () => {
	assert.match(styles, /--knomo-content-end-base: 60px;/u);
	assert.match(styles, /--knomo-content-end-clearance: var\(--size-4-6\);/u);
	assert.match(
		styles,
		/--knomo-content-end-space: max\(\s*var\(--knomo-content-end-base\),\s*calc\(var\(--knomo-content-bottom-occlusion\) \+ var\(--knomo-content-end-clearance\)\),\s*calc\(env\(safe-area-inset-bottom, 0px\) \+ var\(--knomo-content-end-clearance\)\)\s*\);/u,
	);
	assert.doesNotMatch(styles, /--knomo-content-end-gap:/u);
});

test("card flow owns one shared content-end marker", () => {
	const cardFlowRule = getCssRule(".knomo-plugin .knomo-card-flow");
	assert.match(cardFlowRule, /scroll-padding-block-end: var\(--knomo-content-end-space\);/u);
	assert.doesNotMatch(cardFlowRule, /^\s*padding-block-end:/mu);
	assert.match(styles, /\.knomo-plugin \.knomo-card-flow::after \{[\s\S]*?content: "";[\s\S]*?block-size: var\(--knomo-content-end-space\);[\s\S]*?pointer-events: none;/u);
	assert.doesNotMatch(styles, /\.knomo-plugin\.is-record-stats \.knomo-card-flow[\s\S]*?padding-bottom/u);
	assert.doesNotMatch(styles, /\.knomo-plugin\.is-time-buoy \.knomo-card-flow[\s\S]*?padding-bottom/u);
	assert.doesNotMatch(styles, /\.knomo-plugin \.knomo-record-stats-page \{[\s\S]*?padding-bottom/u);
	assert.doesNotMatch(styles, /\.knomo-plugin\.is-[\w-]+(?:\.is-[\w-]+)* \.knomo-card-flow \{[^}]*?(?:padding|margin)-(?:bottom|block-end)/u);
});

test("all registered main pages inherit the shared content-end marker", () => {
	assert.deepEqual(getAllSidebarNavItems().map((item) => item.nav), [
		"all",
		"review",
		"random",
		"shuffleDay",
		"time-buoy",
		"record-stats",
		"trash",
	]);
	assert.deepEqual(
		TITLE_MODE_OPTIONS.filter((option) => option.scope !== undefined).map((option) => option.scope),
		["all", "no-tag", "with-link", "with-image", "anniversary"],
	);
});

test("mobile search uses its own safe end spacing without trailing card margin", () => {
	assert.match(styles, /\.knomo-plugin \.knomo-mobile-search-results \{[\s\S]*?padding-block-end: var\(--knomo-mobile-search-end-space\);[\s\S]*?scroll-padding-block-end: var\(--knomo-mobile-search-end-space\);/u);
	assert.match(styles, /\.knomo-plugin \.knomo-mobile-search-results \.knomo-card:last-child \{\s*margin-bottom: 0;/u);
	assert.match(styles, /\.knomo-plugin \.knomo-empty-state \{\s*margin: 60px 0 0;/u);
});

test("desktop search inherits the shared 60px card-flow end space", () => {
	assert.doesNotMatch(styles, /--knomo-desktop-search-end-space:/u);
	assert.doesNotMatch(styles, /\.knomo-plugin\.is-desktop-search-results/u);
	assert.doesNotMatch(knomoViewSource, /is-desktop-search-results/u);
});

test("main and search card flows clip only closed menu-card overflow", () => {
	assert.match(
		styles,
		/\.knomo-plugin \.knomo-card-flow \.knomo-card\.has-card-actions:not\(\.is-menu-open\),\s*\.knomo-plugin \.knomo-mobile-search-results \.knomo-card\.has-card-actions:not\(\.is-menu-open\) \{\s*overflow: clip;\s*\}/u,
	);
	assert.match(styles, /\.knomo-plugin \.knomo-card-actions \{[\s\S]*?position: absolute;[\s\S]*?visibility: hidden;/u);
	assert.match(styles, /\.knomo-plugin \.knomo-card\.is-menu-above \.knomo-card-actions \{/u);
});

test("mobile load-more controls keep their existing layout with an accessible touch target", () => {
	assert.match(styles, /\.knomo-plugin\.is-layout-mobile \.knomo-load-more \{\s*min-height: var\(--knomo-touch-target\);/u);
});

function getCssRule(selector: string): string {
	const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
	const matches = Array.from(styles.matchAll(new RegExp(`${escapedSelector} \\{([\\s\\S]*?)\\r?\\n\\}`, "gu")));
	const match = matches[matches.length - 1];
	if (match === undefined) {
		throw new Error(`Missing CSS rule: ${selector}`);
	}
	return match[1];
}

import test from "node:test";
import assert from "node:assert/strict";

import { getTagQueryAtCursor } from "../src/utils/composerInput";
import {
	completeWikiLinkTriggerAtCursor,
	getWikiLinkFileSuggestions,
	getWikiLinkRangeAtCursor,
	isKnomoInternalWikiLinkCandidate,
	replaceWikiLinkRangeWithLinktext,
} from "../src/utils/wikiLinkInput";

test("completes half-width WikiLink trigger", () => {
	assert.deepEqual(completeWikiLinkTriggerAtCursor("[[", 2), {
		value: "[[]]",
		cursor: 2,
	});
});

test("normalizes full-width WikiLink trigger", () => {
	assert.deepEqual(completeWikiLinkTriggerAtCursor("【【", 2), {
		value: "[[]]",
		cursor: 2,
	});
});

test("does not complete an already completed WikiLink shell again", () => {
	assert.equal(completeWikiLinkTriggerAtCursor("[[]]", 2), null);
});

test("detects active WikiLink shell at the cursor", () => {
	assert.deepEqual(getWikiLinkRangeAtCursor("[[]]", 2), {
		from: 0,
		to: 4,
		queryFrom: 2,
		queryTo: 2,
		query: "",
		hasClosing: true,
	});
});

test("detects active WikiLink query before the closing brackets", () => {
	assert.deepEqual(getWikiLinkRangeAtCursor("[[note]]", 6), {
		from: 0,
		to: 8,
		queryFrom: 2,
		queryTo: 6,
		query: "note",
		hasClosing: true,
	});
});

test("closes WikiLink range after the closing brackets", () => {
	assert.equal(getWikiLinkRangeAtCursor("[[note]]", 8), null);
});

test("does not match WikiLink ranges across lines", () => {
	assert.equal(getWikiLinkRangeAtCursor("[[\nnote", 7), null);
});

test("replaces the whole active WikiLink range", () => {
	const value = "memo [[old query]] today";
	const range = getWikiLinkRangeAtCursor(value, 16);
	assert.notEqual(range, null);
	assert.deepEqual(replaceWikiLinkRangeWithLinktext(value, range!, "folder/new note"), {
		value: "memo [[folder/new note]] today",
		cursor: 24,
	});
});

test("matches and ranks WikiLink file candidates", () => {
	const files = [
		{ path: "Projects/Notes/Alpha.md", basename: "Alpha" },
		{ path: "Archive/Beta Alpha.md", basename: "Beta Alpha" },
		{ path: "Daily/2026-06-05.md", basename: "2026-06-05" },
		{ path: "Projects/Gamma.md", basename: "Gamma" },
	];
	const suggestions = getWikiLinkFileSuggestions(files, "alpha", 10);
	assert.deepEqual(suggestions.map((suggestion) => suggestion.path), [
		"Projects/Notes/Alpha.md",
		"Archive/Beta Alpha.md",
	]);
});

test("shows paths when duplicate basenames need disambiguation", () => {
	const files = [
		{ path: "A/Plan.md", basename: "Plan" },
		{ path: "B/Plan.md", basename: "Plan" },
	];
	const suggestions = getWikiLinkFileSuggestions(files, "plan", 10);
	assert.deepEqual(suggestions.map((suggestion) => suggestion.showPath), [true, true]);
});

test("filters Knomo internal WikiLink candidates", () => {
	assert.equal(isKnomoInternalWikiLinkCandidate("Knomo/_knomo-system/indexes/memo-index-2026-06.json"), true);
	assert.equal(isKnomoInternalWikiLinkCandidate("Knomo/_knomo-system/backups/rebuild/Plan.md"), true);
	assert.equal(isKnomoInternalWikiLinkCandidate("Notes/Plan.md"), false);
});

test("WikiLink and tag query helpers do not claim each other's ranges", () => {
	assert.equal(getWikiLinkRangeAtCursor("#project", 8), null);
	assert.deepEqual(getTagQueryAtCursor("[[note]] #project", 17), {
		from: 9,
		to: 17,
		query: "project",
	});
});

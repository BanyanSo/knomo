import test from "node:test";
import assert from "node:assert/strict";

import type { MemoRecord } from "../src/types/memo";
import {
	getMemoListStateKey,
	getMemoRenderRevision,
} from "../src/ui/MemoRenderRevision";

test("keeps render revisions stable for non-rendered metadata arrays", () => {
	const memo = makeMemo("memo-1");
	const changed = {
		...memo,
		tags: ["changed"],
		links: [{ target: "https://example.com", displayText: null, syntax: "url" as const }],
		images: [{ path: "changed.png", altText: "", syntax: "obsidian_embed" as const }],
	};

	assert.equal(getMemoRenderRevision(changed), getMemoRenderRevision(memo));
});

test("changes render revisions when visible card state changes", () => {
	const memo = makeMemo("memo-1");

	assert.notEqual(
		getMemoRenderRevision({ ...memo, contentHash: "changed" }),
		getMemoRenderRevision(memo),
	);
	assert.notEqual(
		getMemoRenderRevision({ ...memo, issue: {
			type: "monthly_sync_failed",
			detectedAt: "2026-06-15T10:00:00",
			message: "failed",
		} }),
		getMemoRenderRevision(memo),
	);
});

test("builds an ordered memo list state key", () => {
	const first = makeMemo("memo-1");
	const second = makeMemo("memo-2");

	assert.equal(getMemoListStateKey([first, second]), getMemoListStateKey([first, second]));
	assert.notEqual(getMemoListStateKey([first, second]), getMemoListStateKey([second, first]));
});

function makeMemo(id: string): MemoRecord {
	return {
		id,
		createdAt: "2026-06-15T09:00:00",
		updatedAt: "2026-06-15T09:00:00",
		contentSnapshot: "memo",
		contentHash: `hash-${id}`,
		status: "active",
		syncStatus: "synced",
		source: "plugin_input",
		version: 1,
		tags: [],
		links: [],
		images: [],
		references: [],
		sourceMemoId: null,
		issue: null,
		lastMarkdownSyncAt: null,
		lastMarkdownSyncSource: null,
		dailyRef: {
			path: "Daily/2026-06-15.md",
			heading: "## Memos",
			lastKnownBlock: "- 09:00:00 memo",
			lastKnownHash: `daily-${id}`,
			lineNumberHint: 1,
			lastSyncedAt: null,
		},
		monthlyRef: {
			path: "Knomo/Memos-2026-06.md",
			dateHeading: "## [[2026-06-15]]",
			lastKnownBlock: "- 09:00:00 memo",
			lastKnownHash: `monthly-${id}`,
			lineNumberHint: 1,
			lastSyncedAt: null,
		},
	};
}

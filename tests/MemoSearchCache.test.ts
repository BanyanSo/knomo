import test from "node:test";
import assert from "node:assert/strict";

import type { MemoRecord } from "../src/types/memo";
import { MemoSearchCache } from "../src/ui/MemoSearchCache";

test("caches memo search text while the memo list reference is unchanged", () => {
	let calls = 0;
	const memo = makeMemo("a");
	const memos = [memo];
	const cache = new MemoSearchCache((value) => {
		calls += 1;
		return `${value.id}:${calls}`;
	});

	assert.equal(cache.get(memo, memos), "a:1");
	assert.equal(cache.get(memo, memos), "a:1");
	assert.equal(calls, 1);
});

test("invalidates memo search text when the memo list reference changes", () => {
	let calls = 0;
	const memo = makeMemo("a");
	const cache = new MemoSearchCache((value) => {
		calls += 1;
		return `${value.id}:${calls}`;
	});

	assert.equal(cache.get(memo, [memo]), "a:1");
	assert.equal(cache.get(memo, [memo]), "a:2");
	assert.equal(calls, 2);
});

function makeMemo(id: string): MemoRecord {
	return {
		id,
		createdAt: "2026-05-20T09:00:00",
		updatedAt: "2026-05-20T09:00:00",
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
			path: "Daily/2026-05-20.md",
			heading: "## Memos",
			lastKnownBlock: "- 09:00:00 memo",
			lastKnownHash: `daily-${id}`,
			lineNumberHint: 1,
			lastSyncedAt: null,
		},
		monthlyRef: {
			path: "Knomo/Memos-2026-05.md",
			dateHeading: "## [[2026-05-20]]",
			lastKnownBlock: "- 09:00:00 memo",
			lastKnownHash: `monthly-${id}`,
			lineNumberHint: 1,
			lastSyncedAt: null,
		},
	};
}

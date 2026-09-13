import test from "node:test";
import assert from "node:assert/strict";

import type { MemoViewItem } from "../src/types/memoView";
import { MemoSearchCache } from "../src/ui/MemoSearchCache";

test("caches memo search text while the memo content key is unchanged", () => {
	let calls = 0;
	const memo = makeMemo("a");
	const cache = new MemoSearchCache((value) => {
		calls += 1;
		return `${value.id}:${calls}`;
	});

	assert.equal(cache.get(memo), "a:1");
	assert.equal(cache.get(memo), "a:1");
	assert.equal(calls, 1);
});

test("invalidates one memo search text when its content key changes", () => {
	let calls = 0;
	const memo = makeMemo("a");
	const cache = new MemoSearchCache((value) => {
		calls += 1;
		return `${value.id}:${calls}`;
	});

	assert.equal(cache.get(memo), "a:1");
	assert.equal(cache.get({ ...memo, version: 2, contentHash: "changed" }), "a:2");
	assert.equal(calls, 2);
});

function makeMemo(id: string): MemoViewItem {
	return {
		id,
		createdAt: "2026-05-20T09:00:00",
		updatedAt: "2026-05-20T09:00:00",
		contentSnapshot: "memo",
		contentHash: `hash-${id}`,
		status: "active",
		tags: [],
		links: [],
		images: [],
		dailyRef: {
			path: "Daily/2026-05-20.md",
			heading: "## Memos",
			lineNumberHint: 1,
		},
	};
}

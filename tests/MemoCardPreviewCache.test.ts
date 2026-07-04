import test from "node:test";
import assert from "node:assert/strict";

import type { MemoRecord } from "../src/types/memo";
import { MemoCardPreviewCache } from "../src/ui/MemoCardPreviewCache";

test("reuses a memo preview while its fixed cache key is unchanged", () => {
	let calls = 0;
	const memo = makeMemo("memo-1");
	const cache = new MemoCardPreviewCache((_value, content) => {
		calls += 1;
		return { text: content, imageRefs: [] };
	});

	assert.equal(cache.get(memo, "memo").text, "memo");
	assert.equal(cache.get({ ...memo }, "memo").text, "memo");
	assert.equal(calls, 1);
});

test("invalidates a memo preview when its content revision changes", () => {
	let calls = 0;
	const memo = makeMemo("memo-1");
	const cache = new MemoCardPreviewCache(() => {
		calls += 1;
		return { text: String(calls), imageRefs: [] };
	});

	assert.equal(cache.get(memo, "memo").text, "1");
	assert.equal(cache.get({ ...memo, version: 2, contentHash: "changed" }, "memo").text, "2");
});

test("finds local image previews affected by changed path or basename without dropping cached text", () => {
	let calls = 0;
	const memo = makeMemo("memo-1");
	const cache = new MemoCardPreviewCache(() => {
		calls += 1;
		return {
			text: "",
			imageRefs: [{
				raw: "![[photo.png]]",
				path: "photo.png",
				isRemote: false,
				start: 0,
				end: 14,
			}],
		};
	});

	cache.get(memo, "memo");
	assert.deepEqual(cache.findImagePathMemoIds(["Attachments/photo.png"]), ["memo-1"]);
	cache.get(memo, "memo");
	assert.equal(calls, 1);
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

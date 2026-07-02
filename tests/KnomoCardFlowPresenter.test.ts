import test from "node:test";
import assert from "node:assert/strict";

import type { MemoRecord } from "../src/types/memo";
import { ensureObsidianStub } from "./helpers/obsidianStub";

test("presents card flow error before other states", async () => {
	await ensureObsidianStub();
	const { getCardFlowPresentation } = await import("../src/ui/KnomoCardFlowPresenter");

	assert.deepEqual(getCardFlowPresentation({
		...baseOptions(),
		cardFlowError: "Vault read failed",
		activeNav: "trash",
		trashMemos: [makeMemo("trash-1")],
	}), {
		type: "empty",
		title: "Card feed refresh failed",
		description: "Vault read failed",
	});
});

test("presents regular empty state and filtered empty copy", async () => {
	await ensureObsidianStub();
	const { getCardFlowPresentation } = await import("../src/ui/KnomoCardFlowPresenter");

	assert.deepEqual(getCardFlowPresentation(baseOptions()), {
		type: "empty",
		title: "Nothing here yet",
		description: "",
	});
	assert.deepEqual(getCardFlowPresentation({
		...baseOptions(),
		regularFilterCopy: {
			summary: "Tagged memos",
			emptyTitle: "No tagged memos",
		},
	}), {
		type: "empty",
		title: "No tagged memos",
		description: "",
	});
});

test("presents memo list with regular filter summary", async () => {
	await ensureObsidianStub();
	const { getCardFlowPresentation } = await import("../src/ui/KnomoCardFlowPresenter");
	const memos = makeMemos(2);

	assert.deepEqual(getCardFlowPresentation({
		...baseOptions(),
		memos,
		regularFilterCopy: {
			summary: "2 filtered memos",
			emptyTitle: "No filtered memos",
		},
	}), {
		type: "items",
		memos,
		mode: "memo",
		headers: [{ type: "summary", text: "2 filtered memos" }],
	});
});

test("presents review and random list headers", async () => {
	await ensureObsidianStub();
	const { getCardFlowPresentation } = await import("../src/ui/KnomoCardFlowPresenter");
	const memos = makeMemos(3);

	assert.deepEqual(getCardFlowPresentation({
		...baseOptions(),
		activeNav: "review",
		memos,
	}), {
		type: "items",
		memos,
		mode: "memo",
		headers: [{ type: "summary", text: "3 memos were written on this day" }],
	});
	assert.deepEqual(getCardFlowPresentation({
		...baseOptions(),
		activeNav: "random",
		memos,
	}), {
		type: "items",
		memos,
		mode: "memo",
		headers: [{ type: "random-toolbar", count: 3 }],
	});
});

test("presents random loading before random list", async () => {
	await ensureObsidianStub();
	const { getCardFlowPresentation } = await import("../src/ui/KnomoCardFlowPresenter");

	assert.deepEqual(getCardFlowPresentation({
		...baseOptions(),
		activeNav: "random",
		randomReunionLoading: true,
		memos: makeMemos(2),
	}), {
		type: "empty",
		title: "Looking for memos to revisit",
		description: "",
	});
});

test("presents shuffle day headers without a random toolbar", async () => {
	await ensureObsidianStub();
	const { getCardFlowPresentation } = await import("../src/ui/KnomoCardFlowPresenter");
	const memos = makeMemos(2);

	assert.deepEqual(getCardFlowPresentation({
		...baseOptions(),
		activeNav: "shuffleDay",
		shuffleDay: {
			status: "ready",
			selectedDate: "2026-06-02",
			memos,
			stats: {
				memoCount: 2,
				wordCount: 4,
				tagCount: 1,
				imageCount: 0,
				linkCount: 1,
				firstMemoTime: "09:00",
				lastMemoTime: "10:00",
			},
			error: null,
		},
	}), {
		type: "items",
		memos,
		mode: "memo",
		headers: [{
			type: "shuffle-day",
			selectedDate: "2026-06-02",
			stats: {
				memoCount: 2,
				wordCount: 4,
				tagCount: 1,
				imageCount: 0,
				linkCount: 1,
				firstMemoTime: "09:00",
				lastMemoTime: "10:00",
			},
		}],
	});
});

test("presents trash states and trash items", async () => {
	await ensureObsidianStub();
	const { getCardFlowPresentation } = await import("../src/ui/KnomoCardFlowPresenter");
	const trashMemos = makeMemos(2, "trash");

	assert.deepEqual(getCardFlowPresentation({
		...baseOptions(),
		activeNav: "trash",
		trashMemos: null,
	}), {
		type: "empty",
		title: "Loading trash",
		description: "",
	});
	assert.deepEqual(getCardFlowPresentation({
		...baseOptions(),
		activeNav: "trash",
		trashError: "Trash index failed",
		trashMemos: [],
	}), {
		type: "empty",
		title: "Trash failed to load",
		description: "Trash index failed",
	});
	assert.deepEqual(getCardFlowPresentation({
		...baseOptions(),
		activeNav: "trash",
		trashMemos: [],
	}), {
		type: "empty",
		title: "Trash is empty",
		description: "Deleted memos are kept here temporarily",
	});
	assert.deepEqual(getCardFlowPresentation({
		...baseOptions(),
		activeNav: "trash",
		trashMemos,
	}), {
		type: "items",
		memos: trashMemos,
		mode: "trash",
		headers: [],
	});
});

function baseOptions() {
	return {
		cardFlowError: null,
		activeNav: "all" as const,
		randomReunionLoading: false,
		shuffleDay: {
			status: "idle" as const,
			selectedDate: null,
			memos: [],
			stats: null,
			error: null,
		},
		memos: [],
		regularFilterCopy: null,
		trashLoading: false,
		trashError: null,
		trashMemos: [],
	};
}

function makeMemos(count: number, prefix = "memo"): MemoRecord[] {
	return Array.from({ length: count }, (_, index) => makeMemo(`${prefix}-${index}`));
}

function makeMemo(id: string): MemoRecord {
	return {
		id,
		createdAt: "2026-06-02T00:00:00+08:00",
		updatedAt: "2026-06-02T00:00:00+08:00",
		contentSnapshot: id,
		contentHash: id,
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
			path: "Daily/2026-06-02.md",
			heading: null,
			lastKnownBlock: "",
			lastKnownHash: "",
			lineNumberHint: null,
			lastSyncedAt: null,
		},
		monthlyRef: {
			path: "Knomo/2026-06.md",
			dateHeading: "2026-06-02",
			lastKnownBlock: "",
			lastKnownHash: "",
			lineNumberHint: null,
			lastSyncedAt: null,
		},
	};
}

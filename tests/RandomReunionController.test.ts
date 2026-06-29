import test from "node:test";
import assert from "node:assert/strict";

import type { MemoRecord } from "../src/types/memo";
import { ensureObsidianStub } from "./helpers/obsidianStub";

test("refreshes random reunion once while loading and preserves render transitions", async () => {
	const { RandomReunionController } = await loadController();
	const sourceMemos = [makeMemo("memo-1"), makeMemo("memo-2")];
	const randomMemos = [sourceMemos[1]];
	let ensureCalls = 0;
	let randomCalls = 0;
	let requestedCount = 0;
	let requestedMemos: MemoRecord[] | null = null;
	let renderCalls = 0;
	let resolveRandom!: (memos: MemoRecord[]) => void;
	const randomPromise = new Promise<MemoRecord[]>((resolve) => {
		resolveRandom = resolve;
	});
	const controller = new RandomReunionController({
		ensureAllMemosLoaded: async () => {
			ensureCalls += 1;
		},
		getMemos: () => sourceMemos,
		getRandomReunionMemos: (count, memos) => {
			randomCalls += 1;
			requestedCount = count;
			requestedMemos = memos;
			return randomPromise;
		},
		markRandomReunionReviewed: async () => {},
		isRandomActive: () => true,
		showNotice: () => {},
		requestRender: () => {
			renderCalls += 1;
		},
	});

	const firstRefresh = controller.refresh();
	const secondRefresh = controller.refresh();
	await Promise.resolve();

	assert.equal(controller.getSnapshot().loading, true);
	assert.equal(controller.getSnapshot().memos, null);
	assert.equal(ensureCalls, 1);
	assert.equal(randomCalls, 1);
	assert.equal(requestedCount, 5);
	assert.equal(requestedMemos, sourceMemos);
	assert.equal(renderCalls, 1);

	resolveRandom(randomMemos);
	await Promise.all([firstRefresh, secondRefresh]);

	assert.equal(controller.getSnapshot().loading, false);
	assert.deepEqual(controller.getSnapshot().memos, randomMemos);
	assert.equal(renderCalls, 2);
});

test("reports random reunion refresh errors and leaves an empty result", async () => {
	const { RandomReunionController } = await loadController();
	const notices: string[] = [];
	let renderCalls = 0;
	const controller = new RandomReunionController({
		ensureAllMemosLoaded: async () => {},
		getMemos: () => [],
		getRandomReunionMemos: async () => {
			throw new Error("random source unavailable");
		},
		markRandomReunionReviewed: async () => {},
		isRandomActive: () => true,
		showNotice: (message) => notices.push(message),
		requestRender: () => {
			renderCalls += 1;
		},
	});

	await controller.refresh();

	assert.equal(controller.getSnapshot().loading, false);
	assert.deepEqual(controller.getSnapshot().memos, []);
	assert.deepEqual(notices, ["random source unavailable"]);
	assert.equal(renderCalls, 2);
});

test("keeps random reunion memos in sync with memo mutations", async () => {
	const { RandomReunionController } = await loadController();
	const firstMemo = makeMemo("memo-1");
	const secondMemo = makeMemo("memo-2");
	const controller = new RandomReunionController({
		ensureAllMemosLoaded: async () => {},
		getMemos: () => [firstMemo, secondMemo],
		getRandomReunionMemos: async () => [firstMemo, secondMemo],
		markRandomReunionReviewed: async () => {},
		isRandomActive: () => false,
		showNotice: () => {},
		requestRender: () => {},
	});
	await controller.refresh();

	const updatedMemo = { ...firstMemo, contentSnapshot: "updated" };
	controller.applyMemoMutation({ type: "update", previousMemo: firstMemo, memo: updatedMemo });
	controller.applyMemoMutation({ type: "delete", previousMemo: secondMemo, memo: secondMemo });

	assert.deepEqual(controller.getSnapshot().memos, [updatedMemo]);
	controller.clearMemos();
	assert.equal(controller.getSnapshot().memos, null);
});

test("marks a random reunion memo reviewed only when requested after open", async () => {
	const { RandomReunionController } = await loadController();
	const reviewedMemoIds: string[] = [];
	const controller = new RandomReunionController({
		ensureAllMemosLoaded: async () => {},
		getMemos: () => [],
		getRandomReunionMemos: async () => [],
		markRandomReunionReviewed: async (memoId) => {
			reviewedMemoIds.push(memoId);
		},
		isRandomActive: () => false,
		showNotice: () => {},
		requestRender: () => {},
	});

	await controller.markReviewedAfterOpen("memo-1");

	assert.deepEqual(reviewedMemoIds, ["memo-1"]);
});

async function loadController(): Promise<typeof import("../src/ui/RandomReunionController")> {
	await ensureObsidianStub();
	return import("../src/ui/RandomReunionController");
}

function makeMemo(id: string): MemoRecord {
	return {
		id,
		createdAt: "2026-06-02T00:00:00+08:00",
		updatedAt: "2026-06-02T00:00:00+08:00",
		contentSnapshot: id,
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
			path: "Daily/2026-06-02.md",
			heading: "Memos",
			sectionType: "heading",
			lastKnownBlock: id,
			lastKnownHash: `hash-${id}`,
			lineNumberHint: 1,
			lastSyncedAt: null,
		},
		monthlyRef: {
			path: "Memos/Memos-2026-06.md",
			dateHeading: "2026-06-02",
			lastKnownBlock: id,
			lastKnownHash: `hash-${id}`,
			lineNumberHint: 1,
			lastSyncedAt: null,
		},
	};
}

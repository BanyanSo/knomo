import test from "node:test";
import assert from "node:assert/strict";

import type { MemoRecord } from "./helpers/memoViewFixture";
import { ensureObsidianStub } from "./helpers/obsidianStub";

test("refreshes random reunion once while loading and preserves render transitions", async () => {
	const { RandomReunionController } = await loadController();
	const sourceMemos = [makeMemo("memo-1"), makeMemo("memo-2")];
	const randomMemos = [sourceMemos[1]];
	let prepareCalls = 0;
	let randomCalls = 0;
	let requestedCount = 0;
	let requestedMemos: MemoRecord[] | null = null;
	let renderCalls = 0;
	let resolveRandom!: (memos: MemoRecord[]) => void;
	const randomPromise = new Promise<MemoRecord[]>((resolve) => {
		resolveRandom = resolve;
	});
	const controller = new RandomReunionController({
		prepareCatalogData: async () => {
			prepareCalls += 1;
		},
		getMemos: () => sourceMemos,
		getRandomReunionMemos: (count, memos) => {
			randomCalls += 1;
			requestedCount = count;
			requestedMemos = memos;
			return randomPromise;
		},
		openRandomReunionMemo: async () => {},
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
	assert.equal(prepareCalls, 1);
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
		prepareCatalogData: async () => {},
		getMemos: () => [],
		getRandomReunionMemos: async () => {
			throw new Error("random source unavailable");
		},
		openRandomReunionMemo: async () => {},
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

test("does not select random memos when full loading fails", async () => {
	const { RandomReunionController } = await loadController();
	let randomCalls = 0;
	const notices: string[] = [];
	const controller = new RandomReunionController({
		prepareCatalogData: async () => {
			throw new Error("full load failed");
		},
		getMemos: () => [makeMemo("memo-1")],
		getRandomReunionMemos: async () => {
			randomCalls += 1;
			return [];
		},
		openRandomReunionMemo: async () => {},
		markRandomReunionReviewed: async () => {},
		isRandomActive: () => true,
		showNotice: (message) => notices.push(message),
		requestRender: () => {},
	});

	await controller.refresh();

	assert.equal(randomCalls, 0);
	assert.equal(controller.getSnapshot().memos?.length, 0);
	assert.equal(notices.length, 1);
});

test("clears cached random reunion memos before the next Catalog refresh", async () => {
	const { RandomReunionController } = await loadController();
	const firstMemo = makeMemo("memo-1");
	const secondMemo = makeMemo("memo-2");
	const controller = new RandomReunionController({
		prepareCatalogData: async () => {},
		getMemos: () => [firstMemo, secondMemo],
		getRandomReunionMemos: async () => [firstMemo, secondMemo],
		openRandomReunionMemo: async () => {},
		markRandomReunionReviewed: async () => {},
		isRandomActive: () => false,
		showNotice: () => {},
		requestRender: () => {},
	});
	await controller.refresh();

	assert.deepEqual(controller.getSnapshot().memos, [firstMemo, secondMemo]);
	controller.clearMemos();
	assert.equal(controller.getSnapshot().memos, null);
});

test("keeps explicit review available for Time buoy cards", async () => {
	const { RandomReunionController } = await loadController();
	const reviewedMemoIds: string[] = [];
	const controller = new RandomReunionController({
		prepareCatalogData: async () => {},
		getMemos: () => [],
		getRandomReunionMemos: async () => [],
		openRandomReunionMemo: async () => {},
		markRandomReunionReviewed: async (memoId) => {
			reviewedMemoIds.push(memoId);
		},
		isRandomActive: () => false,
		showNotice: () => {},
		requestRender: () => {},
	});

	await controller.markReviewed("memo-1");

	assert.deepEqual(reviewedMemoIds, ["memo-1"]);
});

test("opens a random memo once and records exactly one review after Daily succeeds", async () => {
	const { RandomReunionController } = await loadController();
	const memo = makeMemo("memo-1");
	const events: string[] = [];
	let resolveOpen!: () => void;
	const openGate = new Promise<void>((resolve) => { resolveOpen = resolve; });
	const controller = new RandomReunionController({
		prepareCatalogData: async () => {},
		getMemos: () => [memo],
		getRandomReunionMemos: async () => [memo],
		openRandomReunionMemo: async () => {
			events.push("open");
			await openGate;
		},
		markRandomReunionReviewed: async (memoId) => { events.push(`review:${memoId}`); },
		isRandomActive: () => true,
		showNotice: () => {},
		requestRender: () => {},
	});
	await controller.refresh();

	const first = controller.openMemo(memo.id);
	const second = controller.openMemo(memo.id);
	assert.deepEqual(events, ["open"]);
	resolveOpen();
	await Promise.all([first, second]);

	assert.deepEqual(events, ["open", "review:memo-1"]);
});

test("does not review when Daily opening fails and distinguishes review persistence failure", async () => {
	const { RandomReunionController } = await loadController();
	const memo = makeMemo("memo-1");
	const notices: string[] = [];
	let reviewCalls = 0;
	let failOpen = true;
	const controller = new RandomReunionController({
		prepareCatalogData: async () => {},
		getMemos: () => [memo],
		getRandomReunionMemos: async () => [memo],
		openRandomReunionMemo: async () => {
			if (failOpen) throw new Error("Daily unavailable");
		},
		markRandomReunionReviewed: async () => {
			reviewCalls += 1;
			throw new Error("Identity unavailable");
		},
		isRandomActive: () => true,
		showNotice: (message) => notices.push(message),
		requestRender: () => {},
	});
	await controller.refresh();

	await controller.openMemo(memo.id);
	assert.equal(reviewCalls, 0);
	assert.equal(notices[0], "Random revisit failed to open: Daily unavailable");

	failOpen = false;
	await controller.openMemo(memo.id);
	assert.equal(reviewCalls, 1);
	assert.equal(notices[1], "Daily note opened, but review status was not saved: Identity unavailable");
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

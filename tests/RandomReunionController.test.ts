import test from "node:test";
import assert from "node:assert/strict";

import type { MemoRecord } from "./helpers/memoViewFixture";
import { ensureObsidianStub } from "./helpers/obsidianStub";

test("refreshes random reunion once while loading and preserves render transitions", async () => {
	const { RandomReunionController } = await loadController();
	const sourceMemos = [makeMemo("memo-1"), makeMemo("memo-2")];
	const randomMemos = [sourceMemos[1]];
	let randomCalls = 0;
	let requestedCount = 0;
	let renderCalls = 0;
	let resolveRandom!: (memos: MemoRecord[]) => void;
	const randomPromise = new Promise<MemoRecord[]>((resolve) => {
		resolveRandom = resolve;
	});
	const controller = new RandomReunionController({
		loadRandomReunionMemos: (count) => {
			randomCalls += 1;
			requestedCount = count;
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

	assert.equal(controller.getSnapshot().status, "loading-candidates");
	assert.equal(controller.getSnapshot().memos, null);
	assert.equal(randomCalls, 1);
	assert.equal(requestedCount, 5);
	assert.equal(renderCalls, 1);

	resolveRandom(randomMemos);
	await Promise.all([firstRefresh, secondRefresh]);

	assert.equal(controller.getSnapshot().status, "ready");
	assert.deepEqual(controller.getSnapshot().memos, randomMemos);
	assert.equal(renderCalls, 2);
});

test("keeps the current random reunion batch visible while loading the next group", async () => {
	const { RandomReunionController } = await loadController();
	const firstMemos = [makeMemo("memo-1")];
	const nextMemos = [makeMemo("memo-2")];
	const deferred = createDeferred<MemoRecord[]>();
	let loadCalls = 0;
	let prepareNext: () => void = () => undefined;
	const controller = new RandomReunionController({
		loadRandomReunionMemos: async (_count, onPreparingIdentity) => {
			loadCalls += 1;
			if (loadCalls > 1) prepareNext = onPreparingIdentity;
			return loadCalls === 1 ? firstMemos : deferred.promise;
		},
		openRandomReunionMemo: async () => {},
		markRandomReunionReviewed: async () => {},
		isRandomActive: () => true,
		showNotice: () => {},
		requestRender: () => {},
	});
	await controller.refresh();

	const refreshing = controller.refresh();
	await Promise.resolve();

	assert.equal(controller.getSnapshot().status, "loading-candidates");
	assert.deepEqual(controller.getSnapshot().memos, firstMemos);
	prepareNext();
	assert.equal(controller.getSnapshot().status, "preparing-identity");
	assert.deepEqual(controller.getSnapshot().memos, firstMemos);

	deferred.resolve(nextMemos);
	await refreshing;
	assert.equal(controller.getSnapshot().status, "ready");
	assert.deepEqual(controller.getSnapshot().memos, nextMemos);
});

test("keeps the current random reunion batch when loading the next group fails", async () => {
	const { RandomReunionController } = await loadController();
	const firstMemos = [makeMemo("memo-1")];
	const notices: string[] = [];
	let loadCalls = 0;
	const controller = new RandomReunionController({
		loadRandomReunionMemos: async () => {
			loadCalls += 1;
			if (loadCalls > 1) throw new Error("next group unavailable");
			return firstMemos;
		},
		openRandomReunionMemo: async () => {},
		markRandomReunionReviewed: async () => {},
		isRandomActive: () => true,
		showNotice: (message) => notices.push(message),
		requestRender: () => {},
	});
	await controller.refresh();

	await controller.refresh();

	assert.equal(controller.getSnapshot().status, "ready");
	assert.equal(controller.getSnapshot().error, null);
	assert.deepEqual(controller.getSnapshot().memos, firstMemos);
	assert.deepEqual(notices, ["next group unavailable"]);
});

test("reports random reunion refresh errors without presenting a false empty result", async () => {
	const { RandomReunionController } = await loadController();
	const notices: string[] = [];
	let renderCalls = 0;
	const controller = new RandomReunionController({
		loadRandomReunionMemos: async () => {
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

	assert.equal(controller.getSnapshot().status, "failed");
	assert.equal(controller.getSnapshot().error, "random source unavailable");
	assert.equal(controller.getSnapshot().memos, null);
	assert.deepEqual(notices, ["random source unavailable"]);
	assert.equal(renderCalls, 2);
});

test("reports identity preparation separately before a preparation failure", async () => {
	const { RandomReunionController } = await loadController();
	const notices: string[] = [];
	const states: string[] = [];
	const controller = new RandomReunionController({
		loadRandomReunionMemos: async (_count, onPreparingIdentity) => {
			onPreparingIdentity();
			throw new Error("identity preparation failed");
		},
		openRandomReunionMemo: async () => {},
		markRandomReunionReviewed: async () => {},
		isRandomActive: () => true,
		showNotice: (message) => notices.push(message),
		requestRender: () => { states.push(controller.getSnapshot().status); },
	});

	await controller.refresh();

	assert.deepEqual(states, ["loading-candidates", "preparing-identity", "failed"]);
	assert.equal(controller.getSnapshot().status, "failed");
	assert.equal(controller.getSnapshot().memos, null);
	assert.equal(notices.length, 1);
});

test("clears cached random reunion memos before the next Catalog refresh", async () => {
	const { RandomReunionController } = await loadController();
	const firstMemo = makeMemo("memo-1");
	const secondMemo = makeMemo("memo-2");
	const controller = new RandomReunionController({
		loadRandomReunionMemos: async () => [firstMemo, secondMemo],
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
	assert.equal(controller.getSnapshot().status, "idle");
});

test("clearing random reunion invalidates an in-flight result", async () => {
	const { RandomReunionController } = await loadController();
	const deferred = createDeferred<MemoRecord[]>();
	const controller = new RandomReunionController({
		loadRandomReunionMemos: async () => deferred.promise,
		openRandomReunionMemo: async () => {},
		markRandomReunionReviewed: async () => {},
		isRandomActive: () => false,
		showNotice: () => {},
		requestRender: () => {},
	});

	const refreshing = controller.refresh();
	controller.clearMemos();
	deferred.resolve([makeMemo("stale")]);
	await refreshing;

	assert.equal(controller.getSnapshot().status, "idle");
	assert.equal(controller.getSnapshot().memos, null);
});

test("keeps explicit review available for Time buoy cards", async () => {
	const { RandomReunionController } = await loadController();
	const reviewedMemoIds: string[] = [];
	const controller = new RandomReunionController({
		loadRandomReunionMemos: async () => [],
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
		loadRandomReunionMemos: async () => [memo],
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
		loadRandomReunionMemos: async () => [memo],
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

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolvePromise: (value: T) => void = () => undefined;
	const promise = new Promise<T>((resolve) => { resolvePromise = resolve; });
	return { promise, resolve: resolvePromise };
}

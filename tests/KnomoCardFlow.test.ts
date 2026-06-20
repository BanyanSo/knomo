import test from "node:test";
import assert from "node:assert/strict";

import {
	getVisibleCardFlowMemoStateKey,
	KnomoCardFlowBatcher,
	runCardFlowBatch,
} from "../src/ui/KnomoCardFlow";
import type { MemoRecord } from "../src/types/memo";

test("starts card flow with the default batch size", () => {
	const batcher = new KnomoCardFlowBatcher();
	const batch = batcher.start(makeMemos(5), "memo", 3);

	assert.equal(batch?.type, "items");
	if (batch?.type !== "items") return;
	assert.deepEqual(batch.items.map((item) => item.memo.id), ["memo-0", "memo-1", "memo-2"]);
	assert.deepEqual(batch.items.map((item) => item.renderIndex), [0, 1, 2]);
	assert.deepEqual(batch.items.map((item) => item.mode), ["memo", "memo", "memo"]);

	const completion = batcher.completeBatch(batch);
	assert.deepEqual(completion, { hasMoreItems: true, remainingCount: 2 });
	assert.equal(batcher.hasMoreItems, true);
});

test("continues card flow batches and reports exhaustion", () => {
	const batcher = new KnomoCardFlowBatcher();
	const firstBatch = batcher.start(makeMemos(4), "trash", 2);
	assert.equal(firstBatch?.type, "items");
	if (firstBatch?.type !== "items") return;
	batcher.completeBatch(firstBatch);

	const secondBatch = batcher.beginNextBatch(2);
	assert.equal(secondBatch?.type, "items");
	if (secondBatch?.type !== "items") return;
	assert.deepEqual(secondBatch.items.map((item) => item.memo.id), ["memo-2", "memo-3"]);
	assert.deepEqual(secondBatch.items.map((item) => item.renderIndex), [2, 3]);
	assert.deepEqual(secondBatch.items.map((item) => item.mode), ["trash", "trash"]);
	assert.deepEqual(batcher.completeBatch(secondBatch), { hasMoreItems: false, remainingCount: 0 });

	const emptyBatch = batcher.beginNextBatch(2);
	assert.deepEqual(emptyBatch, { type: "empty" });
	assert.equal(batcher.hasMoreItems, false);
});

test("updates card flow items without resetting rendered offset", () => {
	const batcher = new KnomoCardFlowBatcher();
	const firstBatch = batcher.start(makeMemos(2), "memo", 2);
	assert.equal(firstBatch?.type, "items");
	if (firstBatch?.type !== "items") return;
	assert.deepEqual(batcher.completeBatch(firstBatch), { hasMoreItems: false, remainingCount: 0 });
	assert.equal(batcher.hasMoreItems, false);

	batcher.updateItems(makeMemos(4));
	assert.equal(batcher.hasMoreItems, true);
	assert.equal(batcher.remainingCount, 2);

	const nextBatch = batcher.beginNextBatch(2);
	assert.equal(nextBatch?.type, "items");
	if (nextBatch?.type !== "items") return;
	assert.deepEqual(nextBatch.items.map((item) => item.memo.id), ["memo-2", "memo-3"]);
	assert.deepEqual(nextBatch.items.map((item) => item.renderIndex), [2, 3]);
});

test("compares only the rendered memo window during hydration", () => {
	const visibleMemos = makeMemos(2);
	const previousKey = getVisibleCardFlowMemoStateKey(visibleMemos, 2, 50);
	const appendedKey = getVisibleCardFlowMemoStateKey(
		[...visibleMemos, makeMemo("older-0"), makeMemo("older-1")],
		2,
		50,
	);
	const prependedKey = getVisibleCardFlowMemoStateKey(
		[makeMemo("new-0"), ...visibleMemos],
		2,
		50,
	);

	assert.equal(appendedKey, previousKey);
	assert.notEqual(prependedKey, previousKey);
});

test("syncs the rendered count after inserting a memo at the front", () => {
	const batcher = new KnomoCardFlowBatcher();
	const firstBatch = batcher.start(makeMemos(4), "memo", 3);
	assert.equal(firstBatch?.type, "items");
	if (firstBatch?.type !== "items") return;
	batcher.completeBatch(firstBatch);

	const memos = [makeMemo("new-0"), ...makeMemos(4)];
	batcher.sync(memos, "memo", 4);
	const nextBatch = batcher.beginNextBatch(2);

	assert.equal(nextBatch?.type, "items");
	if (nextBatch?.type !== "items") return;
	assert.deepEqual(nextBatch.items.map((item) => item.memo.id), ["memo-3"]);
	assert.deepEqual(nextBatch.items.map((item) => item.renderIndex), [4]);
});

test("preserves the previous rendered count when restarting", () => {
	const batcher = new KnomoCardFlowBatcher();
	const firstBatch = batcher.start(makeMemos(6), "memo", 2);
	assert.equal(firstBatch?.type, "items");
	if (firstBatch?.type !== "items") return;
	batcher.completeBatch(firstBatch);

	const restartBatch = batcher.start(makeMemos(6), "memo", 2);
	assert.equal(restartBatch?.type, "items");
	if (restartBatch?.type !== "items") return;
	assert.deepEqual(restartBatch.items.map((item) => item.memo.id), ["memo-0", "memo-1"]);
	batcher.completeBatch(restartBatch);

	const largerBatch = batcher.beginNextBatch(4);
	assert.equal(largerBatch?.type, "items");
	if (largerBatch?.type !== "items") return;
	batcher.completeBatch(largerBatch);

	const preservedBatch = batcher.start(makeMemos(6), "memo", 2);
	assert.equal(preservedBatch?.type, "items");
	if (preservedBatch?.type !== "items") return;
	assert.equal(preservedBatch.items.length, 6);
});

test("uses the initial batch size after resetting before restart", () => {
	const batcher = new KnomoCardFlowBatcher();
	const firstBatch = batcher.start(makeMemos(6), "memo", 2);
	assert.equal(firstBatch?.type, "items");
	if (firstBatch?.type !== "items") return;
	batcher.completeBatch(firstBatch);

	const largerBatch = batcher.beginNextBatch(4);
	assert.equal(largerBatch?.type, "items");
	if (largerBatch?.type !== "items") return;
	batcher.completeBatch(largerBatch);

	batcher.reset();
	const resetBatch = batcher.start(makeMemos(6, "new"), "memo", 2);
	assert.equal(resetBatch?.type, "items");
	if (resetBatch?.type !== "items") return;
	assert.deepEqual(resetBatch.items.map((item) => item.memo.id), ["new-0", "new-1"]);
});

test("blocks overlapping batches until completion or cancel", () => {
	const batcher = new KnomoCardFlowBatcher();
	const batch = batcher.start(makeMemos(3), "memo", 2);
	assert.equal(batch?.type, "items");
	assert.equal(batcher.beginNextBatch(2), null);
	batcher.cancelBatch();

	const retriedBatch = batcher.beginNextBatch(2);
	assert.equal(retriedBatch?.type, "items");
	if (retriedBatch?.type !== "items") return;
	assert.deepEqual(retriedBatch.items.map((item) => item.memo.id), ["memo-0", "memo-1"]);
});

test("restarts card flow while a previous batch is pending", () => {
	const batcher = new KnomoCardFlowBatcher();
	const pendingBatch = batcher.start(makeMemos(4, "old"), "memo", 2);
	assert.equal(pendingBatch?.type, "items");

	const restartBatch = batcher.start(makeMemos(3, "new"), "trash", 2);
	assert.equal(restartBatch?.type, "items");
	if (restartBatch?.type !== "items") return;
	assert.deepEqual(restartBatch.items.map((item) => item.memo.id), ["new-0", "new-1"]);
	assert.deepEqual(restartBatch.items.map((item) => item.mode), ["trash", "trash"]);
	assert.deepEqual(batcher.completeBatch(restartBatch), { hasMoreItems: true, remainingCount: 1 });
});

test("resets card flow state", () => {
	const batcher = new KnomoCardFlowBatcher();
	const batch = batcher.start(makeMemos(2), "memo", 1);
	assert.equal(batch?.type, "items");
	batcher.reset();

	assert.equal(batcher.hasMoreItems, false);
	assert.deepEqual(batcher.beginNextBatch(1), { type: "empty" });
});

test("skips missing card flow batches without side effects", () => {
	const calls: string[] = [];
	const result = runCardFlowBatch({
		batch: null,
		generation: 1,
		hasRenderTarget: true,
		isCurrentGeneration: () => true,
		removeSentinel: () => calls.push("remove"),
		renderItem: () => calls.push("render"),
		completeBatch: () => {
			calls.push("complete");
			return { hasMoreItems: false, remainingCount: 0 };
		},
		cancelBatch: () => calls.push("cancel"),
	});

	assert.deepEqual(result, { type: "skipped" });
	assert.deepEqual(calls, []);
});

test("clears sentinel for empty card flow batches", () => {
	const calls: string[] = [];
	const result = runCardFlowBatch({
		batch: { type: "empty" },
		generation: 1,
		hasRenderTarget: true,
		isCurrentGeneration: () => true,
		removeSentinel: () => calls.push("remove"),
		renderItem: () => calls.push("render"),
		completeBatch: () => {
			calls.push("complete");
			return { hasMoreItems: false, remainingCount: 0 };
		},
		cancelBatch: () => calls.push("cancel"),
	});

	assert.deepEqual(result, { type: "empty" });
	assert.deepEqual(calls, ["remove"]);
});

test("cancels card flow batches when the render target is gone", () => {
	const batch = makeItemsBatch(makeMemos(1));
	const calls: string[] = [];
	const result = runCardFlowBatch({
		batch,
		generation: 1,
		hasRenderTarget: false,
		isCurrentGeneration: () => true,
		removeSentinel: () => calls.push("remove"),
		renderItem: () => calls.push("render"),
		completeBatch: () => {
			calls.push("complete");
			return { hasMoreItems: false, remainingCount: 0 };
		},
		cancelBatch: () => calls.push("cancel"),
	});

	assert.deepEqual(result, { type: "cancelled" });
	assert.deepEqual(calls, ["cancel"]);
});

test("renders and completes current card flow batches", () => {
	const batch = makeItemsBatch(makeMemos(2), "trash");
	const rendered: string[] = [];
	const calls: string[] = [];
	const result = runCardFlowBatch({
		batch,
		generation: 3,
		hasRenderTarget: true,
		isCurrentGeneration: (generation) => generation === 3,
		removeSentinel: () => calls.push("remove"),
		renderItem: (item) => rendered.push(`${item.mode}:${item.memo.id}:${item.renderIndex}`),
		completeBatch: (completedBatch) => {
			calls.push(`complete:${completedBatch.type}`);
			return { hasMoreItems: true, remainingCount: 4 };
		},
		cancelBatch: () => calls.push("cancel"),
	});

	assert.deepEqual(result, { type: "completed", completion: { hasMoreItems: true, remainingCount: 4 } });
	assert.deepEqual(calls, ["remove", "complete:items"]);
	assert.deepEqual(rendered, ["trash:memo-0:0", "trash:memo-1:1"]);
});

test("renders a card flow batch in bounded chunks before completing it", () => {
	const batch = makeItemsBatch(makeMemos(15));
	const rendered: string[] = [];
	let completeCount = 0;
	const options = {
		batch,
		generation: 3,
		hasRenderTarget: true,
		isCurrentGeneration: (generation: number) => generation === 3,
		removeSentinel: () => undefined,
		renderItem: (item: (typeof batch.items)[number]) => rendered.push(item.memo.id),
		completeBatch: () => {
			completeCount += 1;
			return { hasMoreItems: false, remainingCount: 0 };
		},
		cancelBatch: () => undefined,
	};

	const firstResult = runCardFlowBatch({
		...options,
		maxItems: 8,
	});
	assert.deepEqual(firstResult, { type: "pending", nextIndex: 8 });
	assert.equal(rendered.length, 8);
	assert.equal(completeCount, 0);

	const secondResult = runCardFlowBatch({
		...options,
		startIndex: 8,
		maxItems: 6,
	});
	assert.deepEqual(secondResult, { type: "pending", nextIndex: 14 });
	assert.equal(rendered.length, 14);
	assert.equal(completeCount, 0);

	const finalResult = runCardFlowBatch({
		...options,
		startIndex: 14,
		maxItems: 6,
	});
	assert.deepEqual(finalResult, {
		type: "completed",
		completion: { hasMoreItems: false, remainingCount: 0 },
	});
	assert.equal(rendered.length, 15);
	assert.equal(completeCount, 1);
});

test("cancels stale card flow batches before completion", () => {
	const batch = makeItemsBatch(makeMemos(2));
	const rendered: string[] = [];
	const calls: string[] = [];
	let checkCount = 0;
	const result = runCardFlowBatch({
		batch,
		generation: 5,
		hasRenderTarget: true,
		isCurrentGeneration: () => {
			checkCount += 1;
			return checkCount === 1;
		},
		removeSentinel: () => calls.push("remove"),
		renderItem: (item) => rendered.push(item.memo.id),
		completeBatch: () => {
			calls.push("complete");
			return { hasMoreItems: false, remainingCount: 0 };
		},
		cancelBatch: () => calls.push("cancel"),
	});

	assert.deepEqual(result, { type: "cancelled" });
	assert.deepEqual(calls, ["remove", "cancel"]);
	assert.deepEqual(rendered, ["memo-0"]);
});

function makeMemos(count: number, prefix = "memo"): MemoRecord[] {
	return Array.from({ length: count }, (_, index) => makeMemo(`${prefix}-${index}`));
}

function makeItemsBatch(memos: MemoRecord[], mode: "memo" | "trash" = "memo") {
	return {
		type: "items" as const,
		items: memos.map((memo, renderIndex) => ({ memo, mode, renderIndex })),
		batchEnd: memos.length,
		totalCount: memos.length,
	};
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

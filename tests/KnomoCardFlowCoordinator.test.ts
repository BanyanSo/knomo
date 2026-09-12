import test from "node:test";
import assert from "node:assert/strict";

import { KnomoCardFlowCoordinator } from "../src/ui/KnomoCardFlowCoordinator";
import type { MemoViewItem } from "../src/types/memoView";
import type { CardFlowSentinelRenderOptions } from "../src/ui/KnomoCardFlowSentinel";

test("展示重排恢复同一 render key 相对位置，revision 改变只回退 scrollTop", () => {
	const coordinator = new KnomoCardFlowCoordinator();
	coordinator.generation = 4;
	let key = "daily:rev-a:2";
	const root = { scrollTop: 100, getBoundingClientRect: () => ({ top: 10 }), children: [{
		getAttribute: () => key, getBoundingClientRect: () => ({ top: 60 }),
	}] } as unknown as HTMLElement;
	const pending = { generation: 4, scrollTop: 90, visibleCount: 50, anchor: { renderKey: key, offset: 20 } };
	const values: number[] = [];
	coordinator.setPendingScrollRestore(pending);
	coordinator.restorePendingScrollTop(4, (value) => values.push(value), root);
	key = "daily:rev-b:2";
	coordinator.setPendingScrollRestore(pending);
	coordinator.restorePendingScrollTop(4, (value) => values.push(value), root);
	assert.deepEqual(values, [130, 90]);
});

test("tracks pending scroll restore by generation and consumes it once", () => {
	const coordinator = new KnomoCardFlowCoordinator();
	const generation = advanceGeneration(coordinator);
	const restored: number[] = [];

	coordinator.setPendingScrollRestore({ generation, scrollTop: 72, visibleCount: 12 });

	assert.equal(coordinator.getPendingVisibleCount(generation), 12);

	coordinator.restorePendingScrollTop(generation - 1, (scrollTop) => restored.push(scrollTop));
	coordinator.restorePendingScrollTop(generation, (scrollTop) => restored.push(scrollTop));
	coordinator.restorePendingScrollTop(generation, (scrollTop) => restored.push(scrollTop));

	assert.deepEqual(restored, [72]);
	assert.equal(coordinator.getPendingVisibleCount(generation), null);
});

test("merges deferred mobile render requests while composer is open", () => {
	const coordinator = new KnomoCardFlowCoordinator();

	assert.equal(coordinator.deferMobileRender({
		isMobile: false,
		composerOpen: true,
		preserveCardMemoId: "memo-0",
		forceRebuild: false,
		changeIntent: "content-change",
	}), false);

	assert.equal(coordinator.deferMobileRender({
		isMobile: true,
		composerOpen: true,
		preserveCardMemoId: "memo-1",
		forceRebuild: false,
		changeIntent: "content-change",
	}), true);
	assert.equal(coordinator.deferMobileRender({
		isMobile: true,
		composerOpen: true,
		preserveCardMemoId: null,
		forceRebuild: true,
		changeIntent: "view-scope-change",
	}), true);

	assert.deepEqual(coordinator.consumeMobileRenderRequest(), {
		forceRebuild: true,
		changeIntent: "view-scope-change",
		preserveCardMemoId: "memo-1",
	});
	assert.equal(coordinator.consumeMobileRenderRequest(), null);
});

test("renders mobile card batches in bounded continuations", () => {
	const coordinator = new KnomoCardFlowCoordinator({ sentinel: new FakeSentinel() });
	const generation = advanceGeneration(coordinator);
	const batch = coordinator.startBatch(makeMemos(5), "memo", 5);
	const rendered: string[] = [];
	const continuations: Array<() => void> = [];

	coordinator.renderBatch({
		batch,
		generation,
		isMobile: true,
		syncItemLimit: 2,
		chunkSize: 2,
		renderItem: (item) => rendered.push(item.memo.id),
		getSentinelRoot: () => makeScrollTarget(0, 0, 0),
		getObserver: () => undefined,
		onRenderNextBatch: () => undefined,
		requestHydration: () => undefined,
		restorePendingScrollTop: () => undefined,
		scheduleContinuation: (continuation) => continuations.push(continuation),
	});

	assert.deepEqual(rendered, ["memo-0", "memo-1"]);
	assert.equal(continuations.length, 1);

	continuations.shift()?.();
	assert.deepEqual(rendered, ["memo-0", "memo-1", "memo-2", "memo-3"]);
	assert.equal(continuations.length, 1);

	continuations.shift()?.();
	assert.deepEqual(rendered, ["memo-0", "memo-1", "memo-2", "memo-3", "memo-4"]);
	assert.equal(coordinator.hasMoreItems, false);
});

test("scroll bottom keeps next-batch and hydration fallback when observer is active", () => {
	const sentinel = new FakeSentinel();
	sentinel.isObserving = true;
	const coordinator = new KnomoCardFlowCoordinator({ sentinel });
	const generation = advanceGeneration(coordinator);
	coordinator.syncBatch(makeMemos(3), "memo", 1);
	const nextBatchGenerations: number[] = [];
	let hydrationCount = 0;

	coordinator.handleScroll({
		cardFlow: makeScrollTarget(850, 200, 1000),
		isRecordStatsActive: false,
		onRenderNextBatch: (value) => nextBatchGenerations.push(value),
		requestHydration: () => {
			hydrationCount += 1;
		},
	});

	assert.deepEqual(nextBatchGenerations, [generation]);
	assert.equal(hydrationCount, 0);

	coordinator.syncBatch(makeMemos(3), "memo", 3);
	coordinator.handleScroll({
		cardFlow: makeScrollTarget(850, 200, 1000),
		isRecordStatsActive: false,
		onRenderNextBatch: (value) => nextBatchGenerations.push(value),
		requestHydration: () => {
			hydrationCount += 1;
		},
	});

	assert.deepEqual(nextBatchGenerations, [generation]);
	assert.equal(hydrationCount, 1);
});

class FakeSentinel {
	isObserving = false;
	renderCalls: CardFlowSentinelRenderOptions[] = [];

	render(options: CardFlowSentinelRenderOptions): void {
		this.renderCalls.push(options);
	}

	remove(): void {
		this.isObserving = false;
	}
}

function makeScrollTarget(scrollTop: number, clientHeight: number, scrollHeight: number): HTMLElement {
	return {
		scrollTop,
		clientHeight,
		scrollHeight,
	} as HTMLElement;
}

function advanceGeneration(coordinator: KnomoCardFlowCoordinator): number {
	coordinator.generation += 1;
	return coordinator.generation;
}

function makeMemos(count: number, prefix = "memo"): MemoViewItem[] {
	return Array.from({ length: count }, (_, index) => makeMemo(`${prefix}-${index}`));
}

function makeMemo(id: string): MemoViewItem {
	return {
		id,
		createdAt: "2026-06-02T00:00:00+08:00",
		updatedAt: "2026-06-02T00:00:00+08:00",
		contentSnapshot: id,
		contentHash: id,
		status: "active",
		tags: [],
		links: [],
		images: [],
		dailyRef: {
			path: "Daily/2026-06-02.md",
			heading: null,
			lineNumberHint: null,
		},
	};
}

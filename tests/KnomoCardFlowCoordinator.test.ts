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

test("桌面 50、500、2000 卡片按数量分片，完成前不开放下一批", async t => {
	t.mock.method(performance, "now", () => 0);
	for (const count of [50, 500, 2000]) await t.test(String(count), () => {
		const f = createDesktopBatch(count);
		f.coordinator.renderBatch(f.options);
		assert.equal(f.rendered.length, 8);
		assert.equal(f.coordinator.beginNextBatch(50), null);
		let frames = 0;
		while (f.continuations.length > 0) {
			f.continuations.shift()!();
			frames++;
		}
		assert.equal(frames, Math.ceil((count - 8) / 6));
		assert.deepEqual(f.rendered, makeMemos(count).map(memo => memo.id));
		assert.equal(f.coordinator.hasMoreItems, false);
	});
});

test("桌面时间预算在数量上限前让出，最后一片才完成批次", t => {
	let time = 0, exhausted = 0;
	t.mock.method(performance, "now", () => time);
	const f = createDesktopBatch(5);
	f.options.syncItemLimit = 5;
	f.options.chunkSize = 5;
	f.options.renderItem = item => { f.rendered.push(item.memo.id); time += 5; };
	f.options.onExhausted = () => { exhausted++; };
	f.coordinator.renderBatch(f.options);
	assert.deepEqual(f.rendered, ["memo-0", "memo-1"]);
	assert.equal(exhausted, 0);
	f.continuations.shift()!();
	assert.deepEqual(f.rendered, ["memo-0", "memo-1", "memo-2", "memo-3"]);
	assert.equal(exhausted, 0);
	f.continuations.shift()!();
	assert.equal(f.rendered.length, 5);
	assert.equal(exhausted, 1);
});

test("旧 continuation 不渲染、不完成，也不清除新批次的 loading", t => {
	t.mock.method(performance, "now", () => 0);
	const f = createDesktopBatch(20);
	f.coordinator.renderBatch(f.options);
	const old = f.continuations.shift()!;
	f.coordinator.generation++;
	f.coordinator.resetFlowRuntime();
	const current = { ...f.options, generation: f.coordinator.generation,
		batch: f.coordinator.startBatch(makeMemos(20, "current"), "memo", 20) };
	f.coordinator.renderBatch(current);
	const before = [...f.rendered];
	old();
	assert.deepEqual(f.rendered, before);
	assert.equal(f.coordinator.beginNextBatch(50), null);
	while (f.continuations.length > 0) f.continuations.shift()!();
	assert.deepEqual(f.rendered.slice(8), makeMemos(20, "current").map(memo => memo.id));
});

test("renderItem 重入新代次后，旧批次不能覆盖新 continuation", async t => {
	t.mock.method(performance, "now", () => 0);
	for (const limit of [1, 8]) await t.test(String(limit), () => {
		const f = createDesktopBatch(20);
		f.options.syncItemLimit = limit;
		const render = f.options.renderItem;
		let replaced = false;
		f.options.renderItem = (item, generation) => {
			if (replaced) { render(item, generation); return; }
			replaced = true;
			f.coordinator.generation++;
			f.coordinator.resetFlowRuntime();
			f.coordinator.renderBatch({ ...f.options, generation: f.coordinator.generation,
				batch: f.coordinator.startBatch(makeMemos(20, "current"), "memo", 20) });
		};
		f.coordinator.renderBatch(f.options);
		assert.equal(f.coordinator.beginNextBatch(50), null);
		assert.equal(f.continuations.length, 1);
		while (f.continuations.length > 0) f.continuations.shift()!();
		assert.deepEqual(f.rendered, makeMemos(20, "current").map(memo => memo.id));
	});
});

function createDesktopBatch(count: number) {
	const coordinator = new KnomoCardFlowCoordinator({ sentinel: new FakeSentinel() });
	const generation = advanceGeneration(coordinator);
	const rendered: string[] = [], continuations: Array<() => void> = [];
	const options: Parameters<KnomoCardFlowCoordinator["renderBatch"]>[0] = {
		batch: coordinator.startBatch(makeMemos(count), "memo", count), generation,
		isMobile: false, syncItemLimit: 8, chunkSize: 6,
		renderItem: item => { rendered.push(item.memo.id); },
		getSentinelRoot: () => makeScrollTarget(0, 0, 0), getObserver: () => undefined,
		onRenderNextBatch: () => undefined, requestHydration: () => undefined,
		restorePendingScrollTop: () => undefined,
		scheduleContinuation: continuation => { continuations.push(continuation); },
	};
	return { coordinator, rendered, continuations, options };
}

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

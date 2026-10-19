import test from "node:test";
import assert from "node:assert/strict";

import { MarkdownRenderQueue } from "../src/ui/MarkdownRenderQueue";

test("runs high priority markdown tasks before queued normal tasks", async () => {
	let generation = 1;
	const firstTask = createDeferred();
	const order: string[] = [];
	const queue = new MarkdownRenderQueue({
		concurrency: 1,
		getGeneration: () => generation,
	});

	queue.enqueue("normal", generation, async () => {
		order.push("normal-1");
		await firstTask.promise;
	});
	queue.enqueue("normal", generation, async () => {
		order.push("normal-2");
	});
	queue.enqueue("high", generation, async () => {
		order.push("high");
	});

	assert.deepEqual(order, ["normal-1"]);
	firstTask.resolve();
	await waitFor(() => order.length === 3);

	assert.deepEqual(order, ["normal-1", "high", "normal-2"]);
});

test("clears queued markdown tasks without interrupting the active task", async () => {
	const activeTask = createDeferred();
	const order: string[] = [];
	const queue = new MarkdownRenderQueue({
		concurrency: 1,
		getGeneration: () => 1,
	});

	queue.enqueue("normal", 1, async () => {
		order.push("active");
		await activeTask.promise;
	});
	queue.enqueue("normal", 1, async () => {
		order.push("queued");
	});
	queue.clear();

	activeTask.resolve();
	await waitFor(() => order.length === 1);
	await delay();

	assert.deepEqual(order, ["active"]);
});

test("skips stale queued markdown tasks", async () => {
	let generation = 1;
	const activeTask = createDeferred();
	const order: string[] = [];
	const queue = new MarkdownRenderQueue({
		concurrency: 1,
		getGeneration: () => generation,
	});

	queue.enqueue("normal", 1, async () => {
		order.push("active");
		await activeTask.promise;
	});
	queue.enqueue("normal", 1, async () => {
		order.push("stale");
	});

	generation = 2;
	activeTask.resolve();
	await waitFor(() => order.length === 1);
	await delay();

	assert.deepEqual(order, ["active"]);
});

test("pauses queued markdown work until resumed", async () => {
	const order: string[] = [];
	const queue = new MarkdownRenderQueue({
		concurrency: 1,
		getGeneration: () => 1,
	});

	queue.setPaused(true);
	queue.enqueue("normal", 1, async () => {
		order.push("queued");
	});
	await delay();

	assert.deepEqual(order, []);
	queue.setPaused(false);
	await waitFor(() => order.length === 1);

	assert.deepEqual(order, ["queued"]);
});

test("移动端每帧最多启动一个 Markdown 任务，清理取消待执行帧", async () => {
	const frames = new Map<number, () => void>();
	let id = 0;
	const order: number[] = [];
	const queue = new MarkdownRenderQueue({
		concurrency: 4, getGeneration: () => 1,
		scheduleTask: callback => { frames.set(++id, callback); return id; },
		cancelTask: frame => { frames.delete(frame); },
	});
	for (let index = 0; index < 5; index++) queue.enqueue("normal", 1, async () => { order.push(index); });
	assert.deepEqual(order, []);
	const frame = [...frames.entries()][0]; frames.delete(frame[0]); frame[1]();
	await Promise.resolve(); await Promise.resolve();
	assert.deepEqual(order, [0]);
	assert.equal(frames.size, 1);
	queue.clear();
	assert.equal(frames.size, 0);
});

test("视口任务优先于离屏高优先级任务，并在视口改变后重新排序", async () => {
	const frames: Array<() => void> = [];
	const order: number[] = [];
	const targets = Array.from({ length: 300 }, () => ({} as HTMLElement));
	const queue = new MarkdownRenderQueue({
		concurrency: 1, getGeneration: () => 1,
		scheduleTask: callback => { frames.push(callback); return frames.length; },
	});
	for (let index = 0; index < targets.length; index++) {
		queue.enqueue(index < 12 ? "high" : "normal", 1, async () => { order.push(index); }, targets[index]);
	}
	queue.prioritizeTargets(target => target === targets[299] || target === targets[298]);
	frames.shift()!(); await Promise.resolve(); await Promise.resolve();
	assert.deepEqual(order, [298]);
	queue.prioritizeTargets(target => target === targets[200]);
	frames.shift()!(); await Promise.resolve(); await Promise.resolve();
	assert.deepEqual(order, [298, 200]);
	queue.prioritizeTargets(() => false);
	frames.shift()!(); await Promise.resolve(); await Promise.resolve();
	assert.deepEqual(order, [298, 200, 0]);
	queue.clear();
});

test("同目标的百次待执行请求只保留最新任务和一个执行帧", async () => {
	const frames: Array<() => void> = [];
	const order: number[] = [];
	const target = {} as HTMLElement;
	let executedFrames = 0;
	const queue = new MarkdownRenderQueue({ concurrency: 1, getGeneration: () => 1,
		scheduleTask: callback => { frames.push(callback); return frames.length; } });
	queue.setPaused(true);
	for (let index = 0; index < 100; index++) queue.enqueue("normal", 1, async () => { order.push(index); }, target);
	queue.setPaused(false);
	while (frames.length) {
		frames.shift()!(); executedFrames++;
		await Promise.resolve(); await Promise.resolve();
	}
	assert.deepEqual(order, [99]);
	assert.equal(executedFrames, 1);
});

test("更新待执行任务保留高优先级和视口优先状态，并允许普通任务升级", async () => {
	const order: string[] = [];
	const high = {} as HTMLElement, promoted = {} as HTMLElement, visible = {} as HTMLElement;
	const queue = new MarkdownRenderQueue({ concurrency: 1, getGeneration: () => 1 });
	queue.setPaused(true);
	queue.enqueue("high", 1, async () => { order.push("obsolete-high"); }, high);
	queue.enqueue("normal", 1, async () => { order.push("obsolete-normal"); }, promoted);
	queue.enqueue("normal", 1, async () => { order.push("obsolete-visible"); }, visible);
	queue.prioritizeTargets(target => target === visible);
	queue.enqueue("normal", 1, async () => { order.push("high-latest"); }, high);
	queue.enqueue("high", 1, async () => { order.push("promoted-latest"); }, promoted);
	queue.enqueue("normal", 1, async () => { order.push("visible-latest"); }, visible);
	queue.setPaused(false);
	await waitFor(() => order.length === 3);
	assert.deepEqual(order, ["visible-latest", "high-latest", "promoted-latest"]);
});

test("运行中同目标任务继续完成，只合并后续待执行请求", async () => {
	const active = createDeferred();
	const target = {} as HTMLElement;
	const order: string[] = [];
	const queue = new MarkdownRenderQueue({ concurrency: 1, getGeneration: () => 1 });
	queue.enqueue("normal", 1, async () => { order.push("active-start"); await active.promise; order.push("active-end"); }, target);
	queue.enqueue("normal", 1, async () => { order.push("obsolete"); }, target);
	queue.enqueue("normal", 1, async () => { order.push("latest"); }, target);
	assert.deepEqual(order, ["active-start"]);
	active.resolve();
	await waitFor(() => order.includes("latest"));
	assert.deepEqual(order, ["active-start", "active-end", "latest"]);
});

test("不同目标和没有目标的任务分别执行", async () => {
	const order: number[] = [];
	const queue = new MarkdownRenderQueue({ concurrency: 1, getGeneration: () => 1 });
	queue.setPaused(true);
	for (const [index, target] of [undefined, {} as HTMLElement, undefined, {} as HTMLElement].entries()) {
		queue.enqueue("normal", 1, async () => { order.push(index); }, target);
	}
	queue.setPaused(false);
	await waitFor(() => order.length === 4);
	assert.deepEqual(order, [0, 1, 2, 3]);
});

test("过期代次和 clear 不会误删同目标的新待执行请求", async () => {
	let generation = 1;
	const target = {} as HTMLElement;
	const order: string[] = [];
	const queue = new MarkdownRenderQueue({ concurrency: 1, getGeneration: () => generation });
	queue.setPaused(true);
	queue.enqueue("high", 1, async () => { order.push("old-generation"); }, target);
	generation = 2;
	queue.enqueue("normal", 2, async () => { order.push("new"); }, target);
	queue.enqueue("high", 1, async () => { order.push("rejected"); }, target);
	queue.enqueue("normal", 2, async () => { order.push("latest"); }, target);
	queue.setPaused(false);
	await waitFor(() => order.length > 0);
	assert.deepEqual(order, ["latest"]);
	queue.setPaused(true);
	queue.enqueue("normal", 2, async () => { order.push("cleared"); }, target);
	queue.clear();
	queue.enqueue("normal", 2, async () => { order.push("after-clear"); }, target);
	queue.setPaused(false);
	await waitFor(() => order.length === 2);
	assert.deepEqual(order, ["latest", "after-clear"]);
});

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve: () => void = () => {};
	const promise = new Promise<void>((innerResolve) => {
		resolve = innerResolve;
	});
	return { promise, resolve };
}

async function waitFor(condition: () => boolean): Promise<void> {
	for (let index = 0; index < 20; index += 1) {
		if (condition()) {
			return;
		}
		await delay();
	}
	assert.equal(condition(), true);
}

function delay(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

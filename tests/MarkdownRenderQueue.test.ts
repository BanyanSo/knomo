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

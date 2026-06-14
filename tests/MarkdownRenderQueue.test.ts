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

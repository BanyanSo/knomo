import assert from "node:assert/strict";
import { setImmediate as waitImmediate } from "node:timers/promises";
import test from "node:test";

import { LowPriorityWorkQueue } from "../src/services/LowPriorityWorkQueue";

test("Catalog、旧版升级和 Monthly 共用队列时不并发，并按优先级选择下一项", async () => {
	const queue = new LowPriorityWorkQueue(() => ({
		setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay) as unknown as number,
		clearTimeout: (timer) => globalThis.clearTimeout(timer as unknown as NodeJS.Timeout),
	}));
	const order: string[] = [];
	let activeCount = 0;
	let maxActiveCount = 0;
	let releaseCatalog = (): void => undefined;
	const catalogGate = new Promise<void>((resolve) => { releaseCatalog = resolve; });
	let markCatalogStarted = (): void => undefined;
	const catalogStarted = new Promise<void>((resolve) => { markCatalogStarted = resolve; });

	const catalog = queue.run(20, async () => {
		activeCount += 1;
		maxActiveCount = Math.max(maxActiveCount, activeCount);
		order.push("catalog:start");
		markCatalogStarted();
		await catalogGate;
		order.push("catalog:end");
		activeCount -= 1;
	});
	await catalogStarted;
	const legacy = queue.run(30, async () => {
		activeCount += 1;
		maxActiveCount = Math.max(maxActiveCount, activeCount);
		order.push("legacy");
		activeCount -= 1;
	});
	const monthly = queue.run(10, async () => {
		activeCount += 1;
		maxActiveCount = Math.max(maxActiveCount, activeCount);
		order.push("monthly");
		activeCount -= 1;
	});

	releaseCatalog();
	await Promise.all([catalog, legacy, monthly]);
	await waitImmediate();

	assert.equal(maxActiveCount, 1);
	assert.deepEqual(order, ["catalog:start", "catalog:end", "monthly", "legacy"]);
});

test("停止统一队列后取消尚未开始的后台任务", async () => {
	const queue = new LowPriorityWorkQueue(() => ({
		setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay) as unknown as number,
		clearTimeout: (timer) => globalThis.clearTimeout(timer as unknown as NodeJS.Timeout),
	}));
	const pending = queue.run(10, async () => undefined);
	queue.stop();

	await assert.rejects(pending, /stopped/u);
});

test("停止统一队列会向 active task 发出取消信号并废弃其结果", async () => {
	const queue = new LowPriorityWorkQueue(() => ({
		setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay) as unknown as number,
		clearTimeout: (timer) => globalThis.clearTimeout(timer as unknown as NodeJS.Timeout),
	}));
	let release = (): void => undefined;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	let markStarted = (): void => undefined;
	const started = new Promise<void>((resolve) => { markStarted = resolve; });
	const active = queue.run(10, async () => {
		markStarted();
		await gate;
		assert.equal(queue.signal.aborted, true);
		return "stale-result";
	});
	await started;

	queue.stop();
	release();

	await assert.rejects(active, /stopped/u);
});

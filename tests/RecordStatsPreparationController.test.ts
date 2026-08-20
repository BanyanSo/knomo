import test from "node:test";
import assert from "node:assert/strict";

import { RecordStatsPreparationController } from "../src/ui/RecordStatsPreparationController";

test("record stats preparation controller schedules one delayed preparation", () => {
	const scheduler = new FakeScheduler();
	const controller = createController(scheduler);
	let prepareCount = 0;

	controller.schedulePreparation({
		isPreparedForSource: () => false,
		prepare: () => {
			prepareCount += 1;
		},
	});
	controller.schedulePreparation({
		isPreparedForSource: () => false,
		prepare: () => {
			prepareCount += 1;
		},
	});

	assert.equal(scheduler.pendingTaskCount, 1);
	scheduler.flushNext();
	assert.equal(prepareCount, 1);
});

test("record stats preparation controller skips scheduling prepared sources", () => {
	const scheduler = new FakeScheduler();
	const controller = createController(scheduler);

	controller.schedulePreparation({
		isPreparedForSource: () => true,
		prepare: () => {
			throw new Error("Unexpected preparation");
		},
	});

	assert.equal(scheduler.pendingTaskCount, 0);
});

test("record stats preparation controller uses the prepared fast path", async () => {
	const scheduler = new FakeScheduler();
	const controller = createController(scheduler);
	let readyRenderCount = 0;

	const prepared = await controller.prepare({
		isPreparedForSource: () => true,
		runPreparation: () => {
			throw new Error("Unexpected preparation");
		},
		onPreparedForCurrentSource: () => {
			readyRenderCount += 1;
		},
	});

	assert.equal(prepared, true);
	assert.equal(readyRenderCount, 1);
});

test("record stats preparation controller shares in-flight requests", async () => {
	const scheduler = new FakeScheduler();
	const controller = createController(scheduler);
	const deferred = new Deferred<boolean>();
	const runSources: string[] = [];
	const options = createPrepareOptions({
		runPreparation: (source) => {
			runSources.push(source);
			return deferred.promise;
		},
	});

	const first = controller.prepare(options);
	const second = controller.prepare(options);

	assert.equal(first, second);
	assert.equal(controller.hasActiveRequest(), true);
	assert.deepEqual(runSources, ["catalog:0"]);
	deferred.resolve(true);
	assert.equal(await first, true);
	assert.equal(controller.hasActiveRequest(), false);
});

test("record stats preparation controller retries invalidated requests with the next source", async () => {
	const scheduler = new FakeScheduler();
	const controller = createController(scheduler);
	const first = new Deferred<boolean>();
	const second = new Deferred<boolean>();
	const runSources: string[] = [];
	const options = createPrepareOptions({
		runPreparation: (source) => {
			runSources.push(source);
			return runSources.length === 1 ? first.promise : second.promise;
		},
	});

	const preparing = controller.prepare(options);
	controller.invalidate();
	first.resolve(true);
	await preparing;

	assert.deepEqual(runSources, ["catalog:0", "catalog:1"]);
	assert.equal(controller.hasActiveRequest(), true);
	second.resolve(true);
	await flushPromises();
	assert.equal(controller.hasActiveRequest(), false);
});

test("record stats preparation controller can clear a pending retry request", async () => {
	const scheduler = new FakeScheduler();
	const controller = createController(scheduler);
	const deferred = new Deferred<boolean>();
	const runSources: string[] = [];

	const preparing = controller.prepare(createPrepareOptions({
		runPreparation: (source) => {
			runSources.push(source);
			return deferred.promise;
		},
	}));
	controller.invalidate();
	controller.clearRetryRequest();
	deferred.resolve(true);
	await preparing;

	assert.deepEqual(runSources, ["catalog:0"]);
	assert.equal(controller.hasActiveRequest(), false);
});

function createController(scheduler: FakeScheduler): RecordStatsPreparationController {
	return new RecordStatsPreparationController({
		scheduleTask: (callback, delayMs) => scheduler.schedule(callback, delayMs),
		cancelTask: (taskId) => scheduler.cancel(taskId),
	});
}

function createPrepareOptions(overrides: {
	isPreparedForSource?: (source: string) => boolean;
	runPreparation?: (source: string) => Promise<boolean>;
	onPreparedForCurrentSource?: () => void;
} = {}): Parameters<RecordStatsPreparationController["prepare"]>[0] {
	return {
		isPreparedForSource: overrides.isPreparedForSource ?? (() => false),
		runPreparation: overrides.runPreparation ?? (() => Promise.resolve(true)),
		onPreparedForCurrentSource: overrides.onPreparedForCurrentSource ?? (() => undefined),
	};
}

async function flushPromises(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

class Deferred<T> {
	promise: Promise<T>;
	private resolvePromise: ((value: T) => void) | null = null;

	constructor() {
		this.promise = new Promise<T>((resolve) => {
			this.resolvePromise = resolve;
		});
	}

	resolve(value: T): void {
		if (this.resolvePromise === null) {
			throw new Error("Deferred promise was not initialized");
		}
		this.resolvePromise(value);
	}
}

class FakeScheduler {
	private readonly tasks = new Map<number, () => void>();
	private nextTaskId = 1;

	get pendingTaskCount(): number {
		return this.tasks.size;
	}

	schedule(callback: () => void, delayMs: number): number {
		assert.equal(delayMs, 180);
		const taskId = this.nextTaskId;
		this.nextTaskId += 1;
		this.tasks.set(taskId, callback);
		return taskId;
	}

	cancel(taskId: number): void {
		this.tasks.delete(taskId);
	}

	flushNext(): void {
		const [taskId, callback] = this.tasks.entries().next().value as [number, () => void];
		this.tasks.delete(taskId);
		callback();
	}
}

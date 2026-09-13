import test from "node:test";
import assert from "node:assert/strict";

import {
	DateChangeWatcher,
	getNextDateChangeDelayMs,
} from "../src/ui/DateChangeWatcher";

test("夏令时日历日为 23 或 25 小时，恢复后按当前时区重新安排午夜", () => {
	const previous = process.env.TZ;
	try {
		process.env.TZ = "America/New_York";
		assert.equal(getNextDateChangeDelayMs(new Date(2026, 2, 8)), 23 * 3600000 + 1000);
		assert.equal(getNextDateChangeDelayMs(new Date(2026, 10, 1)), 25 * 3600000 + 1000);
		const delays: number[] = [];
		const now = new Date("2026-09-10T12:00:00Z");
		const watcher = new DateChangeWatcher({ getNow: () => now,
			scheduleTask: (_callback, delay) => { delays.push(delay); return delays.length; }, cancelTask: () => {},
		});
		watcher.start(() => {});
		process.env.TZ = "Asia/Shanghai";
		watcher.stop(); watcher.start(() => {});
		assert.notEqual(delays[0], delays[1]);
		assert.equal(delays[1], 4 * 3600000 + 1000);
	} finally {
		if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous;
	}
});

test("date change watcher calculates the delay to the next local day", () => {
	const now = new Date(2026, 0, 1, 12, 0, 0);

	assert.equal(getNextDateChangeDelayMs(now), 43_201_000);
});

test("date change watcher applies the minimum delay", () => {
	const now = new Date(2026, 0, 1, 0, 0, 0);
	const nextDay = new Date(2026, 0, 2, 0, 0, 1);
	const oversizedMinimum = nextDay.getTime() - now.getTime() + 1;

	assert.equal(getNextDateChangeDelayMs(now, oversizedMinimum), oversizedMinimum);
});

test("date change watcher starts only one pending timer", () => {
	const scheduler = new FakeScheduler();
	const watcher = createWatcher(scheduler);

	watcher.start(() => undefined);
	watcher.start(() => undefined);

	assert.equal(scheduler.pendingTaskCount, 1);
});

test("date change watcher stops the pending timer", () => {
	const scheduler = new FakeScheduler();
	const watcher = createWatcher(scheduler);
	let callbackCount = 0;

	watcher.start(() => {
		callbackCount += 1;
	});
	watcher.stop();

	assert.equal(scheduler.cancelledTaskCount, 1);
	assert.equal(scheduler.pendingTaskCount, 0);
	assert.equal(callbackCount, 0);
});

test("date change watcher releases the pending timer before running the callback", () => {
	const scheduler = new FakeScheduler();
	const watcher = createWatcher(scheduler);
	let callbackCount = 0;

	watcher.start(() => {
		callbackCount += 1;
		watcher.start(() => {
			callbackCount += 1;
		});
	});
	scheduler.flushNext();

	assert.equal(callbackCount, 1);
	assert.equal(scheduler.pendingTaskCount, 1);
});

function createWatcher(scheduler: FakeScheduler): DateChangeWatcher {
	return new DateChangeWatcher({
		getNow: () => new Date(2026, 0, 1, 12, 0, 0),
		scheduleTask: (callback, delayMs) => scheduler.schedule(callback, delayMs),
		cancelTask: (taskId) => scheduler.cancel(taskId),
	});
}

class FakeScheduler {
	private readonly tasks = new Map<number, () => void>();
	private nextTaskId = 1;
	cancelledTaskCount = 0;

	get pendingTaskCount(): number {
		return this.tasks.size;
	}

	schedule(callback: () => void, delayMs: number): number {
		assert.equal(delayMs, 43_201_000);
		const taskId = this.nextTaskId;
		this.nextTaskId += 1;
		this.tasks.set(taskId, callback);
		return taskId;
	}

	cancel(taskId: number): void {
		if (this.tasks.delete(taskId)) {
			this.cancelledTaskCount += 1;
		}
	}

	flushNext(): void {
		const [taskId, callback] = this.tasks.entries().next().value as [number, () => void];
		this.tasks.delete(taskId);
		callback();
	}
}

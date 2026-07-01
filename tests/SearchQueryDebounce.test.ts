import test from "node:test";
import assert from "node:assert/strict";

import { SearchQueryDebounce } from "../src/ui/SearchQueryDebounce";

test("search query debounce applies a queued query after the delay", () => {
	const scheduler = new FakeScheduler();
	const debounce = createDebounce(scheduler);
	const appliedQueries: string[] = [];

	debounce.queue("alpha", (query) => appliedQueries.push(query));
	scheduler.flushNext();

	assert.deepEqual(appliedQueries, ["alpha"]);
});

test("search query debounce replaces pending queries", () => {
	const scheduler = new FakeScheduler();
	const debounce = createDebounce(scheduler);
	const appliedQueries: string[] = [];

	debounce.queue("alpha", (query) => appliedQueries.push(query));
	debounce.queue("beta", (query) => appliedQueries.push(query));
	scheduler.flushNext();

	assert.deepEqual(appliedQueries, ["beta"]);
	assert.equal(scheduler.cancelledTaskCount, 1);
});

test("search query debounce clear cancels the pending query", () => {
	const scheduler = new FakeScheduler();
	const debounce = createDebounce(scheduler);
	const appliedQueries: string[] = [];

	debounce.queue("alpha", (query) => appliedQueries.push(query));
	debounce.clear();

	assert.deepEqual(appliedQueries, []);
	assert.equal(scheduler.cancelledTaskCount, 1);
	assert.equal(scheduler.pendingTaskCount, 0);
});

test("search query debounce allows clear from inside the callback", () => {
	const scheduler = new FakeScheduler();
	const debounce = createDebounce(scheduler);
	const appliedQueries: string[] = [];

	debounce.queue("alpha", (query) => {
		debounce.clear();
		appliedQueries.push(query);
	});
	scheduler.flushNext();

	assert.deepEqual(appliedQueries, ["alpha"]);
	assert.equal(scheduler.cancelledTaskCount, 0);
});

function createDebounce(scheduler: FakeScheduler): SearchQueryDebounce {
	return new SearchQueryDebounce({
		scheduleTask: (callback, delayMs) => scheduler.schedule(callback, delayMs),
		cancelTask: (taskId) => scheduler.cancel(taskId),
		delayMs: 220,
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
		assert.equal(delayMs, 220);
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

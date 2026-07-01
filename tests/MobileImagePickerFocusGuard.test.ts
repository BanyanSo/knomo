import test from "node:test";
import assert from "node:assert/strict";

import { MobileImagePickerFocusGuard } from "../src/ui/MobileImagePickerFocusGuard";

test("mobile image picker focus guard only starts when the view can guard focus", () => {
	const scheduler = new FakeScheduler();
	const guard = createGuard(scheduler);

	assert.equal(guard.begin(false), false);
	assert.equal(guard.shouldIgnoreBlur(true), false);

	assert.equal(guard.begin(true), true);
	assert.equal(guard.shouldIgnoreBlur(true), true);
	assert.equal(guard.shouldIgnoreBlur(false), false);
});

test("mobile image picker focus guard clears active state without restore", () => {
	const scheduler = new FakeScheduler();
	const guard = createGuard(scheduler);
	let restored = false;

	guard.begin(true);
	guard.finish(false, () => true, () => {
		restored = true;
	});

	assert.equal(guard.shouldIgnoreBlur(true), false);
	assert.equal(scheduler.size, 0);
	assert.equal(restored, false);
});

test("mobile image picker focus guard schedules and runs focus restore", () => {
	const scheduler = new FakeScheduler();
	const guard = createGuard(scheduler);
	let restored = false;

	guard.begin(true);
	guard.finish(true, () => true, () => {
		restored = true;
	});

	assert.equal(guard.shouldIgnoreBlur(true), false);
	assert.deepEqual(scheduler.delays, [50]);
	scheduler.flushNext();
	assert.equal(restored, true);
});

test("mobile image picker focus guard rechecks restore conditions before focusing", () => {
	const scheduler = new FakeScheduler();
	const guard = createGuard(scheduler);
	let canRestore = true;
	let restored = false;

	guard.begin(true);
	guard.finish(true, () => canRestore, () => {
		restored = true;
	});
	canRestore = false;
	scheduler.flushNext();

	assert.equal(restored, false);
});

test("mobile image picker focus guard cancels stale restore timers", () => {
	const scheduler = new FakeScheduler();
	const guard = createGuard(scheduler);

	guard.finish(true, () => true, () => undefined);
	guard.clear();

	assert.equal(scheduler.cancelledTaskCount, 1);
	assert.equal(scheduler.size, 0);
});

test("mobile image picker focus guard begin clears stale restore timers", () => {
	const scheduler = new FakeScheduler();
	const guard = createGuard(scheduler);

	guard.finish(true, () => true, () => undefined);
	guard.begin(true);

	assert.equal(scheduler.cancelledTaskCount, 1);
	assert.equal(scheduler.size, 0);
	assert.equal(guard.shouldIgnoreBlur(true), true);
});

function createGuard(scheduler: FakeScheduler): MobileImagePickerFocusGuard {
	return new MobileImagePickerFocusGuard({
		scheduleRestore: (callback, delayMs) => scheduler.schedule(callback, delayMs),
		cancelRestore: (taskId) => scheduler.cancel(taskId),
	});
}

class FakeScheduler {
	private readonly tasks = new Map<number, () => void>();
	private nextTaskId = 1;
	readonly delays: number[] = [];
	cancelledTaskCount = 0;

	get size(): number {
		return this.tasks.size;
	}

	schedule(callback: () => void, delayMs: number): number {
		this.delays.push(delayMs);
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
		const next = this.tasks.entries().next().value as [number, () => void] | undefined;
		if (next === undefined) {
			throw new Error("Expected a scheduled restore task");
		}
		const [taskId, callback] = next;
		this.tasks.delete(taskId);
		callback();
	}
}

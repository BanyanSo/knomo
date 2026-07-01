import test from "node:test";
import assert from "node:assert/strict";

import { MobileHandledToolPointer } from "../src/ui/MobileHandledToolPointer";

test("mobile handled tool pointer ignores the matching follow-up click once", () => {
	const scheduler = new FakeScheduler();
	const controller = createController(scheduler);
	const button = {} as HTMLElement;

	controller.mark(button, "insert-tag");

	assert.equal(controller.isHandled(button, "insert-tag"), true);
	assert.equal(controller.shouldIgnoreClick(button, "insert-tag", true), true);
	assert.equal(controller.shouldIgnoreClick(button, "insert-tag", true), false);
	assert.equal(scheduler.cancelledTaskCount, 1);
});

test("mobile handled tool pointer does not ignore desktop or different actions", () => {
	const scheduler = new FakeScheduler();
	const controller = createController(scheduler);
	const button = {} as HTMLElement;
	const otherButton = {} as HTMLElement;

	controller.mark(button, "insert-tag");

	assert.equal(controller.shouldIgnoreClick(button, "insert-tag", false), false);
	assert.equal(controller.shouldIgnoreClick(button, null, true), false);
	assert.equal(controller.shouldIgnoreClick(button, "insert-list", true), false);
	assert.equal(controller.shouldIgnoreClick(otherButton, "insert-tag", true), false);
	assert.equal(controller.isHandled(button, "insert-tag"), true);
});

test("mobile handled tool pointer clears the mark after the delay", () => {
	const scheduler = new FakeScheduler();
	const controller = createController(scheduler);
	const button = {} as HTMLElement;

	controller.mark(button, "insert-tag");
	scheduler.flushNext();

	assert.equal(controller.isHandled(button, "insert-tag"), false);
	assert.equal(controller.shouldIgnoreClick(button, "insert-tag", true), false);
});

test("mobile handled tool pointer replaces previous marks and cancels stale timers", () => {
	const scheduler = new FakeScheduler();
	const controller = createController(scheduler);
	const firstButton = {} as HTMLElement;
	const secondButton = {} as HTMLElement;

	controller.mark(firstButton, "insert-tag");
	controller.mark(secondButton, "insert-list");

	assert.equal(scheduler.cancelledTaskCount, 1);
	assert.equal(controller.isHandled(firstButton, "insert-tag"), false);
	assert.equal(controller.isHandled(secondButton, "insert-list"), true);
});

function createController(scheduler: FakeScheduler): MobileHandledToolPointer {
	return new MobileHandledToolPointer({
		scheduleClear: (callback, delayMs) => scheduler.schedule(callback, delayMs),
		cancelClear: (taskId) => scheduler.cancel(taskId),
	});
}

class FakeScheduler {
	private readonly tasks = new Map<number, () => void>();
	private nextTaskId = 1;
	cancelledTaskCount = 0;

	schedule(callback: () => void, delayMs: number): number {
		assert.equal(delayMs, 350);
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

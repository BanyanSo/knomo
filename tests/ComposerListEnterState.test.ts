import test from "node:test";
import assert from "node:assert/strict";

import { ComposerListEnterState } from "../src/ui/ComposerListEnterState";
import type { TextReplacement } from "../src/utils/composerInput";

test("composer list enter state consumes matching pending corrections once", () => {
	const scheduler = new FakeScheduler();
	const state = createState(scheduler);
	const patch = createPatch("next", 4);

	state.setPendingCorrection({ patch, nativeValue: "native" });

	assert.equal(state.consumePendingCorrection("native"), patch);
	assert.equal(state.consumePendingCorrection("native"), null);
});

test("composer list enter state drops pending corrections when the value changed", () => {
	const scheduler = new FakeScheduler();
	const state = createState(scheduler);

	state.setPendingCorrection({ patch: createPatch("next", 4), nativeValue: "native" });

	assert.equal(state.consumePendingCorrection("different"), null);
	assert.equal(state.consumePendingCorrection("native"), null);
});

test("composer list enter state clears keydown patches on the scheduled task", () => {
	const scheduler = new FakeScheduler();
	const state = createState(scheduler);
	const patch = createPatch("next", 4);

	state.markKeydownPatch(patch);

	assert.equal(state.getKeydownPatch(), patch);
	scheduler.flushNext();
	assert.equal(state.getKeydownPatch(), null);
});

test("composer list enter state replaces keydown patch timers", () => {
	const scheduler = new FakeScheduler();
	const state = createState(scheduler);
	const first = createPatch("first", 5);
	const second = createPatch("second", 6);

	state.markKeydownPatch(first);
	state.markKeydownPatch(second);

	assert.equal(state.getKeydownPatch(), second);
	assert.equal(scheduler.cancelledTaskCount, 1);
});

test("composer list enter state tracks skip input fallback until the scheduled task", () => {
	const scheduler = new FakeScheduler();
	const state = createState(scheduler);

	state.markSkipInputFallback();

	assert.equal(state.shouldSkipInputFallback(), true);
	scheduler.flushNext();
	assert.equal(state.shouldSkipInputFallback(), false);
});

test("composer list enter state clear resets pending and scheduled state", () => {
	const scheduler = new FakeScheduler();
	const state = createState(scheduler);
	const patch = createPatch("next", 4);

	state.setPendingCorrection({ patch, nativeValue: "native" });
	state.markKeydownPatch(patch);
	state.markSkipInputFallback();
	state.clear();

	assert.equal(state.consumePendingCorrection("native"), null);
	assert.equal(state.getKeydownPatch(), null);
	assert.equal(state.shouldSkipInputFallback(), false);
	assert.equal(scheduler.cancelledTaskCount, 2);
});

function createState(scheduler: FakeScheduler): ComposerListEnterState {
	return new ComposerListEnterState({
		scheduleTask: (callback, delayMs) => scheduler.schedule(callback, delayMs),
		cancelTask: (taskId) => scheduler.cancel(taskId),
	});
}

function createPatch(value: string, cursor: number): TextReplacement {
	return { value, cursor };
}

class FakeScheduler {
	private readonly tasks = new Map<number, () => void>();
	private nextTaskId = 1;
	cancelledTaskCount = 0;

	schedule(callback: () => void, delayMs: number): number {
		assert.equal(delayMs, 0);
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

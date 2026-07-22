import test from "node:test";
import assert from "node:assert/strict";

import { ViewRefreshScheduler } from "../src/services/ViewRefreshScheduler";

test("ViewRefreshScheduler coalesces queued refreshes into one run", async () => {
	const fakeWindow = new FakeSchedulerWindow();
	let refreshCount = 0;
	const scheduler = new ViewRefreshScheduler(
		() => fakeWindow,
		async () => {
			refreshCount += 1;
		},
		150,
	);

	const firstPromise = scheduler.queue();
	const secondPromise = scheduler.queue();

	assert.equal(firstPromise, secondPromise);
	assert.equal(fakeWindow.timerCount, 1);
	fakeWindow.flushNextTimer();
	await firstPromise;

	assert.equal(refreshCount, 1);
	assert.equal(fakeWindow.timerCount, 0);
});

test("ViewRefreshScheduler clears pending automatic refreshes without running them", async () => {
	const fakeWindow = new FakeSchedulerWindow();
	let refreshCount = 0;
	const scheduler = new ViewRefreshScheduler(
		() => fakeWindow,
		async () => {
			refreshCount += 1;
		},
		150,
	);

	const queuedPromise = scheduler.queue();
	scheduler.clear();
	await queuedPromise;

	assert.equal(refreshCount, 0);
	assert.equal(fakeWindow.timerCount, 0);
});

class FakeSchedulerWindow {
	private nextTimerId = 1;
	private readonly timers = new Map<number, () => void>();

	get timerCount(): number {
		return this.timers.size;
	}

	setTimeout(callback: () => void): number {
		const timerId = this.nextTimerId;
		this.nextTimerId += 1;
		this.timers.set(timerId, callback);
		return timerId;
	}

	clearTimeout(timerId: number): void {
		this.timers.delete(timerId);
	}

	flushNextTimer(): void {
		const timer = this.timers.entries().next().value as [number, () => void] | undefined;
		if (timer === undefined) {
			return;
		}
		this.timers.delete(timer[0]);
		timer[1]();
	}
}

import assert from "node:assert/strict";
import test from "node:test";
import { ensureObsidianStub } from "./helpers/obsidianStub";

async function fixture(idleSupported = true) {
	await ensureObsidianStub();
	const { KnomoView } = await import("../src/ui/KnomoView");
	const { Platform } = await import("obsidian");
	Object.assign(Platform, { isMobile: true });
	const frames = new Map<number, () => void>();
	const tasks = new Map<number, () => void>();
	let nextId = 0, requests = 0, pauses = 0, shown = true, focused = true;
	const win = {
		requestAnimationFrame: (callback: () => void) => { frames.set(++nextId, callback); return nextId; },
		cancelAnimationFrame: (id: number) => frames.delete(id),
		setTimeout: (callback: () => void) => { tasks.set(++nextId, callback); return nextId; },
		clearTimeout: (id: number) => tasks.delete(id),
		...(idleSupported ? {
			requestIdleCallback: (callback: () => void) => { tasks.set(++nextId, callback); return nextId; },
			cancelIdleCallback: (id: number) => tasks.delete(id),
		} : {}),
	};
	const snapshot = { status: "idle" };
	const view = Object.create(KnomoView.prototype) as {
		scheduleTagIndexWarmup(): void; clearTagIndexWarmup(): void; disposeTagIndexWarmup(): void;
		setTagIndexKeyboardBusy(busy: boolean): void; syncTagIndexInteraction(): void;
		tagIndexWarmupReady: boolean; composerIsComposing: boolean; trashViewClosed: boolean;
	};
	Object.assign(view, {
		inputEl: { contains: () => focused, ownerDocument: { activeElement: {} } },
		containerEl: { win, isShown: () => shown, doc: { visibilityState: "visible" } },
		tagIndexWarmupReady: false, tagIndexWarmupCancel: null, tagIndexInteractionResume: null,
		tagIndexKeyboardBusy: false, composerIsComposing: false, trashViewClosed: false,
		vaultTagIndex: {
			getSnapshot: () => snapshot,
			ensureReady: async () => { requests++; snapshot.status = "ready"; },
			pauseForInteraction: () => { pauses++; return () => { pauses--; }; },
		},
	});
	const flush = (queue: Map<number, () => void>) => {
		const pending = [...queue.values()]; queue.clear(); for (const callback of pending) callback();
	};
	return { view, frames, tasks, snapshot, requests: () => requests, pauses: () => pauses,
		setShown: (value: boolean) => { shown = value; }, setFocused: (value: boolean) => { focused = value; },
		frame: () => flush(frames), idle: () => flush(tasks) };
}

for (const idle of [true, false]) test(`mobile tag warmup waits for first paint and keyboard settling (idle API=${idle})`, async () => {
	const f = await fixture(idle);
	f.view.scheduleTagIndexWarmup();
	assert.equal(f.frames.size, 0, "首屏未完成不能预热");
	f.view.tagIndexWarmupReady = true;
	f.view.scheduleTagIndexWarmup(); f.view.scheduleTagIndexWarmup();
	assert.equal(f.frames.size, 1);
	f.frame();
	assert.equal(f.requests(), 0);
	const stale = [...f.tasks.values()][0];
	f.view.setTagIndexKeyboardBusy(true);
	assert.equal(f.tasks.size, 0, "打开键盘应撤销待执行预热");
	stale();
	f.view.scheduleTagIndexWarmup(); f.frame(); f.idle();
	assert.equal(f.requests(), 0);
	assert.equal(f.pauses(), 1);
	f.view.setTagIndexKeyboardBusy(false);
	f.frame(); f.idle();
	assert.equal(f.requests(), 1);
	assert.equal(f.pauses(), 0);
	f.view.scheduleTagIndexWarmup(); f.frame(); f.idle();
	assert.equal(f.requests(), 1, "已就绪不重复预热");
	f.view.disposeTagIndexWarmup();
});

test("tag warmup rechecks visibility and cancels pending work on disposal", async () => {
	const f = await fixture(); f.view.tagIndexWarmupReady = true;
	f.view.scheduleTagIndexWarmup(); f.frame(); f.setShown(false); f.idle();
	assert.equal(f.requests(), 0);
	f.setShown(true); f.view.scheduleTagIndexWarmup(); f.frame();
	const stale = [...f.tasks.values()][0];
	f.view.disposeTagIndexWarmup(); stale();
	assert.equal(f.requests(), 0);
	assert.equal(f.tasks.size, 0);
});

test("keyboard settling does not release composition's index pause; teardown releases it", async () => {
	const f = await fixture(); f.view.tagIndexWarmupReady = true;
	f.view.setTagIndexKeyboardBusy(true);
	f.view.composerIsComposing = true; f.view.syncTagIndexInteraction();
	f.view.setTagIndexKeyboardBusy(false);
	assert.equal(f.pauses(), 1);
	f.view.trashViewClosed = true; f.view.disposeTagIndexWarmup();
	assert.equal(f.pauses(), 0);
	f.frame(); f.idle();
	assert.equal(f.requests(), 0);
});

test("hidden or blurred Composer cannot leave the shared tag index paused", async () => {
	const f = await fixture(); f.view.tagIndexWarmupReady = true;
	f.view.composerIsComposing = true; f.view.syncTagIndexInteraction();
	assert.equal(f.pauses(), 1);
	f.setFocused(false); f.view.syncTagIndexInteraction();
	assert.equal(f.pauses(), 0);
	f.view.setTagIndexKeyboardBusy(true);
	assert.equal(f.pauses(), 1);
	f.setShown(false); f.view.syncTagIndexInteraction();
	assert.equal(f.pauses(), 0);
	f.view.disposeTagIndexWarmup();
});

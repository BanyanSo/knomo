import test from "node:test";
import assert from "node:assert/strict";
import { ensureObsidianStub } from "./helpers/obsidianStub";

test("mobile navbar compact controller starts, ignores pre-start sync requests, and cleans up timers", async () => {
	await ensureObsidianStub();
	const { MobileNavbarCompactController } = await import("../src/ui/MobileNavbarCompactController");
	const env = createControllerEnv();
	const controller = new MobileNavbarCompactController(env.view, {
		isActive: () => true,
		isComposerOpen: () => false,
		toggleSidebar: () => undefined,
		openComposer: () => undefined,
	});

	controller.requestSync();

	assert.deepEqual(env.frameIds, []);
	assert.deepEqual(env.timers.map((timer) => timer.delay), []);

	controller.start();

	assert.deepEqual(env.workspaceEvents, ["active-leaf-change", "layout-change"]);
	assert.deepEqual(env.domEvents, ["visibilitychange", "resize", "orientationchange"]);
	assert.deepEqual(env.frameIds, [1]);
	assert.deepEqual(env.timers.map((timer) => timer.delay).sort((a, b) => a - b), [120, 300, 320]);

	controller.stop();

	assert.deepEqual(env.cancelledFrames, [1]);
	assert.deepEqual(new Set(env.clearedTimers), new Set([1, 2, 3]));
	assert.equal(env.offRefs.length, 2);
	assert.deepEqual(env.bodyRemovedClasses.sort(), [
		"knomo-mobile-navbar-compact-active",
		"knomo-mobile-navbar-fixed",
		"knomo-mobile-navbar-floating",
	].sort());
});

function createControllerEnv() {
	let nextTimerId = 1;
	let nextFrameId = 1;
	const timers: Array<{ id: number; delay: number }> = [];
	const clearedTimers: number[] = [];
	const frameIds: number[] = [];
	const cancelledFrames: number[] = [];
	const workspaceEvents: string[] = [];
	const domEvents: string[] = [];
	const offRefs: unknown[] = [];
	const bodyRemovedClasses: string[] = [];
	const body = {
		removeClass: (cls: string) => {
			bodyRemovedClasses.push(cls);
		},
		findAll: () => [],
	};
	const win = {
		innerHeight: 800,
		innerWidth: 400,
		requestAnimationFrame: () => {
			const id = nextFrameId;
			nextFrameId += 1;
			frameIds.push(id);
			return id;
		},
		cancelAnimationFrame: (id: number) => {
			cancelledFrames.push(id);
		},
		setTimeout: (_handler: () => void, delay: number) => {
			const id = nextTimerId;
			nextTimerId += 1;
			timers.push({ id, delay });
			return id;
		},
		clearTimeout: (id: number) => {
			clearedTimers.push(id);
		},
	};
	const view = {
		app: {
			workspace: {
				on: (eventName: string) => {
					const ref = { eventName };
					workspaceEvents.push(eventName);
					return ref;
				},
				offref: (ref: unknown) => {
					offRefs.push(ref);
				},
			},
		},
		containerEl: {
			doc: { body },
			win,
		},
		registerDomEvent: (_target: unknown, eventName: string) => {
			domEvents.push(eventName);
		},
	};

	return {
		view: view as never,
		timers,
		clearedTimers,
		frameIds,
		cancelledFrames,
		workspaceEvents,
		domEvents,
		offRefs,
		bodyRemovedClasses,
	};
}

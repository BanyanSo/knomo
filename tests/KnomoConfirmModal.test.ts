import test from "node:test";
import assert from "node:assert/strict";

import { ensureObsidianStub } from "./helpers/obsidianStub";

test("destructive confirmation restores the trigger only when cancelled", async () => {
	const { getDestructiveConfirmReturnFocus } = await loadConfirmModalModule();
	const previousFocus = {} as HTMLElement;

	assert.equal(getDestructiveConfirmReturnFocus(false, previousFocus), previousFocus);
	assert.equal(getDestructiveConfirmReturnFocus(true, previousFocus), null);
});

test("confirm modal restores a connected focus target on the next frame", async () => {
	const { scheduleKnomoConfirmFocus } = await loadConfirmModalModule();
	const callbacks: FrameRequestCallback[] = [];
	const focusCalls: FocusOptions[] = [];
	const target = {
		isConnected: true,
		focus: (options?: FocusOptions) => {
			focusCalls.push(options ?? {});
		},
	} as HTMLElement;

	scheduleKnomoConfirmFocus(target, (callback) => {
		callbacks.push(callback);
		return 1;
	});

	assert.equal(focusCalls.length, 0);
	assert.equal(callbacks.length, 1);
	callbacks[0](0);
	assert.deepEqual(focusCalls, [{ preventScroll: true }]);
});

test("confirm modal does not focus a target removed before the next frame", async () => {
	const { scheduleKnomoConfirmFocus } = await loadConfirmModalModule();
	const callbacks: FrameRequestCallback[] = [];
	let focusCalls = 0;
	const target = {
		isConnected: true,
		focus: () => {
			focusCalls += 1;
		},
	} as HTMLElement;

	scheduleKnomoConfirmFocus(target, (callback) => {
		callbacks.push(callback);
		return 1;
	});
	Object.assign(target, { isConnected: false });
	callbacks[0](0);

	assert.equal(focusCalls, 0);
});

test("confirm modal retries focus without options for older webviews", async () => {
	const { scheduleKnomoConfirmFocus } = await loadConfirmModalModule();
	const focusCalls: Array<FocusOptions | undefined> = [];
	const target = {
		isConnected: true,
		focus: (options?: FocusOptions) => {
			focusCalls.push(options);
			if (options !== undefined) {
				throw new Error("focus options unsupported");
			}
		},
	} as HTMLElement;

	scheduleKnomoConfirmFocus(target, (callback) => {
		callback(0);
		return 1;
	});

	assert.deepEqual(focusCalls, [{ preventScroll: true }, undefined]);
});

async function loadConfirmModalModule(): Promise<typeof import("../src/ui/KnomoConfirmModal")> {
	await ensureObsidianStub();
	return import("../src/ui/KnomoConfirmModal");
}

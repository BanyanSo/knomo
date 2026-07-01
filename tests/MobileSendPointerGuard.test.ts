import test from "node:test";
import assert from "node:assert/strict";

import { MobileSendPointerGuard } from "../src/ui/MobileSendPointerGuard";

test("mobile send pointer guard allows clicks before any pointer", () => {
	const guard = new MobileSendPointerGuard({ getNow: () => 0 });

	assert.equal(guard.shouldIgnoreClick(true), false);
});

test("mobile send pointer guard ignores immediate mobile follow-up clicks", () => {
	let now = 10_000;
	const guard = new MobileSendPointerGuard({ getNow: () => now });

	guard.markPointer();

	assert.equal(guard.shouldIgnoreClick(true), true);
	assert.equal(guard.shouldIgnoreClick(false), false);
});

test("mobile send pointer guard releases clicks after the delay", () => {
	let now = 10_000;
	const guard = new MobileSendPointerGuard({ getNow: () => now });

	guard.markPointer();
	now += 699;
	assert.equal(guard.shouldIgnoreClick(true), true);

	now += 1;
	assert.equal(guard.shouldIgnoreClick(true), false);
});

test("mobile send pointer guard refreshes the ignore window on each pointer", () => {
	let now = 10_000;
	const guard = new MobileSendPointerGuard({ getNow: () => now });

	guard.markPointer();
	now += 500;
	guard.markPointer();
	now += 500;

	assert.equal(guard.shouldIgnoreClick(true), true);
});

test("mobile send pointer guard uses a configurable delay", () => {
	let now = 10_000;
	const guard = new MobileSendPointerGuard({
		getNow: () => now,
		ignoreClickDelayMs: 100,
	});

	guard.markPointer();
	now += 100;

	assert.equal(guard.shouldIgnoreClick(true), false);
});

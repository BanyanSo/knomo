import test from "node:test";
import assert from "node:assert/strict";

import { NativeImagePickerController } from "../src/ui/NativeImagePickerController";

test("native image picker restores focus and cleans up when cancelled", () => {
	const scheduler = new FakeScheduler();
	const input = new FakeInput(scheduler);
	const finishes: boolean[] = [];
	const calls: string[] = [];
	input.onClick = () => calls.push("click");
	const controller = new NativeImagePickerController({
		createInput: () => input.asNativeInput(),
		beginFocusGuard: () => true,
		finishFocusGuard: (shouldRestoreFocus) => {
			calls.push("finish");
			finishes.push(shouldRestoreFocus);
		},
		insertImageFiles: async () => undefined,
	});

	controller.open();
	calls.push("after-open");
	input.emit("cancel");

	assert.deepEqual(finishes, [true]);
	assert.deepEqual(calls, ["click", "after-open", "finish"]);
	assert.equal(input.clicked, true);
	assert.equal(input.detached, true);
	assert.equal(input.listenerCount, 0);
});

test("native image picker restores previous focus after selected files are inserted", async () => {
	const scheduler = new FakeScheduler();
	const input = new FakeInput(scheduler);
	const selectedFiles = { length: 1 } as FileList;
	input.files = selectedFiles;
	let finishInsertion: () => void = () => {
		throw new Error("Expected insertImageFiles to keep a pending promise");
	};
	const insertedFiles: FileList[] = [];
	const finishes: boolean[] = [];
	const controller = new NativeImagePickerController({
		createInput: () => input.asNativeInput(),
		beginFocusGuard: () => true,
		finishFocusGuard: (shouldRestoreFocus) => {
			finishes.push(shouldRestoreFocus);
		},
		insertImageFiles: (files) => {
			insertedFiles.push(files);
			return new Promise<void>((resolve) => {
				finishInsertion = resolve;
			});
		},
	});

	controller.open();
	input.emit("change");

	assert.deepEqual(insertedFiles, [selectedFiles]);
	assert.equal(input.detached, false);

	finishInsertion();
	await Promise.resolve();
	await Promise.resolve();

	assert.deepEqual(finishes, [true]);
	assert.equal(input.detached, true);
	assert.equal(input.listenerCount, 0);
});

test("native image picker does not force focus after selected files if focus was not guarded", async () => {
	const scheduler = new FakeScheduler();
	const input = new FakeInput(scheduler);
	const selectedFiles = { length: 1 } as FileList;
	input.files = selectedFiles;
	const finishes: boolean[] = [];
	const controller = new NativeImagePickerController({
		createInput: () => input.asNativeInput(),
		beginFocusGuard: () => false,
		finishFocusGuard: (shouldRestoreFocus) => {
			finishes.push(shouldRestoreFocus);
		},
		insertImageFiles: async () => undefined,
	});

	controller.open();
	input.emit("change");
	await Promise.resolve();
	await Promise.resolve();

	assert.deepEqual(finishes, [false]);
	assert.equal(input.detached, true);
	assert.equal(input.listenerCount, 0);
});

test("native image picker still inserts files when focus returns long before change", async () => {
	const scheduler = new FakeScheduler();
	const input = new FakeInput(scheduler);
	const selectedFiles = { length: 1 } as FileList;
	input.files = selectedFiles;
	const insertedFiles: FileList[] = [];
	const finishes: boolean[] = [];
	const controller = new NativeImagePickerController({
		createInput: () => input.asNativeInput(),
		beginFocusGuard: () => true,
		finishFocusGuard: (shouldRestoreFocus) => {
			finishes.push(shouldRestoreFocus);
		},
		insertImageFiles: async (files) => {
			insertedFiles.push(files);
		},
	});

	controller.open();
	input.win.emit("focus");
	assert.equal(scheduler.size, 0);
	assert.deepEqual(finishes, []);
	assert.equal(input.detached, false);

	input.emit("change");
	await Promise.resolve();
	await Promise.resolve();

	assert.equal(scheduler.size, 0);
	assert.deepEqual(insertedFiles, [selectedFiles]);
	assert.deepEqual(finishes, [true]);
	assert.equal(input.detached, true);
	assert.equal(input.listenerCount, 0);
});

test("native image picker ignores window focus without cancelling the picker", () => {
	const scheduler = new FakeScheduler();
	const input = new FakeInput(scheduler);
	const finishes: boolean[] = [];
	const controller = new NativeImagePickerController({
		createInput: () => input.asNativeInput(),
		beginFocusGuard: () => true,
		finishFocusGuard: (shouldRestoreFocus) => {
			finishes.push(shouldRestoreFocus);
		},
		insertImageFiles: async () => undefined,
	});

	controller.open();
	input.win.emit("focus");

	assert.equal(scheduler.size, 0);
	assert.deepEqual(finishes, []);
	assert.equal(input.detached, false);
	assert.equal(input.listenerCount, 2);
});

test("native image picker dispose removes the active input without finishing focus guard", () => {
	const scheduler = new FakeScheduler();
	const input = new FakeInput(scheduler);
	const finishes: boolean[] = [];
	const controller = new NativeImagePickerController({
		createInput: () => input.asNativeInput(),
		beginFocusGuard: () => true,
		finishFocusGuard: (shouldRestoreFocus) => {
			finishes.push(shouldRestoreFocus);
		},
		insertImageFiles: async () => undefined,
	});

	controller.open();
	controller.dispose();

	assert.deepEqual(finishes, []);
	assert.equal(input.detached, true);
	assert.equal(input.listenerCount, 0);
	assert.equal(scheduler.size, 0);
});

class FakeInput {
	private readonly listeners = new Map<string, Set<() => void>>();
	readonly win: FakeWindow;
	files: FileList | null = null;
	clicked = false;
	detached = false;
	onClick: (() => void) | null = null;

	constructor(scheduler: FakeScheduler) {
		this.win = new FakeWindow(scheduler);
	}

	get listenerCount(): number {
		return Array.from(this.listeners.values()).reduce((count, listeners) => count + listeners.size, 0)
			+ this.win.listenerCount;
	}

	asNativeInput(): HTMLInputElement {
		return this as unknown as HTMLInputElement;
	}

	addEventListener(type: string, listener: () => void): void {
		let listeners = this.listeners.get(type);
		if (listeners === undefined) {
			listeners = new Set();
			this.listeners.set(type, listeners);
		}
		listeners.add(listener);
	}

	removeEventListener(type: string, listener: () => void): void {
		this.listeners.get(type)?.delete(listener);
	}

	click(): void {
		this.clicked = true;
		this.onClick?.();
	}

	detach(): void {
		this.detached = true;
	}

	emit(type: string): void {
		for (const listener of [...(this.listeners.get(type) ?? [])]) {
			listener();
		}
	}
}

class FakeWindow {
	private readonly listeners = new Map<string, Set<() => void>>();

	constructor(private readonly scheduler: FakeScheduler) {
	}

	get listenerCount(): number {
		return Array.from(this.listeners.values()).reduce((count, listeners) => count + listeners.size, 0);
	}

	addEventListener(type: string, listener: () => void): void {
		let listeners = this.listeners.get(type);
		if (listeners === undefined) {
			listeners = new Set();
			this.listeners.set(type, listeners);
		}
		listeners.add(listener);
	}

	removeEventListener(type: string, listener: () => void): void {
		this.listeners.get(type)?.delete(listener);
	}

	setTimeout(callback: () => void, delayMs: number): number {
		return this.scheduler.schedule(callback, delayMs);
	}

	clearTimeout(taskId: number): void {
		this.scheduler.cancel(taskId);
	}

	emit(type: string): void {
		for (const listener of [...(this.listeners.get(type) ?? [])]) {
			listener();
		}
	}
}

class FakeScheduler {
	private readonly tasks = new Map<number, () => void>();
	private nextTaskId = 1;

	get size(): number {
		return this.tasks.size;
	}

	schedule(callback: () => void, _delayMs: number): number {
		const taskId = this.nextTaskId;
		this.nextTaskId += 1;
		this.tasks.set(taskId, callback);
		return taskId;
	}

	cancel(taskId: number): void {
		this.tasks.delete(taskId);
	}

	flushNext(): void {
		const next = this.tasks.entries().next().value as [number, () => void] | undefined;
		if (next === undefined) {
			throw new Error("Expected a scheduled task");
		}
		const [taskId, callback] = next;
		this.tasks.delete(taskId);
		callback();
	}
}

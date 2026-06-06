import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as waitImmediate } from "node:timers/promises";

import type { MemoRecord } from "../src/types/memo";
import { toggleMarkdownTaskMarkerByIndex } from "../src/utils/markdownTasks";
import { MemoTaskUpdateCoordinator } from "../src/ui/MemoTaskUpdateCoordinator";

test("serializes task updates for the same memo and saves the latest content", async () => {
	const memo = makeMemo("- [ ] first\n- [ ] second");
	const saves: string[] = [];
	const savedMemos: MemoRecord[] = [];
	const deferredSaves: Array<Deferred<MemoRecord>> = [];
	let activeSaves = 0;
	let maxActiveSaves = 0;
	const coordinator = new MemoTaskUpdateCoordinator({
		updateMemo: async (currentMemo, content) => {
			activeSaves += 1;
			maxActiveSaves = Math.max(maxActiveSaves, activeSaves);
			saves.push(content);
			const deferred = createDeferred<MemoRecord>();
			deferredSaves.push(deferred);
			const savedMemo = await deferred.promise;
			activeSaves -= 1;
			return {
				...currentMemo,
				contentSnapshot: savedMemo.contentSnapshot,
				syncStatus: "synced",
				issue: null,
			};
		},
		onSaved: (savedMemo) => {
			savedMemos.push(savedMemo);
		},
		onIssue: () => {
			throw new Error("Unexpected sync issue");
		},
		onFailed: () => {
			throw new Error("Unexpected failure");
		},
	});

	const first = toggleMarkdownTaskMarkerByIndex(coordinator.getLatestContent(memo), 0);
	assert.notEqual(first, null);
	if (first === null) {
		throw new Error("Expected first task toggle");
	}
	coordinator.enqueue(memo, first.content);
	const second = toggleMarkdownTaskMarkerByIndex(coordinator.getLatestContent(memo), 1);
	assert.notEqual(second, null);
	if (second === null) {
		throw new Error("Expected second task toggle");
	}
	coordinator.enqueue(memo, second.content);
	await waitImmediate();

	assert.deepEqual(saves, ["- [x] first\n- [ ] second"]);
	assert.equal(maxActiveSaves, 1);

	deferredSaves[0]?.resolve(makeMemo(saves[0]));
	await waitImmediate();
	await waitImmediate();

	assert.deepEqual(saves, [
		"- [x] first\n- [ ] second",
		"- [x] first\n- [x] second",
	]);
	assert.equal(maxActiveSaves, 1);

	deferredSaves[1]?.resolve(makeMemo(saves[1]));
	await waitImmediate();

	assert.deepEqual(savedMemos.map((savedMemo) => savedMemo.contentSnapshot), ["- [x] first\n- [x] second"]);
});

test("collapses rapid repeated clicks into the final task state", async () => {
	const memo = makeMemo("- [ ] task");
	const saves: string[] = [];
	const savedMemos: MemoRecord[] = [];
	const deferredSaves: Array<Deferred<MemoRecord>> = [];
	const coordinator = new MemoTaskUpdateCoordinator({
		updateMemo: async (currentMemo, content) => {
			saves.push(content);
			const deferred = createDeferred<MemoRecord>();
			deferredSaves.push(deferred);
			const savedMemo = await deferred.promise;
			return { ...currentMemo, contentSnapshot: savedMemo.contentSnapshot };
		},
		onSaved: (savedMemo) => {
			savedMemos.push(savedMemo);
		},
		onIssue: () => {
			throw new Error("Unexpected sync issue");
		},
		onFailed: () => {
			throw new Error("Unexpected failure");
		},
	});

	const first = toggleMarkdownTaskMarkerByIndex(coordinator.getLatestContent(memo), 0);
	assert.notEqual(first, null);
	if (first === null) {
		throw new Error("Expected first task toggle");
	}
	coordinator.enqueue(memo, first.content);
	const second = toggleMarkdownTaskMarkerByIndex(coordinator.getLatestContent(memo), 0);
	assert.notEqual(second, null);
	if (second === null) {
		throw new Error("Expected second task toggle");
	}
	coordinator.enqueue(memo, second.content);
	await waitImmediate();

	assert.deepEqual(saves, ["- [x] task"]);

	deferredSaves[0]?.resolve(makeMemo("- [x] task"));
	await waitImmediate();
	await waitImmediate();

	assert.deepEqual(saves, ["- [x] task", "- [ ] task"]);
	deferredSaves[1]?.resolve(makeMemo("- [ ] task"));
	await waitImmediate();

	assert.deepEqual(savedMemos.map((savedMemo) => savedMemo.contentSnapshot), ["- [ ] task"]);
});

test("restores the last confirmed memo when a task update fails", async () => {
	const memo = makeMemo("- [ ] task");
	const failedMemos: MemoRecord[] = [];
	const coordinator = new MemoTaskUpdateCoordinator({
		updateMemo: async () => {
			throw new Error("save failed");
		},
		onSaved: () => {
			throw new Error("Unexpected save");
		},
		onIssue: () => {
			throw new Error("Unexpected sync issue");
		},
		onFailed: (failedMemo) => {
			failedMemos.push(failedMemo);
		},
	});

	coordinator.enqueue(memo, "- [x] task");
	await waitImmediate();
	await waitImmediate();

	assert.deepEqual(failedMemos.map((failedMemo) => failedMemo.contentSnapshot), ["- [ ] task"]);
});

test("stops the queue when updateMemo returns a sync issue", async () => {
	const memo = makeMemo("- [ ] task");
	const issueMemos: MemoRecord[] = [];
	const saves: string[] = [];
	const coordinator = new MemoTaskUpdateCoordinator({
		updateMemo: async (currentMemo, content) => {
			saves.push(content);
			return {
				...currentMemo,
				contentSnapshot: content,
				syncStatus: "monthly_failed",
				issue: {
					type: "monthly_sync_failed",
					detectedAt: "2026-06-02T00:00:00.000+08:00",
					message: "Monthly failed",
				},
			};
		},
		onSaved: () => {
			throw new Error("Unexpected save");
		},
		onIssue: (issueMemo) => {
			issueMemos.push(issueMemo);
		},
		onFailed: () => {
			throw new Error("Unexpected failure");
		},
	});

	coordinator.enqueue(memo, "- [x] task");
	coordinator.enqueue(memo, "- [ ] task");
	await waitImmediate();
	await waitImmediate();

	assert.deepEqual(saves, ["- [x] task"]);
	assert.deepEqual(issueMemos.map((issueMemo) => issueMemo.contentSnapshot), ["- [x] task"]);
});

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (error: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((promiseResolve, promiseReject) => {
		resolve = promiseResolve;
		reject = promiseReject;
	});
	return { promise, resolve, reject };
}

function makeMemo(contentSnapshot: string): MemoRecord {
	return {
		id: "memo-1",
		createdAt: "2026-06-02T00:00:00+08:00",
		updatedAt: "2026-06-02T00:00:00+08:00",
		contentSnapshot,
		contentHash: "hash",
		status: "active",
		syncStatus: "synced",
		source: "plugin_input",
		version: 1,
		tags: [],
		links: [],
		images: [],
		references: [],
		sourceMemoId: null,
		issue: null,
		lastMarkdownSyncAt: null,
		lastMarkdownSyncSource: null,
		dailyRef: {
			path: "Daily/2026-06-02.md",
			heading: null,
			lastKnownBlock: "",
			lastKnownHash: "",
			lineNumberHint: null,
			lastSyncedAt: null,
		},
		monthlyRef: {
			path: "Knomo/2026-06.md",
			dateHeading: "2026-06-02",
			lastKnownBlock: "",
			lastKnownHash: "",
			lineNumberHint: null,
			lastSyncedAt: null,
		},
	};
}

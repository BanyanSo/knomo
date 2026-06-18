import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { MemoRecord } from "../src/types/memo";
import type { TrashMemoRenderTarget } from "../src/ui/TrashMemoController";

test("tracks deleted memo ids once and refreshes the trash snapshot", async () => {
	const { TrashMemoController } = await loadController();
	const deletedMemos = [makeMemo("memo-1"), makeMemo("memo-2")];
	const renderTargets: TrashMemoRenderTarget[] = [];
	const controller = new TrashMemoController({
		listDeletedMemos: async () => deletedMemos,
		restoreMemo: async () => deletedMemos[0],
		purgeDeletedMemo: async () => {},
		isTrashActive: () => false,
		confirmPurge: () => true,
		showNotice: () => {},
		forceRefreshViews: async () => {},
		requestRender: (target) => renderTargets.push(target),
	});

	controller.recordDeletedMemo("memo-1");
	controller.recordDeletedMemo("memo-1");
	assert.equal(controller.getSnapshot().trashCount, 1);

	await controller.refreshTrashCount(false);

	const snapshot = controller.getSnapshot();
	assert.equal(snapshot.trashCount, 2);
	assert.deepEqual(Array.from(snapshot.deletedMemoIds), ["memo-1", "memo-2"]);
	assert.equal(snapshot.trashMemos, null);
	assert.deepEqual(renderTargets, ["trash-count-and-scope"]);
});

test("loads trash once while busy and preserves loading render transitions", async () => {
	const { TrashMemoController } = await loadController();
	const renderTargets: TrashMemoRenderTarget[] = [];
	let listCalls = 0;
	let resolveList!: (memos: MemoRecord[]) => void;
	const listPromise = new Promise<MemoRecord[]>((resolve) => {
		resolveList = resolve;
	});
	const controller = new TrashMemoController({
		listDeletedMemos: () => {
			listCalls += 1;
			return listPromise;
		},
		restoreMemo: async () => makeMemo("memo-1"),
		purgeDeletedMemo: async () => {},
		isTrashActive: () => true,
		confirmPurge: () => true,
		showNotice: () => {},
		forceRefreshViews: async () => {},
		requestRender: (target) => renderTargets.push(target),
	});

	const firstLoad = controller.loadTrashMemos();
	const secondLoad = controller.loadTrashMemos();
	assert.equal(controller.getSnapshot().trashLoading, true);
	assert.deepEqual(renderTargets, ["ui-state"]);
	assert.equal(listCalls, 1);

	resolveList([makeMemo("memo-1")]);
	await Promise.all([firstLoad, secondLoad]);

	const snapshot = controller.getSnapshot();
	assert.equal(snapshot.trashLoading, false);
	assert.deepEqual(snapshot.trashMemos?.map((memo) => memo.id), ["memo-1"]);
	assert.equal(snapshot.trashCount, 1);
	assert.deepEqual(renderTargets, ["ui-state", "ui-state"]);
});

test("restore keeps one busy action and force refreshes every view", async () => {
	const { TrashMemoController } = await loadController();
	const memo = makeMemo("memo-1");
	const renderTargets: TrashMemoRenderTarget[] = [];
	const notices: string[] = [];
	let restoreCalls = 0;
	let forceRefreshCalls = 0;
	let resolveRestore!: () => void;
	const restorePromise = new Promise<void>((resolve) => {
		resolveRestore = resolve;
	});
	const controller = new TrashMemoController({
		listDeletedMemos: async () => [memo, makeMemo("memo-2")],
		restoreMemo: async () => {
			restoreCalls += 1;
			await restorePromise;
			return memo;
		},
		purgeDeletedMemo: async () => {},
		isTrashActive: () => false,
		confirmPurge: () => true,
		showNotice: (message) => notices.push(message),
		forceRefreshViews: async () => {
			forceRefreshCalls += 1;
		},
		requestRender: (target) => renderTargets.push(target),
	});
	await controller.loadTrashMemos();
	renderTargets.length = 0;

	const firstAction = controller.handleTrashAction("restore", memo);
	const secondAction = controller.handleTrashAction("restore", memo);
	assert.equal(controller.getSnapshot().trashBusyMemoActions.get(memo.id), "restore");
	assert.equal(restoreCalls, 1);
	assert.deepEqual(renderTargets, ["card-flow"]);

	resolveRestore();
	await Promise.all([firstAction, secondAction]);

	const snapshot = controller.getSnapshot();
	assert.equal(snapshot.trashBusyMemoActions.has(memo.id), false);
	assert.deepEqual(snapshot.trashMemos?.map((item) => item.id), ["memo-2"]);
	assert.equal(snapshot.trashCount, 1);
	assert.equal(forceRefreshCalls, 1);
	assert.deepEqual(notices, ["Restored"]);
	assert.deepEqual(renderTargets, ["card-flow", "card-flow"]);
});

test("purge requires confirmation and preserves force refresh behavior", async () => {
	const { TrashMemoController } = await loadController();
	const memo = makeMemo("memo-1");
	const renderTargets: TrashMemoRenderTarget[] = [];
	let confirmed = false;
	let purgeCalls = 0;
	let forceRefreshCalls = 0;
	const controller = new TrashMemoController({
		listDeletedMemos: async () => [memo],
		restoreMemo: async () => memo,
		purgeDeletedMemo: async () => {
			purgeCalls += 1;
		},
		isTrashActive: () => false,
		confirmPurge: () => confirmed,
		showNotice: () => {},
		forceRefreshViews: async () => {
			forceRefreshCalls += 1;
		},
		requestRender: (target) => renderTargets.push(target),
	});
	await controller.loadTrashMemos();
	renderTargets.length = 0;

	await controller.handleTrashAction("purge", memo);
	assert.equal(purgeCalls, 0);
	assert.equal(controller.getSnapshot().trashCount, 1);
	assert.deepEqual(renderTargets, []);

	confirmed = true;
	await controller.handleTrashAction("purge", memo);
	assert.equal(purgeCalls, 1);
	assert.equal(forceRefreshCalls, 1);
	assert.equal(controller.getSnapshot().trashCount, 0);
	assert.deepEqual(controller.getSnapshot().trashMemos, []);
	assert.deepEqual(renderTargets, ["card-flow", "card-flow"]);
});

test("formats trash action errors without duplicating the action label", async () => {
	const { formatTrashActionErrorMessage } = await loadController();

	assert.equal(formatTrashActionErrorMessage("restore", null), "Restore failed. Please try again later");
	assert.equal(formatTrashActionErrorMessage("restore", new Error("disk unavailable")), "Restore failed: disk unavailable");
	assert.equal(formatTrashActionErrorMessage("restore", new Error("Restore failed: conflict")), "Restore failed: conflict");
});

async function loadController(): Promise<typeof import("../src/ui/TrashMemoController")> {
	await ensureObsidianStub();
	return import("../src/ui/TrashMemoController");
}

async function ensureObsidianStub(): Promise<void> {
	const stubPath = resolve(__dirname, "../node_modules/obsidian/index.js");
	await mkdir(dirname(stubPath), { recursive: true });
	await writeFile(
		stubPath,
		[
			"let languageValue = 'en';",
			"function getLanguage() { return languageValue; }",
			"getLanguage.set = (value) => { languageValue = value; };",
			"module.exports = { getLanguage };",
		].join("\n"),
	);
}

function makeMemo(id: string): MemoRecord {
	return {
		id,
		createdAt: "2026-06-02T00:00:00+08:00",
		updatedAt: "2026-06-02T00:00:00+08:00",
		contentSnapshot: id,
		contentHash: `hash-${id}`,
		status: "deleted",
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
			heading: "Memos",
			sectionType: "heading",
			lastKnownBlock: id,
			lastKnownHash: `hash-${id}`,
			lineNumberHint: 1,
			lastSyncedAt: null,
		},
		monthlyRef: {
			path: "Memos/Memos-2026-06.md",
			dateHeading: "2026-06-02",
			lastKnownBlock: id,
			lastKnownHash: `hash-${id}`,
			lineNumberHint: 1,
			lastSyncedAt: null,
		},
	};
}

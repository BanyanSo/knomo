import test from "node:test";
import assert from "node:assert/strict";

import type { MemoRecord } from "./helpers/memoViewFixture";
import type { TrashMemoRenderTarget } from "../src/ui/TrashMemoController";
import { ensureObsidianStub } from "./helpers/obsidianStub";

test("tracks deleted memo ids once and refreshes the trash snapshot", async () => {
	const { TrashMemoController } = await loadController();
	const deletedMemos = [makeMemo("memo-1"), makeMemo("memo-2")];
	const renderTargets: TrashMemoRenderTarget[] = [];
	const controller = new TrashMemoController({
		getDeletedMemoSummary: async () => ({ count: deletedMemos.length, ids: deletedMemos.map((memo) => memo.id) }),
		listDeletedMemos: async () => deletedMemos,
		restoreMemo: async () => deletedMemos[0],
		handleRestoredMemo: () => {},
		purgeDeletedMemo: async () => {},
		isTrashActive: () => false,
		confirmPurge: async () => true,
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
		getDeletedMemoSummary: async () => ({ count: 0, ids: [] }),
		listDeletedMemos: () => {
			listCalls += 1;
			return listPromise;
		},
		restoreMemo: async () => makeMemo("memo-1"),
		handleRestoredMemo: () => {},
		purgeDeletedMemo: async () => {},
		isTrashActive: () => true,
		confirmPurge: async () => true,
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
	let restoredMemo: MemoRecord | null = null;
	const handledRestoredMemos: Array<{ deletedMemo: MemoRecord; restoredMemo: MemoRecord }> = [];
	let forceRefreshCalls = 0;
	let resolveRestore!: () => void;
	const restorePromise = new Promise<void>((resolve) => {
		resolveRestore = resolve;
	});
	const controller = new TrashMemoController({
		getDeletedMemoSummary: async () => ({ count: 2, ids: [memo.id, "memo-2"] }),
		listDeletedMemos: async () => [memo, makeMemo("memo-2")],
		restoreMemo: async (memoToRestore) => {
			restoreCalls += 1;
			restoredMemo = memoToRestore;
			await restorePromise;
			return { ...memo, status: "active" };
		},
		handleRestoredMemo: (deletedMemo, memoAfterRestore) => {
			handledRestoredMemos.push({ deletedMemo, restoredMemo: memoAfterRestore });
		},
		purgeDeletedMemo: async () => {},
		isTrashActive: () => false,
		confirmPurge: async () => true,
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
	assert.equal(restoredMemo, memo);
	assert.deepEqual(renderTargets, ["card-flow"]);

	resolveRestore();
	await Promise.all([firstAction, secondAction]);

	const snapshot = controller.getSnapshot();
	assert.equal(snapshot.trashBusyMemoActions.has(memo.id), false);
	assert.deepEqual(snapshot.trashMemos?.map((item) => item.id), ["memo-2"]);
	assert.equal(snapshot.trashCount, 1);
	assert.equal(handledRestoredMemos.length, 1);
	assert.equal(handledRestoredMemos[0].deletedMemo, memo);
	assert.equal(handledRestoredMemos[0].restoredMemo.status, "active");
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
	let purgedMemo: MemoRecord | null = null;
	let forceRefreshCalls = 0;
	const controller = new TrashMemoController({
		getDeletedMemoSummary: async () => ({ count: 1, ids: [memo.id] }),
		listDeletedMemos: async () => [memo],
		restoreMemo: async () => memo,
		handleRestoredMemo: () => {},
		purgeDeletedMemo: async (memoToPurge) => {
			purgeCalls += 1;
			purgedMemo = memoToPurge;
		},
		isTrashActive: () => false,
		confirmPurge: async () => confirmed,
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
	assert.equal(purgedMemo, memo);
	assert.equal(forceRefreshCalls, 1);
	assert.equal(controller.getSnapshot().trashCount, 0);
	assert.deepEqual(controller.getSnapshot().trashMemos, []);
	assert.deepEqual(renderTargets, ["card-flow", "card-flow"]);
});

test("purge waits for asynchronous confirmation and suppresses duplicate prompts", async () => {
	const { TrashMemoController } = await loadController();
	const memo = makeMemo("memo-1");
	let confirmCalls = 0;
	let purgeCalls = 0;
	let resolveConfirmation!: (confirmed: boolean) => void;
	const confirmation = new Promise<boolean>((resolve) => {
		resolveConfirmation = resolve;
	});
	const controller = new TrashMemoController({
		getDeletedMemoSummary: async () => ({ count: 1, ids: [memo.id] }),
		listDeletedMemos: async () => [memo],
		restoreMemo: async () => memo,
		handleRestoredMemo: () => {},
		purgeDeletedMemo: async () => {
			purgeCalls += 1;
		},
		isTrashActive: () => false,
		confirmPurge: () => {
			confirmCalls += 1;
			return confirmation;
		},
		showNotice: () => {},
		forceRefreshViews: async () => {},
		requestRender: () => {},
	});

	const firstAction = controller.handleTrashAction("purge", memo);
	const duplicateAction = controller.handleTrashAction("purge", memo);
	await Promise.resolve();

	assert.equal(confirmCalls, 1);
	assert.equal(purgeCalls, 0);
	resolveConfirmation(true);
	await Promise.all([firstAction, duplicateAction]);
	assert.equal(purgeCalls, 1);
});

test("restore 已成功后视图刷新失败不会再显示恢复失败", async () => {
	const { TrashMemoController } = await loadController();
	const memo = makeMemo("memo-1");
	const notices: string[] = [];
	const controller = new TrashMemoController({
		getDeletedMemoSummary: async () => ({ count: 1, ids: [memo.id] }),
		listDeletedMemos: async () => [memo],
		restoreMemo: async () => ({ ...memo, status: "active" }),
		handleRestoredMemo: () => {},
		purgeDeletedMemo: async () => {},
		isTrashActive: () => false,
		confirmPurge: async () => true,
		showNotice: (message) => notices.push(message),
		forceRefreshViews: async () => { throw new Error("local refresh failed"); },
		requestRender: () => {},
	});
	await controller.loadTrashMemos();

	await controller.handleTrashAction("restore", memo);

	assert.equal(notices.includes("Restored"), true);
	assert.equal(notices.some((message) => message.startsWith("Restore failed")), false);
	assert.equal(controller.getSnapshot().trashCount, 0);
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

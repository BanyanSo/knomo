import test from "node:test";
import assert from "node:assert/strict";

import type { MemoViewItem } from "../src/types/memoView";
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
		purgeMemo: async () => {},
		confirmPurge: async () => true,
		handleRestoredMemo: () => {},
		isTrashActive: () => false,
		showNotice: () => {},
		forceRefreshViews: async () => {},
		requestRender: (target) => renderTargets.push(target),
	});


	await controller.refreshTrashCount(false);

	const snapshot = controller.getSnapshot();
	assert.equal(snapshot.trashCount, 2);
	assert.equal(snapshot.trashMemos, null);
	assert.deepEqual(renderTargets, ["trash-count", "trash-count-and-scope"]);
});

test("concurrent trash count refreshes share one summary request", async () => {
	const { TrashMemoController } = await loadController();
	const summary = createDeferred<{ count: number; ids: string[] }>();
	let summaryCalls = 0;
	const controller = new TrashMemoController({
		getDeletedMemoSummary: () => {
			summaryCalls += 1;
			return summary.promise;
		},
		listDeletedMemos: async () => [],
		restoreMemo: async () => null,
		purgeMemo: async () => {},
		confirmPurge: async () => true,
		handleRestoredMemo: () => {},
		isTrashActive: () => false,
		showNotice: () => {},
		forceRefreshViews: async () => {},
		requestRender: () => {},
	});

	const first = controller.refreshTrashCount(false);
	const second = controller.refreshTrashCount(false);
	assert.equal(summaryCalls, 1);
	summary.resolve({ count: 0, ids: [] });
	await Promise.all([first, second]);
});

test("loads trash once while busy and preserves loading render transitions", async () => {
	const { TrashMemoController } = await loadController();
	const renderTargets: TrashMemoRenderTarget[] = [];
	let listCalls = 0;
	let resolveList!: (memos: MemoViewItem[]) => void;
	const listPromise = new Promise<MemoViewItem[]>((resolve) => {
		resolveList = resolve;
	});
	const controller = new TrashMemoController({
		getDeletedMemoSummary: async () => ({ count: 0, ids: [] }),
		listDeletedMemos: () => {
			listCalls += 1;
			return listPromise;
		},
		restoreMemo: async () => makeMemo("memo-1"),
		purgeMemo: async () => {},
		confirmPurge: async () => true,
		handleRestoredMemo: () => {},
		isTrashActive: () => true,
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

test("refresh keeps committed trash memos visible until the new list commits", async () => {
	const { TrashMemoController } = await loadController();
	const oldMemo = makeMemo("old");
	const nextList = createDeferred<MemoViewItem[]>();
	let firstLoad = true;
	const controller = new TrashMemoController({
		getDeletedMemoSummary: async () => ({ count: 1, ids: [oldMemo.id] }),
		listDeletedMemos: async () => firstLoad ? [oldMemo] : nextList.promise,
		restoreMemo: async (memo) => memo,
		purgeMemo: async () => {},
		confirmPurge: async () => true,
		handleRestoredMemo: () => {},
		isTrashActive: () => true,
		showNotice: () => {},
		forceRefreshViews: async () => {},
		requestRender: () => {},
	});

	await controller.loadTrashMemos();
	firstLoad = false;
	const refreshing = controller.loadTrashMemos();
	assert.equal(controller.getSnapshot().trashLoading, true);
	assert.deepEqual(controller.getSnapshot().trashMemos?.map((memo) => memo.id), ["old"]);

	nextList.resolve([makeMemo("new")]);
	await refreshing;
	assert.deepEqual(controller.getSnapshot().trashMemos?.map((memo) => memo.id), ["new"]);
});

test("an in-flight trash refresh cannot restore a memo removed by a newer action", async () => {
	const { TrashMemoController } = await loadController();
	const restored = makeMemo("restore-me");
	const kept = makeMemo("keep-me");
	const staleList = createDeferred<MemoViewItem[]>();
	let loadCount = 0;
	const controller = new TrashMemoController({
		getDeletedMemoSummary: async () => ({ count: 2, ids: [restored.id, kept.id] }),
		listDeletedMemos: async () => {
			loadCount += 1;
			return loadCount === 1 ? [restored, kept] : staleList.promise;
		},
		restoreMemo: async (memo) => ({ ...memo, status: "active" }),
		purgeMemo: async () => {},
		confirmPurge: async () => true,
		handleRestoredMemo: () => {},
		isTrashActive: () => true,
		showNotice: () => {},
		forceRefreshViews: async () => {},
		requestRender: () => {},
	});

	await controller.loadTrashMemos();
	const refreshing = controller.loadTrashMemos();
	await controller.handleTrashAction("restore", restored);
	staleList.resolve([restored, kept]);
	await refreshing;

	assert.deepEqual(controller.getSnapshot().trashMemos?.map((memo) => memo.id), ["keep-me"]);
});

test("restore keeps one busy action and force refreshes every view", async () => {
	const { TrashMemoController } = await loadController();
	const memo = makeMemo("memo-1");
	const renderTargets: TrashMemoRenderTarget[] = [];
	const notices: string[] = [];
	let restoreCalls = 0;
	let restoredMemo: MemoViewItem | null = null;
	const handledRestoredMemos: Array<{ deletedMemo: MemoViewItem; restoredMemo: MemoViewItem }> = [];
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
		purgeMemo: async () => {},
		confirmPurge: async () => true,
		handleRestoredMemo: (deletedMemo, memoAfterRestore) => {
			handledRestoredMemos.push({ deletedMemo, restoredMemo: memoAfterRestore });
		},
		isTrashActive: () => false,
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

test("restore 已成功后视图刷新失败不会再显示恢复失败", async () => {
	const { TrashMemoController } = await loadController();
	const memo = makeMemo("memo-1");
	const notices: string[] = [];
	const controller = new TrashMemoController({
		getDeletedMemoSummary: async () => ({ count: 1, ids: [memo.id] }),
		listDeletedMemos: async () => [memo],
		restoreMemo: async () => ({ ...memo, status: "active" }),
		purgeMemo: async () => {},
		confirmPurge: async () => true,
		handleRestoredMemo: () => {},
		isTrashActive: () => false,
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

test("purge waits for confirmation, removes only after durable success, and deduplicates clicks", async () => {
	const { TrashMemoController } = await loadController();
	const memo = makeMemo("memo-1");
	const notices: string[] = [];
	let purgeCalls = 0;
	let resolvePurge!: () => void;
	const purgeGate = new Promise<void>((resolve) => { resolvePurge = resolve; });
	const controller = new TrashMemoController({
		getDeletedMemoSummary: async () => ({ count: 1, ids: [memo.id] }),
		listDeletedMemos: async () => [memo],
		restoreMemo: async () => null,
		purgeMemo: async () => {
			purgeCalls += 1;
			await purgeGate;
		},
		confirmPurge: async () => true,
		handleRestoredMemo: () => {},
		isTrashActive: () => true,
		showNotice: (message) => notices.push(message),
		forceRefreshViews: async () => {},
		requestRender: () => {},
	});
	await controller.loadTrashMemos();

	const first = controller.handleTrashAction("purge", memo);
	const second = controller.handleTrashAction("purge", memo);
	await Promise.resolve();
	assert.equal(purgeCalls, 1);
	resolvePurge();
	await Promise.all([first, second]);

	assert.equal(controller.getSnapshot().trashCount, 0);
	assert.deepEqual(notices, ["Permanently deleted"]);
});

test("purge cancellation and persistence failure both keep the recoverable record", async () => {
	const { TrashMemoController } = await loadController();
	const memo = makeMemo("memo-1");
	const notices: string[] = [];
	let confirmed = false;
	const controller = new TrashMemoController({
		getDeletedMemoSummary: async () => ({ count: 1, ids: [memo.id] }),
		listDeletedMemos: async () => [memo],
		restoreMemo: async () => null,
		purgeMemo: async () => { throw new Error("disk unavailable"); },
		confirmPurge: async () => confirmed,
		handleRestoredMemo: () => {},
		isTrashActive: () => true,
		showNotice: (message) => notices.push(message),
		forceRefreshViews: async () => {},
		requestRender: () => {},
	});
	await controller.loadTrashMemos();

	await controller.handleTrashAction("purge", memo);
	assert.deepEqual(notices, []);

	confirmed = true;
	await controller.handleTrashAction("purge", memo);
	assert.deepEqual(notices, ["Permanent delete failed: disk unavailable"]);
});

test("formats trash action errors without duplicating the action label", async () => {
	const { formatTrashActionErrorMessage } = await loadController();

	assert.equal(formatTrashActionErrorMessage("restore", null), "Restore failed. Please try again later");
	assert.equal(formatTrashActionErrorMessage("restore", new Error("disk unavailable")), "Restore failed: disk unavailable");
	assert.equal(formatTrashActionErrorMessage("restore", new Error("Restore failed: conflict")), "Restore failed: conflict");
	assert.equal(formatTrashActionErrorMessage("purge", null), "Permanent delete failed. Please try again later");
	assert.equal(formatTrashActionErrorMessage("purge", new Error("disk unavailable")), "Permanent delete failed: disk unavailable");
});

async function loadController(): Promise<typeof import("../src/ui/TrashMemoController")> {
	await ensureObsidianStub();
	return import("../src/ui/TrashMemoController");
}

test("首次计数未知，打开侧边栏只取数量且不加载列表", async () => {
	const gate = createDeferred<{ count: number }>();
	const controller = await countController(() => gate.promise);
	assert.equal(controller.getSnapshot().trashCount, null);
	const loading = controller.refreshTrashCount(false);
	assert.equal(controller.getSnapshot().trashCountLoading, true);
	gate.resolve({ count: 3 });
	await loading;
	assert.equal(controller.getSnapshot().trashCount, 3);
	assert.equal(controller.getSnapshot().trashMemos, null);
	assert.equal(controller.getSnapshot().trashCountLoading, false);
});

test("旧计数成功或失败均不能覆盖 Trash 变化后的数量和错误状态", async () => {
	for (const fail of [false, true]) {
		let resolve!: (value: { count: number }) => void;
		let reject!: (error: Error) => void;
		const old = new Promise<{ count: number }>((res, rej) => { resolve = res; reject = rej; });
		let calls = 0;
		const controller = await countController(() => ++calls === 1 ? old : Promise.resolve({ count: 2 }));
		const pending = controller.refreshTrashCount(false);
		controller.invalidateTrashCount();
		await controller.refreshTrashCount(false);
		if (fail) reject(new Error("old error"));
		else resolve({ count: 0 });
		await pending;
		assert.equal(controller.getSnapshot().trashCount, 2);
		assert.equal(controller.getSnapshot().trashCountError, null);
	}
});

test("快照清理事件期间暂缓计数读取，操作完成后按真实数量刷新且不重复减数", async () => {
	const { TrashMemoController } = await loadController();
	let count = 2;
	let reads = 0;
	const controller = new TrashMemoController({
		getDeletedMemoSummary: async () => { reads++; return { count }; },
		listDeletedMemos: async () => [makeMemo("s1"), makeMemo("s2")],
		restoreMemo: async () => null,
		purgeMemo: async () => {
			count = 1;
			controller.invalidateTrashCount();
			await controller.refreshTrashCount(false);
			assert.equal(reads, 1);
		},
		confirmPurge: async () => true,
		handleRestoredMemo: () => {}, isTrashActive: () => false,
		showNotice: () => {}, forceRefreshViews: async () => {}, requestRender: () => {},
	});
	await controller.loadTrashMemos();
	await controller.handleTrashAction("purge", makeMemo("s1"));
	await controller.refreshTrashCount(false);
	assert.equal(controller.getSnapshot().trashCount, 1);
	assert.deepEqual(controller.getSnapshot().trashMemos?.map((memo) => memo.id), ["s2"]);
});

async function countController(getDeletedMemoSummary: () => Promise<{ count: number }>) {
	const { TrashMemoController } = await loadController();
	return new TrashMemoController({
		getDeletedMemoSummary,
		listDeletedMemos: async () => { throw new Error("count must not load list"); },
		restoreMemo: async () => null, purgeMemo: async () => {}, confirmPurge: async () => true,
		handleRestoredMemo: () => {}, isTrashActive: () => false,
		showNotice: () => {}, forceRefreshViews: async () => {}, requestRender: () => {},
	});
}

test("首次列表读取被外部事件作废后自动续读，关闭后不续读或渲染", async () => {
	for (const close of [false, true]) {
		const { TrashMemoController } = await loadController();
		const old = createDeferred<MemoViewItem[]>();
		const finished = createDeferred<void>();
		let lists = 0;
		let renders = 0;
		const controller = new TrashMemoController({
			getDeletedMemoSummary: async () => ({ count: 1 }),
			listDeletedMemos: () => ++lists === 1 ? old.promise : Promise.resolve([makeMemo("new")]),
			restoreMemo: async () => null, purgeMemo: async () => {}, confirmPurge: async () => true,
			handleRestoredMemo: () => {}, isTrashActive: () => true,
			showNotice: () => {}, forceRefreshViews: async () => {},
			requestRender: () => { renders++; if (controller.getSnapshot().trashMemos?.[0]?.id === "new") finished.resolve(); },
		});
		const pending = controller.loadTrashMemos();
		controller.invalidateTrashCount();
		if (close) controller.dispose();
		const before = renders;
		old.resolve([makeMemo("old")]);
		await pending;
		if (close) {
			assert.equal(lists, 1);
			assert.equal(renders, before);
		} else {
			await finished.promise;
			assert.equal(lists, 2);
			assert.equal(controller.getSnapshot().trashMemos?.[0]?.id, "new");
		}
	}
});

function makeMemo(id: string): MemoViewItem {
	return {
		id,
		createdAt: "2026-06-02T00:00:00+08:00",
		updatedAt: "2026-06-02T00:00:00+08:00",
		contentSnapshot: id,
		contentHash: `hash-${id}`,
		status: "deleted",
		tags: [],
		links: [],
		images: [],
		dailyRef: {
			path: "Daily/2026-06-02.md",
			heading: "Memos",
			sectionType: "heading",
			lineNumberHint: 1,
		},
	};
}

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolvePromise: (value: T) => void = () => undefined;
	const promise = new Promise<T>((resolve) => {
		resolvePromise = resolve;
	});
	return { promise, resolve: resolvePromise };
}

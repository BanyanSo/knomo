import test from "node:test";
import assert from "node:assert/strict";
import type { TrashSnapshot } from "../src/types/trash";
import { toTrashMemoItem, toTrashMemoView } from "../src/types/memoView";
import { ensureObsidianStub } from "./helpers/obsidianStub";

const PATH = "Monthly/knomo-trash.json";
const item = (id: string): TrashSnapshot => ({ snapshotId: id, deletedAt: "2026-09-09T12:00:00Z", sourcePath: "Daily/2026-09-09.md",
 logicalDate: "2026-09-09", section: null, rawBlock: "- 10:30 same memo" });
const encode = (items: TrashSnapshot[]) => JSON.stringify({ kind: "knomo-trash", items });
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

async function fixture(count = 5) {
 await ensureObsidianStub();
 const { InMemoryVault } = await import("./helpers/InMemoryVault");
 const { TrashSnapshotStore } = await import("../src/services/TrashSnapshotStore");
 const { TrashMemoController } = await import("../src/ui/TrashMemoController");
 const vault = new InMemoryVault({ [PATH]: encode(Array.from({ length: count }, (_, i) => item(`s${i}`))) });
 let folder = "Monthly";
 const store = new TrashSnapshotStore(vault.app, () => folder);
 let reads = 0;
 const read = vault.app.vault.read.bind(vault.app.vault);
 vault.app.vault.read = async (file) => { reads++; return read(file); };
 const notices: string[] = [];
 const renders: string[] = [];
 let invalidations = 0;
 const options = { store, toMemo: (snapshot: TrashSnapshot) => toTrashMemoView(toTrashMemoItem(snapshot)), pageSize: 2, windowLimit: 3,
  onInvalidated: () => { invalidations++; }, restoreMemo: async (_memo: ReturnType<typeof toTrashMemoView>) => null as ReturnType<typeof toTrashMemoView> | null,
  purgeMemo: async (memo: ReturnType<typeof toTrashMemoView>) => store.remove(item(memo.id)), confirmPurge: async () => true,
  handleRestoredMemo: () => {}, isTrashActive: () => true, showNotice: (message: string) => { notices.push(message); },
  forceRefreshViews: async () => {}, requestRender: (target: string) => { renders.push(target); } };
 const controller = new TrashMemoController(options);
 controller.start();
 return { vault, store, controller, options, notices, renders, reads: () => reads, invalidations: () => invalidations,
  another: () => { const next = new TrashMemoController(options); next.start(); return next; },
  setFolder: (next: string) => { folder = next; store.invalidateConfiguration(); } };
}

test("列表、badge、数量共享一次读取，多视图和分页只派生窗口", async () => {
 const f = await fixture(); const second = f.another();
 assert.equal(f.controller.getSnapshot().trashCount, null);
 assert.equal(f.controller.getSnapshot().trashMemos, null);
 await Promise.all([f.controller.loadTrashMemos(), f.controller.ensureLoaded(), second.loadTrashMemos()]);
 assert.equal(f.reads(), 1);
 assert.equal(second.getSnapshot().trashCount, 5);
 assert.deepEqual(f.controller.getSnapshot().trashMemos?.map((memo) => memo.id), ["s0", "s1"]);
 await f.controller.loadNextPage();
 assert.deepEqual(f.controller.getSnapshot().trashMemos?.map((memo) => memo.id), ["s1", "s2", "s3"]);
 await f.controller.loadNextPage();
 assert.deepEqual(f.controller.getSnapshot().trashMemos?.map((memo) => memo.id), ["s2", "s3", "s4"]);
 assert.equal(f.controller.hasMore(), false);
 await f.controller.ensureLoaded();
 assert.equal(f.reads(), 1);
});

test("已确认本地增删和 Clear 直接发布多视图状态，展示刷新不重复读盘", async () => {
 const f = await fixture(1); const second = f.another();
 await f.controller.loadTrashMemos();
 for (const operation of [() => f.store.save(item("s1")), () => f.store.remove(item("s0")), () => f.store.clear()]) {
  await operation(); const reads = f.reads();
  await Promise.all([f.controller.loadTrashMemos(), second.ensureLoaded()]);
  assert.equal(f.reads(), reads);
  assert.equal(f.controller.getSnapshot().trashCount, f.store.getState().count);
  assert.equal(second.getSnapshot().trashCount, f.store.getState().count);
 }
 assert.deepEqual(f.controller.getSnapshot().trashMemos, []);
 assert.equal(second.getSnapshot().trashCount, 0);
});

test("外部覆盖、损坏和目录切换使列表、数量及错误一致；显式重试恢复", async () => {
 const f = await fixture(1); await f.controller.loadTrashMemos();
 f.vault.replace(PATH, "broken"); f.store.handleFileChange(PATH);
 assert.equal(f.controller.getSnapshot().trashCount, null);
 assert.equal(f.controller.getSnapshot().trashMemos, null);
 await f.controller.loadTrashMemos();
 assert.ok(f.controller.getSnapshot().trashError);
 assert.equal(f.controller.getSnapshot().trashCountError, f.controller.getSnapshot().trashError);
 const reads = f.reads(); await f.controller.loadTrashMemos(); await f.controller.ensureLoaded();
 assert.equal(f.reads(), reads);
 f.vault.replace(PATH, encode([item("fixed")])); await f.controller.loadTrashMemos(true);
 assert.equal(f.controller.getSnapshot().trashMemos?.[0]?.id, "fixed");
 await f.vault.app.vault.createFolder("New"); await f.vault.app.vault.create("New/knomo-trash.json", encode([item("new")])); f.setFolder("New");
 await f.controller.loadTrashMemos();
 assert.equal(f.controller.getSnapshot().trashMemos?.[0]?.id, "new");
});

test("旧读取晚返回不覆盖本地删除，关闭视图后不渲染且不影响其他视图", async () => {
 const f = await fixture(2); const second = f.another();
 const original = f.vault.app.vault.read.bind(f.vault.app.vault); const gate = deferred<void>(); let first = true;
 f.vault.app.vault.read = async (file) => { const text = await original(file); if (first) { first = false; await gate.promise; } return text; };
 const pending = f.controller.loadTrashMemos(); await tick();
 await f.store.remove(item("s0")); f.controller.dispose(); second.dispose();
 const renders = f.renders.length; gate.resolve(); await pending;
 assert.equal(f.renders.length, renders);
 assert.equal(f.store.getState().count, 1);
 const third = f.another(); await third.loadTrashMemos();
 assert.deepEqual(third.getSnapshot().trashMemos?.map((memo) => memo.id), ["s1"]);
});

test("Purge 确认前不删除、取消保留，重复点击合并且确认落盘后才显示成功", async () => {
 const f = await fixture(1); await f.controller.loadTrashMemos(); const memo = f.controller.getSnapshot().trashMemos![0]!;
 f.options.confirmPurge = async () => false; await f.controller.handleTrashAction("purge", memo);
 assert.equal(f.store.getState().count, 1);
 const gate = deferred<boolean>(); let calls = 0;
 f.options.confirmPurge = () => { calls++; return gate.promise; };
 const pending = f.controller.handleTrashAction("purge", memo); await f.controller.handleTrashAction("purge", memo);
 assert.equal(calls, 1); assert.equal(f.store.getState().count, 1);
 gate.resolve(true); await pending;
 assert.equal(f.controller.getSnapshot().trashCount, 0);
});

test("写后抛错不乐观减计数或显示空状态，等待中的展示读取不掩盖操作错误", async () => {
 const f = await fixture(1); await f.controller.loadTrashMemos(); const memo = f.controller.getSnapshot().trashMemos![0]!;
 const process = f.vault.app.vault.process.bind(f.vault.app.vault); let queued: Promise<void> | undefined;
 f.vault.app.vault.process = async (file, update) => {
  const value = await process(file, update); f.store.handleFileChange(file.path);
  queued = f.controller.ensureLoaded(); throw new Error("uncertain");
 };
 await f.controller.handleTrashAction("purge", memo); await queued;
 assert.equal(f.controller.getSnapshot().trashCount, null);
 assert.equal(f.controller.getSnapshot().trashMemos, null);
 assert.ok(f.controller.getSnapshot().trashError);
 assert.ok(f.notices.some((text) => text.includes("uncertain")));
});

test("Restore 防重复点击；正文成功后视图刷新失败仅报告刷新待处理", async () => {
 const f = await fixture(1); await f.controller.loadTrashMemos(); const memo = f.controller.getSnapshot().trashMemos![0]!;
 const gate = deferred<void>(); let restores = 0;
 f.options.restoreMemo = async () => { restores++; await gate.promise; await f.store.remove(item("s0")); return memo; };
 f.options.forceRefreshViews = async () => { throw new Error("view failed"); };
 const pending = f.controller.handleTrashAction("restore", memo); await f.controller.handleTrashAction("restore", memo);
 assert.equal(restores, 1); assert.equal(f.controller.getSnapshot().trashBusyMemoActions.size, 1);
 gate.resolve(); await pending;
 assert.equal(f.controller.getSnapshot().trashBusyMemoActions.size, 0);
 assert.equal(f.controller.getSnapshot().trashCount, 0);
 assert.equal(f.notices.length, 2);
 assert.ok(!f.notices.join("").includes("view failed"));
});

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((res) => { resolve = res; }); return { promise, resolve }; }

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


test("关闭视图撤销尚待确认的 Purge，已提交 Restore 不回填关闭的视图", async () => {
 const f = await fixture(1); await f.controller.loadTrashMemos(); const memo = f.controller.getSnapshot().trashMemos![0]!;
 const confirmation = deferred<boolean>(); f.options.confirmPurge = () => confirmation.promise;
 const purge = f.controller.handleTrashAction("purge", memo); f.controller.dispose(); confirmation.resolve(true); await purge;
 assert.equal(f.store.getState().count, 1);
 const next = f.another(); const restored = deferred<void>(); let callbacks = 0;
 f.options.restoreMemo = async () => { await restored.promise; await f.store.remove(item("s0")); return memo; };
 f.options.handleRestoredMemo = () => { callbacks++; };
 const pending = next.handleTrashAction("restore", memo); next.dispose(); const renders = f.renders.length;
 restored.resolve(); await pending;
 assert.equal(callbacks, 0); assert.equal(f.renders.length, renders); assert.equal(f.store.getState().count, 0);
});

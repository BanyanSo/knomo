import test from "node:test";
import assert from "node:assert/strict";
import type { TrashSnapshot } from "../src/types/trash";
import { toTrashMemoItem, toTrashMemoView } from "../src/types/memoView";
import { ensureObsidianStub } from "./helpers/obsidianStub";
import { MarkdownBlockService } from "../src/services/MarkdownBlockService";
import { memoMarkdownConsistencyFixtures } from "./fixtures/memoMarkdownConsistency";

const PATH = "Monthly/knomo-trash.json";
const item = (id: string): TrashSnapshot => ({ snapshotId: id, deletedAt: "2026-09-09T12:00:00Z", sourcePath: "Daily/2026-09-09.md",
 logicalDate: "2026-09-09", section: null, rawBlock: "- 10:30 same memo" });
const encode = (items: TrashSnapshot[]) => JSON.stringify({ kind: "knomo-trash", items });
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("新独立块格式进入 Trash 后保留正文空白与实际时间，不显示结构前缀和引用 ID", () => {
 const blocks = new MarkdownBlockService();
 for (const sample of memoMarkdownConsistencyFixtures) {
  const deleted = toTrashMemoItem({ ...item("structured"), rawBlock: blocks.buildMemoBlockWithBlockId(sample.content, "10:30:27", "existing-anchor") });
  assert.equal(deleted.createdAt, "2026-09-09T10:30:27");
  assert.equal(deleted.content, sample.content, sample.name);
 }
});

test("Trash 的四列空格及混合缩进保留标题、代码和用户空行", () => {
 const blocks = new MarkdownBlockService();
 for (const content of ["  # title", "    code\n\tmore", "\n  # title\n\n", "first\nsecond  "]) {
  for (const indent of ["    ", " \t", "  \t", "   \t"]) {
   const rawBlock = blocks.buildMemoBlockWithBlockId(content, "10:30:27", "anchor").replace(/^\t/gmu, indent);
   assert.equal(toTrashMemoItem({ ...item("spaces"), rawBlock }).content, content);
  }
 }
});

async function fixture(count = 5) {
 await ensureObsidianStub();
 const { InMemoryVault } = await import("./helpers/InMemoryVault");
 const { TrashSnapshotStore } = await import("../src/services/TrashSnapshotStore");
 const { TrashMemoController } = await import("../src/ui/TrashMemoController");
 const { createClearTrashAction } = await import("../src/ui/clearTrashAction");
 const vault = new InMemoryVault({ [PATH]: encode(Array.from({ length: count }, (_, i) => item(`s${i}`))) });
 let folder = "Monthly";
 const store = new TrashSnapshotStore(vault.app, () => folder);
 let reads = 0;
 const read = vault.app.vault.read.bind(vault.app.vault);
 vault.app.vault.read = async (file) => { reads++; return read(file); };
 const notices: string[] = [];
 const renders: string[] = [];
 const clearOptions = { getPath: () => store.path, confirm: async () => true, clear: () => store.clear(),
  showNotice: (message: string) => { notices.push(message); }, isActive: () => true };
 let invalidations = 0;
 const options = { store, toMemo: (snapshot: TrashSnapshot) => toTrashMemoView(toTrashMemoItem(snapshot)), pageSize: 2, windowLimit: 3,
  onInvalidated: () => { invalidations++; }, restoreMemo: async (_memo: ReturnType<typeof toTrashMemoView>): Promise<import("../src/ui/TrashMemoController").TrashRestoreResult<ReturnType<typeof toTrashMemoView>>> => ({ memo: null, cleanupPending: false, localRefreshPending: false }),
  isCleanupPending: (_memo: ReturnType<typeof toTrashMemoView>) => false,
  purgeMemo: async (memo: ReturnType<typeof toTrashMemoView>) => store.remove(item(memo.id)), confirmPurge: async () => true,
  clearTrash: createClearTrashAction(clearOptions),
  handleRestoredMemo: () => {}, isTrashActive: () => true, showNotice: (message: string) => { notices.push(message); },
  forceRefreshViews: async () => {}, requestRender: (target: string) => { renders.push(target); } };
 const controller = new TrashMemoController(options);
 controller.start();
 return { vault, store, controller, options, clearOptions, notices, renders, reads: () => reads, invalidations: () => invalidations,
  another: () => { const next = new TrashMemoController(options); next.start(); return next; },
  setFolder: (next: string) => { folder = next; store.invalidateConfiguration(); } };
}

test("状态、badge 和窗口展示不读取完整 Trash 正文集合", async t => {
 const f = await fixture(300);
 await f.controller.loadTrashMemos();
 t.mock.method(f.store, "getState", () => { throw new Error("must not clone the entire collection"); });
 assert.equal(f.controller.getSnapshot().trashCount, 300);
 assert.equal(f.controller.getSnapshot().trashMemos?.length, 2);
 assert.equal(f.controller.hasMore(), true);
 await f.controller.ensureLoaded();
 await f.controller.loadNextPage();
 assert.equal(f.controller.getSnapshot().trashMemos?.length, 3);
 assert.equal(f.reads(), 1);
 f.controller.dispose();
});

test("页面清空使用完整集合，确认与执行期间合并页面和命令重复触发，共享列表及数量直接更新", async () => {
 const f = await fixture(5); const second = f.another();
 let confirmations = 0; const confirmation = deferred<boolean>(); const execution = deferred<void>();
 f.clearOptions.confirm = () => { confirmations++; return confirmation.promise; };
 const clear = f.clearOptions.clear; let clears = 0;
 f.clearOptions.clear = async () => { clears++; await execution.promise; await clear(); };
 await f.controller.handleClearTrash(); assert.equal(confirmations, 0);
 await f.controller.loadTrashMemos();
 assert.equal(f.controller.getSnapshot().trashMemos?.length, 2);
 assert.equal(f.controller.getSnapshot().trashCount, 5);
 const pending = f.controller.handleClearTrash();
 await f.controller.handleClearTrash(); await f.options.clearTrash();
 assert.equal(confirmations, 1); assert.equal(clears, 0);
 assert.equal(f.controller.getSnapshot().trashClearBusy, true);
 await f.store.save(item("arrived-during-confirmation"));
 confirmation.resolve(true); await tick();
 await f.options.clearTrash(); await f.controller.handleClearTrash();
 assert.equal(clears, 1); assert.equal(f.notices.length, 0);
 execution.resolve(); await pending;
 assert.equal(f.controller.getSnapshot().trashCount, 0);
 assert.deepEqual(f.controller.getSnapshot().trashMemos, []);
 assert.equal(second.getSnapshot().trashCount, 0);
 assert.equal(f.controller.getSnapshot().trashClearBusy, false);
 assert.deepEqual(f.notices, ["Trash emptied."]);
 await f.controller.handleClearTrash(); assert.equal(confirmations, 1);
});

test("取消清空保留副本且释放 busy，命令可安全清空空集合", async () => {
 const f = await fixture(1); await f.controller.loadTrashMemos();
 f.clearOptions.confirm = async () => false;
 await f.controller.handleClearTrash();
 assert.equal(f.controller.getSnapshot().trashClearBusy, false);
 assert.equal(f.controller.getSnapshot().trashCount, 1); assert.deepEqual(f.notices, []);
 f.clearOptions.confirm = async () => true;
 await f.controller.handleClearTrash(); await f.options.clearTrash();
 assert.equal(f.store.getSummary().count, 0);
 assert.deepEqual(f.notices, ["Trash emptied.", "Trash emptied."]);
});

test("清空确认期间切换目录拒绝执行，原目录与当前目录均不被误清空", async () => {
 const f = await fixture(1); await f.controller.loadTrashMemos();
 const confirmation = deferred<boolean>(); f.clearOptions.confirm = () => confirmation.promise;
 await f.vault.app.vault.create("New/knomo-trash.json", encode([item("new")]));
 const pending = f.controller.handleClearTrash();
 f.setFolder("New"); confirmation.resolve(true); await pending;
 assert.equal(JSON.parse(f.vault.read(PATH)!).items.length, 1);
 assert.equal(JSON.parse(f.vault.read("New/knomo-trash.json")!).items.length, 1);
 assert.deepEqual(f.notices, ["Couldn't confirm whether Trash was emptied. Please check again."]);
});

test("清空读取损坏或写后报错不误报成功，不自动重试并允许显式查看现状", async () => {
 for (const failure of ["corrupt", "write-uncertain"] as const) {
  const f = await fixture(1); await f.controller.loadTrashMemos();
  let attempts = 0; const process = f.vault.app.vault.process.bind(f.vault.app.vault);
  f.vault.app.vault.process = async (file, update) => {
   attempts++; const result = await process(file, update);
   if (failure === "write-uncertain") throw new Error("private technical detail");
   return result;
  };
  const corrupt = "{broken";
  if (failure === "corrupt") f.clearOptions.confirm = async () => { f.vault.replace(PATH, corrupt); return true; };
  await f.controller.handleClearTrash();
  assert.equal(attempts, 1);
  assert.equal(f.controller.getSnapshot().trashCount, null);
  assert.equal(f.controller.getSnapshot().trashMemos, null);
  assert.ok(f.controller.getSnapshot().trashError);
  assert.equal(f.controller.getSnapshot().trashClearBusy, false);
  assert.deepEqual(f.notices, ["Couldn't confirm whether Trash was emptied. Please check again."]);
  await f.controller.handleClearTrash(); assert.equal(attempts, 1);
  if (failure === "corrupt") assert.equal(f.vault.read(PATH), corrupt);
  else {
   assert.deepEqual(JSON.parse(f.vault.read(PATH)!).items, []);
   await f.controller.loadTrashMemos(true);
   assert.equal(f.controller.getSnapshot().trashCount, 0); assert.equal(f.notices.length, 1);
  }
 }
});

test("关闭视图或卸载 runtime 撤销未确认清空，已启动的清空继续且不更新已关闭视图", async () => {
 for (const phase of ["confirm", "runtime", "execute"] as const) {
  const f = await fixture(1); await f.controller.loadTrashMemos();
  const confirmation = deferred<boolean>(); const execution = deferred<void>();
  f.clearOptions.confirm = () => confirmation.promise;
  const clear = f.clearOptions.clear;
  f.clearOptions.clear = async () => { await execution.promise; await clear(); };
  const pending = f.controller.handleClearTrash();
  if (phase === "execute") { confirmation.resolve(true); await tick(); }
  if (phase === "runtime") f.clearOptions.isActive = () => false;
  else f.controller.dispose();
  const renders = f.renders.length;
  confirmation.resolve(true); execution.resolve(); await pending;
  assert.equal(f.renders.length, phase === "runtime" ? renders + 1 : renders);
  assert.equal(f.store.getSummary().count, phase === "execute" ? 0 : 1);
  assert.deepEqual(f.notices, []);
 }
});

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
  await process(file, update); f.store.handleFileChange(file.path);
  queued = f.controller.ensureLoaded(); throw new Error("uncertain");
 };
 await f.controller.handleTrashAction("purge", memo); await queued;
 assert.equal(f.controller.getSnapshot().trashCount, null);
 assert.equal(f.controller.getSnapshot().trashMemos, null);
 assert.ok(f.controller.getSnapshot().trashError);
 assert.ok(f.notices.some((text) => text.includes("uncertain")));
});

test("Restore 防重复点击；正文成功后视图刷新失败不追加操作通知", async () => {
 const f = await fixture(1); await f.controller.loadTrashMemos(); const memo = f.controller.getSnapshot().trashMemos![0]!;
 const gate = deferred<void>(); let restores = 0;
 f.options.restoreMemo = async () => { restores++; await gate.promise; await f.store.remove(item("s0")); return { memo, cleanupPending: false, localRefreshPending: false }; };
 f.options.forceRefreshViews = async () => { throw new Error("view failed"); };
 const pending = f.controller.handleTrashAction("restore", memo); await f.controller.handleTrashAction("restore", memo);
 assert.equal(restores, 1); assert.equal(f.controller.getSnapshot().trashBusyMemoActions.size, 1);
 gate.resolve(); await pending;
 assert.equal(f.controller.getSnapshot().trashBusyMemoActions.size, 0);
 assert.equal(f.controller.getSnapshot().trashCount, 0);
 assert.equal(f.notices.length, 1);
 assert.ok(!f.notices.join("").includes("view failed"));
});

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((res) => { resolve = res; }); return { promise, resolve }; }

test("恢复清理待重试保留成功事实和原因，服务状态决定重试清理入口", async () => {
 const f = await fixture(1); await f.controller.loadTrashMemos(); const memo = f.controller.getSnapshot().trashMemos![0]!;
 let cleanupPending = false; let writes = 0; let cleanups = 0;
 f.options.isCleanupPending = () => cleanupPending;
 f.options.restoreMemo = async () => {
  if (!cleanupPending) { writes++; cleanupPending = true; return { memo, cleanupPending: true, localRefreshPending: true, message: "Content restored, but cleanup failed: disk locked" }; }
  cleanups++; cleanupPending = false; await f.store.remove(item("s0"));
  return { memo, cleanupPending: false, localRefreshPending: false };
 };
 await f.controller.handleTrashAction("restore", memo);
 assert.equal(writes, 1); assert.equal(f.controller.getSnapshot().trashCount, 1);
 assert.ok(f.controller.getSnapshot().trashCleanupPendingMemoIds.has(memo.id));
 assert.ok(f.notices[0]?.includes("disk locked")); assert.ok(f.notices[0]?.includes("Retry only"));
 assert.ok(!f.notices.join("").includes("Restore failed")); assert.equal(f.notices.length, 1);
 await f.controller.handleTrashAction("restore", memo);
 assert.equal(writes, 1); assert.equal(cleanups, 1); assert.equal(f.controller.getSnapshot().trashCount, 0);
});

test("恢复部分成功不被卡片回调与跨视图刷新错误覆盖，只反馈一次清理结果", async () => {
 const f = await fixture(1); await f.controller.loadTrashMemos(); const memo = f.controller.getSnapshot().trashMemos![0]!;
 f.options.restoreMemo = async () => ({ memo, cleanupPending: true, localRefreshPending: true });
 f.options.handleRestoredMemo = () => { throw new Error("render failed"); };
 f.options.forceRefreshViews = async () => { throw new Error("refresh failed"); };
 f.options.requestRender = () => { throw new Error("render failed"); };
 await f.controller.handleTrashAction("restore", memo);
 assert.equal(f.notices.length, 1);
 assert.match(f.notices[0]!, /restored/i);
 assert.match(f.notices[0]!, /Retry only/);
 assert.doesNotMatch(f.notices[0]!, /Restore failed/);
 assert.equal(f.controller.getSnapshot().trashBusyMemoActions.size, 0);
});

test("关闭并重启 controller 后旧 Restore 不发通知、不回填也不清除新会话 busy", async () => {
 const f = await fixture(1); await f.controller.loadTrashMemos(); const memo = f.controller.getSnapshot().trashMemos![0]!;
 const old = deferred<void>(); const current = deferred<void>(); let calls = 0; let callbacks = 0;
 f.options.restoreMemo = async () => { await (++calls === 1 ? old.promise : current.promise); return { memo, cleanupPending: true, localRefreshPending: false }; };
 f.options.handleRestoredMemo = () => { callbacks++; };
 const pending = f.controller.handleTrashAction("restore", memo); f.controller.dispose(); f.controller.start();
 const next = f.controller.handleTrashAction("restore", memo); const renders = f.renders.length;
 old.resolve(); await pending;
 assert.equal(f.notices.length, 0); assert.equal(callbacks, 0); assert.equal(f.renders.length, renders);
 assert.equal(f.controller.getSnapshot().trashBusyMemoActions.size, 1);
 current.resolve(); await next; assert.equal(callbacks, 1); assert.equal(f.controller.getSnapshot().trashBusyMemoActions.size, 0);
});

test("formats trash action errors without duplicating the action label", async () => {
	const { formatTrashActionErrorMessage } = await loadController();

	assert.equal(formatTrashActionErrorMessage("restore", null), "Restore failed. Please try again later");
	assert.equal(formatTrashActionErrorMessage("restore", new Error("disk unavailable")), "Restore failed: disk unavailable");
	assert.equal(formatTrashActionErrorMessage("restore", new Error("Restore failed: conflict")), "Restore failed: conflict");
	assert.equal(formatTrashActionErrorMessage("purge", null), "Permanent delete failed. Please try again later");
	assert.equal(formatTrashActionErrorMessage("purge", new Error("disk unavailable")), "Permanent delete failed: disk unavailable");
});

test("恢复 I/O 未确认与明确失败分别反馈，均保留副本且不自动重试正文", async () => {
 const f = await fixture(1); await f.controller.loadTrashMemos(); const memo = f.controller.getSnapshot().trashMemos![0]!;
 const { TrashDailyWriteError } = await import("../src/services/IndependentTrashService");
 let calls = 0;
 f.options.restoreMemo = async () => { calls++; throw new TrashDailyWriteError("s0", "unreadable", "disk read failed"); };
 await f.controller.handleTrashAction("restore", memo);
 assert.equal(f.notices.length, 1); assert.match(f.notices[0]!, /not confirmed/); assert.doesNotMatch(f.notices[0]!, /Restore failed/);
 assert.equal(f.controller.getSnapshot().trashCount, 1); assert.equal(calls, 1);
 f.options.restoreMemo = async () => { calls++; throw new Error("snapshot invalid"); };
 await f.controller.handleTrashAction("restore", memo);
 assert.equal(f.notices.length, 2); assert.match(f.notices[1]!, /Restore failed/); assert.equal(calls, 2);
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
 f.options.restoreMemo = async () => { await restored.promise; await f.store.remove(item("s0")); return { memo, cleanupPending: false, localRefreshPending: false }; };
 f.options.handleRestoredMemo = () => { callbacks++; };
 const pending = next.handleTrashAction("restore", memo); next.dispose(); const renders = f.renders.length;
 restored.resolve(); await pending;
 assert.equal(callbacks, 0); assert.equal(f.renders.length, renders); assert.equal(f.store.getState().count, 0);
});

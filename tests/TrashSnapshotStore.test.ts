import assert from "node:assert/strict";
import test from "node:test";
import type { TrashSnapshot } from "../src/types/trash";
import { ensureObsidianStub } from "./helpers/obsidianStub";

const PATH = "Monthly/knomo-trash.json";
const snapshot = (snapshotId = "s1"): TrashSnapshot => ({ snapshotId, deletedAt: "2026-09-09T12:00:00Z",
	sourcePath: "Daily/2026-09-09.md", logicalDate: "2026-09-09", section: "## Memos", rawBlock: "- 10:30:27 memo\n  continuation ^ref" });
const encode = (items: TrashSnapshot[]) => JSON.stringify({ kind: "knomo-trash", items });

async function fixture(initial: Record<string, string> = {}) {
	await ensureObsidianStub();
	const { InMemoryVault } = await import("./helpers/InMemoryVault");
	const { TrashSnapshotStore } = await import("../src/services/TrashSnapshotStore");
	const vault = new InMemoryVault(initial);
	let folder = "Monthly";
	let active = true;
	const store = new TrashSnapshotStore(vault.app, () => folder, () => { if (!active) throw new Error("cancelled"); });
	return { vault, store, another: () => new TrashSnapshotStore(vault.app, () => folder),
		setFolder: (value: string) => { folder = value; }, cancel: () => { active = false; } };
}

test("单文件完整六字段、批量保存、同文独立、同 ID 同内容重试，state count 同源且不可被调用方改写", async () => {
	const f = await fixture();
	assert.equal(f.store.getState().count, null);
	assert.deepEqual(await f.store.query(), { items: [], errors: [] });
	assert.equal(f.vault.read(PATH), null);
	await f.store.saveAll([snapshot(), snapshot("s2")]);
	await f.store.save(snapshot());
	assert.deepEqual(JSON.parse(f.vault.read(PATH)!), { kind: "knomo-trash", items: [snapshot(), snapshot("s2")] });
	assert.deepEqual(f.vault.paths(), [PATH]);
	const state = f.store.getState();
	assert.equal(state.status, "ready");
	assert.equal(state.count, 2);
	state.items!.pop();
	assert.equal(f.store.getState().count, 2);
	const [a, b] = await Promise.all([f.store.query(), f.store.query()]);
	a.items[0]!.rawBlock = "mutated";
	assert.equal(b.items[0]!.rawBlock, snapshot().rawBlock);
	assert.equal((await f.store.read("s1")).rawBlock, snapshot().rawBlock);
});

test("ownership、损坏 JSON、非法集合、重复 ID 和无效字段均拒绝读写，不把失败当空集合", async (context) => {
	for (const [name, content] of Object.entries({
		json: "broken", ownership: JSON.stringify({ kind: "other", items: [] }), array: "[]",
		items: JSON.stringify({ kind: "knomo-trash", items: {} }), duplicate: encode([snapshot(), snapshot()]),
		id: encode([snapshot("../x")]), date: encode([{ ...snapshot(), logicalDate: "2026-02-30" }]),
		path: encode([{ ...snapshot(), sourcePath: "../Daily.md" }]), section: encode([{ ...snapshot(), section: "heading" }]),
		raw: encode([{ ...snapshot(), rawBlock: "" }]), extra: JSON.stringify({ kind: "knomo-trash", items: [], version: 1 }),
		itemExtra: JSON.stringify({ kind: "knomo-trash", items: [{ ...snapshot(), version: 1 }] }),
	})) {
		await context.test(name, async () => {
			const f = await fixture({ [PATH]: content });
			assert.equal((await f.store.query()).errors.length, 1);
			assert.equal(f.store.getState().status, "error");
			assert.equal(f.store.getState().count, null);
			await assert.rejects(f.store.save(snapshot("s2")));
			await assert.rejects(f.store.remove(snapshot()));
			await assert.rejects(f.store.clear());
			assert.equal(f.vault.read(PATH), content);
		});
	}
});

test("文件缺失与不可见文件、目录占位、不可读不能混淆，Vault 根目录可用", async () => {
	const f = await fixture();
	await f.vault.app.vault.createFolder(PATH);
	await assert.rejects(f.store.save(snapshot()), /unavailable/u);
	const hidden = await fixture();
	hidden.vault.app.vault.adapter.exists = async (path) => path === PATH;
	assert.equal((await hidden.store.query()).errors.length, 1);
	await assert.rejects(hidden.store.save(snapshot()), /unavailable/u);
	const root = await fixture();
	root.setFolder("");
	await root.store.save(snapshot());
	assert.deepEqual(root.vault.paths(), ["knomo-trash.json"]);
});

test("修改从磁盘当前集合计算，跨实例并发 save/remove 不丢失其他 item", async () => {
	const f = await fixture({ [PATH]: encode([snapshot()]) });
	await f.store.query();
	f.vault.replace(PATH, encode([snapshot(), snapshot("external")]));
	await Promise.all([f.store.save(snapshot("s2")), f.another().save(snapshot("s3")), f.store.remove(snapshot())]);
	assert.deepEqual((await f.store.query()).items.map((item) => item.snapshotId).sort(), ["external", "s2", "s3"]);
});

test("批量冲突全体拒绝；指定 item 使用全部预期字段，process 内变化也拒绝", async () => {
	const f = await fixture({ [PATH]: encode([snapshot()]) });
	await assert.rejects(f.store.saveAll([snapshot("s2"), { ...snapshot(), rawBlock: "different" }]), /changed/u);
	assert.equal(f.vault.read(PATH), encode([snapshot()]));
	for (const field of ["deletedAt", "sourcePath", "logicalDate", "section", "rawBlock"] as const) {
		const changed = { ...snapshot(), [field]: ({ deletedAt: "2026-09-10T12:00:00Z", sourcePath: "Other.md",
			logicalDate: "2026-09-10", section: null, rawBlock: "different" })[field] };
		f.vault.replace(PATH, encode([changed]));
		await assert.rejects(f.store.remove(snapshot()), /changed/u);
		assert.equal(f.vault.read(PATH), encode([changed]));
	}
	f.vault.replace(PATH, encode([snapshot()]));
	const process = f.vault.app.vault.process.bind(f.vault.app.vault);
	f.vault.app.vault.process = async (file, update) => {
		f.vault.replace(PATH, encode([{ ...snapshot(), rawBlock: "changed during process" }]));
		return process(file, update);
	};
	await assert.rejects(f.store.remove(snapshot()), /changed/u);
});

test("写后抛错、读回失败、读回内容变化不报告成功或回写旧集合；后续可重读", async (context) => {
	for (const failure of ["create-after", "process-after", "read", "changed"] as const) {
		await context.test(failure, async () => {
			const f = await fixture(failure === "create-after" ? {} : { [PATH]: encode([snapshot()]) });
			const create = f.vault.app.vault.create.bind(f.vault.app.vault);
			const process = f.vault.app.vault.process.bind(f.vault.app.vault);
			const read = f.vault.app.vault.read.bind(f.vault.app.vault);
			let writes = 0;
			f.vault.app.vault.create = async (path, text) => { writes++; await create(path, text); throw new Error("write uncertain"); };
			f.vault.app.vault.process = async (file, update) => {
				writes++; const result = await process(file, update);
				if (failure === "process-after") throw new Error("write uncertain");
				if (failure === "changed") f.vault.replace(PATH, encode([snapshot("external")]));
				return result;
			};
			f.vault.app.vault.read = async (file) => { if (failure === "read") throw new Error("unreadable"); return read(file); };
			await assert.rejects(f.store.save(snapshot("s2")), /failed/u);
			assert.equal(writes, 1);
			assert.equal(f.store.getState().status, "error");
			assert.equal(f.store.getState().count, null);
			assert.ok(f.vault.read(PATH)!.includes(failure === "changed" ? "external" : "s2"));
			f.vault.app.vault.read = read;
			assert.equal((await f.store.query()).errors.length, 0);
			assert.equal(f.store.getState().status, "ready");
		});
	}
});

test("清理写后抛错不回滚；cleanupOnly 可确认缺失，Clear 不创建文件也不修改 Markdown", async () => {
	const f = await fixture({ "Daily.md": "daily", "Monthly/Memos.md": "monthly" });
	await f.store.clear();
	assert.equal(f.vault.read(PATH), null);
	await f.store.saveAll([snapshot(), snapshot("s2")]);
	const process = f.vault.app.vault.process.bind(f.vault.app.vault);
	f.vault.app.vault.process = async (file, update) => { await process(file, update); throw new Error("uncertain cleanup"); };
	await assert.rejects(f.store.remove(snapshot()), /uncertain cleanup/u);
	assert.deepEqual(JSON.parse(f.vault.read(PATH)!).items, [snapshot("s2")]);
	f.vault.app.vault.process = process;
	await f.store.remove(snapshot(), true);
	await f.store.clear();
	assert.equal(f.store.getState().count, 0);
	assert.equal(f.vault.read("Daily.md"), "daily");
	assert.equal(f.vault.read("Monthly/Memos.md"), "monthly");
});

test("共享读取、晚返回与配置切换不回填旧 state；旧配置排队操作拒绝", async () => {
	const f = await fixture({ [PATH]: encode([snapshot()]), "New/knomo-trash.json": encode([snapshot("new")]) });
	const read = f.vault.app.vault.read.bind(f.vault.app.vault);
	const gate = deferred<void>();
	let reads = 0;
	f.vault.app.vault.read = async (file) => { const content = await read(file); if (++reads === 1) await gate.promise; return content; };
	const a = f.store.query();
	const b = f.store.query();
	await Promise.resolve();
	assert.equal(f.store.getState().status, "loading");
	f.setFolder("New");
	gate.resolve();
	assert.equal((await a).items[0]!.snapshotId, "new");
	assert.equal((await b).items[0]!.snapshotId, "new");
	assert.equal(reads, 2);
	const blocking = deferred<void>();
	const entered = deferred<void>();
	const operation = f.store.runExclusive(async () => { entered.resolve(); await blocking.promise; });
	await entered.promise;
	const save = f.store.save(snapshot("queued"));
	f.setFolder("Third");
	blocking.resolve();
	await operation;
	await assert.rejects(save, /configuration changed/u);
	assert.equal(f.vault.read("Third/knomo-trash.json"), null);
});

test("旧读取不能覆盖新写入 state，卸载后的读取失败", async () => {
	const f = await fixture({ [PATH]: encode([snapshot()]) });
	const read = f.vault.app.vault.read.bind(f.vault.app.vault);
	const gate = deferred<void>();
	let reads = 0;
	f.vault.app.vault.read = async (file) => { const content = await read(file); if (++reads === 1) await gate.promise; return content; };
	const old = f.store.query();
	await f.store.save(snapshot("s2"));
	gate.resolve();
	assert.equal((await old).items.length, 2);
	assert.equal(f.store.getState().count, 2);
	f.cancel();
	assert.equal((await f.store.query()).errors.length, 1);
	assert.equal(f.store.getState().count, null);
});

test("Clear 写后抛错不报告成功、不回滚，已有恢复副本不会被旧 state 重新保存", async () => {
	const f = await fixture({ [PATH]: encode([snapshot()]) });
	await f.store.query();
	const process = f.vault.app.vault.process.bind(f.vault.app.vault);
	f.vault.app.vault.process = async (file, update) => { await process(file, update); throw new Error("clear uncertain"); };
	await assert.rejects(f.store.clear(), /clear uncertain/u);
	assert.equal(f.store.getState().count, null);
	assert.equal(f.vault.read(PATH), encode([]));
	assert.equal((await f.store.query()).items.length, 0);
});

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => { resolve = res; });
	return { promise, resolve };
}


test("文件及父目录事件失效；Daily、Monthly、开发残留不触发 Trash 读取", async () => {
 const f = await fixture({ [PATH]: encode([snapshot()]) });
 let reads = 0; const read = f.vault.app.vault.read.bind(f.vault.app.vault);
 f.vault.app.vault.read = async (file) => { reads++; return read(file); };
 await f.store.query(); let notifications = 0;
 const unsubscribe = f.store.subscribe(() => { notifications++; });
 for (const path of ["Daily/2026-09-09.md", "Monthly/Memos-2026-09.md", "_knomo-data/trash/s1.json", "Monthly/knomo-trash.json.bak"]) f.store.handleFileChange(path);
 await f.store.query(); assert.equal(reads, 1); assert.equal(notifications, 0);
 for (const [path, oldPath] of [[PATH], [PATH], [PATH], ["Moved.json", PATH], [PATH, "Moved.json"], ["Moved", "Monthly"], ["Monthly"]]) {
  f.store.handleFileChange(path!, oldPath);
  assert.equal(f.store.getState().count, null);
 }
 assert.equal(reads, 1); assert.equal(notifications, 7);
 await f.store.query(); assert.equal(reads, 2);
 unsubscribe(); const before = notifications; f.store.invalidate(); assert.equal(notifications, before);
});

test("外部删除和迁入精确目标后重读；订阅实例共享本地发布而无需再读", async () => {
 const f = await fixture({ [PATH]: encode([snapshot()]) }); const another = f.another();
 await f.store.query(); assert.equal(another.getState().count, 1);
 f.vault.remove(PATH); f.store.handleFileChange(PATH); await f.store.query();
 assert.deepEqual(another.getState().items, []);
 await f.vault.app.vault.create(PATH, encode([snapshot("incoming")]));
 f.store.handleFileChange(PATH, "Other/file.json"); await f.store.query();
 assert.equal(another.getState().items?.[0]?.snapshotId, "incoming");
 await another.save(snapshot("s2")); assert.equal(f.store.getState().count, 2);
});

test("旧读取失败及持续外部变化均不发布旧 count 或伪空；重试有界", async () => {
 const f = await fixture({ [PATH]: encode([snapshot()]), "New/knomo-trash.json": encode([snapshot("new")]) });
 const read = f.vault.app.vault.read.bind(f.vault.app.vault); const gate = deferred<void>(); let first = true;
 f.vault.app.vault.read = async (file) => { if (first) { first = false; await gate.promise; throw new Error("old read failed"); } return read(file); };
 const pending = f.store.query(); await Promise.resolve(); f.setFolder("New"); f.store.invalidateConfiguration(); gate.resolve();
 assert.equal((await pending).items[0]?.snapshotId, "new");
 let reads = 0;
 f.vault.app.vault.read = async (file) => { reads++; const text = await read(file); f.store.handleFileChange(file.path); return text; };
 f.store.invalidate(); const result = await f.store.query();
 assert.equal(reads, 3); assert.equal(result.errors.length, 1);
 assert.equal(f.store.getState().status, "error"); assert.equal(f.store.getState().count, null);
});

test("Daily 配置变化取消旧操作但不丢弃同一路径 Trash state", async () => {
 const f = await fixture({ [PATH]: encode([snapshot()]) }); await f.store.query();
 const gate = deferred<void>(); const entered = deferred<void>();
 const pending = f.store.runExclusive(async (store) => { entered.resolve(); await gate.promise; store.assertActive(); });
 await entered.promise; f.store.invalidateConfiguration(false); gate.resolve();
 await assert.rejects(pending, /configuration changed/);
 assert.equal(f.store.getState().count, 1);
});

test("写后校验期间同步覆盖不发布成功，保留外部内容并报告结果不确定", async () => {
 const f = await fixture({ [PATH]: encode([snapshot()]) });
 const read = f.vault.app.vault.read.bind(f.vault.app.vault); let changed = false;
 f.vault.app.vault.read = async (file) => { const text = await read(file); if (!changed) { changed = true;
  f.vault.replace(PATH, encode([snapshot("external")])); f.store.handleFileChange(PATH);
 } return text; };
 await assert.rejects(f.store.save(snapshot("s2")), /changed during write verification/);
 assert.equal(f.store.getState().status, "error"); assert.equal(f.store.getState().count, null);
 assert.equal(f.vault.read(PATH), encode([snapshot("external")]));
});


test("卸载释放共享缓存及订阅，旧请求晚返回不覆盖重启实例的新状态", async () => {
 const f = await fixture({ [PATH]: encode([snapshot()]) });
 const gate = deferred<void>(); const read = f.vault.app.vault.read.bind(f.vault.app.vault); let first = true; let notifications = 0;
 f.vault.app.vault.read = async (file) => { const text = await read(file); if (first) { first = false; await gate.promise; } return text; };
 f.store.subscribe(() => { notifications++; });
 const old = f.store.query(); await Promise.resolve(); f.store.dispose();
 const before = notifications; f.vault.replace(PATH, encode([snapshot("new")]));
 const next = f.another(); await next.query(); gate.resolve(); await old;
 assert.equal(next.getState().items?.[0]?.snapshotId, "new");
 assert.equal(notifications, before);
 assert.equal(f.store.getState().status, "error");
 await assert.rejects(f.store.clear(), /disposed/);
});


test("订阅 loading 时重入查询仍共享同一次读取", async () => {
 const f = await fixture({ [PATH]: encode([snapshot()]) });
 let reads = 0; const read = f.vault.app.vault.read.bind(f.vault.app.vault);
 f.vault.app.vault.read = async (file) => { reads++; return read(file); };
 let nested: Promise<import("../src/types/trash").TrashQueryResult> | undefined;
 f.store.subscribe(() => { if (f.store.getState().status === "loading") nested = f.store.query(); });
 const result = await f.store.query(); await nested;
 assert.equal(reads, 1); assert.equal(result.items.length, 1);
});

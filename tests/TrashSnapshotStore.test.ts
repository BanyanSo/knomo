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

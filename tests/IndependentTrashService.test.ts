import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import type { TFile } from "obsidian";
import { ensureObsidianStub } from "./helpers/obsidianStub";

const PATH = "Daily/2026-09-08.md";
const BODY = "## Memos\n- 10:30 same memo\n- 10:30 same memo\n";

test("生产 runtime 取消后拒绝提交已准备的删除，保留快照且不改 Daily", async () => {
	const f = await fixture();
	let active = true;
	f.options.assertActive = () => { if (!active) throw new Error("runtime cancelled"); };
	const create = f.vault.app.vault.create.bind(f.vault.app.vault);
	f.vault.app.vault.create = async (path, content) => {
		const file = await create(path, content);
		if (path.endsWith(".json")) active = false;
		return file;
	};
	await assert.rejects(() => f.service.delete(f.initial[0]!), /runtime cancelled/u);
	assert.equal(f.vault.read(PATH), BODY);
	assert.equal((await f.store.query()).items.length, 1);
	assert.equal(f.events.includes("daily-process"), false);
});

test("snapshot-first 删除同文 occurrence，独立 ID、独立 restore/purge，时间与 raw block 保留", async () => {
	const f = await fixture();
	const original = await f.observations();
	const first = await f.service.delete(original[1]!);
	assert.equal(first.state, "deleted");
	assert.equal(f.vault.read(PATH), "## Memos\n- 10:30 same memo\n");
	assert.deepEqual(f.events.slice(0, 3), ["snapshot-create", "snapshot-read", "snapshot-read"]);
	assert.ok(f.events.indexOf("daily-process") > f.events.indexOf("snapshot-read"));
	await assert.rejects(() => f.service.delete(original[0]!));
	assert.equal((await f.store.query()).items.length, 1);
	const second = await f.service.delete((await f.observations())[0]!);
	assert.notEqual(first.snapshotId, second.snapshotId);
	const snapshots = (await f.store.query()).items;
	assert.equal(snapshots.length, 2);
	assert.equal(snapshots[0]!.rawBlock, snapshots[1]!.rawBlock);
	await f.service.restore(first.snapshotId);
	await f.service.restore(second.snapshotId);
	assert.equal((await f.observations()).length, 2);
	assert.equal(f.vault.read(PATH), BODY);
	assert.equal((await f.store.query()).items.length, 0);
	const third = await f.service.delete((await f.observations())[0]!);
	const fourth = await f.service.delete((await f.observations())[0]!);
	const beforePurge = f.vault.read(PATH);
	await f.service.purge(third.snapshotId);
	assert.equal(f.vault.read(PATH), beforePurge);
	assert.deepEqual((await f.store.query()).items.map((item) => item.snapshotId), [fourth.snapshotId]);
});

test("初始 stale 不保存快照；快照创建/读回失败、损坏和保存期间 Daily 变化均不删除", async (context) => {
	for (const failure of ["initial-stale", "create", "read", "corrupt", "daily-change"] as const) {
		await context.test(failure, async () => {
			const f = await fixture();
			const handle = (await f.observations())[0]!;
			const create = f.vault.app.vault.create.bind(f.vault.app.vault);
			f.vault.app.vault.create = async (path, content) => {
				if (path.endsWith(".json") && failure === "create") throw new Error("snapshot write failed");
				const file = await create(path, content);
				if (path.endsWith(".json") && failure === "corrupt") f.vault.replace(path, "{}");
				if (path.endsWith(".json") && failure === "daily-change") f.vault.replace(PATH, `external\n${BODY}`);
				return file;
			};
			const read = f.vault.app.vault.read.bind(f.vault.app.vault);
			f.vault.app.vault.read = async (file) => {
				if (file.path.endsWith(".json") && failure === "read") throw new Error("snapshot read failed");
				return read(file);
			};
			if (failure === "initial-stale") f.vault.replace(PATH, `external\n${BODY}`);
			await assert.rejects(() => f.service.delete(handle));
			assert.equal(f.vault.read(PATH), failure === "daily-change" || failure === "initial-stale" ? `external\n${BODY}` : BODY);
			if (failure === "initial-stale") assert.equal(f.events.includes("snapshot-create"), false);
		});
	}
});

test("Daily I/O 不确定保留快照并报告重读状态，不补删也不回滚", async (context) => {
	for (const afterWrite of [false, true]) {
		await context.test(String(afterWrite), async () => {
			const f = await fixture();
			const process = f.vault.app.vault.process.bind(f.vault.app.vault);
			let writes = 0;
			f.vault.app.vault.process = async (file, update) => {
				writes++;
				if (afterWrite) await process(file, update);
				throw new Error("I/O uncertain");
			};
			await assert.rejects(() => f.service.delete(f.initial[0]!), (error: unknown) => {
				assert.equal((error as { dailyState: string }).dailyState, afterWrite ? "after" : "before");
				return true;
			});
			assert.equal(writes, 1);
			assert.equal((await f.store.query()).items.length, 1);
			assert.equal((await f.observations()).length, afterWrite ? 1 : 2);
		});
	}
});

test("Catalog 失败不回滚 Daily；快照保持独立可查询", async () => {
	const f = await fixture();
	f.options.updateCatalogPartition = async () => { throw new Error("IDB unavailable"); };
	const result = await f.service.delete(f.initial[0]!);
	assert.equal(result.catalogUpdatePending, true);
	assert.equal(f.refreshes.length, 1);
	assert.equal((await f.observations()).length, 1);
	assert.equal((await f.store.query()).items.length, 1);
});

test("restore 原路径优先、原路径失效按日期配置追加；不跟踪历史文件移动", async () => {
	const f = await fixture("## Memos\n- 10:30:27 memo\n  continuation\n");
	const deleted = await f.service.delete(f.initial[0]!);
	const snapshot = await f.store.read(deleted.snapshotId);
	assert.equal(snapshot.rawBlock, "- 10:30:27 memo\n  continuation");
	f.vault.remove(PATH);
	f.options.getOriginalDailyFile = async () => null;
	const restored = await f.service.restore(deleted.snapshotId);
	assert.equal(restored.observation?.time, "10:30:27");
	assert.equal(restored.observation?.sourcePath, "NewDaily/2026-09-08.md");
	assert.match(f.vault.read("NewDaily/2026-09-08.md")!, /10:30:27 memo\n  continuation/u);
});

test("restore blockId 冲突检查覆盖 Memo 外锚点，损坏 snapshot 不被覆盖或消费", async () => {
	const f = await fixture("## Memos\n- 10:30 memo ^anchor\n");
	const deleted = await f.service.delete(f.initial[0]!);
	f.vault.replace(PATH, "ordinary ^anchor\n## Memos\n");
	await assert.rejects(() => f.service.restore(deleted.snapshotId), /block ID/u);
	assert.ok(await f.store.read(deleted.snapshotId));
	f.vault.replace(`_knomo-data/trash/${deleted.snapshotId}.json`, "broken");
	await assert.rejects(() => f.service.restore(deleted.snapshotId));
	await assert.rejects(() => f.service.purge(deleted.snapshotId));
	assert.equal((await f.store.query()).errors.length, 1);
	assert.equal(f.vault.read(`_knomo-data/trash/${deleted.snapshotId}.json`), "broken");
});

test("restore 清理失败后仅重试清理，Daily 后续编辑不被重复追加或旧 Catalog 覆盖", async () => {
	const f = await fixture();
	const deleted = await f.service.delete(f.initial[0]!);
	const remove = f.vault.app.vault.delete.bind(f.vault.app.vault);
	f.vault.app.vault.delete = async () => { throw new Error("cleanup failed"); };
	const restored = await f.service.restore(deleted.snapshotId);
	assert.equal(restored.state, "restored_cleanup_pending");
	assert.match(restored.message!, /正文已恢复/u);
	const calls = f.catalog.length;
	f.vault.replace(PATH, `later edit\n${f.vault.read(PATH)}`);
	const content = f.vault.read(PATH);
	f.vault.app.vault.delete = remove;
	assert.equal((await f.service.restore(deleted.snapshotId)).state, "restored");
	assert.equal(f.vault.read(PATH), content);
	assert.equal(f.catalog.length, calls);
});

test("active editor 更新不当作落盘；未落盘保留 snapshot 且重试不再次追加", async () => {
	const f = await fixture();
	const deleted = await f.service.delete(f.initial[0]!);
	let text = f.vault.read(PATH)!;
	let transactions = 0;
	const file = f.vault.app.vault.getAbstractFileByPath(PATH) as TFile;
	const editor = { getValue: () => text, offsetToPos: () => ({ line: 0, ch: 0 }),
		transaction: (change: { changes: Array<{ text: string }> }) => { transactions++; text = change.changes[0]!.text; } };
	const view = { file, editor };
	f.vault.app.workspace.getActiveViewOfType = (() => view) as typeof f.vault.app.workspace.getActiveViewOfType;
	await assert.rejects(() => f.service.restore(deleted.snapshotId));
	assert.equal(transactions, 1);
	assert.equal((await f.store.query()).items.length, 1);
	await assert.rejects(() => f.service.restore(deleted.snapshotId));
	assert.equal(transactions, 1);
	f.vault.replace(PATH, text);
	assert.equal((await f.service.restore(deleted.snapshotId)).state, "restored");
	assert.equal(transactions, 1);
});

test("snapshot ID 冲突不覆盖；可读但内容被改的读回也拒绝删除", async () => {
	const f = await fixture();
	const deleted = await f.service.delete(f.initial[0]!);
	const snapshot = await f.store.read(deleted.snapshotId);
	await assert.rejects(() => f.store.save({ ...snapshot, rawBlock: "- 10:30 replacement" }));
	assert.equal((await f.store.read(deleted.snapshotId)).rawBlock, snapshot.rawBlock);
	await assert.rejects(() => f.store.read("../escape"));
	const create = f.vault.app.vault.create.bind(f.vault.app.vault);
	f.vault.app.vault.create = async (path, content) => {
		const file = await create(path, content);
		if (path.endsWith(".json")) f.vault.replace(path, JSON.stringify({ ...JSON.parse(content), rawBlock: "- 10:30 changed snapshot" }));
		return file;
	};
	const before = f.vault.read(PATH);
	await assert.rejects(() => f.service.delete((f.initial[0]!)));
	await assert.rejects(async () => f.service.delete((await f.observations())[0]!));
	assert.equal(f.vault.read(PATH), before);
});

test("restore I/O 已落盘却返回失败时保留副本，当前会话重试只清理", async () => {
	const f = await fixture();
	const deleted = await f.service.delete(f.initial[0]!);
	const process = f.vault.app.vault.process.bind(f.vault.app.vault);
	let calls = 0;
	f.vault.app.vault.process = async (file, update) => { calls++; await process(file, update); throw new Error("uncertain restore"); };
	await assert.rejects(() => f.service.restore(deleted.snapshotId), /after/u);
	assert.equal((await f.store.query()).items.length, 1);
	assert.equal((await f.service.restore(deleted.snapshotId)).state, "restored");
	assert.equal(calls, 1);
	assert.equal((await f.observations()).length, 2);
});

test("active editor 基线与磁盘冲突时拒绝；保存快照后磁盘冲突也不能覆盖", async (context) => {
	for (const duringSave of [false, true]) {
		await context.test(String(duringSave), async () => {
			const f = await fixture();
			let transactions = 0;
			const file = f.vault.app.vault.getAbstractFileByPath(PATH) as TFile;
			const view = { file, editor: { getValue: () => BODY, transaction: () => { transactions++; } } };
			f.vault.app.workspace.getActiveViewOfType = (() => view) as typeof f.vault.app.workspace.getActiveViewOfType;
			if (duringSave) {
				const create = f.vault.app.vault.create.bind(f.vault.app.vault);
				f.vault.app.vault.create = async (path, content) => { const result = await create(path, content); f.vault.replace(PATH, "external"); return result; };
			} else f.vault.replace(PATH, "external");
			await assert.rejects(() => f.service.delete(f.initial[0]!));
			assert.equal(f.vault.read(PATH), "external");
			assert.equal(transactions, 0);
			assert.equal((await f.store.query()).items.length, duringSave ? 1 : 0);
		});
	}
});

async function fixture(body = BODY) {
	await ensureObsidianStub();
	const { InMemoryVault } = await import("./helpers/InMemoryVault");
	const { DiaryMemoParser } = await import("../src/services/DiaryMemoParser");
	const { DailyMemoWriteGateway } = await import("../src/services/DailyMemoWriteGateway");
	const { TrashSnapshotStore } = await import("../src/services/TrashSnapshotStore");
	const { IndependentTrashService } = await import("../src/services/IndependentTrashService");
	const vault = new InMemoryVault({ [PATH]: body });
	Object.assign(vault.app, { workspace: { getActiveViewOfType: () => null, containerEl: { win: { setTimeout } } } });
	Object.assign(vault.app.vault, { delete: async (file: TFile) => vault.remove(file.path) });
	const events: string[] = [];
	const create = vault.app.vault.create.bind(vault.app.vault);
	vault.app.vault.create = async (path, content) => { if (path.endsWith(".json")) events.push("snapshot-create"); return create(path, content); };
	const read = vault.app.vault.read.bind(vault.app.vault);
	vault.app.vault.read = async (file) => { if (file.path.endsWith(".json")) events.push("snapshot-read"); return read(file); };
	const process = vault.app.vault.process.bind(vault.app.vault);
	vault.app.vault.process = async (file, update) => { events.push("daily-process"); return process(file, update); };
	const parser = new DiaryMemoParser(async (bytes) => createHash("sha256").update(bytes).digest("hex"));
	const observations = async () => (await parser.parse({ sourcePath: PATH, logicalDate: "2026-09-08", bytes: Buffer.from(vault.read(PATH)!) })).observations;
	const catalog: unknown[] = [];
	const refreshes: unknown[] = [];
	let id = 0;
	const options: import("../src/services/IndependentTrashService").IndependentTrashOptions = {
		getLogicalDateForPath: async () => "2026-09-08",
		getOriginalDailyFile: async (path) => vault.app.vault.getAbstractFileByPath(path) as TFile | null,
		getDailyFileForDate: async (date) => vault.app.vault.create(`NewDaily/${date}.md`, "## Memos\n"),
		updateCatalogPartition: async (input) => { catalog.push(input); }, refreshCatalogPaths: async (paths) => { refreshes.push(paths); },
		newSnapshotId: () => `s_${++id}`, now: () => new Date("2026-09-08T12:00:00Z"),
	};
	const store = new TrashSnapshotStore(vault.app);
	const service = new IndependentTrashService(vault.app, store, options, new DailyMemoWriteGateway(vault.app, parser));
	return { vault, store, service, options, observations, initial: await observations(), events, catalog, refreshes };
}


test("独立 Trash 恢复保留完整 raw block 与分钟或秒精度", async (context) => {
 for (const time of ["10:30", "10:30:00", "10:30:27"]) {
  await context.test(time, async () => {
   const f = await fixture();
   const original = '## Memos\n- ' + time + ' first line\n  continuation\n';
   f.vault.replace(PATH, original);
   const deleted = await f.service.delete((await f.observations())[0]!);
   await f.service.restore(deleted.snapshotId);
   assert.equal(f.vault.read(PATH), original);
   assert.equal((await f.observations())[0]!.time, time);
  });
 }
});

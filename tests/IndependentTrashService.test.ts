import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import type { TFile } from "obsidian";
import { ensureObsidianStub } from "./helpers/obsidianStub";

const PATH = "Daily/2026-09-08.md";
const BODY = "## Memos\n- 10:30 same memo\n- 10:30 same memo\n";

test("生产 runtime 取消后拒绝提交已准备的删除，保留快照且不改 Daily", async () => {
	const f = await fixture();
	await f.store.query();
	assert.equal(f.store.getState().count, 0);
	let active = true;
	f.options.assertActive = () => { if (!active) throw new Error("runtime cancelled"); };
	const create = f.vault.app.vault.create.bind(f.vault.app.vault);
	f.vault.app.vault.create = async (path, content) => {
		const file = await create(path, content);
		if (path.endsWith(".json")) {
			f.store.handleFileChange(path);
			active = false;
		}
		return file;
	};
	await assert.rejects(() => f.service.delete(f.initial[0]!), /runtime cancelled/u);
	assert.equal(f.vault.read(PATH), BODY);
	assert.equal((await f.store.query()).items.length, 1);
	assert.equal(f.store.getState().count, 1);
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
	await f.service.purge(await f.store.read(third.snapshotId));
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
	const snapshot = await f.store.read(deleted.snapshotId);
	f.vault.replace("Knomo/knomo-trash.json", "broken");
	await assert.rejects(() => f.service.restore(deleted.snapshotId));
	await assert.rejects(() => f.service.purge(snapshot));
	assert.equal((await f.store.query()).errors.length, 1);
	assert.equal(f.vault.read("Knomo/knomo-trash.json"), "broken");
});

test("restore 清理失败后仅重试清理，Daily 后续编辑不被重复追加或旧 Catalog 覆盖", async () => {
	const f = await fixture();
	const deleted = await f.service.delete(f.initial[0]!);
	const process = f.vault.app.vault.process.bind(f.vault.app.vault);
	f.vault.app.vault.process = async (file, update) => {
		if (file.path.endsWith(".json")) throw new Error("cleanup failed");
		return process(file, update);
	};
	const restored = await f.service.restore(deleted.snapshotId);
	assert.equal(restored.state, "restored_cleanup_pending");
	assert.match(restored.message!, /正文已恢复|Content restored/u);
	const calls = f.catalog.length;
	f.vault.replace(PATH, `later edit\n${f.vault.read(PATH)}`);
	const content = f.vault.read(PATH);
	f.vault.app.vault.process = process;
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
	const process = f.vault.app.vault.process.bind(f.vault.app.vault);
	f.vault.app.vault.process = async (file, update) => {
		const result = await process(file, update);
		if (file.path.endsWith(".json")) {
			const collection = JSON.parse(result);
			collection.items.at(-1).rawBlock = "- 10:30 changed snapshot";
			f.vault.replace(file.path, JSON.stringify(collection));
		}
		return result;
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
	f.vault.app.vault.process = async (file, update) => {
		if (file.path.endsWith(".json")) return process(file, update);
		calls++; await process(file, update); throw new Error("uncertain restore");
	};
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
	vault.app.vault.process = async (file, update) => { events.push(file.path.endsWith(".json") ? "snapshot-process" : "daily-process"); return process(file, update); };
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
	let folder = "Knomo";
	const store = new TrashSnapshotStore(vault.app, () => folder);
	const service = new IndependentTrashService(vault.app, store, options, new DailyMemoWriteGateway(vault.app, parser));
	return { vault, store, service, options, observations, initial: await observations(), events, catalog, refreshes,
		setFolder: (value: string) => { folder = value; } };
}


test("Trash 创建已落盘后抛错仍禁止 Daily 删除，保留快照并明确报告", async () => {
	const f = await fixture();
	const create = f.vault.app.vault.create.bind(f.vault.app.vault);
	f.vault.app.vault.create = async (path, content) => { await create(path, content); throw new Error("write uncertain"); };
	await assert.rejects(f.service.delete(f.initial[0]!), /write uncertain/u);
	assert.equal(f.vault.read(PATH), BODY);
	assert.equal((await f.store.query()).items.length, 1);
	assert.equal(f.events.includes("daily-process"), false);
});

test("Purge 验证选择时完整内容，Clear 只清空合法集合，不修改 Daily 或 Monthly", async () => {
	const f = await fixture();
	const result = await f.service.delete(f.initial[0]!);
	const selected = await f.store.read(result.snapshotId);
	const changed = { ...selected, rawBlock: "- 10:30 external replacement" };
	f.vault.replace(f.store.path, JSON.stringify({ kind: "knomo-trash", items: [changed] }));
	await assert.rejects(f.service.purge(selected), /changed/u);
	assert.deepEqual(await f.store.read(result.snapshotId), changed);
	await f.vault.app.vault.create("Knomo/Memos-2026-09.md", "monthly projection");
	const daily = f.vault.read(PATH);
	await f.service.clear();
	assert.equal((await f.store.query()).items.length, 0);
	assert.equal(f.vault.read(PATH), daily);
	assert.equal(f.vault.read("Knomo/Memos-2026-09.md"), "monthly projection");
	f.vault.replace(f.store.path, "broken");
	await assert.rejects(f.service.clear());
	assert.equal(f.vault.read(f.store.path), "broken");
});

test("Clear 与正在进行的 Delete 共用 Store 锁，必须等待 Daily 提交后再清空", async () => {
	const f = await fixture();
	const gate = promiseGate();
	const entered = promiseGate();
	const process = f.vault.app.vault.process.bind(f.vault.app.vault);
	f.vault.app.vault.process = async (file, update) => {
		if (file.path === PATH) { entered.resolve(); await gate.promise; }
		return process(file, update);
	};
	const deletion = f.service.delete(f.initial[0]!);
	await entered.promise;
	let cleared = false;
	const clear = f.store.clear().then(() => { cleared = true; });
	await Promise.resolve();
	assert.equal(cleared, false);
	assert.equal(JSON.parse(f.vault.read(f.store.path)!).items.length, 1);
	gate.resolve();
	assert.equal((await deletion).state, "deleted");
	await clear;
	assert.equal((await f.observations()).length, 1);
});

test("Restore 清理写后抛错和读回失败只重试清理，目录切换与 Clear 不丢失防重状态", async (context) => {
	for (const failure of ["after-write", "readback", "folder-clear"] as const) {
		await context.test(failure, async () => {
			const f = await fixture();
			const deleted = await f.service.delete(f.initial[0]!);
			const selected = await f.store.read(deleted.snapshotId);
			const process = f.vault.app.vault.process.bind(f.vault.app.vault);
			const read = f.vault.app.vault.read.bind(f.vault.app.vault);
			let cleanup = false;
			f.vault.app.vault.process = async (file, update) => {
				if (file.path.endsWith(".json")) {
					cleanup = true;
					if (failure === "folder-clear") throw new Error("cleanup failed");
					const result = await process(file, update);
					if (failure === "after-write") throw new Error("cleanup uncertain");
					return result;
				}
				return process(file, update);
			};
			f.vault.app.vault.read = async (file) => {
				if (cleanup && failure === "readback" && file.path.endsWith(".json")) throw new Error("readback failed");
				return read(file);
			};
			assert.equal((await f.service.restore(deleted.snapshotId)).state, "restored_cleanup_pending");
			f.vault.app.vault.process = process;
			f.vault.app.vault.read = read;
			const daily = f.vault.read(PATH);
			if (failure === "folder-clear") {
				f.setFolder("New");
				await f.store.save(selected);
				await f.service.clear();
			}
			assert.equal((await f.service.restore(deleted.snapshotId)).state, "restored");
			assert.equal(f.vault.read(PATH), daily);
		});
	}
});

test("快照保存期间路径配置切换拒绝删除；原位置保留快照", async () => {
	const f = await fixture();
	const create = f.vault.app.vault.create.bind(f.vault.app.vault);
	f.vault.app.vault.create = async (path, content) => { const result = await create(path, content); f.setFolder("New"); return result; };
	await assert.rejects(f.service.delete(f.initial[0]!), /configuration changed/u);
	assert.equal(f.vault.read(PATH), BODY);
	assert.equal(JSON.parse(f.vault.read("Knomo/knomo-trash.json")!).items.length, 1);
	assert.equal(f.vault.read("New/knomo-trash.json"), null);
});

function promiseGate() {
	let resolve!: () => void;
	const promise = new Promise<void>((res) => { resolve = res; });
	return { promise, resolve };
}

test("Daily gateway 最终回调期间发生配置变化或 Trash 外部事件，拒绝旧删除", async (context) => {
	for (const change of ["configuration", "trash"] as const) {
		await context.test(change, async () => {
			const f = await fixture();
			const process = f.vault.app.vault.process.bind(f.vault.app.vault);
			f.vault.app.vault.process = async (file, update) => {
				if (file.path === PATH) {
					if (change === "configuration") f.store.invalidateConfiguration();
					else f.store.invalidate();
				}
				return process(file, update);
			};
			await assert.rejects(f.service.delete(f.initial[0]!), /Trash.*changed/u);
			assert.equal(f.vault.read(PATH), BODY);
			assert.equal((await f.store.query()).items.length, 1);
		});
	}
});

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

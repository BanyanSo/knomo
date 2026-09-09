import assert from "node:assert/strict";
import test from "node:test";
import { ensureObsidianStub } from "./helpers/obsidianStub";
import { hashMemoContent, hashText } from "../src/utils/hash";

const INDEX = "Knomo/_knomo-system/indexes/memo-index-2026-08.json";
const ROOT = "Knomo/_knomo-data";
const DAILY = "Daily/2026-08-22.md";
const RAW = "- 09:00 同文恢复副本";

async function fixture(monthly = "Knomo") {
	await ensureObsidianStub();
	const { InMemoryVault } = await import("./helpers/InMemoryVault");
	const { LegacyIndexReader } = await import("../src/services/LegacyIndexReader");
	const { LegacyTrashMigrationService } = await import("../src/services/LegacyTrashMigrationService");
	const { TrashSnapshotStore } = await import("../src/services/TrashSnapshotStore");
	const record = (id: string, status = "deleted") => ({ id, status, createdAt: "2026-08-22T09:00:00.000Z", updatedAt: "2026-08-22T10:00:00.000Z",
		contentHash: hashMemoContent("同文恢复副本"), contentSnapshot: "同文恢复副本", sourceMemoId: null,
		deletedAt: "2026-08-22T10:00:00.000Z", deletedDailyBlock: RAW,
		dailyRef: { path: DAILY, heading: "## Memos", sectionType: "heading", lastKnownBlock: RAW, lastKnownHash: hashText(RAW), lineNumberHint: 2 } });
	const index = JSON.stringify({ schemaVersion: 2, period: "2026-08", memos: {
		"2026082209000001": record("2026082209000001"), "2026082209000002": record("2026082209000002"),
		"2026082209000003": record("2026082209000003", "active") } });
	const vault = new InMemoryVault({ [`${monthly}/_knomo-system/indexes/memo-index-2026-08.json`]: index, [DAILY]: "## Memos\n- 10:30 当前 Daily\n" });
	Object.assign(vault.app, { metadataCache: { getFirstLinkpathDest: () => null } });
	Object.assign(vault.app.vault, { delete: async (file: { path: string }) => {
		for (const path of vault.paths()) if (path.startsWith(`${file.path}/`)) vault.remove(path);
		vault.remove(file.path);
	} });
	const reader = new LegacyIndexReader(vault.app, () => monthly);
	let sourceReads = 0;
	let settingsWrites = 0;
	const load = reader.load.bind(reader);
	reader.load = async (runtime) => { sourceReads++; return load(runtime); };
	const { PluginDataStore } = await import("../src/services/PluginDataStore");
	const { extractLegacyMigration } = await import("../src/utils/pluginData");
	let data: unknown = { settings: { monthlyMemoFolder: monthly, custom: "keep" }, other: 42 };
	const plugin = { loadData: async () => structuredClone(data), saveData: async (next: unknown) => { data = structuredClone(next); } };
	const pluginDataStore = new PluginDataStore(plugin as import("obsidian").Plugin);
	const options = { pluginDataStore, getTrashFolder: () => monthly, migrateSettings: async () => { settingsWrites++; } };
	return { vault, reader, options, make: () => new LegacyTrashMigrationService(vault.app, reader, options),
		store: new TrashSnapshotStore(vault.app, monthly), completion: { read: async () => extractLegacyMigration(await pluginDataStore.read()) }, plugin, data: () => data,
		sourceReads: () => sourceReads, settingsWrites: () => settingsWrites, index };
}

test("正式 Legacy reader 迁移仅保留独立 Trash；活动 Memo 不写 Daily，completion 后不读源或快照", async () => {
	const f = await fixture();
	assert.equal((await f.make().run()).status, "attention");
	assert.equal(f.sourceReads(), 0);
	assert.equal((await f.make().run({ explicit: true })).status, "ready");
	const snapshots = (await f.store.query()).items;
	assert.equal(snapshots.length, 2);
	assert.notEqual(snapshots[0]!.snapshotId, snapshots[1]!.snapshotId);
	assert.equal(snapshots[0]!.rawBlock, snapshots[1]!.rawBlock);
	assert.equal(f.vault.read(DAILY), "## Memos\n- 10:30 当前 Daily\n");
	assert.equal(f.vault.read(INDEX), null);
	assert.equal(f.settingsWrites(), 1);
	const { IndependentTrashService } = await import("../src/services/IndependentTrashService");
	const { TFile } = await import("obsidian");
	Object.assign(f.vault.app, { workspace: { getActiveViewOfType: () => null, containerEl: { win: { setTimeout } } } });
	const trash = new IndependentTrashService(f.vault.app, f.store, {
		getLogicalDateForPath: async () => "2026-08-22",
		getOriginalDailyFile: async () => f.vault.app.vault.getAbstractFileByPath(DAILY) as InstanceType<typeof TFile>,
		getDailyFileForDate: async () => { throw new Error("Original Daily should be used."); },
		updateCatalogPartition: async () => undefined, refreshCatalogPaths: async () => undefined,
	});
	assert.equal((await trash.restore(snapshots[0]!.snapshotId)).state, "restored");
	await f.store.remove(snapshots[1]!);
	const { indexedDB, IDBKeyRange } = await import("fake-indexeddb");
	const { IndexedDbMemoCatalogStore } = await import("../src/services/IndexedDbMemoCatalogStore");
	const databaseName = "p6-migration-rebuild";
	const local = new IndexedDbMemoCatalogStore(databaseName, { factory: indexedDB, keyRange: IDBKeyRange });
	await local.open();
	await local.setMeta("legacyMigrationCompletion", { unrelatedOldCache: true });
	await local.close();
	await new Promise<void>((resolve, reject) => {
		const request = indexedDB.deleteDatabase(databaseName);
		request.onsuccess = () => resolve(); request.onerror = () => reject(request.error);
	});
	await local.open();
	assert.equal(await local.getMeta("legacyMigrationCompletion"), null);
	await local.close();
	// 新 runtime 只读取插件完成事实；restore/purge 后不检查已消费目标。
	f.reader.inspect = () => { throw new Error("Completed source must be inert."); };
	f.reader.load = async () => { throw new Error("Completed source must not be loaded."); };
	assert.equal((await f.make().run({ explicit: true })).status, "ready");
	assert.equal((await f.store.query()).items.length, 0);
});

test("中断后确定性重试，已有同 ID 副本不覆盖，completion 保存/读取故障不报告成功", async (context) => {
	for (const failure of ["second-snapshot", "settings", "data-save", "data-read"] as const) {
		await context.test(failure, async () => {
			const f = await fixture();
			let enabled = true;
			const process = f.vault.app.vault.process.bind(f.vault.app.vault);
			f.vault.app.vault.process = async (file, update) => {
				if (file.path.endsWith("knomo-trash.json") && enabled && failure === "second-snapshot") throw new Error("interrupt");
				return process(file, update);
			};
			const save = f.plugin.saveData;
			f.plugin.saveData = async (data) => { if (enabled && failure === "data-save") throw new Error("save failed"); await save(data); };
			const read = f.plugin.loadData;
			f.plugin.loadData = async () => { if (enabled && failure === "data-read") throw new Error("read failed"); return read(); };
			f.options.migrateSettings = async () => { if (enabled && failure === "settings") throw new Error("settings"); };
			assert.equal((await f.make().run({ explicit: true })).status, "unavailable");
			assert.equal(f.vault.read(INDEX), f.index);
			const before = (await f.store.query()).items;
			enabled = false;
			assert.equal((await f.make().run({ explicit: true })).status, "ready");
			const after = (await f.store.query()).items;
			assert.equal(after.length, 2);
			for (const snapshot of before) assert.deepEqual(after.find((item) => item.snapshotId === snapshot.snapshotId), snapshot);
			assert.ok(await f.completion.read());
		});
	}
});

test("同 ID 内容不符拒绝覆盖；缺失 completion 不自动重导入", async () => {
	const f = await fixture();
	f.options.migrateSettings = async () => { throw new Error("interrupt before completion"); };
	await f.make().run({ explicit: true });
	const snapshot = (await f.store.query()).items[0]!;
	const path = f.store.path;
	const changed = JSON.stringify({ kind: "knomo-trash", items: JSON.parse(f.vault.read(path)!).items.map((item: typeof snapshot) =>
		item.snapshotId === snapshot.snapshotId ? { ...item, rawBlock: "- 09:00 different" } : item) });
	f.vault.replace(path, changed);
	f.options.migrateSettings = async () => undefined;
	assert.equal((await f.make().run({ explicit: true })).status, "unavailable");
	assert.equal(f.vault.read(path), changed);
	assert.equal(await f.completion.read(), null);
	f.vault.remove(path);
	const reads = f.sourceReads();
	assert.equal((await f.make().run()).status, "attention");
	assert.equal(f.sourceReads(), reads);
});

test("迁移中源 revision 变化不落 completion，下一次显式重试才完成", async () => {
	const f = await fixture();
	const load = f.reader.load.bind(f.reader);
	let count = 0;
	f.reader.load = async (runtime) => { const result = await load(runtime); if (++count === 2 && result.kind === "ready") result.snapshot.sourceRevision = "changed"; return result; };
	assert.equal((await f.make().run({ explicit: true })).status, "unavailable");
	assert.equal(await f.completion.read(), null);
	assert.equal((await f.make().run({ explicit: true })).status, "ready");
});

test("生产入口依赖图不包含旧 Identity/current-state/writer/receipts/config runtime", async () => {
	const { build } = await import("esbuild");
	const result = await build({ entryPoints: ["src/main.ts"], bundle: true, write: false, metafile: true,
		platform: "browser", format: "cjs", external: ["obsidian", "electron", "@codemirror/*", "@lezer/*"] });
	const modules = Object.keys(result.metafile!.inputs);
	for (const name of ["IdentityLedgerService", "KnomoCurrentStateStore", "LocalWriterIdentityService", "IdentityReceiptStore",
		"KnomoSharedConfigService", "KnomoBootstrapStateStore", "HistoricalIdentityBootstrapService", "IdentityRevisionTransitionQueue",
		"LegacyIndexMigrationService", "KnomoDataRootMigrationService", "SharedReplicaCache"]) {
		assert.equal(modules.some((path) => path.endsWith(`/${name}.ts`)), false, name);
	}
	assert.ok(modules.some((path) => path.endsWith("/IndependentTrashService.ts")));
	assert.ok(modules.some((path) => path.endsWith("/LegacyTrashMigrationService.ts")));
});

test("旧 review、pending 和历史 relation 损坏不阻断有效 Trash 的正式迁移", async () => {
	const f = await fixture();
	await f.vault.app.vault.create("Knomo/_knomo-system/pending-memo-creates.json", "invalid journal");
	const index = JSON.parse(f.index);
	for (const record of Object.values(index.memos) as Record<string, unknown>[]) {
		record.sourceMemoId = "invalid retired relation";
	}
	f.vault.replace(INDEX, JSON.stringify(index));
	f.vault.app.vault.adapter.readBinary = async () => { throw new Error("Retired review must not be read"); };
	Object.assign(f.vault.app, { metadataCache: { getFirstLinkpathDest: () => { throw new Error("Retired relation must not resolve"); } } });
	assert.equal((await f.make().run({ explicit: true })).status, "ready");
	assert.equal((await f.store.query()).items.length, 2);
	assert.notEqual(await f.completion.read(), null);
	assert.equal(f.vault.read(DAILY), "## Memos\n- 10:30 当前 Daily\n");
});

test("completion 持久化是清理提交点；保留设置，自定义目录与设置改变后重启只清理原目录", async () => {
	const f = await fixture("Archive/Custom");
	await f.vault.app.vault.create("Archive/Custom/2026-08.md", "Monthly");
	await f.vault.app.vault.create("Changed/_knomo-system/keep.json", "keep");
	const remove = f.vault.app.vault.delete;
	let fail = true;
	f.vault.app.vault.delete = async (file, force) => {
		assert.equal((await f.completion.read())?.completed, true);
		if (fail) throw new Error("cleanup failed");
		return remove(file, force);
	};
	assert.equal((await f.make().run({ explicit: true })).diagnostics[0]?.code, "legacy_cleanup_failed");
	assert.equal((await f.completion.read())?.legacySystemRoot, "Archive/Custom/_knomo-system");
	assert.deepEqual((f.data() as Record<string, unknown>).settings, { monthlyMemoFolder: "Archive/Custom", custom: "keep" });
	assert.equal((f.data() as Record<string, unknown>).other, 42);
	f.reader.inspect = () => { throw new Error("must not rediscover current Monthly"); };
	fail = false;
	assert.equal((await f.make().run()).status, "ready");
	assert.equal(await f.vault.app.vault.adapter.exists("Archive/Custom/_knomo-system"), false);
	assert.equal(f.vault.read("Archive/Custom/2026-08.md"), "Monthly");
	assert.equal(f.vault.read("Changed/_knomo-system/keep.json"), "keep");
	assert.equal((await f.make().run()).status, "ready");
	assert.equal(f.vault.read(`${ROOT}/legacy-index-completion.json`), null);
});

test("异常 cleanup 路径及普通文件安全失败，保留完成事实", async () => {
	for (const path of ["", "_knomo-system", "Knomo", "../Knomo/_knomo-system", "/Knomo/_knomo-system", "C:/Knomo/_knomo-system", "Knomo/../_knomo-system", ".obsidian/_knomo-system", "Knomo/_knomo-system/nested/_knomo-system", "Plain/_knomo-system"]) {
		const f = await fixture();
		await f.vault.app.vault.create("Plain/_knomo-system", "ordinary file");
		await f.plugin.saveData({ legacyMigration: { completed: true, legacySystemRoot: path, sourceRevision: "a".repeat(64) } });
		assert.equal((await f.make().run()).diagnostics[0]?.code, "legacy_cleanup_failed", path);
		assert.equal((await f.completion.read())?.completed, true);
		assert.equal(f.vault.read(INDEX), f.index);
		assert.equal(f.vault.read("Plain/_knomo-system"), "ordinary file");
	}
});

test("无字段与旧式普通设置均可写 completion；之后设置保存保留 completion", async () => {
	const { buildPluginDataWithSettings } = await import("../src/utils/pluginData");
	for (const initial of [null, { monthlyMemoFolder: "Custom", custom: "keep" }]) {
		const f = await fixture();
		await f.plugin.saveData(initial);
		assert.equal((await f.make().run({ explicit: true })).status, "ready");
		assert.deepEqual((f.data() as Record<string, unknown>).settings, initial);
		const completion = await f.completion.read();
		await f.options.pluginDataStore.mutate(data => ({ nextData: buildPluginDataWithSettings(data, { monthlyMemoFolder: "Changed" } as import("../src/types/settings").KnomoSettings), result: undefined }));
		assert.deepEqual(await f.completion.read(), completion);
	}
});

test("开发期 marker 不读取、不吸收、不清理，正式迁移仍须显式执行", async (context) => {
	for (const bytes of [JSON.stringify({ sourceId: "legacy-index:Knomo", sourceRevision: "a".repeat(64), legacySystemRoot: "Knomo/_knomo-system" }), "{}", "broken JSON"]) {
		await context.test(bytes, async () => {
			const f = await fixture();
			const path = `${ROOT}/legacy-index-completion.json`;
			await f.vault.app.vault.create(path, bytes);
			const read = f.vault.app.vault.read.bind(f.vault.app.vault);
			f.vault.app.vault.read = async (file) => { assert.notEqual(file.path, path); return read(file); };
			const exists = f.vault.app.vault.adapter.exists.bind(f.vault.app.vault.adapter);
			f.vault.app.vault.adapter.exists = async (candidate) => { assert.notEqual(candidate, path); return exists(candidate); };
			const remove = f.vault.app.vault.delete;
			f.vault.app.vault.delete = async (file, force) => { assert.notEqual(file.path, path); return remove(file, force); };
			assert.equal((await f.make().run()).status, "attention");
			assert.equal(f.sourceReads(), 0);
			assert.equal(await f.completion.read(), null);
			assert.equal(f.vault.read(INDEX), f.index);
			assert.equal((await f.make().run({ explicit: true })).status, "ready");
			assert.equal((await f.store.query()).items.length, 2);
			assert.equal(f.settingsWrites(), 1);
			assert.notEqual((await f.completion.read())?.sourceRevision, "a".repeat(64));
			assert.equal(f.vault.read(INDEX), null);
			assert.equal(f.vault.read(path), bytes);
			const reads = f.sourceReads();
			assert.equal((await f.make().run()).status, "ready");
			assert.equal(f.sourceReads(), reads);
			assert.equal(f.vault.read(path), bytes);
		});
	}
});

test("data.json completion 损坏时不 fallback 到开发期 marker", async () => {
	const f = await fixture();
	await f.vault.app.vault.create(`${ROOT}/legacy-index-completion.json`, JSON.stringify({ sourceId: "legacy-index:Knomo", sourceRevision: "a".repeat(64), legacySystemRoot: "Knomo/_knomo-system" }));
	await f.plugin.saveData({ legacyMigration: { completed: false } });
	assert.equal((await f.make().run({ explicit: true })).status, "unavailable");
	assert.equal(f.sourceReads(), 0);
	assert.equal(f.vault.read(INDEX), f.index);
	assert.deepEqual(f.data(), { legacyMigration: { completed: false } });
});

import assert from "node:assert/strict";
import test from "node:test";
import { ensureObsidianStub } from "./helpers/obsidianStub";
import { hashMemoContent, hashText } from "../src/utils/hash";

const INDEX = "Knomo/_knomo-system/indexes/memo-index-2026-08.json";
const ROOT = "Knomo/_knomo-data";
const DAILY = "Daily/2026-08-22.md";
const RAW = "- 09:00 同文恢复副本";

async function fixture() {
	await ensureObsidianStub();
	const { InMemoryVault } = await import("./helpers/InMemoryVault");
	const { LegacyIndexReader } = await import("../src/services/LegacyIndexReader");
	const { LegacyTrashMigrationService, LegacyMigrationMarkerStore } = await import("../src/services/LegacyTrashMigrationService");
	const { TrashSnapshotStore } = await import("../src/services/TrashSnapshotStore");
	const record = (id: string, status = "deleted") => ({ id, status, createdAt: "2026-08-22T09:00:00.000Z", updatedAt: "2026-08-22T10:00:00.000Z",
		contentHash: hashMemoContent("同文恢复副本"), contentSnapshot: "同文恢复副本", sourceMemoId: null,
		deletedAt: "2026-08-22T10:00:00.000Z", deletedDailyBlock: RAW,
		dailyRef: { path: DAILY, heading: "## Memos", sectionType: "heading", lastKnownBlock: RAW, lastKnownHash: hashText(RAW), lineNumberHint: 2 } });
	const index = JSON.stringify({ schemaVersion: 2, period: "2026-08", memos: {
		"2026082209000001": record("2026082209000001"), "2026082209000002": record("2026082209000002"),
		"2026082209000003": record("2026082209000003", "active") } });
	const vault = new InMemoryVault({ [INDEX]: index, [DAILY]: "## Memos\n- 10:30 当前 Daily\n" });
	Object.assign(vault.app, { metadataCache: { getFirstLinkpathDest: () => null } });
	Object.assign(vault.app.vault, { delete: async (file: { path: string }) => vault.remove(file.path) });
	const reader = new LegacyIndexReader(vault.app, "knomo", () => "Knomo");
	let sourceReads = 0;
	let settingsWrites = 0;
	const load = reader.load.bind(reader);
	reader.load = async (runtime) => { sourceReads++; return load(runtime); };
	const options = { getDataRoot: () => ROOT, migrateSettings: async () => { settingsWrites++; } };
	return { vault, reader, options, make: () => new LegacyTrashMigrationService(vault.app, reader, options),
		store: new TrashSnapshotStore(vault.app, `${ROOT}/trash`), marker: new LegacyMigrationMarkerStore(vault.app, ROOT),
		sourceReads: () => sourceReads, settingsWrites: () => settingsWrites, index };
}

test("正式 Legacy reader 迁移仅保留独立 Trash；活动 Memo 不写 Daily，marker 后不读源或快照", async () => {
	const f = await fixture();
	assert.equal((await f.make().run()).status, "attention");
	assert.equal(f.sourceReads(), 0);
	assert.equal((await f.make().run({ explicit: true })).status, "ready");
	const snapshots = (await f.store.query()).items;
	assert.equal(snapshots.length, 2);
	assert.notEqual(snapshots[0]!.snapshotId, snapshots[1]!.snapshotId);
	assert.equal(snapshots[0]!.rawBlock, snapshots[1]!.rawBlock);
	assert.equal(f.vault.read(DAILY), "## Memos\n- 10:30 当前 Daily\n");
	assert.equal(f.vault.read(INDEX), f.index);
	assert.equal(f.settingsWrites(), 1);
	const { IndependentTrashService } = await import("../src/services/IndependentTrashService");
	const { TFile } = await import("obsidian");
	Object.assign(f.vault.app, { workspace: { getActiveViewOfType: () => null } });
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
	// 新 runtime 只读取共享完成事实；restore/purge 后不检查已消费目标。
	f.reader.inspect = () => { throw new Error("Completed source must be inert."); };
	f.reader.load = async () => { throw new Error("Completed source must not be loaded."); };
	assert.equal((await f.make().run({ explicit: true })).status, "ready");
	assert.equal((await f.store.query()).items.length, 0);
});

test("中断后确定性重试，已有同 ID 副本不覆盖，marker 写入/读回故障不报告成功", async (context) => {
	for (const failure of ["second-snapshot", "settings", "marker-write", "marker-read"] as const) {
		await context.test(failure, async () => {
			const f = await fixture();
			let enabled = true;
			let creates = 0;
			const create = f.vault.app.vault.create.bind(f.vault.app.vault);
			f.vault.app.vault.create = async (path, content) => {
				if (path.includes("/trash/")) { creates++; if (enabled && failure === "second-snapshot" && creates === 2) throw new Error("interrupt"); }
				if (enabled && failure === "marker-write" && path.endsWith("completion.json")) throw new Error("marker write");
				return create(path, content);
			};
			const read = f.vault.app.vault.read.bind(f.vault.app.vault);
			f.vault.app.vault.read = async (file) => { if (enabled && failure === "marker-read" && file.path.endsWith("completion.json")) throw new Error("marker read"); return read(file); };
			f.options.migrateSettings = async () => { if (enabled && failure === "settings") throw new Error("settings"); };
			assert.equal((await f.make().run({ explicit: true })).status, "unavailable");
			const before = (await f.store.query()).items;
			enabled = false;
			assert.equal((await f.make().run({ explicit: true })).status, "ready");
			const after = (await f.store.query()).items;
			assert.equal(after.length, 2);
			for (const snapshot of before) assert.deepEqual(after.find((item) => item.snapshotId === snapshot.snapshotId), snapshot);
			assert.ok(await f.marker.read());
		});
	}
});

test("同 ID 内容不符及损坏 marker 均拒绝覆盖；缺失 marker 不自动重导入", async () => {
	const f = await fixture();
	f.options.migrateSettings = async () => { throw new Error("interrupt before marker"); };
	await f.make().run({ explicit: true });
	const snapshot = (await f.store.query()).items[0]!;
	const path = `${ROOT}/trash/${snapshot.snapshotId}.json`;
	const changed = JSON.stringify({ ...snapshot, rawBlock: "- 09:00 different" });
	f.vault.replace(path, changed);
	f.options.migrateSettings = async () => undefined;
	assert.equal((await f.make().run({ explicit: true })).status, "unavailable");
	assert.equal(f.vault.read(path), changed);
	assert.equal(await f.marker.read(), null);
	f.vault.remove(path);
	const reads = f.sourceReads();
	assert.equal((await f.make().run()).status, "attention");
	assert.equal(f.sourceReads(), reads);
	await f.vault.app.vault.create(`${ROOT}/legacy-index-completion.json`, "{}");
	assert.equal((await f.make().run({ explicit: true })).status, "unavailable");
	assert.equal(f.sourceReads(), reads);
});

test("迁移中源 revision 变化不落 marker，下一次显式重试才完成", async () => {
	const f = await fixture();
	const load = f.reader.load.bind(f.reader);
	let count = 0;
	f.reader.load = async (runtime) => { const result = await load(runtime); if (++count === 2 && result.kind === "ready") result.snapshot.sourceRevision = "changed"; return result; };
	assert.equal((await f.make().run({ explicit: true })).status, "unavailable");
	assert.equal(await f.marker.read(), null);
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

import assert from "node:assert/strict";
import test from "node:test";
import { ensureObsidianStub } from "./helpers/obsidianStub";

test("固定当前状态取代回执：导入完成释放授权，legacy 防重复信息可在无缓存重启后读取", async () => {
	await ensureObsidianStub();
	const { InMemoryVault } = await import("./helpers/InMemoryVault");
	const { KnomoCurrentStateStore } = await import("../src/services/KnomoCurrentStateStore");
	const { KnomoBootstrapStateStore } = await import("../src/services/KnomoBootstrapStateStore");
	const vault = new InMemoryVault();
	const store = new KnomoBootstrapStateStore(new KnomoCurrentStateStore(vault.app, () => "Knomo"));
	await store.setMeta("historicalIdentityBootstrap", { state: "pending", authorizationRoot: "Knomo" });
	await store.setMeta("historicalIdentityBootstrap", { state: "completed" });
	assert.equal(await store.getMeta("historicalIdentityBootstrap"), null);
	await store.setMeta("legacyMigrationCompletion", { sourceRevision: "first", requiredIdentityEventIds: ["obsolete"] });
	await store.setMeta("legacyMigrationCompletion", { sourceRevision: "current", importedMemoIds: ["memo"] });
	const restarted = new KnomoBootstrapStateStore(new KnomoCurrentStateStore(vault.app, () => "Knomo"));
	assert.deepEqual(await restarted.getMetaValues("legacyMigrationCompletion"), [{ sourceRevision: "current", importedMemoIds: ["memo"] }]);
	assert.equal(vault.paths().length, 4);
	assert.equal(vault.paths().some((path) => path.includes("receipts")), false);
});

test("刷新旧槽中断仍可读取已验证的新状态，下次写入清除旧副本", async () => {
	await ensureObsidianStub();
	const { InMemoryVault } = await import("./helpers/InMemoryVault");
	const { KnomoCurrentStateStore } = await import("../src/services/KnomoCurrentStateStore");
	const vault = new InMemoryVault();
	const store = new KnomoCurrentStateStore(vault.app, () => "Knomo");
	await store.setMeta("trash", { body: "deleted" });
	const original = vault.app.vault.process.bind(vault.app.vault);
	let writes = 0;
	vault.app.vault.process = async (file, callback) => {
		if (++writes === 2) throw new Error("interrupted");
		return original(file, callback);
	};
	await assert.rejects(store.deleteMeta("trash"), /interrupted/);
	assert.equal(await new KnomoCurrentStateStore(vault.app, () => "Knomo").getMeta("trash"), null);
	vault.app.vault.process = original;
	await store.deleteMeta("trash");
	assert.equal(Object.values(vault.snapshot()).some((content) => content.includes("deleted")), false);
});

import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryMemoCatalogStore } from "../src/services/MemoCatalogStore";
import {
	SHARED_CONFIG_REPLICA_CACHE_META_KEY,
	SHARED_IDENTITY_REPLICA_CACHE_META_KEY,
	SharedReplicaCache,
} from "../src/services/SharedReplicaCache";
import type { CatalogStoreLifecycle } from "../src/types/catalog";

class DurableMetaStore extends InMemoryMemoCatalogStore {
	override getLifecycle(): CatalogStoreLifecycle {
		return { state: "ready", persistent: true, writable: true, reason: null };
	}
}

test("共享副本缓存按 root 和 domain 隔离并可在新实例中恢复", async () => {
	const store = new DurableMetaStore();
	const cache = new SharedReplicaCache(store);
	await cache.save("identity", "Knomo-A/_knomo-data/identity", [{ eventId: "identity-a" }]);
	await cache.save("identity", "Knomo-B/_knomo-data/identity", [{ eventId: "identity-b" }]);
	await cache.save("config", "Knomo-A/_knomo-data/config", [{ eventId: "config-a" }]);

	const restarted = new SharedReplicaCache(store);
	assert.deepEqual(await restarted.load("identity", "Knomo-A/_knomo-data/identity"), [{ eventId: "identity-a" }]);
	assert.deepEqual(await restarted.load("identity", "Knomo-B/_knomo-data/identity"), [{ eventId: "identity-b" }]);
	assert.deepEqual(await restarted.load("config", "Knomo-A/_knomo-data/config"), [{ eventId: "config-a" }]);
	assert.equal(await restarted.load("config", "Knomo-B/_knomo-data/config"), null);
});

test("损坏的 metadata 不会被当作已验证副本", async () => {
	const store = new DurableMetaStore();
	await store.setMeta(SHARED_IDENTITY_REPLICA_CACHE_META_KEY, { entries: [{ rootPath: "../escape", value: [] }] });
	const cache = new SharedReplicaCache(store);

	await assert.rejects(() => cache.load("identity", "Knomo/_knomo-data/identity"), /cache entry is invalid/u);
});

test("非持久 Catalog fallback 不声称提供跨重启副本", async () => {
	const cache = new SharedReplicaCache(new InMemoryMemoCatalogStore());

	assert.equal(cache.isDurable(), false);
	await assert.rejects(() => cache.load("identity", "Knomo/_knomo-data/identity"), /not durably available/u);
	await assert.rejects(() => cache.save("config", "Knomo/_knomo-data/config", []), /not durably available/u);
});

test("Catalog clear 只在明确保留固定 key 时保留副本", async () => {
	const store = new DurableMetaStore();
	const cache = new SharedReplicaCache(store);
	await cache.save("identity", "Knomo/_knomo-data/identity", [{ eventId: "identity" }]);
	await cache.save("config", "Knomo/_knomo-data/config", [{ eventId: "config" }]);
	await store.setMeta("derived", { stale: true });

	await store.clear([SHARED_IDENTITY_REPLICA_CACHE_META_KEY, SHARED_CONFIG_REPLICA_CACHE_META_KEY]);

	assert.deepEqual(await cache.load("identity", "Knomo/_knomo-data/identity"), [{ eventId: "identity" }]);
	assert.deepEqual(await cache.load("config", "Knomo/_knomo-data/config"), [{ eventId: "config" }]);
	assert.equal(await store.getMeta("derived"), null);
});

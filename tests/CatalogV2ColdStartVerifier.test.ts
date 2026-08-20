import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";

import { CatalogV2ColdStartVerifier } from "../src/services/CatalogV2ColdStartVerifier";
import { CatalogV2StateReducer } from "../src/services/CatalogV2StateReducer";
import { IndexedDbCatalogV2StateStore } from "../src/services/IndexedDbCatalogV2StateStore";

test("cold start 使用隔离 fresh IndexedDB 仅从 v2 输入物化并重开复验", async () => {
	const store = new IndexedDbCatalogV2StateStore("phase5-cold-start", {
		factory: new IDBFactory(),
		keyRange: IDBKeyRange,
	});
	await store.open();
	const eventState = await new CatalogV2StateReducer().reduce([]);
	const passed = await new CatalogV2ColdStartVerifier(store).verify({
		generationDigest: "a".repeat(64),
		packages: [],
		eventState,
		expectedState: eventState,
	});
	assert.equal(passed, true);
	store.close();
});

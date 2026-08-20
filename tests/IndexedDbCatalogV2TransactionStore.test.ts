import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";

import { IndexedDbCatalogV2TransactionStore } from "../src/services/IndexedDbCatalogV2TransactionStore";

test("a closed transaction store reopens and cleans obsolete local outbox", async () => {
	const factory = new IDBFactory();
	const store = new IndexedDbCatalogV2TransactionStore("transaction-auto-reopen", {
		factory,
		keyRange: IDBKeyRange,
	});
	await store.open();
	await store.putOutbox({
		id: "monthly:auto-reopen",
		kind: "monthly_projection",
		memoId: null,
		logicalDate: "2026-08-01",
		period: "2026-08",
		sourceRevision: "test",
		createdAt: "2026-08-11T00:00:00.000Z",
	});
	store.close();

	assert.deepEqual(await store.listOutbox(), []);
	assert.equal(store.isAuthoritative(), true);
});

test("an incompatible versionchange fails closed instead of accepting volatile writes", async () => {
	const factory = new IDBFactory();
	const store = new IndexedDbCatalogV2TransactionStore("transaction-versionchange", {
		factory,
		keyRange: IDBKeyRange,
		version: 1,
	});
	await store.open();
	const upgraded = await openRawDatabase(factory, "transaction-versionchange", 2);
	upgraded.close();
	assert.equal(store.getHealth(), "degraded");

	await assert.rejects(() => store.putOutbox({
		id: "monthly:volatile",
		kind: "monthly_projection",
		memoId: null,
		logicalDate: "2026-08-01",
		period: "2026-08",
		sourceRevision: "test",
		createdAt: "2026-08-11T00:00:00.000Z",
	}), /not durable/u);
	assert.equal(store.isAuthoritative(), false);
});

function openRawDatabase(factory: IDBFactory, name: string, version: number): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = factory.open(name, version);
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

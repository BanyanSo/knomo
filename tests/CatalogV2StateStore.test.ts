import test from "node:test";
import assert from "node:assert/strict";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";

import { IndexedDbCatalogV2StateStore } from "../src/services/IndexedDbCatalogV2StateStore";
import type { CatalogV2MaterializedState } from "../src/types/catalogV2";

test("device writerId is stable and independent from the Catalog database", async () => {
	const factory = new IDBFactory();
	const first = new IndexedDbCatalogV2StateStore("state-store", { factory, keyRange: IDBKeyRange });
	await first.open();
	const writerId = await first.getOrCreateWriterId((target) => target.fill(1));
	first.close();

	const reopened = new IndexedDbCatalogV2StateStore("state-store", { factory, keyRange: IDBKeyRange });
	await reopened.open();
	assert.equal(await reopened.getOrCreateWriterId((target) => target.fill(2)), writerId);
	assert.equal(writerId, "w_01010101010101010101010101010101");
});

test("materialized state and segment checkpoints survive reopen without replay", async () => {
	const factory = new IDBFactory();
	const store = new IndexedDbCatalogV2StateStore("checkpoint-store", { factory, keyRange: IDBKeyRange });
	await store.open();
	const state: CatalogV2MaterializedState = {
		schemaVersion: 1,
		memos: {},
		quarantine: [],
		awaitingWriterIds: [],
		forkedWriterIds: [],
		processedOperationCount: 30000,
	};
	await store.saveMaterializedState(state);
	await store.setSegmentCheckpoint({ path: "state/devices/w_x/segment-000100.jsonl", sha256: "a".repeat(64), byteLength: 100, consumedSequence: 30000 });
	store.close();

	const reopened = new IndexedDbCatalogV2StateStore("checkpoint-store", { factory, keyRange: IDBKeyRange });
	await reopened.open();
	assert.equal((await reopened.loadMaterializedState())?.processedOperationCount, 30000);
	assert.equal((await reopened.loadMaterializedSnapshot())?.revision, "state-1");
	assert.equal((await reopened.listSegmentCheckpoints()).length, 1);
});

test("a closed state cache reopens automatically on the next read", async () => {
	const factory = new IDBFactory();
	const store = new IndexedDbCatalogV2StateStore("state-auto-reopen", { factory, keyRange: IDBKeyRange });
	await store.open();
	await store.saveMaterializedState({
		schemaVersion: 1,
		memos: {},
		quarantine: [],
		awaitingWriterIds: [],
		forkedWriterIds: [],
		processedOperationCount: 7,
	});
	store.close();

	assert.equal((await store.loadMaterializedState())?.processedOperationCount, 7);
	assert.equal(store.isAuthoritative(), true);
});

test("materialized snapshot revision and deleted lifecycle pages are stored atomically", async () => {
	const factory = new IDBFactory();
	const store = new IndexedDbCatalogV2StateStore("lifecycle-store", { factory, keyRange: IDBKeyRange });
	await store.open();
	const deletedMemo = {
		memoId: "memo-deleted",
		identityOperationIds: [],
		activeBindingHeads: [],
		identityBindings: [],
		deleteOperationIds: ["delete-1"],
		deleteVersions: [],
		restoreVersions: [],
		restoredDeleteOperationIds: [],
		purgedDeleteOperationIds: [],
		relationEntries: [],
		supersededRelationIds: [],
		sourceMemoIds: [],
		reviewOperationIds: [],
		reviewCount: 0,
		lastReviewedAt: null,
		pendingCreateIds: [],
		pendingCreateIntents: [],
	};
	const state: CatalogV2MaterializedState = {
		schemaVersion: 1,
		memos: { [deletedMemo.memoId]: deletedMemo },
		quarantine: [],
		awaitingWriterIds: [],
		forkedWriterIds: [],
		processedOperationCount: 1,
	};
	await store.saveMaterializedState(state);
	await store.saveMaterializedState({ ...state, processedOperationCount: 2 });

	assert.equal((await store.loadMaterializedSnapshot())?.revision, "state-2");
	const page = await store.listDeletedMemoPage(50);
	assert.deepEqual(page.items.map((memo) => memo.memoId), ["memo-deleted"]);
	assert.equal(page.revision, "state-2");
});

test("feature queries load only identity candidates for the requested observations", async () => {
	const factory = new IDBFactory();
	const store = new IndexedDbCatalogV2StateStore("identity-slice-store", { factory, keyRange: IDBKeyRange });
	await store.open();
	const first = createMaterializedMemo("memo-1", "2026-08-10", "09:00", "hash-1", "block-1");
	const second = createMaterializedMemo("memo-2", "2026-08-11", "10:00", "hash-2", null);
	await store.saveMaterializedState({
		schemaVersion: 1,
		memos: { [first.memoId]: first, [second.memoId]: second },
		quarantine: [],
		awaitingWriterIds: [],
		forkedWriterIds: [],
		processedOperationCount: 2,
	});

	const slice = await store.loadMaterializedSlice([{
		sourcePath: "Journal/2026-08-10.md",
		logicalDate: "2026-08-10",
		time: "09:00",
		contentHash: "hash-1",
		existingBlockId: "block-1",
	}]);
	assert.deepEqual(Object.keys(slice?.state.memos ?? {}), ["memo-1"]);
	assert.equal(slice?.state.processedOperationCount, 2);
});

test("blocked state IndexedDB uses a bounded device-local fallback", async () => {
	const factory = new IDBFactory();
	const blocker = await openRawDatabase(factory, "blocked-state-store", 1);
	const store = new IndexedDbCatalogV2StateStore("blocked-state-store", { factory, keyRange: IDBKeyRange });
	await store.open();
	assert.equal(store.isFallbackActive(), true);
	const memos: CatalogV2MaterializedState["memos"] = {};
	for (let index = 0; index < 200; index += 1) {
		const memo = createMaterializedMemo(`memo-${index}`, "2026-08-11", "10:00", `hash-${index}`, null);
		memos[memo.memoId] = memo;
	}
	await store.saveMaterializedState({
		schemaVersion: 1,
		memos,
		quarantine: [],
		awaitingWriterIds: [],
		forkedWriterIds: [],
		processedOperationCount: 200,
	});
	assert.equal(Object.keys((await store.loadMaterializedState())?.memos ?? {}).length, 150);
	blocker.close();
});

function createMaterializedMemo(
	memoId: string,
	logicalDate: string,
	time: string,
	contentHash: string,
	existingBlockId: string | null,
) {
	const binding = {
		entryId: `op-${memoId}`,
		source: "state" as const,
		evidence: {
			sourcePath: `Journal/${logicalDate}.md`,
			sourceRevision: `revision-${memoId}`,
			logicalDate,
			section: "## Memos",
			startLine: 1,
			endLine: 1,
			time,
			contentHash,
			existingBlockId,
		},
		baseBindingId: null,
	};
	return {
		memoId,
		identityOperationIds: [`op-${memoId}`],
		activeBindingHeads: [binding],
		identityBindings: [binding],
		deleteOperationIds: [],
		deleteVersions: [],
		restoreVersions: [],
		restoredDeleteOperationIds: [],
		purgedDeleteOperationIds: [],
		relationEntries: [],
		supersededRelationIds: [],
		sourceMemoIds: [],
		reviewOperationIds: [],
		reviewCount: 0,
		lastReviewedAt: null,
		pendingCreateIds: [],
		pendingCreateIntents: [],
	};
}

function openRawDatabase(factory: IDBFactory, name: string, version: number): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = factory.open(name, version);
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

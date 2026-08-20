import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";

import { CatalogV2OperationWriter } from "../src/services/CatalogV2OperationWriter";
import { IndexedDbCatalogV2TransactionStore } from "../src/services/IndexedDbCatalogV2TransactionStore";
import type { ArtifactRef, StateOperation } from "../src/types/catalogV2";
import type { CatalogV2PendingTransaction, StateOperationDraft } from "../src/types/catalogV2Runtime";

test("device-local pending survives reopen and obsolete outbox is cleaned locally", async () => {
	const factory = new IDBFactory();
	const first = new IndexedDbCatalogV2TransactionStore("phase3-transactions", { factory, keyRange: IDBKeyRange });
	await first.open();
	const pending = makePendingTransaction();
	await first.putPending(pending);
	await first.putOutbox({
		id: "monthly:memo-1",
		kind: "monthly_projection",
		memoId: "memo-1",
		logicalDate: "2026-08-09",
		sourceRevision: "a".repeat(64),
		createdAt: "2026-08-09T00:00:00.000Z",
	});
	first.close();

	const reopened = new IndexedDbCatalogV2TransactionStore("phase3-transactions", { factory, keyRange: IDBKeyRange });
	await reopened.open();
	assert.deepEqual(await reopened.listPending(), [pending]);
	assert.deepEqual(await reopened.listOutbox(), []);
	reopened.close();
});

test("operation writer keeps the exact assigned operation after append failure", async () => {
	const factory = new IDBFactory();
	const store = new IndexedDbCatalogV2TransactionStore("phase3-writer", { factory, keyRange: IDBKeyRange });
	await store.open();
	const appender = new MemoryStateAppender();
	appender.fail = true;
	const writer = new CatalogV2OperationWriter(
		{ getOrCreateWriterId: async () => "w_11111111111111111111111111111111" },
		store,
		appender,
	);
	const draft = makeReviewDraft("o_11111111111111111111111111111111");
	const assigned = await writer.queue(draft);
	const failed = await writer.flush();

	assert.equal(failed.appended, 0);
	assert.equal(failed.failed, 1);
	assert.deepEqual((await store.listStateOperationOutbox()).map((item) => item.operation), [assigned]);

	store.close();
	const reopened = new IndexedDbCatalogV2TransactionStore("phase3-writer", { factory, keyRange: IDBKeyRange });
	await reopened.open();
	appender.fail = false;
	const resumedWriter = new CatalogV2OperationWriter(
		{ getOrCreateWriterId: async () => "w_11111111111111111111111111111111" },
		reopened,
		appender,
	);
	const resumed = await resumedWriter.flush();

	assert.equal(resumed.appended, 1);
	assert.equal(resumed.failed, 0);
	assert.deepEqual(appender.appended, [assigned]);
	assert.deepEqual(await reopened.listStateOperationOutbox(), []);
	assert.deepEqual(await resumedWriter.queue(draft), assigned);
	assert.deepEqual(await reopened.listStateOperationOutbox(), []);
});

test("concurrent queueing allocates one strictly increasing writer sequence", async () => {
	const store = new IndexedDbCatalogV2TransactionStore("phase3-sequences", {
		factory: new IDBFactory(),
		keyRange: IDBKeyRange,
	});
	await store.open();
	const appender = new MemoryStateAppender();
	appender.lastSequence = 8;
	const writer = new CatalogV2OperationWriter(
		{ getOrCreateWriterId: async () => "w_22222222222222222222222222222222" },
		store,
		appender,
	);
	const operations = await Promise.all([
		writer.queue(makeReviewDraft("o_22222222222222222222222222222221")),
		writer.queue(makeReviewDraft("o_22222222222222222222222222222222")),
	]);

	assert.deepEqual(operations.map((operation) => operation.sequence).sort((left, right) => left - right), [9, 10]);
});

test("blocked transaction IndexedDB rejects pending and outbox writes", async () => {
	const factory = new IDBFactory();
	const blocker = await openRawDatabase(factory, "blocked-transactions", 1);
	const store = new IndexedDbCatalogV2TransactionStore("blocked-transactions", { factory, keyRange: IDBKeyRange });
	await store.open();
	assert.equal(store.isFallbackActive(), true);
	await assert.rejects(() => store.putPending(makePendingTransaction()), /not durable/u);
	await assert.rejects(() => store.assignStateOperation(
		"w_11111111111111111111111111111111",
		makeReviewDraft("o_44444444444444444444444444444444"),
		1,
	), /not durable/u);
	assert.deepEqual(await store.listPending(), []);
	assert.deepEqual(await store.listStateOperationOutbox(), []);
	blocker.close();
});

test("operation writer rejects a non-durable device writer identity", async () => {
	const factory = new IDBFactory();
	const store = new IndexedDbCatalogV2TransactionStore("writer-identity-unavailable", { factory, keyRange: IDBKeyRange });
	await store.open();
	let writerRead = false;
	const writer = new CatalogV2OperationWriter({
		isAuthoritative: () => false,
		getOrCreateWriterId: async () => {
			writerRead = true;
			return "w_11111111111111111111111111111111";
		},
	}, store, new MemoryStateAppender());
	await assert.rejects(() => writer.queue(
		makeReviewDraft("o_55555555555555555555555555555555"),
	), /not durable/u);
	assert.equal(writerRead, false);
	assert.deepEqual(await store.listStateOperationOutbox(), []);
	store.close();
});

function makePendingTransaction(): CatalogV2PendingTransaction {
	return {
		transactionId: "tx-1",
		kind: "edit",
		memoId: "memo-1",
		sourcePath: "Daily/2026-08-09.md",
		logicalDate: "2026-08-09",
		beforeRevision: "a".repeat(64),
		afterRevision: "b".repeat(64),
		operationDrafts: [makeReviewDraft("o_33333333333333333333333333333333")],
		createdAt: "2026-08-09T00:00:00.000Z",
	};
}

function openRawDatabase(factory: IDBFactory, name: string, version: number): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = factory.open(name, version);
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

function makeReviewDraft(opId: string): StateOperationDraft {
	return {
		opId,
		memoId: "memo-1",
		occurredAt: "2026-08-09T00:00:00.000Z",
		type: "review.record",
		baseEvidence: null,
		payload: { reviewedAt: "2026-08-09T00:00:00.000Z" },
	};
}

class MemoryStateAppender {
	fail = false;
	lastSequence = 0;
	readonly appended: StateOperation[] = [];

	async getLastSequence(): Promise<number> {
		return this.lastSequence;
	}

	async append(operation: StateOperation): Promise<ArtifactRef> {
		if (this.fail) throw new Error("append failed");
		this.appended.push(operation);
		this.lastSequence = Math.max(this.lastSequence, operation.sequence);
		return { path: "state.jsonl", sha256: "a".repeat(64), byteLength: 1 };
	}
}

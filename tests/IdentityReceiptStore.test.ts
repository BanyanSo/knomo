import assert from "node:assert/strict";
import test from "node:test";

import { IdentityReceiptStore } from "../src/services/IdentityReceiptStore";
import { InMemoryVault } from "./helpers/InMemoryVault";

const WRITER_ID = `w_${"1".repeat(32)}`;
const FACT_A = `e_${"a".repeat(32)}`;
const FACT_B = `e_${"b".repeat(32)}`;

test("初始化授权与完成事实从共享不可变记录恢复，完成依赖暂缺时保持等待", async () => {
	const sourceVault = new InMemoryVault();
	let sourceFacts: string[] = [];
	const source = createStore(sourceVault, () => sourceFacts);
	const authorization = {
		state: "pending",
		reason: "initial_import",
		catalogFingerprint: null,
		identityRevision: null,
		identityEventCount: null,
		authorizationRoot: "Knomo",
	};
	await source.setMeta("historicalIdentityBootstrap", authorization);
	sourceFacts = [FACT_A];
	await source.setMeta("historicalIdentityBootstrap", {
		state: "completed",
		reason: "initial_import",
		catalogFingerprint: "catalog-a",
		identityRevision: "identity-a",
		identityEventCount: 1,
		authorizationRoot: "Knomo",
	});

	const replicaVault = new InMemoryVault();
	replicaVault.deliverFrom(sourceVault);
	let replicaFacts: string[] = [];
	const replica = createStore(replicaVault, () => replicaFacts);
	assert.deepEqual(await replica.getMeta("historicalIdentityBootstrap"), authorization);

	replicaFacts = [FACT_A];
	const completed = await replica.getMeta<Record<string, unknown>>("historicalIdentityBootstrap");
	assert.equal(completed?.state, "completed");
	assert.deepEqual(completed?.requiredIdentityEventIds, [FACT_A]);

	replicaFacts.push(FACT_B);
	assert.equal((await replica.getMeta<Record<string, unknown>>("historicalIdentityBootstrap"))?.state, "completed",
		"后续 Ledger 增长不能使已完成事实失效");
});

test("同一完成事实写后返回中断可幂等重试，且不会生成重复共享记录", async () => {
	const vault = new InMemoryVault();
	const store = createStore(vault, () => [FACT_A]);
	const originalCreate = vault.app.vault.create.bind(vault.app.vault);
	let interruptOnce = true;
	vault.app.vault.create = (async (path: string, content: string) => {
		const file = await originalCreate(path, content);
		if (interruptOnce) {
			interruptOnce = false;
			throw new Error("interrupted after shared write");
		}
		return file;
	}) as typeof vault.app.vault.create;
	const completion = legacyCompletion("a".repeat(64));
	await store.setMeta("legacyMigrationCompletion", completion);
	const pathsAfterFirstWrite = vault.paths();
	await store.setMeta("legacyMigrationCompletion", completion);
	assert.deepEqual(vault.paths(), pathsAfterFirstWrite);
	assert.equal((await store.getMetaValues("legacyMigrationCompletion")).length, 1);
});

test("legacy 完成历史按 sourceRevision 独立保留，依赖事实到达后才可见", async () => {
	const vault = new InMemoryVault();
	let facts = [FACT_A];
	const store = createStore(vault, () => facts);
	await store.setMeta("legacyMigrationCompletion", legacyCompletion("a".repeat(64)));
	facts = [FACT_A, FACT_B];
	await store.setMeta("legacyMigrationCompletion", legacyCompletion("b".repeat(64)));

	facts = [FACT_A];
	let values = await store.getMetaValues<Record<string, unknown>>("legacyMigrationCompletion");
	assert.deepEqual(values.map((value) => value.sourceRevision), ["a".repeat(64)]);
	facts = [FACT_A, FACT_B];
	values = await store.getMetaValues<Record<string, unknown>>("legacyMigrationCompletion");
	assert.deepEqual(new Set(values.map((value) => value.sourceRevision)), new Set(["a".repeat(64), "b".repeat(64)]));
});

test("旧 Catalog 完成凭据经 Identity 核对后提升为共享记录", async () => {
	const vault = new InMemoryVault();
	const legacy = {
		state: "completed", reason: "initial_import", catalogFingerprint: "catalog-old",
		identityRevision: "identity-old", identityEventCount: 1, authorizationRoot: "Knomo",
	};
	const store = new IdentityReceiptStore(vault.app, {
		getRootPath: () => "Knomo",
		getWriterId: async () => WRITER_ID,
		getKnownIdentityEventIds: () => [FACT_A],
		getIdentitySnapshot: () => ({
			revision: "identity-new", eventCount: 2, memos: {}, pendingIntents: [], quarantinedEventIds: [],
		}),
		legacyReceiptStore: { getMeta: async <T>() => legacy as T },
	});
	assert.equal((await store.getMeta<Record<string, unknown>>("historicalIdentityBootstrap"))?.state, "completed");

	const afterIndexedDbDeletion = createStore(vault, () => [FACT_A]);
	const recovered = await afterIndexedDbDeletion.getMeta<Record<string, unknown>>("historicalIdentityBootstrap");
	assert.equal(recovered?.catalogFingerprint, "catalog-old");
	assert.deepEqual(recovered?.requiredIdentityEventIds, [FACT_A]);
});

function createStore(vault: InMemoryVault, getFacts: () => readonly string[]): IdentityReceiptStore {
	return new IdentityReceiptStore(vault.app, {
		getRootPath: () => "Knomo",
		getWriterId: async () => WRITER_ID,
		getKnownIdentityEventIds: getFacts,
	});
}

function legacyCompletion(sourceRevision: string): Record<string, unknown> {
	return {
		sourceId: "legacy-index",
		sourceRevision,
		legacySystemRoot: "_knomo-system",
		importedMemoIds: [],
	};
}

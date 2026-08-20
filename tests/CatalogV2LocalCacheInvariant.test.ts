import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";

import { CatalogV2ImmutableStateWriter } from "../src/services/CatalogV2ImmutableStateWriter";
import { CatalogV2FeatureService } from "../src/services/CatalogV2FeatureService";
import { observationToIdentityEvidence } from "../src/services/CatalogV2IdentityResolver";
import { deriveObservationMemoId, CatalogV2SharedMutationStore } from "../src/services/CatalogV2SharedMutationStore";
import { CatalogV2StateReducer } from "../src/services/CatalogV2StateReducer";
import type { CatalogV2StateShadowCoordinator } from "../src/services/CatalogV2StateShadowCoordinator";
import { CatalogV2VaultProtocol } from "../src/services/CatalogV2VaultProtocol";
import { IndexedDbCatalogV2StateStore } from "../src/services/IndexedDbCatalogV2StateStore";
import { IndexedDbCatalogV2TransactionStore } from "../src/services/IndexedDbCatalogV2TransactionStore";
import { IndexedDbMemoCatalogStore } from "../src/services/IndexedDbMemoCatalogStore";
import { DiaryMemoParser } from "../src/services/DiaryMemoParser";
import { canonicalJson, sha256Text } from "../src/services/CatalogV2Protocol";
import { buildCatalogPartition, MemoCatalogService } from "../src/services/MemoCatalogService";
import { InMemoryMemoCatalogStore } from "../src/services/MemoCatalogStore";
import type { MemoObservation } from "../src/types/catalog";
import type { CatalogV2MaterializedState, StateOperation } from "../src/types/catalogV2";
import type { CatalogV2VaultContract } from "../src/types/catalogV2Protocol";
import type { App } from "obsidian";
import { CatalogV2ReplicaVault } from "./helpers/CatalogV2ReplicaVault";

test("clearing any local Catalog V2 database leaves all shared Vault bytes unchanged", async () => {
	const replica = new CatalogV2ReplicaVault({
		"Daily/2026-08-11.md": "## Memos\n- 09:00 local cache invariant\n",
		"Memos/Memos-2026-08.md": "existing monthly bytes\n",
	});
	const protocol = new CatalogV2VaultProtocol(replica.app);
	const writerId = "w_11111111111111111111111111111111";
	const context = await protocol.initializeVault({
		catalogDataRoot: "Memos/_knomo-data",
		contract: makeContract(),
		initialWriterId: writerId,
		createdAt: "2026-08-11T00:00:00.000Z",
		vaultInstanceId: "v_11111111111111111111111111111111",
	});
	await new CatalogV2ImmutableStateWriter(protocol, () => context).append(makeOperation(writerId));
	const sharedBytes = replica.snapshot();
	const factory = new IDBFactory();
	const suffix = `${Date.now()}-${Math.random()}`;
	const names = {
		catalog: `cache-invariant-catalog-${suffix}`,
		state: `cache-invariant-state-${suffix}`,
		transaction: `cache-invariant-transaction-${suffix}`,
	};

	let catalog = new IndexedDbMemoCatalogStore(names.catalog, { factory, keyRange: IDBKeyRange });
	let state = new IndexedDbCatalogV2StateStore(names.state, { factory, keyRange: IDBKeyRange });
	let transaction = new IndexedDbCatalogV2TransactionStore(names.transaction, { factory, keyRange: IDBKeyRange });
	await Promise.all([catalog.open(), state.open(), transaction.open()]);
	await catalog.setMeta("local-only", { value: 1 });
	await materializeState(protocol, context, state);

	catalog.close();
	await deleteDatabase(factory, names.catalog);
	catalog = new IndexedDbMemoCatalogStore(names.catalog, { factory, keyRange: IDBKeyRange });
	await catalog.open();
	assert.equal(await catalog.getMeta("local-only"), null);
	await assertSharedBytesUnchanged(protocol, context, replica, sharedBytes);

	state.close();
	await deleteDatabase(factory, names.state);
	state = new IndexedDbCatalogV2StateStore(names.state, { factory, keyRange: IDBKeyRange });
	await state.open();
	assert.equal(await state.loadMaterializedState(), null);
	await materializeState(protocol, context, state);
	await assertSharedBytesUnchanged(protocol, context, replica, sharedBytes);

	transaction.close();
	await deleteDatabase(factory, names.transaction);
	transaction = new IndexedDbCatalogV2TransactionStore(names.transaction, { factory, keyRange: IDBKeyRange });
	await transaction.open();
	assert.deepEqual(await transaction.listOutbox(), []);
	await assertSharedBytesUnchanged(protocol, context, replica, sharedBytes);

	catalog.close();
	state.close();
	transaction.close();
	await Promise.all(Object.values(names).map((name) => deleteDatabase(factory, name)));
	const rebuiltState = new IndexedDbCatalogV2StateStore(names.state, { factory, keyRange: IDBKeyRange });
	await rebuiltState.open();
	await materializeState(protocol, context, rebuiltState);
	await assertSharedBytesUnchanged(protocol, context, replica, sharedBytes);
	rebuiltState.close();
});

test("two devices can clear all local databases and rebuild the same memoId from Vault-only state", async () => {
	const dailyPath = "Daily/2026-08-11.md";
	const dailyContent = "## Memos\n- 09:00 stable identity\n";
	const replica = new CatalogV2ReplicaVault({ [dailyPath]: dailyContent });
	const protocol = new CatalogV2VaultProtocol(replica.app);
	const writerId = "w_22222222222222222222222222222222";
	const context = await protocol.initializeVault({
		catalogDataRoot: "Memos/_knomo-data",
		contract: makeContract(),
		initialWriterId: writerId,
		createdAt: "2026-08-11T00:00:00.000Z",
		vaultInstanceId: "v_22222222222222222222222222222222",
	});
	const writer = new CatalogV2ImmutableStateWriter(protocol, () => context);
	await writer.reconcile(writerId);
	const parser = new DiaryMemoParser();
	const before = await parser.parse({
		sourcePath: dailyPath,
		logicalDate: "2026-08-11",
		headings: ["## Memos"],
		bytes: new TextEncoder().encode("## Memos\n"),
	});
	const after = await parser.parse({
		sourcePath: dailyPath,
		logicalDate: "2026-08-11",
		headings: ["## Memos"],
		bytes: new TextEncoder().encode(dailyContent),
	});
	const observation = after.observations[0];
	assert.ok(observation !== undefined);
	const evidence = observationToIdentityEvidence(observation);
	const memoId = await deriveObservationMemoId(
		context.bootstrap.vaultInstanceId,
		context.contractSha256,
		evidence,
	);
	const mutationId = "o_22222222222222222222222222222221";
	const claimId = "o_22222222222222222222222222222222";
	const shared = new CatalogV2SharedMutationStore(replica.app, protocol, () => context);
	const prepareRef = await shared.prepare({
		kind: "knomo.catalog-v2.mutation-prepare",
		schemaVersion: 2,
		vaultInstanceId: context.bootstrap.vaultInstanceId,
		mutationId,
		mutationKind: "create",
		memoId,
		changes: [{
			transition: {
				sourcePath: dailyPath,
				logicalDate: "2026-08-11",
				headings: ["## Memos"],
				beforeRevision: before.sourceRevision,
				afterRevision: after.sourceRevision,
				beforeEvidence: null,
				afterEvidence: evidence,
				baseBindingId: null,
				baseEvidence: null,
				preservedEvidence: [],
			},
			replay: { kind: "insert", rawBlock: "- 09:00 stable identity", section: "## Memos" },
		}],
		effectDrafts: [{
			opId: mutationId,
			memoId,
			occurredAt: "2026-08-11T00:01:00.000Z",
			type: "lifecycle.create_intent",
			baseEvidence: null,
			payload: {
				evidence,
				targetPath: dailyPath,
				logicalDate: "2026-08-11",
				time: observation.time,
				contentHash: observation.contentHash,
				sourceMemoId: null,
			},
		}, {
			opId: claimId,
			memoId,
			occurredAt: "2026-08-11T00:01:00.000Z",
			type: "identity.claim",
			baseEvidence: null,
			payload: { evidence, origin: "plugin_create", createIntentOpId: mutationId, control: null },
		}],
		preparedByWriterId: writerId,
		preparedAt: "2026-08-11T00:01:00.000Z",
	});
	const commitRef = await shared.commit({
		kind: "knomo.catalog-v2.mutation-commit",
		schemaVersion: 2,
		vaultInstanceId: context.bootstrap.vaultInstanceId,
		mutationId,
		prepare: prepareRef,
		control: null,
	});
	await writer.commitSharedMutation(writerId, commitRef, [memoId]);
	const sharedBytes = replica.snapshot();
	const factory = new IDBFactory();
	const remoteFactory = new IDBFactory();
	const suffix = `${Date.now()}-${Math.random()}`;
	const names = {
		catalog: `identity-rebuild-catalog-${suffix}`,
		state: `identity-rebuild-state-${suffix}`,
		transaction: `identity-rebuild-transaction-${suffix}`,
	};
	const remoteNames = {
		catalog: `identity-rebuild-remote-catalog-${suffix}`,
		state: `identity-rebuild-remote-state-${suffix}`,
		transaction: `identity-rebuild-remote-transaction-${suffix}`,
	};

	const [first, remoteFirst] = await Promise.all([
		rebuildIdentityView(factory, names, replica, protocol, context, shared, observation),
		rebuildIdentityView(remoteFactory, remoteNames, replica, protocol, context, shared, observation),
	]);
	assert.equal(first.memoId, memoId);
	assert.equal(remoteFirst.memoId, memoId);
	first.close();
	remoteFirst.close();
	await Promise.all([
		...Object.values(names).map((name) => deleteDatabase(factory, name)),
		...Object.values(remoteNames).map((name) => deleteDatabase(remoteFactory, name)),
	]);

	const [rebuilt, remoteRebuilt] = await Promise.all([
		rebuildIdentityView(factory, names, replica, protocol, context, shared, observation),
		rebuildIdentityView(remoteFactory, remoteNames, replica, protocol, context, shared, observation),
	]);
	assert.equal(rebuilt.memoId, memoId);
	assert.equal(remoteRebuilt.memoId, memoId);
	assert.deepEqual(replica.snapshot(), sharedBytes);
	rebuilt.close();
	remoteRebuilt.close();
	await Promise.all([
		...Object.values(names).map((name) => deleteDatabase(factory, name)),
		...Object.values(remoteNames).map((name) => deleteDatabase(remoteFactory, name)),
	]);
});

test("every Catalog V2 read entry leaves Daily, Monthly, and shared data bytes unchanged", async () => {
	const replica = new CatalogV2ReplicaVault({
		"Daily/2026-08-13.md": "## Memos\n- 09:00 read only\n",
		"Memos/Memos-2026-08.md": "monthly bytes\n",
		"Memos/_knomo-data/sentinel.json": "shared bytes\n",
	});
	const expected = replica.snapshot();
	const catalogStore = new InMemoryMemoCatalogStore();
	const catalog = new MemoCatalogService(catalogStore);
	await catalog.open();
	const observation = makeObservation();
	await catalogStore.replaceFilePartition(buildCatalogPartition({
		inventory: { sourcePath: observation.sourcePath, logicalDate: observation.logicalDate, mtime: 1, size: 1 },
		sourceRevision: observation.sourceRevision,
		observations: [observation],
		parserVersion: 1,
		settingsFingerprint: "contract-v2",
		auditedAt: 1,
	}));
	await catalogStore.setCoverage({
		kind: "complete",
		coveredFromDate: observation.logicalDate,
		pendingFileCount: 0,
		coveredFileCount: 1,
		totalFileCount: 1,
	});
	const state: CatalogV2MaterializedState = {
		schemaVersion: 1,
		memos: {},
		quarantine: [],
		awaitingWriterIds: [],
		forkedWriterIds: [],
		processedOperationCount: 0,
	};
	const stateCoordinator = {
		loadLocalStateSnapshot: async () => ({
			snapshot: { state, revision: "state-read-only" },
			settlement: { stateComplete: true, migrationComplete: true, revisionStable: true, historical: false },
		}),
	} as unknown as CatalogV2StateShadowCoordinator;
	const feature = new CatalogV2FeatureService(
		replica.app as unknown as App,
		catalog,
		null,
		stateCoordinator,
		null,
		null,
		null,
		{
			installMode: "existing_v2",
			getHeadings: () => ["## Memos"],
			getOrCreateDailyFile: async () => { throw new Error("read path attempted a write"); },
			getDailyFileForDate: async () => { throw new Error("read path attempted a write"); },
			refreshCatalogPaths: async () => undefined,
			refreshLocalCatalog: async () => undefined,
			getMemoTimeFormat: () => "HH:mm",
			rebuildLocalCatalog: async () => undefined,
		},
	);
	await feature.getReadService().materializeResolutionSnapshot();
	const reads = feature.getReadService();
	await reads.query({ limit: 50 });
	await reads.getDeletedSummary();
	await reads.listDeleted(50);
	await reads.queryTimeBuoysForDate("2026-08-13");
	await reads.queryAllTimeBuoys();
	await reads.buildRecordStats(async () => undefined, () => true);
	await reads.getRandomReunionItems(5);
	await reads.listDailyAggregates();
	await reads.listMemoViewsForDate("2026-08-13");
	await reads.listMonthlyProjectionPeriods();

	assert.deepEqual(replica.snapshot(), expected);
});

async function materializeState(
	protocol: CatalogV2VaultProtocol,
	context: Awaited<ReturnType<CatalogV2VaultProtocol["initializeVault"]>>,
	store: IndexedDbCatalogV2StateStore,
): Promise<void> {
	const selection = await protocol.selectGeneration(context);
	assert.equal(selection.kind, "verified", JSON.stringify(selection));
	if (selection.kind !== "verified") return;
	const envelopes = await Promise.all(selection.value.operations.map(async (operation) => ({
		operation,
		digest: await sha256Text(canonicalJson(operation)),
		sourcePath: selection.value.generationRef.path,
	})));
	await store.saveMaterializedState(await new CatalogV2StateReducer().reduce(envelopes));
}

async function rebuildIdentityView(
	factory: IDBFactory,
	names: { catalog: string; state: string; transaction: string },
	replica: CatalogV2ReplicaVault,
	protocol: CatalogV2VaultProtocol,
	context: Awaited<ReturnType<CatalogV2VaultProtocol["initializeVault"]>>,
	shared: CatalogV2SharedMutationStore,
	observation: MemoObservation,
): Promise<{ memoId: string | null; close: () => void }> {
	const catalogStore = new IndexedDbMemoCatalogStore(names.catalog, { factory, keyRange: IDBKeyRange });
	const stateStore = new IndexedDbCatalogV2StateStore(names.state, { factory, keyRange: IDBKeyRange });
	const transactionStore = new IndexedDbCatalogV2TransactionStore(names.transaction, { factory, keyRange: IDBKeyRange });
	await Promise.all([catalogStore.open(), stateStore.open(), transactionStore.open()]);
	await catalogStore.replaceFilePartition(buildCatalogPartition({
		inventory: {
			sourcePath: observation.sourcePath,
			logicalDate: observation.logicalDate,
			mtime: 1,
			size: new TextEncoder().encode(replica.read(observation.sourcePath) ?? "").byteLength,
		},
		sourceRevision: observation.sourceRevision,
		observations: [observation],
		parserVersion: 1,
		settingsFingerprint: context.contractSha256,
		auditedAt: 1,
	}));
	await catalogStore.setCoverage({
		kind: "complete",
		coveredFromDate: observation.logicalDate,
		pendingFileCount: 0,
		coveredFileCount: 1,
		totalFileCount: 1,
	});
	await materializeState(protocol, context, stateStore);
	const stateSnapshot = await stateStore.loadMaterializedSnapshot();
	assert.ok(stateSnapshot !== null);
	const stateCoordinator = {
		loadLocalStateSnapshot: async () => ({
			snapshot: stateSnapshot,
			settlement: {
				stateComplete: true,
				migrationComplete: true,
				revisionStable: true,
				historical: false,
				verifiedGenerationId: "f".repeat(64),
				contractDigest: context.contractSha256,
			},
		}),
	} as unknown as CatalogV2StateShadowCoordinator;
	const catalog = new MemoCatalogService(catalogStore);
	const feature = new CatalogV2FeatureService(
		replica.app,
		catalog,
		stateStore,
		stateCoordinator,
		transactionStore,
		null,
		null,
		{
			installMode: "existing_v2",
			getHeadings: () => ["## Memos"],
			getOrCreateDailyFile: async () => { throw new Error("not used"); },
			getDailyFileForDate: async () => { throw new Error("not used"); },
			refreshCatalogPaths: async () => undefined,
			refreshLocalCatalog: async () => undefined,
			getMemoTimeFormat: () => "HH:mm",
			rebuildLocalCatalog: async () => undefined,
			getVaultContext: () => context,
			inspectSharedMutations: () => shared.inspect(),
		},
	);
	await feature.getReadService().materializeResolutionSnapshot();
	const memoId = (await feature.getReadService().query({ limit: 1 })).items[0]?.memoId ?? null;
	return {
		memoId,
		close: () => {
			catalog.close();
			stateStore.close();
			transactionStore.close();
		},
	};
}

async function assertSharedBytesUnchanged(
	protocol: CatalogV2VaultProtocol,
	context: Awaited<ReturnType<CatalogV2VaultProtocol["initializeVault"]>>,
	replica: CatalogV2ReplicaVault,
	expected: Record<string, string>,
): Promise<void> {
	assert.equal((await protocol.selectGeneration(context)).kind, "verified");
	assert.deepEqual(replica.snapshot(), expected);
}

function makeOperation(writerId: string): StateOperation {
	return {
		schemaVersion: 1,
		writerId,
		sequence: 1,
		opId: "o_11111111111111111111111111111111",
		memoId: "memo-1",
		occurredAt: "2026-08-11T00:01:00.000Z",
		type: "review.record",
		baseEvidence: null,
		payload: { reviewedAt: "2026-08-11T00:01:00.000Z" },
	};
}

function makeObservation(): MemoObservation {
	return {
		sourcePath: "Daily/2026-08-13.md",
		sourceRevision: "f".repeat(64),
		logicalDate: "2026-08-13",
		section: "## Memos",
		startLine: 1,
		endLine: 1,
		time: "09:00",
		content: "read only @2026-08-13",
		contentHash: "fnv1a-12345678",
		existingBlockId: null,
		tags: ["read"],
		links: [],
		images: [],
		tasks: [],
		timeBuoyDates: ["2026-08-13"],
	};
}

function makeContract(): CatalogV2VaultContract {
	return {
		kind: "knomo.catalog-v2.vault-contract",
		schemaVersion: 2,
		parserVersion: 1,
		daily: { folder: "Daily", dateFormat: "YYYY-MM-DD", headings: ["## Memos"], allowRootMemos: true },
		monthly: {
			folder: "Memos",
			fileFormat: "Memos-YYYY-MM.md",
			dateHeadingFormat: "## [[YYYY-MM-DD]]",
			dateOrder: "asc",
			rendererVersion: 1,
			newline: "lf",
		},
	};
}

function deleteDatabase(factory: IDBFactory, name: string): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const request = factory.deleteDatabase(name);
		request.onsuccess = () => resolve();
		request.onerror = () => reject(request.error);
		request.onblocked = () => reject(new Error(`Blocked while deleting ${name}.`));
	});
}

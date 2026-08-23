import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { TFile } from "obsidian";
import type { App, Component } from "obsidian";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";

import { CatalogV2StateShadowCoordinator } from "../src/services/CatalogV2StateShadowCoordinator";
import { CatalogV2ImmutableStateWriter } from "../src/services/CatalogV2ImmutableStateWriter";
import { CatalogV2IdentityResolver, createResolvedMemoHandle } from "../src/services/CatalogV2IdentityResolver";
import { CatalogV2MigrationArtifactStore } from "../src/services/CatalogV2MigrationArtifactStore";
import { CatalogV2VaultProtocol } from "../src/services/CatalogV2VaultProtocol";
import { IndexedDbCatalogV2StateStore } from "../src/services/IndexedDbCatalogV2StateStore";
import type { CatalogFileRevisionBatch, MemoObservation } from "../src/types/catalog";
import type { ArtifactRef, CatalogV2UpgradeStatus, StateOperation } from "../src/types/catalogV2";
import type { CatalogV2VaultContract } from "../src/types/catalogV2Protocol";
import { CatalogV2ReplicaVault } from "./helpers/CatalogV2ReplicaVault";
import { makeMigrationResult } from "./helpers/CatalogV2MigrationFixture";

test("phase 2 shadow captures legacy artifacts without invoking any Vault write API", async () => {
	const fixture = JSON.parse(await readFile(path.join(process.cwd(), "tests/fixtures/catalog-v2/phase2/legacy-fixtures.json"), "utf8")) as Record<string, unknown>;
	const file = Object.assign(new TFile(), {
		path: "Memos/_knomo-system/indexes/memo-index-2026-06.json",
		name: "memo-index-2026-06.json",
		extension: "json",
		stat: { ctime: 1, mtime: 2, size: 3 },
	});
	const bytes = new TextEncoder().encode(JSON.stringify(fixture["LEG-111-BASE"]));
	const writes: string[] = [];
	const app = {
		vault: {
			configDir: ".obsidian",
			getFiles: () => [file],
			getAbstractFileByPath: () => null,
			readBinary: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
			create: async () => { writes.push("create"); throw new Error("unexpected write"); },
			createFolder: async () => { writes.push("createFolder"); throw new Error("unexpected write"); },
			process: async () => { writes.push("process"); throw new Error("unexpected write"); },
			on: () => ({ unsubscribe: () => undefined }),
			adapter: {
				exists: async () => false,
				stat: async () => null,
				readBinary: async () => new ArrayBuffer(0),
				getName: () => "memory",
			},
		},
		workspace: {
			containerEl: {
				doc: { visibilityState: "visible" },
				win: {
					setTimeout: () => 1,
					clearTimeout: () => undefined,
				},
			},
		},
	} as unknown as App;
	const store = new IndexedDbCatalogV2StateStore("phase2-shadow", {
		factory: new IDBFactory(),
		keyRange: IDBKeyRange,
	});
	const coordinator = new CatalogV2StateShadowCoordinator(app, store, () => "Memos", "knomo", undefined, {
		now: () => 1,
		shaAuditDelayMs: 60_000,
		canPersistMigrationArtifacts: () => true,
	});
	await coordinator.initialize();
	assert.deepEqual(writes, []);
	assert.equal((await store.loadShadowPreview())?.packages.length, 1);
	assert.equal((await store.loadMaterializedState())?.memos["legacy-active-1"]?.identityOperationIds.length, 1);
	store.listOperationEnvelopes = async () => {
		throw new Error("unchanged startup must use the materialized checkpoint");
	};
	await coordinator.capture(false);
	assert.equal((await store.loadMaterializedState())?.memos["legacy-active-1"]?.identityOperationIds.length, 1);
	assert.equal((await coordinator.loadLocalStateSnapshot(false))?.settlement.migrationComplete, false,
		"重复 capture 只能证明本机输入未变化，不能授权 identity adoption");
	store.close();
});

test("protocol-v2 ignores migration packages until a verified generation binds their commit", async () => {
	const replica = new CatalogV2ReplicaVault();
	(replica.app as unknown as { workspace: unknown }).workspace = {
		containerEl: {
			doc: { visibilityState: "visible" },
			win: { setTimeout: () => 1, clearTimeout: () => undefined },
		},
	};
	(replica.app.vault as unknown as { adapter: unknown; configDir: string }).adapter = {
		exists: async () => false,
		stat: async () => null,
		readBinary: async () => new ArrayBuffer(0),
		getName: () => "memory",
	};
	const protocol = new CatalogV2VaultProtocol(replica.app);
	const writerId = "w_11111111111111111111111111111111";
	const context = await protocol.initializeVault({
		catalogDataRoot: "Memos/_knomo-data",
		contract: makeContract(),
		initialWriterId: writerId,
		createdAt: "2026-08-11T00:00:00.000Z",
		vaultInstanceId: "v_11111111111111111111111111111111",
	});
	await new CatalogV2ImmutableStateWriter(protocol, () => context).reconcile(writerId);
	const artifactStore = new CatalogV2MigrationArtifactStore(replica.app, context.bootstrap.catalogDataRoot);
	const result = await makeMigrationResult();
	await artifactStore.persistImportResults([result]);
	const store = new IndexedDbCatalogV2StateStore("protocol-v2-uncommitted-migration", {
		factory: new IDBFactory(),
		keyRange: IDBKeyRange,
	});
	const coordinator = new CatalogV2StateShadowCoordinator(replica.app, store, () => "Memos", "knomo", undefined, {
		protocol,
		getVaultContext: () => context,
		getCatalogDataRoot: () => context.bootstrap.catalogDataRoot,
		getLegacySystemRoot: () => "Memos/_knomo-system",
		migrationArtifactStore: artifactStore,
	});
	await coordinator.initialize();
	assert.deepEqual(Object.keys((await store.loadMaterializedState())?.memos ?? {}), []);
	store.close();
});

test("a newly verified generation schedules one automatic stability capture", async () => {
	const replica = new CatalogV2ReplicaVault();
	const scheduled: Array<() => void> = [];
	(replica.app as unknown as { workspace: unknown }).workspace = {
		containerEl: {
			doc: { visibilityState: "visible" },
			win: {
				setTimeout: (callback: () => void, delay: number) => {
					if (delay === 0) scheduled.push(callback);
					return scheduled.length;
				},
				clearTimeout: () => undefined,
			},
		},
	};
	const protocol = new CatalogV2VaultProtocol(replica.app);
	const writerId = "w_11111111111111111111111111111111";
	const context = await protocol.initializeVault({
		catalogDataRoot: "Memos/_knomo-data",
		contract: makeContract(),
		initialWriterId: writerId,
		createdAt: "2026-08-11T00:00:00.000Z",
		vaultInstanceId: "v_11111111111111111111111111111111",
	});
	await new CatalogV2ImmutableStateWriter(protocol, () => context).reconcile(writerId);
	const store = new IndexedDbCatalogV2StateStore("protocol-v2-auto-stability", {
		factory: new IDBFactory(),
		keyRange: IDBKeyRange,
	});
	const coordinator = new CatalogV2StateShadowCoordinator(replica.app, store, () => "Memos", "knomo", undefined, {
		protocol,
		getVaultContext: () => context,
		getCatalogDataRoot: () => context.bootstrap.catalogDataRoot,
		getLegacySystemRoot: () => "Memos/_knomo-system",
	});
	await coordinator.initialize();
	assert.equal((await coordinator.loadLocalStateSnapshot(false))?.settlement.revisionStable, false);
	assert.equal(scheduled.length, 1);
	scheduled.shift()?.();
	for (let attempt = 0; attempt < 10; attempt += 1) {
		if ((await coordinator.loadLocalStateSnapshot(false))?.settlement.revisionStable === true) break;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	assert.equal((await coordinator.loadLocalStateSnapshot(false))?.settlement.revisionStable, true);
	assert.equal(scheduled.length, 0);
	store.close();
});

test("a previously verified generation cannot regress when its tip disappears", async () => {
	const replica = new CatalogV2ReplicaVault();
	(replica.app as unknown as { workspace: unknown }).workspace = {
		containerEl: {
			doc: { visibilityState: "visible" },
			win: { setTimeout: () => 1, clearTimeout: () => undefined },
		},
	};
	const protocol = new CatalogV2VaultProtocol(replica.app);
	const writerId = "w_11111111111111111111111111111111";
	const context = await protocol.initializeVault({
		catalogDataRoot: "Memos/_knomo-data",
		contract: makeContract(),
		initialWriterId: writerId,
		createdAt: "2026-08-11T00:00:00.000Z",
		vaultInstanceId: "v_11111111111111111111111111111111",
	});
	const writer = new CatalogV2ImmutableStateWriter(protocol, () => context);
	await writer.reconcile(writerId);
	const factory = new IDBFactory();
	const databaseName = "protocol-v2-generation-watermark";
	const firstStore = new IndexedDbCatalogV2StateStore(databaseName, { factory, keyRange: IDBKeyRange });
	const first = new CatalogV2StateShadowCoordinator(replica.app, firstStore, () => "Memos", "knomo", undefined, {
		protocol,
		getVaultContext: () => context,
		getCatalogDataRoot: () => context.bootstrap.catalogDataRoot,
		getLegacySystemRoot: () => "Memos/_knomo-system",
	});
	await first.initialize();
	await first.capture(false);
	await writer.append({
		schemaVersion: 1,
		writerId,
		sequence: 1,
		opId: "o_11111111111111111111111111111111",
		memoId: "memo-a",
		occurredAt: "2026-08-11T00:01:00.000Z",
		type: "review.record",
		baseEvidence: null,
		payload: { reviewedAt: "2026-08-11T00:01:00.000Z" },
	});
	await first.capture(false);
	await first.capture(false);
	const latest = await protocol.selectGeneration(context);
	assert.equal(latest.kind, "verified");
	if (latest.kind !== "verified") throw new Error("Expected verified generation.");
	assert.equal((await first.loadLocalStateSnapshot(false))?.settlement.revisionStable, true);
	replica.remove(latest.value.generationRef.path);
	firstStore.close();

	const secondStore = new IndexedDbCatalogV2StateStore(databaseName, { factory, keyRange: IDBKeyRange });
	const second = new CatalogV2StateShadowCoordinator(replica.app, secondStore, () => "Memos", "knomo", undefined, {
		protocol,
		getVaultContext: () => context,
		getCatalogDataRoot: () => context.bootstrap.catalogDataRoot,
		getLegacySystemRoot: () => "Memos/_knomo-system",
	});
	await second.initialize();
	const local = await second.loadLocalStateSnapshot(false);
	assert.equal(local?.settlement.stateComplete, false);
	assert.equal(local?.settlement.revisionStable, false);
	assert.equal(local?.snapshot.state.memos["memo-a"]?.reviewCount, 1);
	assert.deepEqual((await secondStore.loadShadowPreview())?.stateErrors.map((item) => item.path), [
		"generation_watermark_regression",
	]);
	secondStore.close();
});

test("plugin data 只按 random reunion review 领域触发迁移", async () => {
	let pluginData: Record<string, unknown> = {
		settings: { theme: "one" },
		shuffleDayHistory: ["2026-08-01"],
		randomReunionReviewStates: {
			"memo-1": { memoId: "memo-1", reviewCount: 1, lastReviewedAt: null },
		},
	};
	const app = {
		vault: {
			configDir: ".obsidian",
			getFiles: () => [],
			getAbstractFileByPath: () => null,
			on: () => ({ unsubscribe: () => undefined }),
			adapter: {
				exists: async () => true,
				stat: async () => ({ type: "file", ctime: 1, mtime: 2, size: 1 }),
				readBinary: async () => new TextEncoder().encode(JSON.stringify(pluginData)).buffer,
				getName: () => "memory",
			},
		},
		workspace: {
			containerEl: {
				doc: { visibilityState: "visible" },
				win: { setTimeout: () => 1, clearTimeout: () => undefined },
			},
		},
	} as unknown as App;
	const store = new IndexedDbCatalogV2StateStore("phase5-plugin-data-domain", {
		factory: new IDBFactory(),
		keyRange: IDBKeyRange,
	});
	const coordinator = new CatalogV2StateShadowCoordinator(app, store, () => "Memos", "knomo", undefined, {
		canPersistMigrationArtifacts: () => true,
	});
	await coordinator.initialize();
	const firstPackage = (await store.loadShadowPreview())?.packages[0];
	assert.ok(firstPackage);

	pluginData = { ...pluginData, settings: { theme: "two" }, shuffleDayHistory: ["2026-08-02"] };
	await coordinator.capture(false);
	assert.equal((await store.loadShadowPreview())?.packages[0]?.sha256, firstPackage.sha256);

	pluginData = {
		...pluginData,
		randomReunionReviewStates: {
			"memo-1": { memoId: "memo-1", reviewCount: 2, lastReviewedAt: "2026-08-11T00:00:00.000Z" },
		},
	};
	await coordinator.capture(false);
	assert.notEqual((await store.loadShadowPreview())?.packages[0]?.sha256, firstPackage.sha256);
	store.close();
});

test("晚到或移出的迁移文件会立即撤销 readiness", async () => {
	const handlers = new Map<string, (...args: unknown[]) => void>();
	const app = {
		vault: {
			on: (name: string, callback: (...args: unknown[]) => void) => {
				handlers.set(name, callback);
				return { unsubscribe: () => undefined };
			},
		},
		workspace: {
			containerEl: {
				doc: { visibilityState: "visible" },
				win: { setTimeout: () => 1, clearTimeout: () => undefined },
			},
		},
	} as unknown as App;
	const owner = {
		registerEvent: () => undefined,
		registerDomEvent: () => undefined,
		register: () => undefined,
	} as unknown as Component;
	const store = new IndexedDbCatalogV2StateStore("phase3-readiness-invalidation", {
		factory: new IDBFactory(),
		keyRange: IDBKeyRange,
	});
	await store.open();
	await store.saveMaterializedState({
		schemaVersion: 1,
		memos: {},
		quarantine: [],
		awaitingWriterIds: [],
		forkedWriterIds: [],
		processedOperationCount: 0,
	});
	const snapshot = await store.loadMaterializedSnapshot();
	assert.ok(snapshot);
	const coordinator = new CatalogV2StateShadowCoordinator(app, store, () => "Memos", "knomo");
	const epoch = coordinator.getMigrationInputEpoch();
	await store.saveUpgradeStatus(makeReadyStatus(snapshot.revision, epoch));
	assert.equal(coordinator.confirmMigrationReadiness(epoch), true);
	assert.equal((await coordinator.loadLocalStateSnapshot(false))?.settlement.migrationComplete, true);
	coordinator.start(owner);
	const movedFile = Object.assign(new TFile(), {
		path: "Archive/migration-package.json",
		name: "migration-package.json",
		extension: "json",
		stat: { ctime: 1, mtime: 2, size: 3 },
	});
	handlers.get("rename")?.(movedFile, "Memos/_knomo-data/upgrade/packages/migration-package.json");
	assert.equal((await coordinator.loadLocalStateSnapshot(false))?.settlement.migrationComplete, false);
	store.close();
});

test("a missing writer head blocks only its declared memo scope", async () => {
	const replica = new CatalogV2ReplicaVault();
	(replica.app as unknown as { workspace: unknown }).workspace = {
		containerEl: {
			doc: { visibilityState: "visible" },
			win: { setTimeout: () => 1, clearTimeout: () => undefined },
		},
	};
	const protocol = new CatalogV2VaultProtocol(replica.app);
	const writerA = "w_11111111111111111111111111111111";
	const writerB = "w_22222222222222222222222222222222";
	const context = await protocol.initializeVault({
		catalogDataRoot: "Memos/_knomo-data",
		contract: makeContract(),
		initialWriterId: writerA,
		createdAt: "2026-08-11T00:00:00.000Z",
		vaultInstanceId: "v_11111111111111111111111111111111",
	});
	const observation = makeObservation();
	const operation: StateOperation = {
		schemaVersion: 1,
		writerId: writerA,
		sequence: 1,
		opId: "o_11111111111111111111111111111111",
		memoId: "memo-a",
		occurredAt: "2026-08-11T00:01:00.000Z",
		type: "identity.claim",
		baseEvidence: null,
		payload: {
			evidence: toEvidence(observation),
			origin: "plugin_create",
			createIntentOpId: null,
		},
	};
	await new CatalogV2ImmutableStateWriter(protocol, () => context).append(operation);
	const store = new IndexedDbCatalogV2StateStore("protocol-v2-scoped-awaiting", {
		factory: new IDBFactory(),
		keyRange: IDBKeyRange,
	});
	const coordinator = new CatalogV2StateShadowCoordinator(replica.app, store, () => "Memos", "knomo", undefined, {
		protocol,
		getVaultContext: () => context,
		getCatalogDataRoot: () => context.bootstrap.catalogDataRoot,
		getLegacySystemRoot: () => "Memos/_knomo-system",
	});
	await coordinator.initialize();
	await coordinator.capture(false);
	const verified = await protocol.selectGeneration(context);
	assert.equal(verified.kind, "verified");
	if (verified.kind !== "verified") throw new Error("Expected verified state generation.");
	const missingRegistration: ArtifactRef = {
		path: "Memos/_knomo-data/state/writers/w_22222222222222222222222222222222/registration-missing.json",
		sha256: "e".repeat(64),
		byteLength: 1,
	};
	const missingHead: ArtifactRef = {
		path: "Memos/_knomo-data/state/writers/w_22222222222222222222222222222222/heads/head-000001-missing.json",
		sha256: "f".repeat(64),
		byteLength: 1,
	};
	await protocol.writeGeneration(context, {
		...verified.value.generation,
		parents: [verified.value.generationRef],
		writers: [
			...verified.value.generation.writers,
			{ writerId: writerB, registration: missingRegistration, head: missingHead, affectedMemoIds: ["memo-b"] },
		],
		createdByWriterId: writerA,
		createdAt: "2026-08-11T00:02:00.000Z",
	});
	const sharedBytesBeforeRead = replica.snapshot();
	await coordinator.capture(false);
	const local = await coordinator.loadLocalStateSnapshot(false);
	assert.ok(local !== null);
	assert.equal(local.settlement.stateComplete, false);
	assert.equal(local.settlement.revisionStable, true);
	assert.deepEqual(local.settlement.blockedMemoIds, ["memo-b"]);
	const [resolved] = new CatalogV2IdentityResolver().resolveFile({
		batch: makeBatch(observation),
		state: local.snapshot.state,
		stateRevision: local.snapshot.revision,
		localIntents: [],
		settlement: local.settlement,
	});
	assert.equal(createResolvedMemoHandle(resolved ?? null)?.memoId, "memo-a");
	assert.deepEqual(replica.snapshot(), sharedBytesBeforeRead);

	const writer = new CatalogV2ImmutableStateWriter(protocol, () => context);
	await writer.append({
		schemaVersion: 1,
		writerId: writerA,
		sequence: 2,
		opId: "o_33333333333333333333333333333333",
		memoId: "memo-a",
		occurredAt: "2026-08-11T00:03:00.000Z",
		type: "review.record",
		baseEvidence: null,
		payload: { reviewedAt: "2026-08-11T00:03:00.000Z" },
	});
	await coordinator.capture(false);
	await coordinator.capture(false);
	const progressed = await coordinator.loadLocalStateSnapshot(false);
	assert.equal(progressed?.snapshot.state.memos["memo-a"]?.reviewCount, 1);
	assert.deepEqual(progressed?.settlement.blockedMemoIds, ["memo-b"]);
	await assert.rejects(writer.append({
		schemaVersion: 1,
		writerId: writerA,
		sequence: 3,
		opId: "o_44444444444444444444444444444444",
		memoId: "memo-b",
		occurredAt: "2026-08-11T00:04:00.000Z",
		type: "review.record",
		baseEvidence: null,
		payload: { reviewedAt: "2026-08-11T00:04:00.000Z" },
	}), /awaiting data/u);
});

function makeReadyStatus(stateRevision: string, epoch: number): CatalogV2UpgradeStatus {
	return {
		schemaVersion: 1,
		installMode: "legacy_upgrade",
		phase: "settlement",
		selectedGenerationDigest: null,
		pendingStartupGenerationDigest: null,
		pendingStartupSessionId: null,
		verifiedStartupGenerationDigest: null,
		pendingNoLegacyStartupSessionId: "session-a",
		verifiedNoLegacyStartupSessionId: "session-b",
		pendingLayoutStartupSignature: null,
		pendingLayoutStartupSessionId: null,
		verifiedLayoutStartupSignature: null,
		legacyInventorySignature: "",
		legacyChangedAt: 1,
		legacyReceipts: [],
		legacyV2Receipts: [],
		retiredReceipts: [],
		attention: [],
		identityAdoptionReadiness: {
			kind: "ready",
			epoch,
			generationDigest: null,
			inventorySignature: "",
			stateRevision,
			verifiedSessionId: "session-b",
			settledAt: 2,
		},
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
			fileFormat: "YYYY-MM.md",
			dateHeadingFormat: "## YYYY-MM-DD",
			dateOrder: "asc",
			rendererVersion: 1,
			newline: "lf",
		},
	};
}

function makeObservation(): MemoObservation {
	return {
		sourcePath: "Daily/2026-08-11.md",
		sourceRevision: "a".repeat(64),
		rawBlockHash: "fnv1a-rawblock",
		logicalDate: "2026-08-11",
		section: "## Memos",
		startLine: 1,
		endLine: 1,
		time: "09:00",
		content: "memo a",
		contentHash: "fnv1a-12345678",
		existingBlockId: null,
		tags: [],
		links: [],
		images: [],
		tasks: [],
		timeBuoyDates: [],
	};
}

function toEvidence(observation: MemoObservation) {
	return {
		sourcePath: observation.sourcePath,
		sourceRevision: observation.sourceRevision,
		logicalDate: observation.logicalDate,
		section: observation.section,
		startLine: observation.startLine,
		endLine: observation.endLine,
		time: observation.time,
		contentHash: observation.contentHash,
		existingBlockId: observation.existingBlockId,
	};
}

function makeBatch(observation: MemoObservation): CatalogFileRevisionBatch<MemoObservation> {
	return {
		file: {
			sourcePath: observation.sourcePath,
			sourceRevision: observation.sourceRevision,
			logicalDate: observation.logicalDate,
			mtime: 1,
			size: 1,
			parserVersion: 1,
			settingsFingerprint: "contract-v2",
			observationCount: 1,
			auditedAt: 1,
		},
		observations: [observation],
		catalogRevision: 1,
	};
}

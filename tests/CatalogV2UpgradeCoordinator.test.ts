import assert from "node:assert/strict";
import test from "node:test";
import type { App } from "obsidian";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";

import type { CatalogV2MigrationArtifactStore } from "../src/services/CatalogV2MigrationArtifactStore";
import { CatalogV2MigrationArtifactStore as MigrationArtifactStore } from "../src/services/CatalogV2MigrationArtifactStore";
import { CatalogV2StateShadowCoordinator } from "../src/services/CatalogV2StateShadowCoordinator";
import {
	CatalogV2UpgradeCoordinator,
	hasCatalogIdentityParity,
} from "../src/services/CatalogV2UpgradeCoordinator";
import { IndexedDbCatalogV2StateStore } from "../src/services/IndexedDbCatalogV2StateStore";
import { IndexedDbCatalogV2TransactionStore } from "../src/services/IndexedDbCatalogV2TransactionStore";
import { buildCatalogPartition, MemoCatalogService } from "../src/services/MemoCatalogService";
import { InMemoryMemoCatalogStore } from "../src/services/MemoCatalogStore";
import type { CatalogV2MaterializedState } from "../src/types/catalogV2";
import { CatalogV2ReplicaVault } from "./helpers/CatalogV2ReplicaVault";
import { makeMigrationResult } from "./helpers/CatalogV2MigrationFixture";

test("legacy 升级即使暂未收到输入也必须跨启动验证后才能签发 adoption readiness", async () => {
	const factory = new IDBFactory();
	const stateStore = new IndexedDbCatalogV2StateStore("upgrade-readiness-state", {
		factory,
		keyRange: IDBKeyRange,
	});
	await stateStore.open();
	await stateStore.saveMaterializedState({
		schemaVersion: 1,
		memos: {},
		quarantine: [],
		awaitingWriterIds: [],
		forkedWriterIds: [],
		processedOperationCount: 0,
	});
	const transactionStore = new IndexedDbCatalogV2TransactionStore("upgrade-readiness-transactions", {
		factory,
		keyRange: IDBKeyRange,
	});
	await transactionStore.open();
	const catalogStore = new InMemoryMemoCatalogStore();
	const catalog = new MemoCatalogService(catalogStore);
	await catalog.open();
	await catalogStore.setCoverage({
		kind: "complete",
		coveredFromDate: null,
		pendingFileCount: 0,
		coveredFileCount: 0,
		totalFileCount: 0,
	});
	const app = {
		vault: { getAbstractFileByPath: () => null },
		fileManager: { trashFile: async () => undefined },
	} as unknown as App;
	const artifacts = {
		listAvailableArtifacts: async () => [],
		listPackages: async () => [],
		listCommits: async () => [],
	} as unknown as CatalogV2MigrationArtifactStore;

	const firstStateCoordinator = new CatalogV2StateShadowCoordinator(app, stateStore, () => "Memos", "knomo");
	const first = await new CatalogV2UpgradeCoordinator(
		app,
		"Memos/_knomo-data",
		"Memos/_knomo-system",
		catalog,
		stateStore,
		firstStateCoordinator,
		transactionStore,
		artifacts,
		{
			sessionId: "session-a",
			installMode: "legacy_upgrade",
			settlementMs: 0,
			now: () => 1,
			legacyReadsDisabled: () => true,
			legacyWriterRemoved: () => true,
		},
	).initialize();
	assert.equal(first?.identityAdoptionReadiness.kind, "blocked");
	assert.equal(first?.identityAdoptionReadiness.kind === "blocked" ? first.identityAdoptionReadiness.reason : null,
		"cold_start_pending");

	const secondStateCoordinator = new CatalogV2StateShadowCoordinator(app, stateStore, () => "Memos", "knomo");
	const second = await new CatalogV2UpgradeCoordinator(
		app,
		"Memos/_knomo-data",
		"Memos/_knomo-system",
		catalog,
		stateStore,
		secondStateCoordinator,
		transactionStore,
		artifacts,
		{
			sessionId: "session-b",
			installMode: "legacy_upgrade",
			settlementMs: 0,
			now: () => 2,
			legacyReadsDisabled: () => true,
			legacyWriterRemoved: () => true,
		},
	).initialize();
	assert.equal(second?.identityAdoptionReadiness.kind, "ready");
	assert.equal((await secondStateCoordinator.loadLocalStateSnapshot(false))?.settlement.migrationComplete, true);

	await stateStore.saveMaterializedState({
		schemaVersion: 1,
		memos: {},
		quarantine: [],
		awaitingWriterIds: [],
		forkedWriterIds: [],
		processedOperationCount: 0,
	});
	assert.equal((await secondStateCoordinator.loadLocalStateSnapshot(false))?.settlement.migrationComplete, false,
		"readiness 不能授权不同的 state revision");
	transactionStore.close();
	stateStore.close();
});

test("未初始化 Vault 不得签发 adoption readiness", async () => {
	const factory = new IDBFactory();
	const stateStore = new IndexedDbCatalogV2StateStore("native-readiness-state", {
		factory,
		keyRange: IDBKeyRange,
	});
	await stateStore.open();
	await stateStore.saveMaterializedState({
		schemaVersion: 1,
		memos: {},
		quarantine: [],
		awaitingWriterIds: [],
		forkedWriterIds: [],
		processedOperationCount: 0,
	});
	const transactionStore = new IndexedDbCatalogV2TransactionStore("native-readiness-transactions", {
		factory,
		keyRange: IDBKeyRange,
	});
	await transactionStore.open();
	const catalogStore = new InMemoryMemoCatalogStore();
	const catalog = new MemoCatalogService(catalogStore);
	await catalog.open();
	await catalogStore.setCoverage({
		kind: "complete",
		coveredFromDate: null,
		pendingFileCount: 0,
		coveredFileCount: 0,
		totalFileCount: 0,
	});
	const app = {
		vault: { getAbstractFileByPath: () => null },
		fileManager: { trashFile: async () => undefined },
	} as unknown as App;
	const artifacts = {
		listAvailableArtifacts: async () => [],
		listPackages: async () => [],
		listCommits: async () => [],
	} as unknown as CatalogV2MigrationArtifactStore;
	const stateCoordinator = new CatalogV2StateShadowCoordinator(app, stateStore, () => "Memos", "knomo");
	let installMode: "uninitialized" | "existing_v2" = "uninitialized";

	const coordinator = new CatalogV2UpgradeCoordinator(
		app,
		"Memos/_knomo-data",
		"Memos/_knomo-system",
		catalog,
		stateStore,
		stateCoordinator,
		transactionStore,
		artifacts,
		{
			sessionId: "native-session",
			installMode: "uninitialized",
			getInstallMode: () => installMode,
			now: () => 1,
			legacyReadsDisabled: () => true,
			legacyWriterRemoved: () => true,
		},
	);
	const status = await coordinator.initialize();

	assert.equal(status?.installMode, "uninitialized");
	assert.equal(status?.identityAdoptionReadiness.kind, "blocked");
	installMode = "existing_v2";
	const initializedStatus = await coordinator.run();
	assert.equal(initializedStatus?.installMode, "existing_v2");
	assert.equal(initializedStatus?.identityAdoptionReadiness.kind, "ready");
	transactionStore.close();
	stateStore.close();
});

test("旧库清理前要求每个 active memoId 都已被 Catalog V2 接管", () => {
	assert.equal(hasCatalogIdentityParity(
		["legacy-a", "legacy-b"],
		["legacy-a"],
	), false);
	assert.equal(hasCatalogIdentityParity(
		["legacy-a", "legacy-b", "legacy-a"],
		["legacy-b", "legacy-a"],
	), true);
});

test("uncommitted migration input can be verified in staging and then bound to StateGeneration", async () => {
	const factory = new IDBFactory();
	const stateStore = new IndexedDbCatalogV2StateStore("migration-staging-state", {
		factory,
		keyRange: IDBKeyRange,
	});
	const transactionStore = new IndexedDbCatalogV2TransactionStore("migration-staging-transaction", {
		factory,
		keyRange: IDBKeyRange,
	});
	await Promise.all([stateStore.open(), transactionStore.open()]);
	const emptyState: CatalogV2MaterializedState = {
		schemaVersion: 1,
		memos: {},
		quarantine: [],
		awaitingWriterIds: [],
		forkedWriterIds: [],
		processedOperationCount: 0,
	};
	await stateStore.saveMaterializedState(emptyState);
	const result = await makeMigrationResult();
	if (result.kind !== "imported") throw new Error("Expected imported migration fixture.");
	await stateStore.saveShadowPreview({
		schemaVersion: 1,
		generatedAt: 1,
		catalogDataRoot: "Memos/_knomo-data",
		legacyReceipts: [result.receipt],
		packages: [{ path: result.packagePath, sha256: result.packageSha256, byteLength: result.packageBytes.byteLength }],
		quarantines: [],
		deletedPayloads: [],
		stateSegmentCount: 0,
		materializedMemoCount: 0,
		stateErrors: [],
	});
	const catalogStore = new InMemoryMemoCatalogStore();
	const catalog = new MemoCatalogService(catalogStore);
	await catalog.open();
	const evidence = result.package.identityClaims[0]?.evidence;
	if (evidence === undefined) throw new Error("Missing migration evidence.");
	await catalogStore.replaceFilePartition(buildCatalogPartition({
		inventory: { sourcePath: evidence.sourcePath, logicalDate: evidence.logicalDate, mtime: 1, size: 1 },
		sourceRevision: "e".repeat(64),
		observations: [{
			sourcePath: evidence.sourcePath,
			sourceRevision: "e".repeat(64),
			logicalDate: evidence.logicalDate,
			section: evidence.section,
			startLine: evidence.lineNumberHint ?? 1,
			endLine: evidence.lineNumberHint ?? 1,
			time: evidence.time,
			content: "legacy memo",
			contentHash: evidence.contentHash,
			existingBlockId: evidence.existingBlockId,
			tags: [],
			links: [],
			images: [],
			tasks: [],
			timeBuoyDates: [],
		}],
		parserVersion: 1,
		settingsFingerprint: "contract",
		auditedAt: 1,
	}));
	await catalogStore.setMeta("catalogRevision", 1);
	await catalogStore.setCoverage({
		kind: "complete",
		coveredFromDate: evidence.logicalDate,
		pendingFileCount: 0,
		coveredFileCount: 1,
		totalFileCount: 1,
	});
	const replica = new CatalogV2ReplicaVault();
	const artifactStore = new MigrationArtifactStore(replica.app, "Memos/_knomo-data");
	await artifactStore.persistImportResults([result]);
	let committed = 0;
	const stateCoordinator = {
		getMigrationInputEpoch: () => 0,
		getLatestLegacyV2Receipts: () => [],
		getLatestImportResults: () => [result],
		buildFreshEventState: async () => emptyState,
		getVerifiedGeneration: () => null,
		confirmMigrationReadiness: () => false,
	} as unknown as CatalogV2StateShadowCoordinator;
	const status = await new CatalogV2UpgradeCoordinator(
		replica.app,
		"Memos/_knomo-data",
		"Memos/_knomo-system",
		catalog,
		stateStore,
		stateCoordinator,
		transactionStore,
		artifactStore,
		{
			sessionId: "migration-staging-session",
			installMode: "legacy_upgrade",
			settlementMs: 0,
			now: () => 1,
			legacyReadsDisabled: () => true,
			legacyWriterRemoved: () => true,
			canWriteSharedUpgrade: () => true,
			commitMigration: async () => { committed += 1; },
		},
	).initialize();
	assert.equal(committed, 1, JSON.stringify(status));
	assert.notEqual(status?.selectedGenerationDigest, null);
	assert.equal((await artifactStore.listCommits()).length, 1);
	transactionStore.close();
	stateStore.close();
});

test("legacy migration staging cannot write a shared commit before explicit authorization", async () => {
	const factory = new IDBFactory();
	const stateStore = new IndexedDbCatalogV2StateStore("migration-staging-gated-state", {
		factory,
		keyRange: IDBKeyRange,
	});
	const transactionStore = new IndexedDbCatalogV2TransactionStore("migration-staging-gated-transaction", {
		factory,
		keyRange: IDBKeyRange,
	});
	await Promise.all([stateStore.open(), transactionStore.open()]);
	const emptyState: CatalogV2MaterializedState = {
		schemaVersion: 1,
		memos: {},
		quarantine: [],
		awaitingWriterIds: [],
		forkedWriterIds: [],
		processedOperationCount: 0,
	};
	await stateStore.saveMaterializedState(emptyState);
	const result = await makeMigrationResult();
	if (result.kind !== "imported") throw new Error("Expected imported migration fixture.");
	const catalogStore = new InMemoryMemoCatalogStore();
	const catalog = new MemoCatalogService(catalogStore);
	await catalog.open();
	await catalogStore.setCoverage({
		kind: "complete",
		coveredFromDate: null,
		pendingFileCount: 0,
		coveredFileCount: 0,
		totalFileCount: 0,
	});
	let persisted = 0;
	let committed = 0;
	const artifactStore = {
		listAvailableArtifacts: async () => [],
		listPackages: async () => [],
		listCommits: async () => [],
		persistCommit: async () => { persisted += 1; },
	} as unknown as CatalogV2MigrationArtifactStore;
	const stateCoordinator = {
		getMigrationInputEpoch: () => 0,
		getLatestLegacyV2Receipts: () => [],
		getLatestImportResults: () => [result],
		getVerifiedGeneration: () => null,
		confirmMigrationReadiness: () => false,
	} as unknown as CatalogV2StateShadowCoordinator;
	await new CatalogV2UpgradeCoordinator(
		{} as App,
		"Memos/_knomo-data",
		"Memos/_knomo-system",
		catalog,
		stateStore,
		stateCoordinator,
		transactionStore,
		artifactStore,
		{
			sessionId: "migration-staging-gated",
			installMode: "legacy_upgrade",
			legacyReadsDisabled: () => true,
			legacyWriterRemoved: () => true,
			canWriteSharedUpgrade: () => false,
			commitMigration: async () => { committed += 1; },
		},
	).initialize();
	assert.equal(persisted, 0);
	assert.equal(committed, 0);
	transactionStore.close();
	stateStore.close();
});

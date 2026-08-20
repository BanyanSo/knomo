import assert from "node:assert/strict";
import test from "node:test";
import { TFile, type App } from "obsidian";

import { CatalogV2FeatureService, type CatalogV2FeatureServiceOptions } from "../src/services/CatalogV2FeatureService";
import { CatalogV2StateReducer } from "../src/services/CatalogV2StateReducer";
import { canonicalJson, sha256Text } from "../src/services/CatalogV2Protocol";
import { deriveObservationMemoId } from "../src/services/CatalogV2SharedMutationStore";
import type { CatalogV2MutationRuntime } from "../src/services/CatalogV2MutationRuntime";
import type { CatalogV2StateShadowCoordinator } from "../src/services/CatalogV2StateShadowCoordinator";
import type { IndexedDbCatalogV2StateStore } from "../src/services/IndexedDbCatalogV2StateStore";
import type { IndexedDbCatalogV2TransactionStore } from "../src/services/IndexedDbCatalogV2TransactionStore";
import { buildCatalogPartition, MemoCatalogService } from "../src/services/MemoCatalogService";
import { InMemoryMemoCatalogStore } from "../src/services/MemoCatalogStore";
import type { MemoObservation } from "../src/types/catalog";
import type { CatalogV2MaterializedState, IdentityEvidence, StateOperation } from "../src/types/catalogV2";
import type { CatalogV2SharedMutationInspection, CatalogV2VerifiedVaultContext } from "../src/types/catalogV2Protocol";

test("分页只决定展示窗口，身份解析仍使用完整文件 revision", async () => {
	const sourcePath = "Daily/2026-08-09.md";
	const sourceRevision = "a".repeat(64);
	const first = makeObservation(sourcePath, sourceRevision, 1);
	const second = makeObservation(sourcePath, sourceRevision, 4);
	const store = new InMemoryMemoCatalogStore();
	const catalog = new MemoCatalogService(store);
	await catalog.open();
	await store.replaceFilePartition(buildCatalogPartition({
		inventory: { sourcePath, logicalDate: "2026-08-09", mtime: 1, size: 1 },
		sourceRevision,
		observations: [first, second],
		parserVersion: 1,
		settingsFingerprint: "settings-v1",
		auditedAt: 1,
	}));
	await store.setCoverage({
		kind: "complete",
		coveredFromDate: "2026-08-09",
		pendingFileCount: 0,
		coveredFileCount: 1,
		totalFileCount: 1,
	});
	const state = makeState("m_11111111111111111111111111111111", toEvidence(first));
	const stateCoordinator = {
		loadLocalStateSlice: async () => ({
			snapshot: { state, revision: "state-1" },
			settlement: { stateComplete: true, migrationComplete: true, revisionStable: true, historical: false },
		}),
	} as unknown as CatalogV2StateShadowCoordinator;
	const service = new CatalogV2FeatureService(
		{} as App,
		catalog,
		null,
		stateCoordinator,
		null,
		null,
		null,
		{
			installMode: "existing_v2",
			getHeadings: () => ["Memos"],
			getOrCreateDailyFile: async () => { throw new Error("not used"); },
			getDailyFileForDate: async () => { throw new Error("not used"); },
			refreshCatalogPaths: async () => undefined,
			refreshLocalCatalog: async () => undefined,
			getMemoTimeFormat: () => "HH:mm",
			rebuildLocalCatalog: async () => undefined,
		},
	);
	await service.getReadService().materializeResolutionSnapshot();

	const page = await service.getReadService().query({ limit: 1 });
	assert.equal(page.items.length, 1);
	assert.equal(page.items[0]?.resolved.kind, "ambiguous");
});

test("a manual Daily edit remains read-only and never commits an external rebind", async () => {
	const sourcePath = "Daily/2026-08-09.md";
	const previous = makeObservation(sourcePath, "a".repeat(64), 1);
	const current = { ...makeObservation(sourcePath, "b".repeat(64), 1), content: "edited", contentHash: "fnv1a-87654321" };
	const store = new InMemoryMemoCatalogStore();
	const catalog = new MemoCatalogService(store);
	await catalog.open();
	await store.replaceFilePartition(buildCatalogPartition({
		inventory: { sourcePath, logicalDate: current.logicalDate, mtime: 2, size: 2 },
		sourceRevision: current.sourceRevision,
		observations: [current],
		parserVersion: 1,
		settingsFingerprint: "contract-v2",
		auditedAt: 2,
	}));
	await store.setCoverage({
		kind: "complete",
		coveredFromDate: current.logicalDate,
		pendingFileCount: 0,
		coveredFileCount: 1,
		totalFileCount: 1,
	});
	const claim: StateOperation = {
		schemaVersion: 1,
		writerId: "w_11111111111111111111111111111111",
		sequence: 1,
		opId: "o_11111111111111111111111111111111",
		memoId: "memo-edited",
		occurredAt: "2026-08-09T00:00:00.000Z",
		type: "identity.claim",
		baseEvidence: null,
		payload: { evidence: toEvidence(previous), origin: "plugin_create", createIntentOpId: null },
	};
	const reboundOperations: StateOperation[] = [];
	const reduce = async () => new CatalogV2StateReducer().reduce(await Promise.all([claim, ...reboundOperations]
		.map(async (operation) => ({
			operation,
			digest: await sha256Text(canonicalJson(operation)),
			sourcePath: "generation.json",
		}))));
	const settlement = {
		stateComplete: true,
		migrationComplete: true,
		revisionStable: true,
		historical: false,
		verifiedGenerationId: "c".repeat(64),
		contractDigest: "d".repeat(64),
		blockedMemoIds: [],
	};
	const stateCoordinator = {
		loadLocalStateSlice: async () => ({ snapshot: { state: await reduce(), revision: "state-1" }, settlement }),
		loadLocalStateSnapshot: async () => ({ snapshot: { state: await reduce(), revision: "state-2" }, settlement }),
		capture: async () => undefined,
	} as unknown as CatalogV2StateShadowCoordinator;
	const service = new CatalogV2FeatureService(
		{} as App,
		catalog,
		null,
		stateCoordinator,
		null,
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
		},
	);
	await service.getReadService().materializeResolutionSnapshot();

	const page = await service.getReadService().query({ limit: 10 });
	assert.equal(page.items[0]?.memoId, null);
	assert.notEqual(page.items[0]?.capabilities.edit, "ready");
	assert.deepEqual(reboundOperations, []);
});

test("a shared prepare restores the original memoId candidate after local transaction state is lost", async () => {
	const sourcePath = "Daily/2026-08-09.md";
	const observation = makeObservation(sourcePath, "c".repeat(64), 1);
	const evidence = toEvidence(observation);
	const context = {
		bootstrap: { vaultInstanceId: "v_11111111111111111111111111111111" },
		contractSha256: "d".repeat(64),
	} as unknown as CatalogV2VerifiedVaultContext;
	const memoId = await deriveObservationMemoId(
		context.bootstrap.vaultInstanceId,
		context.contractSha256,
		evidence,
	);
	const store = new InMemoryMemoCatalogStore();
	const catalog = new MemoCatalogService(store);
	await catalog.open();
	await store.replaceFilePartition(buildCatalogPartition({
		inventory: { sourcePath, logicalDate: observation.logicalDate, mtime: 1, size: 1 },
		sourceRevision: observation.sourceRevision,
		observations: [observation],
		parserVersion: 1,
		settingsFingerprint: "contract-v2",
		auditedAt: 1,
	}));
	await store.setCoverage({
		kind: "complete",
		coveredFromDate: observation.logicalDate,
		pendingFileCount: 0,
		coveredFileCount: 1,
		totalFileCount: 1,
	});
	const state = makeEmptyState();
	const stateCoordinator = {
		loadLocalStateSnapshot: async () => ({
			snapshot: { state, revision: "state-shared-prepare" },
			settlement: {
				stateComplete: true,
				migrationComplete: true,
				revisionStable: true,
				historical: false,
				verifiedGenerationId: "e".repeat(64),
				contractDigest: context.contractSha256,
			},
		}),
	} as unknown as CatalogV2StateShadowCoordinator;
	const prepareRef = { path: "prepare.json", sha256: "f".repeat(64), byteLength: 1 };
	const inspection: CatalogV2SharedMutationInspection = {
		records: [{
			mutationId: "o_11111111111111111111111111111111",
			prepare: {
				kind: "knomo.catalog-v2.mutation-prepare",
				schemaVersion: 2,
				vaultInstanceId: context.bootstrap.vaultInstanceId,
				mutationId: "o_11111111111111111111111111111111",
				mutationKind: "create",
				memoId,
				changes: [{
					transition: {
						sourcePath,
						logicalDate: observation.logicalDate,
						headings: ["## Memos"],
						beforeRevision: "b".repeat(64),
						afterRevision: observation.sourceRevision,
						beforeEvidence: null,
						afterEvidence: evidence,
						baseBindingId: null,
						baseEvidence: null,
						preservedEvidence: [],
					},
					replay: { kind: "insert", rawBlock: "- 09:00 same", section: "## Memos" },
				}],
				effectDrafts: [],
				preparedByWriterId: "w_11111111111111111111111111111111",
				preparedAt: "2026-08-09T00:00:00.000Z",
			},
			prepareRef,
			commit: null,
			commitRef: null,
			abandon: null,
			abandonRef: null,
		}],
	missingPrepareMutationIds: [],
	missingCommitMutationIds: ["o_11111111111111111111111111111111"],
	issues: [],
	affectedPaths: [sourcePath],
	affectedMemoIds: [memoId],
	};
	const options = {
		installMode: "existing_v2" as const,
		getHeadings: () => ["## Memos"],
		getOrCreateDailyFile: async () => { throw new Error("not used"); },
		getDailyFileForDate: async () => { throw new Error("not used"); },
		refreshCatalogPaths: async () => undefined,
		refreshLocalCatalog: async () => undefined,
		getMemoTimeFormat: () => "HH:mm" as const,
		rebuildLocalCatalog: async () => undefined,
		getVaultContext: async () => context,
		inspectSharedMutations: async () => inspection,
	} as CatalogV2FeatureServiceOptions & {
		inspectSharedMutations: () => Promise<CatalogV2SharedMutationInspection>;
	};
	const service = new CatalogV2FeatureService(
		{} as App,
		catalog,
		null,
		stateCoordinator,
		null,
		null,
		null,
		options,
	);

	await service.getReadService().materializeResolutionSnapshot();
	const item = (await service.getReadService().query({ limit: 1 })).items[0];
	assert.equal(item?.resolved.kind, "ambiguous");
	assert.equal(item?.resolved.kind === "ambiguous" ? item.resolved.candidates[0]?.memoId : null, memoId);
	assert.equal(item?.capabilities.edit, "blocked_ambiguous");
});

test("verified native reads do not report legacy migration as user-visible settling", async () => {
	const service = await createReadStateService("existing_v2", {
		stateComplete: true,
		migrationComplete: false,
		revisionStable: true,
		historical: false,
	});
	await service.getReadService().query({ limit: 1 });
	const page = await service.getReadService().query({ limit: 1 });

	assert.equal(page.readState, "ready");
	assert.equal(page.degraded, false);
});

test("legacy upgrade and fresh history building expose different read states", async () => {
	const settlement = {
		stateComplete: true,
		migrationComplete: false,
		revisionStable: true,
		historical: false,
	};
	const upgrade = await createReadStateService("legacy_upgrade", settlement);
	await upgrade.getReadService().query({ limit: 1 });
	const upgradePage = await upgrade.getReadService().query({ limit: 1 });
	assert.equal(upgradePage.readState, "upgrade_building");

	const fresh = await createReadStateService("existing_v2", settlement, "partial");
	const freshPage = await fresh.getReadService().query({ limit: 1 });
	assert.equal(freshPage.readState, "history_building");
});

test("ordinary edit uses per-memo readiness while unrelated Catalog history is still building", async () => {
	const sourcePath = "Daily/2026-08-09.md";
	const observation = makeObservation(sourcePath, "a".repeat(64), 1);
	const memoId = "m_77777777777777777777777777777777";
	const store = new InMemoryMemoCatalogStore();
	const catalog = new MemoCatalogService(store);
	await catalog.open();
	await store.replaceFilePartition(buildCatalogPartition({
		inventory: { sourcePath, logicalDate: observation.logicalDate, mtime: 1, size: 1 },
		sourceRevision: observation.sourceRevision,
		observations: [observation],
		parserVersion: 1,
		settingsFingerprint: "settings-v1",
		auditedAt: 1,
	}));
	await store.setCoverage({
		kind: "partial",
		coveredFromDate: observation.logicalDate,
		pendingFileCount: 1,
		coveredFileCount: 1,
		totalFileCount: 2,
	});
	const settlement = {
		stateComplete: true,
		migrationComplete: true,
		revisionStable: true,
		historical: false,
		blockedMemoIds: [],
	};
	const stateInput = {
		snapshot: { state: makeState(memoId, toEvidence(observation)), revision: "state-ordinary-edit" },
		settlement,
	};
	const stateCoordinator = {
		loadLocalStateSnapshot: async () => stateInput,
		loadLocalStateSlice: async () => stateInput,
		capture: async () => undefined,
	} as unknown as CatalogV2StateShadowCoordinator;
	const file = Object.assign(new TFile(), {
		path: sourcePath,
		name: "2026-08-09.md",
		basename: "2026-08-09",
		extension: "md",
		stat: { ctime: 1, mtime: 1, size: 1 },
	});
	let editCalls = 0;
	const mutationRuntime = {
		edit: async (input: { handle: import("../src/types/catalog").ResolvedMemoHandle }) => {
			editCalls += 1;
			return { handle: input.handle, dailySaved: true as const, followUpPending: false };
		},
	} as unknown as CatalogV2MutationRuntime;
	const service = new CatalogV2FeatureService(
		{ vault: { getAbstractFileByPath: () => file } } as unknown as App,
		catalog,
		null,
		stateCoordinator,
		null,
		mutationRuntime,
		null,
		{
			installMode: "existing_v2",
			getHeadings: () => ["## Memos"],
			getOrCreateDailyFile: async () => file,
			getDailyFileForDate: async () => file,
			refreshCatalogPaths: async () => undefined,
			refreshLocalCatalog: async () => undefined,
			getMemoTimeFormat: () => "HH:mm",
			rebuildLocalCatalog: async () => undefined,
		},
	);
	await service.getReadService().materializeResolutionSnapshot();
	const page = await service.getReadService().query({ limit: 1 });
	const item = page.items[0];
	assert.equal(page.readState, "history_building");
	assert.equal(item?.capabilities.edit, "ready");
	assert.equal(service.getOperationalState(page.readState).capabilities.createNew, false);
	assert.ok(item !== undefined);

	const result = await service.edit(item, "updated");

	assert.equal(editCalls, 1);
	assert.equal(result.status, "saved");
});

test("install modes expose actionable operational states", async () => {
	const settlement = { stateComplete: false, migrationComplete: false, revisionStable: false, historical: false };
	const uninitialized = await createReadStateService("uninitialized", settlement);
	const joining = await createReadStateService("joining", settlement);
	const attention = await createReadStateService("attention", settlement);

	assert.equal((await uninitialized.getReadService().query({ limit: 1 })).readState, "needs_initialization");
	assert.equal((await joining.getReadService().query({ limit: 1 })).readState, "waiting_for_sync");
	assert.equal((await attention.getReadService().query({ limit: 1 })).readState, "attention");
	assert.equal(uninitialized.getOperationalState().capabilities.createNew, false);
	assert.equal(joining.getOperationalState().capabilities.projectMonthly, false);
	assert.equal(attention.getOperationalState().capabilities.physicalGc, false);
});

test("card reads survive an unavailable transaction store", async () => {
	const transactionStore = {
		listStateOperationOutbox: async () => { throw new Error("Catalog v2 transaction store is not open."); },
		listOutbox: async () => { throw new Error("Catalog v2 transaction store is not open."); },
		isAuthoritative: () => false,
	} as unknown as IndexedDbCatalogV2TransactionStore;
	const service = await createReadStateService(
		"existing_v2",
		{ stateComplete: true, migrationComplete: true, revisionStable: true, historical: false },
		"complete",
		transactionStore,
	);

	const page = await service.getReadService().query({ limit: 150, cursor: null });

	assert.equal(page.items.length, 1);
});

test("explicit recovery refreshes only the affected Daily path after runtime validation", async () => {
	const store = new InMemoryMemoCatalogStore();
	const catalog = new MemoCatalogService(store);
	await catalog.open();
	const mutationId = "o_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
	const sourcePath = "Daily/2026-08-09.md";
	let recoverCall: { mutationId: string; action: "continue" | "abandon" } | null = null;
	const mutationRuntime = {
		inspectPending: async () => ({
			items: [{
				mutationId,
				transactionId: null,
				memoId: null,
				status: "prepared" as const,
				paths: [sourcePath],
				reasons: [],
			}],
			affectedPaths: [sourcePath],
			affectedMemoIds: [],
		}),
		recoverExplicit: async (nextMutationId: string, action: "continue" | "abandon") => {
			recoverCall = { mutationId: nextMutationId, action };
			return true;
		},
	} as unknown as CatalogV2MutationRuntime;
	const refreshedPaths: string[][] = [];
	const service = new CatalogV2FeatureService(
		{} as App,
		catalog,
		null,
		null,
		null,
		mutationRuntime,
		null,
		{
			installMode: "existing_v2",
			getHeadings: () => ["Memos"],
			getOrCreateDailyFile: async () => { throw new Error("not used"); },
			getDailyFileForDate: async () => { throw new Error("not used"); },
			refreshCatalogPaths: async (paths) => { refreshedPaths.push([...paths]); },
			refreshLocalCatalog: async () => undefined,
			getMemoTimeFormat: () => "HH:mm",
			rebuildLocalCatalog: async () => undefined,
		},
	);

	assert.equal((await service.inspectPendingMutations()).items.length, 1);
	assert.equal(await service.recoverPendingMutation(mutationId, "continue"), true);
	assert.deepEqual(recoverCall, { mutationId, action: "continue" });
	assert.deepEqual(refreshedPaths, [[sourcePath]]);
});

async function createReadStateService(
	installMode: "uninitialized" | "joining" | "attention" | "existing_v2" | "legacy_upgrade",
	settlement: { stateComplete: boolean; migrationComplete: boolean; revisionStable: boolean; historical: boolean },
	coverageKind: "complete" | "partial" = "complete",
	transactionStore: IndexedDbCatalogV2TransactionStore | null = null,
): Promise<CatalogV2FeatureService> {
	const sourcePath = "Daily/2026-08-10.md";
	const sourceRevision = "b".repeat(64);
	const observation = makeObservation(sourcePath, sourceRevision, 1);
	const store = new InMemoryMemoCatalogStore();
	const catalog = new MemoCatalogService(store);
	await catalog.open();
	await store.replaceFilePartition(buildCatalogPartition({
		inventory: { sourcePath, logicalDate: "2026-08-10", mtime: 1, size: 1 },
		sourceRevision,
		observations: [observation],
		parserVersion: 1,
		settingsFingerprint: "settings-v1",
		auditedAt: 1,
	}));
	await store.setCoverage({
		kind: coverageKind,
		coveredFromDate: coverageKind === "complete" ? "2026-08-10" : null,
		pendingFileCount: coverageKind === "complete" ? 0 : 1,
		coveredFileCount: coverageKind === "complete" ? 1 : 0,
		totalFileCount: 1,
	});
	const stateCoordinator = {
		loadLocalStateSlice: async () => ({
			snapshot: { state: makeState("m_22222222222222222222222222222222", toEvidence(observation)), revision: "state-read" },
			settlement,
		}),
	} as unknown as CatalogV2StateShadowCoordinator;
	const service = new CatalogV2FeatureService(
		{} as App,
		catalog,
		null,
		stateCoordinator,
		transactionStore,
		null,
		null,
		{
			installMode,
			getHeadings: () => ["Memos"],
			getOrCreateDailyFile: async () => { throw new Error("not used"); },
			getDailyFileForDate: async () => { throw new Error("not used"); },
			refreshCatalogPaths: async () => undefined,
			refreshLocalCatalog: async () => undefined,
			getMemoTimeFormat: () => "HH:mm",
			rebuildLocalCatalog: async () => undefined,
		},
	);
	await service.getReadService().materializeResolutionSnapshot();
	return service;
}

function makeObservation(sourcePath: string, sourceRevision: string, startLine: number): MemoObservation {
	return {
		sourcePath,
		sourceRevision,
		logicalDate: "2026-08-09",
		section: "## Memos",
		startLine,
		endLine: startLine,
		time: "09:00",
		content: "same",
		contentHash: "fnv1a-12345678",
		existingBlockId: null,
		tags: [],
		links: [],
		images: [],
		tasks: [],
		timeBuoyDates: [],
	};
}

function toEvidence(observation: MemoObservation): IdentityEvidence {
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

function makeState(memoId: string, evidence: IdentityEvidence): CatalogV2MaterializedState {
	return {
		schemaVersion: 1,
		memos: {
			[memoId]: {
				memoId,
				identityOperationIds: ["identity-1"],
				activeBindingHeads: [{ entryId: "identity-1", source: "state", evidence, baseBindingId: null }],
				identityBindings: [{ entryId: "identity-1", source: "state", evidence, baseBindingId: null }],
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
			},
		},
		quarantine: [],
		awaitingWriterIds: [],
		forkedWriterIds: [],
		processedOperationCount: 0,
	};
}

function makeEmptyState(): CatalogV2MaterializedState {
	return {
		schemaVersion: 1,
		memos: {},
		quarantine: [],
		awaitingWriterIds: [],
		forkedWriterIds: [],
		processedOperationCount: 0,
	};
}

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
import type {
	IdentityLedgerBinding,
	IdentityLedgerCreatePlan,
	IdentityLedgerDeleteRecord,
	IdentityLedgerMutationService,
	IdentityLedgerSnapshot,
} from "../src/types/identityLedger";
import type { MarkdownMutationService } from "../src/types/memoOperations";
import type { CatalogV2InstallMode, CatalogV2MaterializedState, IdentityEvidence, StateOperation } from "../src/types/catalogV2";
import type { CatalogV2SharedMutationInspection, CatalogV2VerifiedVaultContext } from "../src/types/catalogV2Protocol";
import type { CatalogV2DeletedMemoItem } from "../src/types/catalogV2View";

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

test("a manual Daily edit remains content-editable and never commits an external rebind during resolution", async () => {
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
	assert.equal(page.items[0]?.capabilities.markdown.edit, true);
	assert.equal(page.items[0]?.capabilities.identity.crossDeviceIdentity, "conflicted");
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
	assert.equal(item?.capabilities.markdown.edit, true);
	assert.equal(item?.capabilities.identity.relation, "conflicted");
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

test("legacy install mode does not alter Catalog read state", async () => {
	const settlement = {
		stateComplete: true,
		migrationComplete: false,
		revisionStable: true,
		historical: false,
	};
	const upgrade = await createReadStateService("legacy_upgrade", settlement);
	await upgrade.getReadService().query({ limit: 1 });
	const upgradePage = await upgrade.getReadService().query({ limit: 1 });
	assert.equal(upgradePage.readState, "ready");

	const fresh = await createReadStateService("existing_v2", settlement, "partial");
	const freshPage = await fresh.getReadService().query({ limit: 1 });
	assert.equal(freshPage.readState, "history_building");
});

test("ordinary edit uses ObservationHandle while unrelated Catalog history is still building", async () => {
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
	const markdownMutations = {
		edit: async () => {
			editCalls += 1;
			return {
				status: "committed_identity_pending" as const,
				observation,
				sourcePaths: [sourcePath],
				catalogUpdatePending: false,
			};
		},
	} as unknown as MarkdownMutationService;
	const service = new CatalogV2FeatureService(
		{ vault: { getAbstractFileByPath: () => file } } as unknown as App,
		catalog,
		null,
		stateCoordinator,
		null,
		null,
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
		markdownMutations,
	);
	await service.getReadService().materializeResolutionSnapshot();
	const page = await service.getReadService().query({ limit: 1 });
	const item = page.items[0];
	assert.equal(page.readState, "history_building");
	assert.equal(item?.capabilities.markdown.edit, true);
	assert.equal(item?.capabilities.identity.crossDeviceIdentity, "ready");
	assert.equal(service.getOperationalState(page.readState).capabilities.createNew, true);
	assert.ok(item !== undefined);

	const result = await service.edit(item, "updated");

	assert.equal(editCalls, 1);
	assert.equal(result.status, "saved");
});

test("install modes do not gate Markdown or Catalog operational states", async () => {
	const settlement = { stateComplete: false, migrationComplete: false, revisionStable: false, historical: false };
	const uninitialized = await createReadStateService("uninitialized", settlement);
	const nonemptyUnconfigured = await createReadStateService("nonempty_unconfigured", settlement);
	const joining = await createReadStateService("joining", settlement);
	const attention = await createReadStateService("attention", settlement);

	assert.equal((await uninitialized.getReadService().query({ limit: 1 })).readState, "ready");
	assert.equal((await nonemptyUnconfigured.getReadService().query({ limit: 1 })).readState, "ready");
	assert.equal((await joining.getReadService().query({ limit: 1 })).readState, "ready");
	assert.equal((await attention.getReadService().query({ limit: 1 })).readState, "ready");
	assert.equal(uninitialized.getOperationalState().capabilities.createNew, true);
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
		{} as MarkdownMutationService,
	);

	assert.equal((await service.inspectPendingMutations()).items.length, 1);
	assert.equal(await service.recoverPendingMutation(mutationId, "continue"), true);
	assert.deepEqual(recoverCall, { mutationId, action: "continue" });
	assert.deepEqual(refreshedPaths, [[sourcePath]]);
});

test("P1 第 5 步：V3 edit/move 在 Daily commit 后续写 rebind，review 不依赖 V2 authority", async () => {
	const before = makeObservation("Daily/2026-08-09.md", "a".repeat(64), 1);
	const afterEdit = { ...makeObservation(before.sourcePath, "b".repeat(64), 1), content: "edited" };
	const afterMove = { ...makeObservation("Daily/2026-08-10.md", "c".repeat(64), 1), logicalDate: "2026-08-10" };
	const order: string[] = [];
	const ledger = makeIdentityLedgerMutationMock(before, {
		onRebind: (_before, _after, reason) => {
			order.push(`rebind:${reason}`);
			return makeLedgerBinding(_after);
		},
		onReview: () => { order.push("review"); },
	});
	const markdownMutations = {
		edit: async () => {
			order.push("daily:edit");
			return committedMarkdownResult(afterEdit);
		},
		move: async () => {
			order.push("daily:move");
			return committedMarkdownResult(afterMove);
		},
	} as unknown as MarkdownMutationService;
	const service = await createV3FeatureService(before, ledger, markdownMutations);
	const item = (await service.getReadService().query({ limit: 1 })).items[0];
	assert.ok(item !== undefined);

	await service.edit(item, "edited");
	await service.move(item, "2026-08-10");
	await service.recordReview(item);

	assert.deepEqual(order, ["daily:edit", "rebind:edit", "daily:move", "rebind:move", "review"]);
});

test("P1 第 5 步：V3 repair 与 adoption 都只走 Identity Ledger", async () => {
	const observation = makeObservation("Daily/2026-08-09.md", "a".repeat(64), 1);
	const repairedMemoId = "01991f40-7c00-7111-9111-111111111111";
	let repairCalls = 0;
	let adoptionCalls = 0;
	const conflictLedger = makeIdentityLedgerMutationMock(observation, {
		state: "conflicted",
		onRepair: () => {
			repairCalls += 1;
			return makeLedgerBinding(observation, repairedMemoId);
		},
	});
	const repairService = await createV3FeatureService(observation, conflictLedger, {} as MarkdownMutationService);
	const conflictItem = (await repairService.getReadService().query({ limit: 1 })).items[0];
	assert.ok(conflictItem !== undefined);
	assert.equal(conflictItem.resolved.kind, "ambiguous");

	await repairService.repairIdentity(conflictItem, repairedMemoId);

	const adoptionLedger = makeIdentityLedgerMutationMock(observation, {
		state: "unbound",
		onAdopt: () => {
			adoptionCalls += 1;
			return makeLedgerBinding(observation, repairedMemoId);
		},
	});
	const adoptionService = await createV3FeatureService(observation, adoptionLedger, {} as MarkdownMutationService);
	const observedItem = (await adoptionService.getReadService().query({ limit: 1 })).items[0];
	assert.ok(observedItem !== undefined);
	assert.equal(observedItem.resolved.kind, "observed");
	assert.equal(adoptionService.getOperationalState().capabilities.adoptExisting, true);
	assert.equal(await adoptionService.adoptMemo(observedItem), repairedMemoId);

	assert.equal(repairCalls, 1);
	assert.equal(adoptionCalls, 1);
});

test("永久删除在执行前重查身份，拒绝沿用过期的无身份 UI 决策", async () => {
	const observation = makeObservation("Daily/2026-08-09.md", "a".repeat(64), 1);
	let removeCalls = 0;
	const markdownMutations = {
		remove: async () => {
			removeCalls += 1;
			return committedMarkdownResult(observation);
		},
	} as unknown as MarkdownMutationService;
	const service = await createV3FeatureService(
		observation,
		makeIdentityLedgerMutationMock(observation),
		markdownMutations,
	);
	const item = (await service.getReadService().query({ limit: 1 })).items[0];
	assert.ok(item !== undefined);
	item.capabilities.identity.recoverableDelete = "absent";

	await assert.rejects(
		() => service.removePermanently(item),
		/requires a current memo without recoverable identity/u,
	);
	assert.equal(removeCalls, 0);
});

test("P1 第 7 步：可恢复删除先持久化 payload 再删 Daily，恢复先写正文再追加 restore", async () => {
	const observation = makeObservation("Daily/2026-08-22.md", "a".repeat(64), 1);
	const order: string[] = [];
	let failDeleteCommit = false;
	let pendingDelete: IdentityLedgerDeleteRecord | null = null;
	let activeDelete: IdentityLedgerDeleteRecord | null = null;
	const baseLedger = makeIdentityLedgerMutationMock(observation);
	const binding = baseLedger.resolveObservation(observation);
	assert.ok(binding !== null);
	const identityLedger: IdentityLedgerMutationService = {
		...baseLedger,
		getActiveDeletes: () => activeDelete === null ? [] : [activeDelete],
		getPendingDeletes: () => pendingDelete === null ? [] : [pendingDelete],
		recordDeletePayload: async (current, evidence) => {
			order.push("identity-delete-payload");
			pendingDelete = {
				memoId: current.memoId,
				deleteEventId: "e_33333333333333333333333333333333",
				deleteCommitEventId: null,
				baseBindingId: current.bindingId,
				evidence,
			};
			return pendingDelete;
		},
		recordDeleteCommit: async (record) => {
			order.push("identity-delete-commit");
			if (failDeleteCommit) throw new Error("identity unavailable");
			activeDelete = { ...record, deleteCommitEventId: "e_44444444444444444444444444444444" };
			pendingDelete = null;
			return activeDelete;
		},
		recordRestore: async (_record, restored) => {
			order.push("identity-restore");
			activeDelete = null;
			return makeLedgerBinding(restored, binding.memoId);
		},
	};
	const rawBlock = "- 09:00 same";
	const markdownMutations = {
		captureObservation: async () => {
			order.push("capture-daily");
			return { observation, rawBlock, deletedSourceRevision: "b".repeat(64) };
		},
		remove: async () => {
			order.push("remove-daily");
			return {
				status: "committed_identity_pending" as const,
				observation: null,
				sourcePaths: [observation.sourcePath],
				catalogUpdatePending: false,
			};
		},
		restore: async () => {
			order.push("restore-daily");
			return {
				status: "committed_identity_pending" as const,
				observation,
				sourcePaths: [observation.sourcePath],
				catalogUpdatePending: false,
			};
		},
	} as unknown as MarkdownMutationService;
	const service = await createV3FeatureService(observation, identityLedger, markdownMutations);
	const item = (await service.getReadService().query({ limit: 1 })).items[0];
	assert.ok(item !== undefined);

	const deletedResult = await service.delete(item);
	assert.equal(deletedResult.followUpPending, false);
	assert.deepEqual(order, [
		"capture-daily",
		"identity-delete-payload",
		"remove-daily",
		"identity-delete-commit",
	]);
	const deleteRecord = identityLedger.getActiveDeletes?.()[0];
	assert.ok(deleteRecord !== undefined);
	await service.restore({
		memoId: binding.memoId,
		identityDeleteEventId: deleteRecord.deleteEventId,
	} as CatalogV2DeletedMemoItem);
	assert.deepEqual(order, [
		"capture-daily",
		"identity-delete-payload",
		"remove-daily",
		"identity-delete-commit",
		"restore-daily",
		"identity-restore",
	]);
	assert.equal(activeDelete, null);

	order.length = 0;
	failDeleteCommit = true;
	const pendingResult = await service.delete(item);
	assert.equal(pendingResult.followUpPending, true);
	assert.deepEqual(order, [
		"capture-daily",
		"identity-delete-payload",
		"remove-daily",
		"identity-delete-commit",
	]);
	assert.equal(identityLedger.getActiveDeletes?.().length, 0);
	assert.equal(identityLedger.getPendingDeletes?.().length, 1);
});

async function createReadStateService(
	installMode: CatalogV2InstallMode,
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
		{} as MarkdownMutationService,
	);
	await service.getReadService().materializeResolutionSnapshot();
	return service;
}

async function createV3FeatureService(
	observation: MemoObservation,
	identityLedger: IdentityLedgerMutationService,
	markdownMutations: MarkdownMutationService,
): Promise<CatalogV2FeatureService> {
	const store = new InMemoryMemoCatalogStore();
	const catalog = new MemoCatalogService(store);
	await catalog.open();
	await store.replaceFilePartition(buildCatalogPartition({
		inventory: {
			sourcePath: observation.sourcePath,
			logicalDate: observation.logicalDate,
			mtime: 1,
			size: 1,
		},
		sourceRevision: observation.sourceRevision,
		observations: [observation],
		parserVersion: 1,
		settingsFingerprint: "settings-v3",
		auditedAt: 1,
	}));
	await store.setCoverage({
		kind: "complete",
		coveredFromDate: observation.logicalDate,
		pendingFileCount: 0,
		coveredFileCount: 1,
		totalFileCount: 1,
	});
	const service = new CatalogV2FeatureService(
		{} as App,
		catalog,
		null,
		null,
		null,
		null,
		null,
		{
			installMode: "uninitialized",
			getHeadings: () => ["## Memos"],
			getOrCreateDailyFile: async () => { throw new Error("not used"); },
			getDailyFileForDate: async () => { throw new Error("not used"); },
			refreshCatalogPaths: async () => undefined,
			refreshLocalCatalog: async () => undefined,
			getMemoTimeFormat: () => "HH:mm",
			rebuildLocalCatalog: async () => undefined,
		},
		markdownMutations,
		identityLedger,
	);
	await service.getReadService().materializeResolutionSnapshot();
	return service;
}

function makeIdentityLedgerMutationMock(
	observation: MemoObservation,
	options: {
		state?: "identified" | "conflicted" | "unbound";
		onRebind?: (
			before: MemoObservation,
			after: MemoObservation,
			reason: "edit" | "move" | "rename" | "restore" | "manual_resolution",
		) => IdentityLedgerBinding;
		onReview?: () => void;
		onRepair?: () => IdentityLedgerBinding;
		onAdopt?: () => IdentityLedgerBinding;
	} = {},
): IdentityLedgerMutationService {
	const memoId = "01991f40-7c00-7111-9111-111111111111";
	const binding = makeLedgerBinding(observation, memoId);
	const state = options.state ?? "identified";
	const plan: IdentityLedgerCreatePlan = {
		memoId,
		intentDurable: true,
		intent: {
			schemaVersion: 1,
			eventId: "e_22222222222222222222222222222222",
			writerId: "w_11111111111111111111111111111111",
			memoId,
			type: "create_intent",
			baseBindingId: null,
			occurredAt: "2026-08-22T00:00:00.000Z",
			evidence: {
				targetPath: observation.sourcePath,
				logicalDate: observation.logicalDate,
				time: observation.time,
				contentHash: observation.contentHash,
				sourceMemoId: null,
			},
		},
	};
	const memos: IdentityLedgerSnapshot["memos"] = {};
	if (state === "conflicted") {
		memos[memoId] = {
			memoId,
			bindings: [binding],
			conflicted: true,
			conflictBaseBindingId: "e_00000000000000000000000000000000",
			sourceMemoIds: [],
			reviewCount: 0,
			lastReviewedAt: null,
		};
	}
	return {
		getRevision: () => "identity-v3-test",
		getStatus: () => "ready",
		getSnapshot: () => ({
			revision: "identity-v3-test",
			eventCount: 2,
			memos,
			pendingIntents: [],
			quarantinedEventIds: [],
		}),
		resolveObservation: () => state === "identified" ? binding : null,
		resolveObservationState: () => state === "identified"
			? { kind: "identified", binding }
			: state === "conflicted"
				? { kind: "conflicted", memoIds: [memoId], bindings: [binding] }
				: { kind: "unbound" },
		getSourceMemoId: () => null,
		getReviewState: () => ({ reviewCount: 0, lastReviewedAt: null }),
		beginCreate: async () => plan,
		finishCreate: async () => binding,
		reconcilePendingCreates: async () => 0,
		reconcileRevision: async () => ({ appendedEventCount: 0, conflictedMemoIds: [] }),
		rebindObservation: async (before, after, reason) => options.onRebind?.(before, after, reason) ?? binding,
		adoptObservation: async () => options.onAdopt?.() ?? binding,
		repairConflict: async () => options.onRepair?.() ?? binding,
		recordReview: async () => { options.onReview?.(); },
	};
}

function makeLedgerBinding(
	observation: MemoObservation,
	memoId = "01991f40-7c00-7111-9111-111111111111",
): IdentityLedgerBinding {
	return {
		memoId,
		bindingId: "e_11111111111111111111111111111111",
		identityRevision: "identity-v3-test",
		evidence: {
			sourcePath: observation.sourcePath,
			sourceRevision: observation.sourceRevision,
			rawBlockHash: observation.rawBlockHash,
			logicalDate: observation.logicalDate,
			section: observation.section,
			startLine: observation.startLine,
			endLine: observation.endLine,
			time: observation.time,
			contentHash: observation.contentHash,
		},
	};
}

function committedMarkdownResult(observation: MemoObservation) {
	return {
		status: "committed_identity_pending" as const,
		observation,
		sourcePaths: [observation.sourcePath],
		catalogUpdatePending: false,
	};
}

function makeObservation(sourcePath: string, sourceRevision: string, startLine: number): MemoObservation {
	return {
		sourcePath,
		sourceRevision,
		rawBlockHash: "fnv1a-rawblock",
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

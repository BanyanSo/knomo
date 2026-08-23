import assert from "node:assert/strict";
import test from "node:test";
import { Notice, TFile } from "obsidian";
import type { App } from "obsidian";

import { t } from "../src/i18n";
import { CatalogV2FeatureService, type CatalogV2FeatureServiceOptions } from "../src/services/CatalogV2FeatureService";
import { createCatalogCapabilities, createResolvedMemoCapabilities } from "../src/services/MemoCapabilityModel";
import type { CatalogV2MutationRuntime } from "../src/services/CatalogV2MutationRuntime";
import type { CatalogV2StateShadowCoordinator } from "../src/services/CatalogV2StateShadowCoordinator";
import type { MemoCatalogService } from "../src/services/MemoCatalogService";
import type { MemoObservation, ResolvedMemoHandle } from "../src/types/catalog";
import type { MarkdownMutationService } from "../src/types/memoOperations";
import type {
	IdentityLedgerBinding,
	IdentityLedgerCreatePlan,
	IdentityLedgerMutationService,
} from "../src/types/identityLedger";
import type {
	CatalogV2DeletedMemoItem,
	CatalogV2MemoItem,
	CatalogV2OperationalState,
} from "../src/types/catalogV2View";
import { toCatalogV2MemoView } from "../src/types/memoView";
import { KnomoView } from "../src/ui/KnomoView";

type SaveOperation = "create" | "edit";
type OtherDailyOperation = "copy" | "move" | "toggleTask" | "delete" | "restore" | "createReferenceText";
type FailurePoint = "catalog_refresh" | "state_capture" | "resolution_materialization";

interface ExpectedSaveResult {
	status: "saved";
	memoId: string | null;
	memo: CatalogV2MemoItem | null;
	timeBuoyDates: string[];
	followUpPending: boolean;
	localRefreshPending: boolean;
}

test("create/edit 的 post-commit 本机收尾失败仍返回已保存状态", async (context) => {
	for (const operation of ["create", "edit"] as const) {
		for (const failurePoint of ["catalog_refresh", "state_capture", "resolution_materialization"] as const) {
			await context.test(`${operation}: ${failurePoint}`, async () => {
				const harness = createFeatureHarness(failurePoint, false);
				const result = await runFeatureSave(harness, operation) as unknown as ExpectedSaveResult;

				assert.equal(result.status, "saved");
				assert.equal(result.memoId, null);
				assert.equal(result.localRefreshPending, true);
				assert.equal(harness.getCommitCount(), 1);
				assert.equal(harness.getDailyContent(), "## Memos\n- 09:00 edited @2026-08-30\n");
			});
		}
	}
});

test("create/edit 的 pre-commit 失败不修改 Daily 并保持失败语义", async (context) => {
	for (const operation of ["create", "edit"] as const) {
		await context.test(operation, async () => {
			const harness = createFeatureHarness(null, true);

			await assert.rejects(() => runFeatureSave(harness, operation), /pre-commit failed/u);
			assert.equal(harness.getCommitCount(), 0);
			assert.equal(harness.getDailyContent(), "## Memos\n- 09:00 before\n");
		});
	}
});

test("其他 Daily mutation 的 post-commit 本机收尾失败仍返回已保存状态", async (context) => {
	for (const operation of ["copy", "move", "toggleTask", "delete", "restore", "createReferenceText"] as const) {
		for (const failurePoint of ["catalog_refresh", "state_capture", "resolution_materialization"] as const) {
			await context.test(`${operation}: ${failurePoint}`, async () => {
				const harness = createFeatureHarness(failurePoint, false);
				const result = await runOtherDailyMutation(harness, operation) as {
					status?: string;
					followUpPending: boolean;
					localRefreshPending: boolean;
				};

				if (operation !== "createReferenceText") assert.equal(result.status, "saved");
				assert.equal(result.localRefreshPending, true);
				assert.equal(harness.getCommitCount(), 1);
				assert.equal(harness.getDailyContent(), "## Memos\n- 09:00 mutated\n");
			});
		}
	}
});

test("其他 Daily mutation 的 pre-commit 失败不修改 Daily 并保持失败语义", async (context) => {
	for (const operation of ["copy", "move", "toggleTask", "delete", "restore", "createReferenceText"] as const) {
		await context.test(operation, async () => {
			const harness = createFeatureHarness(null, true);

			await assert.rejects(() => runOtherDailyMutation(harness, operation), /pre-commit failed/u);
			assert.equal(harness.getCommitCount(), 0);
			assert.equal(harness.getDailyContent(), "## Memos\n- 09:00 before\n");
		});
	}
});

test("显式 Daily recovery 已完成后本机收尾失败仍返回完成", async (context) => {
	for (const failurePoint of ["catalog_refresh", "state_capture", "resolution_materialization"] as const) {
		await context.test(failurePoint, async () => {
			const harness = createFeatureHarness(failurePoint, false);

			assert.equal(await harness.service.recoverPendingMutation("mutation-save-boundary", "continue"), true);
			assert.equal(harness.getCommitCount(), 1);
			assert.equal(harness.getDailyContent(), "## Memos\n- 09:00 recovered\n");
		});
	}
});

test("composer 在 post-commit 收尾失败后清空草稿且不显示内联刷新提示", async () => {
	const harness = createViewHarness("post_commit");

	await harness.saveInput();

	assert.equal(harness.input.value, "");
	assert.equal(harness.getDraftContent(), "");
	assert.equal(harness.getCreateCalls(), 1);
	assert.equal(harness.getStatuses().some((item) => item.isError), false);
	assert.equal(harness.getStatuses().some((item) => item.message.length > 0), false);

	await harness.saveInput();
	assert.equal(harness.getCreateCalls(), 1);
});

test("composer 在 pre-commit 失败后显示错误并保留草稿", async () => {
	const harness = createViewHarness("pre_commit");

	await harness.saveInput();

	assert.equal(harness.input.value, "draft memo");
	assert.equal(harness.getDraftContent(), "draft memo");
	assert.equal(harness.getCreateCalls(), 1);
	assert.equal(harness.getStatuses().at(-1)?.isError, true);
});

test("非空未配置 Vault 不再初始化身份协议，直接保存当前草稿", async () => {
	const harness = createViewHarness("post_commit", {
		installMode: "nonempty_unconfigured",
		initializeResult: true,
	});

	await harness.saveInput();

	assert.equal(harness.getInitializeCalls(), 0);
	assert.equal(harness.getCreateCalls(), 1);
	assert.equal(harness.input.value, "");
});

test("身份初始化回调不可用也不阻塞首次 Daily 保存", async () => {
	const harness = createViewHarness("post_commit", {
		installMode: "nonempty_unconfigured",
		initializeResult: false,
	});

	await harness.saveInput();

	assert.equal(harness.getInitializeCalls(), 0);
	assert.equal(harness.getCreateCalls(), 1);
	assert.equal(harness.input.value, "");
	assert.equal(harness.getDraftContent(), "");
});

test("P0 第 4 步 create 顺序固定为 intent -> Daily -> claim，成功后返回稳定 memoId", async () => {
	const order: string[] = [];
	const plan = makeIdentityCreatePlan(true);
	const ledger = makeIdentityLedgerStub(plan, order);
	const harness = createFeatureHarness(null, false, { identityLedger: ledger, order });

	const result = await harness.service.create("edited @2026-08-30", null);

	assert.deepEqual(order, ["intent", "daily", "claim"]);
	assert.equal(result.status, "saved");
	assert.equal(result.memoId, plan.memoId);
	assert.equal(result.followUpPending, false);
	assert.equal(harness.getCommitCount(), 1);
});

test("V3-FAIL-005：Identity Ledger 写失败不阻塞 Daily，结果明确保持 pending", async () => {
	const order: string[] = [];
	const plan = makeIdentityCreatePlan(false);
	const ledger = makeIdentityLedgerStub(plan, order, true);
	const harness = createFeatureHarness(null, false, { identityLedger: ledger, order });

	const result = await harness.service.create("edited @2026-08-30", null);

	assert.deepEqual(order, ["intent", "daily", "claim"]);
	assert.equal(result.status, "saved");
	assert.equal(result.memoId, plan.memoId);
	assert.equal(result.followUpPending, true);
	assert.equal(harness.getCommitCount(), 1);
});

test("V3-OP-003：intent durable 后 Daily 失败，不追加 claim 且不产生可见 memo", async () => {
	const order: string[] = [];
	const plan = makeIdentityCreatePlan(true);
	const ledger = makeIdentityLedgerStub(plan, order);
	const harness = createFeatureHarness(null, true, { identityLedger: ledger, order });

	await assert.rejects(() => harness.service.create("edited @2026-08-30", null), /pre-commit failed/u);

	assert.deepEqual(order, ["intent", "daily"]);
	assert.equal(harness.getCommitCount(), 0);
});

test("task 在 Daily 已提交后即使 UI reload 失败也不回滚 checkbox 或显示更新失败", async () => {
	const item = makeMemoItem(makeObservation("- [ ] task", "a".repeat(64), []));
	const view = Object.create(KnomoView.prototype) as KnomoView;
	let checkboxRollbackCalls = 0;
	const statuses: Array<{ message: string; isError: boolean }> = [];
	const notices = getNoticeMessages();
	notices.length = 0;
	Object.assign(view, {
		catalogV2FeatureService: {
			toggleTask: async () => ({
				status: "saved" as const,
				memoId: item.memoId,
				memo: null,
				timeBuoyDates: [],
				followUpPending: false,
				localRefreshPending: true,
			}),
		},
		resolveCatalogV2Memo: async () => item,
		mobileMemoHydrator: { getSnapshot: () => ({ allMemosLoaded: false }) },
		reloadMemos: async () => { throw new Error("UI reload failed"); },
		memoMarkdownRenderer: {
			syncTaskCheckboxesForMemo: () => { checkboxRollbackCalls += 1; },
		},
		cardFlowEl: null,
		mobileSearchController: { results: null, isOpen: false },
		updateStatus: (message: string, isError: boolean) => { statuses.push({ message, isError }); },
	});

	await (view as unknown as {
		handleCatalogV2TaskToggle: (memo: ReturnType<typeof toCatalogV2MemoView>, taskIndex: number, checked: boolean) => Promise<void>;
	}).handleCatalogV2TaskToggle(toCatalogV2MemoView(item), 0, true);

	assert.equal(checkboxRollbackCalls, 0);
	assert.equal(notices.includes(t("task.updateFailed")), false);
	assert.deepEqual(statuses, []);
});

test("delete 在 Daily 已提交后即使 UI reload 失败也不显示操作失败", async () => {
	const item = makeMemoItem(makeObservation("delete me", "a".repeat(64), []));
	const memo = toCatalogV2MemoView(item);
	const view = Object.create(KnomoView.prototype) as KnomoView;
	const statuses: Array<{ message: string; isError: boolean }> = [];
	const notices = getNoticeMessages();
	notices.length = 0;
	Object.assign(view, {
		currentLayout: "desktop-wide",
		mobileSearchController: { results: null, isOpen: false },
		catalogV2FeatureService: {
			delete: async () => ({
				status: "saved" as const,
				memoId: item.memoId,
				followUpPending: false,
				localRefreshPending: true,
			}),
		},
		resolveCatalogV2Memo: async () => item,
		mobileMemoHydrator: { getSnapshot: () => ({ allMemosLoaded: false }) },
		reloadMemos: async () => { throw new Error("UI reload failed"); },
		closeCardMenu: () => undefined,
		syncUiChrome: () => undefined,
		syncCardMenuState: () => undefined,
		updateStatus: (message: string, isError: boolean) => { statuses.push({ message, isError }); },
	});

	await (view as unknown as {
		handleMemoAction: (
			action: "delete",
			memoInput: ReturnType<typeof toCatalogV2MemoView>,
			candidateMemoId: null,
		) => Promise<void>;
	}).handleMemoAction("delete", memo, null);

	assert.equal(notices.includes(t("error.operationFailed")), false);
	assert.equal(notices.includes(t("notice.deleted")), true);
	assert.deepEqual(statuses, []);
});

function createFeatureHarness(
	failurePoint: FailurePoint | null,
	preCommitFailure: boolean,
	harnessOptions: {
		identityLedger?: IdentityLedgerMutationService;
		order?: string[];
	} = {},
): {
	service: CatalogV2FeatureService;
	item: CatalogV2MemoItem;
	deletedItem: CatalogV2DeletedMemoItem;
	enableV3Delete: () => void;
	getCommitCount: () => number;
	getDailyContent: () => string;
} {
	const sourcePath = "Daily/2026-08-30.md";
	const targetPath = "Daily/2026-08-31.md";
	const file = Object.assign(new TFile(), {
		path: sourcePath,
		name: "2026-08-30.md",
		basename: "2026-08-30",
		extension: "md",
		stat: { ctime: 1, mtime: 1, size: 1 },
	});
	const targetFile = Object.assign(new TFile(), {
		path: targetPath,
		name: "2026-08-31.md",
		basename: "2026-08-31",
		extension: "md",
		stat: { ctime: 1, mtime: 1, size: 1 },
	});
	let dailyContent = "## Memos\n- 09:00 before\n";
	let commitCount = 0;
	const before = makeObservation("before", "a".repeat(64), []);
	const after = makeObservation("edited @2026-08-30", "b".repeat(64), ["2026-08-30"]);
	const handle: ResolvedMemoHandle = {
		memoId: "memo-save-boundary",
		activeBindingId: "binding-before",
		evidence: toHandleEvidence(before),
		bindingEvidence: toHandleEvidence(before),
		stateRevision: before.sourceRevision,
	};
	const afterHandle: ResolvedMemoHandle = {
		memoId: handle.memoId,
		activeBindingId: "binding-after",
		evidence: toHandleEvidence(after),
		bindingEvidence: toHandleEvidence(after),
		stateRevision: after.sourceRevision,
	};
	const app = {
		vault: {
			getFiles: () => [file, targetFile],
			getAbstractFileByPath: (path: string) => path === sourcePath ? file : path === targetPath ? targetFile : null,
			cachedRead: async () => dailyContent,
		},
		fileManager: {
			generateMarkdownLink: (_file: TFile, _sourcePath: string, subpath: string) => `[[${sourcePath}${subpath}]]`,
		},
	} as unknown as App;
	const stateCoordinator = {
		capture: async () => {
			if (failurePoint === "state_capture") throw new Error("state capture failed");
		},
	} as unknown as CatalogV2StateShadowCoordinator;
	const mutationRuntime = {
		inspectPending: async () => ({
			items: [{ mutationId: "mutation-save-boundary", paths: [sourcePath] }],
			affectedPaths: [sourcePath],
			affectedMemoIds: [handle.memoId],
		}),
		recoverExplicit: async () => {
			if (preCommitFailure) throw new Error("pre-commit failed");
			commitCount += 1;
			dailyContent = "## Memos\n- 09:00 recovered\n";
			return true;
		},
		...Object.fromEntries(["copy", "move", "toggleTask", "delete", "restore", "ensureReferenceAnchor"].map((operation) => [
			operation,
			async () => {
				if (preCommitFailure) throw new Error("pre-commit failed");
				commitCount += 1;
				dailyContent = "## Memos\n- 09:00 mutated\n";
				if (operation === "copy") {
					return {
						memoId: "memo-copy-boundary",
						handle: null,
						observation: after,
						dailySaved: true as const,
						followUpPending: false,
					};
				}
				if (operation === "delete") return { dailySaved: true as const, followUpPending: false };
				return { handle: afterHandle, dailySaved: true as const, followUpPending: false };
			},
		])),
		create: async () => {
			if (preCommitFailure) throw new Error("pre-commit failed");
			commitCount += 1;
			dailyContent = "## Memos\n- 09:00 edited @2026-08-30\n";
			return {
				memoId: handle.memoId,
				handle: null,
				observation: after,
				dailySaved: true as const,
				followUpPending: false,
			};
		},
		edit: async () => {
			if (preCommitFailure) throw new Error("pre-commit failed");
			commitCount += 1;
			dailyContent = "## Memos\n- 09:00 edited @2026-08-30\n";
			return {
				handle,
				dailySaved: true as const,
				followUpPending: false,
			};
		},
	} as unknown as CatalogV2MutationRuntime;
	const runMarkdownMutation = async (operation: "create" | "edit" | "copy" | "move" | "toggleTask" | "reference") => {
		harnessOptions.order?.push("daily");
		if (preCommitFailure) throw new Error("pre-commit failed");
		commitCount += 1;
		dailyContent = operation === "create" || operation === "edit"
			? "## Memos\n- 09:00 edited @2026-08-30\n"
			: "## Memos\n- 09:00 mutated\n";
		return {
			status: "committed_identity_pending" as const,
			observation: after,
			sourcePaths: [sourcePath],
			catalogUpdatePending: failurePoint === "catalog_refresh",
		};
	};
	const markdownMutations = {
		create: async () => runMarkdownMutation("create"),
		edit: async () => runMarkdownMutation("edit"),
		copy: async () => runMarkdownMutation("copy"),
		move: async () => runMarkdownMutation("move"),
		toggleTask: async () => runMarkdownMutation("toggleTask"),
		captureObservation: async () => ({ observation: before, rawBlock: "- 09:00 before" }),
		remove: async () => ({ ...await runMarkdownMutation("toggleTask"), observation: null }),
		createBlockReference: async () => ({
			...await runMarkdownMutation("reference"),
			blockId: "abc123",
		}),
	} as MarkdownMutationService;
	const options: CatalogV2FeatureServiceOptions = {
		installMode: "existing_v2",
		getHeadings: () => ["## Memos"],
		getOrCreateDailyFile: async () => targetFile,
		getDailyFileForDate: async (logicalDate) => logicalDate === "2026-08-31" ? targetFile : file,
		refreshCatalogPaths: async () => {
			if (failurePoint === "catalog_refresh" && commitCount > 0) throw new Error("catalog refresh failed");
		},
		refreshLocalCatalog: async () => undefined,
		getMemoTimeFormat: () => "HH:mm",
		rebuildLocalCatalog: async () => undefined,
		now: () => new Date(2026, 7, 30, 9, 0, 0),
	};
	const service = new CatalogV2FeatureService(
		app,
		{} as MemoCatalogService,
		null,
		stateCoordinator,
		null,
		mutationRuntime,
		null,
		options,
		markdownMutations,
		harnessOptions.identityLedger ?? null,
	);
	const operationalState: CatalogV2OperationalState = {
		readState: "ready",
		capabilities: {
			readKnown: true,
			createNew: true,
			adoptExisting: false,
			projectMonthly: false,
			physicalGc: false,
		},
	};
	Object.assign(service, {
		getOperationalState: () => operationalState,
		isIdentityMutationReady: () => true,
		getWritableHandle: async () => handle,
		findMemoById: async () => null,
		readService: {
			materializeResolutionSnapshot: async () => {
				if (failurePoint === "resolution_materialization" && commitCount > 0) {
					throw new Error("resolution materialization failed");
				}
				return null;
			},
			resolveObservationInFile: async () => makeMemoItem(before).resolved,
			query: async () => ({ items: [], nextCursor: null }),
		},
	});
	const deleteLedger = makeIdentityLedgerStub(makeIdentityCreatePlan(true), []);
	return {
		service,
		item: makeMemoItem(before),
		deletedItem: {
			key: "memo-save-boundary\u0000delete-op",
			memoId: "memo-save-boundary",
			deleteVersion: {
				deleteOpId: "delete-op",
				entryId: "delete-entry",
				payload: {
					path: "_knomo-data/deleted/memo-save-boundary/delete-op.json",
					sha256: "c".repeat(64),
					byteLength: 128,
				},
				baseEvidence: toHandleEvidence(before),
				baseBindingId: handle.activeBindingId,
			},
			deletedAt: "2026-08-30T10:00:00.000Z",
			logicalDate: "2026-08-30",
			sourcePath,
			section: "## Memos",
			content: "before",
			sourceMemoId: null,
			payloadAvailable: true,
		},
		enableV3Delete: () => {
			Object.assign(service, { identityLedger: deleteLedger });
		},
		getCommitCount: () => commitCount,
		getDailyContent: () => dailyContent,
	};
}

function makeIdentityCreatePlan(intentDurable: boolean): IdentityLedgerCreatePlan {
	return {
		memoId: "01991f40-7c00-7111-9111-111111111111",
		intentDurable,
		intent: {
			schemaVersion: 1,
			eventId: "e_11111111111111111111111111111111",
			writerId: "w_11111111111111111111111111111111",
			memoId: "01991f40-7c00-7111-9111-111111111111",
			type: "create_intent",
			baseBindingId: null,
			occurredAt: "2026-08-30T09:00:00.000Z",
			evidence: {
				targetPath: "Daily/2026-08-30.md",
				logicalDate: "2026-08-30",
				time: "09:00",
				contentHash: "fnv1a-12345678",
				sourceMemoId: null,
			},
		},
	};
}

function makeIdentityLedgerStub(
	plan: IdentityLedgerCreatePlan,
	order: string[],
	failClaim = false,
): IdentityLedgerMutationService {
	const binding: IdentityLedgerBinding = {
		memoId: plan.memoId,
		bindingId: "e_22222222222222222222222222222222",
		identityRevision: "identity-v3-test",
		evidence: {
			sourcePath: "Daily/2026-08-30.md",
			sourceRevision: "b".repeat(64),
			rawBlockHash: "fnv1a-12345678",
			logicalDate: "2026-08-30",
			section: "## Memos",
			startLine: 1,
			endLine: 1,
			time: "09:00",
			contentHash: "fnv1a-12345678",
		},
	};
	return {
		getRevision: () => binding.identityRevision,
		getStatus: () => failClaim ? "unavailable" : "ready",
		getSnapshot: () => ({
			revision: binding.identityRevision,
			eventCount: failClaim ? 1 : 2,
			memos: {},
			pendingIntents: [],
			quarantinedEventIds: [],
		}),
		resolveObservation: () => failClaim ? null : binding,
		resolveObservationState: () => failClaim
			? { kind: "unbound" }
			: { kind: "identified", binding },
		getSourceMemoId: () => null,
		getReviewState: () => ({ reviewCount: 0, lastReviewedAt: null }),
		beginCreate: async () => {
			order.push("intent");
			return plan;
		},
		finishCreate: async () => {
			order.push("claim");
			if (failClaim) throw new Error("identity root unavailable");
			return binding;
		},
		reconcilePendingCreates: async () => 0,
		reconcileRevision: async () => ({ appendedEventCount: 0, conflictedMemoIds: [] }),
		rebindObservation: async () => failClaim ? null : binding,
		adoptObservation: async () => binding,
		repairConflict: async () => binding,
		recordReview: async () => undefined,
		getActiveDeletes: () => [],
		recordDeletePayload: async (current, evidence) => ({
			memoId: current.memoId,
			deleteEventId: "e_33333333333333333333333333333333",
			baseBindingId: current.bindingId,
			evidence,
		}),
	};
}

async function runOtherDailyMutation(
	harness: ReturnType<typeof createFeatureHarness>,
	operation: OtherDailyOperation,
): Promise<unknown> {
	switch (operation) {
		case "copy":
			return harness.service.copy(harness.item, "2026-08-31");
		case "move":
			return harness.service.move(harness.item, "2026-08-31");
		case "toggleTask":
			return harness.service.toggleTask(harness.item, 0, true);
		case "delete":
			harness.enableV3Delete();
			return harness.service.delete(harness.item);
		case "restore":
			return harness.service.restore(harness.deletedItem);
		case "createReferenceText":
			return harness.service.createReferenceText(harness.item);
	}
}

async function runFeatureSave(
	harness: ReturnType<typeof createFeatureHarness>,
	operation: SaveOperation,
): Promise<unknown> {
	return operation === "create"
		? harness.service.create("edited @2026-08-30")
		: harness.service.edit(harness.item, "edited @2026-08-30");
}

function createViewHarness(
	mode: "pre_commit" | "post_commit",
	options: {
		installMode?: "existing_v2" | "nonempty_unconfigured";
		initializeResult?: boolean;
	} = {},
): {
	input: { value: string };
	saveInput: () => Promise<void>;
	getCreateCalls: () => number;
	getInitializeCalls: () => number;
	getDraftContent: () => string;
	getStatuses: () => Array<{ message: string; isError: boolean }>;
} {
	const view = Object.create(KnomoView.prototype) as KnomoView;
	const input = { value: "draft memo" };
	const statuses: Array<{ message: string; isError: boolean }> = [];
	let createCalls = 0;
	let initializeCalls = 0;
	let installMode = options.installMode ?? "existing_v2";
	const feature = {
		getOperationalState: () => ({
			installMode,
			capabilities: { createNew: installMode === "existing_v2" },
		}),
		create: async () => {
			createCalls += 1;
			if (mode === "pre_commit") throw new Error("pre-commit failed");
			return {
				status: "saved" as const,
				memoId: "memo-save-boundary",
				memo: null,
				timeBuoyDates: [],
				followUpPending: false,
				localRefreshPending: true,
			};
		},
	} as unknown as CatalogV2FeatureService;
	Object.assign(view, {
		inputEl: input,
		isSaving: false,
		editingMemo: null,
		quoteSourceMemoId: null,
		quoteReferenceText: null,
		quoteMarkdownText: null,
		currentLayout: "desktop-wide",
		draftContent: "draft memo",
		composerOpen: true,
		catalogV2FeatureService: feature,
		getCatalogInstallMode: () => installMode,
		getCatalogInitializationAllowed: () => true,
		onInitializeCatalogVault: async () => {
			initializeCalls += 1;
			const initialized = options.initializeResult ?? true;
			if (initialized) installMode = "existing_v2";
			return initialized;
		},
		mobileMemoHydrator: { getSnapshot: () => ({ allMemosLoaded: false }) },
		closeTimeBuoyPicker: () => undefined,
		updateStatus: (message: string, isError: boolean) => { statuses.push({ message, isError }); },
		updateSendButtonState: () => undefined,
		reloadMemos: async () => { throw new Error("local reload failed"); },
		refresh: async () => undefined,
		clearComposerContext: () => undefined,
		syncComposerMode: () => undefined,
		updateCancelEditButtonState: () => undefined,
		resizeInput: () => undefined,
		showTimeBuoySaveFeedback: () => undefined,
		syncRootState: () => undefined,
	});
	return {
		input,
		saveInput: () => (view as unknown as { saveInput: () => Promise<void> }).saveInput(),
		getCreateCalls: () => createCalls,
		getInitializeCalls: () => initializeCalls,
		getDraftContent: () => (view as unknown as { draftContent: string }).draftContent,
		getStatuses: () => statuses,
	};
}

function makeObservation(content: string, sourceRevision: string, timeBuoyDates: string[]): MemoObservation {
	return {
		sourcePath: "Daily/2026-08-30.md",
		sourceRevision,
		rawBlockHash: `fnv1a-raw-${sourceRevision.slice(0, 8)}`,
		logicalDate: "2026-08-30",
		section: "## Memos",
		startLine: 1,
		endLine: 1,
		time: "09:00",
		content,
		contentHash: `fnv1a-${sourceRevision.slice(0, 8)}`,
		existingBlockId: null,
		tags: [],
		links: [],
		images: [],
		tasks: [],
		timeBuoyDates,
	};
}

function toHandleEvidence(observation: MemoObservation): ResolvedMemoHandle["evidence"] {
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

function makeMemoItem(observation: MemoObservation): CatalogV2MemoItem {
	const identityHandle = {
		memoId: "memo-save-boundary",
		activeBindingId: "binding-before",
		identityRevision: observation.sourceRevision,
	};
	const resolvedCapabilities = createResolvedMemoCapabilities("ready");
	return {
		key: "memo-save-boundary",
		renderKey: `${observation.sourcePath}\u0000${observation.startLine.toString().padStart(10, "0")}`,
		memoId: "memo-save-boundary",
		identityHandle,
		observationHandle: {
			sourcePath: observation.sourcePath,
			sourceRevision: observation.sourceRevision,
			startLine: observation.startLine,
			endLine: observation.endLine,
			rawBlockHash: observation.rawBlockHash,
		},
		createdAt: "2026-08-30T09:00:00",
		content: observation.content,
		tags: [],
		links: [],
		images: [],
		tasks: [],
		timeBuoyDates: [],
		sourcePath: observation.sourcePath,
		lineNumberHint: observation.startLine,
		sourceMemoId: null,
		capabilities: {
			...resolvedCapabilities,
			catalog: createCatalogCapabilities({
				kind: "complete",
				coveredFromDate: observation.logicalDate,
				pendingFileCount: 0,
				coveredFileCount: 1,
				totalFileCount: 1,
			}),
		},
		resolved: {
			kind: "identified",
			bindingEvidence: toHandleEvidence(observation),
			identityHandle,
			observation,
			capabilities: resolvedCapabilities,
			stateRevision: observation.sourceRevision,
		},
		observation: observation as CatalogV2MemoItem["observation"],
	};
}

function getNoticeMessages(): string[] {
	return (Notice as unknown as { messages: string[] }).messages;
}

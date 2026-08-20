import assert from "node:assert/strict";
import test from "node:test";
import { Notice, TFile } from "obsidian";
import type { App } from "obsidian";

import { t } from "../src/i18n";
import { CatalogV2FeatureService, type CatalogV2FeatureServiceOptions } from "../src/services/CatalogV2FeatureService";
import type { CatalogV2MutationRuntime } from "../src/services/CatalogV2MutationRuntime";
import type { CatalogV2StateShadowCoordinator } from "../src/services/CatalogV2StateShadowCoordinator";
import type { MemoCatalogService } from "../src/services/MemoCatalogService";
import type { MemoObservation, ResolvedMemoHandle } from "../src/types/catalog";
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
	memoId: string;
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
				assert.equal(result.memoId, "memo-save-boundary");
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

test("composer 在 post-commit 收尾失败后清空草稿且不会再次创建正文", async () => {
	const harness = createViewHarness("post_commit");

	await harness.saveInput();

	assert.equal(harness.input.value, "");
	assert.equal(harness.getDraftContent(), "");
	assert.equal(harness.getCreateCalls(), 1);
	assert.equal(harness.getStatuses().some((item) => item.isError), false);
	assert.notEqual(harness.getStatuses().at(-1)?.message, "");

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
	assert.equal(statuses.at(-1)?.isError, false);
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
	assert.equal(statuses.at(-1)?.isError, false);
});

function createFeatureHarness(failurePoint: FailurePoint | null, preCommitFailure: boolean): {
	service: CatalogV2FeatureService;
	item: CatalogV2MemoItem;
	deletedItem: CatalogV2DeletedMemoItem;
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
	const options: CatalogV2FeatureServiceOptions = {
		installMode: "existing_v2",
		getHeadings: () => ["## Memos"],
		getOrCreateDailyFile: async () => targetFile,
		getDailyFileForDate: async (logicalDate) => logicalDate === "2026-08-31" ? targetFile : file,
		refreshCatalogPaths: async () => {
			if (failurePoint === "catalog_refresh") throw new Error("catalog refresh failed");
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
	);
	const operationalState: CatalogV2OperationalState = {
		installMode: "existing_v2",
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
		getWritableHandle: async () => handle,
		findMemoById: async () => null,
		readService: {
			materializeResolutionSnapshot: async () => {
				if (failurePoint === "resolution_materialization") {
					throw new Error("resolution materialization failed");
				}
				return null;
			},
			query: async () => ({ items: [] }),
		},
	});
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
		getCommitCount: () => commitCount,
		getDailyContent: () => dailyContent,
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

function createViewHarness(mode: "pre_commit" | "post_commit"): {
	input: { value: string };
	saveInput: () => Promise<void>;
	getCreateCalls: () => number;
	getDraftContent: () => string;
	getStatuses: () => Array<{ message: string; isError: boolean }>;
} {
	const view = Object.create(KnomoView.prototype) as KnomoView;
	const input = { value: "draft memo" };
	const statuses: Array<{ message: string; isError: boolean }> = [];
	let createCalls = 0;
	const feature = {
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
		mobileMemoHydrator: { getSnapshot: () => ({ allMemosLoaded: false }) },
		closeTimeBuoyPicker: () => undefined,
		updateStatus: (message: string, isError: boolean) => { statuses.push({ message, isError }); },
		updateSendButtonState: () => undefined,
		reloadMemos: async () => { throw new Error("local reload failed"); },
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
		getDraftContent: () => (view as unknown as { draftContent: string }).draftContent,
		getStatuses: () => statuses,
	};
}

function makeObservation(content: string, sourceRevision: string, timeBuoyDates: string[]): MemoObservation {
	return {
		sourcePath: "Daily/2026-08-30.md",
		sourceRevision,
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
	return {
		key: "memo-save-boundary",
		memoId: "memo-save-boundary",
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
			view: true,
			copy: true,
			openDaily: true,
			openLinks: true,
			openImages: true,
			copyAsNew: "ready",
			edit: "ready",
			toggleTask: "ready",
			delete: "ready",
			createReference: "ready",
			recordReview: "ready",
		},
		resolved: {
			kind: "identified",
			memoId: "memo-save-boundary",
			activeBindingId: "binding-before",
			bindingEvidence: toHandleEvidence(observation),
			observation,
			capabilities: {
				view: true,
				copy: true,
				openDaily: true,
				openLinks: true,
				openImages: true,
				copyAsNew: "ready",
				edit: "ready",
				toggleTask: "ready",
				delete: "ready",
				createReference: "ready",
				recordReview: "ready",
			},
			stateRevision: observation.sourceRevision,
		},
		observation: observation as CatalogV2MemoItem["observation"],
	};
}

function getNoticeMessages(): string[] {
	return (Notice as unknown as { messages: string[] }).messages;
}

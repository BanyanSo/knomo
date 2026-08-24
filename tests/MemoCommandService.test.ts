import assert from "node:assert/strict";
import test from "node:test";
import type { App } from "obsidian";

import type { MemoObservation } from "../src/types/catalog";
import type { TrashMemoItem } from "../src/types/catalogView";
import type {
	IdentityLedgerBinding,
	IdentityLedgerCreatePlan,
	IdentityLedgerDeleteRecord,
	IdentityLedgerMutationService,
} from "../src/types/identityLedger";
import type { MarkdownMutationService } from "../src/types/memoOperations";

import { ensureObsidianStub } from "./helpers/obsidianStub";

test("create 固定执行 intent、Daily、claim；Daily 失败时不写 claim", async () => {
	await ensureObsidianStub();
	const { MemoCommandService } = await import("../src/services/MemoCommandService");
	const { MemoCatalogService } = await import("../src/services/MemoCatalogService");
	const { InMemoryMemoCatalogStore } = await import("../src/services/MemoCatalogStore");
	const events: string[] = [];
	const store = new InMemoryMemoCatalogStore();
	const catalog = new MemoCatalogService(store);
	await catalog.open();
	const observation = makeObservation("Daily/2026-08-22.md", "2026-08-22", 1, "created memo");
	const binding = makeBinding(observation, "2026082212345601", "identity-1");
	let claimed = false;
	const plan = makeCreatePlan(binding.memoId);
	const identityLedger = {
		getRevision: () => claimed ? "identity-1" : "identity-0",
		getStatus: () => "ready",
		getSnapshot: () => ({ revision: claimed ? "identity-1" : "identity-0", eventCount: claimed ? 2 : 1, memos: {}, pendingIntents: [], quarantinedEventIds: [] }),
		resolveObservation: () => claimed ? binding : null,
		resolveObservationState: () => claimed
			? { kind: "identified", binding } as const
			: { kind: "unbound" } as const,
		getSourceMemoId: () => null,
		getReviewState: () => ({ reviewCount: 0, lastReviewedAt: null }),
		beginCreate: async () => {
			events.push("intent");
			return plan;
		},
		finishCreate: async () => {
			events.push("claim");
			claimed = true;
			return binding;
		},
	} as unknown as IdentityLedgerMutationService;
	const markdownMutations = {
		create: async () => {
			events.push("daily");
			await seedCatalog(catalog, store, observation);
			return mutationResult(observation);
		},
	} as unknown as MarkdownMutationService;
	const service = new MemoCommandService(
		{} as App,
		catalog,
		makeCommandOptions(),
		markdownMutations,
		identityLedger,
	);

	const result = await service.create(observation.content);

	assert.deepEqual(events, ["intent", "daily", "claim"]);
	assert.equal(result.memoId, binding.memoId);
	assert.equal(result.followUpPending, false);
	assert.equal(result.localRefreshPending, false);

	events.length = 0;
	claimed = false;
	const failingMarkdown = {
		create: async () => {
			events.push("daily");
			throw new Error("Daily write failed");
		},
	} as unknown as MarkdownMutationService;
	const failingService = new MemoCommandService(
		{} as App,
		catalog,
		makeCommandOptions(),
		failingMarkdown,
		identityLedger,
	);

	await assert.rejects(() => failingService.create("will fail"), /Daily write failed/u);
	assert.deepEqual(events, ["intent", "daily"]);
});

test("阶段化 create 在 Daily 提交后先完成 committed，identity 与读模型继续结算", async () => {
	await ensureObsidianStub();
	const { MemoCommandService } = await import("../src/services/MemoCommandService");
	const { MemoCatalogService } = await import("../src/services/MemoCatalogService");
	const { InMemoryMemoCatalogStore } = await import("../src/services/MemoCatalogStore");
	const events: string[] = [];
	const catalogGate = createDeferred<void>();
	const store = new InMemoryMemoCatalogStore();
	const catalog = new MemoCatalogService(store);
	await catalog.open();
	const observation = makeObservation("Daily/2026-08-22.md", "2026-08-22", 1, "created memo");
	const binding = makeBinding(observation, "2026082212345601", "identity-1");
	const identityLedger = {
		getRevision: () => "identity-1",
		getStatus: () => "ready",
		getSnapshot: () => ({ revision: "identity-1", eventCount: 2, memos: {}, pendingIntents: [], quarantinedEventIds: [] }),
		resolveObservation: () => binding,
		resolveObservationState: () => ({ kind: "identified", binding }) as const,
		getSourceMemoId: () => null,
		getReviewState: () => ({ reviewCount: 0, lastReviewedAt: null }),
		beginCreate: async () => {
			events.push("intent");
			return makeCreatePlan(binding.memoId);
		},
		finishCreate: async () => {
			events.push("claim");
			return binding;
		},
	} as unknown as IdentityLedgerMutationService;
	const markdownMutations = {
		create: async (input: { onDailyCommitted?: () => void }) => {
			events.push("daily");
			input.onDailyCommitted?.();
			await catalogGate.promise;
			await seedCatalog(catalog, store, observation);
			return mutationResult(observation);
		},
	} as unknown as MarkdownMutationService;
	const service = new MemoCommandService(
		{} as App,
		catalog,
		makeCommandOptions(),
		markdownMutations,
		identityLedger,
	);

	const operation = service.startCreate(observation.content);
	let settled = false;
	void operation.settled.then(() => { settled = true; });
	await operation.dailyCommitted;

	assert.deepEqual(events, ["intent", "daily"]);
	assert.equal(settled, false);
	catalogGate.resolve(undefined);
	await operation.settled;
	assert.deepEqual(events, ["intent", "daily", "claim"]);
});

test("可恢复删除先持久化 payload 再改 Daily；恢复先写 Daily 再恢复 identity", async () => {
	await ensureObsidianStub();
	const { MemoCommandService } = await import("../src/services/MemoCommandService");
	const { MemoCatalogService } = await import("../src/services/MemoCatalogService");
	const { InMemoryMemoCatalogStore } = await import("../src/services/MemoCatalogStore");
	const events: string[] = [];
	const store = new InMemoryMemoCatalogStore();
	const catalog = new MemoCatalogService(store);
	await catalog.open();
	const observation = makeObservation("Daily/2026-08-22.md", "2026-08-22", 1, "recoverable memo");
	await seedCatalog(catalog, store, observation);
	const binding = makeBinding(observation, "2026082212345601", "identity-1");
	let activeDelete: IdentityLedgerDeleteRecord | null = null;
	const identityLedger = {
		getRevision: () => activeDelete === null ? "identity-1" : "identity-2",
		getStatus: () => "ready",
		getSnapshot: () => ({ revision: "identity-1", eventCount: 1, memos: {}, pendingIntents: [], quarantinedEventIds: [] }),
		resolveObservation: () => binding,
		resolveObservationState: () => ({ kind: "identified", binding }) as const,
		getSourceMemoId: () => null,
		getReviewState: () => ({ reviewCount: 0, lastReviewedAt: null }),
		getActiveDeletes: () => activeDelete === null ? [] : [activeDelete],
		recordDeletePayload: async (_binding: IdentityLedgerBinding, evidence: IdentityLedgerDeleteRecord["evidence"]) => {
			events.push("payload");
			activeDelete = {
				memoId: binding.memoId,
				deleteEventId: "e_22222222222222222222222222222222",
				deleteCommitEventId: null,
				baseBindingId: binding.bindingId,
				evidence,
			};
			return activeDelete;
		},
		recordDeleteCommit: async (record: IdentityLedgerDeleteRecord) => {
			events.push("commit");
			activeDelete = { ...record, deleteCommitEventId: "e_33333333333333333333333333333333" };
			return activeDelete;
		},
		recordRestore: async () => {
			events.push("identity-restore");
			activeDelete = null;
			return binding;
		},
	} as unknown as IdentityLedgerMutationService;
	const markdownMutations = {
		captureObservation: async () => {
			events.push("capture");
			return {
				observation,
				rawBlock: "- 12:34 recoverable memo",
				deletedSourceRevision: observation.sourceRevision,
			};
		},
		remove: async () => {
			events.push("daily-remove");
			await catalog.deleteFile(observation.sourcePath);
			return mutationResult(null);
		},
		restore: async () => {
			events.push("daily-restore");
			await seedCatalog(catalog, store, observation);
			return mutationResult(observation);
		},
	} as unknown as MarkdownMutationService;
	const service = new MemoCommandService(
		{} as App,
		catalog,
		makeCommandOptions(),
		markdownMutations,
		identityLedger,
	);
	const page = await service.getReadService().query({ limit: 50 });
	const memo = page.items[0];
	assert.notEqual(memo, undefined);
	if (memo === undefined) throw new Error("Catalog memo fixture is missing.");

	const deleted = await service.delete(memo);
	assert.deepEqual(events, ["capture", "payload", "daily-remove", "commit"]);
	assert.equal(deleted.followUpPending, false);
	const deleteRecord = identityLedger.getActiveDeletes?.()[0];
	assert.notEqual(deleteRecord, undefined);
	if (deleteRecord === undefined) throw new Error("Recoverable delete fixture is missing.");
	const trashItem = makeTrashItem(deleteRecord);

	events.length = 0;
	const restored = await service.restore(trashItem);
	assert.deepEqual(events, ["daily-restore", "identity-restore"]);
	assert.equal(restored.followUpPending, false);
	assert.equal(activeDelete, null);
});

function makeCommandOptions(): import("../src/services/MemoCommandService").MemoCommandServiceOptions {
	return {
		getDailyPathForDate: async (date) => `Daily/${date}.md`,
		refreshCatalogPaths: async () => undefined,
		refreshLocalCatalog: async () => undefined,
		getMemoTimeFormat: () => "HH:mm",
		rebuildLocalCatalog: async () => undefined,
		now: () => new Date("2026-08-22T12:34:56.000Z"),
	};
}

async function seedCatalog(
	catalog: import("../src/services/MemoCatalogService").MemoCatalogService,
	store: import("../src/services/MemoCatalogStore").MemoCatalogStore,
	observation: MemoObservation,
): Promise<void> {
	await catalog.replaceFile({
		inventory: {
			sourcePath: observation.sourcePath,
			logicalDate: observation.logicalDate,
			mtime: 1,
			size: 1,
		},
		sourceRevision: observation.sourceRevision,
		observations: [observation],
		parserVersion: 1,
		settingsFingerprint: "settings-1",
		auditedAt: 1,
	});
	await store.setCoverage({
		kind: "complete",
		coveredFromDate: observation.logicalDate,
		pendingFileCount: 0,
		coveredFileCount: 1,
		totalFileCount: 1,
	});
}

function makeObservation(sourcePath: string, logicalDate: string, startLine: number, content: string): MemoObservation {
	return {
		sourcePath,
		sourceRevision: "a".repeat(64),
		rawBlockHash: "raw-1",
		logicalDate,
		section: "Memos",
		startLine,
		endLine: startLine,
		time: "12:34",
		content,
		contentHash: "fnv1a-11111111",
		existingBlockId: null,
		tags: [],
		links: [],
		images: [],
		tasks: [],
		timeBuoyDates: [],
	};
}

function makeBinding(observation: MemoObservation, memoId: string, identityRevision: string): IdentityLedgerBinding {
	return {
		memoId,
		bindingId: "e_11111111111111111111111111111111",
		identityRevision,
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

function makeCreatePlan(memoId: string): IdentityLedgerCreatePlan {
	return {
		memoId,
		intentDurable: true,
		intent: {
			schemaVersion: 1,
			eventId: "e_00000000000000000000000000000001",
			writerId: "w_00000000000000000000000000000001",
			memoId,
			type: "create_intent",
			baseBindingId: null,
			occurredAt: "2026-08-22T12:34:56.000Z",
			evidence: {
				targetPath: "Daily/2026-08-22.md",
				logicalDate: "2026-08-22",
				time: "12:34",
				contentHash: "fnv1a-11111111",
				sourceMemoId: null,
			},
		},
	};
}

function mutationResult(observation: MemoObservation | null) {
	return {
		status: "committed_identity_pending" as const,
		observation,
		sourcePaths: observation === null ? [] : [observation.sourcePath],
		catalogUpdatePending: false,
	};
}

function makeTrashItem(record: IdentityLedgerDeleteRecord): TrashMemoItem {
	return {
		key: `${record.memoId}:${record.deleteEventId}`,
		memoId: record.memoId,
		deleteEventId: record.deleteEventId,
		deletedAt: record.evidence.deletedAt,
		logicalDate: record.evidence.logicalDate,
		sourcePath: record.evidence.sourcePath,
		section: record.evidence.section,
		content: "recoverable memo",
		contentHash: record.evidence.contentHash,
		sourceMemoId: record.evidence.sourceMemoId,
	};
}

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolvePromise: (value: T) => void = () => undefined;
	const promise = new Promise<T>((resolve) => {
		resolvePromise = resolve;
	});
	return { promise, resolve: resolvePromise };
}

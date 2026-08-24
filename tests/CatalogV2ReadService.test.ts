import assert from "node:assert/strict";
import test from "node:test";

import { CatalogV2ReadService } from "../src/services/CatalogV2ReadService";
import type { CatalogV2StateShadowCoordinator } from "../src/services/CatalogV2StateShadowCoordinator";
import { buildCatalogPartition, MemoCatalogService } from "../src/services/MemoCatalogService";
import { InMemoryMemoCatalogStore } from "../src/services/MemoCatalogStore";
import type { MemoObservation } from "../src/types/catalog";
import type { CatalogV2MaterializedMemo, CatalogV2MaterializedState, IdentityEvidence } from "../src/types/catalogV2";
import type { IdentityLedgerBinding, IdentityLedgerReader } from "../src/types/identityLedger";

test("CatalogV2ReadService keeps unresolved observations queryable without write dependencies", async () => {
	const observation: MemoObservation = {
		sourcePath: "Daily/2026-08-13.md",
		sourceRevision: "a".repeat(64),
		rawBlockHash: "fnv1a-rawblock",
		logicalDate: "2026-08-13",
		section: "## Memos",
		startLine: 1,
		endLine: 1,
		time: "09:00",
		content: "readable while identity settles",
		contentHash: "fnv1a-12345678",
		existingBlockId: null,
		tags: ["readable"],
		links: [],
		images: [],
		tasks: [],
		timeBuoyDates: [],
	};
	const store = new InMemoryMemoCatalogStore();
	const catalog = new MemoCatalogService(store);
	await catalog.open();
	await store.replaceFilePartition(buildCatalogPartition({
		inventory: { sourcePath: observation.sourcePath, logicalDate: observation.logicalDate, mtime: 1, size: 1 },
		sourceRevision: observation.sourceRevision,
		observations: [observation],
		parserVersion: 1,
		settingsFingerprint: "settings-v1",
		auditedAt: 1,
	}));
	await store.setCoverage({
		kind: "complete",
		coveredFromDate: observation.logicalDate,
		pendingFileCount: 0,
		coveredFileCount: 1,
		totalFileCount: 1,
	});
	const service = new CatalogV2ReadService({
		catalog,
		stateStore: null,
		stateCoordinator: null,
		transactionStore: null,
		deletedPayloadStore: null,
		installMode: "existing_v2",
	});

	const page = await service.query({ limit: 1 });

	assert.equal(page.items[0]?.content, observation.content);
	assert.equal(page.items[0]?.resolved.kind, "observed");
	assert.equal(page.items[0]?.capabilities.markdown.edit, true);
	assert.equal(page.items[0]?.capabilities.identity.crossDeviceIdentity, "syncing");
	assert.deepEqual(page.status, {
		content: "ready",
		catalog: "complete",
		identity: "absent",
		projection: "ready",
		migration: "none",
	});
	assert.equal((await service.query({ text: "identity settles", limit: 1 })).items.length, 1);
	assert.equal((await service.buildRecordStats(async () => undefined, () => true))?.overview.memoCount, 1);
	assert.deepEqual(await service.getDeletedSummary(), { count: 0, ids: [] });
});

test("共享配置缺失不把已完成的本地扫描伪装成构建中，也不阻塞本地统计与时光浮标", async () => {
	const observation = makeObservation("2026-08-13", 1, "local fallback @2026-08-13");
	const { catalog, store } = await makeCatalog([observation], "complete");
	await store.setCoverage({
		kind: "complete",
		sharedConfigurationComplete: false,
		coveredFromDate: observation.logicalDate,
		pendingFileCount: 0,
		coveredFileCount: 1,
		totalFileCount: 1,
	});
	const service = new CatalogV2ReadService({
		catalog,
		stateStore: null,
		stateCoordinator: null,
		transactionStore: null,
		deletedPayloadStore: null,
		installMode: "uninitialized",
	});

	const page = await service.query({ limit: 10 });

	assert.equal(page.readState, "ready");
	assert.equal(page.status.content, "ready");
	assert.equal(page.status.catalog, "partial");
	assert.equal(page.capabilities.stats, "complete");
	assert.equal((await service.buildRecordStats(async () => undefined, () => true))?.overview.memoCount, 1);
	assert.equal((await service.queryAllTimeBuoys()).complete, true);
});

test("partial Catalog 只允许浏览已加载 Memo，完整数据功能明确拒绝缩减结果", async () => {
	const observation: MemoObservation = {
		sourcePath: "Daily/2026-08-13.md",
		sourceRevision: "b".repeat(64),
		rawBlockHash: "fnv1a-rawblock",
		logicalDate: "2026-08-13",
		section: "## Memos",
		startLine: 1,
		endLine: 1,
		time: "09:00",
		content: "known recent memo",
		contentHash: "fnv1a-87654321",
		existingBlockId: null,
		tags: [],
		links: [],
		images: [],
		tasks: [],
		timeBuoyDates: ["2026-08-13"],
	};
	const store = new InMemoryMemoCatalogStore();
	const catalog = new MemoCatalogService(store);
	await catalog.open();
	await store.replaceFilePartition(buildCatalogPartition({
		inventory: { sourcePath: observation.sourcePath, logicalDate: observation.logicalDate, mtime: 1, size: 1 },
		sourceRevision: observation.sourceRevision,
		observations: [observation],
		parserVersion: 1,
		settingsFingerprint: "settings-v1",
		auditedAt: 1,
	}));
	await store.setCoverage({
		kind: "partial",
		coveredFromDate: "2026-08-10",
		pendingFileCount: 2,
		coveredFileCount: 1,
		totalFileCount: 3,
	});
	const service = new CatalogV2ReadService({
		catalog,
		stateStore: null,
		stateCoordinator: null,
		transactionStore: null,
		deletedPayloadStore: null,
		installMode: "existing_v2",
	});

	const page = await service.query({ limit: 150 });
	assert.deepEqual(page.items.map((item) => item.content), [observation.content]);
	assert.equal(page.readState, "history_building");
	assert.equal(page.status.content, "scanning");
	assert.equal(page.status.catalog, "partial");
	assert.equal(page.status.identity, "absent");
	assert.deepEqual(page.capabilities, {
		browse: "partial",
		search: "partial",
		stats: "partial",
		shuffle: "partial",
		random: "partial",
		timeBuoy: "partial",
		fullHistory: "partial",
	});
	assert.deepEqual((await service.queryTimeBuoysForDate("2026-08-13")).missingPeriods, []);
	assert.deepEqual((await service.queryTimeBuoysForDate("2026-07-01")).missingPeriods, ["2026-07"]);
	assert.equal((await service.queryAllTimeBuoys()).complete, false);
	await assert.rejects(() => service.buildRecordStats(async () => undefined, () => true), /complete Catalog coverage/u);
	await assert.rejects(() => service.getRandomReunionItems(1), /complete Catalog coverage/u);
	await assert.rejects(() => service.listDailyAggregates(), /complete Catalog coverage/u);
	await assert.rejects(() => service.listMemoViewsForDate("2026-08-13"), /complete Catalog coverage/u);
});

test("rebuilding coverage 不会被呈现为 complete", async () => {
	const store = new InMemoryMemoCatalogStore();
	const catalog = new MemoCatalogService(store);
	await catalog.open();
	await store.setCoverage({
		kind: "rebuilding",
		coveredFromDate: null,
		pendingFileCount: 1,
		coveredFileCount: 0,
		totalFileCount: 1,
	});
	const service = new CatalogV2ReadService({
		catalog,
		stateStore: null,
		stateCoordinator: null,
		transactionStore: null,
		deletedPayloadStore: null,
		installMode: "existing_v2",
	});

	const page = await service.query({ limit: 1 });
	assert.equal(page.coverage.kind, "rebuilding");
	assert.equal(page.readState, "history_building");
	assert.equal(page.status.content, "scanning");
	assert.equal(page.status.catalog, "partial");
	assert.equal(page.capabilities.browse, "partial");
	assert.equal(page.capabilities.stats, "partial");
});

test("V3-FAIL-002：没有 bootstrap 时仍返回全部已扫描 observation", async () => {
	const observations = [
		makeObservation("2026-08-13", 1, "正文一"),
		makeObservation("2026-08-12", 1, "正文二"),
	];
	const { catalog, store } = await makeCatalog(observations, "complete");
	const service = new CatalogV2ReadService({
		catalog,
		stateStore: null,
		stateCoordinator: null,
		transactionStore: null,
		deletedPayloadStore: null,
		installMode: "uninitialized",
	});

	const page = await service.query({ limit: 10 });

	assert.deepEqual(page.items.map((item) => item.content), ["正文一", "正文二"]);
	assert.equal(page.status.content, "ready");
	assert.equal(page.status.catalog, "complete");
	assert.equal(page.status.identity, "absent");
	assert.equal(page.readState, "ready");
	assert.deepEqual(await store.getObservation(page.items[0]?.renderKey ?? ""), page.items[0]?.observation ?? null);
});

test("V3-FAIL-001：Catalog 查询失败时标记内容不可用并请求 Daily observation 扫描", async () => {
	class FailingQueryStore extends InMemoryMemoCatalogStore {
		override async query(): Promise<never> {
			throw new Error("catalog unavailable");
		}
	}
	const store = new FailingQueryStore();
	const catalog = new MemoCatalogService(store);
	await catalog.open();
	let scanRequests = 0;
	const service = new CatalogV2ReadService({
		catalog,
		stateStore: null,
		stateCoordinator: null,
		transactionStore: null,
		deletedPayloadStore: null,
		installMode: "uninitialized",
		requestObservationScan: () => { scanRequests += 1; },
	});

	const page = await service.query({ limit: 10 });
	await Promise.resolve();

	assert.deepEqual(page.items, []);
	assert.equal(page.invalidated, false);
	assert.equal(page.status.content, "unavailable");
	assert.equal(page.status.catalog, "degraded");
	assert.equal(page.status.identity, "absent");
	assert.equal(scanRequests, 1);
});

test("V3-FAIL-003：identity 后到不使 Catalog cursor 失效，并原地增强同一 observation", async () => {
	const first = makeObservation("2026-08-13", 1, "带 #标签 的正文");
	first.tags = ["标签"];
	first.images = [{ path: "assets/photo.png", altText: "photo", syntax: "markdown_image" }];
	first.tasks = [{ taskIndex: 0, lineOffset: 1, marker: " ", text: "待办" }];
	const second = makeObservation("2026-08-12", 1, "下一页正文");
	const { catalog } = await makeCatalog([first, second], "complete");
	let stateInput: Awaited<ReturnType<CatalogV2StateShadowCoordinator["loadLocalStateSnapshot"]>> = null;
	const stateCoordinator = {
		loadLocalStateSnapshot: async () => stateInput,
		loadLocalStateSlice: async () => stateInput,
	} as unknown as CatalogV2StateShadowCoordinator;
	const service = new CatalogV2ReadService({
		catalog,
		stateStore: null,
		stateCoordinator,
		transactionStore: null,
		deletedPayloadStore: null,
		installMode: "existing_v2",
	});
	const observedPage = await service.query({ limit: 1 });
	const observed = observedPage.items[0];
	assert.ok(observed !== undefined);
	assert.ok(observedPage.nextCursor !== null);
	assert.equal(observed.memoId, null);

	const memoId = "m_11111111111111111111111111111111";
	stateInput = {
		snapshot: {
			state: makeState([makeMemo(memoId, first)]),
			revision: "identity-late",
		},
		settlement: {
			stateComplete: true,
			migrationComplete: true,
			revisionStable: true,
			historical: false,
			blockedMemoIds: [],
		},
	};
	await service.materializeResolutionSnapshot();

	const continuedPage = await service.query({ limit: 1, cursor: observedPage.nextCursor });
	const identifiedPage = await service.query({ limit: 1 });
	const identified = identifiedPage.items[0];
	assert.ok(identified !== undefined);

	assert.equal(continuedPage.invalidated, false);
	assert.deepEqual(Object.keys(observedPage.nextCursor ?? {}), ["catalog"]);
	assert.equal(identified.renderKey, observed.renderKey);
	assert.equal(identified.memoId, memoId);
	assert.equal(identified.resolved.kind, "identified");
	assert.equal(identified.content, observed.content);
	assert.deepEqual(identified.tags, observed.tags);
	assert.deepEqual(identified.images, observed.images);
	assert.deepEqual(identified.tasks, observed.tasks);
	assert.equal(identifiedPage.status.identity, "absent");
});

test("P0 第 4 步：V3 claim 后到时不依赖 V2 state 或 bootstrap，原 observation 原地获得 UUIDv7 memoId", async () => {
	const first = makeObservation("2026-08-13", 1, "V3 identity 后到");
	const second = makeObservation("2026-08-12", 1, "下一页正文");
	const { catalog } = await makeCatalog([first, second], "complete");
	const memoId = "01991f40-7c00-7111-9111-111111111111";
	let revision = "identity-v3-empty";
	let binding: IdentityLedgerBinding | null = null;
	const identityLedger: IdentityLedgerReader = {
		getRevision: () => revision,
		getStatus: () => binding === null ? "absent" : "ready",
		getSnapshot: () => ({
			revision,
			eventCount: binding === null ? 0 : 2,
			memos: {},
			pendingIntents: [],
			quarantinedEventIds: [],
		}),
		resolveObservation: (observation) => observation.sourcePath === first.sourcePath ? binding : null,
		resolveObservationState: (observation) => {
			const resolved = observation.sourcePath === first.sourcePath ? binding : null;
			return resolved === null ? { kind: "unbound" } : { kind: "identified", binding: resolved };
		},
		getSourceMemoId: (candidateMemoId) => candidateMemoId === memoId
			? "01991f40-7c00-7222-a222-222222222222" : null,
		getReviewState: () => ({ reviewCount: 0, lastReviewedAt: null }),
	};
	const service = new CatalogV2ReadService({
		catalog,
		stateStore: null,
		stateCoordinator: null,
		transactionStore: null,
		deletedPayloadStore: null,
		installMode: "uninitialized",
		identityLedger,
	});
	await service.materializeResolutionSnapshot();
	const observedPage = await service.query({ limit: 1 });
	const observed = observedPage.items[0];
	assert.ok(observed !== undefined);
	assert.ok(observedPage.nextCursor !== null);
	assert.equal(observed.memoId, null);

	revision = "identity-v3-claim";
	binding = {
		memoId,
		bindingId: "e_11111111111111111111111111111111",
		identityRevision: revision,
		evidence: {
			sourcePath: first.sourcePath,
			sourceRevision: first.sourceRevision,
			rawBlockHash: first.rawBlockHash,
			logicalDate: first.logicalDate,
			section: first.section,
			startLine: first.startLine,
			endLine: first.endLine,
			time: first.time,
			contentHash: first.contentHash,
		},
	};
	await service.materializeResolutionSnapshot();
	const identifiedPage = await service.query({ limit: 1 });
	const continuedPage = await service.query({ limit: 1, cursor: observedPage.nextCursor });
	const identified = identifiedPage.items[0];
	assert.ok(identified !== undefined);

	assert.equal(continuedPage.invalidated, false);
	assert.equal(identified.renderKey, observed.renderKey);
	assert.equal(identified.memoId, memoId);
	assert.equal(identified.sourceMemoId, "01991f40-7c00-7222-a222-222222222222");
	assert.equal(identified.capabilities.identity.crossDeviceIdentity, "ready");
	assert.equal(identified.capabilities.identity.recoverableDelete, "ready");
	assert.equal(identifiedPage.status.identity, "ready");
});

test("P1 第 5 步：V3 分叉只把相关 observation 标为 conflicted，无关 memo 身份能力保持 ready", async () => {
	const conflictedObservation = makeObservation("2026-08-14", 1, "冲突正文");
	const readyObservation = makeObservation("2026-08-13", 1, "无关正文");
	const { catalog } = await makeCatalog([conflictedObservation, readyObservation], "complete");
	const conflictedBinding: IdentityLedgerBinding = {
		memoId: "01991f40-7c00-7111-9111-111111111111",
		bindingId: "e_11111111111111111111111111111111",
		identityRevision: "identity-v3-conflict",
		evidence: {
			sourcePath: conflictedObservation.sourcePath,
			sourceRevision: conflictedObservation.sourceRevision,
			rawBlockHash: conflictedObservation.rawBlockHash,
			logicalDate: conflictedObservation.logicalDate,
			section: conflictedObservation.section,
			startLine: conflictedObservation.startLine,
			endLine: conflictedObservation.endLine,
			time: conflictedObservation.time,
			contentHash: conflictedObservation.contentHash,
		},
	};
	const readyBinding: IdentityLedgerBinding = {
		...conflictedBinding,
		memoId: "01991f40-7c00-7222-a222-222222222222",
		bindingId: "e_22222222222222222222222222222222",
		evidence: {
			...conflictedBinding.evidence,
			sourcePath: readyObservation.sourcePath,
			sourceRevision: readyObservation.sourceRevision,
			rawBlockHash: readyObservation.rawBlockHash,
			logicalDate: readyObservation.logicalDate,
			startLine: readyObservation.startLine,
			endLine: readyObservation.endLine,
			contentHash: readyObservation.contentHash,
		},
	};
	const identityLedger: IdentityLedgerReader = {
		getRevision: () => "identity-v3-conflict",
		getStatus: () => "ready",
		getSnapshot: () => ({
			revision: "identity-v3-conflict",
			eventCount: 4,
			memos: {
				[conflictedBinding.memoId]: {
					memoId: conflictedBinding.memoId,
					bindings: [conflictedBinding],
					conflicted: true,
					conflictBaseBindingId: "e_00000000000000000000000000000000",
					sourceMemoIds: [],
					reviewCount: 0,
					lastReviewedAt: null,
				},
			},
			pendingIntents: [],
			quarantinedEventIds: [],
		}),
		resolveObservation: (observation) => observation.sourcePath === readyObservation.sourcePath
			? readyBinding : null,
		resolveObservationState: (observation) => observation.sourcePath === conflictedObservation.sourcePath
			? { kind: "conflicted", memoIds: [conflictedBinding.memoId], bindings: [conflictedBinding] }
			: { kind: "identified", binding: readyBinding },
		getSourceMemoId: () => null,
		getReviewState: () => ({ reviewCount: 0, lastReviewedAt: null }),
	};
	const service = new CatalogV2ReadService({
		catalog,
		stateStore: null,
		stateCoordinator: null,
		transactionStore: null,
		deletedPayloadStore: null,
		installMode: "uninitialized",
		identityLedger,
	});
	await service.materializeResolutionSnapshot();
	const page = await service.query({ limit: 10 });
	const conflict = page.items.find((item) => item.content === "冲突正文");
	const ready = page.items.find((item) => item.content === "无关正文");

	assert.equal(conflict?.resolved.kind, "ambiguous");
	assert.equal(conflict?.capabilities.markdown.edit, true);
	assert.equal(conflict?.capabilities.identity.repair, "ready");
	assert.equal(conflict?.capabilities.identity.review, "conflicted");
	assert.equal(ready?.memoId, readyBinding.memoId);
	assert.equal(ready?.capabilities.identity.review, "ready");
	assert.equal(page.status.identity, "ready");
});

async function makeCatalog(
	observations: readonly MemoObservation[],
	coverageKind: "partial" | "complete",
): Promise<{ catalog: MemoCatalogService; store: InMemoryMemoCatalogStore }> {
	const store = new InMemoryMemoCatalogStore();
	const catalog = new MemoCatalogService(store);
	await catalog.open();
	for (const observation of observations) {
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
			settingsFingerprint: "settings-v1",
			auditedAt: 1,
		}));
	}
	await store.setCoverage({
		kind: coverageKind,
		coveredFromDate: observations.at(-1)?.logicalDate ?? null,
		pendingFileCount: coverageKind === "complete" ? 0 : 1,
		coveredFileCount: observations.length,
		totalFileCount: observations.length + (coverageKind === "complete" ? 0 : 1),
	});
	return { catalog, store };
}

function makeObservation(logicalDate: string, startLine: number, content: string): MemoObservation {
	return {
		sourcePath: `Daily/${logicalDate}.md`,
		sourceRevision: logicalDate.replace(/-/gu, "").padEnd(64, "a"),
		rawBlockHash: `fnv1a-${logicalDate}-${startLine}`,
		logicalDate,
		section: "## Memos",
		startLine,
		endLine: startLine,
		time: "09:00",
		content,
		contentHash: `fnv1a-content-${logicalDate}-${startLine}`,
		existingBlockId: null,
		tags: [],
		links: [],
		images: [],
		tasks: [],
		timeBuoyDates: [],
	};
}

function makeMemo(memoId: string, observation: MemoObservation): CatalogV2MaterializedMemo {
	const evidence: IdentityEvidence = {
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
	const binding = { entryId: `binding:${memoId}`, source: "state" as const, evidence, baseBindingId: null };
	return {
		memoId,
		identityOperationIds: [binding.entryId],
		activeBindingHeads: [binding],
		identityBindings: [binding],
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
	};
}

function makeState(memos: readonly CatalogV2MaterializedMemo[]): CatalogV2MaterializedState {
	return {
		schemaVersion: 1,
		memos: Object.fromEntries(memos.map((memo) => [memo.memoId, memo])),
		quarantine: [],
		awaitingWriterIds: [],
		forkedWriterIds: [],
		processedOperationCount: 0,
	};
}

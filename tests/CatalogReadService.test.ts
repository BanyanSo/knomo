import assert from "node:assert/strict";
import { setImmediate as waitImmediate } from "node:timers/promises";
import test from "node:test";

import type { CatalogObservation, MemoObservation } from "../src/types/catalog";
import type {
	IdentityLedgerBinding,
	IdentityLedgerDeleteRecord,
	IdentityLedgerMaterializedMemo,
	IdentityLedgerObservationState,
	IdentityLedgerReader,
	IdentityLedgerStatus,
} from "../src/types/identityLedger";

import { ensureObsidianStub } from "./helpers/obsidianStub";

test("Catalog observation 在 Identity Ledger 关系到达后原地获得 memoId", async () => {
	await ensureObsidianStub();
	const { CatalogReadService } = await import("../src/services/CatalogReadService");
	const { MemoCatalogService } = await import("../src/services/MemoCatalogService");
	const { InMemoryMemoCatalogStore } = await import("../src/services/MemoCatalogStore");
	const store = new InMemoryMemoCatalogStore();
	const catalog = new MemoCatalogService(store);
	const observation = makeObservation("Daily/2026-08-22.md", "2026-08-22", 1, "first memo");
	await seedCatalog(catalog, store, [observation]);
	const identity = createIdentityReader();
	const service = new CatalogReadService({ catalog, identityLedger: identity.reader });

	const before = await service.query({ limit: 50 });
	assert.equal(before.items[0]?.memoId, null);
	assert.equal(before.items[0]?.resolved.kind, "observed");
	assert.equal(before.identityRevision, "identity-absent");

	const binding = makeBinding(observation, "2026082212345601", "identity-1");
	identity.setState(observation.content, { kind: "identified", binding }, "ready", "identity-1");
	const after = await service.query({ limit: 50 });

	assert.equal(after.invalidated, false);
	assert.equal(after.items[0]?.renderKey, before.items[0]?.renderKey);
	assert.equal(after.items[0]?.memoId, binding.memoId);
	assert.equal(after.items[0]?.resolved.kind, "identified");
	assert.equal(after.identityRevision, "identity-1");
});

test("已识别 memo 的展示创建时间优先保留 Identity 秒数", async () => {
	await ensureObsidianStub();
	const { CatalogReadService } = await import("../src/services/CatalogReadService");
	const { MemoCatalogService } = await import("../src/services/MemoCatalogService");
	const { InMemoryMemoCatalogStore } = await import("../src/services/MemoCatalogStore");
	const { formatCreatedAtAlias } = await import("../src/utils/references");
	const store = new InMemoryMemoCatalogStore();
	const catalog = new MemoCatalogService(store);
	const observation = makeObservation("Daily/2026-08-22.md", "2026-08-22", 1, "second precision");
	await seedCatalog(catalog, store, [observation]);
	const identity = createIdentityReader();
	const binding = makeBinding(observation, "2026082212345601", "identity-1");
	identity.setState(
		observation.content,
		{ kind: "identified", binding },
		"ready",
		"identity-1",
		"2026-08-22T12:34:56",
	);
	const service = new CatalogReadService({ catalog, identityLedger: identity.reader });

	const page = await service.query({ limit: 50 });

	assert.equal(observation.time, "12:34");
	assert.equal(page.items[0]?.createdAt, "2026-08-22T12:34:56");
	assert.equal(formatCreatedAtAlias(page.items[0]?.createdAt ?? ""), "20260822-123456");
});

test("Identity 冲突只降级相关 observation，不阻断其他 Catalog 内容", async () => {
	await ensureObsidianStub();
	const { CatalogReadService } = await import("../src/services/CatalogReadService");
	const { MemoCatalogService } = await import("../src/services/MemoCatalogService");
	const { InMemoryMemoCatalogStore } = await import("../src/services/MemoCatalogStore");
	const store = new InMemoryMemoCatalogStore();
	const catalog = new MemoCatalogService(store);
	const conflicted = makeObservation("Daily/2026-08-22.md", "2026-08-22", 1, "conflicted memo");
	const unaffected = makeObservation("Daily/2026-08-22.md", "2026-08-22", 3, "unaffected memo");
	await seedCatalog(catalog, store, [conflicted, unaffected]);
	const identity = createIdentityReader();
	identity.setState(conflicted.content, {
		kind: "conflicted",
		memoIds: ["2026082212345601", "2026082212345602"],
		bindings: [],
	}, "ready", "identity-conflict");
	const service = new CatalogReadService({ catalog, identityLedger: identity.reader });

	const page = await service.query({ limit: 50 });
	const conflictedItem = page.items.find((item) => item.content === conflicted.content);
	const unaffectedItem = page.items.find((item) => item.content === unaffected.content);

	assert.equal(page.items.length, 2);
	assert.equal(page.status.identity, "conflicted");
	assert.equal(page.status.identityConflict, "observation");
	assert.equal(conflictedItem?.resolved.kind, "ambiguous");
	assert.equal(conflictedItem?.capabilities.identity.repair, "conflicted");
	assert.equal(unaffectedItem?.resolved.kind, "observed");
	assert.equal(unaffectedItem?.capabilities.markdown.edit, true);
});

test("Catalog 查询失败时返回可展示的降级状态并请求后台扫描", async () => {
	await ensureObsidianStub();
	const { CatalogReadService } = await import("../src/services/CatalogReadService");
	const { MemoCatalogService } = await import("../src/services/MemoCatalogService");
	const { InMemoryMemoCatalogStore } = await import("../src/services/MemoCatalogStore");
	class FailingStore extends InMemoryMemoCatalogStore {
		override async query(): Promise<never> {
			throw new Error("catalog unavailable");
		}
	}
	let scanRequests = 0;
	const service = new CatalogReadService({
		catalog: new MemoCatalogService(new FailingStore()),
		identityLedger: createIdentityReader().reader,
		requestObservationScan: () => { scanRequests += 1; },
	});

	const page = await service.query({ limit: 50 });
	await waitImmediate();

	assert.equal(page.readState, "storage_unavailable");
	assert.equal(page.status.content, "unavailable");
	assert.equal(page.degraded, true);
	assert.equal(scanRequests, 1);
});

test("旧 Index 仅有安全跳过项时保留设置诊断，不占用主视图状态提示", async () => {
	await ensureObsidianStub();
	const { CatalogReadService } = await import("../src/services/CatalogReadService");
	const { MemoCatalogService } = await import("../src/services/MemoCatalogService");
	const { InMemoryMemoCatalogStore } = await import("../src/services/MemoCatalogStore");
	const store = new InMemoryMemoCatalogStore();
	const catalog = new MemoCatalogService(store);
	const observation = makeObservation("Daily/2026-08-22.md", "2026-08-22", 1, "known memo");
	await seedCatalog(catalog, store, [observation]);
	const service = new CatalogReadService({
		catalog,
		identityLedger: createIdentityReader().reader,
		getLegacyImportStatus: () => "partial",
	});

	const page = await service.query({ limit: 20 });

	assert.equal(page.status.migration, "none");
});

test("回收站忽略过期 resolution snapshot，并按当前 Catalog 显示删除记录", async () => {
	await ensureObsidianStub();
	const { CatalogReadService } = await import("../src/services/CatalogReadService");
	const { MemoCatalogService } = await import("../src/services/MemoCatalogService");
	const { InMemoryMemoCatalogStore } = await import("../src/services/MemoCatalogStore");
	const store = new InMemoryMemoCatalogStore();
	const catalog = new MemoCatalogService(store);
	const observation = makeObservation("Daily/2026-08-22.md", "2026-08-22", 1, "deleted memo");
	await seedCatalog(catalog, store, [observation]);
	const identity = createIdentityReader();
	const binding = makeBinding(observation, "2026082212345601", "identity-1");
	identity.setState(
		observation.content,
		{ kind: "identified", binding },
		"ready",
		"identity-1",
		"2026-08-22T12:34:56",
	);
	const service = new CatalogReadService({ catalog, identityLedger: identity.reader });
	await service.materializeResolutionSnapshot();
	await catalog.deleteFile(observation.sourcePath);
	identity.setActiveDeletes([{
		memoId: binding.memoId,
		deleteEventId: "e_22222222222222222222222222222222",
		deleteCommitEventId: "e_33333333333333333333333333333333",
		baseBindingId: binding.bindingId,
		evidence: {
			deletedAt: "2026-08-22T13:00:00.000Z",
			sourcePath: observation.sourcePath,
			deletedSourceRevision: observation.sourceRevision,
			logicalDate: observation.logicalDate,
			section: observation.section,
			rawBlock: "- 12:34 deleted memo",
			contentHash: observation.contentHash,
			sourceMemoId: null,
		},
	}], "identity-2");

	const page = await service.listDeleted(20);

	assert.equal(page.items.length, 1);
	assert.equal(page.items[0]?.memoId, binding.memoId);
	assert.equal(page.items[0]?.createdAt, "2026-08-22T12:34:56");
	assert.equal(page.items[0]?.deleteSource, "knomo_ui");
	assert.equal(page.items[0]?.purgeAllowed, true);

	identity.setState(observation.content, {
		kind: "conflicted",
		memoIds: [binding.memoId],
		bindings: [binding],
	}, "conflicted", "identity-3");
	const conflictedPage = await service.listDeleted(20);
	assert.equal(conflictedPage.items[0]?.purgeAllowed, false);
});

test("Daily 正文重新出现时保持正文 observation 可见并隐藏对应废纸篓记录", async () => {
	await ensureObsidianStub();
	const { CatalogReadService } = await import("../src/services/CatalogReadService");
	const { MemoCatalogService } = await import("../src/services/MemoCatalogService");
	const { InMemoryMemoCatalogStore } = await import("../src/services/MemoCatalogStore");
	const store = new InMemoryMemoCatalogStore();
	const catalog = new MemoCatalogService(store);
	const observation = makeObservation("Daily/2026-08-22.md", "2026-08-22", 1, "externally restored Daily memo");
	await seedCatalog(catalog, store, [observation]);
	const identity = createIdentityReader();
	const binding = makeBinding(observation, "2026082212345601", "identity-1");
	identity.setState(observation.content, { kind: "identified", binding }, "ready", "identity-1");
	identity.setActiveDeletes([{
		memoId: binding.memoId,
		deleteEventId: "e_22222222222222222222222222222222",
		deleteCommitEventId: "e_33333333333333333333333333333333",
		baseBindingId: binding.bindingId,
		evidence: {
			deletedAt: "2026-08-22T13:00:00.000Z",
			sourcePath: observation.sourcePath,
			deletedSourceRevision: observation.sourceRevision,
			logicalDate: observation.logicalDate,
			section: observation.section,
			rawBlock: "- 12:34 externally restored Daily memo",
			contentHash: observation.contentHash,
			sourceMemoId: null,
		},
	}], "identity-2");
	const service = new CatalogReadService({ catalog, identityLedger: identity.reader });

	assert.equal((await service.query({ limit: 20 })).items[0]?.content, observation.content);
	assert.equal((await service.listDeleted(20)).items.length, 0);
});

test("随机重逢只返回具有稳定 memoId 和 review 能力的候选", async () => {
	await ensureObsidianStub();
	const { CatalogReadService } = await import("../src/services/CatalogReadService");
	const { MemoCatalogService } = await import("../src/services/MemoCatalogService");
	const { InMemoryMemoCatalogStore } = await import("../src/services/MemoCatalogStore");
	const store = new InMemoryMemoCatalogStore();
	const catalog = new MemoCatalogService(store);
	const identified = makeObservation("Daily/2026-08-20.md", "2026-08-20", 1, "identified random candidate");
	const syncing = makeObservation("Daily/2026-08-21.md", "2026-08-21", 1, "syncing random candidate");
	await seedCatalogFiles(catalog, store, [identified, syncing]);
	const identity = createIdentityReader();
	const binding = makeBinding(identified, "2026082012345601", "identity-1");
	identity.setState(identified.content, { kind: "identified", binding }, "ready", "identity-1");
	const service = new CatalogReadService({
		catalog,
		identityLedger: identity.reader,
		now: () => new Date(2026, 7, 26, 12, 0, 0),
		random: () => 0,
	});

	const items = await service.getRandomReunionItems(5);

	assert.deepEqual(items.map((item) => item.contentSnapshot), ["identified random candidate"]);
});

test("Identity absent 时随机重逢只为选中的 observation 建立稳定身份", async () => {
	await ensureObsidianStub();
	const { CatalogReadService } = await import("../src/services/CatalogReadService");
	const { MemoCatalogService } = await import("../src/services/MemoCatalogService");
	const { InMemoryMemoCatalogStore } = await import("../src/services/MemoCatalogStore");
	const store = new InMemoryMemoCatalogStore();
	const catalog = new MemoCatalogService(store);
	const first = makeObservation("Daily/2026-08-20.md", "2026-08-20", 1, "first historical random candidate");
	const second = makeObservation("Daily/2026-08-21.md", "2026-08-21", 1, "second historical random candidate");
	await seedCatalogFiles(catalog, store, [first, second]);
	const identity = createIdentityReader();
	const service = new CatalogReadService({
		catalog,
		identityLedger: identity.reader,
		now: () => new Date(2026, 7, 26, 12, 0, 0),
		random: () => 0,
	});
	let adoptionCount = 0;
	let preparingIdentityCount = 0;

	const items = await service.getRandomReunionItems(1, {
		prepareIdentity: async (candidate) => {
			adoptionCount += 1;
			const binding = makeBinding(candidate.observation, "2026082012345601", "identity-1");
			identity.setState(candidate.content, { kind: "identified", binding }, "ready", "identity-1");
			return service.resolveMemoItemInFile(candidate.sourcePath, candidate.observation.startLine);
		},
		onPreparingIdentity: () => { preparingIdentityCount += 1; },
	});

	assert.equal(adoptionCount, 1);
	assert.equal(preparingIdentityCount, 1);
	assert.equal(items.length, 1);
	assert.equal(items[0]?.id, "2026082012345601");
	assert.equal(items[0]?.catalog?.capabilities.identity.review, "ready");
});

test("缓存候选池仍会应用同步后的最新 review 权重", async () => {
	await ensureObsidianStub();
	const { CatalogReadService } = await import("../src/services/CatalogReadService");
	const { MemoCatalogService } = await import("../src/services/MemoCatalogService");
	const { InMemoryMemoCatalogStore } = await import("../src/services/MemoCatalogStore");
	const store = new InMemoryMemoCatalogStore();
	const catalog = new MemoCatalogService(store);
	const unreviewed = makeObservation("Daily/2026-08-20.md", "2026-08-20", 1, "unreviewed random candidate");
	const recentlyReviewed = makeObservation("Daily/2026-08-21.md", "2026-08-21", 1, "recently reviewed candidate");
	await seedCatalogFiles(catalog, store, [unreviewed, recentlyReviewed]);
	const identity = createIdentityReader();
	const unreviewedBinding = makeBinding(unreviewed, "2026082012345601", "identity-1");
	const reviewedBinding = { ...makeBinding(recentlyReviewed, "2026082112345601", "identity-1"), bindingId: "e_22222222222222222222222222222222" };
	identity.setState(unreviewed.content, { kind: "identified", binding: unreviewedBinding }, "ready", "identity-1");
	identity.setState(recentlyReviewed.content, { kind: "identified", binding: reviewedBinding }, "ready", "identity-1");
	const service = new CatalogReadService({
		catalog,
		identityLedger: identity.reader,
		now: () => new Date(2026, 7, 26, 12, 0, 0),
		random: () => 0.5,
	});

	assert.deepEqual(
		(await service.getRandomReunionItems(1)).map((item) => item.contentSnapshot),
		["recently reviewed candidate"],
	);
	identity.setReviewState(reviewedBinding.memoId, 1, "2026-08-25T12:00:00.000Z");
	identity.setState(recentlyReviewed.content, { kind: "identified", binding: reviewedBinding }, "ready", "identity-2");
	const items = await service.getRandomReunionItems(1);

	assert.deepEqual(items.map((item) => item.contentSnapshot), ["unreviewed random candidate"]);
});

test("随机重逢从完整 Catalog 候选池筛选而不是只抽样 24 个日期", async () => {
	await ensureObsidianStub();
	const { CatalogReadService } = await import("../src/services/CatalogReadService");
	const { MemoCatalogService } = await import("../src/services/MemoCatalogService");
	const { InMemoryMemoCatalogStore } = await import("../src/services/MemoCatalogStore");
	const store = new InMemoryMemoCatalogStore();
	const catalog = new MemoCatalogService(store);
	const observations = Array.from({ length: 25 }, (_, index) => {
		const day = (index + 1).toString().padStart(2, "0");
		return makeObservation(
			`Daily/2026-07-${day}.md`,
			`2026-07-${day}`,
			1,
			index === 0 ? "oldest complete-catalog candidate" : "short",
		);
	});
	await seedCatalogFiles(catalog, store, observations);
	const identity = createIdentityReader();
	const binding = makeBinding(observations[0] as MemoObservation, "2026070112345601", "identity-1");
	identity.setState(observations[0]?.content ?? "", { kind: "identified", binding }, "ready", "identity-1");
	const service = new CatalogReadService({
		catalog,
		identityLedger: identity.reader,
		now: () => new Date(2026, 7, 26, 12, 0, 0),
		random: () => 0,
	});

	const items = await service.getRandomReunionItems(5);

	assert.deepEqual(items.map((item) => item.contentSnapshot), ["oldest complete-catalog candidate"]);
});

test("随机重逢按 Catalog revision 复用多页候选池且不因 Identity revision 重读全库", async () => {
	await ensureObsidianStub();
	const { CatalogReadService } = await import("../src/services/CatalogReadService");
	const { MemoCatalogService } = await import("../src/services/MemoCatalogService");
	const { InMemoryMemoCatalogStore } = await import("../src/services/MemoCatalogStore");
	const store = new InMemoryMemoCatalogStore();
	const originalQuery = store.query.bind(store);
	let queryCalls = 0;
	store.query = async (request) => {
		queryCalls += 1;
		return originalQuery(request);
	};
	const catalog = new MemoCatalogService(store);
	const observations = Array.from({ length: 2_000 }, (_, index) => makeObservation(
		"Daily/2026-07-01.md",
		"2026-07-01",
		index + 1,
		`historical random candidate ${index.toString().padStart(4, "0")}`,
	));
	await seedCatalog(catalog, store, observations);
	const identity = createIdentityReader();
	const bindings = observations.map((observation, index) => makeBinding(
		observation,
		(index + 1).toString().padStart(18, "0"),
		"identity-1",
	));
	for (let index = 0; index < observations.length; index += 1) {
		identity.setState(
			observations[index]?.content ?? "",
			{ kind: "identified", binding: bindings[index] as IdentityLedgerBinding },
			"ready",
			"identity-1",
		);
	}
	const service = new CatalogReadService({
		catalog,
		identityLedger: identity.reader,
		now: () => new Date(2026, 7, 26, 12, 0, 0),
		random: () => 0,
	});

	assert.equal((await service.getRandomReunionItems(5)).length, 5);
	const firstLoadQueryCalls = queryCalls;
	identity.setState(
		observations[0]?.content ?? "",
		{ kind: "identified", binding: bindings[0] as IdentityLedgerBinding },
		"ready",
		"identity-2",
	);
	assert.equal((await service.getRandomReunionItems(5)).length, 5);

	assert.ok(firstLoadQueryCalls > 2);
	assert.equal(queryCalls, firstLoadQueryCalls + 1);
});

test("Catalog revision 变化后随机重逢重建候选池", async () => {
	await ensureObsidianStub();
	const { CatalogReadService } = await import("../src/services/CatalogReadService");
	const { MemoCatalogService } = await import("../src/services/MemoCatalogService");
	const { InMemoryMemoCatalogStore } = await import("../src/services/MemoCatalogStore");
	const store = new InMemoryMemoCatalogStore();
	const catalog = new MemoCatalogService(store);
	const first = makeObservation("Daily/2026-07-01.md", "2026-07-01", 1, "first revision candidate");
	await seedCatalogFiles(catalog, store, [first]);
	const identity = createIdentityReader();
	identity.setState(first.content, {
		kind: "identified",
		binding: makeBinding(first, "2026070112345601", "identity-1"),
	}, "ready", "identity-1");
	const service = new CatalogReadService({
		catalog,
		identityLedger: identity.reader,
		now: () => new Date(2026, 7, 26, 12, 0, 0),
		random: () => 0,
	});
	assert.deepEqual((await service.getRandomReunionItems(5)).map((item) => item.contentSnapshot), [first.content]);
	const second = makeObservation("Daily/2026-07-02.md", "2026-07-02", 1, "second revision candidate");
	await catalog.replaceFile({
		inventory: { sourcePath: second.sourcePath, logicalDate: second.logicalDate, mtime: 1, size: 1 },
		sourceRevision: second.sourceRevision,
		observations: [second],
		parserVersion: 2,
		settingsFingerprint: "settings-1",
		auditedAt: 1,
	});
	await store.setCoverage({
		kind: "complete",
		sharedConfigurationComplete: true,
		coveredFromDate: first.logicalDate,
		pendingFileCount: 0,
		coveredFileCount: 2,
		totalFileCount: 2,
	});
	identity.setState(second.content, {
		kind: "identified",
		binding: makeBinding(second, "2026070212345601", "identity-2"),
	}, "ready", "identity-2");

	const refreshed = await service.getRandomReunionItems(5);

	assert.deepEqual(new Set(refreshed.map((item) => item.contentSnapshot)), new Set([first.content, second.content]));
});

test("全库摘要和标签 facet 来自 Catalog 聚合，不受查询分页影响", async () => {
	await ensureObsidianStub();
	const { CatalogReadService } = await import("../src/services/CatalogReadService");
	const { MemoCatalogService } = await import("../src/services/MemoCatalogService");
	const { InMemoryMemoCatalogStore } = await import("../src/services/MemoCatalogStore");
	const store = new InMemoryMemoCatalogStore();
	const catalog = new MemoCatalogService(store);
	const first = makeObservation("Daily/2026-08-20.md", "2026-08-20", 1, "中文 first");
	first.tags = ["#Project/Alpha"];
	first.images = [{ path: "first.png", altText: "", syntax: "obsidian_embed" }];
	const second = makeObservation("Daily/2026-08-21.md", "2026-08-21", 1, "second 42");
	second.tags = ["#project/alpha", "#Life"];
	await seedCatalogFiles(catalog, store, [first, second]);
	const service = new CatalogReadService({ catalog, identityLedger: createIdentityReader().reader });

	assert.equal((await service.query({ limit: 1 })).items.length, 1);
	const summary = await service.getLibrarySummary();
	const facets = await service.getTagFacets();

	assert.equal(summary.complete, true);
	assert.deepEqual(summary.value, { memoCount: 2, tagCount: 2, imageCount: 1, wordCount: 5 });
	assert.equal(facets.complete, true);
	assert.deepEqual(facets.value, [
		{ key: "project/alpha", label: "project/alpha", count: 2 },
		{ key: "life", label: "Life", count: 1 },
	]);
});

test("部分扫描只开放已覆盖范围，不伪装成完整全库统计", async () => {
	await ensureObsidianStub();
	const { CatalogReadService } = await import("../src/services/CatalogReadService");
	const { MemoCatalogService } = await import("../src/services/MemoCatalogService");
	const { InMemoryMemoCatalogStore } = await import("../src/services/MemoCatalogStore");
	const store = new InMemoryMemoCatalogStore();
	const catalog = new MemoCatalogService(store);
	await seedCatalogFiles(catalog, store, [makeObservation("Daily/2026-08-20.md", "2026-08-20", 1, "known")]);
	await store.setCoverage({
		kind: "partial",
		sharedConfigurationComplete: true,
		coveredFromDate: "2026-08-01",
		pendingFileCount: 2,
		coveredFileCount: 1,
		totalFileCount: 3,
	});
	const service = new CatalogReadService({ catalog, identityLedger: createIdentityReader().reader });

	assert.equal((await service.getLibrarySummary()).value, null);
	assert.equal(await service.getCoverageForRange("2026-08-01", "2026-08-31"), true);
	assert.equal(await service.getCoverageForRange("2026-07-31", "2026-08-31"), false);
	await store.setCoverage({
		kind: "rebuilding",
		sharedConfigurationComplete: true,
		coveredFromDate: "2026-08-20",
		pendingFileCount: 2,
		coveredFileCount: 1,
		totalFileCount: 3,
	});
	assert.equal(await service.getCoverageForRange("2026-08-20", "2026-08-20"), true);
	assert.equal(await service.getCoverageForRange("2026-08-19", "2026-08-20"), false);
	const pending = await service.queryRecordStatsDrilldown({
		type: "range",
		startDate: "2026-07-01",
		endDateExclusive: "2026-09-01",
	}, { limit: 50 });
	assert.deepEqual(pending.items, []);
	assert.equal(pending.readState, "history_building");
});

test("运行状态快照只读组合 Catalog、Identity、共享配置、Monthly 和旧版迁移", async () => {
	await ensureObsidianStub();
	const { CatalogReadService } = await import("../src/services/CatalogReadService");
	const { MemoCatalogService } = await import("../src/services/MemoCatalogService");
	const { InMemoryMemoCatalogStore } = await import("../src/services/MemoCatalogStore");
	const store = new InMemoryMemoCatalogStore();
	const catalog = new MemoCatalogService(store);
	await catalog.open();
	await store.setCoverage({
		kind: "partial",
		sharedConfigurationComplete: false,
		coveredFromDate: "2026-08-20",
		pendingFileCount: 2,
		coveredFileCount: 1,
		totalFileCount: 3,
	});
	const identity = createIdentityReader();
	identity.setState("missing", { kind: "unbound" }, "conflicted", "identity-conflict");
	const service = new CatalogReadService({
		catalog,
		identityLedger: identity.reader,
		getSharedConfigurationStatus: () => "conflicted",
		getProjectionState: () => "failed",
		getLegacyImportStatus: () => "attention",
	});

	const snapshot = await service.getRuntimeSnapshot();

	assert.equal(snapshot.catalog.coverage.kind, "partial");
	assert.equal(snapshot.catalog.lifecycle.persistent, false);
	assert.equal(snapshot.identity, "conflicted");
	assert.equal(snapshot.sharedConfiguration, "conflicted");
	assert.equal(snapshot.monthly, "failed");
	assert.equal(snapshot.legacyMigration, "attention");
});

test("往日漫游按同日号查询、排除当天并支持跨页", async () => {
	await ensureObsidianStub();
	const { CatalogReadService } = await import("../src/services/CatalogReadService");
	const { MemoCatalogService } = await import("../src/services/MemoCatalogService");
	const { InMemoryMemoCatalogStore } = await import("../src/services/MemoCatalogStore");
	const store = new InMemoryMemoCatalogStore();
	const catalog = new MemoCatalogService(store);
	await seedCatalogFiles(catalog, store, [
		makeObservation("Daily/2026-03-15.md", "2026-03-15", 1, "today"),
		makeObservation("Daily/2026-02-15.md", "2026-02-15", 1, "february"),
		makeObservation("Daily/2025-11-15.md", "2025-11-15", 1, "november"),
		makeObservation("Daily/2025-03-14.md", "2025-03-14", 1, "other day"),
	]);
	const service = new CatalogReadService({ catalog, identityLedger: createIdentityReader().reader });

	const first = await service.queryReviewItems(new Date(2026, 2, 15), { limit: 1 });
	const second = await service.queryReviewItems(new Date(2026, 2, 15), { limit: 1, cursor: first.nextCursor });

	assert.deepEqual(first.items.map((item) => item.content), ["february"]);
	assert.deepEqual(second.items.map((item) => item.content), ["november"]);
	assert.equal(second.nextCursor, null);
});

test("2 月 29 日往日漫游只返回历史闰日", async () => {
	await ensureObsidianStub();
	const { CatalogReadService } = await import("../src/services/CatalogReadService");
	const { MemoCatalogService } = await import("../src/services/MemoCatalogService");
	const { InMemoryMemoCatalogStore } = await import("../src/services/MemoCatalogStore");
	const store = new InMemoryMemoCatalogStore();
	const catalog = new MemoCatalogService(store);
	await seedCatalogFiles(catalog, store, [
		makeObservation("Daily/2024-02-29.md", "2024-02-29", 1, "today"),
		makeObservation("Daily/2020-02-29.md", "2020-02-29", 1, "leap day"),
		makeObservation("Daily/2023-03-29.md", "2023-03-29", 1, "march"),
	]);
	const service = new CatalogReadService({ catalog, identityLedger: createIdentityReader().reader });

	const page = await service.queryReviewItems(new Date(2024, 1, 29), { limit: 50 });

	assert.deepEqual(page.items.map((item) => item.content), ["leap day"]);
});

test("记录统计钻取在分页前处理标签、引用、小时和并列日期", async () => {
	await ensureObsidianStub();
	const { CatalogReadService } = await import("../src/services/CatalogReadService");
	const { MemoCatalogService } = await import("../src/services/MemoCatalogService");
	const { InMemoryMemoCatalogStore } = await import("../src/services/MemoCatalogStore");
	const store = new InMemoryMemoCatalogStore();
	const catalog = new MemoCatalogService(store);
	const parentTag = makeObservation("Daily/2026-08-01.md", "2026-08-01", 1, "parent");
	parentTag.tags = ["#Project/Alpha"];
	parentTag.time = "09:10";
	const explicitReference = makeObservation("Daily/2026-08-02.md", "2026-08-02", 1, "explicit [[Daily#^abc]]");
	explicitReference.time = "09:20";
	const identityReference = makeObservation("Daily/2026-08-03.md", "2026-08-03", 1, "identity");
	identityReference.time = "12:00";
	const image = makeObservation("Daily/2026-08-04.md", "2026-08-04", 1, "image");
	image.images = [{ path: "image.png", altText: "", syntax: "obsidian_embed" }];
	await seedCatalogFiles(catalog, store, [parentTag, explicitReference, identityReference, image]);
	const identity = createIdentityReader();
	const binding = makeBinding(identityReference, "2026080312000001", "identity-1");
	identity.setState(identityReference.content, { kind: "identified", binding }, "ready", "identity-1");
	identity.setSourceMemoId(binding.memoId, "2026080112000001");
	const service = new CatalogReadService({ catalog, identityLedger: identity.reader });

	const range = { startDate: "2026-08-01", endDateExclusive: "2026-08-05" };
	assert.deepEqual((await service.queryRecordStatsDrilldown({ type: "day", date: "2026-08-03" }, { limit: 50 })).items.map((item) => item.content), ["identity"]);
	assert.equal((await service.queryRecordStatsDrilldown({ type: "month", month: "2026-08" }, { limit: 50 })).items.length, 4);
	assert.equal((await service.queryRecordStatsDrilldown({ type: "range", ...range }, { limit: 50 })).items.length, 4);
	assert.deepEqual((await service.queryRecordStatsDrilldown({ type: "with-tag", ...range }, { limit: 50 })).items.map((item) => item.content), ["parent"]);
	assert.equal((await service.queryRecordStatsDrilldown({ type: "no-tag", ...range }, { limit: 50 })).items.length, 3);
	assert.deepEqual((await service.queryRecordStatsDrilldown({ type: "with-image", ...range }, { limit: 50 })).items.map((item) => item.content), ["image"]);
	assert.deepEqual((await service.queryRecordStatsDrilldown({ type: "tag", ...range, tagKey: "project", tagLabel: "Project" }, { limit: 50 })).items.map((item) => item.content), ["parent"]);
	assert.deepEqual((await service.queryRecordStatsDrilldown({ type: "hour", ...range, hour: 9 }, { limit: 50 })).items.map((item) => item.content), ["explicit [[Daily#^abc]]", "parent"]);
	const references = await service.queryRecordStatsDrilldown({ type: "references", ...range }, { limit: 1 });
	const moreReferences = await service.queryRecordStatsDrilldown({ type: "references", ...range }, { limit: 1, cursor: references.nextCursor });
	assert.deepEqual([...references.items, ...moreReferences.items].map((item) => item.content), ["identity", "explicit [[Daily#^abc]]"]);
	assert.deepEqual((await service.queryRecordStatsDrilldown({ type: "max-daily-notes", dates: ["2026-08-01", "2026-08-04"] }, { limit: 50 })).items.map((item) => item.content), ["image", "parent"]);
	assert.deepEqual((await service.queryRecordStatsDrilldown({ type: "max-daily-words", dates: ["2026-08-02", "2026-08-03"] }, { limit: 50 })).items.map((item) => item.content), ["identity", "explicit [[Daily#^abc]]"]);
});

test("记录统计从 Daily aggregate 构建，并补齐 Identity relation 引用", async () => {
	await ensureObsidianStub();
	const { CatalogReadService } = await import("../src/services/CatalogReadService");
	const { MemoCatalogService } = await import("../src/services/MemoCatalogService");
	const { InMemoryMemoCatalogStore } = await import("../src/services/MemoCatalogStore");
	const store = new InMemoryMemoCatalogStore();
	const catalog = new MemoCatalogService(store);
	const tagged = makeObservation("Daily/2026-08-01.md", "2026-08-01", 1, "中文 hello");
	tagged.tags = ["#Work/Project"];
	tagged.time = "08:30";
	const related = makeObservation("Daily/2026-08-02.md", "2026-08-02", 1, "related memo");
	related.time = "22:00";
	await seedCatalogFiles(catalog, store, [tagged, related]);
	const identity = createIdentityReader();
	const binding = makeBinding(related, "2026080222000001", "identity-1");
	identity.setState(related.content, { kind: "identified", binding }, "ready", "identity-1");
	identity.setSourceMemoId(binding.memoId, "2026080108000001");
	const service = new CatalogReadService({ catalog, identityLedger: identity.reader });

	const prepared = await service.buildRecordStats(async () => undefined, () => true);

	assert.deepEqual(prepared?.overview, { memoCount: 2, wordCount: 5, recordDayCount: 2 });
	assert.equal(prepared?.daily.get("2026-08-02")?.referenceMemoCount, 1);
	assert.equal(prepared?.daily.get("2026-08-01")?.hourCounts[8], 1);
	assert.equal(prepared?.daily.get("2026-08-01")?.tagMemoCounts.get("work/project"), 1);
	assert.equal(prepared?.tagDisplayNames.get("work/project"), "Work/Project");
});

async function seedCatalog(
	catalog: import("../src/services/MemoCatalogService").MemoCatalogService,
	store: import("../src/services/MemoCatalogStore").MemoCatalogStore,
	observations: readonly MemoObservation[],
): Promise<void> {
	await catalog.open();
	await catalog.replaceFile({
		inventory: {
			sourcePath: observations[0]?.sourcePath ?? "Daily/2026-08-22.md",
			logicalDate: observations[0]?.logicalDate ?? "2026-08-22",
			mtime: 1,
			size: 1,
		},
		sourceRevision: observations[0]?.sourceRevision ?? "revision-1",
		observations,
		parserVersion: 1,
		settingsFingerprint: "settings-1",
		auditedAt: 1,
	});
	await store.setCoverage({
		kind: "complete",
		coveredFromDate: "2026-08-22",
		pendingFileCount: 0,
		coveredFileCount: 1,
		totalFileCount: 1,
	});
}

function createIdentityReader(): {
	reader: IdentityLedgerReader;
	setState: (
		content: string,
		state: IdentityLedgerObservationState,
		status: IdentityLedgerStatus,
		revision: string,
		createdAt?: string | null,
	) => void;
	setActiveDeletes: (records: IdentityLedgerDeleteRecord[], revision: string) => void;
	setSourceMemoId: (memoId: string, sourceMemoId: string) => void;
	setReviewState: (memoId: string, reviewCount: number, lastReviewedAt: string | null) => void;
} {
	let revision = "identity-absent";
	let status: IdentityLedgerStatus = "absent";
	const states = new Map<string, IdentityLedgerObservationState>();
	const memos: Record<string, IdentityLedgerMaterializedMemo> = {};
	let activeDeletes: IdentityLedgerDeleteRecord[] = [];
	const sourceMemoIds = new Map<string, string>();
	const reviews = new Map<string, { reviewCount: number; lastReviewedAt: string | null }>();
	const reader: IdentityLedgerReader = {
		getRevision: () => revision,
		getStatus: () => status,
		getSnapshot: () => ({
			revision,
			eventCount: Object.keys(memos).length,
			memos,
			pendingIntents: [],
			quarantinedEventIds: [],
		}),
		resolveObservation: (observation) => {
			const state = states.get(observation.content);
			return state?.kind === "identified" ? state.binding : null;
		},
		resolveObservationState: (observation) => states.get(observation.content) ?? { kind: "unbound" },
		getSourceMemoId: (memoId) => sourceMemoIds.get(memoId) ?? null,
		getCreatedAt: (memoId) => memos[memoId]?.createdAt ?? null,
		getReviewState: (memoId) => reviews.get(memoId) ?? { reviewCount: 0, lastReviewedAt: null },
		getActiveDeletes: () => activeDeletes,
	};
	return {
		reader,
		setState: (content, state, nextStatus, nextRevision, createdAt = null) => {
			states.set(content, state);
			status = nextStatus;
			revision = nextRevision;
			if (state.kind === "identified") {
				memos[state.binding.memoId] = {
					memoId: state.binding.memoId,
					createdAt,
					bindings: [state.binding],
					conflicted: false,
					conflictBaseBindingId: null,
					sourceMemoIds: [],
					reviewCount: 0,
					lastReviewedAt: null,
				};
			} else if (state.kind === "conflicted") {
				for (const memoId of state.memoIds) {
					memos[memoId] = {
						memoId,
						createdAt: null,
						bindings: [],
						conflicted: true,
						conflictBaseBindingId: null,
						sourceMemoIds: [],
						reviewCount: 0,
						lastReviewedAt: null,
					};
				}
			}
		},
		setActiveDeletes: (records, nextRevision) => {
			activeDeletes = records;
			revision = nextRevision;
		},
		setSourceMemoId: (memoId, sourceMemoId) => {
			sourceMemoIds.set(memoId, sourceMemoId);
		},
		setReviewState: (memoId, reviewCount, lastReviewedAt) => {
			reviews.set(memoId, { reviewCount, lastReviewedAt });
		},
	};
}

async function seedCatalogFiles(
	catalog: import("../src/services/MemoCatalogService").MemoCatalogService,
	store: import("../src/services/MemoCatalogStore").MemoCatalogStore,
	observations: readonly MemoObservation[],
): Promise<void> {
	await catalog.open();
	for (const observation of observations) {
		await catalog.replaceFile({
			inventory: {
				sourcePath: observation.sourcePath,
				logicalDate: observation.logicalDate,
				mtime: 1,
				size: 1,
			},
			sourceRevision: observation.sourceRevision,
			observations: [observation],
			parserVersion: 2,
			settingsFingerprint: "settings-1",
			auditedAt: 1,
		});
	}
	await store.setCoverage({
		kind: "complete",
		sharedConfigurationComplete: true,
		coveredFromDate: observations.map((item) => item.logicalDate).sort()[0] ?? null,
		pendingFileCount: 0,
		coveredFileCount: observations.length,
		totalFileCount: observations.length,
	});
}

function makeObservation(sourcePath: string, logicalDate: string, startLine: number, content: string): MemoObservation {
	return {
		sourcePath,
		sourceRevision: "a".repeat(64),
		rawBlockHash: `raw-${startLine}`,
		logicalDate,
		section: "Memos",
		startLine,
		endLine: startLine,
		time: "12:34",
		content,
		contentHash: `content-${startLine}`,
		existingBlockId: null,
		tags: [],
		links: [],
		images: [],
		tasks: [],
		timeBuoyDates: [],
	};
}

function makeBinding(
	observation: MemoObservation | CatalogObservation,
	memoId: string,
	identityRevision: string,
): IdentityLedgerBinding {
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

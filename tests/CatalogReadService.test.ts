import assert from "node:assert/strict";
import { setImmediate as waitImmediate } from "node:timers/promises";
import test from "node:test";

import type { CatalogObservation, MemoObservation } from "../src/types/catalog";

import { ensureObsidianStub } from "./helpers/obsidianStub";

test("浮标保留实际页 revision，跨页失效不是成功空结果", async () => {
	await ensureObsidianStub();
	const { CatalogReadService } = await import("../src/services/CatalogReadService");
	const { MemoCatalogService } = await import("../src/services/MemoCatalogService");
	const { InMemoryMemoCatalogStore } = await import("../src/services/MemoCatalogStore");
	const store = new InMemoryMemoCatalogStore();
	const catalog = new MemoCatalogService(store);
	await seedCatalog(catalog, store, [makeObservation("Daily/2026-08-22.md", "2026-08-22", 1, "same")]);
	const service = new CatalogReadService({ catalog });
	const page = await service.query({ limit: 1 });
	service.query = async () => page;
	const result = await service.queryTimeBuoysForDate("2026-08-22");
	assert.equal(result.catalogRevision, page.catalogRevision);
	assert.deepEqual(result.coverage, page.coverage);
	let calls = 0;
	service.query = async () => ++calls === 1
		? { ...page, nextCursor: {} as NonNullable<typeof page.nextCursor> }
		: { ...page, invalidated: true, catalogRevision: page.catalogRevision + 1 };
	const invalid = await service.queryTimeBuoysForDate("2026-08-22");
	assert.equal(invalid.invalidated, true);
	assert.deepEqual(invalid.items, []);
	assert.equal(calls, 2);
});

test("清理待处理状态独立于已完成迁移传递，成功后可清除", async () => {
	await ensureObsidianStub();
	const { CatalogReadService } = await import("../src/services/CatalogReadService");
	const { MemoCatalogService } = await import("../src/services/MemoCatalogService");
	const { InMemoryMemoCatalogStore } = await import("../src/services/MemoCatalogStore");
	let pending = true;
	const service = new CatalogReadService({ catalog: new MemoCatalogService(new InMemoryMemoCatalogStore()),
		getLegacyImportStatus: () => "ready", getLegacyCleanupPending: () => pending });
	assert.equal(service.getRuntimeAttentionSnapshot().legacyMigration, "ready");
	assert.equal(service.getRuntimeAttentionSnapshot().legacyCleanupPending, true);
	pending = false;
	assert.equal(service.getRuntimeAttentionSnapshot().legacyCleanupPending, false);
});

test("普通 Catalog observation 不因 Identity 到达而获得永久身份或改变本地 key", async () => {
	await ensureObsidianStub();
	const { CatalogReadService } = await import("../src/services/CatalogReadService");
	const { MemoCatalogService } = await import("../src/services/MemoCatalogService");
	const { InMemoryMemoCatalogStore } = await import("../src/services/MemoCatalogStore");
	const store = new InMemoryMemoCatalogStore();
	const catalog = new MemoCatalogService(store);
	const observation = makeObservation("Daily/2026-08-22.md", "2026-08-22", 1, "first memo");
	await seedCatalog(catalog, store, [observation]);
	const service = new CatalogReadService({ catalog, });

	const before = await service.query({ limit: 50 });
	assert.equal(before.items[0]?.resolved.kind, "observation");
	const after = await service.query({ limit: 50 });

	assert.equal(after.invalidated, false);
	assert.equal(after.items[0]?.renderKey, before.items[0]?.renderKey);
	assert.equal(after.items[0]?.resolved.kind, "observation");
	assert.deepEqual(after, before);
});

test("普通 memo 时间取当前 Daily，不能用 Identity 创建时间补秒", async () => {
	await ensureObsidianStub();
	const { CatalogReadService } = await import("../src/services/CatalogReadService");
	const { MemoCatalogService } = await import("../src/services/MemoCatalogService");
	const { InMemoryMemoCatalogStore } = await import("../src/services/MemoCatalogStore");
	const store = new InMemoryMemoCatalogStore();
	const catalog = new MemoCatalogService(store);
	const observation = makeObservation("Daily/2026-08-22.md", "2026-08-22", 1, "second precision");
	await seedCatalog(catalog, store, [observation]);
	const service = new CatalogReadService({ catalog, });

	const page = await service.query({ limit: 50 });

	assert.equal(observation.time, "12:34");
	assert.equal(page.items[0]?.createdAt, "2026-08-22T12:34");
});

test("Identity 冲突不覆盖普通 observation 的卡片状态", async () => {
	await ensureObsidianStub();
	const { CatalogReadService } = await import("../src/services/CatalogReadService");
	const { MemoCatalogService } = await import("../src/services/MemoCatalogService");
	const { InMemoryMemoCatalogStore } = await import("../src/services/MemoCatalogStore");
	const store = new InMemoryMemoCatalogStore();
	const catalog = new MemoCatalogService(store);
	const conflicted = makeObservation("Daily/2026-08-22.md", "2026-08-22", 1, "conflicted memo");
	const unaffected = makeObservation("Daily/2026-08-22.md", "2026-08-22", 3, "unaffected memo");
	await seedCatalog(catalog, store, [conflicted, unaffected]);
	const service = new CatalogReadService({ catalog, });

	const page = await service.query({ limit: 50 });
	const conflictedItem = page.items.find((item) => item.content === conflicted.content);
	const unaffectedItem = page.items.find((item) => item.content === unaffected.content);

	assert.equal(page.items.length, 2);
	assert.equal(conflictedItem?.resolved.kind, "observation");
	assert.equal(unaffectedItem?.resolved.kind, "observation");
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
		requestObservationScan: () => { scanRequests += 1; },
	});

	const page = await service.query({ limit: 50 });
	await waitImmediate();

	assert.equal(page.readState, "storage_unavailable");
	assert.equal(page.status.content, "unavailable");
	assert.equal(page.degraded, true);
	assert.equal(scanRequests, 1);
});

test("随机重逢不以 Identity 状态限制候选", async () => {
	await ensureObsidianStub();
	const { CatalogReadService } = await import("../src/services/CatalogReadService");
	const { MemoCatalogService } = await import("../src/services/MemoCatalogService");
	const { InMemoryMemoCatalogStore } = await import("../src/services/MemoCatalogStore");
	const store = new InMemoryMemoCatalogStore();
	const catalog = new MemoCatalogService(store);
	const identified = makeObservation("Daily/2026-08-20.md", "2026-08-20", 1, "identified random candidate");
	const syncing = makeObservation("Daily/2026-08-21.md", "2026-08-21", 1, "syncing random candidate");
	await seedCatalogFiles(catalog, store, [identified, syncing]);
	const service = new CatalogReadService({
		catalog,
		now: () => new Date(2026, 7, 26, 12, 0, 0),
		random: () => 0,
	});

	const items = await service.getRandomReunionItems(5);

	assert.deepEqual(items.map((item) => item.contentSnapshot), ["syncing random candidate", "identified random candidate"]);
});

test("Identity absent 时随机重逢直接返回 observation，不执行 adoption", async () => {
	await ensureObsidianStub();
	const { CatalogReadService } = await import("../src/services/CatalogReadService");
	const { MemoCatalogService } = await import("../src/services/MemoCatalogService");
	const { InMemoryMemoCatalogStore } = await import("../src/services/MemoCatalogStore");
	const store = new InMemoryMemoCatalogStore();
	const catalog = new MemoCatalogService(store);
	const first = makeObservation("Daily/2026-08-20.md", "2026-08-20", 1, "first historical random candidate");
	const second = makeObservation("Daily/2026-08-21.md", "2026-08-21", 1, "second historical random candidate");
	await seedCatalogFiles(catalog, store, [first, second]);
	const service = new CatalogReadService({
		catalog,
		now: () => new Date(2026, 7, 26, 12, 0, 0),
		random: () => 0,
	});
	const items = await service.getRandomReunionItems(1);
	assert.equal(items.length, 1);
	assert.equal(items[0]?.catalog?.resolved.kind, "observation");
});

test("缓存候选池应用设备本地的最新 review 权重", async () => {
	await ensureObsidianStub();
	const { CatalogReadService } = await import("../src/services/CatalogReadService");
	const { MemoCatalogService } = await import("../src/services/MemoCatalogService");
	const { InMemoryMemoCatalogStore } = await import("../src/services/MemoCatalogStore");
	const store = new InMemoryMemoCatalogStore();
	const catalog = new MemoCatalogService(store);
	const unreviewed = makeObservation("Daily/2026-08-20.md", "2026-08-20", 1, "unreviewed random candidate");
	const recentlyReviewed = makeObservation("Daily/2026-08-21.md", "2026-08-21", 1, "recently reviewed candidate");
	await seedCatalogFiles(catalog, store, [unreviewed, recentlyReviewed]);
	const service = new CatalogReadService({
		catalog,
		now: () => new Date(2026, 7, 26, 12, 0, 0),
		random: () => 0.5,
	});

	assert.deepEqual(
		(await service.getRandomReunionItems(1)).map((item) => item.contentSnapshot),
		["recently reviewed candidate"],
	);
	await service.recordReview((await service.query({ limit: 10 })).items.find((item) => item.content === recentlyReviewed.content)!);
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
	const service = new CatalogReadService({
		catalog,
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
	const service = new CatalogReadService({
		catalog,
		now: () => new Date(2026, 7, 26, 12, 0, 0),
		random: () => 0,
	});

	assert.equal((await service.getRandomReunionItems(5)).length, 5);
	const firstLoadQueryCalls = queryCalls;
	assert.equal((await service.getRandomReunionItems(5)).length, 5);

	assert.ok(firstLoadQueryCalls > 2);
	assert.equal(queryCalls, firstLoadQueryCalls + 1);
});

test("P8 重逢热缓存只读取选中正文，跨日重新纳入昨天的候选", async () => {
	await ensureObsidianStub();
	const { CatalogReadService } = await import("../src/services/CatalogReadService");
	const { MemoCatalogService } = await import("../src/services/MemoCatalogService");
	const { InMemoryMemoCatalogStore } = await import("../src/services/MemoCatalogStore");
	const store = new InMemoryMemoCatalogStore();
	const catalog = new MemoCatalogService(store);
	const observations = Array.from({ length: 300 }, (_, index) => makeObservation("Daily/2026-07-01.md",
		"2026-07-01", index + 1, `long enough candidate ${index}`));
	const todayMemo = makeObservation("Daily/2026-08-26.md", "2026-08-26", 1, "new yesterday candidate");
	await seedCatalog(catalog, store, observations);
	await seedCatalogFiles(catalog, store, [todayMemo]);
	let today = new Date(2026, 7, 26);
	const service = new CatalogReadService({ catalog, now: () => today, random: () => 0 });
	await service.getRandomReunionItems(5);
	let bodyReads = 0;
	const getObservation = catalog.getObservation.bind(catalog);
	catalog.getObservation = async (key) => { bodyReads++; return getObservation(key); };
	const items = await service.getRandomReunionItems(5);
	assert.equal(bodyReads, 5);
	assert.equal(items.length, 5);
	assert.ok(items.every((item) => item.createdAt.startsWith("2026-07-01")));
	today = new Date(2026, 7, 27);
	assert.equal((await service.getRandomReunionItems(1))[0]?.contentSnapshot, todayMemo.content);
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
	const service = new CatalogReadService({
		catalog,
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
		configurationComplete: true,
		coveredFromDate: first.logicalDate,
		pendingFileCount: 0,
		coveredFileCount: 2,
		totalFileCount: 2,
	});

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
	const service = new CatalogReadService({ catalog, });

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
		configurationComplete: true,
		coveredFromDate: "2026-08-01",
		pendingFileCount: 2,
		coveredFileCount: 1,
		totalFileCount: 3,
	});
	const service = new CatalogReadService({ catalog, });

	assert.equal((await service.getLibrarySummary()).value, null);
	assert.equal(await service.getCoverageForRange("2026-08-01", "2026-08-31"), true);
	assert.equal(await service.getCoverageForRange("2026-07-31", "2026-08-31"), false);
	assert.equal((await service.count({ fromDate: "2026-08-01", toDate: "2026-08-31" })).count, 1);
	assert.equal((await service.count({})).count, null);
	await store.setCoverage({
		kind: "rebuilding",
		configurationComplete: true,
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
	assert.equal((await service.countRecordStatsDrilldown({
		type: "range",
		startDate: "2026-07-01",
		endDateExclusive: "2026-09-01",
	})).count, null);
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
	const service = new CatalogReadService({ catalog, });

	const first = await service.queryReviewItems(new Date(2026, 2, 15), { limit: 1 });
	const second = await service.queryReviewItems(new Date(2026, 2, 15), { limit: 1, cursor: first.nextCursor });
	const count = await service.countReviewItems(new Date(2026, 2, 15));

	assert.deepEqual(first.items.map((item) => item.content), ["february"]);
	assert.deepEqual(second.items.map((item) => item.content), ["november"]);
	assert.equal(second.nextCursor, null);
	assert.equal(count.count, 2);
	assert.equal(count.complete, true);
	assert.equal(count.catalogRevision, first.catalogRevision);
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
	const service = new CatalogReadService({ catalog, });

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
	const service = new CatalogReadService({ catalog, });

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
	assert.deepEqual(moreReferences.items, []);
	assert.equal(moreReferences.nextCursor, null);
	const referenceCount = await service.countRecordStatsDrilldown({ type: "references", ...range });
	assert.deepEqual(references.items.map((item) => item.content), ["explicit [[Daily#^abc]]"]);
	assert.equal(referenceCount.count, 1);
	assert.equal(referenceCount.complete, true);
	assert.deepEqual((await service.queryRecordStatsDrilldown({ type: "max-daily-notes", dates: ["2026-08-01", "2026-08-04"] }, { limit: 50 })).items.map((item) => item.content), ["image", "parent"]);
	assert.deepEqual((await service.queryRecordStatsDrilldown({ type: "max-daily-words", dates: ["2026-08-02", "2026-08-03"] }, { limit: 50 })).items.map((item) => item.content), ["identity", "explicit [[Daily#^abc]]"]);
});

test("记录统计只从 Daily aggregate 构建，不补造 Identity relation 引用", async () => {
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
	const service = new CatalogReadService({ catalog, });

	const prepared = await service.buildRecordStats(async () => undefined, () => true);

	assert.deepEqual(prepared?.overview, { memoCount: 2, wordCount: 5, recordDayCount: 2 });
	assert.equal(prepared?.daily.get("2026-08-02")?.referenceMemoCount, 0);
	assert.equal(prepared?.daily.get("2026-08-01")?.hourCounts[8], 1);
	assert.equal(prepared?.daily.get("2026-08-01")?.tagMemoCounts.get("work/project"), 1);
	assert.equal(prepared?.tagDisplayNames.get("work/project"), "Work/Project");
});

test("普通查询、计数和统计不访问 Identity；混合精度分页、重复项与 revision key 均来自 Daily", async () => {
	await ensureObsidianStub();
	const { createHash } = await import("node:crypto");
	const { DiaryMemoParser } = await import("../src/services/DiaryMemoParser");
	const { CatalogReadService } = await import("../src/services/CatalogReadService");
	const { MemoCatalogService } = await import("../src/services/MemoCatalogService");
	const { InMemoryMemoCatalogStore } = await import("../src/services/MemoCatalogStore");
	const store = new InMemoryMemoCatalogStore();
	const catalog = new MemoCatalogService(store);
	const parser = new DiaryMemoParser(async (bytes) => createHash("sha256").update(bytes).digest("hex"));
	const text = "## Memos\n- 10:30 same\n- 10:30:00 same\n- 10:30:27 later\n- 10:30 same\n";
	const parse = (content: string) => parser.parse({
		sourcePath: "Daily/2026-08-22.md", logicalDate: "2026-08-22", bytes: Buffer.from(content),
	});
	await seedCatalog(catalog, store, (await parse(text)).observations);
	const service = new CatalogReadService({ catalog, });
	const first = await service.query({ limit: 2 });
	const second = await service.query({ limit: 2, cursor: first.nextCursor });
	const items = [...first.items, ...second.items];
	assert.deepEqual(items.map((item) => item.createdAt), [
		"2026-08-22T10:30:27", "2026-08-22T10:30", "2026-08-22T10:30:00", "2026-08-22T10:30",
	]);
	assert.deepEqual(items.map((item) => item.observation.startLine), [3, 4, 2, 1]);
	assert.equal(new Set(items.map((item) => item.key)).size, 4);
	assert.equal("snapshotRevision" in first, false);
	assert.equal((await service.count({})).count, 4);
	assert.equal((await service.countRecordStatsDrilldown({ type: "hour", startDate: "2026-08-22", endDateExclusive: "2026-08-23", hour: 10 })).count, 4);
	assert.equal((await service.buildRecordStats(async () => {}, () => true))?.daily.get("2026-08-22")?.hourCounts[10], 4);
	assert.deepEqual((await service.query({ limit: 4 })).items.map((item) => item.key), items.map((item) => item.key));
	await seedCatalog(catalog, store, (await parse(`${text}\n`)).observations);
	assert.equal((await service.query({ limit: 2, cursor: first.nextCursor })).invalidated, true);
	const refreshed = await service.query({ limit: 4 });
	assert.ok(refreshed.items.every((item) => !items.some((old) => old.key === item.key)));
	assert.deepEqual(refreshed.items.map((item) => item.createdAt), items.map((item) => item.createdAt));
	assert.equal(items[0]?.observationHandle.sourceRevision, (await parse(text)).sourceRevision);
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
		configurationComplete: true,
		coveredFromDate: observations.map((item) => item.logicalDate).sort()[0] ?? null,
		pendingFileCount: 0,
		coveredFileCount: observations.length,
		totalFileCount: observations.length,
	});
}

function makeObservation(sourcePath: string, logicalDate: string, startLine: number, content: string): MemoObservation {
	return {
		occurrenceIndex: 0,
		occurrenceCount: 1,
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

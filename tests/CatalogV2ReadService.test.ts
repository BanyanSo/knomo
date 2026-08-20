import assert from "node:assert/strict";
import test from "node:test";

import { CatalogV2ReadService } from "../src/services/CatalogV2ReadService";
import { buildCatalogPartition, MemoCatalogService } from "../src/services/MemoCatalogService";
import { InMemoryMemoCatalogStore } from "../src/services/MemoCatalogStore";
import type { MemoObservation } from "../src/types/catalog";

test("CatalogV2ReadService keeps unresolved observations queryable without write dependencies", async () => {
	const observation: MemoObservation = {
		sourcePath: "Daily/2026-08-13.md",
		sourceRevision: "a".repeat(64),
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
	assert.equal(page.items[0]?.capabilities.edit, "blocked_settling");
	assert.equal((await service.query({ text: "identity settles", limit: 1 })).items.length, 1);
	assert.equal((await service.buildRecordStats(async () => undefined, () => true))?.overview.memoCount, 1);
	assert.deepEqual(await service.getDeletedSummary(), { count: 0, ids: [] });
});

test("partial Catalog 只允许浏览已加载 Memo，完整数据功能明确拒绝缩减结果", async () => {
	const observation: MemoObservation = {
		sourcePath: "Daily/2026-08-13.md",
		sourceRevision: "b".repeat(64),
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
	assert.deepEqual(page.capabilities, {
		browseKnown: true,
		completeStats: false,
		completeShuffleDayPool: false,
		completeRandomPool: false,
		completeTimeBuoyIndex: false,
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
	assert.equal(page.capabilities.browseKnown, true);
	assert.equal(page.capabilities.completeStats, false);
});

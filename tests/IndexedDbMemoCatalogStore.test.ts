import assert from "node:assert/strict";
import test from "node:test";
import { IDBKeyRange, indexedDB } from "fake-indexeddb";

import { IndexedDbMemoCatalogStore } from "../src/services/IndexedDbMemoCatalogStore";
import { createResolvedMemoCapabilities } from "../src/services/MemoCapabilityModel";
import { buildCatalogPartition } from "../src/services/MemoCatalogService";
import { FallbackMemoCatalogStore, InMemoryMemoCatalogStore } from "../src/services/MemoCatalogStore";
import type { CatalogFilePartition, MemoObservation } from "../src/types/catalog";

test("IndexedDB 使用真实索引完成 recent、搜索、筛选、分页和 aggregate", async () => {
	const databaseName = uniqueDatabaseName("query");
	const store = createStore(databaseName);
	assert.equal(store.getLifecycle().state, "opening");
	await store.open();
	try {
		assert.deepEqual(store.getLifecycle(), { state: "ready", persistent: true, writable: true, reason: null });
		await store.replaceFilePartition(makePartition("Journal/2026-08-08.md", "2026-08-08", [
			makeObservation("Journal/2026-08-08.md", "2026-08-08", 1, "09:00", "older plain"),
		]));
		await store.replaceFilePartition(makePartition("Journal/2026-08-09.md", "2026-08-09", [
			makeObservation("Journal/2026-08-09.md", "2026-08-09", 1, "10:00", "中文索引 alpha", {
				tags: ["project"],
				tasks: [{ taskIndex: 0, lineOffset: 1, marker: " ", text: "task" }],
			}),
			makeObservation("Journal/2026-08-09.md", "2026-08-09", 2, "11:00", "newest beta", {
				images: [{ path: "assets/p.png", altText: "p", syntax: "markdown_image" }],
			}),
		]));
		await store.setCoverage({
			kind: "rebuilding",
			coveredFromDate: "2026-08-09",
			pendingFileCount: 1,
			coveredFileCount: 1,
			totalFileCount: 2,
		});
		assert.equal(store.getLifecycle().state, "rebuilding");
		await store.setCoverage({
			kind: "complete",
			coveredFromDate: "2026-08-08",
			pendingFileCount: 0,
			coveredFileCount: 2,
			totalFileCount: 2,
		});
		assert.equal(store.getLifecycle().state, "ready");

		const firstPage = await store.query({ limit: 2 });
		assert.deepEqual(firstPage.items.map((item) => item.content), ["newest beta", "中文索引 alpha"]);
		assert.notEqual(firstPage.nextCursor, null);
		const secondPage = await store.query({ limit: 2, cursor: firstPage.nextCursor });
		assert.deepEqual(secondPage.items.map((item) => item.content), ["older plain"]);
		const fileBatch = await store.getFileRevisionBatch("Journal/2026-08-09.md");
		assert.ok(fileBatch);
		assert.equal(fileBatch.file.observationCount, 2);
		assert.deepEqual(fileBatch.observations.map((item) => item.content), ["中文索引 alpha", "newest beta"]);
		assert.equal(fileBatch.catalogRevision, firstPage.catalogRevision);

		const search = await store.query({ limit: 50, text: "中文" });
		assert.deepEqual(search.items.map((item) => item.content), ["中文索引 alpha"]);
		assert.ok(search.metrics.cursorReads < 3);
		assert.deepEqual((await store.query({ limit: 50, tags: ["project"] })).items.map((item) => item.content), ["中文索引 alpha"]);
		assert.deepEqual((await store.query({ limit: 50, hasImage: true })).items.map((item) => item.content), ["newest beta"]);
		assert.deepEqual((await store.query({ limit: 50, hasTask: false })).items.map((item) => item.content), ["newest beta", "older plain"]);

		const aggregates = await store.listDailyAggregates();
		assert.deepEqual(aggregates.map((item) => [item.logicalDate, item.memoCount, item.taskCount]), [
			["2026-08-09", 2, 1],
			["2026-08-08", 1, 0],
		]);

		await store.replaceFilePartition(makePartition("Journal/2026-08-08.md", "2026-08-08", [
			makeObservation("Journal/2026-08-08.md", "2026-08-08", 3, "12:00", "changed"),
		]));
		const invalidated = await store.query({ limit: 2, cursor: firstPage.nextCursor });
		assert.equal(invalidated.invalidated, true);
		assert.deepEqual(invalidated.items, []);
		const cursorBeforeClear = (await store.query({ limit: 1 })).nextCursor;
		assert.notEqual(cursorBeforeClear, null);
		await store.clear();
		const cleared = await store.query({ limit: 1, cursor: cursorBeforeClear });
		assert.equal(cleared.invalidated, true);
		assert.deepEqual(cleared.items, []);
	} finally {
		store.close();
		await deleteDatabase(databaseName);
	}
});

test("CAT-QUERY-001 / CAT-TAG-001：IndexedDB 搜索保持子串语义，父标签包含嵌套标签", async () => {
	const databaseName = uniqueDatabaseName("substring-parent-tag");
	const store = createStore(databaseName);
	await store.open();
	try {
		await store.replaceFilePartition(makePartition("Journal/2026-08-09.md", "2026-08-09", [
			makeObservation("Journal/2026-08-09.md", "2026-08-09", 1, "09:00", "Notebook 123456", {
				tags: ["project/knomo/ui"],
			}),
			makeObservation("Journal/2026-08-09.md", "2026-08-09", 2, "10:00", "unrelated", {
				tags: ["personal"],
			}),
		]));

		assert.deepEqual((await store.query({ limit: 50, text: "book" })).items.map((item) => item.content), ["Notebook 123456"]);
		assert.deepEqual((await store.query({ limit: 50, text: "123" })).items.map((item) => item.content), ["Notebook 123456"]);
		assert.deepEqual((await store.query({ limit: 50, tags: ["project"] })).items.map((item) => item.content), ["Notebook 123456"]);
		assert.deepEqual((await store.query({ limit: 50, tags: ["project/knomo"] })).items.map((item) => item.content), ["Notebook 123456"]);
	} finally {
		store.close();
		await deleteDatabase(databaseName);
	}
});

test("CAT-PAGE-001：IndexedDB 连续遍历 1001 条记录不重复、不漏项", async () => {
	const databaseName = uniqueDatabaseName("large-pagination");
	const store = createStore(databaseName);
	await store.open();
	try {
		const observations = Array.from({ length: 1_001 }, (_, index) => makeObservation(
			"Journal/2026-08-09.md",
			"2026-08-09",
			index + 1,
			"09:00",
			`memo-${index.toString().padStart(4, "0")}`,
		));
		await store.replaceFilePartition(makePartition("Journal/2026-08-09.md", "2026-08-09", observations));

		const observationKeys: string[] = [];
		let cursor = null;
		do {
			const page = await store.query({ limit: 37, cursor });
			assert.equal(page.invalidated, false);
			observationKeys.push(...page.items.map((item) => item.observationKey));
			cursor = page.nextCursor;
		} while (cursor !== null);

		assert.equal(observationKeys.length, 1_001);
		assert.equal(new Set(observationKeys).size, 1_001);
	} finally {
		store.close();
		await deleteDatabase(databaseName);
	}
});

test("IDB-DELETE-REBUILD：删除本机 Catalog 后可从 Daily 分区重建", async () => {
	const databaseName = uniqueDatabaseName("delete-rebuild");
	let store = createStore(databaseName);
	await store.open();
	await store.replaceFilePartition(makePartition("2026-08-09.md", "2026-08-09", [
		makeObservation("2026-08-09.md", "2026-08-09", 1, "09:00", "before delete"),
	]));
	store.close();
	await deleteDatabase(databaseName);

	store = createStore(databaseName);
	await store.open();
	try {
		assert.deepEqual(await store.listFiles(), []);
		await store.replaceFilePartition(makePartition("2026-08-09.md", "2026-08-09", [
			makeObservation("2026-08-09.md", "2026-08-09", 1, "09:00", "rebuilt"),
		]));
		assert.deepEqual((await store.query({ limit: 50 })).items.map((item) => item.content), ["rebuilt"]);
	} finally {
		store.close();
		await deleteDatabase(databaseName);
	}
});

test("损坏 schema 被识别并重建为可用的空 Catalog", async () => {
	const databaseName = uniqueDatabaseName("corrupt");
	const corrupt = await openRawDatabase(databaseName, 1, (database) => database.createObjectStore("wrong"));
	corrupt.close();

	const store = createStore(databaseName);
	await store.open();
	try {
		assert.deepEqual(await store.listFiles(), []);
		await store.replaceFilePartition(makePartition("2026-08-09.md", "2026-08-09", []));
		assert.equal((await store.listFiles()).length, 1);
	} finally {
		store.close();
		await deleteDatabase(databaseName);
	}
});

test("IDB-BLOCKED：升级被旧连接阻塞时立即降级到有界内存 Store", async () => {
	const databaseName = uniqueDatabaseName("blocked");
	const blocker = await openRawDatabase(databaseName, 1, (database) => database.createObjectStore("legacy"));
	const primary = createStore(databaseName, { version: 2 });
	const fallback = new InMemoryMemoCatalogStore(150);
	const store = new FallbackMemoCatalogStore(primary, fallback);
	await store.open();
	assert.equal(store.isUsingFallback, true);
	assert.equal(store.getLifecycle().state, "degraded");
	assert.equal(store.getLifecycle().persistent, false);
	await store.replaceFilePartition(makePartition("2026-08-09.md", "2026-08-09", []));
	assert.equal((await store.listFiles()).length, 1);
	store.close();
	blocker.close();
	await new Promise<void>((resolve) => setImmediate(resolve));
	await deleteDatabase(databaseName);
});

test("IDB-UPGRADE-ABORT：schema 升级中止时旧功能可用且 Catalog 降级", async () => {
	const databaseName = uniqueDatabaseName("upgrade-abort");
	const primary = createStore(databaseName, {
		beforeUpgrade: () => {
			throw new Error("test upgrade abort");
		},
	});
	const store = new FallbackMemoCatalogStore(primary, new InMemoryMemoCatalogStore(150));
	await store.open();
	assert.equal(store.isUsingFallback, true);
	assert.equal(store.getLifecycle().state, "degraded");
	await store.replaceFilePartition(makePartition("2026-08-09.md", "2026-08-09", []));
	assert.equal((await store.listFiles()).length, 1);
	store.close();
	await deleteDatabase(databaseName);
});

test("本机 Catalog 降级后可显式重连持久化存储", async () => {
	const databaseName = uniqueDatabaseName("retry-fallback");
	const blocker = await openRawDatabase(databaseName, 1, (database) => database.createObjectStore("legacy"));
	const store = new FallbackMemoCatalogStore(
		createStore(databaseName, { version: 2 }),
		new InMemoryMemoCatalogStore(),
	);
	await store.open();
	assert.equal(store.isUsingFallback, true);
	await store.replaceFilePartition(makePartition("2026-08-09.md", "2026-08-09", []));

	blocker.close();
	await new Promise<void>((resolve) => setImmediate(resolve));
	await store.open();

	assert.equal(store.isUsingFallback, false);
	assert.equal(store.getLifecycle().state, "ready");
	assert.deepEqual(await store.listFiles(), []);
	store.close();
	await deleteDatabase(databaseName);
});

test("resolution snapshot atomically persists every observation result without a memory cap", async () => {
	const store = new InMemoryMemoCatalogStore();
	await store.open();
	const results = Object.fromEntries(Array.from({ length: 500 }, (_, index) => {
		const observation = makeObservation("Daily/2026-08-09.md", "2026-08-09", index, "09:00", `memo-${index}`);
		return [observation.sourcePath + "\0" + index.toString().padStart(10, "0"), {
			kind: "observed" as const,
			identityHandle: null,
			observation,
			adoption: "settling" as const,
			capabilities: createResolvedMemoCapabilities("syncing"),
			identityRevision: "identity-1",
		}];
	}));
	await store.saveResolutionSnapshot({
		catalogRevision: 7,
		identityRevision: "identity-1",
		results,
	});

	const restored = await store.loadResolutionSnapshot();
	assert.equal(Object.keys(restored?.results ?? {}).length, 500);
	assert.equal(restored?.catalogRevision, 7);
});

test("IDB-VERSIONCHANGE：运行期连接失效后自动重开，无法重开时安全切换为 partial 内存缓存", async () => {
	const databaseName = uniqueDatabaseName("versionchange");
	const primary = createStore(databaseName);
	let recoveryCount = 0;
	const store = new FallbackMemoCatalogStore(primary, new InMemoryMemoCatalogStore(), () => {
		recoveryCount += 1;
	});
	await store.open();
	await store.replaceFilePartition(makePartition("2026-08-09.md", "2026-08-09", []));
	primary.close();
	assert.equal((await store.listFiles()).length, 1, "同版本连接关闭后应自动重开");
	assert.equal(recoveryCount, 1);

	const newer = await openRawDatabase(databaseName, 3, () => undefined);
	assert.equal(primary.getLifecycle().state, "read-only");
	assert.deepEqual(await store.listFiles(), []);
	assert.equal(store.isUsingFallback, true);
	assert.equal(store.getLifecycle().state, "degraded");
	assert.equal(recoveryCount, 2);
	await store.setCoverage({
		kind: "complete",
		coveredFromDate: "2026-08-09",
		pendingFileCount: 0,
		coveredFileCount: 1,
		totalFileCount: 1,
	});
	assert.equal((await store.getCoverage()).kind, "partial");
	store.close();
	newer.close();
	await deleteDatabase(databaseName);
});

test("IDB-EVICTION：运行期数据库被删除后重开为 partial，并请求从 Daily 重建", async () => {
	const databaseName = uniqueDatabaseName("eviction");
	const primary = createStore(databaseName);
	let recoveryCount = 0;
	const store = new FallbackMemoCatalogStore(primary, new InMemoryMemoCatalogStore(), () => {
		recoveryCount += 1;
	});
	await store.open();
	await store.replaceFilePartition(makePartition("2026-08-09.md", "2026-08-09", [
		makeObservation("2026-08-09.md", "2026-08-09", 1, "09:00", "evicted"),
	]));
	await store.setCoverage({
		kind: "complete",
		coveredFromDate: "2026-08-09",
		pendingFileCount: 0,
		coveredFileCount: 1,
		totalFileCount: 1,
	});

	await deleteDatabase(databaseName);
	assert.equal(primary.getLifecycle().state, "read-only");
	assert.deepEqual(await store.listFiles(), []);
	assert.equal(recoveryCount, 1);
	assert.equal((await store.getCoverage()).kind, "partial");
	assert.equal(store.getLifecycle().state, "ready");
	store.close();
	await deleteDatabase(databaseName);
});

test("IDB-TRANSACTION-ABORT：运行期事务失败降级为 partial 内存 Catalog", async () => {
	const databaseName = uniqueDatabaseName("transaction-abort");
	const primary = createStore(databaseName);
	const originalReplace = primary.replaceFilePartition.bind(primary);
	let failOnce = true;
	primary.replaceFilePartition = async (partition) => {
		if (failOnce) {
			failOnce = false;
			throw new Error("Memo Catalog IndexedDB transaction aborted.");
		}
		return originalReplace(partition);
	};
	const store = new FallbackMemoCatalogStore(primary, new InMemoryMemoCatalogStore());
	await store.open();

	await store.replaceFilePartition(makePartition("2026-08-09.md", "2026-08-09", []));
	assert.equal(store.isUsingFallback, true);
	assert.equal(store.getLifecycle().state, "degraded");
	assert.equal((await store.getCoverage()).kind, "partial");
	assert.equal((await store.listFiles()).length, 1);
	store.close();
	await deleteDatabase(databaseName);
});

function createStore(
	databaseName: string,
	overrides: Partial<{ version: number; beforeUpgrade: () => void }> = {},
): IndexedDbMemoCatalogStore {
	return new IndexedDbMemoCatalogStore(databaseName, {
		factory: indexedDB,
		keyRange: IDBKeyRange,
		...overrides,
	});
}

function makePartition(sourcePath: string, logicalDate: string, observations: MemoObservation[]): CatalogFilePartition {
	return buildCatalogPartition({
		inventory: { sourcePath, logicalDate, mtime: 100, size: 200 },
		sourceRevision: `sha-${sourcePath}-${observations.length}`,
		observations,
		parserVersion: 1,
		settingsFingerprint: "settings-v1",
		auditedAt: 123,
	});
}

function makeObservation(
	sourcePath: string,
	logicalDate: string,
	startLine: number,
	time: string,
	content: string,
	overrides: Partial<MemoObservation> = {},
): MemoObservation {
	return {
		sourcePath,
		sourceRevision: "sha",
		rawBlockHash: `raw-${startLine}`,
		logicalDate,
		section: "## Memos",
		startLine,
		endLine: startLine,
		time,
		content,
		contentHash: `hash-${startLine}`,
		existingBlockId: null,
		tags: [],
		links: [],
		images: [],
		tasks: [],
		timeBuoyDates: [],
		...overrides,
	};
}

function uniqueDatabaseName(suffix: string): string {
	return `knomo-catalog-test-${suffix}-${Date.now()}-${Math.random()}`;
}

function openRawDatabase(
	databaseName: string,
	version: number,
	onUpgrade: (database: IDBDatabase) => void,
): Promise<IDBDatabase> {
	return new Promise<IDBDatabase>((resolve, reject) => {
		const request = indexedDB.open(databaseName, version);
		request.onupgradeneeded = () => onUpgrade(request.result);
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

function deleteDatabase(databaseName: string): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const request = indexedDB.deleteDatabase(databaseName);
		request.onsuccess = () => resolve();
		request.onerror = () => reject(request.error);
		request.onblocked = () => reject(new Error(`Blocked while deleting ${databaseName}.`));
	});
}

import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import type { CatalogQuery } from "../src/types/catalog";
import type { MemoCatalogStore } from "../src/services/MemoCatalogStore";
import { ensureObsidianStub } from "./helpers/obsidianStub";

const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
before(() => Object.defineProperty(globalThis, "window", { configurable: true, value: { setTimeout: globalThis.setTimeout } }));
after(() => { if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow); else Reflect.deleteProperty(globalThis, "window"); });

for (const kind of ["memory", "indexeddb"] as const) {
	test(`${kind}：新增今日文件只更新对应分区，历史候选不重新全量读取`, async () => {
		const f = await fixture(kind);
		try {
			await f.seed("Daily/2026-08-01.md", "2026-08-01", "old-a", 175);
			await f.seed("Daily/2026-08-02.md", "2026-08-02", "old-b", 175);
			await complete(f.store, 2);
			assert.equal((await f.service.getRandomReunionItems(10)).length, 10);
			assert.equal(f.requests.length, 3);
			f.requests.length = 0;
			f.resetReads();
			await f.seed("Daily/2026-08-26.md", "2026-08-26", "today", 1);
			await complete(f.store, 3);
			const items = await f.service.getRandomReunionItems(10);
			assert.equal(items.length, 10);
			assert.ok(items.every(item => !item.contentSnapshot.includes("today")));
			assert.equal(f.requests.length, 0);
			assert.equal(f.observationReads(), 0);
			f.requests.length = 0;
			await f.service.getRandomReunionItems(10);
			assert.equal(f.requests.length, 0);
		} finally { f.store.close(); }
	});

	test(`${kind}：历史文件更新、删除和重命名不沿用旧候选，增量查询仍分页`, async () => {
		const f = await fixture(kind);
		try {
			await f.seed("Daily/2026-08-01.md", "2026-08-01", "first", 175);
			await f.seed("Daily/2026-08-02.md", "2026-08-02", "second", 2);
			await complete(f.store, 2);
			await f.service.getRandomReunionItems(10);
			await f.seed("Daily/2026-08-01.md", "2026-08-01", "updated", 175);
			f.requests.length = 0;
			f.resetReads();
			let items = await f.service.getRandomReunionItems(200);
			assert.equal(items.length, 177);
			assert.ok(items.every(item => !item.contentSnapshot.includes("first")));
			assert.equal(f.requests.length, 2);
			assert.ok(f.observationReads() <= 176);
			assert.ok(f.requests.every(request => request.sourcePaths?.join() === "Daily/2026-08-01.md"));
			await f.catalog.deleteFile("Daily/2026-08-02.md");
			await complete(f.store, 1);
			items = await f.service.getRandomReunionItems(200);
			assert.equal(items.length, 175);
			assert.ok(items.every(item => item.contentSnapshot.includes("updated")));
			await f.catalog.deleteFile("Daily/2026-08-01.md");
			await f.seed("Daily/moved/2026-08-01.md", "2026-08-01", "renamed", 175);
			f.requests.length = 0;
			items = await f.service.getRandomReunionItems(200);
			assert.equal(items.length, 175);
			assert.ok(items.every(item => item.dailyRef?.path === "Daily/moved/2026-08-01.md"));
			assert.ok(f.requests.every(request => request.sourcePaths?.join() === "Daily/moved/2026-08-01.md"));
		} finally { f.store.close(); }
	});

	test(`${kind}：直接 store 写入参与增量，重建和重新打开强制完整读取`, async () => {
		const f = await fixture(kind);
		try {
			await f.seed("Daily/2026-08-01.md", "2026-08-01", "before", 2);
			await complete(f.store, 1);
			await f.service.getRandomReunionItems(10);
			const partition = await buildPartition("Daily/2026-08-01.md", "2026-08-01", "untracked", 2);
			await f.store.replaceFilePartition(partition);
			f.requests.length = 0;
			let items = await f.service.getRandomReunionItems(10);
			assert.ok(items.every(item => item.contentSnapshot.includes("untracked")));
			assert.deepEqual(f.requests[0]?.sourcePaths, ["Daily/2026-08-01.md"]);
			await f.store.clear();
			await f.seed("Daily/2026-08-01.md", "2026-08-01", "rebuilt", 2);
			await complete(f.store, 1);
			f.requests.length = 0;
			items = await f.service.getRandomReunionItems(10);
			assert.ok(items.every(item => item.contentSnapshot.includes("rebuilt")));
			assert.ok(f.requests.some(request => request.sourcePaths === undefined));
			f.store.close();
			await f.store.open();
			f.requests.length = 0;
			await f.service.getRandomReunionItems(10);
			assert.ok(f.requests.some(request => request.sourcePaths === undefined));
		} finally { f.store.close(); }
	});

	test(`${kind}：增量扫描期间再次变化时重试，不发布混合 revision 的候选`, async () => {
		const f = await fixture(kind);
		try {
			await f.seed("Daily/2026-08-01.md", "2026-08-01", "original", 175);
			await complete(f.store, 1);
			await f.service.getRandomReunionItems(10);
			await f.seed("Daily/2026-08-01.md", "2026-08-01", "intermediate", 175);
			const original = f.store.query.bind(f.store);
			let changed = false;
			f.store.query = async request => {
				const page = await original(request);
				if (!changed) { changed = true; await f.seed("Daily/2026-08-01.md", "2026-08-01", "latest", 175); }
				return page;
			};
			const items = await f.service.getRandomReunionItems(200);
			assert.equal(items.length, 175);
			assert.ok(items.every(item => item.contentSnapshot.includes("latest")));
		} finally { f.store.close(); }
	});
}

async function fixture(kind: "memory" | "indexeddb") {
	await ensureObsidianStub();
	const { MemoCatalogService } = await import("../src/services/MemoCatalogService");
	const { CatalogReadService } = await import("../src/services/CatalogReadService");
	const { InMemoryMemoCatalogStore } = await import("../src/services/MemoCatalogStore");
	const { IndexedDbMemoCatalogStore } = await import("../src/services/IndexedDbMemoCatalogStore");
	const factory = new IDBFactory(), databaseName = `random-incremental-${Math.random()}`;
	const store: MemoCatalogStore = kind === "memory" ? new InMemoryMemoCatalogStore() : new IndexedDbMemoCatalogStore(databaseName, {
		factory, keyRange: IDBKeyRange,
	});
	await store.open();
	const catalog = new MemoCatalogService(store);
	const requests: CatalogQuery[] = [];
	const query = store.query.bind(store);
	let observationReads = 0;
	store.query = async request => { requests.push(request); const page = await query(request); observationReads += page.metrics.observationsRead; return page; };
	return {
		store, catalog, requests, factory, databaseName, observationReads: () => observationReads, resetReads: () => { observationReads = 0; },
		service: new CatalogReadService({ catalog, now: () => new Date(2026, 7, 26, 12), random: () => 0 }),
		seed: async (sourcePath: string, logicalDate: string, label: string, count: number) => {
			const partition = await buildPartition(sourcePath, logicalDate, label, count);
			return catalog.replaceFile({ inventory: partition.file, sourceRevision: partition.file.sourceRevision,
				observations: partition.observations, parserVersion: partition.file.parserVersion,
				settingsFingerprint: partition.file.settingsFingerprint, auditedAt: 1 });
		},
	};
}

async function buildPartition(sourcePath: string, logicalDate: string, label: string, count: number) {
	const { DiaryMemoParser, CATALOG_PARSER_VERSION } = await import("../src/services/DiaryMemoParser");
	const { buildCatalogPartition } = await import("../src/services/MemoCatalogService");
	const content = Array.from({ length: count }, (_, index) => `- 12:34 ${label} eligible historical memo ${index}`).join("\n");
	const parsed = new DiaryMemoParser().parseRevision({ sourcePath, logicalDate, content, sourceRevision: `${label}-${count}` });
	return buildCatalogPartition({ inventory: { sourcePath, logicalDate, mtime: 1, size: content.length },
		sourceRevision: parsed.sourceRevision, observations: parsed.observations,
		parserVersion: CATALOG_PARSER_VERSION, settingsFingerprint: "test", auditedAt: 1 });
}

async function complete(store: MemoCatalogStore, files: number) {
	await store.setCoverage({ kind: "complete", coveredFromDate: "2026-08-01", pendingFileCount: 0, coveredFileCount: files, totalFileCount: files });
}


test("Catalog 变更记录超出保留边界时退回完整读取", async () => {
	const f = await fixture("memory");
	try {
		await f.seed("Daily/2026-08-01.md", "2026-08-01", "initial", 1);
		const before = (await f.catalog.readFileChangesSince()).cursor;
		for (let index = 0; index < 300; index++) await f.seed("Daily/2026-08-01.md", "2026-08-01", String(index), 0);
		const changes = await f.catalog.readFileChangesSince(before);
		assert.equal(changes.sourcePaths, null);
		assert.equal(changes.invalidated, false);
	} finally { f.store.close(); }
});

test("fallback 即使碰巧具有相同 revision，也不继承主 store 的候选变更游标", async () => {
	await ensureObsidianStub();
	const { InMemoryMemoCatalogStore, FallbackMemoCatalogStore } = await import("../src/services/MemoCatalogStore");
	const { MemoCatalogService } = await import("../src/services/MemoCatalogService");
	const primary = new InMemoryMemoCatalogStore(), fallback = new InMemoryMemoCatalogStore();
	const store = new FallbackMemoCatalogStore(primary, fallback);
	await store.open();
	try {
		const catalog = new MemoCatalogService(store);
		await primary.replaceFilePartition(await buildPartition("Daily/2026-08-01.md", "2026-08-01", "primary", 1));
		await fallback.replaceFilePartition(await buildPartition("Daily/2026-08-01.md", "2026-08-01", "fallback", 1));
		const before = (await catalog.readFileChangesSince()).cursor;
		primary.getCatalogRevision = async () => { throw new Error("unavailable"); };
		assert.equal((await catalog.readFileChangesSince(before)).invalidated, true);
		const after = await catalog.readFileChangesSince(before);
		assert.equal(after.cursor.catalogRevision, before.catalogRevision);
		assert.notEqual(after.cursor.storeGeneration, before.storeGeneration);
		assert.equal(after.sourcePaths, null);
	} finally { store.close(); }
});


test("其他 IndexedDB 连接的更新不能被空删除误记为本连接的增量", async () => {
	const f = await fixture("indexeddb");
	const { IndexedDbMemoCatalogStore } = await import("../src/services/IndexedDbMemoCatalogStore");
	const external = new IndexedDbMemoCatalogStore(f.databaseName, { factory: f.factory, keyRange: IDBKeyRange });
	try {
		await f.seed("Daily/2026-08-01.md", "2026-08-01", "initial", 2);
		await complete(f.store, 1);
		await f.service.getRandomReunionItems(10);
		const cursor = (await f.catalog.readFileChangesSince()).cursor;
		await external.replaceFilePartition(await buildPartition("Daily/2026-08-01.md", "2026-08-01", "external", 2));
		await f.catalog.deleteFile("Daily/absent.md");
		assert.equal((await f.catalog.readFileChangesSince(cursor)).sourcePaths, null);
		f.requests.length = 0;
		const items = await f.service.getRandomReunionItems(10);
		assert.ok(items.every(item => item.contentSnapshot.includes("external")));
		assert.ok(f.requests.some(request => request.sourcePaths === undefined));
	} finally { external.close(); f.store.close(); }
});

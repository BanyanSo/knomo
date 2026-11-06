import assert from "node:assert/strict";
import test from "node:test";
import { indexedDB, IDBKeyRange, IDBObjectStore as FakeObjectStore } from "fake-indexeddb";
import { DiaryMemoParser, CATALOG_PARSER_VERSION } from "../src/services/DiaryMemoParser";
import { buildCatalogPartition, MemoCatalogService } from "../src/services/MemoCatalogService";
import { InMemoryMemoCatalogStore } from "../src/services/MemoCatalogStore";
import { IndexedDbMemoCatalogStore } from "../src/services/IndexedDbMemoCatalogStore";
import { CatalogReadService, buildRecordStatsCatalogQuery } from "../src/services/CatalogReadService";
import { getCatalogQueryKey, intersectCatalogFilters, narrowCatalogQuery } from "../src/services/SearchMatching";
import { RecordStatsService } from "../src/services/RecordStatsService";
import type { CatalogCursor, CatalogQueryFilter } from "../src/types/catalog";
import type { CatalogFeatureCursor } from "../src/types/catalogView";

function partition(path: string, date: string, memos: string[]) {
	const content = memos.map(memo => `- 09:00 ${memo}\n`).join("");
	const parsed = new DiaryMemoParser().parseRevision({ sourcePath: path, logicalDate: date, sourceRevision: content, content });
	return buildCatalogPartition({ inventory: { sourcePath: path, logicalDate: date, mtime: 1, size: content.length },
		sourceRevision: content, observations: parsed.observations, parserVersion: CATALOG_PARSER_VERSION, settingsFingerprint: "exact", auditedAt: 1 });
}

test("精确标签查询身份、空条件及交集与完整标签规范化一致", () => {
	assert.equal(getCatalogQueryKey({ exactTags: ["#Work", "work", "项目/子", ""] }),
		getCatalogQueryKey({ exactTags: ["项目/子", "WORK"] }));
	for (const exactTags of [undefined, [], ["", "#", " "]]) {
		assert.equal(getCatalogQueryKey({ exactTags }), getCatalogQueryKey({}));
		assert.equal(narrowCatalogQuery({ hasTag: false, exactTags }).matchNone, undefined);
	}
	assert.notEqual(getCatalogQueryKey({ exactTags: ["work"] }), getCatalogQueryKey({ tags: ["work"] }));
	assert.notEqual(getCatalogQueryKey({ exactTags: ["Ａ"] }), getCatalogQueryKey({ exactTags: ["A"] }));
	assert.deepEqual(intersectCatalogFilters({ exactTags: ["#Project"] }, { exactTags: ["project/a", "PROJECT"] }),
		{ exactTags: ["project", "project/a"] });
	for (const exactTags of [undefined, [], ["", "#"]]) {
		assert.deepEqual(intersectCatalogFilters({ exactTags: ["#Project"] }, { exactTags }), { exactTags: ["project"] });
	}
	assert.equal(narrowCatalogQuery({ hasTag: false, exactTags: ["#Work"] }).matchNone, true);
});

test("两个 store 的精确计数、榜单和小页遍历一致，特殊 key 重开保留", async () => {
	const name = `exact-tags-${Date.now()}-${Math.random()}`;
	const stores = [new InMemoryMemoCatalogStore(), new IndexedDbMemoCatalogStore(name, { factory: indexedDB, keyRange: IDBKeyRange })];
	try {
		for (const store of stores) {
			await store.open();
			await store.replaceFilePartition(partition("Daily/2026-11-02-a.md", "2026-11-02", [
				"same #项目 #项目/Knomo #Constructor #__PROTO__", "same #项目/Knomo #项目/Knomo",
				"C #项目/电商", "D #项目/Knomo/性能", "wide #Ａ #中文/😀/三级", "ascii #A",
			]));
			await store.replaceFilePartition(partition("Daily/2026-11-02-b.md", "2026-11-02", [
				"same #项目 #项目/Knomo #Constructor #__PROTO__",
			]));
			await store.replaceFilePartition(partition("Daily/2026-10-31.md", "2026-10-31", ["outside #项目"]));
			await store.setCoverage({ kind: "complete", coveredFromDate: "2026-10-31", coveredFileCount: 3, totalFileCount: 3, pendingFileCount: 0 });
			store.close(); await store.open();
			const reader = new CatalogReadService({ catalog: new MemoCatalogService(store) });
			try {
				const prepared = await reader.buildRecordStats(async () => {}, () => true);
				assert.ok(prepared);
				assert.equal(prepared.daily.get("2026-11-02")!.tagMemoCounts.get("constructor"), 2);
				assert.equal(prepared.daily.get("2026-11-02")!.tagMemoCounts.get("__proto__"), 2);
				assert.equal(prepared.tagDisplayNames.get("constructor"), "Constructor");
				assert.equal(prepared.tagDisplayNames.get("__proto__"), "__PROTO__");
				const stats = new RecordStatsService();
				await stats.prepareFromSource("exact", async () => prepared);
				for (const view of ["week", "month", "year"] as const) {
					const selected = stats.select(view, new Date(2026, 10, 5))!;
					for (const tag of selected.commonTags) {
						const query = buildRecordStatsCatalogQuery({ type: "tag", startDate: selected.startDate,
							endDateExclusive: selected.endDateExclusive, tagKey: tag.key, tagLabel: tag.label }).query;
						assert.equal((await reader.count(query)).count, tag.count);
						const keys: string[] = [];
						let cursor: CatalogFeatureCursor | null = null;
						do {
							const page = await reader.query({ ...query, limit: 1, cursor });
							keys.push(...page.items.map(item => item.key)); cursor = page.nextCursor;
						} while (cursor);
						assert.equal(keys.length, tag.count); assert.equal(new Set(keys).size, tag.count);
					}
				}
				const scope = { fromDate: "2026-11-02", toDate: "2026-11-08" };
				const cases: [CatalogQueryFilter, number][] = [
					[{ tags: ["项目"] }, 5], [{ exactTags: ["项目"] }, 2],
					[{ exactTags: ["项目", "项目/knomo"] }, 2], [{ tags: ["项目"], exactTags: ["项目/knomo"] }, 3],
					[{ exactTags: ["项目/knomo"], text: "same", toDate: "2026-11-02" }, 3],
					[{ exactTags: ["Ａ"] }, 1], [{ exactTags: ["A"] }, 1], [{ exactTags: ["中文/😀/三级"] }, 1],
					[{ exactTags: ["项目"], hasTag: false }, 0], [{ exactTags: ["", "#"], hasTag: false }, 0],
					[{ exactTags: ["", "#", " "] }, 7],
				];
				for (const [filter, expected] of cases) {
					assert.equal((await reader.count({ ...scope, ...filter })).count, expected, JSON.stringify(filter));
					assert.equal((await reader.query({ ...scope, ...filter, limit: 50 })).items.length, expected);
				}
				assert.equal((await reader.count({ ...scope, tags: ["项目"] })).count, 5, "同 revision 共享缓存不串精确条件");
				const oldPage = await store.query({ ...scope, exactTags: ["项目"], limit: 1 });
				assert.ok(oldPage.nextCursor);
				await store.replaceFilePartition(partition("Daily/2026-11-02-a.md", "2026-11-02", ["edited #项目/Knomo"]));
				assert.equal((await store.query({ ...scope, exactTags: ["项目"], limit: 1, cursor: oldPage.nextCursor })).invalidated, true);
				assert.equal((await reader.count({ ...scope, exactTags: ["项目"] })).count, 1);
				await store.deleteFilePartition("Daily/2026-11-02-b.md");
				assert.equal((await reader.count({ ...scope, exactTags: ["项目"] })).count, 0);
				assert.equal((await reader.buildRecordStats(async () => {}, () => true))!.daily.get("2026-11-02")!.tagMemoCounts.get("项目/knomo"), 1);
			} finally { reader.relations.dispose(); }
		}
	} finally {
		for (const store of stores) store.close();
		await new Promise<void>((resolve, reject) => { const request = indexedDB.deleteDatabase(name); request.onsuccess = () => resolve(); request.onerror = () => reject(request.error); });
	}
});

test("精确 posting 查询和计数取消时不返回部分结果", async t => {
	for (const operation of ["query", "count"] as const) await t.test(operation, async t => {
		const name = `exact-cancel-${operation}-${Date.now()}`;
		const store = new IndexedDbMemoCatalogStore(name, { factory: indexedDB, keyRange: IDBKeyRange });
		try {
			await store.open();
			await store.replaceFilePartition(partition("Daily/2026-11-02.md", "2026-11-02", ["one #project", "child #project/a"]));
			const controller = new AbortController(), get = FakeObjectStore.prototype.get;
			t.mock.method(FakeObjectStore.prototype, "get", function(this: IDBObjectStore, ...args: Parameters<IDBObjectStore["get"]>) {
				const request = get.apply(this, args);
				if (this.name === "observations") request.addEventListener("success", () => controller.abort());
				return request;
			});
			await assert.rejects(operation === "query"
				? store.query({ exactTags: ["project"], limit: 1 }, controller.signal)
				: store.count({ exactTags: ["project"] }, controller.signal), { name: "AbortError" });
		} finally {
			store.close();
			await new Promise<void>((resolve, reject) => { const request = indexedDB.deleteDatabase(name); request.onsuccess = () => resolve(); request.onerror = () => reject(request.error); });
		}
	});
});

test("精确查询使用日期内 posting，跳过多批子标签后仍完整分页且组合选择更小候选", async () => {
	const name = `exact-posting-${Date.now()}-${Math.random()}`;
	const store = new IndexedDbMemoCatalogStore(name, { factory: indexedDB, keyRange: IDBKeyRange });
	try {
		await store.open();
		await store.replaceFilePartition(partition("Daily/2026-11-02.md", "2026-11-02", [
			"first #project", "needle #project #project/a", "same #project",
			...Array.from({ length: 350 }, () => "child #project/a"),
			...Array.from({ length: 400 }, () => "unrelated #other"),
		]));
		await store.replaceFilePartition(partition("Daily/2026-10-01.md", "2026-10-01", Array.from({ length: 500 }, () => "outside #project")));
		const filter = { exactTags: ["#Project"], fromDate: "2026-11-02", toDate: "2026-11-02" };
		const keys: string[] = [];
		let cursor: CatalogCursor | null = null;
		do {
			const page = await store.query({ ...filter, limit: 1, cursor });
			assert.ok(page.metrics.observationsRead <= 353, JSON.stringify(page.metrics));
			keys.push(...page.items.map(item => item.observationKey)); cursor = page.nextCursor;
		} while (cursor);
		assert.equal(keys.length, 3); assert.equal(new Set(keys).size, 3);
		assert.equal((await store.count(filter)).count, 3);
		const combined = await store.query({ ...filter, text: "needle", limit: 1 });
		assert.equal(combined.items.length, 1);
		assert.equal(combined.metrics.observationsRead, 1, "组合条件允许选择更小的文字 posting");
		assert.equal((await store.count({ ...filter, text: "needle" })).count, 1);
	} finally {
		store.close();
		await new Promise<void>((resolve, reject) => { const request = indexedDB.deleteDatabase(name); request.onsuccess = () => resolve(); request.onerror = () => reject(request.error); });
	}
});

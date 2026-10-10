import assert from "node:assert/strict";
import test from "node:test";
import { indexedDB, IDBKeyRange } from "fake-indexeddb";
import { DiaryMemoParser, CATALOG_PARSER_VERSION } from "../src/services/DiaryMemoParser";
import { buildCatalogPartition, buildCatalogObservation, MemoCatalogService } from "../src/services/MemoCatalogService";
import { InMemoryMemoCatalogStore, matchesCatalogQuery } from "../src/services/MemoCatalogStore";
import { IndexedDbMemoCatalogStore } from "../src/services/IndexedDbMemoCatalogStore";
import { CatalogReadService, buildReviewCatalogQuery } from "../src/services/CatalogReadService";
import { buildSearchBody } from "../src/services/SearchDocument";
import { parseSearchInput } from "../src/services/SearchQuery";
import { narrowCatalogQuery } from "../src/services/SearchMatching";
import { SearchSession } from "../src/ui/SearchSession";
import { buildSearchSourceScope } from "../src/ui/SearchSourceScope";
import type { CatalogQueryFilter } from "../src/types/catalog";

const parser = new DiaryMemoParser(async () => "test-revision");

export function searchPartition(date: string, contents: readonly string[]) {
	const sourcePath = `Daily/${date}.md`;
	const content = contents.map((memo, index) => {
		const lines = memo.split("\n");
		return `- ${String(9 + index % 12).padStart(2, "0")}:00 ${lines[0]}\n${lines.slice(1).map(line => "  " + line).join("\n")}`;
	}).join("\n");
	const observed = parser.parseRevision({ sourcePath, logicalDate: date, sourceRevision: content, content });
	return buildCatalogPartition({ inventory: { sourcePath, logicalDate: date, mtime: 1, size: content.length },
		sourceRevision: content, observations: observed.observations, parserVersion: CATALOG_PARSER_VERSION, settingsFingerprint: "search", auditedAt: 1 });
}

function searchFilter(text: string): CatalogQueryFilter {
	const parsed = parseSearchInput(text);
	assert.ok(parsed.status === "valid" || parsed.status === "empty", text);
	return { textTerms: parsed.terms, ...(parsed.date ? { searchDate: parsed.date } : {}) };
}

test("可读正文使用 Markdown 节点，排除区域保持不可跨越的边界", () => {
	assert.deepEqual(buildSearchBody("今天**完成**项目 _review_ ~~old~~ ==new== `a*b` \\* &amp;"), ["今天完成项目 review old new a*b * &"]);
	assert.deepEqual(buildSearchBody("left<!-- secret -->right"), ["left", "right"]);
	assert.deepEqual(buildSearchBody("before\n```md\nsecret #hidden [[Hidden]]\n```\nafter"), ["before", "after"]);
	assert.deepEqual(buildSearchBody("[visible](hidden-target) [[Secret|alias]] ![真实说明](photo.jpg) ![[other.png|400]]"), ["visible alias 真实说明"]);
	assert.deepEqual(buildSearchBody("字面 a*b c_d #literal 123-456 项目~复盘"), ["字面 a*b c_d #literal 123-456 项目~复盘"]);
});

test("连续文字不跨字段或排除边界；标签、链接和图片字段独立匹配", () => {
	const observation = buildCatalogObservation(searchPartition("2026-10-09", ["项目 **完成**\n\n复盘 #work [[Target|别名]] ![说明](photo.jpg)"]).observations[0]);
	assert.equal(matchesCatalogQuery(observation, searchFilter("项目 work")), false);
	assert.equal(matchesCatalogQuery(observation, searchFilter("完成 复盘")), true);
	assert.equal(matchesCatalogQuery(observation, searchFilter("work target")), false);
	assert.equal(matchesCatalogQuery(observation, searchFilter("target photo")), false);
	for (const text of ["work", "target", "photo"]) assert.equal(matchesCatalogQuery(observation, searchFilter(text)), true, text);
	assert.equal(matchesCatalogQuery(observation, { textTerms: ["target", "photo"] }), true);
	const separated = buildCatalogObservation(searchPartition("2026-10-09", ["项目<!-- erased -->复盘"]).observations[0]);
	assert.equal(matchesCatalogQuery(separated, searchFilter("项目 复盘")), false);
	assert.equal(matchesCatalogQuery(separated, searchFilter("项目复盘")), false);
	assert.equal(matchesCatalogQuery(separated, searchFilter('"项目 复盘"')), false);
});

test("双存储的 count、逐页结果和 evaluator 在来源组合及稀疏命中时完全一致", async () => {
	const name = "search-semantics-" + Date.now();
	const stores = [new InMemoryMemoCatalogStore(), new IndexedDbMemoCatalogStore(name, { factory: indexedDB, keyRange: IDBKeyRange })];
	const partitions = [
		searchPartition("2026-10-09", Array.from({ length: 120 }, (_, index) =>
				index % 17 ? "ordinary project" : `项目**完成** #Work/Child [[Target|别名]] ![真实说明](photo.jpg)\n- [ ] 稀疏复盘 ${index}`)),
		searchPartition("2025-10-09", ["项目 稀疏复盘 #Work/Child\n- [ ] old"]),
		searchPartition("2026-10-10", ["项目 稀疏复盘 #Work/Child"]),
	];
	try {
		for (const store of stores) {
			await store.open();
			for (const partition of partitions) await store.replaceFilePartition(partition);
			const session = new SearchSession();
			const source = buildSearchSourceScope({ activeNav: "things", scopeFilter: "with-image", activeTag: "Work", activeTagKey: "work", recordStatsSearchFilter: null }, new Date(2026, 9, 9));
			session.updateDraft("20261009 稀疏复盘"); session.submit();
			const filter = session.getFilter(source);
			const expected = partitions.flatMap(partition => partition.observations)
				.filter(item => matchesCatalogQuery(item, filter)).sort((a, b) => b.createdAtKey.localeCompare(a.createdAtKey) || b.observationKey.localeCompare(a.observationKey));
			assert.equal(expected.length, 8);
			const keys: string[] = [];
			let cursor: Awaited<ReturnType<typeof store.query>>["nextCursor"] = null;
			do {
				const page: Awaited<ReturnType<typeof store.query>> = await store.query({ ...filter, limit: 3, cursor });
				assert.equal(page.invalidated, false);
				keys.push(...page.items.map(item => item.observationKey));
				cursor = page.nextCursor;
			} while (cursor);
			assert.deepEqual(keys, expected.map(item => item.observationKey));
			assert.equal((await store.count(filter)).count, expected.length);
			assert.equal(new Set(keys).size, keys.length);
			const phrase = await store.query({ ...searchFilter("项目完成"), limit: 30 });
			assert.equal(phrase.items.length, 8);
			assert.equal((await store.query({ ...searchFilter("0229"), limit: 3 })).items.length, 0);
			const none = narrowCatalogQuery({ ...filter, fromDate: "2026-11-01" });
			const empty = await store.query({ ...none, limit: 3 });
			assert.equal(empty.items.length, 0);
			assert.equal(empty.metrics.observationsRead, 0);
			assert.equal((await store.count(none)).count, 0);
		}
	} finally {
		stores.forEach(store => store.close());
		await new Promise<void>((resolve, reject) => { const request = indexedDB.deleteDatabase(name); request.onsuccess = () => resolve(); request.onerror = () => reject(request.error); });
	}
});

test("coverage 限定实际日期交集，总数未知与真零分开；回顾严格排除今天和未来", async () => {
	const catalog = new MemoCatalogService(new InMemoryMemoCatalogStore());
	await catalog.open();
	const store = catalog.getStore();
	await store.replaceFilePartition(searchPartition("2026-10-09", ["项目"]));
	await store.setCoverage({ kind: "partial", coveredFromDate: "2026-10-01", pendingFileCount: 8, coveredFileCount: 1, totalFileCount: 9 });
	const reader = new CatalogReadService({ catalog });
	assert.equal((await reader.count(searchFilter("项目"))).count, null);
	assert.equal((await reader.count(searchFilter("202610 项目"))).count, 1);
	assert.equal((await reader.count(narrowCatalogQuery({ ...searchFilter("202611"), toDate: "2026-10-31" }))).count, 0);
	await store.replaceFilePartition(searchPartition("2026-09-09", ["old 项目"]));
	await store.replaceFilePartition(searchPartition("2026-11-09", ["future 项目"]));
	await store.setCoverage({ kind: "complete", coveredFromDate: null, pendingFileCount: 0, coveredFileCount: 3, totalFileCount: 3 });
	const review = buildReviewCatalogQuery(new Date(2026, 9, 9));
	assert.deepEqual((await reader.query({ ...review, ...searchFilter("项目"), limit: 10 })).items.map(item => item.observation.logicalDate), ["2026-09-09"]);
	assert.equal((await reader.count({ ...review, ...searchFilter("2026") })).count, 1);
	store.close();
});

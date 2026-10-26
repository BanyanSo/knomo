import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { DiaryMemoParser } from "../src/services/DiaryMemoParser";
import { MemoCatalogService } from "../src/services/MemoCatalogService";
import { InMemoryMemoCatalogStore } from "../src/services/MemoCatalogStore";
import { CatalogReadService, buildRecordStatsCatalogQuery } from "../src/services/CatalogReadService";
import { RecordStatsService } from "../src/services/RecordStatsService";
import type { MemoRelationOptions } from "../src/services/MemoRelationService";

async function fixture(relations?: MemoRelationOptions) {
	const store = new InMemoryMemoCatalogStore();
	const catalog = new MemoCatalogService(store);
	await catalog.open();
	const parser = new DiaryMemoParser(async bytes => createHash("sha256").update(bytes).digest("hex"));
	const reader = new CatalogReadService({ catalog, relations });
	const seed = async (path: string, text: string, date: string) => {
		const parsed = await parser.parse({ sourcePath: path, logicalDate: date, bytes: Buffer.from(text) });
		await catalog.replaceFile({ inventory: { sourcePath: path, logicalDate: date, mtime: 1, size: text.length },
			sourceRevision: parsed.sourceRevision, observations: parsed.observations, blockAnchors: parsed.blockAnchors,
			parserVersion: 14, settingsFingerprint: "test", auditedAt: 1 });
		const count = (await catalog.listFiles()).length;
		await store.setCoverage({ kind: "complete", coveredFromDate: null, coveredFileCount: count,
			totalFileCount: count, pendingFileCount: 0 });
	};
	return { store, catalog, reader, seed };
}

test("被引用统计按不同目标及目标日期计入，跨月来源、重复链接与间接后代不扩大数量", async () => {
	const { seed, reader, catalog } = await fixture();
	try {
		await seed("A.md", "- 10:00 同文 ^a\n- 10:01 同文 ^a2\n- 10:02 未被引用 ^unused\n", "2026-09-05");
		await seed("B.md", "- 11:00 B [[A#^a]] [[A#^a|重复]] [[A#^a2]] ^b\n", "2026-10-01");
		await seed("C.md", "- 12:00 C [[B#^b]] ^c\n", "2026-10-02");
		await seed("D.md", "- 12:01 D [[A#^a]]\n", "2026-10-03");
		catalog.query = async () => { throw Error("统计不能读取正文列表"); };
		catalog.readObservationSnapshot = async () => { throw Error("统计不能读取正文"); };
		const stats = new RecordStatsService();
		assert.equal(await stats.prepareFromSource("test", current => reader.buildRecordStats(async () => {}, current)), true);
		assert.deepEqual(stats.select("month", new Date(2026, 8, 5))?.referenced, { count: 2, complete: true, failed: false });
		assert.deepEqual(stats.select("month", new Date(2026, 9, 5))?.referenced, { count: 1, complete: true, failed: false });
		assert.equal(stats.select("month", new Date(2026, 8, 5))?.range.referenceMemoCount, 0);
		assert.equal(stats.select("month", new Date(2026, 9, 5))?.range.referenceMemoCount, 3);
	} finally { reader.relations.dispose(); }
});

test("被引用钻取按目标日期分页并与搜索相交，旧含引用筛选仍选择来源", async () => {
	const { reader, seed } = await fixture();
	try {
		await seed("A.md", "- 10:00 apple #keep ^a\n- 10:01 banana ^b\n- 10:02 unreferenced ^c\n", "2026-09-05");
		await seed("B.md", "- 11:00 [[A#^a]] [[A#^b]]\n", "2026-10-01");
		const filter = buildRecordStatsCatalogQuery({ type: "referenced", startDate: "2026-09-01", endDateExclusive: "2026-10-01" }).query;
		assert.equal((await reader.count(filter)).count, 2);
		const page = await reader.query({ ...filter, limit: 1 });
		assert.equal(page.items[0]?.content, "banana");
		assert.ok(page.nextCursor);
		const next = await reader.query({ ...filter, limit: 1, cursor: page.nextCursor });
		assert.equal(next.items[0]?.content, "apple #keep");
		assert.equal(next.nextCursor, null);
		assert.equal((await reader.count({ ...filter, text: "apple", tags: ["keep"] })).count, 1);
		assert.equal((await reader.query({ ...filter, text: "unreferenced", limit: 30 })).items.length, 0);
		assert.equal((await reader.count(buildRecordStatsCatalogQuery({ type: "references", startDate: "2026-09-01", endDateExclusive: "2026-10-01" }).query)).count, 0);
	} finally { reader.relations.dispose(); }
});

test("关系解析部分失败时保留已发现目标，钻取和计数不把完整 Daily 覆盖当成关系完整", async () => {
	let failing = true;
	const { reader, seed } = await fixture({ resolvePath: path => {
		if (path === "Later" && failing) throw Error("metadata unavailable");
		return { path: path + ".md" };
	} });
	try {
		await seed("A.md", "- 10:00 target ^a\n", "2026-09-05");
		await seed("B.md", "- 11:00 [[A#^a]] [[Later#^x]]\n", "2026-10-01");
		const stats = new RecordStatsService();
		await stats.prepareFromSource("test", current => reader.buildRecordStats(async () => {}, current));
		assert.deepEqual(stats.select("month", new Date(2026, 8, 5))?.referenced, { count: 1, complete: false, failed: true });
		const filter = buildRecordStatsCatalogQuery({ type: "referenced", startDate: "2026-09-01", endDateExclusive: "2026-10-01" }).query;
		assert.equal((await reader.count(filter)).count, null);
		assert.equal((await reader.query({ ...filter, limit: 30 })).status.relations?.complete, false);
		failing = false;
		reader.relations.invalidateResolution(["Later.md"]);
		assert.equal((await reader.count(filter)).count, 1);
	} finally { reader.relations.dispose(); }
});

test("metadata 单独改解析目标时计数不复用旧缓存，分页拒绝混入另一份关系", async () => {
	let target = "A.md";
	const { reader, seed } = await fixture({ resolvePath: () => ({ path: target }) });
	try {
		await seed("A.md", "- 10:00 A1 ^a\n- 10:01 A2 ^b\n", "2026-09-05");
		await seed("Other.md", "- 10:00 other ^a\n", "2026-10-05");
		await seed("B.md", "- 11:00 [[Link#^a]] [[Link#^b]]\n", "2026-10-06");
		const filter = buildRecordStatsCatalogQuery({ type: "referenced", startDate: "2026-09-01", endDateExclusive: "2026-11-01" }).query;
		assert.equal((await reader.count(filter)).count, 2);
		const first = await reader.query({ ...filter, limit: 1 });
		assert.ok(first.nextCursor);
		target = "Other.md";
		reader.relations.invalidateResolution(["Link.md"]);
		assert.equal((await reader.count(filter)).count, 1);
		const stale = await reader.query({ ...filter, limit: 1, cursor: first.nextCursor });
		assert.equal(stale.invalidated, true);
		assert.deepEqual(stale.items, []);
	} finally { reader.relations.dispose(); }
});

test("目标日期已覆盖但范围外来源仍待扫描时不发布确定的零", async () => {
	const { reader, seed, store } = await fixture();
	try {
		await seed("A.md", "- 10:00 A ^a\n", "2026-10-01");
		await store.setCoverage({ kind: "partial", coveredFromDate: "2026-10-01", coveredFileCount: 1, totalFileCount: 2, pendingFileCount: 1 });
		const filter = buildRecordStatsCatalogQuery({ type: "referenced", startDate: "2026-10-01", endDateExclusive: "2026-11-01" }).query;
		assert.equal((await reader.count(filter)).count, null);
		const page = await reader.query({ ...filter, limit: 10 });
		assert.deepEqual(page.items, []);
		assert.equal(page.status.relations?.complete, false);
	} finally { reader.relations.dispose(); }
});

test("计数或分页提交前覆盖变为部分时，已覆盖的目标日期也不能沿用旧关系总数", async () => {
	for (const feature of ["count", "query"] as const) {
		const { reader, seed, store, catalog } = await fixture();
		try {
			await seed("A.md", "- 10:00 A ^a\n", "2026-10-01"); await seed("B.md", "- 11:00 [[A#^a]]\n", "2026-10-02");
			const filter = buildRecordStatsCatalogQuery({ type: "referenced", startDate: "2026-10-01", endDateExclusive: "2026-11-01" }).query;
			const advance = () => store.setCoverage({ kind: "partial", coveredFromDate: "2026-10-01", coveredFileCount: 2, totalFileCount: 3, pendingFileCount: 1 });
			if (feature === "count") {
				const count = catalog.count.bind(catalog); catalog.count = async (...args) => { await advance(); return count(...args); };
				assert.equal((await reader.count(filter)).count, null);
			} else {
				const query = catalog.query.bind(catalog); catalog.query = async (...args) => { await advance(); return query(...args); };
				const result = await reader.query({ ...filter, limit: 30 }); assert.equal(result.invalidated, true); assert.deepEqual(result.items, []);
			}
		} finally { reader.relations.dispose(); }
	}
});

test("统计让出 UI 期间的改链或 metadata 变化不能提交旧目标数量", async () => {
	for (const change of ["daily", "metadata"] as const) {
		const { reader, seed } = await fixture();
		try {
			await seed("A.md", "- 10:00 A ^a\n", "2026-09-05");
			await seed("B.md", "- 11:00 [[A#^a]]\n", "2026-10-01");
			const stale = await reader.buildRecordStats(async () => {
				if (change === "daily") await seed("B.md", "- 11:00 no link\n", "2026-10-01");
				else reader.relations.invalidateResolution(["A.md"]);
			}, () => true);
			assert.equal(stale, null);
		} finally { reader.relations.dispose(); }
	}
});

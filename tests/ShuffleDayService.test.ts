import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as waitImmediate } from "node:timers/promises";
import type { Plugin } from "obsidian";
import { ShuffleDayService, type ShuffleDayCatalogReader } from "../src/services/ShuffleDayService";
import { PluginDataStore } from "../src/services/PluginDataStore";
import type { CatalogDailyAggregate } from "../src/types/catalog";
import type { MemoViewItem } from "../src/types/memoView";
import { formatDatePart } from "../src/utils/date";
import { extractShuffleDayHistory } from "../src/utils/pluginData";
import { CatalogDiscoveryInvalidatedError } from "../src/services/CatalogReadService";

const now = new Date(2026, 9, 5, 12);

test("生产漫游先抽非空年代段，1:1000 个日期不放大年代概率", async () => {
	const { service } = harness();
	const middle = aggregate("2026-08-01");
	const old = Array.from({ length: 1000 }, (_, i) => aggregate(formatDatePart(new Date(2020, 0, i + 1))));
	const result = await service.selectCatalogShuffleDay(reader([middle, ...old]), { now, today: now, random: () => 0.5 });
	assert.equal(result.status, "ready");
	if (result.status === "ready") assert.equal(result.selectedDate, middle.logicalDate);
});

test("完整聚合空库与全部过近使用不同空态", async () => {
	const { service } = harness();
	assert.equal((await service.selectCatalogShuffleDay(reader([]), { now, today: now })).status, "empty-no-memos");
	assert.equal((await service.selectCatalogShuffleDay(reader([aggregate("2026-10-04")]), { now, today: now })).status, "empty-not-enough-history");
});

test("选择整日加载不占用设置写队列，超过 150 条不截断", async () => {
	const { service, store } = harness();
	let release: () => void = () => {};
	const gate = new Promise<void>(resolve => { release = resolve; });
	const dayMemos = Array.from({ length: 175 }, (_, i) => ({ ...memo("2026-08-01"), id: String(i) }));
	const loading = service.selectCatalogShuffleDay(reader([aggregate("2026-08-01", 175)], async () => { await gate; return dayMemos; }), { now, today: now });
	await waitImmediate();
	let saved = false;
	const mutation = store.mutate(() => ({ nextData: { settings: { changed: true } }, result: undefined })).then(() => { saved = true; });
	await waitImmediate();
	try { assert.equal(saved, true); } finally { release(); await mutation; }
	const result = await loading;
	assert.equal(result.status, "ready");
	if (result.status === "ready") assert.equal(result.memos.length, 175);
});

test("选择不写历史，接受时才产生事件，保存失败保留内容及会话降重并在后续提交合并", async () => {
	const h = harness();
	const source = reader([aggregate("2026-08-01"), aggregate("2026-08-02")]);
	const first = await h.service.selectCatalogShuffleDay(source, { random: () => 0 });
	assert.equal(first.status, "ready");
	assert.equal(h.getSaves(), 0);
	h.setNow(new Date(2026, 9, 5, 13));
	h.failSave(true);
	await assert.rejects(h.service.acceptSelection("2026-08-01"), /save failed/);
	assert.equal(first.status, "ready");
	const next = await h.service.selectCatalogShuffleDay(source, { random: () => 0 });
	assert.equal(next.status, "ready");
	if (next.status === "ready") assert.equal(next.selectedDate, "2026-08-02");
	h.failSave(false);
	h.setNow(new Date(2026, 9, 5, 14));
	await h.service.acceptSelection("2026-08-02");
	const history = extractShuffleDayHistory(h.getData(), now);
	assert.deepEqual(history.map(event => event.date), ["2026-08-02", "2026-08-01"]);
	assert.equal(new Date(history[1].shownAt).getTime(), new Date(2026, 9, 5, 13).getTime());
});

test("历史读取失败时仍可加载，写入重新读取失败绝不覆盖设置，恢复后合并未保存事件", async () => {
	const h = harness();
	h.failRead(true);
	const result = await h.service.selectCatalogShuffleDay(reader([aggregate("2026-08-01")]), { random: () => 0 });
	assert.equal(result.status, "ready");
	if (result.status === "ready") assert.equal(result.historyUnavailable, true);
	await assert.rejects(h.service.acceptSelection("2026-08-01"), /load failed/);
	assert.equal(h.getSaves(), 0);
	assert.deepEqual(h.getData(), { settings: { initial: true } });
	h.failRead(false);
	h.setNow(new Date(2026, 9, 5, 13));
	await h.service.acceptSelection("2026-08-02");
	assert.deepEqual(extractShuffleDayHistory(h.getData(), now).map(event => event.date), ["2026-08-02", "2026-08-01"]);
});

test("两个视图接受事件与设置保存交错时在最新数据上追加，不丢失任何字段", async () => {
	let data: Record<string, unknown> = { settings: { initial: true }, legacyMigration: { completed: true } };
	let release: () => void = () => {};
	const gate = new Promise<void>(resolve => { release = resolve; });
	let saves = 0;
	const store = new PluginDataStore({ loadData: async () => structuredClone(data), saveData: async (next: Record<string, unknown>) => {
		if (++saves === 1) await gate;
		data = structuredClone(next);
	} } as Plugin);
	let clock = now;
	const firstService = new ShuffleDayService(store, () => clock);
	const secondService = new ShuffleDayService(store, () => clock);
	const first = firstService.acceptSelection("2026-08-01");
	await waitImmediate();
	const setting = store.mutate(saved => ({ nextData: { ...saved as Record<string, unknown>, settings: { changed: true } }, result: undefined }));
	clock = new Date(2026, 9, 5, 13);
	const second = secondService.acceptSelection("2026-08-02");
	clock = new Date(2026, 9, 5, 14);
	const third = firstService.acceptSelection("2026-08-03");
	release();
	await Promise.all([first, setting, second, third]);
	assert.deepEqual(data.settings, { changed: true });
	assert.deepEqual(data.legacyMigration, { completed: true });
	assert.deepEqual(extractShuffleDayHistory(data, clock).map(event => event.date), ["2026-08-03", "2026-08-02", "2026-08-01"]);
});

test("漫游版本、日期内容或覆盖失效后重新取快照，连续失效最多三次，取消停止读取", async () => {
	for (const failure of ["revision", "empty"] as const) {
		const h = harness();
		const source = reader([aggregate("2026-08-01")]);
		let snapshots = 0;
		const read = source.readDailyAggregateSnapshot;
		source.readDailyAggregateSnapshot = async signal => { snapshots++; return read(signal); };
		if (failure === "revision") source.isDiscoverySnapshotCurrent = async () => false;
		else source.listMemoViewsForDate = async () => [];
		await assert.rejects(h.service.selectCatalogShuffleDay(source), /try again later/);
		assert.equal(snapshots, 3);
		assert.equal(h.getSaves(), 0);
	}
	const h = harness();
	const source = reader([aggregate("2026-08-01")]);
	let snapshots = 0;
	const read = source.readDailyAggregateSnapshot;
	source.readDailyAggregateSnapshot = async signal => { if (++snapshots === 1) throw new CatalogDiscoveryInvalidatedError(); return read(signal); };
	assert.equal((await h.service.selectCatalogShuffleDay(source)).status, "ready");
	assert.equal(snapshots, 2);
	const abort = new AbortController();
	source.readDailyAggregateSnapshot = async signal => { abort.abort(); return read(signal); };
	let bodies = 0;
	source.listMemoViewsForDate = async date => { bodies++; return [memo(date)]; };
	await assert.rejects(h.service.selectCatalogShuffleDay(source, { signal: abort.signal }), { name: "AbortError" });
	assert.equal(bodies, 0);
});

test("未保存的会话事件有界，下一次成功只合并最近 100 条", async () => {
	const h = harness();
	h.failSave(true);
	for (let i = 0; i < 110; i++) {
		h.setNow(new Date(now.getTime() + i * 1000));
		await assert.rejects(h.service.acceptSelection("2026-08-01"), /save failed/);
	}
	h.failSave(false);
	h.setNow(new Date(now.getTime() + 110000));
	await h.service.acceptSelection("2026-08-02");
	assert.equal(extractShuffleDayHistory(h.getData(), now).length, 100);
});

function aggregate(logicalDate: string, memoCount = 1): CatalogDailyAggregate {
	return { logicalDate, memoCount, tagCount: 0, imageCount: 0, linkCount: 0, taskCount: 0, timeBuoyCount: 0,
		explicitReferenceCount: 0, explicitReferenceMemoCount: 0, explicitReferenceTargets: [], wordCount: 0,
		imageMemoCount: 0, taggedMemoCount: 0, untaggedMemoCount: memoCount, hourCounts: [], tagMemoCounts: {}, tagDisplayNames: {} };
}

function memo(date: string): MemoViewItem {
	return { id: date, createdAt: `${date}T09:00`, updatedAt: `${date}T09:00`, contentSnapshot: "same content", contentHash: "same",
		status: "active", tags: [], links: [], images: [], dailyRef: { path: `Daily/${date}.md`, heading: "Memos", lineNumberHint: 1 } };
}

function harness() {
	let data: unknown = { settings: { initial: true } };
	let clock = now;
	let failLoad = false;
	let failSave = false;
	let saves = 0;
	const store = new PluginDataStore({
		loadData: async () => { if (failLoad) throw new Error("load failed"); return structuredClone(data); },
		saveData: async (next: unknown) => { saves++; if (failSave) throw new Error("save failed"); data = structuredClone(next); },
	} as Plugin);
	return { store, service: new ShuffleDayService(store, () => clock), getData: () => data, getSaves: () => saves,
		failRead: (value: boolean) => { failLoad = value; }, failSave: (value: boolean) => { failSave = value; }, setNow: (value: Date) => { clock = value; } };
}

function reader(aggregates: CatalogDailyAggregate[], loadDate: (date: string) => Promise<MemoViewItem[]> = async date => [memo(date)]): ShuffleDayCatalogReader {
	return {
		readDailyAggregateSnapshot: async () => ({ aggregates, catalogRevision: 1, day: formatDatePart(now), coverage: {
			kind: "complete", coveredFromDate: null, pendingFileCount: 0, coveredFileCount: aggregates.length, totalFileCount: aggregates.length,
		} }),
		listMemoViewsForDate: loadDate,
		isDiscoverySnapshotCurrent: async () => true,
	};
}

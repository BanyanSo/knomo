import assert from "node:assert/strict";
import test from "node:test";
import type { IndependentTrashService } from "../src/services/IndependentTrashService";
import type { MemoCatalogService } from "../src/services/MemoCatalogService";
import type { TrashQueryResult } from "../src/types/trash";
import { ensureObsidianStub } from "./helpers/obsidianStub";

test("列表和计数共享一次读取，普通计数刷新不重读快照正文", async () => {
	const gate = deferred<TrashQueryResult>();
	let reads = 0;
	const read = await fixture(() => { reads++; return gate.promise; });
	const page = read.listDeleted(1);
	const summary = read.getDeletedSummary();
	assert.equal(reads, 1);
	gate.resolve(result(2));
	assert.equal((await page).items.length, 1);
	assert.deepEqual(await summary, { count: 2 });
	assert.deepEqual(await read.getDeletedSummary(), { count: 2 });
	assert.equal(reads, 1);
});

test("读取期间多次 Trash 变化只串行补读一次，旧数量不会回填缓存", async () => {
	const old = deferred<TrashQueryResult>();
	let reads = 0;
	const read = await fixture(() => ++reads === 1 ? old.promise : Promise.resolve(result(2)));
	const first = read.getDeletedSummary();
	read.invalidateTrash();
	read.invalidateTrash();
	const second = read.getDeletedSummary();
	assert.equal(reads, 1);
	old.resolve(result(0));
	assert.deepEqual(await Promise.all([first, second]), [{ count: 2 }, { count: 2 }]);
	assert.equal(reads, 2);
	assert.deepEqual(await read.getDeletedSummary(), { count: 2 });
	assert.equal(reads, 2);
});

test("目录切换丢弃旧读取，旧读取失败也不能覆盖新目录结果", async () => {
	await ensureObsidianStub();
	const { CatalogReadService } = await import("../src/services/CatalogReadService");
	const old = deferred<TrashQueryResult>();
	let source = mockSource(() => old.promise);
	const read = new CatalogReadService({ catalog: {} as MemoCatalogService, getTrashService: () => source });
	const pending = read.getDeletedSummary();
	source = mockSource(async () => result(1));
	old.reject(new Error("old root unavailable"));
	assert.deepEqual(await pending, { count: 1 });
});

test("损坏或暂不可读快照不冒充完整空回收站，失败可以重试", async () => {
	let reads = 0;
	const read = await fixture(async () => {
		reads++;
		if (reads === 1) throw new Error("unavailable");
		if (reads === 2) return { items: [], errors: [{ snapshotId: "s1", message: "read failed" }] };
		return result(1);
	});
	await assert.rejects(read.getDeletedSummary(), /unavailable/u);
	await assert.rejects(read.getDeletedSummary(), /read failed/u);
	assert.deepEqual(await read.getDeletedSummary(), { count: 1 });
});

test("Trash 新增、修改、删除、迁入迁出及父目录搬迁使缓存失效，Daily 事件不触发读取", async () => {
	let reads = 0;
	const read = await fixture(async () => result(++reads));
	let notifications = 0;
	const unsubscribe = read.subscribeTrashChanges(() => notifications++);
	await read.getDeletedSummary();
	for (const path of ["Daily/2026-09-09.md", "_knomo-data/trash-other/s1.json", "_knomo-data/trash/nested/s1.json"]) {
		read.handleTrashFileChange("Knomo/knomo-trash.json", path);
	}
	assert.deepEqual(await read.getDeletedSummary(), { count: 1 });
	assert.equal(notifications, 0);
	for (const [path, oldPath] of [
		["Knomo/knomo-trash.json"],
		["Knomo/knomo-trash.json"],
		["Knomo/knomo-trash.json"],
		["Other/s1.json", "Knomo/knomo-trash.json"],
		["Knomo/knomo-trash.json", "Other/s1.json"],
		["Other", "Knomo"],
	]) {
		read.handleTrashFileChange("Knomo/knomo-trash.json", path!, oldPath);
	}
	assert.equal(notifications, 6);
	assert.equal(reads, 1);
	assert.deepEqual(await read.getDeletedSummary(), { count: 2 });
	unsubscribe();
	read.invalidateTrash();
	assert.equal(notifications, 6);
});

async function fixture(query: () => Promise<TrashQueryResult>) {
	await ensureObsidianStub();
	const { CatalogReadService } = await import("../src/services/CatalogReadService");
	const source = mockSource(query);
	return new CatalogReadService({ catalog: {} as MemoCatalogService, getTrashService: () => source });
}

function mockSource(query: () => Promise<TrashQueryResult>): IndependentTrashService {
	return { query, store: { path: "Knomo/knomo-trash.json", invalidate: () => undefined } } as unknown as IndependentTrashService;
}

test("同一 Trash service 切换文件路径后不复用旧数量，保留会话实例", async () => {
	await ensureObsidianStub();
	const { CatalogReadService } = await import("../src/services/CatalogReadService");
	let path = "Old/knomo-trash.json";
	const source = { query: async () => result(path.startsWith("Old/") ? 1 : 2),
		store: { get path() { return path; }, invalidate: () => undefined } } as unknown as IndependentTrashService;
	const read = new CatalogReadService({ catalog: {} as MemoCatalogService, getTrashService: () => source });
	assert.equal((await read.getDeletedSummary()).count, 1);
	path = "New/knomo-trash.json";
	assert.equal((await read.getDeletedSummary()).count, 2);
});

function result(count: number): TrashQueryResult {
	return { items: Array.from({ length: count }, (_, index) => ({ snapshotId: `s${index}`,
		deletedAt: "2026-09-09T12:00:00Z", logicalDate: "2026-09-09", sourcePath: "Daily/2026-09-09.md",
		section: null, rawBlock: "- 12:00 same memo" })), errors: [] };
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
	return { promise, resolve, reject };
}

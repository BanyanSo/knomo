import assert from "node:assert/strict";
import test from "node:test";
import { IDBDatabase as FakeDatabase, IDBIndex as FakeIndex, IDBKeyRange, indexedDB } from "fake-indexeddb";

import { IndexedDbMemoCatalogStore } from "../src/services/IndexedDbMemoCatalogStore";
import { buildCatalogPartition } from "../src/services/MemoCatalogService";
import { FallbackMemoCatalogStore, InMemoryMemoCatalogStore } from "../src/services/MemoCatalogStore";
import { TimeBuoyPageSelection } from "../src/services/TimeBuoyQuery";
import type { CatalogFilePartition, MemoObservation } from "../src/types/catalog";

test("取消计数立即终止游标，主数据库保持可用且不激活 fallback", async t => {
	const databaseName = uniqueDatabaseName("count-cancel");
	const primary = createStore(databaseName);
	const store = new FallbackMemoCatalogStore(primary, new InMemoryMemoCatalogStore());
	const controller = new AbortController();
	const openCursor = FakeIndex.prototype.openCursor;
	let reads = 0;
	try {
		await store.open();
		const path = "Daily/2026-07-01.md";
		await store.replaceFilePartition(makePartition(path, "2026-07-01", Array.from({ length: 20 }, (_, i) =>
			makeObservation(path, "2026-07-01", i + 1, "10:30", "memo"))));
		t.mock.method(FakeIndex.prototype, "openCursor", function(this: IDBIndex, ...args: Parameters<IDBIndex["openCursor"]>) {
			const request = openCursor.apply(this, args);
			request.addEventListener("success", () => { if (++reads === 2) controller.abort(); });
			return request;
		});
		await assert.rejects(store.count({}, controller.signal), { name: "AbortError" });
		assert.equal(reads, 2);
		assert.equal(store.getLifecycle().persistent, true);
		assert.equal((await store.query({ limit: 1 })).items.length, 1);
	} finally { store.close(); await deleteDatabase(databaseName); }
});

test("浮标游标缺少错误原因时仍以 Error 拒绝查询", async t => {
	const databaseName = uniqueDatabaseName("buoy-cursor-error");
	const store = createStore(databaseName);
	const openKeyCursor = FakeIndex.prototype.openKeyCursor;
	t.mock.method(FakeIndex.prototype, "openKeyCursor", function (this: IDBIndex, ...args: Parameters<IDBIndex["openKeyCursor"]>) {
		const request = openKeyCursor.apply(this, args);
		request.addEventListener("success", event => {
			event.stopImmediatePropagation();
			request.onerror?.call(request, event);
		});
		return request;
	});
	try {
		await assert.rejects(store.queryTimeBuoys({ today: "2026-09-27", tab: "today", limit: 7 }),
			error => error instanceof Error && error.message === "Memo Catalog time buoy query failed.");
	} finally { store.close(); await deleteDatabase(databaseName); }
});

test("浮标索引解析抛出非 Error 时保留原因并拒绝查询", async t => {
	const databaseName = uniqueDatabaseName("buoy-selection-error");
	const store = createStore(databaseName);
	const path = "Daily/2026-07-01.md";
	t.mock.method(TimeBuoyPageSelection.prototype, "add", () => { throw "invalid buoy posting"; });
	try {
		await store.replaceFilePartition(makePartition(path, "2026-07-01", [
			makeObservation(path, "2026-07-01", 1, "10:30", "same", { timeBuoyDates: ["2026-09-27"] }),
		]));
		await assert.rejects(store.queryTimeBuoys({ today: "2026-09-27", tab: "today", limit: 7 }),
			error => error instanceof Error && error.message === "invalid buoy posting");
	} finally { store.close(); await deleteDatabase(databaseName); }
});

test("浮标分页保留三组排序、多日期合并、同文 occurrence 及查询边界", async () => {
	const databaseName = uniqueDatabaseName("buoy-pages");
	const stores = [createStore(databaseName), new InMemoryMemoCatalogStore()];
	const path = "Daily/2026-07-01.md", today = "2026-09-27";
	const observations = Array.from({ length: 77 }, (_, index) => makeObservation(path, "2026-07-01", index + 1,
		index % 2 ? "10:30" : "10:30:00", "same", { timeBuoyDates: index % 7 === 0 ? [] : [
			"2026-09-26", "2026-08-01", today, "2026-10-02", index % 3 === 0 ? "2026-10-01" : "2026-11-01", today,
		] }));
	try {
		for (const store of stores) {
			await store.open();
			await store.replaceFilePartition(makePartition(path, "2026-07-01", observations));
			await store.setCoverage({ kind: "complete", coveredFromDate: "2026-07-01", pendingFileCount: 0, coveredFileCount: 1, totalFileCount: 1 });
			for (const tab of ["today", "upcoming", "past"] as const) {
				const expected = (await store.query({ hasTimeBuoy: true, limit: 150 })).items.map(item => {
					const dates = [...new Set(item.timeBuoyDates.filter(date => tab === "today" ? date === today : tab === "upcoming" ? date > today : date < today))].sort();
					return { item, dates, primary: tab === "past" ? dates[dates.length - 1]! : dates[0]! };
				}).filter(item => item.dates.length).sort((a, b) => (
					(tab === "upcoming" ? a.primary.localeCompare(b.primary) : b.primary.localeCompare(a.primary))
					|| `${b.item.logicalDate}T${b.item.time}`.localeCompare(`${a.item.logicalDate}T${a.item.time}`)
					|| b.item.observationKey.localeCompare(a.item.observationKey)));
				const keys: string[] = [];
				let page = await store.queryTimeBuoys({ today, tab, limit: 7 });
				const first = page;
				for (;;) {
					assert.equal(page.invalidated, false);
					assert.equal(page.metrics.observationsRead, page.items.length);
					assert.ok(page.items.length <= 7);
					keys.push(...page.items.map(item => item.observationKey));
					if (page.nextCursor === null) break;
					page = await store.queryTimeBuoys({ today, tab, limit: 7, cursor: page.nextCursor });
				}
				assert.deepEqual(keys, expected.map(({ item }) => item.observationKey));
				assert.equal(new Set(keys).size, keys.length);
				assert.equal((await store.queryTimeBuoys({ today: "2026-09-28", tab, limit: 7, cursor: first.nextCursor })).invalidated, true);
				assert.equal((await store.queryTimeBuoys({ today, tab: tab === "past" ? "today" : "past", limit: 7, cursor: first.nextCursor })).invalidated, true);
			}
			const first = await store.queryTimeBuoys({ today, tab: "today", limit: 7 });
			await store.deleteFilePartition(path);
			assert.equal((await store.queryTimeBuoys({ today, tab: "today", limit: 7, cursor: first.nextCursor })).invalidated, true);
			assert.equal((await store.queryTimeBuoys({ today, tab: "today", limit: 7 })).items.length, 0);
		}
	} finally { for (const store of stores) store.close(); await deleteDatabase(databaseName); }
});

test("旧浮标缓存升级后重建，分钟改为零秒时更新分页排序字段", async () => {
	const name = uniqueDatabaseName("buoy-upgrade");
	const old = createStore(name, { version: 2 });
	const path = "Daily/2026-07-01.md";
	const memo = makeObservation(path, "2026-07-01", 1, "10:30", "same", { timeBuoyDates: ["2026-09-27"] });
	await old.open();
	await old.replaceFilePartition(makePartition(path, "2026-07-01", [memo]));
	old.close();
	const store = createStore(name);
	try {
		await store.open();
		assert.deepEqual(await store.listFiles(), []);
		await store.replaceFilePartition(makePartition(path, "2026-07-01", [memo]));
		const changed = makePartition(path, "2026-07-01", [{ ...memo, time: "10:30:00" }]);
		changed.file.sourceRevision = "new-revision";
		await store.replaceFilePartition(changed);
		assert.equal((await store.queryTimeBuoys({ today: "2026-09-27", tab: "today", limit: 1 })).items[0]?.time, "10:30:00");
	} finally { store.close(); await deleteDatabase(name); }
});

test("完全同时间的跨文件浮标保留各 Store 原来的稳定并列顺序", async () => {
	const name = uniqueDatabaseName("buoy-ties");
	const stores = [createStore(name), new InMemoryMemoCatalogStore()];
	try {
		for (const store of stores) {
			await store.open();
			for (const path of ["Daily/a.md", "Daily/A.md", "日记/一.md", "日记/二.md"]) {
				await store.replaceFilePartition(makePartition(path, "2026-09-27", [
					makeObservation(path, "2026-09-27", 1, "09:00", "same", { timeBuoyDates: ["2026-09-27"] }),
				]));
			}
			const expected = (await store.query({ hasTimeBuoy: true, limit: 30 })).items.map(item => item.observationKey);
			const keys: string[] = [];
			let page = await store.queryTimeBuoys({ today: "2026-09-27", tab: "today", limit: 1 });
			for (;;) {
				keys.push(...page.items.map(item => item.observationKey));
				if (!page.nextCursor) break;
				page = await store.queryTimeBuoys({ today: "2026-09-27", tab: "today", limit: 1, cursor: page.nextCursor });
			}
			assert.deepEqual(keys, expected);
		}
	} finally { stores.forEach(store => store.close()); await deleteDatabase(name); }
});

test("混排搜索在 IndexedDB 与内存中保持候选、计数和分页一致", async () => {
	const databaseName = uniqueDatabaseName("mixed-search");
	const indexed = createStore(databaseName);
	const memory = new InMemoryMemoCatalogStore();
	await indexed.open();
	await memory.open();
	try {
		const path = "Journal/2026-08-09.md";
		const contents = ["中文ABC项目2026", "中文123项目", "中文_项目", "ABC中文项目", "无关", "中文ABC项目2026"];
		const partition = makePartition(path, "2026-08-09", contents.map((content, index) =>
			makeObservation(path, "2026-08-09", index + 1, "09:00", content, { tags: index % 2 === 0 ? ["project"] : [] })));
		await indexed.replaceFilePartition(partition);
		await memory.replaceFilePartition(partition);
		for (const text of ["中", "文", "中文", "项", "项目", "ABC", "ab", "2026", "文123", "文_", "_项", "中文ABC项目2026"]) {
			for (const tags of [undefined, ["project"], ["absent"]]) {
				const filter = { text, tags };
				const expected = await memory.query({ ...filter, limit: 50 });
				const keys: string[] = [];
				let page = await indexed.query({ ...filter, limit: 1 });
				for (;;) {
					keys.push(...page.items.map(item => item.observationKey));
					if (page.nextCursor === null) break;
					page = await indexed.query({ ...filter, limit: 1, cursor: page.nextCursor });
				}
				assert.deepEqual(keys, expected.items.map(item => item.observationKey), JSON.stringify(filter));
				assert.equal((await indexed.count(filter)).count, (await memory.count(filter)).count, JSON.stringify(filter));
				assert.equal(keys.length, (await indexed.count(filter)).count);
			}
		}
	} finally { indexed.close(); memory.close(); await deleteDatabase(databaseName); }
});

test("Things 稀疏命中分页与组合计数保留同文 occurrence", async () => {
	const databaseName = uniqueDatabaseName("things");
	const store = createStore(databaseName);
	await store.open();
	try {
		const sourcePath = "Journal/2020-01-01.md";
		const observations = Array.from({ length: 45 }, (_, index) => makeObservation(sourcePath, "2020-01-01", index + 1, "09:00", "release same", {
			contentHash: "same", tags: ["project"],
			tasks: index % 10 === 0 ? [{ taskIndex: 0, lineOffset: 0, marker: index === 0 ? " " : "x", text: "release" }] : [],
		}));
		await store.replaceFilePartition(makePartition(sourcePath, "2020-01-01", observations));
		await store.setCoverage({ kind: "complete", coveredFromDate: "2020-01-01", pendingFileCount: 0, coveredFileCount: 1, totalFileCount: 1 });
		const filter = { hasTask: true, tags: ["project"], text: "release", fromDate: "2020-01-01", toDate: "2020-01-31" };
		assert.equal((await store.count(filter)).count, 5);
		let page = await store.query({ ...filter, limit: 2 });
		const lines = page.items.map(item => item.startLine);
		while (page.nextCursor !== null) {
			page = await store.query({ ...filter, limit: 2, cursor: page.nextCursor });
			lines.push(...page.items.map(item => item.startLine));
		}
		assert.equal(lines.length, 5);
		assert.equal(new Set(lines).size, 5);
		assert.equal((await store.count({ ...filter, tags: ["absent"] })).count, 0);
	} finally { store.close(); await deleteDatabase(databaseName); }
});

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
		const allBatches = await store.listFileRevisionBatches();
		assert.deepEqual(allBatches.map((batch) => ({
			path: batch.file.sourcePath,
			contents: batch.observations.map((item) => item.content),
			catalogRevision: batch.catalogRevision,
		})), [
			{
				path: "Journal/2026-08-08.md",
				contents: ["older plain"],
				catalogRevision: firstPage.catalogRevision,
			},
			{
				path: "Journal/2026-08-09.md",
				contents: ["中文索引 alpha", "newest beta"],
				catalogRevision: firstPage.catalogRevision,
			},
		]);

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

test("IndexedDB 独立计数返回完整筛选结果而不受分页限制", async () => {
	const databaseName = uniqueDatabaseName("query-count");
	const store = createStore(databaseName);
	await store.open();
	try {
		await store.replaceFilePartition(makePartition("Journal/2026-08-09.md", "2026-08-09", Array.from(
			{ length: 90 },
			(_, index) => makeObservation(
				"Journal/2026-08-09.md",
				"2026-08-09",
				index + 1,
				`${String(8 + Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}`,
				`project memo ${index + 1}`,
				{ tags: [index % 2 === 0 ? "project" : "project/knomo"] },
			),
		)));
		await store.setCoverage({
			kind: "complete",
			coveredFromDate: "2026-08-09",
			pendingFileCount: 0,
			coveredFileCount: 1,
			totalFileCount: 1,
		});

		const page = await store.query({ limit: 50, tags: ["project"] });
		const count = await store.count({ tags: ["project"] });

		assert.equal(page.items.length, 50);
		assert.notEqual(page.nextCursor, null);
		assert.equal(count.count, 90);
		assert.equal(count.catalogRevision, page.catalogRevision);
		assert.equal(count.coverage.kind, "complete");
		assert.equal((await store.count({ text: "project memo" })).count, 90);
	} finally {
		store.close();
		await deleteDatabase(databaseName);
	}
});

test("IndexedDB clear 原子保留指定服务元数据且重开后仍可读取", async () => {
	const databaseName = uniqueDatabaseName("clear-preserved-meta");
	const store = createStore(databaseName);
	const legacyCompletion = { sourceId: "legacy-index", sourceRevision: "legacy-revision" };
	const monthlyCheckpoint = { version: 1, pending: ["2026-08"], updatedAt: 123 };
	await store.open();
	try {
		await store.replaceFilePartition(makePartition("Journal/2026-08-09.md", "2026-08-09", [
			makeObservation("Journal/2026-08-09.md", "2026-08-09", 1, "09:00", "before rebuild"),
		]));
		await store.setMeta("legacyMigrationCompletion", legacyCompletion);
		await store.setMeta("monthlyProjectionCheckpoint", monthlyCheckpoint);
		await store.setMeta("catalog-derived-sentinel", { stale: true });

		await store.clear(["legacyMigrationCompletion", "monthlyProjectionCheckpoint"]);

		assert.deepEqual(await store.listFiles(), []);
		assert.deepEqual(await store.getMeta("legacyMigrationCompletion"), legacyCompletion);
		assert.deepEqual(await store.getMeta("monthlyProjectionCheckpoint"), monthlyCheckpoint);
		assert.equal(await store.getMeta("catalog-derived-sentinel"), null);
		store.close();

		const reopened = createStore(databaseName);
		await reopened.open();
		try {
			assert.deepEqual(await reopened.getMeta("legacyMigrationCompletion"), legacyCompletion);
			assert.deepEqual(await reopened.getMeta("monthlyProjectionCheckpoint"), monthlyCheckpoint);
		} finally {
			reopened.close();
		}
	} finally {
		store.close();
		await deleteDatabase(databaseName);
	}
});

test("IndexedDB 在一次扫描进度提交中保存 coverage、checkpoint 与失败路径", async () => {
	const databaseName = uniqueDatabaseName("scan-progress");
	const store = createStore(databaseName);
	await store.open();
	try {
		const coverage = {
			kind: "rebuilding" as const,
			coveredFromDate: "2026-08-09",
			pendingFileCount: 1,
			coveredFileCount: 1,
			totalFileCount: 2,
		};
		const checkpoint = { pendingPaths: ["Journal/2026-08-08.md"], updatedAt: 123 };
		const failures = [{ sourcePath: "Journal/2026-08-07.md", message: "read failed" }];

		await store.saveScanProgress(coverage, [
			{ key: "catalogCheckpoint", value: checkpoint },
			{ key: "catalogFailedPaths", value: failures },
		]);

		assert.deepEqual(await store.getCoverage(), coverage);
		assert.deepEqual(await store.getMeta("catalogCheckpoint"), checkpoint);
		assert.deepEqual(await store.getMeta("catalogFailedPaths"), failures);
		assert.equal(store.getLifecycle().state, "rebuilding");
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

	const newer = await openRawDatabase(databaseName, 4, () => undefined);
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
		occurrenceIndex: 0,
		occurrenceCount: 1,
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

test("升级回调抛出非 Error 时保留原因并拒绝打开", async () => {
	const databaseName = uniqueDatabaseName("upgrade-non-error");
	const store = createStore(databaseName, { beforeUpgrade: () => { throw "upgrade failure"; } });
	try {
		await assert.rejects(store.open(), error => error instanceof Error && error.message === "upgrade failure");
	} finally { store.close(); await deleteDatabase(databaseName); }
});
test("P3 内存与 IndexedDB 聚合快照绑定同一 revision 和 coverage，不读取正文", async t => {
	const databaseName = uniqueDatabaseName("aggregate-snapshot");
	const stores = [new InMemoryMemoCatalogStore(), createStore(databaseName)];
	const path = "Daily/2026-09-01.md", date = "2026-09-01";
	const coverage = { kind: "complete" as const, coveredFromDate: date, pendingFileCount: 0, coveredFileCount: 1, totalFileCount: 1 };
	try {
		for (const store of stores) {
			await store.open();
			await store.replaceFilePartition(makePartition(path, date, [makeObservation(path, date, 1, "10:00", "old", { tags: ["#Old"] })]));
			await store.setCoverage(coverage);
			t.mock.method(store, "query", () => { throw new Error("No body query"); });
			t.mock.method(store, "count", () => { throw new Error("No count probe"); });
			const before = await store.getCatalogRevision();
			const pending = store.readAggregateSnapshot();
			await store.replaceFilePartition(makePartition(path, date, [makeObservation(path, date, 1, "10:01", "new"), makeObservation(path, date, 2, "10:02", "new2")]));
			await store.setCoverage({ ...coverage, kind: "partial", pendingFileCount: 1 });
			const snapshot = await pending;
			assert.equal(snapshot.catalogRevision, before);
			assert.deepEqual(snapshot.coverage, coverage);
			assert.equal(snapshot.aggregates[0]!.memoCount, 1);
			assert.equal(snapshot.invalidated, false);
			snapshot.aggregates[0]!.tagMemoCounts.old = 999;
			const next = await store.readAggregateSnapshot();
			assert.equal(next.aggregates[0]!.memoCount, 2);
			assert.equal(next.coverage.kind, "partial");
			assert.ok(next.catalogRevision > before);
		}
	} finally { stores.forEach(store => store.close()); await deleteDatabase(databaseName); }
});

test("P3 IndexedDB 只用 aggregates/meta 同一事务，关闭或 versionchange 使快照失效", async t => {
	for (const action of ["close", "versionchange"] as const) {
		const name = uniqueDatabaseName(action);
		const store = createStore(name);
		await store.open();
		const transaction = FakeDatabase.prototype.transaction;
		const transactions: string[][] = [];
		const mock = t.mock.method(FakeDatabase.prototype, "transaction", function (this: IDBDatabase, ...args: Parameters<IDBDatabase["transaction"]>) {
			const result = transaction.apply(this, args);
			const names = typeof args[0] === "string" ? [args[0]] : [...args[0]];
			transactions.push(names);
			queueMicrotask(() => {
				if (action === "close") store.close();
				else this.onversionchange?.call(this, { target: this } as unknown as IDBVersionChangeEvent);
			});
			return result;
		});
		try {
			const snapshot = await store.readAggregateSnapshot();
			assert.deepEqual(transactions, [["aggregates", "meta"]]);
			assert.equal(snapshot.invalidated, true);
		} finally { mock.mock.restore(); store.close(); await deleteDatabase(name); }
	}
});

test("P3 内存快照返回前关闭再打开也失效", async () => {
	const store = new InMemoryMemoCatalogStore();
	const pending = store.readAggregateSnapshot();
	store.close(); await store.open();
	assert.equal((await pending).invalidated, true);
});

test("P3 fallback 固定来源，切换及关闭重开不提交旧快照", async t => {
	for (const action of ["switch", "close"] as const) {
		const primary = new InMemoryMemoCatalogStore(), fallback = new InMemoryMemoCatalogStore();
		const store = new FallbackMemoCatalogStore(primary, fallback);
		await store.open();
		let release!: () => void;
		const gate = new Promise<void>(resolve => { release = resolve; });
		const read = primary.readAggregateSnapshot.bind(primary);
		t.mock.method(primary, "readAggregateSnapshot", async () => { const snapshot = await read(); await gate; return snapshot; });
		const pending = store.readAggregateSnapshot();
		if (action === "switch") {
			t.mock.method(primary, "query", async () => { throw new Error("primary unavailable"); });
			await store.query({ limit: 1 });
		} else { store.close(); await store.open(); }
		release();
		assert.equal((await pending).invalidated, true);
		const next = await store.readAggregateSnapshot();
		assert.equal(next.invalidated, false);
		store.close();
	}
});

test("P3 聚合读取失败切换 fallback，后续请求重新读取完整快照", async t => {
	const primary = new InMemoryMemoCatalogStore(), fallback = new InMemoryMemoCatalogStore();
	const store = new FallbackMemoCatalogStore(primary, fallback);
	await store.open();
	t.mock.method(primary, "readAggregateSnapshot", async () => { throw new Error("snapshot failure"); });
	await assert.rejects(store.readAggregateSnapshot(), /snapshot failure/);
	assert.equal(store.isUsingFallback, true);
	const next = await store.readAggregateSnapshot();
	assert.equal(next.invalidated, false);
	assert.equal(next.lifecycle.persistent, false);
	assert.equal(next.coverage.kind, "partial");
	store.close();
});

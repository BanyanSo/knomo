import assert from "node:assert/strict";
import test from "node:test";
import type { App } from "obsidian";

import type { MemoObservation } from "../src/types/catalog";
import { toTrashMemoItem } from "../src/types/memoView";
import type { MarkdownMutationService } from "../src/types/memoOperations";

import { ensureObsidianStub } from "./helpers/obsidianStub";

test("生产 Trash 接线保留原句柄，snapshotId 寻址；恢复清理失败不误报成功", async () => {
	await ensureObsidianStub();
	const { MemoCommandService } = await import("../src/services/MemoCommandService");
	const { MemoCatalogService } = await import("../src/services/MemoCatalogService");
	const { InMemoryMemoCatalogStore } = await import("../src/services/MemoCatalogStore");
	const store = new InMemoryMemoCatalogStore();
	const catalog = new MemoCatalogService(store);
	await catalog.open();
	const observation = makeObservation("Daily/2026-08-22.md", "2026-08-22", 1, "same memo");
	await seedCatalog(catalog, store, observation);
	const calls: unknown[] = [];
	let pending = true;
	const trash = {
		store: { query: async () => ({ items: ["s1", "s2"].map((snapshotId) => ({ snapshotId, deletedAt: "2026-08-22T12:00:00Z", sourcePath: observation.sourcePath,
			logicalDate: "2026-08-22", section: "## Memos", rawBlock: "- 12:34 same memo" })), errors: [] }) },
		delete: async (handle: unknown) => { calls.push(handle); return { state: "deleted", catalogUpdatePending: false }; },
		restore: async (id: string) => { calls.push(id); return { state: pending ? "restored_cleanup_pending" : "restored", observation, catalogUpdatePending: false }; },
		purge: async (snapshot: unknown) => { calls.push(snapshot); },
		clear: async () => { calls.push("clear"); },
	} as unknown as import("../src/services/IndependentTrashService").IndependentTrashService;
	const command = new MemoCommandService({} as App, catalog, { ...makeCommandOptions(), getTrashService: () => trash }, {} as MarkdownMutationService);
	const read = command.getReadService();
	const item = (await read.query({ limit: 10 })).items[0]!;
	await command.delete(item);
	assert.strictEqual(calls[0], item.observationHandle);
	const deleted = { items: (await trash.store.query()).items.map(toTrashMemoItem) };
	assert.deepEqual(deleted.items.map((memo) => memo.snapshotId), ["s1", "s2"]);
	assert.equal(deleted.items[0]!.createdAt, "2026-08-22T12:34");
	const pendingResult = await command.restore(deleted.items[0]!);
	assert.equal(pendingResult.status, "saved");
	assert.equal("cleanupPending" in pendingResult && pendingResult.cleanupPending, true);
	pending = false;
	assert.equal((await command.restore(deleted.items[0]!)).status, "saved");
	await command.purge(deleted.items[1]!);
	await command.clearTrash();
	assert.deepEqual(calls.slice(1), ["s1", "s1", (await trash.store.query()).items[1], "clear"]);
});

test("普通命令不访问 Identity，并将最初 observation handle 原样交给写入网关", async () => {
	await ensureObsidianStub();
	const { TFile } = await import("obsidian");
	const { MemoCommandService } = await import("../src/services/MemoCommandService");
	const { MemoCatalogService } = await import("../src/services/MemoCatalogService");
	const { InMemoryMemoCatalogStore } = await import("../src/services/MemoCatalogStore");
	const store = new InMemoryMemoCatalogStore();
	const catalog = new MemoCatalogService(store);
	await catalog.open();
	const observation = makeObservation("Daily/2026-08-22.md", "2026-08-22", 1, "same memo");
	await seedCatalog(catalog, store, observation);
	const file = Object.assign(new TFile(), { path: observation.sourcePath });
	const app = { vault: { getAbstractFileByPath: () => file }, fileManager: {
		generateMarkdownLink: () => "[[Daily/2026-08-22#^block]]",
	}, loadLocalStorage: () => null, saveLocalStorage: () => undefined } as unknown as App;
	const handles: unknown[] = [];
	const mutate = async (input: { observation: unknown }) => { handles.push(input.observation); return mutationResult(observation); };
	const mutations = { create: async () => mutationResult(observation), edit: mutate,
		toggleTask: mutate, createBlockReference: async (input: { observation: unknown }) => ({ ...await mutate(input), blockId: "block" }),
	} as unknown as MarkdownMutationService;
	const service = new MemoCommandService(app, catalog, { ...makeCommandOptions(), now: () => new Date("2026-09-08T12:00:00Z") }, mutations);
	const item = (await service.getReadService().query({ limit: 10 })).items[0]!;
	assert.equal((await service.create("created")).status, "saved");
	for (const result of [await service.edit(item, "edited"), await service.toggleTask(item, 0, true)]) {
		assert.equal(result.status, "saved");
	}
	assert.equal((await service.createReferenceText(item)).text, "[[Daily/2026-08-22#^block|20260822-1234]]");
	const secondPrecisionItem = {
		...item,
		observation: { ...item.observation, time: "12:34:56" },
	};
	assert.equal((await service.createReferenceText(secondPrecisionItem)).text,
		"[[Daily/2026-08-22#^block|20260822-123456]]");
	assert.equal(handles.length, 4);
	for (const handle of handles) assert.strictEqual(handle, item.observationHandle);
	await service.recordReview(item);
	assert.equal((await service.getReadService().getRandomReunionItems(1)).length, 1);
});

test("create 只提交 Daily 和 Catalog，不执行 intent 或 claim", async () => {
	await ensureObsidianStub();
	const { MemoCommandService } = await import("../src/services/MemoCommandService");
	const { MemoCatalogService } = await import("../src/services/MemoCatalogService");
	const { InMemoryMemoCatalogStore } = await import("../src/services/MemoCatalogStore");
	const events: string[] = [];
	const store = new InMemoryMemoCatalogStore();
	const catalog = new MemoCatalogService(store);
	await catalog.open();
	const observation = makeObservation("Daily/2026-08-22.md", "2026-08-22", 1, "created memo");
	const markdownMutations = {
		create: async () => {
			events.push("daily");
			await seedCatalog(catalog, store, observation);
			return mutationResult(observation);
		},
	} as unknown as MarkdownMutationService;
	const service = new MemoCommandService(
		{} as App,
		catalog,
		makeCommandOptions(),
		markdownMutations,
	);

	const result = await service.create(observation.content);

	assert.deepEqual(events, ["daily"]);
	assert.equal(result.status, "saved");
	assert.equal(result.localRefreshPending, false);

	events.length = 0;
	const failingMarkdown = {
		create: async () => {
			events.push("daily");
			throw new Error("Daily write failed");
		},
	} as unknown as MarkdownMutationService;
	const failingService = new MemoCommandService(
		{} as App,
		catalog,
		makeCommandOptions(),
		failingMarkdown,
	);

	await assert.rejects(() => failingService.create("will fail"), /Daily write failed/u);
	assert.deepEqual(events, ["daily"]);
});

test("阶段化 create 在 Daily 提交后先完成 committed，只等待 Catalog", async () => {
	await ensureObsidianStub();
	const { MemoCommandService } = await import("../src/services/MemoCommandService");
	const { MemoCatalogService } = await import("../src/services/MemoCatalogService");
	const { InMemoryMemoCatalogStore } = await import("../src/services/MemoCatalogStore");
	const events: string[] = [];
	const catalogGate = createDeferred<void>();
	const store = new InMemoryMemoCatalogStore();
	const catalog = new MemoCatalogService(store);
	await catalog.open();
	const observation = makeObservation("Daily/2026-08-22.md", "2026-08-22", 1, "created memo");
	const markdownMutations = {
		create: async (input: { onDailyCommitted?: () => void }) => {
			events.push("daily");
			input.onDailyCommitted?.();
			await catalogGate.promise;
			await seedCatalog(catalog, store, observation);
			return mutationResult(observation);
		},
	} as unknown as MarkdownMutationService;
	const service = new MemoCommandService(
		{} as App,
		catalog,
		makeCommandOptions(),
		markdownMutations,
	);

	const operation = service.startCreate(observation.content);
	let settled = false;
	void operation.settled.then(() => { settled = true; });
	await operation.dailyCommitted;

	assert.deepEqual(events, ["daily"]);
	assert.equal(settled, false);
	catalogGate.resolve(undefined);
	await operation.settled;
	assert.deepEqual(events, ["daily"]);
});

test("create、edit、task、reference 和 restore 按完整句柄定点接续，不分页回查大 Daily", async t => {
	await ensureObsidianStub();
	const { TFile } = await import("obsidian");
	const { MemoCommandService } = await import("../src/services/MemoCommandService");
	const { MemoCatalogService } = await import("../src/services/MemoCatalogService");
	const { InMemoryMemoCatalogStore } = await import("../src/services/MemoCatalogStore");
	const store = new InMemoryMemoCatalogStore();
	const catalog = new MemoCatalogService(store);
	await catalog.open();
	const observations = Array.from({ length: 451 }, (_, index) => makeObservation("Daily/2026-08-22.md", "2026-08-22", index + 1, "same memo"));
	const observation = observations[0]!;
	await catalog.replaceFile({ inventory: { sourcePath: observation.sourcePath, logicalDate: observation.logicalDate, mtime: 1, size: 451 },
		sourceRevision: observation.sourceRevision, observations, parserVersion: 1, settingsFingerprint: "settings-1", auditedAt: 1 });
	await store.setCoverage({ kind: "complete", coveredFromDate: observation.logicalDate, pendingFileCount: 0, coveredFileCount: 1, totalFileCount: 1 });
	const file = Object.assign(new TFile(), { path: observation.sourcePath });
	const app = { vault: { getAbstractFileByPath: () => file }, fileManager: { generateMarkdownLink: () => "[[Daily/2026-08-22#^block]]" } } as unknown as App;
	let writes = 0, lookups = 0, queries = 0;
	const mutate = async () => { writes++; return mutationResult(observation); };
	const service = new MemoCommandService(app, catalog, { ...makeCommandOptions(), getTrashService: () => ({
		restore: async () => { writes++; return { state: "restored", observation, catalogUpdatePending: false }; },
	} as unknown as import("../src/services/IndependentTrashService").IndependentTrashService) }, {
		create: mutate, edit: mutate, toggleTask: mutate, createBlockReference: async () => ({ ...await mutate(), blockId: "block" }),
	} as unknown as MarkdownMutationService);
	const read = service.getReadService();
	const item = (await read.readMemoItems([observation]))[0]!;
	const readSnapshot = catalog.readObservationSnapshot.bind(catalog);
	t.mock.method(catalog, "readObservationSnapshot", async (keys: readonly string[]) => { lookups += keys.length; return readSnapshot(keys); });
	t.mock.method(read, "query", async () => { queries++; throw new Error("Save settle must not query pages."); });
	for (const result of [await service.create("created"), await service.edit(item, "edited"), await service.toggleTask(item, 0, true),
		await service.restore(toTrashMemoItem({ snapshotId: "restore", deletedAt: "2026-08-22T12:00:00Z", sourcePath: observation.sourcePath,
			logicalDate: observation.logicalDate, section: "## Memos", rawBlock: "- 12:34 same memo" }))]) {
		assert.equal(result.status, "saved");
		assert.equal(result.localRefreshPending, false);
		assert.deepEqual(result.memo?.observationHandle, item.observationHandle);
	}
	assert.equal((await service.createReferenceText(item)).localRefreshPending, false);
	assert.equal(queries, 0);
	assert.equal(lookups, 5, "定位读取量与 Daily Memo 数量无关");
	assert.equal(writes, 5);
});

test("已提交 Daily 的定点接续拒绝缺失或不匹配句柄，读取失败仅提示本地待刷新", async t => {
	await ensureObsidianStub();
	const { MemoCommandService } = await import("../src/services/MemoCommandService");
	const { MemoCatalogService } = await import("../src/services/MemoCatalogService");
	const { InMemoryMemoCatalogStore } = await import("../src/services/MemoCatalogStore");
	for (const mismatch of ["sourcePath", "sourceRevision", "startLine", "endLine", "rawBlockHash", "unavailable"] as const) await t.test(mismatch, async t => {
		const store = new InMemoryMemoCatalogStore(), catalog = new MemoCatalogService(store);
		await catalog.open();
		const observation = makeObservation("Daily/2026-08-22.md", "2026-08-22", 1, "saved memo");
		await seedCatalog(catalog, store, observation);
		const returned = { ...observation };
		if (mismatch === "sourcePath") returned.sourcePath = "Daily/missing.md";
		if (mismatch === "sourceRevision") returned.sourceRevision = "b".repeat(64);
		if (mismatch === "startLine") returned.startLine++;
		if (mismatch === "endLine") returned.endLine++;
		if (mismatch === "rawBlockHash") returned.rawBlockHash = "different";
		let writes = 0, queries = 0;
		const service = new MemoCommandService({} as App, catalog, makeCommandOptions(), {
			create: async (input: { onDailyCommitted?: () => void }) => { writes++; input.onDailyCommitted?.(); return mutationResult(returned); },
		} as unknown as MarkdownMutationService);
		t.mock.method(service.getReadService(), "query", async () => { queries++; throw new Error("No page fallback."); });
		if (mismatch === "unavailable") t.mock.method(catalog, "readObservationSnapshot", async () => { throw new Error("Catalog unavailable."); });
		const operation = service.startCreate("saved memo");
		await operation.dailyCommitted;
		const result = await operation.settled;
		assert.equal(result.status, "saved");
		assert.equal(result.localRefreshPending, true);
		assert.equal(result.memo, null);
		assert.equal(writes, 1, "读取失败不能再次写入 Daily");
		assert.equal(queries, 0, "不能以全文件查询重新绑定 occurrence");
	});
});

function makeCommandOptions(): import("../src/services/MemoCommandService").MemoCommandServiceOptions {
	return {
		getDailyPathForDate: async (date) => `Daily/${date}.md`,
		refreshCatalogPaths: async () => undefined,
		refreshLocalCatalog: async () => ({
			scannedFiles: 0,
			created: 0,
			updated: 0,
			deleted: 0,
			skipped: 0,
			failed: 0,
			errors: [],
		}),
		getMemoTimeFormat: () => "HH:mm",
		rebuildLocalCatalog: async () => undefined,
		now: () => new Date("2026-08-22T12:34:56.000Z"),
	};
}

async function seedCatalog(
	catalog: import("../src/services/MemoCatalogService").MemoCatalogService,
	store: import("../src/services/MemoCatalogStore").MemoCatalogStore,
	observation: MemoObservation,
): Promise<void> {
	await catalog.replaceFile({
		inventory: {
			sourcePath: observation.sourcePath,
			logicalDate: observation.logicalDate,
			mtime: 1,
			size: 1,
		},
		sourceRevision: observation.sourceRevision,
		observations: [observation],
		parserVersion: 1,
		settingsFingerprint: "settings-1",
		auditedAt: 1,
	});
	await store.setCoverage({
		kind: "complete",
		coveredFromDate: observation.logicalDate,
		pendingFileCount: 0,
		coveredFileCount: 1,
		totalFileCount: 1,
	});
}

function makeObservation(sourcePath: string, logicalDate: string, startLine: number, content: string): MemoObservation {
	return {
		occurrenceIndex: 0,
		occurrenceCount: 1,
		sourcePath,
		sourceRevision: "a".repeat(64),
		rawBlockHash: "raw-1",
		logicalDate,
		section: "Memos",
		startLine,
		endLine: startLine,
		time: "12:34",
		content,
		contentHash: "fnv1a-11111111",
		existingBlockId: null,
		tags: [],
		links: [],
		images: [],
		tasks: [],
		timeBuoyDates: [],
	};
}

function mutationResult(observation: MemoObservation | null) {
	return {
		status: "committed" as const,
		observation,
		catalogUpdatePending: false,
	};
}

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolvePromise: (value: T) => void = () => undefined;
	const promise = new Promise<T>((resolve) => {
		resolvePromise = resolve;
	});
	return { promise, resolve: resolvePromise };
}


test("编辑器已更新但落盘未确认时，最终成功不能覆盖阶段拒绝并误清理草稿", async () => {
	await ensureObsidianStub();
	const { MemoCommandService } = await import("../src/services/MemoCommandService");
	const { MemoCatalogService } = await import("../src/services/MemoCatalogService");
	const { InMemoryMemoCatalogStore } = await import("../src/services/MemoCatalogStore");
	const store = new InMemoryMemoCatalogStore(); const catalog = new MemoCatalogService(store);
	await catalog.open();
	const observation = makeObservation("Daily/2026-08-22.md", "2026-08-22", 1, "created memo");
	const service = new MemoCommandService({} as App, catalog, makeCommandOptions(), {
		create: async (input: { onDailyCommitted?: (confirmed?: boolean) => void }) => {
			input.onDailyCommitted?.(false);
			await seedCatalog(catalog, store, observation);
			return mutationResult(observation);
		},
	} as unknown as MarkdownMutationService);
	const operation = service.startCreate(observation.content);
	await assert.rejects(operation.dailyCommitted, /not confirmed/);
	assert.equal((await operation.settled).status, "saved");
	await assert.rejects(operation.dailyCommitted, /not confirmed/);
});

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { setImmediate as waitImmediate, setTimeout as waitTimer } from "node:timers/promises";
import test from "node:test";
import type { App } from "obsidian";

import type { CatalogRevisionTransition } from "../src/services/CatalogShadowCoordinator";

import { ensureObsidianStub } from "./helpers/obsidianStub";
test("Catalog 扫描 off switch 不注册事件、不读取 Daily", async () => {
	await ensureObsidianStub();
	const { CatalogShadowCoordinator } = await import("../src/services/CatalogShadowCoordinator");
	const { DiaryMemoParser } = await import("../src/services/DiaryMemoParser");
	const { MemoCatalogService } = await import("../src/services/MemoCatalogService");
	const { InMemoryMemoCatalogStore } = await import("../src/services/MemoCatalogStore");
	const fixture = await createCoordinatorFixture([]);
	const store = new InMemoryMemoCatalogStore();
	const coordinator = new CatalogShadowCoordinator(
		fixture.app,
		new MemoCatalogService(store),
		new DiaryMemoParser(async (bytes) => sha256(bytes)),
		async () => ({ folder: "Journal", format: "YYYY-MM-DD" }),
		() => ["## Memos"],
		{ enabled: false },
	);
	coordinator.start(fixture.owner);
	await coordinator.initialize();

	assert.equal(fixture.registeredVaultEvents.length, 0);
	assert.equal(fixture.readCount(), 0);
	assert.deepEqual(await store.listFiles(), []);
});

test("V3-FAIL-007：本机 fallback 扫描完成后仍明确报告 partial coverage", async () => {
	await ensureObsidianStub();
	const { CatalogShadowCoordinator } = await import("../src/services/CatalogShadowCoordinator");
	const { DiaryMemoParser } = await import("../src/services/DiaryMemoParser");
	const { MemoCatalogService } = await import("../src/services/MemoCatalogService");
	const { InMemoryMemoCatalogStore } = await import("../src/services/MemoCatalogStore");
	const fixture = await createCoordinatorFixture([
		{ path: "Journal/2026-08-22.md", content: "## Memos\n- 09:00 fallback memo", mtime: 10 },
	]);
	const store = new InMemoryMemoCatalogStore();
	const coordinator = new CatalogShadowCoordinator(
		fixture.app,
		new MemoCatalogService(store),
		new DiaryMemoParser(async (bytes) => sha256(bytes)),
		async () => ({ folder: "Journal", format: "YYYY-MM-DD" }),
		() => ["## Memos"],
		{ fullAuditIntervalMs: 0, isConfigurationComplete: () => false },
	);
	coordinator.start(fixture.owner);
	await coordinator.initialize();
	await coordinator.waitForIdle();

	const page = await store.query({ limit: 50 });
	assert.deepEqual(page.items.map((item) => item.content), ["fallback memo"]);
	assert.equal(page.coverage.kind, "partial");
	assert.equal(page.coverage.pendingFileCount, 0);
	fixture.unload();
});

test("fresh empty Vault 在共享配置缺失时也把 0/0 Daily 视为 complete", async () => {
	await ensureObsidianStub();
	const { CatalogShadowCoordinator } = await import("../src/services/CatalogShadowCoordinator");
	const { DiaryMemoParser } = await import("../src/services/DiaryMemoParser");
	const { MemoCatalogService } = await import("../src/services/MemoCatalogService");
	const { InMemoryMemoCatalogStore } = await import("../src/services/MemoCatalogStore");
	const fixture = await createCoordinatorFixture([]);
	const store = new InMemoryMemoCatalogStore();
	const coordinator = new CatalogShadowCoordinator(
		fixture.app,
		new MemoCatalogService(store),
		new DiaryMemoParser(async (bytes) => sha256(bytes)),
		async () => ({ folder: "Journal", format: "YYYY-MM-DD" }),
		() => ["## Memos"],
		{ isConfigurationComplete: () => false },
	);
	coordinator.start(fixture.owner);
	await coordinator.initialize();
	await coordinator.waitForIdle();

	assert.deepEqual((await store.query({ limit: 50 })).coverage, {
		kind: "complete",
		coveredFromDate: null,
		pendingFileCount: 0,
		coveredFileCount: 0,
		totalFileCount: 0,
	});
	assert.equal(fixture.readCount(), 0);
	fixture.unload();
});

test("配置晚到触发同一文件分区重扫，不重复 observation", async () => {
	await ensureObsidianStub();
	const { CatalogShadowCoordinator } = await import("../src/services/CatalogShadowCoordinator");
	const { DiaryMemoParser } = await import("../src/services/DiaryMemoParser");
	const { MemoCatalogService } = await import("../src/services/MemoCatalogService");
	const { InMemoryMemoCatalogStore } = await import("../src/services/MemoCatalogStore");
	const fixture = await createCoordinatorFixture([
		{ path: "Journal/2026-08-22.md", content: "## Memos\n- 09:00 one memo", mtime: 10 },
	]);
	const store = new InMemoryMemoCatalogStore();
	let configurationComplete = false;
	const coordinator = new CatalogShadowCoordinator(
		fixture.app,
		new MemoCatalogService(store),
		new DiaryMemoParser(async (bytes) => sha256(bytes)),
		async () => ({ folder: "Journal", format: "YYYY-MM-DD" }),
		() => ["## Memos"],
		{ fullAuditIntervalMs: 0, isConfigurationComplete: () => configurationComplete },
	);
	coordinator.start(fixture.owner);
	await coordinator.initialize();
	await coordinator.waitForIdle();
	assert.equal((await store.query({ limit: 50 })).coverage.kind, "partial");

	configurationComplete = true;
	await coordinator.refreshLocalCatalog();
	const page = await store.query({ limit: 50 });
	assert.equal(page.coverage.kind, "complete");
	assert.equal(page.items.length, 1);
	assert.equal(new Set(page.items.map((item) => item.observationKey)).size, 1);
	fixture.unload();
});

test("DAILY-RENAME / DAILY-MOVE / CATALOG-OFFLINE-CHANGES：启动 inventory diff 删除旧分区且不阻塞全历史读取", async () => {
	await ensureObsidianStub();
	const { CatalogShadowCoordinator } = await import("../src/services/CatalogShadowCoordinator");
	const { DiaryMemoParser } = await import("../src/services/DiaryMemoParser");
	const { MemoCatalogService } = await import("../src/services/MemoCatalogService");
	const { InMemoryMemoCatalogStore } = await import("../src/services/MemoCatalogStore");
	const store = new InMemoryMemoCatalogStore();
	const files = [
		{ path: "Journal/2026-08-08.md", content: "## Memos\n- 08:00 delete me", mtime: 10 },
		{ path: "Journal/2026-08-09.md", content: "## Memos\n- 09:00 rename me", mtime: 10 },
	];
	const first = await createCoordinatorFixture(files);
	const firstCoordinator = new CatalogShadowCoordinator(
		first.app,
		new MemoCatalogService(store),
		new DiaryMemoParser(async (bytes) => sha256(bytes)),
		async () => ({ folder: "Journal", format: "YYYY-MM-DD" }),
		() => ["## Memos"],
		{ fullAuditIntervalMs: 0, now: () => new Date(2026, 7, 9).getTime() },
	);
	firstCoordinator.start(first.owner);
	await firstCoordinator.initialize();
	assert.equal(first.readCount(), 0, "initialize 只做 stat inventory，Daily 读取必须留在后台 timer");
	await firstCoordinator.waitForIdle();
	assert.equal((await store.query({ limit: 50 })).items.length, 2);
	first.unload();

	const second = await createCoordinatorFixture([
		{ path: "Journal/2026-08-10.md", content: "## Memos\n- 09:00 rename me", mtime: 10 },
	]);
	const secondCoordinator = new CatalogShadowCoordinator(
		second.app,
		new MemoCatalogService(store),
		new DiaryMemoParser(async (bytes) => sha256(bytes)),
		async () => ({ folder: "Journal", format: "YYYY-MM-DD" }),
		() => ["## Memos"],
		{ fullAuditIntervalMs: 0, now: () => new Date(2026, 7, 10).getTime() },
	);
	secondCoordinator.start(second.owner);
	await secondCoordinator.initialize();
	await secondCoordinator.waitForIdle();
	const page = await store.query({ limit: 50 });
	assert.deepEqual(page.items.map((item) => item.sourcePath), ["Journal/2026-08-10.md"]);
	assert.deepEqual((await store.listFiles()).map((item) => item.sourcePath), ["Journal/2026-08-10.md"]);
	second.unload();
});

test("同 size、同 mtime 的离线修改不做启动全读，由到期后台 SHA 审计发现", async () => {
	await ensureObsidianStub();
	const { CatalogShadowCoordinator } = await import("../src/services/CatalogShadowCoordinator");
	const { DiaryMemoParser } = await import("../src/services/DiaryMemoParser");
	const { MemoCatalogService } = await import("../src/services/MemoCatalogService");
	const { InMemoryMemoCatalogStore } = await import("../src/services/MemoCatalogStore");
	const store = new InMemoryMemoCatalogStore();
	const first = await createCoordinatorFixture([
		{ path: "Journal/2026-08-09.md", content: "## Memos\n- 09:00 alpha", mtime: 10 },
	]);
	const firstCoordinator = new CatalogShadowCoordinator(
		first.app,
		new MemoCatalogService(store),
		new DiaryMemoParser(async (bytes) => sha256(bytes)),
		async () => ({ folder: "Journal", format: "YYYY-MM-DD" }),
		() => ["## Memos"],
		{ now: () => 1_000, fullAuditIntervalMs: 1_000 },
	);
	firstCoordinator.start(first.owner);
	await firstCoordinator.initialize();
	await firstCoordinator.waitForIdle();
	first.unload();

	const second = await createCoordinatorFixture([
		{ path: "Journal/2026-08-09.md", content: "## Memos\n- 09:00 bravo", mtime: 10 },
	]);
	const transitions: CatalogRevisionTransition[] = [];
	const secondCoordinator = new CatalogShadowCoordinator(
		second.app,
		new MemoCatalogService(store),
		new DiaryMemoParser(async (bytes) => sha256(bytes)),
		async () => ({ folder: "Journal", format: "YYYY-MM-DD" }),
		() => ["## Memos"],
		{
			now: () => 2_001,
			fullAuditIntervalMs: 1_000,
			onRevisionTransition: (transition) => { transitions.push(transition); },
		},
	);
	secondCoordinator.start(second.owner);
	await secondCoordinator.initialize();
	assert.equal(second.readCount(), 0);
	await secondCoordinator.waitForIdle();
	assert.deepEqual((await store.query({ limit: 50 })).items.map((item) => item.content), ["bravo"]);
	assert.deepEqual(transitions.map((transition) => ({
		before: transition.before?.observations.map((item) => item.content) ?? [],
		after: transition.after.observations.map((item) => item.content),
	})), [{ before: ["alpha"], after: ["bravo"] }]);
	second.unload();
});

test("MOBILE-BACKGROUND-RESUME：隐藏时保存 checkpoint，重启只续跑 pending paths", async () => {
	await ensureObsidianStub();
	const {
		CatalogShadowCoordinator,
		CATALOG_CHECKPOINT_META_KEY,
	} = await import("../src/services/CatalogShadowCoordinator");
	const { DiaryMemoParser } = await import("../src/services/DiaryMemoParser");
	const { MemoCatalogService } = await import("../src/services/MemoCatalogService");
	const { InMemoryMemoCatalogStore } = await import("../src/services/MemoCatalogStore");
	const store = new InMemoryMemoCatalogStore();
	const files = [1, 2, 3].map((day) => ({
		path: `Journal/2026-08-0${day}.md`,
		content: `## Memos\n- 09:00 day ${day}`,
		mtime: 10,
	}));
	const first = await createCoordinatorFixture(files, true);
	const firstCoordinator = new CatalogShadowCoordinator(
		first.app,
		new MemoCatalogService(store),
		new DiaryMemoParser(async (bytes) => sha256(bytes)),
		async () => ({ folder: "Journal", format: "YYYY-MM-DD" }),
		() => ["## Memos"],
		{ fullAuditIntervalMs: 0, now: () => new Date(2026, 7, 9).getTime() },
	);
	firstCoordinator.start(first.owner);
	await firstCoordinator.initialize();
	await waitUntil(async () => {
		const checkpoint = await store.getMeta<{ pendingPaths: string[] }>(CATALOG_CHECKPOINT_META_KEY);
		return checkpoint?.pendingPaths.length === 2;
	});
	const firstPage = await store.query({ limit: 50 });
	assert.deepEqual(firstPage.items.map((item) => item.content), ["day 3"], "启动必须优先 hydrate 最近 Daily");
	assert.equal(firstPage.coverage.kind, "rebuilding");
	first.unload();

	const second = await createCoordinatorFixture(files);
	const secondCoordinator = new CatalogShadowCoordinator(
		second.app,
		new MemoCatalogService(store),
		new DiaryMemoParser(async (bytes) => sha256(bytes)),
		async () => ({ folder: "Journal", format: "YYYY-MM-DD" }),
		() => ["## Memos"],
		{ fullAuditIntervalMs: 0, now: () => new Date(2026, 7, 9).getTime() },
	);
	secondCoordinator.start(second.owner);
	await secondCoordinator.initialize();
	await secondCoordinator.waitForIdle();
	assert.equal(second.readCount(), 2);
	const completedPage = await store.query({ limit: 50 });
	assert.equal(completedPage.items.length, 3);
	assert.equal(completedPage.coverage.kind, "complete");
	assert.equal(await store.getMeta(CATALOG_CHECKPOINT_META_KEY), null);
	second.unload();
});

test("V3-FAIL-001/V3-FAIL-002：Catalog 持久层不可用时从 Daily 渐进扫描并展示全部 observation", async () => {
	await ensureObsidianStub();
	const { CatalogShadowCoordinator } = await import("../src/services/CatalogShadowCoordinator");
	const { CatalogV2ReadService } = await import("../src/services/CatalogV2ReadService");
	const { DiaryMemoParser } = await import("../src/services/DiaryMemoParser");
	const { MemoCatalogService } = await import("../src/services/MemoCatalogService");
	const { FallbackMemoCatalogStore, InMemoryMemoCatalogStore } = await import("../src/services/MemoCatalogStore");
	class FailingPrimaryStore extends InMemoryMemoCatalogStore {
		override async open(): Promise<void> {
			throw new Error("indexeddb unavailable");
		}
	}
	const fixture = await createCoordinatorFixture([
		{ path: "Journal/2026-08-20.md", content: "## Memos\n- 09:00 first observation\n", mtime: 10 },
		{ path: "Journal/2026-08-21.md", content: "## Memos\n- 10:00 second observation\n", mtime: 11 },
	]);
	const dailyBefore = fixture.snapshot();
	const store = new FallbackMemoCatalogStore(new FailingPrimaryStore(), new InMemoryMemoCatalogStore());
	const catalog = new MemoCatalogService(store);
	await catalog.open();
	const coordinator = new CatalogShadowCoordinator(
		fixture.app,
		catalog,
		new DiaryMemoParser(async (bytes) => sha256(bytes)),
		async () => ({ folder: "Journal", format: "YYYY-MM-DD" }),
		() => ["## Memos"],
		{ fullAuditIntervalMs: 0, now: () => new Date(2026, 7, 21).getTime() },
	);
	const readService = new CatalogV2ReadService({
		catalog,
		stateStore: null,
		stateCoordinator: null,
		transactionStore: null,
		deletedPayloadStore: null,
		installMode: "uninitialized",
	});
	try {
		coordinator.start(fixture.owner);
		await coordinator.initialize();
		await coordinator.waitForIdle();
		const page = await readService.query({ limit: 50 });

		assert.equal(store.isUsingFallback, true);
		assert.deepEqual(page.items.map((item) => item.content), ["second observation", "first observation"]);
		assert.equal(page.status.catalog, "degraded");
		assert.equal(page.status.identity, "absent");
		assert.equal(page.capabilities.stats, "partial");
		assert.deepEqual(fixture.snapshot(), dailyBefore);
	} finally {
		fixture.unload();
	}
});

test("P0 第 3 步 Daily commit 后直接替换当前 Catalog partition", async () => {
	await ensureObsidianStub();
	const { TFile } = await import("obsidian");
	const { CatalogShadowCoordinator } = await import("../src/services/CatalogShadowCoordinator");
	const { DiaryMemoParser } = await import("../src/services/DiaryMemoParser");
	const { MemoCatalogService } = await import("../src/services/MemoCatalogService");
	const { InMemoryMemoCatalogStore } = await import("../src/services/MemoCatalogStore");
	const sourcePath = "Journal/2026-08-22.md";
	const fixture = await createCoordinatorFixture([
		{ path: sourcePath, content: "## Memos\n- 09:00 before\n", mtime: 10 },
	]);
	const store = new InMemoryMemoCatalogStore();
	const parser = new DiaryMemoParser(async (bytes) => sha256(bytes));
	const transitions: CatalogRevisionTransition[] = [];
	const coordinator = new CatalogShadowCoordinator(
		fixture.app,
		new MemoCatalogService(store),
		parser,
		async () => ({ folder: "Journal", format: "YYYY-MM-DD" }),
		() => ["## Memos"],
		{
			now: () => 20,
			onRevisionTransition: (transition) => { transitions.push(transition); },
		},
	);
	try {
		coordinator.start(fixture.owner);
		await coordinator.initialize();
		await coordinator.waitForIdle();
		const content = "## Memos\n- 09:00 after\n";
		const parsed = await parser.parse({
			sourcePath,
			logicalDate: "2026-08-22",
			headings: ["## Memos"],
			bytes: Buffer.from(content, "utf8"),
		});
		const file = (fixture.app as unknown as App).vault.getAbstractFileByPath(sourcePath);
		assert.ok(file instanceof TFile);

		await coordinator.replaceCommittedFile({
			file,
			logicalDate: "2026-08-22",
			content,
			parsed,
		});

		assert.deepEqual((await store.query({ limit: 10 })).items.map((item) => item.content), ["after"]);
		assert.deepEqual(transitions.map((transition) => ({
			beforeRevision: transition.before?.sourceRevision ?? null,
			beforeContent: transition.before?.observations.map((item) => item.content) ?? [],
			afterRevision: transition.after.sourceRevision,
			afterContent: transition.after.observations.map((item) => item.content),
		})), [{
			beforeRevision: await sha256(Buffer.from("## Memos\n- 09:00 before\n", "utf8")),
			beforeContent: ["before"],
			afterRevision: parsed.sourceRevision,
			afterContent: ["after"],
		}]);
		assert.equal(fixture.snapshot()[sourcePath], "## Memos\n- 09:00 before\n");
	} finally {
		fixture.unload();
	}
});

test("普通刷新加入当前扫描且进度持续上报，不清空本机 Catalog", async () => {
	await ensureObsidianStub();
	const { CatalogShadowCoordinator } = await import("../src/services/CatalogShadowCoordinator");
	const { DiaryMemoParser } = await import("../src/services/DiaryMemoParser");
	const { MemoCatalogService } = await import("../src/services/MemoCatalogService");
	const { InMemoryMemoCatalogStore } = await import("../src/services/MemoCatalogStore");
	const store = new InMemoryMemoCatalogStore();
	let clearCount = 0;
	const originalClear = store.clear.bind(store);
	store.clear = async () => {
		clearCount += 1;
		await originalClear();
	};
	const progress: Array<{ coveredFileCount: number; totalFileCount: number }> = [];
	const fixture = await createCoordinatorFixture([
		{ path: "Journal/2026-08-10.md", content: "## Memos\n- 09:00 progress", mtime: 10 },
	]);
	const coordinator = new CatalogShadowCoordinator(
		fixture.app,
		new MemoCatalogService(store),
		new DiaryMemoParser(async (bytes) => sha256(bytes)),
		async () => ({ folder: "Journal", format: "YYYY-MM-DD" }),
		() => ["## Memos"],
		{
			fullAuditIntervalMs: 0,
			now: () => new Date(2026, 7, 10).getTime(),
			onProgress: (coverage) => { progress.push(coverage); },
		},
	);
	try {
		coordinator.start(fixture.owner);
		await coordinator.initialize();
		await coordinator.waitForIdle();
		await coordinator.refreshLocalCatalog();

		assert.equal(clearCount, 0);
		assert.ok(progress.some((item) => item.coveredFileCount === 0 && item.totalFileCount === 1));
		assert.ok(progress.some((item) => item.coveredFileCount === 1 && item.totalFileCount === 1));
	} finally {
		fixture.unload();
	}
});

test("Catalog rebuild 只重建本机缓存，不修改 Daily、Monthly 或共享数据", async () => {
	await ensureObsidianStub();
	const { CatalogShadowCoordinator } = await import("../src/services/CatalogShadowCoordinator");
	const { DiaryMemoParser } = await import("../src/services/DiaryMemoParser");
	const { MemoCatalogService } = await import("../src/services/MemoCatalogService");
	const { InMemoryMemoCatalogStore } = await import("../src/services/MemoCatalogStore");
	const fixture = await createCoordinatorFixture([
		{ path: "Journal/2026-08-10.md", content: "## Memos\n- 09:00 rebuild only\n", mtime: 10 },
		{ path: "Memos/2026-08.md", content: "monthly bytes\n", mtime: 10 },
		{ path: "Memos/_knomo-data/sentinel.md", content: "shared bytes\n", mtime: 10 },
	]);
	const store = new InMemoryMemoCatalogStore();
	const coordinator = new CatalogShadowCoordinator(
		fixture.app,
		new MemoCatalogService(store),
		new DiaryMemoParser(async (bytes) => sha256(bytes)),
		async () => ({ folder: "Journal", format: "YYYY-MM-DD" }),
		() => ["## Memos"],
		{ fullAuditIntervalMs: 0, now: () => new Date(2026, 7, 10).getTime() },
	);
	const sharedBytes = fixture.snapshot();
	try {
		coordinator.start(fixture.owner);
		await coordinator.initialize();
		await coordinator.waitForIdle();
		await coordinator.rebuildLocalCatalog();

		const page = await store.query({ limit: 50 });
		assert.deepEqual(page.items.map((item) => item.content), ["rebuild only"]);
		assert.equal(page.coverage.kind, "complete");
		assert.deepEqual(fixture.snapshot(), sharedBytes);
	} finally {
		fixture.unload();
	}
});

async function createCoordinatorFixture(
	entries: Array<{ path: string; content: string; mtime: number }>,
	hideAfterFirstRead = false,
) {
	const { TFile } = await import("obsidian");
	const registeredVaultEvents: string[] = [];
	const cleanupCallbacks: Array<() => void> = [];
	const domListeners = new Map<string, () => void>();
	const doc = { visibilityState: "visible" };
	let reads = 0;
	const files = entries.map((entry) => Object.assign(new TFile(), {
		path: entry.path,
		extension: "md",
		stat: { mtime: entry.mtime, size: Buffer.byteLength(entry.content) },
	}));
	const contentByPath = new Map(entries.map((entry) => [entry.path, Buffer.from(entry.content, "utf8")]));
	const app = {
		vault: {
			on: (name: string) => {
				registeredVaultEvents.push(name);
				return {};
			},
			getMarkdownFiles: () => files,
			getAbstractFileByPath: (path: string) => files.find((file) => file.path === path) ?? null,
			readBinary: async (file: { path: string }) => {
				reads += 1;
				if (hideAfterFirstRead && reads === 1) {
					doc.visibilityState = "hidden";
					domListeners.get("visibilitychange")?.();
				}
				const bytes = contentByPath.get(file.path) ?? Buffer.alloc(0);
				return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
			},
			adapter: { getName: () => "test" },
			getName: () => "test-vault",
			configDir: ".obsidian",
		},
		workspace: {
			containerEl: {
				doc,
				win: {
					setTimeout: (callback: () => void, delay: number) => globalThis.setTimeout(callback, delay) as unknown as number,
					clearTimeout: (timer: number) => globalThis.clearTimeout(timer as unknown as NodeJS.Timeout),
				},
			},
		},
	};
	const owner = {
		registerEvent: () => undefined,
		registerDomEvent: (_target: unknown, type: string, listener: () => void) => {
			domListeners.set(type, listener);
		},
		register: (callback: () => void) => cleanupCallbacks.push(callback),
	};
	return {
		app: app as never,
		owner: owner as never,
		registeredVaultEvents,
		readCount: () => reads,
		snapshot: () => Object.fromEntries(
			[...contentByPath.entries()].map(([path, content]) => [path, content.toString("utf8")]),
		),
		unload: () => cleanupCallbacks.splice(0).forEach((callback) => callback()),
	};
}

async function waitUntil(predicate: () => Promise<boolean>): Promise<void> {
	for (let attempt = 0; attempt < 400; attempt += 1) {
		if (await predicate()) {
			return;
		}
		await waitTimer(5);
	}
	throw new Error("Timed out waiting for Catalog background state.");
}

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { setImmediate as waitImmediate, setTimeout as waitTimer } from "node:timers/promises";
import test from "node:test";
import type { App } from "obsidian";

import type { CatalogRevisionTransition } from "../src/services/CatalogIndexCoordinator";
import { LowPriorityWorkQueue } from "../src/services/LowPriorityWorkQueue";

import { ensureObsidianStub } from "./helpers/obsidianStub";
test("Catalog 扫描 off switch 不注册事件、不读取 Daily", async () => {
	await ensureObsidianStub();
	const { CatalogIndexCoordinator } = await import("../src/services/CatalogIndexCoordinator");
	const { DiaryMemoParser } = await import("../src/services/DiaryMemoParser");
	const { MemoCatalogService } = await import("../src/services/MemoCatalogService");
	const { InMemoryMemoCatalogStore } = await import("../src/services/MemoCatalogStore");
	const fixture = await createCoordinatorFixture([]);
	const store = new InMemoryMemoCatalogStore();
	const coordinator = new CatalogIndexCoordinator(
		fixture.app,
		new MemoCatalogService(store),
		new DiaryMemoParser(async (bytes) => sha256(bytes)),
		async () => ({ folder: "Journal", format: "YYYY-MM-DD" }),
		{ enabled: false },
	);
	coordinator.start(fixture.owner);
	await coordinator.initialize();

	assert.equal(fixture.registeredVaultEvents.length, 0);
	assert.equal(fixture.readCount(), 0);
	assert.deepEqual(await store.listFiles(), []);
});

test("本机 fallback 扫描完成后内容就绪但共享配置范围仍不完整", async () => {
	await ensureObsidianStub();
	const { CatalogIndexCoordinator } = await import("../src/services/CatalogIndexCoordinator");
	const { DiaryMemoParser } = await import("../src/services/DiaryMemoParser");
	const { MemoCatalogService } = await import("../src/services/MemoCatalogService");
	const { InMemoryMemoCatalogStore } = await import("../src/services/MemoCatalogStore");
	const fixture = await createCoordinatorFixture([
		{ path: "Journal/2026-08-22.md", content: "## Memos\n- 09:00 fallback memo", mtime: 10 },
	]);
	const store = new InMemoryMemoCatalogStore();
	const coordinator = new CatalogIndexCoordinator(
		fixture.app,
		new MemoCatalogService(store),
		new DiaryMemoParser(async (bytes) => sha256(bytes)),
		async () => ({ folder: "Journal", format: "YYYY-MM-DD" }),
		{ fullAuditIntervalMs: 0, isConfigurationComplete: () => false },
	);
	coordinator.start(fixture.owner);
	await coordinator.initialize();
	await coordinator.waitForIdle();

	const page = await store.query({ limit: 50 });
	assert.deepEqual(page.items.map((item) => item.content), ["fallback memo"]);
	assert.equal(page.coverage.kind, "complete");
	assert.equal(page.coverage.sharedConfigurationComplete, false);
	assert.equal(page.coverage.pendingFileCount, 0);
	fixture.unload();
});

test("fresh empty Vault 在共享配置缺失时也把 0/0 Daily 视为 complete", async () => {
	await ensureObsidianStub();
	const { CatalogIndexCoordinator } = await import("../src/services/CatalogIndexCoordinator");
	const { DiaryMemoParser } = await import("../src/services/DiaryMemoParser");
	const { MemoCatalogService } = await import("../src/services/MemoCatalogService");
	const { InMemoryMemoCatalogStore } = await import("../src/services/MemoCatalogStore");
	const fixture = await createCoordinatorFixture([]);
	const store = new InMemoryMemoCatalogStore();
	const coordinator = new CatalogIndexCoordinator(
		fixture.app,
		new MemoCatalogService(store),
		new DiaryMemoParser(async (bytes) => sha256(bytes)),
		async () => ({ folder: "Journal", format: "YYYY-MM-DD" }),
		{ isConfigurationComplete: () => false },
	);
	coordinator.start(fixture.owner);
	await coordinator.initialize();
	await coordinator.waitForIdle();

	assert.deepEqual((await store.query({ limit: 50 })).coverage, {
		kind: "complete",
		sharedConfigurationComplete: false,
		coveredFromDate: null,
		pendingFileCount: 0,
		coveredFileCount: 0,
		totalFileCount: 0,
	});
	assert.equal(fixture.readCount(), 0);
	fixture.unload();
});

test("Catalog 扫描识别 Daily 根区域及任意标题下的所有时间 memo", async () => {
	await ensureObsidianStub();
	const { CatalogIndexCoordinator } = await import("../src/services/CatalogIndexCoordinator");
	const { DiaryMemoParser } = await import("../src/services/DiaryMemoParser");
	const { MemoCatalogService } = await import("../src/services/MemoCatalogService");
	const { InMemoryMemoCatalogStore } = await import("../src/services/MemoCatalogStore");
	const fixture = await createCoordinatorFixture([{
		path: "Journal/2026-08-27.md",
		content: "- 12:58 root\n### Ideas\n- 14:26 under ideas\n",
		mtime: 10,
	}]);
	const store = new InMemoryMemoCatalogStore();
	const coordinator = new CatalogIndexCoordinator(
		fixture.app,
		new MemoCatalogService(store),
		new DiaryMemoParser(async (bytes) => sha256(bytes)),
		async () => ({ folder: "Journal", format: "YYYY-MM-DD" }),
		{ now: () => 1_000, fullAuditIntervalMs: 10_000 },
	);
	try {
		coordinator.start(fixture.owner);
		await coordinator.initialize();
		await coordinator.waitForIdle();
		const page = await store.query({ limit: 10 });
		assert.deepEqual(page.items.map((item) => [item.time, item.section, item.content]), [
			["14:26", "### Ideas", "under ideas"],
			["12:58", null, "root"],
		]);
	} finally {
		fixture.unload();
	}
});

test("共享配置晚到只更新 coverage，不重读历史 Daily", async () => {
	await ensureObsidianStub();
	const { CatalogIndexCoordinator } = await import("../src/services/CatalogIndexCoordinator");
	const { DiaryMemoParser } = await import("../src/services/DiaryMemoParser");
	const { MemoCatalogService } = await import("../src/services/MemoCatalogService");
	const { InMemoryMemoCatalogStore } = await import("../src/services/MemoCatalogStore");
	const fixture = await createCoordinatorFixture([
		{ path: "Journal/2026-08-22.md", content: "## Memos\n- 09:00 one memo", mtime: 10 },
	]);
	const store = new InMemoryMemoCatalogStore();
	let configurationComplete = false;
	const coordinator = new CatalogIndexCoordinator(
		fixture.app,
		new MemoCatalogService(store),
		new DiaryMemoParser(async (bytes) => sha256(bytes)),
		async () => ({ folder: "Journal", format: "YYYY-MM-DD" }),
		{ fullAuditIntervalMs: 10_000, now: () => 1_000, isConfigurationComplete: () => configurationComplete },
	);
	coordinator.start(fixture.owner);
	await coordinator.initialize();
	await coordinator.waitForIdle();
	assert.deepEqual(
		((await store.query({ limit: 50 })).coverage),
		{
			kind: "complete",
			sharedConfigurationComplete: false,
			coveredFromDate: "2026-08-22",
			pendingFileCount: 0,
			coveredFileCount: 1,
			totalFileCount: 1,
		},
	);
	assert.equal(fixture.readCount(), 1);

	configurationComplete = true;
	await coordinator.refreshLocalCatalog();
	const page = await store.query({ limit: 50 });
	assert.equal(page.coverage.kind, "complete");
	assert.equal(page.coverage.sharedConfigurationComplete, true);
	assert.equal(page.items.length, 1);
	assert.equal(new Set(page.items.map((item) => item.observationKey)).size, 1);
	assert.equal(fixture.readCount(), 1);
	fixture.unload();
});

test("DAILY-RENAME / DAILY-MOVE / CATALOG-OFFLINE-CHANGES：启动 inventory diff 删除旧分区且不阻塞全历史读取", async () => {
	await ensureObsidianStub();
	const { CatalogIndexCoordinator } = await import("../src/services/CatalogIndexCoordinator");
	const { DiaryMemoParser } = await import("../src/services/DiaryMemoParser");
	const { MemoCatalogService } = await import("../src/services/MemoCatalogService");
	const { InMemoryMemoCatalogStore } = await import("../src/services/MemoCatalogStore");
	const store = new InMemoryMemoCatalogStore();
	const files = [
		{ path: "Journal/2026-08-08.md", content: "## Memos\n- 08:00 delete me", mtime: 10 },
		{ path: "Journal/2026-08-09.md", content: "## Memos\n- 09:00 rename me", mtime: 10 },
	];
	const first = await createCoordinatorFixture(files);
	const firstCoordinator = new CatalogIndexCoordinator(
		first.app,
		new MemoCatalogService(store),
		new DiaryMemoParser(async (bytes) => sha256(bytes)),
		async () => ({ folder: "Journal", format: "YYYY-MM-DD" }),
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
	const secondCoordinator = new CatalogIndexCoordinator(
		second.app,
		new MemoCatalogService(store),
		new DiaryMemoParser(async (bytes) => sha256(bytes)),
		async () => ({ folder: "Journal", format: "YYYY-MM-DD" }),
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
	const { CatalogIndexCoordinator } = await import("../src/services/CatalogIndexCoordinator");
	const { DiaryMemoParser } = await import("../src/services/DiaryMemoParser");
	const { MemoCatalogService } = await import("../src/services/MemoCatalogService");
	const { InMemoryMemoCatalogStore } = await import("../src/services/MemoCatalogStore");
	const store = new InMemoryMemoCatalogStore();
	const initialChangedPeriods: string[] = [];
	const first = await createCoordinatorFixture([
		{ path: "Journal/2026-08-09.md", content: "## Memos\n- 09:00 alpha", mtime: 10 },
	]);
	const firstCoordinator = new CatalogIndexCoordinator(
		first.app,
		new MemoCatalogService(store),
		new DiaryMemoParser(async (bytes) => sha256(bytes)),
		async () => ({ folder: "Journal", format: "YYYY-MM-DD" }),
		{
			now: () => 1_000,
			fullAuditIntervalMs: 1_000,
			onDailyPeriodsChanged: (periods) => { initialChangedPeriods.push(...periods); },
		},
	);
	firstCoordinator.start(first.owner);
	await firstCoordinator.initialize();
	await firstCoordinator.waitForIdle();
	assert.deepEqual(initialChangedPeriods, []);
	first.unload();

	const second = await createCoordinatorFixture([
		{ path: "Journal/2026-08-09.md", content: "## Memos\n- 09:00 bravo", mtime: 10 },
	]);
	const transitions: CatalogRevisionTransition[] = [];
	const changedPeriods: string[] = [];
	const secondCoordinator = new CatalogIndexCoordinator(
		second.app,
		new MemoCatalogService(store),
		new DiaryMemoParser(async (bytes) => sha256(bytes)),
		async () => ({ folder: "Journal", format: "YYYY-MM-DD" }),
		{
			now: () => 2_001,
			fullAuditIntervalMs: 1_000,
			onRevisionTransition: (transition) => { transitions.push(transition); },
			onDailyPeriodsChanged: (periods) => { changedPeriods.push(...periods); },
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
	assert.deepEqual(changedPeriods, ["2026-08"]);
	second.unload();
});

test("warm start 在审计未到期时不读取未变化 Daily 正文", async () => {
	await ensureObsidianStub();
	const { CatalogIndexCoordinator } = await import("../src/services/CatalogIndexCoordinator");
	const { DiaryMemoParser } = await import("../src/services/DiaryMemoParser");
	const { MemoCatalogService } = await import("../src/services/MemoCatalogService");
	const { InMemoryMemoCatalogStore } = await import("../src/services/MemoCatalogStore");
	const store = new InMemoryMemoCatalogStore();
	const files = [
		{ path: "Journal/2026-08-09.md", content: "## Memos\n- 09:00 unchanged", mtime: 10 },
	];
	const first = await createCoordinatorFixture(files);
	const firstCoordinator = new CatalogIndexCoordinator(
		first.app,
		new MemoCatalogService(store),
		new DiaryMemoParser(async (bytes) => sha256(bytes)),
		async () => ({ folder: "Journal", format: "YYYY-MM-DD" }),
		{ now: () => 1_000, fullAuditIntervalMs: 10_000 },
	);
	firstCoordinator.start(first.owner);
	await firstCoordinator.initialize();
	await firstCoordinator.waitForIdle();
	assert.equal(first.readCount(), 1);
	first.unload();

	const second = await createCoordinatorFixture(files);
	const secondCoordinator = new CatalogIndexCoordinator(
		second.app,
		new MemoCatalogService(store),
		new DiaryMemoParser(async (bytes) => sha256(bytes)),
		async () => ({ folder: "Journal", format: "YYYY-MM-DD" }),
		{ now: () => 2_000, fullAuditIntervalMs: 10_000 },
	);
	secondCoordinator.start(second.owner);
	await secondCoordinator.initialize();
	await secondCoordinator.waitForIdle();

	assert.equal(second.readCount(), 0);
	assert.equal((await store.query({ limit: 50 })).items[0]?.content, "unchanged");
	second.unload();
});

test("Vault 事件只处理受影响的 Daily，Monthly 与其他 Markdown 不触发 inventory 重算", async () => {
	await ensureObsidianStub();
	const { CatalogIndexCoordinator } = await import("../src/services/CatalogIndexCoordinator");
	const { DiaryMemoParser } = await import("../src/services/DiaryMemoParser");
	const { MemoCatalogService } = await import("../src/services/MemoCatalogService");
	const { InMemoryMemoCatalogStore } = await import("../src/services/MemoCatalogStore");
	const store = new InMemoryMemoCatalogStore();
	const fixture = await createCoordinatorFixture([
		{ path: "Journal/2026-08-09.md", content: "## Memos\n- 09:00 before", mtime: 10 },
		{ path: "Memos/2026-08.md", content: "# Monthly", mtime: 10 },
		{ path: "Notes/other.md", content: "plain note", mtime: 10 },
	]);
	const coordinator = new CatalogIndexCoordinator(
		fixture.app,
		new MemoCatalogService(store),
		new DiaryMemoParser(async (bytes) => sha256(bytes)),
		async () => ({ folder: "Journal", format: "YYYY-MM-DD" }),
		{ now: () => 1_000, fullAuditIntervalMs: 10_000 },
	);
	try {
		coordinator.start(fixture.owner);
		await coordinator.initialize();
		await coordinator.waitForIdle();
		assert.equal(fixture.inventoryCount(), 1);
		assert.equal(fixture.readCount(), 1);

		fixture.emitVaultEvent("modify", fixture.file("Memos/2026-08.md"));
		fixture.emitVaultEvent("modify", fixture.file("Notes/other.md"));
		await waitTimer(20);
		assert.equal(fixture.inventoryCount(), 1);
		assert.equal(fixture.readCount(), 1);

		fixture.setFile("Journal/2026-08-09.md", "## Memos\n- 09:00 after", 20);
		fixture.emitVaultEvent("modify", fixture.file("Journal/2026-08-09.md"));
		await waitUntil(async () => (await store.query({ limit: 10 })).items[0]?.content === "after");
		assert.equal(fixture.inventoryCount(), 1);
		assert.equal(fixture.readCount(), 2);

		const deletedFile = fixture.file("Journal/2026-08-09.md");
		fixture.removeFile("Journal/2026-08-09.md");
		fixture.emitVaultEvent("delete", deletedFile);
		await waitUntil(async () => (await store.listFiles()).length === 0);
		assert.equal(fixture.inventoryCount(), 1);

		fixture.setFile("Journal/2026-08-10.md", "## Memos\n- 10:00 moving", 30);
		fixture.emitVaultEvent("create", fixture.file("Journal/2026-08-10.md"));
		await waitUntil(async () => (await store.listFiles()).some((file) => file.sourcePath.endsWith("2026-08-10.md")));
		fixture.renameFile("Journal/2026-08-10.md", "Journal/2026-08-11.md", 40);
		fixture.emitVaultEvent(
			"rename",
			fixture.file("Journal/2026-08-11.md"),
			"Journal/2026-08-10.md",
		);
		await waitUntil(async () => {
			const paths = (await store.listFiles()).map((file) => file.sourcePath);
			return paths.length === 1 && paths[0] === "Journal/2026-08-11.md";
		});
		assert.equal(fixture.inventoryCount(), 1);
	} finally {
		fixture.unload();
	}
});

test("Markdown 改名为非 Markdown 时先清理旧 Daily Catalog partition", async () => {
	await ensureObsidianStub();
	const { CatalogIndexCoordinator } = await import("../src/services/CatalogIndexCoordinator");
	const { DiaryMemoParser } = await import("../src/services/DiaryMemoParser");
	const { MemoCatalogService } = await import("../src/services/MemoCatalogService");
	const { InMemoryMemoCatalogStore } = await import("../src/services/MemoCatalogStore");
	const sourcePath = "Journal/2026-08-09.md";
	const fixture = await createCoordinatorFixture([
		{ path: sourcePath, content: "## Memos\n- 09:00 before", mtime: 10 },
	]);
	const store = new InMemoryMemoCatalogStore();
	const coordinator = new CatalogIndexCoordinator(
		fixture.app,
		new MemoCatalogService(store),
		new DiaryMemoParser(async (bytes) => sha256(bytes)),
		async () => ({ folder: "Journal", format: "YYYY-MM-DD" }),
		{ fullAuditIntervalMs: 10_000 },
	);
	try {
		coordinator.start(fixture.owner);
		await coordinator.initialize();
		await coordinator.waitForIdle();

		fixture.renameFile(sourcePath, "Journal/2026-08-09.txt", 20);
		fixture.emitVaultEvent("rename", fixture.file("Journal/2026-08-09.txt"), sourcePath);

		await waitUntil(async () => (await store.listFiles()).length === 0);
	} finally {
		fixture.unload();
	}
});

test("文件夹改名清理全部旧 Daily，并在移回 Daily 范围后加入全部新路径", async () => {
	await ensureObsidianStub();
	const { TFolder } = await import("obsidian");
	const { CatalogIndexCoordinator } = await import("../src/services/CatalogIndexCoordinator");
	const { DiaryMemoParser } = await import("../src/services/DiaryMemoParser");
	const { MemoCatalogService } = await import("../src/services/MemoCatalogService");
	const { InMemoryMemoCatalogStore } = await import("../src/services/MemoCatalogStore");
	const fixture = await createCoordinatorFixture([
		{ path: "Journal/2026-08-09.md", content: "- 09:00 first", mtime: 10 },
		{ path: "Journal/2026-08-10.md", content: "- 10:00 second", mtime: 10 },
	]);
	const store = new InMemoryMemoCatalogStore();
	const coordinator = new CatalogIndexCoordinator(
		fixture.app,
		new MemoCatalogService(store),
		new DiaryMemoParser(async (bytes) => sha256(bytes)),
		async () => ({ folder: "Journal", format: "YYYY-MM-DD" }),
		{ fullAuditIntervalMs: 10_000 },
	);
	try {
		coordinator.start(fixture.owner);
		await coordinator.initialize();
		await coordinator.waitForIdle();

		fixture.renameFile("Journal/2026-08-09.md", "Archive/2026-08-09.md", 20);
		fixture.renameFile("Journal/2026-08-10.md", "Archive/2026-08-10.md", 20);
		const archiveFirst = fixture.file("Archive/2026-08-09.md");
		const archiveSecond = fixture.file("Archive/2026-08-10.md");
		assert.ok(archiveFirst !== null && archiveSecond !== null);
		const folder = Object.assign(new TFolder(), {
			path: "Archive",
			children: [archiveFirst, archiveSecond],
		});
		fixture.emitVaultEvent("rename", folder, "Journal");
		await waitUntil(async () => (await store.listFiles()).length === 0);

		fixture.renameFile("Archive/2026-08-09.md", "Journal/2026-08-09.md", 30);
		fixture.renameFile("Archive/2026-08-10.md", "Journal/2026-08-10.md", 30);
		const journalFirst = fixture.file("Journal/2026-08-09.md");
		const journalSecond = fixture.file("Journal/2026-08-10.md");
		assert.ok(journalFirst !== null && journalSecond !== null);
		folder.path = "Journal";
		folder.children = [journalFirst, journalSecond];
		fixture.emitVaultEvent("rename", folder, "Archive");
		await waitUntil(async () => {
			const paths = (await store.listFiles()).map((file) => file.sourcePath).sort();
			return paths.join(",") === "Journal/2026-08-09.md,Journal/2026-08-10.md";
		});
	} finally {
		fixture.unload();
	}
});

test("删除文件夹时清理其下全部 Daily Catalog partition", async () => {
	await ensureObsidianStub();
	const { TFolder } = await import("obsidian");
	const { CatalogIndexCoordinator } = await import("../src/services/CatalogIndexCoordinator");
	const { DiaryMemoParser } = await import("../src/services/DiaryMemoParser");
	const { MemoCatalogService } = await import("../src/services/MemoCatalogService");
	const { InMemoryMemoCatalogStore } = await import("../src/services/MemoCatalogStore");
	const fixture = await createCoordinatorFixture([
		{ path: "Journal/2026-08-09.md", content: "- 09:00 first", mtime: 10 },
		{ path: "Journal/2026-08-10.md", content: "- 10:00 second", mtime: 10 },
	]);
	const store = new InMemoryMemoCatalogStore();
	const coordinator = new CatalogIndexCoordinator(
		fixture.app,
		new MemoCatalogService(store),
		new DiaryMemoParser(async (bytes) => sha256(bytes)),
		async () => ({ folder: "Journal", format: "YYYY-MM-DD" }),
		{ fullAuditIntervalMs: 10_000 },
	);
	try {
		coordinator.start(fixture.owner);
		await coordinator.initialize();
		await coordinator.waitForIdle();
		const first = fixture.file("Journal/2026-08-09.md");
		const second = fixture.file("Journal/2026-08-10.md");
		assert.ok(first !== null && second !== null);
		const children = [first, second];
		const folder = Object.assign(new TFolder(), { path: "Journal", children });

		fixture.removeFile("Journal/2026-08-09.md");
		fixture.removeFile("Journal/2026-08-10.md");
		fixture.emitVaultEvent("delete", folder);

		await waitUntil(async () => (await store.listFiles()).length === 0);
	} finally {
		fixture.unload();
	}
});

test("MOBILE-BACKGROUND-RESUME：隐藏时保存 checkpoint，重启只续跑 pending paths", async () => {
	await ensureObsidianStub();
	const {
		CatalogIndexCoordinator,
		CATALOG_CHECKPOINT_META_KEY,
	} = await import("../src/services/CatalogIndexCoordinator");
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
	const firstCoordinator = new CatalogIndexCoordinator(
		first.app,
		new MemoCatalogService(store),
		new DiaryMemoParser(async (bytes) => sha256(bytes)),
		async () => ({ folder: "Journal", format: "YYYY-MM-DD" }),
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
	const secondCoordinator = new CatalogIndexCoordinator(
		second.app,
		new MemoCatalogService(store),
		new DiaryMemoParser(async (bytes) => sha256(bytes)),
		async () => ({ folder: "Journal", format: "YYYY-MM-DD" }),
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

test("Catalog 持久层不可用时从 Daily 渐进扫描并展示全部 observation", async () => {
	await ensureObsidianStub();
	const { CatalogIndexCoordinator } = await import("../src/services/CatalogIndexCoordinator");
	const { CatalogReadService } = await import("../src/services/CatalogReadService");
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
	const coordinator = new CatalogIndexCoordinator(
		fixture.app,
		catalog,
		new DiaryMemoParser(async (bytes) => sha256(bytes)),
		async () => ({ folder: "Journal", format: "YYYY-MM-DD" }),
		{ fullAuditIntervalMs: 0, now: () => new Date(2026, 7, 21).getTime() },
	);
	const readService = new CatalogReadService({
		catalog,
		identityLedger: {
			getRevision: () => "identity-absent",
			getStatus: () => "absent",
			getSnapshot: () => ({
				revision: "identity-absent",
				eventCount: 0,
				memos: {},
				pendingIntents: [],
				quarantinedEventIds: [],
			}),
			resolveObservation: () => null,
			resolveObservationState: () => ({ kind: "unbound" }),
			getSourceMemoId: () => null,
			getCreatedAt: () => null,
			getReviewState: () => ({ reviewCount: 0, lastReviewedAt: null }),
		},
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
	const { CatalogIndexCoordinator } = await import("../src/services/CatalogIndexCoordinator");
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
	const coordinator = new CatalogIndexCoordinator(
		fixture.app,
		new MemoCatalogService(store),
		parser,
		async () => ({ folder: "Journal", format: "YYYY-MM-DD" }),
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

test("解析中的旧扫描结果不能覆盖同路径刚完成的 Daily 直接提交", async () => {
	await ensureObsidianStub();
	const { TFile } = await import("obsidian");
	const { CatalogIndexCoordinator } = await import("../src/services/CatalogIndexCoordinator");
	const { DiaryMemoParser } = await import("../src/services/DiaryMemoParser");
	const { MemoCatalogService } = await import("../src/services/MemoCatalogService");
	const { InMemoryMemoCatalogStore } = await import("../src/services/MemoCatalogStore");
	const sourcePath = "Journal/2026-08-22.md";
	const beforeContent = "## Memos\n- 09:00 before\n";
	const afterContent = "## Memos\n- 09:00 after\n";
	const fixture = await createCoordinatorFixture([
		{ path: sourcePath, content: beforeContent, mtime: 10 },
	]);
	let startFirstDigest = (): void => undefined;
	const firstDigestStarted = new Promise<void>((resolve) => { startFirstDigest = resolve; });
	let releaseFirstDigest = (): void => undefined;
	const firstDigestBlocked = new Promise<void>((resolve) => { releaseFirstDigest = resolve; });
	let digestCount = 0;
	const parser = new DiaryMemoParser(async (bytes) => {
		digestCount += 1;
		if (digestCount === 1) {
			startFirstDigest();
			await firstDigestBlocked;
		}
		return sha256(bytes);
	});
	const store = new InMemoryMemoCatalogStore();
	const transitions: CatalogRevisionTransition[] = [];
	const coordinator = new CatalogIndexCoordinator(
		fixture.app,
		new MemoCatalogService(store),
		parser,
		async () => ({ folder: "Journal", format: "YYYY-MM-DD" }),
		{
			fullAuditIntervalMs: 10_000,
			onRevisionTransition: (transition) => { transitions.push(transition); },
		},
	);
	try {
		coordinator.start(fixture.owner);
		await coordinator.initialize();
		await firstDigestStarted;

		fixture.setFile(sourcePath, afterContent, 20);
		const file = fixture.file(sourcePath);
		assert.ok(file instanceof TFile);
		const parsed = parser.parseRevision({
			sourcePath,
			logicalDate: "2026-08-22",
			content: afterContent,
			sourceRevision: await sha256(Buffer.from(afterContent, "utf8")),
		});
		const committed = coordinator.replaceCommittedFile({
			file,
			logicalDate: "2026-08-22",
			content: afterContent,
			parsed,
		});
		releaseFirstDigest();
		await committed;
		await coordinator.waitForIdle();

		assert.deepEqual((await store.query({ limit: 10 })).items.map((item) => item.content), ["after"]);
		assert.equal(transitions.some((transition) =>
			transition.after.observations.some((observation) => observation.content === "before")), false);
	} finally {
		releaseFirstDigest();
		fixture.unload();
	}
});

test("Identity 回调执行期间的直接提交保持连续 revision 链", async () => {
	await ensureObsidianStub();
	const { TFile } = await import("obsidian");
	const { CatalogIndexCoordinator } = await import("../src/services/CatalogIndexCoordinator");
	const { DiaryMemoParser } = await import("../src/services/DiaryMemoParser");
	const { MemoCatalogService } = await import("../src/services/MemoCatalogService");
	const { InMemoryMemoCatalogStore } = await import("../src/services/MemoCatalogStore");
	const sourcePath = "Journal/2026-08-22.md";
	const beforeContent = "## Memos\n- 09:00 before\n";
	const scannedContent = "## Memos\n- 09:00 scanned\n";
	const afterContent = "## Memos\n- 09:00 after\n";
	const fixture = await createCoordinatorFixture([
		{ path: sourcePath, content: beforeContent, mtime: 10 },
	]);
	let markTransitionStarted = (): void => undefined;
	const transitionStarted = new Promise<void>((resolve) => { markTransitionStarted = resolve; });
	let releaseTransition = (): void => undefined;
	const transitionBlocked = new Promise<void>((resolve) => { releaseTransition = resolve; });
	const transitions: CatalogRevisionTransition[] = [];
	const store = new InMemoryMemoCatalogStore();
	const parser = new DiaryMemoParser(async (bytes) => sha256(bytes));
	const coordinator = new CatalogIndexCoordinator(
		fixture.app,
		new MemoCatalogService(store),
		parser,
		async () => ({ folder: "Journal", format: "YYYY-MM-DD" }),
		{
			fullAuditIntervalMs: 10_000,
			onRevisionTransition: async (transition) => {
				if (transitions.length === 0) {
					markTransitionStarted();
					await transitionBlocked;
				}
				transitions.push(transition);
			},
		},
	);
	try {
		coordinator.start(fixture.owner);
		await coordinator.initialize();
		await coordinator.waitForIdle();

		fixture.setFile(sourcePath, scannedContent, 20);
		const scannedFile = fixture.file(sourcePath);
		assert.ok(scannedFile instanceof TFile);
		fixture.emitVaultEvent("modify", scannedFile);
		await transitionStarted;

		fixture.setFile(sourcePath, afterContent, 30);
		const committedFile = fixture.file(sourcePath);
		assert.ok(committedFile instanceof TFile);
		const parsed = parser.parseRevision({
			sourcePath,
			logicalDate: "2026-08-22",
			content: afterContent,
			sourceRevision: await sha256(Buffer.from(afterContent, "utf8")),
		});
		const committed = coordinator.replaceCommittedFile({
			file: committedFile,
			logicalDate: "2026-08-22",
			content: afterContent,
			parsed,
		});
		releaseTransition();
		await committed;
		await coordinator.waitForIdle();

		assert.deepEqual(transitions.map((transition) => ({
			before: transition.before?.observations.map((item) => item.content) ?? [],
			after: transition.after.observations.map((item) => item.content),
		})), [
			{ before: ["before"], after: ["scanned"] },
			{ before: ["scanned"], after: ["after"] },
		]);
		assert.deepEqual((await store.query({ limit: 10 })).items.map((item) => item.content), ["after"]);
	} finally {
		releaseTransition();
		fixture.unload();
	}
});

test("普通刷新加入当前扫描且进度持续上报，不清空本机 Catalog", async () => {
	await ensureObsidianStub();
	const { CatalogIndexCoordinator } = await import("../src/services/CatalogIndexCoordinator");
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
	const coordinator = new CatalogIndexCoordinator(
		fixture.app,
		new MemoCatalogService(store),
		new DiaryMemoParser(async (bytes) => sha256(bytes)),
		async () => ({ folder: "Journal", format: "YYYY-MM-DD" }),
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

test("手动刷新按文件 revision 返回真实 added、updated、deleted 和 failed delta", async () => {
	await ensureObsidianStub();
	const { CatalogIndexCoordinator } = await import("../src/services/CatalogIndexCoordinator");
	const { DiaryMemoParser } = await import("../src/services/DiaryMemoParser");
	const { MemoCatalogService } = await import("../src/services/MemoCatalogService");
	const { InMemoryMemoCatalogStore } = await import("../src/services/MemoCatalogStore");
	const fixture = await createCoordinatorFixture([
		{ path: "Journal/2026-08-20.md", content: "## Memos\n- 09:00 update me", mtime: 10 },
		{ path: "Journal/2026-08-21.md", content: "## Memos\n- 09:00 delete me", mtime: 10 },
	]);
	const coordinator = new CatalogIndexCoordinator(
		fixture.app,
		new MemoCatalogService(new InMemoryMemoCatalogStore()),
		new DiaryMemoParser(async (bytes) => sha256(bytes)),
		async () => ({ folder: "Journal", format: "YYYY-MM-DD" }),
		{ fullAuditIntervalMs: 60_000, now: () => new Date(2026, 7, 22).getTime() },
	);
	try {
		coordinator.start(fixture.owner);
		await coordinator.initialize();
		await coordinator.waitForIdle();

		const unchanged = await coordinator.refreshLocalCatalog();
		assert.deepEqual(unchanged, {
			scannedFiles: 0,
			created: 0,
			updated: 0,
			deleted: 0,
			skipped: 2,
			failed: 0,
			errors: [],
		});

		fixture.setFile("Journal/2026-08-20.md", "## Memos\n- 09:00 updated", 20);
		fixture.removeFile("Journal/2026-08-21.md");
		fixture.setFile("Journal/2026-08-22.md", "## Memos\n- 09:00 added", 20);
		const changed = await coordinator.refreshLocalCatalog();

		assert.equal(changed.created, 1);
		assert.equal(changed.updated, 1);
		assert.equal(changed.deleted, 1);
		assert.equal(changed.failed, 0);
		assert.equal(changed.scannedFiles, 2);

		fixture.setFile("Journal/2026-08-23.md", "## Memos\n- 09:00 unreadable", 30);
		fixture.failRead("Journal/2026-08-23.md");
		const failed = await coordinator.refreshLocalCatalog();
		assert.equal(failed.failed, 1);
		assert.equal(failed.errors.length, 1);
		assert.match(failed.errors[0] ?? "", /read failed/u);
	} finally {
		fixture.unload();
	}
});

test("插件 unload 会取消 active 扫描，且不再发起 Catalog 持久化", async () => {
	await ensureObsidianStub();
	const {
		CatalogIndexCoordinator,
		CATALOG_CHECKPOINT_META_KEY,
	} = await import("../src/services/CatalogIndexCoordinator");
	const { DiaryMemoParser } = await import("../src/services/DiaryMemoParser");
	const { MemoCatalogService } = await import("../src/services/MemoCatalogService");
	const { InMemoryMemoCatalogStore } = await import("../src/services/MemoCatalogStore");
	const fixture = await createCoordinatorFixture([
		{ path: "Journal/2026-08-22.md", content: "## Memos\n- 09:00 pending", mtime: 10 },
	]);
	const releaseRead = fixture.blockRead("Journal/2026-08-22.md");
	const store = new InMemoryMemoCatalogStore();
	let replacementCount = 0;
	let unloaded = false;
	let postUnloadPersistenceCount = 0;
	const replace = store.replaceFilePartitions.bind(store);
	store.replaceFilePartitions = async (partitions) => {
		if (unloaded) postUnloadPersistenceCount += 1;
		replacementCount += partitions.length;
		return replace(partitions);
	};
	const setCoverage = store.setCoverage.bind(store);
	store.setCoverage = async (coverage) => {
		if (unloaded) postUnloadPersistenceCount += 1;
		return setCoverage(coverage);
	};
	const setMeta = store.setMeta.bind(store);
	store.setMeta = async <T>(key: string, value: T) => {
		if (unloaded) postUnloadPersistenceCount += 1;
		return setMeta(key, value);
	};
	const saveScanProgress = store.saveScanProgress.bind(store);
	store.saveScanProgress = async (coverage, metadata) => {
		if (unloaded) postUnloadPersistenceCount += 1;
		return saveScanProgress(coverage, metadata);
	};
	const workQueue = new LowPriorityWorkQueue(() => ({
		setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay) as unknown as number,
		clearTimeout: (timer) => globalThis.clearTimeout(timer as unknown as NodeJS.Timeout),
	}));
	workQueue.start(fixture.owner);
	const coordinator = new CatalogIndexCoordinator(
		fixture.app,
		new MemoCatalogService(store),
		new DiaryMemoParser(async (bytes) => sha256(bytes)),
		async () => ({ folder: "Journal", format: "YYYY-MM-DD" }),
		{ workQueue },
	);
	coordinator.start(fixture.owner);
	await coordinator.initialize();
	await waitUntil(async () => fixture.readCount() === 1);

	unloaded = true;
	fixture.unload();
	releaseRead();
	await coordinator.waitForIdle();

	assert.equal(replacementCount, 0);
	assert.equal(postUnloadPersistenceCount, 0);
	assert.equal(fixture.timerCount(), 0);
	assert.deepEqual(
		(await store.getMeta<{ pendingPaths: string[] }>(CATALOG_CHECKPOINT_META_KEY))?.pendingPaths,
		["Journal/2026-08-22.md"],
	);
});

test("Catalog inventory reconcile 进入统一低优先级队列并按预算让出事件循环", async () => {
	await ensureObsidianStub();
	const { CatalogIndexCoordinator } = await import("../src/services/CatalogIndexCoordinator");
	const { DiaryMemoParser } = await import("../src/services/DiaryMemoParser");
	const { MemoCatalogService } = await import("../src/services/MemoCatalogService");
	const { InMemoryMemoCatalogStore } = await import("../src/services/MemoCatalogStore");
	const fixture = await createCoordinatorFixture(Array.from({ length: 4 }, (_, index) => ({
		path: `Journal/2026-08-${String(index + 1).padStart(2, "0")}.md`,
		content: `- 09:00 memo ${index}\n`,
		mtime: index + 1,
	})));
	const priorities: number[] = [];
	let insideQueue = false;
	let yieldCount = 0;
	const coordinator = new CatalogIndexCoordinator(
		fixture.app,
		new MemoCatalogService(new InMemoryMemoCatalogStore()),
		new DiaryMemoParser(async (bytes) => sha256(bytes)),
		async () => {
			assert.equal(insideQueue, true);
			return { folder: "Journal", format: "YYYY-MM-DD" };
		},
		{
			sliceBudgetMs: 0,
			yieldControl: async () => { yieldCount += 1; },
			workQueue: {
				signal: new AbortController().signal,
				run: async <T>(priority: number, action: () => Promise<T>): Promise<T> => {
					priorities.push(priority);
					insideQueue = true;
					try {
						return await action();
					} finally {
						insideQueue = false;
					}
				},
			},
		},
	);
	try {
		coordinator.start(fixture.owner);
		await coordinator.initialize();

		assert.deepEqual(priorities, [20]);
		assert.ok(yieldCount >= 4);
	} finally {
		fixture.unload();
	}
});

test("101 个 Daily 在短 slice 下每个只解析一次，checkpoint 仍按批次持久化", async () => {
	await ensureObsidianStub();
	const {
		CatalogIndexCoordinator,
		CATALOG_CHECKPOINT_META_KEY,
	} = await import("../src/services/CatalogIndexCoordinator");
	const { DiaryMemoParser } = await import("../src/services/DiaryMemoParser");
	const { MemoCatalogService } = await import("../src/services/MemoCatalogService");
	const { InMemoryMemoCatalogStore } = await import("../src/services/MemoCatalogStore");
	const files = Array.from({ length: 101 }, (_, index) => {
		const year = 2020 + Math.floor(index / 336);
		const yearDay = index % 336;
		const month = Math.floor(yearDay / 28) + 1;
		const day = yearDay % 28 + 1;
		const logicalDate = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
		return {
			path: `Journal/${logicalDate}.md`,
			content: `## Memos\n- 09:00 ${index}`,
			mtime: 10,
		};
	});
	const fixture = await createCoordinatorFixture(files);
	const store = new InMemoryMemoCatalogStore();
	let checkpointWriteCount = 0;
	const saveScanProgress = store.saveScanProgress.bind(store);
	store.saveScanProgress = async (coverage, metadata) => {
		if (metadata.some((entry) => entry.key === CATALOG_CHECKPOINT_META_KEY)) checkpointWriteCount += 1;
		await saveScanProgress(coverage, metadata);
	};
	const coordinator = new CatalogIndexCoordinator(
		fixture.app,
		new MemoCatalogService(store),
		new DiaryMemoParser(async (bytes) => sha256(bytes)),
		async () => ({ folder: "Journal", format: "YYYY-MM-DD" }),
		{
			now: () => 1_000,
			fullAuditIntervalMs: 10_000,
			sliceBudgetMs: 0,
			checkpointBatchSize: 25,
			checkpointIntervalMs: 60_000,
			yieldControl: async () => undefined,
		},
	);
	try {
		coordinator.start(fixture.owner);
		await coordinator.initialize();
		await coordinator.waitForIdle();

		assert.equal(fixture.readCount(), files.length);
		assert.ok(checkpointWriteCount <= 6, `checkpoint 写入次数过多：${checkpointWriteCount}`);
		assert.equal((await store.getCoverage()).kind, "complete");
	} finally {
		fixture.unload();
	}
});

test("Catalog rebuild 只重建本机缓存，不修改 Daily、Monthly 或共享数据", async () => {
	await ensureObsidianStub();
	const { CatalogIndexCoordinator } = await import("../src/services/CatalogIndexCoordinator");
	const { DiaryMemoParser } = await import("../src/services/DiaryMemoParser");
	const { LEGACY_MIGRATION_COMPLETION_META_KEY } = await import("../src/services/LegacyIndexMigrationService");
	const { MemoCatalogService } = await import("../src/services/MemoCatalogService");
	const { InMemoryMemoCatalogStore } = await import("../src/services/MemoCatalogStore");
	const { MONTHLY_PROJECTION_CHECKPOINT_META_KEY } = await import("../src/services/MonthlyProjectionCoordinator");
	const fixture = await createCoordinatorFixture([
		{ path: "Journal/2026-08-10.md", content: "## Memos\n- 09:00 rebuild only\n", mtime: 10 },
		{ path: "Memos/2026-08.md", content: "monthly bytes\n", mtime: 10 },
		{ path: "Memos/_knomo-data/sentinel.md", content: "shared bytes\n", mtime: 10 },
	]);
	const store = new InMemoryMemoCatalogStore();
	const legacyCompletion = { sourceId: "legacy-index", sourceRevision: "legacy-revision" };
	const monthlyCheckpoint = {
		version: 1,
		pending: [{ period: "2026-08", reason: "catalog" }],
		updatedAt: 123,
	};
	await store.setMeta(LEGACY_MIGRATION_COMPLETION_META_KEY, legacyCompletion);
	await store.setMeta(MONTHLY_PROJECTION_CHECKPOINT_META_KEY, monthlyCheckpoint);
	await store.setMeta("catalog-derived-sentinel", { stale: true });
	const coordinator = new CatalogIndexCoordinator(
		fixture.app,
		new MemoCatalogService(store),
		new DiaryMemoParser(async (bytes) => sha256(bytes)),
		async () => ({ folder: "Journal", format: "YYYY-MM-DD" }),
		{
			fullAuditIntervalMs: 0,
			now: () => new Date(2026, 7, 10).getTime(),
			preserveMetaKeysOnRebuild: [
				LEGACY_MIGRATION_COMPLETION_META_KEY,
				MONTHLY_PROJECTION_CHECKPOINT_META_KEY,
			],
		},
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
		assert.deepEqual(await store.getMeta(LEGACY_MIGRATION_COMPLETION_META_KEY), legacyCompletion);
		assert.deepEqual(await store.getMeta(MONTHLY_PROJECTION_CHECKPOINT_META_KEY), monthlyCheckpoint);
		assert.equal(await store.getMeta("catalog-derived-sentinel"), null);
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
	const vaultListeners = new Map<string, Array<(...args: unknown[]) => void>>();
	const cleanupCallbacks: Array<() => void> = [];
	const domListeners = new Map<string, () => void>();
	const failedReads = new Set<string>();
	const readBlockers = new Map<string, { promise: Promise<void>; resolve: () => void }>();
	const timers = new Set<NodeJS.Timeout>();
	const doc = { visibilityState: "visible" };
	let reads = 0;
	let inventoryReads = 0;
	const files = entries.map((entry) => Object.assign(new TFile(), {
		path: entry.path,
		extension: "md",
		stat: { mtime: entry.mtime, size: Buffer.byteLength(entry.content) },
	}));
	const contentByPath = new Map(entries.map((entry) => [entry.path, Buffer.from(entry.content, "utf8")]));
	const app = {
		vault: {
			on: (name: string, callback: (...args: unknown[]) => void) => {
				registeredVaultEvents.push(name);
				const listeners = vaultListeners.get(name) ?? [];
				listeners.push(callback);
				vaultListeners.set(name, listeners);
				return {};
			},
			getMarkdownFiles: () => {
				inventoryReads += 1;
				return files;
			},
			getAbstractFileByPath: (path: string) => files.find((file) => file.path === path) ?? null,
			readBinary: async (file: { path: string }) => {
				reads += 1;
				if (hideAfterFirstRead && reads === 1) {
					doc.visibilityState = "hidden";
					domListeners.get("visibilitychange")?.();
				}
				await readBlockers.get(file.path)?.promise;
				if (failedReads.has(file.path)) throw new Error(`read failed: ${file.path}`);
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
					setTimeout: (callback: () => void, delay: number) => {
						let timer: NodeJS.Timeout;
						timer = globalThis.setTimeout(() => {
							timers.delete(timer);
							callback();
						}, delay);
						timers.add(timer);
						return timer as unknown as number;
					},
					clearTimeout: (timerId: number) => {
						const timer = timerId as unknown as NodeJS.Timeout;
						timers.delete(timer);
						globalThis.clearTimeout(timer);
					},
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
		inventoryCount: () => inventoryReads,
		timerCount: () => timers.size,
		file: (path: string) => files.find((file) => file.path === path) ?? null,
		emitVaultEvent: (name: string, ...args: unknown[]) => {
			for (const listener of vaultListeners.get(name) ?? []) listener(...args);
		},
		setFile: (path: string, content: string, mtime: number) => {
			let file = files.find((item) => item.path === path);
			if (file === undefined) {
				file = Object.assign(new TFile(), { path, extension: "md", stat: { mtime, size: 0 } });
				files.push(file);
			}
			file.stat = { ctime: mtime, mtime, size: Buffer.byteLength(content) };
			contentByPath.set(path, Buffer.from(content, "utf8"));
		},
		removeFile: (path: string) => {
			const index = files.findIndex((file) => file.path === path);
			if (index !== -1) files.splice(index, 1);
			contentByPath.delete(path);
		},
		renameFile: (oldPath: string, newPath: string, mtime: number) => {
			const file = files.find((item) => item.path === oldPath);
			if (file === undefined) throw new Error(`missing file: ${oldPath}`);
			const content = contentByPath.get(oldPath) ?? Buffer.alloc(0);
			file.path = newPath;
			file.name = newPath.split("/").pop() ?? "";
			const dotIndex = file.name.lastIndexOf(".");
			file.extension = dotIndex === -1 ? "" : file.name.slice(dotIndex + 1);
			file.basename = dotIndex === -1 ? file.name : file.name.slice(0, dotIndex);
			file.stat = { ctime: mtime, mtime, size: content.byteLength };
			contentByPath.delete(oldPath);
			contentByPath.set(newPath, content);
		},
		failRead: (path: string) => { failedReads.add(path); },
		blockRead: (path: string) => {
			let resolve = (): void => undefined;
			const promise = new Promise<void>((nextResolve) => { resolve = nextResolve; });
			readBlockers.set(path, { promise, resolve });
			return () => {
				readBlockers.delete(path);
				resolve();
			};
		},
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

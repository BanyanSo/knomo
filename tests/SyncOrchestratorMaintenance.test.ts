import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as waitImmediate } from "node:timers/promises";

import type { KnomoSettings } from "../src/types/settings";
import { ensureObsidianStub } from "./helpers/obsidianStub";

test("monthly filename migration waits for active mutations", async () => {
	const { SyncOrchestrator } = await loadSyncOrchestrator();
	const pendingList = createDeferred<never[]>();
	let migrationStarted = false;
	const orchestrator = createOrchestrator(SyncOrchestrator, async () => pendingList.promise);

	const activeMutation = orchestrator.recoverPendingMemoCreates();
	await waitImmediate();
	const migration = orchestrator.runMonthlyMemoFileFormatMigration(async () => {
		migrationStarted = true;
	});
	await waitImmediate();

	assert.equal(migrationStarted, false);
	pendingList.resolve([]);
	await activeMutation;
	await migration;
	assert.equal(migrationStarted, true);
});

test("mutations wait until monthly filename migration finishes", async () => {
	const { SyncOrchestrator } = await loadSyncOrchestrator();
	const finishMigration = createDeferred<void>();
	let pendingListCalls = 0;
	const orchestrator = createOrchestrator(SyncOrchestrator, async () => {
		pendingListCalls += 1;
		return [];
	});

	const migration = orchestrator.runMonthlyMemoFileFormatMigration(async () => {
		await finishMigration.promise;
	});
	await waitImmediate();
	const queuedMutation = orchestrator.recoverPendingMemoCreates();
	await waitImmediate();

	assert.equal(pendingListCalls, 0);
	finishMigration.resolve();
	await migration;
	await queuedMutation;
	assert.equal(pendingListCalls, 1);
});

test("failed monthly filename migration releases queued mutations", async () => {
	const { SyncOrchestrator } = await loadSyncOrchestrator();
	let pendingListCalls = 0;
	const orchestrator = createOrchestrator(SyncOrchestrator, async () => {
		pendingListCalls += 1;
		return [];
	});

	await assert.rejects(
		() => orchestrator.runMonthlyMemoFileFormatMigration(async () => {
			throw new Error("migration failed");
		}),
		/migration failed/,
	);
	await orchestrator.recoverPendingMemoCreates();

	assert.equal(pendingListCalls, 1);
});

test("monthly folder migration waits for active mutations", async () => {
	const { SyncOrchestrator } = await loadSyncOrchestrator();
	const pendingList = createDeferred<never[]>();
	let migrationStarted = false;
	const orchestrator = createOrchestrator(SyncOrchestrator, async () => pendingList.promise);

	const activeMutation = orchestrator.recoverPendingMemoCreates();
	await waitImmediate();
	const migration = orchestrator.runMonthlyMemoFolderMigration(async () => {
		migrationStarted = true;
	});
	await waitImmediate();

	assert.equal(migrationStarted, false);
	pendingList.resolve([]);
	await activeMutation;
	await migration;
	assert.equal(migrationStarted, true);
});

test("monthly folder migration recovers pending creates before moving files", async () => {
	const { SyncOrchestrator } = await loadSyncOrchestrator();
	const pendingList = createDeferred<never[]>();
	let migrationStarted = false;
	const orchestrator = createOrchestrator(SyncOrchestrator, async () => pendingList.promise);

	const migration = orchestrator.runMonthlyMemoFolderMigration(async () => {
		migrationStarted = true;
	});
	await waitImmediate();

	assert.equal(migrationStarted, false);
	pendingList.resolve([]);
	await migration;
	assert.equal(migrationStarted, true);
});

test("monthly folder migration stops when pending create recovery fails", async () => {
	const { SyncOrchestrator } = await loadSyncOrchestrator();
	let migrationStarted = false;
	const orchestrator = createOrchestrator(SyncOrchestrator, async () => {
		throw new Error("pending recovery failed");
	});

	await assert.rejects(
		() => orchestrator.runMonthlyMemoFolderMigration(async () => {
			migrationStarted = true;
		}),
		/pending recovery failed/,
	);

	assert.equal(migrationStarted, false);
});

test("mutations wait until monthly folder migration finishes", async () => {
	const { SyncOrchestrator } = await loadSyncOrchestrator();
	const finishMigration = createDeferred<void>();
	let pendingListCalls = 0;
	const orchestrator = createOrchestrator(SyncOrchestrator, async () => {
		pendingListCalls += 1;
		return [];
	});

	const migration = orchestrator.runMonthlyMemoFolderMigration(async () => {
		await finishMigration.promise;
	});
	await waitImmediate();
	const queuedMutation = orchestrator.recoverPendingMemoCreates();
	await waitImmediate();

	assert.equal(pendingListCalls, 1);
	finishMigration.resolve();
	await migration;
	await queuedMutation;
	assert.equal(pendingListCalls, 2);
});

function createOrchestrator(
	SyncOrchestrator: typeof import("../src/services/SyncOrchestrator").SyncOrchestrator,
	listPending: () => Promise<never[]>,
): InstanceType<typeof SyncOrchestrator> {
	return new SyncOrchestrator(
		{} as never,
		() => createSettings(),
		{} as never,
		{} as never,
		{} as never,
		{} as never,
		undefined,
		{
			list: listPending,
			add: async () => undefined,
			update: async () => undefined,
			remove: async () => undefined,
		},
	);
}

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
}

function createDeferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((promiseResolve) => {
		resolve = promiseResolve;
	});
	return { promise, resolve };
}

function createSettings(): KnomoSettings {
	return {
		settingsVersion: 2,
		dailyHeading: "## Knomo",
		dailyInsertPosition: "bottom",
		memoTimeFormat: "HH:mm:ss",
		monthlyMemoFolder: "Memos",
		monthlyMemoFileFormat: "Memos-YYYY-MM.md",
		monthlyDateHeadingFormat: "## YYYY-MM-DD",
		monthlyDateOrder: "asc",
		legacyDailyHeadings: [],
		mobileCompactMode: "auto",
		syncDebounceMs: 1000,
		desktopSidebarWidth: 248,
		desktopSidebarCollapsed: false,
		excludeMonthlyMemosFromObsidian: false,
		managedObsidianExcludeRuleOwned: false,
		managedSystemFolderExcludeRuleOwned: false,
		pinnedTags: [],
	};
}

async function loadSyncOrchestrator(): Promise<typeof import("../src/services/SyncOrchestrator")> {
	await ensureObsidianStub();
	return import("../src/services/SyncOrchestrator");
}

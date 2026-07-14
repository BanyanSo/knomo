import test from "node:test";
import assert from "node:assert/strict";

import type { MemoRecord } from "../src/types/memo";
import type { KnomoSettings } from "../src/types/settings";
import { hashMemoContent, hashText } from "../src/utils/hash";
import { ensureObsidianStub } from "./helpers/obsidianStub";

test("maintains derived shards only while the feature is enabled", async () => {
	const enabled = { value: false };
	const { service, contents } = await createHarness(enabled);
	const memo = createMemo("memo-1", "回看 @2026-07-20");

	assert.deepEqual(await service.syncMemoRecords(null, memo), {
		status: "disabled",
		dates: ["2026-07-20"],
	});
	assert.equal(contents.size, 0);

	enabled.value = true;
	assert.deepEqual(await service.syncMemoRecords(null, memo), {
		status: "synced",
		dates: ["2026-07-20"],
	});
	assert.equal(contents.has("Memos/_knomo-system/indexes/time-buoy/time-buoy-2026-07.json"), true);
});

test("returns a non-blocking failure and marks repair pending for corrupt shards", async () => {
	const { service } = await createHarness({ value: true }, {
		"Memos/_knomo-system/indexes/time-buoy/time-buoy-2026-07.json": "{",
	});
	const outcome = await service.syncMemoRecords(null, createMemo("memo-1", "回看 @2026-07-20"));

	assert.equal(outcome.status, "failed");
	assert.equal(service.hasPendingRepair(), true);
});

test("marks sync side copies as requiring a rebuild", async () => {
	const { service } = await createHarness({ value: true }, {
		"Memos/_knomo-system/indexes/time-buoy/time-buoy-2026-07 conflict.json": "{}",
	});

	assert.equal(service.hasPendingRepair(), true);
	assert.deepEqual((await service.queryDate("2026-07-20")).missingPeriods, ["2026-07"]);
});

test("updates, deletes, and restores derived dates without changing memo identity", async () => {
	const { service, contents } = await createHarness({ value: true });
	const original = createMemo("memo-1", "回看 @2026-07-20 @2026-08-15");
	const updated = { ...createMemo("memo-1", "改到 @2026-09-01"), createdAt: original.createdAt };

	await service.syncMemoRecords(null, original);
	await service.syncMemoRecords(original, updated);
	assert.deepEqual(readDates(contents, "2026-07"), {});
	assert.deepEqual(readDates(contents, "2026-08"), {});
	assert.deepEqual(Object.keys(readDates(contents, "2026-09")["2026-09-01"] ?? {}), ["memo-1"]);

	await service.syncMemoRecords(updated, null);
	assert.deepEqual(readDates(contents, "2026-09"), {});
	await service.syncMemoRecords(null, updated);
	assert.deepEqual(Object.keys(readDates(contents, "2026-09")["2026-09-01"] ?? {}), ["memo-1"]);
});

test("queries all stored Time buoy periods through one complete read", async () => {
	const { service } = await createHarness({ value: true });
	let queryCount = 0;
	let queriedPeriods: readonly string[] = [];
	const internal = service as unknown as {
		indexStore: {
			listStoredPeriods: () => string[];
			listPotentialSyncConflictFiles: () => [];
			loadState: () => Promise<{
				schemaVersion: 1;
				updatedAt: string;
				dirty: false;
				affectedMemoIds: [];
				expectedPeriods: string[];
			}>;
		};
		queryService: { queryAll: (periods: readonly string[]) => Promise<{
			items: [];
			stale: [];
			missingPeriods: [];
			complete: true;
		}> };
	};
	internal.indexStore.listStoredPeriods = () => ["2020-01", "2035-12"];
	internal.indexStore.listPotentialSyncConflictFiles = () => [];
	internal.indexStore.loadState = async () => ({
		schemaVersion: 1,
		updatedAt: "2026-07-11T00:00:00.000Z",
		dirty: false,
		affectedMemoIds: [],
		expectedPeriods: ["2020-01", "2035-12"],
	});
	internal.queryService.queryAll = async (periods) => {
		queryCount += 1;
		queriedPeriods = periods;
		return { items: [], stale: [], missingPeriods: [], complete: true };
	};

	const result = await service.queryAll();

	assert.equal(queryCount, 1);
	assert.deepEqual(queriedPeriods, ["2020-01", "2035-12"]);
	assert.equal(result.complete, true);
});

test("allows memo maintenance during rebuild and replays it before completion", async () => {
	const { service } = await createHarness({ value: true });
	let finishCandidateBuild: () => void = () => undefined;
	const appliedMemoIds: string[] = [];
	const internal = service as unknown as {
		rebuildService: { rebuild: () => Promise<{ status: "completed"; total: number; indexed: number; skipped: number; periods: string[] }> };
		indexStore: { applyMemoChange: (_folder: string, change: { memoId: string }) => Promise<void> };
	};
	internal.rebuildService.rebuild = async () => {
		await new Promise<void>((resolve) => {
			finishCandidateBuild = resolve;
		});
		return { status: "completed", total: 0, indexed: 0, skipped: 0, periods: [] };
	};
	internal.indexStore.applyMemoChange = async (_folder, change) => {
		appliedMemoIds.push(change.memoId);
	};

	const rebuilding = service.rebuild();
	await Promise.resolve();
	const maintenance = await service.syncMemoRecords(null, createMemo("memo-during-rebuild", "回看 @2026-07-20"));
	assert.equal(maintenance.status, "synced");
	assert.deepEqual(appliedMemoIds, ["memo-during-rebuild"]);
	finishCandidateBuild();
	await rebuilding;

	assert.deepEqual(appliedMemoIds, ["memo-during-rebuild", "memo-during-rebuild"]);
});

test("does not rewrite shards when memo content changes but buoy dates do not", async () => {
	const { service, processedPaths } = await createHarness({ value: true });
	const original = createMemo("memo-1", "回看 @2026-07-20");
	const changed = {
		...createMemo("memo-1", "已完成回看 @2026-07-20"),
		createdAt: original.createdAt,
	};

	await service.syncMemoRecords(null, original);
	const shardPath = "Memos/_knomo-system/indexes/time-buoy/time-buoy-2026-07.json";
	const writesBefore = processedPaths.filter((path) => path === shardPath).length;
	await service.syncMemoRecords(original, changed);

	assert.equal(processedPaths.filter((path) => path === shardPath).length, writesBefore);
});

test("returns incomplete when an expected shard is missing", async () => {
	const statePath = "Memos/_knomo-system/indexes/time-buoy/time-buoy-state.json";
	const { service } = await createHarness({ value: true }, {
		[statePath]: createState(false, ["2026-07"]),
	});

	const result = await service.queryAll();

	assert.equal(result.complete, false);
	assert.deepEqual(result.missingPeriods, ["2026-07"]);
});

test("keeps a failed shard mutation dirty across service restart", async () => {
	const shardPath = "Memos/_knomo-system/indexes/time-buoy/time-buoy-2026-07.json";
	const harness = await createHarness({ value: true }, {}, shardPath);

	const outcome = await harness.service.syncMemoRecords(null, createMemo("memo-1", "回看 @2026-07-20"));
	assert.equal(outcome.status, "failed");
	const state = JSON.parse(harness.contents.get(
		"Memos/_knomo-system/indexes/time-buoy/time-buoy-state.json",
	) ?? "{}") as { dirty?: boolean; affectedMemoIds?: string[]; expectedPeriods?: string[] };
	assert.equal(state.dirty, true);
	assert.deepEqual(state.affectedMemoIds, ["memo-1"]);
	assert.deepEqual(state.expectedPeriods, ["2026-07"]);

	const restarted = harness.createService();
	assert.equal((await restarted.queryAll()).complete, false);
});

test("merges failed retries from the earliest previous dates to the latest next dates", async () => {
	const { service } = await createHarness({ value: true });
	const internal = service as unknown as {
		indexStore: { applyMemoChange: () => Promise<void> };
		pendingChanges: Map<string, {
			buoyRevision: string;
			previousDates: readonly string[];
			nextDates: readonly string[];
		}>;
	};
	internal.indexStore.applyMemoChange = async () => {
		throw new Error("simulated write failure");
	};
	const july = createMemo("memo-1", "@2026-07-20");
	const august = { ...createMemo("memo-1", "@2026-08-20"), createdAt: july.createdAt };
	const september = { ...createMemo("memo-1", "@2026-09-20"), createdAt: july.createdAt };

	await service.syncMemoRecords(july, august);
	await service.syncMemoRecords(august, september);

	assert.deepEqual(internal.pendingChanges.get("memo-1"), {
		memoId: "memo-1",
		sourcePeriod: "2026-05",
		buoyRevision: internal.pendingChanges.get("memo-1")?.buoyRevision,
		previousDates: ["2026-07-20"],
		nextDates: ["2026-09-20"],
	});
});

test("detects dirty or unreadable persisted state before startup scanning", async () => {
	const statePath = "Memos/_knomo-system/indexes/time-buoy/time-buoy-state.json";
	const dirty = await createHarness({ value: true }, {
		[statePath]: createState(true, []),
	});
	const corrupt = await createHarness({ value: true }, {
		[statePath]: "{",
	});
	const clean = await createHarness({ value: true });

	assert.equal(await dirty.service.needsStartupRebuild(), true);
	assert.equal(await corrupt.service.needsStartupRebuild(), true);
	assert.equal(await clean.service.needsStartupRebuild(), false);
});

test("does not clear a pre-existing dirty state after retrying one incremental change", async () => {
	const statePath = "Memos/_knomo-system/indexes/time-buoy/time-buoy-state.json";
	const { service, contents } = await createHarness({ value: true }, {
		[statePath]: createState(true, []),
	});
	const internal = service as unknown as {
		indexStore: { applyMemoChange: () => Promise<void> };
	};
	let attempts = 0;
	internal.indexStore.applyMemoChange = async () => {
		attempts += 1;
		if (attempts === 1) {
			throw new Error("simulated write failure");
		}
	};

	assert.equal((await service.syncMemoRecords(null, createMemo("memo-1", "@2026-07-20"))).status, "failed");
	await new Promise<void>((resolve) => setImmediate(resolve));

	const state = JSON.parse(contents.get(statePath) ?? "{}") as { dirty?: boolean };
	assert.equal(attempts, 2);
	assert.equal(state.dirty, true);
	assert.equal(service.hasPendingRepair(), true);
});

async function createHarness(
	enabled: { value: boolean },
	initialFiles: Record<string, string> = {},
	failProcessPath: string | null = null,
) {
	await ensureObsidianStub();
	const { TFile, TFolder } = await import("obsidian");
	const { TimeBuoyService } = await import("../src/services/TimeBuoyService");
	const files = new Map<string, InstanceType<typeof TFile> | InstanceType<typeof TFolder>>();
	const contents = new Map<string, string>();
	const processedPaths: string[] = [];
	const ensureFolder = (path: string): InstanceType<typeof TFolder> => {
		const existing = files.get(path);
		if (existing instanceof TFolder) return existing;
		const folder = Object.assign(new TFolder(), { path, name: path.split("/").pop() ?? path, children: [] });
		files.set(path, folder);
		const parentPath = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : null;
		if (parentPath !== null) ensureFolder(parentPath).children.push(folder);
		return folder;
	};
	const addFile = (path: string, content: string): InstanceType<typeof TFile> => {
		const file = Object.assign(new TFile(), {
			path,
			name: path.split("/").pop() ?? path,
			extension: path.split(".").pop() ?? "",
		});
		ensureFolder(path.slice(0, path.lastIndexOf("/"))).children.push(file);
		files.set(path, file);
		contents.set(path, content);
		return file;
	};
	for (const [path, content] of Object.entries(initialFiles)) addFile(path, content);
	const statePath = "Memos/_knomo-system/indexes/time-buoy/time-buoy-state.json";
	if (enabled.value && !contents.has(statePath)) {
		const expectedPeriods = [...contents.keys()]
			.map((path) => /time-buoy-(\d{4}-(?:0[1-9]|1[0-2]))\.json$/.exec(path)?.[1] ?? null)
			.filter((period): period is string => period !== null)
			.sort();
		addFile(statePath, createState(false, expectedPeriods));
	}
	const app = {
		vault: {
			getAbstractFileByPath: (path: string) => files.get(path) ?? null,
			createFolder: async (path: string) => ensureFolder(path),
			create: async (path: string, content: string) => addFile(path, content),
			cachedRead: async (file: { path: string }) => contents.get(file.path) ?? "",
			process: async (file: { path: string }, update: (content: string) => string) => {
				if (file.path === failProcessPath) {
					throw new Error("simulated write failure");
				}
				processedPaths.push(file.path);
				const next = update(contents.get(file.path) ?? "");
				contents.set(file.path, next);
				return next;
			},
		},
		fileManager: { trashFile: async () => undefined },
	};
	const settings = (): KnomoSettings => ({
		settingsVersion: 3,
		dailyHeading: "## Memos",
		dailyInsertPosition: "bottom",
		memoTimeFormat: "HH:mm:ss",
		monthlyMemoFolder: "Memos",
		monthlyMemoFileFormat: "Memos-YYYY-MM.md",
		monthlyDateHeadingFormat: "## YYYY-MM-DD",
		monthlyDateOrder: "asc",
		legacyDailyHeadings: [],
		timeBuoyEnabled: enabled.value,
		mobileCompactMode: "auto",
		syncDebounceMs: 1000,
		desktopSidebarWidth: 248,
		desktopSidebarCollapsed: false,
		excludeMonthlyMemosFromObsidian: false,
		pinnedTags: [],
	});
	const memoIndexStore = { loadExistingPeriods: async () => [] };
	const createService = () => new TimeBuoyService(app as never, settings, memoIndexStore as never);
	return {
		service: createService(),
		createService,
		contents,
		processedPaths,
	};
}

function createMemo(id: string, content: string): MemoRecord {
	const block = `- 08:00:00 ${content}`;
	return {
		id,
		createdAt: "2026-05-10T08:00:00+08:00",
		updatedAt: "2026-05-10T08:00:00+08:00",
		contentSnapshot: content,
		contentHash: hashMemoContent(content),
		status: "active",
		syncStatus: "synced",
		source: "plugin_input",
		version: 1,
		tags: [],
		links: [],
		images: [],
		references: [],
		sourceMemoId: null,
		issue: null,
		lastMarkdownSyncAt: null,
		lastMarkdownSyncSource: null,
		dailyRef: {
			path: "Daily/2026-05-10.md",
			heading: "## Memos",
			sectionType: "heading",
			lastKnownBlock: block,
			lastKnownHash: hashText(block),
			lineNumberHint: 1,
			lastSyncedAt: null,
		},
		monthlyRef: {
			path: "Memos/Memos-2026-05.md",
			dateHeading: "2026-05-10",
			lastKnownBlock: block,
			lastKnownHash: hashText(block),
			lineNumberHint: 1,
			lastSyncedAt: null,
		},
	};
}

function readDates(contents: Map<string, string>, period: string): Record<string, Record<string, unknown>> {
	const path = `Memos/_knomo-system/indexes/time-buoy/time-buoy-${period}.json`;
	const shard = JSON.parse(contents.get(path) ?? "{}") as { dates?: Record<string, Record<string, unknown>> };
	return shard.dates ?? {};
}

function createState(dirty: boolean, expectedPeriods: string[]): string {
	return `${JSON.stringify({
		schemaVersion: 1,
		updatedAt: "2026-07-11T00:00:00.000Z",
		dirty,
		affectedMemoIds: [],
		expectedPeriods,
	}, null, "\t")}\n`;
}

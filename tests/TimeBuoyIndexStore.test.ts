import test from "node:test";
import assert from "node:assert/strict";

import { ensureObsidianStub } from "./helpers/obsidianStub";

test("writes memo dates into target-month shards and removes old dates", async () => {
	const { store, contents } = await createHarness({});
	await store.applyMemoChange("Memos", {
		memoId: "memo-1",
		sourcePeriod: "2026-05",
		buoyRevision: "revision-1",
		previousDates: [],
		nextDates: ["2026-07-20", "2026-08-15", "2026-07-20"],
	});
	assert.deepEqual(Object.keys(readShard(contents, "2026-07").dates), ["2026-07-20"]);
	assert.deepEqual(readShard(contents, "2026-08").dates["2026-08-15"], {
		"memo-1": { sourcePeriod: "2026-05", buoyRevision: "revision-1" },
	});

	await store.applyMemoChange("Memos", {
		memoId: "memo-1",
		sourcePeriod: "2026-05",
		buoyRevision: "revision-2",
		previousDates: ["2026-07-20", "2026-08-15"],
		nextDates: ["2026-09-01"],
	});
	assert.deepEqual(readShard(contents, "2026-07").dates, {});
	assert.deepEqual(readShard(contents, "2026-08").dates, {});
	assert.deepEqual(readShard(contents, "2026-09").dates["2026-09-01"], {
		"memo-1": { sourcePeriod: "2026-05", buoyRevision: "revision-2" },
	});
});

test("serializes concurrent changes to the same target shard", async () => {
	const { store } = await createHarness({});
	await Promise.all([
		store.applyMemoChange("Memos", {
			memoId: "memo-1",
			sourcePeriod: "2026-05",
			buoyRevision: "revision-1",
			previousDates: [],
			nextDates: ["2026-07-20"],
		}),
		store.applyMemoChange("Memos", {
			memoId: "memo-2",
			sourcePeriod: "2026-06",
			buoyRevision: "revision-2",
			previousDates: [],
			nextDates: ["2026-07-20"],
		}),
	]);
	const shard = await store.loadExistingPeriod("Memos", "2026-07");
	assert.deepEqual(Object.keys(shard?.dates["2026-07-20"] ?? {}).sort(), ["memo-1", "memo-2"]);
});

test("marks shard writes so file watching can ignore Knomo changes", async () => {
	const markers: Array<{ path: string; reason: string }> = [];
	const { store } = await createHarness({}, null, {
		mark: (path: string, marker: { reason: string }) => markers.push({ path, reason: marker.reason }),
	});

	await store.applyMemoChange("Memos", {
		memoId: "memo-1",
		sourcePeriod: "2026-05",
		buoyRevision: "revision-1",
		previousDates: [],
		nextDates: ["2026-07-20"],
	});

	assert.deepEqual(markers, [{
		path: "Memos/_knomo-system/indexes/time-buoy/time-buoy-2026-07.json",
		reason: "time_buoy_index",
	}]);
});

test("rejects corrupt and mismatched time buoy shards", async () => {
	const { store } = await createHarness({
		"Memos/_knomo-system/indexes/time-buoy/time-buoy-2026-07.json": "{",
		"Memos/_knomo-system/indexes/time-buoy/time-buoy-2026-08.json": JSON.stringify({
			schemaVersion: 2,
			targetPeriod: "2026-09",
			updatedAt: "now",
			dates: {},
		}),
	});
	await assert.rejects(store.loadExistingPeriod("Memos", "2026-07"), /Invalid time buoy index JSON/);
	await assert.rejects(store.loadExistingPeriod("Memos", "2026-08"), /Invalid time buoy index schema/);
});

test("rejects an empty existing canonical shard", async () => {
	const { store } = await createHarness({
		"Memos/_knomo-system/indexes/time-buoy/time-buoy-2026-07.json": "",
	});

	await assert.rejects(store.loadExistingPeriod("Memos", "2026-07"), /Empty time buoy index/);
});

test("persists dirty memo ids and the expected shard set until rebuild completes", async () => {
	const { store } = await createHarness({});

	await store.markDirty("Memos", ["memo-2"], ["2026-08"]);
	await store.markDirty("Memos", ["memo-1", "memo-2"], ["2026-07"]);
	assert.deepEqual(await store.loadState("Memos"), {
		schemaVersion: 1,
		updatedAt: (await store.loadState("Memos"))?.updatedAt,
		dirty: true,
		affectedMemoIds: ["memo-1", "memo-2"],
		expectedPeriods: ["2026-07", "2026-08"],
	});

	await store.markClean("Memos", ["2026-08", "2026-07", "2026-08"]);
	const clean = await store.loadState("Memos");
	assert.equal(clean?.dirty, false);
	assert.deepEqual(clean?.affectedMemoIds, []);
	assert.deepEqual(clean?.expectedPeriods, ["2026-07", "2026-08"]);
});

test("lists canonical periods and trashes only sync-conflict copies", async () => {
	const { store, trashedPaths } = await createHarness({
		"Memos/_knomo-system/indexes/time-buoy/time-buoy-2026-07.json": "",
		"Memos/_knomo-system/indexes/time-buoy/time-buoy-2026-07 conflict.json": "",
		"Memos/_knomo-system/indexes/time-buoy/time-buoy-2026-08 2.json": "",
		"Memos/_knomo-system/indexes/time-buoy/time-buoy-state conflict.json": "",
	});
	assert.deepEqual(store.listStoredPeriods("Memos"), ["2026-07"]);
	assert.deepEqual(store.listPotentialSyncConflictFiles("Memos").map((file) => file.path), [
		"Memos/_knomo-system/indexes/time-buoy/time-buoy-2026-07 conflict.json",
		"Memos/_knomo-system/indexes/time-buoy/time-buoy-2026-08 2.json",
		"Memos/_knomo-system/indexes/time-buoy/time-buoy-state conflict.json",
	]);
	assert.deepEqual(await store.trashPotentialSyncConflictFiles("Memos"), {
		deleted: 3,
		failed: 0,
		firstFailedPath: null,
	});
	assert.equal(trashedPaths.length, 3);
});

test("does not rewrite a valid shard when rebuilt buoy dates are unchanged", async () => {
	const dates = {
		"2026-07-20": {
			"memo-1": { sourcePeriod: "2026-05", buoyRevision: "revision-1" },
		},
	};
	const path = "Memos/_knomo-system/indexes/time-buoy/time-buoy-2026-07.json";
	const { store, processedPaths } = await createHarness({ [path]: createShard("2026-07", dates) });

	await store.replacePeriodsWithRollback("Memos", new Map([["2026-07", dates]]));

	assert.deepEqual(processedPaths, []);
});

test("restores previously written shards when a batch replacement fails", async () => {
	const julyPath = "Memos/_knomo-system/indexes/time-buoy/time-buoy-2026-07.json";
	const augustPath = "Memos/_knomo-system/indexes/time-buoy/time-buoy-2026-08.json";
	const julyOriginal = createShard("2026-07", {});
	const augustOriginal = createShard("2026-08", {});
	const { store, contents } = await createHarness({
		[julyPath]: julyOriginal,
		[augustPath]: augustOriginal,
	}, augustPath);

	const replacements = new Map<string, Record<string, Record<string, { sourcePeriod: string; buoyRevision: string }>>>([
		["2026-07", { "2026-07-20": { "memo-1": { sourcePeriod: "2026-05", buoyRevision: "revision-1" } } }],
		["2026-08", { "2026-08-20": { "memo-1": { sourcePeriod: "2026-05", buoyRevision: "revision-1" } } }],
	]);
	await assert.rejects(store.replacePeriodsWithRollback("Memos", replacements), /simulated write failure/);

	assert.equal(contents.get(julyPath), julyOriginal);
	assert.equal(contents.get(augustPath), augustOriginal);
});

test("backs up a corrupt canonical shard before a successful rebuild replaces it", async () => {
	const corruptPath = "Memos/_knomo-system/indexes/time-buoy/time-buoy-2026-07.json";
	const { store, contents } = await createHarness({ [corruptPath]: "{" });

	await store.replacePeriodsWithRollback("Memos", new Map([["2026-07", {}]]));

	const backup = [...contents.entries()].find(([path]) => path.includes("/backups/time-buoy-rebuild-"));
	assert.equal(backup?.[1], "{");
	assert.deepEqual(readShard(contents, "2026-07").dates, {});
});

test("backs up a schema v1 shard before migrating it to schema v2", async () => {
	const oldPath = "Memos/_knomo-system/indexes/time-buoy/time-buoy-2026-07.json";
	const oldContent = `${JSON.stringify({
		schemaVersion: 1,
		targetPeriod: "2026-07",
		updatedAt: "2026-07-11T00:00:00.000Z",
		dates: {
			"2026-07-20": {
				"memo-1": { sourcePeriod: "2026-05", contentHash: "old-hash" },
			},
		},
	}, null, "\t")}\n`;
	const { store, contents } = await createHarness({ [oldPath]: oldContent });

	await store.replacePeriodsWithRollback("Memos", new Map([["2026-07", {}]]));

	const backup = [...contents.entries()].find(([path]) => path.includes("/backups/time-buoy-rebuild-"));
	assert.equal(backup?.[1], oldContent);
	assert.equal(JSON.parse(contents.get(oldPath) ?? "{}").schemaVersion, 2);
});

async function createHarness(
	initialFiles: Record<string, string>,
	failProcessPath: string | null = null,
	selfWriteTracker?: { mark: (path: string, marker: { reason: string }) => void },
) {
	await ensureObsidianStub();
	const { TFile, TFolder } = await import("obsidian");
	const { TimeBuoyIndexStore } = await import("../src/services/TimeBuoyIndexStore");
	const files = new Map<string, InstanceType<typeof TFile> | InstanceType<typeof TFolder>>();
	const contents = new Map<string, string>();
	const trashedPaths: string[] = [];
	const processedPaths: string[] = [];
	let processFailurePending = failProcessPath !== null;
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
		const parentPath = path.slice(0, path.lastIndexOf("/"));
		ensureFolder(parentPath).children.push(file);
		files.set(path, file);
		contents.set(path, content);
		return file;
	};
	for (const [path, content] of Object.entries(initialFiles)) addFile(path, content);
	const app = {
		vault: {
			getAbstractFileByPath: (path: string) => files.get(path) ?? null,
			createFolder: async (path: string) => ensureFolder(path),
			create: async (path: string, content: string) => addFile(path, content),
			cachedRead: async (file: { path: string }) => contents.get(file.path) ?? "",
			process: async (file: { path: string }, update: (content: string) => string) => {
				if (processFailurePending && file.path === failProcessPath) {
					processFailurePending = false;
					throw new Error("simulated write failure");
				}
				processedPaths.push(file.path);
				const next = update(contents.get(file.path) ?? "");
				contents.set(file.path, next);
				return next;
			},
		},
		fileManager: {
			trashFile: async (file: { path: string }) => {
				trashedPaths.push(file.path);
				files.delete(file.path);
				contents.delete(file.path);
			},
		},
	};
	return {
		store: new TimeBuoyIndexStore(app as never, selfWriteTracker as never),
		contents,
		trashedPaths,
		processedPaths,
	};
}

function createShard(period: string, dates: Record<string, unknown>): string {
	return `${JSON.stringify({ schemaVersion: 2, targetPeriod: period, updatedAt: "2026-07-11T00:00:00.000Z", dates }, null, "\t")}\n`;
}

function readShard(contents: Map<string, string>, period: string): { dates: Record<string, unknown> } {
	return JSON.parse(contents.get(`Memos/_knomo-system/indexes/time-buoy/time-buoy-${period}.json`) ?? "") as {
		dates: Record<string, unknown>;
	};
}

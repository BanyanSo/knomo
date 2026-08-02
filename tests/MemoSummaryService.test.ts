import test from "node:test";
import assert from "node:assert/strict";

import type { App, TFile as ObsidianTFile } from "obsidian";
import type { MemoIndex } from "../src/types";
import type { MemoRecord } from "../src/types/memo";
import type { MemoIndexStore } from "../src/services/MemoIndexStore";
import { ensureObsidianStub } from "./helpers/obsidianStub";

test("memo summary reuses valid fingerprints and rebuilds only a changed month", async () => {
	await ensureObsidianStub();
	const { TFile } = await import("obsidian");
	const { MemoSummaryService } = await import("../src/services/MemoSummaryService");
	const files = new Map<string, ObsidianTFile>();
	const contents = new Map<string, string>();
	const periods = ["2026-06", "2026-05"];
	for (const [index, period] of periods.entries()) {
		const path = `Memos/_knomo-system/indexes/memo-index-${period}.json`;
		const file = new TFile();
		Object.assign(file, { path, name: path.split("/").at(-1) ?? path, extension: "json" });
		file.stat.mtime = index + 1;
		file.stat.size = 100 + index;
		files.set(path, file);
	}
	const app = {
		vault: {
			getAbstractFileByPath: (path: string) => files.get(path) ?? null,
			cachedRead: async (file: ObsidianTFile) => contents.get(file.path) ?? "",
			createFolder: async () => undefined,
			create: async (path: string, data: string) => {
				const file = new TFile();
				Object.assign(file, { path, name: path.split("/").at(-1) ?? path, extension: "json" });
				files.set(path, file);
				contents.set(path, data);
				return file;
			},
			process: async (file: ObsidianTFile, update: (data: string) => string) => {
				const next = update(contents.get(file.path) ?? "");
				contents.set(file.path, next);
				return next;
			},
		},
	} as unknown as App;
	const indexes: Record<string, MemoIndex> = {
		"2026-06": makeIndex("2026-06", [makeMemo("active", "active", ["Project"])]),
		"2026-05": makeIndex("2026-05", [makeMemo("deleted", "deleted", []), makeMemo("older", "active", ["project/sub"])]),
	};
	const loadedPeriods: string[] = [];
	const store = {
		listStoredPeriods: () => periods,
		getIndexFilePath: (_folder: string, period: string) => `Memos/_knomo-system/indexes/memo-index-${period}.json`,
		loadExistingPeriod: async (_folder: string, period: string) => {
			loadedPeriods.push(period);
			return indexes[period];
		},
	} as unknown as MemoIndexStore;
	const service = new MemoSummaryService(app, () => ({ monthlyMemoFolder: "Memos" }) as never, store);

	const first = await service.ensureReady();
	assert.equal(first.status, "ready");
	assert.equal(first.activeMemoCount, 2);
	assert.equal(first.deletedMemoCount, 1);
	assert.deepEqual([...first.deletedMemoIds], ["deleted"]);
	assert.equal(first.tagCounts.get("project"), 1);
	assert.equal(first.tagCounts.get("project/sub"), 1);
	assert.deepEqual(loadedPeriods, periods);

	loadedPeriods.length = 0;
	await service.ensureReady();
	assert.deepEqual(loadedPeriods, []);

	const changedFile = files.get("Memos/_knomo-system/indexes/memo-index-2026-05.json");
	assert.notEqual(changedFile, undefined);
	changedFile!.stat.mtime += 1;
	await service.ensureReady();
	assert.deepEqual(loadedPeriods, ["2026-05"]);

	loadedPeriods.length = 0;
	indexes["2026-05"] = makeIndex("2026-05", [makeMemo("replacement", "active", ["updated"])]);
	service.invalidatePeriod("2026-05");
	const invalidated = await service.ensureReady();
	assert.deepEqual(loadedPeriods, ["2026-05"]);
	assert.equal(invalidated.tagCounts.get("updated"), 1);
});

function makeIndex(period: string, memos: MemoRecord[]): MemoIndex {
	return {
		schemaVersion: 2,
		period,
		updatedAt: "2026-06-01T00:00:00+08:00",
		memos: Object.fromEntries(memos.map((memo) => [memo.id, memo])),
	};
}

function makeMemo(id: string, status: "active" | "deleted", tags: string[]): MemoRecord {
	return {
		id,
		createdAt: "2026-06-01T08:00:00+08:00",
		updatedAt: "2026-06-01T08:00:00+08:00",
		contentSnapshot: "hello world",
		contentHash: `hash-${id}`,
		status,
		syncStatus: "synced",
		source: "plugin_input",
		version: 1,
		tags,
		links: [],
		images: [],
		references: [],
		sourceMemoId: null,
		issue: null,
		lastMarkdownSyncAt: null,
		lastMarkdownSyncSource: null,
		dailyRef: { path: "Daily/2026-06-01.md", heading: "Memos", sectionType: "heading", lastKnownBlock: id, lastKnownHash: `hash-${id}`, lineNumberHint: 1, lastSyncedAt: null },
		monthlyRef: { path: "Memos/2026-06.md", dateHeading: "2026-06-01", lastKnownBlock: id, lastKnownHash: `hash-${id}`, lineNumberHint: 1, lastSyncedAt: null },
	};
}

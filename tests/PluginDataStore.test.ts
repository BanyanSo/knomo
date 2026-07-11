import test from "node:test";
import assert from "node:assert/strict";
import type { Plugin } from "obsidian";

import { PluginDataStore } from "../src/services/PluginDataStore";
import { RandomReunionService } from "../src/services/RandomReunionService";
import { ShuffleDayService } from "../src/services/ShuffleDayService";
import type { MemoRecord } from "../src/types/memo";
import { isRecord } from "../src/utils/object";
import {
	extractRandomReunionReviewStates,
	extractShuffleDayHistory,
} from "../src/utils/pluginData";

test("concurrent review mutations preserve every update", async () => {
	const harness = createPluginHarness({});
	const store = new PluginDataStore(harness.plugin);
	const service = new RandomReunionService(store);

	await Promise.all([
		service.markRandomReunionReviewed("memo-a"),
		service.markRandomReunionReviewed("memo-a"),
		service.markRandomReunionReviewed("memo-b"),
	]);

	const states = extractRandomReunionReviewStates(await store.read());
	assert.equal(states["memo-a"]?.reviewCount, 2);
	assert.equal(states["memo-b"]?.reviewCount, 1);
});

test("shared plugin data store preserves review state and shuffle history", async () => {
	const harness = createPluginHarness({});
	const store = new PluginDataStore(harness.plugin);
	const randomReunionService = new RandomReunionService(store);
	const shuffleDayService = new ShuffleDayService(store);

	const [, shuffleResult] = await Promise.all([
		randomReunionService.markRandomReunionReviewed("memo-a"),
		shuffleDayService.selectShuffleDay([createMemo("old-memo", "2020-01-02T09:00:00")]),
	]);

	assert.equal(shuffleResult.status, "ready");
	const savedData = await store.read();
	assert.equal(extractRandomReunionReviewStates(savedData)["memo-a"]?.reviewCount, 1);
	assert.equal(extractShuffleDayHistory(savedData).length, 1);
});

test("failed plugin data save releases the next mutation", async () => {
	const harness = createPluginHarness({});
	const store = new PluginDataStore(harness.plugin);
	harness.failNextSave();

	await assert.rejects(
		store.mutate((savedData) => ({
			nextData: Object.assign({}, isRecord(savedData) ? savedData : {}, { failed: true }),
			result: undefined,
		})),
		/save failed/,
	);
	await store.mutate((savedData) => ({
		nextData: Object.assign({}, isRecord(savedData) ? savedData : {}, { saved: true }),
		result: undefined,
	}));

	const savedData = await store.read();
	assert.equal(isRecord(savedData) ? savedData.saved : undefined, true);
});

function createPluginHarness(initialData: unknown): {
	plugin: Plugin;
	failNextSave: () => void;
} {
	let data = cloneData(initialData);
	let shouldFailNextSave = false;
	const plugin = {
		loadData: async () => cloneData(data),
		saveData: async (nextData: unknown) => {
			if (shouldFailNextSave) {
				shouldFailNextSave = false;
				throw new Error("save failed");
			}
			data = cloneData(nextData);
		},
	} as Plugin;
	return {
		plugin,
		failNextSave: () => {
			shouldFailNextSave = true;
		},
	};
}

function cloneData<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function createMemo(id: string, createdAt: string): MemoRecord {
	return {
		id,
		createdAt,
		updatedAt: createdAt,
		contentSnapshot: id,
		contentHash: `hash-${id}`,
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
			path: `Daily/${createdAt.slice(0, 10)}.md`,
			heading: "## Memos",
			lastKnownBlock: id,
			lastKnownHash: `daily-${id}`,
			lineNumberHint: 1,
			lastSyncedAt: null,
		},
		monthlyRef: {
			path: "Memos/Memos-2020-01.md",
			dateHeading: `## ${createdAt.slice(0, 10)}`,
			lastKnownBlock: id,
			lastKnownHash: `monthly-${id}`,
			lineNumberHint: 1,
			lastSyncedAt: null,
		},
	};
}

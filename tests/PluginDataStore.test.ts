import test from "node:test";
import assert from "node:assert/strict";
import type { Plugin } from "obsidian";

import { PluginDataStore } from "../src/services/PluginDataStore";
import { isRecord } from "../src/utils/object";

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

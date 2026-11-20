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

test("a source change during load repeats preparation and reads the newest shared data", async () => {
	let data: Record<string, unknown> = { shared: "first" };
	let revision = 0, preparations = 0, mutations = 0, reads = 0;
	const store = new PluginDataStore({
		loadData: async () => {
			const loaded = { ...data };
			if (++reads === 1) {
				data = { shared: "external" };
				revision++;
			}
			return loaded;
		},
		saveData: async (value: Record<string, unknown>) => { data = value; },
	} as Plugin);
	await store.mutate(saved => {
		mutations++;
		return { nextData: { ...saved as Record<string, unknown>, beacon: "updated" }, result: undefined };
	}, async () => {
		preparations++;
		const validated = revision;
		return () => revision === validated;
	});
	assert.equal(preparations, 2); assert.equal(reads, 2); assert.equal(mutations, 1);
	assert.deepEqual(data, { shared: "external", beacon: "updated" });
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

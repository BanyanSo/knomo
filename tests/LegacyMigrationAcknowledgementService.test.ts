import assert from "node:assert/strict";
import test from "node:test";
import type { Plugin } from "obsidian";

import { LegacyMigrationAcknowledgementService } from "../src/services/LegacyMigrationAcknowledgementService";
import { PluginDataStore } from "../src/services/PluginDataStore";
import type { LegacyIdentityImportReport } from "../src/types/legacyMigration";

test("只确认当前 partial 来源修订，来源变化后重新显示", async () => {
	const harness = createPluginHarness({ settings: { dailyHeading: "## Memos" } });
	const service = new LegacyMigrationAcknowledgementService(new PluginDataStore(harness.plugin));
	await service.initialize();
	const first = partialReport("a".repeat(64));

	assert.equal(service.isAcknowledged(first), false);
	assert.equal(await service.acknowledge(first), true);
	assert.equal(service.isAcknowledged(first), true);
	assert.equal(service.isAcknowledged(partialReport("b".repeat(64))), false);

	const restored = new LegacyMigrationAcknowledgementService(new PluginDataStore(harness.plugin));
	await restored.initialize();
	assert.equal(restored.isAcknowledged(first), true);
});

test("非 partial 或缺少来源修订时不能确认", async () => {
	const harness = createPluginHarness({ settings: {} });
	const service = new LegacyMigrationAcknowledgementService(new PluginDataStore(harness.plugin));
	await service.initialize();

	assert.equal(await service.acknowledge({ ...partialReport("a".repeat(64)), status: "attention" }), false);
	assert.equal(await service.acknowledge(partialReport(null)), false);
});

function partialReport(sourceRevision: string | null): LegacyIdentityImportReport {
	return {
		status: "partial",
		sourceRevision,
		importedEventCount: 0,
		importedMemoIds: [],
		skippedMemoIds: ["legacy-memo"],
		diagnostics: [],
		cleanupCandidate: null,
	};
}

function createPluginHarness(initialData: unknown): { plugin: Plugin } {
	let data = cloneData(initialData);
	return {
		plugin: {
			loadData: async () => cloneData(data),
			saveData: async (nextData: unknown) => { data = cloneData(nextData); },
		} as Plugin,
	};
}

function cloneData<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

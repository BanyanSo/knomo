import assert from "node:assert/strict";
import test from "node:test";
import type { Plugin } from "obsidian";

import { LegacyMigrationCompletionNoticeService } from "../src/services/LegacyMigrationCompletionNoticeService";
import { PluginDataStore } from "../src/services/PluginDataStore";
import { DEFAULT_KNOMO_SETTINGS } from "../src/settings/defaults";
import type { LegacyMigrationCleanupCandidate } from "../src/types/legacyMigration";
import { isRecord } from "../src/utils/object";
import { buildPluginDataWithSettings } from "../src/utils/pluginData";
import { InMemoryVault } from "./helpers/InMemoryVault";

const LEGACY_ROOT = "Knomo/_knomo-system";

test("同一迁移 revision 只提示一次，旧数据变化后允许再次提示", async () => {
	const vault = new InMemoryVault({ [`${LEGACY_ROOT}/indexes/memo-index-2026-08.json`]: "{}" });
	const harness = createPluginHarness(vault, { settings: { dailyHeading: "## Memos" } });
	const messages: string[] = [];
	const service = new LegacyMigrationCompletionNoticeService(
		vault.app,
		new PluginDataStore(harness.plugin),
		(path) => messages.push(path),
	);
	const first = candidate("a".repeat(64));

	assert.equal(await service.showIfNeeded(first), false);
	assert.equal(readShownRevision(harness.getData()), null);
	service.markLayoutReady();
	assert.equal(await service.showIfNeeded(first), true);
	assert.equal(await service.showIfNeeded(first), false);
	assert.equal(await service.showIfNeeded(candidate("b".repeat(64))), true);
	assert.deepEqual(messages, [LEGACY_ROOT, LEGACY_ROOT]);
	assert.equal(readShownRevision(harness.getData()), "b".repeat(64));
});

test("旧系统目录已不存在时不提示也不记录", async () => {
	const vault = new InMemoryVault();
	const harness = createPluginHarness(vault, { settings: {} });
	const messages: string[] = [];
	const service = new LegacyMigrationCompletionNoticeService(
		vault.app,
		new PluginDataStore(harness.plugin),
		(path) => messages.push(path),
	);
	service.markLayoutReady();

	assert.equal(await service.showIfNeeded(candidate("a".repeat(64))), false);
	assert.deepEqual(messages, []);
	assert.equal(readShownRevision(harness.getData()), null);
});

test("普通设置保存保留已提示 revision", async () => {
	const vault = new InMemoryVault({ [`${LEGACY_ROOT}/indexes/memo-index-2026-08.json`]: "{}" });
	const harness = createPluginHarness(vault, { settings: { dailyHeading: "## Memos" } });
	const store = new PluginDataStore(harness.plugin);
	const service = new LegacyMigrationCompletionNoticeService(vault.app, store, () => undefined);
	service.markLayoutReady();
	const sourceRevision = "a".repeat(64);
	await service.showIfNeeded(candidate(sourceRevision));
	await store.mutate((savedData) => ({
		nextData: buildPluginDataWithSettings(savedData, {
			...DEFAULT_KNOMO_SETTINGS,
			dailyHeading: "## Notes",
			mobileCompactMode: "on",
		}),
		result: undefined,
	}));

	assert.equal(readShownRevision(harness.getData()), sourceRevision);
});

function candidate(sourceRevision: string): LegacyMigrationCleanupCandidate {
	return { legacySystemRoot: LEGACY_ROOT, sourceRevision };
}

function createPluginHarness(vault: InMemoryVault, initialData: unknown): {
	plugin: Plugin;
	getData: () => unknown;
} {
	let data = cloneData(initialData);
	const plugin = {
		app: vault.app,
		loadData: async () => cloneData(data),
		saveData: async (nextData: unknown) => { data = cloneData(nextData); },
	} as Plugin;
	return { plugin, getData: () => cloneData(data) };
}

function readShownRevision(value: unknown): string | null {
	return isRecord(value) && typeof value.legacyMigrationNoticeSourceRevision === "string"
		? value.legacyMigrationNoticeSourceRevision
		: null;
}

function cloneData<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

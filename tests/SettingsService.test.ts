import assert from "node:assert/strict";
import test from "node:test";

import type { KnomoSettings } from "../src/types/settings";
import { ensureObsidianStub } from "./helpers/obsidianStub";

test("enables Time Buoy by default when no setting was persisted", async () => {
	const { SettingsService } = await loadSettingsService();
	const legacySettings = { ...createSettings() } as Partial<KnomoSettings>;
	delete legacySettings.timeBuoyEnabled;
	const plugin = await createPlugin({}, { settings: legacySettings });
	const service = new SettingsService(plugin as never);
	await service.loadSettings();

	await service.initializeTimeBuoyDefault();

	assert.equal(service.getSettings().timeBuoyEnabled, true);
	assert.equal(service.getSettings().timeBuoyIntroDismissed, true);
	assert.equal(service.consumeInitialTimeBuoyBuildPending(), true);
});

test("does not override an explicitly persisted Time Buoy setting", async () => {
	const { SettingsService } = await loadSettingsService();
	const settings = { ...createSettings(), timeBuoyEnabled: true };
	const plugin = await createPlugin({}, { settings });
	const service = new SettingsService(plugin as never);
	await service.loadSettings();

	await service.initializeTimeBuoyDefault();

	assert.equal(service.getSettings().timeBuoyEnabled, true);
	assert.equal(plugin.saveCalls, 0);
});

test("Monthly folder migration only changes projection configuration", async () => {
	const { SettingsService } = await loadSettingsService();
	const plugin = await createPlugin({
		"Memos/Memos-2026-05.md": "# old projection",
		"Memos/_knomo-system/indexes/memo-index-2026-05.json": "legacy index",
	}, { settings: createSettings() });
	const service = new SettingsService(plugin as never);
	await service.loadSettings();
	const plan = await service.planMonthlyMemoFolderMigration("Archive/Memos");
	const result = await service.migrateMonthlyMemoFolder("Archive/Memos");

	assert.deepEqual(plan.conflicts, []);
	assert.equal(result.status, "migrated");
	assert.equal(service.getSettings().monthlyMemoFolder, "Archive/Memos");
	assert.equal(plugin.vault.exists("Memos/Memos-2026-05.md"), true);
	assert.equal(plugin.vault.exists("Memos/_knomo-system/indexes/memo-index-2026-05.json"), true);
	assert.equal(plugin.vault.exists("Archive/Memos/Memos-2026-05.md"), false);
});

test("Monthly filename migration derives periods from projection files and creates no backup", async () => {
	const { SettingsService } = await loadSettingsService();
	const plugin = await createPlugin({
		"Memos/Memos-2026-05.md": "# projection",
		"Memos/notes.md": "# ordinary note",
		"Memos/_knomo-system/indexes/memo-index-2026-05.json": "legacy index",
	}, { settings: createSettings() });
	const service = new SettingsService(plugin as never);
	await service.loadSettings();
	const rebuilt: string[][] = [];

	const result = await service.migrateMonthlyMemoFileFormat(
		"Archive-YYYY-MM.md",
		async (periods) => { rebuilt.push([...periods]); },
	);

	assert.equal(result.status, "migrated");
	assert.deepEqual(result.plan.periods, ["2026-05"]);
	assert.deepEqual(rebuilt, [["2026-05"]]);
	assert.equal(service.getSettings().monthlyMemoFileFormat, "Archive-YYYY-MM.md");
	assert.equal(plugin.vault.exists("Memos/Memos-2026-05.md"), true);
	assert.equal(plugin.vault.exists("Memos/_knomo-system/indexes/memo-index-2026-05.json"), true);
});

test("restores staged Monthly settings when projection rebuild fails", async () => {
	const { SettingsService } = await loadSettingsService();
	const plugin = await createPlugin({
		"Memos/Memos-2026-05.md": "# projection",
	}, { settings: createSettings() });
	const service = new SettingsService(plugin as never);
	await service.loadSettings();

	await assert.rejects(() => service.migrateMonthlyMemoFileFormat(
		"Archive-YYYY-MM.md",
		async () => { throw new Error("projection failed"); },
	), /projection failed/u);

	assert.equal(service.getSettings().monthlyMemoFileFormat, "Memos-YYYY-MM.md");
	assert.equal(plugin.saveCalls, 0);
});

test("Catalog exclusion state is independent from the Monthly folder", async () => {
	const { SettingsService } = await loadSettingsService();
	const plugin = await createPlugin({}, { settings: createSettings() });
	const service = new SettingsService(plugin as never);
	await service.loadSettings();

	await service.ensureCatalogDataExcludeRules(
		"Shared/_knomo-data",
		"Memos/_knomo-system",
		true,
	);

	assert.deepEqual(plugin.vault.config.userIgnoreFilters, [
		"Shared/_knomo-data/",
		"Memos/_knomo-system/",
	]);
	assert.equal(service.getSettings().managedSystemFolderExcludeRule, "Shared/_knomo-data/");
	assert.equal(service.getSettings().managedLegacySystemFolderExcludeRule, "Memos/_knomo-system/");

	await service.retireLegacySystemExcludeRule();
	assert.deepEqual(plugin.vault.config.userIgnoreFilters, ["Shared/_knomo-data/"]);
	assert.equal(service.getSettings().managedLegacySystemFolderExcludeRule, undefined);
});

test("keeps runtime settings unchanged when persistence fails", async () => {
	const { SettingsService } = await loadSettingsService();
	const plugin = await createPlugin({}, { settings: createSettings() }, true);
	const service = new SettingsService(plugin as never);
	await service.loadSettings();

	await assert.rejects(
		() => service.updateSettings({ dailyHeading: "## Changed" }),
		/保存设置失败/u,
	);

	assert.equal(service.getSettings().dailyHeading, "## Knomo");
});

test("serializes concurrent setting patches without losing earlier updates", async () => {
	const { SettingsService } = await loadSettingsService();
	const plugin = await createPlugin({}, { settings: createSettings() });
	const service = new SettingsService(plugin as never);
	await service.loadSettings();

	await Promise.all([
		service.updateSettings({ dailyInsertPosition: "top" }),
		service.updateSettings({ memoTimeFormat: "HH:mm" }),
	]);

	assert.equal(service.getSettings().dailyInsertPosition, "top");
	assert.equal(service.getSettings().memoTimeFormat, "HH:mm");
});

test("retires legacy maintenance diagnostics on the next plugin-data write", async () => {
	const { SettingsService } = await loadSettingsService();
	const plugin = await createPlugin({}, {
		settings: createSettings(),
		maintenanceDiagnostic: { task: "file_watch", status: "completed" },
	});
	const service = new SettingsService(plugin as never);
	await service.loadSettings();

	await service.updateSettings({ dailyHeading: "## Daily Memos" });

	assert.equal(Object.prototype.hasOwnProperty.call(plugin.savedData, "maintenanceDiagnostic"), false);
});

async function loadSettingsService(): Promise<typeof import("../src/services/SettingsService")> {
	await ensureObsidianStub();
	return import("../src/services/SettingsService");
}

async function createPlugin(
	initialFiles: Record<string, string>,
	initialData: Record<string, unknown>,
	failSaveData = false,
) {
	await ensureObsidianStub();
	const { TFile, TFolder } = await import("obsidian");
	type TestFile = InstanceType<typeof TFile>;
	type TestFolder = InstanceType<typeof TFolder>;
	const entries = new Map<string, TestFile | TestFolder>();
	const root = Object.assign(new TFolder(), {
		path: "",
		name: "",
		children: [] as Array<TestFile | TestFolder>,
		parent: null,
	});
	entries.set("", root);

	const ensureFolder = (folderPath: string): TestFolder => {
		const normalized = normalizeTestPath(folderPath);
		if (normalized.length === 0) return root;
		const existing = entries.get(normalized);
		if (existing instanceof TFolder) return existing;
		const parent = ensureFolder(getParentPath(normalized));
		const folder = Object.assign(new TFolder(), {
			path: normalized,
			name: getName(normalized),
			children: [] as Array<TestFile | TestFolder>,
			parent,
		});
		parent.children.push(folder);
		entries.set(normalized, folder);
		return folder;
	};

	for (const path of Object.keys(initialFiles)) {
		const normalized = normalizeTestPath(path);
		const parent = ensureFolder(getParentPath(normalized));
		const name = getName(normalized);
		const file = Object.assign(new TFile(), {
			path: normalized,
			name,
			basename: name.replace(/\.[^.]+$/u, ""),
			extension: name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "",
			parent,
		});
		parent.children.push(file);
		entries.set(normalized, file);
	}

	const vault = {
		config: { userIgnoreFilters: [] as string[] },
		getAbstractFileByPath: (path: string) => entries.get(normalizeTestPath(path)) ?? null,
		getConfig(key: string): unknown {
			return this.config[key as keyof typeof this.config];
		},
		async setConfig(key: string, value: unknown): Promise<void> {
			(this.config as Record<string, unknown>)[key] = value;
		},
		exists: (path: string) => entries.has(normalizeTestPath(path)),
	};
	const plugin = {
		app: { vault },
		vault,
		savedData: initialData,
		saveCalls: 0,
		loadData: async () => plugin.savedData,
		saveData: async (data: Record<string, unknown>) => {
			if (failSaveData) throw new Error("保存设置失败");
			plugin.saveCalls += 1;
			plugin.savedData = data;
		},
	};
	return plugin;
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
		timeBuoyEnabled: false,
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

function normalizeTestPath(path: string): string {
	return path.replace(/\\/gu, "/").replace(/\/+/gu, "/").replace(/^\/|\/$/gu, "");
}

function getParentPath(path: string): string {
	const normalized = normalizeTestPath(path);
	const index = normalized.lastIndexOf("/");
	return index === -1 ? "" : normalized.slice(0, index);
}

function getName(path: string): string {
	const normalized = normalizeTestPath(path);
	return normalized.slice(normalized.lastIndexOf("/") + 1);
}

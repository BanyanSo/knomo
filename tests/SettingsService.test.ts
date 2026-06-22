import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { KnomoSettings } from "../src/types/settings";

test("migrates monthly files, system folder, monthlyRef paths, exclude rule, and backups", async () => {
	const { SettingsService } = await loadSettingsService();
	const vault = await createMemoryVault({
		"Memos/Memos-2026-05.md": "# 2026-05\n\n## 2026-05-18\n- 08:00:00 内容",
		"Memos/_knomo-system/indexes/memo-index-2026-05.json": JSON.stringify(createIndex("Memos/Memos-2026-05.md"), null, "\t"),
	});
	vault.config.userIgnoreFilters = ["Memos/", "Memos/_knomo-system/"];
	const plugin = createPlugin(vault, {
		...createSettings(),
		excludeMonthlyMemosFromObsidian: true,
		managedObsidianExcludeRule: "Memos/",
		managedObsidianExcludeRuleOwned: true,
		managedSystemFolderExcludeRule: "Memos/_knomo-system/",
		managedSystemFolderExcludeRuleOwned: true,
	});
	const archiveMoves: Array<{ from: string; to: string }> = [];
	const service = new SettingsService(plugin as never, (from, to) => {
		archiveMoves.push({ from, to });
	});
	await service.loadSettings();

	const result = await service.migrateMonthlyMemoFolder("Archive/Memos");

	assert.equal(result.status, "migrated");
	assert.equal(vault.exists("Archive/Memos/Memos-2026-05.md"), true);
	assert.equal(vault.exists("Archive/Memos/_knomo-system/indexes/memo-index-2026-05.json"), true);
	assert.equal(vault.exists("Memos/Memos-2026-05.md"), false);
	assert.equal(vault.readText("Archive/Memos/Memos-2026-05.md").startsWith("<!-- knomo:monthly-archive\nKnomo monthly archive file"), true);
	const index = JSON.parse(vault.readText("Archive/Memos/_knomo-system/indexes/memo-index-2026-05.json")) as ReturnType<typeof createIndex>;
	assert.equal(index.memos.memo1.monthlyRef.path, "Archive/Memos/Memos-2026-05.md");
	assert.deepEqual(vault.config.userIgnoreFilters, ["Archive/Memos/", "Archive/Memos/_knomo-system/"]);
	assert.equal(vault.listPaths().some((path) => path.includes("_knomo-system/backups/monthly-folder-")), true);
	assert.equal(plugin.savedSettings?.monthlyMemoFolder, "Archive/Memos");
	assert.equal(plugin.savedSettings?.managedSystemFolderExcludeRule, "Archive/Memos/_knomo-system/");
	assert.deepEqual(archiveMoves, [{
		from: "Memos/Memos-2026-05.md",
		to: "Archive/Memos/Memos-2026-05.md",
	}]);
});

test("stops monthly folder migration on target path conflicts without moving old data", async () => {
	const { SettingsService } = await loadSettingsService();
	const vault = await createMemoryVault({
		"Memos/Memos-2026-05.md": "# 2026-05",
		"Memos/_knomo-system/indexes/memo-index-2026-05.json": JSON.stringify(createIndex("Memos/Memos-2026-05.md"), null, "\t"),
		"Archive/Memos/Memos-2026-05.md": "conflict",
	});
	const plugin = createPlugin(vault, createSettings());
	const service = new SettingsService(plugin as never);
	await service.loadSettings();

	await assert.rejects(() => service.migrateMonthlyMemoFolder("Archive/Memos"), /Target path has conflicts/);
	assert.equal(vault.exists("Memos/Memos-2026-05.md"), true);
	assert.equal(vault.readText("Archive/Memos/Memos-2026-05.md"), "conflict");
	assert.equal(plugin.savedSettings, null);
});

test("discards the archive move marker when an internal rename fails", async () => {
	const { SettingsService } = await loadSettingsService();
	const vault = await createMemoryVault({
		"Memos/Memos-2026-05.md": "# 2026-05",
	});
	vault.rename = async () => {
		throw new Error("rename failed");
	};
	const plugin = createPlugin(vault, createSettings());
	let discardedMarkers = 0;
	const service = new SettingsService(plugin as never, () => () => {
		discardedMarkers += 1;
	});
	await service.loadSettings();

	await assert.rejects(() => service.migrateMonthlyMemoFolder("Archive/Memos"), /rename failed/);

	assert.equal(discardedMarkers, 1);
	assert.equal(vault.exists("Memos/Memos-2026-05.md"), true);
});

test("only plans recognized monthly archive files for folder migration", async () => {
	const { SettingsService } = await loadSettingsService();
	const vault = await createMemoryVault({
		"Memos/Memos-2026-05.md": "# 2026-05",
		"Memos/indexed.md": "# indexed archive",
		"Memos/marked.md": "<!-- knomo:monthly-archive -->\n# marked archive",
		"Memos/notes.md": "# ordinary note",
		"Memos/_knomo-system/indexes/memo-index-2026-05.json": JSON.stringify(createIndex("Memos/indexed.md"), null, "\t"),
	});
	const plugin = createPlugin(vault, createSettings());
	const service = new SettingsService(plugin as never);
	await service.loadSettings();

	const plan = await service.planMonthlyMemoFolderMigration("Archive/Memos");

	assert.equal(plan.monthlyFileMoves.length, 3);
	assert.deepEqual(new Set(plan.monthlyFileMoves.map((move) => move.from)), new Set([
		"Memos/Memos-2026-05.md",
		"Memos/indexed.md",
		"Memos/marked.md",
	]));
	assert.equal(plan.monthlyFileMoves.some((move) => move.from === "Memos/notes.md"), false);
});

test("recognizes monthly archive filenames without requiring a markdown extension", async () => {
	const { SettingsService } = await loadSettingsService();
	const vault = await createMemoryVault({
		"Memos/Memos-2026-05": "# 2026-05",
		"Memos/notes.md": "# ordinary note",
	});
	const plugin = createPlugin(vault, {
		...createSettings(),
		monthlyMemoFileFormat: "Memos-YYYY-MM",
	});
	const service = new SettingsService(plugin as never);
	await service.loadSettings();

	const plan = await service.planMonthlyMemoFolderMigration("Archive/Memos");

	assert.deepEqual(plan.monthlyFileMoves, [{
		from: "Memos/Memos-2026-05",
		to: "Archive/Memos/Memos-2026-05",
	}]);
});

test("initializes system folder exclude rule without duplicates", async () => {
	const { SettingsService } = await loadSettingsService();
	const vault = await createMemoryVault({});
	const plugin = createPlugin(vault, createSettings());
	const service = new SettingsService(plugin as never);
	await service.loadSettings();

	await service.initializeSystemFolders();
	await service.initializeSystemFolders();

	assert.equal(vault.exists("Memos/_knomo-system/indexes"), true);
	assert.deepEqual(vault.config.userIgnoreFilters, ["Memos/_knomo-system/"]);
	assert.equal(plugin.savedSettings?.managedSystemFolderExcludeRule, "Memos/_knomo-system/");
	assert.equal(plugin.savedSettings?.managedSystemFolderExcludeRuleOwned, true);
});

test("keeps runtime settings unchanged when persistence fails", async () => {
	const { SettingsService } = await loadSettingsService();
	const vault = await createMemoryVault({});
	const plugin = createPlugin(vault, createSettings(), { failSaveData: true });
	const service = new SettingsService(plugin as never);
	await service.loadSettings();

	await assert.rejects(
		() => service.updateSettings({ dailyHeading: "## Changed" }),
		/保存设置失败/,
	);

	assert.equal(service.getSettings().dailyHeading, "## Knomo");
});

test("serializes concurrent setting patches without losing earlier updates", async () => {
	const { SettingsService } = await loadSettingsService();
	const vault = await createMemoryVault({});
	const plugin = createPlugin(vault, createSettings());
	const service = new SettingsService(plugin as never);
	await service.loadSettings();

	await Promise.all([
		service.updateSettings({ dailyInsertPosition: "top" }),
		service.updateSettings({ memoTimeFormat: "HH:mm" }),
	]);

	assert.equal(service.getSettings().dailyInsertPosition, "top");
	assert.equal(service.getSettings().memoTimeFormat, "HH:mm");
	assert.equal(plugin.savedSettings?.dailyInsertPosition, "top");
	assert.equal(plugin.savedSettings?.memoTimeFormat, "HH:mm");
});

test("rejects monthly memo file formats with path separators", async () => {
	const { SettingsService } = await loadSettingsService();
	const vault = await createMemoryVault({});
	const plugin = createPlugin(vault, {
		...createSettings(),
		monthlyMemoFileFormat: "YYYY/Memos-YYYY-MM.md",
	});
	const service = new SettingsService(plugin as never);

	const settings = await service.loadSettings();

	assert.equal(settings.monthlyMemoFileFormat, "Memos-YYYY-MM.md");
	assert.equal(service.validateMonthlyMemoFileFormat("Memos-YYYY-MM.md"), true);
	assert.equal(service.validateMonthlyMemoFileFormat("Memos-YYYY-MM"), true);
	assert.equal(service.validateMonthlyMemoFileFormat("Memos.md"), false);
	assert.equal(service.validateMonthlyMemoFileFormat("Memos-YYYY-MM-YYYY-MM.md"), false);
	assert.equal(service.validateMonthlyMemoFileFormat("YYYY/Memos-YYYY-MM.md"), false);
	assert.equal(service.validateMonthlyMemoFileFormat("YYYY\\Memos-YYYY-MM.md"), false);
});

test("keeps historical monthly filename formats until explicit migration", async () => {
	const { SettingsService } = await loadSettingsService();
	const vault = await createMemoryVault({});
	const plugin = createPlugin(vault, {
		...createSettings(),
		monthlyMemoFileFormat: "Memos.md",
	});
	const service = new SettingsService(plugin as never);

	const settings = await service.loadSettings();

	assert.equal(settings.monthlyMemoFileFormat, "Memos.md");
	assert.equal(service.validateMonthlyMemoFileFormat(settings.monthlyMemoFileFormat), false);
	assert.equal(plugin.savedSettings, null);
});

test("backs up and explicitly migrates monthly filename format", async () => {
	const { SettingsService } = await loadSettingsService();
	const indexPath = "Memos/_knomo-system/indexes/memo-index-2026-05.json";
	const vault = await createMemoryVault({
		"Memos/Memos.md": "# historical archive",
		[indexPath]: JSON.stringify(createIndex("Memos/Memos.md"), null, "\t"),
	});
	const plugin = createPlugin(vault, {
		...createSettings(),
		monthlyMemoFileFormat: "Memos.md",
	});
	const service = new SettingsService(plugin as never);
	await service.loadSettings();

	const plan = await service.planMonthlyMemoFileFormatMigration("Archive-YYYY-MM.md");
	assert.deepEqual(plan.periods, ["2026-05"]);
	assert.deepEqual(plan.oldArchivePaths, ["Memos/Memos.md"]);

	const result = await service.migrateMonthlyMemoFileFormat("Archive-YYYY-MM.md", async (periods, trackGeneratedPath) => {
		assert.deepEqual(periods, ["2026-05"]);
		assert.equal(service.getSettings().monthlyMemoFileFormat, "Archive-YYYY-MM.md");
		await vault.create("Memos/Archive-2026-05.md", "# rebuilt archive");
		trackGeneratedPath("Memos/Archive-2026-05.md");
	});

	assert.equal(result.status, "migrated");
	assert.equal(vault.exists("Memos/Memos.md"), true);
	assert.equal(vault.exists("Memos/Archive-2026-05.md"), true);
	assert.equal(vault.readText(indexPath).includes("Memos/Archive-2026-05.md"), true);
	assert.equal(vault.listPaths().some((path) => path.includes("_knomo-system/backups/monthly-format-")), true);
	assert.equal(plugin.savedSettings?.monthlyMemoFileFormat, "Archive-YYYY-MM.md");
});

test("stops monthly filename format migration before writes on target conflicts", async () => {
	const { SettingsService } = await loadSettingsService();
	const vault = await createMemoryVault({
		"Memos/Memos.md": "# historical archive",
		"Memos/Archive-2026-05.md": "# existing target",
		"Memos/_knomo-system/indexes/memo-index-2026-05.json": JSON.stringify(createIndex("Memos/Memos.md"), null, "\t"),
	});
	const plugin = createPlugin(vault, {
		...createSettings(),
		monthlyMemoFileFormat: "Memos.md",
	});
	const service = new SettingsService(plugin as never);
	await service.loadSettings();
	let rebuildCalled = false;

	await assert.rejects(
		() => service.migrateMonthlyMemoFileFormat("Archive-YYYY-MM.md", async () => {
			rebuildCalled = true;
		}),
		/Target path has conflicts/,
	);

	assert.equal(rebuildCalled, false);
	assert.equal(service.getSettings().monthlyMemoFileFormat, "Memos.md");
	assert.equal(vault.readText("Memos/Archive-2026-05.md"), "# existing target");
	assert.equal(plugin.savedSettings, null);
});

test("rolls back index and generated archives when monthly filename format save fails", async () => {
	const { SettingsService } = await loadSettingsService();
	const indexPath = "Memos/_knomo-system/indexes/memo-index-2026-05.json";
	const vault = await createMemoryVault({
		"Memos/Memos.md": "# historical archive",
		[indexPath]: JSON.stringify(createIndex("Memos/Memos.md"), null, "\t"),
	});
	const plugin = createPlugin(vault, {
		...createSettings(),
		monthlyMemoFileFormat: "Memos.md",
	}, { failSaveData: true });
	const service = new SettingsService(plugin as never);
	await service.loadSettings();

	await assert.rejects(
		() => service.migrateMonthlyMemoFileFormat("Archive-YYYY-MM.md", async (_periods, trackGeneratedPath) => {
			await vault.create("Memos/Archive-2026-05.md", "# rebuilt archive");
			trackGeneratedPath("Memos/Archive-2026-05.md");
			await vault.create("Memos/User-during-migration.md", "# user file");
		}),
		/保存设置失败/,
	);

	assert.equal(service.getSettings().monthlyMemoFileFormat, "Memos.md");
	assert.equal(vault.exists("Memos/Memos.md"), true);
	assert.equal(vault.exists("Memos/Archive-2026-05.md"), false);
	assert.equal(vault.exists("Memos/User-during-migration.md"), true);
	assert.equal(vault.readText(indexPath).includes("Memos/Memos.md"), true);
	assert.equal(vault.listPaths().some((path) => path.includes("_knomo-system/backups/monthly-format-")), true);
});

test("restores monthly files and indexes when migration save fails", async () => {
	const { SettingsService } = await loadSettingsService();
	const originalMonthlyContent = "# 2026-05\n\n## 2026-05-18\n- 08:00:00 内容";
	const vault = await createMemoryVault({
		"Memos/Memos-2026-05.md": originalMonthlyContent,
		"Memos/_knomo-system/indexes/memo-index-2026-05.json": JSON.stringify(createIndex("Memos/Memos-2026-05.md"), null, "\t"),
	});
	const plugin = createPlugin(vault, createSettings(), { failSaveData: true });
	const service = new SettingsService(plugin as never);
	await service.loadSettings();

	await assert.rejects(() => service.migrateMonthlyMemoFolder("Archive/Memos"), /保存设置失败/);

	assert.equal(vault.exists("Memos/Memos-2026-05.md"), true);
	assert.equal(vault.exists("Memos/_knomo-system/indexes/memo-index-2026-05.json"), true);
	assert.equal(vault.exists("Archive/Memos/Memos-2026-05.md"), false);
	assert.equal(vault.readText("Memos/Memos-2026-05.md"), originalMonthlyContent);
	const restoredIndex = JSON.parse(vault.readText("Memos/_knomo-system/indexes/memo-index-2026-05.json")) as ReturnType<typeof createIndex>;
	assert.equal(restoredIndex.memos.memo1.monthlyRef.path, "Memos/Memos-2026-05.md");
	assert.deepEqual(vault.config.userIgnoreFilters, []);
	assert.equal(service.getSettings().monthlyMemoFolder, "Memos");
});

async function loadSettingsService(): Promise<typeof import("../src/services/SettingsService")> {
	await ensureObsidianStub();
	return import("../src/services/SettingsService");
}

async function createMemoryVault(initialFiles: Record<string, string>) {
	await ensureObsidianStub();
	const { TFile, TFolder } = await import("obsidian");
	const entries = new Map<string, { node: InstanceType<typeof TFile> | InstanceType<typeof TFolder>; content?: string }>();
	const root = Object.assign(new TFolder(), { path: "", name: "", children: [] as Array<InstanceType<typeof TFile> | InstanceType<typeof TFolder>>, parent: null });
	entries.set("", { node: root });

	const ensureFolderNode = (folderPath: string): InstanceType<typeof TFolder> => {
		const normalized = normalizeTestPath(folderPath);
		if (normalized.length === 0) return root;
		const existing = entries.get(normalized)?.node;
		if (existing instanceof TFolder) return existing;
		const parentPath = getParentPath(normalized);
		const parent = ensureFolderNode(parentPath);
		const folder = Object.assign(new TFolder(), {
			path: normalized,
			name: getName(normalized),
			children: [] as Array<InstanceType<typeof TFile> | InstanceType<typeof TFolder>>,
			parent,
		});
		parent.children.push(folder);
		entries.set(normalized, { node: folder });
		return folder;
	};

	const createFileNode = (path: string, content: string): InstanceType<typeof TFile> => {
		const normalized = normalizeTestPath(path);
		const parent = ensureFolderNode(getParentPath(normalized));
		const file = Object.assign(new TFile(), {
			path: normalized,
			name: getName(normalized),
			basename: getName(normalized).replace(/\.[^.]+$/, ""),
			extension: getName(normalized).split(".").pop() ?? "",
			parent,
		});
		parent.children.push(file);
		entries.set(normalized, { node: file, content });
		return file;
	};

	for (const [path, content] of Object.entries(initialFiles)) {
		createFileNode(path, content);
	}

	const renameEntry = (node: InstanceType<typeof TFile> | InstanceType<typeof TFolder>, nextPath: string): void => {
		const previousPath = node.path;
		const normalizedNextPath = normalizeTestPath(nextPath);
		const oldParent = "parent" in node ? node.parent as InstanceType<typeof TFolder> | null : null;
		if (oldParent !== null) {
			oldParent.children = oldParent.children.filter((child) => child !== node);
		}
		const nextParent = ensureFolderNode(getParentPath(normalizedNextPath));
		node.path = normalizedNextPath;
		node.name = getName(normalizedNextPath);
		if (node instanceof TFile) {
			node.basename = node.name.replace(/\.[^.]+$/, "");
			node.extension = node.name.split(".").pop() ?? "";
		}
		node.parent = nextParent;
		nextParent.children.push(node);
		const entry = entries.get(previousPath);
		entries.delete(previousPath);
		entries.set(normalizedNextPath, { node, content: entry?.content });
		if (node instanceof TFolder) {
			for (const child of [...node.children]) {
				renameEntry(child as InstanceType<typeof TFile> | InstanceType<typeof TFolder>, `${normalizedNextPath}/${child.name}`);
			}
		}
	};

	const removeFile = (file: InstanceType<typeof TFile>): void => {
		const parent = file.parent;
		if (parent !== null) {
			parent.children = parent.children.filter((child) => child !== file);
		}
		entries.delete(file.path);
	};

	return {
		config: {} as Record<string, unknown>,
		getAbstractFileByPath: (path: string) => entries.get(normalizeTestPath(path))?.node ?? null,
		cachedRead: async (file: InstanceType<typeof TFile>) => entries.get(file.path)?.content ?? "",
		process: async (file: InstanceType<typeof TFile>, callback: (content: string) => string) => {
			const nextContent = callback(entries.get(file.path)?.content ?? "");
			entries.set(file.path, { node: file, content: nextContent });
			return nextContent;
		},
		create: async (path: string, content: string) => createFileNode(path, content),
		createFolder: async (path: string) => {
			ensureFolderNode(path);
		},
		rename: async (node: InstanceType<typeof TFile> | InstanceType<typeof TFolder>, nextPath: string) => {
			renameEntry(node, nextPath);
		},
		getConfig(key: string): unknown {
			return this.config[key];
		},
		async setConfig(key: string, value: unknown): Promise<void> {
			this.config[key] = value;
		},
		exists: (path: string) => entries.has(normalizeTestPath(path)),
		readText: (path: string) => entries.get(normalizeTestPath(path))?.content ?? "",
		listPaths: () => [...entries.keys()],
		removeFile,
	};
}

function createPlugin(
	vault: Awaited<ReturnType<typeof createMemoryVault>>,
	settings: KnomoSettings,
	options: { failSaveData?: boolean } = {},
) {
	const plugin = {
		app: {
			vault,
			fileManager: {
				trashFile: async (file: Parameters<typeof vault.removeFile>[0]) => {
					vault.removeFile(file);
				},
			},
		},
		savedSettings: null as KnomoSettings | null,
		loadData: async () => ({ settings }),
		saveData: async (data: { settings: KnomoSettings }) => {
			if (options.failSaveData === true) {
				throw new Error("保存设置失败");
			}
			plugin.savedSettings = data.settings;
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

function createIndex(monthlyPath: string) {
	return {
		schemaVersion: 2,
		period: "2026-05",
		updatedAt: "2026-05-18T08:00:00.000+08:00",
		memos: {
			memo1: {
				monthlyRef: {
					path: monthlyPath,
				},
			},
		},
	};
}

function normalizeTestPath(path: string): string {
	return path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
}

function getParentPath(path: string): string {
	const index = normalizeTestPath(path).lastIndexOf("/");
	return index === -1 ? "" : path.slice(0, index);
}

function getName(path: string): string {
	const normalized = normalizeTestPath(path);
	return normalized.slice(normalized.lastIndexOf("/") + 1);
}

async function ensureObsidianStub(): Promise<void> {
	const stubPath = resolve(__dirname, "../node_modules/obsidian/index.js");
	await mkdir(dirname(stubPath), { recursive: true });
	await writeFile(
		stubPath,
			[
				"class TFile {}",
				"class TFolder { constructor() { this.children = []; } }",
				"const Vault = { recurseChildren(folder, callback) { for (const child of folder.children || []) { callback(child); if (child instanceof TFolder) Vault.recurseChildren(child, callback); } } };",
				"const normalizePath = (value) => value.replace(/\\\\/g, '/').replace(/\\/+/g, '/').replace(/^\\//, '').replace(/\\/$/, '');",
				"let languageValue = 'en';",
				"function getLanguage() { return languageValue; }",
				"getLanguage.set = (value) => { languageValue = value; };",
				"function setIcon(el, icon) { if (el && typeof el.setAttr === 'function') el.setAttr('data-icon', icon); return el; }",
				"function addIcon() {}",
				"let localeValue = 'en';",
				"const moment = (date = new Date()) => ({ format: () => date.toISOString().slice(0, 10) });",
				"moment.locale = (value) => { if (typeof value === 'string') localeValue = value; return localeValue; };",
				"module.exports = { TFile, TFolder, Vault, normalizePath, moment, getLanguage, setIcon, addIcon };",
			].join("\n"),
	);
}

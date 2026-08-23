import assert from "node:assert/strict";
import test from "node:test";
import { TFile, TFolder } from "obsidian";
import type { App, Plugin, TAbstractFile } from "obsidian";

import {
	buildCatalogV2VaultContract,
	CatalogV2SystemRootService,
} from "../src/services/CatalogV2SystemRootService";
import { CatalogV2MigrationArtifactStore } from "../src/services/CatalogV2MigrationArtifactStore";
import { CatalogV2DeletedPayloadStore } from "../src/services/CatalogV2DeletedPayloadStore";
import { PluginDataStore } from "../src/services/PluginDataStore";
import type { KnomoSettings } from "../src/types/settings";
import { extractCatalogV2PluginConfig } from "../src/utils/pluginData";
import { getCatalogBootstrapPath } from "../src/utils/path";
import { canonicalJsonFileBytes } from "../src/services/CatalogV2Protocol";
import { makeMigrationResult } from "./helpers/CatalogV2MigrationFixture";

const WRITER_ID = "w_00000000000000000000000000000001";
const VAULT_ID = "v_00000000000000000000000000000001";
const CREATED_AT = "2026-08-11T00:00:00.000Z";

test("absence of a bootstrap remains uninitialized and writes no protocol files", async () => {
	const harness = createHarness({ settings: { monthlyMemoFolder: "Memos" } });
	const service = new CatalogV2SystemRootService(harness.app, harness.store, () => "Memos");

	assert.equal(await service.initialize(), "Memos/_knomo-data");
	assert.equal(service.installMode, "uninitialized");
	assert.equal(service.vaultContext, null);
	assert.equal(service.initializationAllowed, true);
	assert.deepEqual(harness.listPaths(), []);
	assert.equal(extractCatalogV2PluginConfig(harness.readData()), null);
});

test("Markdown evidence without Knomo data is nonempty and unconfigured, not joining", async () => {
	const harness = createHarness({ settings: { monthlyMemoFolder: "Memos" } });
	harness.addFile("Daily/2026-08-11.md", "## Memos\n");
	const service = new CatalogV2SystemRootService(harness.app, harness.store, () => "Memos");

	await service.initialize();
	assert.equal(service.installMode, "nonempty_unconfigured");
	assert.equal(service.initializationAllowed, true);
	assert.equal(harness.readFile(getCatalogBootstrapPath()), null);
});

test("a user-confirmed nonempty Vault can be initialized without adopting Daily history", async () => {
	const harness = createHarness({ settings: { monthlyMemoFolder: "Memos" } });
	harness.addFile("Daily/2026-08-11.md", "## Memos\n- 09:00 existing\n");
	const service = new CatalogV2SystemRootService(harness.app, harness.store, () => "Memos");
	await service.initialize();

	await service.initializeVault(makeContract(), WRITER_ID, CREATED_AT, VAULT_ID);

	assert.equal(service.installMode, "existing_v2");
	assert.equal(harness.readFile("Daily/2026-08-11.md"), "## Memos\n- 09:00 existing\n");
	assert.notEqual(harness.readFile(getCatalogBootstrapPath()), null);
});

test("a partial bootstrap is joining while its contract is still syncing", async () => {
	const harness = createHarness({ settings: { monthlyMemoFolder: "Memos" } });
	harness.addFile(getCatalogBootstrapPath(), new TextDecoder().decode(canonicalJsonFileBytes({
		kind: "knomo.catalog-v2.vault-bootstrap",
		schemaVersion: 2,
		protocolVersion: 2,
		initializationMode: "native",
		vaultInstanceId: VAULT_ID,
		catalogDataRoot: "Memos/_knomo-data",
		contract: { path: "Memos/_knomo-data/contracts/contract-missing.json", sha256: "a".repeat(64), byteLength: 1 },
		controlGenesis: { path: "Memos/_knomo-data/protocol/control/generations/control-missing.json", sha256: "b".repeat(64), byteLength: 1 },
		initialWriterId: WRITER_ID,
		createdAt: CREATED_AT,
	})));
	const service = new CatalogV2SystemRootService(harness.app, harness.store, () => "Memos");

	await service.initialize();
	assert.equal(service.installMode, "joining");
	assert.equal(service.vaultContext, null);
	assert.equal(service.initializationAllowed, false);
	await assert.rejects(
		service.initializeVault(makeContract(), WRITER_ID, CREATED_AT, VAULT_ID),
		/syncing/u,
	);
});

test("an orphaned V2 artifact blocks replacement initialization", async () => {
	const harness = createHarness({ settings: { monthlyMemoFolder: "Memos" } });
	harness.addFile("Elsewhere/_knomo-data/state/generations/generation-old.json", "{}");
	const service = new CatalogV2SystemRootService(harness.app, harness.store, () => "Memos");

	await service.initialize();

	assert.equal(service.installMode, "joining");
	assert.equal(service.initializationAllowed, false);
	await assert.rejects(
		service.initializeVault(makeContract(), WRITER_ID, CREATED_AT, VAULT_ID),
		/syncing/u,
	);
});

test("a bootstrap arriving after startup moves an unconfigured Vault to existing V2", async () => {
	const harness = createHarness({ settings: { monthlyMemoFolder: "Memos" } });
	harness.addFile("Daily/2026-08-11.md", "## Memos\n");
	const unconfigured = new CatalogV2SystemRootService(harness.app, harness.store, () => "Memos");
	await unconfigured.initialize();
	const initializer = new CatalogV2SystemRootService(harness.app, harness.store, () => "Memos");
	await initializer.initialize();
	await initializer.initializeVault(makeContract(), WRITER_ID, CREATED_AT, VAULT_ID);

	assert.notEqual(await unconfigured.refreshVaultContext(), null);
	assert.equal(unconfigured.installMode, "existing_v2");
});

test("root-bound artifact stores follow a late bootstrap instead of the local guessed root", async () => {
	const harness = createHarness({ settings: { monthlyMemoFolder: "Memos" } });
	harness.addFile("Daily/2026-08-11.md", "## Memos\n");
	const unconfigured = new CatalogV2SystemRootService(harness.app, harness.store, () => "Memos");
	await unconfigured.initialize();
	const artifacts = new CatalogV2MigrationArtifactStore(harness.app, () => unconfigured.catalogDataRoot);
	const payloads = new CatalogV2DeletedPayloadStore(harness.app, () => unconfigured.catalogDataRoot);
	const initializer = new CatalogV2SystemRootService(harness.app, harness.store, () => "Shared");
	await initializer.initialize();
	await initializer.initializeVault(makeContract(), WRITER_ID, CREATED_AT, VAULT_ID);
	await unconfigured.refreshVaultContext();
	const result = await makeMigrationResult();
	await artifacts.persistImportResults([result]);
	const payload = await payloads.write({
		kind: "knomo.catalog-v2.deleted-payload",
		schemaVersion: 1,
		memoId: "memo-1",
		deleteOpId: "o_11111111111111111111111111111111",
		deletedAt: CREATED_AT,
		sourcePath: "Daily/2026-08-11.md",
		logicalDate: "2026-08-11",
		section: "## Memos",
		rawBlock: "- 09:00 memo",
		contentHash: "fnv1a-12345678",
		sourceMemoId: null,
	});
	if (result.kind !== "imported") throw new Error("Expected imported migration fixture.");

	assert.equal(unconfigured.catalogDataRoot, "Shared/_knomo-data");
	assert.notEqual(harness.readFile(`Shared/_knomo-data/${result.packagePath}`), null);
	assert.equal(harness.readFile(`Memos/_knomo-data/${result.packagePath}`), null);
	assert.equal(payload.path.startsWith("Shared/_knomo-data/state/deleted/"), true);
});

test("legacy evidence selects upgrade mode without migrating or deleting it", async () => {
	const harness = createHarness({ settings: { monthlyMemoFolder: "Memos" } });
	harness.addFile("Memos/_knomo-system/indexes/memo-index-2026-08.json", "{}");
	const service = new CatalogV2SystemRootService(harness.app, harness.store, () => "Memos");

	await service.initialize();
	assert.equal(service.installMode, "legacy_upgrade");
	assert.equal(harness.readFile("Memos/_knomo-system/indexes/memo-index-2026-08.json"), "{}");
	assert.equal(harness.readFile(getCatalogBootstrapPath()), null);
	await service.initializeVault(makeContract(), WRITER_ID, CREATED_AT, VAULT_ID);
	assert.equal(service.installMode, "legacy_upgrade");
	const reopened = new CatalogV2SystemRootService(harness.app, harness.store, () => "Elsewhere");
	await reopened.initialize();
	assert.equal(reopened.installMode, "legacy_upgrade");
});

test("legacy evidence is discovered outside the configured Monthly folder", async () => {
	const harness = createHarness({ settings: { monthlyMemoFolder: "Memos" } });
	harness.addFile("Archive/Knomo/_knomo-system/indexes/memo-index-2026-08.json", "{}");
	const service = new CatalogV2SystemRootService(harness.app, harness.store, () => "Memos");

	await service.initialize();

	assert.equal(service.installMode, "legacy_upgrade");
	assert.equal(service.catalogDataRoot, "Archive/Knomo/_knomo-data");
	assert.equal(service.legacySystemRoot, "Archive/Knomo/_knomo-system");
	assert.equal(service.initializationAllowed, true);
	assert.equal(harness.readFile("Archive/Knomo/_knomo-system/indexes/memo-index-2026-08.json"), "{}");
});

test("multiple legacy roots require attention instead of choosing one", async () => {
	const harness = createHarness({ settings: { monthlyMemoFolder: "Memos" } });
	harness.addFile("First/_knomo-system/indexes/memo-index-2026-08.json", "{}");
	harness.addFile("Second/_knomo-system/indexes/memo-index-2026-08.json", "{}");
	const service = new CatalogV2SystemRootService(harness.app, harness.store, () => "Memos");

	await service.initialize();

	assert.equal(service.installMode, "attention");
	assert.equal(service.initializationAllowed, false);
});

test("explicit initialization writes an immutable bootstrap and schema-2 local locator", async () => {
	const harness = createHarness({ settings: { monthlyMemoFolder: "Memos" } });
	const service = new CatalogV2SystemRootService(harness.app, harness.store, () => "Memos");
	await service.initialize();
	const context = await service.initializeVault(makeContract(), WRITER_ID, CREATED_AT, VAULT_ID);
	const savedAfterInitialization = harness.getSaveCount();
	await service.refreshVaultContext();

	assert.equal(service.installMode, "existing_v2");
	assert.equal(context.bootstrap.vaultInstanceId, VAULT_ID);
	assert.equal(harness.getSaveCount(), savedAfterInitialization);
	assert.notEqual(harness.readFile(getCatalogBootstrapPath()), null);
	assert.deepEqual(extractCatalogV2PluginConfig(harness.readData()), {
		schemaVersion: 2,
		catalogDataRoot: "Memos/_knomo-data",
		vaultInstanceId: VAULT_ID,
		contractDigest: context.contractSha256,
	});
});

test("the shared bootstrap freezes the data root when local Monthly settings change", async () => {
	const harness = createHarness({ settings: { monthlyMemoFolder: "Memos" } });
	const first = new CatalogV2SystemRootService(harness.app, harness.store, () => "Memos");
	await first.initialize();
	await first.initializeVault(makeContract(), WRITER_ID, CREATED_AT, VAULT_ID);

	const reopened = new CatalogV2SystemRootService(harness.app, harness.store, () => "Elsewhere");
	assert.equal(await reopened.initialize(), "Memos/_knomo-data");
	assert.equal(reopened.installMode, "existing_v2");
	assert.equal(reopened.vaultContext?.bootstrap.vaultInstanceId, VAULT_ID);
});

test("a conflicting local Vault locator remains attention on refresh", async () => {
	const harness = createHarness({ settings: { monthlyMemoFolder: "Memos" } });
	const first = new CatalogV2SystemRootService(harness.app, harness.store, () => "Memos");
	await first.initialize();
	await first.initializeVault(makeContract(), WRITER_ID, CREATED_AT, VAULT_ID);
	harness.setData({
		catalogV2: {
			schemaVersion: 2,
			catalogDataRoot: "Elsewhere/_knomo-data",
			vaultInstanceId: "v_00000000000000000000000000000002",
			contractDigest: "f".repeat(64),
		},
	});
	const conflicted = new CatalogV2SystemRootService(harness.app, harness.store, () => "Memos");
	await conflicted.initialize();
	assert.equal(conflicted.installMode, "attention");
	assert.equal(await conflicted.refreshVaultContext(), null);
	assert.equal(conflicted.installMode, "attention");
});

function makeContract() {
	return buildCatalogV2VaultContract(makeSettings(), { folder: "Daily", format: "YYYY-MM-DD" });
}

function makeSettings(): KnomoSettings {
	return {
		settingsVersion: 4,
		dailyHeading: "## Memos",
		dailyInsertPosition: "bottom",
		memoTimeFormat: "HH:mm:ss",
		knomoDataRoot: "Memos",
		knomoDataRootConfigured: true,
		monthlyMemoFolder: "Memos",
		monthlyMemoFileFormat: "Memos-YYYY-MM.md",
		monthlyDateHeadingFormat: "## [[YYYY-MM-DD]]",
		monthlyDateOrder: "asc",
		legacyDailyHeadings: [],
		timeBuoyEnabled: true,
		mobileCompactMode: "auto",
		syncDebounceMs: 1000,
		desktopSidebarWidth: 248,
		desktopSidebarCollapsed: false,
		excludeMonthlyMemosFromObsidian: true,
		pinnedTags: [],
	};
}

function createHarness(initialData: unknown): {
	app: App;
	store: PluginDataStore;
	addFile: (path: string, content: string) => void;
	readFile: (path: string) => string | null;
	readData: () => unknown;
	setData: (next: unknown) => void;
	getSaveCount: () => number;
	listPaths: () => string[];
} {
	let data = structuredClone(initialData);
	let saveCount = 0;
	const files = new Map<string, TAbstractFile>();
	const contents = new Map<string, string>();
	const addFile = (path: string, content: string): void => {
		const name = path.split("/").at(-1) ?? path;
		const file = Object.assign(new TFile(), {
			path,
			name,
			basename: name.replace(/\.[^.]+$/u, ""),
			extension: name.includes(".") ? name.split(".").at(-1) ?? "" : "",
			stat: { ctime: 1, mtime: 1, size: new TextEncoder().encode(content).byteLength },
		});
		files.set(path, file);
		contents.set(path, content);
	};
	const app = {
		vault: {
			configDir: ".obsidian",
			getFiles: () => [...files.values()].filter((file): file is TFile => file instanceof TFile),
			getAbstractFileByPath: (path: string) => files.get(path) ?? null,
			readBinary: async (file: TFile) => new TextEncoder().encode(contents.get(file.path) ?? "").buffer,
			createFolder: async (path: string) => {
				files.set(path, Object.assign(new TFolder(), { path, name: path.split("/").at(-1) ?? path, children: [] }));
			},
			create: async (path: string, content: string) => {
				if (files.has(path)) throw new Error(`exists:${path}`);
				addFile(path, content);
				return files.get(path) as TFile;
			},
		},
	} as unknown as App;
	const plugin = {
		loadData: async () => structuredClone(data),
		saveData: async (next: unknown) => {
			saveCount += 1;
			data = structuredClone(next);
		},
	} as Plugin;
	return {
		app,
		store: new PluginDataStore(plugin),
		addFile,
		readFile: (path) => contents.get(path) ?? null,
		readData: () => structuredClone(data),
		setData: (next) => { data = structuredClone(next); },
		getSaveCount: () => saveCount,
		listPaths: () => [...files.keys()].sort(),
	};
}

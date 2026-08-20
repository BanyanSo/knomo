import { normalizePath } from "obsidian";
import type { App } from "obsidian";

import type { CatalogV2InstallMode, CatalogV2LayoutMigrationReport } from "../types/catalogV2";
import type { CatalogV2VaultContract, CatalogV2VerifiedVaultContext } from "../types/catalogV2Protocol";
import type { KnomoSettings } from "../types/settings";
import {
	buildPluginDataWithCatalogV2Config,
	extractCatalogV2PluginConfig,
} from "../utils/pluginData";
import { getCatalogDataRootPath, getLegacySystemRootPath } from "../utils/path";
import { classifyLegacyArtifactPath } from "./LegacyArtifactInventory";
import type { DailyNotesConfig } from "./DailyNoteService";
import { CATALOG_PARSER_VERSION } from "./DiaryMemoParser";
import { CATALOG_V2_MONTHLY_RENDERER_VERSION } from "./CatalogV2MonthlyProjection";
import type { PluginDataStore } from "./PluginDataStore";
import { CatalogV2VaultProtocol } from "./CatalogV2VaultProtocol";

const EMPTY_LAYOUT_REPORT: CatalogV2LayoutMigrationReport = {
	legacyInventorySignature: "",
	receipts: [],
	markdownBytesSignature: "",
};

export class CatalogV2SystemRootService {
	private activeCatalogDataRoot: string | null = null;
	private activeLegacySystemRoot: string | null = null;
	private activeInstallMode: CatalogV2InstallMode | null = null;
	private activeVaultContext: CatalogV2VerifiedVaultContext | null = null;
	private activeInitializationAllowed = false;
	private readonly protocol: CatalogV2VaultProtocol;

	constructor(
		private readonly app: App,
		private readonly pluginDataStore: PluginDataStore,
		private readonly getMonthlyMemoFolder: () => string,
		protocol: CatalogV2VaultProtocol | null = null,
	) {
		this.protocol = protocol ?? new CatalogV2VaultProtocol(app);
	}

	get catalogDataRoot(): string {
		if (this.activeCatalogDataRoot === null) throw new Error("Catalog data root is not initialized.");
		return this.activeCatalogDataRoot;
	}

	get legacySystemRoot(): string {
		if (this.activeLegacySystemRoot === null) throw new Error("Legacy system root is not initialized.");
		return this.activeLegacySystemRoot;
	}

	get installMode(): CatalogV2InstallMode {
		if (this.activeInstallMode === null) throw new Error("Catalog install mode is not initialized.");
		return this.activeInstallMode;
	}

	get vaultContext(): CatalogV2VerifiedVaultContext | null {
		return this.activeVaultContext;
	}

	get initializationAllowed(): boolean {
		return this.activeInitializationAllowed;
	}

	get layoutReport(): CatalogV2LayoutMigrationReport {
		return { ...EMPTY_LAYOUT_REPORT, receipts: [] };
	}

	async initialize(): Promise<string> {
		const savedData = await this.pluginDataStore.read();
		const configured = extractCatalogV2PluginConfig(savedData);
		const contextResult = await this.protocol.loadVaultContext();
		if (contextResult.kind === "ready") {
			const context = contextResult.context;
			if (hasConfiguredContextMismatch(configured, context)) {
				this.activateWithoutContext(context.bootstrap.catalogDataRoot, "attention");
				return this.catalogDataRoot;
			}
			await this.activateContext(context, installModeFromBootstrap(context));
			return this.catalogDataRoot;
		}

		const roots = resolveCatalogRoots(configured, this.getMonthlyMemoFolder());
		if (contextResult.kind === "awaiting_data") {
			this.activateWithoutContext(roots.catalogDataRoot, "joining", roots.legacySystemRoot, false);
			return this.catalogDataRoot;
		}
		if (contextResult.kind === "attention") {
			this.activateWithoutContext(roots.catalogDataRoot, "attention", roots.legacySystemRoot, false);
			return this.catalogDataRoot;
		}
		const state = detectUnbootstrappedState(this.app, configured, roots);
		this.activateWithoutContext(
			state.catalogDataRoot,
			state.mode,
			state.legacySystemRoot,
			state.initializationAllowed,
		);
		return this.catalogDataRoot;
	}

	async initializeVault(
		contract: CatalogV2VaultContract,
		writerId: string,
		createdAt = new Date().toISOString(),
		vaultInstanceId?: string,
	): Promise<CatalogV2VerifiedVaultContext> {
		if (this.activeInstallMode === null) await this.initialize();
		if (this.installMode === "attention") throw new Error("Catalog Vault identity requires attention before initialization.");
		if (this.activeVaultContext === null && !this.activeInitializationAllowed) {
			throw new Error("Catalog Vault initialization is blocked while shared data may still be syncing.");
		}
		const context = await this.protocol.initializeVault({
			catalogDataRoot: this.catalogDataRoot,
			contract,
			initialWriterId: writerId,
			createdAt,
			vaultInstanceId,
			initializationMode: this.activeInstallMode === "legacy_upgrade" ? "legacy_upgrade" : "native",
		});
		await this.activateContext(context, installModeFromBootstrap(context));
		return context;
	}

	async refreshVaultContext(): Promise<CatalogV2VerifiedVaultContext | null> {
		const result = await this.protocol.loadVaultContext();
		if (result.kind === "ready") {
			const configured = extractCatalogV2PluginConfig(await this.pluginDataStore.read());
			if (hasConfiguredContextMismatch(configured, result.context)) {
				this.activeVaultContext = null;
				this.activeInstallMode = "attention";
				this.activeInitializationAllowed = false;
				return null;
			}
			await this.activateContext(result.context, installModeFromBootstrap(result.context));
			return result.context;
		}
		this.activeVaultContext = null;
		if (result.kind === "attention") {
			this.activeInstallMode = "attention";
			this.activeInitializationAllowed = false;
			return null;
		}
		if (result.kind === "awaiting_data") {
			this.activeInstallMode = "joining";
			this.activeInitializationAllowed = false;
			return null;
		}
		const configured = extractCatalogV2PluginConfig(await this.pluginDataStore.read());
		const roots = resolveCatalogRoots(configured, this.getMonthlyMemoFolder());
		const state = detectUnbootstrappedState(this.app, configured, roots);
		this.activateWithoutContext(
			state.catalogDataRoot,
			state.mode,
			state.legacySystemRoot,
			state.initializationAllowed,
		);
		return null;
	}

	async refreshLegacyLayout(): Promise<CatalogV2LayoutMigrationReport> {
		// 未发布的中间 V2 布局不再迁移；真实 legacy 输入只通过 importer 读取。
		return this.layoutReport;
	}

	private async activateContext(context: CatalogV2VerifiedVaultContext, mode: CatalogV2InstallMode): Promise<void> {
		this.activeCatalogDataRoot = normalizeCatalogRoot(context.bootstrap.catalogDataRoot);
		this.activeLegacySystemRoot = siblingRoot(
			this.activeCatalogDataRoot,
			"_knomo-system",
			getLegacySystemRootPath(this.getMonthlyMemoFolder()),
		);
		this.activeInstallMode = mode;
		this.activeVaultContext = context;
		this.activeInitializationAllowed = false;
		await this.pluginDataStore.mutate((current) => {
			const nextConfig = {
				schemaVersion: 2,
				catalogDataRoot: this.activeCatalogDataRoot as string,
				vaultInstanceId: context.bootstrap.vaultInstanceId,
				contractDigest: context.contractSha256,
			} as const;
			const currentConfig = extractCatalogV2PluginConfig(current);
			const unchanged = currentConfig?.schemaVersion === 2
				&& currentConfig.catalogDataRoot === nextConfig.catalogDataRoot
				&& currentConfig.vaultInstanceId === nextConfig.vaultInstanceId
				&& currentConfig.contractDigest === nextConfig.contractDigest;
			return {
				nextData: unchanged ? null : buildPluginDataWithCatalogV2Config(current, nextConfig),
				result: undefined,
			};
		});
	}

	private activateWithoutContext(
		catalogDataRoot: string,
		mode: CatalogV2InstallMode,
		legacySystemRoot = getLegacySystemRootPath(this.getMonthlyMemoFolder()),
		initializationAllowed = false,
	): void {
		this.activeCatalogDataRoot = normalizeCatalogRoot(catalogDataRoot);
		this.activeLegacySystemRoot = normalizeCatalogRoot(legacySystemRoot);
		this.activeInstallMode = mode;
		this.activeVaultContext = null;
		this.activeInitializationAllowed = initializationAllowed;
	}
}

function installModeFromBootstrap(context: CatalogV2VerifiedVaultContext): CatalogV2InstallMode {
	return context.bootstrap.initializationMode === "legacy_upgrade" ? "legacy_upgrade" : "existing_v2";
}

function hasConfiguredContextMismatch(
	configured: ReturnType<typeof extractCatalogV2PluginConfig>,
	context: CatalogV2VerifiedVaultContext,
): boolean {
	return configured?.schemaVersion === 2
		&& (configured.vaultInstanceId !== context.bootstrap.vaultInstanceId
			|| configured.contractDigest !== context.contractSha256
			|| normalizeCatalogRoot(configured.catalogDataRoot) !== context.bootstrap.catalogDataRoot);
}

export function buildCatalogV2VaultContract(
	settings: KnomoSettings,
	dailyNotes: DailyNotesConfig,
): CatalogV2VaultContract {
	return {
		kind: "knomo.catalog-v2.vault-contract",
		schemaVersion: 2,
		parserVersion: CATALOG_PARSER_VERSION,
		daily: {
			folder: dailyNotes.folder,
			dateFormat: dailyNotes.format,
			headings: [...new Set([settings.dailyHeading, ...settings.legacyDailyHeadings])],
			allowRootMemos: true,
		},
		monthly: {
			folder: normalizePath(settings.monthlyMemoFolder),
			fileFormat: settings.monthlyMemoFileFormat,
			dateHeadingFormat: settings.monthlyDateHeadingFormat,
			dateOrder: settings.monthlyDateOrder,
			rendererVersion: CATALOG_V2_MONTHLY_RENDERER_VERSION,
			newline: "lf",
		},
	};
}

interface CatalogV2UnbootstrappedState {
	mode: CatalogV2InstallMode;
	catalogDataRoot: string;
	legacySystemRoot: string;
	initializationAllowed: boolean;
}

function detectUnbootstrappedState(
	app: App,
	configured: ReturnType<typeof extractCatalogV2PluginConfig>,
	roots: { catalogDataRoot: string; legacySystemRoot: string },
): CatalogV2UnbootstrappedState {
	const files = app.vault.getFiles();
	const legacyConfigured = configured?.schemaVersion === 1 && "systemDataRoot" in configured;
	const legacyRoots = new Set<string>();
	if (legacyConfigured) legacyRoots.add(normalizeCatalogRoot(configured.systemDataRoot));
	for (const file of files) {
		const legacyRoot = findLegacySystemRoot(file.path);
		if (legacyRoot !== null) legacyRoots.add(legacyRoot);
	}
	if (legacyRoots.size > 1) {
		return {
			mode: "attention",
			catalogDataRoot: roots.catalogDataRoot,
			legacySystemRoot: roots.legacySystemRoot,
			initializationAllowed: false,
		};
	}
	const discoveredLegacyRoot = [...legacyRoots][0] ?? null;
	if (discoveredLegacyRoot !== null) {
		return {
			mode: "legacy_upgrade",
			catalogDataRoot: siblingRoot(discoveredLegacyRoot, "_knomo-data", roots.catalogDataRoot),
			legacySystemRoot: discoveredLegacyRoot,
			initializationAllowed: true,
		};
	}

	const configDir = `${normalizePath(app.vault.configDir ?? ".obsidian").replace(/\/$/u, "")}/`;
	const sharedProtocolEvidence = configured !== null || files.some((file) => {
		const path = normalizePath(file.path);
		return path.startsWith("_knomo-data/") || path.includes("/_knomo-data/");
	});
	if (sharedProtocolEvidence) {
		return {
			mode: "joining",
			catalogDataRoot: roots.catalogDataRoot,
			legacySystemRoot: roots.legacySystemRoot,
			initializationAllowed: false,
		};
	}
	const noteEvidence = files.some((file) => {
		const path = normalizePath(file.path);
		return !path.startsWith(configDir) && path.endsWith(".md");
	});
	return noteEvidence
		? {
			mode: "joining",
			catalogDataRoot: roots.catalogDataRoot,
			legacySystemRoot: roots.legacySystemRoot,
			initializationAllowed: true,
		}
		: {
			mode: "uninitialized",
			catalogDataRoot: roots.catalogDataRoot,
			legacySystemRoot: roots.legacySystemRoot,
			initializationAllowed: true,
		};
}

function findLegacySystemRoot(path: string): string | null {
	const normalized = normalizePath(path);
	const marker = "_knomo-system";
	const segments = normalized.split("/");
	const markerIndex = segments.lastIndexOf(marker);
	if (markerIndex < 0 || markerIndex === segments.length - 1) return null;
	const root = normalizeCatalogRoot(segments.slice(0, markerIndex + 1).join("/"));
	return classifyLegacyArtifactPath(root, normalized) === null ? null : root;
}

export function resolveCatalogRoots(
	configured: ReturnType<typeof extractCatalogV2PluginConfig>,
	monthlyMemoFolder: string,
): { catalogDataRoot: string; legacySystemRoot: string } {
	if (configured !== null && "catalogDataRoot" in configured) {
		const catalogDataRoot = normalizeCatalogRoot(configured.catalogDataRoot);
		return {
			catalogDataRoot,
			legacySystemRoot: siblingRoot(catalogDataRoot, "_knomo-system", getLegacySystemRootPath(monthlyMemoFolder)),
		};
	}
	if (configured !== null) {
		const legacySystemRoot = normalizeCatalogRoot(configured.systemDataRoot);
		return {
			catalogDataRoot: siblingRoot(legacySystemRoot, "_knomo-data", getCatalogDataRootPath(monthlyMemoFolder)),
			legacySystemRoot,
		};
	}
	return {
		catalogDataRoot: normalizeCatalogRoot(getCatalogDataRootPath(monthlyMemoFolder)),
		legacySystemRoot: normalizeCatalogRoot(getLegacySystemRootPath(monthlyMemoFolder)),
	};
}

export function normalizeCatalogRoot(value: string): string {
	const normalized = normalizePath(value.trim()).replace(/^\/+|\/+$/gu, "");
	if (normalized.length === 0 || normalized !== value.trim().replace(/^\/+|\/+$/gu, "")
		|| /(^|\/)\.{1,2}(\/|$)/u.test(normalized)
		|| /[\\\u0000-\u001f]/u.test(normalized)) {
		throw new Error(`Invalid Catalog data root: ${value}`);
	}
	return normalized;
}

function siblingRoot(root: string, siblingName: string, fallback: string): string {
	const separator = root.lastIndexOf("/");
	const name = separator < 0 ? root : root.slice(separator + 1);
	if (name !== "_knomo-system" && name !== "_knomo-data") return normalizeCatalogRoot(fallback);
	const parent = separator < 0 ? "" : root.slice(0, separator);
	return normalizeCatalogRoot(parent.length === 0 ? siblingName : `${parent}/${siblingName}`);
}

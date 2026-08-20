import { Notice, Platform, Plugin, TFile } from "obsidian";
import type { WorkspaceLeaf } from "obsidian";

import { KNOMO_VIEW_TYPE } from "./constants";
import { AttachmentService } from "./services/AttachmentService";
import {
	CATALOG_V2_SCANNER_ENABLED,
	CatalogShadowCoordinator,
	createCatalogDatabaseName,
} from "./services/CatalogShadowCoordinator";
import { DailyNoteService } from "./services/DailyNoteService";
import { DailyNotesProvider } from "./services/DailyNotesProvider";
import { DiaryMemoParser } from "./services/DiaryMemoParser";
import { CatalogV2DailyWriteGateway } from "./services/CatalogV2DailyWriteGateway";
import { CatalogV2FeatureService } from "./services/CatalogV2FeatureService";
import type { CatalogV2ReadService } from "./services/CatalogV2ReadService";
import { CatalogV2DeletedPayloadStore } from "./services/CatalogV2DeletedPayloadStore";
import { CatalogV2MutationRuntime } from "./services/CatalogV2MutationRuntime";
import { CatalogV2MonthlyProjectionCoordinator } from "./services/CatalogV2MonthlyProjectionCoordinator";
import { CATALOG_V2_MONTHLY_RENDERER_VERSION } from "./services/CatalogV2MonthlyProjection";
import { CatalogV2ProjectionInputBuilder } from "./services/CatalogV2ProjectionInputBuilder";
import { CatalogV2SharedMutationStore } from "./services/CatalogV2SharedMutationStore";
import { CatalogV2MigrationArtifactStore } from "./services/CatalogV2MigrationArtifactStore";
import { CatalogV2UpgradeCoordinator } from "./services/CatalogV2UpgradeCoordinator";
import { CatalogV2ImmutableStateWriter } from "./services/CatalogV2ImmutableStateWriter";
import { CatalogV2OperationWriter } from "./services/CatalogV2OperationWriter";
import {
	buildCatalogV2VaultContract,
	CatalogV2SystemRootService,
} from "./services/CatalogV2SystemRootService";
import { CatalogV2VaultProtocol } from "./services/CatalogV2VaultProtocol";
import { IndexedDbMemoCatalogStore } from "./services/IndexedDbMemoCatalogStore";
import { IndexedDbCatalogV2StateStore } from "./services/IndexedDbCatalogV2StateStore";
import { IndexedDbCatalogV2TransactionStore } from "./services/IndexedDbCatalogV2TransactionStore";
import {
	CATALOG_V2_STATE_RUNTIME_ENABLED,
	CatalogV2StateShadowCoordinator,
	createCatalogV2StateDatabaseName,
} from "./services/CatalogV2StateShadowCoordinator";
import { MemoCatalogService } from "./services/MemoCatalogService";
import { FallbackMemoCatalogStore, InMemoryMemoCatalogStore } from "./services/MemoCatalogStore";
import { ObsidianExcludeService } from "./services/ObsidianExcludeService";
import { PluginDataStore } from "./services/PluginDataStore";
import { SelfWriteTracker } from "./services/SelfWriteTracker";
import { SettingsService } from "./services/SettingsService";
import { ShuffleDayService } from "./services/ShuffleDayService";
import { ViewRefreshScheduler } from "./services/ViewRefreshScheduler";
import { VaultTagIndex } from "./services/VaultTagIndex";
import { KNOMO_LOGO_ICON, registerKnomoIcons } from "./icons";
import { t } from "./i18n";
import { KnomoSettingTab } from "./ui/KnomoSettingTab";
import { showKnomoConfirmModal } from "./ui/KnomoConfirmModal";
import { MobileNavbarCompactController } from "./ui/MobileNavbarCompactController";
import { KnomoView } from "./ui/KnomoView";
import type { CatalogRefreshResult } from "./ui/KnomoView";
import type { CatalogV2InstallMode } from "./types/catalogV2";
import { formatDatePart } from "./utils/date";

const OPEN_VIEWS_REFRESH_DEBOUNCE_MS = 150;
const DESKTOP_STARTUP_DAILY_SCAN_DAYS = 30;
const MOBILE_STARTUP_DAILY_SCAN_DAYS = 7;

export function getStartupDailyScanDays(isMobile: boolean): number {
	return isMobile ? MOBILE_STARTUP_DAILY_SCAN_DAYS : DESKTOP_STARTUP_DAILY_SCAN_DAYS;
}

export default class KnomoPlugin extends Plugin {
	settingsService!: SettingsService;
	manualRefreshPromise: Promise<CatalogRefreshResult> | null = null;
	private viewRefreshScheduler: ViewRefreshScheduler | null = null;
	private vaultTagIndex!: VaultTagIndex;
	private catalogShadowCoordinator: CatalogShadowCoordinator | null = null;
	private catalogV2StateShadowCoordinator: CatalogV2StateShadowCoordinator | null = null;
	private catalogV2MutationRuntime: CatalogV2MutationRuntime | null = null;
	private catalogV2UpgradeCoordinator: CatalogV2UpgradeCoordinator | null = null;
	private catalogV2FeatureService: CatalogV2FeatureService | null = null;
	private catalogV2ReadService: CatalogV2ReadService | null = null;
	private catalogV2MonthlyProjectionCoordinator: CatalogV2MonthlyProjectionCoordinator | null = null;
	private memoCatalogService: MemoCatalogService | null = null;
	private initializeCatalogVaultProtocol: (() => Promise<void>) | null = null;

	async onload(): Promise<void> {
		registerKnomoIcons();
		const selfWriteTracker = new SelfWriteTracker();
		const pluginDataStore = new PluginDataStore(this);
		this.settingsService = new SettingsService(this, pluginDataStore);
		this.vaultTagIndex = this.addChild(new VaultTagIndex(this.app));
		const settingsLoaded = await this.loadSettingsSafely();
		const diaryMemoParser = new DiaryMemoParser();
		const dailyNotesProvider = new DailyNotesProvider(this.app);
		const dailyNoteService = new DailyNoteService(this.app, dailyNotesProvider);
		await this.refreshDailyStatusSafely(dailyNoteService);
		const attachmentService = new AttachmentService(this.app);
		let catalogV2StateStore: IndexedDbCatalogV2StateStore | null = null;
		let catalogV2TransactionStore: IndexedDbCatalogV2TransactionStore | null = null;
		let catalogV2OperationWriter: CatalogV2OperationWriter | null = null;
		let catalogV2ImmutableStateWriter: CatalogV2ImmutableStateWriter | null = null;
		let catalogV2DeletedPayloadStore: CatalogV2DeletedPayloadStore | null = null;
		let catalogV2SharedMutationStore: CatalogV2SharedMutationStore | null = null;
		let migrationArtifactStore: CatalogV2MigrationArtifactStore | null = null;
		const catalogV2VaultProtocol = new CatalogV2VaultProtocol(this.app);
		const catalogV2SystemRootService = new CatalogV2SystemRootService(
			this.app,
			pluginDataStore,
			() => this.settingsService.getSettings().monthlyMemoFolder,
			catalogV2VaultProtocol,
		);
		let catalogDataRoot: string | null = null;
		let legacySystemRoot: string | null = null;
		let catalogInstallMode: CatalogV2InstallMode = "attention";
		let catalogUpgradeAuthorized = false;
		let localCatalogWriterId: string | null = null;
		try {
			catalogDataRoot = await catalogV2SystemRootService.initialize();
			legacySystemRoot = catalogV2SystemRootService.legacySystemRoot;
			catalogInstallMode = catalogV2SystemRootService.installMode;
		} catch {
			// 布局迁移未完整通过时不切换写入根，Catalog 仍可只读降级。
			new Notice(t("catalog.v2Unavailable"));
		}
		let observedContractDigest = catalogV2SystemRootService.vaultContext?.contractSha256 ?? null;
		let catalogContractChanged = false;
		const refreshCatalogVaultContext = async () => {
			const context = await catalogV2SystemRootService.refreshVaultContext();
			catalogInstallMode = catalogV2SystemRootService.installMode;
			if (context !== null) {
				const rootChanged = catalogDataRoot !== context.bootstrap.catalogDataRoot;
				catalogDataRoot = context.bootstrap.catalogDataRoot;
				legacySystemRoot = catalogV2SystemRootService.legacySystemRoot;
				if (rootChanged && settingsLoaded) {
					await this.settingsService.ensureCatalogDataExcludeRules(
						catalogDataRoot,
						legacySystemRoot,
						this.app.vault.getAbstractFileByPath(legacySystemRoot) !== null,
					).catch(() => undefined);
				}
			}
			if (context !== null && context.contractSha256 !== observedContractDigest) {
				observedContractDigest = context.contractSha256;
				catalogContractChanged = true;
			}
			return context;
		};
		if (settingsLoaded) await this.initializeTimeBuoyDefaultSafely();
		if (settingsLoaded && catalogDataRoot !== null && legacySystemRoot !== null) {
			try {
				await this.settingsService.ensureCatalogDataExcludeRules(
					catalogDataRoot,
					legacySystemRoot,
					this.app.vault.getAbstractFileByPath(legacySystemRoot) !== null,
				);
			} catch {
				// 排除规则失败不阻断本地数据初始化，用户仍可在设置中重试。
			}
		}
		if (catalogDataRoot !== null && legacySystemRoot !== null) {
			const stateStore = new IndexedDbCatalogV2StateStore(createCatalogV2StateDatabaseName(this.app));
			catalogV2StateStore = stateStore;
			migrationArtifactStore = new CatalogV2MigrationArtifactStore(
				this.app,
				() => catalogV2SystemRootService.catalogDataRoot,
			);
			this.catalogV2StateShadowCoordinator = new CatalogV2StateShadowCoordinator(
				this.app,
				stateStore,
				() => this.settingsService.getSettings().monthlyMemoFolder,
				this.manifest.id,
				undefined,
				{
					enabled: CATALOG_V2_STATE_RUNTIME_ENABLED,
					getCatalogDataRoot: () => catalogV2SystemRootService.catalogDataRoot,
					getLegacySystemRoot: () => catalogV2SystemRootService.legacySystemRoot,
					migrateLegacyLayout: () => catalogV2SystemRootService.refreshLegacyLayout(),
					migrationArtifactStore,
					canPersistMigrationArtifacts: () => catalogUpgradeAuthorized,
					protocol: catalogV2VaultProtocol,
					getVaultContext: refreshCatalogVaultContext,
					onCaptured: async () => {
						if (catalogContractChanged) {
							catalogContractChanged = false;
							await this.catalogShadowCoordinator?.refreshLocalCatalog();
							await this.catalogV2MonthlyProjectionCoordinator?.initialize().catch(() => undefined);
						}
						// 本机捕获只更新只读视图；分叉合并必须由明确的用户写操作触发。
						await this.catalogV2UpgradeCoordinator?.initialize();
						await this.catalogV2ReadService?.materializeResolutionSnapshot();
						await this.queueRefreshOpenViews();
					},
				},
			);
			this.catalogV2StateShadowCoordinator.start(this);
			const transactionStore = new IndexedDbCatalogV2TransactionStore(
				`${createCatalogV2StateDatabaseName(this.app)}-transactions`,
			);
			catalogV2TransactionStore = transactionStore;
			this.register(() => transactionStore.close());
			const immutableStateWriter = new CatalogV2ImmutableStateWriter(
				catalogV2VaultProtocol,
				() => catalogV2SystemRootService.vaultContext,
			);
			catalogV2ImmutableStateWriter = immutableStateWriter;
			const operationWriter = new CatalogV2OperationWriter(stateStore, transactionStore, immutableStateWriter);
			catalogV2OperationWriter = operationWriter;
			const deletedPayloadStore = new CatalogV2DeletedPayloadStore(
				this.app,
				() => catalogV2SystemRootService.catalogDataRoot,
			);
			catalogV2DeletedPayloadStore = deletedPayloadStore;
			const sharedMutationStore = new CatalogV2SharedMutationStore(
				this.app,
				catalogV2VaultProtocol,
				refreshCatalogVaultContext,
			);
			catalogV2SharedMutationStore = sharedMutationStore;
			this.catalogV2MutationRuntime = new CatalogV2MutationRuntime(
				new CatalogV2DailyWriteGateway(this.app),
				transactionStore,
				operationWriter,
				deletedPayloadStore,
				(path) => {
					const file = this.app.vault.getAbstractFileByPath(path);
					return file instanceof TFile ? file : null;
				},
				undefined,
				undefined,
				async (memoId, createIntentOpId) => {
					const context = await refreshCatalogVaultContext();
					if (context === null) return false;
					const selection = await catalogV2VaultProtocol.selectGeneration(context);
					return selection.kind === "verified" && selection.value.operations.some((operation) =>
						operation.memoId === memoId && operation.opId === createIntentOpId
						&& operation.type === "lifecycle.create_intent");
				},
				sharedMutationStore,
				refreshCatalogVaultContext,
				async () => {
					if (!stateStore.isAuthoritative()) throw new Error("Catalog v2 writer identity storage is unavailable.");
					localCatalogWriterId = await stateStore.getOrCreateWriterId();
					return localCatalogWriterId;
				},
				(writerId, commit, memoIds, controlled) =>
					immutableStateWriter.commitSharedMutation(writerId, commit, memoIds, controlled),
				async () => {
					const context = await refreshCatalogVaultContext();
					const input = await this.catalogV2StateShadowCoordinator?.loadLocalStateSnapshot(false) ?? null;
					const generationId = input?.settlement.verifiedGenerationId;
					const contractDigest = input?.settlement.contractDigest;
					if (context === null || input === null || !input.settlement.stateComplete
						|| !input.settlement.revisionStable || generationId === undefined
						|| contractDigest !== context.contractSha256) return null;
					return {
						state: input.snapshot.state,
						vaultInstanceId: context.bootstrap.vaultInstanceId,
						contractDigest,
						verifiedGenerationId: generationId,
					};
				},
			);
		}
		const memoCatalogStore = new FallbackMemoCatalogStore(
			new IndexedDbMemoCatalogStore(createCatalogDatabaseName(this.app)),
			new InMemoryMemoCatalogStore(),
			() => this.catalogShadowCoordinator?.refreshLocalCatalog(),
		);
		this.memoCatalogService = new MemoCatalogService(memoCatalogStore);
		// 工作区恢复早于布局就绪回调，先打开视图查询依赖，避免首次渲染访问尚未打开的存储。
		await this.memoCatalogService.open();
		await catalogV2StateStore?.open();
		await catalogV2TransactionStore?.open();
		const projectionInputBuilder = new CatalogV2ProjectionInputBuilder(
			this.app,
			diaryMemoParser,
			{
				getDailyConfig: () => {
					const contract = catalogV2SystemRootService.vaultContext?.contract;
					return contract === undefined
						? dailyNoteService.getDailyNotesConfig()
						: Promise.resolve({ folder: contract.daily.folder, format: contract.daily.dateFormat });
				},
				getHeadings: () => {
					const contract = catalogV2SystemRootService.vaultContext?.contract;
					if (contract !== undefined) return contract.daily.headings;
					const settings = this.settingsService.getSettings();
					return [settings.dailyHeading, ...settings.legacyDailyHeadings];
				},
				getSettings: () => {
					const contract = catalogV2SystemRootService.vaultContext?.contract;
					if (contract !== undefined) {
						return {
							monthlyMemoFolder: contract.monthly.folder,
							monthlyMemoFileFormat: contract.monthly.fileFormat,
							monthlyDateHeadingFormat: contract.monthly.dateHeadingFormat,
							monthlyDateOrder: contract.monthly.dateOrder,
						};
					}
					const settings = this.settingsService.getSettings();
					return {
						monthlyMemoFolder: settings.monthlyMemoFolder,
						monthlyMemoFileFormat: settings.monthlyMemoFileFormat,
						monthlyDateHeadingFormat: settings.monthlyDateHeadingFormat,
						monthlyDateOrder: settings.monthlyDateOrder,
					};
				},
				getRendererVersion: () => catalogV2SystemRootService.vaultContext?.contract.monthly.rendererVersion
					?? CATALOG_V2_MONTHLY_RENDERER_VERSION,
			},
		);
		this.catalogV2MonthlyProjectionCoordinator = new CatalogV2MonthlyProjectionCoordinator(
			this.app,
			{ inputBuilder: projectionInputBuilder, selfWriteTracker },
		);
		this.catalogV2MonthlyProjectionCoordinator.start(this);
		await this.catalogV2MonthlyProjectionCoordinator.initialize().catch(() => undefined);
		if (catalogInstallMode === "existing_v2" && this.catalogV2StateShadowCoordinator !== null) {
			await this.catalogV2StateShadowCoordinator.initialize();
			await this.catalogV2StateShadowCoordinator.capture(false);
		}
		this.catalogShadowCoordinator = new CatalogShadowCoordinator(
			this.app,
			this.memoCatalogService,
			diaryMemoParser,
			() => {
				const contract = catalogV2SystemRootService.vaultContext?.contract;
				return contract === undefined
					? dailyNoteService.getDailyNotesConfig()
					: Promise.resolve({ folder: contract.daily.folder, format: contract.daily.dateFormat });
			},
			() => {
				const contract = catalogV2SystemRootService.vaultContext?.contract;
				if (contract !== undefined) return contract.daily.headings;
				const settings = this.settingsService.getSettings();
				return [settings.dailyHeading, ...settings.legacyDailyHeadings];
			},
			{
				enabled: CATALOG_V2_SCANNER_ENABLED,
				onProgress: () => this.queueRefreshOpenViews(),
				onCatalogSettled: async () => {
					await this.catalogV2UpgradeCoordinator?.run();
					await this.catalogV2ReadService?.materializeResolutionSnapshot();
					await this.queueRefreshOpenViews();
				},
			},
		);
		this.catalogShadowCoordinator.start(this);
		await this.catalogShadowCoordinator.initialize();
		this.catalogV2FeatureService = new CatalogV2FeatureService(
			this.app,
			this.memoCatalogService,
			catalogV2StateStore,
			this.catalogV2StateShadowCoordinator,
			catalogV2TransactionStore,
			this.catalogV2MutationRuntime,
			catalogV2DeletedPayloadStore,
			{
				installMode: catalogInstallMode,
				getInstallMode: () => catalogInstallMode,
				getHeadings: () => {
					const contract = catalogV2SystemRootService.vaultContext?.contract;
					if (contract !== undefined) return contract.daily.headings;
					const settings = this.settingsService.getSettings();
					return [settings.dailyHeading, ...settings.legacyDailyHeadings];
				},
				getOrCreateDailyFile: (date) => {
					const contract = catalogV2SystemRootService.vaultContext?.contract;
					return contract === undefined
						? dailyNoteService.getOrCreateDailyNoteForDate(date)
						: dailyNoteService.getOrCreateDailyNoteForDateWithConfig(date, {
							folder: contract.daily.folder,
							format: contract.daily.dateFormat,
						});
				},
				removeEmptyCreatedDailyFile: async (file) => {
					// 新 Daily 只是 create 的预备目标；共享 intent 失败时不留下空文件。
					if ((await this.app.vault.cachedRead(file)).length === 0) await this.app.fileManager.trashFile(file);
				},
				getDailyFileForDate: (logicalDate) => {
					const date = parseLogicalDate(logicalDate);
					const contract = catalogV2SystemRootService.vaultContext?.contract;
					return contract === undefined
						? dailyNoteService.getOrCreateDailyNoteForDate(date)
						: dailyNoteService.getOrCreateDailyNoteForDateWithConfig(date, {
							folder: contract.daily.folder,
							format: contract.daily.dateFormat,
						});
				},
				refreshCatalogPaths: (paths) => this.catalogShadowCoordinator?.refreshPaths(paths) ?? Promise.resolve(),
				refreshLocalCatalog: () => this.catalogShadowCoordinator?.refreshLocalCatalog() ?? Promise.resolve(),
				getMemoTimeFormat: () => this.settingsService.getSettings().memoTimeFormat,
				rebuildLocalCatalog: () => this.catalogShadowCoordinator?.rebuildLocalCatalog() ?? Promise.resolve(),
				getVaultContext: refreshCatalogVaultContext,
				getWriterId: async () => {
					if (catalogV2StateStore?.isAuthoritative() !== true) {
						throw new Error("Catalog v2 writer identity storage is unavailable.");
					}
					localCatalogWriterId = await catalogV2StateStore.getOrCreateWriterId();
					return localCatalogWriterId;
				},
				isControlAuthority: () => catalogV2StateStore?.isAuthoritative() === true
					&& localCatalogWriterId !== null
					&& catalogV2SystemRootService.vaultContext?.control.generation.authorityWriterId
						=== localCatalogWriterId,
				vaultProtocol: catalogV2VaultProtocol,
				...(catalogV2SharedMutationStore === null ? {} : {
					inspectSharedMutations: () => catalogV2SharedMutationStore.inspect(),
				}),
			},
		);
		this.catalogV2ReadService = this.catalogV2FeatureService.getReadService();
		if (catalogV2StateStore !== null && catalogV2TransactionStore !== null
			&& catalogV2OperationWriter !== null && catalogV2DeletedPayloadStore !== null
			&& this.catalogV2StateShadowCoordinator !== null
			&& this.catalogV2MutationRuntime !== null && this.memoCatalogService !== null) {
			if (catalogDataRoot !== null && legacySystemRoot !== null && migrationArtifactStore !== null) {
				this.catalogV2UpgradeCoordinator = new CatalogV2UpgradeCoordinator(
					this.app,
					() => catalogV2SystemRootService.catalogDataRoot,
					legacySystemRoot,
					this.memoCatalogService,
					catalogV2StateStore,
					this.catalogV2StateShadowCoordinator,
					catalogV2TransactionStore,
					migrationArtifactStore,
					{
						sessionId: `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`,
						installMode: catalogInstallMode,
						getInstallMode: () => catalogInstallMode,
						legacyReadsDisabled: () => true,
						legacyWriterRemoved: () => true,
						canWriteSharedUpgrade: () => catalogUpgradeAuthorized,
						commitMigration: async (commit, generationDigest, memoIds, supersedes) => {
							if (catalogV2ImmutableStateWriter === null || !catalogV2StateStore.isAuthoritative()) {
								throw new Error("Catalog v2 immutable state writer is unavailable.");
							}
							await catalogV2ImmutableStateWriter.commitMigration(
								await catalogV2StateStore.getOrCreateWriterId(),
								commit,
								generationDigest,
								memoIds,
								supersedes,
							);
						},
						onLegacyRootRetired: () => this.settingsService.retireLegacySystemExcludeRule(),
						onLegacyRootBlocked: () => new Notice(t("catalog.legacyRootNotEmpty")),
					},
				);
				if (catalogInstallMode === "existing_v2") await this.catalogV2UpgradeCoordinator.initialize();
			}
		}
		if (catalogInstallMode === "existing_v2") {
			try {
				await this.catalogV2ReadService.prime();
			} catch {
				// 首次预热失败时由视图按可读状态降级，Daily 内容不受影响。
			}
		}
		this.viewRefreshScheduler = new ViewRefreshScheduler(
			() => this.app.workspace.containerEl.win,
			() => this.runRefreshOpenViews(),
			OPEN_VIEWS_REFRESH_DEBOUNCE_MS,
		);
		const shuffleDayService = new ShuffleDayService(pluginDataStore);
		const obsidianExcludeService = new ObsidianExcludeService(this.app);
		this.registerView(
			KNOMO_VIEW_TYPE,
			(leaf: WorkspaceLeaf) => new KnomoView(
				leaf,
				this.settingsService,
				shuffleDayService,
				attachmentService,
				this.vaultTagIndex,
				() => this.runRefreshOpenViews(true),
				() => this.runManualRefresh(),
				this.catalogV2FeatureService!,
				this.catalogV2ReadService!,
				() => dailyNoteService.getStatus(),
				() => dailyNoteService.getTodayDailyNotePath(),
				() => catalogInstallMode,
				() => catalogV2SystemRootService.initializationAllowed,
				() => this.initializeCatalogVaultProtocol?.() ?? Promise.resolve(),
				async () => {
					await refreshCatalogVaultContext();
					await this.catalogShadowCoordinator?.waitForIdle();
					const catalogWasUsingFallback = memoCatalogStore.isUsingFallback;
					await this.memoCatalogService?.open();
					if (catalogWasUsingFallback && !memoCatalogStore.isUsingFallback) {
						await this.catalogShadowCoordinator?.refreshLocalCatalog();
					}
					await catalogV2StateStore?.retryOpen();
					await catalogV2TransactionStore?.retryOpen();
					await this.catalogV2StateShadowCoordinator?.initialize();
					await this.catalogV2StateShadowCoordinator?.capture(false);
				},
				() => this.openCatalogDataSettings(),
			),
		);
		this.registerAttachmentEvents();

		this.registerHoverLinkSource(KNOMO_VIEW_TYPE, {
			display: "Knomo",
			defaultMod: false,
		});

		this.addRibbonIcon(KNOMO_LOGO_ICON, t("app.openKnomo"), () => {
			void this.activateView();
		});

		this.addCommand({
			id: "open-view",
			name: t("app.openKnomo"),
			callback: () => {
				void this.activateView();
			},
		});

		this.initializeCatalogVaultProtocol = async () => {
			const existingContext = catalogV2SystemRootService.vaultContext;
			if (existingContext === null && !catalogV2SystemRootService.initializationAllowed) {
				if (catalogInstallMode === "attention") {
					new Notice(t("catalog.attentionDesc"));
					return;
				}
				new Notice(t("catalog.joiningInitializeBlocked"));
				return;
			}
			const initialMode = catalogInstallMode;
			if (existingContext === null && !await showKnomoConfirmModal(this.app, {
				message: initialMode === "joining"
					? t("catalog.initializeNonemptyVaultConfirm")
					: initialMode === "legacy_upgrade"
						? t("catalog.upgradeVaultConfirm")
						: t("catalog.initializeVaultConfirm"),
			})) return;
			if (catalogV2StateStore === null || catalogV2TransactionStore === null
				|| catalogV2ImmutableStateWriter === null) {
				new Notice(t("catalog.initializeVaultStorageUnavailable"));
				return;
			}
			await catalogV2StateStore.open();
			await catalogV2TransactionStore.open();
			if (!catalogV2StateStore.isAuthoritative() || !catalogV2TransactionStore.isAuthoritative()) {
				new Notice(t("catalog.initializeVaultStorageUnavailable"));
				return;
			}
			try {
				const writerId = await catalogV2StateStore.getOrCreateWriterId();
				localCatalogWriterId = writerId;
				if (existingContext === null) {
					const dailyConfig = await dailyNoteService.getDailyNotesConfig();
					await catalogV2SystemRootService.initializeVault(
						buildCatalogV2VaultContract(this.settingsService.getSettings(), dailyConfig),
						writerId,
					);
					catalogInstallMode = catalogV2SystemRootService.installMode;
				}
				catalogUpgradeAuthorized = initialMode === "legacy_upgrade";
				try {
					await catalogV2ImmutableStateWriter.reconcile(writerId);
					await this.catalogV2StateShadowCoordinator?.initialize();
					await this.catalogV2StateShadowCoordinator?.capture(false);
					await this.catalogV2UpgradeCoordinator?.initialize();
					await this.catalogV2ReadService?.prime();
					await this.queueRefreshOpenViews();
					new Notice(existingContext === null
						? initialMode === "joining"
							? t("catalog.initializeNonemptyVaultDone")
							: t("catalog.initializeVaultDone")
						: t("catalog.initializeVaultExisting"));
				} finally {
					catalogUpgradeAuthorized = false;
				}
			} catch {
				catalogUpgradeAuthorized = false;
				new Notice(t("catalog.v2Unavailable"));
			}
		};
		this.addCommand({
			id: "initialize-vault-protocol",
			name: t("catalog.initializeVault"),
			checkCallback: (checking) => {
				if (catalogV2SystemRootService.vaultContext === null
					&& !catalogV2SystemRootService.initializationAllowed) return false;
				if (!checking) void this.initializeCatalogVaultProtocol?.();
				return true;
			},
		});
		this.addCommand({
			id: "request-catalog-authority-transfer",
			name: t("catalog.requestAuthorityTransfer"),
			checkCallback: (checking) => {
				const context = catalogV2SystemRootService.vaultContext;
				if (context === null || catalogV2StateStore?.isAuthoritative() !== true) return false;
				if (!checking) void (async () => {
					try {
						const writerId = await catalogV2StateStore.getOrCreateWriterId();
						localCatalogWriterId = writerId;
						if (writerId === context.control.generation.authorityWriterId) {
							new Notice(t("catalog.authorityAlreadyLocal"));
							return;
						}
						await catalogV2VaultProtocol.requestAuthorityTransfer(context, writerId, new Date().toISOString());
						new Notice(t("catalog.authorityTransferRequested"));
					} catch {
						new Notice(t("catalog.authorityTransferFailed"));
					}
				})();
				return true;
			},
		});
		this.addCommand({
			id: "approve-catalog-authority-transfer",
			name: t("catalog.approveAuthorityTransfer"),
			checkCallback: (checking) => {
				const context = catalogV2SystemRootService.vaultContext;
				if (context === null || catalogV2StateStore?.isAuthoritative() !== true) return false;
				if (!checking) void (async () => {
					try {
						const writerId = await catalogV2StateStore.getOrCreateWriterId();
						localCatalogWriterId = writerId;
						if (writerId !== context.control.generation.authorityWriterId) {
							new Notice(t("catalog.authorityApprovalNotLocal"));
							return;
						}
						const requests = (await catalogV2VaultProtocol.listAuthorityTransferRequests(context))
							.filter((item) => item.request.targetWriterId !== writerId);
						if (requests.length !== 1) {
							new Notice(requests.length === 0
								? t("catalog.authorityRequestMissing")
								: t("catalog.authorityRequestAmbiguous"));
							return;
						}
						const approved = await showKnomoConfirmModal(this.app, {
							message: t("catalog.authorityTransferConfirm"),
						});
						if (!approved) return;
						const request = requests[0];
						if (request === undefined) return;
						await catalogV2VaultProtocol.transferAuthority(
							context,
							writerId,
							request.requestRef,
							new Date().toISOString(),
						);
						await refreshCatalogVaultContext();
						new Notice(t("catalog.authorityTransferApproved"));
					} catch {
						new Notice(t("catalog.authorityTransferFailed"));
					}
				})();
				return true;
			},
		});

		this.addSettingTab(new KnomoSettingTab(
			this.app,
			this,
			this.settingsService,
			obsidianExcludeService,
			this.catalogV2FeatureService!,
			this.catalogV2ReadService!,
			this.catalogV2MonthlyProjectionCoordinator!,
		));

		this.app.workspace.onLayoutReady(() => {
			void this.initializeAfterLayoutWithCatalogSafely();
		});
	}

	onunload(): void {
		this.initializeCatalogVaultProtocol = null;
		this.viewRefreshScheduler?.clear();
		MobileNavbarCompactController.cleanupDocument(this.app.workspace.containerEl.doc);
	}

	async activateView(): Promise<void> {
		const existingLeaves = this.app.workspace.getLeavesOfType(KNOMO_VIEW_TYPE);
		if (existingLeaves.length > 0) {
			const leaf = existingLeaves[0];
			await this.app.workspace.revealLeaf(leaf);
			this.app.workspace.setActiveLeaf(leaf, { focus: true });
			this.requestMobileNavbarSync(leaf);
			return;
		}

		const leaf = this.app.workspace.getLeaf("tab");
		await leaf.setViewState({
			type: KNOMO_VIEW_TYPE,
			active: true,
		});
		await this.app.workspace.revealLeaf(leaf);
		this.app.workspace.setActiveLeaf(leaf, { focus: true });
		this.requestMobileNavbarSync(leaf);
	}

	private requestMobileNavbarSync(leaf: WorkspaceLeaf): void {
		if (Platform.isMobile && leaf.view instanceof KnomoView) {
			leaf.view.requestMobileNavbarSync();
		}
	}

	private async refreshOpenViews(): Promise<void> {
		if (this.viewRefreshScheduler === null) {
			await this.runRefreshOpenViews(true);
			return;
		}
		this.viewRefreshScheduler.clear();
		await this.runRefreshOpenViews(true);
	}

	private async queueRefreshOpenViews(): Promise<void> {
		if (this.viewRefreshScheduler === null) {
			await this.runRefreshOpenViews();
			return;
		}
		await this.viewRefreshScheduler.queue();
	}

	private async runRefreshOpenViews(forceRebuild = false): Promise<void> {
		const refreshes = this.app.workspace.getLeavesOfType(KNOMO_VIEW_TYPE).map(async (leaf) => {
			if (leaf.view instanceof KnomoView) {
				await leaf.view.refresh(forceRebuild);
			}
		});
		await Promise.all(refreshes);
	}

	private registerAttachmentEvents(): void {
		this.registerEvent(this.app.vault.on("create", (file) => {
			if (file instanceof TFile && isSupportedImagePath(file.path)) {
				this.broadcastAttachmentChanges([file.path]);
			}
		}));
		this.registerEvent(this.app.vault.on("modify", (file) => {
			if (file instanceof TFile && isSupportedImagePath(file.path)) {
				this.broadcastAttachmentChanges([file.path]);
			}
		}));
		this.registerEvent(this.app.vault.on("delete", (file) => {
			if (file instanceof TFile && isSupportedImagePath(file.path)) {
				this.broadcastAttachmentChanges([file.path]);
			}
		}));
		this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
			const paths = [
				isSupportedImagePath(oldPath) ? oldPath : null,
				file instanceof TFile && isSupportedImagePath(file.path) ? file.path : null,
			].filter((path): path is string => path !== null);
			if (paths.length > 0) {
				this.broadcastAttachmentChanges(paths);
			}
		}));
	}

	private broadcastAttachmentChanges(paths: readonly string[]): void {
		for (const leaf of this.app.workspace.getLeavesOfType(KNOMO_VIEW_TYPE)) {
			if (leaf.view instanceof KnomoView) {
				leaf.view.handleAttachmentFilesChanged(paths);
			}
		}
	}

	private async loadSettingsSafely(): Promise<boolean> {
		try {
			await this.settingsService.loadSettings();
			return true;
		} catch {
			// 启动提示会干扰快速记录；读取失败时继续使用默认设置。
			return false;
		}
	}

	private async initializeTimeBuoyDefaultSafely(): Promise<void> {
		try {
			await this.settingsService.initializeTimeBuoyDefault();
		} catch {
			// 默认策略初始化失败时保持关闭，避免升级用户被意外扫描。
		}
	}

	private async refreshDailyStatusSafely(dailyNoteService: DailyNoteService): Promise<void> {
		try {
			await dailyNoteService.refreshStatus();
		} catch {
			// 日记状态会在实际写入时再次校验，这里不弹启动提示。
		}
	}

	private async initializeAfterLayoutSafely(): Promise<void> {
		try {
			await this.catalogV2StateShadowCoordinator?.initialize();
		} catch {
			// 本机状态不可用时保留只读 Catalog 和 Daily 快速记录能力。
		}
	}

	private openCatalogDataSettings(): void {
		const setting = (this.app as typeof this.app & {
			setting: {
				open: () => void;
				openTabById?: (id: string) => void;
			};
		}).setting as {
			open: () => void;
			openTabById?: (id: string) => void;
		};
		setting.open();
		setting.openTabById?.(this.manifest.id);
	}

	private async initializeAfterLayoutWithCatalogSafely(): Promise<void> {
		try {
			await this.initializeAfterLayoutSafely();
		} finally {
			try {
				await this.catalogShadowCoordinator?.initialize();
				await this.catalogV2UpgradeCoordinator?.initialize();
				await this.catalogV2ReadService?.prime();
			} catch {
				// Catalog Shadow 只是只读诊断层，失败不能影响当前稳定功能。
			}
		}
	}

	private runManualRefresh(): Promise<CatalogRefreshResult> {
		if (this.manualRefreshPromise !== null) {
			return this.manualRefreshPromise;
		}
		const refresh = (this.catalogV2FeatureService?.refreshLocalCatalog() ?? Promise.resolve()).then(async () => {
				const coverage = await this.memoCatalogService?.getStore().getCoverage();
				return {
					scannedFiles: coverage?.totalFileCount ?? 0,
					created: coverage?.coveredFileCount ?? 0,
					updated: 0,
					deleted: 0,
					skipped: 0,
					failed: coverage?.pendingFileCount ?? 0,
					errors: [],
				};
			});
		this.manualRefreshPromise = refresh
			.then(async (result) => {
				await this.refreshOpenViews();
				return result;
			})
			.finally(() => {
				this.manualRefreshPromise = null;
			});
		return this.manualRefreshPromise;
	}
}

function parseLogicalDate(value: string): Date {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
	if (match === null) throw new Error(`Invalid logical date: ${value}`);
	const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
	if (formatDatePart(date) !== value) throw new Error(`Invalid logical date: ${value}`);
	return date;
}

const SUPPORTED_IMAGE_EXTENSIONS = new Set(["avif", "bmp", "gif", "jpeg", "jpg", "png", "svg", "webp"]);

function isSupportedImagePath(path: string): boolean {
	const extensionIndex = path.lastIndexOf(".");
	return extensionIndex !== -1 && SUPPORTED_IMAGE_EXTENSIONS.has(path.slice(extensionIndex + 1).toLowerCase());
}

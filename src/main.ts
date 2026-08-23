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
import { CatalogV2MonthlyProjectionCoordinator } from "./services/CatalogV2MonthlyProjectionCoordinator";
import { CatalogV2ProjectionInputBuilder } from "./services/CatalogV2ProjectionInputBuilder";
import { CatalogV2ReadOnlyCompatibilitySource } from "./services/CatalogV2ReadOnlyCompatibilitySource";
import { CatalogV3LegacyIdentityImporter } from "./services/CatalogV3LegacyIdentityImporter";
import { IndexedDbMemoCatalogStore } from "./services/IndexedDbMemoCatalogStore";
import { createIdentityLedgerWriterId, getIdentityLedgerRootPath } from "./services/IdentityLedgerProtocol";
import { IdentityLedgerService } from "./services/IdentityLedgerService";
import { KnomoDataRootMigrationService } from "./services/KnomoDataRootMigrationService";
import {
	buildKnomoSharedConfig,
	getKnomoSharedConfigRootPath,
} from "./services/KnomoSharedConfigProtocol";
import { KnomoSharedConfigService } from "./services/KnomoSharedConfigService";
import { MemoCatalogService } from "./services/MemoCatalogService";
import { MarkdownMutationService } from "./services/MarkdownMutationService";
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
import { MobileNavbarCompactController } from "./ui/MobileNavbarCompactController";
import { KnomoView } from "./ui/KnomoView";
import type { CatalogRefreshResult } from "./ui/KnomoView";
import type { CatalogFileRevisionBatch } from "./types/catalog";
import { formatDatePart } from "./utils/date";
import { parseDailyNoteDateFromPath } from "./utils/dailyNotes";

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
	private catalogV2FeatureService: CatalogV2FeatureService | null = null;
	private catalogV2ReadService: CatalogV2ReadService | null = null;
	private catalogV2MonthlyProjectionCoordinator: CatalogV2MonthlyProjectionCoordinator | null = null;
	private legacyIdentityImporter: CatalogV3LegacyIdentityImporter | null = null;
	private memoCatalogService: MemoCatalogService | null = null;

	async onload(): Promise<void> {
		registerKnomoIcons();
		const selfWriteTracker = new SelfWriteTracker();
		const pluginDataStore = new PluginDataStore(this);
		this.settingsService = new SettingsService(this, pluginDataStore);
		this.vaultTagIndex = this.addChild(new VaultTagIndex(this.app));
		const settingsLoaded = await this.loadSettingsSafely();
		if (settingsLoaded) await this.initializeTimeBuoyDefaultSafely();

		const diaryMemoParser = new DiaryMemoParser();
		const dailyNotesProvider = new DailyNotesProvider(this.app);
		const dailyNoteService = new DailyNoteService(this.app, dailyNotesProvider);
		await this.refreshDailyStatusSafely(dailyNoteService);
		const attachmentService = new AttachmentService(this.app);

		const memoCatalogStore = new FallbackMemoCatalogStore(
			new IndexedDbMemoCatalogStore(createCatalogDatabaseName(this.app)),
			new InMemoryMemoCatalogStore(),
			() => this.catalogShadowCoordinator?.refreshLocalCatalog(),
		);
		this.memoCatalogService = new MemoCatalogService(memoCatalogStore);
		// 工作区恢复早于布局就绪回调，先打开视图查询依赖。
		await this.memoCatalogService.open();

		const sessionWriterId = createIdentityLedgerWriterId();
		const identityLedgerService = new IdentityLedgerService(this.app, {
			getRootPath: () => {
				const settings = this.settingsService.getSettings();
				return settings.knomoDataRootConfigured
					? getIdentityLedgerRootPath(settings.knomoDataRoot)
					: null;
			},
			getWriterId: async () => sessionWriterId,
		});
		await identityLedgerService.initialize();

		const knomoSharedConfigService = new KnomoSharedConfigService(this.app, {
			getRootPath: () => {
				const settings = this.settingsService.getSettings();
				return settings.knomoDataRootConfigured
					? getKnomoSharedConfigRootPath(settings.knomoDataRoot)
					: null;
			},
			getWriterId: async () => sessionWriterId,
			getLocalConfig: async () => buildKnomoSharedConfig(
				await dailyNoteService.getDailyNotesConfig(),
				this.settingsService.getSettings(),
			),
		});
		await knomoSharedConfigService.initialize();

		const getEffectiveDailyConfig = () => {
			const config = knomoSharedConfigService.getEffectiveConfig();
			return { folder: config.daily.folder, format: config.daily.dateFormat };
		};
		const getEffectiveHeadings = () => knomoSharedConfigService.getEffectiveConfig().daily.headings;
		const getEffectiveMonthlySettings = () => {
			const monthly = knomoSharedConfigService.getEffectiveConfig().monthly;
			return {
				monthlyMemoFolder: monthly.folder,
				monthlyMemoFileFormat: monthly.fileFormat,
				monthlyDateHeadingFormat: monthly.dateHeadingFormat,
				monthlyDateOrder: monthly.dateOrder,
			};
		};

		if (settingsLoaded
			&& this.settingsService.getSettings().knomoDataRootConfigured
			&& identityLedgerService.getStatus() === "missing") {
			new Notice(t("settings.dataRoot.missing", {
				path: this.settingsService.getSettings().knomoDataRoot,
			}));
		}

		const knomoDataRootMigrationService = new KnomoDataRootMigrationService(
			this.app,
			identityLedgerService,
			() => this.settingsService.getSettings(),
			async (nextDataRoot) => {
				await this.settingsService.commitKnomoDataRoot(nextDataRoot);
			},
			{
				migrateSharedConfiguration: (sourceDataRoot, targetDataRoot) =>
					knomoSharedConfigService.copyAndVerifyDataRoot(sourceDataRoot, targetDataRoot),
			},
		);

		const loadObservationBatches = async (): Promise<CatalogFileRevisionBatch[]> => {
			const files = await this.memoCatalogService!.listFiles();
			const batches = await Promise.all(files.map((file) =>
				this.memoCatalogService!.getFileRevisionBatch(file.sourcePath)));
			return batches.filter((batch): batch is CatalogFileRevisionBatch => batch !== null);
		};
		const reconcileIdentityLedger = async () => {
			const batches = await loadObservationBatches();
			await identityLedgerService.reconcilePendingCreates(
				batches.flatMap((batch) => batch.observations),
			);
		};

		const projectionInputBuilder = new CatalogV2ProjectionInputBuilder(
			this.app,
			diaryMemoParser,
			{
				getDailyConfig: () => Promise.resolve(getEffectiveDailyConfig()),
				getHeadings: getEffectiveHeadings,
				getSettings: getEffectiveMonthlySettings,
				getRendererVersion: () => knomoSharedConfigService.getEffectiveConfig().monthly.rendererVersion,
			},
		);
		this.catalogV2MonthlyProjectionCoordinator = new CatalogV2MonthlyProjectionCoordinator(
			this.app,
			{
				inputBuilder: projectionInputBuilder,
				selfWriteTracker,
				isProjectionAllowed: () => knomoSharedConfigService.isMonthlyProjectionAllowed(),
				onStateChanged: () => { void this.queueRefreshOpenViews(); },
			},
		);

		this.catalogShadowCoordinator = new CatalogShadowCoordinator(
			this.app,
			this.memoCatalogService,
			diaryMemoParser,
			() => Promise.resolve(getEffectiveDailyConfig()),
			getEffectiveHeadings,
			{
				enabled: CATALOG_V2_SCANNER_ENABLED,
				isConfigurationComplete: () => knomoSharedConfigService.isCoverageComplete(),
				onProgress: () => this.queueRefreshOpenViews(),
				onRevisionTransition: async (transition) => {
					await identityLedgerService.reconcileRevision(
						transition.before?.observations ?? [],
						transition.after.observations,
					);
				},
				onCatalogSettled: async () => {
					await this.legacyIdentityImporter?.run();
					await reconcileIdentityLedger();
					await this.catalogV2ReadService?.materializeResolutionSnapshot();
					await this.queueRefreshOpenViews();
				},
			},
		);

		const markdownMutationService = new MarkdownMutationService(this.app, {
			getHeadings: getEffectiveHeadings,
			getDailyFileForDate: (logicalDate) => {
				const date = parseLogicalDate(logicalDate);
				return dailyNoteService.getOrCreateDailyNoteForDateWithConfig(date, getEffectiveDailyConfig());
			},
			getLogicalDateForPath: async (sourcePath) => {
				const date = parseDailyNoteDateFromPath(sourcePath, getEffectiveDailyConfig());
				if (date === null) throw new Error("Daily path does not match the active configuration: " + sourcePath);
				return formatDatePart(date);
			},
			getMemoTimeFormat: () => this.settingsService.getSettings().memoTimeFormat,
			updateCatalogPartition: async (input) => {
				if (this.catalogShadowCoordinator === null) throw new Error("Memo Catalog is not available.");
				await this.catalogShadowCoordinator.replaceCommittedFile(input);
			},
			refreshCatalogPaths: (paths) => this.catalogShadowCoordinator?.refreshPaths(paths) ?? Promise.resolve(),
			removeEmptyCreatedDailyFile: async (file) => {
				if ((await this.app.vault.cachedRead(file)).length === 0) await this.app.fileManager.trashFile(file);
			},
		}, new CatalogV2DailyWriteGateway(this.app, diaryMemoParser));

		this.catalogV2FeatureService = new CatalogV2FeatureService(
			this.app,
			this.memoCatalogService,
			null,
			null,
			null,
			null,
			null,
			{
				getHeadings: getEffectiveHeadings,
				getOrCreateDailyFile: (date) =>
					dailyNoteService.getOrCreateDailyNoteForDateWithConfig(date, getEffectiveDailyConfig()),
				removeEmptyCreatedDailyFile: async (file) => {
					if ((await this.app.vault.cachedRead(file)).length === 0) await this.app.fileManager.trashFile(file);
				},
				getDailyFileForDate: (logicalDate) => {
					const date = parseLogicalDate(logicalDate);
					return dailyNoteService.getOrCreateDailyNoteForDateWithConfig(date, getEffectiveDailyConfig());
				},
				getDailyPathForDate: async (logicalDate) => {
					const date = parseLogicalDate(logicalDate);
					return dailyNoteService.getDailyNotePathForDateWithConfig(date, getEffectiveDailyConfig());
				},
				refreshCatalogPaths: (paths) => this.catalogShadowCoordinator?.refreshPaths(paths) ?? Promise.resolve(),
				refreshLocalCatalog: () => this.catalogShadowCoordinator?.refreshLocalCatalog() ?? Promise.resolve(),
				getProjectionState: () => this.catalogV2MonthlyProjectionCoordinator?.getProjectionState() ?? "ready",
				getMemoTimeFormat: () => this.settingsService.getSettings().memoTimeFormat,
				rebuildLocalCatalog: () => this.catalogShadowCoordinator?.rebuildLocalCatalog() ?? Promise.resolve(),
				getLegacyImportStatus: () => this.legacyIdentityImporter?.getReport().status ?? "idle",
			},
			markdownMutationService,
			identityLedgerService,
		);
		this.catalogV2ReadService = this.catalogV2FeatureService.getReadService();

		const legacyIdentitySource = new CatalogV2ReadOnlyCompatibilitySource(
			this.app,
			this.manifest.id,
			() => {
				const settings = this.settingsService.getSettings();
				return settings.knomoDataRootConfigured ? settings.knomoDataRoot : null;
			},
		);
		this.legacyIdentityImporter = new CatalogV3LegacyIdentityImporter(
			this.app,
			legacyIdentitySource,
			identityLedgerService,
			{ getObservationBatches: loadObservationBatches },
		);

		identityLedgerService.start(this, async () => {
			await reconcileIdentityLedger();
			await this.catalogV2ReadService?.materializeResolutionSnapshot();
			await this.queueRefreshOpenViews();
		});
		knomoSharedConfigService.start(this, async () => {
			await this.catalogShadowCoordinator?.refreshLocalCatalog().catch(() => undefined);
			await this.catalogV2MonthlyProjectionCoordinator?.handleConfigurationChanged().catch(() => undefined);
			await this.legacyIdentityImporter?.run();
			await this.queueRefreshOpenViews();
		});
		this.legacyIdentityImporter.start(this, async () => {
			await this.catalogV2ReadService?.materializeResolutionSnapshot();
			await this.queueRefreshOpenViews();
		});
		this.catalogV2MonthlyProjectionCoordinator.start(this);
		this.catalogShadowCoordinator.start(this);

		await this.catalogV2MonthlyProjectionCoordinator.initialize().catch(() => undefined);
		await this.catalogShadowCoordinator.initialize();
		await this.legacyIdentityImporter.run();
		await reconcileIdentityLedger();
		await this.catalogV2ReadService.materializeResolutionSnapshot();
		await this.catalogV2ReadService.prime().catch(() => undefined);

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
				null,
				null,
				null,
				async () => {
					const catalogWasUsingFallback = memoCatalogStore.isUsingFallback;
					await this.memoCatalogService?.open();
					if (catalogWasUsingFallback && !memoCatalogStore.isUsingFallback) {
						await this.catalogShadowCoordinator?.refreshLocalCatalog();
					}
					await this.legacyIdentityImporter?.run();
					await reconcileIdentityLedger();
					await this.catalogV2ReadService?.materializeResolutionSnapshot();
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

		this.addSettingTab(new KnomoSettingTab(
			this.app,
			this,
			this.settingsService,
			obsidianExcludeService,
			this.catalogV2FeatureService,
			this.catalogV2ReadService,
			this.catalogV2MonthlyProjectionCoordinator,
			knomoDataRootMigrationService,
			knomoSharedConfigService,
			this.legacyIdentityImporter,
		));

		this.app.workspace.onLayoutReady(() => {
			void this.initializeAfterLayoutWithCatalogSafely();
		});
	}

	onunload(): void {
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
			await this.catalogShadowCoordinator?.initialize();
			await this.legacyIdentityImporter?.run();
			await this.catalogV2ReadService?.materializeResolutionSnapshot();
			await this.catalogV2ReadService?.prime();
		} catch {
			// 本机 Catalog 或兼容导入失败不能影响 Daily 快速记录能力。
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

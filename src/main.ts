import { initializeCatalogRuntime } from "./services/CatalogStartup";
import { getLanguage, normalizePath, Notice, Platform, Plugin, TFile } from "obsidian";
import type { WorkspaceLeaf } from "obsidian";

import { KNOMO_VIEW_TYPE } from "./constants";
import { AttachmentService } from "./services/AttachmentService";
import {
	CATALOG_SCANNER_ENABLED,
	CatalogIndexCoordinator,
	createCatalogDatabaseName,
} from "./services/CatalogIndexCoordinator";
import { DailyNoteService } from "./services/DailyNoteService";
import { DailyInventoryIndex } from "./services/DailyInventoryIndex";
import { DailyNotesProvider } from "./services/DailyNotesProvider";
import { DiaryMemoParser } from "./services/DiaryMemoParser";
import { DailyMemoWriteGateway } from "./services/DailyMemoWriteGateway";
import type { CatalogReadService } from "./services/CatalogReadService";
import {
	MONTHLY_PROJECTION_CHECKPOINT_META_KEY,
	MonthlyProjectionCoordinator,
} from "./services/MonthlyProjectionCoordinator";
import { MonthlyProjectionInputBuilder } from "./services/MonthlyProjectionInputBuilder";
import { IndexedDbMemoCatalogStore } from "./services/IndexedDbMemoCatalogStore";
import { KnomoCurrentConfigService } from "./services/KnomoCurrentConfigService";
import { KnomoStartupBootstrapService } from "./services/KnomoStartupBootstrapService";
import { LegacyTrashMigrationService } from "./services/LegacyTrashMigrationService";
import { RecoveryDataRootService } from "./services/RecoveryDataRootService";
import { IndependentTrashService } from "./services/IndependentTrashService";
import { TrashSnapshotStore } from "./services/TrashSnapshotStore";
import { getCatalogDataRootPath } from "./utils/path";
import { LegacyIndexReader } from "./services/LegacyIndexReader";
import { LegacyMigrationCompletionNoticeService } from "./services/LegacyMigrationCompletionNoticeService";
import { LowPriorityWorkQueue } from "./services/LowPriorityWorkQueue";
import { MemoCatalogService } from "./services/MemoCatalogService";
import { MemoCommandService } from "./services/MemoCommandService";
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
import type { CatalogCoverage, CatalogRefreshResult } from "./types/catalog";
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
	private catalogIndexCoordinator: CatalogIndexCoordinator | null = null;
	private memoCommandService: MemoCommandService | null = null;
	private catalogReadService: CatalogReadService | null = null;
	private monthlyProjectionCoordinator: MonthlyProjectionCoordinator | null = null;
	private legacyTrashMigrationService: LegacyTrashMigrationService | null = null;
	private legacyMigrationCompletionNoticeService: LegacyMigrationCompletionNoticeService | null = null;
	private memoCatalogService: MemoCatalogService | null = null;
	private runtimeInitializationPromise: Promise<boolean> | null = null;

	async onload(): Promise<void> {
		registerKnomoIcons();
		const selfWriteTracker = new SelfWriteTracker();
		const lowPriorityWorkQueue = new LowPriorityWorkQueue(() => this.app.workspace.containerEl.win);
		lowPriorityWorkQueue.start(this);
		const dailyInventory = new DailyInventoryIndex();
		const pluginDataStore = new PluginDataStore(this);
		this.settingsService = new SettingsService(this, pluginDataStore);
		this.vaultTagIndex = this.addChild(new VaultTagIndex(this.app));
		const settingsLoaded = await this.loadSettingsSafely();
		if (settingsLoaded) {
			await this.initializeTimeBuoyDefaultSafely();
		}

		const diaryMemoParser = new DiaryMemoParser();
		const dailyNotesProvider = new DailyNotesProvider(this.app);
		const dailyNoteService = new DailyNoteService(this.app, dailyNotesProvider);
		await this.refreshDailyStatusSafely(dailyNoteService);
		const attachmentService = new AttachmentService(this.app);

		const memoCatalogStore = new FallbackMemoCatalogStore(
			new IndexedDbMemoCatalogStore(createCatalogDatabaseName(this.app)),
			new InMemoryMemoCatalogStore(),
			async () => { await this.catalogIndexCoordinator?.refreshLocalCatalog(); },
		);
		this.memoCatalogService = new MemoCatalogService(memoCatalogStore);
		// 工作区恢复早于布局就绪回调，先打开视图查询依赖。
		await this.memoCatalogService.open();
		const knomoCurrentConfigService = new KnomoCurrentConfigService(this.settingsService, dailyNotesProvider, () => getLanguage());
		await knomoCurrentConfigService.initializeLocalConfig();

		const getEffectiveDailyConfig = () => {
			const config = dailyNotesProvider.getConfig();
			if (config === null) throw new Error("Obsidian Daily configuration is unknown.");
			return config;
		};
		const getEffectiveWriteHeading = () => knomoCurrentConfigService.getEffectiveConfig().daily.headings[0] ?? null;
		const getEffectiveMonthlySettings = () => {
			const monthly = knomoCurrentConfigService.getEffectiveConfig().monthly;
			return {
				monthlyMemoFolder: monthly.folder,
				monthlyMemoFileFormat: monthly.fileFormat,
				monthlyDateHeadingFormat: monthly.dateHeadingFormat,
				monthlyDateOrder: monthly.dateOrder,
				locale: monthly.locale,
			};
		};

		const recoveryDataRootService = new RecoveryDataRootService(this.app,
			() => this.settingsService.getSettings(),
			async (root) => { await this.settingsService.commitKnomoDataRoot(root); },
			async (action) => {
				await this.legacyTrashMigrationService?.waitForIdle();
				return this.memoCommandService === null ? action() : this.memoCommandService.runWithMutationsPaused(action);
			});
		const startupBootstrapService = new KnomoStartupBootstrapService(this.app, {
			getLocation: () => this.settingsService.getSettings(),
			initializeDataRoot: (root) => recoveryDataRootService.migrate(root),
			currentConfig: knomoCurrentConfigService,
			cancellationSignal: lowPriorityWorkQueue.signal,
		});
		const getStartupSnapshot = () => startupBootstrapService.getSnapshot();
		let settingTab: KnomoSettingTab | null = null;
		const projectionInputBuilder = new MonthlyProjectionInputBuilder(
			this.app,
			diaryMemoParser,
			{
				getDailyConfig: () => Promise.resolve(getEffectiveDailyConfig()),
				getSettings: getEffectiveMonthlySettings,
				dailyInventory,
			},
		);
		let monthlyProjectionFailureVisible = false;
		this.monthlyProjectionCoordinator = new MonthlyProjectionCoordinator(
			this.app,
			{
				inputBuilder: projectionInputBuilder,
				selfWriteTracker,
				checkpointStore: this.memoCatalogService.getStore(),
				listCatalogPeriods: () => {
					if (this.catalogReadService === null) throw new Error("Catalog read service is not available.");
					return this.catalogReadService.listMonthlyProjectionPeriods();
				},
				isProjectionAllowed: () => knomoCurrentConfigService.isMonthlyProjectionAllowed(),
				workQueue: lowPriorityWorkQueue,
				onStateChanged: () => {
					const failureVisible = this.monthlyProjectionCoordinator?.getProjectionState() === "failed";
					if (failureVisible === monthlyProjectionFailureVisible) return;
					monthlyProjectionFailureVisible = failureVisible;
					void this.queueRefreshOpenViews();
				},
			},
		);

		this.catalogIndexCoordinator = new CatalogIndexCoordinator(
			this.app,
			this.memoCatalogService,
			diaryMemoParser,
			() => Promise.resolve(getEffectiveDailyConfig()),
			{
				enabled: CATALOG_SCANNER_ENABLED,
				isConfigurationComplete: () => dailyNotesProvider.getConfig() !== null,
				onProgress: (coverage) => this.updateOpenViewCatalogProgress(coverage),
				onDailyPeriodsChanged: (periods) => this.monthlyProjectionCoordinator?.invalidateChangedPeriods(periods),
				preserveMetaKeysOnRebuild: [MONTHLY_PROJECTION_CHECKPOINT_META_KEY],
				onCatalogSettled: async () => {
					await this.monthlyProjectionCoordinator?.handleCatalogSettled();
					await this.queueRefreshOpenViews();
					settingTab?.refreshAttentionIfVisible();
				},
				dailyInventory,
				workQueue: lowPriorityWorkQueue,
			},
		);

		const markdownMutationService = new MarkdownMutationService(this.app, {
			getWriteHeading: getEffectiveWriteHeading,
			getDailyFileForDate: (logicalDate) => {
				const date = parseLogicalDate(logicalDate);
				return dailyNoteService.getOrCreateDailyNoteForDateWithConfig(date, getEffectiveDailyConfig());
			},
			getLogicalDateForPath: async (sourcePath) => {
				const date = parseDailyNoteDateFromPath(sourcePath, getEffectiveDailyConfig());
				if (date === null) throw new Error("Daily path does not match the active configuration: " + sourcePath);
				return formatDatePart(date);
			},
			getMemoTimeFormat: () => { if (this.settingsService.getLoadStatus() !== "ready") throw new Error("Knomo settings unavailable."); return this.settingsService.getSettings().memoTimeFormat; },
			getInsertPosition: () => this.settingsService.getSettings().dailyInsertPosition,
			updateCatalogPartition: async (input) => {
				if (this.catalogIndexCoordinator === null) throw new Error("Memo Catalog is not available.");
				await this.catalogIndexCoordinator.replaceCommittedFile(input);
			},
			refreshCatalogPaths: (paths) => this.catalogIndexCoordinator?.refreshPaths(paths) ?? Promise.resolve(),
			removeEmptyCreatedDailyFile: async (file) => {
				if ((await this.app.vault.cachedRead(file)).length === 0) await this.app.fileManager.trashFile(file);
			},
		}, new DailyMemoWriteGateway(this.app, diaryMemoParser));

		let trashRoot: string | null = null;
		let trashService: IndependentTrashService;
		const getTrashService = () => {
			if (this.settingsService.getLoadStatus() !== "ready") throw new Error("Knomo settings unavailable.");
			const root = getCatalogDataRootPath(this.settingsService.getSettings().knomoDataRoot);
			if (trashRoot !== root) {
				trashRoot = root;
				trashService = new IndependentTrashService(this.app, new TrashSnapshotStore(this.app, root + "/trash"), {
					assertActive: () => {
						if (lowPriorityWorkQueue.signal.aborted || root !== getCatalogDataRootPath(this.settingsService.getSettings().knomoDataRoot)
							|| this.settingsService.getLoadStatus() !== "ready") throw new Error("Trash operation cancelled or configuration changed.");
					},
					getLogicalDateForPath: async (path) => {
						const date = parseDailyNoteDateFromPath(path, getEffectiveDailyConfig());
						if (date === null) throw new Error("Daily path does not match current configuration.");
						return formatDatePart(date);
					},
					getOriginalDailyFile: async (path, logicalDate) => {
						const date = parseDailyNoteDateFromPath(path, getEffectiveDailyConfig());
						const file = this.app.vault.getAbstractFileByPath(path);
						return date !== null && formatDatePart(date) === logicalDate && file instanceof TFile ? file : null;
					},
					getDailyFileForDate: (date) => dailyNoteService.getOrCreateDailyNoteForDateWithConfig(parseLogicalDate(date), getEffectiveDailyConfig()),
					updateCatalogPartition: (input) => this.catalogIndexCoordinator!.replaceCommittedFile(input),
					refreshCatalogPaths: (paths) => this.catalogIndexCoordinator!.refreshPaths(paths),
				}, new DailyMemoWriteGateway(this.app, diaryMemoParser));
			}
			return trashService;
		};

		this.memoCommandService = new MemoCommandService(
			this.app,
			this.memoCatalogService,
			{
				getDailyPathForDate: async (logicalDate) => {
					const date = parseLogicalDate(logicalDate);
					return dailyNoteService.getDailyNotePathForDateWithConfig(date, getEffectiveDailyConfig());
				},
				refreshCatalogPaths: (paths) => this.catalogIndexCoordinator?.refreshPaths(paths) ?? Promise.resolve(),
				refreshLocalCatalog: () => {
					if (this.catalogIndexCoordinator === null) throw new Error("Memo Catalog is not available.");
					return this.catalogIndexCoordinator.refreshLocalCatalog();
				},
				getProjectionState: () => this.monthlyProjectionCoordinator?.getProjectionState() ?? "ready",
				getMemoTimeFormat: () => { if (this.settingsService.getLoadStatus() !== "ready") throw new Error("Knomo settings unavailable."); return this.settingsService.getSettings().memoTimeFormat; },
				rebuildLocalCatalog: () => this.catalogIndexCoordinator?.rebuildLocalCatalog() ?? Promise.resolve(),
				getLegacyImportStatus: () => this.legacyTrashMigrationService?.getReport().status ?? "idle",
				getCurrentConfigurationStatus: () => knomoCurrentConfigService.getStatus(),
				getSettingsStatus: () => this.settingsService.getLoadStatus(),
				getStartupBootstrapSnapshot: getStartupSnapshot,
				getTrashService,
			},
			markdownMutationService,
		);
		this.catalogReadService = this.memoCommandService.getReadService();

		const legacyIndexReader = new LegacyIndexReader(
			this.app,
			() => this.settingsService.getSettings().monthlyMemoFolder,
		);
		this.legacyMigrationCompletionNoticeService = new LegacyMigrationCompletionNoticeService(
			this.app,
			pluginDataStore,
			(legacySystemRoot) => {
				new Notice(t("notice.legacyMigrationCompleted", { path: legacySystemRoot }));
			},
		);
		this.legacyTrashMigrationService = new LegacyTrashMigrationService(this.app, legacyIndexReader, {
			pluginDataStore,
			runExclusive: (action) => this.memoCommandService!.runWithMutationsPaused(action),
			onReportChanged: async () => {
				if (lowPriorityWorkQueue.signal.aborted) return;
				await this.queueRefreshOpenViews();
				await this.showLegacyMigrationCompletionNotice();
				settingTab?.refreshAttentionIfVisible();
			},
			getDataRoot: () => getCatalogDataRootPath(this.settingsService.getSettings().knomoDataRoot),
			migrateSettings: async () => {
				await knomoCurrentConfigService.initialize();
				await this.settingsService.persistLegacyConfiguration();
			},
			signal: lowPriorityWorkQueue.signal,
			yieldControl: () => new Promise((resolve) => this.app.workspace.containerEl.win.setTimeout(resolve, 0)),
		});

		this.app.workspace.onLayoutReady(() => {
			if (lowPriorityWorkQueue.signal.aborted) return;
			knomoCurrentConfigService.start(this, async () => {
				await this.monthlyProjectionCoordinator?.handleConfigurationChanged().catch(() => undefined);
				await this.catalogIndexCoordinator?.refreshLocalCatalog().catch(() => undefined);
				await this.queueRefreshOpenViews();
			});
			this.registerDomEvent(this.app.workspace.containerEl.win, "focus", () => {
				if (!lowPriorityWorkQueue.signal.aborted) void dailyNotesProvider.loadConfig().catch(() => settingTab?.refreshAttentionIfVisible());
			});
		});
		this.monthlyProjectionCoordinator.start(this);
		this.catalogIndexCoordinator.start(this);

		this.viewRefreshScheduler = new ViewRefreshScheduler(
			() => this.app.workspace.containerEl.win,
			() => this.runRefreshOpenViews(),
			OPEN_VIEWS_REFRESH_DEBOUNCE_MS,
		);
		const shuffleDayService = new ShuffleDayService(pluginDataStore);
		const obsidianExcludeService = new ObsidianExcludeService(this.app);
		const retryRuntimeState = async (): Promise<void> => {
			let settingsRecovered = false;
			if (this.settingsService.getLoadStatus() === "unavailable") {
				await this.settingsService.loadSettings();
				await this.settingsService.initializeTimeBuoyDefault().catch(() => undefined);
				await this.settingsService.initializeMonthlyExcludeDefault();
				await startupBootstrapService.initialize();
				settingsRecovered = true;
			} else if (startupBootstrapService.getSnapshot().status === "unavailable") {
				await startupBootstrapService.initialize();
			} else if (knomoCurrentConfigService.getStatus() === "unavailable") {
				await knomoCurrentConfigService.reloadConfiguredRoot();
			}
			const catalogWasUsingFallback = memoCatalogStore.isUsingFallback;
			await this.memoCatalogService?.open();
			if (catalogWasUsingFallback && !memoCatalogStore.isUsingFallback) {
				await this.catalogIndexCoordinator?.refreshLocalCatalog();
			}
			if (settingsRecovered) await this.catalogIndexCoordinator?.refreshLocalCatalog();
			await this.legacyTrashMigrationService?.run();
		};
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
				this.memoCommandService!,
				this.catalogReadService!,
				() => dailyNoteService.getStatus(),
				() => dailyNoteService.getTodayDailyNotePath(),
				() => retryRuntimeState(),
				() => this.openCatalogDataSettings(),
				async () => {
					await this.memoCommandService!.runWithMutationsPaused(() => this.catalogIndexCoordinator!.rebuildLocalCatalog());
					await retryRuntimeState();
				},
			),
		);
		this.registerAttachmentEvents();
		this.registerReferenceEvents();

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

		settingTab = new KnomoSettingTab(
			this.app,
			this,
			this.settingsService,
			obsidianExcludeService,
			this.memoCommandService,
			this.catalogReadService,
			this.monthlyProjectionCoordinator,
			recoveryDataRootService,
			knomoCurrentConfigService,
			this.legacyTrashMigrationService,
			startupBootstrapService,
			retryRuntimeState,
		);
		this.addSettingTab(settingTab);

		this.runtimeInitializationPromise = initializeCatalogRuntime({
			initializeCatalog: () => this.catalogIndexCoordinator!.initialize(),
			primeCatalog: async () => { await this.catalogReadService?.prime(); },
			initializeConfiguration: async () => {
				await knomoCurrentConfigService.initialize();
				if (!lowPriorityWorkQueue.signal.aborted) await this.initializeMonthlyExcludeDefaultSafely();
			},
			initializeMonthly: async () => { await this.monthlyProjectionCoordinator?.initialize(); },
			initializeRecovery: async () => {
				if (settingsLoaded) await startupBootstrapService.initialize();
				if (!lowPriorityWorkQueue.signal.aborted) await this.legacyTrashMigrationService?.run();
			},
			isCancelled: () => lowPriorityWorkQueue.signal.aborted,
			onAuxiliaryError: () => settingTab?.refreshAttentionIfVisible(),
		}).catch(() => {
			// 后台初始化失败不阻塞视图注册与 Daily 快速记录。
			return false;
		});

		this.app.workspace.onLayoutReady(() => {
			if (lowPriorityWorkQueue.signal.aborted) return;
			this.legacyMigrationCompletionNoticeService?.markLayoutReady();
			void this.initializeAfterLayoutWithCatalogSafely(lowPriorityWorkQueue.signal);
		});
	}

	onunload(): void {
		this.viewRefreshScheduler?.clear();
		MobileNavbarCompactController.cleanupDocument(this.app.workspace.containerEl.doc);
	}

	async onExternalSettingsChange(): Promise<void> {
		await this.settingsService.loadSettings().catch(() => undefined);
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

	private updateOpenViewCatalogProgress(coverage: CatalogCoverage): void {
		for (const leaf of this.app.workspace.getLeavesOfType(KNOMO_VIEW_TYPE)) {
			if (leaf.view instanceof KnomoView) leaf.view.updateCatalogProgress(coverage);
		}
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

	private registerReferenceEvents(): void {
		// 只重查已打开视图的 Catalog 页面；目标变化不触发全库 Daily 重读。
		const scheduler = new ViewRefreshScheduler(
			() => this.app.workspace.containerEl.win,
			() => this.runRefreshOpenViews(true),
			OPEN_VIEWS_REFRESH_DEBOUNCE_MS,
		);
		this.register(() => scheduler.clear());
		const refresh = (): void => {
			void scheduler.queue().catch((error: unknown) => console.error("Knomo reference refresh failed", error));
		};
		this.registerEvent(this.app.metadataCache.on("changed", refresh));
		this.registerEvent(this.app.vault.on("rename", refresh));
		this.registerEvent(this.app.vault.on("delete", refresh));
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

	private async initializeMonthlyExcludeDefaultSafely(): Promise<void> {
		try {
			await this.settingsService.initializeMonthlyExcludeDefault();
		} catch {
			// 默认排除初始化失败时保持当前状态，用户仍可在设置页重试。
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

	private async initializeAfterLayoutWithCatalogSafely(cancellationSignal?: AbortSignal): Promise<void> {
		const isCancelled = () => cancellationSignal?.aborted === true;
		try {
			if (this.runtimeInitializationPromise !== null
				&& await this.runtimeInitializationPromise) {
				if (isCancelled()) return;
				await this.showLegacyMigrationCompletionNotice();
				return;
			}
			if (isCancelled()) return;
			await this.catalogIndexCoordinator?.initialize();
			if (isCancelled()) return;
			await this.catalogReadService?.prime();
			if (isCancelled()) return;
			await this.showLegacyMigrationCompletionNotice();
		} catch {
			// 本机 Catalog 或兼容导入失败不能影响 Daily 快速记录能力。
		}
	}

	private async showLegacyMigrationCompletionNotice(): Promise<void> {
		await this.legacyMigrationCompletionNoticeService?.showIfNeeded(
			this.legacyTrashMigrationService?.getReport().cleanupCandidate ?? null,
		);
	}

	private runManualRefresh(): Promise<CatalogRefreshResult> {
		if (this.manualRefreshPromise !== null) {
			return this.manualRefreshPromise;
		}
		const refresh = this.memoCommandService?.refreshLocalCatalog() ?? Promise.resolve({
			scannedFiles: 0,
			created: 0,
			updated: 0,
			deleted: 0,
			skipped: 0,
			failed: 0,
			errors: [],
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

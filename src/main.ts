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
import { MonthlyProjectionCoordinator } from "./services/MonthlyProjectionCoordinator";
import { MonthlyProjectionInputBuilder } from "./services/MonthlyProjectionInputBuilder";
import { IndexedDbMemoCatalogStore } from "./services/IndexedDbMemoCatalogStore";
import { createIdentityLedgerWriterId, getIdentityLedgerRootPath } from "./services/IdentityLedgerProtocol";
import { IdentityLedgerService } from "./services/IdentityLedgerService";
import { KnomoDataRootMigrationService } from "./services/KnomoDataRootMigrationService";
import {
	buildKnomoSharedConfig,
	getKnomoSharedConfigRootPath,
} from "./services/KnomoSharedConfigProtocol";
import { KnomoSharedConfigService } from "./services/KnomoSharedConfigService";
import { KnomoStartupBootstrapService } from "./services/KnomoStartupBootstrapService";
import { LegacyIndexMigrationService } from "./services/LegacyIndexMigrationService";
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
import type { CatalogCoverage, CatalogFileRevisionBatch, CatalogRefreshResult } from "./types/catalog";
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
	private legacyIndexMigrationService: LegacyIndexMigrationService | null = null;
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
			await this.initializeMonthlyExcludeDefaultSafely();
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

		const knomoSharedConfigService = new KnomoSharedConfigService(this.app, {
			getRootPath: () => {
				const settings = this.settingsService.getSettings();
				return settings.knomoDataRootConfigured
					? getKnomoSharedConfigRootPath(settings.knomoDataRoot)
					: null;
			},
			getWriterId: async () => sessionWriterId,
			getCurrentLocale: () => getLanguage(),
			getLocalConfig: async (monthlyLocale) => buildKnomoSharedConfig(
				await dailyNoteService.getDailyNotesConfig(),
				this.settingsService.getSettings(),
				monthlyLocale,
			),
		});
		await knomoSharedConfigService.initializeLocalConfig();

		const getEffectiveDailyConfig = () => {
			const config = knomoSharedConfigService.getEffectiveConfig();
			return { folder: config.daily.folder, format: config.daily.dateFormat };
		};
		const getEffectiveWriteHeading = () => knomoSharedConfigService.getEffectiveConfig().daily.headings[0] ?? null;
		const getEffectiveMonthlySettings = () => {
			const monthly = knomoSharedConfigService.getEffectiveConfig().monthly;
			return {
				monthlyMemoFolder: monthly.folder,
				monthlyMemoFileFormat: monthly.fileFormat,
				monthlyDateHeadingFormat: monthly.dateHeadingFormat,
				monthlyDateOrder: monthly.dateOrder,
				locale: monthly.locale,
			};
		};

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
		const startupBootstrapService = settingsLoaded
			? new KnomoStartupBootstrapService(this.app, {
				getLocation: () => this.settingsService.getSettings(),
				initializeDataRoot: async (dataRoot) => {
					await knomoDataRootMigrationService.migrate(dataRoot);
				},
				identity: identityLedgerService,
				sharedConfig: knomoSharedConfigService,
			})
			: null;

		const loadObservationBatches = async (): Promise<CatalogFileRevisionBatch[]> => {
			return this.memoCatalogService!.listFileRevisionBatches();
		};
		const reconcileIdentityLedger = async () => {
			const batches = await loadObservationBatches();
			await identityLedgerService.reconcilePendingCreates(
				batches.flatMap((batch) => batch.observations),
			);
			const coverage = await this.memoCatalogService!.getStore().getCoverage();
			if (coverage.kind === "complete") {
				await identityLedgerService.reconcilePendingDeletes(Object.fromEntries(batches.map((batch) => [
					normalizePath(batch.file.sourcePath),
					batch.file.sourceRevision,
				])));
			}
		};

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
				isProjectionAllowed: () => knomoSharedConfigService.isMonthlyProjectionAllowed(),
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
				isConfigurationComplete: () => knomoSharedConfigService.isCoverageComplete(),
				onProgress: (coverage) => this.updateOpenViewCatalogProgress(coverage),
				onRevisionTransition: async (transition) => {
					await identityLedgerService.reconcileRevision(
						transition.before?.observations ?? [],
						transition.after.observations,
					);
				},
				onDailyPeriodsChanged: (periods) => this.monthlyProjectionCoordinator?.invalidateChangedPeriods(periods),
				onCatalogSettled: async () => {
					await this.legacyIndexMigrationService?.run();
					await reconcileIdentityLedger();
					await this.queueRefreshOpenViews();
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
			getMemoTimeFormat: () => this.settingsService.getSettings().memoTimeFormat,
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
				getMemoTimeFormat: () => this.settingsService.getSettings().memoTimeFormat,
				rebuildLocalCatalog: () => this.catalogIndexCoordinator?.rebuildLocalCatalog() ?? Promise.resolve(),
				getLegacyImportStatus: () => this.legacyIndexMigrationService?.getReport().status ?? "idle",
				getSharedConfigurationStatus: () => knomoSharedConfigService.getStatus(),
			},
			markdownMutationService,
			identityLedgerService,
		);
		this.catalogReadService = this.memoCommandService.getReadService();

		const legacyIndexReader = new LegacyIndexReader(
			this.app,
			this.manifest.id,
			() => this.settingsService.getSettings().monthlyMemoFolder,
		);
		this.legacyMigrationCompletionNoticeService = new LegacyMigrationCompletionNoticeService(
			this.app,
			pluginDataStore,
			(legacySystemRoot) => {
				new Notice(t("notice.legacyMigrationCompleted", { path: legacySystemRoot }));
			},
		);
		this.legacyIndexMigrationService = new LegacyIndexMigrationService(
			this.app,
			legacyIndexReader,
			identityLedgerService,
			{
				getCatalogCoverage: () => this.memoCatalogService!.getStore().getCoverage(),
				getObservationBatches: loadObservationBatches,
				onReportChanged: () => this.showLegacyMigrationCompletionNotice(),
				workQueue: lowPriorityWorkQueue,
			},
		);

		identityLedgerService.start(this, async () => {
			await reconcileIdentityLedger();
			await this.queueRefreshOpenViews();
		});
		knomoSharedConfigService.start(this, async () => {
			await this.catalogIndexCoordinator?.refreshLocalCatalog().catch(() => undefined);
			await this.monthlyProjectionCoordinator?.handleConfigurationChanged().catch(() => undefined);
			await this.legacyIndexMigrationService?.run({ verifyCompletion: true });
			await this.queueRefreshOpenViews();
		});
		this.legacyIndexMigrationService.start(this, async () => {
			await this.queueRefreshOpenViews();
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
				async () => {
					const catalogWasUsingFallback = memoCatalogStore.isUsingFallback;
					await this.memoCatalogService?.open();
					if (catalogWasUsingFallback && !memoCatalogStore.isUsingFallback) {
						await this.catalogIndexCoordinator?.refreshLocalCatalog();
					}
					await this.legacyIndexMigrationService?.run({ sourceChanged: true, verifyCompletion: true });
					await reconcileIdentityLedger();
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
			this.memoCommandService,
			this.catalogReadService,
			this.monthlyProjectionCoordinator,
			knomoDataRootMigrationService,
			knomoSharedConfigService,
			this.legacyIndexMigrationService,
			startupBootstrapService,
		));

		this.runtimeInitializationPromise = (async () => {
			if (startupBootstrapService !== null) {
				try {
					await startupBootstrapService.initialize();
				} catch {
					// 自动初始化失败不阻塞 Daily；下次启用会继续补齐缺失配置。
				}
			}
			if (startupBootstrapService === null) {
				await identityLedgerService.initialize();
				await knomoSharedConfigService.initialize();
			}
			if (settingsLoaded
				&& this.settingsService.getSettings().knomoDataRootConfigured
				&& identityLedgerService.getStatus() === "missing") {
				new Notice(t("settings.dataRoot.missing", {
					path: this.settingsService.getSettings().knomoDataRoot,
				}));
			}
			await this.catalogIndexCoordinator?.initialize();
			await this.monthlyProjectionCoordinator?.initialize().catch(() => undefined);
			await this.legacyIndexMigrationService?.run();
			await reconcileIdentityLedger();
			await this.catalogReadService?.prime().catch(() => undefined);
			return true;
		})().catch(() => {
			// 后台初始化失败不阻塞视图注册与 Daily 快速记录。
			return false;
		});

		this.app.workspace.onLayoutReady(() => {
			this.legacyMigrationCompletionNoticeService?.markLayoutReady();
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

	private async initializeAfterLayoutWithCatalogSafely(): Promise<void> {
		try {
			if (this.runtimeInitializationPromise !== null
				&& await this.runtimeInitializationPromise) {
				await this.showLegacyMigrationCompletionNotice();
				return;
			}
			await this.catalogIndexCoordinator?.initialize();
			await this.legacyIndexMigrationService?.run();
			await this.catalogReadService?.prime();
			await this.showLegacyMigrationCompletionNotice();
		} catch {
			// 本机 Catalog 或兼容导入失败不能影响 Daily 快速记录能力。
		}
	}

	private async showLegacyMigrationCompletionNotice(): Promise<void> {
		await this.legacyMigrationCompletionNoticeService?.showIfNeeded(
			this.legacyIndexMigrationService?.getReport().cleanupCandidate ?? null,
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

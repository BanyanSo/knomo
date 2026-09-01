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
import { getIdentityLedgerRootPath } from "./services/IdentityLedgerProtocol";
import { IdentityLedgerService } from "./services/IdentityLedgerService";
import { IdentityRecoveryCoordinator } from "./services/IdentityRecoveryCoordinator";
import {
	IDENTITY_REVISION_TRANSITION_QUEUE_META_KEY,
	IdentityRevisionTransitionQueue,
} from "./services/IdentityRevisionTransitionQueue";
import { LocalWriterIdentityService } from "./services/LocalWriterIdentityService";
import {
	HISTORICAL_IDENTITY_BOOTSTRAP_META_KEY,
	HistoricalIdentityBootstrapService,
} from "./services/HistoricalIdentityBootstrapService";
import { KnomoDataRootMigrationService } from "./services/KnomoDataRootMigrationService";
import {
	buildKnomoSharedConfig,
	getKnomoSharedConfigRootPath,
} from "./services/KnomoSharedConfigProtocol";
import { KnomoSharedConfigService } from "./services/KnomoSharedConfigService";
import { KnomoStartupBootstrapService } from "./services/KnomoStartupBootstrapService";
import {
	LEGACY_MIGRATION_COMPLETION_META_KEY,
	LegacyIndexMigrationService,
} from "./services/LegacyIndexMigrationService";
import { LegacyIndexReader } from "./services/LegacyIndexReader";
import { LegacyMigrationCompletionNoticeService } from "./services/LegacyMigrationCompletionNoticeService";
import { LegacyMigrationAcknowledgementService } from "./services/LegacyMigrationAcknowledgementService";
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
	private identityRecoveryCoordinator: IdentityRecoveryCoordinator | null = null;
	private runtimeInitializationPromise: Promise<boolean> | null = null;

	async onload(): Promise<void> {
		registerKnomoIcons();
		const selfWriteTracker = new SelfWriteTracker();
		const lowPriorityWorkQueue = new LowPriorityWorkQueue(() => this.app.workspace.containerEl.win);
		lowPriorityWorkQueue.start(this);
		const dailyInventory = new DailyInventoryIndex();
		const pluginDataStore = new PluginDataStore(this);
		const legacyMigrationAcknowledgementService = new LegacyMigrationAcknowledgementService(pluginDataStore);
		await legacyMigrationAcknowledgementService.initialize().catch(() => undefined);
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

		const localWriterIdentityService = new LocalWriterIdentityService(this.app);
		const identityLedgerService = new IdentityLedgerService(this.app, {
			getRootPath: () => {
				const settings = this.settingsService.getSettings();
				return settings.knomoDataRootConfigured
					? getIdentityLedgerRootPath(settings.knomoDataRoot)
					: null;
			},
			getWriterId: () => localWriterIdentityService.getWriterId(),
			cancellationSignal: lowPriorityWorkQueue.signal,
		});

		const knomoSharedConfigService = new KnomoSharedConfigService(this.app, {
			getRootPath: () => {
				const settings = this.settingsService.getSettings();
				return settings.knomoDataRootConfigured
					? getKnomoSharedConfigRootPath(settings.knomoDataRoot)
					: null;
			},
			getWriterId: () => localWriterIdentityService.getWriterId(),
			getCurrentLocale: () => getLanguage(),
			getLocalConfig: async (monthlyLocale) => buildKnomoSharedConfig(
				await dailyNoteService.getDailyNotesConfig(),
				this.settingsService.getSettings(),
				monthlyLocale,
			),
			cancellationSignal: lowPriorityWorkQueue.signal,
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
		const startupBootstrapService = new KnomoStartupBootstrapService(this.app, {
				getLocation: () => this.settingsService.getSettings(),
				initializeDataRoot: async (dataRoot) => {
					await knomoDataRootMigrationService.migrate(dataRoot);
				},
				identity: identityLedgerService,
				sharedConfig: knomoSharedConfigService,
				cancellationSignal: lowPriorityWorkQueue.signal,
			});

		const loadObservationBatches = async (): Promise<CatalogFileRevisionBatch[]> => {
			return this.memoCatalogService!.listFileRevisionBatches();
		};
		const identityRevisionTransitionQueue = new IdentityRevisionTransitionQueue({
			store: this.memoCatalogService.getStore(),
			getCurrentSourceRevision: async (sourcePath) =>
				(await this.memoCatalogService!.getFileRevisionBatch(sourcePath))?.file.sourceRevision ?? null,
		});
		const reconcileIdentityLedger = async () => {
			const hasPendingCreates = identityLedgerService.hasPendingCreates();
			const hasPendingDeletes = identityLedgerService.hasPendingDeletes();
			const hasConflicts = Object.values(identityLedgerService.getSnapshot().memos)
				.some((memo) => memo.conflicted);
			const batches = hasPendingCreates || hasPendingDeletes || hasConflicts
				? await loadObservationBatches()
				: null;
			const observations = batches?.flatMap((batch) => batch.observations) ?? [];
			if (hasConflicts) {
				await identityLedgerService.repairKnownDuplicateCreateConflicts(observations);
			}
			if (hasPendingCreates) {
				await identityLedgerService.reconcilePendingCreates(observations);
			}
			await identityRevisionTransitionQueue.drain((transition) => identityLedgerService.reconcileRevision(
				transition.before?.observations ?? [],
				transition.after.observations,
				transition.insertedObservation,
				transition.allowIdentityAdoption,
			));
			const coverage = hasPendingDeletes
				? await this.memoCatalogService!.getStore().getCoverage()
				: null;
			if (coverage?.kind === "complete" && batches !== null) {
				await identityLedgerService.reconcilePendingDeletes(Object.fromEntries(batches.map((batch) => [
					normalizePath(batch.file.sourcePath),
					batch.file.sourceRevision,
				])));
			}
		};
		let settingTab: KnomoSettingTab | null = null;
		this.identityRecoveryCoordinator = new IdentityRecoveryCoordinator({
			getStatus: () => identityLedgerService.getStatus(),
			getAttentionRoute: () => identityLedgerService.getAttentionRoute(),
			reload: () => identityLedgerService.reloadConfiguredRoot(false),
			reconcile: reconcileIdentityLedger,
			cancellationSignal: lowPriorityWorkQueue.signal,
		});
		this.register(() => this.identityRecoveryCoordinator?.stop());
		let historicalIdentityBootstrapService: HistoricalIdentityBootstrapService | null = null;

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
					await identityRevisionTransitionQueue.enqueue(transition);
					await this.identityRecoveryCoordinator?.request();
				},
				onDailyPeriodsChanged: (periods) => this.monthlyProjectionCoordinator?.invalidateChangedPeriods(periods),
				preserveMetaKeysOnRebuild: [
					LEGACY_MIGRATION_COMPLETION_META_KEY,
					HISTORICAL_IDENTITY_BOOTSTRAP_META_KEY,
					MONTHLY_PROJECTION_CHECKPOINT_META_KEY,
					IDENTITY_REVISION_TRANSITION_QUEUE_META_KEY,
				],
				onCatalogSettled: async () => {
					const legacyReport = await this.legacyIndexMigrationService?.run();
					if (legacyReport !== undefined) {
						await historicalIdentityBootstrapService?.run(legacyReport.status);
					}
					await this.identityRecoveryCoordinator?.request();
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
				getHistoricalIdentityBootstrapStatus: () => historicalIdentityBootstrapService?.getStatus() ?? "idle",
				getSharedConfigurationStatus: () => knomoSharedConfigService.getStatus(),
				getSettingsStatus: () => this.settingsService.getLoadStatus(),
				getStartupBootstrapSnapshot: () => startupBootstrapService.getSnapshot(),
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
				isTargetReady: () => startupBootstrapService !== null
					? startupBootstrapService.getSnapshot().status === "ready"
					: (identityLedgerService.getStatus() === "ready" || identityLedgerService.getStatus() === "absent")
						&& knomoSharedConfigService.getStatus() === "ready",
				getCatalogCoverage: () => this.memoCatalogService!.getStore().getCoverage(),
				getObservationBatches: loadObservationBatches,
				completionStore: this.memoCatalogService.getStore(),
				onReportChanged: () => this.showLegacyMigrationCompletionNotice(),
				workQueue: lowPriorityWorkQueue,
			},
		);
		historicalIdentityBootstrapService = new HistoricalIdentityBootstrapService(
			identityLedgerService,
			{
				getCatalogCoverage: () => this.memoCatalogService!.getStore().getCoverage(),
				getCatalogLifecycle: () => this.memoCatalogService!.getStore().getLifecycle(),
				getObservationBatches: loadObservationBatches,
				checkpointStore: this.memoCatalogService.getStore(),
				workQueue: lowPriorityWorkQueue,
				onStateChanged: () => this.queueRefreshOpenViews(),
			},
		);

		this.app.workspace.onLayoutReady(() => {
			if (lowPriorityWorkQueue.signal.aborted) return;
			identityLedgerService.start(this, async () => {
				await this.identityRecoveryCoordinator?.request();
				await this.queueRefreshOpenViews();
				settingTab?.refreshAttentionIfVisible();
			});
			knomoSharedConfigService.start(this, async () => {
				await this.catalogIndexCoordinator?.refreshLocalCatalog().catch(() => undefined);
				await this.monthlyProjectionCoordinator?.handleConfigurationChanged().catch(() => undefined);
				const legacyReport = await this.legacyIndexMigrationService?.run();
				if (legacyReport !== undefined) {
					await historicalIdentityBootstrapService?.run(legacyReport.status);
				}
				await this.queueRefreshOpenViews();
			});
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
		const retryRuntimeState = async (forceIdentityReload = false): Promise<void> => {
			let settingsRecovered = false;
			if (this.settingsService.getLoadStatus() === "unavailable") {
				await this.settingsService.loadSettings();
				await this.settingsService.initializeTimeBuoyDefault().catch(() => undefined);
				await this.settingsService.initializeMonthlyExcludeDefault();
				await startupBootstrapService.initialize();
				settingsRecovered = true;
			} else if (startupBootstrapService.getSnapshot().status === "unavailable") {
				await startupBootstrapService.retryInitialization();
			} else if (knomoSharedConfigService.getStatus() === "unavailable") {
				await knomoSharedConfigService.reloadConfiguredRoot();
			}
			const catalogWasUsingFallback = memoCatalogStore.isUsingFallback;
			await this.memoCatalogService?.open();
			if (catalogWasUsingFallback && !memoCatalogStore.isUsingFallback) {
				await this.catalogIndexCoordinator?.refreshLocalCatalog();
			}
			if (settingsRecovered) await this.catalogIndexCoordinator?.refreshLocalCatalog();
			await historicalIdentityBootstrapService?.initializeEligibility();
			const legacyReport = await this.legacyIndexMigrationService?.run({ sourceChanged: true, verifyCompletion: true });
			if (legacyReport !== undefined) {
				await historicalIdentityBootstrapService?.run(legacyReport.status);
			}
			await this.identityRecoveryCoordinator?.request({
				reload: forceIdentityReload ? "force" : "if_needed",
			});
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
				() => retryRuntimeState(false),
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

		settingTab = new KnomoSettingTab(
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
			legacyMigrationAcknowledgementService,
			startupBootstrapService,
			retryRuntimeState,
		);
		this.addSettingTab(settingTab);

		this.runtimeInitializationPromise = (async () => {
			if (settingsLoaded) {
				try {
					await startupBootstrapService.initialize();
				} catch {
					// 自动初始化失败不阻塞 Daily；下次启用会继续补齐缺失配置。
				} finally {
					if (!lowPriorityWorkQueue.signal.aborted) settingTab?.refreshAttentionIfVisible();
				}
			}
			if (lowPriorityWorkQueue.signal.aborted) return false;
			if (!settingsLoaded) {
				await identityLedgerService.initialize();
				await knomoSharedConfigService.initialize();
			}
			if (lowPriorityWorkQueue.signal.aborted) return false;
			if (settingsLoaded
				&& this.settingsService.getSettings().knomoDataRootConfigured
				&& identityLedgerService.getStatus() === "missing") {
				new Notice(t("settings.dataRoot.missing", {
					path: this.settingsService.getSettings().knomoDataRoot,
				}));
			}
			await historicalIdentityBootstrapService?.initializeEligibility();
			await this.catalogIndexCoordinator?.initialize();
			if (lowPriorityWorkQueue.signal.aborted) return false;
			await this.monthlyProjectionCoordinator?.initialize().catch(() => undefined);
			if (lowPriorityWorkQueue.signal.aborted) return false;
			await this.catalogReadService?.prime().catch(() => undefined);
			return true;
		})().catch(() => {
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
				await this.identityRecoveryCoordinator?.request({ reload: "if_needed" });
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

import { Platform, Plugin } from "obsidian";
import type { WorkspaceLeaf } from "obsidian";

import { KNOMO_VIEW_TYPE } from "./constants";
import { DailyNoteService } from "./services/DailyNoteService";
import { DailyNotesProvider } from "./services/DailyNotesProvider";
import { FileWatchService } from "./services/FileWatchService";
import { MarkdownBlockService } from "./services/MarkdownBlockService";
import { MemoIndexStore } from "./services/MemoIndexStore";
import { MonthlyArchiveService } from "./services/MonthlyArchiveService";
import { ObsidianExcludeService } from "./services/ObsidianExcludeService";
import { RandomReunionService } from "./services/RandomReunionService";
import { ReferenceService } from "./services/ReferenceService";
import { SelfWriteTracker } from "./services/SelfWriteTracker";
import { SettingsService } from "./services/SettingsService";
import { SyncOrchestrator } from "./services/SyncOrchestrator";
import type { ScanDailyMemosResult } from "./services/MemoScanService";
import { KnomoSettingTab } from "./ui/KnomoSettingTab";
import { KnomoView } from "./ui/KnomoView";

export default class KnomoPlugin extends Plugin {
	settingsService!: SettingsService;
	syncOrchestrator!: SyncOrchestrator;
	manualRefreshPromise: Promise<ScanDailyMemosResult> | null = null;

	async onload(): Promise<void> {
		this.settingsService = new SettingsService(this);
		await this.loadSettingsSafely();
		const markdownBlockService = new MarkdownBlockService();
		const selfWriteTracker = new SelfWriteTracker();
		const dailyNotesProvider = new DailyNotesProvider(this.app);
		const dailyNoteService = new DailyNoteService(this.app, markdownBlockService, dailyNotesProvider);
		await this.refreshDailyStatusSafely(dailyNoteService);
		const monthlyArchiveService = new MonthlyArchiveService(this.app, markdownBlockService);
		const memoIndexStore = new MemoIndexStore(this.app);
		this.syncOrchestrator = new SyncOrchestrator(
			this.app,
			() => this.settingsService.getSettings(),
			dailyNoteService,
			monthlyArchiveService,
			memoIndexStore,
			selfWriteTracker,
			markdownBlockService,
		);
		const referenceService = new ReferenceService(
			this.app,
			markdownBlockService,
			(memo) => this.syncOrchestrator.ensureReferenceBlockId(memo),
		);
		const randomReunionService = new RandomReunionService(this);
		const obsidianExcludeService = new ObsidianExcludeService(this.app);
		const fileWatchService = new FileWatchService(this.app, selfWriteTracker, this.syncOrchestrator, () => this.refreshOpenViews());
		fileWatchService.start(this);

		this.registerView(
			KNOMO_VIEW_TYPE,
			(leaf: WorkspaceLeaf) => new KnomoView(
				leaf,
				this.settingsService,
				this.syncOrchestrator,
				referenceService,
				randomReunionService,
				() => this.refreshOpenViews(),
				() => this.runManualRefresh(),
			),
		);

		this.registerHoverLinkSource(KNOMO_VIEW_TYPE, {
			display: "Knomo",
			defaultMod: false,
		});

		this.addRibbonIcon("sticky-note", "Open Knomo", () => {
			void this.activateView();
		});

		this.addCommand({
			id: "open-view",
			name: "Open Knomo",
			callback: () => {
				void this.activateView();
			},
		});

		this.addSettingTab(new KnomoSettingTab(this.app, this, this.settingsService, this.syncOrchestrator, obsidianExcludeService));

		this.app.workspace.onLayoutReady(() => {
			void this.initializeAfterLayoutSafely();
		});
	}

	async activateView(): Promise<void> {
		const existingLeaves = this.app.workspace.getLeavesOfType(KNOMO_VIEW_TYPE);
		if (!Platform.isMobile && existingLeaves.length > 0) {
			await this.app.workspace.revealLeaf(existingLeaves[0]);
			return;
		}
		if (Platform.isMobile) {
			for (const leaf of existingLeaves) {
				leaf.detach();
			}
		}

		const leaf = this.app.workspace.getLeaf("tab");
		await leaf.setViewState({
			type: KNOMO_VIEW_TYPE,
			active: true,
		});
		await this.app.workspace.revealLeaf(leaf);
	}

	private async refreshOpenViews(): Promise<void> {
		const refreshes = this.app.workspace.getLeavesOfType(KNOMO_VIEW_TYPE).map(async (leaf) => {
			if (leaf.view instanceof KnomoView) {
				await leaf.view.refresh();
			}
		});
		await Promise.all(refreshes);
	}

	private async loadSettingsSafely(): Promise<void> {
		try {
			await this.settingsService.loadSettings();
		} catch {
			// 启动提示会干扰快速记录；读取失败时继续使用默认设置。
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
		await this.initializeSystemFoldersSafely();
		await this.scanRecentDailyMemosSafely();
	}

	private async initializeSystemFoldersSafely(): Promise<void> {
		try {
			await this.settingsService.initializeSystemFolders();
		} catch {
			// 系统目录也会在具体读写路径按需创建；启动阶段不弹提示。
		}
	}

	private async scanRecentDailyMemosSafely(): Promise<void> {
		try {
			const result = await this.syncOrchestrator.scanRecentDailyMemos(30);
			if (result.created > 0 || result.updated > 0 || result.deleted > 0) {
				await this.refreshOpenViews();
			}
		} catch {
			// 启动扫描只做轻量修复，不打断用户。
		}
	}

	private runManualRefresh(): Promise<ScanDailyMemosResult> {
		if (this.manualRefreshPromise !== null) {
			return this.manualRefreshPromise;
		}
		this.manualRefreshPromise = this.syncOrchestrator.scanRecentDailyMemos(30, "manual_refresh")
			.then(async (result) => {
				if (result.created > 0 || result.updated > 0 || result.deleted > 0) {
					await this.refreshOpenViews();
				}
				return result;
			})
			.finally(() => {
				this.manualRefreshPromise = null;
			});
		return this.manualRefreshPromise;
	}
}

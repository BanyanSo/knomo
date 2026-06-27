import { Notice, Platform, Plugin, TFile } from "obsidian";
import type { WorkspaceLeaf } from "obsidian";

import { KNOMO_VIEW_TYPE } from "./constants";
import { AttachmentService } from "./services/AttachmentService";
import { DailyNoteService } from "./services/DailyNoteService";
import { DailyNotesProvider } from "./services/DailyNotesProvider";
import { FileWatchService } from "./services/FileWatchService";
import { MarkdownBlockService } from "./services/MarkdownBlockService";
import { MemoIndexStore } from "./services/MemoIndexStore";
import { MonthlyArchiveService } from "./services/MonthlyArchiveService";
import { ObsidianExcludeService } from "./services/ObsidianExcludeService";
import { PendingMemoCreateStore } from "./services/PendingMemoCreateStore";
import { RandomReunionService } from "./services/RandomReunionService";
import { ReferenceService } from "./services/ReferenceService";
import { SelfWriteTracker } from "./services/SelfWriteTracker";
import { SettingsService } from "./services/SettingsService";
import { SyncOrchestrator } from "./services/SyncOrchestrator";
import { ViewRefreshScheduler } from "./services/ViewRefreshScheduler";
import type { ScanDailyMemosResult } from "./services/MemoScanService";
import { KNOMO_LOGO_ICON, registerKnomoIcons } from "./icons";
import { t } from "./i18n";
import { KnomoSettingTab } from "./ui/KnomoSettingTab";
import { MobileNavbarCompactController } from "./ui/MobileNavbarCompactController";
import { KnomoView } from "./ui/KnomoView";
import type { MemoMutation } from "./types/memo";
import { formatServiceError } from "./utils/serviceText";

const OPEN_VIEWS_REFRESH_DEBOUNCE_MS = 150;

export default class KnomoPlugin extends Plugin {
	settingsService!: SettingsService;
	syncOrchestrator!: SyncOrchestrator;
	manualRefreshPromise: Promise<ScanDailyMemosResult> | null = null;
	private viewRefreshScheduler: ViewRefreshScheduler | null = null;

	async onload(): Promise<void> {
		registerKnomoIcons();
		const selfWriteTracker = new SelfWriteTracker();
		this.settingsService = new SettingsService(this, (oldPath, newPath) => {
			const now = Date.now();
			const opId = `archive-move-${now}-${newPath}`;
			selfWriteTracker.mark(oldPath, {
				opId,
				path: oldPath,
				reason: "archive_move",
				writtenAt: now,
				expiresAt: now + 10000,
				expectedHash: null,
				targetPath: newPath,
			});
			return () => selfWriteTracker.discard(oldPath, opId);
		});
		await this.loadSettingsSafely();
		const markdownBlockService = new MarkdownBlockService();
		const dailyNotesProvider = new DailyNotesProvider(this.app);
		const dailyNoteService = new DailyNoteService(this.app, markdownBlockService, dailyNotesProvider);
		await this.refreshDailyStatusSafely(dailyNoteService);
		const monthlyArchiveService = new MonthlyArchiveService(this.app, markdownBlockService, (path) => {
			const now = Date.now();
			selfWriteTracker.mark(path, {
				opId: `archive-delete-${now}`,
				path,
				reason: "archive_delete",
				writtenAt: now,
				expiresAt: now + 10000,
				expectedHash: null,
			});
		});
		const memoIndexStore = new MemoIndexStore(this.app);
		const pendingMemoCreateStore = new PendingMemoCreateStore(
			this.app,
			() => this.settingsService.getSettings(),
		);
		const attachmentService = new AttachmentService(this.app);
		this.syncOrchestrator = new SyncOrchestrator(
			this.app,
			() => this.settingsService.getSettings(),
			dailyNoteService,
			monthlyArchiveService,
			memoIndexStore,
			selfWriteTracker,
			markdownBlockService,
			pendingMemoCreateStore,
		);
		this.viewRefreshScheduler = new ViewRefreshScheduler(
			() => this.app.workspace.containerEl.win,
			() => this.runRefreshOpenViews(),
			OPEN_VIEWS_REFRESH_DEBOUNCE_MS,
		);
		const referenceService = new ReferenceService(
			this.app,
			markdownBlockService,
			(memo) => this.syncOrchestrator.ensureReferenceBlockId(memo),
		);
		const randomReunionService = new RandomReunionService(this);
		const obsidianExcludeService = new ObsidianExcludeService(this.app);
		const fileWatchService = new FileWatchService(
			this.app,
			selfWriteTracker,
			this.syncOrchestrator,
			() => this.queueRefreshOpenViews(),
			(path, error) => this.notifyWatchSyncError(path, error),
		);
		fileWatchService.start(this);

		this.registerView(
			KNOMO_VIEW_TYPE,
			(leaf: WorkspaceLeaf) => new KnomoView(
				leaf,
				this.settingsService,
				this.syncOrchestrator,
				referenceService,
				randomReunionService,
				attachmentService,
				(mutation, sourceView) => this.broadcastMemoMutation(mutation, sourceView),
				() => this.runRefreshOpenViews(true),
				() => this.runManualRefresh(),
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

		this.addSettingTab(new KnomoSettingTab(this.app, this, this.settingsService, this.syncOrchestrator, obsidianExcludeService));

		this.app.workspace.onLayoutReady(() => {
			void this.initializeAfterLayoutSafely();
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

	private broadcastMemoMutation(mutation: MemoMutation, sourceView: KnomoView): void {
		for (const leaf of this.app.workspace.getLeavesOfType(KNOMO_VIEW_TYPE)) {
			if (leaf.view instanceof KnomoView && leaf.view !== sourceView) {
				leaf.view.applyMemoMutation(mutation);
			}
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

	private notifyWatchSyncError(path: string, error: unknown): void {
		const message = formatServiceError(error);
		new Notice(t("service.watchSyncFailed", { path, message }));
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
		if (!await this.recoverPendingMemoCreatesSafely()) {
			return;
		}
		if (Platform.isMobile) {
			return;
		}
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
				await this.queueRefreshOpenViews();
			}
		} catch {
			// 启动扫描只做轻量修复，不打断用户。
		}
	}

	private async recoverPendingMemoCreatesSafely(): Promise<boolean> {
		try {
			await this.syncOrchestrator.recoverPendingMemoCreates();
			return true;
		} catch {
			// 未完成创建必须先保留现场，避免启动扫描生成重复 memo。
			return false;
		}
	}

	private runManualRefresh(): Promise<ScanDailyMemosResult> {
		if (this.manualRefreshPromise !== null) {
			return this.manualRefreshPromise;
		}
		this.manualRefreshPromise = this.syncOrchestrator.scanRecentDailyMemos(30, "manual_refresh")
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

const SUPPORTED_IMAGE_EXTENSIONS = new Set(["avif", "bmp", "gif", "jpeg", "jpg", "png", "svg", "webp"]);

function isSupportedImagePath(path: string): boolean {
	const extensionIndex = path.lastIndexOf(".");
	return extensionIndex !== -1 && SUPPORTED_IMAGE_EXTENSIONS.has(path.slice(extensionIndex + 1).toLowerCase());
}

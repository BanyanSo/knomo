import { TFile } from "obsidian";
import type { App, Component } from "obsidian";

import { KnomoError } from "../types/serviceError";
import { hashText } from "../utils/hash";
import type { SelfWriteTracker } from "./SelfWriteTracker";
import type { SyncOrchestrator } from "./SyncOrchestrator";

export type FileWatchSyncErrorHandler = (path: string, error: unknown) => void;

interface FileWatchServiceOptions {
	memoIndexRecoveryScanDays?: number;
}

interface QueuedFileTask {
	key: string;
	path: string;
	task: () => Promise<void>;
}

const DEFAULT_MEMO_INDEX_RECOVERY_SCAN_DAYS = 30;
const MEMO_INDEX_RECOVERY_TASK_KEY = "memo-index-recovery";

// 职责：监听日记与 memo-index 变化；日记写入结合 SelfWriteTracker 防循环。
export class FileWatchService {
	private readonly timersByPath = new Map<string, number>();
	private readonly queuedTasks: QueuedFileTask[] = [];
	private readonly memoIndexRecoveryScanDays: number;
	private taskRunning = false;

	constructor(
		private readonly app: App,
		private readonly selfWriteTracker: SelfWriteTracker,
		private readonly syncOrchestrator: SyncOrchestrator,
		private readonly onSynced?: () => Promise<void> | void,
		private readonly onSyncError?: FileWatchSyncErrorHandler,
		options: FileWatchServiceOptions = {},
	) {
		this.memoIndexRecoveryScanDays = options.memoIndexRecoveryScanDays ?? DEFAULT_MEMO_INDEX_RECOVERY_SCAN_DAYS;
	}

	start(owner: Component): void {
		owner.registerEvent(this.app.vault.on("modify", (file) => this.handleFileChanged(file)));
		owner.registerEvent(this.app.vault.on("create", (file) => this.handleFileChanged(file)));
		owner.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.handleFileRenamed(file, oldPath)));
		owner.registerEvent(this.app.vault.on("delete", (file) => this.handleFileDeleted(file)));
		owner.register(() => this.clearTimers());
	}

	private queueDailySync(file: TFile): void {
		this.queueFileTask(file.path, file.path, () => this.runSync(file));
	}

	private handleFileChanged(file: unknown): void {
		if (!(file instanceof TFile)) {
			return;
		}
		if (file.extension === "md" && this.syncOrchestrator.isPotentialDailyFile(file.path)) {
			this.queueDailySync(file);
		}
		if (file.extension === "json" && this.syncOrchestrator.isMemoIndexFile(file.path)) {
			this.queueIndexRefresh(file);
		}
		if (file.extension === "json" && this.isTimeBuoyIndexFile(file.path)) {
			this.queueTimeBuoyRefresh(file.path);
		}
	}

	private handleFileRenamed(file: unknown, oldPath: string): void {
		if (!(file instanceof TFile)) {
			return;
		}
		if (this.isTimeBuoyIndexFile(oldPath) || this.isTimeBuoyIndexFile(file.path)) {
			this.queueTimeBuoyRefresh(oldPath);
			return;
		}
		if (this.syncOrchestrator.isMemoIndexFile(oldPath)) {
			this.queueMemoIndexRecovery(oldPath);
			return;
		}
		if (this.syncOrchestrator.isMemoIndexFile(file.path)) {
			this.queueIndexRefresh(file);
			return;
		}
		if (this.syncOrchestrator.isMonthlyArchiveFile(oldPath)) {
			if (this.selfWriteTracker.consumeByReason(oldPath, "archive_move", file.path) !== null) {
				return;
			}
			this.queueFileTask(`monthly-rename:${oldPath}`, oldPath, async () => {
				const changed = await this.syncOrchestrator.recoverDeletedMonthlyArchive(oldPath);
				if (changed) {
					await this.onSynced?.();
				}
				if (this.syncOrchestrator.isMonthlyArchiveFile(file.path)) {
					throw new KnomoError("target_path_conflicts", { paths: file.path });
				}
			});
			return;
		}
		if (file.extension !== "md") {
			return;
		}
		if (!this.syncOrchestrator.isPotentialDailyFile(oldPath) && !this.syncOrchestrator.isPotentialDailyFile(file.path)) {
			return;
		}
		const key = `rename:${oldPath}->${file.path}`;
		this.queueFileTask(key, oldPath, async () => {
			const changed = await this.syncOrchestrator.syncRenamedDailyFile(file, oldPath);
			if (changed) {
				await this.onSynced?.();
			}
		});
	}

	private handleFileDeleted(file: unknown): void {
		if (!(file instanceof TFile)) {
			return;
		}
		const path = file.path;
		if (this.isTimeBuoyIndexFile(path)) {
			if (this.selfWriteTracker.consumeByReason(path, "time_buoy_index") !== null) {
				return;
			}
			this.queueTimeBuoyRefresh(path);
			return;
		}
		if (file.extension === "md" && this.syncOrchestrator.isPotentialDailyFile(path)) {
			this.queueFileTask(`delete:${path}`, path, async () => {
				const changed = await this.syncOrchestrator.syncDeletedDailyFile(path);
				if (changed) {
					await this.onSynced?.();
				}
			});
			return;
		}
		if (file.extension === "json" && this.syncOrchestrator.isMemoIndexFile(path)) {
			this.queueMemoIndexRecovery(path);
			return;
		}
		if (!this.syncOrchestrator.isMonthlyArchiveFile(path)) {
			return;
		}
		if (this.selfWriteTracker.consumeByReason(path, "archive_delete") !== null) {
			return;
		}
		this.queueFileTask(`monthly-delete:${path}`, path, async () => {
			const changed = await this.syncOrchestrator.recoverDeletedMonthlyArchive(path);
			if (changed) {
				await this.onSynced?.();
			}
		});
	}

	private queueIndexRefresh(file: TFile): void {
		this.queueFileTask(file.path, file.path, async () => {
			if (this.selfWriteTracker.consumeByReason(file.path, "index") !== null) {
				return;
			}
			await this.onSynced?.();
		});
	}

	private queueMemoIndexRecovery(path: string): void {
		this.queueFileTask(MEMO_INDEX_RECOVERY_TASK_KEY, path, () => this.runMemoIndexRecovery());
	}

	private queueTimeBuoyRefresh(path: string): void {
		this.queueFileTask(`time-buoy-refresh:${path}`, path, async () => {
			if (this.selfWriteTracker.consumeByReason(path, "time_buoy_index") !== null) {
				return;
			}
			await this.onSynced?.();
		});
	}

	private isTimeBuoyIndexFile(path: string): boolean {
		const orchestrator = this.syncOrchestrator as SyncOrchestrator & {
			isTimeBuoyIndexFile?: (candidatePath: string) => boolean;
		};
		return orchestrator.isTimeBuoyIndexFile?.(path) === true;
	}

	private async runMemoIndexRecovery(): Promise<void> {
		const result = await this.syncOrchestrator.scanRecentDailyMemos(
			this.memoIndexRecoveryScanDays,
			"file_watch",
		);
		if (result.created > 0 || result.updated > 0 || result.deleted > 0) {
			await this.onSynced?.();
		}
	}

	private queueFileTask(key: string, path: string, task: () => Promise<void>): void {
		const existingTimer = this.timersByPath.get(key);
		if (existingTimer !== undefined) {
			this.app.workspace.containerEl.win.clearTimeout(existingTimer);
		}

		const timer = this.app.workspace.containerEl.win.setTimeout(() => {
			this.timersByPath.delete(key);
			this.enqueueTask(key, path, task);
		}, this.syncOrchestrator.getSyncDebounceMs());
		this.timersByPath.set(key, timer);
	}

	private enqueueTask(key: string, path: string, task: () => Promise<void>): void {
		const queuedTask = this.queuedTasks.find((item) => item.key === key);
		if (queuedTask !== undefined) {
			queuedTask.path = path;
			queuedTask.task = task;
			return;
		}
		this.queuedTasks.push({ key, path, task });
		void this.flushTaskQueue();
	}

	private async flushTaskQueue(): Promise<void> {
		if (this.taskRunning) {
			return;
		}
		this.taskRunning = true;
		try {
			for (;;) {
				const queuedTask = this.queuedTasks.shift();
				if (queuedTask === undefined) {
					return;
				}
				try {
					await queuedTask.task();
				} catch (error) {
					this.handleSyncError(queuedTask.path, error);
				}
			}
		} finally {
			this.taskRunning = false;
			if (this.queuedTasks.length > 0) {
				void this.flushTaskQueue();
			}
		}
	}

	private async runSync(file: TFile): Promise<void> {
		const content = await this.app.vault.cachedRead(file);
		const expectedHashMarker = this.selfWriteTracker.consumeByExpectedHash(file.path, hashText(content));
		if (expectedHashMarker !== null) {
			return;
		}
		const changed = await this.syncOrchestrator.syncExternalDailyFile(file);
		if (changed) {
			await this.onSynced?.();
		}
	}

	private handleSyncError(path: string, error: unknown): void {
		this.onSyncError?.(path, error);
	}

	private clearTimers(): void {
		for (const timer of this.timersByPath.values()) {
			this.app.workspace.containerEl.win.clearTimeout(timer);
		}
		this.timersByPath.clear();
		this.queuedTasks.length = 0;
	}
}

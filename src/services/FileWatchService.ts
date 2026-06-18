import { TFile } from "obsidian";
import type { App, Component } from "obsidian";

import { hashText } from "../utils/hash";
import type { SelfWriteTracker } from "./SelfWriteTracker";
import type { SyncOrchestrator } from "./SyncOrchestrator";

export type FileWatchSyncErrorHandler = (path: string, error: unknown) => void;

interface QueuedFileTask {
	key: string;
	path: string;
	task: () => Promise<void>;
}

// 职责：监听日记与 memo-index 变化；日记写入结合 SelfWriteTracker 防循环。
export class FileWatchService {
	private readonly timersByPath = new Map<string, number>();
	private readonly queuedTasks: QueuedFileTask[] = [];
	private taskRunning = false;

	constructor(
		private readonly app: App,
		private readonly selfWriteTracker: SelfWriteTracker,
		private readonly syncOrchestrator: SyncOrchestrator,
		private readonly onSynced?: () => Promise<void> | void,
		private readonly onSyncError?: FileWatchSyncErrorHandler,
	) {}

	start(owner: Component): void {
		owner.registerEvent(this.app.vault.on("modify", (file) => this.handleFileChanged(file)));
		owner.registerEvent(this.app.vault.on("create", (file) => this.handleFileChanged(file)));
		owner.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.handleFileRenamed(file, oldPath)));
		owner.registerEvent(this.app.vault.on("delete", (file) => this.handleFileDeleted(file)));
		owner.register(() => this.clearTimers());
	}

	stop(): void {
		this.clearTimers();
		this.selfWriteTracker.cleanup();
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
	}

	private handleFileRenamed(file: unknown, oldPath: string): void {
		if (!(file instanceof TFile) || file.extension !== "md") {
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
		if (!(file instanceof TFile) || file.extension !== "md") {
			return;
		}
		const path = file.path;
		if (this.syncOrchestrator.isPotentialDailyFile(path)) {
			this.queueFileTask(`delete:${path}`, path, async () => {
				const changed = await this.syncOrchestrator.syncDeletedDailyFile(path);
				if (changed) {
					await this.onSynced?.();
				}
			});
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

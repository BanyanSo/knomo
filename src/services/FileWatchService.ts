import { TFile } from "obsidian";
import type { App, Component } from "obsidian";

import { hashText } from "../utils/hash";
import type { SelfWriteTracker } from "./SelfWriteTracker";
import type { SyncOrchestrator } from "./SyncOrchestrator";

export type FileWatchSyncErrorHandler = (path: string, error: unknown) => void;

interface QueuedFileTask {
	file: TFile;
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
		owner.registerEvent(this.app.vault.on("rename", (file) => this.handleFileChanged(file)));
		owner.register(() => this.clearTimers());
	}

	stop(): void {
		this.clearTimers();
		this.selfWriteTracker.cleanup();
	}

	private queueDailySync(file: TFile): void {
		this.queueFileTask(file, () => this.runSync(file));
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

	private queueIndexRefresh(file: TFile): void {
		this.queueFileTask(file, async () => {
			await this.onSynced?.();
		});
	}

	private queueFileTask(file: TFile, task: () => Promise<void>): void {
		const existingTimer = this.timersByPath.get(file.path);
		if (existingTimer !== undefined) {
			this.app.workspace.containerEl.win.clearTimeout(existingTimer);
		}

		const timer = this.app.workspace.containerEl.win.setTimeout(() => {
			this.timersByPath.delete(file.path);
			this.enqueueTask(file, task);
		}, this.syncOrchestrator.getSyncDebounceMs());
		this.timersByPath.set(file.path, timer);
	}

	private enqueueTask(file: TFile, task: () => Promise<void>): void {
		const queuedTask = this.queuedTasks.find((item) => item.file.path === file.path);
		if (queuedTask !== undefined) {
			queuedTask.file = file;
			queuedTask.task = task;
			return;
		}
		this.queuedTasks.push({ file, task });
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
					this.handleSyncError(queuedTask.file, error);
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

	private handleSyncError(file: TFile, error: unknown): void {
		this.onSyncError?.(file.path, error);
	}

	private clearTimers(): void {
		for (const timer of this.timersByPath.values()) {
			this.app.workspace.containerEl.win.clearTimeout(timer);
		}
		this.timersByPath.clear();
		this.queuedTasks.length = 0;
	}
}

import { Notice, TFile } from "obsidian";
import type { App, Component } from "obsidian";

import { hashText } from "../utils/hash";
import { t } from "../i18n";
import { formatSettingsText } from "../ui/KnomoSettingTab";
import type { SelfWriteTracker } from "./SelfWriteTracker";
import type { SyncOrchestrator } from "./SyncOrchestrator";

// 职责：监听相关文件变化，并结合 SelfWriteTracker 判断是否为自身写入。
export class FileWatchService {
	private readonly timersByPath = new Map<string, number>();

	constructor(
		private readonly app: App,
		private readonly selfWriteTracker: SelfWriteTracker,
		private readonly syncOrchestrator: SyncOrchestrator,
		private readonly onSynced?: () => Promise<void> | void,
	) {}

	start(owner: Component): void {
		owner.registerEvent(this.app.vault.on("modify", (file) => {
			if (!(file instanceof TFile) || file.extension !== "md") {
				return;
			}
			if (!this.syncOrchestrator.isPotentialDailyFile(file.path)) {
				return;
			}
			this.queueSync(file);
		}));
		owner.register(() => this.clearTimers());
	}

	stop(): void {
		this.clearTimers();
		this.selfWriteTracker.cleanup();
	}

	private queueSync(file: TFile): void {
		const existingTimer = this.timersByPath.get(file.path);
		if (existingTimer !== undefined) {
			this.app.workspace.containerEl.win.clearTimeout(existingTimer);
		}

		const timer = this.app.workspace.containerEl.win.setTimeout(() => {
			this.timersByPath.delete(file.path);
			void this.runSync(file).catch((error) => this.handleSyncError(file, error));
		}, this.syncOrchestrator.getSyncDebounceMs());
		this.timersByPath.set(file.path, timer);
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
		const message = formatSettingsText(error instanceof Error ? error.message : t("service.unknownError"));
		new Notice(t("service.watchSyncFailed", { path: file.path, message }));
	}

	private clearTimers(): void {
		for (const timer of this.timersByPath.values()) {
			this.app.workspace.containerEl.win.clearTimeout(timer);
		}
		this.timersByPath.clear();
	}
}

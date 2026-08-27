import { TFolder } from "obsidian";
import type { App } from "obsidian";

import type { LegacyMigrationCleanupCandidate } from "../types/legacyMigration";
import {
	buildPluginDataWithLegacyMigrationNoticeSourceRevision,
	extractLegacyMigrationNoticeSourceRevision,
} from "../utils/pluginData";
import { PluginDataStore } from "./PluginDataStore";

export class LegacyMigrationCompletionNoticeService {
	private layoutReady = false;

	constructor(
		private readonly app: App,
		private readonly pluginDataStore: PluginDataStore,
		private readonly showNotice: (legacySystemRoot: string) => void,
	) {}

	markLayoutReady(): void {
		this.layoutReady = true;
	}

	async showIfNeeded(candidate: LegacyMigrationCleanupCandidate | null): Promise<boolean> {
		if (!this.layoutReady
			|| candidate === null
			|| candidate.sourceRevision.length === 0
			|| !(this.app.vault.getAbstractFileByPath(candidate.legacySystemRoot) instanceof TFolder)) {
			return false;
		}
		const shouldShow = await this.pluginDataStore.mutate((savedData) => {
			if (extractLegacyMigrationNoticeSourceRevision(savedData) === candidate.sourceRevision) {
				return { nextData: null, result: false };
			}
			return {
				nextData: buildPluginDataWithLegacyMigrationNoticeSourceRevision(savedData, candidate.sourceRevision),
				result: true,
			};
		});
		if (!shouldShow) return false;
		this.showNotice(candidate.legacySystemRoot);
		return true;
	}
}

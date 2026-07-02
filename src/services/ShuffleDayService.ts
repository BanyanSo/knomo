import type { Plugin } from "obsidian";

import type { MemoRecord } from "../types/memo";
import {
	buildPluginDataWithShuffleDayHistory,
	extractShuffleDayHistory,
} from "../utils/pluginData";
import {
	selectShuffleDay,
	type ShuffleDayHistoryEntry,
	type ShuffleDaySelectionResult,
} from "../utils/shuffleDay";

export class ShuffleDayService {
	constructor(private readonly plugin: Plugin) {}

	async selectShuffleDay(memos: MemoRecord[]): Promise<ShuffleDaySelectionResult> {
		const history = await this.loadHistory();
		const result = selectShuffleDay(memos, { history });
		if (result.status === "ready") {
			await this.saveHistory(result.nextHistory);
		}
		return result;
	}

	private async loadHistory(): Promise<ShuffleDayHistoryEntry[]> {
		const savedData: unknown = await this.plugin.loadData();
		return extractShuffleDayHistory(savedData);
	}

	private async saveHistory(history: ShuffleDayHistoryEntry[]): Promise<void> {
		const savedData: unknown = await this.plugin.loadData();
		await this.plugin.saveData(buildPluginDataWithShuffleDayHistory(savedData, history));
	}
}

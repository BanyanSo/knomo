import type { MemoRecord } from "../types/memo";
import {
	buildPluginDataWithShuffleDayHistory,
	extractShuffleDayHistory,
} from "../utils/pluginData";
import {
	selectShuffleDay,
	type ShuffleDaySelectionResult,
} from "../utils/shuffleDay";
import type { PluginDataStore } from "./PluginDataStore";

export class ShuffleDayService {
	constructor(private readonly pluginDataStore: PluginDataStore) {}

	async selectShuffleDay(memos: MemoRecord[]): Promise<ShuffleDaySelectionResult> {
		return this.pluginDataStore.mutate((savedData) => {
			const result = selectShuffleDay(memos, {
				history: extractShuffleDayHistory(savedData),
			});
			return {
				nextData: result.status === "ready"
					? buildPluginDataWithShuffleDayHistory(savedData, result.nextHistory)
					: null,
				result,
			};
		});
	}
}

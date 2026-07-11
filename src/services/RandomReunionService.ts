import type { MemoRecord } from "../types/memo";
import type { MemoReviewStateMap } from "../types/review";
import {
	extractRandomReunionReviewStates,
	buildPluginDataWithRandomReunionReviewStates,
} from "../utils/pluginData";
import {
	getRandomReunionMemos,
	markMemoReviewed,
} from "../utils/randomReunion";
import type { PluginDataStore } from "./PluginDataStore";

export class RandomReunionService {
	constructor(private readonly pluginDataStore: PluginDataStore) {}

	async getRandomReunionMemos(count: number, memos: MemoRecord[]): Promise<MemoRecord[]> {
		const reviewStates = await this.loadReviewStates();
		return getRandomReunionMemos(memos, reviewStates, count);
	}

	async markRandomReunionReviewed(memoId: string): Promise<void> {
		await this.pluginDataStore.mutate((savedData) => {
			const reviewStates = extractRandomReunionReviewStates(savedData);
			return {
				nextData: buildPluginDataWithRandomReunionReviewStates(
					savedData,
					markMemoReviewed(reviewStates, memoId),
				),
				result: undefined,
			};
		});
	}

	async loadReviewStates(): Promise<MemoReviewStateMap> {
		const savedData = await this.pluginDataStore.read();
		return extractRandomReunionReviewStates(savedData);
	}
}

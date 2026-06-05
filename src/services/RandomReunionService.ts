import type { Plugin } from "obsidian";

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

export class RandomReunionService {
	constructor(private readonly plugin: Plugin) {}

	async getRandomReunionMemos(count: number, memos: MemoRecord[]): Promise<MemoRecord[]> {
		const reviewStates = await this.loadReviewStates();
		return getRandomReunionMemos(memos, reviewStates, count);
	}

	async markRandomReunionReviewed(memoId: string): Promise<void> {
		const savedData: unknown = await this.plugin.loadData();
		const reviewStates = extractRandomReunionReviewStates(savedData);
		await this.saveReviewStates(markMemoReviewed(reviewStates, memoId));
	}

	async loadReviewStates(): Promise<MemoReviewStateMap> {
		const savedData: unknown = await this.plugin.loadData();
		return extractRandomReunionReviewStates(savedData);
	}

	private async saveReviewStates(reviewStates: MemoReviewStateMap): Promise<void> {
		const savedData: unknown = await this.plugin.loadData();
		await this.plugin.saveData(buildPluginDataWithRandomReunionReviewStates(savedData, reviewStates));
	}
}

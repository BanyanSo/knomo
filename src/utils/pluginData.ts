import type { KnomoSettings } from "../types/settings";
import type { MemoReviewState, MemoReviewStateMap } from "../types/review";
import { isRecord } from "./object";

const SETTINGS_KEY = "settings";
const RANDOM_REUNION_REVIEW_STATES_KEY = "randomReunionReviewStates";

export function extractSettingsData(savedData: unknown): unknown {
	if (isRecord(savedData) && isRecord(savedData[SETTINGS_KEY])) {
		return savedData[SETTINGS_KEY];
	}
	return savedData;
}

export function buildPluginDataWithSettings(savedData: unknown, settings: KnomoSettings): Record<string, unknown> {
	const nextData = getStructuredPluginData(savedData);
	nextData[SETTINGS_KEY] = settings;
	return nextData;
}

export function extractRandomReunionReviewStates(savedData: unknown): MemoReviewStateMap {
	if (!isRecord(savedData) || !isRecord(savedData[RANDOM_REUNION_REVIEW_STATES_KEY])) {
		return {};
	}
	const states: MemoReviewStateMap = {};
	for (const [memoId, value] of Object.entries(savedData[RANDOM_REUNION_REVIEW_STATES_KEY])) {
		const state = normalizeReviewState(memoId, value);
		if (state !== null) {
			states[memoId] = state;
		}
	}
	return states;
}

export function buildPluginDataWithRandomReunionReviewStates(
	savedData: unknown,
	states: MemoReviewStateMap,
): Record<string, unknown> {
	const nextData = getStructuredPluginData(savedData);
	nextData[RANDOM_REUNION_REVIEW_STATES_KEY] = states;
	return nextData;
}

function getStructuredPluginData(savedData: unknown): Record<string, unknown> {
	if (isStructuredPluginData(savedData)) {
		return Object.assign({}, savedData);
	}
	return {
		[SETTINGS_KEY]: extractSettingsData(savedData),
	};
}

function isStructuredPluginData(value: unknown): value is Record<string, unknown> {
	return isRecord(value) && (SETTINGS_KEY in value || RANDOM_REUNION_REVIEW_STATES_KEY in value);
}

function normalizeReviewState(memoId: string, value: unknown): MemoReviewState | null {
	if (!isRecord(value)) {
		return null;
	}
	const stateMemoId = typeof value.memoId === "string" && value.memoId.length > 0 ? value.memoId : memoId;
	const reviewCount = typeof value.reviewCount === "number" && Number.isFinite(value.reviewCount)
		? Math.max(0, Math.floor(value.reviewCount))
		: 0;
	const lastReviewedAt = typeof value.lastReviewedAt === "string" && value.lastReviewedAt.length > 0
		? value.lastReviewedAt
		: undefined;
	return lastReviewedAt === undefined
		? { memoId: stateMemoId, reviewCount }
		: { memoId: stateMemoId, lastReviewedAt, reviewCount };
}

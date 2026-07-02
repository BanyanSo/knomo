import type { KnomoSettings } from "../types/settings";
import type { MemoReviewState, MemoReviewStateMap } from "../types/review";
import type { ShuffleDayHistoryEntry } from "./shuffleDay";
import { isRecord } from "./object";
import { normalizeShuffleDayHistory } from "./shuffleDay";

const SETTINGS_KEY = "settings";
const RANDOM_REUNION_REVIEW_STATES_KEY = "randomReunionReviewStates";
const SHUFFLE_DAY_HISTORY_KEY = "shuffleDayHistory";

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

export function extractShuffleDayHistory(savedData: unknown): ShuffleDayHistoryEntry[] {
	if (!isRecord(savedData) || !Array.isArray(savedData[SHUFFLE_DAY_HISTORY_KEY])) {
		return [];
	}
	return normalizeShuffleDayHistory(savedData[SHUFFLE_DAY_HISTORY_KEY].map(normalizeShuffleDayHistoryEntry)
		.filter((entry): entry is ShuffleDayHistoryEntry => entry !== null));
}

export function buildPluginDataWithShuffleDayHistory(
	savedData: unknown,
	history: ShuffleDayHistoryEntry[],
): Record<string, unknown> {
	const nextData = getStructuredPluginData(savedData);
	nextData[SHUFFLE_DAY_HISTORY_KEY] = normalizeShuffleDayHistory(history);
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
	return isRecord(value) && (
		SETTINGS_KEY in value ||
		RANDOM_REUNION_REVIEW_STATES_KEY in value ||
		SHUFFLE_DAY_HISTORY_KEY in value
	);
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

function normalizeShuffleDayHistoryEntry(value: unknown): ShuffleDayHistoryEntry | null {
	if (!isRecord(value) || typeof value.date !== "string" || typeof value.shownAt !== "string") {
		return null;
	}
	return {
		date: value.date,
		shownAt: value.shownAt,
	};
}

import type { KnomoSettings } from "../types/settings";
import type { ShuffleDayHistoryEntry } from "./shuffleDay";
import { isRecord } from "./object";
import { normalizeShuffleDayHistory } from "./shuffleDay";
import type { BeaconReference } from "../types/beacon";

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

export function extractShuffleDayHistory(savedData: unknown, now = new Date()): ShuffleDayHistoryEntry[] {
	if (!isRecord(savedData) || !Array.isArray(savedData[SHUFFLE_DAY_HISTORY_KEY])) {
		return [];
	}
	return normalizeShuffleDayHistory(savedData[SHUFFLE_DAY_HISTORY_KEY].map(normalizeShuffleDayHistoryEntry)
		.filter((entry): entry is ShuffleDayHistoryEntry => entry !== null), now);
}

export function buildPluginDataWithShuffleDayHistory(
	savedData: unknown,
	history: ShuffleDayHistoryEntry[],
	now = new Date(),
): Record<string, unknown> {
	const nextData = getStructuredPluginData(savedData);
	nextData[SHUFFLE_DAY_HISTORY_KEY] = normalizeShuffleDayHistory(history, now);
	return nextData;
}

function getStructuredPluginData(savedData: unknown): Record<string, unknown> {
	if (isStructuredPluginData(savedData)) {
		const nextData = Object.assign({}, savedData);
		delete nextData.maintenanceDiagnostic;
		return nextData;
	}
	return {
		[SETTINGS_KEY]: extractSettingsData(savedData),
	};
}

function isStructuredPluginData(value: unknown): value is Record<string, unknown> {
	return isRecord(value) && (
		SETTINGS_KEY in value ||
		RANDOM_REUNION_REVIEW_STATES_KEY in value ||
		SHUFFLE_DAY_HISTORY_KEY in value ||
		"beacon" in value ||
		// 仅按字段存在识别数据结构，保存时原样保留旧完成标记。
		"legacyMigration" in value
	);
}

export function getBeaconData(savedData: unknown): unknown {
	return isRecord(savedData) ? savedData.beacon : undefined;
}

function hasPathControlCharacter(path: string): boolean {
	for (let index = 0; index < path.length; index++) {
		if (path.charCodeAt(index) <= 0x1f) return true;
	}
	return false;
}

export function parseBeaconReference(value: unknown): BeaconReference | null {
	if (!isRecord(value) || typeof value.sourcePath !== "string" || value.sourcePath.length === 0
		|| !value.sourcePath.endsWith(".md") || value.sourcePath.startsWith("/")
		|| /(?:^|\/)\.\.?(?:\/|$)|[\\:]|\/\//u.test(value.sourcePath)
		|| hasPathControlCharacter(value.sourcePath)
		|| typeof value.blockId !== "string" || !/^[A-Za-z0-9-]+$/u.test(value.blockId)
		|| typeof value.memoTime !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/u.test(value.memoTime)) return null;
	return { sourcePath: value.sourcePath, blockId: value.blockId, memoTime: value.memoTime };
}

export function buildPluginDataWithBeacon(savedData: unknown, beacon: BeaconReference | undefined): Record<string, unknown> {
	const nextData = getStructuredPluginData(savedData);
	if (beacon === undefined) delete nextData.beacon;
	else nextData.beacon = beacon;
	return nextData;
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

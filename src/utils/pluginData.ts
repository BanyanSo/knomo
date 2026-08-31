import type { KnomoSettings } from "../types/settings";
import type { ShuffleDayHistoryEntry } from "./shuffleDay";
import { isRecord } from "./object";
import { normalizeShuffleDayHistory } from "./shuffleDay";

const SETTINGS_KEY = "settings";
const RANDOM_REUNION_REVIEW_STATES_KEY = "randomReunionReviewStates";
const SHUFFLE_DAY_HISTORY_KEY = "shuffleDayHistory";
const LEGACY_MIGRATION_NOTICE_SOURCE_REVISION_KEY = "legacyMigrationNoticeSourceRevision";
const LEGACY_MIGRATION_ACKNOWLEDGED_SOURCE_REVISION_KEY = "legacyMigrationAcknowledgedSourceRevision";

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
		LEGACY_MIGRATION_NOTICE_SOURCE_REVISION_KEY in value ||
		LEGACY_MIGRATION_ACKNOWLEDGED_SOURCE_REVISION_KEY in value
	);
}

export function extractLegacyMigrationNoticeSourceRevision(savedData: unknown): string | null {
	if (!isRecord(savedData)) return null;
	const value = savedData[LEGACY_MIGRATION_NOTICE_SOURCE_REVISION_KEY];
	return typeof value === "string" && value.length > 0 ? value : null;
}

export function buildPluginDataWithLegacyMigrationNoticeSourceRevision(
	savedData: unknown,
	sourceRevision: string,
): Record<string, unknown> {
	const nextData = getStructuredPluginData(savedData);
	nextData[LEGACY_MIGRATION_NOTICE_SOURCE_REVISION_KEY] = sourceRevision;
	return nextData;
}

export function extractLegacyMigrationAcknowledgedSourceRevision(savedData: unknown): string | null {
	if (!isRecord(savedData)) return null;
	const value = savedData[LEGACY_MIGRATION_ACKNOWLEDGED_SOURCE_REVISION_KEY];
	return typeof value === "string" && value.length > 0 ? value : null;
}

export function buildPluginDataWithLegacyMigrationAcknowledgedSourceRevision(
	savedData: unknown,
	sourceRevision: string,
): Record<string, unknown> {
	const nextData = getStructuredPluginData(savedData);
	nextData[LEGACY_MIGRATION_ACKNOWLEDGED_SOURCE_REVISION_KEY] = sourceRevision;
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

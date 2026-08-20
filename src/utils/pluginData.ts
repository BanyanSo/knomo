import type { KnomoSettings } from "../types/settings";
import type { ShuffleDayHistoryEntry } from "./shuffleDay";
import { isRecord } from "./object";
import { normalizeShuffleDayHistory } from "./shuffleDay";

const SETTINGS_KEY = "settings";
const RANDOM_REUNION_REVIEW_STATES_KEY = "randomReunionReviewStates";
const SHUFFLE_DAY_HISTORY_KEY = "shuffleDayHistory";
const CATALOG_V2_CONFIG_KEY = "catalogV2";

export interface CatalogV2PluginConfig {
	schemaVersion: 2;
	catalogDataRoot: string;
	vaultInstanceId: string;
	contractDigest: string;
}

export interface IntermediateCatalogV2PluginConfig {
	schemaVersion: 1;
	catalogDataRoot: string;
}

export interface LegacyCatalogV2PluginConfig {
	schemaVersion: 1;
	systemDataRoot: string;
}

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

export function extractCatalogV2PluginConfig(
	savedData: unknown,
): CatalogV2PluginConfig | IntermediateCatalogV2PluginConfig | LegacyCatalogV2PluginConfig | null {
	if (!isRecord(savedData) || !isRecord(savedData[CATALOG_V2_CONFIG_KEY])) {
		return null;
	}
	const value = savedData[CATALOG_V2_CONFIG_KEY];
	if (value.schemaVersion === 2 && typeof value.catalogDataRoot === "string"
		&& typeof value.vaultInstanceId === "string" && typeof value.contractDigest === "string") {
		return {
			schemaVersion: 2,
			catalogDataRoot: value.catalogDataRoot,
			vaultInstanceId: value.vaultInstanceId,
			contractDigest: value.contractDigest,
		};
	}
	if (value.schemaVersion !== 1) return null;
	if (typeof value.catalogDataRoot === "string") {
		return { schemaVersion: 1, catalogDataRoot: value.catalogDataRoot };
	}
	if (typeof value.systemDataRoot === "string") {
		return { schemaVersion: 1, systemDataRoot: value.systemDataRoot };
	}
	return null;
}

export function buildPluginDataWithCatalogV2Config(
	savedData: unknown,
	config: CatalogV2PluginConfig,
): Record<string, unknown> {
	const nextData = getStructuredPluginData(savedData);
	nextData[CATALOG_V2_CONFIG_KEY] = config;
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
		CATALOG_V2_CONFIG_KEY in value
	);
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

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
		"legacyMigration" in value
	);
}

export function getBeaconData(savedData: unknown): unknown {
	return isRecord(savedData) ? savedData.beacon : undefined;
}

export function parseBeaconReference(value: unknown): BeaconReference | null {
	if (!isRecord(value) || !isValidBeaconDate(value.logicalDate) || !isRecord(value.handle)) return null;
	const h = value.handle;
	if (typeof h.sourcePath !== "string" || h.sourcePath.length === 0 || !h.sourcePath.endsWith(".md")
		|| h.sourcePath.startsWith("/") || /(?:^|\/)\.\.?(?:\/|$)|[\\:\u0000-\u001f]/u.test(h.sourcePath)
		|| typeof h.sourceRevision !== "string" || !/^[a-f0-9]{64}$/u.test(h.sourceRevision)
		|| typeof h.rawBlockHash !== "string" || !/^fnv1a-[a-f0-9]{8}$/u.test(h.rawBlockHash)
		|| !Number.isSafeInteger(h.startLine) || Number(h.startLine) < 0
		|| !Number.isSafeInteger(h.endLine) || Number(h.endLine) < Number(h.startLine)) return null;
	let bodyProof: BeaconReference["bodyProof"];
	if (value.bodyProof !== undefined) {
		const p = value.bodyProof;
		if (!isRecord(p) || typeof p.digest !== "string" || !/^[a-f0-9]{64}$/u.test(p.digest)
			|| !Number.isSafeInteger(p.startLine) || Number(p.startLine) < 0 || Number(p.startLine) > Number(h.startLine)) return null;
		bodyProof = { digest: p.digest, startLine: Number(p.startLine) };
	}
	return { handle: { sourcePath: h.sourcePath, sourceRevision: h.sourceRevision, startLine: Number(h.startLine),
		endLine: Number(h.endLine), rawBlockHash: h.rawBlockHash }, logicalDate: value.logicalDate,
		...(bodyProof ? { bodyProof } : {}) };
}

export function isValidBeaconDate(value: unknown): value is string {
	if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
	const date = new Date(value + "T12:00:00");
	return !Number.isNaN(date.valueOf()) && date.getFullYear() === Number(value.slice(0, 4))
		&& date.getMonth() + 1 === Number(value.slice(5, 7)) && date.getDate() === Number(value.slice(8, 10));
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

export interface LegacyMigrationCompletion {
	completed: true;
	legacySystemRoot: string;
	sourceRevision: string;
}

export function extractLegacyMigration(savedData: unknown): LegacyMigrationCompletion | null {
	if (!isRecord(savedData) || savedData.legacyMigration === undefined) return null;
	const value = savedData.legacyMigration;
	if (!isRecord(value) || value.completed !== true || typeof value.legacySystemRoot !== "string"
		|| typeof value.sourceRevision !== "string" || !/^[a-f0-9]{64}$/u.test(value.sourceRevision)) throw new Error("Invalid legacy migration completion.");
	return { completed: true, legacySystemRoot: value.legacySystemRoot, sourceRevision: value.sourceRevision };
}

export function buildPluginDataWithLegacyMigration(savedData: unknown, completion: LegacyMigrationCompletion): Record<string, unknown> {
	return { ...getStructuredPluginData(savedData), legacyMigration: completion };
}

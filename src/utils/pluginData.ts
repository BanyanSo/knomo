import type { KnomoSettings } from "../types/settings";
import type { MemoReviewState, MemoReviewStateMap } from "../types/review";
import type { ShuffleDayHistoryEntry } from "./shuffleDay";
import { isRecord } from "./object";
import { normalizeShuffleDayHistory } from "./shuffleDay";

const SETTINGS_KEY = "settings";
const RANDOM_REUNION_REVIEW_STATES_KEY = "randomReunionReviewStates";
const SHUFFLE_DAY_HISTORY_KEY = "shuffleDayHistory";
const MAINTENANCE_DIAGNOSTIC_KEY = "maintenanceDiagnostic";

export type MaintenanceDiagnosticTask = "startup_scan" | "file_watch" | "repair";
export type MaintenanceDiagnosticStatus = "completed" | "failed";

export interface MaintenanceDiagnostic {
	task: MaintenanceDiagnosticTask;
	status: MaintenanceDiagnosticStatus;
	occurredAt: string;
	scope: string | null;
	mode: string | null;
	message: string;
	scannedFiles: number | null;
	created: number | null;
	updated: number | null;
	deleted: number | null;
	failed: number | null;
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

export function extractMaintenanceDiagnostic(savedData: unknown): MaintenanceDiagnostic | null {
	if (!isRecord(savedData)) {
		return null;
	}
	return normalizeMaintenanceDiagnostic(savedData[MAINTENANCE_DIAGNOSTIC_KEY]);
}

export function buildPluginDataWithMaintenanceDiagnostic(
	savedData: unknown,
	diagnostic: MaintenanceDiagnostic,
): Record<string, unknown> {
	const nextData = getStructuredPluginData(savedData);
	nextData[MAINTENANCE_DIAGNOSTIC_KEY] = diagnostic;
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
		SHUFFLE_DAY_HISTORY_KEY in value ||
		MAINTENANCE_DIAGNOSTIC_KEY in value
	);
}

function normalizeMaintenanceDiagnostic(value: unknown): MaintenanceDiagnostic | null {
	if (!isRecord(value)) {
		return null;
	}
	const task = normalizeDiagnosticTask(value.task);
	const status = normalizeDiagnosticStatus(value.status);
	const occurredAt = typeof value.occurredAt === "string" ? value.occurredAt : "";
	const message = typeof value.message === "string" ? value.message : "";
	if (task === null || status === null || occurredAt.length === 0 || message.length === 0) {
		return null;
	}
	return {
		task,
		status,
		occurredAt,
		scope: normalizeNullableString(value.scope),
		mode: normalizeNullableString(value.mode),
		message,
		scannedFiles: normalizeNullableNumber(value.scannedFiles),
		created: normalizeNullableNumber(value.created),
		updated: normalizeNullableNumber(value.updated),
		deleted: normalizeNullableNumber(value.deleted),
		failed: normalizeNullableNumber(value.failed),
	};
}

function normalizeDiagnosticTask(value: unknown): MaintenanceDiagnosticTask | null {
	return value === "startup_scan" || value === "file_watch" || value === "repair" ? value : null;
}

function normalizeDiagnosticStatus(value: unknown): MaintenanceDiagnosticStatus | null {
	return value === "completed" || value === "failed" ? value : null;
}

function normalizeNullableString(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function normalizeNullableNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
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

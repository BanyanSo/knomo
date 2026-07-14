import { normalizePath } from "obsidian";

import { DEFAULT_MONTHLY_MEMO_FOLDER } from "../constants";

export function normalizeVaultPath(path: string): string {
	const trimmedPath = path.trim();
	const normalizedPath = normalizePath(trimmedPath || DEFAULT_MONTHLY_MEMO_FOLDER);
	return normalizedPath.replace(/^\/+/, "");
}

export function getSystemFolderPath(monthlyMemoFolder: string): string {
	return normalizePath(`${normalizeVaultPath(monthlyMemoFolder)}/_knomo-system`);
}

export function getIndexFolderPath(monthlyMemoFolder: string): string {
	return normalizePath(`${getSystemFolderPath(monthlyMemoFolder)}/indexes`);
}

export function getIndexFilePath(monthlyMemoFolder: string, period: string): string {
	return normalizePath(`${getIndexFolderPath(monthlyMemoFolder)}/memo-index-${period}.json`);
}

export function getTimeBuoyIndexFolderPath(monthlyMemoFolder: string): string {
	return normalizePath(`${getIndexFolderPath(monthlyMemoFolder)}/time-buoy`);
}

export function getTimeBuoyIndexFilePath(monthlyMemoFolder: string, targetPeriod: string): string {
	return normalizePath(`${getTimeBuoyIndexFolderPath(monthlyMemoFolder)}/time-buoy-${targetPeriod}.json`);
}

export function getTimeBuoyIndexStateFilePath(monthlyMemoFolder: string): string {
	return normalizePath(`${getTimeBuoyIndexFolderPath(monthlyMemoFolder)}/time-buoy-state.json`);
}

export function getPendingMemoCreateFilePath(monthlyMemoFolder: string): string {
	return normalizePath(`${getSystemFolderPath(monthlyMemoFolder)}/pending-memo-creates.json`);
}

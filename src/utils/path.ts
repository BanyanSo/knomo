import { normalizePath } from "obsidian";

import { DEFAULT_MONTHLY_MEMO_FOLDER } from "../constants";

export function normalizeVaultPath(path: string): string {
	const trimmedPath = path.trim();
	const normalizedPath = normalizePath(trimmedPath || DEFAULT_MONTHLY_MEMO_FOLDER);
	return normalizedPath.replace(/^\/+/, "");
}

export function getLegacySystemRootPath(monthlyMemoFolder: string): string {
	return normalizePath(`${normalizeVaultPath(monthlyMemoFolder)}/_knomo-system`);
}

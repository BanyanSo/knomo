import { normalizePath } from "obsidian";

import type { LegacyArtifactKind } from "../types/legacyIndex";
import { isLikelySyncConflictPath } from "../utils/syncConflict";

export interface LegacyArtifactPathClassification {
	artifactKind: LegacyArtifactKind;
	period: string | null;
	conflict: boolean;
}

export function classifyLegacyArtifactPath(
	legacySystemRoot: string,
	path: string,
): LegacyArtifactPathClassification | null {
	const root = normalizeStrictPath(legacySystemRoot);
	const candidate = normalizeStrictPath(path);
	if (root === null || candidate === null || !candidate.startsWith(`${root}/`)) return null;

	if (candidate === `${root}/pending-memo-creates.json`) {
		return { artifactKind: "pending_create", period: null, conflict: false };
	}
	const pendingName = getDirectChildName(root, candidate);
	if (pendingName !== null
		&& /^pending-memo-creates.+\.json$/u.test(pendingName)
		&& isLikelySyncConflictPath(pendingName)) {
		return { artifactKind: "pending_create", period: null, conflict: true };
	}
	const memoIndexFolder = `${root}/indexes`;
	const memoIndexName = getDirectChildName(memoIndexFolder, candidate);
	if (memoIndexName !== null) {
		const canonical = /^memo-index-(\d{4}-(?:0[1-9]|1[0-2]))\.json$/.exec(memoIndexName);
		if (canonical !== null) return { artifactKind: "memo_index", period: canonical[1] ?? null, conflict: false };
		const conflict = /^memo-index-(\d{4}-(?:0[1-9]|1[0-2])).+\.json$/.exec(memoIndexName);
		if (conflict !== null && isLikelySyncConflictPath(memoIndexName)) {
			return { artifactKind: "memo_index", period: conflict[1] ?? null, conflict: true };
		}
		if (memoIndexName === "memo-summary.json") {
			return { artifactKind: "memo_summary", period: null, conflict: false };
		}
		if (/^memo-summary.+\.json$/u.test(memoIndexName) && isLikelySyncConflictPath(memoIndexName)) {
			return { artifactKind: "memo_summary", period: null, conflict: true };
		}
	}

	const timeBuoyFolder = `${root}/indexes/time-buoy`;
	const timeBuoyName = getDirectChildName(timeBuoyFolder, candidate);
	if (timeBuoyName !== null) {
		const canonicalIndex = /^time-buoy-(\d{4}-(?:0[1-9]|1[0-2]))\.json$/.exec(timeBuoyName);
		if (canonicalIndex !== null) return { artifactKind: "time_buoy_index", period: canonicalIndex[1] ?? null, conflict: false };
		if (timeBuoyName === "time-buoy-state.json") {
			return { artifactKind: "time_buoy_state", period: null, conflict: false };
		}
		const conflictIndex = /^time-buoy-(\d{4}-(?:0[1-9]|1[0-2])).+\.json$/.exec(timeBuoyName);
		if (conflictIndex !== null && isLikelySyncConflictPath(timeBuoyName)) {
			return { artifactKind: "time_buoy_index", period: conflictIndex[1] ?? null, conflict: true };
		}
		if (/^time-buoy-state.+\.json$/.test(timeBuoyName) && isLikelySyncConflictPath(timeBuoyName)) {
			return { artifactKind: "time_buoy_state", period: null, conflict: true };
		}
	}

	const repairName = getDirectChildName(`${root}/repair`, candidate);
	if (repairName !== null && /(?:repair|candidate).+\.json$/.test(repairName)) {
		return { artifactKind: "repair_candidate", period: null, conflict: isLikelySyncConflictPath(repairName) };
	}

	const backupPath = getDescendantPath(`${root}/backups`, candidate);
	const backupFolder = backupPath?.split("/")[0] ?? null;
	if (backupFolder !== null && isLegacyBackupFolder(backupFolder)) {
		return { artifactKind: "backup", period: null, conflict: false };
	}
	return null;
}

export function classifyPluginDataPath(configDir: string, pluginId: string, path: string): LegacyArtifactPathClassification | null {
	const expected = normalizeStrictPath(`${configDir}/plugins/${pluginId}/data.json`);
	const candidate = normalizeStrictPath(path);
	return expected !== null && candidate === expected
		? { artifactKind: "plugin_data", period: null, conflict: false }
		: null;
}

function normalizeStrictPath(path: string): string | null {
	const trimmed = path.trim();
	if (trimmed.length === 0 || trimmed.startsWith("/") || trimmed.includes("\\") || /(^|\/)\.{1,2}(\/|$)/.test(trimmed) || /[\u0000-\u001f]/.test(trimmed)) {
		return null;
	}
	return normalizePath(trimmed).replace(/^\/+|\/+$/g, "");
}

function getDirectChildName(folder: string, path: string): string | null {
	const prefix = `${folder}/`;
	if (!path.startsWith(prefix)) return null;
	const name = path.slice(prefix.length);
	return name.length > 0 && !name.includes("/") ? name : null;
}

function getDescendantPath(folder: string, path: string): string | null {
	const prefix = `${folder}/`;
	return path.startsWith(prefix) && path.length > prefix.length ? path.slice(prefix.length) : null;
}

function isLegacyBackupFolder(name: string): boolean {
	return /^rebuild-index-\d{8}-\d{6}$/u.test(name)
		|| /^rebuild-monthly-\d{4}-\d{2}-\d{8}-\d{6}$/u.test(name)
		|| /^time-buoy-rebuild-\d{4}-.+$/u.test(name)
		|| /^monthly-(?:format|folder)-\d+$/u.test(name);
}

const SYNC_CONFLICT_PATTERNS = [
	/\bconflict(?:ed)?\b/i,
	/\bsync-conflict\b/i,
	/冲突/,
];

export function isLikelySyncConflictPath(path: string): boolean {
	return SYNC_CONFLICT_PATTERNS.some((pattern) => pattern.test(path));
}

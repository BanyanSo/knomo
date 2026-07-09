export type SyncConflictFileKind = "memo-index" | "monthly-archive";

export interface SyncConflictFile {
	kind: SyncConflictFileKind;
	path: string;
	period: string | null;
}

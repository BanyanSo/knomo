import type { MemoRecord } from "./memo";

export interface MemoIndex {
	schemaVersion: 2;
	period: string;
	updatedAt: string;
	memos: Record<string, MemoRecord>;
}

export type SelfWriteReason =
	| "create"
	| "edit"
	| "delete"
	| "archive"
	| "archive_delete"
	| "archive_move"
	| "index"
	| "time_buoy_index"
	| "scan"
	| "repair";

export interface SelfWriteMarker {
	opId: string;
	path: string;
	reason: SelfWriteReason;
	writtenAt: number;
	expiresAt: number;
	expectedHash: string | null;
	targetPath?: string;
}

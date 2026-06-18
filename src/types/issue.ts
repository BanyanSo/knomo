import type { KnomoErrorCode } from "./serviceError";

export type MemoIssueType =
	| "daily_block_missing"
	| "daily_block_ambiguous"
	| "monthly_sync_failed"
	| "monthly_block_missing"
	| "index_parse_failed"
	| "delete_failed"
	| "file_path_invalid"
	| "index_write_failed";

export type MemoIssueContextValue = string | number | boolean | null;

export interface MemoIssue {
	type: MemoIssueType;
	code?: KnomoErrorCode;
	detectedAt: string;
	message: string;
	context?: Record<string, MemoIssueContextValue>;
}

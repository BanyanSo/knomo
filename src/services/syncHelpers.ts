import type { MemoRecord } from "../types/memo";
import type { KnomoSettings } from "../types/settings";
import { KnomoError } from "../types/serviceError";
import { formatMemoIdPrefix, formatMonthPeriod } from "../utils/date";
import { hashText } from "../utils/hash";
import { getIndexFilePath } from "../utils/path";
import { MonthlyArchiveMissingError } from "./MonthlyArchiveService";
import type { SelfWriteTracker } from "./SelfWriteTracker";

export type SelfWriteReason = "create" | "edit" | "delete" | "archive" | "repair";

export function createOperationId(date: Date): string {
	return `op-${formatMemoIdPrefix(date)}-${Math.floor(Math.random() * 10000)
		.toString()
		.padStart(4, "0")}`;
}

export function createMemoId(date: Date): string {
	return `${formatMemoIdPrefix(date)}${Math.floor(Math.random() * 100)
		.toString()
		.padStart(2, "0")}`;
}

export function normalizeMemoInput(input: string): string {
	return input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function buildMonthlyIssue(error: unknown): MemoRecord["issue"] {
	const code = error instanceof KnomoError ? error.code : undefined;
	return {
		type: error instanceof MonthlyArchiveMissingError ? "monthly_block_missing" : "monthly_sync_failed",
		...(code === undefined ? {} : { code }),
		detectedAt: new Date().toISOString(),
		message: error instanceof Error ? error.message : "Monthly archive sync failed.",
		...(error instanceof KnomoError && Object.keys(error.params).length > 0 ? { context: error.params } : {}),
	};
}

export function buildIndexWriteFailedError(action: string, error: unknown, dailyPath: string, monthlyPath: string): Error {
	const monthlyText = monthlyPath.trim().length > 0 ? monthlyPath : "Monthly archive incomplete";
	return new KnomoError("index_write_failed", {
		action,
		dailyPath,
		monthlyPath: monthlyText,
		monthlyIncomplete: monthlyPath.trim().length === 0,
	}, error);
}

export function hasValidMonthlyRef(memo: MemoRecord): boolean {
	return memo.monthlyRef.path.trim().length > 0;
}

export function markSelfWrite(
	selfWriteTracker: SelfWriteTracker,
	opId: string,
	path: string,
	reason: SelfWriteReason,
	content: string,
): void {
	const writtenAt = Date.now();
	selfWriteTracker.mark(path, {
		opId,
		path,
		reason,
		writtenAt,
		expiresAt: writtenAt + 10000,
		expectedHash: hashText(content),
	});
}

export function markIndexSelfWrite(
	selfWriteTracker: SelfWriteTracker,
	opId: string,
	settings: KnomoSettings,
	date: Date,
): void {
	const path = getIndexFilePath(settings.monthlyMemoFolder, formatMonthPeriod(date));
	const writtenAt = Date.now();
	selfWriteTracker.mark(path, {
		opId,
		path,
		reason: "index",
		writtenAt,
		expiresAt: writtenAt + 10000,
		expectedHash: null,
	});
}

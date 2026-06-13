import type { DailyRef, MemoSource, MonthlyRef } from "./memo";
import type { KnomoSettings } from "./settings";

export interface PreparedDailyMemoWrite {
	path: string;
	beforeHash: string;
	afterHash: string;
	blockOccurrencesBefore: number;
	ref: DailyRef;
}

export interface PreparedMonthlyMemoWrite {
	path: string;
	beforeHash: string;
	afterHash: string;
	blockOccurrencesBefore: number;
	ref: MonthlyRef;
}

export interface PendingMemoCreate {
	memoId: string;
	opId: string;
	createdAt: string;
	content: string;
	block: string;
	dailyTrailer: string | null;
	source: MemoSource;
	sourceMemoId: string | null;
	sourceReferenceText: string | null;
	settings: KnomoSettings;
	dailyWrite: PreparedDailyMemoWrite;
	monthlyWrite: PreparedMonthlyMemoWrite | null;
}

export interface PendingMemoCreateJournal {
	schemaVersion: 1;
	operations: Record<string, PendingMemoCreate>;
}

export class PendingMemoWriteConflictError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PendingMemoWriteConflictError";
	}
}

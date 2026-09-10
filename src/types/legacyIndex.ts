export type LegacyArtifactKind =
	| "memo_index"
	| "pending_create"
	| "memo_summary"
	| "time_buoy_index"
	| "time_buoy_state"
	| "backup"
	| "repair_candidate";

export interface LegacyDeletedMemoPayload {
	deletedAt: string;
	sourcePath: string;
	logicalDate: string;
	section: string | null;
	rawBlock: string;
}

export interface LegacyIndexMemo {
	memoId: string;
	status: "active" | "deleted" | "error";
	deletedPayload: LegacyDeletedMemoPayload | null;
}

export interface LegacyIndexDiagnostic {
	code: string;
	sourcePath: string | null;
	memoId: string | null;
	detail: string;
}

export interface LegacyIndexSnapshot {
	sourceId: string;
	sourceRevision: string;
	legacySystemRoot: string;
	legacySystemRootPresent: boolean;
	memos: LegacyIndexMemo[];
	diagnostics: LegacyIndexDiagnostic[];
}

export type LegacyIndexSourceResult =
	| { kind: "missing" }
	| { kind: "ready"; snapshot: LegacyIndexSnapshot }
	| { kind: "attention"; diagnostics: LegacyIndexDiagnostic[] };

export type LegacyIndexSourcePresence =
	| { kind: "missing" }
	| { kind: "present"; legacySystemRoot: string; sourceId: string };

export interface LegacyIndexLoadRuntime {
	cancellationSignal?: AbortSignal;
	yieldControl?: () => Promise<void>;
	sliceBudgetMs?: number;
	now?: () => number;
}

export interface LegacyIndexSource {
	inspect(): LegacyIndexSourcePresence;
	load(runtime?: LegacyIndexLoadRuntime): Promise<LegacyIndexSourceResult>;
}

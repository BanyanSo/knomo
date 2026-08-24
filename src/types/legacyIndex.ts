export type LegacyArtifactKind =
	| "memo_index"
	| "pending_create"
	| "plugin_data"
	| "time_buoy_index"
	| "time_buoy_state"
	| "repair_candidate";

export interface LegacyIndexEvidence {
	sourcePath: string;
	logicalDate: string;
	section: string | null;
	time: string;
	contentHash: string;
	lastKnownBlockHash: string;
	lineNumberHint: number | null;
}

export interface LegacyDeletedMemoPayload {
	deletedAt: string;
	sourcePath: string;
	logicalDate: string;
	section: string | null;
	rawBlock: string;
	contentHash: string;
	sourceMemoId: string | null;
}

export interface LegacyIndexMemo {
	memoId: string;
	status: "active" | "deleted" | "error";
	createdAt: string;
	updatedAt: string;
	evidence: LegacyIndexEvidence;
	sourceMemoId: string | null;
	deletedPayload: LegacyDeletedMemoPayload | null;
}

export interface LegacyPendingMemo {
	memoId: string;
	createdAt: string;
	evidence: LegacyIndexEvidence;
	sourceMemoId: string | null;
}

export interface LegacyReviewState {
	memoId: string;
	reviewCount: number;
	lastReviewedAt: string | null;
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
	memos: LegacyIndexMemo[];
	pendingMemos: LegacyPendingMemo[];
	reviews: LegacyReviewState[];
	diagnostics: LegacyIndexDiagnostic[];
}

export type LegacyIndexSourceResult =
	| { kind: "missing" }
	| { kind: "ready"; snapshot: LegacyIndexSnapshot }
	| { kind: "attention"; diagnostics: LegacyIndexDiagnostic[] };

export interface LegacyIndexSource {
	load(): Promise<LegacyIndexSourceResult>;
	isSourcePath(path: string): boolean;
}

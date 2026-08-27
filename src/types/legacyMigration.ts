export type LegacyIdentityImportStatus = "idle" | "not_applicable" | "ready" | "partial" | "attention" | "unavailable";

export interface LegacyIdentityImportDiagnostic {
	code: string;
	sourcePath: string | null;
	memoId: string | null;
	detail: string;
}

export interface LegacyMigrationCleanupCandidate {
	legacySystemRoot: string;
	sourceRevision: string;
}

export interface LegacyIdentityImportReport {
	status: LegacyIdentityImportStatus;
	sourceRevision: string | null;
	importedEventCount: number;
	importedMemoIds: string[];
	skippedMemoIds: string[];
	diagnostics: LegacyIdentityImportDiagnostic[];
	cleanupCandidate: LegacyMigrationCleanupCandidate | null;
}

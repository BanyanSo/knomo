export type LegacyMigrationStatus = "idle" | "not_applicable" | "ready" | "attention" | "unavailable";

export interface LegacyMigrationDiagnostic {
	code: string;
	sourcePath: string | null;
	memoId: string | null;
	detail: string;
}

export interface LegacyMigrationCleanupCandidate {
	legacySystemRoot: string;
	sourceRevision: string;
}

export interface LegacyMigrationReport {
	status: LegacyMigrationStatus;
	sourceRevision: string | null;
	diagnostics: LegacyMigrationDiagnostic[];
	cleanupCandidate: LegacyMigrationCleanupCandidate | null;
}

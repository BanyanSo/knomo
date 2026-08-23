import type { CatalogV2MaterializedState, DeletedMemoPayload, StateOperation } from "./catalogV2";

export type LegacyIdentityImportStatus = "idle" | "missing" | "ready" | "partial" | "attention" | "unavailable";

export interface LegacyIdentityImportDiagnostic {
	code: string;
	sourcePath: string | null;
	memoId: string | null;
	detail: string;
}

export interface VerifiedLegacyIdentitySnapshot {
	sourceKind: "catalog_v2" | "legacy";
	sourceId: string;
	sourceRevision: string;
	state: CatalogV2MaterializedState;
	operations: StateOperation[];
	deletedPayloads: Record<string, DeletedMemoPayload>;
	diagnostics: LegacyIdentityImportDiagnostic[];
}

export type LegacyIdentitySourceResult =
	| { kind: "missing" }
	| { kind: "ready"; snapshot: VerifiedLegacyIdentitySnapshot }
	| { kind: "attention"; diagnostics: LegacyIdentityImportDiagnostic[] };

export interface LegacyIdentityImportReport {
	status: LegacyIdentityImportStatus;
	sourceRevision: string | null;
	importedEventCount: number;
	importedMemoIds: string[];
	skippedMemoIds: string[];
	diagnostics: LegacyIdentityImportDiagnostic[];
}

export interface LegacyIdentitySource {
	load(): Promise<LegacyIdentitySourceResult>;
	isSourcePath(path: string): boolean;
}

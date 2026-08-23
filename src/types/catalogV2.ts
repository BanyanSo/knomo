export type CatalogV2IdPrefix = "m" | "w" | "o" | "v";

export interface ArtifactRef {
	path: string;
	sha256: string;
	byteLength: number;
}

export type CatalogV2LegacyV2ArtifactKind =
	| "state_segment"
	| "state_snapshot"
	| "state_checkpoint"
	| "deleted_payload"
	| "upgrade_package"
	| "upgrade_checkpoint"
	| "upgrade_issue";

export interface CatalogV2LegacyV2Receipt {
	sourcePath: string;
	sourceSha256: string;
	sourceByteLength: number;
	target: ArtifactRef;
	artifactKind: CatalogV2LegacyV2ArtifactKind;
}

export interface CatalogV2LayoutMigrationReport {
	legacyInventorySignature: string;
	receipts: CatalogV2LegacyV2Receipt[];
	markdownBytesSignature: string;
}

export interface IdentityEvidence {
	sourcePath: string;
	sourceRevision: string;
	logicalDate: string;
	section: string | null;
	startLine: number;
	endLine: number;
	time: string;
	contentHash: string;
	existingBlockId: string | null;
}

interface StateOperationBase {
	schemaVersion: 1;
	writerId: string;
	sequence: number;
	opId: string;
	memoId: string;
	occurredAt: string;
}

export type StateOperation =
	| StateOperationBase & {
		type: "identity.claim";
		baseEvidence: null;
		payload: {
			evidence: IdentityEvidence;
			origin: "plugin_create" | "explicit_copy" | "manual_adoption";
			createIntentOpId: string | null;
			control?: import("./catalogV2Protocol").CatalogV2ControlPermit | null;
		};
	}
	| StateOperationBase & {
		type: "identity.rebind";
		baseEvidence: IdentityEvidence;
		payload: {
			baseBindingId: string;
			evidence: IdentityEvidence;
			reason: "edit" | "rename" | "move" | "restore" | "manual_resolution";
			control?: import("./catalogV2Protocol").CatalogV2ControlPermit | null;
		};
	}
	| StateOperationBase & {
		type: "identity.redirect";
		baseEvidence: null;
		payload: {
			toMemoId: string;
			reason: "duplicate_resolution" | "manual_resolution";
		};
	}
	| StateOperationBase & {
		type: "lifecycle.create_intent";
		baseEvidence: null;
		payload: {
			evidence: IdentityEvidence;
			targetPath: string;
			logicalDate: string;
			time: string;
			contentHash: string;
			sourceMemoId: string | null;
		};
	}
	| StateOperationBase & {
		type: "lifecycle.create_abandon";
		baseEvidence: null;
		payload: {
			createIntentOpId: string;
			reason: "daily_write_failed" | "intent_commit_failed" | "user_cancelled";
		};
	}
	| StateOperationBase & {
		type: "lifecycle.delete";
		baseEvidence: IdentityEvidence;
		payload: {
			baseBindingId: string;
			deleteOpId: string;
			deletedPayload: ArtifactRef;
		};
	}
	| StateOperationBase & {
		type: "lifecycle.restore";
		baseEvidence: null;
		payload: {
			baseBindingId: string | null;
			deleteOpId: string;
			evidence: IdentityEvidence;
		};
	}
	| StateOperationBase & {
		type: "lifecycle.purge";
		baseEvidence: null;
		payload: {
			deleteOpId: string;
		};
	}
	| StateOperationBase & {
		type: "relation.set_source";
		baseEvidence: null;
		payload: {
			sourceMemoId: string | null;
			supersedesRelationIds: string[];
		};
	}
	| StateOperationBase & {
		type: "review.record";
		baseEvidence: null;
		payload: {
			reviewedAt: string;
		};
	};

export interface StateOperationEnvelope {
	operation: StateOperation;
	digest: string;
	sourcePath: string;
}

export interface ParsedStateSegment {
	path: string;
	sha256: string;
	byteLength: number;
	writerId: string;
	firstSequence: number;
	lastSequence: number;
	operations: StateOperationEnvelope[];
}

export interface StateSnapshotOperationDigest {
	opId: string;
	sha256: string;
}

export interface StateSnapshot {
	kind: "knomo.catalog-v2.state-snapshot";
	schemaVersion: 1;
	sourceWriterId: string;
	firstSequence: number;
	lastSequence: number;
	coveredSegments: ArtifactRef[];
	operationDigests: StateSnapshotOperationDigest[];
	operations: StateOperation[];
}

export interface StateCompactionCommit {
	kind: "knomo.catalog-v2.compaction-commit";
	schemaVersion: 1;
	sourceWriterId: string;
	firstSequence: number;
	lastSequence: number;
	snapshot: ArtifactRef;
	coveredSegments: ArtifactRef[];
	committingWriterId: string;
	committedAt: string;
}

export interface DeletedMemoPayload {
	kind: "knomo.catalog-v2.deleted-payload";
	schemaVersion: 1;
	memoId: string;
	deleteOpId: string;
	deletedAt: string;
	sourcePath: string;
	logicalDate: string;
	section: string | null;
	rawBlock: string;
	contentHash: string;
	sourceMemoId: string | null;
}

export type LegacyArtifactKind =
	| "memo_index"
	| "pending_create"
	| "plugin_data"
	| "time_buoy_index"
	| "time_buoy_state"
	| "repair_candidate";

export interface LegacyArtifactInput {
	artifactKind: LegacyArtifactKind;
	path: string;
	bytes: Uint8Array;
	mtime: number;
}

export interface LegacyArtifactReceipt {
	path: string;
	artifactKind: LegacyArtifactKind;
	byteLength: number;
	mtime: number;
	sha256: string;
	legacySchemaVersion: number | null;
	readableRecordCount: number;
	disposition: "pending" | "imported" | "quarantined" | "retired";
	requiredArtifact: ArtifactRef | null;
	errorCode: string | null;
}

export interface LegacyEvidence {
	sourcePath: string;
	logicalDate: string;
	section: string | null;
	time: string;
	contentHash: string;
	lastKnownBlockHash: string;
	existingBlockId: string | null;
	lineNumberHint: number | null;
}

export interface MigrationIdentityClaim {
	memoId: string;
	legacyStatus: "active" | "error";
	legacyRecordDigest: string;
	evidence: LegacyEvidence;
}

export interface MigrationDeletedRecord {
	memoId: string;
	deleteOpId: string;
	deletedAt: string | null;
	deleteSource: string | null;
	legacyRecordDigest: string;
	payload: ArtifactRef;
}

export interface MigrationRelation {
	memoId: string;
	sourceMemoId: string;
	legacyRecordDigest: string;
}

export interface MigrationReview {
	memoId: string;
	reviewCount: number;
	lastReviewedAt: string | null;
	legacyRecordDigest: string;
}

export interface MigrationPendingCreate {
	memoId: string;
	legacyOpId: string;
	createdAt: string;
	rawBlock: string;
	contentHash: string;
	dailyPath: string;
	dailyBeforeHash: string;
	dailyAfterHash: string;
	source: "plugin_input" | "daily_scan" | "quote_create";
	sourceMemoId: string | null;
	legacyRecordDigest: string;
}

export interface MigrationDiagnostic {
	entryKey: string;
	severity: "info" | "attention";
	code: string;
	memoId: string | null;
	fieldNames: string[];
}

export interface MigrationDomainCounts {
	identityClaims: number;
	deletedRecords: number;
	relations: number;
	reviewOrdinals: number;
	pendingCreates: number;
	diagnostics: number;
}

export interface MigrationPackage {
	kind: "knomo.catalog-v2.migration-package";
	schemaVersion: 1;
	importerVersion: 1;
	source: {
		artifactDigest: string;
		artifactKind: LegacyArtifactKind;
		byteLength: number;
		legacySchemaVersion: number | null;
		period: string | null;
		recordCount: number;
	};
	identityClaims: MigrationIdentityClaim[];
	deletedRecords: MigrationDeletedRecord[];
	relations: MigrationRelation[];
	reviews: MigrationReview[];
	pendingCreates: MigrationPendingCreate[];
	diagnostics: MigrationDiagnostic[];
	counts: MigrationDomainCounts;
}

export interface QuarantineReceipt {
	kind: "knomo.catalog-v2.quarantine-receipt";
	schemaVersion: 1;
	artifactDigest: string;
	artifactKind: LegacyArtifactKind;
	byteLength: number;
	errorCode: string;
	recoverableRecordCount: number;
	preservedRecordDigests: string[];
}

export interface MigrationPayloadPreview {
	payload: DeletedMemoPayload;
	bytes: Uint8Array;
	sha256: string;
	path: string;
}

export type LegacyImportResult =
	| {
		kind: "imported";
		receipt: LegacyArtifactReceipt;
		package: MigrationPackage;
		packageBytes: Uint8Array;
		packageSha256: string;
		packagePath: string;
		deletedPayloads: MigrationPayloadPreview[];
	}
	| {
		kind: "quarantined";
		receipt: QuarantineReceipt;
		receiptBytes: Uint8Array;
		receiptSha256: string;
		path: string;
		inventory: LegacyArtifactReceipt;
	};

export interface CatalogV2StateAttention {
	code:
		| "op_id_collision"
		| "writer_sequence_fork"
		| "relation_conflict"
		| "redirect_conflict"
		| "identity_ambiguous"
		| "lifecycle_conflict"
		| "restore_conflict"
		| "restore_missing_delete"
		| "identity_ownership_conflict"
		| "mutation_conflict";
	key: string;
	digests: string[];
}

export interface CatalogV2MaterializedIdentityBinding {
	entryId: string;
	source: "state" | "migration";
	evidence: IdentityEvidence | LegacyEvidence;
	baseBindingId: string | null;
	baseEvidence?: IdentityEvidence | null;
}

export interface CatalogV2MaterializedCreateIntent {
	entryId: string;
	evidence: IdentityEvidence;
	sourceMemoId: string | null;
}

export interface CatalogV2MaterializedDeleteVersion {
	deleteOpId: string;
	entryId: string;
	payload: ArtifactRef;
	baseEvidence: IdentityEvidence | null;
	baseBindingId: string | null;
}

export interface CatalogV2MaterializedRestoreVersion {
	entryId: string;
	deleteOpId: string;
	evidence: IdentityEvidence;
	baseBindingId: string | null;
}

export interface CatalogV2MaterializedRelationEntry {
	relationId: string;
	sourceMemoId: string | null;
}

export interface CatalogV2MaterializedMemo {
	memoId: string;
	identityOperationIds: string[];
	activeBindingHeads: CatalogV2MaterializedIdentityBinding[];
	identityBindings: CatalogV2MaterializedIdentityBinding[];
	deleteOperationIds: string[];
	deleteVersions: CatalogV2MaterializedDeleteVersion[];
	restoreVersions: CatalogV2MaterializedRestoreVersion[];
	restoredDeleteOperationIds: string[];
	purgedDeleteOperationIds: string[];
	relationEntries: CatalogV2MaterializedRelationEntry[];
	supersededRelationIds: string[];
	sourceMemoIds: string[];
	reviewOperationIds: string[];
	reviewCount: number;
	lastReviewedAt: string | null;
	pendingCreateIds: string[];
	pendingCreateIntents: CatalogV2MaterializedCreateIntent[];
}

export interface CatalogV2MaterializedState {
	schemaVersion: 1;
	memos: Record<string, CatalogV2MaterializedMemo>;
	fileRevisionTransitions?: import("./catalogV2Protocol").CatalogV2FileRevisionTransition[];
	quarantine: CatalogV2StateAttention[];
	awaitingWriterIds: string[];
	forkedWriterIds: string[];
	processedOperationCount: number;
}

export interface StateSegmentCheckpoint {
	path: string;
	sha256: string;
	byteLength: number;
	mtime?: number;
	consumedSequence: number;
}

export interface CatalogV2ShadowPreview {
	schemaVersion: 1;
	generatedAt: number;
	catalogDataRoot: string;
	legacyReceipts: LegacyArtifactReceipt[];
	packages: Array<{ path: string; sha256: string; byteLength: number }>;
	quarantines: Array<{ path: string; sha256: string; byteLength: number }>;
	deletedPayloads: Array<{ path: string; sha256: string; byteLength: number }>;
	stateSegmentCount: number;
	materializedMemoCount: number;
	stateErrors: Array<{ path: string; errorCode: "invalid_state_segment" }>;
}

export type MigrationRequiredArtifactKind = "migration_package" | "quarantine_receipt" | "deleted_payload";

export interface MigrationCommitLegacySource {
	artifactDigest: string;
	artifactKind: LegacyArtifactKind;
	disposition: "imported" | "quarantined";
	receipt: ArtifactRef;
}

export interface MigrationCommitRequiredArtifact extends ArtifactRef {
	artifactKind: MigrationRequiredArtifactKind;
}

export interface MigrationCommitDomainCounts extends MigrationDomainCounts {
	quarantinedArtifacts: number;
}

export interface MigrationCommitVerification {
	structure: {
		requiredArtifactsVerified: true;
		existingMemoIdsPreserved: true;
		domainCountsVerified: true;
		deletedPayloadsVerified: true;
		dailyHashesUnchanged: true;
	};
	runtime: {
		v2ColdStartPassed: true;
		outboxDrained: true;
		legacyReadsDisabled: true;
		legacyWriterRemoved: true;
	};
	catalog: {
		coverage: "complete";
		observationCount: number;
		identifiedCount: number;
		observedCount: number;
		ambiguousCount: number;
		failedPaths: string[];
	};
}

export interface MigrationCommit {
	kind: "knomo.catalog-v2.migration-commit";
	schemaVersion: 1;
	importerVersion: 1;
	generationDigest: string;
	writerId: string;
	committedAt: string;
	legacySources: MigrationCommitLegacySource[];
	requiredArtifacts: MigrationCommitRequiredArtifact[];
	domainCounts: MigrationCommitDomainCounts;
	verification: MigrationCommitVerification;
}

export type CatalogV2UpgradePhase =
	| "legacy_detected"
	| "importing"
	| "v2_ready"
	| "verifying"
	| "committed"
	| "settlement"
	| "legacy_retired";

export type CatalogV2InstallMode =
	| "uninitialized"
	| "nonempty_unconfigured"
	| "joining"
	| "attention"
	| "existing_v2"
	| "legacy_upgrade";

export type CatalogV2LegacyCleanupClass =
	| "legacy_memo_index"
	| "legacy_time_buoy"
	| "legacy_pending_create"
	| "legacy_v2_artifact"
	| "legacy_empty_directory"
	| "legacy_empty_system_root";

export interface CatalogV2LegacyRetiredReceipt {
	path: string;
	sha256: string | null;
	cleanupClass: CatalogV2LegacyCleanupClass;
	retiredAt: string;
}

export type CatalogV2IdentityReadinessReason =
	| "collecting"
	| "awaiting_data"
	| "artifact_attention"
	| "cold_start_pending"
	| "quiet_window"
	| "state_mismatch";

export type CatalogV2IdentityAdoptionReadiness =
	| {
		kind: "blocked";
		epoch: number;
		reason: CatalogV2IdentityReadinessReason;
	}
	| {
		kind: "ready";
		epoch: number;
		generationDigest: string | null;
		inventorySignature: string;
		stateRevision: string;
		verifiedSessionId: string;
		settledAt: number;
	};

export interface CatalogV2UpgradeStatus {
	schemaVersion: 1;
	installMode: CatalogV2InstallMode;
	phase: CatalogV2UpgradePhase;
	selectedGenerationDigest: string | null;
	pendingStartupGenerationDigest: string | null;
	pendingStartupSessionId: string | null;
	verifiedStartupGenerationDigest: string | null;
	pendingNoLegacyStartupSessionId: string | null;
	verifiedNoLegacyStartupSessionId: string | null;
	pendingLayoutStartupSignature: string | null;
	pendingLayoutStartupSessionId: string | null;
	verifiedLayoutStartupSignature: string | null;
	legacyInventorySignature: string;
	legacyChangedAt: number;
	legacyReceipts: LegacyArtifactReceipt[];
	legacyV2Receipts: CatalogV2LegacyV2Receipt[];
	retiredReceipts: CatalogV2LegacyRetiredReceipt[];
	attention: string[];
	identityAdoptionReadiness: CatalogV2IdentityAdoptionReadiness;
}

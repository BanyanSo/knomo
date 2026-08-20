import type { ArtifactRef, IdentityEvidence, StateOperation } from "./catalogV2";

export type CatalogV2VaultMode = "uninitialized" | "joining" | "legacy_upgrade" | "ready" | "attention";

export interface CatalogV2VaultBootstrap {
	kind: "knomo.catalog-v2.vault-bootstrap";
	schemaVersion: 2;
	protocolVersion: 2;
	initializationMode: "native" | "legacy_upgrade";
	vaultInstanceId: string;
	catalogDataRoot: string;
	contract: ArtifactRef;
	controlGenesis: ArtifactRef;
	initialWriterId: string;
	createdAt: string;
}

export type CatalogV2ControlActionKind =
	| "genesis"
	| "identity_adoption"
	| "identity_repair"
	| "migration_finalize"
	| "contract_change"
	| "authority_transfer";

export interface CatalogV2WriterFrontier {
	writerId: string;
	registration: ArtifactRef;
	head: ArtifactRef | null;
	lastSequence: number;
	affectedMemoIds: string[];
}

export interface CatalogV2ControlAction {
	actionId: string;
	kind: CatalogV2ControlActionKind;
	inputDigest: string | null;
	memoIds: string[];
	authorityRequest: ArtifactRef | null;
	nextAuthorityWriterId: string | null;
	nextContract: ArtifactRef | null;
}

export interface CatalogV2ControlGeneration {
	kind: "knomo.catalog-v2.control-generation";
	schemaVersion: 2;
	vaultInstanceId: string;
	controlSequence: number;
	authorityEpoch: number;
	parent: ArtifactRef | null;
	authorityWriterId: string;
	contract: ArtifactRef;
	stateGeneration: ArtifactRef | null;
	writerFrontier: CatalogV2WriterFrontier[];
	consumedAuthorityRequestIds: string[];
	action: CatalogV2ControlAction;
	createdByWriterId: string;
	createdAt: string;
}

export interface CatalogV2AuthorityTransferRequest {
	kind: "knomo.catalog-v2.authority-transfer-request";
	schemaVersion: 2;
	vaultInstanceId: string;
	requestId: string;
	targetWriterId: string;
	registration: ArtifactRef;
	requestedAt: string;
}

export interface CatalogV2VerifiedControlGeneration {
	generation: CatalogV2ControlGeneration;
	generationRef: ArtifactRef;
}

export type CatalogV2ControlGenerationVerification =
	| { kind: "verified"; value: CatalogV2VerifiedControlGeneration }
	| { kind: "awaiting_data"; generationRef: ArtifactRef; missingPaths: string[] }
	| { kind: "invalid"; generationRef: ArtifactRef; reason: string };

export type CatalogV2ControlGenerationSelection =
	| { kind: "verified"; value: CatalogV2VerifiedControlGeneration }
	| { kind: "awaiting_data"; missingPaths: string[] }
	| { kind: "forked"; generationRefs: ArtifactRef[] }
	| { kind: "invalid"; reasons: string[] };

export interface CatalogV2ControlPermit {
	kind: "catalog-v2-control-permit";
	vaultInstanceId: string;
	controlGeneration: ArtifactRef;
	controlSequence: number;
	authorityEpoch: number;
	authorityWriterId: string;
	actionId: string;
	actionKind: Exclude<CatalogV2ControlActionKind, "genesis">;
	inputDigest: string;
	authorizedAt: string;
	stateGenerationId: string;
	contractDigest: string;
}

export interface CatalogV2VaultContract {
	kind: "knomo.catalog-v2.vault-contract";
	schemaVersion: 2;
	parserVersion: number;
	daily: {
		folder: string | null;
		dateFormat: string;
		headings: string[];
		allowRootMemos: true;
	};
	monthly: {
		folder: string;
		fileFormat: string;
		dateHeadingFormat: string;
		dateOrder: "asc" | "desc";
		rendererVersion: number;
		newline: "lf";
	};
}

export interface CatalogV2WriterRegistration {
	kind: "knomo.catalog-v2.writer-registration";
	schemaVersion: 2;
	vaultInstanceId: string;
	writerId: string;
	createdAt: string;
}

export interface CatalogV2ImmutableStateSegment {
	kind: "knomo.catalog-v2.state-segment";
	schemaVersion: 2;
	vaultInstanceId: string;
	writerId: string;
	firstSequence: number;
	lastSequence: number;
	previousHeadSha256: string | null;
	operations: StateOperation[];
}

export interface CatalogV2WriterHead {
	kind: "knomo.catalog-v2.writer-head";
	schemaVersion: 2;
	vaultInstanceId: string;
	writerId: string;
	firstSequence: number;
	lastSequence: number;
	previousHead: ArtifactRef | null;
	segment: ArtifactRef;
	affectedMemoIds: string[];
	committedAt: string;
}

export interface CatalogV2GenerationWriter {
	writerId: string;
	registration: ArtifactRef;
	head: ArtifactRef | null;
	affectedMemoIds: string[];
}

export interface CatalogV2StateGeneration {
	kind: "knomo.catalog-v2.state-generation";
	schemaVersion: 2;
	vaultInstanceId: string;
	contract: ArtifactRef;
	controlGeneration: ArtifactRef;
	parents: ArtifactRef[];
	writers: CatalogV2GenerationWriter[];
	mutationCommits?: ArtifactRef[];
	mutationMemoIds?: string[];
	migrationCommit: ArtifactRef | null;
	migrationGenerationDigest: string | null;
	migrationMemoIds: string[];
	retiredWriterIds: string[];
	createdByWriterId: string;
	createdAt: string;
}

export interface CatalogV2VerifiedVaultContext {
	bootstrap: CatalogV2VaultBootstrap;
	bootstrapSha256: string;
	contract: CatalogV2VaultContract;
	contractRef: ArtifactRef;
	contractSha256: string;
	control: CatalogV2VerifiedControlGeneration;
}

export interface CatalogV2VerifiedStateGeneration {
	generation: CatalogV2StateGeneration;
	generationRef: ArtifactRef;
	operations: StateOperation[];
	writerHeads: Record<string, CatalogV2WriterHead | null>;
	mutationPrepares?: Record<string, CatalogV2MutationPrepareArtifact>;
}

export type CatalogV2GenerationVerification =
	| { kind: "verified"; value: CatalogV2VerifiedStateGeneration }
	| { kind: "fenced"; generationRef: ArtifactRef }
	| {
		kind: "awaiting_data";
		generationRef: ArtifactRef;
		missingPaths: string[];
		affectedMemoIds: string[] | null;
		affectedWriterIds: string[] | null;
	}
	| { kind: "invalid"; generationRef: ArtifactRef; reason: string };

export type CatalogV2GenerationSelection =
	| { kind: "verified"; value: CatalogV2VerifiedStateGeneration }
	| { kind: "empty" }
	| {
		kind: "awaiting_data";
		missingPaths: string[];
		affectedMemoIds: string[] | null;
		affectedWriterIds: string[] | null;
		verifiedBase: CatalogV2VerifiedStateGeneration | null;
	}
	| { kind: "forked"; generationRefs: ArtifactRef[] }
	| { kind: "invalid"; reasons: string[] };

export interface CatalogV2AdoptionPermit {
	kind: "catalog-v2-adoption-permit";
	vaultInstanceId: string;
	memoId: string;
	generationId: string;
	contractDigest: string;
	sourceRevision: string;
	observationDigest: string;
	control?: CatalogV2ControlPermit;
}

export type CatalogV2SharedMutationKind = "create" | "edit" | "task" | "delete" | "restore" | "move" | "copy" | "adoption" | "manual_repair";

export interface CatalogV2FileRevisionTransition {
	sourcePath: string;
	logicalDate: string;
	headings: string[];
	beforeRevision: string;
	afterRevision: string;
	beforeEvidence: IdentityEvidence | null;
	afterEvidence: IdentityEvidence | null;
	baseBindingId: string | null;
	baseEvidence: IdentityEvidence | null;
	preservedEvidence: Array<{
		before: IdentityEvidence;
		after: IdentityEvidence;
	}>;
}

export type CatalogV2MutationReplay =
	| { kind: "insert"; rawBlock: string; section: string | null }
	| { kind: "replace"; beforeRawBlock: string; afterRawBlock: string }
	| { kind: "remove"; beforeRawBlock: string };

export interface CatalogV2MutationFileChange {
	transition: CatalogV2FileRevisionTransition;
	replay: CatalogV2MutationReplay;
}

export interface CatalogV2MutationPrepareArtifact {
	kind: "knomo.catalog-v2.mutation-prepare";
	schemaVersion: 2;
	vaultInstanceId: string;
	mutationId: string;
	mutationKind: CatalogV2SharedMutationKind;
	memoId: string;
	changes: CatalogV2MutationFileChange[];
	effectDrafts: import("./catalogV2Runtime").StateOperationDraft[];
	preparedByWriterId: string;
	preparedAt: string;
}

export interface CatalogV2MutationCommitArtifact {
	kind: "knomo.catalog-v2.mutation-commit";
	schemaVersion: 2;
	vaultInstanceId: string;
	mutationId: string;
	prepare: ArtifactRef;
	control: CatalogV2ControlPermit | null;
}

export interface CatalogV2MutationAbandonArtifact {
	kind: "knomo.catalog-v2.mutation-abandon";
	schemaVersion: 2;
	vaultInstanceId: string;
	mutationId: string;
	prepare: ArtifactRef;
	reason: "daily_write_failed" | "stale_revision" | "user_cancelled";
}

export interface CatalogV2SharedMutationRecord {
	mutationId: string;
	prepare: CatalogV2MutationPrepareArtifact;
	prepareRef: ArtifactRef;
	commit: CatalogV2MutationCommitArtifact | null;
	commitRef: ArtifactRef | null;
	abandon: CatalogV2MutationAbandonArtifact | null;
	abandonRef: ArtifactRef | null;
}

export type CatalogV2SharedMutationInspectionIssueKind =
	| "digest_mismatch"
	| "invalid_artifact"
	| "artifact_mutation_mismatch"
	| "duplicate_artifact"
	| "prepare_reference_mismatch"
	| "commit_abandon_conflict";

export interface CatalogV2SharedMutationInspectionIssue {
	kind: CatalogV2SharedMutationInspectionIssueKind;
	mutationId: string;
	paths: string[];
	memoIds: string[];
	detail: string;
}

export interface CatalogV2SharedMutationInspection {
	records: CatalogV2SharedMutationRecord[];
	missingPrepareMutationIds: string[];
	missingCommitMutationIds: string[];
	issues: CatalogV2SharedMutationInspectionIssue[];
	affectedPaths: string[];
	affectedMemoIds: string[];
}

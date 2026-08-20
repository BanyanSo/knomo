import type { MemoImageRef, MemoLinkRef } from "./memo";
import type { IdentityEvidence } from "./catalogV2";

export type CatalogCoverageKind = "partial" | "complete" | "rebuilding";
export type CatalogStoreLifecycleState = "opening" | "ready" | "degraded" | "retrying" | "read-only" | "rebuilding";
export type CatalogPostingKind = "tag" | "search" | "link" | "image" | "task" | "timeBuoy" | "reference";

export interface MemoTaskRef {
	taskIndex: number;
	lineOffset: number;
	marker: string;
	text: string;
}

// Observation 只描述当前 Daily 字节，不承担身份职责。
export interface MemoObservation {
	sourcePath: string;
	sourceRevision: string;
	logicalDate: string;
	section: string | null;
	startLine: number;
	endLine: number;
	time: string;
	content: string;
	contentHash: string;
	existingBlockId: string | null;
	tags: string[];
	links: MemoLinkRef[];
	images: MemoImageRef[];
	tasks: MemoTaskRef[];
	timeBuoyDates: string[];
}

export type IdentityWriteMode = "ready" | "adopt_then_retry" | "blocked_settling" | "blocked_ambiguous" | "blocked_waiting_sync";

export interface MemoCapabilities {
	view: true;
	copy: true;
	openDaily: true;
	openLinks: true;
	openImages: true;
	copyAsNew: IdentityWriteMode;
	edit: IdentityWriteMode;
	toggleTask: IdentityWriteMode;
	delete: IdentityWriteMode;
	createReference: IdentityWriteMode;
	recordReview: IdentityWriteMode;
}

export interface IdentityCandidate {
	memoId: string;
	source: "local_intent" | "existing_block_id" | "state" | "migration" | "tuple" | "manual_successor" | "lifecycle_conflict";
	origin?: {
		sourcePath: string;
		logicalDate: string;
		time: string;
	};
}

export type ResolvedMemo =
	| {
		kind: "identified";
		memoId: string;
		activeBindingId: string;
		bindingEvidence: IdentityEvidence;
		observation: MemoObservation;
		capabilities: MemoCapabilities;
		stateRevision: string;
	}
	| {
		kind: "observed";
		observation: MemoObservation;
		adoption: "eligible" | "settling" | "historical_readonly";
		capabilities: MemoCapabilities;
		stateRevision: string;
	}
	| {
		kind: "ambiguous";
		observation: MemoObservation;
		candidates: IdentityCandidate[];
		reason?: "ambiguous" | "manual_successor" | "known_predecessor";
		capabilities: MemoCapabilities;
		stateRevision: string;
	};

export interface ResolvedMemoHandle {
	memoId: string;
	activeBindingId: string;
	evidence: IdentityEvidence;
	bindingEvidence: IdentityEvidence;
	stateRevision: string;
}

export interface CatalogObservation extends MemoObservation {
	observationKey: string;
	createdAtKey: string;
	searchText: string;
	searchTokens: string[];
	tagKeys: string[];
	linkTargets: string[];
	imagePaths: string[];
	explicitReferenceTargets: string[];
	hasLink: 0 | 1;
	hasImage: 0 | 1;
	hasTask: 0 | 1;
	hasTimeBuoy: 0 | 1;
}

export interface CatalogFileRecord {
	sourcePath: string;
	sourceRevision: string;
	logicalDate: string;
	mtime: number;
	size: number;
	parserVersion: number;
	settingsFingerprint: string;
	observationCount: number;
	auditedAt: number;
}

export interface CatalogFileAggregate {
	sourcePath: string;
	logicalDate: string;
	memoCount: number;
	tagCount: number;
	linkCount: number;
	imageCount: number;
	taskCount: number;
	timeBuoyCount: number;
	explicitReferenceCount: number;
	explicitReferenceTargets: string[];
}

export interface CatalogDailyAggregate {
	logicalDate: string;
	memoCount: number;
	tagCount: number;
	linkCount: number;
	imageCount: number;
	taskCount: number;
	timeBuoyCount: number;
	explicitReferenceCount: number;
	explicitReferenceTargets: string[];
}

export interface CatalogCoverage {
	kind: CatalogCoverageKind;
	coveredFromDate: string | null;
	pendingFileCount: number;
	coveredFileCount: number;
	totalFileCount: number;
}

export interface CatalogStoreLifecycle {
	state: CatalogStoreLifecycleState;
	persistent: boolean;
	writable: boolean;
	reason: string | null;
}

export interface CatalogCheckpoint {
	settingsFingerprint: string;
	parserVersion: number;
	pendingPaths: string[];
	fullAudit: boolean;
	completedFileCount: number;
	totalFileCount: number;
	startedAt: number;
	updatedAt: number;
}

export interface CatalogCursor {
	catalogRevision: number;
	createdAtKey: string;
	observationKey: string;
}

export interface CatalogQuery {
	text?: string;
	tags?: string[];
	linkTarget?: string;
	hasLink?: boolean;
	imagePath?: string;
	hasImage?: boolean;
	hasTask?: boolean;
	hasTag?: boolean;
	hasTimeBuoy?: boolean;
	timeBuoyDate?: string;
	explicitReferenceTarget?: string;
	fromDate?: string;
	toDate?: string;
	monthDay?: string;
	sourcePaths?: readonly string[];
	limit: number;
	cursor?: CatalogCursor | null;
}

export interface CatalogQueryMetrics {
	cursorReads: number;
	observationsRead: number;
	returned: number;
}

export interface CatalogQueryPage {
	items: CatalogObservation[];
	nextCursor: CatalogCursor | null;
	catalogRevision: number;
	coverage: CatalogCoverage;
	lifecycle: CatalogStoreLifecycle;
	metrics: CatalogQueryMetrics;
	invalidated: boolean;
}

export interface CatalogFilePartition {
	file: CatalogFileRecord;
	observations: CatalogObservation[];
	aggregate: CatalogFileAggregate;
}

// 同一 Catalog revision 中一个 Daily 文件的完整 observation 集合。
export interface CatalogFileRevisionBatch<TObservation extends MemoObservation = CatalogObservation> {
	file: CatalogFileRecord;
	observations: readonly TObservation[];
	catalogRevision: number;
}

export interface CatalogV2ResolutionSnapshot {
	catalogRevision: number;
	stateRevision: string;
	mutationInventoryDigest: string;
	results: Record<string, ResolvedMemo>;
}

export interface CatalogInventoryEntry {
	sourcePath: string;
	logicalDate: string;
	mtime: number;
	size: number;
}

export interface CatalogShadowMismatch {
	kind: "missing-in-catalog" | "catalog-only" | "content" | "aggregate-not-comparable";
	sourcePath: string;
	line: number | null;
	detail: string;
}

export interface CatalogShadowReport {
	comparedAt: number;
	coverage: CatalogCoverage;
	coveredSourcePaths: string[];
	stableCount: number;
	catalogCount: number;
	referenceAggregateComparable: false;
	mismatches: CatalogShadowMismatch[];
}

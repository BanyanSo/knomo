import type { MemoImageRef, MemoLinkRef } from "./memo";

export type CatalogCoverageKind = "partial" | "complete" | "rebuilding";
export type CatalogStoreLifecycleState = "opening" | "ready" | "degraded" | "retrying" | "read-only" | "rebuilding";
export type CatalogPostingKind = "tag" | "search" | "link" | "image" | "task" | "timeBuoy" | "reference";

export interface MemoTaskRef {
	taskIndex: number;
	lineOffset: number;
	marker: string;
	text: string;
}

export interface ObservationHandle {
	sourcePath: string;
	sourceRevision: string;
	startLine: number;
	endLine: number;
	rawBlockHash: string;
}

export interface IdentityHandle {
	memoId: string;
	activeBindingId: string;
	identityRevision: string;
}

export interface ResolvedIdentityEvidence {
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

// Observation 只描述当前 Daily 字节，不承担身份职责。
export interface MemoObservation extends ObservationHandle {
	logicalDate: string;
	section: string | null;
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

export interface MarkdownCapabilities {
	view: true;
	create: true;
	edit: true;
	task: true;
	copy: true;
	move: true;
	remove: true;
	openDaily: true;
	openLinks: true;
	openImages: true;
	explicitBlockReference: true;
}

export type CatalogCapabilityCoverage = "complete" | "partial";

export interface CatalogCapabilities {
	browse: CatalogCapabilityCoverage;
	search: CatalogCapabilityCoverage;
	stats: CatalogCapabilityCoverage;
	shuffle: CatalogCapabilityCoverage;
	random: CatalogCapabilityCoverage;
	timeBuoy: CatalogCapabilityCoverage;
	fullHistory: CatalogCapabilityCoverage;
}

export type IdentityCapabilityState = "ready" | "absent" | "syncing" | "conflicted";

export interface IdentityCapabilities {
	relation: IdentityCapabilityState;
	review: IdentityCapabilityState;
	recoverableDelete: IdentityCapabilityState;
	restore: IdentityCapabilityState;
	merge: IdentityCapabilityState;
	repair: IdentityCapabilityState;
	crossDeviceIdentity: IdentityCapabilityState;
}

export interface ResolvedMemoCapabilities {
	markdown: MarkdownCapabilities;
	identity: IdentityCapabilities;
}

export interface MemoCapabilities {
	markdown: MarkdownCapabilities;
	catalog: CatalogCapabilities;
	identity: IdentityCapabilities;
}

export interface IdentityCandidate {
	memoId: string;
	source: "manual_successor";
	origin?: {
		sourcePath: string;
		logicalDate: string;
		time: string;
	};
}

export type ResolvedMemo =
	| {
		kind: "identified";
		bindingEvidence: ResolvedIdentityEvidence;
		identityHandle: IdentityHandle;
		observation: MemoObservation;
		capabilities: ResolvedMemoCapabilities;
		identityRevision: string;
	}
	| {
		kind: "observed";
		identityHandle: null;
		observation: MemoObservation;
		adoption: "eligible" | "settling";
		capabilities: ResolvedMemoCapabilities;
		identityRevision: string;
	}
	| {
		kind: "ambiguous";
		identityHandle: null;
		observation: MemoObservation;
		candidates: IdentityCandidate[];
		reason?: "manual_successor";
		capabilities: ResolvedMemoCapabilities;
		identityRevision: string;
	};

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
	observationKeys?: string[];
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
	explicitReferenceMemoCount: number;
	explicitReferenceTargets: string[];
	wordCount: number;
	imageMemoCount: number;
	taggedMemoCount: number;
	untaggedMemoCount: number;
	hourCounts: number[];
	tagMemoCounts: Record<string, number>;
	tagDisplayNames: Record<string, string>;
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
	explicitReferenceMemoCount: number;
	explicitReferenceTargets: string[];
	wordCount: number;
	imageMemoCount: number;
	taggedMemoCount: number;
	untaggedMemoCount: number;
	hourCounts: number[];
	tagMemoCounts: Record<string, number>;
	tagDisplayNames: Record<string, string>;
}

export interface CatalogCoverage {
	kind: CatalogCoverageKind;
	/** false 表示本地扫描已可用，但共享配置尚不能证明扫描范围完整。 */
	sharedConfigurationComplete?: boolean;
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
	dayOfMonth?: string;
	hour?: number;
	logicalDates?: readonly string[];
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

export interface CatalogResolutionSnapshot {
	catalogRevision: number;
	identityRevision: string;
	results: Record<string, ResolvedMemo>;
}

export interface CatalogInventoryEntry {
	sourcePath: string;
	logicalDate: string;
	mtime: number;
	size: number;
}

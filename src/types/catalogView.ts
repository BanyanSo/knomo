import type {
	CatalogCoverage,
	CatalogCapabilities,
	CatalogCursor,
	CatalogObservation,
	CatalogQuery,
	CatalogStoreLifecycle,
	IdentityHandle,
	MemoCapabilities,
	ObservationHandle,
	ResolvedMemo,
} from "./catalog";
import type { IdentityLedgerStatus } from "./identityLedger";
import type { KnomoSharedConfigStatus } from "./knomoConfig";
import type { LegacyIdentityImportStatus } from "./legacyMigration";
import type { KnomoSettingsLoadStatus } from "./settings";

export type CatalogReadState = "ready" | "history_building" | "storage_unavailable";
export type CatalogContentState = "ready" | "scanning" | "unavailable";
export type CatalogState = "partial" | "complete" | "degraded";
export type CatalogIdentityState = "absent" | "syncing" | "ready" | "conflicted";
export type CatalogIdentityAttention = "settings_retry";
export type MonthlyProjectionState = "ready" | "stale" | "failed";
export type LegacyMigrationState = "none" | "attention" | "unavailable";

export interface CatalogReadStatus {
	settings?: KnomoSettingsLoadStatus;
	content: CatalogContentState;
	catalog: CatalogState;
	identity: CatalogIdentityState;
	identityAttention?: CatalogIdentityAttention | null;
	sharedConfiguration?: KnomoSharedConfigStatus;
	projection: MonthlyProjectionState;
	migration: LegacyMigrationState;
}

export interface KnomoRuntimeAttentionSnapshot {
	settings?: KnomoSettingsLoadStatus;
	catalogLifecycle: CatalogStoreLifecycle;
	identity: IdentityLedgerStatus;
	identityAttention: CatalogIdentityAttention | null;
	sharedConfiguration: KnomoSharedConfigStatus;
	monthly: MonthlyProjectionState;
	legacyMigration: LegacyIdentityImportStatus;
}

export interface KnomoRuntimeSnapshot {
	settings?: KnomoSettingsLoadStatus;
	catalog: {
		coverage: CatalogCoverage;
		lifecycle: CatalogStoreLifecycle;
	};
	identity: IdentityLedgerStatus;
	sharedConfiguration: KnomoSharedConfigStatus;
	monthly: MonthlyProjectionState;
	legacyMigration: LegacyIdentityImportStatus;
}

export interface CatalogMemoItem {
	key: string;
	renderKey: string;
	memoId: string | null;
	identityHandle: IdentityHandle | null;
	observationHandle: ObservationHandle;
	createdAt: string;
	content: string;
	tags: string[];
	links: CatalogObservation["links"];
	images: CatalogObservation["images"];
	tasks: CatalogObservation["tasks"];
	timeBuoyDates: string[];
	sourcePath: string;
	lineNumberHint: number;
	sourceMemoId: string | null;
	capabilities: MemoCapabilities;
	resolved: ResolvedMemo;
	observation: CatalogObservation;
}

export interface MutationFollowUpState {
	followUpPending: boolean;
	localRefreshPending: boolean;
}

export interface DailyMutationResult extends MutationFollowUpState {
	status: "saved" | "content_pending";
	memoId: string | null;
}

export interface MemoSaveResult extends DailyMutationResult {
	memo: CatalogMemoItem | null;
	timeBuoyDates: string[];
}

export interface MemoSaveOperation {
	dailyCommitted: Promise<void>;
	settled: Promise<MemoSaveResult>;
}

export interface CatalogFeatureCursor {
	catalog: CatalogCursor;
}

export interface CatalogMemoPage {
	items: CatalogMemoItem[];
	nextCursor: CatalogFeatureCursor | null;
	catalogRevision: number;
	identityRevision: string;
	coverage: CatalogCoverage;
	lifecycle: CatalogStoreLifecycle;
	capabilities: CatalogCapabilities;
	status: CatalogReadStatus;
	readState: CatalogReadState;
	degraded: boolean;
	invalidated: boolean;
}

export interface CatalogMemoCountResult {
	count: number | null;
	complete: boolean;
	catalogRevision: number;
	identityRevision: string;
	coverage: CatalogCoverage;
}

export interface CatalogLibrarySummary {
	memoCount: number;
	tagCount: number;
	imageCount: number;
	wordCount: number;
}

export interface CatalogTagFacet {
	key: string;
	label: string;
	count: number;
}

export interface CatalogAggregateResult<T> {
	value: T | null;
	complete: boolean;
	coverage: CatalogCoverage;
}

export interface CatalogFunctionPageRequest {
	limit: number;
	cursor?: CatalogFeatureCursor | null;
	text?: string;
}

export type CatalogRecordStatsFilter =
	| { type: "day"; date: string }
	| { type: "month"; month: string }
	| { type: "range"; startDate: string; endDateExclusive: string }
	| { type: "with-tag"; startDate: string; endDateExclusive: string }
	| { type: "no-tag"; startDate: string; endDateExclusive: string }
	| { type: "with-image"; startDate: string; endDateExclusive: string }
	| { type: "tag"; startDate: string; endDateExclusive: string; tagKey: string; tagLabel: string }
	| { type: "references"; startDate: string; endDateExclusive: string }
	| { type: "max-daily-notes"; dates: string[] }
	| { type: "max-daily-words"; dates: string[] }
	| { type: "hour"; startDate: string; endDateExclusive: string; hour: number };

export interface CatalogOperationalState {
	readState: CatalogReadState;
	capabilities: {
		createNew: boolean;
	};
}

export type CatalogFeatureQuery = Omit<CatalogQuery, "cursor"> & {
	cursor?: CatalogFeatureCursor | null;
};

export type CatalogFeatureFilter = Omit<CatalogFeatureQuery, "limit" | "cursor">;

export type TrashDeleteSource = "knomo_ui" | "unknown";

export interface TrashMemoItem {
	key: string;
	memoId: string;
	deleteEventId: string;
	createdAt: string;
	deletedAt: string;
	deleteSource: TrashDeleteSource;
	logicalDate: string;
	sourcePath: string;
	section: string | null;
	content: string;
	contentHash: string;
	sourceMemoId: string | null;
	purgeAllowed: boolean;
}

export interface TrashMemoPage {
	items: TrashMemoItem[];
	nextCursor: string | null;
	identityRevision: string;
}

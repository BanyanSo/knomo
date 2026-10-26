import type {
	CatalogCoverage,
	CatalogCapabilities,
	CatalogCursor,
	CatalogObservation,
	CatalogQuery,
	CatalogStoreLifecycle,
	MemoCapabilities,
	ObservationHandle,
	ResolvedMemo,
} from "./catalog";
import type { KnomoCurrentConfigStatus } from "./knomoConfig";
import type { LegacyMigrationStatus } from "./legacyMigration";
import type { KnomoSettingsLoadStatus } from "./settings";

export type CatalogReadState = "ready" | "history_building" | "storage_unavailable";
export type CatalogContentState = "ready" | "scanning" | "unavailable";
export type CatalogState = "partial" | "complete" | "degraded";
export type MonthlyProjectionState = "ready" | "stale" | "failed";

export interface CatalogScanSnapshot {
	state: "idle" | "scanning" | "paused" | "waiting-retry";
	failedFileCount: number;
}


export interface CatalogReadStatus {
	settings?: KnomoSettingsLoadStatus;
	content: CatalogContentState;
	catalog: CatalogState;
	currentConfiguration?: KnomoCurrentConfigStatus;
	projection: MonthlyProjectionState;
	scan?: CatalogScanSnapshot;
	relations?: { complete: boolean; failed: boolean; stale?: boolean };

}

export interface KnomoRuntimeAttentionSnapshot {
	settings?: KnomoSettingsLoadStatus;
	catalogLifecycle: CatalogStoreLifecycle;
	currentConfiguration: KnomoCurrentConfigStatus;
	monthly: MonthlyProjectionState;
	legacyMigration: LegacyMigrationStatus;
	legacyCleanupPending?: boolean;
}

export interface CatalogMemoItem {
	key: string;
	renderKey: string;
	observationHandle: ObservationHandle;
	// 当前 Daily 日期与原样 parsed time，非永久创建时间或带时区 instant。
	createdAt: string;
	content: string;
	tags: string[];
	links: CatalogObservation["links"];
	images: CatalogObservation["images"];
	tasks: CatalogObservation["tasks"];
	timeBuoyDates: string[];
	sourcePath: string;
	lineNumberHint: number;
	capabilities: MemoCapabilities;
	resolved: ResolvedMemo;
	observation: CatalogObservation;
}

export interface MutationFollowUpState {
	localRefreshPending: boolean;
}

export interface DailyMutationResult extends MutationFollowUpState {
	status: "saved";
}

export interface MemoSaveResult extends DailyMutationResult {
	memo: CatalogMemoItem | null;
	timeBuoyDates: string[];
}

export interface MemoRestoreResult extends MemoSaveResult {
	cleanupPending: boolean;
	message?: string;
}

export interface MemoSaveOperation {
	dailyCommitted: Promise<void>;
	settled: Promise<MemoSaveResult>;
}

export interface CatalogFeatureCursor {
	catalog: CatalogCursor;
	relationsVersion?: number;
}

export interface CatalogMemoPage {
	items: CatalogMemoItem[];
	nextCursor: CatalogFeatureCursor | null;
	catalogRevision: number;
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

export type CatalogRecordStatsFilter =
	| { type: "day"; date: string }
	| { type: "month"; month: string }
	| { type: "range"; startDate: string; endDateExclusive: string }
	| { type: "with-tag"; startDate: string; endDateExclusive: string }
	| { type: "no-tag"; startDate: string; endDateExclusive: string }
	| { type: "with-image"; startDate: string; endDateExclusive: string }
	| { type: "tag"; startDate: string; endDateExclusive: string; tagKey: string; tagLabel: string }
	| { type: "references"; startDate: string; endDateExclusive: string }
	| { type: "referenced"; startDate: string; endDateExclusive: string }
	| { type: "max-daily-notes"; dates: string[] }
	| { type: "max-daily-words"; dates: string[] }
	| { type: "hour"; startDate: string; endDateExclusive: string; hour: number };


export type CatalogFeatureQuery = Omit<CatalogQuery, "cursor"> & {
	cursor?: CatalogFeatureCursor | null;
};

export type CatalogFeatureFilter = Omit<CatalogFeatureQuery, "limit" | "cursor">;
export interface CatalogLibraryIndexesResult {
	value: { summary: CatalogLibrarySummary; facets: CatalogTagFacet[] } | null;
	complete: boolean;
	catalogRevision: number;
	coverage: CatalogCoverage;
	lifecycle: CatalogStoreLifecycle;
	invalidated: boolean;
}

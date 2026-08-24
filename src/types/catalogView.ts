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

export type CatalogReadState = "ready" | "history_building" | "storage_unavailable";
export type CatalogContentState = "ready" | "scanning" | "unavailable";
export type CatalogState = "partial" | "complete" | "degraded";
export type CatalogIdentityState = "absent" | "syncing" | "ready" | "conflicted";
export type MonthlyProjectionState = "ready" | "stale" | "failed";
export type LegacyMigrationState = "none" | "attention" | "unavailable";

export interface CatalogReadStatus {
	content: CatalogContentState;
	catalog: CatalogState;
	identity: CatalogIdentityState;
	projection: MonthlyProjectionState;
	migration: LegacyMigrationState;
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
	coverage: CatalogCoverage;
	lifecycle: CatalogStoreLifecycle;
	capabilities: CatalogCapabilities;
	status: CatalogReadStatus;
	readState: CatalogReadState;
	degraded: boolean;
	invalidated: boolean;
}

export interface CatalogOperationalState {
	readState: CatalogReadState;
	capabilities: {
		createNew: boolean;
	};
}

export type CatalogFeatureQuery = Omit<CatalogQuery, "cursor"> & {
	cursor?: CatalogFeatureCursor | null;
};

export interface TrashMemoItem {
	key: string;
	memoId: string;
	deleteEventId: string;
	deletedAt: string;
	logicalDate: string;
	sourcePath: string;
	section: string | null;
	content: string;
	contentHash: string;
	sourceMemoId: string | null;
}

export interface TrashMemoPage {
	items: TrashMemoItem[];
	nextCursor: string | null;
	identityRevision: string;
}

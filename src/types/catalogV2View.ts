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
import type { CatalogV2MaterializedDeleteVersion } from "./catalogV2";

export type CatalogV2ReadState =
	| "needs_initialization"
	| "waiting_for_sync"
	| "legacy_detected"
	| "attention"
	| "ready"
	| "history_building"
	| "upgrade_building"
	| "state_settling"
	| "storage_unavailable";

export type CatalogV2ContentState = "ready" | "scanning" | "unavailable";
export type CatalogV2CatalogState = "partial" | "complete" | "degraded";
export type CatalogV2IdentityState = "absent" | "syncing" | "ready" | "conflicted";
export type CatalogV2ProjectionState = "ready" | "stale" | "failed";
export type CatalogV2MigrationState = "none" | "detected" | "running" | "attention";

export interface CatalogV2ReadStatus {
	content: CatalogV2ContentState;
	catalog: CatalogV2CatalogState;
	identity: CatalogV2IdentityState;
	projection: CatalogV2ProjectionState;
	migration: CatalogV2MigrationState;
}

export interface CatalogV2MemoItem {
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

export interface CatalogV2MutationFollowUpState {
	followUpPending: boolean;
	localRefreshPending: boolean;
}

export interface CatalogV2DailyMutationResult extends CatalogV2MutationFollowUpState {
	status: "saved" | "content_pending";
	memoId: string | null;
}

export interface CatalogV2MemoSaveResult extends CatalogV2DailyMutationResult {
	memo: CatalogV2MemoItem | null;
	timeBuoyDates: string[];
}

export interface CatalogV2FeatureCursor {
	catalog: CatalogCursor;
}

export interface CatalogV2MemoPage {
	items: CatalogV2MemoItem[];
	nextCursor: CatalogV2FeatureCursor | null;
	coverage: CatalogCoverage;
	lifecycle: CatalogStoreLifecycle;
	capabilities: CatalogCapabilities;
	status: CatalogV2ReadStatus;
	// 仅供冻结的 Protocol V2 mutation 运行时兼容；展示层必须读取 status。
	readState: CatalogV2ReadState;
	degraded: boolean;
	invalidated: boolean;
}

export interface CatalogV2OperationalState {
	readState: CatalogV2ReadState;
	capabilities: {
		readKnown: true;
		createNew: boolean;
		adoptExisting: boolean;
		projectMonthly: false;
		physicalGc: false;
	};
}

export type CatalogV2FeatureQuery = Omit<CatalogQuery, "cursor"> & {
	cursor?: CatalogV2FeatureCursor | null;
};

export interface CatalogV2DeletedMemoItem {
	key: string;
	memoId: string;
	deleteVersion: CatalogV2MaterializedDeleteVersion;
	deletedAt: string;
	logicalDate: string;
	sourcePath: string;
	section: string | null;
	content: string;
	sourceMemoId: string | null;
	payloadAvailable: boolean;
	identityDeleteEventId?: string;
}

export interface CatalogV2DeletedMemoPage {
	items: CatalogV2DeletedMemoItem[];
	nextCursor: string | null;
	stateRevision: string;
}

import type {
	CatalogCoverage,
	CatalogCursor,
	CatalogObservation,
	CatalogQuery,
	CatalogStoreLifecycle,
	MemoCapabilities,
	ResolvedMemo,
} from "./catalog";
import type { CatalogV2MaterializedDeleteVersion } from "./catalogV2";
import type { CatalogV2InstallMode } from "./catalogV2";

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

export interface CatalogV2MemoItem {
	key: string;
	memoId: string | null;
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
	status: "saved";
	memoId: string;
}

export interface CatalogV2MemoSaveResult extends CatalogV2DailyMutationResult {
	memo: CatalogV2MemoItem | null;
	timeBuoyDates: string[];
}

export interface CatalogV2FeatureCursor {
	catalog: CatalogCursor;
	stateRevision: string;
}

export interface CatalogV2MemoPage {
	items: CatalogV2MemoItem[];
	nextCursor: CatalogV2FeatureCursor | null;
	coverage: CatalogCoverage;
	lifecycle: CatalogStoreLifecycle;
	capabilities: CatalogV2CoverageCapabilities;
	readState: CatalogV2ReadState;
	degraded: boolean;
	invalidated: boolean;
}

export interface CatalogV2CoverageCapabilities {
	browseKnown: true;
	completeStats: boolean;
	completeShuffleDayPool: boolean;
	completeRandomPool: boolean;
	completeTimeBuoyIndex: boolean;
}

export interface CatalogV2OperationalState {
	installMode: CatalogV2InstallMode;
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
}

export interface CatalogV2DeletedMemoPage {
	items: CatalogV2DeletedMemoItem[];
	nextCursor: string | null;
	stateRevision: string;
}

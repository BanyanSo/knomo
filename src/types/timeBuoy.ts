import type { MemoViewItem } from "./memoView";
import type { CatalogCoverage, CatalogObservation, CatalogQueryMetrics, CatalogStoreLifecycle } from "./catalog";

export type TimeBuoyDateStatus = "today" | "upcoming" | "past";

export interface TimeBuoyIndexEntry {
	observationKey: string;
	createdAtKey: string;
	timeBuoyDates: string[];
}

export interface TimeBuoyCursor {
	catalogRevision: number;
	coverageKey: string;
	today: string;
	tab: TimeBuoyDateStatus;
	primaryTargetDate: string;
	createdAtKey: string;
	observationKey: string;
}

export interface TimeBuoyPageRequest {
	today: string;
	tab: TimeBuoyDateStatus;
	limit: number;
	cursor?: TimeBuoyCursor | null;
}

export interface TimeBuoyObservationPage {
	items: CatalogObservation[];
	nextCursor: TimeBuoyCursor | null;
	catalogRevision: number;
	coverage: CatalogCoverage;
	lifecycle: CatalogStoreLifecycle;
	invalidated: boolean;
	metrics: CatalogQueryMetrics;
}

export interface TimeBuoyPageResult extends TimeBuoyAllQueryResult {
	nextCursor: TimeBuoyCursor | null;
	metrics: CatalogQueryMetrics;
}

export interface TimeBuoyInstance {
	// 仅用于当前视图关联的本地 observation key，不是永久 Memo ID。
	memoId: string;
	targetDate: string;
}

export interface TimeBuoyQueryItem {
	instance: TimeBuoyInstance;
	memo: MemoViewItem;
}

export interface TimeBuoyQueryResult {
	nextCursor?: TimeBuoyCursor | null;
	catalogRevision?: number;
	coverage?: CatalogCoverage;
	invalidated?: boolean;
	items: TimeBuoyQueryItem[];
	stale: TimeBuoyInstance[];
	missingPeriods: string[];
}

export interface TimeBuoyAllQueryResult extends TimeBuoyQueryResult {
	complete: boolean;
}

export interface TimeBuoyMatch {
	targetDate: string;
	start: number;
	end: number;
}

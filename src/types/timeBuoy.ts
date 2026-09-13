import type { MemoViewItem } from "./memoView";
import type { CatalogCoverage } from "./catalog";

export type TimeBuoyDateStatus = "today" | "upcoming" | "past";

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

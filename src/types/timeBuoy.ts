import type { MemoViewItem } from "./memoView";

export type TimeBuoyDateStatus = "today" | "upcoming" | "past";

export interface TimeBuoyInstance {
	memoId: string;
	targetDate: string;
}

export interface TimeBuoyQueryItem {
	instance: TimeBuoyInstance;
	memo: MemoViewItem;
}

export interface TimeBuoyQueryResult {
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

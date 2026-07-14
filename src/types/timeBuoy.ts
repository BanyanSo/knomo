export type TimeBuoyDateStatus = "today" | "upcoming" | "past";

export interface TimeBuoyInstance {
	memoId: string;
	targetDate: string;
	sourcePeriod: string;
	buoyRevision: string;
}

export interface TimeBuoyIndexEntry {
	sourcePeriod: string;
	buoyRevision: string;
}

export interface TimeBuoyIndexShard {
	schemaVersion: 2;
	targetPeriod: string;
	updatedAt: string;
	dates: Record<string, Record<string, TimeBuoyIndexEntry>>;
}

export interface TimeBuoyIndexState {
	schemaVersion: 1;
	updatedAt: string;
	dirty: boolean;
	affectedMemoIds: string[];
	expectedPeriods: string[];
}

export interface TimeBuoyMatch {
	targetDate: string;
	start: number;
	end: number;
}

export interface MemoReviewState {
	memoId: string;
	lastReviewedAt?: string;
	reviewCount: number;
}

export type MemoReviewStateMap = Record<string, MemoReviewState>;

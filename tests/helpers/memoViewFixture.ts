import type { MemoViewItem } from "../../src/types/memoView";

export interface MemoIssueFixture {
	type: string;
	code?: string;
	detectedAt: string;
	message: string;
	context?: Record<string, string | number | boolean | null>;
}

/** 仅供历史 UI fixture 复用；生产类型不再包含 legacy sync / Monthly 状态。 */
export interface MemoRecord extends Omit<MemoViewItem, "dailyRef"> {
	dailyRef: MemoViewItem["dailyRef"] & {
		lastKnownBlock: string;
		lastKnownHash: string;
		lastSyncedAt: string | null;
	};
	syncStatus?: string;
	source?: string;
	version?: number;
	issue?: MemoIssueFixture | null;
	lastMarkdownSyncAt?: string | null;
	lastMarkdownSyncSource?: string | null;
	monthlyRef?: {
		path: string;
		dateHeading: string;
		lastKnownBlock: string;
		lastKnownHash: string;
		lineNumberHint: number | null;
		lastSyncedAt: string | null;
	};
	deletedDailyBlock?: string;
	deletedMonthlyBlock?: string;
}

import type { MemoIssue } from "./issue";

export type MemoStatus = "active" | "deleted" | "error";
export type MemoSyncStatus =
	| "synced"
	| "pending_monthly"
	| "monthly_failed"
	| "monthly_delete_failed";
export type MemoSource = "plugin_input" | "daily_scan" | "quote_create";
export type MarkdownSyncSource = "file_watch" | "legacy_import" | "manual_scan" | "startup_scan";
export type DailyRefSectionType = "heading" | "root";
export type MemoImageSyntax = "obsidian_embed" | "markdown_image";
export type MemoLinkSyntax = "wiki_link" | "markdown_link" | "url";

export interface MemoImageRef {
	path: string;
	altText: string;
	syntax: MemoImageSyntax;
}

export interface MemoLinkRef {
	target: string;
	displayText: string | null;
	syntax: MemoLinkSyntax;
}

export interface MemoReference {
	memoId: string;
	referenceText: string;
}

export interface DailyRef {
	path: string;
	heading: string | null;
	sectionType?: DailyRefSectionType;
	lastKnownBlock: string;
	lastKnownHash: string;
	lineNumberHint: number | null;
	lastSyncedAt: string | null;
}

export interface MonthlyRef {
	path: string;
	dateHeading: string;
	lastKnownBlock: string;
	lastKnownHash: string;
	lineNumberHint: number | null;
	lastSyncedAt: string | null;
}

export interface ParsedMemoBlock {
	startLine: number;
	endLine: number;
	rawBlock: string;
	time: string;
	content: string;
	contentHash: string;
	blockId: string | null;
	tags: string[];
	links: MemoLinkRef[];
	images: MemoImageRef[];
}

export interface MemoRecord {
	id: string;
	createdAt: string;
	updatedAt: string;
	contentSnapshot: string;
	contentHash: string;
	status: MemoStatus;
	syncStatus: MemoSyncStatus;
	source: MemoSource;
	version: number;
	tags: string[];
	links: MemoLinkRef[];
	images: MemoImageRef[];
	references: MemoReference[];
	sourceMemoId: string | null;
	issue: MemoIssue | null;
	lastMarkdownSyncAt: string | null;
	lastMarkdownSyncSource: MarkdownSyncSource | null;
	dailyRef: DailyRef;
	monthlyRef: MonthlyRef;
	deletedAt?: string;
	deleteSource?: string;
	deletedDailyBlock?: string;
	deletedMonthlyBlock?: string;
}

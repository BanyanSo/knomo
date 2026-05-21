export type DailyInsertPosition = "top" | "bottom";
export type MemoTimeFormat = "HH:mm:ss" | "HH:mm";
export type MonthlyDateOrder = "asc" | "desc";
export type ReferenceMode = "embed" | "link";
export type MobileCompactMode = "auto" | "on" | "off";

export interface KnomoSettings {
	settingsVersion: number;
	dailyHeading: string;
	dailyInsertPosition: DailyInsertPosition;
	memoTimeFormat: MemoTimeFormat;
	monthlyMemoFolder: string;
	monthlyMemoFileFormat: string;
	monthlyDateHeadingFormat: string;
	monthlyDateOrder: MonthlyDateOrder;
	legacyDailyHeadings: string[];
	mobileCompactMode: MobileCompactMode;
	syncDebounceMs: number;
	desktopSidebarWidth: number;
	desktopSidebarCollapsed: boolean;
	excludeMonthlyMemosFromObsidian: boolean;
	managedObsidianExcludeRule?: string;
	managedObsidianExcludeRuleOwned?: boolean;
	pinnedTags: string[];
}

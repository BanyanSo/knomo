import { SETTINGS_VERSION } from "../constants";
import type {
	DailyInsertPosition,
	KnomoSettings,
	MemoTimeFormat,
	MobileCompactMode,
	MonthlyDateOrder,
} from "../types/settings";
import { isValidMarkdownHeading } from "../utils/markdown";
import { isRecord } from "../utils/object";
import { normalizeVaultPath } from "../utils/path";
import { DEFAULT_KNOMO_SETTINGS } from "./defaults";

export { DEFAULT_KNOMO_SETTINGS } from "./defaults";

function isDailyInsertPosition(value: unknown): value is DailyInsertPosition {
	return value === "top" || value === "bottom";
}

function isMemoTimeFormat(value: unknown): value is MemoTimeFormat {
	return value === "HH:mm:ss" || value === "HH:mm";
}

function isMobileCompactMode(value: unknown): value is MobileCompactMode {
	return value === "auto" || value === "on" || value === "off";
}

function isMonthlyDateOrder(value: unknown): value is MonthlyDateOrder {
	return value === "asc" || value === "desc";
}

function stringOrDefault(value: unknown, fallback: string): string {
	return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

function numberOrDefault(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function booleanOrDefault(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export function isValidMonthlyMemoFileFormat(value: string): boolean {
	const format = value.trim();
	const tokenCount = format.split("YYYY-MM").length - 1;
	if (format.length === 0 || /[\\/]/.test(format) || tokenCount !== 1) {
		return false;
	}
	return format.replace("YYYY-MM", "2026-05") !== format.replace("YYYY-MM", "2026-06");
}

function isSafePersistedMonthlyMemoFileFormat(value: string): boolean {
	return value.trim().length > 0 && !/[\\/]/.test(value);
}

function stringArrayOrDefault(value: unknown, fallback: string[]): string[] {
	if (!Array.isArray(value)) {
		return [...fallback];
	}
	return value.filter((item): item is string => typeof item === "string");
}

export function normalizeSettings(value: unknown): KnomoSettings {
	const savedSettings = isRecord(value) ? value : {};
	const merged = Object.assign({}, DEFAULT_KNOMO_SETTINGS, savedSettings);
	const dailyInsertPosition = isDailyInsertPosition(merged.dailyInsertPosition)
		? merged.dailyInsertPosition
		: DEFAULT_KNOMO_SETTINGS.dailyInsertPosition;
	const memoTimeFormat = isMemoTimeFormat(merged.memoTimeFormat)
		? merged.memoTimeFormat
		: DEFAULT_KNOMO_SETTINGS.memoTimeFormat;
	const mobileCompactMode = isMobileCompactMode(merged.mobileCompactMode)
		? merged.mobileCompactMode
		: DEFAULT_KNOMO_SETTINGS.mobileCompactMode;
	const monthlyDateOrder = isMonthlyDateOrder(merged.monthlyDateOrder)
		? merged.monthlyDateOrder
		: DEFAULT_KNOMO_SETTINGS.monthlyDateOrder;
	const monthlyMemoFileFormat = stringOrDefault(
		merged.monthlyMemoFileFormat,
		DEFAULT_KNOMO_SETTINGS.monthlyMemoFileFormat,
	);

	return {
		settingsVersion: SETTINGS_VERSION,
		dailyHeading: stringOrDefault(merged.dailyHeading, DEFAULT_KNOMO_SETTINGS.dailyHeading),
		dailyInsertPosition,
		memoTimeFormat,
		monthlyMemoFolder: normalizeVaultPath(
			stringOrDefault(merged.monthlyMemoFolder, DEFAULT_KNOMO_SETTINGS.monthlyMemoFolder),
		),
		monthlyMemoFileFormat: isSafePersistedMonthlyMemoFileFormat(monthlyMemoFileFormat)
			? monthlyMemoFileFormat
			: DEFAULT_KNOMO_SETTINGS.monthlyMemoFileFormat,
		monthlyDateHeadingFormat: stringOrDefault(
			merged.monthlyDateHeadingFormat,
			DEFAULT_KNOMO_SETTINGS.monthlyDateHeadingFormat,
		),
		monthlyDateOrder,
		legacyDailyHeadings: stringArrayOrDefault(
			merged.legacyDailyHeadings,
			DEFAULT_KNOMO_SETTINGS.legacyDailyHeadings,
		).filter((heading) => isValidMarkdownHeading(heading)),
		timeBuoyEnabled: booleanOrDefault(
			merged.timeBuoyEnabled,
			DEFAULT_KNOMO_SETTINGS.timeBuoyEnabled,
		),
		timeBuoyIntroDismissed: booleanOrDefault(
			merged.timeBuoyIntroDismissed,
			DEFAULT_KNOMO_SETTINGS.timeBuoyIntroDismissed ?? false,
		),
		mobileCompactMode,
		syncDebounceMs: numberOrDefault(merged.syncDebounceMs, DEFAULT_KNOMO_SETTINGS.syncDebounceMs),
		desktopSidebarWidth: numberOrDefault(
			merged.desktopSidebarWidth,
			DEFAULT_KNOMO_SETTINGS.desktopSidebarWidth,
		),
		desktopSidebarCollapsed: booleanOrDefault(
			merged.desktopSidebarCollapsed,
			DEFAULT_KNOMO_SETTINGS.desktopSidebarCollapsed,
		),
		excludeMonthlyMemosFromObsidian: booleanOrDefault(
			merged.excludeMonthlyMemosFromObsidian,
			DEFAULT_KNOMO_SETTINGS.excludeMonthlyMemosFromObsidian,
		),
		managedObsidianExcludeRule: optionalString(merged.managedObsidianExcludeRule),
		managedObsidianExcludeRuleOwned: booleanOrDefault(
			merged.managedObsidianExcludeRuleOwned,
			DEFAULT_KNOMO_SETTINGS.managedObsidianExcludeRuleOwned ?? false,
		),
		managedSystemFolderExcludeRule: optionalString(merged.managedSystemFolderExcludeRule),
		managedSystemFolderExcludeRuleOwned: booleanOrDefault(
			merged.managedSystemFolderExcludeRuleOwned,
			DEFAULT_KNOMO_SETTINGS.managedSystemFolderExcludeRuleOwned ?? false,
		),
		managedLegacySystemFolderExcludeRule: optionalString(merged.managedLegacySystemFolderExcludeRule),
		managedLegacySystemFolderExcludeRuleOwned: booleanOrDefault(
			merged.managedLegacySystemFolderExcludeRuleOwned,
			DEFAULT_KNOMO_SETTINGS.managedLegacySystemFolderExcludeRuleOwned ?? false,
		),
		pinnedTags: stringArrayOrDefault(merged.pinnedTags, DEFAULT_KNOMO_SETTINGS.pinnedTags),
	};
}

export function cloneSettings(settings: KnomoSettings): KnomoSettings {
	return {
		...settings,
		legacyDailyHeadings: [...settings.legacyDailyHeadings],
		pinnedTags: [...settings.pinnedTags],
	};
}

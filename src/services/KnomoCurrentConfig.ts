import { normalizePath } from "obsidian";
import { normalizeMonthlyLocaleKey } from "./MonthlyProjection";
import type { DailyNotesConfig } from "./DailyNoteService";
import type { KnomoCurrentConfig } from "../types/knomoConfig";
import type { KnomoSettings } from "../types/settings";
import { isValidMonthlyMemoFileFormat } from "../settings/normalizeSettings";
import { isValidMarkdownHeading } from "../utils/markdown";
import { isRecord } from "../utils/object";
import { normalizeVaultPath } from "../utils/path";

export function buildKnomoCurrentConfig(
	dailyConfig: DailyNotesConfig,
	settings: Pick<
		KnomoSettings,
		"dailyHeading" | "legacyDailyHeadings" | "monthlyMemoFolder" | "monthlyMemoFileFormat"
		| "monthlyDateHeadingFormat" | "monthlyDateOrder"
	>,
	monthlyLocale: string,
): KnomoCurrentConfig {
	const headings = [...new Set([settings.dailyHeading, ...settings.legacyDailyHeadings]
		.map((heading) => heading.trim()).filter(Boolean))];
	const config: KnomoCurrentConfig = {
		daily: {
			folder: dailyConfig.folder === null || dailyConfig.folder.trim().length === 0
				? null
				: normalizeVaultPath(dailyConfig.folder),
			dateFormat: dailyConfig.format.trim(),
			headings,
		},
		monthly: {
			folder: normalizeVaultPath(settings.monthlyMemoFolder),
			fileFormat: settings.monthlyMemoFileFormat.trim(),
			dateHeadingFormat: settings.monthlyDateHeadingFormat.trim(),
			dateOrder: settings.monthlyDateOrder,
			locale: normalizeMonthlyLocaleKey(monthlyLocale),
		},
	};
	assertKnomoCurrentConfig(config);
	return config;
}

export function assertKnomoCurrentConfig(value: unknown): asserts value is KnomoCurrentConfig {
	if (!isRecord(value)
		|| !hasExactKeys(value, ["daily", "monthly"])
		|| !isRecord(value.daily)
		|| !hasExactKeys(value.daily, ["folder", "dateFormat", "headings"])
		|| !isRecord(value.monthly)
		|| !hasExactKeys(value.monthly, ["folder", "fileFormat", "dateHeadingFormat", "dateOrder", "locale"])) {
		throw new Error("Invalid Knomo current configuration.");
	}
	const daily = value.daily;
	const monthly = value.monthly;
	if ((daily.folder !== null && !isNormalizedVaultPath(daily.folder))
		|| typeof daily.dateFormat !== "string" || daily.dateFormat.trim().length === 0
		|| !Array.isArray(daily.headings) || daily.headings.length === 0
		|| daily.headings.some((heading) => typeof heading !== "string" || !isValidMarkdownHeading(heading))
		|| new Set(daily.headings).size !== daily.headings.length
		|| !isNormalizedVaultPath(monthly.folder)
		|| typeof monthly.fileFormat !== "string" || !isValidMonthlyMemoFileFormat(monthly.fileFormat)
		|| typeof monthly.dateHeadingFormat !== "string" || !isValidMarkdownHeading(monthly.dateHeadingFormat)
		|| (monthly.dateOrder !== "asc" && monthly.dateOrder !== "desc")
		|| typeof monthly.locale !== "string"
		|| normalizeMonthlyLocaleKey(monthly.locale) !== monthly.locale) {
		throw new Error("Invalid Knomo current configuration.");
	}
}

function isNormalizedVaultPath(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0
		&& !value.startsWith("/") && !value.includes("\\") && !value.split("/").includes("..")
		&& normalizePath(value) === value;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
	const keys = Object.keys(value).sort();
	return keys.length === expected.length
		&& [...expected].sort().every((key, index) => keys[index] === key);
}

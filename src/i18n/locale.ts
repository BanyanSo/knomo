import { getLanguage } from "obsidian";

export type KnomoLocale = "zh-CN" | "en";

export function normalizeKnomoLocale(value: unknown): KnomoLocale {
	if (typeof value !== "string") {
		return "en";
	}
	const normalized = value.trim().replace(/_/g, "-").toLowerCase();
	if (normalized.length === 0 || normalized === "en") {
		return "en";
	}
	return normalized === "zh" || normalized.startsWith("zh-") ? "zh-CN" : "en";
}

export function detectKnomoLocale(): KnomoLocale {
	return normalizeKnomoLocale(readObsidianLanguage());
}

function readObsidianLanguage(): string | null {
	try {
		const value = getLanguage();
		return isUsefulLocaleSource(value) ? value : null;
	} catch {
		return null;
	}
}

function isUsefulLocaleSource(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

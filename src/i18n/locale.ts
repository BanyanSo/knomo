import { getLanguage, moment as obsidianMoment } from "obsidian";

export type KnomoLocale = "zh-CN" | "en";

interface MomentWithLocale {
	locale?: () => unknown;
}

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
	const obsidianLanguage = readObsidianLanguage();
	if (obsidianLanguage !== null) {
		return normalizeKnomoLocale(obsidianLanguage);
	}
	const localStorageLanguage = readLocalStorageLanguage();
	if (localStorageLanguage !== null) {
		return normalizeKnomoLocale(localStorageLanguage);
	}
	const documentLanguage = readDocumentLanguage();
	if (documentLanguage !== null) {
		return normalizeKnomoLocale(documentLanguage);
	}
	const momentLanguage = readMomentLanguage();
	if (momentLanguage !== null) {
		return normalizeKnomoLocale(momentLanguage);
	}
	return "en";
}

function readObsidianLanguage(): string | null {
	try {
		const value = getLanguage();
		return isUsefulLocaleSource(value) ? value : null;
	} catch {
		return null;
	}
}

function readLocalStorageLanguage(): string | null {
	try {
		if (typeof window === "undefined") {
			return null;
		}
		const value = window.localStorage?.getItem("language") ?? null;
		return isUsefulLocaleSource(value) ? value : null;
	} catch {
		return null;
	}
}

function readDocumentLanguage(): string | null {
	try {
		if (typeof document === "undefined") {
			return null;
		}
		const value = document.documentElement?.lang ?? null;
		return isUsefulLocaleSource(value) ? value : null;
	} catch {
		return null;
	}
}

function readMomentLanguage(): string | null {
	try {
		const maybeMoment = obsidianMoment as unknown as MomentWithLocale;
		if (typeof maybeMoment.locale !== "function") {
			return null;
		}
		const value = maybeMoment.locale();
		return isUsefulLocaleSource(value) ? value : null;
	} catch {
		return null;
	}
}

function isUsefulLocaleSource(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

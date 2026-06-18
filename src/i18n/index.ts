import { en } from "./en";
import { detectKnomoLocale } from "./locale";
import { zhCN } from "./zh-CN";
import type { KnomoLocale } from "./locale";
import type { TranslationKey } from "./zh-CN";

export type TranslationParams = Record<string, string | number | boolean | null | undefined>;

const dictionaries: Record<KnomoLocale, Readonly<Record<TranslationKey, string>>> = {
	"zh-CN": zhCN,
	en,
};

const activeLocale = detectKnomoLocale();

export function getKnomoLocale(): KnomoLocale {
	return activeLocale;
}

export function t(key: TranslationKey, params: TranslationParams = {}): string {
	return translate(activeLocale, key, params);
}

export function translate(locale: KnomoLocale, key: TranslationKey, params: TranslationParams = {}): string {
	const template = dictionaries[locale][key] ?? dictionaries.en[key] ?? key;
	return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) => {
		const value = params[name];
		return value === null || value === undefined ? match : String(value);
	});
}

export type { KnomoLocale, TranslationKey };

import { t } from "../i18n";
import type { TranslationKey } from "../i18n";
import { en } from "../i18n/en";
import { legacyZhCNText } from "../i18n/zh-CN";
import {
	KNOMO_ERROR_DEFINITIONS,
	KnomoError,
} from "../types/serviceError";
import type { KnomoErrorCode, ServiceErrorParams } from "../types/serviceError";

export function formatServiceError(error: unknown, fallbackMessage = t("service.unknownError")): string {
	if (error instanceof KnomoError) {
		return formatKnomoError(error.code, error.params, error.detail);
	}
	if (error instanceof Error) {
		return error.message.length > 0 ? formatSettingsText(error.message) : fallbackMessage;
	}
	if (typeof error === "string" && error.length > 0) {
		return formatSettingsText(error);
	}
	return fallbackMessage;
}

export function formatSettingsText(text: string): string {
	return replaceKnownServiceText(text)
		.replace(/\bmemo block\b/gi, t("term.memoBlock"))
		.replace(/\bmemoId\b/g, t("term.memoId"))
		.replace(/\bmemo\b|\bMemo\b|\bMEMO\b/g, t("term.memo"))
		.replace(/\bdaily block\b/gi, t("term.dailyBlock"))
		.replace(/\bblockId\b/g, t("term.blockId"))
		.replace(/\bblock\b/gi, t("term.block"))
		.replace(/_knomo-(?:data|system)/g, t("term.systemFolder"));
}

const KNOWN_SERVICE_TEXT_KEYS: TranslationKey[] = [
	"service.unknownError",
	"service.dailyNotesUnavailable",
	"service.dailyNotesDisabled",
	"service.dailyNotesEnabled",
	"service.autoExcludeUnsupported",
];

function replaceKnownServiceText(text: string): string {
	let nextText = text;
	for (const key of KNOWN_SERVICE_TEXT_KEYS) {
		nextText = replaceLiteral(nextText, en[key], t(key));
		const legacyText = legacyZhCNText[key];
		if (legacyText !== undefined) {
			nextText = replaceLiteral(nextText, legacyText, t(key));
		}
	}
	return nextText;
}

function formatKnomoError(code: KnomoErrorCode, sourceParams: ServiceErrorParams, detail?: unknown): string {
	const params: ServiceErrorParams = { ...sourceParams };
	if (detail !== undefined) params.reason = formatServiceError(detail);
	return t(KNOMO_ERROR_DEFINITIONS[code].messageKey, params);
}

function replaceLiteral(text: string, search: string, replacement: string): string {
	return search.length === 0 ? text : text.split(search).join(replacement);
}

import type { TranslationKey } from "../i18n";

export type ServiceErrorParamValue = string | number | boolean | null;
export type ServiceErrorParams = Record<string, ServiceErrorParamValue>;

interface KnomoErrorDefinition {
	messageKey: TranslationKey;
	fallbackMessage: string;
}

export const KNOMO_ERROR_DEFINITIONS = {
	daily_notes_unavailable: {
		messageKey: "service.dailyNotesUnavailable",
		fallbackMessage: "Daily Notes core plugin is unavailable; Knomo cannot resolve the daily note.",
	},
	daily_notes_disabled: {
		messageKey: "service.dailyNotesDisabled",
		fallbackMessage: "Enable the Daily Notes core plugin in Obsidian settings. Knomo will read the Daily Notes settings automatically; you do not need to configure the daily note path in Knomo.",
	},
	auto_exclude_unsupported: {
		messageKey: "service.autoExcludeUnsupported",
		fallbackMessage: "This Obsidian environment does not support automatic exclude rule updates.",
	},
} as const satisfies Record<string, KnomoErrorDefinition>;

export type KnomoErrorCode = keyof typeof KNOMO_ERROR_DEFINITIONS;

export function isKnomoErrorCode(value: unknown): value is KnomoErrorCode {
	return typeof value === "string" && Object.prototype.hasOwnProperty.call(KNOMO_ERROR_DEFINITIONS, value);
}

export class KnomoError extends Error {
	readonly code: KnomoErrorCode;
	readonly params: ServiceErrorParams;
	readonly detail: unknown;

	constructor(code: KnomoErrorCode, params: ServiceErrorParams = {}, detail?: unknown) {
		const fallbackParams = detail === undefined || params.reason !== undefined
			? params
			: { ...params, reason: getUnknownErrorMessage(detail) };
		const message = formatFallbackMessage(KNOMO_ERROR_DEFINITIONS[code].fallbackMessage, fallbackParams);
		super(message);
		this.name = "KnomoError";
		this.code = code;
		this.params = params;
		this.detail = detail;
	}
}

function formatFallbackMessage(template: string, params: ServiceErrorParams): string {
	return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) => {
		const value = params[name];
		return value === null || value === undefined ? match : String(value);
	});
}

function getUnknownErrorMessage(error: unknown): string {
	return error instanceof Error && error.message.length > 0 ? error.message : "Unknown error";
}

import { t } from "../i18n";
import type { TrashDeleteSource } from "../types/catalogView";

export function formatMemoDisplayTime(value: string): string {
	return value
		.replace("T", " ")
		.replace(/\.\d+(?=Z$|[+-]\d{2}:\d{2}$|$)/u, "")
		.replace(/(?:Z|[+-]\d{2}:\d{2})$/u, "");
}

export function formatOptionalMemoTime(value: string | undefined): string {
	return value === undefined || value.trim().length === 0 ? t("trash.unknownTime") : formatMemoDisplayTime(value);
}

export function formatDeleteSource(value: TrashDeleteSource): string {
	return value === "knomo_ui" ? "Knomo" : t("deleteSource.unknown");
}

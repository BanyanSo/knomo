import { t } from "../i18n";
import type { TrashDeleteSource } from "../types/catalogView";

export function formatMemoDisplayTime(value: string): string {
	if (/(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) {
		const instant = new Date(value);
		if (!Number.isNaN(instant.getTime())) {
			return [
				`${instant.getFullYear()}-${padTwoDigits(instant.getMonth() + 1)}-${padTwoDigits(instant.getDate())}`,
				`${padTwoDigits(instant.getHours())}:${padTwoDigits(instant.getMinutes())}:${padTwoDigits(instant.getSeconds())}`,
			].join(" ");
		}
	}
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

function padTwoDigits(value: number): string {
	return String(value).padStart(2, "0");
}

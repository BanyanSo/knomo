import { t } from "../i18n";

export function formatMemoDisplayTime(value: string): string {
	return value.replace("T", " ").replace(/\.\d{3}[+-]\d{2}:\d{2}$/, "");
}

export function formatOptionalMemoTime(value: string | undefined): string {
	return value === undefined || value.trim().length === 0 ? t("trash.unknownTime") : formatMemoDisplayTime(value);
}

export function formatDeleteSource(value: string): string {
	if (value === "knomo_ui") {
		return "Knomo";
	}
	if (value === "file_watch") {
		return t("deleteSource.fileWatch");
	}
	if (value === "manual_scan") {
		return t("deleteSource.manualScan");
	}
	if (value === "startup_scan") {
		return t("deleteSource.startupScan");
	}
	return value;
}

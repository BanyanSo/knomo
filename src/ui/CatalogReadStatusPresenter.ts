import { t } from "../i18n";
import type { CatalogCoverage } from "../types/catalog";
import type { CatalogReadStatus } from "../types/catalogView";
import type { CardFlowHeader } from "./KnomoCardFlowPresenter";

export interface CatalogReadStatusPresentationOptions {
	status: CatalogReadStatus;
	coverage: CatalogCoverage | null;
}

// 卡片流只显示需要用户处理的故障，正常后台收尾不占用内容区域。
export function getCatalogReadStatusHeaders(
	options: CatalogReadStatusPresentationOptions,
): CardFlowHeader[] {
	const headers: CardFlowHeader[] = [];

	if (options.status.content === "unavailable") {
		headers.push(summary(t("catalog.storageUnavailable"), t("catalog.retryLocalStorage"), "refresh-catalog-sync-state"));
	}
	if (options.status.catalog === "degraded") {
		headers.push(summary(t("catalog.storageUnavailable"), t("catalog.retryLocalStorage"), "refresh-catalog-sync-state"));
	} else if (options.status.catalog === "partial" && options.coverage?.sharedConfigurationComplete === false) {
		headers.push(summary(t("catalog.sharedConfigurationPartial"), t("catalog.openDiagnostics"), "open-catalog-settings"));
	}

	if (options.status.identity === "conflicted") {
		headers.push(summary(t("catalog.identityConflict"), t("catalog.openDiagnostics"), "open-catalog-settings"));
	}

	if (options.status.projection === "failed") {
		headers.push(summary(t("sync.monthlyFailed"), t("catalog.openDiagnostics"), "open-catalog-settings"));
	}

	if (options.status.migration === "attention") {
		headers.push(summary(t("catalog.legacyMigrationAttention"), t("catalog.openDiagnostics"), "open-catalog-settings"));
	} else if (options.status.migration === "unavailable") {
		headers.push(summary(t("catalog.legacyMigrationUnavailable"), t("catalog.retrySyncState"), "refresh-catalog-sync-state"));
	}

	return dedupeHeaders(headers);
}

function summary(text: string, label?: string, action?: string): CardFlowHeader {
	return label === undefined || action === undefined
		? { type: "summary", text }
		: { type: "summary", text, action: { label, action } };
}

function dedupeHeaders(headers: readonly CardFlowHeader[]): CardFlowHeader[] {
	const seen = new Set<string>();
	return headers.filter((header) => {
		if (header.type !== "summary") return true;
		const key = `${header.text}\u0000${header.action?.action ?? ""}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

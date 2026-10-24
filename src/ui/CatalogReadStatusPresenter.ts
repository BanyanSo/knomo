import { t } from "../i18n";
import type { CatalogCoverage } from "../types/catalog";
import type { CatalogReadStatus } from "../types/catalogView";
import type { CardFlowHeader } from "./KnomoCardFlowPresenter";

export interface CatalogReadStatusPresentationOptions {
	status: CatalogReadStatus;
	coverage: CatalogCoverage | null;
}

// 辅助服务报错不改变正文结果是否完整、是否仍在等待。
export function hasCatalogReadBlocker(status: CatalogReadStatus, coverage: CatalogCoverage | null = null): boolean {
	return status.settings === "unavailable" || status.content === "unavailable" || status.catalog === "degraded"
		|| status.currentConfiguration === "conflicted" || status.currentConfiguration === "unavailable"
		|| status.scan?.state === "waiting-retry" || status.scan?.state === "paused"
		|| isIncompleteIdle(status, coverage);
}

function isIncompleteIdle(status: CatalogReadStatus, coverage: CatalogCoverage | null): boolean {
	return status.scan?.state === "idle" && coverage !== null
		&& (coverage.kind !== "complete" || coverage.configurationComplete === false);
}

// 卡片流只显示需要用户处理的故障，正常后台收尾不占用内容区域。
export function getCatalogReadStatusHeaders(
	options: CatalogReadStatusPresentationOptions,
): CardFlowHeader[] {
	const headers: CardFlowHeader[] = [];
	if (options.status.settings === "unavailable") {
		return [summary(t("catalog.settingsUnavailable"), t("catalog.openDiagnostics"), "open-catalog-settings")];
	}

	if (options.status.content === "unavailable") {
		headers.push(summary(t("catalog.storageUnavailable"), t("catalog.retryLocalStorage"), "refresh-catalog-sync-state"));
	}
	if (options.status.catalog === "degraded") {
		headers.push(summary(t("catalog.storageUnavailable"), t("catalog.retryLocalStorage"), "refresh-catalog-sync-state"));
	}
	if (options.status.scan?.state === "waiting-retry") {
		headers.push(summary(t("catalog.partialReadFailed"), t("settings.attention.retry"), "refresh-catalog-sync-state"));
	}
	if (options.status.currentConfiguration === "conflicted") {
		headers.push(summary(t("catalog.currentConfigConflict"), t("catalog.openDiagnostics"), "open-catalog-settings"));
	} else if (options.status.currentConfiguration === "unavailable") {
		headers.push(summary(t("catalog.currentConfigUnavailable"), t("catalog.retrySyncState"), "refresh-catalog-sync-state"));
	}


	if (options.status.projection === "failed") {
		headers.push(summary(t("sync.monthlyFailed"), t("catalog.openDiagnostics"), "open-catalog-settings"));
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

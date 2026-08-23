import { t } from "../i18n";
import type { CatalogCoverage } from "../types/catalog";
import type { CatalogV2ReadStatus } from "../types/catalogV2View";
import type { CardFlowHeader } from "./KnomoCardFlowPresenter";

export interface CatalogReadStatusPresentationOptions {
	status: CatalogV2ReadStatus;
	coverage: CatalogCoverage | null;
}

// 各能力状态只生成非阻塞提示，不接管 Observation 列表。
export function getCatalogReadStatusHeaders(
	options: CatalogReadStatusPresentationOptions,
): CardFlowHeader[] {
	const headers: CardFlowHeader[] = [];
	const coverageText = t("catalog.coveragePartial", {
		covered: options.coverage?.coveredFileCount ?? 0,
		total: options.coverage?.totalFileCount ?? 0,
	});

	if (options.status.content === "unavailable") {
		headers.push(summary(t("catalog.storageUnavailable"), t("catalog.retryLocalStorage"), "refresh-catalog-sync-state"));
	} else if (options.status.content === "scanning") {
		headers.push(summary(coverageText, t("catalog.retrySyncState"), "refresh-catalog-sync-state"));
	}
	if (options.status.catalog === "degraded") {
		headers.push(summary(t("catalog.storageUnavailable"), t("catalog.retryLocalStorage"), "refresh-catalog-sync-state"));
	} else if (options.status.catalog === "partial") {
		headers.push(summary(coverageText, t("catalog.retrySyncState"), "refresh-catalog-sync-state"));
	}

	if (options.status.identity === "syncing") {
		headers.push(summary(
			t("catalog.stateSettling"),
			t("catalog.retrySyncState"),
			"refresh-catalog-sync-state",
		));
	} else if (options.status.identity === "conflicted") {
		headers.push(summary(t("catalog.attentionDesc"), t("catalog.openDiagnostics"), "open-catalog-settings"));
	}

	if (options.status.projection === "stale") {
		headers.push(summary(t("sync.pendingMonthly")));
	} else if (options.status.projection === "failed") {
		headers.push(summary(t("sync.monthlyFailed"), t("catalog.openDiagnostics"), "open-catalog-settings"));
	}

	if (options.status.migration === "detected") {
		headers.push(summary(t("catalog.legacyDetectedDesc"), t("catalog.openDiagnostics"), "open-catalog-settings"));
	} else if (options.status.migration === "running") {
		headers.push(summary(
			t("catalog.upgradeBuilding", {
				covered: options.coverage?.coveredFileCount ?? 0,
				total: options.coverage?.totalFileCount ?? 0,
			}),
			t("catalog.openUpgrade"),
			"open-catalog-settings",
		));
	} else if (options.status.migration === "attention") {
		headers.push(summary(t("catalog.attentionDesc"), t("catalog.openDiagnostics"), "open-catalog-settings"));
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

import type { RecordStatsSnapshot, RecordStatsView } from "../services/RecordStatsService";
import type { MemoViewItem as MemoRecord } from "../types/memoView";
import { formatDatePart } from "../utils/date";
import { getMemoListStateKey, getMemoRenderKey } from "./MemoRenderRevision";
import type { CardFlowHeader, CardFlowPresentation } from "./KnomoCardFlowPresenter";
import type { RecordStatsSearchFilter, ScopeFilter, SearchDateFilter } from "./viewFilters";
import { getRecordStatsSearchFilterKey } from "./viewFilters";
import type { SidebarNav } from "./viewNavigation";
import { getVisibleCardFlowMemoStateKey } from "./KnomoCardFlow";

export type CardFlowChangeIntent = "content-change" | "view-scope-change";

interface CardFlowViewStateKeyOptions {
	activeNav: SidebarNav;
	scopeFilter: ScopeFilter;
	activeTagKey: string | null;
	searchQuery: string;
	searchDateFilter: SearchDateFilter | null;
	recordStatsSearchFilter: RecordStatsSearchFilter | null;
}

interface CardFlowStateKeyOptions {
	activeNav: SidebarNav;
	recordStatsSnapshot: RecordStatsSnapshot;
	recordStatsView: RecordStatsView;
	recordStatsSelectedDate: Date;
	today: Date;
	presentation: CardFlowPresentation;
}

interface VisibleCardFlowStateKeyOptions extends CardFlowStateKeyOptions {
	renderedCardCount: number;
	initialBatchSize: number;
}

interface MobileSearchViewStateKeyOptions {
	query: string;
	dateFilter: SearchDateFilter | null;
	recordStatsFilter: RecordStatsSearchFilter | null;
}

interface MobileSearchStateKeyOptions extends MobileSearchViewStateKeyOptions {
	open: boolean;
	visibleMemos: readonly MemoRecord[];
}

export function getStateKey(parts: readonly (string | number)[]): string {
	return parts.map((part) => {
		const value = String(part);
		return `${value.length}:${value}`;
	}).join("");
}

export function getCardFlowViewStateKey(options: CardFlowViewStateKeyOptions): string {
	return getStateKey([
		options.activeNav,
		options.scopeFilter,
		options.activeTagKey ?? "",
		options.searchQuery.trim().toLowerCase(),
		options.searchDateFilter ?? "",
		getRecordStatsSearchFilterKey(options.recordStatsSearchFilter),
	]);
}

export function getCardFlowChangeIntent(
	previousViewStateKey: string,
	options: CardFlowViewStateKeyOptions,
): CardFlowChangeIntent {
	return getChangeIntent(previousViewStateKey, getCardFlowViewStateKey(options));
}

export function getCardFlowStateKey(options: CardFlowStateKeyOptions): string {
	if (options.activeNav === "record-stats") {
		const renderState = options.recordStatsSnapshot.state === "idle"
			? "loading"
			: options.recordStatsSnapshot.state;
		return getStateKey([
			"record-stats",
			renderState,
			options.recordStatsSnapshot.error ?? "",
			options.recordStatsSnapshot.updating ? "updating" : "settled",
			options.recordStatsView,
			formatDatePart(options.recordStatsSelectedDate),
			formatDatePart(options.today),
		]);
	}
	if (options.presentation.type === "empty") {
		return getStateKey(["empty", options.presentation.title, options.presentation.description]);
	}
	if (options.presentation.type === "onboarding") {
		return getStateKey([
			"onboarding",
			options.presentation.title,
			options.presentation.description,
			...options.presentation.actions.flatMap((action) => [action.label, action.action]),
		]);
	}
	return getStateKey([
		"items",
		options.presentation.mode,
		getCardFlowHeadersStateKey(options.presentation.headers),
		getMemoListStateKey(options.presentation.memos),
	]);
}

export function getVisibleCardFlowStateKey(options: VisibleCardFlowStateKeyOptions): string {
	if (options.activeNav === "record-stats") {
		return getCardFlowStateKey(options);
	}
	if (options.presentation.type === "empty") {
		return getStateKey(["empty", options.presentation.title, options.presentation.description]);
	}
	if (options.presentation.type === "onboarding") {
		return getCardFlowStateKey(options);
	}
	return `${options.presentation.mode}:${getVisibleCardFlowMemoStateKey(
		options.presentation.memos,
		options.renderedCardCount,
		options.initialBatchSize,
	)}`;
}

export function getMobileSearchViewStateKey(options: MobileSearchViewStateKeyOptions): string {
	return getStateKey([
		options.query.trim().toLowerCase(),
		options.dateFilter ?? "",
		getRecordStatsSearchFilterKey(options.recordStatsFilter),
	]);
}

export function getMobileSearchChangeIntent(
	previousViewStateKey: string,
	options: MobileSearchViewStateKeyOptions,
): CardFlowChangeIntent {
	return getChangeIntent(previousViewStateKey, getMobileSearchViewStateKey(options));
}

export function getMobileSearchStateKey(options: MobileSearchStateKeyOptions): string {
	if (!options.open) {
		return "closed";
	}
	return getStateKey([
		options.query.trim().toLowerCase(),
		options.dateFilter ?? "",
		getRecordStatsSearchFilterKey(options.recordStatsFilter),
		getMemoListStateKey(options.visibleMemos),
	]);
}

export function getMobileSearchIdsKey(open: boolean, visibleMemos: readonly MemoRecord[]): string {
	if (!open) {
		return "closed";
	}
	return visibleMemos.map(getMemoRenderKey).join("\n");
}

function getChangeIntent(previousViewStateKey: string, currentViewStateKey: string): CardFlowChangeIntent {
	return previousViewStateKey === currentViewStateKey
		? "content-change"
		: "view-scope-change";
}

function getCardFlowHeadersStateKey(headers: readonly CardFlowHeader[]): string {
	return headers.map((header) => {
		if (header.type === "summary") {
			return getStateKey([header.type, header.text, header.action?.label ?? "", header.action?.action ?? ""]);
		}
		if (header.type === "random-toolbar") {
			return getStateKey([header.type, header.count]);
		}
		return getStateKey([
			header.type,
			header.selectedDate,
			header.stats.memoCount,
			header.stats.wordCount,
			header.stats.tagCount,
			header.stats.imageCount,
			header.stats.linkCount,
		]);
	}).join("");
}

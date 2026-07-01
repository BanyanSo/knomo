import type { SelectedRecordStats } from "../services/RecordStatsService";
import type { RecordStatsSearchFilter } from "./viewFilters";

export type RecordStatsMetricFilterType =
	| "range"
	| "with-tag"
	| "no-tag"
	| "with-image"
	| "references"
	| "max-daily-notes"
	| "max-daily-words";

export function getRecordStatsTrendSearchFilter(
	selected: SelectedRecordStats | null,
	key: string | null,
	unit: string | null,
): RecordStatsSearchFilter | null {
	if (key === null || selected?.trend.some((point) => point.key === key && point.count > 0) !== true) {
		return null;
	}
	if (unit === "day" && /^\d{4}-\d{2}-\d{2}$/.test(key)) {
		return { type: "day", date: key };
	}
	if (unit === "month" && /^\d{4}-\d{2}$/.test(key)) {
		return { type: "month", month: key };
	}
	return null;
}

export function getRecordStatsHourSearchFilter(
	selected: SelectedRecordStats | null,
	hourText: string,
): RecordStatsSearchFilter | null {
	const hour = Number(hourText);
	if (
		!Number.isInteger(hour)
		|| hour < 0
		|| hour > 23
		|| selected?.activeHours[hour]?.count === 0
	) {
		return null;
	}
	if (selected === null) {
		return null;
	}
	return {
		type: "hour",
		startDate: selected.startDate,
		endDateExclusive: selected.endDateExclusive,
		hour,
	};
}

export function getRecordStatsMetricSearchFilter(
	selected: SelectedRecordStats | null,
	type: RecordStatsMetricFilterType,
): RecordStatsSearchFilter | null {
	if (selected === null) {
		return null;
	}
	if (type === "range" && selected.range.memoCount > 0) {
		return {
			type,
			startDate: selected.startDate,
			endDateExclusive: selected.endDateExclusive,
		};
	}
	if (type === "references" && selected.range.referenceMemoCount > 0) {
		return {
			type,
			startDate: selected.startDate,
			endDateExclusive: selected.endDateExclusive,
		};
	}
	if (type === "with-tag" && selected.range.taggedMemoCount > 0) {
		return {
			type,
			startDate: selected.startDate,
			endDateExclusive: selected.endDateExclusive,
		};
	}
	if (type === "no-tag" && selected.range.untaggedMemoCount > 0) {
		return {
			type,
			startDate: selected.startDate,
			endDateExclusive: selected.endDateExclusive,
		};
	}
	if (type === "with-image" && selected.range.imageMemoCount > 0) {
		return {
			type,
			startDate: selected.startDate,
			endDateExclusive: selected.endDateExclusive,
		};
	}
	if (type === "max-daily-notes" && selected.range.maxDailyMemoCount > 0) {
		return { type, dates: [...selected.range.maxDailyMemoDates] };
	}
	if (type === "max-daily-words" && selected.range.maxDailyWordCount > 0) {
		return { type, dates: [...selected.range.maxDailyWordDates] };
	}
	return null;
}

export function getRecordStatsTagSearchFilter(
	selected: SelectedRecordStats | null,
	tagKey: string | null,
): RecordStatsSearchFilter | null {
	const tag = tagKey === null ? undefined : selected?.commonTags.find((item) => item.key === tagKey);
	if (selected === null || tag === undefined || tag.count <= 0) {
		return null;
	}
	return {
		type: "tag",
		startDate: selected.startDate,
		endDateExclusive: selected.endDateExclusive,
		tagKey: tag.key,
		tagLabel: tag.label,
	};
}

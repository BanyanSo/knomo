import { getKnomoLocale, t } from "../i18n";
import type { CardFlowHeader } from "./KnomoCardFlowPresenter";
import type { ShuffleDayStats } from "../utils/shuffleDay";

type LoadMoreAction = "load-more" | "load-more-mobile-search" | "load-more-time-buoy-cards";

interface RenderLoadMoreButtonOptions {
	remainingCount: number;
	action: LoadMoreAction;
	extraClass?: string;
	sentinel?: boolean;
}

export function renderKnomoListSummary(container: HTMLElement, text: string): HTMLElement {
	return container.createDiv({
		cls: "knomo-list-summary",
		text,
	});
}

export function renderKnomoRandomReunionToolbar(container: HTMLElement, count: number): HTMLElement {
	const toolbar = container.createDiv({ cls: "knomo-list-toolbar" });
	renderKnomoListSummary(toolbar, t("list.randomSummary", { count }));
	toolbar.createEl("button", {
		cls: "knomo-inline-button",
		text: t("list.randomRefresh"),
		attr: {
			type: "button",
			"data-action": "refresh-random-reunion",
		},
	});
	return toolbar;
}

export function renderKnomoShuffleDayHeader(
	container: HTMLElement,
	selectedDate: string,
	stats: ShuffleDayStats,
): HTMLElement {
	const header = container.createDiv({ cls: "knomo-shuffle-day-header" });
	header.createDiv({ cls: "knomo-shuffle-day-date", text: formatShuffleDayDateTitle(selectedDate) });
	const summary = formatShuffleDaySummary(stats);
	if (summary.length > 0) {
		header.createDiv({ cls: "knomo-shuffle-day-summary", text: summary });
	}
	return header;
}

export function renderKnomoCardFlowHeaders(container: HTMLElement, headers: CardFlowHeader[]): HTMLElement[] {
	return headers.map((header) => {
		if (header.type === "random-toolbar") {
			return renderKnomoRandomReunionToolbar(container, header.count);
		}
		if (header.type === "shuffle-day") {
			return renderKnomoShuffleDayHeader(container, header.selectedDate, header.stats);
		}
		return renderKnomoListSummary(container, header.text);
	});
}

export function renderKnomoLoadMoreButton(container: HTMLElement, options: RenderLoadMoreButtonOptions): HTMLButtonElement {
	const attr: Record<string, string> = {
		type: "button",
		"data-action": options.action,
	};
	if (options.sentinel === true) {
		attr["data-load-more-sentinel"] = "true";
	}
	const cls = options.extraClass === undefined
		? "knomo-load-more"
		: `knomo-load-more ${options.extraClass}`;
	return container.createEl("button", {
		cls,
		text: t("list.loadMore", { count: options.remainingCount }),
		attr,
	});
}

export function renderKnomoEmptyState(container: HTMLElement, title = t("empty.generic"), description = ""): HTMLElement {
	const emptyState = container.createDiv({ cls: "knomo-empty-state" });
	emptyState.createDiv({ cls: "knomo-empty-title", text: title });
	if (description.length > 0) {
		emptyState.createDiv({ cls: "knomo-empty-description", text: description });
	}
	return emptyState;
}

function formatShuffleDayDateTitle(selectedDate: string): string {
	const date = parseDateKey(selectedDate);
	if (date === null) {
		return selectedDate;
	}
	const locale = getKnomoLocale();
	const weekday = new Intl.DateTimeFormat(locale, { weekday: "long" }).format(date);
	const separator = t("filterSummary.separator");
	if (locale === "zh-CN") {
		return `${selectedDate}${separator}${weekday}`;
	}
	const dateText = new Intl.DateTimeFormat("en", {
		month: "short",
		day: "numeric",
		year: "numeric",
	}).format(date);
	return `${dateText}${separator}${weekday}`;
}

function formatShuffleDaySummary(stats: ShuffleDayStats): string {
	const parts = [
		stats.memoCount > 0 ? formatShuffleDayCount(stats.memoCount, "memo") : null,
		stats.wordCount > 0 ? formatShuffleDayCount(stats.wordCount, "word") : null,
		stats.tagCount > 0 ? formatShuffleDayCount(stats.tagCount, "tag") : null,
		stats.imageCount > 0 ? formatShuffleDayCount(stats.imageCount, "image") : null,
		stats.linkCount > 0 ? formatShuffleDayCount(stats.linkCount, "link") : null,
	].filter((part): part is string => part !== null);
	return parts.join(t("filterSummary.separator"));
}

function formatShuffleDayCount(count: number, metric: "memo" | "word" | "tag" | "image" | "link"): string {
	const keys = {
		memo: ["shuffleDay.summary.memoOne", "shuffleDay.summary.memoOther"],
		word: ["shuffleDay.summary.wordOne", "shuffleDay.summary.wordOther"],
		tag: ["shuffleDay.summary.tagOne", "shuffleDay.summary.tagOther"],
		image: ["shuffleDay.summary.imageOne", "shuffleDay.summary.imageOther"],
		link: ["shuffleDay.summary.linkOne", "shuffleDay.summary.linkOther"],
	} as const;
	const key = count === 1 ? keys[metric][0] : keys[metric][1];
	return t(key, { count });
}

function parseDateKey(value: string): Date | null {
	const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
	if (match === null) {
		return null;
	}
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const date = new Date(year, month - 1, day);
	if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
		return null;
	}
	return date;
}

import { getKnomoLocale, t } from "../i18n";
import type { CardFlowHeader } from "./KnomoCardFlowPresenter";
import type { ShuffleDayStats } from "../utils/shuffleDay";

type LoadMoreAction = "load-more" | "load-more-mobile-search" | "load-more-time-buoy-cards";

interface RenderLoadMoreButtonOptions {
	remainingCount: number | null;
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

export function renderKnomoActionableListSummary(
	container: HTMLElement,
	text: string,
	action: { label: string; action: string },
): HTMLElement {
	const summary = container.createDiv({ cls: "knomo-list-summary knomo-catalog-status" });
	summary.createSpan({ text });
	summary.createEl("button", {
		cls: "knomo-inline-button",
		text: action.label,
		attr: { type: "button", "data-action": action.action },
	});
	return summary;
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
	stats: ShuffleDayStats | null,
	action?: { label: string; action: string },
): HTMLElement {
	const header = container.createDiv({ cls: "knomo-shuffle-day-header" });
	header.createDiv({ cls: "knomo-shuffle-day-date", text: formatShuffleDayDateTitle(selectedDate) });
	const summary = stats === null ? "" : formatShuffleDaySummary(stats);
	const summaryContainer = action ? header.createDiv({ cls: "knomo-list-toolbar" }) : header;
	if (summary.length > 0) {
		summaryContainer.createDiv({ cls: action ? "knomo-shuffle-day-summary knomo-list-summary" : "knomo-shuffle-day-summary", text: summary });
	}
	if (action) {
		summaryContainer.createEl("button", {
			cls: "knomo-inline-button", text: action.label,
			attr: { type: "button", "data-action": action.action },
		});
	}
	return header;
}

const lastFeedback = new WeakMap<HTMLElement, string>();
const historyHeaders = new WeakMap<HTMLElement, { context: string; elements: Map<string, HTMLElement>; rendered: HTMLElement[] }>();

// 仅复用历史浏览中的操作表面；内容更新不替换触摸目标，切页后旧节点不再使用。
export function syncKnomoCardFlowHeaders(container: HTMLElement, headers: CardFlowHeader[], context: string, announcement?: { key: string; context: string }): HTMLElement[] {
	const previous = historyHeaders.get(container);
	const occurrences = new Map<string, number>();
	const keys = headers.map(header => {
		const key = header.type === "random-toolbar" ? header.type
			: header.type === "random-day" ? `${header.type}:${header.selectedDate}`
			: header.type === "summary" && header.action?.action === "retry-random-day" ? header.action.action : null;
		if (key === null) return null;
		const occurrence = occurrences.get(key) ?? 0;
		occurrences.set(key, occurrence + 1);
		return `${key}:${occurrence}`;
	});
	const reused = keys.map(key => {
		const element = key !== null && previous?.context === context ? previous.elements.get(key) : undefined;
		return element?.parentElement === container ? element : undefined;
	});
	// 先清理全部过期头部，避免旧提示占位导致仍在使用的工具栏被移动。
	for (const element of previous?.rendered ?? []) {
		if (!reused.includes(element)) element.remove();
	}
	const elements = renderKnomoCardFlowHeaders(container, headers, announcement, reused);
	historyHeaders.set(container, { context, elements: new Map(keys.flatMap((key, index) => key === null ? [] : [[key, elements[index]]])), rendered: elements });
	// 只定位新增或确实换序的头部；原位节点不能先移除再插回。
	let next = container.firstElementChild;
	for (const element of elements) {
		if (element !== next) container.insertBefore(element, next);
		next = element.nextElementSibling;
	}
	return elements;
}

function updateHeaderText(element: HTMLElement | null, text: string): void {
	if (element !== null && element.textContent !== text) element.setText(text);
}

export function renderKnomoCardFlowHeaders(container: HTMLElement, headers: CardFlowHeader[], announcement?: { key: string; context: string }, reused: readonly (HTMLElement | undefined)[] = []): HTMLElement[] {
	const feedback = JSON.stringify([announcement?.context, headers.flatMap(header => header.type === "summary" && header.feedback ? [header.text] : [])]);
	const changed = feedback !== (announcement?.key ?? lastFeedback.get(container));
	if (announcement) announcement.key = feedback;
	lastFeedback.set(container, feedback);
	return headers.map((header, index) => {
		const existing = reused[index];
		if (header.type === "random-day") {
			if (existing) {
				updateHeaderText(existing.querySelector(".knomo-shuffle-day-date"), formatShuffleDayDateTitle(header.selectedDate));
				const toolbar = existing.querySelector<HTMLElement>(".knomo-list-toolbar")!;
				const button = toolbar.querySelector<HTMLButtonElement>("button")!;
				const text = header.stats === null ? "" : formatShuffleDaySummary(header.stats);
				let summary = toolbar.querySelector<HTMLElement>(".knomo-shuffle-day-summary");
				if (text && !summary) {
					summary = toolbar.createDiv({ cls: "knomo-shuffle-day-summary knomo-list-summary" });
					toolbar.insertBefore(summary, button);
				}
				if (text) updateHeaderText(summary, text);
				else summary?.remove();
				updateHeaderText(button, t("random.dayBack"));
				return existing;
			}
			return renderKnomoShuffleDayHeader(container, header.selectedDate, header.stats, {
				label: t("random.dayBack"), action: "random-day-back",
			});
		}
		if (header.type === "random-toolbar") {
			if (existing) {
				updateHeaderText(existing.querySelector(".knomo-list-summary"), t("list.randomSummary", { count: header.count }));
				updateHeaderText(existing.querySelector("button"), t("list.randomRefresh"));
				return existing;
			}
			return renderKnomoRandomReunionToolbar(container, header.count);
		}
		if (header.type === "trash-toolbar") {
			const toolbar = container.createDiv({ cls: "knomo-list-toolbar" });
			renderKnomoListSummary(toolbar, t(header.count === 1 ? "trash.summaryOne" : "trash.summary", { count: header.count }));
			const button = toolbar.createEl("button", {
				cls: "knomo-inline-button is-danger",
				text: t("trash.clear"),
				attr: { type: "button", "data-action": "clear-trash", "aria-busy": String(header.busy) },
			});
			button.disabled = header.busy;
			return toolbar;
		}
		if (header.type === "shuffle-day") {
			return renderKnomoShuffleDayHeader(container, header.selectedDate, header.stats);
		}
		const summary = existing ?? (header.action !== undefined ? renderKnomoActionableListSummary(container, header.text, header.action)
			: renderKnomoListSummary(container, header.text));
		if (header.relationCount) summary.addClass("knomo-relation-result-count");
		if (existing && header.action) {
			updateHeaderText(summary.querySelector("span"), header.text);
			updateHeaderText(summary.querySelector("button"), header.action.label);
		}
		if (header.feedback) summary.setAttrs({ role: "status", "aria-live": changed ? "polite" : "off", "aria-atomic": "true" });
		else if (existing) for (const name of ["role", "aria-live", "aria-atomic"]) summary.removeAttribute(name);
		return summary;
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
		text: options.remainingCount === null ? t("list.loadMoreUnknown") : t("list.loadMore", { count: options.remainingCount }),
		attr,
	});
}

export function renderKnomoEmptyState(container: HTMLElement, title = t("empty.generic"), description = "", loading = false): HTMLElement {
	const emptyState = container.createDiv({ cls: "knomo-empty-state" });
	if (loading) {
		emptyState.setAttrs({ role: "status", "aria-live": "polite", "aria-atomic": "true" });
	}
	emptyState.createDiv({ cls: "knomo-empty-title", text: title });
	if (description.length > 0) {
		emptyState.createDiv({ cls: "knomo-empty-description", text: description });
	}
	return emptyState;
}

export function renderKnomoLoadingPlaceholder(container: HTMLElement, visible: boolean, announce = true): HTMLElement {
	const placeholder = container.createDiv({ cls: "knomo-loading-placeholder", attr: { "aria-busy": "true",
		...(visible && announce ? { role: "status", "aria-live": "polite", "aria-label": t("loading.label") } : {}) } });
	if (!visible) return placeholder;
	const skeleton = placeholder.createDiv({ cls: "knomo-loading-skeleton", attr: { "aria-hidden": "true" } });
	for (let index = 0; index < 3; index++) {
		const card = skeleton.createDiv({ cls: "knomo-loading-card" });
		card.createDiv({ cls: "knomo-loading-line is-short" });
		card.createDiv({ cls: "knomo-loading-line" });
		card.createDiv({ cls: "knomo-loading-line" });
	}
	return placeholder;
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

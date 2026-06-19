import { setIcon } from "obsidian";

import { getKnomoLocale, t } from "../i18n";
import type {
	RecordStatsSnapshot,
	RecordStatsTrendPoint,
	RecordStatsView,
	SelectedRecordStats,
} from "../services/RecordStatsService";
import type { MemoRecord } from "../types/memo";

export interface RenderKnomoRecordStatsPageOptions {
	snapshot: RecordStatsSnapshot;
	selected: SelectedRecordStats | null;
	view: RecordStatsView;
	canAdvance: boolean;
	canRetreat: boolean;
	renderMemoPreview: (container: HTMLElement, memo: MemoRecord, renderIndex: number) => HTMLElement;
}

interface MetricItem {
	label: string;
	value: number;
}

export function renderKnomoRecordStatsPage(
	container: HTMLElement,
	options: RenderKnomoRecordStatsPageOptions,
): HTMLElement {
	const page = container.createDiv({ cls: "knomo-record-stats-page" });
	if (options.snapshot.state === "idle" || options.snapshot.state === "loading") {
		renderLoadingState(page);
		return page;
	}
	if (options.snapshot.state === "error" || options.selected === null) {
		renderErrorState(page, options.snapshot.error);
		return page;
	}
	if (options.snapshot.state === "empty") {
		renderGlobalEmptyState(page);
		return page;
	}

	renderOverview(page, options.selected);
	renderSelectedRange(page, options);
	return page;
}

function renderLoadingState(container: HTMLElement): void {
	const status = container.createDiv({
		cls: "knomo-record-stats-loading",
		attr: { role: "status", "aria-live": "polite" },
	});
	status.createDiv({ cls: "knomo-record-stats-state-title", text: t("recordStats.loading.title") });
	status.createDiv({ cls: "knomo-record-stats-state-description", text: t("recordStats.loading.desc") });
	const skeleton = status.createDiv({ cls: "knomo-record-stats-skeleton", attr: { "aria-hidden": "true" } });
	renderSkeletonGrid(skeleton, 3);
	skeleton.createDiv({ cls: "knomo-record-stats-skeleton-chart" });
	renderSkeletonGrid(skeleton, 6);
}

function renderErrorState(container: HTMLElement, error: string | null): void {
	const state = container.createDiv({ cls: "knomo-record-stats-state is-error", attr: { role: "alert" } });
	state.createDiv({ cls: "knomo-record-stats-state-title", text: t("recordStats.error.title") });
	state.createDiv({ cls: "knomo-record-stats-state-description", text: t("recordStats.error.desc") });
	if (error !== null && error.trim().length > 0) {
		state.createDiv({ cls: "knomo-record-stats-error-detail", text: error });
	}
	state.createEl("button", {
		cls: "knomo-inline-button knomo-record-stats-retry",
		text: t("recordStats.error.retry"),
		attr: { type: "button", "data-action": "record-stats-retry" },
	});
}

function renderGlobalEmptyState(container: HTMLElement): void {
	const state = container.createDiv({ cls: "knomo-record-stats-state" });
	state.createDiv({ cls: "knomo-record-stats-state-title", text: t("recordStats.empty.title") });
	state.createDiv({ cls: "knomo-record-stats-state-description", text: t("recordStats.empty.desc") });
}

function renderOverview(container: HTMLElement, selected: SelectedRecordStats): void {
	const section = createSection(container);
	renderMetricGrid(section, [
		{ label: t("recordStats.overview.notes"), value: selected.overview.memoCount },
		{ label: t("recordStats.overview.words"), value: selected.overview.wordCount },
		{ label: t("recordStats.metric.recordDays"), value: selected.overview.recordDayCount },
	], "knomo-record-stats-overview-grid");
}

function renderSelectedRange(container: HTMLElement, options: RenderKnomoRecordStatsPageOptions): void {
	const selected = options.selected;
	if (selected === null) {
		return;
	}
	const section = createSection(container, "knomo-record-stats-range-section");
	renderViewControls(section, options.view);
	renderRangeNavigation(section, selected, options.canRetreat, options.canAdvance);
	renderTrendChart(section, options.view, selected);
	renderRangeMetrics(section, options.view, selected);
	renderActiveHours(section, selected);
	renderMemoExtremes(section, selected, options.renderMemoPreview);
}

function createSection(container: HTMLElement, cls = ""): HTMLElement {
	return container.createEl("section", {
		cls: cls.length > 0 ? `knomo-record-stats-section ${cls}` : "knomo-record-stats-section",
	});
}

function renderViewControls(container: HTMLElement, view: RecordStatsView): void {
	const controls = container.createDiv({
		cls: "knomo-record-stats-view-controls",
		attr: { role: "group", "aria-label": t("recordStats.view.label") },
	});
	for (const option of ["week", "month", "year"] as const) {
		controls.createEl("button", {
			cls: option === view ? "knomo-record-stats-view-button is-active" : "knomo-record-stats-view-button",
			text: getViewLabel(option),
			attr: {
				type: "button",
				"aria-pressed": option === view ? "true" : "false",
				"data-action": `record-stats-view-${option}`,
			},
		});
	}
}

function renderRangeNavigation(
	container: HTMLElement,
	selected: SelectedRecordStats,
	canRetreat: boolean,
	canAdvance: boolean,
): void {
	const navigation = container.createDiv({ cls: "knomo-record-stats-range-navigation" });
	const previous = navigation.createEl("button", {
		cls: "knomo-record-stats-range-button",
		attr: {
			type: "button",
			"aria-label": t("recordStats.range.previous"),
			"data-tooltip-position": "top",
			"data-action": "record-stats-previous",
		},
	});
	previous.disabled = !canRetreat;
	setIcon(previous, "chevron-left");
	navigation.createDiv({
		cls: "knomo-record-stats-range-label",
		text: formatRangeLabel(selected.startDate, selected.endDateExclusive),
		attr: { "aria-live": "polite" },
	});
	const next = navigation.createEl("button", {
		cls: "knomo-record-stats-range-button",
		attr: {
			type: "button",
			"aria-label": t("recordStats.range.next"),
			"data-tooltip-position": "top",
			"data-action": "record-stats-next",
		},
	});
	next.disabled = !canAdvance;
	setIcon(next, "chevron-right");
}

function renderTrendChart(container: HTMLElement, view: RecordStatsView, selected: SelectedRecordStats): void {
	const chartSection = container.createDiv({ cls: "knomo-record-stats-chart-section" });
	const scroll = chartSection.createDiv({
		cls: view !== "week"
			? "knomo-record-stats-chart-scroll is-scrollable"
			: "knomo-record-stats-chart-scroll",
	});
	renderBarChart(scroll, selected.trend, {
		chartClass: `knomo-record-stats-chart is-${view}`,
		ariaLabel: t("recordStats.trend"),
		getVisibleLabel: (point, index) => getTrendVisibleLabel(view, point, index, selected.trend.length),
		getAriaLabel: (point, index) => t("recordStats.chart.memoCount", {
			label: getTrendAriaLabel(view, point, index),
			count: point.count,
		}),
	});
	if (selected.range.memoCount === 0) {
		chartSection.createDiv({ cls: "knomo-record-stats-chart-empty", text: t("recordStats.range.empty") });
	}
}

function renderRangeMetrics(container: HTMLElement, view: RecordStatsView, selected: SelectedRecordStats): void {
	const section = container.createDiv({ cls: "knomo-record-stats-metrics-section" });
	section.createEl("h3", { cls: "knomo-record-stats-subtitle", text: getRangeStatsTitle(view) });
	renderMetricGrid(section, [
		{ label: t("recordStats.metric.notes"), value: selected.range.memoCount },
		{ label: t("recordStats.metric.words"), value: selected.range.wordCount },
		{ label: t("recordStats.metric.recordDays"), value: selected.range.recordDayCount },
		{ label: t("recordStats.metric.references"), value: selected.range.referenceMemoCount },
		{ label: t("recordStats.metric.maxDailyNotes"), value: selected.range.maxDailyMemoCount },
		{ label: t("recordStats.metric.maxDailyWords"), value: selected.range.maxDailyWordCount },
	], "knomo-record-stats-range-grid");
}

function renderActiveHours(container: HTMLElement, selected: SelectedRecordStats): void {
	const section = container.createDiv({ cls: "knomo-record-stats-chart-section" });
	section.createEl("h3", { cls: "knomo-record-stats-subtitle", text: t("recordStats.activeHours") });
	const scroll = section.createDiv({ cls: "knomo-record-stats-chart-scroll is-scrollable" });
	const chart = renderBarChart(scroll, selected.activeHours.map((point) => ({
		key: String(point.hour),
		label: String(point.hour).padStart(2, "0"),
		count: point.count,
	})), {
		chartClass: "knomo-record-stats-chart is-hours",
		ariaLabel: t("recordStats.activeHours"),
		getVisibleLabel: (point, index) => index % 2 === 0 || index === 23 ? point.label : "",
		getAriaLabel: (point) => t("recordStats.chart.hourCount", { hour: point.label, count: point.count }),
	});
	centerChartItem(scroll, chart.children.item(12));
	if (selected.range.memoCount === 0) {
		section.createDiv({ cls: "knomo-record-stats-chart-empty", text: t("recordStats.range.empty") });
	}
}

function renderBarChart(
	container: HTMLElement,
	points: RecordStatsTrendPoint[],
	options: {
		chartClass: string;
		ariaLabel: string;
		getVisibleLabel: (point: RecordStatsTrendPoint, index: number) => string;
		getAriaLabel: (point: RecordStatsTrendPoint, index: number) => string;
	},
): HTMLElement {
	const chart = container.createDiv({
		cls: options.chartClass,
		attr: { role: "list", "aria-label": options.ariaLabel },
	});
	chart.setCssProps({ "--knomo-record-stats-columns": String(points.length) });
	const max = Math.max(0, ...points.map((point) => point.count));
	for (const [index, point] of points.entries()) {
		const item = chart.createDiv({
			cls: "knomo-record-stats-bar-item",
			attr: { role: "listitem", "aria-label": options.getAriaLabel(point, index) },
		});
		item.createDiv({
			cls: "knomo-record-stats-bar-value",
			text: point.count > 0 ? formatNumber(point.count) : "",
		});
		item.createDiv({ cls: "knomo-record-stats-bar-track" }).createDiv({ cls: "knomo-record-stats-bar" }).setCssProps({
			"--knomo-record-stats-ratio": max === 0 ? "0" : String(point.count / max),
		});
		item.createDiv({ cls: "knomo-record-stats-bar-label", text: options.getVisibleLabel(point, index) });
	}
	return chart;
}

function centerChartItem(scroll: HTMLElement, item: Element | null): void {
	if (item === null) {
		return;
	}
	const scrollRect = scroll.getBoundingClientRect();
	const itemRect = item.getBoundingClientRect();
	scroll.scrollLeft += itemRect.left + itemRect.width / 2 - scrollRect.left - scrollRect.width / 2;
}

function renderMemoExtremes(
	container: HTMLElement,
	selected: SelectedRecordStats,
	renderMemoPreview: RenderKnomoRecordStatsPageOptions["renderMemoPreview"],
): void {
	const grid = container.createDiv({ cls: "knomo-record-stats-memo-grid" });
	renderMemoExtreme(grid, t("recordStats.earliest"), selected.earliestMemo, 0, renderMemoPreview);
	renderMemoExtreme(grid, t("recordStats.latest"), selected.latestMemo, 1, renderMemoPreview);
}

function renderMemoExtreme(
	container: HTMLElement,
	title: string,
	memo: MemoRecord | null,
	renderIndex: number,
	renderMemoPreview: RenderKnomoRecordStatsPageOptions["renderMemoPreview"],
): void {
	const section = container.createEl("section", { cls: "knomo-record-stats-memo-section" });
	section.createEl("h3", { cls: "knomo-record-stats-subtitle", text: title });
	if (memo === null) {
		section.createDiv({ cls: "knomo-record-stats-memo-empty", text: t("recordStats.range.empty") });
		return;
	}
	const card = renderMemoPreview(section, memo, renderIndex);
	card.addClass("knomo-record-stats-memo-preview");
}

function renderMetricGrid(container: HTMLElement, items: MetricItem[], cls: string): void {
	const grid = container.createDiv({ cls: `knomo-record-stats-metric-grid ${cls}` });
	for (const item of items) {
		const metric = grid.createDiv({ cls: "knomo-record-stats-metric" });
		metric.createDiv({ cls: "knomo-record-stats-metric-value", text: formatNumber(item.value) });
		metric.createDiv({ cls: "knomo-record-stats-metric-label", text: item.label });
	}
}

function renderSkeletonGrid(container: HTMLElement, count: number): void {
	const grid = container.createDiv({ cls: "knomo-record-stats-skeleton-grid" });
	for (let index = 0; index < count; index += 1) {
		grid.createDiv({ cls: "knomo-record-stats-skeleton-item" });
	}
}

function getViewLabel(view: RecordStatsView): string {
	if (view === "week") return t("recordStats.view.week");
	if (view === "month") return t("recordStats.view.month");
	return t("recordStats.view.year");
}

function getRangeStatsTitle(view: RecordStatsView): string {
	if (view === "week") return t("recordStats.rangeStats.week");
	if (view === "month") return t("recordStats.rangeStats.month");
	return t("recordStats.rangeStats.year");
}

function getTrendVisibleLabel(
	view: RecordStatsView,
	point: RecordStatsTrendPoint,
	index: number,
	pointCount: number,
): string {
	if (view === "week") {
		return [
			t("recordStats.weekday.mon"),
			t("recordStats.weekday.tue"),
			t("recordStats.weekday.wed"),
			t("recordStats.weekday.thu"),
			t("recordStats.weekday.fri"),
			t("recordStats.weekday.sat"),
			t("recordStats.weekday.sun"),
		][index] ?? point.label;
	}
	if (view === "year") {
		return t("recordStats.monthLabel", { month: point.label });
	}
	return index === 0 || index === pointCount - 1 || (index + 1) % 5 === 0 ? point.label : "";
}

function getTrendAriaLabel(view: RecordStatsView, point: RecordStatsTrendPoint, index: number): string {
	if (view === "week") {
		return getTrendVisibleLabel(view, point, index, 7);
	}
	if (view === "year") {
		return t("recordStats.monthLabel", { month: point.label });
	}
	return t("recordStats.dayLabel", { day: point.label });
}

function formatRangeLabel(startDate: string, endDateExclusive: string): string {
	const start = parseDateKey(startDate);
	const endExclusive = parseDateKey(endDateExclusive);
	if (start === null || endExclusive === null) {
		return startDate;
	}
	const end = new Date(endExclusive.year, endExclusive.month - 1, endExclusive.day - 1);
	const endParts = {
		year: end.getFullYear(),
		month: end.getMonth() + 1,
		day: end.getDate(),
	};
	const dayCount = differenceInCalendarDays(start, endParts) + 1;
	if (dayCount === 7) {
		if (start.year === endParts.year) {
			return t("recordStats.range.week", {
				year: start.year,
				startMonth: padNumber(start.month),
				startDay: padNumber(start.day),
				endMonth: padNumber(endParts.month),
				endDay: padNumber(endParts.day),
			});
		}
		return t("recordStats.range.weekCrossYear", {
			startYear: start.year,
			startMonth: padNumber(start.month),
			startDay: padNumber(start.day),
			endYear: endParts.year,
			endMonth: padNumber(endParts.month),
			endDay: padNumber(endParts.day),
		});
	}
	if (start.day === 1 && endParts.year === start.year && endParts.month === start.month) {
		return t("recordStats.range.month", { year: start.year, month: padNumber(start.month) });
	}
	return t("recordStats.range.year", { year: start.year });
}

function differenceInCalendarDays(
	start: { year: number; month: number; day: number },
	end: { year: number; month: number; day: number },
): number {
	return Math.round((Date.UTC(end.year, end.month - 1, end.day) - Date.UTC(start.year, start.month - 1, start.day)) / 86400000);
}

function parseDateKey(value: string): { year: number; month: number; day: number } | null {
	const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
	if (match === null) {
		return null;
	}
	return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

function padNumber(value: number): string {
	return String(value).padStart(2, "0");
}

function formatNumber(value: number): string {
	return new Intl.NumberFormat(getKnomoLocale()).format(value);
}

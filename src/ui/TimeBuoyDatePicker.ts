import { getLanguage, moment as obsidianMoment, setIcon } from "obsidian";

import { getKnomoLocale, t } from "../i18n";
import { addTimeBuoyCalendarDays, formatTimeBuoyDate } from "../utils/timeBuoyDate";

export type TimeBuoyPickerSource = "button" | "at-input";

export interface TimeBuoyDatePickerState {
	source: TimeBuoyPickerSource;
	mobile: boolean;
	browseYear: number;
	browseMonth: number;
	today: Date;
}

export function getTimeBuoyPickerLeft(
	containerWidth: number,
	anchorOffset: number,
	pickerWidth: number,
	margin = 12,
): number {
	const minLeft = margin;
	const maxLeft = Math.max(minLeft, containerWidth - margin - pickerWidth);
	return Math.max(minLeft, Math.min(anchorOffset, maxLeft));
}

export function renderTimeBuoyDatePicker(
	container: HTMLElement,
	id: string,
	state: TimeBuoyDatePickerState,
): HTMLElement {
	const isModal = state.mobile;
	const picker = container.createDiv({
		cls: `knomo-time-buoy-picker${state.mobile ? " is-mobile" : " is-desktop"}${isModal ? " is-modal" : " is-context"}`,
		attr: {
			id,
			role: "dialog",
			"aria-modal": isModal ? "true" : "false",
			"aria-label": t("composer.addTimeBuoy"),
		},
	});
	const header = picker.createDiv({ cls: "knomo-time-buoy-picker-header" });
	header.createDiv({ cls: "knomo-time-buoy-picker-title", text: t("composer.addTimeBuoy") });
	const closeButton = header.createEl("button", {
		cls: "knomo-time-buoy-picker-icon-button",
		attr: {
			type: "button",
			"aria-label": t("timeBuoy.picker.close"),
			"data-time-buoy-picker-action": "cancel",
		},
	});
	setIcon(closeButton, "x");

	const shortcuts = picker.createDiv({ cls: "knomo-time-buoy-picker-shortcuts" });
	for (const [label, offset] of [
		[t("timeBuoy.picker.tomorrow"), 1],
		[t("timeBuoy.picker.after7"), 7],
		[t("timeBuoy.picker.after30"), 30],
		[t("timeBuoy.picker.after90"), 90],
	] as const) {
		const date = formatTimeBuoyDate(addTimeBuoyCalendarDays(state.today, offset));
		shortcuts.createEl("button", {
			cls: "knomo-time-buoy-picker-shortcut",
			text: label,
			attr: { type: "button", "data-time-buoy-date": date },
		});
	}

	const monthHeader = picker.createDiv({ cls: "knomo-time-buoy-picker-month-header" });
	const previous = createMonthButton(monthHeader, "chevron-left", t("timeBuoy.picker.previousMonth"), "previous-month");
	const currentMonth = new Date(state.today.getFullYear(), state.today.getMonth(), 1);
	const browseMonth = new Date(state.browseYear, state.browseMonth, 1);
	const calendarLocale = getCalendarLocale();
	previous.disabled = browseMonth.getTime() <= currentMonth.getTime();
	monthHeader.createDiv({
		cls: "knomo-time-buoy-picker-month-label",
		text: new Intl.DateTimeFormat(calendarLocale, { year: "numeric", month: "long" }).format(browseMonth),
	});
	createMonthButton(monthHeader, "chevron-right", t("timeBuoy.picker.nextMonth"), "next-month");

	const grid = picker.createDiv({ cls: "knomo-time-buoy-picker-grid", attr: { role: "grid" } });
	const weekStart = getCalendarWeekStart();
	const weekdayFormatter = new Intl.DateTimeFormat(calendarLocale, { weekday: "narrow" });
	for (let offset = 0; offset < 7; offset += 1) {
		const day = new Date(2026, 0, 4 + ((weekStart + offset) % 7));
		grid.createDiv({
			cls: "knomo-time-buoy-picker-weekday",
			text: weekdayFormatter.format(day),
			attr: { role: "columnheader" },
		});
	}
	const firstWeekday = (browseMonth.getDay() - weekStart + 7) % 7;
	const gridStart = new Date(state.browseYear, state.browseMonth, 1 - firstWeekday);
	const todayText = formatTimeBuoyDate(state.today);
	for (let offset = 0; offset < 42; offset += 1) {
		const date = addTimeBuoyCalendarDays(gridStart, offset);
		const dateText = formatTimeBuoyDate(date);
		const today = dateText === todayText;
		const disabled = dateText < todayText;
		const button = grid.createEl("button", {
			cls: "knomo-time-buoy-picker-day",
			text: String(date.getDate()),
			attr: {
				type: "button",
				role: "gridcell",
				"aria-label": dateText,
				"aria-disabled": disabled ? "true" : "false",
				...(today ? { "aria-current": "date" } : {}),
				tabindex: today ? "0" : "-1",
				"data-time-buoy-date": dateText,
			},
		});
		button.toggleClass("is-adjacent", date.getMonth() !== state.browseMonth);
		button.toggleClass("is-today", today);
		button.disabled = disabled;
	}
	return picker;
}

function getCalendarLocale(): string {
	try {
		const language = getLanguage();
		return typeof language === "string" && language.trim().length > 0 ? language : getKnomoLocale();
	} catch {
		return getKnomoLocale();
	}
}

function getCalendarWeekStart(): number {
	try {
		const momentWithLocaleData = obsidianMoment as typeof obsidianMoment & {
			localeData?: () => { firstDayOfWeek?: () => number };
		};
		const firstDay = momentWithLocaleData.localeData?.().firstDayOfWeek?.();
		if (typeof firstDay === "number" && firstDay >= 0 && firstDay <= 6) {
			return firstDay;
		}
	} catch {
		// 回退到 Knomo 当前支持语言的常见周起始日。
	}
	return getKnomoLocale() === "zh-CN" ? 1 : 0;
}

function createMonthButton(
	container: HTMLElement,
	icon: string,
	label: string,
	action: string,
): HTMLButtonElement {
	const button = container.createEl("button", {
		cls: "knomo-time-buoy-picker-icon-button",
		attr: {
			type: "button",
			"aria-label": label,
			"data-time-buoy-picker-action": action,
		},
	});
	setIcon(button, icon);
	return button;
}

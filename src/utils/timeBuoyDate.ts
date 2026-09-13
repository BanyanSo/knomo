import type { TimeBuoyDateStatus } from "../types/timeBuoy";

const DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseTimeBuoyDate(value: string): Date | null {
	const match = DATE_KEY_PATTERN.exec(value);
	if (match === null) {
		return null;
	}
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) {
		return null;
	}
	const date = new Date(0);
	date.setHours(0, 0, 0, 0);
	date.setFullYear(year, month - 1, day);
	if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
		return null;
	}
	return date;
}

export function isValidTimeBuoyDate(value: string): boolean {
	return parseTimeBuoyDate(value) !== null;
}

export function formatTimeBuoyDate(date: Date): string {
	return [
		String(date.getFullYear()).padStart(4, "0"),
		String(date.getMonth() + 1).padStart(2, "0"),
		String(date.getDate()).padStart(2, "0"),
	].join("-");
}

export function addTimeBuoyCalendarDays(date: Date, days: number): Date {
	const nextDate = new Date(date.getTime());
	nextDate.setHours(0, 0, 0, 0);
	nextDate.setDate(nextDate.getDate() + days);
	return nextDate;
}

export function getTimeBuoyDateStatus(targetDate: string, today = new Date()): TimeBuoyDateStatus | null {
	if (!isValidTimeBuoyDate(targetDate)) {
		return null;
	}
	const todayKey = formatTimeBuoyDate(today);
	if (targetDate === todayKey) {
		return "today";
	}
	return targetDate > todayKey ? "upcoming" : "past";
}

export function getTimeBuoyCardStatus(targetDates: readonly string[], today = new Date()): TimeBuoyDateStatus | null {
	let fallback: TimeBuoyDateStatus | null = null;
	for (const targetDate of targetDates) {
		const status = getTimeBuoyDateStatus(targetDate, today);
		if (status === "today") {
			return status;
		}
		if (status === "upcoming") {
			fallback = status;
		} else if (status === "past" && fallback === null) {
			fallback = status;
		}
	}
	return fallback;
}

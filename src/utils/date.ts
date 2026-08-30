import type { MemoTimeFormat } from "../types/settings";

function padNumber(value: number, length: number): string {
	return value.toString().padStart(length, "0");
}

export function formatDatePart(date: Date): string {
	const year = date.getFullYear();
	const month = padNumber(date.getMonth() + 1, 2);
	const day = padNumber(date.getDate(), 2);
	return `${year}-${month}-${day}`;
}

export function formatTimePart(date: Date, format: MemoTimeFormat = "HH:mm:ss"): string {
	const hours = padNumber(date.getHours(), 2);
	const minutes = padNumber(date.getMinutes(), 2);
	const seconds = padNumber(date.getSeconds(), 2);
	if (format === "HH:mm") {
		return `${hours}:${minutes}`;
	}
	return `${hours}:${minutes}:${seconds}`;
}

export function formatLocalIsoString(date: Date): string {
	const offsetMinutes = -date.getTimezoneOffset();
	const sign = offsetMinutes >= 0 ? "+" : "-";
	const absoluteOffset = Math.abs(offsetMinutes);
	const offsetHours = padNumber(Math.floor(absoluteOffset / 60), 2);
	const offsetRemainder = padNumber(absoluteOffset % 60, 2);
	const milliseconds = padNumber(date.getMilliseconds(), 3);
	return `${formatDatePart(date)}T${formatTimePart(date)}.${milliseconds}${sign}${offsetHours}:${offsetRemainder}`;
}

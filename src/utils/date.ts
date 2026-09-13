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

export function parseMemoCalendarDate(value: string): Date | null {
	const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:\d{2})?)?$/u.exec(value);
	if (match === null) return null;
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const hours = match[4] === undefined ? 0 : Number(match[4]);
	const minutes = match[5] === undefined ? 0 : Number(match[5]);
	const seconds = match[6] === undefined ? 0 : Number(match[6]);
	const milliseconds = Number.parseInt(`${match[7] ?? ""}000`.slice(0, 3), 10);
	const timeZone = match[8];
	const calendar = new Date(Date.UTC(year, month - 1, day, hours, minutes, seconds, milliseconds));
	if (
		calendar.getUTCFullYear() !== year ||
		calendar.getUTCMonth() !== month - 1 ||
		calendar.getUTCDate() !== day ||
		calendar.getUTCHours() !== hours ||
		calendar.getUTCMinutes() !== minutes ||
		calendar.getUTCSeconds() !== seconds ||
		calendar.getUTCMilliseconds() !== milliseconds
	) {
		return null;
	}
	if (timeZone !== undefined) {
		const instant = new Date(`${match[1]}-${match[2]}-${match[3]}T${padNumber(hours, 2)}:${padNumber(minutes, 2)}:${padNumber(seconds, 2)}.${padNumber(milliseconds, 3)}${timeZone}`);
		return Number.isNaN(instant.getTime()) ? null : instant;
	}
	const localDate = new Date(year, month - 1, day, hours, minutes, seconds, milliseconds);
	if (
		localDate.getFullYear() !== year ||
		localDate.getMonth() !== month - 1 ||
		localDate.getDate() !== day ||
		localDate.getHours() !== hours ||
		localDate.getMinutes() !== minutes ||
		localDate.getSeconds() !== seconds ||
		localDate.getMilliseconds() !== milliseconds
	) {
		return null;
	}
	return localDate;
}

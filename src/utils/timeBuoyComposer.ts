import { hasTimeBuoyDate, isTimeBuoyTriggerAt } from "./timeBuoyParser";

export interface TimeBuoyTextInsertion {
	value: string;
	cursor: number;
}

export interface TimeBuoyDirectInputChange {
	inputType: string;
	data: string | null;
	isComposing: boolean;
	selectionStart: number;
	selectionEnd: number;
}

export function getTimeBuoyTriggerStartForDirectInput(
	value: string,
	change: TimeBuoyDirectInputChange,
): number | null {
	if (
		change.isComposing
		|| change.inputType !== "insertText"
		|| (change.data !== "@" && change.data !== "＠")
		|| change.selectionStart !== change.selectionEnd
	) {
		return null;
	}
	const triggerStart = change.selectionStart - 1;
	return isTimeBuoyTriggerAt(value, triggerStart) ? triggerStart : null;
}

export function getTimeBuoyTriggerStartAfterComposition(
	value: string,
	selectionStart: number,
	selectionEnd: number,
	data: string,
): number | null {
	if (
		selectionStart !== selectionEnd
		|| (!data.endsWith("@") && !data.endsWith("＠"))
	) {
		return null;
	}
	const triggerStart = selectionStart - 1;
	return isTimeBuoyTriggerAt(value, triggerStart) ? triggerStart : null;
}

export function insertTimeBuoyDateAtSelection(
	value: string,
	selectionEnd: number,
	targetDate: string,
): TimeBuoyTextInsertion {
	const position = clampPosition(value, selectionEnd);
	return insertToken(value, position, position, targetDate);
}

export function replaceTimeBuoyTrigger(
	value: string,
	triggerStart: number,
	triggerEnd: number,
	targetDate: string,
): TimeBuoyTextInsertion | null {
	if (
		triggerStart < 0
		|| triggerEnd !== triggerStart + 1
		|| (value.slice(triggerStart, triggerEnd) !== "@" && value.slice(triggerStart, triggerEnd) !== "＠")
	) {
		return null;
	}
	return insertToken(value, triggerStart, triggerEnd, targetDate);
}

export function alreadyHasTimeBuoyDate(value: string, targetDate: string): boolean {
	return hasTimeBuoyDate(value, targetDate);
}

function insertToken(value: string, start: number, end: number, targetDate: string): TimeBuoyTextInsertion {
	const token = `@${targetDate}`;
	const before = value.slice(0, start);
	const after = value.slice(end);
	const prefix = needsBoundarySpaceBefore(before) ? " " : "";
	const suffix = needsBoundarySpaceAfter(after) ? " " : "";
	const inserted = `${prefix}${token}${suffix}`;
	const existingHorizontalSpace = suffix.length === 0 && /^[\t ]/u.test(after) ? 1 : 0;
	return {
		value: `${before}${inserted}${after}`,
		cursor: before.length + prefix.length + token.length + suffix.length + existingHorizontalSpace,
	};
}

function needsBoundarySpaceBefore(before: string): boolean {
	if (before.length === 0) {
		return false;
	}
	const previous = before[before.length - 1];
	return !/\s/u.test(previous) && !/[([{（【《「『〈〔“‘"'，。！？；：、,.!?;:]/u.test(previous);
}

function needsBoundarySpaceAfter(after: string): boolean {
	if (after.length === 0) {
		return true;
	}
	const next = after[0];
	return !/\s/u.test(next) && !/[)\]}）】》」』〉〕”’"'，。！？；：、,.!?;:]/u.test(next);
}

function clampPosition(value: string, position: number): number {
	return Math.min(value.length, Math.max(0, position));
}

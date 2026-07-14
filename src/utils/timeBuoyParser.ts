import type { TimeBuoyMatch } from "../types/timeBuoy";
import { hashText } from "./hash";
import { isValidTimeBuoyDate } from "./timeBuoyDate";

const DATE_TOKEN_LENGTH = 11;
const OPENING_BOUNDARY = new Set([
	"(", "[", "{", "（", "【", "《", "「", "『", "〈", "〔", "“", "‘", "\"", "'",
	"，", "。", "！", "？", "；", "：", "、", ",", ".", "!", "?", ";", ":",
]);
const CLOSING_BOUNDARY = new Set([
	")", "]", "}", "）", "】", "》", "」", "』", "〉", "〕", "”", "’", "\"", "'",
	"，", "。", "！", "？", "；", "：", "、", ",", ".", "!", "?", ";", ":",
]);

interface ProtectedRange {
	start: number;
	end: number;
}

interface FenceState {
	marker: "`" | "~";
	length: number;
}

export function parseTimeBuoyMatches(content: string): TimeBuoyMatch[] {
	const normalized = normalizeLineEndings(content);
	const protectedRanges = collectProtectedRanges(normalized);
	const matches: TimeBuoyMatch[] = [];
	let rangeIndex = 0;

	for (let index = 0; index <= normalized.length - DATE_TOKEN_LENGTH; index += 1) {
		while (protectedRanges[rangeIndex]?.end <= index) {
			rangeIndex += 1;
		}
		const protectedRange = protectedRanges[rangeIndex];
		if (protectedRange !== undefined && index >= protectedRange.start && index < protectedRange.end) {
			index = protectedRange.end - 1;
			continue;
		}
		const marker = normalized[index];
		if (marker !== "@" && marker !== "＠") {
			continue;
		}
		const targetDate = normalized.slice(index + 1, index + DATE_TOKEN_LENGTH);
		const end = index + DATE_TOKEN_LENGTH;
		if (
			isEscaped(normalized, index)
			|| !hasClosingBoundary(normalized, end)
			|| !isValidTimeBuoyDate(targetDate)
			|| isEmbeddedInUrlEmailOrPath(normalized, index, end)
		) {
			continue;
		}
		matches.push({ targetDate, start: index, end });
		index = end - 1;
	}
	return matches;
}

export function extractTimeBuoyDates(content: string): string[] {
	return [...new Set(parseTimeBuoyMatches(content).map((match) => match.targetDate))];
}

export function getTimeBuoyRevision(content: string): string {
	return hashText([...extractTimeBuoyDates(content)].sort().join("\n"));
}

export function hasTimeBuoyDate(content: string, targetDate: string): boolean {
	return parseTimeBuoyMatches(content).some((match) => match.targetDate === targetDate);
}

export function isTimeBuoyTriggerAt(content: string, index: number): boolean {
	const normalized = normalizeLineEndings(content);
	if (index < 0 || index >= normalized.length || (normalized[index] !== "@" && normalized[index] !== "＠")) {
		return false;
	}
	if (isEscaped(normalized, index) || !hasOpeningBoundary(normalized, index)) {
		return false;
	}
	if (collectProtectedRanges(normalized).some((range) => index >= range.start && index < range.end)) {
		return false;
	}
	return !isEmbeddedInUrlEmailOrPath(normalized, index, index + 1);
}

function normalizeLineEndings(value: string): string {
	return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function hasOpeningBoundary(content: string, index: number): boolean {
	if (index === 0) {
		return true;
	}
	const previous = content[index - 1];
	return /\s/u.test(previous) || OPENING_BOUNDARY.has(previous);
}

function hasClosingBoundary(content: string, end: number): boolean {
	if (end >= content.length) {
		return true;
	}
	const next = content[end];
	return /\s/u.test(next) || CLOSING_BOUNDARY.has(next);
}

function isEscaped(content: string, index: number): boolean {
	let backslashes = 0;
	for (let cursor = index - 1; cursor >= 0 && content[cursor] === "\\"; cursor -= 1) {
		backslashes += 1;
	}
	return backslashes % 2 === 1;
}

function isEmbeddedInUrlEmailOrPath(content: string, start: number, end: number): boolean {
	let chunkStart = start;
	while (chunkStart > 0 && !/\s/u.test(content[chunkStart - 1])) {
		chunkStart -= 1;
	}
	let chunkEnd = end;
	while (chunkEnd < content.length && !/\s/u.test(content[chunkEnd])) {
		chunkEnd += 1;
	}
	const chunk = content.slice(chunkStart, chunkEnd);
	if (chunk.includes("/") || chunk.includes("\\") || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(chunk)) {
		return true;
	}
	const relativeStart = start - chunkStart;
	const relativeEnd = end - chunkStart;
	const before = chunk.slice(0, relativeStart);
	const after = chunk.slice(relativeEnd);
	if (before.includes("@") || after.startsWith("@") || after.startsWith("＠")) {
		return true;
	}
	const strippedAfter = after.replace(/^[)\]}>）】》」』〉〕”’\"']+/, "");
	return /^\.[A-Za-z0-9][A-Za-z0-9._-]*$/.test(strippedAfter);
}

function collectProtectedRanges(content: string): ProtectedRange[] {
	const ranges: ProtectedRange[] = [];
	let fence: FenceState | null = null;
	let htmlCommentOpen = false;
	let lineStart = 0;

	while (lineStart <= content.length) {
		const newlineIndex = content.indexOf("\n", lineStart);
		const lineEnd = newlineIndex === -1 ? content.length : newlineIndex;
		const line = content.slice(lineStart, lineEnd);
		const fullLineEnd = newlineIndex === -1 ? lineEnd : lineEnd + 1;
		if (fence !== null) {
			ranges.push({ start: lineStart, end: fullLineEnd });
			if (isClosingFence(line, fence)) {
				fence = null;
			}
		} else {
			const openingFence = getOpeningFence(line);
			if (openingFence !== null) {
				ranges.push({ start: lineStart, end: fullLineEnd });
				fence = openingFence;
			} else if (/^\s{0,3}>/.test(line)) {
				ranges.push({ start: lineStart, end: fullLineEnd });
			} else {
				htmlCommentOpen = collectInlineProtectedRanges(line, lineStart, ranges, htmlCommentOpen);
				const blockId = /\s+\^[A-Za-z0-9_-]+\s*$/.exec(line);
				if (blockId !== null) {
					ranges.push({ start: lineStart + blockId.index, end: lineEnd });
				}
			}
		}
		if (newlineIndex === -1) {
			break;
		}
		lineStart = newlineIndex + 1;
	}
	return mergeRanges(ranges);
}

function getOpeningFence(line: string): FenceState | null {
	const match = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
	if (match === null) {
		return null;
	}
	return {
		marker: match[1][0] as FenceState["marker"],
		length: match[1].length,
	};
}

function isClosingFence(line: string, fence: FenceState): boolean {
	const trimmed = line.replace(/^\s{0,3}/, "");
	let markerCount = 0;
	while (trimmed[markerCount] === fence.marker) {
		markerCount += 1;
	}
	return markerCount >= fence.length && trimmed.slice(markerCount).trim().length === 0;
}

function collectInlineProtectedRanges(
	line: string,
	lineOffset: number,
	ranges: ProtectedRange[],
	htmlCommentOpen: boolean,
): boolean {
	let index = 0;
	while (index < line.length) {
		if (htmlCommentOpen) {
			const close = line.indexOf("-->", index);
			if (close === -1) {
				ranges.push({ start: lineOffset + index, end: lineOffset + line.length });
				return true;
			}
			ranges.push({ start: lineOffset + index, end: lineOffset + close + 3 });
			htmlCommentOpen = false;
			index = close + 3;
			continue;
		}
		if (line.startsWith("<!--", index)) {
			const close = line.indexOf("-->", index + 4);
			if (close === -1) {
				ranges.push({ start: lineOffset + index, end: lineOffset + line.length });
				return true;
			}
			ranges.push({ start: lineOffset + index, end: lineOffset + close + 3 });
			index = close + 3;
			continue;
		}
		if (line[index] === "`") {
			const runLength = countRun(line, index, "`");
			const marker = "`".repeat(runLength);
			const close = line.indexOf(marker, index + runLength);
			if (close !== -1) {
				ranges.push({ start: lineOffset + index, end: lineOffset + close + runLength });
				index = close + runLength;
				continue;
			}
		}
		const wikiStart = line.startsWith("[[", index)
			? index
			: line.startsWith("![[", index) ? index + 1 : -1;
		if (wikiStart !== -1) {
			const close = line.indexOf("]]", wikiStart + 2);
			const end = close === -1 ? line.length : close + 2;
			ranges.push({ start: lineOffset + index, end: lineOffset + end });
			index = end;
			continue;
		}
		const linkStart = line[index] === "[" ? index : line.startsWith("![", index) ? index + 1 : -1;
		if (linkStart !== -1) {
			const labelEnd = findClosingBracket(line, linkStart);
			if (labelEnd !== -1 && line[labelEnd + 1] === "(") {
				const destinationEnd = findClosingParenthesis(line, labelEnd + 1);
				if (destinationEnd !== -1) {
					ranges.push({ start: lineOffset + index, end: lineOffset + destinationEnd + 1 });
					index = destinationEnd + 1;
					continue;
				}
			}
		}
		if (line[index] === "<") {
			const close = line.indexOf(">", index + 1);
			if (close !== -1) {
				ranges.push({ start: lineOffset + index, end: lineOffset + close + 1 });
				index = close + 1;
				continue;
			}
		}
		index += 1;
	}
	return htmlCommentOpen;
}

function countRun(value: string, start: number, marker: string): number {
	let count = 0;
	while (value[start + count] === marker) {
		count += 1;
	}
	return count;
}

function findClosingBracket(value: string, start: number): number {
	let depth = 0;
	for (let index = start; index < value.length; index += 1) {
		if (isEscaped(value, index)) {
			continue;
		}
		if (value[index] === "[") {
			depth += 1;
		} else if (value[index] === "]") {
			depth -= 1;
			if (depth === 0) {
				return index;
			}
		}
	}
	return -1;
}

function findClosingParenthesis(value: string, start: number): number {
	let depth = 0;
	for (let index = start; index < value.length; index += 1) {
		if (isEscaped(value, index)) {
			continue;
		}
		if (value[index] === "(") {
			depth += 1;
		} else if (value[index] === ")") {
			depth -= 1;
			if (depth === 0) {
				return index;
			}
		}
	}
	return -1;
}

function mergeRanges(ranges: ProtectedRange[]): ProtectedRange[] {
	const sorted = ranges.sort((left, right) => left.start - right.start || left.end - right.end);
	const merged: ProtectedRange[] = [];
	for (const range of sorted) {
		const previous = merged[merged.length - 1];
		if (previous === undefined || range.start > previous.end) {
			merged.push({ ...range });
		} else {
			previous.end = Math.max(previous.end, range.end);
		}
	}
	return merged;
}

import { parser } from "@lezer/markdown";
import { splitMarkdownLines } from "./markdown";

export type MarkdownTaskMarker = " " | "x" | "X" | "-";
export type WritableMarkdownTaskMarker = " " | "x" | "-";

export interface TextReplacement {
	value: string;
	cursor: number;
}

export interface ParsedMarkdownTaskLine {
	indent: string;
	listMarker: string;
	listWhitespace: string;
	marker: MarkdownTaskMarker;
	bodySpacing: string;
	body: string;
	markerStart: number;
	markerEnd: number;
}

export interface IndexedMarkdownTaskLine extends ParsedMarkdownTaskLine {
	index: number;
	lineIndex: number;
	line: string;
}

const TASK_LINE_REGEX = /^([ \t]*)([-*+]|\d+[.)])([ \t]+)\[([ xX-])\]([ \t]*)(.*)$/;

export function parseMarkdownTaskLine(line: string): ParsedMarkdownTaskLine | null {
	const match = line.match(TASK_LINE_REGEX);
	if (match === null || !isMarkdownTaskMarker(match[4]) || (match[6].length > 0 && match[5].length === 0)) {
		return null;
	}
	const indent = match[1];
	const listMarker = match[2];
	const listWhitespace = match[3];
	const markerStart = indent.length + listMarker.length + listWhitespace.length;
	return {
		indent,
		listMarker,
		listWhitespace,
		marker: match[4],
		bodySpacing: match[5],
		body: match[6],
		markerStart,
		markerEnd: markerStart + 3,
	};
}

export function getMarkdownTaskLines(content: string): IndexedMarkdownTaskLine[] {
	const lines = splitMarkdownLines(content);
	const markdown = lines.join("\n");
	const tasks: IndexedMarkdownTaskLine[] = [];
	let lineIndex = 0;
	let lineStart = 0;
	// 语法树负责容器和代码边界；逐行匹配只校验本期支持的 marker。
	parser.parse(markdown).iterate({
		enter(node) {
			if (node.name !== "ListItem") return;
			const listMark = node.node.getChild("ListMark");
			if (listMark === null) return;
			while (lineIndex < lines.length - 1 && lineStart + lines[lineIndex].length < listMark.from) {
				lineStart += lines[lineIndex].length + 1;
				lineIndex += 1;
			}
			const line = lines[lineIndex];
			const prefix = listMark.from - lineStart;
			const task = parseMarkdownTaskLine(line.slice(prefix));
			if (task === null) return;
			tasks.push({
				...task,
				indent: line.slice(0, prefix),
				markerStart: task.markerStart + prefix,
				markerEnd: task.markerEnd + prefix,
				index: tasks.length,
				lineIndex,
				line,
			});
		},
	});
	return tasks;
}

export function getMarkdownTaskLineByIndex(content: string, taskIndex: number): IndexedMarkdownTaskLine | null {
	if (!Number.isInteger(taskIndex) || taskIndex < 0) {
		return null;
	}
	return getMarkdownTaskLines(content)[taskIndex] ?? null;
}

export function replaceMarkdownTaskMarkerByIndex(
	content: string,
	taskIndex: number,
	marker: WritableMarkdownTaskMarker,
): string | null {
	const task = getMarkdownTaskLineByIndex(content, taskIndex);
	return task === null ? null : replaceMarkdownTaskMarker(content, task, marker);
}

export function getMarkdownTaskEnterPatch(value: string, start: number, end: number): TextReplacement | null {
	if (start !== end) {
		return null;
	}
	const lineStart = value.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
	if (isOffsetInsideFencedCode(value, lineStart)) {
		return null;
	}
	const line = value.slice(lineStart, start);
	const task = parseMarkdownTaskLine(line);
	if (task === null) {
		return null;
	}
	if (isEmptyTask(task)) {
		const cursor = lineStart + task.indent.length;
		return {
			value: `${value.slice(0, lineStart)}${task.indent}${value.slice(start)}`,
			cursor,
		};
	}
	const insert = `\n${task.indent}${getNextTaskListMarker(task)} [ ] `;
	const cursor = start + insert.length;
	return {
		value: `${value.slice(0, start)}${insert}${value.slice(end)}`,
		cursor,
	};
}

export function getMarkdownTaskEnterPatchAfterNativeNewline(value: string, start: number, end: number): TextReplacement | null {
	if (start !== end || start <= 0 || value.charAt(start - 1) !== "\n") {
		return null;
	}
	const newlineIndex = start - 1;
	const lineStart = value.lastIndexOf("\n", Math.max(0, newlineIndex - 1)) + 1;
	if (isOffsetInsideFencedCode(value, lineStart)) {
		return null;
	}
	const line = value.slice(lineStart, newlineIndex);
	const task = parseMarkdownTaskLine(line);
	if (task === null) {
		return null;
	}
	if (isEmptyTask(task)) {
		const cursor = lineStart + task.indent.length;
		return {
			value: `${value.slice(0, lineStart)}${task.indent}${value.slice(start)}`,
			cursor,
		};
	}
	const insert = `${task.indent}${getNextTaskListMarker(task)} [ ] `;
	const cursor = start + insert.length;
	return {
		value: `${value.slice(0, start)}${insert}${value.slice(start)}`,
		cursor,
	};
}

function replaceMarkdownTaskMarker(
	content: string,
	task: IndexedMarkdownTaskLine,
	marker: WritableMarkdownTaskMarker,
): string | null {
	const lines = splitMarkdownLines(content);
	const line = lines[task.lineIndex];
	if (line === undefined) {
		return null;
	}
	lines[task.lineIndex] = `${line.slice(0, task.markerStart)}[${marker}]${line.slice(task.markerEnd)}`;
	return lines.join("\n");
}

function isMarkdownTaskMarker(value: string): value is MarkdownTaskMarker {
	return value === " " || value === "x" || value === "X" || value === "-";
}

function isEmptyTask(task: ParsedMarkdownTaskLine): boolean {
	return task.body.trim().length === 0;
}

function getNextTaskListMarker(task: ParsedMarkdownTaskLine): string {
	const ordered = task.listMarker.match(/^(\d+)[.)]$/);
	if (ordered === null) {
		return task.listMarker;
	}
	return `${Number(ordered[1]) + 1}.`;
}

function isOffsetInsideFencedCode(content: string, offset: number): boolean {
	const lines = splitMarkdownLines(content.slice(0, offset));
	let fence: CodeFenceMarker | null = null;
	for (const line of lines.slice(0, -1)) {
		const marker = getCodeFenceMarker(line);
		if (marker === null) {
			continue;
		}
		if (fence === null) {
			fence = marker;
		} else if (isClosingCodeFence(fence, marker)) {
			fence = null;
		}
	}
	return fence !== null;
}

interface CodeFenceMarker {
	char: "`" | "~";
	length: number;
}

function getCodeFenceMarker(line: string): CodeFenceMarker | null {
	const match = line.match(/^(?: {0,3})(`{3,}|~{3,})/);
	if (match === null) {
		return null;
	}
	const marker = match[1];
	return {
		char: marker.charAt(0) as "`" | "~",
		length: marker.length,
	};
}

function isClosingCodeFence(opening: CodeFenceMarker, candidate: CodeFenceMarker): boolean {
	return candidate.char === opening.char && candidate.length >= opening.length;
}

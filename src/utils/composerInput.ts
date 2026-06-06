import { getMarkdownTaskEnterPatch, getMarkdownTaskEnterPatchAfterNativeNewline } from "./markdownTasks";

export interface TagQueryRange {
	from: number;
	to: number;
	query: string;
}

export interface TextReplacement {
	value: string;
	cursor: number;
}

export interface NativeListInputOptions {
	allowTextChangeWithNewline?: boolean;
}

export type ListFormatType = "bullet" | "ordered";

export function getHashInsertionText(value: string, cursor: number): string {
	if (cursor <= 0) {
		return "#";
	}
	const previousChar = value.charAt(cursor - 1);
	return /\s/.test(previousChar) ? "#" : " #";
}

export function getTagQueryAtCursor(value: string, cursor: number): TagQueryRange | null {
	if (cursor < 0 || cursor > value.length) {
		return null;
	}
	let hashIndex = cursor - 1;
	while (hashIndex >= 0) {
		const char = value.charAt(hashIndex);
		if (char === "#") {
			break;
		}
		if (char === "]" || /\s/.test(char)) {
			return null;
		}
		hashIndex -= 1;
	}
	if (hashIndex < 0 || !isTagStart(value, hashIndex)) {
		return null;
	}
	return {
		from: hashIndex,
		to: cursor,
		query: value.slice(hashIndex + 1, cursor),
	};
}

export function replaceTagQueryWithSuggestion(value: string, range: TagQueryRange, tag: string): TextReplacement {
	const normalizedTag = tag.replace(/^#/, "");
	const replacement = `#${normalizedTag}`;
	const before = value.slice(0, range.from);
	const after = value.slice(range.to);
	const nextChar = after.charAt(0);
	const hasTrailingWhitespace = nextChar.length > 0 && /\s/.test(nextChar);
	if (hasTrailingWhitespace) {
		return {
			value: `${before}${replacement}${after}`,
			cursor: range.from + replacement.length + 1,
		};
	}
	return {
		value: `${before}${replacement} ${after}`,
		cursor: range.from + replacement.length + 1,
	};
}

export function applyListFormatToText(value: string, start: number, end: number, type: ListFormatType): TextReplacement {
	const blockStart = value.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
	const nextLineBreak = value.indexOf("\n", end);
	const blockEnd = nextLineBreak === -1 ? value.length : nextLineBreak;
	const before = value.slice(0, blockStart);
	const target = value.slice(blockStart, blockEnd);
	const after = value.slice(blockEnd);
	const lines = target.split("\n");
	const formatted = lines.map((line, index) => {
		const match = line.match(/^(\s*)(?:[-*+]\s+|\d+[.)]\s+)?(.*)$/);
		const indent = match?.[1] ?? "";
		const content = match?.[2] ?? line.trimStart();
		if (type === "bullet") {
			return `${indent}- ${content}`;
		}
		return `${indent}${index + 1}. ${content}`;
	});
	const formattedText = formatted.join("\n");
	return {
		value: `${before}${formattedText}${after}`,
		cursor: blockStart + formattedText.length,
	};
}

export function getListEnterPatch(value: string, start: number, end: number): TextReplacement | null {
	if (start !== end) {
		return null;
	}
	const task = getMarkdownTaskEnterPatch(value, start, end);
	if (task !== null) {
		return task;
	}
	const lineStart = value.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
	const line = value.slice(lineStart, start);
	const bullet = parseBulletListLine(line);
	const ordered = parseOrderedListLine(line);
	if (bullet === null && ordered === null) {
		return null;
	}
	if (bullet !== null) {
		const { indent, content } = bullet;
		if (content.trim().length === 0) {
			const cursor = lineStart + indent.length;
			return {
				value: `${value.slice(0, lineStart)}${indent}${value.slice(start)}`,
				cursor,
			};
		}
		const insert = `\n${indent}- `;
		const cursor = start + insert.length;
		return {
			value: `${value.slice(0, start)}${insert}${value.slice(end)}`,
			cursor,
		};
	}
	if (ordered === null) {
		return null;
	}
	const { indent, number, content } = ordered;
	if (content.trim().length === 0) {
		const cursor = lineStart + indent.length;
		return {
			value: `${value.slice(0, lineStart)}${indent}${value.slice(start)}`,
			cursor,
		};
	}
	const insert = `\n${indent}${number + 1}. `;
	const cursor = start + insert.length;
	return {
		value: `${value.slice(0, start)}${insert}${value.slice(end)}`,
		cursor,
	};
}

export function getListEnterPatchAfterNativeNewline(value: string, start: number, end: number): TextReplacement | null {
	if (start !== end || start <= 0 || value.charAt(start - 1) !== "\n") {
		return null;
	}
	const task = getMarkdownTaskEnterPatchAfterNativeNewline(value, start, end);
	if (task !== null) {
		return task;
	}
	const newlineIndex = start - 1;
	const lineStart = value.lastIndexOf("\n", Math.max(0, newlineIndex - 1)) + 1;
	const line = value.slice(lineStart, newlineIndex);
	const bullet = parseBulletListLine(line);
	const ordered = parseOrderedListLine(line);
	if (bullet === null && ordered === null) {
		return null;
	}
	if (bullet !== null) {
		const { indent, content } = bullet;
		if (content.trim().length === 0) {
			const cursor = lineStart + indent.length;
			return {
				value: `${value.slice(0, lineStart)}${indent}${value.slice(start)}`,
				cursor,
			};
		}
		const insert = `${indent}- `;
		const cursor = start + insert.length;
		return {
			value: `${value.slice(0, start)}${insert}${value.slice(start)}`,
			cursor,
		};
	}
	if (ordered === null) {
		return null;
	}
	const { indent, number, content } = ordered;
	if (content.trim().length === 0) {
		const cursor = lineStart + indent.length;
		return {
			value: `${value.slice(0, lineStart)}${indent}${value.slice(start)}`,
			cursor,
		};
	}
	const insert = `${indent}${number + 1}. `;
	const cursor = start + insert.length;
	return {
		value: `${value.slice(0, start)}${insert}${value.slice(start)}`,
		cursor,
	};
}

export function getListEnterPatchForNativeInput(
	previousValue: string,
	value: string,
	start: number,
	end: number,
	options: NativeListInputOptions = {},
): TextReplacement | null {
	if (start !== end || start <= 0 || value.charAt(start - 1) !== "\n") {
		return null;
	}
	const withoutInsertedNewline = `${value.slice(0, start - 1)}${value.slice(start)}`;
	if (withoutInsertedNewline !== previousValue) {
		if (!options.allowTextChangeWithNewline || countLineBreaks(value) !== countLineBreaks(previousValue) + 1) {
			return null;
		}
	}
	return getListEnterPatchAfterNativeNewline(value, start, end);
}

function countLineBreaks(value: string): number {
	let count = 0;
	for (let index = 0; index < value.length; index += 1) {
		if (value.charAt(index) === "\n") {
			count += 1;
		}
	}
	return count;
}

function parseBulletListLine(line: string): { indent: string; content: string } | null {
	const markedLine = line.match(/^(\s*)[-*+]\s+(.*)$/);
	if (markedLine !== null) {
		return {
			indent: markedLine[1],
			content: markedLine[2],
		};
	}
	const emptyMarkerLine = line.match(/^(\s*)[-*+]$/);
	if (emptyMarkerLine === null) {
		return null;
	}
	return {
		indent: emptyMarkerLine[1],
		content: "",
	};
}

function parseOrderedListLine(line: string): { indent: string; number: number; content: string } | null {
	const markedLine = line.match(/^(\s*)(\d+)[.)]\s+(.*)$/);
	if (markedLine !== null) {
		return {
			indent: markedLine[1],
			number: Number(markedLine[2]),
			content: markedLine[3],
		};
	}
	const emptyMarkerLine = line.match(/^(\s*)(\d+)[.)]$/);
	if (emptyMarkerLine === null) {
		return null;
	}
	return {
		indent: emptyMarkerLine[1],
		number: Number(emptyMarkerLine[2]),
		content: "",
	};
}

function isTagStart(value: string, hashIndex: number): boolean {
	if (hashIndex === 0) {
		return true;
	}
	return /[\s([{]/.test(value.charAt(hashIndex - 1));
}

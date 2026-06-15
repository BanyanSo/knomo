export type ParsedMarkdownImageSyntax = "obsidian_embed" | "markdown_image";

export interface ParsedMarkdownImage {
	raw: string;
	path: string;
	altText: string;
	syntax: ParsedMarkdownImageSyntax;
	start: number;
	end: number;
}

export function parseMarkdownImages(content: string): ParsedMarkdownImage[] {
	const images: ParsedMarkdownImage[] = [];
	let index = 0;

	while (index < content.length) {
		const fencedEnd = findFencedCodeEnd(content, index);
		if (fencedEnd !== null) {
			index = fencedEnd;
			continue;
		}
		if (content.charAt(index) === "`") {
			const codeEnd = findInlineCodeEnd(content, index);
			if (codeEnd !== null) {
				index = codeEnd;
				continue;
			}
		}

		const image = parseImageAt(content, index);
		if (image !== null) {
			images.push(image);
			index = image.end;
			continue;
		}
		index += 1;
	}
	return images;
}

function parseImageAt(content: string, index: number): ParsedMarkdownImage | null {
	if (content.startsWith("![[", index)) {
		return parseObsidianImageAt(content, index);
	}
	if (content.startsWith("![", index)) {
		return parseMarkdownImageAt(content, index);
	}
	return null;
}

function parseObsidianImageAt(content: string, start: number): ParsedMarkdownImage | null {
	const closeIndex = findUnescapedSequence(content, start + 3, "]]");
	if (closeIndex === -1) {
		return null;
	}
	const target = content.slice(start + 3, closeIndex);
	const path = normalizeObsidianImagePath(target);
	if (path.length === 0) {
		return null;
	}
	const end = closeIndex + 2;
	return {
		raw: content.slice(start, end),
		path,
		altText: "",
		syntax: "obsidian_embed",
		start,
		end,
	};
}

function parseMarkdownImageAt(content: string, start: number): ParsedMarkdownImage | null {
	const altEnd = findClosingBracket(content, start + 2);
	if (altEnd === -1) {
		return null;
	}
	let destinationOpen = altEnd + 1;
	while (isHorizontalWhitespace(content.charAt(destinationOpen))) {
		destinationOpen += 1;
	}
	if (content.charAt(destinationOpen) !== "(") {
		return null;
	}
	const destination = parseMarkdownDestination(content, destinationOpen + 1);
	if (destination === null || destination.path.length === 0) {
		return null;
	}
	return {
		raw: content.slice(start, destination.end),
		path: destination.path,
		altText: unescapeMarkdownText(content.slice(start + 2, altEnd)),
		syntax: "markdown_image",
		start,
		end: destination.end,
	};
}

function parseMarkdownDestination(content: string, start: number): { path: string; end: number } | null {
	let index = skipWhitespace(content, start);
	if (content.charAt(index) === "<") {
		const closeAngle = findUnescapedCharacter(content, index + 1, ">");
		if (closeAngle === -1) {
			return null;
		}
		const end = parseDestinationTail(content, closeAngle + 1);
		if (end === null) {
			return null;
		}
		return {
			path: unescapeMarkdownText(content.slice(index + 1, closeAngle).trim()),
			end,
		};
	}

	const pathStart = index;
	let depth = 0;
	while (index < content.length) {
		const char = content.charAt(index);
		if (char === "\\") {
			index += Math.min(2, content.length - index);
			continue;
		}
		if (char === "(") {
			depth += 1;
			index += 1;
			continue;
		}
		if (char === ")") {
			if (depth === 0) {
				return {
					path: unescapeMarkdownText(content.slice(pathStart, index).trim()),
					end: index + 1,
				};
			}
			depth -= 1;
			index += 1;
			continue;
		}
		if (isWhitespace(char) && depth === 0) {
			const end = parseDestinationTail(content, index);
			if (end === null) {
				return null;
			}
			return {
				path: unescapeMarkdownText(content.slice(pathStart, index).trim()),
				end,
			};
		}
		index += 1;
	}
	return null;
}

function parseDestinationTail(content: string, start: number): number | null {
	let index = skipWhitespace(content, start);
	if (content.charAt(index) === ")") {
		return index + 1;
	}
	const titleEnd = findTitleEnd(content, index);
	if (titleEnd === null) {
		return null;
	}
	index = skipWhitespace(content, titleEnd);
	return content.charAt(index) === ")" ? index + 1 : null;
}

function findTitleEnd(content: string, start: number): number | null {
	const opening = content.charAt(start);
	const closing = opening === "(" ? ")" : opening;
	if (opening !== "\"" && opening !== "'" && opening !== "(") {
		return null;
	}
	let index = start + 1;
	let depth = opening === "(" ? 1 : 0;
	while (index < content.length) {
		const char = content.charAt(index);
		if (char === "\\") {
			index += Math.min(2, content.length - index);
			continue;
		}
		if (opening === "(" && char === "(") {
			depth += 1;
		} else if (char === closing) {
			if (opening !== "(" || depth === 1) {
				return index + 1;
			}
			depth -= 1;
		}
		index += 1;
	}
	return null;
}

function findClosingBracket(content: string, start: number): number {
	let depth = 0;
	let index = start;
	while (index < content.length) {
		const char = content.charAt(index);
		if (char === "\\") {
			index += Math.min(2, content.length - index);
			continue;
		}
		if (char === "[") {
			depth += 1;
		} else if (char === "]") {
			if (depth === 0) {
				return index;
			}
			depth -= 1;
		}
		index += 1;
	}
	return -1;
}

function findFencedCodeEnd(content: string, start: number): number | null {
	if (start > 0 && content.charAt(start - 1) !== "\n") {
		return null;
	}
	const lineEnd = findLineEnd(content, start);
	const openingLine = content.slice(start, lineEnd);
	const openingMatch = openingLine.match(/^ {0,3}(`{3,}|~{3,})/);
	if (openingMatch === null) {
		return null;
	}
	const fenceChar = openingMatch[1].charAt(0);
	const fenceLength = openingMatch[1].length;
	let lineStart = lineEnd < content.length ? lineEnd + 1 : content.length;
	while (lineStart < content.length) {
		const closingLineEnd = findLineEnd(content, lineStart);
		const line = content.slice(lineStart, closingLineEnd);
		if (isClosingFence(line, fenceChar, fenceLength)) {
			return closingLineEnd < content.length ? closingLineEnd + 1 : content.length;
		}
		lineStart = closingLineEnd < content.length ? closingLineEnd + 1 : content.length;
	}
	return content.length;
}

function findInlineCodeEnd(content: string, start: number): number | null {
	const markerLength = countBackticks(content, start);
	let index = start + markerLength;
	while (index < content.length) {
		const next = content.indexOf("`", index);
		if (next === -1) {
			return null;
		}
		const closingLength = countBackticks(content, next);
		if (closingLength === markerLength) {
			return next + closingLength;
		}
		index = next + closingLength;
	}
	return null;
}

function normalizeObsidianImagePath(value: string): string {
	const aliasIndex = findUnescapedCharacter(value, 0, "|");
	const pathWithFragment = (aliasIndex === -1 ? value : value.slice(0, aliasIndex)).trim();
	const fragmentIndex = findUnescapedCharacter(pathWithFragment, 0, "#");
	const path = fragmentIndex === -1 ? pathWithFragment : pathWithFragment.slice(0, fragmentIndex);
	return unescapeMarkdownText(path.trim());
}

function findUnescapedSequence(content: string, start: number, sequence: string): number {
	let index = start;
	while (index < content.length) {
		if (content.charAt(index) === "\\") {
			index += Math.min(2, content.length - index);
			continue;
		}
		if (content.startsWith(sequence, index)) {
			return index;
		}
		index += 1;
	}
	return -1;
}

function findUnescapedCharacter(content: string, start: number, target: string): number {
	let index = start;
	while (index < content.length) {
		if (content.charAt(index) === "\\") {
			index += Math.min(2, content.length - index);
			continue;
		}
		if (content.charAt(index) === target) {
			return index;
		}
		index += 1;
	}
	return -1;
}

function isClosingFence(line: string, fenceChar: string, fenceLength: number): boolean {
	let index = 0;
	while (index < line.length && index < 3 && line.charAt(index) === " ") {
		index += 1;
	}
	let markerLength = 0;
	while (line.charAt(index + markerLength) === fenceChar) {
		markerLength += 1;
	}
	if (markerLength < fenceLength) {
		return false;
	}
	return line.slice(index + markerLength).trim().length === 0;
}

function countBackticks(content: string, start: number): number {
	let index = start;
	while (content.charAt(index) === "`") {
		index += 1;
	}
	return index - start;
}

function findLineEnd(content: string, start: number): number {
	const lineEnd = content.indexOf("\n", start);
	return lineEnd === -1 ? content.length : lineEnd;
}

function skipWhitespace(content: string, start: number): number {
	let index = start;
	while (isWhitespace(content.charAt(index))) {
		index += 1;
	}
	return index;
}

function isHorizontalWhitespace(char: string): boolean {
	return char === " " || char === "\t";
}

function isWhitespace(char: string): boolean {
	return char === " " || char === "\t" || char === "\n" || char === "\r";
}

function unescapeMarkdownText(value: string): string {
	return value.replace(/\\([!-/:-@[-`{-~])/g, "$1");
}

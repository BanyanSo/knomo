import { splitMarkdownLines } from "../utils/markdown";

interface MarkdownFence {
	character: string;
	length: number;
}

export function prepareMemoCardMarkdown(value: string): string {
	const lines = splitMarkdownLines(value);
	const paragraphLines: boolean[] = [];
	let fence: MarkdownFence | null = null;

	for (const line of lines) {
		if (fence !== null) {
			paragraphLines.push(false);
			if (isClosingFence(line, fence)) {
				fence = null;
			}
			continue;
		}

		const openingFence = getOpeningFence(line);
		if (openingFence !== null) {
			fence = openingFence;
			paragraphLines.push(false);
			continue;
		}
		paragraphLines.push(isPlainParagraphLine(line));
	}

	for (let index = 0; index < lines.length - 1; index += 1) {
		if (
			paragraphLines[index]
			&& paragraphLines[index + 1]
			&& !hasMarkdownHardBreak(lines[index])
		) {
			lines[index] = `${lines[index]}  `;
		}
	}
	return lines.join("\n");
}

function isPlainParagraphLine(line: string): boolean {
	if (line.trim().length === 0 || /^(?: {4}|\t)/.test(line)) {
		return false;
	}
	const content = line.replace(/^ {0,3}/, "");
	if (
		/^(?:#{1,6}(?:\s|$)|>|(?:[-+*]|\d+[.)])(?:\s|$)|\$\$(?:\s|$)|%%|<)/.test(content)
		|| /^(?:\[[^\]]+\]|\[\^[^\]]+\]):/.test(content)
		|| /^(?:\^[-A-Za-z0-9_]+)\s*$/.test(content)
		|| /^(?:([-*_])(?:\s*\1){2,}|={3,})\s*$/.test(content)
		|| content.includes("|")
	) {
		return false;
	}
	return true;
}

function hasMarkdownHardBreak(line: string): boolean {
	if (/[ \t]{2,}$/.test(line)) {
		return true;
	}
	let backslashCount = 0;
	for (let index = line.length - 1; index >= 0 && line.charAt(index) === "\\"; index -= 1) {
		backslashCount += 1;
	}
	return backslashCount % 2 === 1;
}

function getOpeningFence(line: string): MarkdownFence | null {
	const match = line.match(/^ {0,3}(`{3,}|~{3,})/);
	if (match === null) {
		return null;
	}
	return {
		character: match[1].charAt(0),
		length: match[1].length,
	};
}

function isClosingFence(line: string, fence: MarkdownFence): boolean {
	let index = 0;
	while (index < line.length && index < 4 && line.charAt(index) === " ") {
		index += 1;
	}
	if (index > 3) {
		return false;
	}
	let markerLength = 0;
	while (line.charAt(index + markerLength) === fence.character) {
		markerLength += 1;
	}
	return markerLength >= fence.length && line.slice(index + markerLength).trim().length === 0;
}

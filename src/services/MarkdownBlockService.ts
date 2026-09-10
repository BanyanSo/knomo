import type { ParsedMemoBlock } from "../types/memo";
import { hashMemoContent } from "../utils/hash";
import {
	extractTrailingBlockId,
	findLastEffectiveLineIndex,
	indentMemoContinuationLine,
	isMarkdownHeadingLine,
	isMemoContinuationLine,
	isMemoStartLine,
	normalizeMarkdownLineEndings,
	parseMemoImages,
	parseMemoLinks,
	parseMemoTags,
	splitMarkdownLines,
	stripMemoContinuationIndent,
} from "../utils/markdown";
import type { DailyInsertPosition } from "../types/settings";

// 职责：提供完整 memo block 的解析、插入、更新和删除纯函数。
export interface MemoMetadata {
	tags: string[];
	links: ParsedMemoBlock["links"];
	images: ParsedMemoBlock["images"];
}

export interface InsertMemoBlockOptions {
	heading: string;
	block: string;
	position: DailyInsertPosition;
	createHeadingIfMissing: boolean;
}

export class MarkdownBlockService {
	buildMemoBlock(content: string, time: string): string {
		const lines = splitMarkdownLines(content);
		if (shouldDetachFirstContentLine(lines[0] ?? "")) {
			return [`- ${time}`, ...lines.map((line) => indentMemoContinuationLine(line))].join("\n");
		}
		const firstLine = lines[0] ?? "";
		const blockLines = [`- ${time} ${firstLine}`];
		for (const line of lines.slice(1)) {
			blockLines.push(indentMemoContinuationLine(line));
		}
		return blockLines.join("\n");
	}

	buildMemoBlockWithBlockId(content: string, time: string, blockId: string | null): string {
		const block = this.buildMemoBlock(content, time);
		if (blockId === null) {
			return block;
		}

		const lines = splitMarkdownLines(block);
		const targetLineIndex = findLastEffectiveLineIndex(lines);
		if (targetLineIndex === -1) {
			return block;
		}
		lines[targetLineIndex] = `${lines[targetLineIndex]} ^${blockId}`;
		return lines.join("\n");
	}

	appendBlockIdToMemoBlock(rawBlock: string, blockId: string): string {
		const lines = splitMarkdownLines(rawBlock);
		const targetLineIndex = findLastEffectiveLineIndex(lines);
		if (targetLineIndex === -1) {
			return rawBlock;
		}
		lines[targetLineIndex] = `${lines[targetLineIndex]} ^${blockId}`;
		return lines.join("\n");
	}

	parseMemoBlock(lines: string[], startLine: number): ParsedMemoBlock | null {
		const firstLine = lines[startLine];
		if (firstLine === undefined || !isMemoStartLine(firstLine)) {
			return null;
		}

		const startMatch = firstLine.match(/^- (\d{2}:\d{2}(?::\d{2})?)(?: (.*))?$/);
		if (!startMatch) {
			return null;
		}

		const contentLines: string[] = [];
		const firstContentText = startMatch[2] ?? "";
		const firstContent = extractTrailingBlockId(firstContentText);
		let blockId = firstContent.blockId;
		if (startMatch[2] !== undefined || blockId !== null) {
			contentLines.push(firstContent.text);
		}

		let endLine = startLine;
		for (let lineIndex = startLine + 1; lineIndex < lines.length; lineIndex += 1) {
			const line = lines[lineIndex];
			if (!isMemoContinuationLine(line)) {
				break;
			}
			contentLines.push(stripMemoContinuationIndent(line));
			endLine = lineIndex;
		}
		if (contentLines.length === 0) {
			return null;
		}

		const lastEffectiveLineIndex = findLastEffectiveLineIndex(contentLines);
		if (lastEffectiveLineIndex !== -1) {
			const lastContent = extractTrailingBlockId(contentLines[lastEffectiveLineIndex]);
			if (lastContent.blockId !== null) {
				contentLines[lastEffectiveLineIndex] = lastContent.text;
				blockId = lastContent.blockId;
			}
		}

		const content = contentLines.join("\n");
		const metadata = this.parseMemoMetadata(content);
		return {
			startLine,
			endLine,
			rawBlock: lines.slice(startLine, endLine + 1).join("\n"),
			time: startMatch[1],
			content,
			contentHash: hashMemoContent(content),
			blockId,
			...metadata,
		};
	}

	parseMemoMetadata(content: string): MemoMetadata {
		return {
			tags: parseMemoTags(content),
			links: parseMemoLinks(content),
			images: parseMemoImages(content),
		};
	}

	parseMemoBlocks(currentContent: string): ParsedMemoBlock[] {
		const lines = splitMarkdownLines(currentContent);
		const blocks: ParsedMemoBlock[] = [];
		for (let index = 0; index < lines.length; index += 1) {
			const parsedBlock = this.parseMemoBlock(lines, index);
			if (parsedBlock === null) {
				continue;
			}
			blocks.push(parsedBlock);
			index = parsedBlock.endLine;
		}
		return blocks;
	}

	parseMemoBlocksUnderHeading(currentContent: string, heading: string): ParsedMemoBlock[] {
		const lines = splitMarkdownLines(currentContent);
		const headingIndex = lines.findIndex((line) => line.trim() === heading.trim());
		if (headingIndex === -1) {
			return [];
		}

		let sectionEnd = lines.length;
		for (let index = headingIndex + 1; index < lines.length; index += 1) {
			if (isMarkdownHeadingLine(lines[index])) {
				sectionEnd = index;
				break;
			}
		}

		const blocks: ParsedMemoBlock[] = [];
		for (let index = headingIndex + 1; index < sectionEnd; index += 1) {
			const parsedBlock = this.parseMemoBlock(lines, index);
			if (parsedBlock === null) {
				continue;
			}
			blocks.push(parsedBlock);
			index = parsedBlock.endLine;
		}
		return blocks;
	}

	insertMemoBlock(currentContent: string, options: InsertMemoBlockOptions): string {
		const normalizedContent = normalizeMarkdownLineEndings(currentContent);
		const lines = normalizedContent.length > 0 ? splitMarkdownLines(normalizedContent) : [];
		const headingIndex = findHeadingIndex(lines, options.heading);

		if (headingIndex === -1) {
			if (!options.createHeadingIfMissing) {
				throw new Error(`Heading not found: ${options.heading}`);
			}
			const prefix = normalizedContent.trim().length === 0 ? "" : `${normalizedContent.replace(/\s*$/, "")}\n\n`;
			return `${prefix}${options.heading}\n${options.block}`;
		}

		const sectionEnd = findHeadingSectionEnd(lines, headingIndex);
		const blockLines = splitMarkdownLines(options.block);
		const insertIndex =
			options.position === "top"
				? findTopInsertIndex(lines, headingIndex, sectionEnd)
				: findBottomInsertIndex(lines, headingIndex, sectionEnd);
		const nextLines = [...lines];
		nextLines.splice(insertIndex, 0, ...blockLines);
		return nextLines.join("\n");
	}

	deleteMemoBlock(currentContent: string, startLine: number): string {
		const lines = splitMarkdownLines(currentContent);
		const parsedBlock = this.parseMemoBlock(lines, startLine);
		if (parsedBlock === null) {
			throw new Error(`Memo block not found at line ${startLine}.`);
		}

		const nextLines = [...lines];
		nextLines.splice(startLine, parsedBlock.endLine - parsedBlock.startLine + 1);
		return nextLines.join("\n");
	}
}

function shouldDetachFirstContentLine(line: string): boolean {
	return /^(\s*)(?:[-*+]\s+|\d+[.)]\s+)/.test(line);
}

function findHeadingIndex(lines: string[], heading: string): number {
	const normalizedHeading = heading.trim();
	return lines.findIndex((line) => line.trim() === normalizedHeading && isMarkdownHeadingLine(line));
}

function findHeadingSectionEnd(lines: string[], headingIndex: number): number {
	for (let index = headingIndex + 1; index < lines.length; index += 1) {
		if (isMarkdownHeadingLine(lines[index])) {
			return index;
		}
	}
	return lines.length;
}

function findTopInsertIndex(lines: string[], headingIndex: number, sectionEnd: number): number {
	const firstBodyLine = headingIndex + 1;
	if (firstBodyLine < sectionEnd && lines[firstBodyLine].trim() === "") {
		return firstBodyLine + 1;
	}
	return firstBodyLine;
}

function findBottomInsertIndex(lines: string[], headingIndex: number, sectionEnd: number): number {
	let insertIndex = sectionEnd;
	while (insertIndex > headingIndex + 1 && lines[insertIndex - 1].trim() === "") {
		insertIndex -= 1;
	}
	return insertIndex;
}

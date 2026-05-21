import type { ParsedMemoBlock } from "../types/memo";
import type { MemoIssueType } from "../types/issue";
import { hashMemoContent, hashText } from "../utils/hash";
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
} from "../utils/markdown";
import type { DailyInsertPosition } from "../types/settings";

// 职责：提供完整 memo block 的解析、插入、更新和删除纯函数。
export type MemoChangeType = "create" | "edit" | "delete" | "scan" | "repair";

export interface MemoChange {
	type: MemoChangeType;
	memoId: string;
	block: string;
	startLine?: number;
}

export interface MemoMetadata {
	tags: string[];
	links: ParsedMemoBlock["links"];
	images: ParsedMemoBlock["images"];
}

export interface MemoBlockLocator {
	lineNumberHint: number | null;
	lastKnownBlock: string;
	lastKnownHash: string;
	contentHash: string;
	allowLineHintTimeMatch?: boolean;
}

export interface MemoBlockLocation {
	parsedBlock: ParsedMemoBlock | null;
	issueType: Extract<MemoIssueType, "daily_block_missing" | "daily_block_ambiguous" | "monthly_block_missing"> | null;
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

	updateDailyBlock(currentContent: string, change: MemoChange): string {
		if (change.type === "create") {
			const normalizedContent = normalizeMarkdownLineEndings(currentContent).replace(/\s*$/, "");
			return normalizedContent.length === 0 ? change.block : `${normalizedContent}\n${change.block}`;
		}
		if (change.startLine === undefined) {
			throw new Error("更新或删除 memo block 需要 startLine。");
		}
		if (change.type === "edit") {
			const lines = splitMarkdownLines(currentContent);
			const parsedBlock = this.parseMemoBlock(lines, change.startLine);
			if (parsedBlock === null) {
				throw new Error(`Memo block not found at line ${change.startLine}.`);
			}
			const nextLines = [...lines];
			nextLines.splice(change.startLine, parsedBlock.endLine - parsedBlock.startLine + 1, ...splitMarkdownLines(change.block));
			return nextLines.join("\n");
		}
		if (change.type === "delete") {
			return this.deleteMemoBlock(currentContent, change.startLine);
		}
		return currentContent;
	}

	parseMemoBlock(lines: string[], startLine: number): ParsedMemoBlock | null {
		const firstLine = lines[startLine];
		if (firstLine === undefined || !isMemoStartLine(firstLine)) {
			return null;
		}

		const startMatch = firstLine.match(/^- (\d{2}:\d{2}(?::\d{2})?) (.*)$/);
		if (!startMatch) {
			return null;
		}

		const contentLines: string[] = [];
		const firstContent = extractTrailingBlockId(startMatch[2]);
		let blockId = firstContent.blockId;
		contentLines.push(firstContent.text);

		let endLine = startLine;
		for (let lineIndex = startLine + 1; lineIndex < lines.length; lineIndex += 1) {
			const line = lines[lineIndex];
			if (!isMemoContinuationLine(line)) {
				break;
			}
			contentLines.push(line.replace(/^ {2,}/, ""));
			endLine = lineIndex;
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

	findMemoBlock(
		currentContent: string,
		locator: MemoBlockLocator,
		missingIssueType: Extract<MemoIssueType, "daily_block_missing" | "monthly_block_missing">,
	): MemoBlockLocation {
		const blocks = this.parseMemoBlocks(currentContent);
		const hintIndex = locator.lineNumberHint === null ? -1 : locator.lineNumberHint - 1;
		const knownBlock = this.parseMemoBlock(splitMarkdownLines(locator.lastKnownBlock), 0);
		const knownBlockId = knownBlock?.blockId ?? null;
		const knownTime = knownBlock?.time ?? extractMemoTime(locator.lastKnownBlock);
		const byBlockId = knownBlockId === null
			? []
			: blocks.filter((block) => block.blockId === knownBlockId);
		const blockIdMatch = pickUniqueOrNearest(byBlockId, hintIndex);
		if (blockIdMatch.status === "matched") {
			return { parsedBlock: blockIdMatch.block, issueType: null };
		}
		if (blockIdMatch.status === "ambiguous") {
			return { parsedBlock: null, issueType: "daily_block_ambiguous" };
		}

		const byLastKnownHash = locator.lastKnownHash.trim().length === 0
			? []
			: blocks.filter((block) => hashText(block.rawBlock) === locator.lastKnownHash);
		const hashMatch = pickUniqueOrNearest(byLastKnownHash, hintIndex);
		if (hashMatch.status === "matched") {
			return { parsedBlock: hashMatch.block, issueType: null };
		}
		if (hashMatch.status === "ambiguous") {
			return { parsedBlock: null, issueType: "daily_block_ambiguous" };
		}

		const byContentHash = locator.contentHash.trim().length === 0
			? []
			: blocks.filter((block) => block.contentHash === locator.contentHash);
		const contentHashMatch = pickUniqueOrNearest(byContentHash, hintIndex);
		if (contentHashMatch.status === "matched") {
			return { parsedBlock: contentHashMatch.block, issueType: null };
		}
		if (contentHashMatch.status === "ambiguous") {
			return { parsedBlock: null, issueType: "daily_block_ambiguous" };
		}

		const nearbyBlocks = getNearbyBlocks(blocks, hintIndex);
		const nearbyStrongCandidates = nearbyBlocks.filter((block) =>
			(knownBlockId !== null && block.blockId === knownBlockId) ||
			(locator.lastKnownHash.trim().length > 0 && hashText(block.rawBlock) === locator.lastKnownHash) ||
			(locator.contentHash.trim().length > 0 && block.contentHash === locator.contentHash),
		);
		const nearbyStrongMatch = pickNearest(nearbyStrongCandidates, hintIndex);
		if (nearbyStrongMatch.status === "matched") {
			return { parsedBlock: nearbyStrongMatch.block, issueType: null };
		}
		if (nearbyStrongMatch.status === "ambiguous") {
			return { parsedBlock: null, issueType: "daily_block_ambiguous" };
		}

		if (locator.allowLineHintTimeMatch === true && knownTime !== null) {
			const nearbyTimeCandidates = nearbyBlocks.filter((block) => block.time === knownTime);
			const nearbyTimeMatch = pickNearest(nearbyTimeCandidates, hintIndex);
			if (nearbyTimeMatch.status === "matched") {
				return { parsedBlock: nearbyTimeMatch.block, issueType: null };
			}
			if (nearbyTimeMatch.status === "ambiguous") {
				return { parsedBlock: null, issueType: "daily_block_ambiguous" };
			}
		}

		return {
			parsedBlock: null,
			issueType: missingIssueType,
		};
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
		const normalizedInsertIndex = removeAdjacentBlankLines(nextLines, insertIndex, headingIndex);
		nextLines.splice(normalizedInsertIndex, 0, ...blockLines);
		return nextLines.join("\n");
	}

	updateMemoBlock(currentContent: string, startLine: number, nextContent: string): string {
		const lines = splitMarkdownLines(currentContent);
		const parsedBlock = this.parseMemoBlock(lines, startLine);
		if (parsedBlock === null) {
			throw new Error(`Memo block not found at line ${startLine}.`);
		}

		const nextBlock = this.buildMemoBlockWithBlockId(nextContent, parsedBlock.time, parsedBlock.blockId);
		const nextLines = [...lines];
		nextLines.splice(startLine, parsedBlock.endLine - parsedBlock.startLine + 1, ...splitMarkdownLines(nextBlock));
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

function extractMemoTime(block: string): string | null {
	return block.match(/^- (\d{2}:\d{2}(?::\d{2})?) /)?.[1] ?? null;
}

type PickMatch =
	| { status: "matched"; block: ParsedMemoBlock }
	| { status: "ambiguous" }
	| { status: "missing" };

const LINE_HINT_WINDOW = 5;

function pickUniqueOrNearest(blocks: ParsedMemoBlock[], hintIndex: number): PickMatch {
	if (blocks.length === 0) {
		return { status: "missing" };
	}
	if (blocks.length === 1) {
		return { status: "matched", block: blocks[0] };
	}
	return pickNearest(getNearbyBlocks(blocks, hintIndex), hintIndex);
}

function pickNearest(blocks: ParsedMemoBlock[], hintIndex: number): PickMatch {
	if (blocks.length === 0) {
		return { status: "missing" };
	}
	if (blocks.length === 1 || hintIndex < 0) {
		return blocks.length === 1 ? { status: "matched", block: blocks[0] } : { status: "ambiguous" };
	}
	let nearestDistance = Number.POSITIVE_INFINITY;
	let nearestBlocks: ParsedMemoBlock[] = [];
	for (const block of blocks) {
		const distance = Math.abs(block.startLine - hintIndex);
		if (distance < nearestDistance) {
			nearestDistance = distance;
			nearestBlocks = [block];
		} else if (distance === nearestDistance) {
			nearestBlocks.push(block);
		}
	}
	return nearestBlocks.length === 1
		? { status: "matched", block: nearestBlocks[0] }
		: { status: "ambiguous" };
}

function getNearbyBlocks(blocks: ParsedMemoBlock[], hintIndex: number): ParsedMemoBlock[] {
	if (hintIndex < 0) {
		return blocks;
	}
	return blocks.filter((block) => Math.abs(block.startLine - hintIndex) <= LINE_HINT_WINDOW);
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

function removeAdjacentBlankLines(lines: string[], insertIndex: number, headingIndex: number): number {
	let nextInsertIndex = insertIndex;
	while (nextInsertIndex > headingIndex + 1 && lines[nextInsertIndex - 1]?.trim() === "") {
		lines.splice(nextInsertIndex - 1, 1);
		nextInsertIndex -= 1;
	}
	while (lines[nextInsertIndex]?.trim() === "") {
		lines.splice(nextInsertIndex, 1);
	}
	return nextInsertIndex;
}

import { parseMarkdownReferences } from "../utils/markdownReferences";
import type { MemoObservation } from "../types/catalog";
import type { MemoLinkRef } from "../types/memo";
import { hashMemoContent, hashText } from "../utils/hash";
import { sha256Bytes } from "../utils/sha256";
import { getMarkdownTaskLines } from "../utils/markdownTasks";
import {
	extractTrailingBlockId,
	extractLeadingParagraphBlockId,
	findLastEffectiveLineIndex,
	getFourColumnMemoPrefix,
	isMarkdownHeadingLine,
	isMemoContinuationLine,
	isMemoStartLine,
	parseMemoImages,
	parseMemoTags,
	splitMarkdownLines,
	stripMemoContinuationIndent,
} from "../utils/markdown";
import { extractTimeBuoyDates } from "../utils/timeBuoyParser";
import { CooperativeYieldController } from "./CooperativeTask";
import type { CooperativeTaskRuntime } from "./CooperativeTask";
import { assignObservationOccurrences } from "./ObservationOccurrences";
import { collectRelationBlockAnchors, memoLevelRelationBlockId } from "../utils/memoRelations";

export const CATALOG_PARSER_VERSION = 15;

export interface DiaryMemoParseInput {
	sourcePath: string;
	logicalDate: string;
	bytes: Uint8Array;
}

export interface DiaryMemoParseResult {
	blockAnchors?: Record<string, number>;
	sourceRevision: string;
	observations: MemoObservation[];
}

export interface DiaryMemoParseRuntime extends Omit<CooperativeTaskRuntime, "maxOperationsPerSlice"> {
	maxLinesPerSlice?: number;
}

export interface DiaryMemoRevisionParseInput {
	sourcePath: string;
	logicalDate: string;
	content: string;
	sourceRevision: string;
}

export type CatalogDigestBytes = (bytes: Uint8Array) => Promise<string>;

interface CodeFenceMarker {
	char: "`" | "~";
	length: number;
}

interface ParsedDiaryMemoBlock {
	startLine: number;
	endLine: number;
	time: string;
	content: string;
	contentStartLineOffset: number;
	contentHash: string;
	blockId: string | null;
}

export class DiaryMemoParser {
	constructor(private readonly digestBytes: CatalogDigestBytes = sha256Bytes) {}

	async parse(input: DiaryMemoParseInput, runtime?: DiaryMemoParseRuntime): Promise<DiaryMemoParseResult> {
		const sourceRevision = await this.digestBytes(input.bytes);
		const content = decodeUtf8(input.bytes);
		const revisionInput = {
			sourcePath: input.sourcePath,
			logicalDate: input.logicalDate,
			content,
			sourceRevision,
		};
		return runtime === undefined
			? this.parseRevision(revisionInput)
			: this.parseRevisionCooperatively(revisionInput, runtime);
	}

	parseRevision(input: DiaryMemoRevisionParseInput): DiaryMemoParseResult {
		const { content, sourceRevision } = input;
		const lines = splitMarkdownLines(content);
		const observations: MemoObservation[] = [];
		let currentSection: string | null = null;
		let fence: CodeFenceMarker | null = null;
		let frontmatter = startsWithFrontmatter(lines);

		for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
			const line = lines[lineIndex];
			if (frontmatter) {
				if (lineIndex > 0 && isFrontmatterEnd(line)) {
					frontmatter = false;
				}
				continue;
			}

			const fenceMarker = getCodeFenceMarker(line);
			if (fenceMarker !== null) {
				if (fence === null) {
					fence = fenceMarker;
				} else if (isClosingCodeFence(fence, fenceMarker)) {
					fence = null;
				}
				continue;
			}
			if (fence !== null) {
				continue;
			}

			if (isMarkdownHeadingLine(line)) {
				currentSection = line;
				continue;
			}
			if (!isMemoStartLine(line) || !hasValidMemoTime(line)) {
				continue;
			}
			const parsed = parseDiaryMemoBlock(lines, lineIndex);
			if (parsed === null) {
				continue;
			}
			observations.push(buildMemoObservation(input, currentSection, lines, parsed));
			lineIndex = parsed.endLine;
		}

		assignObservationOccurrences(observations);
		return { sourceRevision, observations, blockAnchors: collectRelationBlockAnchors(content) };
	}

	private async parseRevisionCooperatively(
		input: DiaryMemoRevisionParseInput,
		runtime: DiaryMemoParseRuntime,
	): Promise<DiaryMemoParseResult> {
		const { content, sourceRevision } = input;
		const lines = splitMarkdownLines(content);
		const observations: MemoObservation[] = [];
		const yieldController = new CooperativeYieldController(runtime, runtime.maxLinesPerSlice);
		let currentSection: string | null = null;
		let fence: CodeFenceMarker | null = null;
		let frontmatter = startsWithFrontmatter(lines);

		for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
			if (yieldController.shouldYield()) await yieldController.yieldNow();
			const line = lines[lineIndex];
			if (frontmatter) {
				if (lineIndex > 0 && isFrontmatterEnd(line)) frontmatter = false;
				continue;
			}
			const fenceMarker = getCodeFenceMarker(line);
			if (fenceMarker !== null) {
				if (fence === null) fence = fenceMarker;
				else if (isClosingCodeFence(fence, fenceMarker)) fence = null;
				continue;
			}
			if (fence !== null) continue;
			if (isMarkdownHeadingLine(line)) {
				currentSection = line;
				continue;
			}
			if (!isMemoStartLine(line) || !hasValidMemoTime(line)) continue;
			const parsed = await parseDiaryMemoBlockCooperatively(lines, lineIndex, yieldController);
			if (parsed === null) continue;
			if (yieldController.shouldYield()) await yieldController.yieldNow();
			observations.push(buildMemoObservation(input, currentSection, lines, parsed));
			lineIndex = parsed.endLine;
		}
		assignObservationOccurrences(observations);
		return { sourceRevision, observations, blockAnchors: collectRelationBlockAnchors(content) };
	}
}

function parseDiaryMemoBlock(lines: readonly string[], startLine: number): ParsedDiaryMemoBlock | null {
	const firstLine = lines[startLine];
	const match = firstLine?.match(/^-(?: | {3})(\d{2}:\d{2}(?::\d{2})?)(?: (.*))?$/u) ?? null;
	if (match === null) {
		return null;
	}

	const contentLines: string[] = [];
	const prefix = getFourColumnMemoPrefix(lines, startLine);
	const continuationColumns = prefix === null ? 2 : 4;
	const firstContent = extractTrailingBlockId(match[2] ?? "");
	let blockId = prefix === null ? firstContent.blockId : prefix.blockId;
	if (prefix?.firstContent !== undefined && prefix.firstContent !== null) {
		contentLines.push(prefix.firstContent);
	} else if (prefix === null && (match[2] !== undefined || blockId !== null)) {
		contentLines.push(firstContent.text);
	}
	const contentStartLineOffset = prefix?.contentStartLineOffset ?? (match[2] === undefined ? 1 : 0);
	let endLine = startLine;
	for (let lineIndex = startLine + Math.max(1, contentStartLineOffset); lineIndex < lines.length; lineIndex += 1) {
		const line = lines[lineIndex];
		if (!isMemoContinuationLine(line, continuationColumns)) {
			break;
		}
		contentLines.push(stripMemoContinuationIndent(line, continuationColumns));
		endLine = lineIndex;
	}

	const lastEffectiveLineIndex = findLastEffectiveLineIndex(contentLines);
	if (prefix === null && lastEffectiveLineIndex !== -1) {
		const lastContent = extractTrailingBlockId(contentLines[lastEffectiveLineIndex]);
		if (lastContent.blockId !== null) {
			contentLines[lastEffectiveLineIndex] = lastContent.text;
			blockId = lastContent.blockId;
		}
	}
	let content = contentLines.join("\n");
	if (prefix?.contentStartLineOffset === 0) {
		const paragraph = extractLeadingParagraphBlockId(content);
		content = paragraph.text;
		blockId = paragraph.blockId;
	}
	if (content.trim().length === 0) {
		return null;
	}
	return {
		startLine,
		endLine,
		time: match[1],
		content,
		contentStartLineOffset,
		contentHash: hashMemoContent(content),
		blockId,
	};
}

async function parseDiaryMemoBlockCooperatively(
	lines: readonly string[],
	startLine: number,
	yieldController: CooperativeYieldController,
): Promise<ParsedDiaryMemoBlock | null> {
	const firstLine = lines[startLine];
	const match = firstLine?.match(/^-(?: | {3})(\d{2}:\d{2}(?::\d{2})?)(?: (.*))?$/u) ?? null;
	if (match === null) return null;

	const contentLines: string[] = [];
	const prefix = getFourColumnMemoPrefix(lines, startLine);
	const continuationColumns = prefix === null ? 2 : 4;
	const firstContent = extractTrailingBlockId(match[2] ?? "");
	let blockId = prefix === null ? firstContent.blockId : prefix.blockId;
	if (prefix?.firstContent !== undefined && prefix.firstContent !== null) contentLines.push(prefix.firstContent);
	else if (prefix === null && (match[2] !== undefined || blockId !== null)) contentLines.push(firstContent.text);
	const contentStartLineOffset = prefix?.contentStartLineOffset ?? (match[2] === undefined ? 1 : 0);
	let endLine = startLine;
	for (let lineIndex = startLine + Math.max(1, contentStartLineOffset); lineIndex < lines.length; lineIndex += 1) {
		if (yieldController.shouldYield()) await yieldController.yieldNow();
		const line = lines[lineIndex];
		if (!isMemoContinuationLine(line, continuationColumns)) break;
		contentLines.push(stripMemoContinuationIndent(line, continuationColumns));
		endLine = lineIndex;
	}

	const lastEffectiveLineIndex = findLastEffectiveLineIndex(contentLines);
	if (prefix === null && lastEffectiveLineIndex !== -1) {
		const lastContent = extractTrailingBlockId(contentLines[lastEffectiveLineIndex]);
		if (lastContent.blockId !== null) {
			contentLines[lastEffectiveLineIndex] = lastContent.text;
			blockId = lastContent.blockId;
		}
	}
	let content = contentLines.join("\n");
	if (prefix?.contentStartLineOffset === 0) {
		const paragraph = extractLeadingParagraphBlockId(content);
		content = paragraph.text;
		blockId = paragraph.blockId;
	}
	if (content.trim().length === 0) return null;
	return {
		startLine,
		endLine,
		time: match[1],
		content,
		contentStartLineOffset,
		contentHash: hashMemoContent(content),
		blockId,
	};
}

function buildMemoObservation(
	input: DiaryMemoRevisionParseInput,
	currentSection: string | null,
	lines: readonly string[],
	parsed: ParsedDiaryMemoBlock,
): MemoObservation {
	const metadataContent = maskProtectedMarkdown(parsed.content);
	const tasks = getMarkdownTaskLines(parsed.content).map((task) => ({
		taskIndex: task.index,
		lineOffset: parsed.contentStartLineOffset + task.lineIndex,
		marker: task.marker,
		text: task.body,
	}));
	return {
		sourcePath: normalizeVaultPath(input.sourcePath),
		sourceRevision: input.sourceRevision,
		rawBlockHash: hashText(lines.slice(parsed.startLine, parsed.endLine + 1).join("\n")),
		logicalDate: input.logicalDate,
		section: currentSection,
		startLine: parsed.startLine,
		endLine: parsed.endLine,
		time: parsed.time,
		content: parsed.content,
		contentHash: parsed.contentHash,
		occurrenceIndex: 0,
		occurrenceCount: 1,
		existingBlockId: parsed.blockId,
		relationBlockId: memoLevelRelationBlockId(lines.slice(parsed.startLine, parsed.endLine + 1).join("\n"), parsed.blockId),
		tags: parseMemoTags(metadataContent),
		links: parseMemoLinksInSourceOrder(metadataContent),
		images: dedupeStable(parseMemoImages(metadataContent), (image) => `${image.syntax}\0${image.path}\0${image.altText}`),
		tasks,
		timeBuoyDates: extractTimeBuoyDates(parsed.content),
	};
}

export function extractDailyExplicitReferenceTargets(content: string): string[] {
	return dedupeStable(parseMarkdownReferences(content)
		.filter((link) => link.valid && /#(?:\^|%5[eE])/u.test(link.target))
		.map((link) => link.target), (target) => target);
}

function decodeUtf8(bytes: Uint8Array): string {
	return new TextDecoder("utf-8", { fatal: false }).decode(bytes).replace(/^\uFEFF/u, "");
}

function normalizeVaultPath(path: string): string {
	return path.replace(/\\/gu, "/").replace(/^\/+|\/+$/gu, "");
}

function startsWithFrontmatter(lines: readonly string[]): boolean {
	return lines[0]?.trim() === "---";
}

function isFrontmatterEnd(line: string): boolean {
	const value = line.trim();
	return value === "---" || value === "...";
}

function hasValidMemoTime(line: string): boolean {
	const time = line.match(/^-(?: | {3})(\d{2}:\d{2}(?::\d{2})?)(?: |$)/u)?.[1] ?? "";
	return /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/u.test(time);
}

function getCodeFenceMarker(line: string): CodeFenceMarker | null {
	const match = line.match(/^ {0,3}(`{3,}|~{3,})/u);
	if (match === null) {
		return null;
	}
	return {
		char: match[1].charAt(0) as "`" | "~",
		length: match[1].length,
	};
}

function isClosingCodeFence(opening: CodeFenceMarker, candidate: CodeFenceMarker): boolean {
	return opening.char === candidate.char && candidate.length >= opening.length;
}

function maskProtectedMarkdown(content: string): string {
	const lines = splitMarkdownLines(content);
	let fence: CodeFenceMarker | null = null;
	let htmlCommentOpen = false;
	return lines.map((line) => {
		const marker = getCodeFenceMarker(line);
		if (marker !== null) {
			if (fence === null) {
				fence = marker;
			} else if (isClosingCodeFence(fence, marker)) {
				fence = null;
			}
			return " ".repeat(line.length);
		}
		if (fence !== null) {
			return " ".repeat(line.length);
		}
		const chars = [...line];
		for (let index = 0; index < chars.length; index += 1) {
			if (!htmlCommentOpen && line.startsWith("<!--", index)) {
				htmlCommentOpen = true;
			}
			if (htmlCommentOpen) {
				chars[index] = " ";
				if (line.startsWith("-->", index)) {
					chars[index + 1] = " ";
					chars[index + 2] = " ";
					htmlCommentOpen = false;
					index += 2;
				}
			}
		}
		return chars.join("");
	}).join("\n");
}

function parseMemoLinksInSourceOrder(content: string): MemoLinkRef[] {
	const matches: Array<{ index: number; link: MemoLinkRef }> = [];
	const wrappedRanges: Array<[number, number]> = [];
	const wikiRegex = /\[\[([^\]]+)\]\]/gu;
	let wikiMatch = wikiRegex.exec(content);
	while (wikiMatch !== null) {
		wrappedRanges.push([wikiMatch.index, wikiMatch.index + wikiMatch[0].length]);
		if (content.charAt(wikiMatch.index - 1) !== "!" || /#(?:\^|%5[eE])/u.test(wikiMatch[1])) {
			const separatorIndex = wikiMatch[1].indexOf("|");
			matches.push({
				index: wikiMatch.index,
				link: {
					target: separatorIndex === -1 ? wikiMatch[1] : wikiMatch[1].slice(0, separatorIndex),
					displayText: separatorIndex === -1 ? null : wikiMatch[1].slice(separatorIndex + 1),
					syntax: "wiki_link",
				},
			});
		}
		wikiMatch = wikiRegex.exec(content);
	}
	for (const reference of parseMarkdownReferences(content).filter((link) => link.syntax === "markdown_link")) {
		const index = reference.startOffset!;
		wrappedRanges.push([index, index + reference.raw.length]);
		matches.push({ index, link: { target: reference.target, displayText: reference.displayText, syntax: "markdown_link" } });
	}
	const imagePattern = /!\[[^\]]*\]\([^\n]*?\)/gu;
	let image: RegExpExecArray | null;
	while ((image = imagePattern.exec(content)) !== null) {
		wrappedRanges.push([image.index, image.index + image[0].length]);
	}
	const webRegex = /\bhttps?:\/\/[^\s<>"'，。！？；：、（）【】《》]+/giu;
	let webMatch = webRegex.exec(content);
	while (webMatch !== null) {
		const wrapped = wrappedRanges.some(([start, end]) => webMatch !== null && webMatch.index >= start && webMatch.index < end);
		if (!wrapped) {
			matches.push({
				index: webMatch.index,
				link: { target: trimBareUrl(webMatch[0]), displayText: null, syntax: "url" },
			});
		}
		webMatch = webRegex.exec(content);
	}
	matches.sort((left, right) => left.index - right.index);
	return dedupeStable(matches.map((match) => match.link), (link) => `${link.syntax}\0${link.target}\0${link.displayText ?? ""}`);
}

function trimBareUrl(value: string): string {
	let target = value.replace(/[.,!?;:，。！？；：、]+$/u, "");
	for (const [opening, closing] of [["(", ")"], ["[", "]"], ["{", "}"]] as const) {
		while (target.endsWith(closing) && target.split(closing).length > target.split(opening).length) {
			target = target.slice(0, -1);
		}
	}
	return target;
}

function dedupeStable<T>(values: readonly T[], getKey: (value: T) => string): T[] {
	const seen = new Set<string>();
	return values.filter((value) => {
		const key = getKey(value);
		if (seen.has(key)) {
			return false;
		}
		seen.add(key);
		return true;
	});
}

import type { MemoObservation } from "../types/catalog";
import type { MemoLinkRef } from "../types/memo";
import { hashMemoContent, hashText } from "../utils/hash";
import { getMarkdownTaskLines } from "../utils/markdownTasks";
import {
	extractTrailingBlockId,
	findLastEffectiveLineIndex,
	isMarkdownHeadingLine,
	isMemoContinuationLine,
	isMemoStartLine,
	parseMemoImages,
	parseMemoTags,
	splitMarkdownLines,
} from "../utils/markdown";
import { extractTimeBuoyDates } from "../utils/timeBuoyParser";

export const CATALOG_PARSER_VERSION = 3;

export interface DiaryMemoParseInput {
	sourcePath: string;
	logicalDate: string;
	headings: readonly string[];
	bytes: Uint8Array;
}

export interface DiaryMemoParseResult {
	sourceRevision: string;
	observations: MemoObservation[];
}

export interface DiaryMemoRevisionParseInput {
	sourcePath: string;
	logicalDate: string;
	headings: readonly string[];
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

	async parse(input: DiaryMemoParseInput): Promise<DiaryMemoParseResult> {
		const sourceRevision = await this.digestBytes(input.bytes);
		const content = decodeUtf8(input.bytes);
		return this.parseRevision({
			sourcePath: input.sourcePath,
			logicalDate: input.logicalDate,
			headings: input.headings,
			content,
			sourceRevision,
		});
	}

	parseRevision(input: DiaryMemoRevisionParseInput): DiaryMemoParseResult {
		const { content, sourceRevision } = input;
		const lines = splitMarkdownLines(content);
		const allowedHeadings = new Set(input.headings.map((heading) => heading.trim()).filter(Boolean));
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
			if (currentSection !== null && !allowedHeadings.has(currentSection.trim())) {
				continue;
			}

			const parsed = parseDiaryMemoBlock(lines, lineIndex);
			if (parsed === null) {
				continue;
			}
			const metadataContent = maskProtectedMarkdown(parsed.content);
			const tasks = getMarkdownTaskLines(parsed.content).map((task) => ({
				taskIndex: task.index,
				lineOffset: parsed.contentStartLineOffset + task.lineIndex,
				marker: task.marker,
				text: task.body,
			}));
			observations.push({
				sourcePath: normalizeVaultPath(input.sourcePath),
				sourceRevision,
				rawBlockHash: hashText(lines.slice(parsed.startLine, parsed.endLine + 1).join("\n")),
				logicalDate: input.logicalDate,
				section: currentSection,
				startLine: parsed.startLine,
				endLine: parsed.endLine,
				time: parsed.time,
				content: parsed.content,
				contentHash: parsed.contentHash,
				existingBlockId: parsed.blockId,
				tags: parseMemoTags(metadataContent),
				links: parseMemoLinksInSourceOrder(metadataContent),
				images: dedupeStable(parseMemoImages(metadataContent), (image) => `${image.syntax}\0${image.path}\0${image.altText}`),
				tasks,
				timeBuoyDates: extractTimeBuoyDates(parsed.content),
			});
			lineIndex = parsed.endLine;
		}

		return { sourceRevision, observations };
	}
}

function parseDiaryMemoBlock(lines: readonly string[], startLine: number): ParsedDiaryMemoBlock | null {
	const firstLine = lines[startLine];
	const match = firstLine?.match(/^- (\d{2}:\d{2}(?::\d{2})?)(?: (.*))?$/u) ?? null;
	if (match === null) {
		return null;
	}

	const contentLines: string[] = [];
	const firstContent = extractTrailingBlockId(match[2] ?? "");
	let blockId = firstContent.blockId;
	if (match[2] !== undefined || blockId !== null) {
		contentLines.push(firstContent.text);
	}
	let endLine = startLine;
	for (let lineIndex = startLine + 1; lineIndex < lines.length; lineIndex += 1) {
		const line = lines[lineIndex];
		if (!isMemoContinuationLine(line)) {
			break;
		}
		contentLines.push(stripOneContinuationIndent(line));
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
	if (content.trim().length === 0) {
		return null;
	}
	return {
		startLine,
		endLine,
		time: match[1],
		content,
		contentStartLineOffset: match[2] === undefined ? 1 : 0,
		contentHash: hashMemoContent(content),
		blockId,
	};
}

function stripOneContinuationIndent(line: string): string {
	return line.startsWith("\t") ? line.slice(1) : line.slice(2);
}

export async function sha256Bytes(bytes: Uint8Array): Promise<string> {
	const cryptoApi = typeof crypto === "undefined" ? undefined : crypto;
	if (cryptoApi?.subtle === undefined) {
		throw new Error("Web Crypto SHA-256 is unavailable.");
	}
	const digestInput = new Uint8Array(bytes.byteLength);
	digestInput.set(bytes);
	const digest = await cryptoApi.subtle.digest("SHA-256", digestInput.buffer);
	return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

export function extractDailyExplicitReferenceTargets(content: string): string[] {
	const searchable = maskProtectedMarkdown(content);
	const matches: Array<{ index: number; target: string }> = [];
	const patterns = [
		/!?\[\[([^\]]*#\^[A-Za-z0-9_-]+)(?:\|[^\]]*)?\]\]/gu,
		/\[[^\]]*\]\(([^)\s]*#\^[A-Za-z0-9_-]+)\)/gu,
	];
	for (const pattern of patterns) {
		let match = pattern.exec(searchable);
		while (match !== null) {
			matches.push({ index: match.index, target: match[1] });
			match = pattern.exec(searchable);
		}
	}
	matches.sort((left, right) => left.index - right.index);
	return dedupeStable(matches.map((match) => match.target), (target) => target);
}

export function getIndexableDiaryMemoContent(content: string): string {
	return maskProtectedMarkdown(content);
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
	const time = line.match(/^- (\d{2}:\d{2}(?::\d{2})?)(?: |$)/u)?.[1] ?? "";
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
		if (content.charAt(wikiMatch.index - 1) !== "!") {
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
	const markdownRegex = /\[([^\]]+)\]\(([^)]+)\)/gu;
	let markdownMatch = markdownRegex.exec(content);
	while (markdownMatch !== null) {
		wrappedRanges.push([markdownMatch.index, markdownMatch.index + markdownMatch[0].length]);
		if (content.charAt(markdownMatch.index - 1) !== "!") {
			matches.push({
				index: markdownMatch.index,
				link: {
					target: markdownMatch[2],
					displayText: markdownMatch[1],
					syntax: "markdown_link",
				},
			});
		}
		markdownMatch = markdownRegex.exec(content);
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

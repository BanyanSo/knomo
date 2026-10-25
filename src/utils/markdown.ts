import { parser, GFM } from "@lezer/markdown";
import type { MemoImageRef } from "../types/memo";
import { decodePercentEncodedImagePath, parseMarkdownImages } from "./markdownImages";

const MARKDOWN_HEADING_REGEX = /^(#{1,6})\s+\S.*$/;
const MEMO_START_LINE_REGEX = /^-(?: | {3})\d{2}:\d{2}(?::\d{2})?(?: .*)?$/;
const MEMO_CONTINUATION_INDENT_REGEX = /^(?:\t| {2,})/;
const FOUR_COLUMN_MEMO_INDENT_REGEX = /^(?: {0,3}\t| {4})/u;
const WEB_URL_REGEX = /\bhttps?:\/\/[^\s<>"'，。！？；：、（）【】《》]+/gi;
const URL_TRAILING_PUNCTUATION_REGEX = /[.,!?;:，。！？；：、]+$/u;
const URL_CLOSING_DELIMITERS = [["(", ")"], ["[", "]"], ["{", "}"]] as const;
const TAG_REGEX = /(^|[\s([{])#([^\s#\]]+)/g;
const OBSIDIAN_IMAGE_EXTENSIONS = new Set(["avif", "bmp", "gif", "jpeg", "jpg", "png", "svg", "webp"]);
const memoMarkdown = parser.configure(GFM);

export function parseMemoMarkdown(content: string) {
	return memoMarkdown.parse(content);
}

export function extractLeadingParagraphBlockId(content: string): { text: string; blockId: string | null } {
	if (!content.includes(" ^")) return { text: content, blockId: null };
	const paragraph = parseMemoMarkdown(content).topNode.firstChild;
	if (paragraph?.name !== "Paragraph") return { text: content, blockId: null };
	const start = content.lastIndexOf("\n", paragraph.to - 1) + 1;
	const nextLine = content.indexOf("\n", start);
	const end = nextLine === -1 ? content.length : nextLine;
	const match = content.slice(start, end).match(/^(.*) \^([A-Za-z0-9_-]+)$/u);
	if (match === null) return { text: content, blockId: null };
	// 贪婪保留原有行尾空白，只移除段末 ID 及写入时追加的单个分隔空格。
	return { text: content.slice(0, start) + match[1] + content.slice(end), blockId: match[2] };
}

export function isValidMarkdownHeading(value: string): boolean {
	return MARKDOWN_HEADING_REGEX.test(value.trim());
}

export function extractTrailingBlockId(value: string): { text: string; blockId: string | null } {
	const match = value.match(/^(.*?)(?:\s+\^([A-Za-z0-9_-]+)\s*)$/);
	if (!match) {
		return { text: value, blockId: null };
	}
	return {
		text: match[1],
		blockId: match[2],
	};
}

export function isMemoStartLine(value: string): boolean {
	return MEMO_START_LINE_REGEX.test(value);
}

export function isMarkdownHeadingLine(value: string): boolean {
	return MARKDOWN_HEADING_REGEX.test(value.trim());
}

export function indentMemoContinuationLine(value: string): string {
	// 与外层 "- " 的两列宽度相同，避免 Tab 展开后改变正文原有缩进语义。
	return `  ${value}`;
}

export function normalizeMarkdownLineEndings(value: string): string {
	return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function splitMarkdownLines(value: string): string[] {
	return normalizeMarkdownLineEndings(value).split("\n");
}

export function findLastEffectiveLineIndex(lines: string[]): number {
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		if (lines[index].trim().length > 0) {
			return index;
		}
	}
	return -1;
}

export function isMemoContinuationLine(value: string, columns: 2 | 4 = 2): boolean {
	return MEMO_CONTINUATION_INDENT_REGEX.test(value) || (columns === 4 && FOUR_COLUMN_MEMO_INDENT_REGEX.test(value));
}

export function stripMemoContinuationIndent(value: string, columns: 2 | 4): string {
	// 四列容器只移除外层缩进；Tab 及停靠到第四列的混合缩进等价于四个空格。
	const fourColumnIndent = columns === 4 ? FOUR_COLUMN_MEMO_INDENT_REGEX.exec(value)?.[0] : undefined;
	if (fourColumnIndent !== undefined) return value.slice(fourColumnIndent.length);
	// 旧两列规则及不足四列的既有 continuation 保持原有读取行为。
	return value.startsWith("\t") ? value.slice(1) : value.replace(/^ {2}/u, "");
}

export function getFourColumnMemoPrefix(lines: readonly string[], startLine = 0): {
	firstContent: string | null;
	blockId: string | null;
	contentStartLineOffset: 0 | 1 | 2;
} | null {
	const match = lines[startLine]?.match(/^- {3}\d{2}:\d{2}(?::\d{2})?(?: (.*))?$/u);
	if (!match) return null;
	const headerContent = match[1];
	const headerId = headerContent?.match(/^\^([A-Za-z0-9_-]+)$/u)?.[1];
	if (headerContent !== undefined && headerId === undefined) {
		return { firstContent: headerContent, blockId: null, contentStartLineOffset: 0 };
	}
	if (!isMemoContinuationLine(lines[startLine + 1] ?? "", 4)) return null;
	// 保留已写入的分隔前缀；无分隔前缀的独立块从下一行读取，不新增正文空行。
	const separator = lines[startLine + 1];
	const separated = FOUR_COLUMN_MEMO_INDENT_REGEX.test(separator) && stripMemoContinuationIndent(separator, 4) === ""
		&& isMemoContinuationLine(lines[startLine + 2] ?? "", 4);
	return { firstContent: null, blockId: headerId ?? null, contentStartLineOffset: separated ? 2 : 1 };
}

export function parseMemoTags(content: string): string[] {
	const tags: string[] = [];
	for (const range of memoTagRanges(content)) {
		const tag = content.slice(range.from + 1, range.to);
		if (!tags.includes(tag)) {
			tags.push(tag);
		}
	}
	return tags;
}

// Composer 与 Catalog 共用词法边界；上下文隔离由 Composer 模型负责。
export function memoTagRanges(content: string): { from: number; to: number }[] {
	const ranges: { from: number; to: number }[] = [];
	const expression = new RegExp(TAG_REGEX);
	let match: RegExpExecArray | null;
	while ((match = expression.exec(content)) !== null) ranges.push({ from: match.index + match[1].length, to: match.index + match[0].length });
	return ranges;
}

export function memoUrlRanges(content: string): { from: number; to: number }[] {
	const ranges: { from: number; to: number }[] = [];
	const expression = new RegExp(WEB_URL_REGEX);
	let match: RegExpExecArray | null;
	while ((match = expression.exec(content)) !== null) ranges.push({ from: match.index, to: match.index + trimBareUrl(match[0]).length });
	return ranges;
}

export function parseMemoImages(content: string): MemoImageRef[] {
	return parseMarkdownImages(content)
		.filter((image) => image.syntax === "markdown_image" || isSupportedObsidianImagePath(image.path))
		.map((image) => ({
			path: normalizeMemoImagePath(image),
			altText: image.altText,
			syntax: image.syntax,
		}));
}

function trimBareUrl(value: string): string {
	let target = value.replace(URL_TRAILING_PUNCTUATION_REGEX, "");
	for (const [opening, closing] of URL_CLOSING_DELIMITERS) {
		while (
			target.endsWith(closing)
			&& target.split(closing).length > target.split(opening).length
		) {
			target = target.slice(0, -1);
		}
	}
	return target;
}

function isSupportedObsidianImagePath(path: string): boolean {
	const extensionIndex = path.lastIndexOf(".");
	if (extensionIndex === -1) {
		return false;
	}
	return OBSIDIAN_IMAGE_EXTENSIONS.has(path.slice(extensionIndex + 1).toLowerCase());
}

function normalizeMemoImagePath(image: { path: string; syntax: string }): string {
	if (image.syntax === "markdown_image" && !hasUrlScheme(image.path)) {
		return decodePercentEncodedImagePath(image.path);
	}
	return image.path;
}

function hasUrlScheme(value: string): boolean {
	return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value);
}

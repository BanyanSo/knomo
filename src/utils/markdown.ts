import type { MemoImageRef, MemoLinkRef } from "../types/memo";
import { decodePercentEncodedImagePath, parseMarkdownImages } from "./markdownImages";

const MARKDOWN_HEADING_REGEX = /^(#{1,6})\s+\S.*$/;
const MEMO_START_LINE_REGEX = /^- \d{2}:\d{2}(?::\d{2})?(?: .*)?$/;
const MEMO_CONTINUATION_INDENT_REGEX = /^(?:\t| {2,})/;
const OBSIDIAN_LINK_REGEX = /\[\[([^\]]+)\]\]/g;
const MARKDOWN_LINK_REGEX = /\[([^\]]+)\]\(([^)]+)\)/g;
const WEB_URL_REGEX = /\bhttps?:\/\/[^\s<>"'，。！？；：、（）【】《》]+/gi;
const URL_TRAILING_PUNCTUATION_REGEX = /[.,!?;:，。！？；：、]+$/u;
const URL_CLOSING_DELIMITERS = [["(", ")"], ["[", "]"], ["{", "}"]] as const;
const TAG_REGEX = /(^|[\s([{])#([^\s#\]]+)/g;
const OBSIDIAN_IMAGE_EXTENSIONS = new Set(["avif", "bmp", "gif", "jpeg", "jpg", "png", "svg", "webp"]);

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
	return `\t${value}`;
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

export function isMemoContinuationLine(value: string): boolean {
	return MEMO_CONTINUATION_INDENT_REGEX.test(value);
}

export function stripMemoContinuationIndent(value: string): string {
	return value.replace(MEMO_CONTINUATION_INDENT_REGEX, "");
}

export function parseMemoTags(content: string): string[] {
	const tags: string[] = [];
	TAG_REGEX.lastIndex = 0;
	let match = TAG_REGEX.exec(content);
	while (match !== null) {
		const tag = match[2];
		if (!tags.includes(tag)) {
			tags.push(tag);
		}
		match = TAG_REGEX.exec(content);
	}
	return tags;
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

export function isSupportedMemoImage(image: MemoImageRef): boolean {
	if (image.syntax === "markdown_image") {
		return true;
	}
	return isSupportedObsidianImagePath(extractObsidianEmbedPath(image.path));
}

export function parseMemoLinks(content: string): MemoLinkRef[] {
	const links: MemoLinkRef[] = [];
	const wrappedLinkRanges: Array<[number, number]> = [];
	OBSIDIAN_LINK_REGEX.lastIndex = 0;
	let obsidianLinkMatch = OBSIDIAN_LINK_REGEX.exec(content);
	while (obsidianLinkMatch !== null) {
		wrappedLinkRanges.push([obsidianLinkMatch.index, obsidianLinkMatch.index + obsidianLinkMatch[0].length]);
		if (content.charAt(obsidianLinkMatch.index - 1) !== "!") {
			const [target, displayText] = splitLinkAlias(obsidianLinkMatch[1]);
			links.push({
				target,
				displayText,
				syntax: "wiki_link",
			});
		}
		obsidianLinkMatch = OBSIDIAN_LINK_REGEX.exec(content);
	}

	MARKDOWN_LINK_REGEX.lastIndex = 0;
	let markdownLinkMatch = MARKDOWN_LINK_REGEX.exec(content);
	while (markdownLinkMatch !== null) {
		wrappedLinkRanges.push([markdownLinkMatch.index, markdownLinkMatch.index + markdownLinkMatch[0].length]);
		if (content.charAt(markdownLinkMatch.index - 1) !== "!") {
			links.push({
				target: markdownLinkMatch[2],
				displayText: markdownLinkMatch[1],
				syntax: "markdown_link",
			});
		}
		markdownLinkMatch = MARKDOWN_LINK_REGEX.exec(content);
	}

	WEB_URL_REGEX.lastIndex = 0;
	let webUrlMatch = WEB_URL_REGEX.exec(content);
	while (webUrlMatch !== null) {
		const matchIndex = webUrlMatch.index;
		const isWrappedLink = wrappedLinkRanges.some(([start, end]) => matchIndex >= start && matchIndex < end);
		if (!isWrappedLink) {
			links.push({
				target: trimBareUrl(webUrlMatch[0]),
				displayText: null,
				syntax: "url",
			});
		}
		webUrlMatch = WEB_URL_REGEX.exec(content);
	}
	return links;
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

function splitLinkAlias(value: string): [string, string | null] {
	const separatorIndex = value.indexOf("|");
	if (separatorIndex === -1) {
		return [value, null];
	}
	return [value.slice(0, separatorIndex), value.slice(separatorIndex + 1)];
}

function extractObsidianEmbedPath(value: string): string {
	const [target] = splitLinkAlias(value);
	const subpathIndex = target.indexOf("#");
	return (subpathIndex === -1 ? target : target.slice(0, subpathIndex)).trim();
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

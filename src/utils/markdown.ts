import type { MemoImageRef, MemoLinkRef } from "../types/memo";

const MARKDOWN_HEADING_REGEX = /^(#{1,6})\s+\S.*$/;
const TRAILING_BLOCK_ID_REGEX = /\s+\^[A-Za-z0-9_-]+\s*$/;
const MEMO_START_LINE_REGEX = /^- \d{2}:\d{2}(?::\d{2})? .*$/;
const OBSIDIAN_IMAGE_REGEX = /!\[\[([^\]]+)\]\]/g;
const OBSIDIAN_LINK_REGEX = /\[\[([^\]]+)\]\]/g;
const MARKDOWN_IMAGE_REGEX = /!\[([^\]]*)\]\(([^)]+)\)/g;
const MARKDOWN_LINK_REGEX = /\[([^\]]+)\]\(([^)]+)\)/g;
const TAG_REGEX = /(^|[\s([{])#([^\s#\]]+)/g;
const OBSIDIAN_IMAGE_EXTENSIONS = new Set(["avif", "bmp", "gif", "jpeg", "jpg", "png", "svg", "webp"]);

export function isValidMarkdownHeading(value: string): boolean {
	return MARKDOWN_HEADING_REGEX.test(value.trim());
}

export function stripTrailingBlockId(value: string): string {
	return value.replace(TRAILING_BLOCK_ID_REGEX, "");
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

export function findLineNumber(content: string, block: string, preferLast = false): number | null {
	const normalizedContent = normalizeMarkdownLineEndings(content);
	const normalizedBlock = normalizeMarkdownLineEndings(block);
	const index = preferLast ? normalizedContent.lastIndexOf(normalizedBlock) : normalizedContent.indexOf(normalizedBlock);
	if (index === -1) {
		return null;
	}
	return normalizedContent.slice(0, index).split("\n").length;
}

export function isMemoContinuationLine(value: string): boolean {
	return /^ {2,}/.test(value);
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
	const images: MemoImageRef[] = [];
	OBSIDIAN_IMAGE_REGEX.lastIndex = 0;
	let obsidianImageMatch = OBSIDIAN_IMAGE_REGEX.exec(content);
	while (obsidianImageMatch !== null) {
		const path = extractObsidianEmbedPath(obsidianImageMatch[1]);
		if (isSupportedObsidianImagePath(path)) {
			images.push({
				path,
				altText: "",
				syntax: "obsidian_embed",
			});
		}
		obsidianImageMatch = OBSIDIAN_IMAGE_REGEX.exec(content);
	}

	MARKDOWN_IMAGE_REGEX.lastIndex = 0;
	let markdownImageMatch = MARKDOWN_IMAGE_REGEX.exec(content);
	while (markdownImageMatch !== null) {
		images.push({
			path: markdownImageMatch[2],
			altText: markdownImageMatch[1],
			syntax: "markdown_image",
		});
		markdownImageMatch = MARKDOWN_IMAGE_REGEX.exec(content);
	}
	return images;
}

export function isSupportedMemoImage(image: MemoImageRef): boolean {
	if (image.syntax === "markdown_image") {
		return true;
	}
	return isSupportedObsidianImagePath(extractObsidianEmbedPath(image.path));
}

export function parseMemoLinks(content: string): MemoLinkRef[] {
	const links: MemoLinkRef[] = [];
	OBSIDIAN_LINK_REGEX.lastIndex = 0;
	let obsidianLinkMatch = OBSIDIAN_LINK_REGEX.exec(content);
	while (obsidianLinkMatch !== null) {
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
		if (content.charAt(markdownLinkMatch.index - 1) !== "!") {
			links.push({
				target: markdownLinkMatch[2],
				displayText: markdownLinkMatch[1],
				syntax: "markdown_link",
			});
		}
		markdownLinkMatch = MARKDOWN_LINK_REGEX.exec(content);
	}
	return links;
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

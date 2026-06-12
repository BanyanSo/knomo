import type { App, TFile } from "obsidian";

export interface MemoCardPreview {
	text: string;
	images: MemoPreviewImage[];
}

export interface MemoPreviewImage {
	raw: string;
	path: string;
	alt?: string;
	url?: string;
	isRemote: boolean;
	file?: TFile;
	unresolved?: boolean;
}

const IMAGE_EXTENSIONS = new Set(["avif", "bmp", "gif", "jpeg", "jpg", "png", "svg", "webp"]);
const UNSUPPORTED_URL_SCHEMES = new Set(["blob", "data", "file", "javascript", "obsidian"]);

interface ProtectedRange {
	start: number;
	end: number;
}

interface ParsedImageSyntax {
	raw: string;
	path: string;
	alt?: string;
	kind: "wiki" | "markdown";
}

export function parseMemoCardPreview(content: string, sourcePath: string, app: App): MemoCardPreview {
	const protectedRanges = buildProtectedRanges(content);
	const images: MemoPreviewImage[] = [];
	let text = "";
	let index = 0;

	while (index < content.length) {
		const protectedEnd = getProtectedEnd(index, protectedRanges);
		if (protectedEnd !== null) {
			text += content.slice(index, protectedEnd);
			index = protectedEnd;
			continue;
		}

		const syntax = parseImageSyntaxAt(content, index);
		if (syntax === null) {
			text += content[index];
			index += 1;
			continue;
		}

		const image = resolvePreviewImage(syntax, sourcePath, app);
		if (image === null) {
			text += syntax.raw;
		} else {
			images.push(image);
		}
		index += syntax.raw.length;
	}

	return {
		text: normalizePreviewText(text),
		images,
	};
}

function parseImageSyntaxAt(content: string, index: number): ParsedImageSyntax | null {
	if (content.startsWith("![[", index)) {
		return parseWikiImageAt(content, index);
	}
	if (content.startsWith("![", index)) {
		return parseMarkdownImageAt(content, index);
	}
	return null;
}

function parseWikiImageAt(content: string, index: number): ParsedImageSyntax | null {
	const closeIndex = content.indexOf("]]", index + 3);
	if (closeIndex === -1) {
		return null;
	}
	const raw = content.slice(index, closeIndex + 2);
	const path = normalizeWikiImagePath(content.slice(index + 3, closeIndex));
	if (path.length === 0) {
		return null;
	}
	return {
		raw,
		path,
		kind: "wiki",
	};
}

function parseMarkdownImageAt(content: string, index: number): ParsedImageSyntax | null {
	const closeAltIndex = content.indexOf("]", index + 2);
	if (closeAltIndex === -1 || content.charAt(closeAltIndex + 1) !== "(") {
		return null;
	}
	const closeDestIndex = findMarkdownImageDestinationEnd(content, closeAltIndex + 2);
	if (closeDestIndex === -1) {
		return null;
	}
	const rawDestination = content.slice(closeAltIndex + 2, closeDestIndex);
	const path = normalizeMarkdownImageDestination(rawDestination);
	if (path.length === 0) {
		return null;
	}
	return {
		raw: content.slice(index, closeDestIndex + 1),
		path,
		alt: content.slice(index + 2, closeAltIndex),
		kind: "markdown",
	};
}

function findMarkdownImageDestinationEnd(content: string, destinationStart: number): number {
	const firstChar = content.charAt(destinationStart);
	if (firstChar === "<") {
		const closeAngleIndex = content.indexOf(">", destinationStart + 1);
		if (closeAngleIndex === -1) {
			return -1;
		}
		let index = closeAngleIndex + 1;
		while (content.charAt(index) === " " || content.charAt(index) === "\t") {
			index += 1;
		}
		return content.charAt(index) === ")" ? index : -1;
	}
	return content.indexOf(")", destinationStart);
}

function resolvePreviewImage(syntax: ParsedImageSyntax, sourcePath: string, app: App): MemoPreviewImage | null {
	const scheme = getUrlScheme(syntax.path);
	if (scheme !== null) {
		if (syntax.kind === "markdown" && (scheme === "http" || scheme === "https") && isSupportedImagePath(syntax.path)) {
			return {
				raw: syntax.raw,
				path: syntax.path,
				alt: syntax.alt,
				url: syntax.path,
				isRemote: true,
			};
		}
		if (UNSUPPORTED_URL_SCHEMES.has(scheme)) {
			return {
				raw: "",
				path: "",
				alt: syntax.alt,
				isRemote: false,
				unresolved: true,
			};
		}
		return null;
	}

	if (!isSupportedImagePath(syntax.path)) {
		return null;
	}

	const file = app.metadataCache.getFirstLinkpathDest(syntax.path, sourcePath);
	if (file === null) {
		return {
			raw: syntax.raw,
			path: syntax.path,
			alt: syntax.alt,
			isRemote: false,
			unresolved: true,
		};
	}
	return {
		raw: syntax.raw,
		path: syntax.path,
		alt: syntax.alt,
		url: app.vault.getResourcePath(file),
		isRemote: false,
		file,
	};
}

function normalizeWikiImagePath(value: string): string {
	const aliasIndex = value.indexOf("|");
	const pathWithFragment = (aliasIndex === -1 ? value : value.slice(0, aliasIndex)).trim();
	const fragmentIndex = pathWithFragment.indexOf("#");
	return (fragmentIndex === -1 ? pathWithFragment : pathWithFragment.slice(0, fragmentIndex)).trim();
}

function normalizeMarkdownImageDestination(value: string): string {
	const trimmed = value.trim();
	if (trimmed.startsWith("<") && trimmed.endsWith(">")) {
		return trimmed.slice(1, -1).trim();
	}
	return trimmed;
}

function isSupportedImagePath(path: string): boolean {
	const pathWithoutQuery = path.split(/[?#]/, 1)[0];
	const extensionIndex = pathWithoutQuery.lastIndexOf(".");
	if (extensionIndex === -1) {
		return false;
	}
	return IMAGE_EXTENSIONS.has(pathWithoutQuery.slice(extensionIndex + 1).toLowerCase());
}

function getUrlScheme(value: string): string | null {
	const match = value.match(/^([A-Za-z][A-Za-z0-9+.-]*):/);
	return match === null ? null : match[1].toLowerCase();
}

function normalizePreviewText(value: string): string {
	return value.replace(/[ \t]+$/gm, "").trim();
}

function buildProtectedRanges(content: string): ProtectedRange[] {
	const fencedRanges = buildFencedCodeRanges(content);
	return [...fencedRanges, ...buildInlineCodeRanges(content, fencedRanges)]
		.sort((a, b) => a.start - b.start);
}

function buildFencedCodeRanges(content: string): ProtectedRange[] {
	const ranges: ProtectedRange[] = [];
	let index = 0;
	let fenceStart: number | null = null;
	let fenceChar = "";
	let fenceLength = 0;

	while (index < content.length) {
		const lineEnd = content.indexOf("\n", index);
		const end = lineEnd === -1 ? content.length : lineEnd + 1;
		const line = content.slice(index, lineEnd === -1 ? content.length : lineEnd);
		const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/);
		if (fenceStart === null) {
			if (fenceMatch !== null) {
				fenceStart = index;
				fenceChar = fenceMatch[1].charAt(0);
				fenceLength = fenceMatch[1].length;
			}
		} else if (isClosingFence(line, fenceChar, fenceLength)) {
			ranges.push({ start: fenceStart, end });
			fenceStart = null;
			fenceChar = "";
			fenceLength = 0;
		}
		index = end;
	}

	if (fenceStart !== null) {
		ranges.push({ start: fenceStart, end: content.length });
	}
	return ranges;
}

function buildInlineCodeRanges(content: string, fencedRanges: ProtectedRange[]): ProtectedRange[] {
	const ranges: ProtectedRange[] = [];
	let index = 0;
	while (index < content.length) {
		const fencedEnd = getProtectedEnd(index, fencedRanges);
		if (fencedEnd !== null) {
			index = fencedEnd;
			continue;
		}
		if (content.charAt(index) !== "`") {
			index += 1;
			continue;
		}
		const markerLength = countBackticks(content, index);
		const closeIndex = findClosingBackticks(content, index + markerLength, markerLength, fencedRanges);
		if (closeIndex === -1) {
			index += markerLength;
			continue;
		}
		ranges.push({ start: index, end: closeIndex + markerLength });
		index = closeIndex + markerLength;
	}
	return ranges;
}

function isClosingFence(line: string, fenceChar: string, fenceLength: number): boolean {
	const escapedFence = fenceChar === "`" ? "`" : "~";
	const pattern = new RegExp(`^ {0,3}${escapedFence}{${fenceLength},}\\s*$`);
	return pattern.test(line);
}

function countBackticks(content: string, start: number): number {
	let index = start;
	while (content.charAt(index) === "`") {
		index += 1;
	}
	return index - start;
}

function findClosingBackticks(content: string, start: number, markerLength: number, fencedRanges: ProtectedRange[]): number {
	let index = start;
	while (index < content.length) {
		const fencedEnd = getProtectedEnd(index, fencedRanges);
		if (fencedEnd !== null) {
			index = fencedEnd;
			continue;
		}
		if (content.charAt(index) === "`" && countBackticks(content, index) === markerLength) {
			return index;
		}
		index += 1;
	}
	return -1;
}

function getProtectedEnd(index: number, ranges: ProtectedRange[]): number | null {
	for (const range of ranges) {
		if (index < range.start) {
			return null;
		}
		if (index >= range.start && index < range.end) {
			return range.end;
		}
	}
	return null;
}

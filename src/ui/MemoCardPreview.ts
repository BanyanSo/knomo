import type { App, TFile } from "obsidian";

import { parseMarkdownImages } from "../utils/markdownImages";
import type { ParsedMarkdownImage } from "../utils/markdownImages";

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
	resourcePath?: string;
	unresolved?: boolean;
}

const IMAGE_EXTENSIONS = new Set(["avif", "bmp", "gif", "jpeg", "jpg", "png", "svg", "webp"]);
const UNSUPPORTED_URL_SCHEMES = new Set(["blob", "data", "file", "javascript", "obsidian"]);

export function parseMemoCardPreview(content: string, sourcePath: string, app: App): MemoCardPreview {
	const images: MemoPreviewImage[] = [];
	const textParts: string[] = [];
	let textStart = 0;
	for (const syntax of parseMarkdownImages(content)) {
		const image = resolvePreviewImage(syntax, sourcePath, app);
		if (image === null) {
			continue;
		}
		textParts.push(content.slice(textStart, syntax.start));
		images.push(image);
		textStart = syntax.end;
	}
	textParts.push(content.slice(textStart));

	return {
		text: normalizePreviewText(textParts.join("")),
		images,
	};
}

function resolvePreviewImage(syntax: ParsedMarkdownImage, sourcePath: string, app: App): MemoPreviewImage | null {
	const scheme = getUrlScheme(syntax.path);
	if (scheme !== null) {
		if (syntax.syntax === "markdown_image" && (scheme === "http" || scheme === "https") && isSupportedImagePath(syntax.path)) {
			return {
				raw: syntax.raw,
				path: syntax.path,
				alt: syntax.altText,
				url: syntax.path,
				isRemote: true,
			};
		}
		if (UNSUPPORTED_URL_SCHEMES.has(scheme)) {
			return {
				raw: "",
				path: "",
				alt: syntax.altText,
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
			alt: syntax.altText,
			isRemote: false,
			unresolved: true,
		};
	}
	const resourceUrl = app.vault.getResourcePath(file);
	return {
		raw: syntax.raw,
		path: syntax.path,
		alt: syntax.altText,
		url: appendResourceVersion(resourceUrl, file.stat?.mtime),
		isRemote: false,
		file,
		resourcePath: file.path,
	};
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

function appendResourceVersion(url: string, modifiedAt: number | undefined): string {
	if (modifiedAt === undefined) {
		return url;
	}
	const hashIndex = url.indexOf("#");
	const base = hashIndex === -1 ? url : url.slice(0, hashIndex);
	const fragment = hashIndex === -1 ? "" : url.slice(hashIndex);
	const separator = base.includes("?") ? "&" : "?";
	return `${base}${separator}knomo-mtime=${modifiedAt}${fragment}`;
}

function normalizePreviewText(value: string): string {
	return value.replace(/[ \t]+$/gm, "").trim();
}

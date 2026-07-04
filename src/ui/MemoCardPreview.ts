import type { App, TFile } from "obsidian";

import { decodePercentEncodedImagePath, parseMarkdownImages } from "../utils/markdownImages";
import type { ParsedMarkdownImage } from "../utils/markdownImages";
import { ImageResourceCache } from "./ImageResourceCache";

export interface MemoCardPreview {
	text: string;
	images: MemoPreviewImage[];
}

export interface MemoCardPreviewLite {
	text: string;
	imageRefs: MemoPreviewImageRef[];
}

export interface MemoPreviewImageRef {
	raw: string;
	path: string;
	alt?: string;
	isRemote: boolean;
	url?: string;
	unresolved?: boolean;
	start: number;
	end: number;
}

export interface MemoPreviewImage {
	raw: string;
	path: string;
	alt?: string;
	url?: string;
	isRemote: boolean;
	file?: TFile;
	resourcePath?: string;
	mtime?: number;
	unresolved?: boolean;
	start?: number;
	end?: number;
}

const IMAGE_EXTENSIONS = new Set(["avif", "bmp", "gif", "jpeg", "jpg", "png", "svg", "webp"]);
const UNSUPPORTED_URL_SCHEMES = new Set(["blob", "data", "file", "javascript", "obsidian"]);

export function parseMemoCardPreview(
	content: string,
	sourcePath: string,
	app: App,
	imageResourceCache = new ImageResourceCache(),
): MemoCardPreview {
	return resolveMemoPreviewImages(parseMemoCardPreviewLite(content), sourcePath, app, imageResourceCache);
}

export function parseMemoCardPreviewLite(content: string): MemoCardPreviewLite {
	const imageRefs: MemoPreviewImageRef[] = [];
	const textParts: string[] = [];
	let textStart = 0;
	for (const syntax of parseMarkdownImages(content)) {
		const imageRef = parsePreviewImageRef(syntax);
		if (imageRef === null) {
			continue;
		}
		textParts.push(content.slice(textStart, syntax.start));
		imageRefs.push(imageRef);
		textStart = syntax.end;
	}
	textParts.push(content.slice(textStart));

	return {
		text: normalizePreviewText(textParts.join("")),
		imageRefs,
	};
}

export function resolveMemoPreviewImages(
	preview: MemoCardPreviewLite,
	sourcePath: string,
	app: App,
	imageResourceCache: ImageResourceCache,
): MemoCardPreview {
	return {
		text: preview.text,
		images: preview.imageRefs.map((imageRef) => resolvePreviewImage(imageRef, sourcePath, app, imageResourceCache)),
	};
}

function parsePreviewImageRef(syntax: ParsedMarkdownImage): MemoPreviewImageRef | null {
	const scheme = getUrlScheme(syntax.path);
	if (scheme !== null) {
		if (syntax.syntax === "markdown_image" && (scheme === "http" || scheme === "https") && isSupportedImagePath(syntax.path)) {
			return {
				raw: syntax.raw,
				path: syntax.path,
				alt: syntax.altText,
				url: syntax.path,
				isRemote: true,
				start: syntax.start,
				end: syntax.end,
			};
		}
		if (UNSUPPORTED_URL_SCHEMES.has(scheme)) {
			return {
				raw: "",
				path: "",
				alt: syntax.altText,
				isRemote: false,
				unresolved: true,
				start: syntax.start,
				end: syntax.end,
			};
		}
		return null;
	}

	const localPath = decodePercentEncodedImagePath(syntax.path);
	if (!isSupportedImagePath(localPath)) {
		return null;
	}
	return {
		raw: syntax.raw,
		path: localPath,
		alt: syntax.altText,
		isRemote: false,
		start: syntax.start,
		end: syntax.end,
	};
}

function resolvePreviewImage(
	imageRef: MemoPreviewImageRef,
	sourcePath: string,
	app: App,
	imageResourceCache: ImageResourceCache,
): MemoPreviewImage {
	if (imageRef.isRemote || imageRef.unresolved === true) {
		return { ...imageRef };
	}
	const resource = imageResourceCache.get(sourcePath, imageRef.path, app);
	if (resource.missing) {
		return {
			...imageRef,
			isRemote: false,
			unresolved: true,
		};
	}
	return {
		...imageRef,
		url: resource.url,
		isRemote: false,
		file: resource.file,
		resourcePath: resource.resourcePath,
		mtime: resource.mtime,
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

function normalizePreviewText(value: string): string {
	return value.replace(/[ \t]+$/gm, "").trim();
}

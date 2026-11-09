import { normalizeImagePath, getImagePathBasename } from "../utils/imagePath";
import type { App, TFile } from "obsidian";

export interface ImageResourceCacheValue {
	file?: TFile;
	resourcePath?: string;
	url?: string;
	mtime?: number;
	missing: boolean;
}

interface ImageResourceCacheEntry {
	rawPath: string;
	value: ImageResourceCacheValue;
}

export const IMAGE_RESOURCE_CACHE_LIMIT = 1_024;

export class ImageResourceCache {
	private readonly entries = new Map<string, ImageResourceCacheEntry>();

	get(sourcePath: string, rawPath: string, app: App): ImageResourceCacheValue {
		const key = getImageResourceCacheKey(sourcePath, rawPath);
		const cached = this.entries.get(key);
		if (cached !== undefined) {
			this.entries.delete(key);
			this.entries.set(key, cached);
			return cached.value;
		}
		const file = app.metadataCache.getFirstLinkpathDest(rawPath, sourcePath);
		const value = file === null
			? { missing: true }
			: {
				file,
				resourcePath: file.path,
				url: appendResourceVersion(app.vault.getResourcePath(file), file.stat?.mtime),
				mtime: file.stat?.mtime,
				missing: false,
			};
		this.entries.set(key, { rawPath, value });
		if (this.entries.size > IMAGE_RESOURCE_CACHE_LIMIT) {
			const oldest = this.entries.keys().next().value;
			if (oldest !== undefined) this.entries.delete(oldest);
		}
		return value;
	}

	invalidateImagePaths(paths: readonly string[]): void {
		const normalizedPaths = new Set(paths.map(normalizeImagePath));
		const basenames = new Set([...normalizedPaths].map(getImagePathBasename));
		for (const [key, entry] of this.entries) {
			const resolvedPath = entry.value.resourcePath;
			if (resolvedPath !== undefined && normalizedPaths.has(normalizeImagePath(resolvedPath))) {
				this.entries.delete(key);
				continue;
			}
			const rawPath = normalizeImagePath(entry.rawPath);
			if (normalizedPaths.has(rawPath) || basenames.has(getImagePathBasename(rawPath))) {
				this.entries.delete(key);
			}
		}
	}

	invalidateMissing(): void {
		for (const [key, entry] of this.entries) {
			if (entry.value.missing) this.entries.delete(key);
		}
	}

	getPathsInFolders(matches: (path: string) => boolean): string[] {
		const paths = new Set<string>();
		for (const { rawPath, value } of this.entries.values()) {
			if (matches(rawPath)) paths.add(rawPath);
			if (value.resourcePath !== undefined && matches(value.resourcePath)) paths.add(value.resourcePath);
		}
		return [...paths];
	}

	clear(): void {
		this.entries.clear();
	}
}

function getImageResourceCacheKey(sourcePath: string, rawPath: string): string {
	return encodeParts([sourcePath, rawPath]);
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

function encodeParts(parts: readonly string[]): string {
	return parts.map((part) => `${part.length}:${part}`).join("");
}

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

export class ImageResourceCache {
	private readonly entries = new Map<string, ImageResourceCacheEntry>();

	get(sourcePath: string, rawPath: string, app: App): ImageResourceCacheValue {
		const key = getImageResourceCacheKey(sourcePath, rawPath);
		const cached = this.entries.get(key);
		if (cached !== undefined) {
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
		return value;
	}

	invalidateImagePaths(paths: readonly string[]): void {
		const normalizedPaths = paths.map(normalizeComparablePath);
		const basenames = new Set(normalizedPaths.map(getPathBasename));
		for (const [key, entry] of this.entries) {
			const resolvedPath = entry.value.resourcePath;
			if (resolvedPath !== undefined && normalizedPaths.includes(normalizeComparablePath(resolvedPath))) {
				this.entries.delete(key);
				continue;
			}
			const rawPath = normalizeComparablePath(entry.rawPath);
			if (normalizedPaths.includes(rawPath) || basenames.has(getPathBasename(rawPath))) {
				this.entries.delete(key);
			}
		}
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

function normalizeComparablePath(path: string): string {
	return path.replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase();
}

function getPathBasename(path: string): string {
	const separatorIndex = path.lastIndexOf("/");
	return separatorIndex === -1 ? path : path.slice(separatorIndex + 1);
}

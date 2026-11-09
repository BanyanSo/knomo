import { normalizeImagePath, getImagePathBasename } from "../utils/imagePath";
import type { MemoViewItem as MemoRecord } from "../types/memoView";
import type { MemoCardPreviewLite } from "./MemoCardPreview";

interface MemoCardPreviewCacheEntry {
	key: string;
	preview: MemoCardPreviewLite;
}

type BuildMemoCardPreview = (memo: MemoRecord, displayContent: string) => MemoCardPreviewLite;
type MemoPreviewCacheItem = MemoRecord & { version?: number };

export class MemoCardPreviewCache {
	private readonly entries = new Map<string, MemoCardPreviewCacheEntry>();

	constructor(private readonly buildPreview: BuildMemoCardPreview) {}

	get(memo: MemoPreviewCacheItem, displayContent: string): MemoCardPreviewLite {
		const key = getMemoCardPreviewKey(memo);
		const cached = this.entries.get(memo.id);
		if (cached?.key === key) {
			return cached.preview;
		}
		const preview = this.buildPreview(memo, displayContent);
		this.entries.set(memo.id, { key, preview });
		return preview;
	}

	retain(memoIds: ReadonlySet<string>): void {
		for (const memoId of this.entries.keys()) {
			if (!memoIds.has(memoId)) {
				this.entries.delete(memoId);
			}
		}
	}

	clear(): void {
		this.entries.clear();
	}

	findImagePathMemoIds(paths: readonly string[]): string[] {
		const normalizedPaths = paths.map(normalizeImagePath);
		const basenames = new Set(normalizedPaths.map(getImagePathBasename));
		const affectedMemoIds: string[] = [];
		for (const [memoId, entry] of this.entries) {
			const affected = entry.preview.imageRefs.some((image) => {
				if (image.isRemote) {
					return false;
				}
				const imagePath = normalizeImagePath(image.path);
				return normalizedPaths.includes(imagePath) || basenames.has(getImagePathBasename(imagePath));
			});
			if (affected) {
				affectedMemoIds.push(memoId);
			}
		}
		return affectedMemoIds;
	}
}

export function getMemoCardPreviewKey(memo: MemoPreviewCacheItem): string {
	return [
		memo.updatedAt,
		memo.contentHash,
		memo.dailyRef.path,
	].join(":");
}

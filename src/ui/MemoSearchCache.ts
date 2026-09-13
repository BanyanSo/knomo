import type { MemoViewItem as MemoRecord } from "../types/memoView";
import { buildMemoSearchText } from "./viewFilters";

type BuildMemoSearchText = (memo: MemoRecord) => string;
type MemoSearchCacheItem = MemoRecord & { version?: number };

interface MemoSearchCacheEntry {
	key: string;
	text: string;
}

export class MemoSearchCache {
	private textCache = new Map<string, MemoSearchCacheEntry>();

	constructor(private readonly buildSearchText: BuildMemoSearchText = buildMemoSearchText) {}

	invalidate(): void {
		this.textCache.clear();
	}

	remove(memoId: string): void {
		this.textCache.delete(memoId);
	}

	get(memo: MemoSearchCacheItem): string {
		const key = `${memo.contentHash}:${memo.updatedAt}`;
		const cached = this.textCache.get(memo.id);
		if (cached?.key === key) {
			return cached.text;
		}
		const searchText = this.buildSearchText(memo);
		this.textCache.set(memo.id, { key, text: searchText });
		return searchText;
	}
}

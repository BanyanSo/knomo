import type { MemoRecord } from "../types/memo";
import { buildMemoSearchText } from "./viewFilters";

type BuildMemoSearchText = (memo: MemoRecord) => string;

export class MemoSearchCache {
	private textCache = new Map<string, string>();
	private source: MemoRecord[] | null = null;

	constructor(private readonly buildSearchText: BuildMemoSearchText = buildMemoSearchText) {}

	invalidate(memos: MemoRecord[]): void {
		this.textCache.clear();
		this.source = memos;
	}

	get(memo: MemoRecord, memos: MemoRecord[]): string {
		if (this.source !== memos) {
			this.invalidate(memos);
		}
		const cachedText = this.textCache.get(memo.id);
		if (cachedText !== undefined) {
			return cachedText;
		}
		const searchText = this.buildSearchText(memo);
		this.textCache.set(memo.id, searchText);
		return searchText;
	}
}

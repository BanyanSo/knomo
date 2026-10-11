import type { MemoViewItem as MemoRecord } from "../types/memoView";
import type { CatalogQueryFilter } from "../types/catalog";
import { createCatalogQueryMatcher } from "../services/MemoCatalogStore";

// 卡片二次筛选只读取 Catalog 投影，条件仅准备一次，与 count 和分页共用 evaluator。
export function filterCatalogMemos(memos: readonly MemoRecord[], filter: CatalogQueryFilter): MemoRecord[] {
	const matches = createCatalogQueryMatcher(filter);
	return memos.filter(memo => memo.catalog !== undefined && matches(memo.catalog.observation));
}

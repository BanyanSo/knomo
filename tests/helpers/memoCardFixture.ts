import type { MemoViewItem } from "../../src/types/memoView";

export function createCardMemo(overrides: Partial<MemoViewItem> = {}): MemoViewItem {
	return {
		id: "memo-1",
		createdAt: "2026-06-02T00:00:00+08:00",
		updatedAt: "2026-06-02T00:00:00+08:00",
		contentSnapshot: "memo",
		contentHash: "hash",
		status: "active",
		tags: [],
		links: [],
		images: [],
		dailyRef: {
			path: "Daily/2026-06-02.md",
			heading: null,
			lineNumberHint: null,
		},
		...overrides,
	};
}

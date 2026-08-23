import type { MemoViewItem as MemoRecord } from "../types/memoView";

export function getMemoRenderKey(memo: MemoRecord): string {
	return memo.catalogV2?.renderKey ?? memo.id;
}

export function getMemoRenderRevision(memo: MemoRecord): string {
	const reference = memo.references[0];
	return encodeParts([
		getMemoRenderKey(memo),
		memo.id,
		memo.updatedAt,
		memo.createdAt,
		memo.updatedAt,
		memo.contentHash,
		memo.status,
		memo.sourceMemoId,
		reference?.memoId,
		reference?.referenceText,
		memo.dailyRef.path,
		memo.deletedAt,
		memo.deleteSource,
	]);
}

export function getMemoListStateKey(memos: readonly MemoRecord[]): string {
	return memos.map(getMemoRenderRevision).join("");
}

function encodeParts(parts: readonly (string | number | null | undefined)[]): string {
	return parts.map((part) => {
		const value = part === null || part === undefined ? "" : String(part);
		return `${value.length}:${value}`;
	}).join("");
}

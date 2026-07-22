import type { MemoRecord } from "../types/memo";

export function getMemoRenderRevision(memo: MemoRecord): string {
	const reference = memo.references[0];
	return encodeParts([
		memo.id,
		memo.version,
		memo.createdAt,
		memo.updatedAt,
		memo.contentHash,
		memo.status,
		memo.syncStatus,
		memo.sourceMemoId,
		memo.issue?.type,
		memo.issue?.code,
		memo.issue?.detectedAt,
		memo.issue?.message,
		memo.issue?.context === undefined ? undefined : JSON.stringify(memo.issue.context),
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

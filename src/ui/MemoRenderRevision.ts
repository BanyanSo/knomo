import type { MemoViewItem as MemoRecord } from "../types/memoView";

export function getMemoRenderKey(memo: MemoRecord): string {
	return memo.catalog?.renderKey ?? memo.id;
}

export function getMemoRenderRevision(memo: MemoRecord): string {
	return encodeParts([
		getMemoRenderKey(memo),
		memo.id,
		memo.updatedAt,
		memo.createdAt,
		memo.updatedAt,
		memo.contentHash,
		memo.status,
		memo.dailyRef.path,
		memo.deletedAt,
	]);
}

export function getMemoListStateKey(memos: readonly MemoRecord[]): string {
	return memos.map(getMemoRenderRevision).join("");
}

// 仅在已确认提交给出的 occurrence 映射内复用，不按正文寻找或合并 Memo。
export function canRetainMemoCard(before: MemoRecord, after: MemoRecord): boolean {
	return (before.id === after.id || (before.catalog !== undefined && after.catalog !== undefined
		&& before.catalog.observation.rawBlockHash === after.catalog.observation.rawBlockHash))
		&& before.dailyRef.path === after.dailyRef.path
		&& before.createdAt === after.createdAt && before.updatedAt === after.updatedAt
		&& before.contentHash === after.contentHash && before.contentSnapshot === after.contentSnapshot
		&& before.status === after.status && before.deletedAt === after.deletedAt
		&& JSON.stringify(before.catalog?.resolved.capabilities) === JSON.stringify(after.catalog?.resolved.capabilities);
}

export function areMemoListsUnchanged(
	before: readonly MemoRecord[], after: readonly MemoRecord[], changes: ReadonlyMap<string, MemoRecord | null>,
): boolean {
	return before.length === after.length && before.every((memo, index) => {
		const current = changes.has(memo.id) ? changes.get(memo.id) : memo;
		return current != null && current.id === after[index]?.id && canRetainMemoCard(memo, after[index]);
	});
}

export function rebindMemoCard(card: HTMLElement, memo: MemoRecord): void {
	const previousId = card.getAttribute("data-memo-id");
	card.setAttribute("data-memo-id", memo.id);
	card.setAttribute("data-memo-render-key", getMemoRenderKey(memo));
	for (const attribute of ["data-memo-id", "data-knomo-memo-id"]) {
		for (const element of Array.from(card.querySelectorAll(`[${attribute}]`))) {
			if (element.getAttribute(attribute) === previousId) element.setAttribute(attribute, memo.id);
		}
	}
}

function encodeParts(parts: readonly (string | number | null | undefined)[]): string {
	return parts.map((part) => {
		const value = part === null || part === undefined ? "" : String(part);
		return `${value.length}:${value}`;
	}).join("");
}

import type { MemoViewItem } from "../types/memoView";

// 只保存本次重绘期间的静态显示，不复用旧 occurrence 句柄或交互监听。
export function createMemoRenderPlaceholders(entries: readonly { memo: MemoViewItem; card: HTMLElement }[]) {
	const snapshots = new Map<string, HTMLElement>();
	const key = (memo: MemoViewItem) => JSON.stringify([memo.dailyRef.path, memo.contentSnapshot]);
	for (const { memo, card } of entries) {
		const content = card.querySelector<HTMLElement>(".knomo-card-content");
		if (content && content.childNodes.length > 0) snapshots.set(key(memo), content);
	}
	return (memo: MemoViewItem, card: HTMLElement): void => {
		const previous = snapshots.get(key(memo));
		const content = card.querySelector<HTMLElement>(".knomo-card-content");
		if (!previous || !content || content.childNodes.length > 0) return;
		const snapshot = (previous.querySelector(":scope > [data-knomo-render-placeholder]") ?? previous).cloneNode(true) as HTMLElement;
		snapshot.className = "";
		snapshot.setAttribute("data-knomo-render-placeholder", "");
		snapshot.setAttribute("inert", "");
		// 新正文完成渲染前，快照只供显示；同文卡片也各自使用独立克隆。
		snapshot.querySelectorAll("[data-knomo-memo-id], [data-action]").forEach(element => {
			element.removeAttribute("data-knomo-memo-id"); element.removeAttribute("data-action");
		});
		snapshot.querySelectorAll<HTMLInputElement>("input").forEach(input => { input.disabled = true; });
		content.append(snapshot);
	};
}

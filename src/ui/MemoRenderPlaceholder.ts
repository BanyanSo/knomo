import type { MemoViewItem } from "../types/memoView";

// 只保存本次重绘期间的静态显示，不复用旧 occurrence 句柄或交互监听。
export function createMemoRenderPlaceholders(entries: readonly { memo: MemoViewItem; card: HTMLElement }[]) {
	const selectors = [".knomo-card-content", ".knomo-source-reference-content"] as const;
	const snapshots = new Map<string, (HTMLElement | null)[]>();
	const key = (memo: MemoViewItem) => JSON.stringify([memo.dailyRef.path, memo.contentSnapshot]);
	for (const { memo, card } of entries) {
		const sections = selectors.map(selector => {
			const section = card.querySelector<HTMLElement>(selector);
			return section && section.childNodes.length > 0 ? section : null;
		});
		if (sections.some(section => section !== null)) snapshots.set(key(memo), sections);
	}
	return (memo: MemoViewItem, card: HTMLElement): void => {
		const previousSections = snapshots.get(key(memo));
		if (!previousSections) return;
		for (const [index, selector] of selectors.entries()) {
			const previous = previousSections[index];
			const content = card.querySelector<HTMLElement>(selector);
			if (!previous || !content || (content.childNodes.length > 0 && !content.querySelector(":scope > [data-knomo-render-placeholder]"))) continue;
			const snapshot = (previous.querySelector(":scope > [data-knomo-render-placeholder]") ?? previous).cloneNode(true) as HTMLElement;
			snapshot.className = snapshot.classList.contains("knomo-card-text-placeholder") ? "knomo-card-text-placeholder" : "";
			snapshot.setAttribute("data-knomo-render-placeholder", "");
			snapshot.setAttribute("inert", "");
			// 新 Markdown 完成渲染前，正文和来源快照只供显示；同文卡片也各自使用独立克隆。
			snapshot.querySelectorAll("[data-knomo-memo-id], [data-action]").forEach(element => {
				element.removeAttribute("data-knomo-memo-id"); element.removeAttribute("data-action");
			});
			snapshot.querySelectorAll<HTMLInputElement>("input").forEach(input => { input.disabled = true; });
			content.replaceChildren(snapshot);
		}
	};
}

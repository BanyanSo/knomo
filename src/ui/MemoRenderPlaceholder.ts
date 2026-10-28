import type { MemoViewItem } from "../types/memoView";

// 只保存本次重绘期间的静态显示，不复用旧 occurrence 句柄或交互监听。
export function createMemoRenderPlaceholders(entries: readonly { memo: MemoViewItem; card: HTMLElement }[]) {
	const selectors = [".knomo-card-content", ".knomo-source-reference-content"] as const;
	const snapshots = new Map<string, (HTMLElement | null)[]>();
	const key = (memo: MemoViewItem) => JSON.stringify([memo.dailyRef.path, memo.contentSnapshot]);
	const referrers = new Map<string, HTMLElement>();
	// 行位置只用于本次重绘的静态占位，不授予 occurrence 身份或操作权限。
	const referrerKey = (memo: MemoViewItem) => JSON.stringify([key(memo), memo.dailyRef.lineNumberHint,
		memo.catalog?.observationHandle.rawBlockHash]);
	for (const { memo, card } of entries) {
		const sections = selectors.map(selector => {
			const section = card.querySelector<HTMLElement>(selector);
			return section && section.childNodes.length > 0 ? section : null;
		});
		if (sections.some(section => section !== null)) snapshots.set(key(memo), sections);
		const region = card.querySelector<HTMLElement>(".knomo-memo-referrers");
		if (region) referrers.set(referrerKey(memo), region);
	}
	return (memo: MemoViewItem, card: HTMLElement): void => {
		const previousSections = snapshots.get(key(memo));
		const previousReferrers = referrers.get(referrerKey(memo));
		if (previousReferrers && !card.querySelector(".knomo-memo-referrers") && !card.closest(".knomo-relations-page")) {
			const snapshot = previousReferrers.cloneNode(true) as HTMLElement;
			snapshot.setAttribute("data-knomo-render-placeholder", "");
			snapshot.setAttribute("inert", "");
			snapshot.dataset.stale = "true";
			snapshot.removeAttribute("data-preview-signature");
			// 克隆不携带监听器，且不能以旧目标响应键盘、指针或委托事件。
			for (const element of Array.from(snapshot.querySelectorAll<HTMLElement>("*"))) {
				for (const attribute of ["data-relation-target", "data-relation-action", "data-memo-id", "data-knomo-memo-id", "data-action"]) element.removeAttribute(attribute);
			}
			for (const button of Array.from(snapshot.querySelectorAll("button"))) button.disabled = true;
			card.appendChild(snapshot);
		}
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

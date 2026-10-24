// 原生候选列表的方向、首尾和翻页导航；修饰键继续交给编辑器及保存快捷键。
export function getSuggestionNavigationIndex(event: KeyboardEvent, selectedIndex: number, list: HTMLElement): number | null {
	const count = list.children.length;
	if (count === 0 || event.altKey || event.metaKey || event.shiftKey) return null;
	if (event.ctrlKey) {
		if (event.key.toLowerCase() === "n") return (selectedIndex + 1) % count;
		if (event.key.toLowerCase() === "p") return (selectedIndex + count - 1) % count;
		return null;
	}
	if (event.key === "ArrowDown") return (selectedIndex + 1) % count;
	if (event.key === "ArrowUp") return (selectedIndex + count - 1) % count;
	if (event.key === "Home") return 0;
	if (event.key === "End") return count - 1;
	if (event.key !== "PageUp" && event.key !== "PageDown") return null;
	const row = list.children[selectedIndex] as HTMLElement;
	const rowHeight = Math.max(1, row.clientHeight || row.offsetHeight);
	const visible = Math.max(1, Math.floor(list.clientHeight / rowHeight));
	const padding = Number.parseFloat(list.ownerDocument.defaultView?.getComputedStyle(list).paddingTop ?? "0") || 0;
	const first = Math.floor((list.scrollTop - padding) / rowHeight);
	if (event.key === "PageUp") return Math.max(0, first - (selectedIndex <= first ? visible : 0));
	const last = first + visible - 1;
	return Math.min(count - 1, last + (selectedIndex >= last ? visible : 0));
}

export function scrollSuggestionIntoView(list: HTMLElement, item: HTMLElement): void {
	const itemTop = item.offsetTop;
	const itemBottom = itemTop + item.offsetHeight;
	if (itemTop < list.scrollTop) list.scrollTop = itemTop;
	else if (itemBottom > list.scrollTop + list.clientHeight) list.scrollTop = itemBottom - list.clientHeight;
}

// 触摸确认会移除浮层；尾随事件仍可能落到旧节点或下方编辑器/蒙层。
export function guardSuggestionTouchClickThrough(origin: MouseEvent | TouchEvent, container: HTMLElement, onClear: () => void): () => void {
	const win = container.ownerDocument.defaultView!;
	const originPoint = "changedTouches" in origin ? origin.changedTouches[0] : origin;
	const targets: EventTarget[] = [win, container];
	const types = ["touchend", "mousedown", "mouseup", "click"] as const;
	const guard = (event: Event) => {
		if (event.type === "click" && (event as MouseEvent).detail === 0) return;
		const point = event.type === "touchend" ? (event as TouchEvent).changedTouches[0] : event as MouseEvent;
		if (!point || !originPoint || Math.hypot(point.clientX - originPoint.clientX, point.clientY - originPoint.clientY) > 12) return;
		event.preventDefault();
		event.stopImmediatePropagation();
		if (event.type === "click") clear();
	};
	const clear = () => {
		for (const target of targets) for (const type of types) target.removeEventListener(type, guard, true);
		win.removeEventListener("pointerdown", clear, true);
		win.clearTimeout(timer);
		onClear();
	};
	const timer = win.setTimeout(clear, 600);
	for (const target of targets) for (const type of types) target.addEventListener(type, guard, { capture: true, passive: false });
	win.addEventListener("pointerdown", clear, true);
	return clear;
}

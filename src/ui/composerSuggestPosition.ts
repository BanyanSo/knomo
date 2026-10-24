import type { ComposerInput } from "./ComposerEditor";
export interface SuggestContentWidthOptions {
	includeScrollbarWidth?: boolean;
	extraWidth?: number;
}

export function getTextareaCharacterRect(inputEl: HTMLElement, index: number): DOMRect | null {
	return (inputEl as ComposerInput).composer.coordsAtPos(index);
}

// 桌面优先在光标下方展开；空间不足时选上方，长列表在浮层内滚动。
export function getDesktopSuggestionPosition(anchor: Pick<DOMRect, "top" | "bottom">, contentHeight: number,
	viewportTop: number, viewportBottom: number): { top: number; maxHeight: number } {
	const requiredHeight = Math.min(240, contentHeight > 0 ? contentHeight : 240);
	const below = Math.max(0, viewportBottom - 12 - anchor.bottom);
	const above = Math.max(0, anchor.top - viewportTop - 12);
	const placeBelow = below >= requiredHeight || below >= above;
	const maxHeight = Math.min(240, placeBelow ? below : above);
	const height = Math.min(requiredHeight, maxHeight);
	const top = placeBelow ? anchor.bottom : anchor.top - height;
	return { top: clamp(top, viewportTop + 12, Math.max(viewportTop + 12, viewportBottom - 12 - height)), maxHeight };
}

export function measureSuggestionContentHeight(inputEl: HTMLElement, container: HTMLElement, itemSelector: string): number {
	const win = inputEl.ownerDocument.defaultView;
	if (win === null) {
		return Math.ceil(container.scrollHeight || container.getBoundingClientRect().height);
	}
	const computed = win.getComputedStyle(container);
	const verticalInset =
		parseCssPixels(computed.paddingTop) +
		parseCssPixels(computed.paddingBottom) +
		parseCssPixels(computed.borderTopWidth) +
		parseCssPixels(computed.borderBottomWidth);
	const list = container.querySelector<HTMLElement>(":scope > .knomo-suggest-list");
	if (list !== null) {
		const listStyle = win.getComputedStyle(list);
		return Math.ceil(list.scrollHeight + verticalInset
			+ parseCssPixels(listStyle.borderTopWidth) + parseCssPixels(listStyle.borderBottomWidth));
	}
	const items = Array.from(container.querySelectorAll<HTMLElement>(itemSelector));
	if (items.length === 0) {
		return Math.ceil(container.scrollHeight || container.getBoundingClientRect().height);
	}
	const itemHeight = items.reduce((height, item) => height + item.getBoundingClientRect().height, 0);
	return Math.ceil(Math.max(container.scrollHeight, itemHeight + verticalInset));
}

export function measureSuggestionContentWidth(
	inputEl: HTMLElement,
	container: HTMLElement,
	itemSelector: string,
	options: SuggestContentWidthOptions = {},
): number {
	const doc = inputEl.ownerDocument;
	const items = Array.from(container.querySelectorAll<HTMLElement>(itemSelector));
	if (items.length === 0) {
		return Math.ceil(container.scrollWidth || container.getBoundingClientRect().width);
	}
	const host = asHTMLElement(container.cloneNode(false), doc);
	if (host === null) {
		return Math.ceil(container.scrollWidth || container.getBoundingClientRect().width);
	}
	host.addClass("knomo-suggest-measure-host");
	// 保留原生列表的祖先结构，让主题留白与测量副本的继承一致。
	const list = container.querySelector<HTMLElement>(":scope > .knomo-suggest-list");
	const cloneList = list === null ? null : asHTMLElement(list.cloneNode(false), doc);
	if (cloneList !== null) host.appendChild(cloneList);
	const clones: HTMLElement[] = [];
	for (const item of items) {
		const clone = asHTMLElement(item.cloneNode(true), doc);
		if (clone === null) {
			continue;
		}
		clone.addClass("knomo-suggest-measure-item");
		(cloneList ?? host).appendChild(clone);
		clones.push(clone);
	}
	let width = 0;
	// 先批量挂载再集中测量，避免每插入一行就迫使浏览器重新布局。
	doc.body.appendChild(host);
	try {
		for (const clone of clones) width = Math.max(width, clone.getBoundingClientRect().width);
	} finally {
		host.detach();
	}
	const win = doc.defaultView;
	if (win === null) {
		return Math.ceil(width);
	}
	const computed = win.getComputedStyle(container);
	let horizontalInset =
		parseCssPixels(computed.paddingLeft) +
		parseCssPixels(computed.paddingRight) +
		parseCssPixels(computed.borderLeftWidth) +
		parseCssPixels(computed.borderRightWidth);
	if (list !== null) {
		const listStyle = win.getComputedStyle(list);
		horizontalInset += parseCssPixels(listStyle.paddingLeft) + parseCssPixels(listStyle.paddingRight)
			+ parseCssPixels(listStyle.borderLeftWidth) + parseCssPixels(listStyle.borderRightWidth);
	}
	const scrollbarWidth = options.includeScrollbarWidth === true ? measureScrollbarWidth(doc) : 0;
	return Math.ceil(width + horizontalInset + scrollbarWidth + (options.extraWidth ?? 2));
}

export function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function asHTMLElement(value: Node, doc: Document): HTMLElement | null {
	const win = doc.defaultView;
	if (win !== null && value.instanceOf(win.HTMLElement)) {
		return value;
	}
	return null;
}

function parseCssPixels(value: string): number {
	const parsed = Number.parseFloat(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

function measureScrollbarWidth(doc: Document): number {
	const outer = doc.body.createDiv({ cls: "knomo-scrollbar-measure-outer" });
	outer.createDiv({ cls: "knomo-scrollbar-measure-inner" });
	const scrollbarWidth = outer.offsetWidth - outer.clientWidth;
	outer.detach();
	return Math.max(0, scrollbarWidth);
}

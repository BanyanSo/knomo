export interface SuggestContentWidthOptions {
	includeScrollbarWidth?: boolean;
	extraWidth?: number;
}

export function getTextareaCharacterRect(inputEl: HTMLTextAreaElement, index: number): DOMRect | null {
	const doc = inputEl.ownerDocument;
	const win = doc.defaultView;
	if (win === null) {
		return null;
	}
	const inputRect = inputEl.getBoundingClientRect();
	const computed = win.getComputedStyle(inputEl);
	const mirror = doc.body.createDiv();
	const mirrorStyle = mirror.style;
	mirrorStyle.position = "fixed";
	mirrorStyle.visibility = "hidden";
	mirrorStyle.pointerEvents = "none";
	mirrorStyle.whiteSpace = "pre-wrap";
	mirrorStyle.overflowWrap = "break-word";
	mirrorStyle.wordBreak = computed.wordBreak;
	mirrorStyle.boxSizing = computed.boxSizing;
	mirrorStyle.width = `${inputRect.width}px`;
	mirrorStyle.minHeight = computed.minHeight;
	mirrorStyle.padding = computed.padding;
	mirrorStyle.border = computed.border;
	mirrorStyle.font = computed.font;
	mirrorStyle.lineHeight = computed.lineHeight;
	mirrorStyle.letterSpacing = computed.letterSpacing;
	mirrorStyle.textTransform = computed.textTransform;
	mirrorStyle.left = `${inputRect.left - inputEl.scrollLeft}px`;
	mirrorStyle.top = `${inputRect.top - inputEl.scrollTop}px`;
	mirror.setText(inputEl.value.slice(0, index));
	const marker = mirror.createSpan({ text: inputEl.value.charAt(index) || "\u200b" });
	const rect = marker.getBoundingClientRect();
	mirror.detach();
	return rect;
}

export function measureSuggestionContentHeight(inputEl: HTMLTextAreaElement, container: HTMLElement, itemSelector: string): number {
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
	const items = Array.from(container.querySelectorAll<HTMLElement>(itemSelector));
	if (items.length === 0) {
		return Math.ceil(container.scrollHeight || container.getBoundingClientRect().height);
	}
	const itemHeight = items.reduce((height, item) => height + item.getBoundingClientRect().height, 0);
	return Math.ceil(Math.max(container.scrollHeight, itemHeight + verticalInset));
}

export function measureSuggestionContentWidth(
	inputEl: HTMLTextAreaElement,
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
	host.style.position = "fixed";
	host.style.visibility = "hidden";
	host.style.pointerEvents = "none";
	host.style.width = "max-content";
	host.style.maxWidth = "none";
	host.style.minWidth = "0";
	host.style.left = "-10000px";
	host.style.top = "0";
	doc.body.appendChild(host);
	let width = 0;
	for (const item of items) {
		const clone = asHTMLElement(item.cloneNode(true), doc);
		if (clone === null) {
			continue;
		}
		clone.style.width = "max-content";
		clone.style.maxWidth = "none";
		clone.style.minWidth = "0";
		host.appendChild(clone);
		width = Math.max(width, clone.getBoundingClientRect().width);
	}
	host.detach();
	const win = doc.defaultView;
	if (win === null) {
		return Math.ceil(width);
	}
	const computed = win.getComputedStyle(container);
	const horizontalInset =
		parseCssPixels(computed.paddingLeft) +
		parseCssPixels(computed.paddingRight) +
		parseCssPixels(computed.borderLeftWidth) +
		parseCssPixels(computed.borderRightWidth);
	const scrollbarWidth = options.includeScrollbarWidth === true ? measureScrollbarWidth(doc) : 0;
	return Math.ceil(width + horizontalInset + scrollbarWidth + (options.extraWidth ?? 2));
}

export function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function asHTMLElement(value: Node, doc: Document): HTMLElement | null {
	const win = doc.defaultView as (Window & { HTMLElement?: typeof HTMLElement }) | null;
	if (win !== null && typeof win.HTMLElement === "function" && value instanceof win.HTMLElement) {
		return value;
	}
	const globalHTMLElement = globalThis.HTMLElement;
	if (typeof globalHTMLElement === "function") {
		if (value instanceof globalHTMLElement) {
			return value;
		}
		const maybeObsidianNode = value as Node & { instanceOf?: (constructor: typeof HTMLElement) => boolean };
		if (typeof maybeObsidianNode.instanceOf === "function" && maybeObsidianNode.instanceOf(globalHTMLElement)) {
			return value as HTMLElement;
		}
	}
	return null;
}

function parseCssPixels(value: string): number {
	const parsed = Number.parseFloat(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

function measureScrollbarWidth(doc: Document): number {
	const outer = doc.body.createDiv();
	const inner = outer.createDiv();
	outer.style.position = "fixed";
	outer.style.visibility = "hidden";
	outer.style.pointerEvents = "none";
	outer.style.overflow = "scroll";
	outer.style.width = "100px";
	outer.style.height = "100px";
	outer.style.left = "-10000px";
	outer.style.top = "0";
	inner.style.width = "100%";
	inner.style.height = "120px";
	const scrollbarWidth = outer.offsetWidth - outer.clientWidth;
	outer.detach();
	return Math.max(0, scrollbarWidth);
}

import { AbstractInputSuggest, getAllTags, prepareFuzzySearch, renderResults } from "obsidian";
import type { App, SearchResult } from "obsidian";

import { getTagQueryAtCursor, replaceTagQueryWithSuggestion } from "../utils/composerInput";

interface TagSuggestion {
	tag: string;
	result: SearchResult | null;
}

export class KnomoTagSuggest extends AbstractInputSuggest<TagSuggestion> {
	private tagsSnapshot: string[] | null = null;
	private popoverRepositionFrameId: number | null = null;

	constructor(
		app: App,
		private readonly inputEl: HTMLTextAreaElement,
		private readonly onInputChanged: () => void,
	) {
		super(app, inputEl as unknown as HTMLInputElement);
		this.limit = 0;
	}

	open(): void {
		super.open();
		this.hidePopoverUntilPositioned();
		this.queuePopoverReposition();
	}

	close(): void {
		this.clearPopoverReposition();
		this.showPositionedPopover();
		super.close();
		this.tagsSnapshot = null;
	}

	openForCurrentTrigger(): void {
		this.open();
		this.queuePopoverReposition();
		const container = this.getSuggestionContainer();
		if (container !== null) {
			container.addClass("knomo-tag-suggest-popover");
			container.style.position = "fixed";
			container.style.zIndex = "10020";
		}
	}

	protected getSuggestions(): TagSuggestion[] {
		const range = getTagQueryAtCursor(this.inputEl.value, this.inputEl.selectionStart);
		if (range === null) {
			return [];
		}
		const tags = this.getTagsSnapshot();
		const suggestions = range.query.length === 0
			? tags.map((tag) => ({ tag, result: null }))
			: this.getFuzzySuggestions(tags, range.query);
		if (suggestions.length > 0) {
			this.queuePopoverReposition();
		}
		return suggestions;
	}

	renderSuggestion(value: TagSuggestion, el: HTMLElement): void {
		if (value.result === null) {
			el.setText(value.tag);
			this.queuePopoverReposition();
			return;
		}
		el.empty();
		renderResults(el, value.tag, value.result);
		this.queuePopoverReposition();
	}

	selectSuggestion(value: TagSuggestion, _evt: MouseEvent | KeyboardEvent): void {
		const range = getTagQueryAtCursor(this.inputEl.value, this.inputEl.selectionStart);
		if (range === null) {
			this.close();
			return;
		}
		const next = replaceTagQueryWithSuggestion(this.inputEl.value, range, value.tag);
		this.inputEl.value = next.value;
		this.inputEl.setSelectionRange(next.cursor, next.cursor);
		this.onInputChanged();
		this.close();
	}

	private hidePopoverUntilPositioned(): void {
		const container = this.getSuggestionContainer();
		if (container === null) {
			return;
		}
		container.addClass("knomo-tag-suggest-popover");
		container.addClass("knomo-tag-suggest-positioning");
	}

	private showPositionedPopover(container = this.getSuggestionContainer()): void {
		container?.removeClass("knomo-tag-suggest-positioning");
	}

	private getTagsSnapshot(): string[] {
		if (this.tagsSnapshot === null) {
			this.tagsSnapshot = this.getVaultTags();
		}
		return this.tagsSnapshot;
	}

	private getFuzzySuggestions(tags: string[], query: string): TagSuggestion[] {
		const search = prepareFuzzySearch(query);
		const suggestions: TagSuggestion[] = [];
		for (const tag of tags) {
			const result = search(tag);
			if (result !== null) {
				suggestions.push({ tag, result });
			}
		}
		return suggestions;
	}

	private getVaultTags(): string[] {
		const tags = new Set<string>();
		for (const file of this.app.vault.getMarkdownFiles()) {
			const cache = this.app.metadataCache.getFileCache(file);
			if (cache === null) {
				continue;
			}
			for (const tag of getAllTags(cache) ?? []) {
				const normalizedTag = tag.replace(/^#/, "");
				if (normalizedTag.length > 0) {
					tags.add(normalizedTag);
				}
			}
		}
		return Array.from(tags).sort((first, second) => first.localeCompare(second));
	}

	private queuePopoverReposition(): void {
		const win = this.inputEl.ownerDocument.defaultView;
		if (win === null) {
			this.repositionPopover();
			return;
		}
		if (this.popoverRepositionFrameId !== null) {
			return;
		}
		this.popoverRepositionFrameId = win.requestAnimationFrame(() => {
			this.popoverRepositionFrameId = null;
			this.repositionPopover();
		});
	}

	private repositionPopover(): void {
		const range = getTagQueryAtCursor(this.inputEl.value, this.inputEl.selectionStart);
		if (range === null) {
			return;
		}
		const anchor = this.getTextareaCharacterRect(range.to);
		const container = this.getSuggestionContainer();
		if (anchor === null || container === null) {
			return;
		}
		const layer = this.inputEl.closest(".knomo-mobile-composer-layer");
		if (layer !== null) {
			const win = this.inputEl.ownerDocument.defaultView;
			const viewport = win?.visualViewport ?? null;
			const viewportTop = viewport ? Math.max(0, viewport.offsetTop) : 0;
			const topGuard = 52;
			const gap = 8;
			const maxHeightLimit = 240;
			const availableAbove = Math.max(0, anchor.top - viewportTop - topGuard - gap);
			const maxHeight = Math.min(maxHeightLimit, availableAbove);
			const contentHeight = this.measureSuggestionContentHeight(container);
			const measuredHeight = Math.min(maxHeight, contentHeight > 0 ? contentHeight : maxHeight);
			container.addClass("knomo-tag-suggest-popover");
			container.style.position = "fixed";
			container.style.zIndex = "10020";
			container.style.maxHeight = `${Math.round(maxHeight)}px`;
			container.style.overflowY = "auto";
			const top = Math.max(viewportTop + topGuard, anchor.top - measuredHeight - gap);
			const inputRect = this.inputEl.getBoundingClientRect();
			const viewportLeft = viewport ? Math.max(0, viewport.offsetLeft) : 0;
			const viewportRight = viewport
				? viewport.offsetLeft + viewport.width
				: win?.innerWidth ?? this.inputEl.ownerDocument.documentElement.clientWidth;
			const viewportMargin = 12;
			const availableWidth = Math.max(0, viewportRight - viewportLeft - viewportMargin * 2);
			const contentWidth = this.measureSuggestionContentWidth(container);
			const targetWidth = contentWidth > 0 ? contentWidth + 44 : inputRect.width - 24;
			const width = Math.max(0, Math.min(targetWidth, availableWidth));
			const minLeft = viewportLeft + viewportMargin;
			const maxLeft = Math.max(minLeft, viewportRight - viewportMargin - width);
			const left = clamp(anchor.left, minLeft, maxLeft);
			container.style.left = `${Math.round(left)}px`;
			container.style.top = `${Math.round(top)}px`;
			container.style.width = `${Math.round(width)}px`;
			container.style.right = "";
			container.style.bottom = "";
			this.showPositionedPopover(container);
			return;
		}
		container.addClass("knomo-tag-suggest-popover");
		const win = this.inputEl.ownerDocument.defaultView;
		const viewport = win?.visualViewport ?? null;
		const viewportLeft = viewport ? Math.max(0, viewport.offsetLeft) : 0;
		const viewportRight = viewport
			? viewport.offsetLeft + viewport.width
			: win?.innerWidth ?? this.inputEl.ownerDocument.documentElement.clientWidth;
		const viewportMargin = 12;
		const availableWidth = Math.max(0, viewportRight - viewportLeft - viewportMargin * 2);
		const inputRect = this.inputEl.getBoundingClientRect();
		const contentWidth = this.measureSuggestionContentWidth(container, true, 12);
		const targetWidth = contentWidth > 0 ? contentWidth : inputRect.width;
		const width = Math.max(0, Math.min(targetWidth, 320, availableWidth));
		const minLeft = viewportLeft + viewportMargin;
		const maxLeft = Math.max(minLeft, viewportRight - viewportMargin - width);
		const left = clamp(anchor.left, minLeft, maxLeft);
		container.style.position = "fixed";
		container.style.left = `${Math.round(left)}px`;
		container.style.top = `${Math.round(anchor.bottom)}px`;
		container.style.width = `${Math.round(width)}px`;
		container.style.right = "";
		container.style.bottom = "";
		this.showPositionedPopover(container);
	}

	private clearPopoverReposition(): void {
		const win = this.inputEl.ownerDocument.defaultView;
		if (win === null || this.popoverRepositionFrameId === null) {
			this.popoverRepositionFrameId = null;
			return;
		}
		win.cancelAnimationFrame(this.popoverRepositionFrameId);
		this.popoverRepositionFrameId = null;
	}

	private measureSuggestionContentHeight(container: HTMLElement): number {
		const win = this.inputEl.ownerDocument.defaultView;
		if (win === null) {
			return Math.ceil(container.scrollHeight || container.getBoundingClientRect().height);
		}
		const computed = win.getComputedStyle(container);
		const verticalInset =
			parseCssPixels(computed.paddingTop) +
			parseCssPixels(computed.paddingBottom) +
			parseCssPixels(computed.borderTopWidth) +
			parseCssPixels(computed.borderBottomWidth);
		const items = Array.from(container.querySelectorAll<HTMLElement>(".suggestion-item"));
		if (items.length === 0) {
			return Math.ceil(container.scrollHeight || container.getBoundingClientRect().height);
		}
		const itemHeight = items.reduce((height, item) => height + item.getBoundingClientRect().height, 0);
		return Math.ceil(Math.max(container.scrollHeight, itemHeight + verticalInset));
	}

	private measureSuggestionContentWidth(container: HTMLElement, includeScrollbarWidth = false, extraWidth = 2): number {
		const doc = this.inputEl.ownerDocument;
		const items = Array.from(container.querySelectorAll<HTMLElement>(".suggestion-item"));
		if (items.length === 0) {
			return Math.ceil(container.scrollWidth || container.getBoundingClientRect().width);
		}
		const host = container.cloneNode(false);
		if (!host.instanceOf(HTMLElement)) {
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
			const clone = item.cloneNode(true);
			if (!clone.instanceOf(HTMLElement)) {
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
		const scrollbarWidth = includeScrollbarWidth ? measureScrollbarWidth(doc) : 0;
		return Math.ceil(width + horizontalInset + scrollbarWidth + extraWidth);
	}

	private getTextareaCharacterRect(index: number): DOMRect | null {
		const doc = this.inputEl.ownerDocument;
		const win = doc.defaultView;
		if (win === null) {
			return null;
		}
		const inputRect = this.inputEl.getBoundingClientRect();
		const computed = win.getComputedStyle(this.inputEl);
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
		mirrorStyle.left = `${inputRect.left - this.inputEl.scrollLeft}px`;
		mirrorStyle.top = `${inputRect.top - this.inputEl.scrollTop}px`;
		mirror.setText(this.inputEl.value.slice(0, index));
		const marker = mirror.createSpan({ text: this.inputEl.value.charAt(index) || "\u200b" });
		const rect = marker.getBoundingClientRect();
		mirror.detach();
		return rect;
	}

	private getSuggestionContainer(): HTMLElement | null {
		const internal = this as unknown as { suggestEl?: unknown; popover?: unknown };
		const directContainer = this.asHTMLElement(internal.suggestEl) ?? this.getContainerElement(internal.suggestEl) ?? this.getContainerElement(internal.popover);
		if (directContainer !== null) {
			return directContainer;
		}
		const containers = Array.from(this.inputEl.ownerDocument.querySelectorAll<HTMLElement>(".suggestion-container"));
		return containers.length > 0 ? containers[containers.length - 1] : null;
	}

	private getContainerElement(value: unknown): HTMLElement | null {
		if (value === null || typeof value !== "object") {
			return null;
		}
		const candidate = value as { containerEl?: unknown; el?: unknown };
		return this.asHTMLElement(candidate.containerEl) ?? this.asHTMLElement(candidate.el);
	}

	private asHTMLElement(value: unknown): HTMLElement | null {
		const win = this.inputEl.ownerDocument.defaultView;
		if (win === null) {
			return null;
		}
		return value instanceof win.HTMLElement ? value : null;
	}
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
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

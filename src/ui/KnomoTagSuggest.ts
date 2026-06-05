import { AbstractInputSuggest, getAllTags, prepareFuzzySearch, renderResults } from "obsidian";
import type { App, SearchResult } from "obsidian";

import { getTagQueryAtCursor, replaceTagQueryWithSuggestion } from "../utils/composerInput";
import {
	clamp,
	getTextareaCharacterRect,
	measureSuggestionContentHeight,
	measureSuggestionContentWidth,
} from "./composerSuggestPosition";

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
		const anchor = getTextareaCharacterRect(this.inputEl, range.to);
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
			const contentHeight = measureSuggestionContentHeight(this.inputEl, container, ".suggestion-item");
			const measuredHeight = Math.min(maxHeight, contentHeight > 0 ? contentHeight : maxHeight);
			container.addClass("knomo-tag-suggest-popover");
			const top = Math.max(viewportTop + topGuard, anchor.top - measuredHeight - gap);
			const inputRect = this.inputEl.getBoundingClientRect();
			const viewportLeft = viewport ? Math.max(0, viewport.offsetLeft) : 0;
			const viewportRight = viewport
				? viewport.offsetLeft + viewport.width
				: win?.innerWidth ?? this.inputEl.ownerDocument.documentElement.clientWidth;
			const viewportMargin = 12;
			const availableWidth = Math.max(0, viewportRight - viewportLeft - viewportMargin * 2);
			const contentWidth = measureSuggestionContentWidth(this.inputEl, container, ".suggestion-item");
			const targetWidth = contentWidth > 0 ? contentWidth + 44 : inputRect.width - 24;
			const width = Math.max(0, Math.min(targetWidth, availableWidth));
			const minLeft = viewportLeft + viewportMargin;
			const maxLeft = Math.max(minLeft, viewportRight - viewportMargin - width);
			const left = clamp(anchor.left, minLeft, maxLeft);
			this.setPopoverOffsetPosition(container, left, top, width, maxHeight);
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
		const contentWidth = measureSuggestionContentWidth(this.inputEl, container, ".suggestion-item", {
			includeScrollbarWidth: true,
			extraWidth: 12,
		});
		const targetWidth = contentWidth > 0 ? contentWidth : inputRect.width;
		const width = Math.max(0, Math.min(targetWidth, 320, availableWidth));
		const minLeft = viewportLeft + viewportMargin;
		const maxLeft = Math.max(minLeft, viewportRight - viewportMargin - width);
		const left = clamp(anchor.left, minLeft, maxLeft);
		this.setPopoverOffsetPosition(container, left, anchor.bottom, width, 240);
		this.showPositionedPopover(container);
	}

	private setPopoverOffsetPosition(container: HTMLElement, left: number, top: number, width: number, maxHeight: number): void {
		container.setCssProps({
			"--knomo-suggest-translate-x": "0px",
			"--knomo-suggest-translate-y": "0px",
		});
		const currentRect = container.getBoundingClientRect();
		container.setCssProps({
			"--knomo-suggest-translate-x": `${Math.round(left - currentRect.left)}px`,
			"--knomo-suggest-translate-y": `${Math.round(top - currentRect.top)}px`,
			"--knomo-suggest-width": `${Math.round(width)}px`,
			"--knomo-suggest-max-height": `${Math.round(maxHeight)}px`,
		});
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
		if (win === null || value === null || typeof value !== "object") {
			return null;
		}
		const candidate = value as { instanceOf?: (constructor: typeof HTMLElement) => boolean };
		return typeof candidate.instanceOf === "function" && candidate.instanceOf(win.HTMLElement) ? value as HTMLElement : null;
	}
}

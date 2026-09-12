import { applyComposerEdit, type ComposerInput } from "./ComposerEditor";
import { prepareFuzzySearch, renderResults } from "obsidian";
import type { App, SearchResult } from "obsidian";

import type { VaultTagIndex } from "../services/VaultTagIndex";
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

export class KnomoTagSuggest {
	private popoverRepositionFrameId: number | null = null;
	private popoverEl: HTMLElement | null = null;
	private suggestions: TagSuggestion[] = [];
	private selectedIndex = 0;
	private requestGeneration = 0;
	private readonly popoverId: string;

	constructor(
		app: App,
		private readonly inputEl: ComposerInput,
		private readonly onInputChanged: () => void,
		private readonly vaultTagIndex: VaultTagIndex,
	) {
		void app;
		this.popoverId = `${inputEl.getAttribute("aria-labelledby") ?? "knomo-composer"}-tag-suggestions`;
	}

	open(): void { this.refresh(); }
	close(): void {
		this.requestGeneration++;
		this.clearPopoverReposition();
		this.popoverEl?.remove();
		this.popoverEl = null;
		this.suggestions = [];
		if (this.inputEl.getAttribute("aria-controls") === this.popoverId) {
			this.inputEl.setAttribute("aria-expanded", "false");
			this.inputEl.removeAttribute("aria-activedescendant");
		}
	}
	openForCurrentTrigger(): void {
		this.refresh();
		const generation = ++this.requestGeneration;
		const context = this.inputEl.composer.capture();
		void this.vaultTagIndex.ensureReady().then(() => {
			if (generation === this.requestGeneration && context.valid()) this.refresh();
		});
	}
	refresh(): void {
		if (this.inputEl.composer.composing) return;
		const selected = this.suggestions[this.selectedIndex]?.tag;
		const suggestions = this.getSuggestions();
		this.close();
		if (!suggestions.length) return;
		this.suggestions = suggestions;
		this.selectedIndex = Math.max(0, suggestions.findIndex(suggestion => suggestion.tag === selected));
		const container = this.inputEl.ownerDocument.body.createDiv({ cls: "suggestion-container knomo-tag-suggest-popover" });
		this.popoverEl = container;
		container.id = this.popoverId;
		this.hidePopoverUntilPositioned();
		this.inputEl.setAttribute("aria-controls", this.popoverId);
		this.inputEl.setAttribute("aria-expanded", "true");
		container.setAttribute("role", "listbox");
		for (const [index, suggestion] of suggestions.entries()) {
			const item = container.createDiv({ cls: "suggestion-item" });
			item.setAttribute("role", "option");
			item.id = `${this.popoverId}-${index}`;
			item.setAttribute("aria-selected", String(index === this.selectedIndex));
			item.toggleClass("is-selected", index === this.selectedIndex);
			this.renderSuggestion(suggestion, item);
			item.addEventListener("pointerdown", event => event.preventDefault());
			item.addEventListener("click", event => this.selectSuggestion(suggestion, event));
		}
		this.inputEl.setAttribute("aria-activedescendant", `${this.popoverId}-${this.selectedIndex}`);
		this.queuePopoverReposition();
	}
	handleKeydown(event: KeyboardEvent): boolean {
		const controlNavigation = event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && ["n", "p"].includes(event.key.toLowerCase());
		if (!this.popoverEl || event.isComposing || this.inputEl.composer.composing || (event.ctrlKey || event.metaKey) && !controlNavigation) return false;
		if (!["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(event.key) && !controlNavigation) return false;
		event.preventDefault(); event.stopImmediatePropagation();
		if (event.key === "Escape") this.close();
		else if (event.key === "Enter" || event.key === "Tab") this.selectSuggestion(this.suggestions[this.selectedIndex], event);
		else {
			this.selectedIndex = (this.selectedIndex + (event.key === "ArrowDown" || event.key === "n" ? 1 : -1) + this.suggestions.length) % this.suggestions.length;
			Array.from(this.popoverEl.children).forEach((child, index) => {
				child.classList.toggle("is-selected", index === this.selectedIndex);
				child.setAttribute("aria-selected", String(index === this.selectedIndex));
			});
			this.inputEl.setAttribute("aria-activedescendant", `${this.popoverId}-${this.selectedIndex}`);
			this.popoverEl.children[this.selectedIndex]?.scrollIntoView({ block: "nearest" });
		}
		return true;
	}
	private getSuggestions(): TagSuggestion[] {
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
		applyComposerEdit(this.inputEl, next.value, next.cursor);
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
		return [...this.vaultTagIndex.getSnapshot().suggestions];
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

	private getSuggestionContainer(): HTMLElement | null { return this.popoverEl; }
}

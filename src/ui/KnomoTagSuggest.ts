import { applyComposerEdit, type ComposerInput } from "./ComposerEditor";
import { registerComposerToolGesture } from "./ComposerToolGesture";
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
	private renderedQuery: string | null = null;
	private requestGeneration = 0;
	private readonly popoverId: string;
	private dismissed: ReturnType<ComposerInput["composer"]["capture"]> | null = null;
	private clearTouchClickGuard: (() => void) | null = null;

	constructor(
		app: App,
		private readonly inputEl: ComposerInput,
		private readonly onInputChanged: () => void,
		private readonly vaultTagIndex: VaultTagIndex,
	) {
		void app;
		this.popoverId = `${inputEl.getAttribute("aria-labelledby") ?? "knomo-composer"}-tag-suggestions`;
	}

	open(): void { this.dismissed = null; this.refresh(); }
	close(): void {
		this.dismissed = this.inputEl.composer.capture();
		this.clear();
	}
	private clear(): void {
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
		this.dismissed = null;
		this.refresh();
		const generation = ++this.requestGeneration;
		const context = this.inputEl.composer.capture();
		void this.vaultTagIndex.ensureReady().then(() => {
			if (generation === this.requestGeneration && context.valid()) this.refresh();
		});
	}
	refresh(): void {
		if (this.inputEl.composer.readOnly) { this.close(); return; }
		if (this.inputEl.composer.composing) return;
		if (!this.inputEl.contains(this.inputEl.ownerDocument.activeElement)) { this.close(); return; }
		const current = this.inputEl.composer.capture();
		if (this.dismissed?.valid() && this.dismissed.anchor === current.anchor && this.dismissed.head === current.head) return;
		this.dismissed = null;
		const selected = this.suggestions[this.selectedIndex]?.tag;
		const suggestions = this.getSuggestions();
		const query = getTagQueryAtCursor(this.inputEl.value, this.inputEl.selectionStart)?.query ?? null;
		// 导航和松键不重建候选 DOM，保留滚动位置与鼠标目标。
		if (this.popoverEl && query === this.renderedQuery && suggestions.length === this.suggestions.length
			&& suggestions.every((suggestion, index) => suggestion.tag === this.suggestions[index].tag)) {
			this.queuePopoverReposition();
			return;
		}
		this.clear();
		if (!suggestions.length) return;
		this.renderedQuery = query;
		this.suggestions = suggestions;
		this.selectedIndex = Math.max(0, suggestions.findIndex(suggestion => suggestion.tag === selected));
		const container = this.inputEl.ownerDocument.body.createDiv({ cls: "suggestion-container knomo-tag-suggest-popover" });
		this.popoverEl = container;
		container.id = this.popoverId;
		this.hidePopoverUntilPositioned();
		this.inputEl.setAttribute("aria-controls", this.popoverId);
		this.inputEl.setAttribute("aria-expanded", "true");
		container.setAttribute("role", "listbox");
		// 与工具栏共用触摸手势：松手点选、滑动/取消不选，阻止兼容鼠标事件夺走焦点。
		registerComposerToolGesture(container, (action, event) => {
			const suggestion = this.suggestions[Number(action)];
			if (this.popoverEl !== container || !suggestion) return;
			if (event.type === "pointerup") {
				event.stopImmediatePropagation();
				this.guardTouchClickThrough(event);
			}
			this.selectSuggestion(suggestion);
		});
		for (const [index, suggestion] of suggestions.entries()) {
			const item = container.createDiv({ cls: "suggestion-item" });
			item.setAttribute("role", "option");
			item.setAttribute("data-action", String(index));
			item.id = `${this.popoverId}-${index}`;
			item.setAttribute("aria-selected", String(index === this.selectedIndex));
			item.toggleClass("is-selected", index === this.selectedIndex);
			this.renderSuggestion(suggestion, item);
			item.addEventListener("pointermove", event => {
				if (event.pointerType === "mouse") this.setSelectedIndex(index, false);
			});
		}
		this.inputEl.setAttribute("aria-activedescendant", `${this.popoverId}-${this.selectedIndex}`);
		this.queuePopoverReposition();
	}
	registerLifecycle(): () => void {
		const keydown = (event: KeyboardEvent) => { this.handleKeydown(event); };
		const keyup = (event: KeyboardEvent) => { if (!(event.ctrlKey || event.metaKey)) this.refresh(); };
		const close = () => this.close();
		const reset = () => { this.clearTouchClickGuard?.(); this.close(); };
		this.inputEl.addEventListener("keydown", keydown, true);
		this.inputEl.addEventListener("keyup", keyup);
		this.inputEl.addEventListener("blur", close);
		this.inputEl.addEventListener("composer-reset", reset);
		return () => {
			this.inputEl.removeEventListener("keydown", keydown, true);
			this.inputEl.removeEventListener("keyup", keyup);
			this.inputEl.removeEventListener("blur", close);
			this.inputEl.removeEventListener("composer-reset", reset);
			this.clearTouchClickGuard?.();
			this.close();
		};
	}
	private guardTouchClickThrough(origin: MouseEvent): void {
		this.clearTouchClickGuard?.();
		const win = this.inputEl.ownerDocument.defaultView;
		if (win === null) return;
		// 松手后候选 DOM 会消失；在窗口捕获同一次触摸的尾部事件，防止重新命中编辑器/蒙层。
		const types = ["touchend", "mousedown", "mouseup", "click"] as const;
		const guard = (event: Event) => {
			if (event.type === "click" && (event as MouseEvent).detail === 0) return;
			const point = event.type === "touchend"
				? (event as TouchEvent).changedTouches[0] : event as MouseEvent;
			if (!point || Math.hypot(point.clientX - origin.clientX, point.clientY - origin.clientY) > 12) return;
			event.preventDefault();
			event.stopImmediatePropagation();
			if (event.type === "click") clear();
		};
		const clear = () => {
			for (const type of types) win.removeEventListener(type, guard, true);
			win.removeEventListener("pointerdown", clear, true);
			win.clearTimeout(timer);
			this.clearTouchClickGuard = null;
		};
		const timer = win.setTimeout(clear, 600);
		this.clearTouchClickGuard = clear;
		for (const type of types) win.addEventListener(type, guard, { capture: true, passive: false });
		// 新的真实手势立即放行，不依赖固定延时封锁后续点击。
		win.addEventListener("pointerdown", clear, true);
	}
	handleKeydown(event: KeyboardEvent): boolean {
		const controlNavigation = event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && ["n", "p"].includes(event.key.toLowerCase());
		if (!this.popoverEl || event.isComposing || this.inputEl.composer.composing || (event.ctrlKey || event.metaKey) && !controlNavigation) return false;
		if (!["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(event.key) && !controlNavigation) return false;
		event.preventDefault(); event.stopImmediatePropagation();
		if (event.key === "Escape") this.close();
		else if (event.key === "Enter" || event.key === "Tab") this.selectSuggestion(this.suggestions[this.selectedIndex], event);
		else {
			this.setSelectedIndex((this.selectedIndex + (event.key === "ArrowDown" || event.key.toLowerCase() === "n" ? 1 : -1) + this.suggestions.length) % this.suggestions.length, true);
		}
		return true;
	}
	private setSelectedIndex(index: number, scroll: boolean): void {
		if (!this.popoverEl) return;
		this.selectedIndex = index;
		Array.from(this.popoverEl.children).forEach((child, childIndex) => {
			child.classList.toggle("is-selected", childIndex === index);
			child.setAttribute("aria-selected", String(childIndex === index));
		});
		this.inputEl.setAttribute("aria-activedescendant", `${this.popoverId}-${index}`);
		if (scroll) this.popoverEl.children[index]?.scrollIntoView({ block: "nearest" });
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

	selectSuggestion(value: TagSuggestion, _evt?: MouseEvent | KeyboardEvent): void {
		const range = getTagQueryAtCursor(this.inputEl.value, this.inputEl.selectionStart);
		if (range === null) {
			this.close();
			return;
		}
		const next = replaceTagQueryWithSuggestion(this.inputEl.value, range, value.tag);
		if (!applyComposerEdit(this.inputEl, next.value, next.cursor)) return;
		this.inputEl.composer.view.focus();
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

import { applyComposerEdit, type ComposerInput } from "./ComposerEditor";
import { registerComposerToolGesture } from "./ComposerToolGesture";
import { getSuggestionNavigationIndex, guardSuggestionTouchClickThrough, scrollSuggestionIntoView } from "./composerSuggestInteraction";
import { prepareFuzzySearch, renderResults } from "obsidian";
import type { App, SearchResult } from "obsidian";

import type { VaultTagIndex } from "../services/VaultTagIndex";
import { getTagQueryAtCursor, replaceTagQueryWithSuggestion } from "../utils/composerInput";
import {
	clamp,
	getDesktopSuggestionPosition,
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
	private listEl: HTMLElement | null = null;
	private suggestions: TagSuggestion[] = [];
	private selectedIndex = 0;
	private renderedQuery: string | null = null;
	private calculated: { revision: number; query: string; suggestions: TagSuggestion[] } | null = null;
	private requestGeneration = 0;
	private pendingRequest: number | null = null;
	private readonly popoverId: string;
	private dismissed: ReturnType<ComposerInput["composer"]["capture"]> | null = null;
	private clearTouchClickGuard: (() => void) | null = null;
	private clearGesture: (() => void) | null = null;
	private releaseGlassSurface: (() => void) | null = null;

	constructor(
		app: App,
		private readonly inputEl: ComposerInput,
		private readonly onInputChanged: () => void,
		private readonly vaultTagIndex: VaultTagIndex,
		private readonly registerGlassSurface?: (surface: HTMLElement) => () => void,
	) {
		void app;
		this.popoverId = `${inputEl.getAttribute("aria-labelledby") ?? "knomo-composer"}-tag-suggestions`;
	}

	open(): void { this.dismissed = null; this.refresh(); }
	close(): void {
		this.dismissed = this.inputEl.composer.capture();
		this.calculated = null;
		this.cancelRequest();
		this.clearPopover();
	}
	private cancelRequest(): void {
		this.requestGeneration++;
		this.pendingRequest = null;
	}
	private clearPopover(): void {
		this.clearPopoverReposition();
		this.clearGesture?.();
		this.clearGesture = null;
		this.releaseGlassSurface?.();
		this.releaseGlassSurface = null;
		this.popoverEl?.remove();
		this.popoverEl = null;
		this.listEl = null;
		this.suggestions = [];
		if (this.inputEl.getAttribute("aria-controls") === this.popoverId) {
			this.inputEl.setAttribute("aria-expanded", "false");
			this.inputEl.removeAttribute("aria-activedescendant");
		}
	}
	openForCurrentTrigger(): void {
		this.dismissed = null;
		this.refresh();
	}
	private prepareSuggestions(): void {
		const status = this.vaultTagIndex.getSnapshot().status;
		if (this.pendingRequest !== null || (status !== "idle" && status !== "building")) return;
		const generation = ++this.requestGeneration;
		this.pendingRequest = generation;
		const context = this.inputEl.composer.capture();
		void this.vaultTagIndex.ensureReady().then(() => {
			if (generation !== this.requestGeneration) return;
			this.pendingRequest = null;
			// 同一编辑会话允许继续输入；完成后读取当前查询，重置和销毁仍使等待失效。
			if (context.sameSession()) this.refresh();
		}).catch((error: unknown) => {
			if (generation !== this.requestGeneration) return;
			this.pendingRequest = null;
			if (context.sameSession()) this.close();
			console.error("[Knomo] Tag suggestions could not be loaded", error);
		});
	}
	refresh(): void {
		if (this.inputEl.composer.readOnly) { this.close(); return; }
		if (this.inputEl.composer.composing) { this.close(); return; }
		if (!this.inputEl.contains(this.inputEl.ownerDocument.activeElement)) { this.close(); return; }
		const current = this.inputEl.composer.capture();
		if (this.dismissed?.valid() && this.dismissed.anchor === current.anchor && this.dismissed.head === current.head) return;
		this.dismissed = null;
		if (getTagQueryAtCursor(this.inputEl.value, this.inputEl.selectionStart) === null) {
			this.calculated = null;
			this.cancelRequest();
			this.clearPopover();
			return;
		}
		this.prepareSuggestions();
		const selected = this.suggestions[this.selectedIndex]?.tag;
		const suggestions = this.getSuggestions();
		const query = getTagQueryAtCursor(this.inputEl.value, this.inputEl.selectionStart)?.query ?? null;
		const sameQuery = query === this.renderedQuery;
		// 导航和松键不重建候选 DOM，保留滚动位置与鼠标目标。
		if (this.popoverEl && sameQuery && (suggestions === this.suggestions
			|| suggestions.length === this.suggestions.length
			&& suggestions.every((suggestion, index) => suggestion.tag === this.suggestions[index].tag))) {
			this.suggestions = suggestions;
			this.queuePopoverReposition();
			return;
		}
		this.clearPopover();
		if (!suggestions.length) return;
		this.renderedQuery = query;
		this.suggestions = suggestions;
		this.selectedIndex = sameQuery ? Math.max(0, suggestions.findIndex(suggestion => suggestion.tag === selected)) : 0;
		const mobile = this.inputEl.closest(".knomo-mobile-composer-layer") !== null;
		const container = this.inputEl.ownerDocument.body.createDiv({
			cls: `suggestion-container knomo-tag-suggest-popover knomo-native-suggest${mobile ? " knomo-tag-suggest-mobile knomo-suggest-mobile" : ""}`,
		});
		this.popoverEl = container;
		this.releaseGlassSurface = this.registerGlassSurface?.(container) ?? null;
		container.id = this.popoverId;
		this.hidePopoverUntilPositioned();
		this.inputEl.setAttribute("aria-controls", this.popoverId);
		this.inputEl.setAttribute("aria-expanded", "true");
		container.setAttribute("role", "listbox");
		const list = this.listEl = container.createDiv({ cls: "suggestion knomo-suggest-list" });
		// 与工具栏共用触摸手势：松手点选、滑动/取消不选，阻止兼容鼠标事件夺走焦点。
		this.clearGesture = registerComposerToolGesture(container, (action, event) => {
			const suggestion = this.suggestions[Number(action)];
			if (this.popoverEl !== container || !suggestion || this.inputEl.composer.readOnly || this.inputEl.composer.composing) return;
			if (event.type === "pointerup") {
				event.stopImmediatePropagation();
				this.clearTouchClickGuard?.();
				this.clearTouchClickGuard = guardSuggestionTouchClickThrough(event, container, () => { this.clearTouchClickGuard = null; });
			}
			this.selectSuggestion(suggestion);
		}, mobile ? {
			scrollElement: list,
			capture: () => {
				const context = this.inputEl.composer.capture();
				const canStart = !this.inputEl.composer.readOnly && !this.inputEl.composer.composing;
				return () => {
					const current = this.inputEl.composer.capture();
					return canStart && this.popoverEl === container && context.valid()
						&& current.anchor === context.anchor && current.head === context.head
						&& !this.inputEl.composer.readOnly && !this.inputEl.composer.composing;
				};
			},
		} : undefined);
		for (const [index, suggestion] of suggestions.entries()) {
			const item = list.createDiv({ cls: "suggestion-item" });
			item.setAttribute("role", "option");
			item.setAttribute("data-action", String(index));
			item.id = `${this.popoverId}-${index}`;
			item.setAttribute("aria-selected", String(index === this.selectedIndex));
			item.toggleClass("is-selected", index === this.selectedIndex);
			const label = mobile ? item.createSpan() : item;
			this.renderSuggestion(suggestion, label);
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
		this.inputEl.addEventListener("compositionstart", close);
		this.inputEl.addEventListener("composer-reset", reset);
		return () => {
			this.inputEl.removeEventListener("keydown", keydown, true);
			this.inputEl.removeEventListener("keyup", keyup);
			this.inputEl.removeEventListener("blur", close);
			this.inputEl.removeEventListener("compositionstart", close);
			this.inputEl.removeEventListener("composer-reset", reset);
			this.clearTouchClickGuard?.();
			this.close();
		};
	}
	handleKeydown(event: KeyboardEvent): boolean {
		if (event.key === "Escape" && this.pendingRequest !== null && !event.isComposing && !this.inputEl.composer.composing) {
			event.preventDefault(); event.stopImmediatePropagation(); this.close(); return true;
		}
		if (!this.listEl || event.isComposing || this.inputEl.composer.composing) return false;
		const nextIndex = getSuggestionNavigationIndex(event, this.selectedIndex, this.listEl);
		if ((event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) && nextIndex === null) return false;
		if (!["Enter", "Tab", "Escape"].includes(event.key) && nextIndex === null) return false;
		event.preventDefault(); event.stopImmediatePropagation();
		if (event.key === "Escape") this.close();
		else if (event.key === "Enter" || event.key === "Tab") this.selectSuggestion(this.suggestions[this.selectedIndex], event);
		else {
			this.setSelectedIndex(nextIndex!, true);
		}
		return true;
	}
	private setSelectedIndex(index: number, scroll: boolean): void {
		if (!this.listEl) return;
		this.selectedIndex = index;
		Array.from(this.listEl.children).forEach((child, childIndex) => {
			child.classList.toggle("is-selected", childIndex === index);
			child.setAttribute("aria-selected", String(childIndex === index));
		});
		this.inputEl.setAttribute("aria-activedescendant", `${this.popoverId}-${index}`);
		if (scroll) {
			const item = this.listEl.children[index] as HTMLElement | undefined;
			if (item) scrollSuggestionIntoView(this.listEl, item);
		}
	}
	private getSuggestions(): TagSuggestion[] {
		const range = getTagQueryAtCursor(this.inputEl.value, this.inputEl.selectionStart);
		if (range === null) {
			return [];
		}
		const snapshot = this.vaultTagIndex.getSnapshot();
		if (this.calculated?.revision === snapshot.revision && this.calculated.query === range.query) {
			return this.calculated.suggestions;
		}
		const tags = snapshot.suggestions;
		const suggestions = range.query.length === 0
			? tags.map((tag) => ({ tag, result: null }))
			: this.getFuzzySuggestions(tags, range.query);
		// 只保留当前查询，空结果也复用；关闭与 trigger 失效时释放。
		this.calculated = { revision: snapshot.revision, query: range.query, suggestions };
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

	selectSuggestion(value: TagSuggestion, event?: MouseEvent | KeyboardEvent): void {
		const range = getTagQueryAtCursor(this.inputEl.value, this.inputEl.selectionStart);
		if (range === null) {
			this.close();
			return;
		}
		const completing = event?.type === "keydown" && (event as KeyboardEvent).key === "Tab";
		const replacement = `#${value.tag.replace(/^#/, "")}`;
		const next = completing ? {
			value: `${this.inputEl.value.slice(0, range.from)}${replacement}${this.inputEl.value.slice(range.to)}`,
			cursor: range.from + replacement.length,
		} : replaceTagQueryWithSuggestion(this.inputEl.value, range, value.tag);
		if (!applyComposerEdit(this.inputEl, next.value, next.cursor)) return;
		this.inputEl.composer.view.focus();
		this.onInputChanged();
		if (completing) this.refresh();
		else this.close();
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

	private getFuzzySuggestions(tags: readonly string[], query: string): TagSuggestion[] {
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
			container.addClass("knomo-tag-suggest-popover");
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
			container.setCssProps({ "--knomo-suggest-width": `${Math.round(width)}px` });
			const contentHeight = measureSuggestionContentHeight(this.inputEl, container, ".suggestion-item");
			const measuredHeight = Math.min(maxHeight, contentHeight > 0 ? contentHeight : maxHeight);
			const top = Math.max(viewportTop + topGuard, anchor.top - measuredHeight - gap);
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
		container.setCssProps({ "--knomo-suggest-width": `${Math.round(width)}px` });
		const viewportTop = viewport ? Math.max(0, viewport.offsetTop) : 0;
		const viewportBottom = viewportTop + (viewport?.height ?? win?.innerHeight ?? this.inputEl.ownerDocument.documentElement.clientHeight);
		const position = getDesktopSuggestionPosition(anchor,
			measureSuggestionContentHeight(this.inputEl, container, ".suggestion-item"), viewportTop, viewportBottom);
		this.setPopoverOffsetPosition(container, left, position.top, width, position.maxHeight);
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

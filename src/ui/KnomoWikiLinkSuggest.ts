import type { App, EventRef, TFile } from "obsidian";

import {
	completeWikiLinkTriggerAtCursor,
	getWikiLinkFileSuggestions,
	getWikiLinkRangeAtCursor,
	isKnomoInternalWikiLinkCandidate,
	replaceWikiLinkRangeWithLinktext,
} from "../utils/wikiLinkInput";
import type { TextReplacement, WikiLinkSuggestionMatch } from "../utils/wikiLinkInput";
import {
	clamp,
	getTextareaCharacterRect,
	measureSuggestionContentHeight,
	measureSuggestionContentWidth,
} from "./composerSuggestPosition";

interface KnomoWikiLinkSuggestOptions {
	getSourcePath: () => string;
	onInputChanged: () => void;
	closeTagSuggest: () => void;
	registerVaultEvent: (eventRef: EventRef) => void;
}

type WikiLinkSuggestion = WikiLinkSuggestionMatch<TFile>;

const WIKI_LINK_SUGGESTION_LIMIT = 10;
const WIKI_LINK_POPOVER_Z_INDEX = "10020";
const MOBILE_TOP_GUARD = 52;
const POPOVER_GAP = 8;
const VIEWPORT_MARGIN = 12;

export class KnomoWikiLinkSuggest {
	private filesSnapshot: TFile[] | null = null;
	private popoverEl: HTMLElement | null = null;
	private suggestions: WikiLinkSuggestion[] = [];
	private selectedIndex = 0;
	private composing = false;
	private repositionFrameId: number | null = null;

	constructor(
		private readonly app: App,
		private readonly inputEl: HTMLTextAreaElement,
		private readonly options: KnomoWikiLinkSuggestOptions,
	) {
		this.options.registerVaultEvent(this.app.vault.on("create", () => this.invalidateFiles()));
		this.options.registerVaultEvent(this.app.vault.on("delete", () => this.invalidateFiles()));
		this.options.registerVaultEvent(this.app.vault.on("rename", () => this.invalidateFiles()));
	}

	destroy(): void {
		this.close();
		this.filesSnapshot = null;
	}

	close(): void {
		this.clearReposition();
		this.popoverEl?.detach();
		this.popoverEl = null;
		this.suggestions = [];
		this.selectedIndex = 0;
	}

	handleBeforeInput(event: InputEvent): boolean {
		if (event.defaultPrevented || event.isComposing || this.composing) {
			return false;
		}
		if (event.inputType !== "insertText" || (event.data !== "[" && event.data !== "【")) {
			return false;
		}
		if (this.inputEl.selectionStart !== this.inputEl.selectionEnd) {
			return false;
		}
		const cursor = this.inputEl.selectionStart;
		const beforeChar = this.inputEl.value.charAt(cursor - 1);
		if (beforeChar !== event.data) {
			return false;
		}
		const nextValue = `${this.inputEl.value.slice(0, cursor)}${event.data}${this.inputEl.value.slice(cursor)}`;
		const patch = completeWikiLinkTriggerAtCursor(nextValue, cursor + event.data.length);
		if (patch === null) {
			return false;
		}
		event.preventDefault();
		this.applyPatch(patch);
		this.openForCurrentRange();
		return true;
	}

	handleInput(): boolean {
		if (this.composing) {
			return false;
		}
		const patch = completeWikiLinkTriggerAtCursor(this.inputEl.value, this.inputEl.selectionStart);
		if (patch !== null) {
			this.applyPatch(patch);
			this.openForCurrentRange();
			return true;
		}
		this.refreshForCursor();
		return false;
	}

	handleCompositionStart(): void {
		this.composing = true;
	}

	handleCompositionEnd(): boolean {
		this.composing = false;
		const patch = completeWikiLinkTriggerAtCursor(this.inputEl.value, this.inputEl.selectionStart);
		if (patch !== null) {
			this.applyPatch(patch);
			this.openForCurrentRange();
			return true;
		}
		this.refreshForCursor();
		return false;
	}

	handleKeydown(event: KeyboardEvent): boolean {
		if (this.popoverEl === null) {
			return false;
		}
		if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			event.stopImmediatePropagation();
			this.close();
			return true;
		}
		if (this.suggestions.length === 0) {
			return false;
		}
		if (event.key === "ArrowDown") {
			event.preventDefault();
			event.stopPropagation();
			event.stopImmediatePropagation();
			this.selectedIndex = (this.selectedIndex + 1) % this.suggestions.length;
			this.renderSuggestions();
			return true;
		}
		if (event.key === "ArrowUp") {
			event.preventDefault();
			event.stopPropagation();
			event.stopImmediatePropagation();
			this.selectedIndex = (this.selectedIndex + this.suggestions.length - 1) % this.suggestions.length;
			this.renderSuggestions();
			return true;
		}
		if (event.key === "Enter" || event.key === "Tab") {
			event.preventDefault();
			event.stopPropagation();
			event.stopImmediatePropagation();
			this.selectSuggestion(this.selectedIndex);
			return true;
		}
		return false;
	}

	openForCurrentRange(): void {
		const range = getWikiLinkRangeAtCursor(this.inputEl.value, this.inputEl.selectionStart);
		if (range === null) {
			this.close();
			return;
		}
		this.options.closeTagSuggest();
		this.ensurePopover();
		this.refreshSuggestions(range.query);
	}

	refreshForCursor(): void {
		const range = getWikiLinkRangeAtCursor(this.inputEl.value, this.inputEl.selectionStart);
		if (range === null) {
			this.close();
			return;
		}
		this.options.closeTagSuggest();
		this.ensurePopover();
		this.refreshSuggestions(range.query);
	}

	isOpen(): boolean {
		return this.popoverEl !== null;
	}

	getSelectedIndex(): number {
		return this.selectedIndex;
	}

	getSuggestionsForTest(): WikiLinkSuggestion[] {
		return this.suggestions;
	}

	getPopoverForTest(): HTMLElement | null {
		return this.popoverEl;
	}

	private refreshSuggestions(query: string): void {
		const files = this.getFilesSnapshot();
		this.suggestions = getWikiLinkFileSuggestions(files, query, WIKI_LINK_SUGGESTION_LIMIT);
		this.selectedIndex = this.suggestions.length === 0 ? 0 : Math.min(this.selectedIndex, this.suggestions.length - 1);
		if (this.suggestions.length === 0) {
			this.close();
			return;
		}
		this.renderSuggestions();
	}

	private renderSuggestions(): void {
		const popover = this.popoverEl;
		if (popover === null) {
			return;
		}
		popover.empty();
		for (const [index, suggestion] of this.suggestions.entries()) {
			const item = popover.createDiv({
				cls: "knomo-link-suggest-item",
				attr: {
					role: "option",
					tabindex: "-1",
				},
			});
			item.toggleClass("is-selected", index === this.selectedIndex);
			item.createDiv({ cls: "knomo-link-suggest-title", text: suggestion.basename });
			if (suggestion.showPath) {
				item.createDiv({ cls: "knomo-link-suggest-path", text: suggestion.path });
			}
			let touchStartY: number | null = null;
			let touchMoved = false;
			const preventBlur = (event: Event) => {
				if (isTouchPointerEvent(event)) {
					return;
				}
				event.preventDefault();
			};
			const choose = (event: Event) => {
				if (isTouchPointerEvent(event)) {
					return;
				}
				if (touchMoved) {
					touchMoved = false;
					return;
				}
				event.preventDefault();
				this.selectSuggestion(index);
			};
			const startTouch = (event: TouchEvent) => {
				touchStartY = event.touches[0]?.clientY ?? null;
				touchMoved = false;
			};
			const trackTouchMove = (event: TouchEvent) => {
				if (touchStartY === null) {
					return;
				}
				const currentY = event.touches[0]?.clientY ?? touchStartY;
				if (Math.abs(currentY - touchStartY) > 6) {
					touchMoved = true;
				}
			};
			item.addEventListener("pointerdown", preventBlur);
			item.addEventListener("mousedown", preventBlur);
			item.addEventListener("touchstart", startTouch);
			item.addEventListener("touchmove", trackTouchMove);
			item.addEventListener("pointerup", choose);
			item.addEventListener("touchend", choose);
			item.addEventListener("click", choose);
		}
		this.queueReposition();
	}

	private selectSuggestion(index: number): void {
		const suggestion = this.suggestions[index];
		if (suggestion === undefined) {
			return;
		}
		const range = getWikiLinkRangeAtCursor(this.inputEl.value, this.inputEl.selectionStart);
		if (range === null) {
			this.close();
			return;
		}
		const sourcePath = this.options.getSourcePath();
		const linktext = this.getSafeLinktext(suggestion.file, sourcePath);
		this.applyPatch(replaceWikiLinkRangeWithLinktext(this.inputEl.value, range, linktext));
		this.close();
	}

	private getSafeLinktext(file: TFile, sourcePath: string): string {
		const linktext = this.app.metadataCache.fileToLinktext(file, sourcePath, true);
		const resolved = this.app.metadataCache.getFirstLinkpathDest(linktext, sourcePath);
		if (resolved?.path === file.path) {
			return linktext;
		}
		const fallback = file.path.replace(/\.md$/i, "");
		const fallbackResolved = this.app.metadataCache.getFirstLinkpathDest(fallback, sourcePath);
		return fallbackResolved?.path === file.path ? fallback : linktext;
	}

	private applyPatch(patch: TextReplacement): void {
		this.inputEl.value = patch.value;
		this.focusInput();
		this.inputEl.setSelectionRange(patch.cursor, patch.cursor);
		this.dispatchInputEvent();
		this.options.onInputChanged();
	}

	private focusInput(): void {
		try {
			this.inputEl.focus({ preventScroll: true });
		} catch {
			this.inputEl.focus();
		}
	}

	private dispatchInputEvent(): void {
		const EventConstructor = (this.inputEl.win as Window & { Event: typeof Event }).Event;
		this.inputEl.dispatchEvent(new EventConstructor("input", { bubbles: true, cancelable: false }));
	}

	private getFilesSnapshot(): TFile[] {
		if (this.filesSnapshot === null) {
			this.filesSnapshot = this.app.vault.getMarkdownFiles()
				.filter((file) => !isKnomoInternalWikiLinkCandidate(file.path));
		}
		return this.filesSnapshot;
	}

	private invalidateFiles(): void {
		this.filesSnapshot = null;
		if (this.popoverEl !== null) {
			this.refreshForCursor();
		}
	}

	private ensurePopover(): void {
		if (this.popoverEl !== null) {
			return;
		}
		const popover = this.inputEl.ownerDocument.body.createDiv({
			cls: "knomo-link-suggest-popover knomo-link-suggest-positioning",
			attr: {
				role: "listbox",
			},
		});
		popover.setCssProps({ "--knomo-suggest-z-index": WIKI_LINK_POPOVER_Z_INDEX });
		this.popoverEl = popover;
	}

	private queueReposition(): void {
		const win = this.inputEl.ownerDocument.defaultView;
		if (win === null) {
			this.repositionPopover();
			return;
		}
		if (this.repositionFrameId !== null) {
			return;
		}
		this.repositionFrameId = win.requestAnimationFrame(() => {
			this.repositionFrameId = null;
			this.repositionPopover();
		});
	}

	private repositionPopover(): void {
		const popover = this.popoverEl;
		if (popover === null) {
			return;
		}
		const range = getWikiLinkRangeAtCursor(this.inputEl.value, this.inputEl.selectionStart);
		if (range === null) {
			this.close();
			return;
		}
		const doc = this.inputEl.ownerDocument;
		const win = doc.defaultView;
		const anchor = getTextareaCharacterRect(this.inputEl, this.inputEl.selectionStart);
		if (anchor === null) {
			return;
		}
		const inputRect = this.inputEl.getBoundingClientRect();
		const viewport = win?.visualViewport ?? null;
		const viewportTop = viewport ? Math.max(0, viewport.offsetTop) : 0;
		const viewportLeft = viewport ? Math.max(0, viewport.offsetLeft) : 0;
		const viewportWidth = viewport ? viewport.width : win?.innerWidth ?? doc.documentElement.clientWidth;
		const viewportHeight = viewport ? viewport.height : win?.innerHeight ?? doc.documentElement.clientHeight;
		const viewportRight = viewportLeft + viewportWidth;
		const viewportBottom = viewportTop + viewportHeight;
		const availableWidth = Math.max(0, viewportWidth - VIEWPORT_MARGIN * 2);
		const contentWidth = measureSuggestionContentWidth(this.inputEl, popover, ".knomo-link-suggest-item", {
			includeScrollbarWidth: true,
			extraWidth: 12,
		});
		const targetWidth = contentWidth > 0 ? contentWidth : inputRect.width;
		const width = Math.max(0, Math.min(Math.max(targetWidth, 220), 360, availableWidth));
		const minLeft = viewportLeft + VIEWPORT_MARGIN;
		const maxLeft = Math.max(minLeft, viewportRight - VIEWPORT_MARGIN - width);
		const left = clamp(anchor.left, minLeft, maxLeft);
		const mobileLayer = this.inputEl.closest(".knomo-mobile-composer-layer");
		const popoverCssProps = {
			"--knomo-suggest-left": `${Math.round(left)}px`,
			"--knomo-suggest-width": `${Math.round(width)}px`,
		};
		if (mobileLayer !== null) {
			const availableAbove = Math.max(0, anchor.top - viewportTop - MOBILE_TOP_GUARD - POPOVER_GAP);
			const maxHeight = Math.min(240, availableAbove);
			const contentHeight = measureSuggestionContentHeight(this.inputEl, popover, ".knomo-link-suggest-item");
			const measuredHeight = Math.min(maxHeight, contentHeight > 0 ? contentHeight : maxHeight);
			const top = Math.max(viewportTop + MOBILE_TOP_GUARD, anchor.top - measuredHeight - POPOVER_GAP);
			popover.setCssProps({
				...popoverCssProps,
				"--knomo-suggest-top": `${Math.round(top)}px`,
				"--knomo-suggest-max-height": `${Math.round(maxHeight)}px`,
			});
			popover.removeClass("knomo-link-suggest-positioning");
			return;
		}
		const maxHeight = Math.max(72, Math.min(240, viewportBottom - anchor.bottom - VIEWPORT_MARGIN));
		popover.setCssProps({
			...popoverCssProps,
			"--knomo-suggest-top": `${Math.round(anchor.bottom)}px`,
			"--knomo-suggest-max-height": `${Math.round(maxHeight)}px`,
		});
		popover.removeClass("knomo-link-suggest-positioning");
	}

	private clearReposition(): void {
		const win = this.inputEl.ownerDocument.defaultView;
		if (win !== null && this.repositionFrameId !== null) {
			win.cancelAnimationFrame(this.repositionFrameId);
		}
		this.repositionFrameId = null;
	}

}

function isTouchPointerEvent(event: Event): boolean {
	return "pointerType" in event && (event as PointerEvent).pointerType === "touch";
}

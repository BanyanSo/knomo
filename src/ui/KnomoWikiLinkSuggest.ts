import { applyComposerEdit, type ComposerInput } from "./ComposerEditor";
import { registerComposerToolGesture } from "./ComposerToolGesture";
import { getSuggestionNavigationIndex, guardSuggestionTouchClickThrough, scrollSuggestionIntoView } from "./composerSuggestInteraction";
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
	getDesktopSuggestionPosition,
	getTextareaCharacterRect,
	measureSuggestionContentHeight,
	measureSuggestionContentWidth,
} from "./composerSuggestPosition";

interface KnomoWikiLinkSuggestOptions {
	listboxId: string;
	getSourcePath: () => string;
	onInputChanged: () => void;
	closeTagSuggest: () => void;
	registerVaultEvent: (eventRef: EventRef) => void;
	registerGlassSurface?: (surface: HTMLElement) => () => void;
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
	private listEl: HTMLElement | null = null;
	private suggestions: WikiLinkSuggestion[] = [];
	private selectedIndex = 0;
	private composing = false;
	private repositionFrameId: number | null = null;
	private releaseGlassSurface: (() => void) | null = null;
	private clearGesture: (() => void) | null = null;
	private clearTouchClickGuard: (() => void) | null = null;
	private dismissed: ReturnType<ComposerInput["composer"]["capture"]> | null = null;
	private renderedQuery: string | null = null;
	private computedQuery: string | null = null;
	private computedSuggestions: WikiLinkSuggestion[] = [];

	constructor(
		private readonly app: App,
		private readonly inputEl: ComposerInput,
		private readonly options: KnomoWikiLinkSuggestOptions,
	) {
		this.inputEl.setAttr("aria-autocomplete", "list");
		this.inputEl.setAttr("aria-haspopup", "listbox");
		this.inputEl.setAttr("aria-controls", this.options.listboxId);
		this.inputEl.setAttr("aria-expanded", "false");
		this.options.registerVaultEvent(this.app.vault.on("create", () => this.invalidateFiles()));
		this.options.registerVaultEvent(this.app.vault.on("delete", () => this.invalidateFiles()));
		this.options.registerVaultEvent(this.app.vault.on("rename", () => this.invalidateFiles()));
	}

	destroy(): void {
		this.clearTouchClickGuard?.();
		this.close();
		this.filesSnapshot = null;
		this.computedQuery = null;
		this.computedSuggestions = [];
		this.inputEl.removeAttribute("aria-autocomplete");
		this.inputEl.removeAttribute("aria-haspopup");
		this.inputEl.removeAttribute("aria-controls");
		this.inputEl.removeAttribute("aria-expanded");
	}

	close(): void {
		this.dismissed = this.inputEl.composer.capture();
		this.clearReposition();
		this.clearGesture?.();
		this.clearGesture = null;
		this.releaseGlassSurface?.();
		this.releaseGlassSurface = null;
		this.popoverEl?.detach();
		this.popoverEl = null;
		this.listEl = null;
		this.renderedQuery = null;
		this.suggestions = [];
		this.selectedIndex = 0;
		this.inputEl.setAttr("aria-expanded", "false");
		this.inputEl.removeAttribute("aria-activedescendant");
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
		this.close();
	}

	handleCompositionReset(): void {
		this.clearTouchClickGuard?.();
		this.composing = false;
		this.close();
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
		if (this.listEl === null || event.isComposing || this.composing || this.inputEl.composer.composing) {
			return false;
		}
		const nextIndex = getSuggestionNavigationIndex(event, this.selectedIndex, this.listEl);
		if ((event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) && nextIndex === null) return false;
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
		if (nextIndex !== null) {
			event.preventDefault();
			event.stopPropagation();
			event.stopImmediatePropagation();
			this.setSelectedIndex(nextIndex, true);
			return true;
		}
		if (event.key === "Enter" || event.key === "Tab") {
			event.preventDefault();
			event.stopPropagation();
			event.stopImmediatePropagation();
			this.selectSuggestion(this.selectedIndex, event.key === "Tab");
			return true;
		}
		return false;
	}

	openForCurrentRange(): void {
		this.dismissed = null;
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
		if (this.inputEl.composer.readOnly || this.composing || this.inputEl.composer.composing) { this.close(); return; }
		const current = this.inputEl.composer.capture();
		if (this.dismissed?.valid() && this.dismissed.anchor === current.anchor && this.dismissed.head === current.head) return;
		this.dismissed = null;
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

	getPopoverForTest(): HTMLElement | null {
		return this.popoverEl;
	}

	private refreshSuggestions(query: string): void {
		if (query !== this.computedQuery || this.filesSnapshot === null) {
			this.computedSuggestions = getWikiLinkFileSuggestions(this.getFilesSnapshot(), query, WIKI_LINK_SUGGESTION_LIMIT);
			this.computedQuery = query;
		}
		const suggestions = this.computedSuggestions;
		if (query === this.renderedQuery && suggestions.length === this.suggestions.length
			&& suggestions.every((suggestion, index) => suggestion.path === this.suggestions[index].path)) {
			this.suggestions = suggestions;
			this.queueReposition();
			return;
		}
		this.suggestions = suggestions;
		this.renderedQuery = query;
		this.selectedIndex = 0;
		if (this.suggestions.length === 0) {
			this.close();
			return;
		}
		this.renderSuggestions();
	}

	private renderSuggestions(): void {
		const list = this.listEl;
		if (list === null) {
			return;
		}
		list.empty();
		for (const [index, suggestion] of this.suggestions.entries()) {
			const optionId = this.getOptionId(index);
			const item = list.createDiv({
				cls: "suggestion-item mod-complex knomo-link-suggest-item",
				attr: {
					id: optionId,
					role: "option",
					tabindex: "-1",
					"aria-selected": index === this.selectedIndex ? "true" : "false",
					"data-action": String(index),
				},
			});
			const selected = index === this.selectedIndex;
			item.toggleClass("is-selected", selected);
			const content = item.createDiv({ cls: "suggestion-content" });
			content.createDiv({ cls: "suggestion-title knomo-link-suggest-title", text: suggestion.basename });
			if (suggestion.showPath) {
				content.createDiv({ cls: "suggestion-note knomo-link-suggest-path", text: suggestion.path });
			}
			item.addEventListener("pointermove", event => {
				if (event.pointerType === "mouse") this.setSelectedIndex(index, false);
			});
		}
		this.inputEl.setAttr("aria-expanded", "true");
		this.inputEl.setAttr("aria-activedescendant", this.getOptionId(this.selectedIndex));
		list.scrollTop = 0;
		this.queueReposition();
	}

	private setSelectedIndex(index: number, scroll: boolean): void {
		if (!this.listEl) return;
		this.selectedIndex = index;
		Array.from(this.listEl.children).forEach((child, childIndex) => {
			child.classList.toggle("is-selected", childIndex === index);
			child.setAttribute("aria-selected", String(childIndex === index));
		});
		this.inputEl.setAttr("aria-activedescendant", this.getOptionId(index));
		const selected = this.listEl.children[index] as HTMLElement | undefined;
		if (scroll && selected) scrollSuggestionIntoView(this.listEl, selected);
	}

	private selectSuggestion(index: number, completing = false): void {
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
		const patch = replaceWikiLinkRangeWithLinktext(this.inputEl.value, range, linktext);
		if (completing) patch.cursor -= 2;
		if (!this.applyPatch(patch)) return;
		if (completing) this.refreshForCursor();
		else this.close();
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

	private applyPatch(patch: TextReplacement): boolean {
		if (this.inputEl.composer.readOnly || this.inputEl.composer.composing || this.composing) return false;
		// Tab 后 Enter 可能只移动光标，不应因正文未变而跳过选区更新或增加撤销记录。
		if (this.inputEl.value === patch.value) this.inputEl.setSelectionRange(patch.cursor, patch.cursor);
		else if (!applyComposerEdit(this.inputEl, patch.value, patch.cursor)) return false;
		this.focusInput();
		this.options.onInputChanged();
		return true;
	}

	private focusInput(): void {
		try {
			this.inputEl.focus({ preventScroll: true });
		} catch {
			this.inputEl.focus();
		}
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
		this.computedQuery = null;
		this.computedSuggestions = [];
		if (this.popoverEl !== null) {
			this.refreshForCursor();
		}
	}

	private ensurePopover(): void {
		this.inputEl.setAttr("aria-controls", this.options.listboxId);
		if (this.popoverEl !== null) {
			return;
		}
		const mobile = this.inputEl.closest(".knomo-mobile-composer-layer") !== null;
		const popover = this.inputEl.ownerDocument.body.createDiv({
			cls: `suggestion-container knomo-link-suggest-popover knomo-link-suggest-positioning knomo-native-suggest${mobile ? " knomo-suggest-mobile" : ""}`,
			attr: {
				id: this.options.listboxId,
				role: "listbox",
			},
		});
		popover.setCssProps({ "--knomo-suggest-z-index": WIKI_LINK_POPOVER_Z_INDEX });
		this.popoverEl = popover;
		const list = this.listEl = popover.createDiv({ cls: "suggestion knomo-suggest-list" });
		this.clearGesture = registerComposerToolGesture(popover, (action, event) => {
			if (this.inputEl.composer.readOnly || this.inputEl.composer.composing) return;
			if (event.type === "pointerup" || event.type === "touchend") {
				event.stopImmediatePropagation();
				this.clearTouchClickGuard?.();
				this.clearTouchClickGuard = guardSuggestionTouchClickThrough(event, popover, () => { this.clearTouchClickGuard = null; });
			}
			this.selectSuggestion(Number(action));
		}, mobile ? {
			scrollElement: list,
			capture: () => {
				const context = this.inputEl.composer.capture();
				return () => this.popoverEl === popover && context.valid()
					&& this.inputEl.selectionStart === context.anchor && this.inputEl.selectionEnd === context.head
					&& !this.inputEl.composer.readOnly && !this.inputEl.composer.composing;
			},
		} : undefined);
		this.releaseGlassSurface = this.options.registerGlassSurface?.(popover) ?? null;
	}

	private getOptionId(index: number): string {
		return `${this.options.listboxId}-option-${index}`;
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
		popover.setCssProps(popoverCssProps);
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
		const position = getDesktopSuggestionPosition(anchor,
			measureSuggestionContentHeight(this.inputEl, popover, ".knomo-link-suggest-item"), viewportTop, viewportBottom);
		popover.setCssProps({
			...popoverCssProps,
			"--knomo-suggest-top": `${Math.round(position.top)}px`,
			"--knomo-suggest-max-height": `${Math.round(position.maxHeight)}px`,
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

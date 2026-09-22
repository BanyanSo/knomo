import { normalizeComposerToolbar, type ComposerToolbarPreferences } from "../settings/composerToolbar";
import { isCjkMemoContent } from "./KnomoCardMetadata";
import { setIcon } from "obsidian";

import { KNOMO_TIME_BUOY_ICON } from "../icons";
import { t } from "../i18n";
import { ComposerEditor, type ComposerInput } from "./ComposerEditor";

export interface KnomoComposerElements {
	composerEl: HTMLElement;
	inputEl: ComposerInput;
	referencePreviewEl: HTMLElement;
	composerBarEl: HTMLElement;
	toolsEl: HTMLElement;
	timeBuoyButtonEl: HTMLButtonElement | null;
	timeBuoyMonthStatusEl: HTMLElement | null;
	cancelEditButtonEl: HTMLButtonElement;
	statusEl: HTMLElement;
	imageStatusEl: HTMLElement;
	cancelImagesButtonEl: HTMLButtonElement;
	sendButtonEl: HTMLButtonElement;
}

interface RenderKnomoComposerOptions {
	createEditor?: (parent: HTMLElement, doc: string, label: string, hint: string) => ComposerInput;
	dailyEnabled: boolean;
	toolbar?: ComposerToolbarPreferences;
	timeBuoyEnabled?: boolean;
	timeBuoyPickerId?: string;
	draftContent: string;
	createHiddenText: (container: HTMLElement, name: string, text: string) => string;
	createIconButton: (
		container: HTMLElement,
		icon: string,
		ariaLabel: string,
		cls: string,
		action: string,
		showTooltip?: boolean,
	) => HTMLButtonElement;
}

interface RenderReferencePreviewOptions {
	setTooltipIfDesktopOnly: (element: HTMLElement) => void;
}

export function renderKnomoComposer(container: HTMLElement, options: RenderKnomoComposerOptions): KnomoComposerElements {
	const composerEl = container.createDiv({ cls: "knomo-composer" });
	const inputArea = composerEl.createDiv({ cls: "knomo-composer-input-area" });
	const composerInputLabelId = options.createHiddenText(inputArea, "composer-input-label", t("composer.inputLabel"));
	const inputEl = options.createEditor?.(inputArea, options.draftContent, composerInputLabelId, t("composer.placeholder"))
		?? new ComposerEditor(inputArea, options.draftContent, composerInputLabelId, t("composer.placeholder")).input;
	inputEl.disabled = !options.dailyEnabled;

	const referencePreviewEl = inputArea.createDiv({ cls: "knomo-reference-preview" });
	const composerBarEl = inputArea.createDiv({ cls: "knomo-composer-bar" });
	const toolsEl = composerBarEl.createDiv({ cls: "knomo-tool-group" });
	options.createIconButton(toolsEl, "hash", t("composer.insertTag"), "knomo-tool-button", "insert-tag", false);
	options.createIconButton(toolsEl, "image", t("composer.insertImage"), "knomo-tool-button", "insert-image", false);
	const timeBuoyButtonEl = options.timeBuoyEnabled === true
		? options.createIconButton(toolsEl, KNOMO_TIME_BUOY_ICON, t("composer.addTimeBuoy"), "knomo-tool-button", "insert-time-buoy", true)
		: null;
	if (timeBuoyButtonEl !== null) {
		timeBuoyButtonEl.disabled = !options.dailyEnabled;
		timeBuoyButtonEl.setAttrs({
			"aria-haspopup": "dialog",
			"aria-expanded": "false",
			"aria-controls": options.timeBuoyPickerId ?? "knomo-time-buoy-picker",
		});
	}
	const timeBuoyMonthStatusEl = options.timeBuoyEnabled === true
		? composerEl.createDiv({
			cls: "knomo-visually-hidden",
			attr: {
				role: "status",
				"aria-live": "polite",
				"aria-atomic": "true",
			},
		})
		: null;
	options.createIconButton(toolsEl, "list-todo", t("composer.insertTask"), "knomo-tool-button", "insert-task", false);
	options.createIconButton(toolsEl, "bold", t("composer.insertBold"), "knomo-tool-button", "insert-bold", false);
	options.createIconButton(toolsEl, "highlighter", t("composer.insertHighlight"), "knomo-tool-button", "insert-highlight", false);
	options.createIconButton(toolsEl, "brackets", t("composer.insertLink"), "knomo-tool-button", "insert-link", false);
	options.createIconButton(toolsEl, "list", t("composer.insertList"), "knomo-tool-button", "insert-list", false);
	options.createIconButton(toolsEl, "list-ordered", t("composer.insertNumberedList"), "knomo-tool-button", "insert-numbered-list", false);

	updateComposerToolbar(toolsEl, normalizeComposerToolbar(options.toolbar));
	const actions = composerBarEl.createDiv({ cls: "knomo-composer-actions" });
	const cancelEditButtonEl = actions.createEl("button", {
		cls: "knomo-cancel-edit-button",
		text: t("composer.cancelEdit"),
		attr: {
			type: "button",
			"data-action": "cancel-edit",
			hidden: "",
		},
	});
	const statusEl = composerEl.createDiv({
		cls: options.dailyEnabled ? "knomo-status" : "knomo-status is-error",
	});
	const imageStatusEl = composerEl.createDiv({ cls: "knomo-image-status", attr: { hidden: "", role: "status", "aria-live": "polite" } });
	imageStatusEl.createSpan({ text: t("composer.imagesPending") });
	const cancelImagesButtonEl = imageStatusEl.createEl("button", { text: t("composer.cancelImages"), attr: { type: "button" } });
	const sendButtonEl = actions.createEl("button", {
		cls: "knomo-send-button",
		attr: {
			type: "button",
			"aria-label": t("composer.send"),
			"data-action": "save-input",
		},
	});
	setIcon(sendButtonEl, "send");

	return {
		composerEl,
		inputEl,
		referencePreviewEl,
		composerBarEl,
		toolsEl,
		timeBuoyButtonEl,
		timeBuoyMonthStatusEl,
		cancelEditButtonEl,
		statusEl,
		imageStatusEl,
		cancelImagesButtonEl,
		sendButtonEl,
	};
}

export function renderComposerReferencePreview(
	container: HTMLElement,
	quoteMarkdownText: string | null,
	options: RenderReferencePreviewOptions,
): void {
	if (quoteMarkdownText === null) {
		container.empty();
		container.removeClass("is-visible");
		return;
	}
	container.empty();
	const previewText = container.createDiv({
		cls: "knomo-reference-preview-text",
	});
	previewText.createSpan({ cls: "knomo-reference-label", text: t("reference.label") });
	previewText.createSpan({
		cls: "knomo-reference-content",
		text: quoteMarkdownText.replace(/^> ?/gm, ""),
	});
	const clearButton = container.createEl("button", {
		cls: "knomo-reference-clear",
		attr: {
			type: "button",
			"aria-label": t("reference.clear"),
			"data-action": "clear-reference",
		},
	});
	options.setTooltipIfDesktopOnly(clearButton);
	setIcon(clearButton, "x");
	container.addClass("is-visible");
	container.toggleClass("is-cjk-content", isCjkMemoContent(quoteMarkdownText));
}

export const composerActionLabels = {
	tag: "composer.insertTag", image: "composer.insertImage", "time-buoy": "composer.addTimeBuoy",
	task: "composer.insertTask", list: "composer.insertList", bold: "composer.insertBold",
	highlight: "composer.insertHighlight", link: "composer.insertLink", "numbered-list": "composer.insertNumberedList",
} as const;

export function updateComposerToolbar(tools: HTMLElement, preferences: ComposerToolbarPreferences): void {
	for (const action of preferences.order) {
		const button = tools.querySelector<HTMLElement>('[data-action="insert-' + action + '"]');
		if (!button) continue;
		button.hidden = preferences.hidden.includes(action);
		tools.appendChild(button);
	}
	tools.hidden = !Array.from(tools.children).some(button => !(button as HTMLElement).hidden);
}

import { setIcon } from "obsidian";

import { t } from "../i18n";

export interface KnomoComposerElements {
	composerEl: HTMLElement;
	inputEl: HTMLTextAreaElement;
	referencePreviewEl: HTMLElement;
	composerBarEl: HTMLElement;
	toolsEl: HTMLElement;
	cancelEditButtonEl: HTMLButtonElement;
	statusEl: HTMLElement;
	sendButtonEl: HTMLButtonElement;
}

interface RenderKnomoComposerOptions {
	dailyEnabled: boolean;
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
	const inputEl = inputArea.createEl("textarea", {
		cls: "knomo-composer-input",
		attr: {
			placeholder: t("composer.placeholder"),
			"aria-labelledby": composerInputLabelId,
		},
	});
	inputEl.disabled = !options.dailyEnabled;
	inputEl.value = options.draftContent;

	const referencePreviewEl = inputArea.createDiv({ cls: "knomo-reference-preview" });
	const composerBarEl = inputArea.createDiv({ cls: "knomo-composer-bar" });
	const toolsEl = composerBarEl.createDiv({ cls: "knomo-tool-group" });
	options.createIconButton(toolsEl, "hash", t("composer.insertTag"), "knomo-tool-button", "insert-tag", false);
	options.createIconButton(toolsEl, "image", t("composer.insertImage"), "knomo-tool-button", "insert-image", false);
	options.createIconButton(toolsEl, "list", t("composer.insertList"), "knomo-tool-button", "insert-list", false);
	options.createIconButton(toolsEl, "list-ordered", t("composer.insertNumberedList"), "knomo-tool-button", "insert-numbered-list", false);

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
		cancelEditButtonEl,
		statusEl,
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
		container.style.display = "none";
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
	container.style.display = "flex";
}

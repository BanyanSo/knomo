const OBSIDIAN_MODAL_CLOSE_BUTTON_SELECTORS = [
	":scope > .modal-close-button",
	":scope > .modal-header-button",
] as const;

export function removeObsidianModalCloseButtons(modalEl: HTMLElement): void {
	for (const selector of OBSIDIAN_MODAL_CLOSE_BUTTON_SELECTORS) {
		modalEl.querySelector(selector)?.remove();
	}
}


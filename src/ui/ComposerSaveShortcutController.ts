interface ComposerSaveShortcutRequest {
	inputEl: HTMLTextAreaElement | null;
	activeElement: Element | null;
	isSaving: boolean;
	saveInput: () => void;
}

export class ComposerSaveShortcutController {
	private shortcutDown = false;

	handleKeydown(event: KeyboardEvent, request: ComposerSaveShortcutRequest): boolean {
		if (request.inputEl === null || !isComposerSaveShortcut(event)) {
			return false;
		}
		const isComposerEvent = event.target === request.inputEl || request.activeElement === request.inputEl;
		if (!isComposerEvent) {
			return false;
		}
		event.preventDefault();
		event.stopPropagation();
		event.stopImmediatePropagation();
		if (this.shortcutDown || request.isSaving) {
			return true;
		}
		this.shortcutDown = true;
		request.saveInput();
		return true;
	}

	handleKeyup(event: KeyboardEvent): void {
		if (!this.shortcutDown) {
			return;
		}
		if (isComposerSaveShortcutRelease(event)) {
			this.shortcutDown = false;
		}
	}

	reset(): void {
		this.shortcutDown = false;
	}
}

export function isComposerSaveShortcut(event: KeyboardEvent): boolean {
	const isMod = event.metaKey || event.ctrlKey;
	if (!isMod) {
		return false;
	}
	return isComposerEnterKey(event);
}

function isComposerSaveShortcutRelease(event: KeyboardEvent): boolean {
	return isComposerEnterKey(event) || (!event.metaKey && !event.ctrlKey);
}

function isComposerEnterKey(event: KeyboardEvent): boolean {
	return event.key === "Enter" || event.code === "Enter" || event.code === "NumpadEnter";
}

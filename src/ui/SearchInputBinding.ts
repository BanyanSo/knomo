import type { SearchSession } from "./SearchSession";

interface SearchInputBindingOptions {
	input: HTMLInputElement;
	session: SearchSession;
	registerDomEvent: <K extends keyof HTMLElementEventMap>(target: HTMLElement, type: K, listener: (event: HTMLElementEventMap[K]) => void) => void;
	onDraftChanged: () => void;
	onQueue: () => void;
	onClose: () => void;
	onCompositionChanged?: (composing: boolean) => void;
}

export function bindSearchInput(options: SearchInputBindingOptions): void {
	const { input, session } = options;
	const readDraft = () => {
		const changed = session.updateDraft(input.value, input.selectionStart ?? input.value.length, input.selectionEnd ?? input.value.length);
		if (changed) options.onDraftChanged();
		return changed;
	};
	options.registerDomEvent(input, "compositionstart", () => {
		session.beginComposition();
		options.onCompositionChanged?.(true);
		options.onDraftChanged();
	});
	options.registerDomEvent(input, "compositionend", () => {
		session.endComposition(input.value, input.selectionStart ?? input.value.length, input.selectionEnd ?? input.value.length);
		options.onDraftChanged();
		options.onQueue();
		options.onCompositionChanged?.(false);
	});
	options.registerDomEvent(input, "input", event => {
		if (session.draft.composing || ("isComposing" in event && event.isComposing === true)) {
			readDraft();
			return;
		}
		if (readDraft()) options.onQueue();
	});
	options.registerDomEvent(input, "keydown", event => {
		if (event.key !== "Enter" && event.key !== "Escape") return;
		if (session.draft.composing || event.isComposing || event.keyCode === 229) {
			event.stopPropagation();
			return;
		}
		// 普通 Enter 沿用输入防抖，不新增立即提交流程。
		if (event.key === "Enter") return;
		event.preventDefault();
		event.stopPropagation();
		readDraft();
		options.onClose();
	});
}

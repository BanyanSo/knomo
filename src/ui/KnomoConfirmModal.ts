import { Modal } from "obsidian";
import type { App } from "obsidian";

import { t } from "../i18n";
import { removeObsidianModalCloseButtons } from "./ObsidianModalCloseButton";

type ScheduleAnimationFrame = (callback: FrameRequestCallback) => number;

export interface KnomoConfirmModalOptions {
	message: string;
	title?: string;
	confirmLabel?: string;
	cancelLabel?: string;
	danger?: boolean;
	getReturnFocus?: (confirmed: boolean, previousFocus: HTMLElement | null) => HTMLElement | null;
}

export class KnomoConfirmModal extends Modal {
	private readonly previousFocusEl: HTMLElement | null;
	private result = false;
	private resolved = false;
	private initialFocusFrameId: number | null = null;

	constructor(
		app: App,
		private readonly options: KnomoConfirmModalOptions,
		private readonly resolveResult: (confirmed: boolean) => void,
	) {
		super(app);
		const activeElement = this.containerEl.doc.activeElement;
		this.previousFocusEl = activeElement !== null && activeElement.instanceOf(HTMLElement)
			? activeElement
			: null;
	}

	onOpen(): void {
		this.modalEl.addClass("knomo-confirm-modal");
		removeObsidianModalCloseButtons(this.modalEl);
		this.titleEl.setText(this.options.title ?? t("confirm.title"));
		this.contentEl.empty();

		this.contentEl.createDiv({
			cls: "knomo-confirm-message",
			text: this.options.message,
		});
		const actions = this.contentEl.createDiv({
			cls: "modal-button-container knomo-confirm-actions",
		});
		const cancelButton = actions.createEl("button", {
			cls: "knomo-confirm-button",
			text: this.options.cancelLabel ?? t("confirm.cancel"),
			attr: { type: "button" },
		});
		const confirmButton = actions.createEl("button", {
			cls: this.options.danger === true
				? "knomo-confirm-button mod-warning"
				: "knomo-confirm-button mod-cta",
			text: this.options.confirmLabel ?? t("confirm.confirm"),
			attr: { type: "button" },
		});

		cancelButton.addEventListener("click", this.handleCancelClick);
		confirmButton.addEventListener("click", this.handleConfirmClick);
		this.initialFocusFrameId = scheduleKnomoConfirmFocus(
			cancelButton,
			(callback) => this.containerEl.win.requestAnimationFrame(callback),
		);
	}

	onClose(): void {
		if (this.initialFocusFrameId !== null) {
			this.containerEl.win.cancelAnimationFrame(this.initialFocusFrameId);
			this.initialFocusFrameId = null;
		}
		this.contentEl.empty();

		const focusTarget = this.options.getReturnFocus === undefined
			? this.previousFocusEl
			: this.options.getReturnFocus(this.result, this.previousFocusEl);
		scheduleKnomoConfirmFocus(
			focusTarget,
			(callback) => this.containerEl.win.requestAnimationFrame(callback),
		);
		if (!this.resolved) {
			this.resolved = true;
			this.resolveResult(this.result);
		}
	}

	private finish(result: boolean): void {
		if (this.resolved) {
			return;
		}
		this.result = result;
		this.close();
	}

	private readonly handleCancelClick = (): void => {
		this.finish(false);
	};

	private readonly handleConfirmClick = (): void => {
		this.finish(true);
	};
}

export function showKnomoConfirmModal(app: App, options: KnomoConfirmModalOptions): Promise<boolean> {
	return new Promise<boolean>((resolve) => {
		new KnomoConfirmModal(app, options, resolve).open();
	});
}

export function getDestructiveConfirmReturnFocus(
	confirmed: boolean,
	previousFocus: HTMLElement | null,
): HTMLElement | null {
	return confirmed ? null : previousFocus;
}

export function scheduleKnomoConfirmFocus(
	target: HTMLElement | null,
	scheduleAnimationFrame: ScheduleAnimationFrame,
): number | null {
	if (target === null) {
		return null;
	}
	return scheduleAnimationFrame(() => {
		if (!target.isConnected) {
			return;
		}
		try {
			target.focus({ preventScroll: true });
		} catch {
			target.focus();
		}
	});
}

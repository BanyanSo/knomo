interface MobileHandledToolPointerOptions {
	scheduleClear: (callback: () => void, delayMs: number) => number;
	cancelClear: (taskId: number) => void;
	clearDelayMs?: number;
}

interface HandledMobileToolPointer {
	button: HTMLElement;
	action: string;
}

export class MobileHandledToolPointer {
	private handled: HandledMobileToolPointer | null = null;
	private clearTaskId: number | null = null;
	private readonly clearDelayMs: number;

	constructor(private readonly options: MobileHandledToolPointerOptions) {
		this.clearDelayMs = options.clearDelayMs ?? 350;
	}

	mark(button: HTMLElement, action: string): void {
		this.clear();
		this.handled = { button, action };
		this.clearTaskId = this.options.scheduleClear(() => {
			this.handled = null;
			this.clearTaskId = null;
		}, this.clearDelayMs);
	}

	isHandled(button: HTMLElement, action: string): boolean {
		const handled = this.handled;
		return handled !== null && handled.button === button && handled.action === action;
	}

	shouldIgnoreClick(button: HTMLElement, action: string | null, isMobileLayout: boolean): boolean {
		if (!isMobileLayout || action === null || this.handled === null) {
			return false;
		}
		const shouldIgnore = this.isHandled(button, action);
		if (shouldIgnore) {
			this.clear();
		}
		return shouldIgnore;
	}

	clear(): void {
		this.handled = null;
		if (this.clearTaskId !== null) {
			this.options.cancelClear(this.clearTaskId);
			this.clearTaskId = null;
		}
	}
}

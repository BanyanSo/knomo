interface MobileImagePickerFocusGuardOptions {
	scheduleRestore: (callback: () => void, delayMs: number) => number;
	cancelRestore: (taskId: number) => void;
	restoreDelayMs?: number;
}

export class MobileImagePickerFocusGuard {
	private active = false;
	private restoreTaskId: number | null = null;
	private readonly restoreDelayMs: number;

	constructor(private readonly options: MobileImagePickerFocusGuardOptions) {
		this.restoreDelayMs = options.restoreDelayMs ?? 50;
	}

	begin(canBegin: boolean): boolean {
		this.clear();
		if (!canBegin) {
			return false;
		}
		this.active = true;
		return true;
	}

	shouldIgnoreBlur(isMobileLayout: boolean): boolean {
		return isMobileLayout && this.active;
	}

	finish(shouldRestoreFocus: boolean, canRestoreFocus: () => boolean, restoreFocus: () => void): void {
		this.active = false;
		this.clearRestoreTask();
		if (!shouldRestoreFocus || !canRestoreFocus()) {
			return;
		}
		this.restoreTaskId = this.options.scheduleRestore(() => {
			this.restoreTaskId = null;
			if (canRestoreFocus()) {
				restoreFocus();
			}
		}, this.restoreDelayMs);
	}

	clear(): void {
		this.active = false;
		this.clearRestoreTask();
	}

	private clearRestoreTask(): void {
		if (this.restoreTaskId === null) {
			return;
		}
		this.options.cancelRestore(this.restoreTaskId);
		this.restoreTaskId = null;
	}
}

import type { TextReplacement } from "../utils/composerInput";

interface ComposerListEnterStateOptions {
	scheduleTask: (callback: () => void, delayMs: number) => number;
	cancelTask: (taskId: number) => void;
}

export interface PendingListEnterCorrection {
	patch: TextReplacement;
	nativeValue: string;
}

export class ComposerListEnterState {
	private pendingCorrection: PendingListEnterCorrection | null = null;
	private keydownPatch: TextReplacement | null = null;
	private keydownPatchTaskId: number | null = null;
	private skipInputFallback = false;
	private skipInputFallbackTaskId: number | null = null;

	constructor(private readonly options: ComposerListEnterStateOptions) {}

	consumePendingCorrection(currentValue: string | null): TextReplacement | null {
		const pending = this.pendingCorrection;
		if (pending === null) {
			return null;
		}
		this.pendingCorrection = null;
		return currentValue === pending.nativeValue ? pending.patch : null;
	}

	setPendingCorrection(correction: PendingListEnterCorrection | null): void {
		this.pendingCorrection = correction;
	}

	getKeydownPatch(): TextReplacement | null {
		return this.keydownPatch;
	}

	markKeydownPatch(patch: TextReplacement): void {
		this.clearKeydownPatch();
		this.keydownPatch = patch;
		this.keydownPatchTaskId = this.options.scheduleTask(() => {
			this.keydownPatch = null;
			this.keydownPatchTaskId = null;
		}, 0);
	}

	clearKeydownPatch(): void {
		this.keydownPatch = null;
		if (this.keydownPatchTaskId !== null) {
			this.options.cancelTask(this.keydownPatchTaskId);
			this.keydownPatchTaskId = null;
		}
	}

	shouldSkipInputFallback(): boolean {
		return this.skipInputFallback;
	}

	markSkipInputFallback(): void {
		this.clearSkipInputFallback();
		this.skipInputFallback = true;
		this.skipInputFallbackTaskId = this.options.scheduleTask(() => {
			this.skipInputFallback = false;
			this.skipInputFallbackTaskId = null;
		}, 0);
	}

	clearSkipInputFallback(): void {
		this.skipInputFallback = false;
		if (this.skipInputFallbackTaskId !== null) {
			this.options.cancelTask(this.skipInputFallbackTaskId);
			this.skipInputFallbackTaskId = null;
		}
	}

	clear(): void {
		this.pendingCorrection = null;
		this.clearKeydownPatch();
		this.clearSkipInputFallback();
	}
}

interface MobileSendPointerGuardOptions {
	getNow: () => number;
	ignoreClickDelayMs?: number;
}

export class MobileSendPointerGuard {
	private lastPointerAt: number | null = null;
	private readonly ignoreClickDelayMs: number;

	constructor(private readonly options: MobileSendPointerGuardOptions) {
		this.ignoreClickDelayMs = options.ignoreClickDelayMs ?? 700;
	}

	markPointer(): void {
		this.lastPointerAt = this.options.getNow();
	}

	shouldIgnoreClick(isMobileLayout: boolean): boolean {
		return isMobileLayout &&
			this.lastPointerAt !== null &&
			this.options.getNow() - this.lastPointerAt < this.ignoreClickDelayMs;
	}
}

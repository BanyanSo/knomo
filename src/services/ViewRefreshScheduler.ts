export interface RefreshSchedulerWindow {
	setTimeout(callback: () => void, delay: number): number;
	clearTimeout(timerId: number): void;
}

// 职责：合并自动视图刷新请求，并避免并发刷新同一批 Knomo 视图。
export class ViewRefreshScheduler {
	private timerId: number | null = null;
	private queuedPromise: Promise<void> | null = null;
	private queuedResolve: (() => void) | null = null;
	private queuedReject: ((error: unknown) => void) | null = null;
	private runningPromise: Promise<void> | null = null;

	constructor(
		private readonly getWindow: () => RefreshSchedulerWindow,
		private readonly refresh: () => Promise<void>,
		private readonly debounceMs: number,
	) {}

	queue(): Promise<void> {
		if (this.queuedPromise === null) {
			this.queuedPromise = new Promise<void>((resolve, reject) => {
				this.queuedResolve = resolve;
				this.queuedReject = reject;
			});
		}
		if (this.timerId !== null) {
			this.getWindow().clearTimeout(this.timerId);
		}

		const queuedPromise = this.queuedPromise;
		this.timerId = this.getWindow().setTimeout(() => {
			if (this.queuedPromise !== queuedPromise) {
				return;
			}
			this.timerId = null;
			void this.flushQueued(queuedPromise);
		}, this.debounceMs);
		return queuedPromise;
	}

	clear(): void {
		this.clearTimer();
		this.queuedResolve?.();
		this.clearQueuedPromise();
	}

	private async flushQueued(queuedPromise: Promise<void>): Promise<void> {
		if (this.runningPromise !== null) {
			try {
				await this.runningPromise;
			} catch {
				// 自动刷新仍应在上一次刷新失败后继续尝试。
			}
			if (this.queuedPromise !== queuedPromise || this.timerId !== null) {
				return;
			}
		}
		if (this.queuedPromise !== queuedPromise) {
			return;
		}
		const queuedResolve = this.queuedResolve;
		const queuedReject = this.queuedReject;
		this.clearQueuedPromise();
		try {
			await this.startRefresh();
			queuedResolve?.();
		} catch (error) {
			queuedReject?.(error);
		}
	}

	private startRefresh(): Promise<void> {
		if (this.runningPromise !== null) {
			return this.runningPromise;
		}
		this.runningPromise = Promise.resolve()
			.then(() => this.refresh())
			.finally(() => {
				this.runningPromise = null;
			});
		return this.runningPromise;
	}

	private clearTimer(): void {
		if (this.timerId === null) {
			return;
		}
		this.getWindow().clearTimeout(this.timerId);
		this.timerId = null;
	}

	private clearQueuedPromise(): void {
		this.queuedPromise = null;
		this.queuedResolve = null;
		this.queuedReject = null;
	}
}

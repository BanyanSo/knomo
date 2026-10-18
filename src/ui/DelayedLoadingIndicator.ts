interface LoadingIndicatorRuntime {
	scheduleTask: (callback: () => void, delayMs: number) => number;
	cancelTask: (taskId: number) => void;
}

// 只延迟反馈，不延迟数据提交；同一范围的重绘共享等待起点。
export class DelayedLoadingIndicator {
	private key: string | null = null;
	private taskId: number | null = null;
	private generation = 0;
	private revealed = false;
	private onReveal: (() => void) | null = null;

	constructor(private readonly runtime: LoadingIndicatorRuntime) {}

	pending(key: string, onReveal: () => void): boolean {
		this.onReveal = onReveal;
		if (this.key === key) return this.revealed;
		this.clear();
		this.key = key;
		this.onReveal = onReveal;
		const generation = this.generation;
		this.taskId = this.runtime.scheduleTask(() => {
			if (this.generation !== generation || this.key !== key) return;
			this.taskId = null;
			this.revealed = true;
			this.onReveal?.();
		}, 250);
		return false;
	}

	clear(): void {
		if (this.taskId !== null) this.runtime.cancelTask(this.taskId);
		this.taskId = null;
		this.key = null;
		this.revealed = false;
		this.onReveal = null;
		this.generation++;
	}
}

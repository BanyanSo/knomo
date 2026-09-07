export interface KnomoAutomaticRecoveryOptions {
	recover: () => Promise<void>;
	isRecovered: () => boolean;
	signal: AbortSignal;
	retryDelays?: readonly number[];
}

// 自动恢复合并并发请求；重试耗尽后由调用方呈现可操作的最终状态。
export class KnomoAutomaticRecovery {
	private operation: Promise<void> | null = null;

	constructor(private readonly options: KnomoAutomaticRecoveryOptions) {}

	isRunning(): boolean { return this.operation !== null; }

	run(): Promise<void> {
		if (this.operation !== null) return this.operation;
		const operation = this.runOnce().finally(() => {
			if (this.operation === operation) this.operation = null;
		});
		this.operation = operation;
		return operation;
	}

	private async runOnce(): Promise<void> {
		const delays = [0, ...(this.options.retryDelays ?? [250, 1000])];
		let lastError: unknown;
		for (const delay of delays) {
			if (this.options.signal.aborted) return;
			if (delay > 0) await this.wait(delay);
			if (this.options.signal.aborted) return;
			try {
				await this.options.recover();
				lastError = undefined;
			} catch (error) { lastError = error; }
			if (this.options.isRecovered()) return;
		}
		if (lastError !== undefined) throw lastError;
	}

	private wait(delay: number): Promise<void> {
		return new Promise((resolve) => {
			const finish = () => {
				clearTimeout(timer);
				this.options.signal.removeEventListener("abort", finish);
				resolve();
			};
			const timer = setTimeout(finish, delay);
			this.options.signal.addEventListener("abort", finish, { once: true });
			if (this.options.signal.aborted) finish();
		});
	}
}

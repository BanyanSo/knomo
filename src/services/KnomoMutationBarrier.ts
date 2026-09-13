/** 重建先阻止新的用户写入，再等待已经开始的完整 Daily 操作结束。 */
export class KnomoMutationBarrier {
	private paused = false;
	private readonly active = new Set<Promise<unknown>>();
	wrap<Args extends unknown[], Result>(action: (...args: Args) => Promise<Result>): (...args: Args) => Promise<Result> {
		return (...args) => {
			if (this.paused) return Promise.reject(new Error("Knomo basic data is being rebuilt. Please retry after recovery."));
			const operation = Promise.resolve().then(() => action(...args));
			this.active.add(operation);
			void operation.finally(() => this.active.delete(operation)).catch(() => undefined);
			return operation;
		};
	}
	async runPaused<T>(action: () => Promise<T>): Promise<T> {
		if (this.paused) throw new Error("Knomo recovery is already running.");
		this.paused = true;
		try {
			await Promise.all([...this.active].map((operation) => operation.then(() => undefined, () => undefined)));
			return await action();
		} finally { this.paused = false; }
	}
}

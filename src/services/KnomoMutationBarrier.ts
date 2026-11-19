/** 重建先阻止新的用户写入，再等待已经开始的完整 Daily 操作结束。 */
export class KnomoMutationBarrier {
	private paused = false;
	private readonly active = new Set<Promise<void>>();
	wrap<Args extends unknown[], Result>(action: (...args: Args) => Promise<Result>): (...args: Args) => Promise<Result> {
		return (...args) => this.run(() => Promise.resolve().then(() => action(...args)));
	}
	async run<T>(action: () => Promise<T>): Promise<T> {
		if (this.paused) throw new Error("Knomo basic data is being rebuilt. Please retry after recovery.");
		let finish!: () => void;
		const completion = new Promise<void>(resolve => { finish = resolve; });
		this.active.add(completion);
		try { return await action(); }
		finally { this.active.delete(completion); finish(); }
	}
	async runPaused<T>(action: () => Promise<T>): Promise<T> {
		if (this.paused) throw new Error("Knomo recovery is already running.");
		this.paused = true;
		try {
			await Promise.all(this.active);
			return await action();
		} finally { this.paused = false; }
	}
}

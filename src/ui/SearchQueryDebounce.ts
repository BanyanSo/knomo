interface SearchQueryDebounceOptions {
	scheduleTask: (callback: () => void, delayMs: number) => number;
	cancelTask: (taskId: number) => void;
	delayMs: number;
}

export class SearchQueryDebounce {
	private taskId: number | null = null;

	constructor(private readonly options: SearchQueryDebounceOptions) {}

	queue(query: string, applyQuery: (query: string) => void): void {
		this.clear();
		this.taskId = this.options.scheduleTask(() => {
			this.taskId = null;
			applyQuery(query);
		}, this.options.delayMs);
	}

	clear(): void {
		if (this.taskId === null) {
			return;
		}
		this.options.cancelTask(this.taskId);
		this.taskId = null;
	}
}

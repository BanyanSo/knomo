interface DateChangeWatcherOptions {
	getNow: () => Date;
	scheduleTask: (callback: () => void, delayMs: number) => number;
	cancelTask: (taskId: number) => void;
	minDelayMs?: number;
}

export class DateChangeWatcher {
	private taskId: number | null = null;
	private readonly minDelayMs: number;

	constructor(private readonly options: DateChangeWatcherOptions) {
		this.minDelayMs = options.minDelayMs ?? 1000;
	}

	start(onDateChange: () => void): void {
		if (this.taskId !== null) {
			return;
		}
		const delay = getNextDateChangeDelayMs(this.options.getNow(), this.minDelayMs);
		this.taskId = this.options.scheduleTask(() => {
			this.taskId = null;
			onDateChange();
		}, delay);
	}

	stop(): void {
		if (this.taskId === null) {
			return;
		}
		this.options.cancelTask(this.taskId);
		this.taskId = null;
	}
}

export function getNextDateChangeDelayMs(now: Date, minDelayMs = 1000): number {
	const nextDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 1);
	return Math.max(minDelayMs, nextDay.getTime() - now.getTime());
}

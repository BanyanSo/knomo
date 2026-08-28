import type { Component } from "obsidian";

export interface LowPriorityWorkQueueWindow {
	setTimeout(callback: () => void, delay: number): number;
	clearTimeout(timer: number): void;
}

export interface LowPriorityWorkRunner {
	run<T>(priority: number, action: () => Promise<T>): Promise<T>;
}

interface QueuedWork {
	priority: number;
	sequence: number;
	run: () => Promise<void>;
	reject: (error: Error) => void;
}

// 职责：把可延后的后台工作串行化，并在每项工作之间归还事件循环。
export class LowPriorityWorkQueue implements LowPriorityWorkRunner {
	private readonly pending: QueuedWork[] = [];
	private sequence = 0;
	private timer: number | null = null;
	private active = false;
	private stopped = false;

	constructor(private readonly getWindow: () => LowPriorityWorkQueueWindow) {}

	start(owner: Component): void {
		owner.register(() => this.stop());
	}

	run<T>(priority: number, action: () => Promise<T>): Promise<T> {
		if (this.stopped) return Promise.reject(new Error("Low-priority work queue is stopped."));
		return new Promise<T>((resolve, reject) => {
			const queued: QueuedWork = {
				priority,
				sequence: this.sequence,
				reject,
				run: async () => {
					try {
						resolve(await action());
					} catch (error) {
						reject(error);
					}
				},
			};
			this.sequence += 1;
			this.pending.push(queued);
			this.schedule();
		});
	}

	stop(): void {
		if (this.stopped) return;
		this.stopped = true;
		const win = this.getWindow();
		if (this.timer !== null) win.clearTimeout(this.timer);
		this.timer = null;
		const error = new Error("Low-priority work queue is stopped.");
		for (const task of this.pending.splice(0)) task.reject(error);
	}

	private schedule(): void {
		if (this.stopped || this.active || this.timer !== null || this.pending.length === 0) return;
		const win = this.getWindow();
		this.timer = win.setTimeout(() => {
			this.timer = null;
			void this.runNext();
		}, 0);
	}

	private async runNext(): Promise<void> {
		if (this.stopped || this.active) return;
		this.pending.sort((left, right) => left.priority - right.priority || left.sequence - right.sequence);
		const task = this.pending.shift();
		if (task === undefined) return;
		this.active = true;
		try {
			await task.run();
		} finally {
			this.active = false;
			this.schedule();
		}
	}
}

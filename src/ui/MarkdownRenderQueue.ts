export type MarkdownRenderPriority = "high" | "normal";

interface MarkdownRenderTask {
	generation: number;
	run: () => Promise<void>;
	target?: HTMLElement;
	preferred: boolean;
}

interface MarkdownRenderQueueOptions {
	concurrency: number;
	getGeneration: () => number;
	scheduleTask?: (callback: () => void) => number;
	cancelTask?: (id: number) => void;
}

export class MarkdownRenderQueue {
	private highPriorityQueue: MarkdownRenderTask[] = [];
	private normalPriorityQueue: MarkdownRenderTask[] = [];
	private activeCount = 0;
	private paused = false;
	private scheduledTask: number | null = null;

	constructor(private readonly options: MarkdownRenderQueueOptions) {}

	enqueue(priority: MarkdownRenderPriority, generation: number, run: () => Promise<void>, target?: HTMLElement): void {
		if (generation !== this.options.getGeneration()) {
			return;
		}
		const task: MarkdownRenderTask = { generation, run, target, preferred: false };
		if (priority === "high") {
			this.highPriorityQueue.push(task);
		} else {
			this.normalPriorityQueue.push(task);
		}
		this.pump();
	}

	prioritizeTargets(isPreferred: (target: HTMLElement) => boolean): void {
		for (const task of [...this.highPriorityQueue, ...this.normalPriorityQueue]) {
			task.preferred = task.target !== undefined && isPreferred(task.target);
		}
	}

	clear(): void {
		if (this.scheduledTask !== null) this.options.cancelTask?.(this.scheduledTask);
		this.scheduledTask = null;
		this.highPriorityQueue = [];
		this.normalPriorityQueue = [];
	}

	setPaused(paused: boolean): void {
		if (this.paused === paused) {
			return;
		}
		this.paused = paused;
		if (!paused) {
			this.pump();
		}
	}

	private pump(inFrame = false): void {
		if (this.paused) {
			return;
		}
		if (this.options.scheduleTask && !inFrame) {
			if (this.scheduledTask === null && this.activeCount < this.options.concurrency
				&& (this.highPriorityQueue.length > 0 || this.normalPriorityQueue.length > 0)) {
				this.scheduledTask = this.options.scheduleTask(() => {
					this.scheduledTask = null;
					this.pump(true);
				});
			}
			return;
		}
		while (this.activeCount < this.options.concurrency) {
			// 屏内正文先于按列表索引标记的高优先级任务，原队列顺序作为兜底。
			const preferredHigh = this.highPriorityQueue.findIndex(task => task.preferred);
			const preferredNormal = preferredHigh < 0 ? this.normalPriorityQueue.findIndex(task => task.preferred) : -1;
			const task = preferredHigh >= 0 ? this.highPriorityQueue.splice(preferredHigh, 1)[0]
				: preferredNormal >= 0 ? this.normalPriorityQueue.splice(preferredNormal, 1)[0]
					: this.highPriorityQueue.shift() ?? this.normalPriorityQueue.shift();
			if (task === undefined) {
				return;
			}
			if (task.generation !== this.options.getGeneration()) {
				continue;
			}
			this.activeCount += 1;
			void this.runTask(task);
			if (this.options.scheduleTask) {
				this.pump();
				return;
			}
		}
	}

	private async runTask(task: MarkdownRenderTask): Promise<void> {
		try {
			if (task.generation === this.options.getGeneration()) {
				await task.run();
			}
		} catch {
			// 单张卡片渲染失败会在任务内部降级，队列本身只负责继续调度。
		} finally {
			this.activeCount = Math.max(0, this.activeCount - 1);
			this.pump();
		}
	}
}

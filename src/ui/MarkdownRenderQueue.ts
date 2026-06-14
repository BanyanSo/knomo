export type MarkdownRenderPriority = "high" | "normal";

interface MarkdownRenderTask {
	generation: number;
	run: () => Promise<void>;
}

interface MarkdownRenderQueueOptions {
	concurrency: number;
	getGeneration: () => number;
}

export class MarkdownRenderQueue {
	private highPriorityQueue: MarkdownRenderTask[] = [];
	private normalPriorityQueue: MarkdownRenderTask[] = [];
	private activeCount = 0;
	private paused = false;

	constructor(private readonly options: MarkdownRenderQueueOptions) {}

	enqueue(priority: MarkdownRenderPriority, generation: number, run: () => Promise<void>): void {
		if (generation !== this.options.getGeneration()) {
			return;
		}
		const task: MarkdownRenderTask = { generation, run };
		if (priority === "high") {
			this.highPriorityQueue.push(task);
		} else {
			this.normalPriorityQueue.push(task);
		}
		this.pump();
	}

	clear(): void {
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

	private pump(): void {
		if (this.paused) {
			return;
		}
		while (this.activeCount < this.options.concurrency) {
			const task = this.highPriorityQueue.shift() ?? this.normalPriorityQueue.shift();
			if (task === undefined) {
				return;
			}
			if (task.generation !== this.options.getGeneration()) {
				continue;
			}
			this.activeCount += 1;
			void this.runTask(task);
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

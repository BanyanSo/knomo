import type { Plugin } from "obsidian";

export interface PluginDataMutation<T> {
	nextData: Record<string, unknown> | null;
	result: T;
}

// 职责：串行化 plugin data 的读改写，避免不同服务互相覆盖字段。
export class PluginDataStore {
	private writeQueue: Promise<void> = Promise.resolve();

	constructor(private readonly plugin: Plugin) {}

	async read(): Promise<unknown> {
		await this.writeQueue;
		const savedData: unknown = await this.plugin.loadData();
		return savedData;
	}

	async mutate<T>(
		mutation: (savedData: unknown) => PluginDataMutation<T>,
		prepare?: () => Promise<() => boolean>,
	): Promise<T> {
		return this.runWriteExclusive(async () => {
			for (;;) {
				// 先完成异步核对。若读取期间收到源变化通知，重新核对并重新读取配置。
				const isPrepared = prepare ? await prepare() : undefined;
				const savedData: unknown = await this.plugin.loadData();
				if (isPrepared && !isPrepared()) continue;
				const { nextData, result } = mutation(savedData);
				if (nextData !== null) await this.plugin.saveData(nextData);
				return result;
			}
		});
	}

	private async runWriteExclusive<T>(operation: () => Promise<T>): Promise<T> {
		const previous = this.writeQueue;
		let releaseQueue: () => void = () => undefined;
		this.writeQueue = new Promise<void>((resolve) => {
			releaseQueue = resolve;
		});
		await previous;
		try {
			return await operation();
		} finally {
			releaseQueue();
		}
	}
}

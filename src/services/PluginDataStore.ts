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
		mutation: (savedData: unknown) => PluginDataMutation<T> | Promise<PluginDataMutation<T>>,
	): Promise<T> {
		return this.runWriteExclusive(async () => {
			const savedData: unknown = await this.plugin.loadData();
			const { nextData, result } = await mutation(savedData);
			if (nextData !== null) {
				await this.plugin.saveData(nextData);
			}
			return result;
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

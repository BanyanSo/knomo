interface KnomoBasicDataRecoveryOptions {
	signal: AbortSignal;
	runExclusive?: (action: () => Promise<void>) => Promise<void>;
	prepare: () => Promise<void>;
	rebuildReplicas: () => Promise<void>;
	initialize: () => Promise<void>;
	rebuildCatalog: () => Promise<void>;
	importIdentities: () => Promise<void>;
	complete: () => Promise<void>;
}

/** 用户确认后的单一恢复入口；任一步失败都保留进度，重试从当前文件幂等恢复。 */
export class KnomoBasicDataRecovery {
	private operation: Promise<void> | null = null;
	constructor(private readonly options: KnomoBasicDataRecoveryOptions) {}
	isRunning(): boolean { return this.operation !== null; }
	run(): Promise<void> {
		if (this.operation !== null) return this.operation;
		const execute = async () => {
			for (const step of [this.options.prepare, this.options.rebuildReplicas, this.options.initialize,
				this.options.rebuildCatalog, this.options.importIdentities, this.options.complete]) {
				if (this.options.signal.aborted) throw new Error("Knomo recovery was cancelled.");
				await step();
			}
		};
		const operation = Promise.resolve().then(() => this.options.runExclusive?.(execute) ?? execute())
			.finally(() => { if (this.operation === operation) this.operation = null; });
		this.operation = operation;
		return operation;
	}
}

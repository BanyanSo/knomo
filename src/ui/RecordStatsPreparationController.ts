interface RecordStatsPreparationControllerOptions {
	scheduleTask: (callback: () => void, delayMs: number) => number;
	cancelTask: (taskId: number) => void;
	prepareDelayMs?: number;
}

interface PrepareRecordStatsOptions {
	isPreparedForSource: (source: string) => boolean;
	runPreparation: (source: string) => Promise<boolean>;
	onPreparedForCurrentSource: () => void;
}

interface ScheduleRecordStatsOptions {
	isPreparedForSource: (source: string) => boolean;
	prepare: () => void;
}

export class RecordStatsPreparationController {
	private sourceKeyValue = "catalog:uninitialized";
	private prepareTaskId: number | null = null;
	private requestPromise: Promise<boolean> | null = null;
	private requestInvalidated = false;
	private readonly prepareDelayMs: number;

	constructor(private readonly options: RecordStatsPreparationControllerOptions) {
		this.prepareDelayMs = options.prepareDelayMs ?? 180;
	}

	get sourceKey(): string {
		return this.sourceKeyValue;
	}

	hasActiveRequest(): boolean {
		return this.requestPromise !== null;
	}

	setSourceKey(sourceKey: string): boolean {
		if (sourceKey === this.sourceKeyValue) {
			return false;
		}
		this.sourceKeyValue = sourceKey;
		this.invalidate();
		return true;
	}

	invalidate(): void {
		this.clearScheduledPreparation();
		if (this.requestPromise !== null) {
			this.requestInvalidated = true;
		}
	}

	schedulePreparation(options: ScheduleRecordStatsOptions): void {
		if (
			options.isPreparedForSource(this.sourceKey) ||
			this.requestPromise !== null ||
			this.prepareTaskId !== null
		) {
			return;
		}
		this.prepareTaskId = this.options.scheduleTask(() => {
			this.prepareTaskId = null;
			options.prepare();
		}, this.prepareDelayMs);
	}

	clearScheduledPreparation(): void {
		if (this.prepareTaskId === null) {
			return;
		}
		this.options.cancelTask(this.prepareTaskId);
		this.prepareTaskId = null;
	}

	clearRetryRequest(): void {
		this.requestInvalidated = false;
	}

	prepare(options: PrepareRecordStatsOptions): Promise<boolean> {
		this.clearScheduledPreparation();
		if (options.isPreparedForSource(this.sourceKey)) {
			options.onPreparedForCurrentSource();
			return Promise.resolve(true);
		}
		if (this.requestPromise !== null) {
			return this.requestPromise;
		}
		this.requestInvalidated = false;
		const request = options.runPreparation(this.sourceKey);
		const trackedRequest = request.finally(() => {
			const shouldRetry = this.requestInvalidated && !options.isPreparedForSource(this.sourceKey);
			this.requestInvalidated = false;
			if (this.requestPromise === trackedRequest) {
				this.requestPromise = null;
			}
			if (shouldRetry) {
				void this.prepare(options);
			}
		});
		this.requestPromise = trackedRequest;
		return trackedRequest;
	}
}

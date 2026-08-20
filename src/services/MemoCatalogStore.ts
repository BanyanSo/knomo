import type {
	CatalogCoverage,
	CatalogDailyAggregate,
	CatalogFilePartition,
	CatalogFileRecord,
	CatalogFileRevisionBatch,
	CatalogObservation,
	CatalogQuery,
	CatalogQueryPage,
	CatalogStoreLifecycle,
	CatalogV2ResolutionSnapshot,
} from "../types/catalog";

export const DEFAULT_CATALOG_COVERAGE: CatalogCoverage = {
	kind: "partial",
	coveredFromDate: null,
	pendingFileCount: 0,
	coveredFileCount: 0,
	totalFileCount: 0,
};

export interface MemoCatalogStore {
	open(): Promise<void>;
	close(): void;
	getLifecycle(): CatalogStoreLifecycle;
	replaceFilePartition(partition: CatalogFilePartition): Promise<number>;
	replaceFilePartitions(partitions: readonly CatalogFilePartition[]): Promise<number>;
	deleteFilePartition(sourcePath: string): Promise<number>;
	getFile(sourcePath: string): Promise<CatalogFileRecord | null>;
	getFileRevisionBatch(sourcePath: string): Promise<CatalogFileRevisionBatch | null>;
	getObservation(observationKey: string): Promise<CatalogObservation | null>;
	listFiles(): Promise<CatalogFileRecord[]>;
	query(request: CatalogQuery): Promise<CatalogQueryPage>;
	listDailyAggregates(fromDate?: string, toDate?: string): Promise<CatalogDailyAggregate[]>;
	getCoverage(): Promise<CatalogCoverage>;
	setCoverage(coverage: CatalogCoverage): Promise<void>;
	getMeta<T>(key: string): Promise<T | null>;
	setMeta<T>(key: string, value: T): Promise<void>;
	deleteMeta(key: string): Promise<void>;
	loadResolutionSnapshot(): Promise<CatalogV2ResolutionSnapshot | null>;
	saveResolutionSnapshot(snapshot: CatalogV2ResolutionSnapshot): Promise<void>;
	clear(): Promise<void>;
}

export class InMemoryMemoCatalogStore implements MemoCatalogStore {
	private readonly files = new Map<string, CatalogFileRecord>();
	private readonly observations = new Map<string, CatalogObservation>();
	private readonly observationsByFile = new Map<string, string[]>();
	private readonly aggregates = new Map<string, CatalogFilePartition["aggregate"]>();
	private readonly metadata = new Map<string, unknown>();
	private catalogRevision = 0;
	private coverage: CatalogCoverage = { ...DEFAULT_CATALOG_COVERAGE };

	constructor(private readonly maxObservations = Number.MAX_SAFE_INTEGER) {}

	async open(): Promise<void> {}

	close(): void {}

	getLifecycle(): CatalogStoreLifecycle {
		return { state: "ready", persistent: false, writable: true, reason: null };
	}

	async replaceFilePartition(partition: CatalogFilePartition): Promise<number> {
		return this.replaceFilePartitions([partition]);
	}

	async replaceFilePartitions(partitions: readonly CatalogFilePartition[]): Promise<number> {
		if (partitions.length === 0) {
			return this.catalogRevision;
		}
		for (const partition of partitions) {
			this.removeFilePartition(partition.file.sourcePath);
			this.files.set(partition.file.sourcePath, clone(partition.file));
			const keys: string[] = [];
			for (const observation of partition.observations) {
				this.observations.set(observation.observationKey, clone(observation));
				keys.push(observation.observationKey);
			}
			this.observationsByFile.set(partition.file.sourcePath, keys);
			this.aggregates.set(partition.file.sourcePath, clone(partition.aggregate));
		}
		this.catalogRevision += 1;
		this.trimToLimit();
		return this.catalogRevision;
	}

	async deleteFilePartition(sourcePath: string): Promise<number> {
		if (!this.files.has(sourcePath)) {
			return this.catalogRevision;
		}
		this.removeFilePartition(sourcePath);
		this.catalogRevision += 1;
		return this.catalogRevision;
	}

	async getFile(sourcePath: string): Promise<CatalogFileRecord | null> {
		const file = this.files.get(sourcePath);
		return file === undefined ? null : clone(file);
	}

	async getFileRevisionBatch(sourcePath: string): Promise<CatalogFileRevisionBatch | null> {
		const file = this.files.get(sourcePath);
		if (file === undefined) return null;
		const observations = (this.observationsByFile.get(sourcePath) ?? [])
			.flatMap((key) => {
				const observation = this.observations.get(key);
				return observation === undefined ? [] : [clone(observation)];
			})
			.sort((left, right) => left.observationKey.localeCompare(right.observationKey));
		return { file: clone(file), observations, catalogRevision: this.catalogRevision };
	}

	async getObservation(observationKey: string): Promise<CatalogObservation | null> {
		const observation = this.observations.get(observationKey);
		return observation === undefined ? null : clone(observation);
	}

	async listFiles(): Promise<CatalogFileRecord[]> {
		return [...this.files.values()].map(clone).sort((left, right) => left.sourcePath.localeCompare(right.sourcePath));
	}

	async query(request: CatalogQuery): Promise<CatalogQueryPage> {
		if (request.cursor !== undefined && request.cursor !== null && request.cursor.catalogRevision !== this.catalogRevision) {
			return emptyInvalidatedPage(this.catalogRevision, this.coverage);
		}
		const limit = clampPageLimit(request.limit);
		let cursorReads = 0;
		let observationsRead = 0;
		const sourcePaths = request.sourcePaths === undefined ? null : new Set(request.sourcePaths);
		const candidates = [...this.observations.values()].sort(compareCatalogObservations);
		const matches: CatalogObservation[] = [];
		for (const observation of candidates) {
			cursorReads += 1;
			if (!isAfterCursor(observation, request)) {
				continue;
			}
			observationsRead += 1;
			if (!matchesCatalogQuery(observation, request, sourcePaths)) {
				continue;
			}
			matches.push(clone(observation));
			if (matches.length > limit) {
				break;
			}
		}
		const hasNext = matches.length > limit;
		const items = matches.slice(0, limit);
		const last = items[items.length - 1];
		return {
			items,
			nextCursor: hasNext && last !== undefined ? {
				catalogRevision: this.catalogRevision,
				createdAtKey: last.createdAtKey,
				observationKey: last.observationKey,
			} : null,
			catalogRevision: this.catalogRevision,
			coverage: clone(this.coverage),
			lifecycle: this.getLifecycle(),
			metrics: { cursorReads, observationsRead, returned: items.length },
			invalidated: false,
		};
	}

	async listDailyAggregates(fromDate?: string, toDate?: string): Promise<CatalogDailyAggregate[]> {
		const byDate = new Map<string, CatalogDailyAggregate>();
		for (const aggregate of this.aggregates.values()) {
			if ((fromDate !== undefined && aggregate.logicalDate < fromDate)
				|| (toDate !== undefined && aggregate.logicalDate > toDate)) {
				continue;
			}
			mergeAggregate(byDate, aggregate);
		}
		return [...byDate.values()].sort((left, right) => right.logicalDate.localeCompare(left.logicalDate));
	}

	async getCoverage(): Promise<CatalogCoverage> {
		return clone(this.coverage);
	}

	async setCoverage(coverage: CatalogCoverage): Promise<void> {
		this.coverage = clone(coverage);
	}

	async getMeta<T>(key: string): Promise<T | null> {
		const value = this.metadata.get(key);
		return value === undefined ? null : clone(value as T);
	}

	async setMeta<T>(key: string, value: T): Promise<void> {
		this.metadata.set(key, clone(value));
	}

	async deleteMeta(key: string): Promise<void> {
		this.metadata.delete(key);
	}

	async loadResolutionSnapshot(): Promise<CatalogV2ResolutionSnapshot | null> {
		return this.getMeta<CatalogV2ResolutionSnapshot>("catalogV2ResolutionSnapshot");
	}

	async saveResolutionSnapshot(snapshot: CatalogV2ResolutionSnapshot): Promise<void> {
		await this.setMeta("catalogV2ResolutionSnapshot", snapshot);
	}

	async clear(): Promise<void> {
		this.files.clear();
		this.observations.clear();
		this.observationsByFile.clear();
		this.aggregates.clear();
		this.metadata.clear();
		this.catalogRevision += 1;
		this.coverage = { ...DEFAULT_CATALOG_COVERAGE };
	}

	private removeFilePartition(sourcePath: string): void {
		for (const key of this.observationsByFile.get(sourcePath) ?? []) {
			this.observations.delete(key);
		}
		this.observationsByFile.delete(sourcePath);
		this.files.delete(sourcePath);
		this.aggregates.delete(sourcePath);
	}

	private trimToLimit(): void {
		if (this.observations.size <= this.maxObservations) {
			return;
		}
		const filesOldestFirst = [...this.files.values()].sort((left, right) =>
			left.logicalDate.localeCompare(right.logicalDate) || left.sourcePath.localeCompare(right.sourcePath));
		for (const file of filesOldestFirst) {
			if (this.observations.size <= this.maxObservations) {
				break;
			}
			this.removeFilePartition(file.sourcePath);
		}
		this.coverage = {
			...this.coverage,
			kind: this.coverage.kind === "rebuilding" ? "rebuilding" : "partial",
			coveredFromDate: getEarliestStoredDate(this.files),
			coveredFileCount: this.files.size,
			pendingFileCount: Math.max(0, this.coverage.totalFileCount - this.files.size),
		};
	}
}

export class FallbackMemoCatalogStore implements MemoCatalogStore {
	private active: MemoCatalogStore | null = null;
	private fallbackActive = false;
	private activatingFallback: Promise<void> | null = null;
	private lifecycle: CatalogStoreLifecycle = {
		state: "opening",
		persistent: true,
		writable: false,
		reason: null,
	};
	private recoveryNotificationPending = false;

	constructor(
		private readonly primary: MemoCatalogStore,
		private readonly fallback: MemoCatalogStore,
		private readonly onFallbackActivated: (() => void | Promise<void>) | null = null,
	) {}

	get isUsingFallback(): boolean {
		return this.fallbackActive;
	}

	async open(): Promise<void> {
		this.lifecycle = {
			state: this.fallbackActive ? "retrying" : "opening",
			persistent: true,
			writable: false,
			reason: null,
		};
		try {
			await this.primary.open();
			this.active = this.primary;
			this.fallbackActive = false;
			this.lifecycle = this.primary.getLifecycle();
		} catch (error) {
			await this.fallback.open();
			this.active = this.fallback;
			this.fallbackActive = true;
			this.lifecycle = degradedLifecycle(error);
		}
	}

	close(): void {
		this.primary.close();
		this.fallback.close();
		this.active = null;
		this.lifecycle = degradedLifecycle("closed");
	}

	getLifecycle(): CatalogStoreLifecycle {
		return { ...this.lifecycle };
	}

	replaceFilePartition(partition: CatalogFilePartition): Promise<number> {
		return this.run((store) => store.replaceFilePartition(partition));
	}
	replaceFilePartitions(partitions: readonly CatalogFilePartition[]): Promise<number> {
		return this.run((store) => store.replaceFilePartitions(partitions));
	}
	deleteFilePartition(sourcePath: string): Promise<number> {
		return this.run((store) => store.deleteFilePartition(sourcePath));
	}
	getFile(sourcePath: string): Promise<CatalogFileRecord | null> {
		return this.run((store) => store.getFile(sourcePath));
	}
	getFileRevisionBatch(sourcePath: string): Promise<CatalogFileRevisionBatch | null> {
		return this.run((store) => store.getFileRevisionBatch(sourcePath));
	}
	getObservation(observationKey: string): Promise<CatalogObservation | null> {
		return this.run((store) => store.getObservation(observationKey));
	}
	listFiles(): Promise<CatalogFileRecord[]> { return this.run((store) => store.listFiles()); }
	async query(request: CatalogQuery): Promise<CatalogQueryPage> {
		const page = await this.run((store) => store.query(request));
		return { ...page, lifecycle: this.getLifecycle() };
	}
	listDailyAggregates(fromDate?: string, toDate?: string): Promise<CatalogDailyAggregate[]> {
		return this.run((store) => store.listDailyAggregates(fromDate, toDate));
	}
	getCoverage(): Promise<CatalogCoverage> { return this.run((store) => store.getCoverage()); }
	async setCoverage(coverage: CatalogCoverage): Promise<void> {
		await this.run(async (store) => {
			if (store !== this.fallback) {
				await store.setCoverage(coverage);
				return;
			}
			const coveredFileCount = (await store.listFiles()).length;
			await store.setCoverage({
				...coverage,
				kind: coverage.kind === "rebuilding" ? "rebuilding" : "partial",
				coveredFileCount,
				pendingFileCount: Math.max(0, coverage.totalFileCount - coveredFileCount),
			});
		});
		this.lifecycle = coverage.kind === "rebuilding"
			? { state: "rebuilding", persistent: !this.fallbackActive, writable: true, reason: null }
			: this.fallbackActive ? degradedLifecycle("indexeddb_unavailable") : this.primary.getLifecycle();
	}
	getMeta<T>(key: string): Promise<T | null> { return this.run((store) => store.getMeta<T>(key)); }
	setMeta<T>(key: string, value: T): Promise<void> { return this.run((store) => store.setMeta(key, value)); }
	deleteMeta(key: string): Promise<void> { return this.run((store) => store.deleteMeta(key)); }
	loadResolutionSnapshot(): Promise<CatalogV2ResolutionSnapshot | null> {
		return this.run((store) => store.loadResolutionSnapshot());
	}
	saveResolutionSnapshot(snapshot: CatalogV2ResolutionSnapshot): Promise<void> {
		return this.run((store) => store.saveResolutionSnapshot(snapshot));
	}
	clear(): Promise<void> { return this.run((store) => store.clear()); }

	private async run<T>(operation: (store: MemoCatalogStore) => Promise<T>): Promise<T> {
		const active = this.getActive();
		const lifecycleBefore = active.getLifecycle();
		try {
			const result = await operation(active);
			if (active === this.primary) {
				this.lifecycle = this.primary.getLifecycle();
				if (lifecycleBefore.state === "read-only" || lifecycleBefore.state === "degraded") {
					this.notifyRecoveryNeeded();
				}
			}
			return result;
		} catch (error) {
			if (active !== this.primary) throw error;
			await this.activateFallback();
			return operation(this.fallback);
		}
	}

	private async activateFallback(): Promise<void> {
		if (this.active === this.fallback) return;
		if (this.activatingFallback !== null) return this.activatingFallback;
		this.activatingFallback = (async () => {
			await this.fallback.open();
			this.primary.close();
			this.active = this.fallback;
			this.fallbackActive = true;
			this.lifecycle = degradedLifecycle("indexeddb_unavailable");
			if (this.onFallbackActivated !== null) {
				this.notifyRecoveryNeeded();
			}
		})().finally(() => { this.activatingFallback = null; });
		return this.activatingFallback;
	}

	private getActive(): MemoCatalogStore {
		if (this.active === null) {
			throw new Error("Memo Catalog store is not open.");
		}
		return this.active;
	}

	private notifyRecoveryNeeded(): void {
		if (this.onFallbackActivated === null || this.recoveryNotificationPending) return;
		this.recoveryNotificationPending = true;
		void Promise.resolve(this.onFallbackActivated()).catch(() => undefined).finally(() => {
			this.recoveryNotificationPending = false;
		});
	}
}

export function normalizeCatalogText(value: string): string {
	return value.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
}

export function matchesCatalogQuery(
	observation: CatalogObservation,
	request: CatalogQuery,
	sourcePaths: ReadonlySet<string> | null = request.sourcePaths === undefined ? null : new Set(request.sourcePaths),
): boolean {
	const tags = request.tags?.map(normalizeCatalogText) ?? [];
	const normalizedText = request.text === undefined ? "" : normalizeCatalogText(request.text);
	return (normalizedText.length === 0 || observation.searchText.includes(normalizedText))
		&& tags.every((tag) => observation.tagKeys.includes(tag))
		&& (request.linkTarget === undefined || observation.linkTargets.includes(normalizeCatalogText(request.linkTarget)))
		&& (request.hasLink === undefined || (observation.hasLink === 1) === request.hasLink)
		&& (request.imagePath === undefined || observation.imagePaths.includes(normalizeCatalogText(request.imagePath)))
		&& (request.hasImage === undefined || (observation.hasImage === 1) === request.hasImage)
		&& (request.hasTask === undefined || (observation.hasTask === 1) === request.hasTask)
		&& (request.hasTag === undefined || (observation.tags.length > 0) === request.hasTag)
		&& (request.hasTimeBuoy === undefined || (observation.hasTimeBuoy === 1) === request.hasTimeBuoy)
		&& (request.timeBuoyDate === undefined || observation.timeBuoyDates.includes(request.timeBuoyDate))
		&& (request.explicitReferenceTarget === undefined
			|| observation.explicitReferenceTargets.includes(request.explicitReferenceTarget))
		&& (request.fromDate === undefined || observation.logicalDate >= request.fromDate)
		&& (request.toDate === undefined || observation.logicalDate <= request.toDate)
		&& (request.monthDay === undefined || observation.logicalDate.slice(5) === request.monthDay)
		&& (sourcePaths === null || sourcePaths.has(observation.sourcePath));
}

export function compareCatalogObservations(left: CatalogObservation, right: CatalogObservation): number {
	return right.createdAtKey.localeCompare(left.createdAtKey) || right.observationKey.localeCompare(left.observationKey);
}

export function clampPageLimit(limit: number): number {
	return Math.max(1, Math.min(150, Math.trunc(limit)));
}

export function emptyInvalidatedPage(
	catalogRevision: number,
	coverage: CatalogCoverage,
	lifecycle: CatalogStoreLifecycle = { state: "ready", persistent: false, writable: true, reason: null },
): CatalogQueryPage {
	return {
		items: [],
		nextCursor: null,
		catalogRevision,
		coverage: clone(coverage),
		lifecycle: { ...lifecycle },
		metrics: { cursorReads: 0, observationsRead: 0, returned: 0 },
		invalidated: true,
	};
}

function getEarliestStoredDate(files: ReadonlyMap<string, CatalogFileRecord>): string | null {
	return [...files.values()].map((file) => file.logicalDate).sort()[0] ?? null;
}

function degradedLifecycle(reason: unknown): CatalogStoreLifecycle {
	return {
		state: "degraded",
		persistent: false,
		writable: true,
		reason: reason instanceof Error ? reason.message : String(reason),
	};
}

export function mergeAggregate(
	byDate: Map<string, CatalogDailyAggregate>,
	aggregate: CatalogFilePartition["aggregate"],
): void {
	const current = byDate.get(aggregate.logicalDate) ?? {
		logicalDate: aggregate.logicalDate,
		memoCount: 0,
		tagCount: 0,
		linkCount: 0,
		imageCount: 0,
		taskCount: 0,
		timeBuoyCount: 0,
		explicitReferenceCount: 0,
		explicitReferenceTargets: [],
	};
	current.memoCount += aggregate.memoCount;
	current.tagCount += aggregate.tagCount;
	current.linkCount += aggregate.linkCount;
	current.imageCount += aggregate.imageCount;
	current.taskCount += aggregate.taskCount;
	current.timeBuoyCount += aggregate.timeBuoyCount;
	current.explicitReferenceCount += aggregate.explicitReferenceCount;
	for (const target of aggregate.explicitReferenceTargets) {
		if (!current.explicitReferenceTargets.includes(target)) {
			current.explicitReferenceTargets.push(target);
		}
	}
	byDate.set(aggregate.logicalDate, current);
}

function isAfterCursor(observation: CatalogObservation, request: CatalogQuery): boolean {
	const cursor = request.cursor;
	if (cursor === undefined || cursor === null) {
		return true;
	}
	return observation.createdAtKey < cursor.createdAtKey
		|| (observation.createdAtKey === cursor.createdAtKey && observation.observationKey < cursor.observationKey);
}

function clone<T>(value: T): T {
	return structuredClone(value);
}

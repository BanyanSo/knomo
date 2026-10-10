import { CatalogFileChangeTracker, readCatalogFileChanges } from "./CatalogFileChanges";
import type { CatalogChangeCursor, CatalogFileChanges } from "./CatalogFileChanges";
import { getCatalogTextTerms, narrowCatalogQuery } from "./SearchMatching";
import type {
	CatalogAggregateSnapshot,
	CatalogCoverage,
	CatalogDailyAggregate,
	CatalogFileAggregate,
	CatalogFilePartition,
	CatalogFileRecord,
	CatalogFileRevisionBatch,
	CatalogObservation,
	CatalogPostingKind,
	CatalogQuery,
	CatalogQueryCountResult,
	CatalogQueryFilter,
	CatalogQueryPage,
	CatalogStoreLifecycle,
} from "../types/catalog";
import {
	clampPageLimit,
	createCatalogCountAbortError,
	DEFAULT_CATALOG_COVERAGE,
	emptyInvalidatedPage,
	createCatalogQueryMatcher,
	mergeAggregate,
	normalizeCatalogText,
} from "./MemoCatalogStore";
import type { CatalogMetaEntry, MemoCatalogStore } from "./MemoCatalogStore";
import { selectCatalogSearchToken } from "./MemoCatalogService";

import type { TimeBuoyObservationPage, TimeBuoyPageRequest } from "../types/timeBuoy";
import { TimeBuoyPageSelection } from "./TimeBuoyQuery";

const CATALOG_DATABASE_VERSION = 4;
const FILES_STORE = "files";
const OBSERVATIONS_STORE = "observations";
const POSTINGS_STORE = "postings";
const TIME_BUOYS_STORE = "timeBuoys";
const AGGREGATES_STORE = "aggregates";
const META_STORE = "meta";
const BY_SOURCE_PATH = "bySourcePath";
const BY_CREATED_AT = "byCreatedAt";
const BY_LOOKUP = "byLookup";
const BY_TARGET_DATE = "byTargetDate";
const BY_NEIGHBOR_DATE = "byNeighborDate";
const BY_LOGICAL_DATE = "byLogicalDate";
const CATALOG_REVISION_META = "catalogRevision";
const COVERAGE_META = "coverage";

interface CatalogPostingRecord {
	postingKey: string;
	sourcePath: string;
	observationKey: string;
	lookupKeys: string[];
}

// 相邻日期用于确定同一 occurrence 在当前标签内的最近目标，避免跨页重复。
type TimeBuoyKey = [targetDate: string, createdAtKey: string, observationKey: string, previousDate: string, nextDate: string];
interface TimeBuoyPostingRecord {
	key: TimeBuoyKey;
	targetDate: string;
	sourcePath: string;
	neighborKeys: [targetDate: string, direction: string, neighborDate: string][];
}

interface CatalogMetaRecord<T = unknown> {
	key: string;
	value: T;
}

interface CatalogIndexSelection {
	kind: CatalogPostingKind;
	value: string;
}

export interface IndexedDbMemoCatalogStoreOptions {
	factory?: IDBFactory;
	keyRange?: typeof IDBKeyRange;
	version?: number;
	beforeUpgrade?: () => void;
}

export class CatalogDatabaseBlockedError extends Error {
	constructor() {
		super("Memo Catalog IndexedDB open was blocked.");
		this.name = "CatalogDatabaseBlockedError";
	}
}

export class CatalogDatabaseCorruptError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CatalogDatabaseCorruptError";
	}
}

export class IndexedDbMemoCatalogStore implements MemoCatalogStore {
	private readonly fileChanges = new CatalogFileChangeTracker();
	private database: IDBDatabase | null = null;
	private snapshotGeneration = 0;
	private opening: Promise<void> | null = null;
	private readonly factory: IDBFactory | undefined;
	private readonly keyRange: typeof IDBKeyRange | undefined;
	private readonly version: number;
	private readonly beforeUpgrade: (() => void) | undefined;
	private openedOnce = false;
	private lifecycle: CatalogStoreLifecycle = {
		state: "opening",
		persistent: true,
		writable: false,
		reason: null,
	};

	constructor(
		private readonly databaseName: string,
		options: IndexedDbMemoCatalogStoreOptions = {},
	) {
		this.factory = options.factory ?? (typeof indexedDB === "undefined" ? undefined : indexedDB);
		this.keyRange = options.keyRange ?? (typeof IDBKeyRange === "undefined" ? undefined : IDBKeyRange);
		this.version = options.version ?? CATALOG_DATABASE_VERSION;
		this.beforeUpgrade = options.beforeUpgrade;
	}

	async open(): Promise<void> {
		if (this.database !== null) {
			return;
		}
		if (this.opening !== null) return this.opening;
		this.lifecycle = {
			state: this.openedOnce ? "retrying" : "opening",
			persistent: true,
			writable: false,
			reason: null,
		};
		this.opening = this.openInternal().then(() => {
			this.openedOnce = true;
			this.lifecycle = { state: "ready", persistent: true, writable: true, reason: null };
		}).catch((error: unknown) => {
			this.lifecycle = {
				state: "degraded",
				persistent: false,
				writable: false,
				reason: error instanceof Error ? error.message : String(error),
			};
			throw error;
		}).finally(() => { this.opening = null; });
		return this.opening;
	}

	private async openInternal(): Promise<void> {
		if (this.factory === undefined || this.keyRange === undefined) {
			throw new Error("IndexedDB is unavailable.");
		}
		try {
			this.database = await openCatalogDatabase(this.factory, this.databaseName, this.version, this.beforeUpgrade);
		} catch (error) {
			if (!(error instanceof CatalogDatabaseCorruptError)) {
				throw error;
			}
			this.lifecycle = { state: "rebuilding", persistent: true, writable: false, reason: error.message };
			await deleteCatalogDatabase(this.factory, this.databaseName);
			this.database = await openCatalogDatabase(this.factory, this.databaseName, this.version, this.beforeUpgrade);
		}
		const database = this.database;
		database.onversionchange = () => {
			this.snapshotGeneration++;
			this.fileChanges.clear();
			this.lifecycle = {
				state: "read-only",
				persistent: true,
				writable: false,
				reason: "versionchange",
			};
			database.close();
			if (this.database === database) this.database = null;
		};
	}

	close(): void {
		this.snapshotGeneration++;
		this.fileChanges.clear();
		this.database?.close();
		this.database = null;
		if (this.lifecycle.state !== "read-only") {
			this.lifecycle = { state: "degraded", persistent: false, writable: false, reason: "closed" };
		}
	}

	getRuntimeGeneration(): string { return String(this.snapshotGeneration); }
	readFileChangesSince(previous?: CatalogChangeCursor): Promise<CatalogFileChanges> {
		return readCatalogFileChanges(this, this.fileChanges, previous);
	}

	getLifecycle(): CatalogStoreLifecycle {
		return { ...this.lifecycle };
	}

	async replaceFilePartition(partition: CatalogFilePartition): Promise<number> {
		return this.replaceFilePartitions([partition]);
	}

	async replaceFilePartitions(partitions: readonly CatalogFilePartition[]): Promise<number> {
		await this.open();
		if (partitions.length === 0) {
			return this.getCatalogRevision();
		}
		const generation = this.snapshotGeneration;
		const transaction = this.getDatabase().transaction(
			[FILES_STORE, OBSERVATIONS_STORE, POSTINGS_STORE, TIME_BUOYS_STORE, AGGREGATES_STORE, META_STORE],
			"readwrite",
		);
		const done = waitForTransaction(transaction);
		const files = transaction.objectStore(FILES_STORE);
		const observations = transaction.objectStore(OBSERVATIONS_STORE);
		const postings = transaction.objectStore(POSTINGS_STORE);
		const timeBuoys = transaction.objectStore(TIME_BUOYS_STORE);
		const aggregates = transaction.objectStore(AGGREGATES_STORE);
		const metadata = transaction.objectStore(META_STORE);
		const partitionRequests = partitions.map((partition) =>
			(requestResult(files.get(partition.file.sourcePath)) as Promise<CatalogFileRecord | undefined>)
				.then(async (existingFile) => {
					if (existingFile === undefined) {
						return { partition, observationKeys: [], postingKeys: [], buoyKeys: [] as IDBValidKey[], existingObservations: [], reuseExisting: false };
					}
					if (existingFile.sourceRevision === partition.file.sourceRevision
						&& existingFile.parserVersion === partition.file.parserVersion
						&& existingFile.settingsFingerprint === partition.file.settingsFingerprint) {
						return { partition, observationKeys: [], postingKeys: [], buoyKeys: [] as IDBValidKey[], existingObservations: [], reuseExisting: true };
					}
					const [observationKeys, postingKeys, buoyKeys, existingObservations] = await Promise.all([
						existingFile.observationKeys === undefined
							? requestResult(observations.index(BY_SOURCE_PATH).getAllKeys(partition.file.sourcePath))
							: Promise.resolve(existingFile.observationKeys),
						existingFile.observationKeys === undefined
							? requestResult(postings.index(BY_SOURCE_PATH).getAllKeys(partition.file.sourcePath))
							: Promise.resolve(existingFile.observationKeys),
						requestResult(timeBuoys.index(BY_SOURCE_PATH).getAllKeys(partition.file.sourcePath)),
						Promise.all(partition.observations.map((observation) =>
							requestResult(observations.get(observation.observationKey)) as Promise<CatalogObservation | undefined>)),
					]);
					return { partition, observationKeys, postingKeys, buoyKeys, existingObservations, reuseExisting: false };
				}));
		const revisionRequest = requestResult(metadata.get(CATALOG_REVISION_META)) as
			Promise<CatalogMetaRecord<number> | undefined>;
		try {
			const [partitionsWithKeys, revisionRecord] = await Promise.all([
				Promise.all(partitionRequests),
				revisionRequest,
			]);
			for (const { partition, observationKeys, postingKeys, buoyKeys, existingObservations, reuseExisting } of partitionsWithKeys) {
				files.put(partition.file);
				if (reuseExisting) continue;
				const nextKeys = new Set(partition.file.observationKeys ?? []);
				const existingByKey = new Map(existingObservations.flatMap((observation) =>
					observation === undefined ? [] : [[observation.observationKey, observation] as const]));
				for (const key of observationKeys) {
					if (!nextKeys.has(String(key))) observations.delete(key);
				}
				for (const key of postingKeys) {
					if (!nextKeys.has(String(key))) postings.delete(key);
				}
				const changedBuoys = new Set(partition.observations.filter(observation => {
					const existing = existingByKey.get(observation.observationKey);
					return existing === undefined || !sameTimeBuoyPosting(existing, observation);
				}).map(observation => observation.observationKey));
				for (const key of buoyKeys) {
					const observationKey = (key as TimeBuoyKey)[2];
					if (!nextKeys.has(observationKey) || changedBuoys.has(observationKey)) timeBuoys.delete(key);
				}
				aggregates.put(partition.aggregate);
				for (const observation of partition.observations) {
					observations.put(observation);
					if (changedBuoys.has(observation.observationKey)) {
						for (const posting of buildTimeBuoyPostings(observation)) timeBuoys.put(posting);
					}
					const posting = buildPostingRecord(observation);
					const existingObservation = existingByKey.get(observation.observationKey);
					if (existingObservation === undefined
						|| existingObservation.time !== observation.time
						|| !sameLookupKeys(buildPostingRecord(existingObservation).lookupKeys, posting.lookupKeys)) {
						postings.put(posting);
					}
				}
			}
			const revision = (revisionRecord?.value ?? 0) + 1;
			metadata.put({ key: CATALOG_REVISION_META, value: revision } satisfies CatalogMetaRecord<number>);
			await done;
			if (generation === this.snapshotGeneration) this.fileChanges.record(revision, partitions.map(partition => partition.file.sourcePath));
			return revision;
		} catch (error) {
			try { transaction.abort(); } catch { /* 事务可能已结束，保留原始失败原因。 */ }
			await done.catch(() => undefined);
			throw error instanceof Error ? error : new Error(String(error));
		}
	}

	async deleteFilePartition(sourcePath: string): Promise<number> {
		await this.open();
		const generation = this.snapshotGeneration;
		const transaction = this.getDatabase().transaction(
			[FILES_STORE, OBSERVATIONS_STORE, POSTINGS_STORE, TIME_BUOYS_STORE, AGGREGATES_STORE, META_STORE],
			"readwrite",
		);
		const done = waitForTransaction(transaction);
		const files = transaction.objectStore(FILES_STORE);
		const observations = transaction.objectStore(OBSERVATIONS_STORE);
		const postings = transaction.objectStore(POSTINGS_STORE);
		const metadata = transaction.objectStore(META_STORE);
		const buoyKeysRequest = requestResult(transaction.objectStore(TIME_BUOYS_STORE).index(BY_SOURCE_PATH).getAllKeys(sourcePath));
		const fileRequest = (requestResult(files.get(sourcePath)) as Promise<CatalogFileRecord | undefined>)
			.then(async (file) => {
				if (file === undefined) return { file, observationKeys: [], postingKeys: [] };
				if (file.observationKeys !== undefined) {
					return { file, observationKeys: file.observationKeys, postingKeys: file.observationKeys };
				}
				const [observationKeys, postingKeys] = await Promise.all([
					requestResult(observations.index(BY_SOURCE_PATH).getAllKeys(sourcePath)),
					requestResult(postings.index(BY_SOURCE_PATH).getAllKeys(sourcePath)),
				]);
				return { file, observationKeys, postingKeys };
			});
		const [{ file, observationKeys, postingKeys }, revisionRecord, buoyKeys] = await Promise.all([
			fileRequest,
			requestResult(metadata.get(CATALOG_REVISION_META)) as Promise<CatalogMetaRecord<number> | undefined>,
			buoyKeysRequest,
		]);
		const currentRevision = revisionRecord?.value ?? 0;
		if (file === undefined) {
			await done;
			return currentRevision;
		}
		for (const key of observationKeys) observations.delete(key);
		for (const key of postingKeys) postings.delete(key);
		for (const key of buoyKeys) transaction.objectStore(TIME_BUOYS_STORE).delete(key);
		files.delete(sourcePath);
		transaction.objectStore(AGGREGATES_STORE).delete(sourcePath);
		const revision = currentRevision + 1;
		metadata.put({ key: CATALOG_REVISION_META, value: revision } satisfies CatalogMetaRecord<number>);
		await done;
		if (generation === this.snapshotGeneration) this.fileChanges.record(revision, [sourcePath]);
		return revision;
	}

	async getFile(sourcePath: string): Promise<CatalogFileRecord | null> {
		await this.open();
		const transaction = this.getDatabase().transaction(FILES_STORE, "readonly");
		const done = waitForTransaction(transaction);
		const file = await requestResult(transaction.objectStore(FILES_STORE).get(sourcePath)) as CatalogFileRecord | undefined;
		await done;
		return file ?? null;
	}

	async getFileRevisionBatch(sourcePath: string): Promise<CatalogFileRevisionBatch | null> {
		await this.open();
		const transaction = this.getDatabase().transaction([FILES_STORE, OBSERVATIONS_STORE, META_STORE], "readonly");
		const done = waitForTransaction(transaction);
		const [file, observations, revisionRecord] = await Promise.all([
			requestResult(transaction.objectStore(FILES_STORE).get(sourcePath)) as Promise<CatalogFileRecord | undefined>,
			requestResult(transaction.objectStore(OBSERVATIONS_STORE).index(BY_SOURCE_PATH).getAll(sourcePath)) as Promise<CatalogObservation[]>,
			requestResult(transaction.objectStore(META_STORE).get(CATALOG_REVISION_META)) as Promise<CatalogMetaRecord<number> | undefined>,
		]);
		await done;
		if (file === undefined) return null;
		return {
			file,
			observations: observations.sort((left, right) => left.observationKey.localeCompare(right.observationKey)),
			catalogRevision: revisionRecord?.value ?? 0,
		};
	}

	async getObservation(observationKey: string): Promise<CatalogObservation | null> {
		await this.open();
		const transaction = this.getDatabase().transaction(OBSERVATIONS_STORE, "readonly");
		const done = waitForTransaction(transaction);
		const observation = await requestResult(transaction.objectStore(OBSERVATIONS_STORE).get(observationKey)) as CatalogObservation | undefined;
		await done;
		return observation ?? null;
	}

	async listFiles(): Promise<CatalogFileRecord[]> {
		await this.open();
		const transaction = this.getDatabase().transaction(FILES_STORE, "readonly");
		const done = waitForTransaction(transaction);
		const files = await requestResult(transaction.objectStore(FILES_STORE).getAll()) as CatalogFileRecord[];
		await done;
		return files.sort((left, right) => left.sourcePath.localeCompare(right.sourcePath));
	}

	async queryTimeBuoys(request: TimeBuoyPageRequest): Promise<TimeBuoyObservationPage> {
		await this.open();
		const transaction = this.getDatabase().transaction([TIME_BUOYS_STORE, OBSERVATIONS_STORE, META_STORE], "readonly");
		const done = waitForTransaction(transaction);
		try {
			const metadata = transaction.objectStore(META_STORE);
			const [revisionRecord, coverageRecord] = await Promise.all([
				requestResult(metadata.get(CATALOG_REVISION_META)) as Promise<CatalogMetaRecord<number> | undefined>,
				requestResult(metadata.get(COVERAGE_META)) as Promise<CatalogMetaRecord<CatalogCoverage> | undefined>,
			]);
			const catalogRevision = revisionRecord?.value ?? 0;
			const coverage = coverageRecord?.value ?? { ...DEFAULT_CATALOG_COVERAGE };
			// 完全同时间时保留 IndexedDB key 倒序；时间仍使用原始分钟或秒文本。
			const selection = new TimeBuoyPageSelection(request, catalogRevision, coverage,
				(left, right) => left === right ? 0 : left > right ? -1 : 1);
			const cursorReads = selection.invalidated ? 0 : await readTimeBuoyCandidates(
				transaction.objectStore(TIME_BUOYS_STORE), this.getKeyRange(), request, selection);
			const observations = transaction.objectStore(OBSERVATIONS_STORE);
			const items = await Promise.all(selection.items.slice(0, selection.limit).map((item) =>
				requestResult(observations.get(item.observationKey)) as Promise<CatalogObservation>));
			await done;
			return { items, nextCursor: selection.nextCursor, catalogRevision, coverage,
				lifecycle: this.getLifecycle(), invalidated: selection.invalidated,
				metrics: { cursorReads, observationsRead: items.length, returned: items.length } };
		} catch (error) {
			await done.catch(() => undefined);
			throw error instanceof Error ? error : new Error(String(error));
		}
	}

	async query(request: CatalogQuery): Promise<CatalogQueryPage> {
		request = { ...request, ...narrowCatalogQuery(request), text: undefined, textTerms: getCatalogTextTerms(request) };
		await this.open();
		const database = this.getDatabase();
		const keyRange = this.getKeyRange();
		return new Promise<CatalogQueryPage>((resolve, reject) => {
			const transaction = database.transaction([OBSERVATIONS_STORE, POSTINGS_STORE, META_STORE], "readonly");
			const observations = transaction.objectStore(OBSERVATIONS_STORE);
			const metadata = transaction.objectStore(META_STORE);
			const revisionRequest = metadata.get(CATALOG_REVISION_META);
			const coverageRequest = metadata.get(COVERAGE_META);
			const limit = clampPageLimit(request.limit);
			const matches = createCatalogQueryMatcher(request);
			const items: CatalogObservation[] = [];
			let cursorReads = 0;
			let observationsRead = 0;
			let catalogRevision = 0;
			let coverage: CatalogCoverage = { ...DEFAULT_CATALOG_COVERAGE };
			let invalidated = false;
			let started = false;

			const startCursor = () => {
				if (started || revisionRequest.readyState !== "done" || coverageRequest.readyState !== "done") {
					return;
				}
				started = true;
				catalogRevision = (revisionRequest.result as CatalogMetaRecord<number> | undefined)?.value ?? 0;
				coverage = (coverageRequest.result as CatalogMetaRecord<CatalogCoverage> | undefined)?.value
					?? { ...DEFAULT_CATALOG_COVERAGE };
				if (request.cursor !== undefined && request.cursor !== null
					&& request.cursor.catalogRevision !== catalogRevision) {
					invalidated = true;
					return;
				}

				if (request.matchNone) return;
				const startSelectedCursor = (selection: CatalogIndexSelection | null) => {
					try {
						if (selection === null) {
							const range = buildObservationRange(keyRange, request);
							const cursorRequest = observations.index(BY_CREATED_AT).openCursor(range, "prev");
							cursorRequest.onsuccess = () => {
								const cursor = cursorRequest.result;
								if (cursor === null || items.length > limit) {
									return;
								}
								cursorReads += 1;
								observationsRead += 1;
								const observation = cursor.value as CatalogObservation;
								if (matches(observation)) {
									items.push(observation);
								}
								if (items.length <= limit) {
									cursor.continue();
								}
							};
						} else {
							const range = buildPostingRange(keyRange, request, selection);
							const cursorRequest = transaction.objectStore(POSTINGS_STORE).index(BY_LOOKUP).openCursor(range, "prev");
							cursorRequest.onsuccess = () => {
								const cursor = cursorRequest.result;
								if (cursor === null || items.length > limit) {
									return;
								}
								cursorReads += 1;
								const posting = cursor.value as CatalogPostingRecord;
								const observationRequest = observations.get(posting.observationKey);
								observationRequest.onsuccess = () => {
									const observation = observationRequest.result as CatalogObservation | undefined;
									if (observation !== undefined) {
										observationsRead += 1;
										if (matches(observation)) {
											items.push(observation);
										}
									}
									if (items.length <= limit) {
										cursor.continue();
									}
								};
							};
						}
					} catch (error) {
						transaction.abort();
						reject(error instanceof Error ? error : new Error(String(error)));
					}
				};
				try {
					selectCatalogIndex(transaction.objectStore(POSTINGS_STORE).index(BY_LOOKUP), request,
						selection => buildPostingRange(keyRange, request, selection), startSelectedCursor);
				} catch (error) {
					transaction.abort();
					reject(error instanceof Error ? error : new Error(String(error)));
				}
			};

			revisionRequest.onsuccess = startCursor;
			coverageRequest.onsuccess = startCursor;
			transaction.oncomplete = () => {
				if (invalidated) {
					resolve(emptyInvalidatedPage(catalogRevision, coverage, this.getLifecycle()));
					return;
				}
				const hasNext = items.length > limit;
				const pageItems = items.slice(0, limit);
				const last = pageItems[pageItems.length - 1];
				resolve({
					items: pageItems,
					nextCursor: hasNext && last !== undefined ? {
						catalogRevision,
						createdAtKey: last.createdAtKey,
						observationKey: last.observationKey,
					} : null,
					catalogRevision,
					coverage,
					lifecycle: this.getLifecycle(),
					metrics: { cursorReads, observationsRead, returned: pageItems.length },
					invalidated: false,
				});
			};
			transaction.onerror = () => reject(transaction.error ?? new Error("Memo Catalog query failed."));
			transaction.onabort = () => reject(transaction.error ?? new Error("Memo Catalog query aborted."));
		});
	}

	async count(request: CatalogQueryFilter, signal?: AbortSignal): Promise<CatalogQueryCountResult> {
		request = { ...narrowCatalogQuery(request), text: undefined, textTerms: getCatalogTextTerms(request) };
		signal?.throwIfAborted();
		await this.open();
		signal?.throwIfAborted();
		const database = this.getDatabase();
		const keyRange = this.getKeyRange();
		return new Promise<CatalogQueryCountResult>((resolve, reject) => {
			const transaction = database.transaction([OBSERVATIONS_STORE, POSTINGS_STORE, META_STORE], "readonly");
			const abort = () => {
				try { transaction.abort(); }
				catch { cleanup(); reject(createCatalogCountAbortError(signal)); }
			};
			const cleanup = () => signal?.removeEventListener("abort", abort);
			signal?.addEventListener("abort", abort, { once: true });
			const observations = transaction.objectStore(OBSERVATIONS_STORE);
			const metadata = transaction.objectStore(META_STORE);
			const revisionRequest = metadata.get(CATALOG_REVISION_META);
			const coverageRequest = metadata.get(COVERAGE_META);
			const matches = createCatalogQueryMatcher(request);
			let count = 0;
			let catalogRevision = 0;
			let coverage: CatalogCoverage = { ...DEFAULT_CATALOG_COVERAGE };
			let started = false;

			const startCursor = () => {
				if (signal?.aborted || started || revisionRequest.readyState !== "done" || coverageRequest.readyState !== "done") {
					return;
				}
				started = true;
				catalogRevision = (revisionRequest.result as CatalogMetaRecord<number> | undefined)?.value ?? 0;
				coverage = (coverageRequest.result as CatalogMetaRecord<CatalogCoverage> | undefined)?.value
					?? { ...DEFAULT_CATALOG_COVERAGE };
				if (request.matchNone) return;
				const startSelectedCursor = (selection: CatalogIndexSelection | null) => {
					if (signal?.aborted) return;
					try {
						if (selection === null) {
							const range = buildObservationCountRange(keyRange, request);
							const cursorRequest = observations.index(BY_CREATED_AT).openCursor(range, "prev");
							cursorRequest.onsuccess = () => {
								if (signal?.aborted) return;
								const cursor = cursorRequest.result;
								if (cursor === null) return;
								const observation = cursor.value as CatalogObservation;
								if (matches(observation)) count += 1;
								cursor.continue();
							};
						} else {
							const range = buildPostingCountRange(keyRange, request, selection);
							const cursorRequest = transaction.objectStore(POSTINGS_STORE).index(BY_LOOKUP).openCursor(range, "prev");
							cursorRequest.onsuccess = () => {
								if (signal?.aborted) return;
								const cursor = cursorRequest.result;
								if (cursor === null) return;
								const posting = cursor.value as CatalogPostingRecord;
								const observationRequest = observations.get(posting.observationKey);
								observationRequest.onsuccess = () => {
									if (signal?.aborted) return;
									const observation = observationRequest.result as CatalogObservation | undefined;
									if (observation !== undefined && matches(observation)) {
										count += 1;
									}
									cursor.continue();
								};
							};
						}
					} catch (error) {
						transaction.abort();
						reject(error instanceof Error ? error : new Error(String(error)));
					}
				};
				try {
					if (canCountObservationRange(request)) {
						const countRequest = observations.index(BY_CREATED_AT).count(buildObservationCountRange(keyRange, request));
						countRequest.onsuccess = () => { count = countRequest.result; };
						return;
					}
					selectCatalogIndex(transaction.objectStore(POSTINGS_STORE).index(BY_LOOKUP), request,
						selection => buildPostingCountRange(keyRange, request, selection), startSelectedCursor);
				} catch (error) {
					transaction.abort();
					reject(error instanceof Error ? error : new Error(String(error)));
				}
			};

			revisionRequest.onsuccess = startCursor;
			coverageRequest.onsuccess = startCursor;
			transaction.oncomplete = () => {
				cleanup();
				resolve({ count, catalogRevision, coverage, lifecycle: this.getLifecycle() });
			};
			transaction.onerror = () => {
				cleanup();
				reject(transaction.error ?? new Error("Memo Catalog count failed."));
			};
			transaction.onabort = () => {
				cleanup();
				reject(signal?.aborted ? createCatalogCountAbortError(signal) : transaction.error ?? new Error("Memo Catalog count aborted."));
			};
		});
	}

	async listDailyAggregates(fromDate?: string, toDate?: string): Promise<CatalogDailyAggregate[]> {
		await this.open();
		const database = this.getDatabase();
		const keyRange = this.getKeyRange();
		return new Promise<CatalogDailyAggregate[]>((resolve, reject) => {
			const transaction = database.transaction(AGGREGATES_STORE, "readonly");
			const byDate = new Map<string, CatalogDailyAggregate>();
			const range = fromDate === undefined && toDate === undefined
				? null
				: keyRange.bound(fromDate ?? "", toDate ?? "\uffff");
			const request = transaction.objectStore(AGGREGATES_STORE).index(BY_LOGICAL_DATE).openCursor(range, "prev");
			request.onsuccess = () => {
				const cursor = request.result;
				if (cursor === null) {
					return;
				}
				mergeAggregate(byDate, cursor.value as CatalogFileAggregate);
				cursor.continue();
			};
			transaction.oncomplete = () => resolve([...byDate.values()]
				.sort((left, right) => right.logicalDate.localeCompare(left.logicalDate)));
			transaction.onerror = () => reject(transaction.error ?? new Error("Memo Catalog aggregate query failed."));
			transaction.onabort = () => reject(transaction.error ?? new Error("Memo Catalog aggregate query aborted."));
		});
	}

	async readAggregateSnapshot(): Promise<CatalogAggregateSnapshot> {
		const generation = this.snapshotGeneration;
		await this.open();
		const database = this.getDatabase();
		const lifecycle = this.getLifecycle();
		return new Promise((resolve, reject) => {
			const transaction = database.transaction([AGGREGATES_STORE, META_STORE], "readonly");
			const metadata = transaction.objectStore(META_STORE);
			const revision = metadata.get(CATALOG_REVISION_META);
			const coverage = metadata.get(COVERAGE_META);
			const byDate = new Map<string, CatalogDailyAggregate>();
			const request = transaction.objectStore(AGGREGATES_STORE).index(BY_LOGICAL_DATE).openCursor(null, "prev");
			request.onsuccess = () => {
				const cursor = request.result;
				if (cursor === null) return;
				mergeAggregate(byDate, cursor.value as CatalogFileAggregate);
				cursor.continue();
			};
			transaction.oncomplete = () => resolve({
				aggregates: [...byDate.values()].sort((left, right) => right.logicalDate.localeCompare(left.logicalDate)),
				catalogRevision: (revision.result as CatalogMetaRecord<number> | undefined)?.value ?? 0,
				coverage: (coverage.result as CatalogMetaRecord<CatalogCoverage> | undefined)?.value ?? { ...DEFAULT_CATALOG_COVERAGE },
				lifecycle,
				invalidated: generation !== this.snapshotGeneration || this.database !== database
					|| JSON.stringify(lifecycle) !== JSON.stringify(this.getLifecycle()),
			});
			transaction.onerror = () => reject(transaction.error ?? new Error("Catalog aggregate snapshot failed."));
			transaction.onabort = () => reject(transaction.error ?? new Error("Catalog aggregate snapshot aborted."));
		});
	}

	async getCoverage(): Promise<CatalogCoverage> {
		return (await this.getMeta<CatalogCoverage>(COVERAGE_META)) ?? { ...DEFAULT_CATALOG_COVERAGE };
	}

	setCoverage(coverage: CatalogCoverage): Promise<void> {
		return this.saveScanProgress(coverage, []);
	}

	async saveScanProgress(coverage: CatalogCoverage, metadata: readonly CatalogMetaEntry[]): Promise<void> {
		if (coverage.kind === "rebuilding") {
			this.lifecycle = { state: "rebuilding", persistent: true, writable: true, reason: null };
		}
		await this.open();
		const transaction = this.getDatabase().transaction(META_STORE, "readwrite");
		const done = waitForTransaction(transaction);
		const store = transaction.objectStore(META_STORE);
		store.put({ key: COVERAGE_META, value: coverage } satisfies CatalogMetaRecord<CatalogCoverage>);
		for (const entry of metadata) {
			store.put({ key: entry.key, value: entry.value } satisfies CatalogMetaRecord);
		}
		await done;
		if (coverage.kind !== "rebuilding") {
			this.lifecycle = { state: "ready", persistent: true, writable: true, reason: null };
		}
	}

	async getMeta<T>(key: string): Promise<T | null> {
		await this.open();
		const transaction = this.getDatabase().transaction(META_STORE, "readonly");
		const done = waitForTransaction(transaction);
		const record = await requestResult(transaction.objectStore(META_STORE).get(key)) as CatalogMetaRecord<T> | undefined;
		await done;
		return record?.value ?? null;
	}

	async setMeta<T>(key: string, value: T): Promise<void> {
		await this.open();
		const transaction = this.getDatabase().transaction(META_STORE, "readwrite");
		const done = waitForTransaction(transaction);
		transaction.objectStore(META_STORE).put({ key, value } satisfies CatalogMetaRecord<T>);
		await done;
	}

	async deleteMeta(key: string): Promise<void> {
		await this.open();
		const transaction = this.getDatabase().transaction(META_STORE, "readwrite");
		const done = waitForTransaction(transaction);
		transaction.objectStore(META_STORE).delete(key);
		await done;
	}

	async clear(preserveMetaKeys: readonly string[] = []): Promise<void> {
		this.snapshotGeneration++;
		this.fileChanges.clear();
		await this.open();
		const transaction = this.getDatabase().transaction(
			[FILES_STORE, OBSERVATIONS_STORE, POSTINGS_STORE, TIME_BUOYS_STORE, AGGREGATES_STORE, META_STORE],
			"readwrite",
		);
		const done = waitForTransaction(transaction);
		const metaStore = transaction.objectStore(META_STORE);
		const revisionRequest = requestResult(metaStore.get(CATALOG_REVISION_META)) as
			Promise<CatalogMetaRecord<number> | undefined>;
		const preservedRequests = [...new Set(preserveMetaKeys)].map((key) =>
			requestResult(metaStore.get(key)) as Promise<CatalogMetaRecord<unknown> | undefined>);
		const revisionRecord = await revisionRequest;
		const preservedRecords = await Promise.all(preservedRequests);
		for (const storeName of [FILES_STORE, OBSERVATIONS_STORE, POSTINGS_STORE, TIME_BUOYS_STORE, AGGREGATES_STORE, META_STORE]) {
			transaction.objectStore(storeName).clear();
		}
		for (const record of preservedRecords) {
			if (record !== undefined) metaStore.put(record);
		}
		metaStore.put({
			key: CATALOG_REVISION_META,
			value: (revisionRecord?.value ?? 0) + 1,
		} satisfies CatalogMetaRecord<number>);
		metaStore.put({ key: COVERAGE_META, value: DEFAULT_CATALOG_COVERAGE } satisfies CatalogMetaRecord<CatalogCoverage>);
		await done;
	}

	private getDatabase(): IDBDatabase {
		if (this.database === null) {
			throw new Error("Memo Catalog IndexedDB is not open.");
		}
		return this.database;
	}

	private getKeyRange(): typeof IDBKeyRange {
		if (this.keyRange === undefined) {
			throw new Error("IDBKeyRange is unavailable.");
		}
		return this.keyRange;
	}

	async getCatalogRevision(): Promise<number> {
		await this.open();
		return (await this.getMeta<number>(CATALOG_REVISION_META)) ?? 0;
	}
}

function openCatalogDatabase(
	factory: IDBFactory,
	databaseName: string,
	version: number,
	beforeUpgrade: (() => void) | undefined,
): Promise<IDBDatabase> {
	return new Promise<IDBDatabase>((resolve, reject) => {
		const request = factory.open(databaseName, version);
		let settled = false;
		let upgradeError: Error | null = null;
		request.onupgradeneeded = (event) => {
			try {
				createCatalogSchema(request.result, request.transaction, event.oldVersion);
				beforeUpgrade?.();
			} catch (error) {
				upgradeError = error instanceof Error ? error : new Error(String(error));
				request.transaction?.abort();
			}
		};
		request.onblocked = () => {
			if (!settled) {
				settled = true;
				reject(new CatalogDatabaseBlockedError());
			}
		};
		request.onerror = () => {
			if (!settled) {
				settled = true;
				reject(upgradeError ?? request.error ?? new Error("Memo Catalog IndexedDB open failed."));
			}
		};
		request.onsuccess = () => {
			if (settled) {
				request.result.close();
				return;
			}
			try {
				validateCatalogSchema(request.result);
				settled = true;
				resolve(request.result);
			} catch (error) {
				request.result.close();
				settled = true;
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		};
	});
}

function createCatalogSchema(database: IDBDatabase, transaction: IDBTransaction | null, oldVersion: number): void {
	if (oldVersion > 0 && oldVersion < CATALOG_DATABASE_VERSION) {
		const storeNames: string[] = [];
		for (let index = 0; index < database.objectStoreNames.length; index += 1) {
			const storeName = database.objectStoreNames.item(index);
			if (storeName !== null) {
				storeNames.push(storeName);
			}
		}
		for (const storeName of storeNames) {
			database.deleteObjectStore(storeName);
		}
	}
	if (!database.objectStoreNames.contains(FILES_STORE)) {
		database.createObjectStore(FILES_STORE, { keyPath: "sourcePath" });
	}
	if (!database.objectStoreNames.contains(OBSERVATIONS_STORE)) {
		const observations = database.createObjectStore(OBSERVATIONS_STORE, { keyPath: "observationKey" });
		observations.createIndex(BY_SOURCE_PATH, "sourcePath", { unique: false });
		observations.createIndex(BY_CREATED_AT, ["createdAtKey", "observationKey"], { unique: true });
		observations.createIndex(BY_LOGICAL_DATE, "logicalDate", { unique: false });
	}
	if (!database.objectStoreNames.contains(POSTINGS_STORE)) {
		const postings = database.createObjectStore(POSTINGS_STORE, { keyPath: "postingKey" });
		postings.createIndex(BY_SOURCE_PATH, "sourcePath", { unique: false });
		postings.createIndex(BY_LOOKUP, "lookupKeys", { unique: false, multiEntry: true });
	}
	if (!database.objectStoreNames.contains(TIME_BUOYS_STORE)) {
		const timeBuoys = database.createObjectStore(TIME_BUOYS_STORE, { keyPath: "key" });
		timeBuoys.createIndex(BY_SOURCE_PATH, "sourcePath", { unique: false });
		timeBuoys.createIndex(BY_TARGET_DATE, "targetDate", { unique: false });
		timeBuoys.createIndex(BY_NEIGHBOR_DATE, "neighborKeys", { unique: false, multiEntry: true });
	}
	if (!database.objectStoreNames.contains(AGGREGATES_STORE)) {
		const aggregates = database.createObjectStore(AGGREGATES_STORE, { keyPath: "sourcePath" });
		aggregates.createIndex(BY_LOGICAL_DATE, "logicalDate", { unique: false });
	}
	if (!database.objectStoreNames.contains(META_STORE)) {
		database.createObjectStore(META_STORE, { keyPath: "key" });
	}
	if (transaction === null) {
		throw new CatalogDatabaseCorruptError("Memo Catalog schema upgrade has no transaction.");
	}
}

function validateCatalogSchema(database: IDBDatabase): void {
	for (const storeName of [FILES_STORE, OBSERVATIONS_STORE, POSTINGS_STORE, TIME_BUOYS_STORE, AGGREGATES_STORE, META_STORE]) {
		if (!database.objectStoreNames.contains(storeName)) {
			throw new CatalogDatabaseCorruptError(`Memo Catalog store is missing: ${storeName}.`);
		}
	}
	const transaction = database.transaction([OBSERVATIONS_STORE, POSTINGS_STORE, TIME_BUOYS_STORE, AGGREGATES_STORE], "readonly");
	const expectedIndexes = [
		[OBSERVATIONS_STORE, [BY_SOURCE_PATH, BY_CREATED_AT, BY_LOGICAL_DATE]],
		[POSTINGS_STORE, [BY_SOURCE_PATH, BY_LOOKUP]],
		[TIME_BUOYS_STORE, [BY_SOURCE_PATH, BY_TARGET_DATE, BY_NEIGHBOR_DATE]],
		[AGGREGATES_STORE, [BY_LOGICAL_DATE]],
	] as const;
	for (const [storeName, indexes] of expectedIndexes) {
		const store = transaction.objectStore(storeName);
		for (const indexName of indexes) {
			if (!store.indexNames.contains(indexName)) {
				throw new CatalogDatabaseCorruptError(`Memo Catalog index is missing: ${storeName}.${indexName}.`);
			}
		}
	}
}

function deleteCatalogDatabase(factory: IDBFactory, databaseName: string): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const request = factory.deleteDatabase(databaseName);
		request.onsuccess = () => resolve();
		request.onerror = () => reject(request.error ?? new Error("Memo Catalog IndexedDB delete failed."));
		request.onblocked = () => reject(new CatalogDatabaseBlockedError());
	});
}

function buildPostingRecord(observation: CatalogObservation): CatalogPostingRecord {
	const entries: Array<[CatalogPostingKind, string]> = [];
	for (const tag of observation.tagKeys) {
		for (const lookupTag of buildTagLookupValues(tag)) {
			entries.push(["tag", lookupTag]);
		}
	}
	for (const token of observation.searchTokens) {
		entries.push(["search", token]);
	}
	for (const target of observation.linkTargets) {
		entries.push(["link", `target:${target}`]);
	}
	entries.push(["link", `has:${observation.hasLink}`]);
	for (const path of observation.imagePaths) {
		entries.push(["image", `path:${path}`]);
	}
	entries.push(["image", `has:${observation.hasImage}`]);
	entries.push(["task", `has:${observation.hasTask}`]);
	for (const date of observation.timeBuoyDates) {
		entries.push(["timeBuoy", `date:${date}`]);
	}
	entries.push(["timeBuoy", `has:${observation.hasTimeBuoy}`]);
	for (const target of observation.explicitReferenceTargets) {
		entries.push(["reference", `target:${target}`]);
	}
	const lookupKeys = [...new Set(entries.map(([kind, value]) => buildLookupKey(
		kind,
		value,
		observation.createdAtKey,
		observation.observationKey,
	)))];
	return {
		postingKey: observation.observationKey,
		sourcePath: observation.sourcePath,
		observationKey: observation.observationKey,
		lookupKeys,
	};
}

function sameTimeBuoyPosting(left: CatalogObservation, right: CatalogObservation): boolean {
	return left.time === right.time && left.logicalDate === right.logicalDate
		&& sameLookupKeys([...new Set(left.timeBuoyDates)].sort(), [...new Set(right.timeBuoyDates)].sort());
}

function buildTimeBuoyPostings(observation: CatalogObservation): TimeBuoyPostingRecord[] {
	const dates = [...new Set(observation.timeBuoyDates)].sort();
	return dates.map((date, index) => {
		const previousDate = dates[index - 1] ?? "", nextDate = dates[index + 1] ?? "\uffff";
		return {
			key: [date, observation.logicalDate + "T" + observation.time, observation.observationKey, previousDate, nextDate],
			targetDate: date, sourcePath: observation.sourcePath,
			neighborKeys: [[date, "previous", previousDate], [date, "next", nextDate]],
		};
	});
}

// 先按目标日定位，再按原始记录时间倒序取页；只读取轻量 key 和当前页正文。
function readTimeBuoyCandidates(store: IDBObjectStore, keyRange: typeof IDBKeyRange, request: TimeBuoyPageRequest, selection: TimeBuoyPageSelection): Promise<number> {
	return new Promise((resolve, reject) => {
		let reads = 0;
		const fail = (error: unknown) => reject(error instanceof Error ? error : new Error(String(error)));
		const readDate = (date: string, nextDate: () => void) => {
			const neighborRange = request.tab === "today" ? null : request.tab === "upcoming"
				? keyRange.bound([date, "previous", ""], [date, "previous", request.today])
				: keyRange.bound([date, "next", request.today], [date, "next", "\uffff"]);
			const addCandidate = ([targetDate, createdAtKey, observationKey]: TimeBuoyKey) =>
				selection.add({ observationKey, createdAtKey, timeBuoyDates: [targetDate] });
			const finishDate = () => { if (selection.items.length > selection.limit) resolve(reads); else nextDate(); };
			const readEligibleCandidates = (range: IDBKeyRange, boundary: IDBValidKey) => {
				const remainingRange = keyRange.upperBound(boundary, true);
				const eligible = store.index(BY_NEIGHBOR_DATE).openKeyCursor(range, "prev");
				eligible.onerror = () => fail(eligible.error ?? new Error("Memo Catalog time buoy query failed."));
				eligible.onsuccess = () => {
					try {
						const cursor = eligible.result;
						if (cursor === null) { finishDate(); return; }
						reads++;
						if (remainingRange.includes(cursor.primaryKey)) addCandidate(cursor.primaryKey as TimeBuoyKey);
						cursor.continue();
					} catch (error) { fail(error); }
				};
			};
			const readCandidates = () => {
				const boundary = request.cursor?.primaryTargetDate === date ? request.cursor : null;
				const upper = boundary === null ? [date, "\uffff"] : [date, boundary.createdAtKey, boundary.observationKey];
				const cursorRequest = store.openKeyCursor(keyRange.bound([date], upper, false, boundary !== null), "prev");
				let skipped = 0;
				cursorRequest.onerror = () => fail(cursorRequest.error ?? new Error("Memo Catalog time buoy query failed."));
				cursorRequest.onsuccess = () => {
					try {
						const cursor = cursorRequest.result;
						if (cursor === null) { finishDate(); return; }
						reads++;
						const key = cursor.key as TimeBuoyKey;
						if (request.tab === "today" || (request.tab === "upcoming" ? key[3] <= request.today : key[4] >= request.today)) addCandidate(key);
						else skipped++;
						if (selection.items.length > selection.limit) resolve(reads);
						// 重复项达到两页时改扫有效区间；切换边界排除已处理项，选页仍只保留 limit + 1 项。
						else if (neighborRange !== null && skipped >= selection.limit * 2) readEligibleCandidates(neighborRange, cursor.key);
						else cursor.continue();
					} catch (error) { fail(error); }
				};
			};
			if (neighborRange === null) { readCandidates(); return; }
			// 原生索引探测跳过没有最近目标的日期组，避免末页重扫全部重复日期。
			const probe = store.index(BY_NEIGHBOR_DATE).getKey(neighborRange);
			probe.onerror = () => fail(probe.error ?? new Error("Memo Catalog time buoy query failed."));
			probe.onsuccess = () => {
				try { if (probe.result === undefined) nextDate(); else readCandidates(); }
				catch (error) { fail(error); }
			};
		};
		if (request.tab === "today") { readDate(request.today, () => resolve(reads)); return; }
		const range = request.tab === "upcoming"
			? keyRange.lowerBound(request.cursor?.primaryTargetDate ?? request.today, request.cursor == null)
			: keyRange.upperBound(request.cursor?.primaryTargetDate ?? request.today, request.cursor == null);
		const cursorRequest = store.index(BY_TARGET_DATE).openKeyCursor(range, request.tab === "upcoming" ? "nextunique" : "prevunique");
		cursorRequest.onerror = () => fail(cursorRequest.error ?? new Error("Memo Catalog time buoy query failed."));
		cursorRequest.onsuccess = () => {
			try {
				const cursor = cursorRequest.result;
				if (cursor === null) { resolve(reads); return; }
				reads++;
				readDate(String(cursor.key), () => cursor.continue());
			} catch (error) { fail(error); }
		};
	});
}

function buildTagLookupValues(tag: string): string[] {
	const values = [tag];
	for (let index = 0; index < tag.length; index += 1) {
		if (tag[index] === "/" && index > 0) {
			values.push(tag.slice(0, index));
		}
	}
	return [...new Set(values)];
}

function sameLookupKeys(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function getCatalogIndexCandidates(request: CatalogQueryFilter): CatalogIndexSelection[] {
	const candidates: CatalogIndexSelection[] = [];
	for (const tag of request.tags?.map(normalizeCatalogText).filter(Boolean) ?? []) candidates.push({ kind: "tag", value: tag });
	for (const term of getCatalogTextTerms(request)) {
		const token = selectCatalogSearchToken(term);
		if (token !== null) candidates.push({ kind: "search", value: token });
	}
	if (request.linkTarget !== undefined) candidates.push({ kind: "link", value: "target:" + normalizeCatalogText(request.linkTarget) });
	if (request.hasLink !== undefined) candidates.push({ kind: "link", value: "has:" + (request.hasLink ? 1 : 0) });
	if (request.imagePath !== undefined) candidates.push({ kind: "image", value: "path:" + normalizeCatalogText(request.imagePath) });
	if (request.hasImage !== undefined) candidates.push({ kind: "image", value: "has:" + (request.hasImage ? 1 : 0) });
	if (request.hasTask !== undefined) candidates.push({ kind: "task", value: "has:" + (request.hasTask ? 1 : 0) });
	if (request.timeBuoyDate !== undefined) candidates.push({ kind: "timeBuoy", value: "date:" + request.timeBuoyDate });
	if (request.hasTimeBuoy !== undefined) candidates.push({ kind: "timeBuoy", value: "has:" + (request.hasTimeBuoy ? 1 : 0) });
	if (request.explicitReferenceTarget !== undefined) candidates.push({ kind: "reference", value: "target:" + request.explicitReferenceTarget });
	return candidates.filter((candidate, index) => candidates.findIndex(other => other.kind === candidate.kind && other.value === candidate.value) === index);
}

function selectCatalogIndex(index: IDBIndex, request: CatalogQueryFilter, range: (selection: CatalogIndexSelection) => IDBKeyRange,
	onSelected: (selection: CatalogIndexSelection | null) => void): void {
	const candidates = getCatalogIndexCandidates(request);
	if (candidates.length <= 1) { onSelected(candidates[0] ?? null); return; }
	const counts = candidates.map(candidate => index.count(range(candidate)));
	let remaining = counts.length;
	for (const count of counts) count.onsuccess = () => {
		if (--remaining !== 0) return;
		let selected = 0;
		for (let i = 1; i < counts.length; i++) if (counts[i].result < counts[selected].result) selected = i;
		onSelected(candidates[selected]);
	};
}

function canCountObservationRange(request: CatalogQueryFilter): boolean {
	return Object.entries(request).every(([key, value]) => value === undefined
		|| key === "fromDate" || key === "toDate" || key === "matchNone"
		|| key === "searchDate" && request.searchDate?.kind === "range"
		|| (key === "textTerms" || key === "tags") && Array.isArray(value) && value.length === 0);
}

function buildObservationCountRange(
	keyRange: typeof IDBKeyRange,
	request: CatalogQueryFilter,
): IDBKeyRange {
	return keyRange.bound(
		[request.fromDate === undefined ? "" : `${request.fromDate}T`, ""],
		[`${request.toDate ?? "\uffff"}T\uffff`, "\uffff"],
	);
}

function buildPostingCountRange(
	keyRange: typeof IDBKeyRange,
	request: CatalogQueryFilter,
	selection: CatalogIndexSelection,
): IDBKeyRange {
	const prefix = buildLookupPrefix(selection.kind, selection.value);
	return keyRange.bound(
		`${prefix}${request.fromDate === undefined ? "" : `${request.fromDate}T`}\0`,
		`${prefix}${request.toDate ?? "\uffff"}T\uffff\0\uffff`,
	);
}

function buildObservationRange(keyRange: typeof IDBKeyRange, request: CatalogQuery): IDBKeyRange {
	const lower = [request.fromDate === undefined ? "" : `${request.fromDate}T`, ""];
	const cursor = request.cursor;
	const upper = cursor === undefined || cursor === null
		? [`${request.toDate ?? "\uffff"}T\uffff`, "\uffff"]
		: [cursor.createdAtKey, cursor.observationKey];
	return keyRange.bound(lower, upper, false, cursor !== undefined && cursor !== null);
}

function buildPostingRange(
	keyRange: typeof IDBKeyRange,
	request: CatalogQuery,
	selection: CatalogIndexSelection,
): IDBKeyRange {
	const prefix = buildLookupPrefix(selection.kind, selection.value);
	const lower = `${prefix}${request.fromDate === undefined ? "" : `${request.fromDate}T`}\0`;
	const cursor = request.cursor;
	const upper = cursor === undefined || cursor === null
		? `${prefix}${request.toDate ?? "\uffff"}T\uffff\0\uffff`
		: `${prefix}${cursor.createdAtKey}\0${cursor.observationKey}`;
	return keyRange.bound(lower, upper, false, cursor !== undefined && cursor !== null);
}

function buildLookupKey(
	kind: CatalogPostingKind,
	value: string,
	createdAtKey: string,
	observationKey: string,
): string {
	return `${buildLookupPrefix(kind, value)}${createdAtKey}\0${observationKey}`;
}

function buildLookupPrefix(kind: CatalogPostingKind, value: string): string {
	return `${kind}\0${encodeURIComponent(value)}\0`;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error("Memo Catalog IndexedDB request failed."));
	});
}

function waitForTransaction(transaction: IDBTransaction): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		transaction.oncomplete = () => resolve();
		transaction.onerror = () => reject(transaction.error ?? new Error("Memo Catalog IndexedDB transaction failed."));
		transaction.onabort = () => reject(transaction.error ?? new Error("Memo Catalog IndexedDB transaction aborted."));
	});
}

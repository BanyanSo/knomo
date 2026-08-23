import type {
	CatalogCoverage,
	CatalogDailyAggregate,
	CatalogFileAggregate,
	CatalogFilePartition,
	CatalogFileRecord,
	CatalogFileRevisionBatch,
	CatalogObservation,
	CatalogPostingKind,
	CatalogQuery,
	CatalogQueryPage,
	CatalogStoreLifecycle,
	CatalogV2ResolutionSnapshot,
} from "../types/catalog";
import {
	clampPageLimit,
	DEFAULT_CATALOG_COVERAGE,
	emptyInvalidatedPage,
	matchesCatalogQuery,
	mergeAggregate,
	normalizeCatalogText,
} from "./MemoCatalogStore";
import type { MemoCatalogStore } from "./MemoCatalogStore";
import { selectCatalogSearchToken } from "./MemoCatalogService";

const CATALOG_DATABASE_VERSION = 2;
const FILES_STORE = "files";
const OBSERVATIONS_STORE = "observations";
const POSTINGS_STORE = "postings";
const AGGREGATES_STORE = "aggregates";
const META_STORE = "meta";
const BY_SOURCE_PATH = "bySourcePath";
const BY_CREATED_AT = "byCreatedAt";
const BY_LOOKUP = "byLookup";
const BY_LOGICAL_DATE = "byLogicalDate";
const CATALOG_REVISION_META = "catalogRevision";
const COVERAGE_META = "coverage";
const RESOLUTION_SNAPSHOT_META = "catalogV2ResolutionSnapshot";

interface CatalogPostingRecord {
	postingKey: string;
	sourcePath: string;
	observationKey: string;
	lookupKeys: string[];
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
	private database: IDBDatabase | null = null;
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
		this.database?.close();
		this.database = null;
		if (this.lifecycle.state !== "read-only") {
			this.lifecycle = { state: "degraded", persistent: false, writable: false, reason: "closed" };
		}
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
		const transaction = this.getDatabase().transaction(
			[FILES_STORE, OBSERVATIONS_STORE, POSTINGS_STORE, AGGREGATES_STORE, META_STORE],
			"readwrite",
		);
		const done = waitForTransaction(transaction);
		const files = transaction.objectStore(FILES_STORE);
		const observations = transaction.objectStore(OBSERVATIONS_STORE);
		const postings = transaction.objectStore(POSTINGS_STORE);
		const aggregates = transaction.objectStore(AGGREGATES_STORE);
		const metadata = transaction.objectStore(META_STORE);
		const partitionRequests = partitions.map((partition) =>
			(requestResult(files.get(partition.file.sourcePath)) as Promise<CatalogFileRecord | undefined>)
				.then(async (existingFile) => {
					if (existingFile === undefined) {
						return { partition, observationKeys: [], postingKeys: [], existingObservations: [], reuseExisting: false };
					}
					if (existingFile.sourceRevision === partition.file.sourceRevision
						&& existingFile.parserVersion === partition.file.parserVersion
						&& existingFile.settingsFingerprint === partition.file.settingsFingerprint) {
						return { partition, observationKeys: [], postingKeys: [], existingObservations: [], reuseExisting: true };
					}
					const [observationKeys, postingKeys, existingObservations] = await Promise.all([
						existingFile.observationKeys === undefined
							? requestResult(observations.index(BY_SOURCE_PATH).getAllKeys(partition.file.sourcePath))
							: Promise.resolve(existingFile.observationKeys),
						existingFile.observationKeys === undefined
							? requestResult(postings.index(BY_SOURCE_PATH).getAllKeys(partition.file.sourcePath))
							: Promise.resolve(existingFile.observationKeys),
						Promise.all(partition.observations.map((observation) =>
							requestResult(observations.get(observation.observationKey)) as Promise<CatalogObservation | undefined>)),
					]);
					return { partition, observationKeys, postingKeys, existingObservations, reuseExisting: false };
				}));
		const revisionRequest = requestResult(metadata.get(CATALOG_REVISION_META)) as
			Promise<CatalogMetaRecord<number> | undefined>;
		const [partitionsWithKeys, revisionRecord] = await Promise.all([
			Promise.all(partitionRequests),
			revisionRequest,
		]);
		for (const { partition, observationKeys, postingKeys, existingObservations, reuseExisting } of partitionsWithKeys) {
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
			aggregates.put(partition.aggregate);
			for (const observation of partition.observations) {
				observations.put(observation);
				const posting = buildPostingRecord(observation);
				const existingObservation = existingByKey.get(observation.observationKey);
				if (existingObservation === undefined
					|| !sameLookupKeys(buildPostingRecord(existingObservation).lookupKeys, posting.lookupKeys)) {
					postings.put(posting);
				}
			}
		}
		const revision = (revisionRecord?.value ?? 0) + 1;
		metadata.put({ key: CATALOG_REVISION_META, value: revision } satisfies CatalogMetaRecord<number>);
		await done;
		return revision;
	}

	async deleteFilePartition(sourcePath: string): Promise<number> {
		await this.open();
		const transaction = this.getDatabase().transaction(
			[FILES_STORE, OBSERVATIONS_STORE, POSTINGS_STORE, AGGREGATES_STORE, META_STORE],
			"readwrite",
		);
		const done = waitForTransaction(transaction);
		const files = transaction.objectStore(FILES_STORE);
		const observations = transaction.objectStore(OBSERVATIONS_STORE);
		const postings = transaction.objectStore(POSTINGS_STORE);
		const metadata = transaction.objectStore(META_STORE);
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
		const [{ file, observationKeys, postingKeys }, revisionRecord] = await Promise.all([
			fileRequest,
			requestResult(metadata.get(CATALOG_REVISION_META)) as Promise<CatalogMetaRecord<number> | undefined>,
		]);
		const currentRevision = revisionRecord?.value ?? 0;
		if (file === undefined) {
			await done;
			return currentRevision;
		}
		for (const key of observationKeys) observations.delete(key);
		for (const key of postingKeys) postings.delete(key);
		files.delete(sourcePath);
		transaction.objectStore(AGGREGATES_STORE).delete(sourcePath);
		const revision = currentRevision + 1;
		metadata.put({ key: CATALOG_REVISION_META, value: revision } satisfies CatalogMetaRecord<number>);
		await done;
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

	async query(request: CatalogQuery): Promise<CatalogQueryPage> {
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
			const sourcePaths = request.sourcePaths === undefined ? null : new Set(request.sourcePaths);
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

				const selection = selectCatalogIndex(request);
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
							if (matchesCatalogQuery(observation, request, sourcePaths)) {
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
									if (matchesCatalogQuery(observation, request, sourcePaths)) {
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
					reject(error);
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

	async getCoverage(): Promise<CatalogCoverage> {
		return (await this.getMeta<CatalogCoverage>(COVERAGE_META)) ?? { ...DEFAULT_CATALOG_COVERAGE };
	}

	async setCoverage(coverage: CatalogCoverage): Promise<void> {
		if (coverage.kind === "rebuilding") {
			this.lifecycle = { state: "rebuilding", persistent: true, writable: true, reason: null };
		}
		await this.setMeta(COVERAGE_META, coverage);
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

	loadResolutionSnapshot(): Promise<CatalogV2ResolutionSnapshot | null> {
		return this.getMeta<CatalogV2ResolutionSnapshot>(RESOLUTION_SNAPSHOT_META);
	}

	saveResolutionSnapshot(snapshot: CatalogV2ResolutionSnapshot): Promise<void> {
		return this.setMeta(RESOLUTION_SNAPSHOT_META, snapshot);
	}

	async clear(): Promise<void> {
		await this.open();
		const transaction = this.getDatabase().transaction(
			[FILES_STORE, OBSERVATIONS_STORE, POSTINGS_STORE, AGGREGATES_STORE, META_STORE],
			"readwrite",
		);
		const done = waitForTransaction(transaction);
		const revisionRecord = await requestResult(transaction.objectStore(META_STORE).get(CATALOG_REVISION_META)) as
			CatalogMetaRecord<number> | undefined;
		for (const storeName of [FILES_STORE, OBSERVATIONS_STORE, POSTINGS_STORE, AGGREGATES_STORE, META_STORE]) {
			transaction.objectStore(storeName).clear();
		}
		transaction.objectStore(META_STORE).put({
			key: CATALOG_REVISION_META,
			value: (revisionRecord?.value ?? 0) + 1,
		} satisfies CatalogMetaRecord<number>);
		transaction.objectStore(META_STORE).put({ key: COVERAGE_META, value: DEFAULT_CATALOG_COVERAGE } satisfies CatalogMetaRecord<CatalogCoverage>);
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

	private async getCatalogRevision(): Promise<number> {
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
		let upgradeError: unknown = null;
		request.onupgradeneeded = (event) => {
			try {
				createCatalogSchema(request.result, request.transaction, event.oldVersion);
				beforeUpgrade?.();
			} catch (error) {
				upgradeError = error;
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
				reject(error);
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
	for (const storeName of [FILES_STORE, OBSERVATIONS_STORE, POSTINGS_STORE, AGGREGATES_STORE, META_STORE]) {
		if (!database.objectStoreNames.contains(storeName)) {
			throw new CatalogDatabaseCorruptError(`Memo Catalog store is missing: ${storeName}.`);
		}
	}
	const transaction = database.transaction([OBSERVATIONS_STORE, POSTINGS_STORE, AGGREGATES_STORE], "readonly");
	const expectedIndexes = [
		[OBSERVATIONS_STORE, [BY_SOURCE_PATH, BY_CREATED_AT, BY_LOGICAL_DATE]],
		[POSTINGS_STORE, [BY_SOURCE_PATH, BY_LOOKUP]],
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
		entries.push(["tag", tag]);
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

function sameLookupKeys(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function selectCatalogIndex(request: CatalogQuery): CatalogIndexSelection | null {
	const tag = request.tags?.map(normalizeCatalogText).find(Boolean);
	if (tag !== undefined) {
		return { kind: "tag", value: tag };
	}
	if (request.text !== undefined) {
		const token = selectCatalogSearchToken(request.text);
		if (token !== null) {
			return { kind: "search", value: token };
		}
	}
	if (request.linkTarget !== undefined) {
		return { kind: "link", value: `target:${normalizeCatalogText(request.linkTarget)}` };
	}
	if (request.hasLink !== undefined) {
		return { kind: "link", value: `has:${request.hasLink ? 1 : 0}` };
	}
	if (request.imagePath !== undefined) {
		return { kind: "image", value: `path:${normalizeCatalogText(request.imagePath)}` };
	}
	if (request.hasImage !== undefined) {
		return { kind: "image", value: `has:${request.hasImage ? 1 : 0}` };
	}
	if (request.hasTask !== undefined) {
		return { kind: "task", value: `has:${request.hasTask ? 1 : 0}` };
	}
	if (request.timeBuoyDate !== undefined) {
		return { kind: "timeBuoy", value: `date:${request.timeBuoyDate}` };
	}
	if (request.hasTimeBuoy !== undefined) {
		return { kind: "timeBuoy", value: `has:${request.hasTimeBuoy ? 1 : 0}` };
	}
	if (request.explicitReferenceTarget !== undefined) {
		return { kind: "reference", value: `target:${request.explicitReferenceTarget}` };
	}
	return null;
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

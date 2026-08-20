import type {
	ArtifactRef,
	CatalogV2MaterializedState,
	CatalogV2ShadowPreview,
	CatalogV2UpgradeStatus,
	StateOperationEnvelope,
	StateSegmentCheckpoint,
} from "../types/catalogV2";
import { createCatalogV2Id } from "./CatalogV2Protocol";
import type { FillRandomBytes } from "./CatalogV2Protocol";

const STATE_DATABASE_VERSION = 5;
const DEVICE_STORE = "device";
const CHECKPOINTS_STORE = "checkpoints";
const META_STORE = "meta";
const OPERATIONS_STORE = "operations";
const MATERIALIZED_MEMOS_STORE = "materializedMemos";
const BY_SOURCE_PATH = "bySourcePath";
const BY_LIFECYCLE_CURSOR = "byLifecycleCursor";
const BY_IDENTITY_LOOKUP = "byIdentityLookup";
const WRITER_ID_KEY = "writerId";
const MATERIALIZED_STATE_KEY = "materializedState";
const MATERIALIZED_STATE_REVISION_KEY = "materializedStateRevision";
const SHADOW_PREVIEW_KEY = "shadowPreview";
const UPGRADE_STATUS_KEY = "upgradeStatus";
const LEGACY_REVIEW_SIGNATURE_KEY = "legacyReviewSignature";
const VERIFIED_GENERATION_WATERMARK_KEY = "verifiedGenerationWatermark";
const COMPACTION_VERIFICATION_PREFIX = "compactionVerification:";
const FALLBACK_MEMO_LIMIT = 150;
const FALLBACK_OPERATION_LIMIT = 1_000;

interface StateMetaRecord<T = unknown> {
	key: string;
	value: T;
}

interface MaterializedMemoRecord {
	memoId: string;
	memo: CatalogV2MaterializedState["memos"][string];
	lifecycle: "active" | "deleted";
	lifecycleCursor: string;
	identityLookupKeys: string[];
}

type MaterializedStateHeader = Omit<CatalogV2MaterializedState, "memos">;

export interface CatalogV2StateSnapshot {
	state: CatalogV2MaterializedState;
	revision: string;
}

export interface CatalogV2IdentityContextSnapshot {
	snapshot: CatalogV2StateSnapshot;
	upgradeStatus: CatalogV2UpgradeStatus | null;
}

export interface CatalogV2VerifiedGenerationWatermark {
	vaultInstanceId: string;
	contractDigest: string;
	generationRef: ArtifactRef;
}

export interface CatalogV2LifecyclePage {
	items: CatalogV2MaterializedState["memos"][string][];
	nextCursor: string | null;
	revision: string;
}

export interface CatalogV2DeletedMemoSummary {
	count: number;
	memoIds: string[];
	revision: string;
}

export interface CatalogV2CompactionVerification {
	snapshotSha256: string;
	inputSignature: string;
	verifiedAt: number;
}

export interface IndexedDbCatalogV2StateStoreOptions {
	factory?: IDBFactory;
	keyRange?: typeof IDBKeyRange;
	version?: number;
}

export type CatalogV2StateStoreHealth = "closed" | "opening" | "open" | "degraded" | "fallback";

export class IndexedDbCatalogV2StateStore {
	private database: IDBDatabase | null = null;
	private fallbackActive = false;
	private health: CatalogV2StateStoreHealth = "closed";
	private opening: Promise<void> | null = null;
	private fallbackWriterId: string | null = null;
	private fallbackState: CatalogV2MaterializedState | null = null;
	private fallbackRevision = 0;
	private readonly fallbackCheckpoints = new Map<string, StateSegmentCheckpoint>();
	private readonly fallbackEnvelopes = new Map<string, StateOperationEnvelope[]>();
	private readonly fallbackMeta = new Map<string, unknown>();
	private readonly factory: IDBFactory | undefined;
	private readonly keyRange: typeof IDBKeyRange | undefined;
	private readonly version: number;

	constructor(
		private readonly databaseName: string,
		options: IndexedDbCatalogV2StateStoreOptions = {},
	) {
		this.factory = options.factory ?? (typeof indexedDB === "undefined" ? undefined : indexedDB);
		this.keyRange = options.keyRange ?? (typeof IDBKeyRange === "undefined" ? undefined : IDBKeyRange);
		this.version = options.version ?? STATE_DATABASE_VERSION;
	}

	async open(): Promise<void> {
		if (this.database !== null) return;
		if (this.opening !== null) return this.opening;
		this.opening = this.openInternal().finally(() => { this.opening = null; });
		return this.opening;
	}

	private async openInternal(): Promise<void> {
		this.health = "opening";
		if (this.factory === undefined || this.keyRange === undefined) {
			this.fallbackActive = true;
			this.health = "fallback";
			return;
		}
		try {
			this.database = await openStateDatabase(this.factory, this.databaseName, this.version);
			validateStateDatabase(this.database);
			this.fallbackActive = false;
			this.health = "open";
			this.database.onversionchange = () => {
				this.database?.close();
				this.database = null;
				this.health = "degraded";
			};
		} catch {
			this.database?.close();
			this.database = null;
			this.fallbackActive = true;
			this.health = "fallback";
		}
	}

	close(): void {
		this.database?.close();
		this.database = null;
		this.health = "closed";
	}

	isFallbackActive(): boolean {
		return this.fallbackActive;
	}

	isAuthoritative(): boolean {
		return this.health === "open" && this.database !== null && !this.fallbackActive;
	}

	getHealth(): CatalogV2StateStoreHealth {
		return this.health;
	}

	async retryOpen(): Promise<boolean> {
		if (this.database !== null) return true;
		this.fallbackActive = false;
		await this.open();
		return this.isAuthoritative();
	}

	async getOrCreateWriterId(fillRandomBytes?: FillRandomBytes): Promise<string> {
		await this.ensureReadable();
		if (this.fallbackActive) {
			this.fallbackWriterId ??= createCatalogV2Id("w", fillRandomBytes);
			return this.fallbackWriterId;
		}
		const transaction = this.getDatabase().transaction(DEVICE_STORE, "readwrite");
		const done = waitForTransaction(transaction);
		const store = transaction.objectStore(DEVICE_STORE);
		const current = await requestResult(store.get(WRITER_ID_KEY)) as StateMetaRecord<string> | undefined;
		if (current !== undefined) {
			await done;
			return current.value;
		}
		const writerId = createCatalogV2Id("w", fillRandomBytes);
		store.put({ key: WRITER_ID_KEY, value: writerId } satisfies StateMetaRecord<string>);
		await done;
		return writerId;
	}

	async rotateWriterId(fillRandomBytes?: FillRandomBytes): Promise<string> {
		await this.ensureReadable();
		const writerId = createCatalogV2Id("w", fillRandomBytes);
		if (this.fallbackActive) {
			this.fallbackWriterId = writerId;
			return writerId;
		}
		const transaction = this.getDatabase().transaction(DEVICE_STORE, "readwrite");
		const done = waitForTransaction(transaction);
		transaction.objectStore(DEVICE_STORE).put({ key: WRITER_ID_KEY, value: writerId } satisfies StateMetaRecord<string>);
		await done;
		return writerId;
	}

	async saveMaterializedState(state: CatalogV2MaterializedState): Promise<void> {
		await this.ensureReadable();
		if (this.fallbackActive) {
			const memoEntries = Object.entries(state.memos).sort(([left], [right]) => left.localeCompare(right));
			this.fallbackState = {
				...state,
				memos: Object.fromEntries(memoEntries.slice(0, FALLBACK_MEMO_LIMIT)),
			};
			this.fallbackRevision += 1;
			return;
		}
		const transaction = this.getDatabase().transaction([META_STORE, MATERIALIZED_MEMOS_STORE], "readwrite");
		const done = waitForTransaction(transaction);
		const meta = transaction.objectStore(META_STORE);
		const current = await requestResult(meta.get(MATERIALIZED_STATE_REVISION_KEY)) as StateMetaRecord<number> | undefined;
		const revision = (current?.value ?? 0) + 1;
		meta.put({ key: MATERIALIZED_STATE_KEY, value: toMaterializedStateHeader(state) } satisfies StateMetaRecord<MaterializedStateHeader>);
		meta.put({ key: MATERIALIZED_STATE_REVISION_KEY, value: revision } satisfies StateMetaRecord<number>);
		const memos = transaction.objectStore(MATERIALIZED_MEMOS_STORE);
		memos.clear();
		for (const memo of Object.values(state.memos)) memos.put(toMaterializedMemoRecord(memo));
		await done;
	}

	async loadMaterializedState(): Promise<CatalogV2MaterializedState | null> {
		await this.ensureReadable();
		if (this.fallbackActive) return Promise.resolve(this.fallbackState);
		const transaction = this.getDatabase().transaction([META_STORE, MATERIALIZED_MEMOS_STORE], "readonly");
		const done = waitForTransaction(transaction);
		const [stateRecord, memoRecords] = await Promise.all([
			requestResult(transaction.objectStore(META_STORE).get(MATERIALIZED_STATE_KEY)) as Promise<StateMetaRecord<MaterializedStateHeader | CatalogV2MaterializedState> | undefined>,
			requestResult(transaction.objectStore(MATERIALIZED_MEMOS_STORE).getAll()) as Promise<MaterializedMemoRecord[]>,
		]);
		await done;
		if (stateRecord === undefined) return null;
		return materializeState(stateRecord.value, memoRecords);
	}

	async loadMaterializedSnapshot(): Promise<CatalogV2StateSnapshot | null> {
		await this.ensureReadable();
		if (this.fallbackActive) {
			return this.fallbackState === null ? null : {
				state: this.fallbackState,
				revision: formatStateRevision(this.fallbackRevision),
			};
		}
		const transaction = this.getDatabase().transaction([META_STORE, MATERIALIZED_MEMOS_STORE], "readonly");
		const done = waitForTransaction(transaction);
		const store = transaction.objectStore(META_STORE);
		const [stateRecord, revisionRecord, memoRecords] = await Promise.all([
			requestResult(store.get(MATERIALIZED_STATE_KEY)) as Promise<StateMetaRecord<MaterializedStateHeader | CatalogV2MaterializedState> | undefined>,
			requestResult(store.get(MATERIALIZED_STATE_REVISION_KEY)) as Promise<StateMetaRecord<number> | undefined>,
			requestResult(transaction.objectStore(MATERIALIZED_MEMOS_STORE).getAll()) as Promise<MaterializedMemoRecord[]>,
		]);
		await done;
		if (stateRecord === undefined) return null;
		return { state: materializeState(stateRecord.value, memoRecords), revision: formatStateRevision(revisionRecord?.value ?? 0) };
	}

	async loadIdentityContextSnapshot(): Promise<CatalogV2IdentityContextSnapshot | null> {
		await this.ensureReadable();
		if (this.fallbackActive) {
			return this.fallbackState === null ? null : {
				snapshot: {
					state: this.fallbackState,
					revision: formatStateRevision(this.fallbackRevision),
				},
				upgradeStatus: (this.fallbackMeta.get(UPGRADE_STATUS_KEY) as CatalogV2UpgradeStatus | undefined) ?? null,
			};
		}
		const transaction = this.getDatabase().transaction([META_STORE, MATERIALIZED_MEMOS_STORE], "readonly");
		const done = waitForTransaction(transaction);
		const metadata = transaction.objectStore(META_STORE);
		const [stateRecord, revisionRecord, upgradeRecord, memoRecords] = await Promise.all([
			requestResult(metadata.get(MATERIALIZED_STATE_KEY)) as Promise<StateMetaRecord<MaterializedStateHeader | CatalogV2MaterializedState> | undefined>,
			requestResult(metadata.get(MATERIALIZED_STATE_REVISION_KEY)) as Promise<StateMetaRecord<number> | undefined>,
			requestResult(metadata.get(UPGRADE_STATUS_KEY)) as Promise<StateMetaRecord<CatalogV2UpgradeStatus> | undefined>,
			requestResult(transaction.objectStore(MATERIALIZED_MEMOS_STORE).getAll()) as Promise<MaterializedMemoRecord[]>,
		]);
		await done;
		if (stateRecord === undefined) return null;
		return {
			snapshot: {
				state: materializeState(stateRecord.value, memoRecords),
				revision: formatStateRevision(revisionRecord?.value ?? 0),
			},
			upgradeStatus: upgradeRecord?.value ?? null,
		};
	}

	loadVerifiedGenerationWatermark(): Promise<CatalogV2VerifiedGenerationWatermark | null> {
		return this.getMeta<CatalogV2VerifiedGenerationWatermark>(VERIFIED_GENERATION_WATERMARK_KEY);
	}

	saveVerifiedGenerationWatermark(value: CatalogV2VerifiedGenerationWatermark): Promise<void> {
		return this.setMeta(VERIFIED_GENERATION_WATERMARK_KEY, value);
	}

	async loadMaterializedSlice(observations: ReadonlyArray<{
		sourcePath: string;
		logicalDate: string;
		time: string;
		contentHash: string;
		existingBlockId: string | null;
	}>): Promise<CatalogV2StateSnapshot | null> {
		await this.ensureReadable();
		if (this.fallbackActive) return this.loadMaterializedSnapshot();
		const transaction = this.getDatabase().transaction([META_STORE, MATERIALIZED_MEMOS_STORE], "readonly");
		const done = waitForTransaction(transaction);
		const metadata = transaction.objectStore(META_STORE);
		const memos = transaction.objectStore(MATERIALIZED_MEMOS_STORE);
		const lookup = memos.index(BY_IDENTITY_LOOKUP);
		const keys = [...new Set(observations.flatMap((observation) => identityLookupKeys(observation)))];
		const [stateRecord, revisionRecord, recordGroups] = await Promise.all([
			requestResult(metadata.get(MATERIALIZED_STATE_KEY)) as Promise<StateMetaRecord<MaterializedStateHeader | CatalogV2MaterializedState> | undefined>,
			requestResult(metadata.get(MATERIALIZED_STATE_REVISION_KEY)) as Promise<StateMetaRecord<number> | undefined>,
			Promise.all(keys.map((key) => requestResult(lookup.getAll(key)) as Promise<MaterializedMemoRecord[]>)),
		]);
		await done;
		if (stateRecord === undefined) return null;
		const records = [...new Map(recordGroups.flat().map((record) => [record.memoId, record])).values()];
		return {
			state: materializeState(stateRecord.value, records),
			revision: formatStateRevision(revisionRecord?.value ?? 0),
		};
	}

	async loadIdentityContextSlice(observations: ReadonlyArray<{
		sourcePath: string;
		logicalDate: string;
		time: string;
		contentHash: string;
		existingBlockId: string | null;
	}>): Promise<CatalogV2IdentityContextSnapshot | null> {
		await this.ensureReadable();
		if (this.fallbackActive) return this.loadIdentityContextSnapshot();
		const transaction = this.getDatabase().transaction([META_STORE, MATERIALIZED_MEMOS_STORE], "readonly");
		const done = waitForTransaction(transaction);
		const metadata = transaction.objectStore(META_STORE);
		const memos = transaction.objectStore(MATERIALIZED_MEMOS_STORE);
		const lookup = memos.index(BY_IDENTITY_LOOKUP);
		const keys = [...new Set(observations.flatMap((observation) => identityLookupKeys(observation)))];
		const [stateRecord, revisionRecord, upgradeRecord, recordGroups] = await Promise.all([
			requestResult(metadata.get(MATERIALIZED_STATE_KEY)) as Promise<StateMetaRecord<MaterializedStateHeader | CatalogV2MaterializedState> | undefined>,
			requestResult(metadata.get(MATERIALIZED_STATE_REVISION_KEY)) as Promise<StateMetaRecord<number> | undefined>,
			requestResult(metadata.get(UPGRADE_STATUS_KEY)) as Promise<StateMetaRecord<CatalogV2UpgradeStatus> | undefined>,
			Promise.all(keys.map((key) => requestResult(lookup.getAll(key)) as Promise<MaterializedMemoRecord[]>)),
		]);
		await done;
		if (stateRecord === undefined) return null;
		const records = [...new Map(recordGroups.flat().map((record) => [record.memoId, record])).values()];
		return {
			snapshot: {
				state: materializeState(stateRecord.value, records),
				revision: formatStateRevision(revisionRecord?.value ?? 0),
			},
			upgradeStatus: upgradeRecord?.value ?? null,
		};
	}

	async listMaterializedMemosByIds(memoIds: readonly string[]): Promise<CatalogV2MaterializedState["memos"][string][]> {
		await this.ensureReadable();
		if (this.fallbackActive) return [...new Set(memoIds)].flatMap((memoId) => {
			const memo = this.fallbackState?.memos[memoId];
			return memo === undefined ? [] : [memo];
		});
		const transaction = this.getDatabase().transaction(MATERIALIZED_MEMOS_STORE, "readonly");
		const done = waitForTransaction(transaction);
		const store = transaction.objectStore(MATERIALIZED_MEMOS_STORE);
		const records = await Promise.all([...new Set(memoIds)].map((memoId) =>
			requestResult(store.get(memoId)) as Promise<MaterializedMemoRecord | undefined>));
		await done;
		return records.flatMap((record) => record === undefined ? [] : [record.memo]);
	}

	async listDeletedMemoPage(limit: number, cursor: string | null = null): Promise<CatalogV2LifecyclePage> {
		await this.ensureReadable();
		if (this.fallbackActive) return listFallbackDeletedPage(this.fallbackState, this.fallbackRevision, limit, cursor);
		const snapshot = await this.loadMaterializedSnapshot();
		if (snapshot === null) return { items: [], nextCursor: null, revision: formatStateRevision(0) };
		const pageLimit = Math.max(1, Math.min(150, Math.trunc(limit)));
		const transaction = this.getDatabase().transaction(MATERIALIZED_MEMOS_STORE, "readonly");
		const done = waitForTransaction(transaction);
		const index = transaction.objectStore(MATERIALIZED_MEMOS_STORE).index(BY_LIFECYCLE_CURSOR);
		const lower = cursor === null ? "deleted\u0000" : cursor;
		const range = cursor === null
			? this.getKeyRange().bound(lower, "deleted\u0000\uffff", false, false)
			: this.getKeyRange().bound(lower, "deleted\u0000\uffff", true, false);
		const records = await readCursorPage<MaterializedMemoRecord>(index, range, pageLimit + 1);
		await done;
		const hasMore = records.length > pageLimit;
		const visible = records.slice(0, pageLimit);
		return {
			items: visible.map((record) => record.memo),
			nextCursor: hasMore ? visible[visible.length - 1]?.lifecycleCursor ?? null : null,
			revision: snapshot.revision,
		};
	}

	async getDeletedMemoSummary(): Promise<CatalogV2DeletedMemoSummary> {
		await this.ensureReadable();
		if (this.fallbackActive) {
			const memoIds = listFallbackDeletedRecords(this.fallbackState).map((record) => record.memoId);
			return { count: memoIds.length, memoIds, revision: formatStateRevision(this.fallbackRevision) };
		}
		const snapshot = await this.loadMaterializedSnapshot();
		if (snapshot === null) return { count: 0, memoIds: [], revision: formatStateRevision(0) };
		const transaction = this.getDatabase().transaction(MATERIALIZED_MEMOS_STORE, "readonly");
		const done = waitForTransaction(transaction);
		const index = transaction.objectStore(MATERIALIZED_MEMOS_STORE).index(BY_LIFECYCLE_CURSOR);
		const range = this.getKeyRange().bound("deleted\u0000", "deleted\u0000\uffff", false, false);
		const memoIds = await readCursorPrimaryKeys(index, range);
		await done;
		return { count: memoIds.length, memoIds, revision: snapshot.revision };
	}

	async setSegmentCheckpoint(checkpoint: StateSegmentCheckpoint): Promise<void> {
		await this.ensureReadable();
		if (this.fallbackActive) {
			this.fallbackCheckpoints.set(checkpoint.path, checkpoint);
			return;
		}
		const transaction = this.getDatabase().transaction(CHECKPOINTS_STORE, "readwrite");
		const done = waitForTransaction(transaction);
		transaction.objectStore(CHECKPOINTS_STORE).put(checkpoint);
		await done;
	}

	async deleteSegmentCheckpoint(path: string): Promise<void> {
		await this.ensureReadable();
		if (this.fallbackActive) {
			this.fallbackCheckpoints.delete(path);
			return;
		}
		const transaction = this.getDatabase().transaction(CHECKPOINTS_STORE, "readwrite");
		const done = waitForTransaction(transaction);
		transaction.objectStore(CHECKPOINTS_STORE).delete(path);
		await done;
	}

	async listSegmentCheckpoints(): Promise<StateSegmentCheckpoint[]> {
		await this.ensureReadable();
		if (this.fallbackActive) return [...this.fallbackCheckpoints.values()].sort((left, right) => left.path.localeCompare(right.path));
		const transaction = this.getDatabase().transaction(CHECKPOINTS_STORE, "readonly");
		const done = waitForTransaction(transaction);
		const checkpoints = await requestResult(transaction.objectStore(CHECKPOINTS_STORE).getAll()) as StateSegmentCheckpoint[];
		await done;
		return checkpoints.sort((left, right) => left.path.localeCompare(right.path));
	}

	async replaceSegmentEnvelopes(path: string, envelopes: readonly StateOperationEnvelope[]): Promise<void> {
		await this.ensureReadable();
		if (this.fallbackActive) {
			this.fallbackEnvelopes.set(path, envelopes.slice(-FALLBACK_OPERATION_LIMIT));
			trimFallbackEnvelopes(this.fallbackEnvelopes);
			return;
		}
		const transaction = this.getDatabase().transaction(OPERATIONS_STORE, "readwrite");
		const done = waitForTransaction(transaction);
		const store = transaction.objectStore(OPERATIONS_STORE);
		const keys = await requestResult(store.index(BY_SOURCE_PATH).getAllKeys(path));
		for (const key of keys) store.delete(key);
		for (const envelope of envelopes) {
			store.put({ ...envelope, storageKey: `${path}\u0000${envelope.digest}` });
		}
		await done;
	}

	async listOperationEnvelopes(): Promise<StateOperationEnvelope[]> {
		await this.ensureReadable();
		if (this.fallbackActive) return [...this.fallbackEnvelopes.values()].flat().slice(-FALLBACK_OPERATION_LIMIT);
		const transaction = this.getDatabase().transaction(OPERATIONS_STORE, "readonly");
		const done = waitForTransaction(transaction);
		const records = await requestResult(transaction.objectStore(OPERATIONS_STORE).getAll()) as Array<StateOperationEnvelope & { storageKey: string }>;
		await done;
		return records.map(({ operation, digest, sourcePath }) => ({ operation, digest, sourcePath }));
	}

	saveShadowPreview(preview: CatalogV2ShadowPreview): Promise<void> {
		return this.setMeta(SHADOW_PREVIEW_KEY, preview);
	}

	loadShadowPreview(): Promise<CatalogV2ShadowPreview | null> {
		return this.getMeta<CatalogV2ShadowPreview>(SHADOW_PREVIEW_KEY);
	}

	saveUpgradeStatus(status: CatalogV2UpgradeStatus): Promise<void> {
		return this.setMeta(UPGRADE_STATUS_KEY, status);
	}

	loadUpgradeStatus(): Promise<CatalogV2UpgradeStatus | null> {
		return this.getMeta<CatalogV2UpgradeStatus>(UPGRADE_STATUS_KEY);
	}

	saveLegacyReviewSignature(signature: string): Promise<void> {
		return this.setMeta(LEGACY_REVIEW_SIGNATURE_KEY, signature);
	}

	loadLegacyReviewSignature(): Promise<string | null> {
		return this.getMeta<string>(LEGACY_REVIEW_SIGNATURE_KEY);
	}

	saveCompactionVerification(writerId: string, verification: CatalogV2CompactionVerification): Promise<void> {
		assertWriterId(writerId);
		return this.setMeta(`${COMPACTION_VERIFICATION_PREFIX}${writerId}`, verification);
	}

	loadCompactionVerification(writerId: string): Promise<CatalogV2CompactionVerification | null> {
		assertWriterId(writerId);
		return this.getMeta<CatalogV2CompactionVerification>(`${COMPACTION_VERIFICATION_PREFIX}${writerId}`);
	}

	createIsolatedVerificationStore(suffix: string): IndexedDbCatalogV2StateStore {
		if (!/^[a-f0-9-]+$/u.test(suffix)) throw new Error("Invalid cold-start verification suffix.");
		return new IndexedDbCatalogV2StateStore(`${this.databaseName}-cold-start-${suffix}`, {
			factory: this.factory,
			keyRange: this.keyRange,
			version: this.version,
		});
	}

	deleteIsolatedVerificationStore(suffix: string): Promise<void> {
		if (!/^[a-f0-9-]+$/u.test(suffix) || this.factory === undefined) {
			throw new Error("Invalid cold-start verification store.");
		}
		return deleteDatabase(this.factory, `${this.databaseName}-cold-start-${suffix}`);
	}

	private async getMeta<T>(key: string): Promise<T | null> {
		await this.ensureReadable();
		if (this.fallbackActive) return (this.fallbackMeta.get(key) as T | undefined) ?? null;
		const transaction = this.getDatabase().transaction(META_STORE, "readonly");
		const done = waitForTransaction(transaction);
		const record = await requestResult(transaction.objectStore(META_STORE).get(key)) as StateMetaRecord<T> | undefined;
		await done;
		return record?.value ?? null;
	}

	private async setMeta<T>(key: string, value: T): Promise<void> {
		await this.ensureReadable();
		if (this.fallbackActive) {
			this.fallbackMeta.set(key, value);
			return;
		}
		const transaction = this.getDatabase().transaction(META_STORE, "readwrite");
		const done = waitForTransaction(transaction);
		transaction.objectStore(META_STORE).put({ key, value } satisfies StateMetaRecord<T>);
		await done;
	}

	private getDatabase(): IDBDatabase {
		if (this.database === null) throw new Error("Catalog v2 state store is not open.");
		return this.database;
	}

	private getKeyRange(): typeof IDBKeyRange {
		if (this.keyRange === undefined) throw new Error("IndexedDB key ranges are unavailable.");
		return this.keyRange;
	}

	private async ensureReadable(): Promise<void> {
		if (this.database === null && this.health !== "fallback") await this.retryOpen();
	}
}

function openStateDatabase(factory: IDBFactory, name: string, version: number): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = factory.open(name, version);
		let settled = false;
		request.onupgradeneeded = () => {
			const database = request.result;
			if (!database.objectStoreNames.contains(DEVICE_STORE)) database.createObjectStore(DEVICE_STORE, { keyPath: "key" });
			if (!database.objectStoreNames.contains(CHECKPOINTS_STORE)) database.createObjectStore(CHECKPOINTS_STORE, { keyPath: "path" });
			if (!database.objectStoreNames.contains(META_STORE)) database.createObjectStore(META_STORE, { keyPath: "key" });
			if (!database.objectStoreNames.contains(OPERATIONS_STORE)) {
				const operations = database.createObjectStore(OPERATIONS_STORE, { keyPath: "storageKey" });
				operations.createIndex(BY_SOURCE_PATH, "sourcePath", { unique: false });
			}
			if (!database.objectStoreNames.contains(MATERIALIZED_MEMOS_STORE)) {
				const memos = database.createObjectStore(MATERIALIZED_MEMOS_STORE, { keyPath: "memoId" });
				memos.createIndex(BY_LIFECYCLE_CURSOR, "lifecycleCursor", { unique: true });
				memos.createIndex(BY_IDENTITY_LOOKUP, "identityLookupKeys", { unique: false, multiEntry: true });
			} else if (request.transaction !== null) {
				const memos = request.transaction.objectStore(MATERIALIZED_MEMOS_STORE);
				if (!memos.indexNames.contains(BY_IDENTITY_LOOKUP)) {
					memos.createIndex(BY_IDENTITY_LOOKUP, "identityLookupKeys", { unique: false, multiEntry: true });
				}
				const cursorRequest = memos.openCursor();
				cursorRequest.onsuccess = () => {
					const cursor = cursorRequest.result;
					if (cursor === null) return;
					const record = cursor.value as MaterializedMemoRecord;
					cursor.update(toMaterializedMemoRecord(record.memo));
					cursor.continue();
				};
			}
		};
		request.onsuccess = () => {
			if (settled) {
				request.result.close();
				return;
			}
			settled = true;
			resolve(request.result);
		};
		request.onerror = () => {
			if (settled) return;
			settled = true;
			reject(request.error ?? new Error("Catalog v2 state database open failed."));
		};
		request.onblocked = () => {
			if (settled) return;
			settled = true;
			reject(new Error("Catalog v2 state database open was blocked."));
		};
	});
}

function validateStateDatabase(database: IDBDatabase): void {
	for (const storeName of [DEVICE_STORE, CHECKPOINTS_STORE, META_STORE, OPERATIONS_STORE, MATERIALIZED_MEMOS_STORE]) {
		if (!database.objectStoreNames.contains(storeName)) throw new Error(`Catalog v2 state store is missing: ${storeName}.`);
	}
	const transaction = database.transaction([OPERATIONS_STORE, MATERIALIZED_MEMOS_STORE], "readonly");
	if (!transaction.objectStore(OPERATIONS_STORE).indexNames.contains(BY_SOURCE_PATH)) {
		throw new Error("Catalog v2 operation source index is missing.");
	}
	if (!transaction.objectStore(MATERIALIZED_MEMOS_STORE).indexNames.contains(BY_LIFECYCLE_CURSOR)) {
		throw new Error("Catalog v2 lifecycle index is missing.");
	}
	if (!transaction.objectStore(MATERIALIZED_MEMOS_STORE).indexNames.contains(BY_IDENTITY_LOOKUP)) {
		throw new Error("Catalog v2 identity lookup index is missing.");
	}
}

function toMaterializedMemoRecord(memo: CatalogV2MaterializedState["memos"][string]): MaterializedMemoRecord {
	const activeDeleteIds = memo.deleteOperationIds.filter((deleteOpId) =>
		!memo.restoredDeleteOperationIds.includes(deleteOpId) && !memo.purgedDeleteOperationIds.includes(deleteOpId));
	const lifecycle: MaterializedMemoRecord["lifecycle"] = activeDeleteIds.length > 0 ? "deleted" : "active";
	const sortKey = activeDeleteIds[activeDeleteIds.length - 1] ?? memo.memoId;
	return {
		memoId: memo.memoId,
		memo,
		lifecycle,
		lifecycleCursor: `${lifecycle}\u0000${sortKey}\u0000${memo.memoId}`,
		identityLookupKeys: [...new Set(memo.identityBindings.flatMap((binding) => identityLookupKeys(binding.evidence)))],
	};
}

function identityLookupKeys(evidence: {
	sourcePath: string;
	logicalDate: string;
	time: string;
	contentHash: string;
	existingBlockId: string | null;
}): string[] {
	return [
		`path\u0000${evidence.sourcePath}`,
		`tuple\u0000${evidence.sourcePath}\u0000${evidence.logicalDate}\u0000${evidence.time}\u0000${evidence.contentHash}`,
		...(evidence.existingBlockId === null ? [] : [`block\u0000${evidence.sourcePath}\u0000${evidence.existingBlockId}`]),
	];
}

function toMaterializedStateHeader(state: CatalogV2MaterializedState): MaterializedStateHeader {
	const { memos: _memos, ...header } = state;
	return header;
}

function materializeState(
	value: MaterializedStateHeader | CatalogV2MaterializedState,
	records: readonly MaterializedMemoRecord[],
): CatalogV2MaterializedState {
	const header = "memos" in value ? toMaterializedStateHeader(value) : value;
	const memos = records.length === 0 && "memos" in value
		? value.memos
		: Object.fromEntries(records.map((record) => [record.memoId, record.memo]));
	return { ...header, memos };
}

function listFallbackDeletedRecords(state: CatalogV2MaterializedState | null): MaterializedMemoRecord[] {
	return Object.values(state?.memos ?? {})
		.map(toMaterializedMemoRecord)
		.filter((record) => record.lifecycle === "deleted")
		.sort((left, right) => left.lifecycleCursor.localeCompare(right.lifecycleCursor));
}

function listFallbackDeletedPage(
	state: CatalogV2MaterializedState | null,
	revision: number,
	limit: number,
	cursor: string | null,
): CatalogV2LifecyclePage {
	const pageLimit = Math.max(1, Math.min(FALLBACK_MEMO_LIMIT, Math.trunc(limit)));
	const records = listFallbackDeletedRecords(state).filter((record) => cursor === null || record.lifecycleCursor > cursor);
	const visible = records.slice(0, pageLimit);
	return {
		items: visible.map((record) => record.memo),
		nextCursor: records.length > pageLimit ? visible[visible.length - 1]?.lifecycleCursor ?? null : null,
		revision: formatStateRevision(revision),
	};
}

function trimFallbackEnvelopes(values: Map<string, StateOperationEnvelope[]>): void {
	let count = [...values.values()].reduce((total, items) => total + items.length, 0);
	for (const path of [...values.keys()].sort()) {
		if (count <= FALLBACK_OPERATION_LIMIT) return;
		const items = values.get(path) ?? [];
		values.delete(path);
		count -= items.length;
	}
}

function formatStateRevision(revision: number): string {
	return `state-${Math.max(0, Math.trunc(revision))}`;
}

function readCursorPage<T>(source: IDBIndex, range: IDBKeyRange, limit: number): Promise<T[]> {
	return new Promise((resolve, reject) => {
		const values: T[] = [];
		const request = source.openCursor(range);
		request.onsuccess = () => {
			const cursor = request.result;
			if (cursor === null || values.length >= limit) {
				resolve(values);
				return;
			}
			values.push(cursor.value as T);
			cursor.continue();
		};
		request.onerror = () => reject(request.error ?? new Error("IndexedDB cursor failed."));
	});
}

function readCursorPrimaryKeys(source: IDBIndex, range: IDBKeyRange): Promise<string[]> {
	return new Promise((resolve, reject) => {
		const values: string[] = [];
		const request = source.openKeyCursor(range);
		request.onsuccess = () => {
			const cursor = request.result;
			if (cursor === null) {
				resolve(values);
				return;
			}
			values.push(String(cursor.primaryKey));
			cursor.continue();
		};
		request.onerror = () => reject(request.error ?? new Error("IndexedDB key cursor failed."));
	});
}

function assertWriterId(writerId: string): void {
	if (!/^w_[a-f0-9]{32}$/u.test(writerId)) throw new Error("Invalid writerId.");
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed."));
	});
}

function waitForTransaction(transaction: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		transaction.oncomplete = () => resolve();
		transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed."));
		transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted."));
	});
}

function deleteDatabase(factory: IDBFactory, name: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const request = factory.deleteDatabase(name);
		request.onsuccess = () => resolve();
		request.onerror = () => reject(request.error ?? new Error("IndexedDB deletion failed."));
		request.onblocked = () => reject(new Error("IndexedDB deletion was blocked."));
	});
}

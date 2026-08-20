import { canonicalJson } from "./CatalogV2Protocol";
import type { StateOperation } from "../types/catalogV2";
import type {
	CatalogV2OutboxItem,
	CatalogV2PendingPointer,
	CatalogV2PendingTransaction,
	CatalogV2StateOperationOutboxItem,
	StateOperationDraft,
} from "../types/catalogV2Runtime";

const TRANSACTION_DATABASE_VERSION = 1;
const PENDING_STORE = "pending";
const OUTBOX_STORE = "outbox";
const META_STORE = "meta";

interface TransactionMetaRecord<T = unknown> {
	key: string;
	value: T;
}

export interface IndexedDbCatalogV2TransactionStoreOptions {
	factory?: IDBFactory;
	keyRange?: typeof IDBKeyRange;
	version?: number;
}

export type CatalogV2TransactionStoreHealth = "closed" | "opening" | "open" | "degraded" | "fallback";

export class IndexedDbCatalogV2TransactionStore {
	private database: IDBDatabase | null = null;
	private fallbackActive = false;
	private health: CatalogV2TransactionStoreHealth = "closed";
	private opening: Promise<void> | null = null;
	private readonly factory: IDBFactory | undefined;
	private readonly keyRange: typeof IDBKeyRange | undefined;
	private readonly version: number;

	constructor(
		private readonly databaseName: string,
		options: IndexedDbCatalogV2TransactionStoreOptions = {},
	) {
		this.factory = options.factory ?? (typeof indexedDB === "undefined" ? undefined : indexedDB);
		this.keyRange = options.keyRange ?? (typeof IDBKeyRange === "undefined" ? undefined : IDBKeyRange);
		this.version = options.version ?? TRANSACTION_DATABASE_VERSION;
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
			this.database = await openTransactionDatabase(this.factory, this.databaseName, this.version);
			validateTransactionDatabase(this.database);
			await cleanupLegacyLocalOutbox(this.database);
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

	getHealth(): CatalogV2TransactionStoreHealth {
		return this.health;
	}

	async retryOpen(): Promise<boolean> {
		if (this.database !== null) return true;
		this.fallbackActive = false;
		await this.open();
		return this.isAuthoritative();
	}

	async putPending(transactionValue: CatalogV2PendingTransaction | CatalogV2PendingPointer): Promise<void> {
		await this.ensureAuthoritative();
		const transaction = this.getDatabase().transaction(PENDING_STORE, "readwrite");
		const done = waitForTransaction(transaction);
		transaction.objectStore(PENDING_STORE).put(transactionValue);
		await done;
	}

	async listPending(): Promise<CatalogV2PendingTransaction[]> {
		await this.ensureReadable();
		if (this.fallbackActive) return [];
		const transaction = this.getDatabase().transaction(PENDING_STORE, "readonly");
		const done = waitForTransaction(transaction);
		const values = await requestResult(transaction.objectStore(PENDING_STORE).getAll()) as CatalogV2PendingTransaction[];
		await done;
		return values.sort((left, right) => left.transactionId.localeCompare(right.transactionId));
	}

	async putPendingPointer(transactionValue: CatalogV2PendingPointer): Promise<void> {
		return this.putPending(transactionValue);
	}

	async listPendingPointers(): Promise<CatalogV2PendingPointer[]> {
		return (await this.listPending()).flatMap((value) => {
			const candidate = value as CatalogV2PendingTransaction | CatalogV2PendingPointer;
			if (!("sharedPrepare" in candidate) || candidate.sharedPrepare === undefined) return [];
			return [{
				transactionId: candidate.transactionId,
				kind: candidate.kind,
				memoId: candidate.memoId,
				sourcePath: candidate.sourcePath,
				logicalDate: candidate.logicalDate,
				createdAt: candidate.createdAt,
				sharedPrepare: candidate.sharedPrepare,
			}];
		});
	}

	async deletePending(transactionId: string): Promise<void> {
		await this.ensureAuthoritative();
		const transaction = this.getDatabase().transaction(PENDING_STORE, "readwrite");
		const done = waitForTransaction(transaction);
		transaction.objectStore(PENDING_STORE).delete(transactionId);
		await done;
	}

	async putOutbox(item: CatalogV2OutboxItem): Promise<void> {
		await this.ensureAuthoritative();
		const transaction = this.getDatabase().transaction(OUTBOX_STORE, "readwrite");
		const done = waitForTransaction(transaction);
		transaction.objectStore(OUTBOX_STORE).put(item);
		await done;
	}

	async listOutbox(): Promise<CatalogV2OutboxItem[]> {
		await this.ensureReadable();
		if (this.fallbackActive) return [];
		const transaction = this.getDatabase().transaction(OUTBOX_STORE, "readonly");
		const done = waitForTransaction(transaction);
		const values = await requestResult(transaction.objectStore(OUTBOX_STORE).getAll()) as CatalogV2OutboxItem[];
		await done;
		return values.sort(compareOutboxItems);
	}

	async listStateOperationOutbox(): Promise<CatalogV2StateOperationOutboxItem[]> {
		return (await this.listOutbox()).filter((item): item is CatalogV2StateOperationOutboxItem => item.kind === "state_operation")
			.sort((left, right) => left.operation.writerId.localeCompare(right.operation.writerId)
				|| left.operation.sequence - right.operation.sequence
				|| left.id.localeCompare(right.id));
	}

	async getOutbox(id: string): Promise<CatalogV2OutboxItem | null> {
		await this.ensureReadable();
		if (this.fallbackActive) return null;
		const transaction = this.getDatabase().transaction(OUTBOX_STORE, "readonly");
		const done = waitForTransaction(transaction);
		const value = await requestResult(transaction.objectStore(OUTBOX_STORE).get(id)) as CatalogV2OutboxItem | undefined;
		await done;
		return value ?? null;
	}

	async deleteOutbox(id: string): Promise<void> {
		await this.ensureAuthoritative();
		const transaction = this.getDatabase().transaction(OUTBOX_STORE, "readwrite");
		const done = waitForTransaction(transaction);
		transaction.objectStore(OUTBOX_STORE).delete(id);
		await done;
	}

	async assignStateOperation(
		writerId: string,
		draft: StateOperationDraft,
		minimumSequence: number,
		companions: readonly CatalogV2OutboxItem[] = [],
	): Promise<StateOperation> {
		await this.ensureAuthoritative();
		const transaction = this.getDatabase().transaction([OUTBOX_STORE, META_STORE], "readwrite");
		const done = waitForTransaction(transaction);
		const outbox = transaction.objectStore(OUTBOX_STORE);
		const metadata = transaction.objectStore(META_STORE);
		const assignmentKey = `assigned:${draft.opId}`;
		const assigned = await requestResult(metadata.get(assignmentKey)) as TransactionMetaRecord<StateOperation> | undefined;
		if (assigned !== undefined) {
			if (assigned.value.writerId !== writerId || canonicalJson(toDraft(assigned.value)) !== canonicalJson(draft)) {
				transaction.abort();
				await done.catch(() => undefined);
				throw new Error(`Assigned opId collision: ${draft.opId}`);
			}
			try {
				await putCompanions(outbox, companions, draft.opId);
			} catch (error) {
				transaction.abort();
				await done.catch(() => undefined);
				throw error;
			}
			await done;
			return assigned.value;
		}
		const existing = await requestResult(outbox.get(draft.opId)) as CatalogV2OutboxItem | undefined;
		if (existing !== undefined) {
			if (existing.kind !== "state_operation" || canonicalJson(toDraft(existing.operation)) !== canonicalJson(draft)) {
				transaction.abort();
				await done.catch(() => undefined);
				throw new Error(`Outbox opId collision: ${draft.opId}`);
			}
			metadata.put({ key: assignmentKey, value: existing.operation } satisfies TransactionMetaRecord<StateOperation>);
			try {
				await putCompanions(outbox, companions, draft.opId);
			} catch (error) {
				transaction.abort();
				await done.catch(() => undefined);
				throw error;
			}
			await done;
			return existing.operation;
		}

		const metaKey = `nextSequence:${writerId}`;
		const current = await requestResult(metadata.get(metaKey)) as TransactionMetaRecord<number> | undefined;
		const sequence = Math.max(current?.value ?? minimumSequence, minimumSequence);
		const operation = createStateOperation(writerId, sequence, draft);
		outbox.put({ id: operation.opId, kind: "state_operation", operation } satisfies CatalogV2StateOperationOutboxItem);
		try {
			await putCompanions(outbox, companions, operation.opId);
		} catch (error) {
			transaction.abort();
			await done.catch(() => undefined);
			throw error;
		}
		metadata.put({ key: assignmentKey, value: operation } satisfies TransactionMetaRecord<StateOperation>);
		metadata.put({ key: metaKey, value: sequence + 1 } satisfies TransactionMetaRecord<number>);
		await done;
		return operation;
	}

	private getDatabase(): IDBDatabase {
		if (this.database === null) throw new Error("Catalog v2 transaction store is not open.");
		return this.database;
	}

	private async ensureReadable(): Promise<void> {
		if (this.database === null && this.health !== "fallback") await this.retryOpen();
	}

	private async ensureAuthoritative(): Promise<void> {
		if (this.database === null && this.health !== "fallback") await this.retryOpen();
		if (!this.isAuthoritative()) throw new Error("Catalog v2 transaction storage is not durable.");
	}
}

function cleanupLegacyLocalOutbox(database: IDBDatabase): Promise<void> {
	const transaction = database.transaction(OUTBOX_STORE, "readwrite");
	const done = waitForTransaction(transaction);
	const store = transaction.objectStore(OUTBOX_STORE);
	const request = store.openCursor();
	request.onsuccess = () => {
		const cursor = request.result;
		if (cursor === null) return;
		const value = cursor.value as CatalogV2OutboxItem;
		if (value.kind === "monthly_projection" || value.kind === "deleted_payload_cleanup") cursor.delete();
		cursor.continue();
	};
	return done;
}

async function putCompanions(
	outbox: IDBObjectStore,
	companions: readonly CatalogV2OutboxItem[],
	operationId: string,
): Promise<void> {
	for (const companion of companions) {
		if (companion.kind === "state_operation" || companion.id === operationId) {
			throw new Error("A state operation companion must be a distinct non-state outbox item.");
		}
		const existing = await requestResult(outbox.get(companion.id)) as CatalogV2OutboxItem | undefined;
		if (existing !== undefined && canonicalJson(existing) !== canonicalJson(companion)) {
			throw new Error(`Outbox companion collision: ${companion.id}`);
		}
		outbox.put(companion);
	}
}

function createStateOperation(writerId: string, sequence: number, draft: StateOperationDraft): StateOperation {
	return { schemaVersion: 1, writerId, sequence, ...draft } as StateOperation;
}

function toDraft(operation: StateOperation): StateOperationDraft {
	const { schemaVersion: _schemaVersion, writerId: _writerId, sequence: _sequence, ...draft } = operation;
	return draft;
}

function compareOutboxItems(left: CatalogV2OutboxItem, right: CatalogV2OutboxItem): number {
	return left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id);
}

function openTransactionDatabase(factory: IDBFactory, name: string, version: number): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = factory.open(name, version);
		let settled = false;
		request.onupgradeneeded = () => {
			const database = request.result;
			if (!database.objectStoreNames.contains(PENDING_STORE)) database.createObjectStore(PENDING_STORE, { keyPath: "transactionId" });
			if (!database.objectStoreNames.contains(OUTBOX_STORE)) database.createObjectStore(OUTBOX_STORE, { keyPath: "id" });
			if (!database.objectStoreNames.contains(META_STORE)) database.createObjectStore(META_STORE, { keyPath: "key" });
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
			reject(request.error ?? new Error("Catalog v2 transaction database open failed."));
		};
		request.onblocked = () => {
			if (settled) return;
			settled = true;
			reject(new Error("Catalog v2 transaction database open was blocked."));
		};
	});
}

function validateTransactionDatabase(database: IDBDatabase): void {
	for (const storeName of [PENDING_STORE, OUTBOX_STORE, META_STORE]) {
		if (!database.objectStoreNames.contains(storeName)) {
			throw new Error(`Catalog v2 transaction store is missing: ${storeName}.`);
		}
	}
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

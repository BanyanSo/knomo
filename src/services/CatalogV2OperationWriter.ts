import type { ArtifactRef, StateOperation } from "../types/catalogV2";
import type { CatalogV2OutboxItem, StateOperationDraft } from "../types/catalogV2Runtime";
import type { IndexedDbCatalogV2TransactionStore } from "./IndexedDbCatalogV2TransactionStore";

export interface CatalogV2WriterIdentityStore {
	getOrCreateWriterId(): Promise<string>;
	isAuthoritative?(): boolean;
}

export interface CatalogV2StateAppender {
	getLastSequence(writerId: string, memoId?: string): Promise<number>;
	append(operation: StateOperation): Promise<ArtifactRef>;
}

export interface CatalogV2OutboxFlushResult {
	appended: number;
	failed: number;
}

export class CatalogV2OperationWriter {
	constructor(
		private readonly identityStore: CatalogV2WriterIdentityStore,
		private readonly transactionStore: IndexedDbCatalogV2TransactionStore,
		private readonly appender: CatalogV2StateAppender,
	) {}

	async queue(draft: StateOperationDraft, companions: readonly CatalogV2OutboxItem[] = []): Promise<StateOperation> {
		if (this.identityStore.isAuthoritative?.() === false) {
			throw new Error("Catalog v2 writer identity storage is not durable.");
		}
		const writerId = await this.identityStore.getOrCreateWriterId();
		const minimumSequence = await this.appender.getLastSequence(writerId, draft.memoId) + 1;
		return this.transactionStore.assignStateOperation(writerId, draft, minimumSequence, companions);
	}

	async flush(): Promise<CatalogV2OutboxFlushResult> {
		const items = await this.transactionStore.listStateOperationOutbox();
		const blockedWriterIds = new Set<string>();
		let appended = 0;
		let failed = 0;
		for (const item of items) {
			const writerId = item.operation.writerId;
			if (blockedWriterIds.has(writerId)) {
				failed += 1;
				continue;
			}
			try {
				await this.appender.append(item.operation);
				await this.transactionStore.deleteOutbox(item.id);
				appended += 1;
			} catch {
				blockedWriterIds.add(writerId);
				failed += 1;
			}
		}
		return { appended, failed };
	}
}

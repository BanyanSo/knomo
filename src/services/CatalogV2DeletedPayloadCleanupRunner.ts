import type { IndexedDbCatalogV2TransactionStore } from "./IndexedDbCatalogV2TransactionStore";
import type { CatalogV2DeletedPayloadStore } from "./CatalogV2DeletedPayloadStore";

export class CatalogV2DeletedPayloadCleanupRunner {
	constructor(
		private readonly transactionStore: IndexedDbCatalogV2TransactionStore,
		_payloadStore: CatalogV2DeletedPayloadStore,
	) {}

	async run(): Promise<{ cleaned: number; waiting: number }> {
		// Protocol V2 只保留逻辑 purge；没有跨设备 GC 安全点时不得删除共享 payload。
		const items = (await this.transactionStore.listOutbox()).filter((item) => item.kind === "deleted_payload_cleanup");
		for (const item of items) {
			await this.transactionStore.deleteOutbox(item.id);
		}
		return { cleaned: 0, waiting: 0 };
	}
}

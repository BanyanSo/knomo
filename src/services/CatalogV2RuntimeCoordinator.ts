import type { Component } from "obsidian";
import type { IndexedDbCatalogV2TransactionStore } from "./IndexedDbCatalogV2TransactionStore";

export interface CatalogV2RuntimeRecoveryResult {
	completedTransactions: number;
	attentionTransactions: number;
	appendedOperations: number;
	failedOperations: number;
	cleanedPayloads: number;
	waitingPayloads: number;
}

export class CatalogV2RuntimeCoordinator {
	private initialized = false;

	constructor(
		private readonly transactionStore: IndexedDbCatalogV2TransactionStore,
	) {}

	start(owner: Component): void {
		owner.register(() => this.stop());
	}

	async initialize(): Promise<CatalogV2RuntimeRecoveryResult> {
		if (!this.initialized) {
			await this.transactionStore.open();
			this.initialized = true;
		}
		return emptyRecoveryResult();
	}

	run(): Promise<CatalogV2RuntimeRecoveryResult> {
		return Promise.resolve(emptyRecoveryResult());
	}

	private stop(): void {
		this.transactionStore.close();
		this.initialized = false;
	}
}

function emptyRecoveryResult(): CatalogV2RuntimeRecoveryResult {
	return {
		completedTransactions: 0,
		attentionTransactions: 0,
		appendedOperations: 0,
		failedOperations: 0,
		cleanedPayloads: 0,
		waitingPayloads: 0,
	};
}

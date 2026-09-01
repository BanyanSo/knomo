import type { App } from "obsidian";

import {
	createIdentityLedgerWriterId,
	isIdentityLedgerWriterId,
} from "./IdentityLedgerProtocol";

export const LOCAL_WRITER_ID_STORAGE_KEY = "knomo.identity.writerId";

type LocalStorageApp = Pick<App, "loadLocalStorage" | "saveLocalStorage">;

// 职责：在当前设备的当前 Vault 范围内持久化并复用 Ledger writer identity。
export class LocalWriterIdentityService {
	private writerIdOperation: Promise<string> | null = null;

	constructor(
		private readonly app: LocalStorageApp,
		private readonly createWriterId: () => string = createIdentityLedgerWriterId,
	) {}

	getWriterId(): Promise<string> {
		if (this.writerIdOperation !== null) return this.writerIdOperation;
		const operation = Promise.resolve().then(() => this.loadOrCreateWriterId());
		this.writerIdOperation = operation;
		void operation.catch(() => {
			if (this.writerIdOperation === operation) this.writerIdOperation = null;
		});
		return operation;
	}

	private loadOrCreateWriterId(): string {
		const saved = this.app.loadLocalStorage(LOCAL_WRITER_ID_STORAGE_KEY);
		if (saved !== null) {
			if (!isIdentityLedgerWriterId(saved)) {
				throw new Error("Local Identity Ledger writerId is invalid.");
			}
			return saved;
		}

		const writerId = this.createWriterId();
		this.app.saveLocalStorage(LOCAL_WRITER_ID_STORAGE_KEY, writerId);
		if (this.app.loadLocalStorage(LOCAL_WRITER_ID_STORAGE_KEY) !== writerId) {
			throw new Error("Local Identity Ledger writerId was not persisted.");
		}
		return writerId;
	}
}

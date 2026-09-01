import type { IdentityLedgerAttentionRoute, IdentityLedgerStatus } from "../types/identityLedger";

export type IdentityRecoveryReloadMode = "none" | "if_needed" | "force";

export interface IdentityRecoveryRequest {
	reload?: IdentityRecoveryReloadMode;
}

export interface IdentityRecoveryCoordinatorOptions {
	getStatus: () => IdentityLedgerStatus;
	getAttentionRoute: () => IdentityLedgerAttentionRoute;
	reload: () => Promise<void>;
	reconcile: () => Promise<void>;
	cancellationSignal?: AbortSignal;
	maxReloadAttempts?: number;
}

const RELOAD_STRENGTH: Readonly<Record<IdentityRecoveryReloadMode, number>> = {
	none: 0,
	if_needed: 1,
	force: 2,
};

/** 合并并发恢复请求，并在更强请求到达时补跑一轮。 */
export class IdentityRecoveryCoordinator {
	private pendingReload: IdentityRecoveryReloadMode = "none";
	private rerunRequested = false;
	private activeOperation: Promise<void> | null = null;
	private stopped = false;
	private runId = 0;
	private readonly maxReloadAttempts: number;

	constructor(private readonly options: IdentityRecoveryCoordinatorOptions) {
		this.maxReloadAttempts = Math.max(1, options.maxReloadAttempts ?? 2);
	}

	request(request: IdentityRecoveryRequest = {}): Promise<void> {
		if (this.isStopped()) return Promise.resolve();
		this.mergeReload(request.reload ?? "none");
		if (this.activeOperation !== null) {
			this.rerunRequested = true;
			return this.activeOperation;
		}

		let operation: Promise<void>;
		operation = this.drain().finally(() => {
			if (this.activeOperation === operation) this.activeOperation = null;
		});
		this.activeOperation = operation;
		return operation;
	}

	stop(): void {
		this.stopped = true;
		this.runId += 1;
		this.pendingReload = "none";
		this.rerunRequested = false;
	}

	private async drain(): Promise<void> {
		do {
			const reload = this.pendingReload;
			this.pendingReload = "none";
			this.rerunRequested = false;
			const runId = ++this.runId;
			await this.runOnce(runId, reload);
		} while (!this.isStopped() && (this.rerunRequested || this.pendingReload !== "none"));
	}

	private async runOnce(runId: number, reloadMode: IdentityRecoveryReloadMode): Promise<void> {
		if (this.shouldReload(reloadMode)) {
			for (let attempt = 0; attempt < this.maxReloadAttempts; attempt += 1) {
				await this.options.reload();
				this.assertCurrent(runId);
				if (this.options.getAttentionRoute() !== "settings_retry") break;
			}
		}
		await this.options.reconcile();
		this.assertCurrent(runId);
	}

	private shouldReload(mode: IdentityRecoveryReloadMode): boolean {
		if (mode === "force") return true;
		if (mode === "none") return false;
		return this.options.getStatus() === "unavailable"
			|| this.options.getAttentionRoute() === "settings_retry";
	}

	private mergeReload(mode: IdentityRecoveryReloadMode): void {
		if (RELOAD_STRENGTH[mode] > RELOAD_STRENGTH[this.pendingReload]) this.pendingReload = mode;
	}

	private assertCurrent(runId: number): void {
		if (this.isStopped() || runId !== this.runId) throw new IdentityRecoveryCancelledError();
	}

	private isStopped(): boolean {
		return this.stopped || this.options.cancellationSignal?.aborted === true;
	}
}

export class IdentityRecoveryCancelledError extends Error {
	constructor() {
		super("Identity recovery was cancelled.");
		this.name = "IdentityRecoveryCancelledError";
	}
}

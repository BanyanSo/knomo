import type { App } from "obsidian";

import type { IdentityLedgerStatus } from "../types/identityLedger";
import type { KnomoSharedConfigStatus } from "../types/knomoConfig";
import { getCatalogDataRootPath } from "../utils/path";
import { ensureFolder } from "../utils/vault";
import type { KnomoDataRootLocation } from "./KnomoDataRootMigrationService";

interface StartupIdentityService {
	initialize(): Promise<void>;
	getStatus(): IdentityLedgerStatus;
}

interface StartupSharedConfigService {
	initialize(): Promise<void>;
	getStatus(): KnomoSharedConfigStatus;
	getLastError(): string | null;
	publishLocalConfig(): Promise<void>;
	resolveWithLocalConfig(): Promise<void>;
}

export interface KnomoStartupBootstrapOptions {
	getLocation: () => KnomoDataRootLocation;
	initializeDataRoot: (dataRoot: string) => Promise<void>;
	identity: StartupIdentityService;
	sharedConfig: StartupSharedConfigService;
	cancellationSignal?: AbortSignal;
}

export type KnomoStartupBootstrapStatus = "unconfigured" | "initializing" | "ready" | "conflicted" | "unavailable";
export type KnomoStartupBootstrapStage = "data_root" | "identity" | "catalog" | "shared_config" | "verification";

export interface KnomoStartupBootstrapSnapshot {
	status: KnomoStartupBootstrapStatus;
	stage: KnomoStartupBootstrapStage | null;
	error: string | null;
}

type BootstrapMode = "initialize" | "retry" | "use_current_device";

/** 启用插件时补齐默认数据根与共享配置；已有共享配置只读取，不覆盖。 */
export class KnomoStartupBootstrapService {
	private snapshot: KnomoStartupBootstrapSnapshot = {
		status: "unconfigured",
		stage: null,
		error: null,
	};
	private activeOperation: Promise<void> | null = null;
	private activeMode: BootstrapMode | null = null;
	private queuedUseCurrentOperation: Promise<void> | null = null;

	constructor(
		private readonly app: App,
		private readonly options: KnomoStartupBootstrapOptions,
	) {}

	getSnapshot(): KnomoStartupBootstrapSnapshot {
		return { ...this.snapshot };
	}

	initialize(): Promise<void> {
		return this.activeOperation ?? this.startOperation("initialize");
	}

	retryInitialization(): Promise<void> {
		return this.activeOperation ?? this.startOperation("retry");
	}

	useCurrentDeviceSettings(): Promise<void> {
		if (this.activeOperation === null) return this.startOperation("use_current_device");
		if (this.activeMode === "use_current_device") return this.activeOperation;
		if (this.queuedUseCurrentOperation !== null) return this.queuedUseCurrentOperation;

		let queuedOperation: Promise<void>;
		queuedOperation = this.activeOperation.then(
			() => this.startOperation("use_current_device"),
			() => this.startOperation("use_current_device"),
		).finally(() => {
			if (this.queuedUseCurrentOperation === queuedOperation) this.queuedUseCurrentOperation = null;
		});
		this.queuedUseCurrentOperation = queuedOperation;
		return queuedOperation;
	}

	private startOperation(mode: BootstrapMode): Promise<void> {
		let operation: Promise<void>;
		operation = this.runOnce(mode).finally(() => {
			if (this.activeOperation === operation) {
				this.activeOperation = null;
				this.activeMode = null;
			}
		});
		this.activeMode = mode;
		this.activeOperation = operation;
		return operation;
	}

	private async runOnce(mode: BootstrapMode): Promise<void> {
		let stage: KnomoStartupBootstrapStage = "data_root";
		this.setInitializing(stage);
		try {
			await this.waitForLayoutReady();
			this.throwIfCancelled();
			let location = this.options.getLocation();
			if (!location.knomoDataRootConfigured) {
				await this.options.initializeDataRoot(location.knomoDataRoot);
				this.throwIfCancelled();
				location = this.options.getLocation();
				if (!location.knomoDataRootConfigured) {
					throw new Error("Knomo Data Root initialization did not persist its location.");
				}
			}

			stage = "identity";
			this.setInitializing(stage);
			await this.options.identity.initialize();
			this.throwIfCancelled();
			const identityStatus = this.options.identity.getStatus();
			if (identityStatus === "missing") {
				throw new Error("Configured Identity Ledger root is missing.");
			}
			if (identityStatus === "unavailable") {
				throw new Error("Identity Ledger cannot be read.");
			}

			stage = "catalog";
			this.setInitializing(stage);
			await ensureFolder(this.app, getCatalogDataRootPath(location.knomoDataRoot));
			this.throwIfCancelled();

			stage = "shared_config";
			this.setInitializing(stage);
			await this.options.sharedConfig.initialize();
			this.throwIfCancelled();
			const sharedStatus = this.options.sharedConfig.getStatus();
			if (sharedStatus === "unavailable") {
				throw new Error(this.options.sharedConfig.getLastError() ?? "Shared configuration cannot be read.");
			}
			if (sharedStatus === "conflicted") {
				if (mode !== "use_current_device") {
					this.snapshot = { status: "conflicted", stage, error: null };
					return;
				}
				await this.options.sharedConfig.resolveWithLocalConfig();
				this.throwIfCancelled();
			} else if (sharedStatus === "missing") {
				if (mode === "retry") {
					this.snapshot = { status: "unconfigured", stage, error: null };
					return;
				}
				await this.options.sharedConfig.publishLocalConfig();
				this.throwIfCancelled();
			} else if (mode === "use_current_device") {
				await this.options.sharedConfig.publishLocalConfig();
				this.throwIfCancelled();
			}

			stage = "verification";
			this.setInitializing(stage);
			await this.options.sharedConfig.initialize();
			this.throwIfCancelled();
			const verifiedStatus = this.options.sharedConfig.getStatus();
			if (verifiedStatus === "conflicted") {
				throw new Error("Shared configuration remains conflicted after initialization.");
			}
			if (verifiedStatus !== "ready") {
				throw new Error(this.options.sharedConfig.getLastError() ?? "Shared configuration verification failed.");
			}
			this.snapshot = { status: "ready", stage: null, error: null };
		} catch (error) {
			if (error instanceof KnomoStartupCancelledError || this.options.cancellationSignal?.aborted === true) {
				throw new KnomoStartupCancelledError();
			}
			const detail = error instanceof Error ? error.message : String(error);
			const conflicted = (stage === "shared_config" || stage === "verification")
				&& this.options.sharedConfig.getStatus() === "conflicted";
			this.snapshot = {
				status: conflicted ? "conflicted" : "unavailable",
				stage,
				error: detail,
			};
			throw error;
		}
	}

	private async waitForLayoutReady(): Promise<void> {
		this.throwIfCancelled();
		if (this.app.workspace.layoutReady) return;
		await new Promise<void>((resolve, reject) => {
			let settled = false;
			const signal = this.options.cancellationSignal;
			const finish = () => {
				if (settled) return;
				settled = true;
				signal?.removeEventListener("abort", cancel);
				resolve();
			};
			const cancel = () => {
				if (settled) return;
				settled = true;
				reject(new KnomoStartupCancelledError());
			};
			signal?.addEventListener("abort", cancel, { once: true });
			this.app.workspace.onLayoutReady(finish);
			if (this.app.workspace.layoutReady) finish();
			if (signal?.aborted === true) cancel();
		});
		this.throwIfCancelled();
	}

	private throwIfCancelled(): void {
		if (this.options.cancellationSignal?.aborted === true) {
			throw new KnomoStartupCancelledError();
		}
	}

	private setInitializing(stage: KnomoStartupBootstrapStage): void {
		this.snapshot = {
			status: "initializing",
			stage,
			error: this.snapshot.error,
		};
	}

}

class KnomoStartupCancelledError extends Error {
	constructor() {
		super("Knomo startup initialization was cancelled.");
	}
}

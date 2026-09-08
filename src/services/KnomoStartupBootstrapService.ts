import type { App } from "obsidian";
import type { KnomoCurrentConfigStatus } from "../types/knomoConfig";
import { getCatalogDataRootPath } from "../utils/path";
import { ensureFolder } from "../utils/vault";
import type { KnomoDataRootLocation } from "./RecoveryDataRootService";

interface StartupCurrentConfigService {
	initialize(): Promise<void>;
	getStatus(): KnomoCurrentConfigStatus;
	getLastError(): string | null;
}

export interface KnomoStartupBootstrapOptions {
	getLocation: () => KnomoDataRootLocation;
	initializeDataRoot: (dataRoot: string) => Promise<void>;
	currentConfig: StartupCurrentConfigService;
	cancellationSignal?: AbortSignal;
}

export type KnomoStartupBootstrapStatus = "unconfigured" | "initializing" | "ready" | "conflicted" | "unavailable";
export type KnomoStartupBootstrapStage = "data_root" | "catalog" | "shared_config" | "verification";

export interface KnomoStartupBootstrapSnapshot {
	status: KnomoStartupBootstrapStatus;
	stage: KnomoStartupBootstrapStage | null;
	error: string | null;
}

type BootstrapMode = "initialize" | "retry" | "initialize_new";

/** 启用插件时补齐默认数据根与当前配置；已有配置不可读时不覆盖。 */
export class KnomoStartupBootstrapService {
	private snapshot: KnomoStartupBootstrapSnapshot = {
		status: "unconfigured",
		stage: null,
		error: null,
	};
	private activeOperation: Promise<void> | null = null;
	private activeMode: BootstrapMode | null = null;
	private queuedNewOperation: Promise<void> | null = null;
	private activeDataRoot: string | null = null;

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

	initializeNewDataRoot(dataRoot: string): Promise<void> {
		if (this.activeOperation === null) return this.startOperation("initialize_new", dataRoot);
		if (this.activeMode === "initialize_new" && this.activeDataRoot === dataRoot) return this.activeOperation;
		if (this.queuedNewOperation !== null) return this.queuedNewOperation;

		let queuedOperation: Promise<void>;
		queuedOperation = this.activeOperation.then(
			() => this.startOperation("initialize_new", dataRoot),
			() => this.startOperation("initialize_new", dataRoot),
		).finally(() => {
			if (this.queuedNewOperation === queuedOperation) this.queuedNewOperation = null;
		});
		this.queuedNewOperation = queuedOperation;
		return queuedOperation;
	}

	private startOperation(mode: BootstrapMode, dataRoot: string | null = null): Promise<void> {
		let operation: Promise<void>;
		operation = this.runOnce(mode, dataRoot).finally(() => {
			if (this.activeOperation === operation) {
				this.activeOperation = null;
				this.activeMode = null;
				this.activeDataRoot = null;
			}
		});
		this.activeMode = mode;
		this.activeDataRoot = dataRoot;
		this.activeOperation = operation;
		return operation;
	}

	private async runOnce(mode: BootstrapMode, requestedDataRoot: string | null): Promise<void> {
		let stage: KnomoStartupBootstrapStage = "data_root";
		this.setInitializing(stage);
		try {
			await this.waitForLayoutReady();
			this.throwIfCancelled();
			let location = this.options.getLocation();
			if (!location.knomoDataRootConfigured) {
				if (mode !== "initialize_new" && mode !== "initialize") {
					this.snapshot = { status: "unconfigured", stage, error: null };
					return;
				}
				const dataRoot = requestedDataRoot ?? location.knomoDataRoot;
				this.throwIfCancelled();
				await this.options.initializeDataRoot(dataRoot);
				this.throwIfCancelled();
				location = this.options.getLocation();
				if (!location.knomoDataRootConfigured) {
					throw new Error("Knomo Data Root initialization did not persist its location.");
				}
			}

			stage = "catalog";
			this.setInitializing(stage);
			await ensureFolder(this.app, getCatalogDataRootPath(location.knomoDataRoot));
			this.throwIfCancelled();

			stage = "shared_config";
			this.setInitializing(stage);
			await this.options.currentConfig.initialize();
			this.throwIfCancelled();
			const sharedStatus = this.options.currentConfig.getStatus();
			if (sharedStatus === "unavailable") {
				throw new Error(this.options.currentConfig.getLastError() ?? "Shared configuration cannot be read.");
			}
			if (sharedStatus !== "ready") {
				this.snapshot = { status: sharedStatus === "conflicted" ? "conflicted" : "unconfigured", stage, error: null };
				return;
			}

			stage = "verification";
			this.setInitializing(stage);
			await this.options.currentConfig.initialize();
			this.throwIfCancelled();
			const verifiedStatus = this.options.currentConfig.getStatus();
			if (verifiedStatus === "conflicted") {
				throw new Error("Shared configuration remains conflicted after initialization.");
			}
			if (verifiedStatus !== "ready") {
				throw new Error(this.options.currentConfig.getLastError() ?? "Shared configuration verification failed.");
			}
			this.snapshot = { status: "ready", stage: null, error: null };
		} catch (error) {
			if (error instanceof KnomoStartupCancelledError || this.options.cancellationSignal?.aborted === true) {
				throw new KnomoStartupCancelledError();
			}
			const detail = error instanceof Error ? error.message : String(error);
			const conflicted = (stage === "shared_config" || stage === "verification")
				&& this.options.currentConfig.getStatus() === "conflicted";
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

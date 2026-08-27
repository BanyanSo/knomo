import { normalizePath, TFolder } from "obsidian";
import type { App } from "obsidian";

import type { IdentityLedgerStatus } from "../types/identityLedger";
import type { KnomoSharedConfigStatus } from "../types/knomoConfig";
import { getCatalogDataRootPath } from "../utils/path";
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
}

export type KnomoStartupBootstrapStatus = "unconfigured" | "initializing" | "ready" | "conflicted" | "unavailable";
export type KnomoStartupBootstrapStage = "data_root" | "identity" | "catalog" | "shared_config" | "verification";

export interface KnomoStartupBootstrapSnapshot {
	status: KnomoStartupBootstrapStatus;
	stage: KnomoStartupBootstrapStage | null;
	error: string | null;
}

type BootstrapMode = "initialize" | "use_current_device";

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
			let location = this.options.getLocation();
			if (!location.knomoDataRootConfigured) {
				await this.options.initializeDataRoot(location.knomoDataRoot);
				location = this.options.getLocation();
				if (!location.knomoDataRootConfigured) {
					throw new Error("Knomo Data Root initialization did not persist its location.");
				}
			}

			stage = "identity";
			this.setInitializing(stage);
			await this.options.identity.initialize();
			const identityStatus = this.options.identity.getStatus();
			if (identityStatus === "missing") {
				throw new Error("Configured Identity Ledger root is missing.");
			}
			if (identityStatus === "unavailable") {
				throw new Error("Identity Ledger cannot be read.");
			}

			stage = "catalog";
			this.setInitializing(stage);
			await this.ensureFolder(getCatalogDataRootPath(location.knomoDataRoot));

			stage = "shared_config";
			this.setInitializing(stage);
			await this.options.sharedConfig.initialize();
			const sharedStatus = this.options.sharedConfig.getStatus();
			if (sharedStatus === "unavailable") {
				throw new Error(this.options.sharedConfig.getLastError() ?? "Shared configuration cannot be read.");
			}
			if (sharedStatus === "conflicted") {
				if (mode === "initialize") {
					this.snapshot = { status: "conflicted", stage, error: null };
					return;
				}
				await this.options.sharedConfig.resolveWithLocalConfig();
			} else if (sharedStatus === "missing" || mode === "use_current_device") {
				await this.options.sharedConfig.publishLocalConfig();
			}

			stage = "verification";
			this.setInitializing(stage);
			await this.options.sharedConfig.initialize();
			const verifiedStatus = this.options.sharedConfig.getStatus();
			if (verifiedStatus === "conflicted") {
				throw new Error("Shared configuration remains conflicted after initialization.");
			}
			if (verifiedStatus !== "ready") {
				throw new Error(this.options.sharedConfig.getLastError() ?? "Shared configuration verification failed.");
			}
			this.snapshot = { status: "ready", stage: null, error: null };
		} catch (error) {
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

	private setInitializing(stage: KnomoStartupBootstrapStage): void {
		this.snapshot = {
			status: "initializing",
			stage,
			error: this.snapshot.error,
		};
	}

	private async ensureFolder(path: string): Promise<void> {
		const segments = normalizePath(path).split("/").filter(Boolean);
		let current = "";
		for (const segment of segments) {
			current = current.length === 0 ? segment : `${current}/${segment}`;
			const existing = this.app.vault.getAbstractFileByPath(current);
			if (existing instanceof TFolder) continue;
			if (existing !== null) throw new Error(`Knomo data path is not a folder: ${current}`);
			try {
				await this.app.vault.createFolder(current);
			} catch (error) {
				if (!(this.app.vault.getAbstractFileByPath(current) instanceof TFolder)) throw error;
			}
		}
	}
}

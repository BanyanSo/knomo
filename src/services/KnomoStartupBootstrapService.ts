import type { App } from "obsidian";
import type { KnomoCurrentConfigStatus } from "../types/knomoConfig";

interface StartupCurrentConfigService {
	initialize(): Promise<void>;
	getStatus(): KnomoCurrentConfigStatus;
	getLastError(): string | null;
}

export interface KnomoStartupBootstrapOptions {
	currentConfig: StartupCurrentConfigService;
	cancellationSignal?: AbortSignal;
}

export type KnomoStartupBootstrapStatus = "unconfigured" | "initializing" | "ready" | "conflicted" | "unavailable";
export type KnomoStartupBootstrapStage = "current_config" | "verification";

export interface KnomoStartupBootstrapSnapshot {
	status: KnomoStartupBootstrapStatus;
	stage: KnomoStartupBootstrapStage | null;
	error: string | null;
}

/** 启用插件时初始化并确认当前配置；已有配置不可读时不覆盖。 */
export class KnomoStartupBootstrapService {
	private snapshot: KnomoStartupBootstrapSnapshot = {
		status: "unconfigured",
		stage: null,
		error: null,
	};
	private activeOperation: Promise<void> | null = null;

	constructor(
		private readonly app: App,
		private readonly options: KnomoStartupBootstrapOptions,
	) {}

	getSnapshot(): KnomoStartupBootstrapSnapshot {
		return { ...this.snapshot };
	}

	initialize(): Promise<void> {
		return this.activeOperation ?? this.startOperation();
	}

	retryInitialization(): Promise<void> {
		return this.activeOperation ?? this.startOperation();
	}

	private startOperation(): Promise<void> {
		let operation: Promise<void>;
		operation = this.runOnce().finally(() => {
			if (this.activeOperation === operation) {
				this.activeOperation = null;
			}
		});
		this.activeOperation = operation;
		return operation;
	}

	private async runOnce(): Promise<void> {
		let stage: KnomoStartupBootstrapStage = "current_config";
		this.setInitializing(stage);
		try {
			await this.waitForLayoutReady();
			this.throwIfCancelled();
			stage = "current_config";
			this.setInitializing(stage);
			await this.options.currentConfig.initialize();
			this.throwIfCancelled();
			const currentStatus = this.options.currentConfig.getStatus();
			if (currentStatus === "unavailable") {
				throw new Error(this.options.currentConfig.getLastError() ?? "Current configuration cannot be read.");
			}
			if (currentStatus !== "ready") {
				this.snapshot = { status: currentStatus === "conflicted" ? "conflicted" : "unconfigured", stage, error: null };
				return;
			}

			stage = "verification";
			this.setInitializing(stage);
			await this.options.currentConfig.initialize();
			this.throwIfCancelled();
			const verifiedStatus = this.options.currentConfig.getStatus();
			if (verifiedStatus === "conflicted") {
				throw new Error("Current configuration remains conflicted after initialization.");
			}
			if (verifiedStatus !== "ready") {
				throw new Error(this.options.currentConfig.getLastError() ?? "Current configuration verification failed.");
			}
			this.snapshot = { status: "ready", stage: null, error: null };
		} catch (error) {
			if (error instanceof KnomoStartupCancelledError || this.options.cancellationSignal?.aborted === true) {
				throw new KnomoStartupCancelledError();
			}
			const detail = error instanceof Error ? error.message : String(error);
			const conflicted = (stage === "current_config" || stage === "verification")
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

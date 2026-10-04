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

	initialize(configurationOperation?: Promise<void>): Promise<void> {
		if (this.activeOperation !== null && configurationOperation !== undefined) {
			return Promise.all([this.activeOperation.catch(() => undefined), configurationOperation.catch(() => undefined)])
				.then(() => this.initialize(configurationOperation));
		}
		return this.activeOperation ?? this.startOperation(configurationOperation);
	}

	private startOperation(configurationOperation?: Promise<void>): Promise<void> {
		// 立即接住后台配置失败，不能等布局就绪后才订阅 rejection。
		const configurationResult = configurationOperation?.then(
			() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, error }),
		);
		let operation: Promise<void>;
		operation = this.runOnce(configurationResult).finally(() => {
			if (this.activeOperation === operation) {
				this.activeOperation = null;
			}
		});
		this.activeOperation = operation;
		return operation;
	}

	private async runOnce(configurationResult?: Promise<{ ok: true } | { ok: false; error: unknown }>): Promise<void> {
		let stage: KnomoStartupBootstrapStage = "current_config";
		this.setInitializing(stage);
		try {
			await this.waitForLayoutReady();
			this.throwIfCancelled();
			stage = "current_config";
			this.setInitializing(stage);
			if (configurationResult === undefined) await this.options.currentConfig.initialize();
			else {
				const result = await configurationResult;
				if (!result.ok) throw result.error;
			}
			this.throwIfCancelled();
			const currentStatus = this.options.currentConfig.getStatus();
			if (currentStatus === "unavailable") {
				throw new Error(this.options.currentConfig.getLastError() ?? "Current configuration cannot be read.");
			}
			if (currentStatus !== "ready") {
				this.snapshot = { status: currentStatus === "conflicted" ? "conflicted" : "unconfigured", stage, error: null };
				return;
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

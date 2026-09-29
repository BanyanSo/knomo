import type { Component } from "obsidian";
import type { KnomoCurrentConfig, KnomoCurrentConfigStatus } from "../types/knomoConfig";
import type { SettingsService } from "./SettingsService";
import type { DailyNotesProvider } from "./DailyNotesProvider";
import { buildKnomoCurrentConfig } from "./KnomoCurrentConfig";
import { normalizeMonthlyLocaleKey } from "./MonthlyProjection";

// 读取、验证并通知当前配置，不保存配置事件。
export class KnomoCurrentConfigService {
	private error: string | null = null;
	private verified = false;
	private initializing: Promise<void> | null = null;
	private refreshing: Promise<void> | null = null;
	private refreshingReload = false;
	private verifiedKey: string | null = null;
	private onChanged: (() => void | Promise<void>) | null = null;

	constructor(private readonly settings: SettingsService, private readonly daily: DailyNotesProvider,
		private readonly locale: () => string,
		private readonly options: {
			prepareInitialization?: (reload: boolean) => Promise<void>;
			cancellationSignal?: AbortSignal;
		} = {}) {}

	initialize(): Promise<void> {
		return this.refreshing ?? this.initializing ?? this.startInitialization(false);
	}

	private startInitialization(reload: boolean, refreshDaily = false): Promise<void> {
		this.verified = false;
		const operation = Promise.resolve().then(async () => {
			this.assertActive();
			if (reload) await this.settings.loadSettings();
			this.assertActive();
			await this.options.prepareInitialization?.(reload);
			this.assertActive();
			if (refreshDaily) await this.daily.loadConfig();
			this.assertActive();
			await this.initializeCurrent();
		}).catch((error: unknown) => {
			this.verified = false;
			this.error = String(error);
			throw error;
		}).finally(() => { if (this.initializing === operation) this.initializing = null; });
		this.initializing = operation;
		return operation;
	}

	private async initializeCurrent(): Promise<void> {
		if (this.settings.getLoadStatus() !== "ready") throw new Error("Knomo current settings unavailable.");
		const settings = this.settings.getSettings();
		const expectedKey = this.configurationKey({
			currentConfigInitialized: true,
			monthlyLocale: settings.monthlyLocale ?? normalizeMonthlyLocaleKey(this.locale()),
		});
		if (settings.currentConfigInitialized) {
			if (!settings.monthlyLocale) throw new Error("Current Monthly locale is unavailable.");
			await this.settings.verifyCurrentSettings({ currentConfigInitialized: true, monthlyLocale: settings.monthlyLocale });
			this.assertVerifiedConfiguration(expectedKey);
			this.error = null;
			this.verified = true;
			return;
		}
		const patch = {
			monthlyLocale: settings.monthlyLocale ?? normalizeMonthlyLocaleKey(this.locale()),
			currentConfigInitialized: true,
		};
		await this.settings.updateSettings(patch);
		this.assertActive();
		await this.settings.verifyCurrentSettings(patch);
		this.assertVerifiedConfiguration(expectedKey);
		this.error = null;
		this.verified = true;
	}

	getStatus(): KnomoCurrentConfigStatus {
		return this.options.cancellationSignal?.aborted || this.error !== null || this.settings.getLoadStatus() !== "ready" ? "unavailable"
			: this.verified && this.verifiedKey === this.configurationKey() ? "ready" : "missing";
	}
	getLastError(): string | null { return this.error; }
	getEffectiveConfig(): KnomoCurrentConfig {
		const daily = this.daily.getConfig();
		if (daily === null) throw new Error("Obsidian Daily configuration is unknown.");
		if (this.getStatus() !== "ready") throw new Error(this.error ?? "Current configuration is not ready.");
		const settings = this.settings.getSettings();
		return buildKnomoCurrentConfig(daily, settings, settings.monthlyLocale!);
	}
	isCoverageComplete(): boolean { return this.daily.getConfig() !== null; }
	isMonthlyProjectionAllowed(): boolean {
		try { this.getEffectiveConfig(); return true; } catch { return false; }
	}
	start(owner: Component, onChanged: () => void | Promise<void>): void {
		this.onChanged = onChanged;
		owner.register(this.daily.onChanged(() => {
			void Promise.resolve(this.onChanged?.()).catch((error: unknown) => { this.error = String(error); });
		}));
		let current = this.configurationKey();
		owner.register(this.settings.onChanged(() => {
			const next = this.configurationKey();
			if (next === current) return;
			current = next;
			void Promise.resolve(this.onChanged?.()).catch((error: unknown) => { this.error = String(error); });
		}));
		owner.register(() => { this.onChanged = null; });
	}
	private configurationKey(patch: Partial<ReturnType<SettingsService["getSettings"]>> = {}): string {
		const settings = { ...this.settings.getSettings(), ...patch };
		return JSON.stringify([this.settings.getLoadStatus(), settings.currentConfigInitialized, settings.dailyHeading,
			settings.legacyDailyHeadings, settings.monthlyMemoFolder, settings.monthlyMemoFileFormat,
			settings.monthlyDateHeadingFormat, settings.monthlyDateOrder, settings.monthlyLocale]);
	}
	private assertActive(): void {
		if (this.options.cancellationSignal?.aborted) throw new Error("Current configuration initialization cancelled.");
	}
	private assertVerifiedConfiguration(expectedKey: string): void {
		this.assertActive();
		if (this.configurationKey() !== expectedKey) throw new Error("Current configuration changed during verification.");
		this.verifiedKey = expectedKey;
	}
	// 显式刷新先等待旧默认值/核验结束，再读取当前事实并建立新尝试。
	private refresh(reload: boolean): Promise<void> {
		if (this.refreshing !== null) {
			if (reload && !this.refreshingReload) return this.refreshing.catch(() => undefined).then(() => this.refresh(true));
			return this.refreshing;
		}
		this.refreshingReload = reload;
		const previous = this.initializing;
		const operation = (async () => {
			await previous?.catch(() => undefined);
			await this.startInitialization(reload, true);
		})().finally(() => { if (this.refreshing === operation) this.refreshing = null; });
		this.refreshing = operation;
		return operation;
	}
	async refreshLocalConfig(): Promise<void> { await this.refresh(false); await this.onChanged?.(); }
	async reloadConfiguration(): Promise<void> { await this.refresh(true); await this.onChanged?.(); }
}

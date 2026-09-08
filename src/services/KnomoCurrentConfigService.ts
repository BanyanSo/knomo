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
	private onChanged: (() => void | Promise<void>) | null = null;

	constructor(private readonly settings: SettingsService, private readonly daily: DailyNotesProvider,
		private readonly locale: () => string) {}

	initializeLocalConfig(): Promise<void> { return this.daily.loadConfig().then(() => undefined); }

	initialize(): Promise<void> {
		if (this.initializing !== null) return this.initializing;
		this.initializing = this.initializeCurrent().catch((error: unknown) => {
			this.verified = false;
			this.error = String(error);
			throw error;
		}).finally(() => { this.initializing = null; });
		return this.initializing;
	}

	private async initializeCurrent(): Promise<void> {
		if (this.settings.getLoadStatus() !== "ready") throw new Error("Knomo current settings unavailable.");
		const settings = this.settings.getSettings();
		if (settings.currentConfigInitialized) {
			if (!settings.monthlyLocale) throw new Error("Current Monthly locale is unavailable.");
			await this.settings.verifyCurrentSettings({ currentConfigInitialized: true, monthlyLocale: settings.monthlyLocale });
			this.error = null;
			this.verified = true;
			return;
		}
		const patch = {
			monthlyLocale: settings.monthlyLocale ?? normalizeMonthlyLocaleKey(this.locale()),
			currentConfigInitialized: true,
		};
		await this.settings.updateSettings(patch);
		await this.settings.verifyCurrentSettings(patch);
		this.error = null;
		this.verified = true;
	}

	getStatus(): KnomoCurrentConfigStatus {
		return this.error !== null || this.settings.getLoadStatus() !== "ready" ? "unavailable"
			: this.verified && this.settings.getSettings().currentConfigInitialized && this.settings.getSettings().monthlyLocale ? "ready" : "missing";
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
	private configurationKey(): string {
		const settings = this.settings.getSettings();
		return JSON.stringify([this.settings.getLoadStatus(), settings.currentConfigInitialized, settings.dailyHeading,
			settings.legacyDailyHeadings, settings.monthlyMemoFolder, settings.monthlyMemoFileFormat,
			settings.monthlyDateHeadingFormat, settings.monthlyDateOrder, settings.monthlyLocale]);
	}
	async refreshLocalConfig(): Promise<void> { await this.daily.loadConfig(); await this.initialize(); await this.onChanged?.(); }
	async reloadConfiguredRoot(): Promise<void> { await this.settings.loadSettings(); await this.refreshLocalConfig(); }
}

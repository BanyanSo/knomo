import type { Plugin } from "obsidian";

import { DEFAULT_KNOMO_SETTINGS } from "../settings/defaults";
import { MonthlyFolderMigrationService } from "../settings/MonthlyFolderMigrationService";
import type {
	MonthlyFolderMigrationPlan,
	MonthlyFolderMigrationResult,
	MonthlyMemoFileFormatMigrationPlan,
	MonthlyMemoFileFormatMigrationResult,
} from "../settings/MonthlyFolderMigrationService";
import { cloneSettings, isValidMonthlyMemoFileFormat, normalizeSettings } from "../settings/normalizeSettings";
import type { KnomoSettings, KnomoSettingsLoadStatus } from "../types/settings";
import { isValidMarkdownHeading } from "../utils/markdown";
import { isRecord } from "../utils/object";
import {
	buildPluginDataWithSettings,
	extractSettingsData,
} from "../utils/pluginData";
import { PluginDataStore } from "./PluginDataStore";
import { buildMonthlyFolderExcludeRule, ObsidianExcludeService } from "./ObsidianExcludeService";

export { DEFAULT_KNOMO_SETTINGS, isValidMonthlyMemoFileFormat };
export type {
	MonthlyFolderMigrationPlan,
	MonthlyFolderMigrationResult,
	MonthlyMemoFileFormatMigrationPlan,
	MonthlyMemoFileFormatMigrationResult,
} from "../settings/MonthlyFolderMigrationService";

export class SettingsService {
	private settings = cloneSettings(DEFAULT_KNOMO_SETTINGS);
	private timeBuoySettingPersisted = false;
	private monthlyExcludeSettingPersisted = false;
	private initialTimeBuoyBuildPending = false;
	private loadStatus: KnomoSettingsLoadStatus = "not_loaded";
	private monthlyExcludeInitializationFailed = false;
	private settingsWriteQueue: Promise<void> = Promise.resolve();
	private readonly monthlyFolderMigrationService: MonthlyFolderMigrationService;
	private readonly listeners = new Set<() => void>();
	private loadedConfiguration: string | undefined;

	constructor(
		private readonly plugin: Plugin,
		private readonly pluginDataStore = new PluginDataStore(plugin),
		private readonly monthlyRuntime: { runExclusive<T>(action: () => Promise<T>): Promise<T>; assertActive(): void } = {
			runExclusive: (action) => action(), assertActive: () => undefined,
		},
	) {
		this.monthlyFolderMigrationService = new MonthlyFolderMigrationService(
			plugin,
			() => this.settings,
			async (settings) => {
				const result = await this.persistSettings(settings);
				try { await this.verifyCurrentSettings({ monthlyMemoFolder: result.monthlyMemoFolder }); }
				catch (error) { this.loadStatus = "unavailable"; this.notifyChanged(); throw error; }
				return result;
			},
			(settings) => {
				this.settings = cloneSettings(settings);
			},
			() => { this.monthlyRuntime.assertActive(); if (this.loadStatus !== "ready") throw new Error("Knomo settings unavailable."); },
		);
	}

	async loadSettings(): Promise<KnomoSettings> {
		try {
			const savedData = await this.pluginDataStore.read();
			const settingsData = extractSettingsData(savedData);
			if (savedData !== null && savedData !== undefined && (!isRecord(settingsData)
				|| isRecord(savedData) && "settings" in savedData && !isRecord(savedData.settings))) throw new Error("Knomo settings are unreadable.");
			this.timeBuoySettingPersisted = isRecord(settingsData)
				&& typeof settingsData.timeBuoyEnabled === "boolean";
			this.monthlyExcludeSettingPersisted = isRecord(settingsData)
				&& typeof settingsData.excludeMonthlyMemosFromObsidian === "boolean";
			this.settings = this.migrateSettings(settingsData);
			this.loadedConfiguration = configurationFingerprint(settingsData);
			try {
				const local = this.plugin.app.loadLocalStorage?.("knomo.preferences");
				if (isRecord(local)) this.settings = this.migrateSettings({ ...this.settings, ...pickPreferences(local) });
			} catch {
				// 设备偏好丢失可使用默认 UI，不降低当前 Vault 配置可读性。
			}
			if (
				this.timeBuoySettingPersisted
				&& isRecord(settingsData)
				&& typeof settingsData.timeBuoyIntroDismissed !== "boolean"
			) {
				this.settings.timeBuoyIntroDismissed = true;
			}
			this.loadStatus = "ready";
			this.notifyChanged();
			return this.getSettings();
		} catch (error) {
			this.loadStatus = "unavailable";
			this.notifyChanged();
			throw error;
		}
	}

	getLoadStatus(): KnomoSettingsLoadStatus {
		return this.loadStatus;
	}

	onChanged(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => { this.listeners.delete(listener); };
	}

	private notifyChanged(): void { for (const listener of this.listeners) listener(); }

	async verifyCurrentSettings(expected: Partial<KnomoSettings>): Promise<void> {
		const stored = extractSettingsData(await this.pluginDataStore.read());
		if (!isRecord(stored) || Object.entries(expected).some(([key, value]) => JSON.stringify(stored[key]) !== JSON.stringify(value))) {
			throw new Error("Current configuration read-back verification failed.");
		}
	}

	async persistLegacyConfiguration(): Promise<void> {
		await this.runSettingsWriteExclusive(async () => {
			await this.persistSettings(this.getSettings());
			const expected = { ...this.getSettings() };
			for (const key of PREFERENCE_KEYS) delete (expected as unknown as Record<string, unknown>)[key];
			await this.verifyCurrentSettings(expected);
		});
	}

	async initializeTimeBuoyDefault(): Promise<KnomoSettings> {
		if (this.timeBuoySettingPersisted) {
			return this.getSettings();
		}
		const settings = await this.updateSettings({
			timeBuoyEnabled: true,
			timeBuoyIntroDismissed: true,
		});
		this.initialTimeBuoyBuildPending = true;
		this.timeBuoySettingPersisted = true;
		return settings;
	}

	async initializeMonthlyExcludeDefault(): Promise<KnomoSettings> {
		if (
			this.monthlyExcludeSettingPersisted
			&& !this.settings.excludeMonthlyMemosFromObsidian
		) {
			return this.getSettings();
		}
		const currentSettings = this.getSettings();
		const rule = buildMonthlyFolderExcludeRule(currentSettings.monthlyMemoFolder);
		if (rule === null) {
			const settings = await this.updateSettings({
				excludeMonthlyMemosFromObsidian: false,
				managedObsidianExcludeRule: undefined,
				managedObsidianExcludeRuleOwned: false,
			});
			this.monthlyExcludeSettingPersisted = true;
			return settings;
		}

		let addedByKnomo: boolean;
		try {
			({ addedByKnomo } = await new ObsidianExcludeService(this.plugin.app).ensureRule(rule));
		} catch {
			this.monthlyExcludeInitializationFailed = true;
			return currentSettings;
		}

		const managedRuleOwned = addedByKnomo || (
			currentSettings.managedObsidianExcludeRule === rule
			&& currentSettings.managedObsidianExcludeRuleOwned === true
		);
		if (
			this.monthlyExcludeSettingPersisted
			&& currentSettings.managedObsidianExcludeRule === rule
			&& currentSettings.managedObsidianExcludeRuleOwned === managedRuleOwned
		) {
			return currentSettings;
		}
		const settings = await this.updateSettings({
			excludeMonthlyMemosFromObsidian: true,
			managedObsidianExcludeRule: rule,
			managedObsidianExcludeRuleOwned: managedRuleOwned,
		});
		this.monthlyExcludeSettingPersisted = true;
		this.monthlyExcludeInitializationFailed = false;
		return settings;
	}

	hasMonthlyExcludeInitializationFailure(): boolean {
		return this.monthlyExcludeInitializationFailed;
	}

	consumeInitialTimeBuoyBuildPending(): boolean {
		const pending = this.initialTimeBuoyBuildPending;
		this.initialTimeBuoyBuildPending = false;
		return pending;
	}

	getSettings(): KnomoSettings {
		return cloneSettings(this.settings);
	}

	async saveSettings(settings: KnomoSettings): Promise<KnomoSettings> {
		if (settings.monthlyMemoFolder !== this.settings.monthlyMemoFolder) {
			const result = await this.migrateMonthlyMemoFolder(settings.monthlyMemoFolder, settings);
			if (result.trashError) throw new Error(`Monthly folder saved; Trash relocation incomplete: ${result.trashError}`);
			return this.getSettings();
		}
		return this.runSettingsWriteExclusive(() => this.persistSettings(settings));
	}

	async updateSettings(patch: Partial<KnomoSettings>): Promise<KnomoSettings> {
		if (patch.monthlyMemoFolder !== undefined && patch.monthlyMemoFolder !== this.settings.monthlyMemoFolder) {
			const result = await this.migrateMonthlyMemoFolder(patch.monthlyMemoFolder, patch);
			if (result.trashError) throw new Error(`Monthly folder saved; Trash relocation incomplete: ${result.trashError}`);
			return this.getSettings();
		}
		if (Object.keys(patch).every((key) => PREFERENCE_KEYS.includes(key))) {
			return this.runSettingsWriteExclusive(async () => {
				const next = this.migrateSettings({ ...this.settings, ...patch });
				this.plugin.app.saveLocalStorage?.("knomo.preferences", pickPreferences(next));
				this.settings = next;
				this.notifyChanged();
				return this.getSettings();
			});
		}
		const updatesMonthlyExclude = Object.prototype.hasOwnProperty.call(
			patch,
			"excludeMonthlyMemosFromObsidian",
		);
		const settings = await this.runSettingsWriteExclusive(() => this.persistSettings(
			Object.assign({}, this.settings, patch),
		));
		if (updatesMonthlyExclude) {
			this.monthlyExcludeSettingPersisted = true;
			this.monthlyExcludeInitializationFailed = false;
		}
		return settings;
	}

	private async persistSettings(settings: KnomoSettings): Promise<KnomoSettings> {
		if (this.loadStatus === "unavailable") throw new Error("Knomo settings are unreadable; retry loading before changing configuration.");
		const nextSettings = this.migrateSettings(settings);
		const storedSettings = { ...nextSettings };
		for (const key of PREFERENCE_KEYS) delete (storedSettings as unknown as Record<string, unknown>)[key];
		try {
			await this.pluginDataStore.mutate((savedData) => {
				if (this.loadedConfiguration !== undefined && this.loadedConfiguration !== configurationFingerprint(extractSettingsData(savedData))) {
					throw new Error("Knomo configuration changed externally; reload before saving.");
				}
				return { nextData: buildPluginDataWithSettings(savedData, storedSettings), result: undefined };
			});
		} catch (error) {
			this.loadStatus = "unavailable";
			this.notifyChanged();
			throw error;
		}
		this.loadedConfiguration = configurationFingerprint(storedSettings);
		this.settings = nextSettings;
		try {
			this.plugin.app.saveLocalStorage?.("knomo.preferences", pickPreferences(nextSettings));
		} finally {
			// Vault 当前值已提交，即使设备偏好失败也必须取消旧配置任务。
			this.notifyChanged();
		}
		return this.getSettings();
	}

	private async runSettingsWriteExclusive<T>(operation: () => Promise<T>): Promise<T> {
		const previous = this.settingsWriteQueue;
		let releaseQueue: () => void = () => undefined;
		this.settingsWriteQueue = new Promise<void>((resolve) => {
			releaseQueue = resolve;
		});
		await previous;
		try {
			return await operation();
		} finally {
			releaseQueue();
		}
	}

	migrateSettings(savedData: unknown): KnomoSettings {
		return normalizeSettings(savedData);
	}

	validateDailyHeading(value: string): boolean {
		return this.validateMarkdownHeading(value);
	}

	validateMarkdownHeading(value: string): boolean {
		return isValidMarkdownHeading(value);
	}

	validateMonthlyMemoFileFormat(value: string): boolean {
		return isValidMonthlyMemoFileFormat(value);
	}

	async migrateMonthlyMemoFolder(nextMonthlyMemoFolder: string, patch: Partial<KnomoSettings> = {}): Promise<MonthlyFolderMigrationResult> {
		const selectedSettings = this.settings;
		return this.monthlyRuntime.runExclusive(() => this.runSettingsWriteExclusive(() => {
			if (this.settings !== selectedSettings) throw new Error("Monthly configuration changed before relocation.");
			return this.monthlyFolderMigrationService.migrateMonthlyMemoFolder(nextMonthlyMemoFolder, patch);
		}));
	}

	async planMonthlyMemoFolderMigration(nextMonthlyMemoFolder: string): Promise<MonthlyFolderMigrationPlan> {
		return this.monthlyFolderMigrationService.planMonthlyMemoFolderMigration(nextMonthlyMemoFolder);
	}

	async planMonthlyMemoFileFormatMigration(
		nextMonthlyMemoFileFormat: string,
		sourcePeriods?: readonly string[],
	): Promise<MonthlyMemoFileFormatMigrationPlan> {
		return this.monthlyFolderMigrationService.planMonthlyMemoFileFormatMigration(
			nextMonthlyMemoFileFormat,
			sourcePeriods,
		);
	}

	async migrateMonthlyMemoFileFormat(
		nextMonthlyMemoFileFormat: string,
		rebuildPeriods: (periods: string[], trackGeneratedPath: (path: string) => void) => Promise<void>,
	): Promise<MonthlyMemoFileFormatMigrationResult> {
		return this.runSettingsWriteExclusive(() => this.monthlyFolderMigrationService.migrateMonthlyMemoFileFormat(
			nextMonthlyMemoFileFormat,
			rebuildPeriods,
		));
	}
}

const PREFERENCE_KEYS = ["mobileCompactMode", "desktopSidebarWidth", "desktopSidebarCollapsed", "pinnedTags", "timeBuoyIntroDismissed"];

function pickPreferences(value: object): Record<string, unknown> {
	return Object.fromEntries(Object.entries(value).filter(([key]) => PREFERENCE_KEYS.includes(key)));
}

function configurationFingerprint(value: unknown): string {
	return JSON.stringify(isRecord(value)
		? Object.fromEntries(Object.entries(value).filter(([key]) => !PREFERENCE_KEYS.includes(key)).sort(([a], [b]) => a.localeCompare(b)))
		: value ?? null);
}

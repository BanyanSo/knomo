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
import type { KnomoSettings } from "../types/settings";
import { isValidMarkdownHeading } from "../utils/markdown";
import { isRecord } from "../utils/object";
import { normalizeVaultPath } from "../utils/path";
import {
	buildPluginDataWithSettings,
	extractSettingsData,
} from "../utils/pluginData";
import { PluginDataStore } from "./PluginDataStore";
import { ObsidianExcludeService } from "./ObsidianExcludeService";

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
	private initialTimeBuoyBuildPending = false;
	private settingsWriteQueue: Promise<void> = Promise.resolve();
	private readonly monthlyFolderMigrationService: MonthlyFolderMigrationService;

	constructor(
		private readonly plugin: Plugin,
		private readonly pluginDataStore = new PluginDataStore(plugin),
	) {
		this.monthlyFolderMigrationService = new MonthlyFolderMigrationService(
			plugin,
			() => this.settings,
			(settings) => this.saveSettings(settings),
			(settings) => {
				this.settings = cloneSettings(settings);
			},
		);
	}

	async ensureCatalogDataExcludeRules(
		catalogDataRoot: string,
		legacySystemRoot: string,
		keepLegacyRule: boolean,
	): Promise<void> {
		const excludeService = new ObsidianExcludeService(this.plugin.app);
		const catalogRule = `${normalizeVaultPath(catalogDataRoot)}/`;
		const legacyRule = `${normalizeVaultPath(legacySystemRoot)}/`;
		const settings = this.getSettings();
		const catalogResult = await excludeService.ensureRule(catalogRule);
		let legacyOwned = settings.managedLegacySystemFolderExcludeRuleOwned === true;
		let managedLegacyRule = settings.managedLegacySystemFolderExcludeRule;
		if (settings.managedSystemFolderExcludeRule?.split("/").includes("_knomo-system") === true) {
			managedLegacyRule = settings.managedSystemFolderExcludeRule;
			legacyOwned = settings.managedSystemFolderExcludeRuleOwned === true;
		}
		if (keepLegacyRule) {
			const legacyResult = await excludeService.ensureRule(legacyRule);
			managedLegacyRule = legacyRule;
			legacyOwned = managedLegacyRule === settings.managedLegacySystemFolderExcludeRule
				? legacyOwned || legacyResult.addedByKnomo
				: legacyResult.addedByKnomo;
		}
		await this.saveSettings({
			...settings,
			managedSystemFolderExcludeRule: catalogRule,
			managedSystemFolderExcludeRuleOwned: settings.managedSystemFolderExcludeRule === catalogRule
				? settings.managedSystemFolderExcludeRuleOwned === true || catalogResult.addedByKnomo
				: catalogResult.addedByKnomo,
			managedLegacySystemFolderExcludeRule: managedLegacyRule,
			managedLegacySystemFolderExcludeRuleOwned: legacyOwned,
		});
	}

	async retireLegacySystemExcludeRule(): Promise<void> {
		const settings = this.getSettings();
		const rule = settings.managedLegacySystemFolderExcludeRule;
		if (rule !== undefined && settings.managedLegacySystemFolderExcludeRuleOwned === true) {
			await new ObsidianExcludeService(this.plugin.app).removeRule(rule);
		}
		await this.saveSettings({
			...settings,
			managedLegacySystemFolderExcludeRule: undefined,
			managedLegacySystemFolderExcludeRuleOwned: false,
		});
	}

	async loadSettings(): Promise<KnomoSettings> {
		const savedData = await this.pluginDataStore.read();
		const settingsData = extractSettingsData(savedData);
		this.timeBuoySettingPersisted = isRecord(settingsData)
			&& typeof settingsData.timeBuoyEnabled === "boolean";
		this.settings = this.migrateSettings(settingsData);
		if (
			this.timeBuoySettingPersisted
			&& isRecord(settingsData)
			&& typeof settingsData.timeBuoyIntroDismissed !== "boolean"
		) {
			this.settings.timeBuoyIntroDismissed = true;
		}
		return this.getSettings();
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

	consumeInitialTimeBuoyBuildPending(): boolean {
		const pending = this.initialTimeBuoyBuildPending;
		this.initialTimeBuoyBuildPending = false;
		return pending;
	}

	getSettings(): KnomoSettings {
		return cloneSettings(this.settings);
	}

	async saveSettings(settings: KnomoSettings): Promise<KnomoSettings> {
		return this.runSettingsWriteExclusive(() => this.persistSettings(settings));
	}

	async updateSettings(patch: Partial<KnomoSettings>): Promise<KnomoSettings> {
		return this.runSettingsWriteExclusive(() => this.persistSettings(
			Object.assign({}, this.settings, patch),
		));
	}

	private async persistSettings(settings: KnomoSettings): Promise<KnomoSettings> {
		const nextSettings = this.migrateSettings(settings);
		await this.pluginDataStore.mutate((savedData) => ({
			nextData: buildPluginDataWithSettings(savedData, nextSettings),
			result: undefined,
		}));
		this.settings = nextSettings;
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

	async migrateMonthlyMemoFolder(nextMonthlyMemoFolder: string): Promise<MonthlyFolderMigrationResult> {
		return this.monthlyFolderMigrationService.migrateMonthlyMemoFolder(nextMonthlyMemoFolder);
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
		return this.monthlyFolderMigrationService.migrateMonthlyMemoFileFormat(
			nextMonthlyMemoFileFormat,
			rebuildPeriods,
		);
	}
}

import type { Plugin } from "obsidian";

import { DEFAULT_KNOMO_SETTINGS } from "../settings/defaults";
import { MonthlyFolderMigrationService } from "../settings/MonthlyFolderMigrationService";
import type { MonthlyFolderMigrationPlan, SystemFolderMigrationResult } from "../settings/MonthlyFolderMigrationService";
import { cloneSettings, isValidMonthlyMemoFileFormat, normalizeSettings } from "../settings/normalizeSettings";
import type { KnomoSettings } from "../types/settings";
import { isValidMarkdownHeading } from "../utils/markdown";
import { buildPluginDataWithSettings, extractSettingsData } from "../utils/pluginData";

export { DEFAULT_KNOMO_SETTINGS, isValidMonthlyMemoFileFormat };
export type { MonthlyFolderMigrationPlan, SystemFolderMigrationResult } from "../settings/MonthlyFolderMigrationService";

export class SettingsService {
	private settings = cloneSettings(DEFAULT_KNOMO_SETTINGS);
	private readonly monthlyFolderMigrationService: MonthlyFolderMigrationService;

	constructor(private readonly plugin: Plugin) {
		this.monthlyFolderMigrationService = new MonthlyFolderMigrationService(
			plugin,
			() => this.settings,
			(settings) => this.saveSettings(settings),
		);
	}

	async loadSettings(): Promise<KnomoSettings> {
		const savedData: unknown = await this.plugin.loadData();
		this.settings = this.migrateSettings(extractSettingsData(savedData));
		return this.getSettings();
	}

	getSettings(): KnomoSettings {
		return cloneSettings(this.settings);
	}

	async saveSettings(settings: KnomoSettings): Promise<KnomoSettings> {
		this.settings = this.migrateSettings(settings);
		const savedData: unknown = await this.plugin.loadData();
		await this.plugin.saveData(buildPluginDataWithSettings(savedData, this.settings));
		return this.getSettings();
	}

	async updateSettings(patch: Partial<KnomoSettings>): Promise<KnomoSettings> {
		const nextSettings = Object.assign({}, this.settings, patch);
		return this.saveSettings(nextSettings);
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

	async initializeSystemFolders(): Promise<void> {
		await this.monthlyFolderMigrationService.initializeSystemFolders();
	}

	async migrateMonthlyMemoFolder(nextMonthlyMemoFolder: string): Promise<SystemFolderMigrationResult> {
		return this.monthlyFolderMigrationService.migrateMonthlyMemoFolder(nextMonthlyMemoFolder);
	}

	async planMonthlyMemoFolderMigration(nextMonthlyMemoFolder: string): Promise<MonthlyFolderMigrationPlan> {
		return this.monthlyFolderMigrationService.planMonthlyMemoFolderMigration(nextMonthlyMemoFolder);
	}
}

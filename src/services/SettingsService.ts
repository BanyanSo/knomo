import type { Plugin } from "obsidian";

import { DEFAULT_KNOMO_SETTINGS } from "../settings/defaults";
import { MonthlyFolderMigrationService } from "../settings/MonthlyFolderMigrationService";
import type {
	MonthlyFolderMigrationPlan,
	MonthlyMemoFileFormatMigrationPlan,
	MonthlyMemoFileFormatMigrationResult,
	SystemFolderMigrationResult,
} from "../settings/MonthlyFolderMigrationService";
import { cloneSettings, isValidMonthlyMemoFileFormat, normalizeSettings } from "../settings/normalizeSettings";
import type { KnomoSettings } from "../types/settings";
import { isValidMarkdownHeading } from "../utils/markdown";
import { buildPluginDataWithSettings, extractSettingsData } from "../utils/pluginData";

export { DEFAULT_KNOMO_SETTINGS, isValidMonthlyMemoFileFormat };
export type {
	MonthlyFolderMigrationPlan,
	MonthlyMemoFileFormatMigrationPlan,
	MonthlyMemoFileFormatMigrationResult,
	SystemFolderMigrationResult,
} from "../settings/MonthlyFolderMigrationService";

export class SettingsService {
	private settings = cloneSettings(DEFAULT_KNOMO_SETTINGS);
	private settingsWriteQueue: Promise<void> = Promise.resolve();
	private readonly monthlyFolderMigrationService: MonthlyFolderMigrationService;

	constructor(
		private readonly plugin: Plugin,
		onBeforeArchiveMove?: (oldPath: string, newPath: string) => void | (() => void),
	) {
		this.monthlyFolderMigrationService = new MonthlyFolderMigrationService(
			plugin,
			() => this.settings,
			(settings) => this.saveSettings(settings),
			(settings) => {
				this.settings = cloneSettings(settings);
			},
			onBeforeArchiveMove,
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
		return this.runSettingsWriteExclusive(() => this.persistSettings(settings));
	}

	async updateSettings(patch: Partial<KnomoSettings>): Promise<KnomoSettings> {
		return this.runSettingsWriteExclusive(() => this.persistSettings(
			Object.assign({}, this.settings, patch),
		));
	}

	private async persistSettings(settings: KnomoSettings): Promise<KnomoSettings> {
		const nextSettings = this.migrateSettings(settings);
		const savedData: unknown = await this.plugin.loadData();
		await this.plugin.saveData(buildPluginDataWithSettings(savedData, nextSettings));
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

	async initializeSystemFolders(): Promise<void> {
		await this.monthlyFolderMigrationService.initializeSystemFolders();
	}

	async migrateMonthlyMemoFolder(nextMonthlyMemoFolder: string): Promise<SystemFolderMigrationResult> {
		return this.monthlyFolderMigrationService.migrateMonthlyMemoFolder(nextMonthlyMemoFolder);
	}

	async planMonthlyMemoFolderMigration(nextMonthlyMemoFolder: string): Promise<MonthlyFolderMigrationPlan> {
		return this.monthlyFolderMigrationService.planMonthlyMemoFolderMigration(nextMonthlyMemoFolder);
	}

	async planMonthlyMemoFileFormatMigration(
		nextMonthlyMemoFileFormat: string,
	): Promise<MonthlyMemoFileFormatMigrationPlan> {
		return this.monthlyFolderMigrationService.planMonthlyMemoFileFormatMigration(nextMonthlyMemoFileFormat);
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

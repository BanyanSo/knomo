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
import { isRecord } from "../utils/object";
import {
	buildPluginDataWithMaintenanceDiagnostic,
	buildPluginDataWithSettings,
	extractMaintenanceDiagnostic,
	extractSettingsData,
	type MaintenanceDiagnostic,
} from "../utils/pluginData";
import { PluginDataStore } from "./PluginDataStore";

export { DEFAULT_KNOMO_SETTINGS, isValidMonthlyMemoFileFormat };
export type {
	MonthlyFolderMigrationPlan,
	MonthlyMemoFileFormatMigrationPlan,
	MonthlyMemoFileFormatMigrationResult,
	SystemFolderMigrationResult,
} from "../settings/MonthlyFolderMigrationService";

export class SettingsService {
	private settings = cloneSettings(DEFAULT_KNOMO_SETTINGS);
	private timeBuoySettingPersisted = false;
	private initialTimeBuoyBuildPending = false;
	private settingsWriteQueue: Promise<void> = Promise.resolve();
	private readonly monthlyFolderMigrationService: MonthlyFolderMigrationService;

	constructor(
		plugin: Plugin,
		onBeforeArchiveMove?: (oldPath: string, newPath: string) => void | (() => void),
		private readonly pluginDataStore = new PluginDataStore(plugin),
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

	async initializeTimeBuoyDefault(hasExistingMemoIndex: boolean): Promise<KnomoSettings> {
		if (this.timeBuoySettingPersisted) {
			return this.getSettings();
		}
		const settings = await this.updateSettings({
			timeBuoyEnabled: !hasExistingMemoIndex,
			timeBuoyIntroDismissed: !hasExistingMemoIndex,
		});
		this.initialTimeBuoyBuildPending = !hasExistingMemoIndex;
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

	async loadMaintenanceDiagnostic(): Promise<MaintenanceDiagnostic | null> {
		const savedData = await this.pluginDataStore.read();
		return extractMaintenanceDiagnostic(savedData);
	}

	async saveMaintenanceDiagnostic(diagnostic: MaintenanceDiagnostic): Promise<void> {
		await this.runSettingsWriteExclusive(async () => {
			await this.pluginDataStore.mutate((savedData) => ({
				nextData: buildPluginDataWithMaintenanceDiagnostic(savedData, diagnostic),
				result: undefined,
			}));
		});
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

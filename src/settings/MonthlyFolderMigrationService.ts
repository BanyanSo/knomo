import { normalizePath, TFile, TFolder } from "obsidian";
import type { Plugin } from "obsidian";

import { buildMonthlyFolderExcludeRule, ObsidianExcludeService } from "../services/ObsidianExcludeService";
import type { KnomoSettings } from "../types/settings";
import { normalizeVaultPath } from "../utils/path";
import { isValidMonthlyMemoFileFormat } from "./normalizeSettings";

type GetSettings = () => KnomoSettings;
type SaveSettings = (settings: KnomoSettings) => Promise<KnomoSettings>;
type StageSettings = (settings: KnomoSettings) => void;

/** Monthly 是 Daily 的派生投影；设置迁移只更新投影配置，不搬运 identity 或 legacy index。 */
export class MonthlyFolderMigrationService {
	constructor(
		private readonly plugin: Plugin,
		private readonly getSettings: GetSettings,
		private readonly saveSettings: SaveSettings,
		private readonly stageSettings: StageSettings,
	) {}

	async planMonthlyMemoFolderMigration(nextMonthlyMemoFolder: string): Promise<MonthlyFolderMigrationPlan> {
		const settings = this.getSettings();
		const newMonthlyMemoFolder = normalizeVaultPath(nextMonthlyMemoFolder);
		return {
			status: settings.monthlyMemoFolder === newMonthlyMemoFolder ? "unchanged" : "planned",
			oldMonthlyMemoFolder: settings.monthlyMemoFolder,
			newMonthlyMemoFolder,
			conflicts: [],
		};
	}

	async migrateMonthlyMemoFolder(nextMonthlyMemoFolder: string): Promise<MonthlyFolderMigrationResult> {
		const plan = await this.planMonthlyMemoFolderMigration(nextMonthlyMemoFolder);
		if (plan.status === "unchanged") {
			return {
				status: "unchanged",
				message: "Monthly projection folder did not change.",
				plan,
			};
		}

		const settings = this.getSettings();
		const nextSettings = await this.prepareMonthlyMemoFolderSettings(settings, plan.newMonthlyMemoFolder);
		await this.saveSettings({
			...nextSettings,
			monthlyMemoFolder: plan.newMonthlyMemoFolder,
		});
		return {
			status: "migrated",
			message: "Monthly projection folder updated.",
			plan,
		};
	}

	async planMonthlyMemoFileFormatMigration(
		nextMonthlyMemoFileFormat: string,
		sourcePeriods?: readonly string[],
	): Promise<MonthlyMemoFileFormatMigrationPlan> {
		const settings = this.getSettings();
		const newFormat = nextMonthlyMemoFileFormat.trim();
		if (!isValidMonthlyMemoFileFormat(newFormat)) {
			throw new Error("Invalid monthly memo filename format.");
		}
		const periods = sourcePeriods === undefined
			? this.listProjectionPeriods(settings)
			: normalizePeriods(sourcePeriods);
		return {
			status: settings.monthlyMemoFileFormat === newFormat ? "unchanged" : "planned",
			oldFormat: settings.monthlyMemoFileFormat,
			newFormat,
			periods,
			oldArchivePaths: periods.map((period) => getProjectionPath(settings.monthlyMemoFolder, settings.monthlyMemoFileFormat, period)),
			targetPaths: periods.map((period) => getProjectionPath(settings.monthlyMemoFolder, newFormat, period)),
			conflicts: [],
		};
	}

	async migrateMonthlyMemoFileFormat(
		nextMonthlyMemoFileFormat: string,
		rebuildPeriods: (periods: string[], trackGeneratedPath: (path: string) => void) => Promise<void>,
	): Promise<MonthlyMemoFileFormatMigrationResult> {
		const plan = await this.planMonthlyMemoFileFormatMigration(nextMonthlyMemoFileFormat);
		if (plan.status === "unchanged") {
			return { status: "unchanged", plan };
		}
		const oldSettings = this.getSettings();
		const nextSettings = { ...oldSettings, monthlyMemoFileFormat: plan.newFormat };
		this.stageSettings(nextSettings);
		try {
			await rebuildPeriods(plan.periods, () => undefined);
			await this.saveSettings(nextSettings);
			return { status: "migrated", plan };
		} catch (error) {
			this.stageSettings(oldSettings);
			throw error;
		}
	}

	private listProjectionPeriods(settings: KnomoSettings): string[] {
		const folder = this.plugin.app.vault.getAbstractFileByPath(normalizeVaultPath(settings.monthlyMemoFolder));
		if (!(folder instanceof TFolder)) return [];
		return normalizePeriods(folder.children
			.filter((child): child is TFile => child instanceof TFile)
			.map((file) => getPeriodFromProjectionName(file.name, settings.monthlyMemoFileFormat))
			.filter((period): period is string => period !== null));
	}

	async prepareMonthlyMemoFolderSettings(settings: KnomoSettings, newFolder: string): Promise<KnomoSettings> {
		if (!settings.excludeMonthlyMemosFromObsidian) return settings;
		const nextRule = buildMonthlyFolderExcludeRule(newFolder);
		if (nextRule === null) {
			return {
				...settings,
				excludeMonthlyMemosFromObsidian: false,
				managedObsidianExcludeRule: undefined,
				managedObsidianExcludeRuleOwned: false,
			};
		}
		const excludeService = new ObsidianExcludeService(this.plugin.app);
		const result = await excludeService.ensureRule(nextRule);
		const oldRule = settings.managedObsidianExcludeRule;
		if (settings.managedObsidianExcludeRuleOwned === true && oldRule !== undefined && oldRule !== nextRule) {
			await excludeService.removeRule(oldRule);
		}
		return {
			...settings,
			managedObsidianExcludeRule: nextRule,
			managedObsidianExcludeRuleOwned: result.addedByKnomo,
		};
	}
}

export interface MonthlyFolderMigrationResult {
	status: "unchanged" | "migrated";
	message: string;
	plan?: MonthlyFolderMigrationPlan;
}

export interface MonthlyFolderMigrationPlan {
	status: "unchanged" | "planned";
	oldMonthlyMemoFolder: string;
	newMonthlyMemoFolder: string;
	conflicts: string[];
}

export interface MonthlyMemoFileFormatMigrationPlan {
	status: "unchanged" | "planned";
	oldFormat: string;
	newFormat: string;
	periods: string[];
	oldArchivePaths: string[];
	targetPaths: string[];
	conflicts: string[];
}

export interface MonthlyMemoFileFormatMigrationResult {
	status: "unchanged" | "migrated";
	plan: MonthlyMemoFileFormatMigrationPlan;
}

function normalizePeriods(periods: readonly string[]): string[] {
	return [...new Set(periods.filter((period) => /^\d{4}-(?:0[1-9]|1[0-2])$/u.test(period)))].sort();
}

function getProjectionPath(folder: string, format: string, period: string): string {
	const [year, month] = period.split("-");
	return normalizePath(`${normalizeVaultPath(folder)}/${format.replace(/YYYY/gu, year ?? "").replace(/MM/gu, month ?? "")}`);
}

function getPeriodFromProjectionName(name: string, format: string): string | null {
	const pattern = escapeRegExp(format)
		.replace(/YYYY/gu, "(?<year>\\d{4})")
		.replace(/MM/gu, "(?<month>0[1-9]|1[0-2])");
	const match = new RegExp(`^${pattern}$`, "u").exec(name);
	return match?.groups === undefined ? null : `${match.groups.year}-${match.groups.month}`;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

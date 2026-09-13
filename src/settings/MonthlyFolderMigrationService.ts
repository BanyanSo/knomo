import { normalizePath, TFile, TFolder } from "obsidian";
import type { Plugin } from "obsidian";

import { buildMonthlyFolderExcludeRule, ObsidianExcludeService } from "../services/ObsidianExcludeService";
import type { KnomoSettings } from "../types/settings";
import { normalizeVaultPath } from "../utils/path";
import { isValidMonthlyMemoFileFormat } from "./normalizeSettings";
import { assertVaultPath, getTrashFilePath, TrashSnapshotStore } from "../services/TrashSnapshotStore";

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
		private readonly assertActive: () => void = () => undefined,
	) {}

	async planMonthlyMemoFolderMigration(nextMonthlyMemoFolder: string): Promise<MonthlyFolderMigrationPlan> {
		const settings = this.getSettings();
		const newMonthlyMemoFolder = normalizeVaultPath(nextMonthlyMemoFolder);
		assertVaultPath(newMonthlyMemoFolder);
		const configDir = this.plugin.app.vault.configDir;
		if (newMonthlyMemoFolder === configDir || newMonthlyMemoFolder.startsWith(`${configDir}/`)) throw new Error("Monthly folder overlaps plugin configuration.");
		return {
			status: settings.monthlyMemoFolder === newMonthlyMemoFolder ? "unchanged" : "planned",
			oldMonthlyMemoFolder: settings.monthlyMemoFolder,
			newMonthlyMemoFolder,
			conflicts: [],
		};
	}

	async migrateMonthlyMemoFolder(nextMonthlyMemoFolder: string, patch: Partial<KnomoSettings> = {}): Promise<MonthlyFolderMigrationResult> {
		const settings = this.getSettings();
		const plan = await this.planMonthlyMemoFolderMigration(nextMonthlyMemoFolder);
		this.assertActive();
		if (this.getSettings() !== settings) throw new Error("Monthly configuration changed while planning relocation.");
		if (plan.status === "unchanged") {
			if (Object.keys(patch).length) await this.saveSettings({ ...this.getSettings(), ...patch });
			return {
				status: "unchanged",
				message: "Monthly projection folder did not change.",
				plan,
			};
		}

		let sourcePath: string | null = null;
		const assertSourceActive = () => {
			this.assertActive();
			if (this.getSettings() !== settings) throw new Error("Monthly configuration changed during relocation.");
		};
		let sourceFile: TFile | null = null;
		let sourceText: string | null = null;
		let trashError: string | undefined;
		let sourceItems: import("../types/trash").TrashSnapshot[] = [];
		const target = new TrashSnapshotStore(this.plugin.app, plan.newMonthlyMemoFolder, assertSourceActive);
		try {
			assertSourceActive();
			sourcePath = getTrashFilePath(plan.oldMonthlyMemoFolder);
			const configDir = this.plugin.app.vault.configDir;
			if (sourcePath.startsWith(`${configDir}/`)) throw new Error("Trash source overlaps plugin configuration.");
			const file = this.plugin.app.vault.getAbstractFileByPath(sourcePath);
			if (file !== null || await this.plugin.app.vault.adapter.exists(sourcePath)) {
				if (!(file instanceof TFile)) throw new Error("Trash source unavailable.");
				sourceFile = file;
				sourceText = await this.plugin.app.vault.read(file);
			}
			const source = new TrashSnapshotStore(this.plugin.app, plan.oldMonthlyMemoFolder, assertSourceActive);
			const result = await source.query();
			if (result.errors.length) throw new Error(result.errors.map((error) => error.message).join("; "));
			sourceItems = result.items;
			assertSourceActive();
			await target.saveAll(sourceItems);
			await target.assertContainsAll(sourceItems);
			assertSourceActive();
			if (sourceFile !== null && (sourceFile.path !== sourcePath || await this.plugin.app.vault.read(sourceFile) !== sourceText)) throw new Error("Trash source changed during relocation.");
		} catch (error) { trashError = String(error); }
		// 搬迁失败不阻止合法设置；配置本身已变化或运行时失效则不能提交旧设置。
		assertSourceActive();
		const nextSettings = await this.prepareMonthlyMemoFolderSettings({ ...settings, ...patch }, plan.newMonthlyMemoFolder);
		assertSourceActive();
		await this.saveSettings({
			...nextSettings,
			monthlyMemoFolder: plan.newMonthlyMemoFolder,
		});
		const savedSettings = this.getSettings();
		const assertTargetActive = () => {
			this.assertActive();
			if (this.getSettings() !== savedSettings || savedSettings.monthlyMemoFolder !== plan.newMonthlyMemoFolder) throw new Error("Monthly configuration changed before cleanup.");
		};
		if (trashError === undefined && sourceFile !== null && sourcePath !== null) {
			try {
				assertTargetActive();
				await new TrashSnapshotStore(this.plugin.app, plan.newMonthlyMemoFolder, assertTargetActive).assertContainsAll(sourceItems);
				if (sourceFile.path !== sourcePath || this.plugin.app.vault.getAbstractFileByPath(sourcePath) !== sourceFile
					|| await this.plugin.app.vault.read(sourceFile) !== sourceText) throw new Error("Trash source changed; old file retained.");
				assertTargetActive();
				if (sourceFile.path !== sourcePath || this.plugin.app.vault.getAbstractFileByPath(sourcePath) !== sourceFile) throw new Error("Trash source moved before cleanup.");
				await this.plugin.app.fileManager.trashFile(sourceFile);
				if (await this.plugin.app.vault.adapter.exists(sourcePath)) throw new Error("Trash old file cleanup not confirmed.");
			} catch (error) { trashError = String(error); }
		}
		return {
			status: "migrated",
			message: "Monthly projection folder updated.",
			plan,
			trashError,
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
	trashError?: string;
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

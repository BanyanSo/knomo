import { normalizePath, TFile, TFolder, Vault } from "obsidian";
import type { Plugin } from "obsidian";

import {
	ensureReadOnlyComment,
	getMonthlyArchivePath,
	MONTHLY_ARCHIVE_MARKER,
} from "../services/MonthlyArchiveService";
import { buildMonthlyFolderExcludeRule, buildSystemFolderExcludeRule, ObsidianExcludeService } from "../services/ObsidianExcludeService";
import type { KnomoSettings } from "../types/settings";
import { KnomoError } from "../types/serviceError";
import { isRecord } from "../utils/object";
import { getIndexFilePath, getIndexFolderPath, getSystemFolderPath, normalizeVaultPath } from "../utils/path";
import { ensureFolder, getParentFolderPath } from "../utils/vault";
import { isValidMonthlyMemoFileFormat } from "./normalizeSettings";

type GetSettings = () => KnomoSettings;
type SaveSettings = (settings: KnomoSettings) => Promise<KnomoSettings>;
type StageSettings = (settings: KnomoSettings) => void;
type BeforeArchiveMove = (oldPath: string, newPath: string) => void | (() => void);

export class MonthlyFolderMigrationService {
	constructor(
		private readonly plugin: Plugin,
		private readonly getSettings: GetSettings,
		private readonly saveSettings: SaveSettings,
		private readonly stageSettings: StageSettings,
		private readonly onBeforeArchiveMove: BeforeArchiveMove = () => undefined,
	) {}

	async initializeSystemFolders(): Promise<void> {
		const settings = this.getSettings();
		await ensureFolder(this.plugin.app, getIndexFolderPath(settings.monthlyMemoFolder));
		const systemExcludeState = await this.updateSystemFolderExcludeRule(settings, settings.monthlyMemoFolder);
		if (this.hasSystemExcludeStateChanged(settings, systemExcludeState)) {
			await this.saveSettings({
				...settings,
				...systemExcludeState,
			});
		}
	}

	async migrateMonthlyMemoFolder(nextMonthlyMemoFolder: string): Promise<SystemFolderMigrationResult> {
		const plan = await this.planMonthlyMemoFolderMigration(nextMonthlyMemoFolder);
		if (plan.status === "unchanged") {
			await this.initializeSystemFolders();
			return {
				status: "unchanged",
				oldSystemPath: plan.oldSystemPath,
				newSystemPath: plan.newSystemPath,
				message: "System folder path did not change.",
				plan,
			};
		}
		if (plan.conflicts.length > 0) {
			throw new KnomoError("target_path_conflicts", { paths: plan.conflicts.join("; ") });
		}

		const movedPaths: Array<{ from: string; to: string }> = [];
		let backupPath: string | null = null;
		const originalExcludeRules = new ObsidianExcludeService(this.plugin.app).getExcludeRules();
		try {
			backupPath = await this.backupMonthlyMigrationPlan(plan);
			await ensureFolder(this.plugin.app, plan.newMonthlyMemoFolder);
			for (const move of plan.monthlyFileMoves) {
				const file = this.plugin.app.vault.getAbstractFileByPath(move.from);
				if (!(file instanceof TFile)) {
					continue;
				}
				const discardMoveMarker = this.onBeforeArchiveMove(move.from, move.to);
				try {
					await this.plugin.app.vault.rename(file, move.to);
				} catch (error) {
					discardMoveMarker?.();
					throw error;
				}
				movedPaths.push(move);
				const movedFile = this.plugin.app.vault.getAbstractFileByPath(move.to);
				if (movedFile instanceof TFile) {
					await this.plugin.app.vault.process(movedFile, ensureReadOnlyComment);
				}
			}

			const oldSystemFolder = this.plugin.app.vault.getAbstractFileByPath(plan.oldSystemPath);
			if (oldSystemFolder instanceof TFolder) {
				const newParentPath = getParentFolderPath(plan.newSystemPath);
				if (newParentPath !== null) {
					await ensureFolder(this.plugin.app, newParentPath);
				}
				await this.plugin.app.vault.rename(oldSystemFolder, plan.newSystemPath);
				movedPaths.push({ from: plan.oldSystemPath, to: plan.newSystemPath });
			} else if (oldSystemFolder !== null) {
				throw new KnomoError("old_system_path_not_folder", { path: plan.oldSystemPath });
			} else {
				await ensureFolder(this.plugin.app, getIndexFolderPath(plan.newMonthlyMemoFolder));
			}

			await this.rewriteMonthlyRefs(plan);
			const settings = this.getSettings();
			const excludeState = await this.updateExcludeRuleForMigration(settings, plan);
			const systemExcludeState = await this.updateSystemFolderExcludeRule(settings, plan.newMonthlyMemoFolder);
			await this.saveSettings({
				...settings,
				monthlyMemoFolder: plan.newMonthlyMemoFolder,
				...excludeState,
				...systemExcludeState,
			});
			return {
				status: "migrated",
				oldSystemPath: plan.oldSystemPath,
				newSystemPath: plan.newSystemPath,
				message: "Monthly memos folder migrated successfully.",
				plan,
			};
		} catch (error) {
			await this.rollbackMonthlyMigration(movedPaths);
			if (backupPath !== null) {
				await this.restoreMonthlyMigrationBackup(plan, backupPath);
			}
			await this.restoreExcludeRules(originalExcludeRules);
			throw error;
		}
	}

	async planMonthlyMemoFolderMigration(nextMonthlyMemoFolder: string): Promise<MonthlyFolderMigrationPlan> {
		const settings = this.getSettings();
		const oldMonthlyMemoFolder = settings.monthlyMemoFolder;
		const newMonthlyMemoFolder = normalizeVaultPath(nextMonthlyMemoFolder);
		const oldSystemPath = getSystemFolderPath(oldMonthlyMemoFolder);
		const newSystemPath = getSystemFolderPath(newMonthlyMemoFolder);
		const monthlyFiles = await this.listRecognizedMonthlyArchiveFiles(settings);
		const monthlyFileMoves = monthlyFiles.map((file) => ({
			from: file.path,
			to: normalizePath(`${newMonthlyMemoFolder}/${file.path.slice(oldMonthlyMemoFolder.length + 1)}`),
		}));
		const rewrittenMonthlyRefs = await this.countMonthlyRefRewrites(oldMonthlyMemoFolder);
		const conflicts = this.findMigrationConflicts(monthlyFileMoves, oldSystemPath, newSystemPath, oldMonthlyMemoFolder, newMonthlyMemoFolder);

		return {
			status: oldMonthlyMemoFolder === newMonthlyMemoFolder ? "unchanged" : "planned",
			oldMonthlyMemoFolder,
			newMonthlyMemoFolder,
			oldSystemPath,
			newSystemPath,
			monthlyFileMoves,
			moveSystemFolder: this.plugin.app.vault.getAbstractFileByPath(oldSystemPath) instanceof TFolder,
			rewrittenMonthlyRefs,
			conflicts,
		};
	}

	async planMonthlyMemoFileFormatMigration(nextMonthlyMemoFileFormat: string): Promise<MonthlyMemoFileFormatMigrationPlan> {
		const settings = this.getSettings();
		const oldFormat = settings.monthlyMemoFileFormat;
		const newFormat = nextMonthlyMemoFileFormat.trim();
		if (!isValidMonthlyMemoFileFormat(newFormat)) {
			throw new Error("Invalid monthly memo filename format.");
		}
		const periods = this.listIndexPeriods(settings.monthlyMemoFolder);
		const targetPaths = periods.map((period) => getMonthlyArchivePath({
			...settings,
			monthlyMemoFileFormat: newFormat,
		}, period));
		const oldArchivePaths = (await this.listRecognizedMonthlyArchiveFiles(settings)).map((file) => file.path);
		const conflicts = oldFormat === newFormat
			? []
			: targetPaths.filter((path) => this.plugin.app.vault.getAbstractFileByPath(path) !== null);

		return {
			status: oldFormat === newFormat ? "unchanged" : "planned",
			oldFormat,
			newFormat,
			periods,
			oldArchivePaths,
			targetPaths,
			conflicts: [...new Set(conflicts)].sort(),
		};
	}

	async migrateMonthlyMemoFileFormat(
		nextMonthlyMemoFileFormat: string,
		rebuildPeriods: (periods: string[], trackGeneratedPath: (path: string) => void) => Promise<void>,
	): Promise<MonthlyMemoFileFormatMigrationResult> {
		const plan = await this.planMonthlyMemoFileFormatMigration(nextMonthlyMemoFileFormat);
		if (plan.status === "unchanged") {
			return { status: "unchanged", backupPath: null, plan };
		}
		if (plan.conflicts.length > 0) {
			throw new KnomoError("target_path_conflicts", { paths: plan.conflicts.join("; ") });
		}

		const oldSettings = this.getSettings();
		const nextSettings = { ...oldSettings, monthlyMemoFileFormat: plan.newFormat };
		const backupPath = await this.backupMonthlyMemoFileFormatMigration(plan, oldSettings.monthlyMemoFolder);
		const generatedPaths = new Set<string>();
		this.stageSettings(nextSettings);
		try {
			await rebuildPeriods(plan.periods, (path) => generatedPaths.add(path));
			await this.rewriteMonthlyRefsForFileFormat(plan, oldSettings.monthlyMemoFolder);
			await this.saveSettings(nextSettings);
			return { status: "migrated", backupPath, plan };
		} catch (error) {
			this.stageSettings(oldSettings);
			await this.restoreIndexBackup(oldSettings.monthlyMemoFolder, backupPath);
			await this.trashGeneratedMonthlyFiles([...generatedPaths]);
			throw error;
		}
	}

	private async listRecognizedMonthlyArchiveFiles(settings: KnomoSettings): Promise<TFile[]> {
		const monthlyFolder = normalizeVaultPath(settings.monthlyMemoFolder);
		const systemPath = getSystemFolderPath(monthlyFolder);
		const filesByPath = new Map<string, TFile>();
		const indexFolder = this.plugin.app.vault.getAbstractFileByPath(getIndexFolderPath(monthlyFolder));
		if (indexFolder instanceof TFolder) {
			for (const indexFile of listIndexFiles(indexFolder)) {
				const content = await this.plugin.app.vault.cachedRead(indexFile);
				for (const path of listMonthlyRefPaths(content)) {
					if (!isPathInsideFolder(path, monthlyFolder) || isPathInsideFolder(path, systemPath)) {
						continue;
					}
					const file = this.plugin.app.vault.getAbstractFileByPath(path);
					if (file instanceof TFile) {
						filesByPath.set(file.path, file);
					}
				}
			}
		}

		const folder = this.plugin.app.vault.getAbstractFileByPath(monthlyFolder);
		if (folder instanceof TFolder) {
			for (const child of folder.children) {
				if (!(child instanceof TFile)) {
					continue;
				}
				if (getPeriodFromMonthlyFileName(child.name, settings.monthlyMemoFileFormat) !== null) {
					filesByPath.set(child.path, child);
					continue;
				}
				if (child.extension !== "md") {
					continue;
				}
				const content = await this.plugin.app.vault.cachedRead(child);
				if (content.includes(MONTHLY_ARCHIVE_MARKER)) {
					filesByPath.set(child.path, child);
				}
			}
		}
		return [...filesByPath.values()].sort((left, right) => left.path.localeCompare(right.path));
	}

	private listIndexPeriods(monthlyMemoFolder: string): string[] {
		const indexFolder = this.plugin.app.vault.getAbstractFileByPath(getIndexFolderPath(monthlyMemoFolder));
		if (!(indexFolder instanceof TFolder)) {
			return [];
		}
		const periods = listIndexFiles(indexFolder)
			.map((file) => /^memo-index-(\d{4}-(?:0[1-9]|1[0-2]))\.json$/.exec(file.name)?.[1])
			.filter((period): period is string => period !== undefined);
		return [...new Set(periods)].sort();
	}

	private async backupMonthlyMemoFileFormatMigration(
		plan: MonthlyMemoFileFormatMigrationPlan,
		monthlyMemoFolder: string,
	): Promise<string> {
		const backupRoot = normalizePath(`${getSystemFolderPath(monthlyMemoFolder)}/backups/monthly-format-${Date.now()}`);
		const indexBackupRoot = normalizePath(`${backupRoot}/indexes`);
		const monthlyBackupRoot = normalizePath(`${backupRoot}/monthly`);
		await ensureFolder(this.plugin.app, indexBackupRoot);
		await ensureFolder(this.plugin.app, monthlyBackupRoot);

		const indexFolder = this.plugin.app.vault.getAbstractFileByPath(getIndexFolderPath(monthlyMemoFolder));
		if (indexFolder instanceof TFolder) {
			for (const file of listMarkdownAndJsonFiles(indexFolder)) {
				const relativePath = file.path.slice(indexFolder.path.length + 1);
				await this.copyFileToBackup(file, normalizePath(`${indexBackupRoot}/${relativePath}`));
			}
		}
		for (const path of plan.oldArchivePaths) {
			const file = this.plugin.app.vault.getAbstractFileByPath(path);
			if (file instanceof TFile) {
				const relativePath = file.path.slice(normalizeVaultPath(monthlyMemoFolder).length + 1);
				await this.copyFileToBackup(file, normalizePath(`${monthlyBackupRoot}/${relativePath}`));
			}
		}
		return backupRoot;
	}

	private async trashGeneratedMonthlyFiles(paths: string[]): Promise<void> {
		for (const path of paths) {
			const file = this.plugin.app.vault.getAbstractFileByPath(path);
			if (file instanceof TFile) {
				await this.plugin.app.fileManager.trashFile(file);
			}
		}
	}

	private async rewriteMonthlyRefsForFileFormat(
		plan: MonthlyMemoFileFormatMigrationPlan,
		monthlyMemoFolder: string,
	): Promise<void> {
		for (let index = 0; index < plan.periods.length; index += 1) {
			const indexFile = this.plugin.app.vault.getAbstractFileByPath(
				getIndexFilePath(monthlyMemoFolder, plan.periods[index]),
			);
			if (!(indexFile instanceof TFile)) {
				throw new Error(`Monthly memo-index does not exist for ${plan.periods[index]}.`);
			}
			await this.plugin.app.vault.process(indexFile, (content) => (
				rewriteAllMonthlyRefPaths(content, plan.targetPaths[index])
			));
		}
	}

	private findMigrationConflicts(
		monthlyFileMoves: Array<{ from: string; to: string }>,
		oldSystemPath: string,
		newSystemPath: string,
		oldMonthlyMemoFolder: string,
		newMonthlyMemoFolder: string,
	): string[] {
		if (oldMonthlyMemoFolder === newMonthlyMemoFolder) {
			return [];
		}
		const conflicts: string[] = [];
		for (const move of monthlyFileMoves) {
			if (move.from !== move.to && this.plugin.app.vault.getAbstractFileByPath(move.to) !== null) {
				conflicts.push(move.to);
			}
		}
		if (oldSystemPath !== newSystemPath && this.plugin.app.vault.getAbstractFileByPath(newSystemPath) !== null) {
			conflicts.push(newSystemPath);
		}
		return conflicts;
	}

	private async backupMonthlyMigrationPlan(plan: MonthlyFolderMigrationPlan): Promise<string> {
		const backupRoot = normalizePath(`${plan.oldSystemPath}/backups/monthly-folder-${Date.now()}`);
		const indexBackupRoot = normalizePath(`${backupRoot}/indexes`);
		const monthlyBackupRoot = normalizePath(`${backupRoot}/monthly`);
		await ensureFolder(this.plugin.app, indexBackupRoot);
		await ensureFolder(this.plugin.app, monthlyBackupRoot);

		const indexFolder = this.plugin.app.vault.getAbstractFileByPath(getIndexFolderPath(plan.oldMonthlyMemoFolder));
		if (indexFolder instanceof TFolder) {
			for (const file of listMarkdownAndJsonFiles(indexFolder)) {
				const relativePath = file.path.slice(indexFolder.path.length + 1);
				await this.copyFileToBackup(file, normalizePath(`${indexBackupRoot}/${relativePath}`));
			}
		}
		for (const move of plan.monthlyFileMoves) {
			const file = this.plugin.app.vault.getAbstractFileByPath(move.from);
			if (file instanceof TFile) {
				const relativePath = file.path.slice(plan.oldMonthlyMemoFolder.length + 1);
				await this.copyFileToBackup(file, normalizePath(`${monthlyBackupRoot}/${relativePath}`));
			}
		}
		return backupRoot;
	}

	private async copyFileToBackup(file: TFile, backupPath: string): Promise<void> {
		const parentPath = getParentFolderPath(backupPath);
		if (parentPath !== null) {
			await ensureFolder(this.plugin.app, parentPath);
		}
		const content = await this.plugin.app.vault.cachedRead(file);
		await this.plugin.app.vault.create(backupPath, content);
	}

	private async rewriteMonthlyRefs(plan: MonthlyFolderMigrationPlan): Promise<void> {
		const indexFolder = this.plugin.app.vault.getAbstractFileByPath(getIndexFolderPath(plan.newMonthlyMemoFolder));
		if (!(indexFolder instanceof TFolder)) {
			return;
		}
		for (const file of listIndexFiles(indexFolder)) {
			await this.plugin.app.vault.process(file, (content) => rewriteMonthlyRefPaths(
				content,
				plan.oldMonthlyMemoFolder,
				plan.newMonthlyMemoFolder,
			));
		}
	}

	private async countMonthlyRefRewrites(oldMonthlyMemoFolder: string): Promise<number> {
		const indexFolder = this.plugin.app.vault.getAbstractFileByPath(getIndexFolderPath(oldMonthlyMemoFolder));
		if (!(indexFolder instanceof TFolder)) {
			return 0;
		}
		let count = 0;
		for (const file of listIndexFiles(indexFolder)) {
			const content = await this.plugin.app.vault.cachedRead(file);
			count += countMonthlyRefsInIndex(content, oldMonthlyMemoFolder);
		}
		return count;
	}

	private async updateExcludeRuleForMigration(settings: KnomoSettings, plan: MonthlyFolderMigrationPlan): Promise<Partial<KnomoSettings>> {
		if (!settings.excludeMonthlyMemosFromObsidian) {
			return {};
		}
		const nextRule = buildMonthlyFolderExcludeRule(plan.newMonthlyMemoFolder);
		if (nextRule === null) {
			return {
				excludeMonthlyMemosFromObsidian: false,
				managedObsidianExcludeRule: undefined,
				managedObsidianExcludeRuleOwned: false,
			};
		}
		const excludeService = new ObsidianExcludeService(this.plugin.app);
		const previousRule = settings.managedObsidianExcludeRule;
		const result = await excludeService.ensureRule(nextRule);
		if (
			settings.managedObsidianExcludeRuleOwned === true &&
			previousRule !== undefined &&
			previousRule !== nextRule
		) {
			await excludeService.removeRule(previousRule);
		}
		return {
			excludeMonthlyMemosFromObsidian: true,
			managedObsidianExcludeRule: nextRule,
			managedObsidianExcludeRuleOwned: settings.managedObsidianExcludeRuleOwned === true || result.addedByKnomo,
		};
	}

	private async updateSystemFolderExcludeRule(settings: KnomoSettings, monthlyMemoFolder: string): Promise<Partial<KnomoSettings>> {
		const nextRule = buildSystemFolderExcludeRule(monthlyMemoFolder);
		const previousRule = settings.managedSystemFolderExcludeRule;
		const previousOwned = settings.managedSystemFolderExcludeRuleOwned === true;
		try {
			const excludeService = new ObsidianExcludeService(this.plugin.app);
			const result = await excludeService.ensureRule(nextRule);
			if (previousOwned && previousRule !== undefined && previousRule !== nextRule) {
				await excludeService.removeRule(previousRule);
			}
			return {
				managedSystemFolderExcludeRule: nextRule,
				managedSystemFolderExcludeRuleOwned: previousRule === nextRule
					? previousOwned || result.addedByKnomo
					: result.addedByKnomo,
			};
		} catch {
			return {};
		}
	}

	private hasSystemExcludeStateChanged(settings: KnomoSettings, state: Partial<KnomoSettings>): boolean {
		return state.managedSystemFolderExcludeRule !== undefined && (
			state.managedSystemFolderExcludeRule !== settings.managedSystemFolderExcludeRule ||
			state.managedSystemFolderExcludeRuleOwned !== settings.managedSystemFolderExcludeRuleOwned
		);
	}

	private async restoreMonthlyMigrationBackup(plan: MonthlyFolderMigrationPlan, backupRoot: string): Promise<void> {
		await this.restoreIndexBackup(plan.oldMonthlyMemoFolder, backupRoot);
		await this.restoreMonthlyFilesBackup(plan.oldMonthlyMemoFolder, backupRoot);
	}

	private async restoreIndexBackup(monthlyMemoFolder: string, backupRoot: string): Promise<void> {
		const indexBackupFolder = this.plugin.app.vault.getAbstractFileByPath(normalizePath(`${backupRoot}/indexes`));
		if (!(indexBackupFolder instanceof TFolder)) {
			return;
		}
		const indexFolderPath = getIndexFolderPath(monthlyMemoFolder);
		await ensureFolder(this.plugin.app, indexFolderPath);
		for (const file of listMarkdownAndJsonFiles(indexBackupFolder)) {
			const relativePath = file.path.slice(indexBackupFolder.path.length + 1);
			await this.restoreFileFromBackup(file, normalizePath(`${indexFolderPath}/${relativePath}`));
		}
	}

	private async restoreMonthlyFilesBackup(monthlyMemoFolder: string, backupRoot: string): Promise<void> {
		const monthlyBackupFolder = this.plugin.app.vault.getAbstractFileByPath(normalizePath(`${backupRoot}/monthly`));
		if (!(monthlyBackupFolder instanceof TFolder)) {
			return;
		}
		for (const file of listMarkdownAndJsonFiles(monthlyBackupFolder)) {
			const relativePath = file.path.slice(monthlyBackupFolder.path.length + 1);
			await this.restoreFileFromBackup(file, normalizePath(`${monthlyMemoFolder}/${relativePath}`));
		}
	}

	private async restoreFileFromBackup(backupFile: TFile, targetPath: string): Promise<void> {
		const parentPath = getParentFolderPath(targetPath);
		if (parentPath !== null) {
			await ensureFolder(this.plugin.app, parentPath);
		}
		const content = await this.plugin.app.vault.cachedRead(backupFile);
		const existing = this.plugin.app.vault.getAbstractFileByPath(targetPath);
		if (existing instanceof TFile) {
			await this.plugin.app.vault.process(existing, () => content);
		} else {
			await this.plugin.app.vault.create(targetPath, content);
		}
	}

	private async restoreExcludeRules(rules: string[]): Promise<void> {
		try {
			await new ObsidianExcludeService(this.plugin.app).setExcludeRules(rules);
		} catch {
			// 排除规则只影响 Obsidian 展示范围，迁移失败时优先保证文件和索引已回滚。
		}
	}

	private async rollbackMonthlyMigration(movedPaths: Array<{ from: string; to: string }>): Promise<void> {
		for (const move of [...movedPaths].reverse()) {
			const moved = this.plugin.app.vault.getAbstractFileByPath(move.to);
			if (moved === null || this.plugin.app.vault.getAbstractFileByPath(move.from) !== null) {
				continue;
			}
			if (moved instanceof TFile) {
				const discardMoveMarker = this.onBeforeArchiveMove(move.to, move.from);
				try {
					await this.plugin.app.vault.rename(moved, move.from);
				} catch (error) {
					discardMoveMarker?.();
					throw error;
				}
				continue;
			}
			await this.plugin.app.vault.rename(moved, move.from);
		}
	}
}

export interface SystemFolderMigrationResult {
	status: "unchanged" | "migrated" | "created";
	oldSystemPath: string;
	newSystemPath: string;
	message: string;
	plan?: MonthlyFolderMigrationPlan;
}

export interface MonthlyFolderMigrationPlan {
	status: "unchanged" | "planned";
	oldMonthlyMemoFolder: string;
	newMonthlyMemoFolder: string;
	oldSystemPath: string;
	newSystemPath: string;
	monthlyFileMoves: Array<{ from: string; to: string }>;
	moveSystemFolder: boolean;
	rewrittenMonthlyRefs: number;
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
	backupPath: string | null;
	plan: MonthlyMemoFileFormatMigrationPlan;
}

function listIndexFiles(folder: TFolder): TFile[] {
	return listMarkdownAndJsonFiles(folder).filter((file) => /^memo-index-\d{4}-\d{2}\.json$/.test(file.name));
}

function listMarkdownAndJsonFiles(folder: TFolder): TFile[] {
	const files: TFile[] = [];
	Vault.recurseChildren(folder, (child) => {
		if (child instanceof TFile && (child.extension === "md" || child.extension === "json")) {
			files.push(child);
		}
	});
	return files;
}

function countMonthlyRefsInIndex(content: string, oldMonthlyMemoFolder: string): number {
	const parsed = parseIndexContent(content);
	if (!isRecord(parsed) || !isRecord(parsed.memos)) {
		return 0;
	}
	let count = 0;
	for (const memo of Object.values(parsed.memos)) {
		if (!isRecord(memo) || !isRecord(memo.monthlyRef) || typeof memo.monthlyRef.path !== "string") {
			continue;
		}
		if (shouldRewriteMonthlyPath(memo.monthlyRef.path, oldMonthlyMemoFolder)) {
			count += 1;
		}
	}
	return count;
}

function rewriteMonthlyRefPaths(content: string, oldMonthlyMemoFolder: string, newMonthlyMemoFolder: string): string {
	const parsed = parseIndexContent(content);
	if (!isRecord(parsed) || !isRecord(parsed.memos)) {
		return content;
	}
	let changed = false;
	for (const memo of Object.values(parsed.memos)) {
		if (!isRecord(memo) || !isRecord(memo.monthlyRef) || typeof memo.monthlyRef.path !== "string") {
			continue;
		}
		const nextPath = rewriteMonthlyPath(memo.monthlyRef.path, oldMonthlyMemoFolder, newMonthlyMemoFolder);
		if (nextPath !== memo.monthlyRef.path) {
			memo.monthlyRef.path = nextPath;
			changed = true;
		}
	}
	return changed ? `${JSON.stringify(parsed, null, "\t")}\n` : content;
}

function rewriteAllMonthlyRefPaths(content: string, targetPath: string): string {
	const parsed = parseIndexContent(content);
	if (!isRecord(parsed) || !isRecord(parsed.memos)) {
		throw new Error("Monthly memo-index content is invalid.");
	}
	let changed = false;
	for (const memo of Object.values(parsed.memos)) {
		if (!isRecord(memo) || !isRecord(memo.monthlyRef) || memo.monthlyRef.path === targetPath) {
			continue;
		}
		memo.monthlyRef.path = targetPath;
		changed = true;
	}
	return changed ? `${JSON.stringify(parsed, null, "\t")}\n` : content;
}

function parseIndexContent(content: string): unknown {
	if (content.trim().length === 0) {
		return null;
	}
	try {
		return JSON.parse(content) as unknown;
	} catch {
		return null;
	}
}

function listMonthlyRefPaths(content: string): string[] {
	const parsed = parseIndexContent(content);
	if (!isRecord(parsed) || !isRecord(parsed.memos)) {
		return [];
	}
	const paths: string[] = [];
	for (const memo of Object.values(parsed.memos)) {
		if (isRecord(memo) && isRecord(memo.monthlyRef) && typeof memo.monthlyRef.path === "string") {
			paths.push(normalizeVaultPath(memo.monthlyRef.path));
		}
	}
	return paths;
}

function getPeriodFromMonthlyFileName(fileName: string, format: string): string | null {
	if (!isValidMonthlyMemoFileFormat(format)) {
		return null;
	}
	const [prefix, suffix] = format.split("YYYY-MM");
	if (!fileName.startsWith(prefix) || !fileName.endsWith(suffix)) {
		return null;
	}
	const period = fileName.slice(prefix.length, suffix.length === 0 ? undefined : -suffix.length);
	return /^\d{4}-(?:0[1-9]|1[0-2])$/.test(period) ? period : null;
}

function isPathInsideFolder(path: string, folder: string): boolean {
	const normalizedPath = normalizeVaultPath(path);
	const normalizedFolder = normalizeVaultPath(folder);
	return normalizedPath.startsWith(`${normalizedFolder}/`);
}

function rewriteMonthlyPath(path: string, oldMonthlyMemoFolder: string, newMonthlyMemoFolder: string): string {
	if (!shouldRewriteMonthlyPath(path, oldMonthlyMemoFolder)) {
		return path;
	}
	const normalizedOld = normalizeVaultPath(oldMonthlyMemoFolder);
	const normalizedNew = normalizeVaultPath(newMonthlyMemoFolder);
	return normalizePath(`${normalizedNew}/${path.slice(normalizedOld.length + 1)}`);
}

function shouldRewriteMonthlyPath(path: string, oldMonthlyMemoFolder: string): boolean {
	const normalizedOld = normalizeVaultPath(oldMonthlyMemoFolder);
	return path === normalizedOld || path.startsWith(`${normalizedOld}/`);
}

import { normalizePath, TFile, TFolder, Vault } from "obsidian";
import type { Plugin } from "obsidian";

import { ensureReadOnlyComment } from "../services/MonthlyArchiveService";
import { buildMonthlyFolderExcludeRule, buildSystemFolderExcludeRule, ObsidianExcludeService } from "../services/ObsidianExcludeService";
import type { KnomoSettings } from "../types/settings";
import { isRecord } from "../utils/object";
import { getIndexFolderPath, getSystemFolderPath, normalizeVaultPath } from "../utils/path";
import { ensureFolder, getParentFolderPath } from "../utils/vault";

type GetSettings = () => KnomoSettings;
type SaveSettings = (settings: KnomoSettings) => Promise<KnomoSettings>;

export class MonthlyFolderMigrationService {
	constructor(
		private readonly plugin: Plugin,
		private readonly getSettings: GetSettings,
		private readonly saveSettings: SaveSettings,
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
			throw new Error(`Target path has conflicts; migration stopped: ${plan.conflicts.join("; ")}`);
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
				await this.plugin.app.vault.rename(file, move.to);
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
				throw new Error(`Old system path is not a folder: ${plan.oldSystemPath}`);
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
		const oldFolder = this.plugin.app.vault.getAbstractFileByPath(oldMonthlyMemoFolder);
		const monthlyFiles = oldFolder instanceof TFolder
			? oldFolder.children.filter((child): child is TFile => child instanceof TFile && child.extension === "md")
			: [];
		const monthlyFileMoves = monthlyFiles.map((file) => ({
			from: file.path,
			to: normalizePath(`${newMonthlyMemoFolder}/${file.name}`),
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
				await this.copyFileToBackup(file, normalizePath(`${monthlyBackupRoot}/${file.name}`));
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

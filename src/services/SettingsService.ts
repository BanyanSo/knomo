import { normalizePath, TFile, TFolder, Vault } from "obsidian";
import type { Plugin } from "obsidian";

import {
	DEFAULT_DAILY_HEADING,
	DEFAULT_DESKTOP_SIDEBAR_WIDTH,
	DEFAULT_MEMO_TIME_FORMAT,
	DEFAULT_MONTHLY_DATE_HEADING_FORMAT,
	DEFAULT_MONTHLY_DATE_ORDER,
	DEFAULT_MONTHLY_MEMO_FILE_FORMAT,
	DEFAULT_MONTHLY_MEMO_FOLDER,
	DEFAULT_SYNC_DEBOUNCE_MS,
	SETTINGS_VERSION,
} from "../constants";
import type {
	DailyInsertPosition,
	KnomoSettings,
	MemoTimeFormat,
	MobileCompactMode,
	MonthlyDateOrder,
} from "../types/settings";
import { ensureReadOnlyComment } from "./MonthlyArchiveService";
import { buildMonthlyFolderExcludeRule, buildSystemFolderExcludeRule, ObsidianExcludeService } from "./ObsidianExcludeService";
import { isValidMarkdownHeading } from "../utils/markdown";
import { isRecord } from "../utils/object";
import { getIndexFolderPath, getSystemFolderPath, normalizeVaultPath } from "../utils/path";
import { buildPluginDataWithSettings, extractSettingsData } from "../utils/pluginData";
import { ensureFolder, getParentFolderPath } from "../utils/vault";

export const DEFAULT_KNOMO_SETTINGS: KnomoSettings = {
	settingsVersion: SETTINGS_VERSION,
	dailyHeading: DEFAULT_DAILY_HEADING,
	dailyInsertPosition: "bottom",
	memoTimeFormat: DEFAULT_MEMO_TIME_FORMAT,
	monthlyMemoFolder: DEFAULT_MONTHLY_MEMO_FOLDER,
	monthlyMemoFileFormat: DEFAULT_MONTHLY_MEMO_FILE_FORMAT,
	monthlyDateHeadingFormat: DEFAULT_MONTHLY_DATE_HEADING_FORMAT,
	monthlyDateOrder: DEFAULT_MONTHLY_DATE_ORDER,
	legacyDailyHeadings: [],
	mobileCompactMode: "auto",
	syncDebounceMs: DEFAULT_SYNC_DEBOUNCE_MS,
	desktopSidebarWidth: DEFAULT_DESKTOP_SIDEBAR_WIDTH,
	desktopSidebarCollapsed: false,
	excludeMonthlyMemosFromObsidian: false,
	managedObsidianExcludeRule: undefined,
	managedObsidianExcludeRuleOwned: false,
	managedSystemFolderExcludeRule: undefined,
	managedSystemFolderExcludeRuleOwned: false,
	pinnedTags: [],
};

function isDailyInsertPosition(value: unknown): value is DailyInsertPosition {
	return value === "top" || value === "bottom";
}

function isMemoTimeFormat(value: unknown): value is MemoTimeFormat {
	return value === "HH:mm:ss" || value === "HH:mm";
}

function isMobileCompactMode(value: unknown): value is MobileCompactMode {
	return value === "auto" || value === "on" || value === "off";
}

function isMonthlyDateOrder(value: unknown): value is MonthlyDateOrder {
	return value === "asc" || value === "desc";
}

function stringOrDefault(value: unknown, fallback: string): string {
	return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

function numberOrDefault(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function booleanOrDefault(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export function isValidMonthlyMemoFileFormat(value: string): boolean {
	return !/[\\/]/.test(value);
}

function stringArrayOrDefault(value: unknown, fallback: string[]): string[] {
	if (!Array.isArray(value)) {
		return [...fallback];
	}
	return value.filter((item): item is string => typeof item === "string");
}

function normalizeSettings(value: Record<string, unknown>): KnomoSettings {
	const merged = Object.assign({}, DEFAULT_KNOMO_SETTINGS, value);
	const dailyInsertPosition = isDailyInsertPosition(merged.dailyInsertPosition)
		? merged.dailyInsertPosition
		: DEFAULT_KNOMO_SETTINGS.dailyInsertPosition;
	const memoTimeFormat = isMemoTimeFormat(merged.memoTimeFormat)
		? merged.memoTimeFormat
		: DEFAULT_KNOMO_SETTINGS.memoTimeFormat;
	const mobileCompactMode = isMobileCompactMode(merged.mobileCompactMode)
		? merged.mobileCompactMode
		: DEFAULT_KNOMO_SETTINGS.mobileCompactMode;
	const monthlyDateOrder = isMonthlyDateOrder(merged.monthlyDateOrder)
		? merged.monthlyDateOrder
		: DEFAULT_KNOMO_SETTINGS.monthlyDateOrder;
	const monthlyMemoFileFormat = stringOrDefault(
		merged.monthlyMemoFileFormat,
		DEFAULT_KNOMO_SETTINGS.monthlyMemoFileFormat,
	);

	return {
		settingsVersion: SETTINGS_VERSION,
		dailyHeading: stringOrDefault(merged.dailyHeading, DEFAULT_KNOMO_SETTINGS.dailyHeading),
		dailyInsertPosition,
		memoTimeFormat,
		monthlyMemoFolder: normalizeVaultPath(
			stringOrDefault(merged.monthlyMemoFolder, DEFAULT_KNOMO_SETTINGS.monthlyMemoFolder),
		),
		monthlyMemoFileFormat: isValidMonthlyMemoFileFormat(monthlyMemoFileFormat)
			? monthlyMemoFileFormat
			: DEFAULT_KNOMO_SETTINGS.monthlyMemoFileFormat,
		monthlyDateHeadingFormat: stringOrDefault(
			merged.monthlyDateHeadingFormat,
			DEFAULT_KNOMO_SETTINGS.monthlyDateHeadingFormat,
		),
		monthlyDateOrder,
		legacyDailyHeadings: stringArrayOrDefault(
			merged.legacyDailyHeadings,
			DEFAULT_KNOMO_SETTINGS.legacyDailyHeadings,
		).filter((heading) => isValidMarkdownHeading(heading)),
		mobileCompactMode,
		syncDebounceMs: numberOrDefault(merged.syncDebounceMs, DEFAULT_KNOMO_SETTINGS.syncDebounceMs),
		desktopSidebarWidth: numberOrDefault(
			merged.desktopSidebarWidth,
			DEFAULT_KNOMO_SETTINGS.desktopSidebarWidth,
		),
		desktopSidebarCollapsed: booleanOrDefault(
			merged.desktopSidebarCollapsed,
			DEFAULT_KNOMO_SETTINGS.desktopSidebarCollapsed,
		),
		excludeMonthlyMemosFromObsidian: booleanOrDefault(
			merged.excludeMonthlyMemosFromObsidian,
			DEFAULT_KNOMO_SETTINGS.excludeMonthlyMemosFromObsidian,
		),
		managedObsidianExcludeRule: optionalString(merged.managedObsidianExcludeRule),
		managedObsidianExcludeRuleOwned: booleanOrDefault(
			merged.managedObsidianExcludeRuleOwned,
			DEFAULT_KNOMO_SETTINGS.managedObsidianExcludeRuleOwned ?? false,
		),
		managedSystemFolderExcludeRule: optionalString(merged.managedSystemFolderExcludeRule),
		managedSystemFolderExcludeRuleOwned: booleanOrDefault(
			merged.managedSystemFolderExcludeRuleOwned,
			DEFAULT_KNOMO_SETTINGS.managedSystemFolderExcludeRuleOwned ?? false,
		),
		pinnedTags: stringArrayOrDefault(merged.pinnedTags, DEFAULT_KNOMO_SETTINGS.pinnedTags),
	};
}

function cloneSettings(settings: KnomoSettings): KnomoSettings {
	return {
		...settings,
		legacyDailyHeadings: [...settings.legacyDailyHeadings],
		pinnedTags: [...settings.pinnedTags],
	};
}

export class SettingsService {
	private settings = cloneSettings(DEFAULT_KNOMO_SETTINGS);

	constructor(private readonly plugin: Plugin) {}

	async loadSettings(): Promise<KnomoSettings> {
		const savedData = (await this.plugin.loadData()) as unknown;
		this.settings = this.migrateSettings(extractSettingsData(savedData));
		return this.getSettings();
	}

	getSettings(): KnomoSettings {
		return cloneSettings(this.settings);
	}

	async saveSettings(settings: KnomoSettings): Promise<KnomoSettings> {
		this.settings = this.migrateSettings(settings);
		const savedData = await this.plugin.loadData();
		await this.plugin.saveData(buildPluginDataWithSettings(savedData, this.settings));
		return this.getSettings();
	}

	async updateSettings(patch: Partial<KnomoSettings>): Promise<KnomoSettings> {
		const nextSettings = Object.assign({}, this.settings, patch);
		return this.saveSettings(nextSettings);
	}

	migrateSettings(savedData: unknown): KnomoSettings {
		const savedSettings = isRecord(savedData) ? savedData : {};
		return normalizeSettings(savedSettings);
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
		await ensureFolder(this.plugin.app, getIndexFolderPath(this.settings.monthlyMemoFolder));
		const systemExcludeState = await this.updateSystemFolderExcludeRule(this.settings.monthlyMemoFolder);
		if (this.hasSystemExcludeStateChanged(systemExcludeState)) {
			await this.saveSettings({
				...this.settings,
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
				message: "系统目录路径未变化。",
				plan,
			};
		}
		if (plan.conflicts.length > 0) {
			throw new Error(`目标路径存在冲突，已停止迁移：${plan.conflicts.join("；")}`);
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
				throw new Error(`旧系统路径不是文件夹：${plan.oldSystemPath}`);
			} else {
				await ensureFolder(this.plugin.app, getIndexFolderPath(plan.newMonthlyMemoFolder));
			}

			await this.rewriteMonthlyRefs(plan);
			const excludeState = await this.updateExcludeRuleForMigration(plan);
			const systemExcludeState = await this.updateSystemFolderExcludeRule(plan.newMonthlyMemoFolder);
			await this.saveSettings({
				...this.settings,
				monthlyMemoFolder: plan.newMonthlyMemoFolder,
				...excludeState,
				...systemExcludeState,
			});
			return {
				status: "migrated",
				oldSystemPath: plan.oldSystemPath,
				newSystemPath: plan.newSystemPath,
				message: "月度 Memos 文件夹已完整迁移。",
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
		const oldMonthlyMemoFolder = this.settings.monthlyMemoFolder;
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

	private async updateExcludeRuleForMigration(plan: MonthlyFolderMigrationPlan): Promise<Partial<KnomoSettings>> {
		if (!this.settings.excludeMonthlyMemosFromObsidian) {
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
		const previousRule = this.settings.managedObsidianExcludeRule;
		const result = await excludeService.ensureRule(nextRule);
		if (
			this.settings.managedObsidianExcludeRuleOwned === true &&
			previousRule !== undefined &&
			previousRule !== nextRule
		) {
			await excludeService.removeRule(previousRule);
		}
		return {
			excludeMonthlyMemosFromObsidian: true,
			managedObsidianExcludeRule: nextRule,
			managedObsidianExcludeRuleOwned: this.settings.managedObsidianExcludeRuleOwned === true || result.addedByKnomo,
		};
	}

	private async updateSystemFolderExcludeRule(monthlyMemoFolder: string): Promise<Partial<KnomoSettings>> {
		const nextRule = buildSystemFolderExcludeRule(monthlyMemoFolder);
		const previousRule = this.settings.managedSystemFolderExcludeRule;
		const previousOwned = this.settings.managedSystemFolderExcludeRuleOwned === true;
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

	private hasSystemExcludeStateChanged(state: Partial<KnomoSettings>): boolean {
		return state.managedSystemFolderExcludeRule !== undefined && (
			state.managedSystemFolderExcludeRule !== this.settings.managedSystemFolderExcludeRule ||
			state.managedSystemFolderExcludeRuleOwned !== this.settings.managedSystemFolderExcludeRuleOwned
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

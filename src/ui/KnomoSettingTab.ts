import { Notice, PluginSettingTab, Setting } from "obsidian";
import type { App, ButtonComponent, Plugin, ToggleComponent } from "obsidian";

import {
	DEFAULT_DAILY_HEADING,
	DEFAULT_MONTHLY_DATE_HEADING_FORMAT,
	DEFAULT_MONTHLY_MEMO_FILE_FORMAT,
	DEFAULT_MONTHLY_MEMO_FOLDER,
	KNOMO_VIEW_TYPE,
} from "../constants";
import { t } from "../i18n";
import { en } from "../i18n/en";
import { legacyZhCNText } from "../i18n/zh-CN";
import type { TranslationKey } from "../i18n";
import { buildMonthlyFolderExcludeRule, type ObsidianExcludeService } from "../services/ObsidianExcludeService";
import type { SettingsService } from "../services/SettingsService";
import type { RebuildIndexMode, RebuildIndexScope, SyncOrchestrator } from "../services/SyncOrchestrator";
import type { LegacyDailyMemosGroupPreview, LegacyDailyMemosImportScope, LegacyDailyMemosPreview } from "../services/MemoScanService";
import type { MemoRecord } from "../types/memo";
import type { DailyInsertPosition, MemoTimeFormat, MonthlyDateOrder } from "../types/settings";
import { normalizeVaultPath } from "../utils/path";
import { KnomoView } from "./KnomoView";

export class KnomoSettingTab extends PluginSettingTab {
	private issueListEl: HTMLElement | null = null;
	private legacyImportResultEl: HTMLElement | null = null;
	private legacyImportGroupsEl: HTMLElement | null = null;
	private legacyImportPreview: LegacyDailyMemosPreview | null = null;
	private legacyImportScope: LegacyDailyMemosImportScope = "90d";
	private legacyImportRunning = false;
	private rebuildResultEl: HTMLElement | null = null;
	private monthlyExcludeStatusEl: HTMLElement | null = null;
	private rebuildRunning = false;

	constructor(
		app: App,
		plugin: Plugin,
		private readonly settingsService: SettingsService,
		private readonly syncOrchestrator: SyncOrchestrator,
		private readonly obsidianExcludeService: ObsidianExcludeService,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		const settings = this.settingsService.getSettings();

		containerEl.createEl("h2", { text: t("settings.title") });

		new Setting(containerEl)
			.setName(t("settings.dailyHeading.name"))
			.setDesc(t("settings.dailyHeading.desc", { heading: DEFAULT_DAILY_HEADING }))
			.addText((text) => {
				text.setPlaceholder(DEFAULT_DAILY_HEADING);
				text.setValue(settings.dailyHeading);
				text.onChange((value) => {
					void this.saveDailyHeading(value);
				});
			});
		new Setting(containerEl)
			.setName(t("settings.insertPosition.name"))
			.setDesc(t("settings.insertPosition.desc"))
			.addDropdown((dropdown) => {
				dropdown.addOption("bottom", t("settings.insertPosition.bottom"));
				dropdown.addOption("top", t("settings.insertPosition.top"));
				dropdown.setValue(settings.dailyInsertPosition);
				dropdown.onChange((value) => {
					void this.settingsService.updateSettings({
						dailyInsertPosition: value as DailyInsertPosition,
					});
				});
			});
		new Setting(containerEl)
			.setName(t("settings.timeFormat.name"))
			.setDesc(t("settings.timeFormat.desc"))
			.addDropdown((dropdown) => {
				dropdown.addOption("HH:mm:ss", "HH:mm:ss");
				dropdown.addOption("HH:mm", "HH:mm");
				dropdown.setValue(settings.memoTimeFormat);
				dropdown.onChange((value) => {
					void this.settingsService.updateSettings({
						memoTimeFormat: value as MemoTimeFormat,
					});
				});
			});

		let monthlyFolderDraft = settings.monthlyMemoFolder;
		new Setting(containerEl)
			.setName(t("settings.monthlyFolder.name"))
			.setDesc(t("settings.monthlyFolder.desc"))
			.addText((text) => {
				text.setPlaceholder(DEFAULT_MONTHLY_MEMO_FOLDER);
				text.setValue(settings.monthlyMemoFolder);
				text.onChange((value) => {
					monthlyFolderDraft = value;
				});
			})
			.addButton((button) => {
				button.setButtonText(t("settings.monthlyFolder.save"));
				button.onClick(() => {
					void this.saveMonthlyFolder(monthlyFolderDraft, button);
				});
			});
		new Setting(containerEl)
			.setName(t("settings.excludeMonthly.name"))
			.setDesc(t("settings.excludeMonthly.desc"))
			.addToggle((toggle) => {
				toggle.setValue(settings.excludeMonthlyMemosFromObsidian);
				toggle.onChange((value) => {
					void this.toggleMonthlyMemosExcludeRule(value, toggle);
				});
			});
		this.monthlyExcludeStatusEl = containerEl.createDiv({ cls: "knomo-setting-help" });
		new Setting(containerEl)
			.setName(t("settings.monthlyFileFormat.name"))
			.setDesc(t("settings.monthlyFileFormat.desc", { format: DEFAULT_MONTHLY_MEMO_FILE_FORMAT }))
			.addText((text) => {
				text.setPlaceholder(DEFAULT_MONTHLY_MEMO_FILE_FORMAT);
				text.setValue(settings.monthlyMemoFileFormat);
				text.onChange((value) => {
					void this.saveMonthlyMemoFileFormat(value);
				});
			});
		new Setting(containerEl)
			.setName(t("settings.dateHeadingFormat.name"))
			.setDesc(t("settings.dateHeadingFormat.desc", { format: DEFAULT_MONTHLY_DATE_HEADING_FORMAT }))
			.addText((text) => {
				text.setPlaceholder(DEFAULT_MONTHLY_DATE_HEADING_FORMAT);
				text.setValue(settings.monthlyDateHeadingFormat);
				text.onChange((value) => {
					void this.saveMonthlyDateHeadingFormat(value);
				});
			});
		new Setting(containerEl)
			.setName(t("settings.dateOrder.name"))
			.setDesc(t("settings.dateOrder.desc"))
			.addDropdown((dropdown) => {
				dropdown.addOption("asc", t("settings.dateOrder.asc"));
				dropdown.addOption("desc", t("settings.dateOrder.descOption"));
				dropdown.setValue(settings.monthlyDateOrder);
				dropdown.onChange((value) => {
					void this.settingsService.updateSettings({
						monthlyDateOrder: value as MonthlyDateOrder,
					});
				});
			});

		new Setting(containerEl)
			.setName(t("settings.maintenance.heading"))
			.setHeading();
		new Setting(containerEl)
			.setName(t("settings.legacyImport.name"))
			.setDesc(t("settings.legacyImport.desc"))
			.addDropdown((dropdown) => {
				dropdown.addOption("30d", t("settings.scope30d"));
				dropdown.addOption("90d", t("settings.scope90d"));
				dropdown.addOption("all", t("settings.scopeAll"));
				dropdown.setValue(this.legacyImportScope);
				dropdown.onChange((value) => {
					this.legacyImportScope = value as LegacyDailyMemosImportScope;
					this.legacyImportPreview = null;
					this.renderLegacyImportPreview();
				});
			})
			.addButton((button) => {
				button.setButtonText(t("settings.preview.start"));
				button.onClick(() => {
					void this.runLegacyImportPreview(button);
				});
			});
		this.legacyImportResultEl = containerEl.createDiv({ cls: "knomo-scan-result" });
		this.legacyImportGroupsEl = containerEl.createDiv({ cls: "knomo-legacy-import-groups" });
		this.renderLegacyImportPreview();

		let rebuildScope: RebuildIndexScope = "30d";
		let rebuildMode: RebuildIndexMode = "index-only";
		new Setting(containerEl)
			.setName(t("settings.rebuild.name"))
			.setDesc(t("settings.rebuild.desc"))
			.addDropdown((dropdown) => {
				dropdown.addOption("30d", t("settings.scope30d"));
				dropdown.addOption("90d", t("settings.scope90d"));
				dropdown.addOption("all", t("settings.scopeAll"));
				dropdown.setValue(rebuildScope);
				dropdown.onChange((value) => {
					rebuildScope = value as RebuildIndexScope;
				});
			})
			.addDropdown((dropdown) => {
				dropdown.addOption("index-only", t("settings.rebuild.indexOnly"));
				dropdown.addOption("index-and-monthly", t("settings.rebuild.indexAndMonthly"));
				dropdown.setValue(rebuildMode);
				dropdown.onChange((value) => {
					rebuildMode = value as RebuildIndexMode;
				});
			})
			.addButton((button) => {
				button.setButtonText(t("settings.rebuild.start"));
				button.onClick(() => {
					void this.runRebuildIndex(rebuildScope, rebuildMode, button);
				});
			});
		this.rebuildResultEl = containerEl.createDiv({ cls: "knomo-scan-result" });
		this.renderRebuildResult(t("settings.rebuild.before"));
		this.issueListEl = containerEl.createDiv({ cls: "knomo-issue-list" });
		void this.renderIssueList();
	}

	private async saveDailyHeading(value: string): Promise<void> {
		const nextHeading = value.trim();
		if (!this.settingsService.validateDailyHeading(nextHeading)) {
			new Notice(t("settings.dailyHeading.invalid"));
			return;
		}
		if (nextHeading === this.settingsService.getSettings().dailyHeading) {
			return;
		}
		await this.settingsService.updateSettings({ dailyHeading: nextHeading });
		new Notice(t("settings.dailyHeading.changed"));
	}

	private async saveMonthlyDateHeadingFormat(value: string): Promise<void> {
		const nextFormat = value.trim();
		if (!this.settingsService.validateMarkdownHeading(nextFormat)) {
			new Notice(t("settings.dateHeadingFormat.invalid"));
			return;
		}
		await this.settingsService.updateSettings({ monthlyDateHeadingFormat: nextFormat });
	}

	private async saveMonthlyMemoFileFormat(value: string): Promise<void> {
		const nextFormat = value.trim();
		if (!this.settingsService.validateMonthlyMemoFileFormat(nextFormat)) {
			new Notice(t("settings.monthlyFileFormat.invalid"));
			return;
		}
		await this.settingsService.updateSettings({ monthlyMemoFileFormat: nextFormat });
	}

	private async saveMonthlyFolder(value: string, button: ButtonComponent): Promise<void> {
		const monthlyMemoFolder = normalizeVaultPath(value);
		const currentSettings = this.settingsService.getSettings();
		button.setDisabled(true);
		button.setButtonText(t("settings.monthlyFolder.saving"));
		try {
			if (monthlyMemoFolder !== currentSettings.monthlyMemoFolder) {
				const plan = await this.settingsService.planMonthlyMemoFolderMigration(monthlyMemoFolder);
				if (plan.conflicts.length > 0) {
					throw new Error(`Target path has conflicts; migration stopped: ${plan.conflicts.join("; ")}`);
				}
				const confirmed = this.containerEl.win.confirm(
					t("settings.monthlyFolder.confirm", {
						current: currentSettings.monthlyMemoFolder,
						next: monthlyMemoFolder,
						count: plan.monthlyFileMoves.length,
						systemAction: plan.moveSystemFolder ? t("settings.monthlyFolder.moveSystem") : t("settings.monthlyFolder.createSystem"),
						rewritten: plan.rewrittenMonthlyRefs,
					}),
				);
				if (!confirmed) {
					return;
				}
			}
			await this.settingsService.migrateMonthlyMemoFolder(monthlyMemoFolder);
			new Notice(t("settings.monthlyFolder.saved"));
		} catch (error) {
			const message = formatSettingsText(error instanceof Error ? error.message : t("settings.monthlyFolder.saveFailed"));
			new Notice(message);
		} finally {
			button.setDisabled(false);
			button.setButtonText(t("settings.monthlyFolder.save"));
		}
	}

	private async toggleMonthlyMemosExcludeRule(enabled: boolean, toggle: ToggleComponent): Promise<void> {
		toggle.setDisabled(true);
		try {
			if (enabled) {
				await this.enableMonthlyMemosExcludeRule();
			} else {
				await this.disableMonthlyMemosExcludeRule();
			}
		} finally {
			toggle.setDisabled(false);
			toggle.setValue(this.settingsService.getSettings().excludeMonthlyMemosFromObsidian);
		}
	}

	private setExcludeStatus(text: string, isError = false): void {
		if (this.monthlyExcludeStatusEl === null) return;
		this.monthlyExcludeStatusEl.setText(text);
		this.monthlyExcludeStatusEl.toggleClass("is-error", isError);
	}

	private async enableMonthlyMemosExcludeRule(): Promise<void> {
		const settings = this.settingsService.getSettings();
		const rule = buildMonthlyFolderExcludeRule(settings.monthlyMemoFolder);
		if (rule === null) {
			await this.settingsService.updateSettings({
				excludeMonthlyMemosFromObsidian: false,
				managedObsidianExcludeRule: undefined,
				managedObsidianExcludeRuleOwned: false,
			});
			this.setExcludeStatus(t("settings.excludeMonthly.empty"), true);
			return;
		}
		try {
			const result = await this.obsidianExcludeService.ensureRule(rule);
			await this.settingsService.updateSettings({
				excludeMonthlyMemosFromObsidian: true,
				managedObsidianExcludeRule: rule,
				managedObsidianExcludeRuleOwned: result.addedByKnomo,
			});
			this.setExcludeStatus(result.addedByKnomo
				? t("settings.excludeMonthly.added")
				: t("settings.excludeMonthly.existing"));
		} catch {
			await this.settingsService.updateSettings({
				excludeMonthlyMemosFromObsidian: false,
				managedObsidianExcludeRule: undefined,
				managedObsidianExcludeRuleOwned: false,
			});
			new Notice(t("settings.excludeMonthly.addManual", { rule }));
		}
	}

	private async disableMonthlyMemosExcludeRule(): Promise<void> {
		const settings = this.settingsService.getSettings();
		const rule = settings.managedObsidianExcludeRule;
		let removedRule = false;
		if (settings.managedObsidianExcludeRuleOwned === true && rule !== undefined) {
			try {
				await this.obsidianExcludeService.removeRule(rule);
				removedRule = true;
			} catch {
				new Notice(t("settings.excludeMonthly.removeManual", { rule }));
			}
		}
		await this.settingsService.updateSettings({
			excludeMonthlyMemosFromObsidian: false,
			managedObsidianExcludeRule: undefined,
			managedObsidianExcludeRuleOwned: false,
		});
		this.setExcludeStatus(removedRule
			? t("settings.excludeMonthly.removed")
			: t("settings.excludeMonthly.keepExisting"));
	}

	private async syncMonthlyMemosExcludeRuleAfterFolderChange(
		nextMonthlyMemoFolder: string,
		previousSettings: ReturnType<SettingsService["getSettings"]>,
	): Promise<void> {
		if (!previousSettings.excludeMonthlyMemosFromObsidian) {
			return;
		}
		const nextRule = buildMonthlyFolderExcludeRule(nextMonthlyMemoFolder);
		if (nextRule === null) {
			await this.settingsService.updateSettings({
				managedObsidianExcludeRule: undefined,
				managedObsidianExcludeRuleOwned: false,
			});
			this.setExcludeStatus(t("settings.excludeMonthly.empty"), true);
			return;
		}
		try {
			const previousRule = previousSettings.managedObsidianExcludeRule;
			if (previousRule === nextRule) {
				const result = await this.obsidianExcludeService.ensureRule(nextRule);
				await this.settingsService.updateSettings({
					excludeMonthlyMemosFromObsidian: true,
					managedObsidianExcludeRule: nextRule,
					managedObsidianExcludeRuleOwned: previousSettings.managedObsidianExcludeRuleOwned === true
						? true
						: result.addedByKnomo,
				});
				return;
			}
			if (
				previousSettings.managedObsidianExcludeRuleOwned === true &&
				previousRule !== undefined
			) {
				await this.obsidianExcludeService.removeRule(previousRule);
			}
			const result = await this.obsidianExcludeService.ensureRule(nextRule);
			await this.settingsService.updateSettings({
				excludeMonthlyMemosFromObsidian: true,
				managedObsidianExcludeRule: nextRule,
				managedObsidianExcludeRuleOwned: result.addedByKnomo,
			});
		} catch {
			await this.settingsService.updateSettings({
				excludeMonthlyMemosFromObsidian: true,
				managedObsidianExcludeRule: nextRule,
				managedObsidianExcludeRuleOwned: false,
			});
			new Notice(t("settings.excludeMonthly.addManual", { rule: nextRule }));
		}
	}

	private async runLegacyImportPreview(button: { setButtonText(text: string): void; setDisabled(disabled: boolean): void }): Promise<void> {
		if (this.legacyImportRunning) {
			return;
		}
		this.legacyImportRunning = true;
		button.setDisabled(true);
		button.setButtonText(t("settings.preview.running"));
		this.legacyImportPreview = null;
		this.legacyImportGroupsEl?.empty();
		this.renderLegacyImportStatus(t("settings.legacyImport.previewing"));
		try {
			this.legacyImportPreview = await this.syncOrchestrator.previewLegacyDailyMemos(this.legacyImportScope);
			this.renderLegacyImportPreview();
		} catch (error) {
			const message = formatSettingsText(error instanceof Error ? error.message : t("settings.legacyImport.previewFailed"));
			this.renderLegacyImportStatus(message, true);
			new Notice(message);
		} finally {
			this.legacyImportRunning = false;
			button.setDisabled(false);
			button.setButtonText(t("settings.preview.start"));
		}
	}

	private renderLegacyImportPreview(): void {
		if (this.legacyImportGroupsEl === null) {
			return;
		}
		this.legacyImportGroupsEl.empty();
		const preview = this.legacyImportPreview;
		if (preview === null) {
			this.renderLegacyImportStatus(t("settings.legacyImport.notPreviewed"));
			return;
		}
		const summary = [
			t("settings.legacyImport.summary", { count: preview.candidateCount }),
			...preview.groups.map((group) => t("settings.legacyImport.groupCount", {
				label: formatSettingsText(group.label),
				count: group.count,
			})),
		].join("\n");
		this.renderLegacyImportStatus(summary);
		if (preview.groups.length === 0) {
			return;
		}
		for (const group of preview.groups) {
			this.renderLegacyImportGroup(group);
		}
		const button = this.legacyImportGroupsEl.createEl("button", {
			cls: "mod-cta",
			text: t("settings.legacyImport.importSelected"),
			attr: { type: "button" },
		});
		button.addEventListener("click", () => {
			void this.runLegacyImport(button);
		});
	}

	private renderLegacyImportGroup(group: LegacyDailyMemosGroupPreview): void {
		if (this.legacyImportGroupsEl === null) {
			return;
		}
		const item = this.legacyImportGroupsEl.createDiv({ cls: "knomo-legacy-import-group" });
		const label = item.createEl("label", { cls: "knomo-legacy-import-label" });
		const checkbox = label.createEl("input", {
			attr: {
				type: "checkbox",
				"data-legacy-import-group": group.key,
			},
		});
		checkbox.checked = group.selectedByDefault;
		label.createSpan({ text: t("settings.legacyImport.groupCount", { label: formatSettingsText(group.label), count: group.count }) });
		const samples = item.createDiv({ cls: "knomo-legacy-import-samples" });
		for (const sample of group.samples) {
			samples.createDiv({
				cls: "knomo-setting-code",
				text: `${sample.path}:${sample.lineNumber} ${sample.time} ${formatLegacyImportSample(sample.content)}`,
			});
		}
	}

	private async runLegacyImport(button: HTMLButtonElement): Promise<void> {
		const preview = this.legacyImportPreview;
		if (preview === null || this.legacyImportGroupsEl === null || this.legacyImportRunning) {
			return;
		}
		const selectedGroupKeys = this.getSelectedLegacyImportGroupKeys();
		if (selectedGroupKeys.length === 0) {
			new Notice(t("settings.legacyImport.chooseGroup"));
			return;
		}
		let importCompleted = false;
		this.legacyImportRunning = true;
		button.disabled = true;
		button.setText(t("settings.legacyImport.importing"));
		this.renderLegacyImportStatus(t("settings.legacyImport.importingStatus"));
		try {
			const result = await this.syncOrchestrator.importLegacyDailyMemos({
				scope: this.legacyImportScope,
				selectedGroupKeys,
			});
			await this.addLegacyDailyHeadings(result.importedHeadings);
			await this.renderIssueList();
			const message = t("settings.legacyImport.complete", {
				imported: result.imported,
				failed: result.failed,
				skipped: result.skipped,
			});
			const errors = result.errors.map(formatSettingsText);
			this.legacyImportPreview = null;
			this.legacyImportGroupsEl.empty();
			this.renderLegacyImportStatus(errors.length > 0 ? `${message}\n${errors.join("\n")}` : message, result.failed > 0);
			importCompleted = true;
			void this.reloadAllMemosInOpenKnomoViewsAfterImport();
			if (result.failed > 0) {
				new Notice(t("settings.legacyImport.failedCount", { count: result.failed }));
			}
		} catch (error) {
			const message = formatSettingsText(error instanceof Error ? error.message : t("settings.legacyImport.failed"));
			this.renderLegacyImportStatus(message, true);
			new Notice(message);
		} finally {
			this.legacyImportRunning = false;
			if (!importCompleted) {
				button.disabled = false;
				button.setText(t("settings.legacyImport.importSelected"));
			}
		}
	}

	private getSelectedLegacyImportGroupKeys(): string[] {
		const groupsEl = this.legacyImportGroupsEl;
		if (groupsEl === null) {
			return [];
		}
		return groupsEl.findAll("input[data-legacy-import-group]")
			.filter((input): input is HTMLInputElement => input.instanceOf(HTMLInputElement) && input.checked)
			.map((input) => input.getAttr("data-legacy-import-group"))
			.filter((key): key is string => key !== null);
	}

	private async addLegacyDailyHeadings(headings: string[]): Promise<void> {
		if (headings.length === 0) {
			return;
		}
		const settings = this.settingsService.getSettings();
		const nextHeadings = [...settings.legacyDailyHeadings];
		for (const heading of headings) {
			if (!nextHeadings.includes(heading)) {
				nextHeadings.push(heading);
			}
		}
		await this.settingsService.updateSettings({ legacyDailyHeadings: nextHeadings });
	}

	private renderLegacyImportStatus(message: string, isError = false): void {
		if (this.legacyImportResultEl === null) {
			return;
		}
		this.legacyImportResultEl.empty();
		this.legacyImportResultEl.createDiv({ cls: isError ? "knomo-setting-help is-error" : "knomo-setting-help", text: message });
	}

	private async runRebuildIndex(
		scope: RebuildIndexScope,
		mode: RebuildIndexMode,
		button: { setButtonText(text: string): void; setDisabled(disabled: boolean): void },
	): Promise<void> {
		if (this.rebuildRunning) {
			return;
		}
		this.rebuildRunning = true;
		button.setDisabled(true);
		button.setButtonText(t("settings.rebuild.checking"));
		try {
			const estimate = await this.syncOrchestrator.estimateRebuildIndex(scope);
			const monthlyModeText = mode === "index-and-monthly" ? t("settings.rebuild.monthlySync") : t("settings.rebuild.monthlyMissingOnly");
			const confirmed = this.containerEl.win.confirm(
				t("settings.rebuild.confirm", {
					scanned: estimate.scannedFiles,
					created: estimate.estimatedNew,
					updated: estimate.estimatedUpdated,
					missing: estimate.estimatedMissing,
					monthlyMode: monthlyModeText,
				}),
			);
			if (!confirmed) {
				this.renderRebuildResult(t("settings.rebuild.cancelled"));
				return;
			}
			button.setButtonText(t("settings.rebuild.running"));
			this.renderRebuildResult(t("settings.rebuild.status", { monthlyMode: monthlyModeText }));
			const result = await this.syncOrchestrator.rebuildIndex(scope, mode, (progress) => {
				this.renderRebuildResult(
					t("settings.rebuild.progress", {
						completed: progress.completedFiles,
						scanned: progress.scannedFiles,
						created: progress.created,
						updated: progress.updated,
						deleted: progress.deleted,
						skipped: progress.skipped,
						failed: progress.failed,
						currentFile: progress.currentFile === null ? "" : t("settings.rebuild.currentFile", { file: progress.currentFile }),
					}),
				);
			});
			const message = t("settings.rebuild.complete", {
				scanned: result.scannedFiles,
				created: result.created,
				updated: result.updated,
				deleted: result.deleted,
				skipped: result.skipped,
			});
			const backup = result.backupPath === null ? t("settings.rebuild.noBackup") : t("settings.rebuild.backup", { path: result.backupPath });
			this.renderRebuildResult(`${message}\n${backup}`);
			await this.renderIssueList();
			await this.refreshOpenKnomoViews();
			new Notice(t("settings.rebuild.completedNotice"));
		} catch (error) {
			const message = formatSettingsText(error instanceof Error ? error.message : t("settings.rebuild.failed"));
			this.renderRebuildResult(message);
			new Notice(message);
		} finally {
			this.rebuildRunning = false;
			button.setDisabled(false);
			button.setButtonText(t("settings.rebuild.start"));
		}
	}

	private renderRebuildResult(message: string): void {
		if (this.rebuildResultEl === null) {
			return;
		}
		this.rebuildResultEl.empty();
		this.rebuildResultEl.createDiv({ cls: "knomo-setting-help", text: message });
	}

	private async refreshOpenKnomoViews(): Promise<void> {
		const refreshes = this.app.workspace.getLeavesOfType(KNOMO_VIEW_TYPE).map(async (leaf) => {
			if (leaf.view instanceof KnomoView) {
				await leaf.view.refresh();
			}
		});
		await Promise.all(refreshes);
	}

	private async reloadAllMemosInOpenKnomoViewsAfterImport(): Promise<void> {
		let failed = false;
		try {
			const preloads = this.app.workspace.getLeavesOfType(KNOMO_VIEW_TYPE).map(async (leaf) => {
				if (!(leaf.view instanceof KnomoView)) {
					return true;
				}
				try {
					return await leaf.view.reloadAllMemosAfterImport();
				} catch {
					return false;
				}
			});
			const results = await Promise.all(preloads);
			failed = results.some((loaded) => !loaded);
			if (results.length > 0 && !failed) {
				new Notice(t("settings.legacyImport.loadedAll"));
			}
		} catch {
			failed = true;
		}
		if (failed) {
			new Notice(t("settings.legacyImport.loadAllFailed"));
		}
	}

	private async renderIssueList(): Promise<void> {
		if (this.issueListEl === null) {
			return;
		}
		this.issueListEl.empty();
		try {
			const memos = await this.syncOrchestrator.listIssueMemos();
			if (memos.length === 0) {
				this.issueListEl.createDiv({ cls: "knomo-setting-help", text: t("settings.issues.none") });
				return;
			}
			for (const memo of memos) {
				this.renderIssueItem(memo);
			}
		} catch (error) {
			this.issueListEl.createDiv({
				cls: "knomo-setting-help is-error",
				text: formatSettingsText(error instanceof Error ? error.message : t("settings.issues.loadFailed")),
			});
		}
	}

	private renderIssueItem(memo: MemoRecord): void {
		if (this.issueListEl === null) {
			return;
		}
		const item = this.issueListEl.createDiv({ cls: "knomo-issue-item" });
		item.createDiv({
			cls: "knomo-setting-code",
			text: `${memo.id} · ${getSyncStatusLabel(memo.syncStatus)}`,
		});
		item.createDiv({
			cls: memo.issue === null ? "knomo-setting-help" : "knomo-setting-help is-error",
			text: formatSettingsText(memo.issue?.message ?? t("settings.issues.needsHandling")),
		});
		if (memo.syncStatus === "monthly_delete_failed") {
			const button = item.createEl("button", {
				cls: "mod-cta",
				text: t("settings.issues.retryMonthlyDelete"),
				attr: { type: "button" },
			});
			button.addEventListener("click", () => {
				void this.retryMonthlyDelete(memo, button);
			});
		} else if (memo.syncStatus === "monthly_failed" || memo.issue?.type === "monthly_block_missing" || memo.issue?.type === "monthly_sync_failed") {
			const button = item.createEl("button", {
				cls: "mod-cta",
				text: t("settings.issues.retryMonthlySync"),
				attr: { type: "button" },
			});
			button.addEventListener("click", () => {
				void this.retryMonthlySync(memo, button);
			});
		}
	}

	private async retryMonthlyDelete(memo: MemoRecord, button: HTMLButtonElement): Promise<void> {
		button.disabled = true;
		button.setText(t("settings.issues.retrying"));
		try {
			await this.syncOrchestrator.retryMonthlyDelete(memo);
			await this.renderIssueList();
			await this.refreshOpenKnomoViews();
			new Notice(t("settings.issues.monthlyDeleteComplete"));
		} catch (error) {
			new Notice(formatSettingsText(error instanceof Error ? error.message : t("settings.issues.monthlyDeleteFailed")));
		} finally {
			button.disabled = false;
			button.setText(t("settings.issues.retryMonthlyDelete"));
		}
	}

	private async retryMonthlySync(memo: MemoRecord, button: HTMLButtonElement): Promise<void> {
		button.disabled = true;
		button.setText(t("settings.issues.retrying"));
		try {
			await this.syncOrchestrator.retryMonthlySync(memo);
			await this.renderIssueList();
			await this.refreshOpenKnomoViews();
			new Notice(t("settings.issues.monthlySyncComplete"));
		} catch (error) {
			new Notice(formatSettingsText(error instanceof Error ? error.message : t("settings.issues.monthlySyncFailed")));
		} finally {
			button.disabled = false;
			button.setText(t("settings.issues.retryMonthlySync"));
		}
	}
}

export function formatSettingsText(text: string): string {
	const sourceText = formatStructuredServiceText(text)
		?? text.split("\n").map((line) => formatStructuredServiceText(line) ?? line).join("\n");
	return replaceKnownServiceText(sourceText)
		.replace(/\bmemo-index\b/gi, t("term.memoIndex"))
		.replace(/\bmemo block\b/gi, t("term.memoBlock"))
		.replace(/\bmemo index\b/gi, t("term.memoIndex"))
		.replace(/\bmemoId\b/g, t("term.memoId"))
		.replace(/\bmemo\b|\bMemo\b|\bMEMO\b/g, t("term.memo"))
		.replace(/\bdaily block\b/gi, t("term.dailyBlock"))
		.replace(/\bmonthly block\b/gi, t("term.monthlyBlock"))
		.replace(/\bblockId\b/g, t("term.blockId"))
		.replace(/\bblock\b/gi, t("term.block"))
		.replace(/_knomo-system/g, t("term.systemFolder"));
}

function getSyncStatusLabel(status: MemoRecord["syncStatus"]): string {
	if (status === "synced") {
		return t("sync.synced");
	}
	if (status === "pending_monthly") {
		return t("sync.pendingMonthly");
	}
	if (status === "monthly_failed") {
		return t("sync.monthlyFailed");
	}
	return t("sync.monthlyDeleteFailed");
}

const KNOWN_SERVICE_TEXT_KEYS: TranslationKey[] = [
	"service.unknownError",
	"service.referenceNotInitialized",
	"service.referenceTargetMissing",
	"service.dailyNotesUnavailable",
	"service.dailyNotesDisabled",
	"service.dailyNotesEnabled",
	"service.systemPathUnchanged",
	"service.monthlyFolderMigrated",
	"service.monthlyArchiveFileMissing",
	"service.monthlyArchiveBlockMissing",
	"service.updateDeleteNeedsStartLine",
	"service.trashOnlyPurge",
	"service.autoExcludeUnsupported",
	"service.dailyBlockAmbiguous",
	"service.monthlyDeleteFailed",
	"service.monthlySyncFailed",
	"service.untitledSection",
	"service.memoContentEmpty",
	"service.dailyFileMissing",
	"service.dailyBlockMissing",
	"service.deleteDailyBlockMissing",
	"service.memoNotFoundOrCleaned",
	"service.restoreFailedRetry",
	"service.monthlyDeleteRetryFailed",
	"service.retryMonthlySyncDailyMissing",
	"service.restoreVerifyDailyFailed",
	"service.missingDeleteSnapshot",
	"service.monthlyIncomplete",
	"service.rebuildIndexFailedGeneric",
	"service.backupNotFound",
	"service.uniqueBlockIdFailed",
];

function replaceKnownServiceText(text: string): string {
	let nextText = text;
	for (const key of KNOWN_SERVICE_TEXT_KEYS) {
		nextText = replaceLiteral(nextText, en[key], t(key));
		const legacyText = legacyZhCNText[key];
		if (legacyText !== undefined) {
			nextText = replaceLiteral(nextText, legacyText, t(key));
		}
	}
	nextText = replaceLegacyBackupPathPrefix(nextText);
	return nextText;
}

function formatStructuredServiceText(text: string): string | null {
	const targetConflictMatch = text.match(/^Target path has conflicts; migration stopped: (.+)$/s);
	if (targetConflictMatch !== null) {
		return t("service.targetPathConflicts", { paths: targetConflictMatch[1] });
	}
	const oldSystemPathMatch = text.match(/^Old system path is not a folder: (.+)$/s);
	if (oldSystemPathMatch !== null) {
		return t("service.oldSystemPathNotFolder", { path: oldSystemPathMatch[1] });
	}
	const indexBackupMatch = text.match(/^Index backup does not exist: (.+)$/s);
	if (indexBackupMatch !== null) {
		return t("service.indexBackupMissing", { path: indexBackupMatch[1] });
	}
	const importFailedMatch = text.match(/^Import failed: (.+)$/s);
	if (importFailedMatch !== null) {
		return t("service.importFailed", { path: importFailedMatch[1] });
	}
	const scanFailedMatch = text.match(/^Scan failed: (.+)$/s);
	if (scanFailedMatch !== null) {
		return t("service.scanFailed", { path: scanFailedMatch[1] });
	}
	const backupPathMatch = text.match(/^Backup path: (.+)$/s);
	if (backupPathMatch !== null) {
		return t("service.backupPath", { path: backupPathMatch[1] });
	}
	const rebuildIndexMatch = text.match(/^Rebuild index failed: (\d+) files did not sync; stopped refreshing the view\.$/s);
	if (rebuildIndexMatch !== null) {
		return t("service.rebuildIndexFailed", { count: rebuildIndexMatch[1] });
	}
	const indexWriteMatch = text.match(
		/^Failed to write memo-index while (.+?) memo\. The daily note may already be written: (.*); monthly archive: (.*)\. Repair memo-index or run manual scan before sending again\. Original error: (.*)$/s,
	);
	if (indexWriteMatch !== null) {
		return t("service.indexWriteFailed", {
			action: getIndexWriteActionLabel(indexWriteMatch[1]),
			dailyPath: indexWriteMatch[2],
			monthlyPath: formatSettingsText(indexWriteMatch[3]),
			reason: formatSettingsText(indexWriteMatch[4]),
		});
	}
	return null;
}

function getIndexWriteActionLabel(action: string): string {
	if (action === "creating") return t("service.actionCreate");
	if (action === "editing") return t("service.actionEdit");
	if (action === "deleting") return t("service.actionDelete");
	if (action === "restoring") return t("service.actionRestore");
	if (action === "generating reference") return t("service.actionReference");
	return action;
}

function replaceLiteral(text: string, search: string, replacement: string): string {
	return search.length === 0 ? text : text.split(search).join(replacement);
}

function replaceLegacyBackupPathPrefix(text: string): string {
	const index = text.indexOf(legacyZhCNText.backupPathPrefix);
	if (index === -1) {
		return text;
	}
	const before = text.slice(0, index);
	const path = text.slice(index + legacyZhCNText.backupPathPrefix.length);
	return `${before}${t("service.backupPath", { path })}`;
}

function formatLegacyImportSample(content: string): string {
	const normalizedContent = content.replace(/\s+/g, " ").trim();
	if (normalizedContent.length <= 80) {
		return normalizedContent;
	}
	return `${normalizedContent.slice(0, 77)}...`;
}

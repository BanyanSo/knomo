import { Notice, PluginSettingTab, Setting } from "obsidian";
import type { App, ButtonComponent, Plugin, SettingDefinitionItem, ToggleComponent } from "obsidian";

import {
	DEFAULT_DAILY_HEADING,
	DEFAULT_MONTHLY_DATE_HEADING_FORMAT,
	DEFAULT_MONTHLY_MEMO_FILE_FORMAT,
	DEFAULT_MONTHLY_MEMO_FOLDER,
	KNOMO_VIEW_TYPE,
} from "../constants";
import { t } from "../i18n";
import { buildMonthlyFolderExcludeRule, type ObsidianExcludeService } from "../services/ObsidianExcludeService";
import type { SettingsService } from "../services/SettingsService";
import type { RebuildIndexMode, RebuildIndexScope, SyncOrchestrator } from "../services/SyncOrchestrator";
import type { LegacyDailyMemosGroupPreview, LegacyDailyMemosImportScope, LegacyDailyMemosPreview } from "../services/MemoScanService";
import type { MemoRecord } from "../types/memo";
import type { DailyInsertPosition, MemoTimeFormat, MonthlyDateOrder } from "../types/settings";
import type { SyncConflictFile } from "../types/syncConflict";
import type { MaintenanceDiagnostic } from "../utils/pluginData";
import { normalizeVaultPath } from "../utils/path";
import { formatMemoIssue, formatServiceError, formatSettingsText } from "../utils/serviceText";
import { showKnomoConfirmModal } from "./KnomoConfirmModal";
import { KnomoView } from "./KnomoView";

const SETTING_NOTICE_DELAY_MS = 800;

type SettingNoticeKey = "dailyHeading" | "monthlyMemoFileFormat" | "monthlyDateHeadingFormat";

interface DelayedSettingNotice {
	value: string;
	timeoutId: number;
}

export class KnomoSettingTab extends PluginSettingTab {
	private issueListEl: HTMLElement | null = null;
	private legacyImportResultEl: HTMLElement | null = null;
	private legacyImportGroupsEl: HTMLElement | null = null;
	private legacyImportPreview: LegacyDailyMemosPreview | null = null;
	private legacyImportScope: LegacyDailyMemosImportScope = "90d";
	private legacyImportRunning = false;
	private rebuildResultEl: HTMLElement | null = null;
	private monthlyRebuildResultEl: HTMLElement | null = null;
	private monthlyExcludeStatusEl: HTMLElement | null = null;
	private monthlyFileFormatStatusEl: HTMLElement | null = null;
	private rebuildRunning = false;
	private monthlyRebuildRunning = false;
	private monthlyFileFormatMigrationRunning = false;
	private timeBuoyToggleRunning = false;
	private readonly latestSettingNoticeValues = new Map<SettingNoticeKey, string>();
	private readonly delayedSettingNotices = new Map<SettingNoticeKey, DelayedSettingNotice>();
	private readonly pendingSettingDrafts = new Map<SettingNoticeKey, string>();

	constructor(
		app: App,
		plugin: Plugin,
		private readonly settingsService: SettingsService,
		private readonly syncOrchestrator: SyncOrchestrator,
		private readonly obsidianExcludeService: ObsidianExcludeService,
	) {
		super(app, plugin);
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				type: "group",
				heading: t("settings.title"),
				items: [
					{
						name: t("settings.dailyHeading.name"),
						desc: t("settings.dailyHeading.desc", { heading: DEFAULT_DAILY_HEADING }),
						render: (setting) => {
							const settings = this.settingsService.getSettings();
							setting.addText((text) => {
								text.setPlaceholder(DEFAULT_DAILY_HEADING);
								text.setValue(settings.dailyHeading);
								text.onChange((value) => {
									this.updateTextSettingDraft(
										"dailyHeading",
										value,
										(nextValue) => this.settingsService.validateDailyHeading(nextValue),
										t("settings.dailyHeading.invalid"),
									);
								});
								text.inputEl.addEventListener("blur", () => {
									void this.commitDailyHeadingDraft();
								});
							});
						},
					},
					{
						name: t("settings.insertPosition.name"),
						desc: t("settings.insertPosition.desc"),
						render: (setting) => {
							const settings = this.settingsService.getSettings();
							setting.addDropdown((dropdown) => {
								dropdown.addOption("bottom", t("settings.insertPosition.bottom"));
								dropdown.addOption("top", t("settings.insertPosition.top"));
								dropdown.setValue(settings.dailyInsertPosition);
								dropdown.onChange((value) => {
									void this.settingsService.updateSettings({
										dailyInsertPosition: value as DailyInsertPosition,
									});
								});
							});
						},
					},
					{
						name: t("settings.timeFormat.name"),
						desc: t("settings.timeFormat.desc"),
						render: (setting) => {
							const settings = this.settingsService.getSettings();
							setting.addDropdown((dropdown) => {
								dropdown.addOption("HH:mm:ss", "HH:mm:ss");
								dropdown.addOption("HH:mm", "HH:mm");
								dropdown.setValue(settings.memoTimeFormat);
								dropdown.onChange((value) => {
									void this.settingsService.updateSettings({
										memoTimeFormat: value as MemoTimeFormat,
									});
								});
							});
						},
					},
					{
						name: t("settings.timeBuoy.name"),
						desc: t("settings.timeBuoy.desc"),
						render: (setting) => {
							const settings = this.settingsService.getSettings();
							setting.addToggle((toggle) => {
								toggle.setValue(settings.timeBuoyEnabled);
								toggle.onChange((value) => {
									void this.toggleTimeBuoy(value, toggle);
								});
							});
						},
					},
					{
						name: t("settings.monthlyFolder.name"),
						desc: t("settings.monthlyFolder.desc"),
						render: (setting) => {
							const settings = this.settingsService.getSettings();
							let monthlyFolderDraft = settings.monthlyMemoFolder;
							setting
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
						},
					},
					{
						name: t("settings.excludeMonthly.name"),
						desc: t("settings.excludeMonthly.desc"),
						render: (setting, group) => {
							const settings = this.settingsService.getSettings();
							setting.addToggle((toggle) => {
								toggle.setValue(settings.excludeMonthlyMemosFromObsidian);
								toggle.onChange((value) => {
									void this.toggleMonthlyMemosExcludeRule(value, toggle);
								});
							});
							this.monthlyExcludeStatusEl = group.listEl.createDiv({ cls: "knomo-setting-help" });
						},
					},
					{
						name: t("settings.monthlyFileFormat.name"),
						desc: t("settings.monthlyFileFormat.desc", { format: DEFAULT_MONTHLY_MEMO_FILE_FORMAT }),
						render: (setting, group) => {
							const settings = this.settingsService.getSettings();
							setting.addText((text) => {
								text.setPlaceholder(DEFAULT_MONTHLY_MEMO_FILE_FORMAT);
								text.setValue(settings.monthlyMemoFileFormat);
								text.onChange((value) => {
									this.updateTextSettingDraft(
										"monthlyMemoFileFormat",
										value,
										(nextValue) => this.settingsService.validateMonthlyMemoFileFormat(nextValue),
										t("settings.monthlyFileFormat.invalid"),
									);
								});
								text.inputEl.addEventListener("blur", () => {
									void this.commitMonthlyMemoFileFormatDraft();
								});
							});
							this.monthlyFileFormatStatusEl = group.listEl.createDiv({ cls: "knomo-setting-help" });
							this.updateMonthlyFileFormatStatus();
						},
					},
					{
						name: t("settings.dateHeadingFormat.name"),
						desc: t("settings.dateHeadingFormat.desc", { format: DEFAULT_MONTHLY_DATE_HEADING_FORMAT }),
						render: (setting) => {
							const settings = this.settingsService.getSettings();
							setting.addText((text) => {
								text.setPlaceholder(DEFAULT_MONTHLY_DATE_HEADING_FORMAT);
								text.setValue(settings.monthlyDateHeadingFormat);
								text.onChange((value) => {
									this.updateTextSettingDraft(
										"monthlyDateHeadingFormat",
										value,
										(nextValue) => this.settingsService.validateMarkdownHeading(nextValue),
										t("settings.dateHeadingFormat.invalid"),
									);
								});
								text.inputEl.addEventListener("blur", () => {
									void this.commitMonthlyDateHeadingFormatDraft();
								});
							});
						},
					},
					{
						name: t("settings.dateOrder.name"),
						desc: t("settings.dateOrder.desc"),
						render: (setting) => {
							const settings = this.settingsService.getSettings();
							setting.addDropdown((dropdown) => {
								dropdown.addOption("asc", t("settings.dateOrder.asc"));
								dropdown.addOption("desc", t("settings.dateOrder.descOption"));
								dropdown.setValue(settings.monthlyDateOrder);
								dropdown.onChange((value) => {
									void this.settingsService.updateSettings({
										monthlyDateOrder: value as MonthlyDateOrder,
									});
								});
							});
						},
					},
				],
			},
			{
				type: "group",
				heading: t("settings.maintenance.heading"),
				items: [
					{
						name: t("settings.legacyImport.name"),
						desc: t("settings.legacyImport.desc"),
						render: (setting, group) => {
							setting
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
							this.legacyImportResultEl = group.listEl.createDiv({ cls: "knomo-scan-result" });
							this.legacyImportGroupsEl = group.listEl.createDiv({ cls: "knomo-legacy-import-groups" });
							this.renderLegacyImportPreview();
						},
					},
					{
						name: t("settings.rebuild.name"),
						desc: t("settings.rebuild.desc"),
						render: (setting, group) => {
							let rebuildScope: RebuildIndexScope = "30d";
							let rebuildMode: RebuildIndexMode = "index-only";
							setting
								.setClass("knomo-maintenance-setting")
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
							this.rebuildResultEl = group.listEl.createDiv({ cls: "knomo-scan-result" });
							void this.renderInitialRebuildResult();
						},
					},
					{
						name: t("settings.monthlyRebuild.name"),
						desc: t("settings.monthlyRebuild.desc"),
						render: (setting, group) => {
							const monthlyPeriods = this.syncOrchestrator.listMemoIndexPeriods();
							let monthlyRebuildPeriod = monthlyPeriods[0] ?? "";
							setting
								.setClass("knomo-maintenance-setting")
								.addDropdown((dropdown) => {
									for (const period of monthlyPeriods) {
										dropdown.addOption(period, period);
									}
									dropdown.setValue(monthlyRebuildPeriod);
									dropdown.onChange((value) => {
										monthlyRebuildPeriod = value;
									});
								})
								.addButton((button) => {
									button.setButtonText(t("settings.monthlyRebuild.start"));
									button.onClick(() => {
										void this.runMonthlyArchiveRebuild(monthlyRebuildPeriod, button);
									});
								});
							this.monthlyRebuildResultEl = group.listEl.createDiv({ cls: "knomo-scan-result" });
							this.renderMonthlyRebuildResult(t("settings.monthlyRebuild.before"));
							this.issueListEl = group.listEl.createDiv({ cls: "knomo-issue-list" });
							void this.renderIssueList();
						},
					},
				],
			},
		];
	}

	display(): void {
		const { containerEl } = this;
		this.cancelAllDelayedSettingNotices();
		this.pendingSettingDrafts.clear();
		containerEl.empty();

		const settings = this.settingsService.getSettings();

		new Setting(containerEl)
			.setName(t("settings.title"))
			.setHeading();

		new Setting(containerEl)
			.setName(t("settings.dailyHeading.name"))
			.setDesc(t("settings.dailyHeading.desc", { heading: DEFAULT_DAILY_HEADING }))
			.addText((text) => {
				text.setPlaceholder(DEFAULT_DAILY_HEADING);
				text.setValue(settings.dailyHeading);
				text.onChange((value) => {
					this.updateTextSettingDraft(
						"dailyHeading",
						value,
						(nextValue) => this.settingsService.validateDailyHeading(nextValue),
						t("settings.dailyHeading.invalid"),
					);
				});
				text.inputEl.addEventListener("blur", () => {
					void this.commitDailyHeadingDraft();
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
		new Setting(containerEl)
			.setName(t("settings.timeBuoy.name"))
			.setDesc(t("settings.timeBuoy.desc"))
			.addToggle((toggle) => {
				toggle.setValue(settings.timeBuoyEnabled);
				toggle.onChange((value) => {
					void this.toggleTimeBuoy(value, toggle);
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
					this.updateTextSettingDraft(
						"monthlyMemoFileFormat",
						value,
						(nextValue) => this.settingsService.validateMonthlyMemoFileFormat(nextValue),
						t("settings.monthlyFileFormat.invalid"),
					);
				});
				text.inputEl.addEventListener("blur", () => {
					void this.commitMonthlyMemoFileFormatDraft();
				});
			});
		this.monthlyFileFormatStatusEl = containerEl.createDiv({ cls: "knomo-setting-help" });
		this.updateMonthlyFileFormatStatus();
		new Setting(containerEl)
			.setName(t("settings.dateHeadingFormat.name"))
			.setDesc(t("settings.dateHeadingFormat.desc", { format: DEFAULT_MONTHLY_DATE_HEADING_FORMAT }))
			.addText((text) => {
				text.setPlaceholder(DEFAULT_MONTHLY_DATE_HEADING_FORMAT);
				text.setValue(settings.monthlyDateHeadingFormat);
				text.onChange((value) => {
					this.updateTextSettingDraft(
						"monthlyDateHeadingFormat",
						value,
						(nextValue) => this.settingsService.validateMarkdownHeading(nextValue),
						t("settings.dateHeadingFormat.invalid"),
					);
				});
				text.inputEl.addEventListener("blur", () => {
					void this.commitMonthlyDateHeadingFormatDraft();
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
			.setClass("knomo-maintenance-setting")
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
		void this.renderInitialRebuildResult();

		const monthlyPeriods = this.syncOrchestrator.listMemoIndexPeriods();
		let monthlyRebuildPeriod = monthlyPeriods[0] ?? "";
		new Setting(containerEl)
			.setClass("knomo-maintenance-setting")
			.setName(t("settings.monthlyRebuild.name"))
			.setDesc(t("settings.monthlyRebuild.desc"))
			.addDropdown((dropdown) => {
				for (const period of monthlyPeriods) {
					dropdown.addOption(period, period);
				}
				dropdown.setValue(monthlyRebuildPeriod);
				dropdown.onChange((value) => {
					monthlyRebuildPeriod = value;
				});
			})
			.addButton((button) => {
				button.setButtonText(t("settings.monthlyRebuild.start"));
				button.onClick(() => {
					void this.runMonthlyArchiveRebuild(monthlyRebuildPeriod, button);
				});
			});
		this.monthlyRebuildResultEl = containerEl.createDiv({ cls: "knomo-scan-result" });
		this.renderMonthlyRebuildResult(t("settings.monthlyRebuild.before"));
		this.issueListEl = containerEl.createDiv({ cls: "knomo-issue-list" });
		void this.renderIssueList();
	}

	hide(): void {
		void this.commitAllPendingSettingDrafts(false);
		super.hide();
		this.cancelAllDelayedSettingNotices();
	}

	private rememberSettingNoticeValue(key: SettingNoticeKey, value: string): void {
		this.latestSettingNoticeValues.set(key, value);
	}

	private isLatestSettingNoticeValue(key: SettingNoticeKey, value: string): boolean {
		return this.latestSettingNoticeValues.get(key) === value;
	}

	private scheduleDelayedSettingNotice(
		key: SettingNoticeKey,
		value: string,
		message: string,
		shouldShowNotice: () => boolean,
	): void {
		this.cancelDelayedSettingNotice(key);
		const timeoutId = this.containerEl.win.setTimeout(() => {
			const pendingNotice = this.delayedSettingNotices.get(key);
			if (pendingNotice === undefined || pendingNotice.timeoutId !== timeoutId || !this.isLatestSettingNoticeValue(key, value)) {
				return;
			}
			this.delayedSettingNotices.delete(key);
			if (shouldShowNotice()) {
				new Notice(message);
			}
		}, SETTING_NOTICE_DELAY_MS);
		this.delayedSettingNotices.set(key, { value, timeoutId });
	}

	private cancelDelayedSettingNotice(key: SettingNoticeKey): void {
		const pendingNotice = this.delayedSettingNotices.get(key);
		if (pendingNotice === undefined) {
			return;
		}
		this.containerEl.win.clearTimeout(pendingNotice.timeoutId);
		this.delayedSettingNotices.delete(key);
	}

	private cancelAllDelayedSettingNotices(): void {
		for (const key of this.delayedSettingNotices.keys()) {
			this.cancelDelayedSettingNotice(key);
		}
	}

	private updateTextSettingDraft(
		key: SettingNoticeKey,
		value: string,
		validate: (value: string) => boolean,
		invalidMessage: string,
	): void {
		const nextValue = value.trim();
		this.pendingSettingDrafts.set(key, value);
		this.rememberSettingNoticeValue(key, nextValue);
		if (!validate(nextValue)) {
			this.scheduleDelayedSettingNotice(
				key,
				nextValue,
				invalidMessage,
				() => !validate(nextValue),
			);
			return;
		}
		this.cancelDelayedSettingNotice(key);
	}

	private async commitAllPendingSettingDrafts(showChangedNotice: boolean): Promise<void> {
		const dailyHeading = this.pendingSettingDrafts.get("dailyHeading");
		const monthlyMemoFileFormat = this.pendingSettingDrafts.get("monthlyMemoFileFormat");
		const monthlyDateHeadingFormat = this.pendingSettingDrafts.get("monthlyDateHeadingFormat");
		if (dailyHeading !== undefined) {
			await this.commitDailyHeadingDraft(showChangedNotice, dailyHeading);
		}
		if (monthlyMemoFileFormat !== undefined) {
			await this.commitMonthlyMemoFileFormatDraft(monthlyMemoFileFormat);
		}
		if (monthlyDateHeadingFormat !== undefined) {
			await this.commitMonthlyDateHeadingFormatDraft(monthlyDateHeadingFormat);
		}
	}

	private async commitDailyHeadingDraft(showChangedNotice = true, draftValue?: string): Promise<void> {
		const value = draftValue ?? this.pendingSettingDrafts.get("dailyHeading");
		if (value === undefined) {
			return;
		}
		if (
			await this.saveDailyHeading(value, showChangedNotice)
			&& this.pendingSettingDrafts.get("dailyHeading") === value
		) {
			this.pendingSettingDrafts.delete("dailyHeading");
		}
	}

	private async commitMonthlyMemoFileFormatDraft(draftValue?: string): Promise<void> {
		const value = draftValue ?? this.pendingSettingDrafts.get("monthlyMemoFileFormat");
		if (value === undefined) {
			return;
		}
		if (
			await this.saveMonthlyMemoFileFormat(value)
			&& this.pendingSettingDrafts.get("monthlyMemoFileFormat") === value
		) {
			this.pendingSettingDrafts.delete("monthlyMemoFileFormat");
		}
	}

	private async commitMonthlyDateHeadingFormatDraft(draftValue?: string): Promise<void> {
		const value = draftValue ?? this.pendingSettingDrafts.get("monthlyDateHeadingFormat");
		if (value === undefined) {
			return;
		}
		if (
			await this.saveMonthlyDateHeadingFormat(value)
			&& this.pendingSettingDrafts.get("monthlyDateHeadingFormat") === value
		) {
			this.pendingSettingDrafts.delete("monthlyDateHeadingFormat");
		}
	}

	private async saveDailyHeading(value: string, showChangedNotice = true): Promise<boolean> {
		const key: SettingNoticeKey = "dailyHeading";
		const nextHeading = value.trim();
		this.rememberSettingNoticeValue(key, nextHeading);
		if (!this.settingsService.validateDailyHeading(nextHeading)) {
			this.scheduleDelayedSettingNotice(
				key,
				nextHeading,
				t("settings.dailyHeading.invalid"),
				() => !this.settingsService.validateDailyHeading(nextHeading),
			);
			return false;
		}
		this.cancelDelayedSettingNotice(key);
		if (nextHeading === this.settingsService.getSettings().dailyHeading) {
			return true;
		}
		await this.settingsService.updateSettings({ dailyHeading: nextHeading });
		if (!this.isLatestSettingNoticeValue(key, nextHeading)) {
			return true;
		}
		if (showChangedNotice) {
			this.scheduleDelayedSettingNotice(
				key,
				nextHeading,
				t("settings.dailyHeading.changed"),
				() => this.settingsService.getSettings().dailyHeading === nextHeading,
			);
		}
		return true;
	}

	private async saveMonthlyDateHeadingFormat(value: string): Promise<boolean> {
		const key: SettingNoticeKey = "monthlyDateHeadingFormat";
		const nextFormat = value.trim();
		this.rememberSettingNoticeValue(key, nextFormat);
		if (!this.settingsService.validateMarkdownHeading(nextFormat)) {
			this.scheduleDelayedSettingNotice(
				key,
				nextFormat,
				t("settings.dateHeadingFormat.invalid"),
				() => !this.settingsService.validateMarkdownHeading(nextFormat),
			);
			return false;
		}
		this.cancelDelayedSettingNotice(key);
		if (nextFormat === this.settingsService.getSettings().monthlyDateHeadingFormat) {
			return true;
		}
		await this.settingsService.updateSettings({ monthlyDateHeadingFormat: nextFormat });
		return true;
	}

	private async saveMonthlyMemoFileFormat(value: string): Promise<boolean> {
		const key: SettingNoticeKey = "monthlyMemoFileFormat";
		const nextFormat = value.trim();
		this.rememberSettingNoticeValue(key, nextFormat);
		if (!this.settingsService.validateMonthlyMemoFileFormat(nextFormat)) {
			this.scheduleDelayedSettingNotice(
				key,
				nextFormat,
				t("settings.monthlyFileFormat.invalid"),
				() => !this.settingsService.validateMonthlyMemoFileFormat(nextFormat),
			);
			return false;
		}
		this.cancelDelayedSettingNotice(key);
		if (nextFormat === this.settingsService.getSettings().monthlyMemoFileFormat) {
			return true;
		}
		if (this.monthlyFileFormatMigrationRunning) {
			return false;
		}
		this.monthlyFileFormatMigrationRunning = true;
		try {
			const plan = await this.settingsService.planMonthlyMemoFileFormatMigration(nextFormat);
			if (plan.conflicts.length > 0) {
				throw new Error(`Target path has conflicts; migration stopped: ${plan.conflicts.join("; ")}`);
			}
			const confirmed = await showKnomoConfirmModal(this.app, {
				message: t("settings.monthlyFileFormat.confirm", {
					current: plan.oldFormat,
					next: plan.newFormat,
					count: plan.periods.length,
				}),
			});
			if (!confirmed) {
				return false;
			}
			await this.syncOrchestrator.runMonthlyMemoFileFormatMigration(() => (
				this.settingsService.migrateMonthlyMemoFileFormat(nextFormat, (periods, trackGeneratedPath) => (
					this.syncOrchestrator.rebuildMonthlyArchivesForFileFormatMigration(periods, trackGeneratedPath)
				))
			));
			this.updateMonthlyFileFormatStatus();
			new Notice(t("settings.monthlyFileFormat.migrated", { count: plan.periods.length }));
			return true;
		} catch (error) {
			new Notice(formatServiceError(error, t("settings.monthlyFileFormat.migrationFailed")));
			return false;
		} finally {
			this.monthlyFileFormatMigrationRunning = false;
		}
	}

	private updateMonthlyFileFormatStatus(): void {
		if (this.monthlyFileFormatStatusEl === null) {
			return;
		}
		const currentFormat = this.settingsService.getSettings().monthlyMemoFileFormat;
		const isLegacyFormat = !this.settingsService.validateMonthlyMemoFileFormat(currentFormat);
		this.monthlyFileFormatStatusEl.setText(
			isLegacyFormat ? t("settings.monthlyFileFormat.legacyWarning") : "",
		);
		this.monthlyFileFormatStatusEl.toggleClass("is-error", isLegacyFormat);
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
				const confirmed = await showKnomoConfirmModal(this.app, {
					message: t("settings.monthlyFolder.confirm", {
						current: currentSettings.monthlyMemoFolder,
						next: monthlyMemoFolder,
						count: plan.monthlyFileMoves.length,
						systemAction: plan.moveSystemFolder ? t("settings.monthlyFolder.moveSystem") : t("settings.monthlyFolder.createSystem"),
						rewritten: plan.rewrittenMonthlyRefs,
					}),
				});
				if (!confirmed) {
					return;
				}
			}
			await this.syncOrchestrator.runMonthlyMemoFolderMigration(() => (
				this.settingsService.migrateMonthlyMemoFolder(monthlyMemoFolder)
			));
			new Notice(t("settings.monthlyFolder.saved"));
		} catch (error) {
			const message = formatServiceError(error, t("settings.monthlyFolder.saveFailed"));
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

	private async toggleTimeBuoy(enabled: boolean, toggle: ToggleComponent): Promise<void> {
		if (this.timeBuoyToggleRunning) {
			return;
		}
		this.timeBuoyToggleRunning = true;
		toggle.setDisabled(true);
		try {
			await this.settingsService.updateSettings({ timeBuoyEnabled: enabled, timeBuoyIntroDismissed: true });
			await this.refreshOpenKnomoViews();
			if (!enabled) {
				new Notice(t("settings.timeBuoy.disabled"));
				return;
			}
			new Notice(t("settings.timeBuoy.building"));
			const result = await this.syncOrchestrator.rebuildTimeBuoyIndex({
				yieldToUi: () => new Promise<void>((resolve) => {
					this.containerEl.win.setTimeout(resolve, 0);
				}),
			});
			if (result.status === "completed") {
				new Notice(t("settings.timeBuoy.buildComplete", {
					total: result.total,
					indexed: result.indexed,
					skipped: result.skipped,
				}));
			} else {
				new Notice(t("settings.timeBuoy.enabled"));
			}
			await this.refreshOpenKnomoViews();
		} catch (error) {
			new Notice(formatServiceError(error, t("settings.timeBuoy.buildFailed")));
			await this.refreshOpenKnomoViews();
		} finally {
			this.timeBuoyToggleRunning = false;
			toggle.setDisabled(false);
			toggle.setValue(this.settingsService.getSettings().timeBuoyEnabled);
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
			const message = formatServiceError(error, t("settings.legacyImport.previewFailed"));
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
			const message = formatServiceError(error, t("settings.legacyImport.failed"));
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
			const confirmed = await showKnomoConfirmModal(this.app, {
				message: t("settings.rebuild.confirm", {
					scanned: estimate.scannedFiles,
					created: estimate.estimatedNew,
					updated: estimate.estimatedUpdated,
					missing: estimate.estimatedMissing,
					monthlyMode: monthlyModeText,
				}),
			});
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
			const resultLines = [message, backup];
			if (result.duplicateIndexRecordsRemoved > 0) {
				resultLines.push(t("settings.rebuild.cleanedDuplicateIndexRecords", { count: result.duplicateIndexRecordsRemoved }));
			}
			if (result.syncConflictIndexFilesDeleted > 0) {
				resultLines.push(t("settings.rebuild.cleanedIndexConflicts", { count: result.syncConflictIndexFilesDeleted }));
			}
			if (result.syncConflictIndexFileDeleteFailed > 0) {
				resultLines.push(t("settings.rebuild.indexConflictCleanupFailed", {
					count: result.syncConflictIndexFileDeleteFailed,
					path: result.firstFailedSyncConflictIndexPath ?? "",
				}));
			}
			const remainingMonthlyConflicts = this.syncOrchestrator.listPotentialSyncConflictFiles()
				.filter((conflict) => conflict.kind === "monthly-archive");
			const firstMonthlyConflict = remainingMonthlyConflicts[0];
			if (firstMonthlyConflict !== undefined) {
				resultLines.push(t("settings.rebuild.monthlyConflictsRemain", {
					count: remainingMonthlyConflicts.length,
					path: firstMonthlyConflict.path,
				}));
			}
			await this.saveMaintenanceDiagnosticSafely({
				task: "repair",
				status: "completed",
				occurredAt: new Date().toISOString(),
				scope,
				mode,
				message,
				scannedFiles: result.scannedFiles,
				created: result.created,
				updated: result.updated,
				deleted: result.deleted,
				failed: result.failed,
			});
			this.renderRebuildResult(resultLines.join("\n"));
			await this.renderIssueList();
			await this.refreshOpenKnomoViews();
			new Notice(t("settings.rebuild.completedNotice"));
		} catch (error) {
			const message = formatServiceError(error, t("settings.rebuild.failed"));
			await this.saveMaintenanceDiagnosticSafely({
				task: "repair",
				status: "failed",
				occurredAt: new Date().toISOString(),
				scope,
				mode,
				message,
				scannedFiles: null,
				created: null,
				updated: null,
				deleted: null,
				failed: null,
			});
			this.renderRebuildResult(message);
			new Notice(message);
		} finally {
			this.rebuildRunning = false;
			button.setDisabled(false);
			button.setButtonText(t("settings.rebuild.start"));
		}
	}

	private async runMonthlyArchiveRebuild(
		period: string,
		button: { setButtonText(text: string): void; setDisabled(disabled: boolean): void },
	): Promise<void> {
		if (this.monthlyRebuildRunning || period.length === 0) {
			return;
		}
		const confirmed = await showKnomoConfirmModal(this.app, {
			message: t("settings.monthlyRebuild.confirm", { period }),
		});
		if (!confirmed) {
			this.renderMonthlyRebuildResult(t("settings.monthlyRebuild.cancelled"));
			return;
		}

		this.monthlyRebuildRunning = true;
		button.setDisabled(true);
		button.setButtonText(t("settings.monthlyRebuild.running"));
		this.renderMonthlyRebuildResult(t("settings.monthlyRebuild.status", { period }));
		try {
			const result = await this.syncOrchestrator.rebuildMonthlyArchive(period);
			const backup = result.backupPath === null
				? t("settings.monthlyRebuild.noBackup")
				: t("settings.rebuild.backup", { path: result.backupPath });
			this.renderMonthlyRebuildResult(`${t("settings.monthlyRebuild.complete", {
				period: result.period,
				rebuilt: result.rebuilt,
				issues: result.issues,
			})}\n${backup}`);
			await this.renderIssueList();
			await this.refreshOpenKnomoViews();
			new Notice(t("settings.monthlyRebuild.completedNotice", { period: result.period }));
		} catch (error) {
			const message = formatServiceError(error, t("settings.monthlyRebuild.failed"));
			this.renderMonthlyRebuildResult(message);
			new Notice(message);
		} finally {
			this.monthlyRebuildRunning = false;
			button.setDisabled(false);
			button.setButtonText(t("settings.monthlyRebuild.start"));
		}
	}

	private renderRebuildResult(message: string): void {
		if (this.rebuildResultEl === null) {
			return;
		}
		this.rebuildResultEl.empty();
		this.rebuildResultEl.createDiv({ cls: "knomo-setting-help", text: message });
	}

	private async saveMaintenanceDiagnosticSafely(diagnostic: MaintenanceDiagnostic): Promise<void> {
		try {
			await this.settingsService.saveMaintenanceDiagnostic(diagnostic);
		} catch {
			// 维护诊断写入失败不应覆盖用户正在执行的维护结果。
		}
	}

	private async renderInitialRebuildResult(): Promise<void> {
		let message = this.getRebuildBeforeMessage();
		try {
			const diagnostic = await this.settingsService.loadMaintenanceDiagnostic();
			if (diagnostic !== null) {
				message = `${message}\n${this.formatMaintenanceDiagnostic(diagnostic)}`;
			}
		} catch {
			// 诊断只辅助维护说明，读取失败时保留基础提示。
		}
		this.renderRebuildResult(message);
	}

	private getRebuildBeforeMessage(): string {
		const conflicts = this.syncOrchestrator.listPotentialSyncConflictFiles();
		if (conflicts.length === 0) {
			return t("settings.rebuild.before");
		}
		return `${t("settings.rebuild.before")}\n${this.formatSyncConflictMessage(conflicts)}`;
	}

	private formatSyncConflictMessage(conflicts: readonly SyncConflictFile[]): string {
		const firstConflict = conflicts[0];
		if (firstConflict === undefined) {
			return "";
		}
		const indexCount = conflicts.filter((conflict) => conflict.kind === "memo-index").length;
		const monthlyCount = conflicts.length - indexCount;
		const messageKey = indexCount > 0 && monthlyCount > 0
			? "settings.rebuild.conflictMixedFiles"
			: indexCount > 0
				? "settings.rebuild.conflictIndexFiles"
				: "settings.rebuild.conflictMonthlyFiles";
		return t(messageKey, {
			count: conflicts.length,
			indexCount,
			monthlyCount,
			path: firstConflict.path,
		});
	}

	private formatMaintenanceDiagnostic(diagnostic: MaintenanceDiagnostic): string {
		const task = diagnostic.task === "startup_scan"
			? t("settings.maintenanceDiagnostic.startupScan")
			: diagnostic.task === "file_watch"
				? t("settings.maintenanceDiagnostic.fileWatch")
				: t("settings.maintenanceDiagnostic.repair");
		const status = diagnostic.status === "completed"
			? t("settings.maintenanceDiagnostic.completed")
			: t("settings.maintenanceDiagnostic.failed");
		const scope = diagnostic.scope === null ? "" : t("settings.maintenanceDiagnostic.scope", { scope: diagnostic.scope });
		const mode = diagnostic.mode === null ? "" : t("settings.maintenanceDiagnostic.mode", { mode: diagnostic.mode });
		const stats = diagnostic.scannedFiles === null
			? ""
			: t("settings.maintenanceDiagnostic.stats", {
				scanned: diagnostic.scannedFiles,
				created: diagnostic.created ?? 0,
				updated: diagnostic.updated ?? 0,
				deleted: diagnostic.deleted ?? 0,
				failed: diagnostic.failed ?? 0,
			});
		return t("settings.maintenanceDiagnostic.latest", {
			task,
			status,
			time: diagnostic.occurredAt,
			scope,
			mode,
			stats,
			message: diagnostic.message,
		});
	}

	private renderMonthlyRebuildResult(message: string): void {
		if (this.monthlyRebuildResultEl === null) {
			return;
		}
		this.monthlyRebuildResultEl.empty();
		this.monthlyRebuildResultEl.createDiv({ cls: "knomo-setting-help", text: message });
	}

	private async refreshOpenKnomoViews(): Promise<void> {
		const refreshes = this.app.workspace.getLeavesOfType(KNOMO_VIEW_TYPE).map(async (leaf) => {
			if (leaf.view instanceof KnomoView) {
				await leaf.view.refresh(true);
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
				text: formatServiceError(error, t("settings.issues.loadFailed")),
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
			text: memo.issue === null ? t("settings.issues.needsHandling") : formatMemoIssue(memo.issue),
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
		} else if (
			memo.syncStatus === "monthly_failed"
			|| memo.issue?.type === "monthly_block_missing"
			|| memo.issue?.type === "monthly_block_ambiguous"
			|| memo.issue?.type === "monthly_sync_failed"
		) {
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
			new Notice(formatServiceError(error, t("settings.issues.monthlyDeleteFailed")));
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
			new Notice(formatServiceError(error, t("settings.issues.monthlySyncFailed")));
		} finally {
			button.disabled = false;
			button.setText(t("settings.issues.retryMonthlySync"));
		}
	}
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

function formatLegacyImportSample(content: string): string {
	const normalizedContent = content.replace(/\s+/g, " ").trim();
	if (normalizedContent.length <= 80) {
		return normalizedContent;
	}
	return `${normalizedContent.slice(0, 77)}...`;
}

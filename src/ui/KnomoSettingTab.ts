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
import type { CatalogV2FeatureService } from "../services/CatalogV2FeatureService";
import type { CatalogV2ReadService } from "../services/CatalogV2ReadService";
import type { CatalogV2MonthlyProjectionCoordinator } from "../services/CatalogV2MonthlyProjectionCoordinator";
import type { CatalogV2PendingMutationInspectionItem } from "../types/catalogV2Runtime";
import type { DailyInsertPosition, MemoTimeFormat, MonthlyDateOrder } from "../types/settings";
import { normalizeVaultPath } from "../utils/path";
import { formatDatePart } from "../utils/date";
import { formatServiceError, formatSettingsText } from "../utils/serviceText";
import { showKnomoConfirmModal } from "./KnomoConfirmModal";
import { KnomoView } from "./KnomoView";

const SETTING_NOTICE_DELAY_MS = 800;
type RebuildIndexMode = "index-only" | "index-and-monthly";
type RebuildIndexScope = "30d" | "90d" | "all";

type SettingNoticeKey = "dailyHeading" | "monthlyMemoFileFormat" | "monthlyDateHeadingFormat";

interface DelayedSettingNotice {
	value: string;
	timeoutId: number;
}

export class KnomoSettingTab extends PluginSettingTab {
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
		private readonly obsidianExcludeService: ObsidianExcludeService,
		private readonly catalogV2FeatureService: CatalogV2FeatureService,
		private readonly catalogV2ReadService: CatalogV2ReadService,
		private readonly catalogV2MonthlyProjectionCoordinator: CatalogV2MonthlyProjectionCoordinator,
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
						render: (setting) => {
							const settings = this.settingsService.getSettings();
							const statusEl = setting.infoEl.createDiv({ cls: "knomo-setting-help" });
							setting.addToggle((toggle) => {
								toggle.setValue(settings.excludeMonthlyMemosFromObsidian);
								toggle.onChange((value) => {
									void this.toggleMonthlyMemosExcludeRule(value, toggle, statusEl);
								});
							});
						},
					},
					{
						name: t("settings.monthlyFileFormat.name"),
						desc: t("settings.monthlyFileFormat.desc", { format: DEFAULT_MONTHLY_MEMO_FILE_FORMAT }),
						render: (setting) => {
							const settings = this.settingsService.getSettings();
							const statusEl = setting.infoEl.createDiv({ cls: "knomo-setting-help" });
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
									void this.commitMonthlyMemoFileFormatDraft(undefined, statusEl);
								});
							});
							this.updateMonthlyFileFormatStatus(statusEl);
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
						name: t("settings.localHistory.name"),
						desc: t("settings.localHistory.desc"),
						render: (setting: Setting) => {
							const resultEl = setting.infoEl.createDiv({ cls: "knomo-scan-result" });
							setting.setClass("knomo-maintenance-setting").addButton((button) => {
								button.setButtonText(t("settings.rebuild.start"));
								button.onClick(() => {
									void this.runRebuildIndex("all", "index-only", button, resultEl);
								});
							});
							void this.renderInitialRebuildResult(resultEl);
						},
					},
					{
						name: t("settings.pendingRecovery.name"),
						desc: t("settings.pendingRecovery.desc"),
						render: (setting: Setting) => {
							this.renderPendingMutationRecovery(setting);
						},
					},
					{
						name: t("settings.monthlyRebuild.name"),
						desc: t("settings.monthlyRebuild.desc"),
						render: (setting: Setting) => {
							this.renderCatalogV2MonthlyRebuildSetting(setting);
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
					void this.toggleMonthlyMemosExcludeRule(value, toggle, monthlyExcludeStatusEl);
				});
			});
		const monthlyExcludeStatusEl = containerEl.createDiv({ cls: "knomo-setting-help" });
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
					void this.commitMonthlyMemoFileFormatDraft(undefined, monthlyFileFormatStatusEl);
				});
			});
		const monthlyFileFormatStatusEl = containerEl.createDiv({ cls: "knomo-setting-help" });
		this.updateMonthlyFileFormatStatus(monthlyFileFormatStatusEl);
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
			.setClass("knomo-maintenance-setting")
			.setName(t("settings.localHistory.name"))
			.setDesc(t("settings.localHistory.desc"))
			.addButton((button) => {
				button.setButtonText(t("settings.rebuild.start"));
				button.onClick(() => {
					void this.runRebuildIndex("all", "index-only", button, catalogRebuildResultEl);
				});
			});
		const catalogRebuildResultEl = containerEl.createDiv({ cls: "knomo-scan-result" });
		void this.renderInitialRebuildResult(catalogRebuildResultEl);
		const pendingRecoverySetting = new Setting(containerEl)
			.setClass("knomo-maintenance-setting")
			.setName(t("settings.pendingRecovery.name"))
			.setDesc(t("settings.pendingRecovery.desc"));
		this.renderPendingMutationRecovery(pendingRecoverySetting);
		const monthlySetting = new Setting(containerEl).setName(t("settings.monthlyRebuild.name"));
		this.renderCatalogV2MonthlyRebuildSetting(monthlySetting);
	}

	hide(): void {
		void this.commitAllPendingSettingDrafts(false);
		super.hide();
		this.cancelAllDelayedSettingNotices();
	}

	private renderPendingMutationRecovery(setting: Setting): void {
		const statusEl = setting.infoEl.createDiv({ cls: "knomo-scan-result" });
		statusEl.setAttr("role", "status");
		statusEl.setAttr("aria-live", "polite");
		statusEl.setAttr("aria-atomic", "true");
		statusEl.setAttr("tabindex", "-1");
		void this.refreshPendingMutationRecovery(statusEl);
	}

	private renderCatalogV2MonthlyRebuildSetting(setting: Setting): void {
		let monthlyRebuildPeriod = formatDatePart(new Date()).slice(0, 7);
		const resultEl = setting.infoEl.createDiv({ cls: "knomo-scan-result" });
		setting
			.setClass("knomo-maintenance-setting")
			.setName(t("settings.monthlyRebuild.name"))
			.setDesc(t("settings.monthlyRebuild.desc"))
			.addDropdown((dropdown) => {
				dropdown.addOption(monthlyRebuildPeriod, monthlyRebuildPeriod);
				dropdown.setValue(monthlyRebuildPeriod);
				dropdown.onChange((value) => { monthlyRebuildPeriod = value; });
				void this.catalogV2MonthlyProjectionCoordinator.listPeriods().then((periods) => {
					for (const period of periods) {
						if (period !== monthlyRebuildPeriod) dropdown.addOption(period, period);
					}
					const firstPeriod = periods[0];
					if (firstPeriod !== undefined) {
						monthlyRebuildPeriod = firstPeriod;
						dropdown.setValue(firstPeriod);
					}
				}).catch(() => undefined);
			})
			.addButton((button) => {
				button.setButtonText(t("settings.monthlyRebuild.start"));
				button.onClick(() => {
					void this.runMonthlyArchiveRebuild(monthlyRebuildPeriod, button, resultEl);
				});
			});
		this.renderMonthlyRebuildResult(t("settings.monthlyRebuild.before"), resultEl);
	}

	private async refreshPendingMutationRecovery(statusEl: HTMLElement, focus = false): Promise<void> {
		statusEl.empty();
		statusEl.setText(t("settings.pendingRecovery.loading"));
		try {
			const inspection = await this.catalogV2FeatureService.inspectPendingMutations();
			const items = inspection.items.filter((item) => item.status !== "abandoned");
			statusEl.empty();
			if (items.length === 0) {
				statusEl.setText(t("settings.pendingRecovery.none"));
			} else {
				for (const item of items) this.renderPendingMutationItem(statusEl, item);
			}
		} catch {
			statusEl.setText(t("settings.pendingRecovery.loadFailed"));
		}
		if (focus) statusEl.focus({ preventScroll: true });
	}

	private renderPendingMutationItem(
		statusEl: HTMLElement,
		item: CatalogV2PendingMutationInspectionItem,
	): void {
		const itemEl = statusEl.createDiv({ cls: "knomo-pending-recovery-item" });
		itemEl.createDiv({
			cls: "knomo-setting-help",
			text: t("settings.pendingRecovery.item", {
				paths: item.paths.join(", ") || t("settings.pendingRecovery.unknownPath"),
				status: this.getPendingMutationStatusText(item),
			}),
		});
		const actionsEl = itemEl.createDiv({ cls: "knomo-pending-recovery-actions" });
		const canContinue = item.status === "prepared" || item.status === "daily_after"
			|| item.status === "committed_unbound" || item.reasons.includes("daily_partial");
		if (canContinue) {
			const continueButton = actionsEl.createEl("button", {
				text: t("settings.pendingRecovery.continue"),
				attr: {
					type: "button",
					"aria-label": t("settings.pendingRecovery.continueLabel", {
						paths: item.paths.join(", ") || t("settings.pendingRecovery.unknownPath"),
					}),
				},
			});
			continueButton.addEventListener("click", () => {
				void this.runPendingMutationRecovery(item, "continue", continueButton, statusEl);
			});
		}
		if (item.status === "prepared") {
			const abandonButton = actionsEl.createEl("button", {
				text: t("settings.pendingRecovery.abandon"),
				attr: {
					type: "button",
					"aria-label": t("settings.pendingRecovery.abandonLabel", {
						paths: item.paths.join(", ") || t("settings.pendingRecovery.unknownPath"),
					}),
				},
			});
			abandonButton.addEventListener("click", () => {
				void this.runPendingMutationRecovery(item, "abandon", abandonButton, statusEl);
			});
		}
	}

	private getPendingMutationStatusText(item: CatalogV2PendingMutationInspectionItem): string {
		if (item.reasons.includes("daily_partial")) return t("settings.pendingRecovery.partial");
		switch (item.status) {
			case "prepared": return t("settings.pendingRecovery.prepared");
			case "daily_after": return t("settings.pendingRecovery.dailyAfter");
			case "committed_unbound": return t("settings.pendingRecovery.committedUnbound");
			case "abandoned": return t("settings.pendingRecovery.abandonedStatus");
			case "attention": return t("settings.pendingRecovery.attention");
		}
	}

	private async runPendingMutationRecovery(
		item: CatalogV2PendingMutationInspectionItem,
		action: "continue" | "abandon",
		button: HTMLButtonElement,
		statusEl: HTMLElement,
	): Promise<void> {
		const confirmed = await showKnomoConfirmModal(this.app, {
			message: action === "continue"
				? t("settings.pendingRecovery.continueConfirm")
				: t("settings.pendingRecovery.abandonConfirm"),
			confirmLabel: action === "continue"
				? t("settings.pendingRecovery.continue")
				: t("settings.pendingRecovery.abandon"),
			danger: action === "abandon",
		});
		if (!confirmed) return;
		button.disabled = true;
		statusEl.setAttr("aria-busy", "true");
		try {
			const completed = await this.catalogV2FeatureService?.recoverPendingMutation(item.mutationId, action) ?? false;
			new Notice(completed
				? action === "continue" ? t("settings.pendingRecovery.completed") : t("settings.pendingRecovery.abandoned")
				: t("settings.pendingRecovery.failed"));
		} catch {
			new Notice(t("settings.pendingRecovery.failed"));
		} finally {
			statusEl.removeAttribute("aria-busy");
			await this.refreshPendingMutationRecovery(statusEl, true);
		}
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

	private async commitMonthlyMemoFileFormatDraft(draftValue?: string, statusEl?: HTMLElement): Promise<void> {
		const value = draftValue ?? this.pendingSettingDrafts.get("monthlyMemoFileFormat");
		if (value === undefined) {
			return;
		}
		if (
			await this.saveMonthlyMemoFileFormat(value, statusEl)
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
		await this.catalogV2FeatureService?.rebuildLocalCatalog();
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

	private async saveMonthlyMemoFileFormat(value: string, statusEl?: HTMLElement): Promise<boolean> {
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
			const sourcePeriods = await this.catalogV2MonthlyProjectionCoordinator.listPeriods();
			const plan = await this.settingsService.planMonthlyMemoFileFormatMigration(nextFormat, sourcePeriods);
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
			await this.settingsService.updateSettings({ monthlyMemoFileFormat: nextFormat });
			for (const period of plan.periods) {
				await this.catalogV2MonthlyProjectionCoordinator.rebuildPeriod(period);
			}
			if (statusEl !== undefined) {
				this.updateMonthlyFileFormatStatus(statusEl);
			}
			new Notice(t("settings.monthlyFileFormat.migrated", { count: plan.periods.length }));
			return true;
		} catch (error) {
			new Notice(formatServiceError(error, t("settings.monthlyFileFormat.migrationFailed")));
			return false;
		} finally {
			this.monthlyFileFormatMigrationRunning = false;
		}
	}

	private updateMonthlyFileFormatStatus(statusEl: HTMLElement): void {
		const currentFormat = this.settingsService.getSettings().monthlyMemoFileFormat;
		const isLegacyFormat = !this.settingsService.validateMonthlyMemoFileFormat(currentFormat);
		statusEl.setText(
			isLegacyFormat ? t("settings.monthlyFileFormat.legacyWarning") : "",
		);
		statusEl.toggleClass("is-error", isLegacyFormat);
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
					}),
				});
				if (!confirmed) {
					return;
				}
			}
			await this.settingsService.migrateMonthlyMemoFolder(monthlyMemoFolder);
			if (monthlyMemoFolder !== currentSettings.monthlyMemoFolder) {
				for (const period of await this.catalogV2MonthlyProjectionCoordinator.listPeriods()) {
					await this.catalogV2MonthlyProjectionCoordinator.rebuildPeriod(period);
				}
			}
			new Notice(t("settings.monthlyFolder.saved"));
		} catch (error) {
			const message = formatServiceError(error, t("settings.monthlyFolder.saveFailed"));
			new Notice(message);
		} finally {
			button.setDisabled(false);
			button.setButtonText(t("settings.monthlyFolder.save"));
		}
	}

	private async toggleMonthlyMemosExcludeRule(enabled: boolean, toggle: ToggleComponent, statusEl: HTMLElement): Promise<void> {
		toggle.setDisabled(true);
		try {
			if (enabled) {
				await this.enableMonthlyMemosExcludeRule(statusEl);
			} else {
				await this.disableMonthlyMemosExcludeRule(statusEl);
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
			await this.catalogV2ReadService.queryTimeBuoysForDate(formatDatePart(new Date()));
			new Notice(t("settings.timeBuoy.enabled"));
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

	private setExcludeStatus(statusEl: HTMLElement, text: string, isError = false): void {
		statusEl.setText(text);
		statusEl.toggleClass("is-error", isError);
	}

	private async enableMonthlyMemosExcludeRule(statusEl: HTMLElement): Promise<void> {
		const settings = this.settingsService.getSettings();
		const rule = buildMonthlyFolderExcludeRule(settings.monthlyMemoFolder);
		if (rule === null) {
			await this.settingsService.updateSettings({
				excludeMonthlyMemosFromObsidian: false,
				managedObsidianExcludeRule: undefined,
				managedObsidianExcludeRuleOwned: false,
			});
			this.setExcludeStatus(statusEl, t("settings.excludeMonthly.empty"), true);
			return;
		}
		try {
			const result = await this.obsidianExcludeService.ensureRule(rule);
			await this.settingsService.updateSettings({
				excludeMonthlyMemosFromObsidian: true,
				managedObsidianExcludeRule: rule,
				managedObsidianExcludeRuleOwned: result.addedByKnomo,
			});
			this.setExcludeStatus(statusEl, result.addedByKnomo
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

	private async disableMonthlyMemosExcludeRule(statusEl: HTMLElement): Promise<void> {
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
		this.setExcludeStatus(statusEl, removedRule
			? t("settings.excludeMonthly.removed")
			: t("settings.excludeMonthly.keepExisting"));
	}

	private async runRebuildIndex(
		scope: RebuildIndexScope,
		mode: RebuildIndexMode,
		button: { setButtonText(text: string): void; setDisabled(disabled: boolean): void },
		resultEl: HTMLElement,
	): Promise<void> {
		if (this.rebuildRunning) {
			return;
		}
		this.rebuildRunning = true;
		button.setDisabled(true);
		button.setButtonText(t("settings.rebuild.checking"));
		try {
			const confirmed = await showKnomoConfirmModal(this.app, {
				message: t("settings.rebuild.catalogConfirm"),
			});
			if (!confirmed) {
				this.renderRebuildResult(t("settings.rebuild.cancelled"), resultEl);
				return;
			}
			button.setButtonText(t("settings.rebuild.running"));
			this.renderRebuildResult(t("settings.rebuild.catalogStatus"), resultEl);
			await this.catalogV2FeatureService.rebuildLocalCatalog();
			this.renderRebuildResult(t("settings.rebuild.catalogComplete"), resultEl);
			await this.refreshOpenKnomoViews();
			new Notice(t("settings.rebuild.completedNotice"));
		} catch (error) {
			const message = formatServiceError(error, t("settings.rebuild.failed"));
			this.renderRebuildResult(message, resultEl);
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
		resultEl: HTMLElement,
	): Promise<void> {
		if (this.monthlyRebuildRunning || period.length === 0) {
			return;
		}
		const confirmed = await showKnomoConfirmModal(this.app, {
			message: t("settings.monthlyRebuild.confirm", { period }),
		});
		if (!confirmed) {
			this.renderMonthlyRebuildResult(t("settings.monthlyRebuild.cancelled"), resultEl);
			return;
		}

		this.monthlyRebuildRunning = true;
		button.setDisabled(true);
		button.setButtonText(t("settings.monthlyRebuild.running"));
		this.renderMonthlyRebuildResult(t("settings.monthlyRebuild.status", { period }), resultEl);
		try {
			const projection = await this.catalogV2MonthlyProjectionCoordinator.rebuildPeriod(period);
			if (projection.failed > 0) throw new Error(t("settings.monthlyRebuild.failed"));
			this.renderMonthlyRebuildResult(t("settings.monthlyRebuild.complete", {
				period,
				rebuilt: projection.projected,
				issues: 0,
			}), resultEl);
			await this.refreshOpenKnomoViews();
			new Notice(t("settings.monthlyRebuild.completedNotice", { period }));
		} catch (error) {
			const message = formatServiceError(error, t("settings.monthlyRebuild.failed"));
			this.renderMonthlyRebuildResult(message, resultEl);
			new Notice(message);
		} finally {
			this.monthlyRebuildRunning = false;
			button.setDisabled(false);
			button.setButtonText(t("settings.monthlyRebuild.start"));
		}
	}

	private renderRebuildResult(message: string, resultEl: HTMLElement): void {
		resultEl.empty();
		resultEl.createDiv({ cls: "knomo-setting-help", text: message });
	}

	private async renderInitialRebuildResult(resultEl: HTMLElement): Promise<void> {
		this.renderRebuildResult(t("settings.rebuild.before"), resultEl);
	}

	private renderMonthlyRebuildResult(message: string, resultEl: HTMLElement): void {
		resultEl.empty();
		resultEl.createDiv({ cls: "knomo-setting-help", text: message });
	}

	private async refreshOpenKnomoViews(): Promise<void> {
		const refreshes = this.app.workspace.getLeavesOfType(KNOMO_VIEW_TYPE).map(async (leaf) => {
			if (leaf.view instanceof KnomoView) {
				await leaf.view.refresh(true);
			}
		});
		await Promise.all(refreshes);
	}

}

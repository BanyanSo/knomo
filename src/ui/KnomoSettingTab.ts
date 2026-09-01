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
import type { KnomoDataRootMigrationService } from "../services/KnomoDataRootMigrationService";
import type { KnomoSharedConfigService } from "../services/KnomoSharedConfigService";
import type {
	KnomoStartupBootstrapService,
} from "../services/KnomoStartupBootstrapService";
import type { CatalogReadService } from "../services/CatalogReadService";
import type { MemoCommandService } from "../services/MemoCommandService";
import type { MonthlyProjectionCoordinator } from "../services/MonthlyProjectionCoordinator";
import type { LegacyIndexMigrationService } from "../services/LegacyIndexMigrationService";
import type { LegacyMigrationAcknowledgementService } from "../services/LegacyMigrationAcknowledgementService";
import type { DailyInsertPosition, MemoTimeFormat, MonthlyDateOrder } from "../types/settings";
import { formatDatePart } from "../utils/date";
import { normalizeVaultPath } from "../utils/path";
import { formatServiceError } from "../utils/serviceText";
import { showKnomoConfirmModal } from "./KnomoConfirmModal";
import { KnomoFolderSuggest } from "./KnomoFolderSuggest";
import { getKnomoSettingAttentionKinds } from "./KnomoSettingAttention";
import type { KnomoSettingAttentionKind } from "./KnomoSettingAttention";
import { KnomoView } from "./KnomoView";

const SETTING_NOTICE_DELAY_MS = 800;

type SettingNoticeKey = "dailyHeading" | "monthlyMemoFileFormat" | "monthlyDateHeadingFormat";

interface DelayedSettingNotice {
	value: string;
	timeoutId: number;
}

export class KnomoSettingTab extends PluginSettingTab {
	private rebuildRunning = false;
	private monthlyRetryRunning = false;
	private monthlyFileFormatMigrationRunning = false;
	private timeBuoyToggleRunning = false;
	private dataRootEditing = false;
	private dataRootDraft: string | null = null;
	private settingsVisible = false;
	private readonly latestSettingNoticeValues = new Map<SettingNoticeKey, string>();
	private readonly delayedSettingNotices = new Map<SettingNoticeKey, DelayedSettingNotice>();
	private readonly pendingSettingDrafts = new Map<SettingNoticeKey, string>();

	constructor(
		app: App,
		plugin: Plugin,
		private readonly settingsService: SettingsService,
		private readonly obsidianExcludeService: ObsidianExcludeService,
		private readonly memoCommandService: MemoCommandService,
		private readonly catalogReadService: CatalogReadService,
		private readonly monthlyProjectionCoordinator: MonthlyProjectionCoordinator,
		private readonly knomoDataRootMigrationService: KnomoDataRootMigrationService,
		private readonly knomoSharedConfigService: KnomoSharedConfigService,
		private readonly legacyIndexMigrationService: LegacyIndexMigrationService,
		private readonly legacyMigrationAcknowledgementService: LegacyMigrationAcknowledgementService,
		private readonly startupBootstrapService: KnomoStartupBootstrapService | null,
		private readonly retryRuntimeState: (forceIdentityReload?: boolean) => Promise<void>,
	) {
		super(app, plugin);
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		const attentionItems = this.getAttentionKinds().map((kind) => ({
			name: this.getAttentionName(kind),
			desc: this.getAttentionDescription(kind),
			render: (setting: Setting) => { this.renderAttentionSetting(kind, setting); },
		}));
		return [
			{
				type: "group",
				heading: t("settings.attention.heading"),
				visible: attentionItems.length > 0,
				items: attentionItems,
			},
			{
				type: "group",
				heading: t("settings.capture.heading"),
				items: [
					{
						name: t("settings.dailyHeading.name"),
						desc: t("settings.dailyHeading.desc", { heading: DEFAULT_DAILY_HEADING }),
						render: (setting: Setting) => { this.renderDailyHeadingSetting(setting); },
					},
					{
						name: t("settings.insertPosition.name"),
						desc: t("settings.insertPosition.desc"),
						render: (setting: Setting) => { this.renderInsertPositionSetting(setting); },
					},
					{
						name: t("settings.timeFormat.name"),
						desc: t("settings.timeFormat.desc"),
						render: (setting: Setting) => { this.renderTimeFormatSetting(setting); },
					},
					{
						name: t("settings.timeBuoy.name"),
						desc: t("settings.timeBuoy.desc"),
						render: (setting: Setting) => { this.renderTimeBuoySetting(setting); },
					},
				],
			},
			{
				type: "group",
				heading: t("settings.monthly.heading"),
				items: [
					{
						name: t("settings.dateOrder.name"),
						desc: t("settings.dateOrder.desc"),
						render: (setting: Setting) => { this.renderDateOrderSetting(setting); },
					},
					{
						name: t("settings.monthlyFileFormat.name"),
						desc: t("settings.monthlyFileFormat.desc", { format: DEFAULT_MONTHLY_MEMO_FILE_FORMAT }),
						render: (setting: Setting) => { this.renderMonthlyFileFormatSetting(setting); },
					},
					{
						name: t("settings.dateHeadingFormat.name"),
						desc: t("settings.dateHeadingFormat.desc", { format: DEFAULT_MONTHLY_DATE_HEADING_FORMAT }),
						render: (setting: Setting) => { this.renderDateHeadingFormatSetting(setting); },
					},
					{
						name: t("settings.excludeMonthly.name"),
						desc: t("settings.excludeMonthly.desc"),
						render: (setting: Setting) => { this.renderMonthlyExcludeSetting(setting); },
					},
				],
			},
			{
				type: "group",
				heading: t("settings.files.heading"),
				items: [{
					name: t("settings.dataRoot.name"),
					desc: t("settings.dataRoot.desc"),
					render: (setting: Setting) => { this.renderDataRootSetting(setting); },
				}],
			},
		];
	}

	display(): void {
		this.settingsVisible = true;
		const { containerEl } = this;
		this.cancelAllDelayedSettingNotices();
		this.pendingSettingDrafts.clear();
		containerEl.empty();

		const attentionKinds = this.getAttentionKinds();
		if (attentionKinds.length > 0) {
			new Setting(containerEl)
				.setName(t("settings.attention.heading"))
				.setHeading();
			for (const kind of attentionKinds) {
				this.renderAttentionSetting(kind, new Setting(containerEl));
			}
		}

		new Setting(containerEl)
			.setName(t("settings.capture.heading"))
			.setHeading();
		this.renderDailyHeadingSetting(new Setting(containerEl)
			.setName(t("settings.dailyHeading.name"))
			.setDesc(t("settings.dailyHeading.desc", { heading: DEFAULT_DAILY_HEADING })));
		this.renderInsertPositionSetting(new Setting(containerEl)
			.setName(t("settings.insertPosition.name"))
			.setDesc(t("settings.insertPosition.desc")));
		this.renderTimeFormatSetting(new Setting(containerEl)
			.setName(t("settings.timeFormat.name"))
			.setDesc(t("settings.timeFormat.desc")));
		this.renderTimeBuoySetting(new Setting(containerEl)
			.setName(t("settings.timeBuoy.name"))
			.setDesc(t("settings.timeBuoy.desc")));

		new Setting(containerEl)
			.setName(t("settings.monthly.heading"))
			.setHeading();
		this.renderDateOrderSetting(new Setting(containerEl)
			.setName(t("settings.dateOrder.name"))
			.setDesc(t("settings.dateOrder.desc")));
		this.renderMonthlyFileFormatSetting(new Setting(containerEl)
			.setName(t("settings.monthlyFileFormat.name"))
			.setDesc(t("settings.monthlyFileFormat.desc", { format: DEFAULT_MONTHLY_MEMO_FILE_FORMAT })));
		this.renderDateHeadingFormatSetting(new Setting(containerEl)
			.setName(t("settings.dateHeadingFormat.name"))
			.setDesc(t("settings.dateHeadingFormat.desc", { format: DEFAULT_MONTHLY_DATE_HEADING_FORMAT })));
		this.renderMonthlyExcludeSetting(new Setting(containerEl)
			.setName(t("settings.excludeMonthly.name"))
			.setDesc(t("settings.excludeMonthly.desc")));

		new Setting(containerEl)
			.setName(t("settings.files.heading"))
			.setHeading();
		this.renderDataRootSetting(new Setting(containerEl)
			.setName(t("settings.dataRoot.name"))
			.setDesc(t("settings.dataRoot.desc")));
	}

	hide(): void {
		this.settingsVisible = false;
		void this.commitAllPendingSettingDrafts(false);
		super.hide();
		this.cancelAllDelayedSettingNotices();
	}

	private renderDailyHeadingSetting(setting: Setting): void {
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
	}

	private renderInsertPositionSetting(setting: Setting): void {
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
	}

	private renderTimeFormatSetting(setting: Setting): void {
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
	}

	private renderTimeBuoySetting(setting: Setting): void {
		const settings = this.settingsService.getSettings();
		setting.addToggle((toggle) => {
			toggle.setValue(settings.timeBuoyEnabled);
			toggle.onChange((value) => {
				void this.toggleTimeBuoy(value, toggle);
			});
		});
	}

	private renderDateOrderSetting(setting: Setting): void {
		const settings = this.settingsService.getSettings();
		setting.addDropdown((dropdown) => {
			dropdown.addOption("asc", t("settings.dateOrder.asc"));
			dropdown.addOption("desc", t("settings.dateOrder.descOption"));
			dropdown.setValue(settings.monthlyDateOrder);
			dropdown.onChange((value) => {
				void (async () => {
					await this.settingsService.updateSettings({
						monthlyDateOrder: value as MonthlyDateOrder,
					});
					await this.syncSharedConfiguration();
				})();
			});
		});
	}

	private renderMonthlyExcludeSetting(setting: Setting): void {
		const settings = this.settingsService.getSettings();
		const statusEl = setting.infoEl.createDiv({ cls: "knomo-setting-help" });
		setting.addToggle((toggle) => {
			toggle.setValue(settings.excludeMonthlyMemosFromObsidian);
			toggle.onChange((value) => {
				void this.toggleMonthlyMemosExcludeRule(value, toggle, statusEl);
			});
		});
		if (this.settingsService.hasMonthlyExcludeInitializationFailure()) {
			this.setExcludeStatus(statusEl, t("settings.excludeMonthly.autoFailed"), true);
			setting.addButton((button) => {
				button.setButtonText(t("settings.excludeMonthly.retry"));
				button.onClick(() => { void this.retryMonthlyExcludeInitialization(button); });
			});
		}
	}

	private async retryMonthlyExcludeInitialization(
		button: { setDisabled(disabled: boolean): void },
	): Promise<void> {
		button.setDisabled(true);
		try {
			await this.settingsService.initializeMonthlyExcludeDefault();
		} finally {
			button.setDisabled(false);
			this.refreshSettingTab();
		}
	}

	private renderMonthlyFileFormatSetting(setting: Setting): void {
		const settings = this.settingsService.getSettings();
		const statusEl = setting.infoEl.createDiv({ cls: "knomo-setting-help" });
		let draft = settings.monthlyMemoFileFormat;
		let applyButton: ButtonComponent | null = null;
		const updateApplyState = (): void => {
			const nextValue = draft.trim();
			applyButton?.setDisabled(
				!this.settingsService.validateMonthlyMemoFileFormat(nextValue)
				|| nextValue === this.settingsService.getSettings().monthlyMemoFileFormat,
			);
		};
		setting
			.addText((text) => {
				text.setPlaceholder(DEFAULT_MONTHLY_MEMO_FILE_FORMAT);
				text.setValue(settings.monthlyMemoFileFormat);
				text.onChange((value) => {
					draft = value;
					this.updateTextSettingDraft(
						"monthlyMemoFileFormat",
						value,
						(nextValue) => this.settingsService.validateMonthlyMemoFileFormat(nextValue),
						t("settings.monthlyFileFormat.invalid"),
					);
					this.updateMonthlyFileFormatDraftStatus(statusEl, value);
					updateApplyState();
				});
			})
			.addButton((button) => {
				applyButton = button;
				button.setButtonText(t("settings.monthlyFileFormat.apply"));
				button.onClick(() => {
					void (async () => {
						button.setDisabled(true);
						button.setButtonText(t("settings.monthlyFileFormat.applying"));
						try {
							await this.commitMonthlyMemoFileFormatDraft(draft, statusEl);
						} finally {
							button.setButtonText(t("settings.monthlyFileFormat.apply"));
							updateApplyState();
						}
					})();
				});
				updateApplyState();
			});
		this.updateMonthlyFileFormatStatus(statusEl);
	}

	private renderDateHeadingFormatSetting(setting: Setting): void {
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
	}

	private renderDataRootSetting(setting: Setting): void {
		const settings = this.settingsService.getSettings();
		if (!this.dataRootEditing) {
			setting
				.addText((text) => {
					text.setValue(settings.knomoDataRoot);
					text.inputEl.readOnly = true;
				})
				.addButton((button) => {
					button.setButtonText(settings.knomoDataRootConfigured
						? t("settings.dataRoot.change")
						: t("settings.dataRoot.choose"));
					button.onClick(() => {
						this.dataRootEditing = true;
						this.dataRootDraft = settings.knomoDataRoot;
						this.refreshSettingTab();
					});
				});
			return;
		}

		this.dataRootDraft ??= settings.knomoDataRoot;
		setting
			.addText((text) => {
				text.setPlaceholder(DEFAULT_MONTHLY_MEMO_FOLDER);
				text.setValue(this.dataRootDraft ?? settings.knomoDataRoot);
				text.onChange((value) => { this.dataRootDraft = value; });
				new KnomoFolderSuggest(this.app, text.inputEl, (value) => { this.dataRootDraft = value; });
			})
			.addButton((button) => {
				button.setButtonText(t("settings.dataRoot.apply"));
				button.onClick(() => {
					void (async () => {
						const saved = await this.saveKnomoDataRoot(this.dataRootDraft ?? settings.knomoDataRoot, button);
						if (!saved) return;
						this.dataRootEditing = false;
						this.dataRootDraft = null;
						this.refreshSettingTab();
					})();
				});
			})
			.addButton((button) => {
				button.setButtonText(t("settings.dataRoot.cancel"));
				button.onClick(() => {
					this.dataRootEditing = false;
					this.dataRootDraft = null;
					this.refreshSettingTab();
				});
			});
	}

	private renderCatalogAttentionSetting(setting: Setting): void {
		const resultEl = setting.infoEl.createDiv({ cls: "knomo-scan-result" });
		setting
			.setName(t("settings.attention.catalog.name"))
			.setDesc(t("settings.attention.catalog.desc"))
			.addButton((button) => {
				button.setButtonText(t("settings.attention.checkAgain"));
				button.onClick(() => { void this.runRuntimeRetry(button); });
			})
			.addButton((button) => {
				button.setButtonText(t("settings.rebuild.start"));
				button.onClick(() => {
					void this.runRebuildIndex(button, resultEl);
				});
			});
	}

	private renderIdentityAttentionSetting(setting: Setting): void {
		const status = this.catalogReadService.getRuntimeAttentionSnapshot().identity;
		setting
			.setName(t("settings.attention.identity.name"))
			.setDesc(t(status === "conflicted"
				? "settings.attention.identity.conflicted"
				: "settings.attention.identity.unavailable"))
			.addButton((button) => {
				button.setButtonText(t("settings.attention.checkAgain"));
				button.onClick(() => { void this.runRuntimeRetry(button, t("settings.attention.checkAgain"), true); });
			});
	}

	private renderMonthlyAttentionSetting(setting: Setting): void {
		const periods = this.monthlyProjectionCoordinator.getFailedPeriods();
		setting
			.setName(t("settings.attention.monthly.name"))
			.setDesc(t("settings.attention.monthly.desc", { periods: periods.join(", ") || "—" }))
			.addButton((button) => {
				button.setButtonText(t("settings.attention.retry"));
				button.onClick(() => { void this.runMonthlyRetry(button); });
			});
	}

	private renderSettingsAttentionSetting(setting: Setting): void {
		setting
			.setName(t("settings.attention.settings.name"))
			.setDesc(t("settings.attention.settings.desc"))
			.addButton((button) => {
				button.setButtonText(t("settings.attention.settings.retry"));
				button.onClick(() => {
					void this.runRuntimeRetry(button, t("settings.attention.settings.retry"));
				});
			});
	}

	private renderLegacyIdentityImport(setting: Setting): void {
		const report = this.legacyIndexMigrationService.getReport();
		setting
			.setName(t("settings.legacyIdentityImport.name"))
			.setDesc(this.getLegacyIdentityImportDescription());
		if (report.status === "partial") {
			setting.addButton((button) => {
				button.setButtonText(t("settings.legacyIdentityImport.acknowledge"));
				button.onClick(() => {
					void this.acknowledgeLegacyMigration(button);
				});
			});
		} else {
			setting.addButton((button) => {
				button.setButtonText(t("settings.attention.checkAgain"));
				button.onClick(() => { void this.runRuntimeRetry(button); });
			});
		}
	}

	private getLegacyIdentityImportDescription(): string {
		const report = this.legacyIndexMigrationService.getReport();
		const messageKey = report.status === "partial"
			? "settings.legacyIdentityImport.partial"
			: report.status === "attention"
				? "settings.legacyIdentityImport.attention"
				: "settings.legacyIdentityImport.unavailable";
		return t(messageKey);
	}

	private async acknowledgeLegacyMigration(
		button: { setDisabled(disabled: boolean): void },
	): Promise<void> {
		button.setDisabled(true);
		try {
			const acknowledged = await this.legacyMigrationAcknowledgementService.acknowledge(
				this.legacyIndexMigrationService.getReport(),
			);
			if (!acknowledged) throw new Error("Legacy migration report is not acknowledgeable.");
		} catch {
			new Notice(t("settings.legacyIdentityImport.acknowledgeFailed"));
		} finally {
			button.setDisabled(false);
			this.refreshSettingTab();
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
		const monthlyDateHeadingFormat = this.pendingSettingDrafts.get("monthlyDateHeadingFormat");
		if (dailyHeading !== undefined) {
			await this.commitDailyHeadingDraft(showChangedNotice, dailyHeading);
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
		await this.syncSharedConfiguration();
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
		await this.syncSharedConfiguration();
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
			const sourcePeriods = await this.monthlyProjectionCoordinator.listPeriods();
			const plan = await this.settingsService.planMonthlyMemoFileFormatMigration(nextFormat, sourcePeriods);
			if (plan.conflicts.length > 0) {
				throw new Error(t("settings.monthlyFileFormat.conflict", {
					paths: plan.conflicts.join("; "),
				}));
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
			await this.syncSharedConfiguration();
			for (const period of plan.periods) {
				await this.monthlyProjectionCoordinator.rebuildPeriod(period);
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

	private updateMonthlyFileFormatDraftStatus(statusEl: HTMLElement, value: string): void {
		const nextFormat = value.trim();
		if (!this.settingsService.validateMonthlyMemoFileFormat(nextFormat)) {
			statusEl.setText(t("settings.monthlyFileFormat.invalid"));
			statusEl.toggleClass("is-error", true);
			return;
		}
		this.updateMonthlyFileFormatStatus(statusEl);
	}

	private async saveKnomoDataRoot(value: string, button: ButtonComponent): Promise<boolean> {
		const knomoDataRoot = normalizeVaultPath(value);
		const currentSettings = this.settingsService.getSettings();
		button.setDisabled(true);
		button.setButtonText(t("settings.dataRoot.saving"));
		try {
			const plan = await this.knomoDataRootMigrationService.plan(knomoDataRoot);
			if (plan.action === "migrate" || plan.action === "adopt") {
				const confirmed = await showKnomoConfirmModal(this.app, {
					message: t("settings.dataRoot.confirm", {
						current: currentSettings.knomoDataRoot,
						next: knomoDataRoot,
					}),
				});
				if (!confirmed) {
					return false;
				}
			}
			await this.knomoDataRootMigrationService.migrate(knomoDataRoot);
			await this.knomoSharedConfigService.reloadConfiguredRoot();
			await this.syncSharedConfiguration();
			await this.legacyIndexMigrationService.run({ sourceChanged: true, verifyCompletion: true });
			new Notice(t("settings.dataRoot.saved"));
			return true;
		} catch (error) {
			const message = formatServiceError(error, t("settings.dataRoot.saveFailed"));
			new Notice(message);
			return false;
		} finally {
			button.setDisabled(false);
			button.setButtonText(t("settings.dataRoot.apply"));
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
			await this.catalogReadService.queryTimeBuoysForDate(formatDatePart(new Date()));
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
		button: { setButtonText(text: string): void; setDisabled(disabled: boolean): void },
		resultEl: HTMLElement,
	): Promise<void> {
		if (this.rebuildRunning) {
			return;
		}
		this.rebuildRunning = true;
		button.setDisabled(true);
		button.setButtonText(t("settings.rebuild.running"));
		try {
			this.renderRebuildResult(t("settings.rebuild.catalogStatus"), resultEl);
			await this.memoCommandService.rebuildLocalCatalog();
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

	private async runRuntimeRetry(
		button: { setButtonText(text: string): void; setDisabled(disabled: boolean): void },
		idleButtonText = t("settings.attention.checkAgain"),
		forceIdentityReload = false,
	): Promise<void> {
		button.setDisabled(true);
		button.setButtonText(t("settings.attention.checking"));
		try {
			await this.retryRuntimeState(forceIdentityReload);
			await this.refreshOpenKnomoViews();
		} catch {
			new Notice(t("settings.attention.retryFailed"));
		} finally {
			button.setDisabled(false);
			button.setButtonText(idleButtonText);
			this.refreshSettingTab();
		}
	}

	private async runMonthlyRetry(
		button: { setButtonText(text: string): void; setDisabled(disabled: boolean): void },
	): Promise<void> {
		if (this.monthlyRetryRunning) return;
		this.monthlyRetryRunning = true;
		button.setDisabled(true);
		button.setButtonText(t("settings.attention.retrying"));
		try {
			const result = await this.monthlyProjectionCoordinator.run(true);
			if (result.failed > 0 || this.monthlyProjectionCoordinator.getProjectionState() === "failed") {
				throw new Error(t("settings.attention.monthly.retryFailed"));
			}
			await this.refreshOpenKnomoViews();
			new Notice(t("settings.attention.monthly.retried"));
		} catch (error) {
			new Notice(formatServiceError(error, t("settings.attention.monthly.retryFailed")));
		} finally {
			this.monthlyRetryRunning = false;
			button.setDisabled(false);
			button.setButtonText(t("settings.attention.retry"));
			this.refreshSettingTab();
		}
	}

	private renderRebuildResult(message: string, resultEl: HTMLElement): void {
		resultEl.empty();
		resultEl.createDiv({ cls: "knomo-setting-help", text: message });
	}

	private getAttentionKinds(): KnomoSettingAttentionKind[] {
		const legacyReport = this.legacyIndexMigrationService.getReport();
		return getKnomoSettingAttentionKinds(
			this.catalogReadService.getRuntimeAttentionSnapshot(),
			this.startupBootstrapService?.getSnapshot() ?? null,
			{
				legacyMigrationAcknowledged: this.legacyMigrationAcknowledgementService.isAcknowledged(legacyReport),
			},
		);
	}

	private getAttentionName(kind: KnomoSettingAttentionKind): string {
		switch (kind) {
			case "settings": return t("settings.attention.settings.name");
			case "shared-config": return t("settings.sharedConfig.name");
			case "catalog": return t("settings.attention.catalog.name");
			case "identity": return t("settings.attention.identity.name");
			case "monthly": return t("settings.attention.monthly.name");
			case "legacy": return t("settings.legacyIdentityImport.name");
		}
	}

	private getAttentionDescription(kind: KnomoSettingAttentionKind): string {
		switch (kind) {
			case "settings": return t("settings.attention.settings.desc");
			case "shared-config": return this.getSharedConfigDescription();
			case "catalog": return t("settings.attention.catalog.desc");
			case "identity": return t(this.catalogReadService.getRuntimeAttentionSnapshot().identity === "conflicted"
				? "settings.attention.identity.conflicted"
				: "settings.attention.identity.unavailable");
			case "monthly": return t("settings.attention.monthly.desc", {
				periods: this.monthlyProjectionCoordinator.getFailedPeriods().join(", ") || "—",
			});
			case "legacy": return this.getLegacyIdentityImportDescription();
		}
	}

	private renderAttentionSetting(kind: KnomoSettingAttentionKind, setting: Setting): void {
		switch (kind) {
			case "settings": this.renderSettingsAttentionSetting(setting); break;
			case "shared-config": this.renderSharedConfigSetting(setting); break;
			case "catalog": this.renderCatalogAttentionSetting(setting); break;
			case "identity": this.renderIdentityAttentionSetting(setting); break;
			case "monthly": this.renderMonthlyAttentionSetting(setting); break;
			case "legacy": this.renderLegacyIdentityImport(setting); break;
		}
	}

	private getSharedConfigDescription(): string {
		const initialization = this.startupBootstrapService?.getSnapshot() ?? null;
		if (initialization?.status === "initializing") {
			return t("settings.sharedConfig.initializing");
		}
		if (initialization?.status === "unavailable" && initialization.error !== null) {
			return t("settings.sharedConfig.initializationFailed");
		}
		switch (this.knomoSharedConfigService.getStatus()) {
			case "ready":
				return t("settings.sharedConfig.ready");
			case "conflicted":
				return t("settings.sharedConfig.conflicted");
			case "unavailable":
				return t("settings.sharedConfig.unavailable");
			case "missing":
				return t("settings.sharedConfig.missing");
		}
	}

	private renderSharedConfigSetting(setting: Setting): void {
		const status = this.knomoSharedConfigService.getStatus();
		const initializationStatus = this.startupBootstrapService?.getSnapshot().status ?? "ready";
		setting
			.setName(t("settings.sharedConfig.name"))
			.setDesc(this.getSharedConfigDescription());
		if (status === "ready" && initializationStatus === "ready") return;
		setting.addButton((button) => {
			button.setButtonText(status === "unavailable" || initializationStatus === "unavailable"
				? t("settings.sharedConfig.checkAgain")
				: status === "conflicted"
					? t("settings.sharedConfig.resolve")
					: t("settings.sharedConfig.publish"));
			button.onClick(() => {
				void (async () => {
					button.setDisabled(true);
					try {
						if (this.startupBootstrapService !== null) {
							const currentInitializationStatus = this.startupBootstrapService.getSnapshot().status;
							const currentSharedConfigStatus = this.knomoSharedConfigService.getStatus();
							if (currentInitializationStatus === "unavailable" || currentSharedConfigStatus === "unavailable") {
								await this.startupBootstrapService.retryInitialization();
							} else {
								await this.startupBootstrapService.useCurrentDeviceSettings();
							}
						} else {
							const currentStatus = this.knomoSharedConfigService.getStatus();
							if (currentStatus === "unavailable") await this.knomoSharedConfigService.reloadConfiguredRoot();
							else if (currentStatus === "conflicted") await this.knomoSharedConfigService.resolveWithLocalConfig();
							else await this.knomoSharedConfigService.publishLocalConfig();
						}
						if (this.knomoSharedConfigService.getStatus() !== "ready") {
							throw new Error(this.knomoSharedConfigService.getLastError()
								?? "Shared configuration did not become ready.");
						}
						new Notice(t("settings.sharedConfig.saved"));
					} catch {
						new Notice(t("settings.sharedConfig.failed"));
					} finally {
						button.setDisabled(false);
						this.refreshSettingTab();
					}
				})();
			});
		});
	}

	private async syncSharedConfiguration(): Promise<void> {
		try {
			await this.knomoSharedConfigService.refreshLocalConfig();
			const status = this.knomoSharedConfigService.getStatus();
			if (status === "ready" || status === "missing") {
				await this.knomoSharedConfigService.publishLocalConfig();
			}
		} catch {
			// 本机设置保存成功后，共享配置写入失败只保留待处理状态。
		}
	}

	private async refreshOpenKnomoViews(): Promise<void> {
		const refreshes = this.app.workspace.getLeavesOfType(KNOMO_VIEW_TYPE).map(async (leaf) => {
			if (leaf.view instanceof KnomoView) {
				await leaf.view.refresh(true);
			}
		});
		await Promise.all(refreshes);
	}

	refreshAttentionIfVisible(): void {
		if (this.settingsVisible) this.refreshSettingTab();
	}

	private refreshSettingTab(): void {
		const settingTab = this as PluginSettingTab & { update?: () => void };
		if (typeof settingTab.update === "function") {
			settingTab.update();
			return;
		}
		this.display();
	}

}

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
	KnomoStartupBootstrapStage,
	KnomoStartupBootstrapStatus,
} from "../services/KnomoStartupBootstrapService";
import type { CatalogReadService } from "../services/CatalogReadService";
import type { MemoCommandService } from "../services/MemoCommandService";
import type { MonthlyProjectionCoordinator } from "../services/MonthlyProjectionCoordinator";
import type { LegacyIndexMigrationService } from "../services/LegacyIndexMigrationService";
import type { KnomoRuntimeSnapshot } from "../types/catalogView";
import type { LegacyIdentityImportStatus } from "../types/legacyMigration";
import type { DailyInsertPosition, MemoTimeFormat, MonthlyDateOrder } from "../types/settings";
import { normalizeVaultPath } from "../utils/path";
import { formatDatePart } from "../utils/date";
import { formatServiceError, formatSettingsText } from "../utils/serviceText";
import { showKnomoConfirmModal } from "./KnomoConfirmModal";
import { KnomoView } from "./KnomoView";

const SETTING_NOTICE_DELAY_MS = 800;

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
	private dataRootEditing = false;
	private dataRootDraft: string | null = null;
	private legacyDiagnosticsExpanded = false;
	private runtimeStatusRequestId = 0;
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
		private readonly startupBootstrapService: KnomoStartupBootstrapService | null,
	) {
		super(app, plugin);
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				type: "group",
				heading: t("settings.attention.heading"),
				visible: () => this.shouldShowSharedConfigAttention(),
				items: [{
					name: t("settings.sharedConfig.name"),
					desc: this.getSharedConfigDescription(),
					render: (setting: Setting) => { this.renderSharedConfigSetting(setting); },
				}],
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
						name: t("settings.monthlyLocale.name"),
						desc: t("settings.monthlyLocale.desc", {
							locale: this.knomoSharedConfigService.getMonthlyLocale() ?? "—",
						}),
						render: (setting: Setting) => { this.renderMonthlyLocaleSetting(setting); },
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
			{
				type: "group",
				heading: t("settings.runtime.heading"),
				items: [{
					name: t("settings.runtime.name"),
					desc: t("settings.runtime.desc"),
					render: (setting: Setting) => { this.renderRuntimeStatusSetting(setting); },
				}],
			},
			{
				type: "group",
				heading: t("settings.maintenance.heading"),
				items: [
					{
						name: t("settings.localHistory.name"),
						desc: t("settings.localHistory.desc"),
						render: (setting: Setting) => { this.renderLocalHistorySetting(setting); },
					},
					{
						name: t("settings.monthlyRebuild.name"),
						desc: t("settings.monthlyRebuild.desc"),
						render: (setting: Setting) => { this.renderMonthlyRebuildSetting(setting); },
					},
					...(this.shouldShowLegacyIdentityImport() ? [{
						name: t("settings.legacyIdentityImport.name"),
						desc: t("settings.legacyIdentityImport.desc"),
						render: (setting: Setting) => { this.renderLegacyIdentityImport(setting); },
					}] : []),
				],
			},
		];
	}

	display(): void {
		const { containerEl } = this;
		this.cancelAllDelayedSettingNotices();
		this.pendingSettingDrafts.clear();
		containerEl.empty();

		if (this.shouldShowSharedConfigAttention()) {
			new Setting(containerEl)
				.setName(t("settings.attention.heading"))
				.setHeading();
			this.renderSharedConfigSetting(new Setting(containerEl)
				.setName(t("settings.sharedConfig.name")));
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
		this.renderMonthlyLocaleSetting(new Setting(containerEl)
			.setName(t("settings.monthlyLocale.name")));
		this.renderMonthlyExcludeSetting(new Setting(containerEl)
			.setName(t("settings.excludeMonthly.name"))
			.setDesc(t("settings.excludeMonthly.desc")));

		new Setting(containerEl)
			.setName(t("settings.files.heading"))
			.setHeading();
		this.renderDataRootSetting(new Setting(containerEl)
			.setName(t("settings.dataRoot.name"))
			.setDesc(t("settings.dataRoot.desc")));

		new Setting(containerEl)
			.setName(t("settings.runtime.heading"))
			.setHeading();
		this.renderRuntimeStatusSetting(new Setting(containerEl)
			.setName(t("settings.runtime.name"))
			.setDesc(t("settings.runtime.desc")));

		new Setting(containerEl)
			.setName(t("settings.maintenance.heading"))
			.setHeading();
		this.renderLocalHistorySetting(new Setting(containerEl)
			.setName(t("settings.localHistory.name"))
			.setDesc(t("settings.localHistory.desc")));
		this.renderMonthlyRebuildSetting(new Setting(containerEl)
			.setName(t("settings.monthlyRebuild.name"))
			.setDesc(t("settings.monthlyRebuild.desc")));
		if (this.shouldShowLegacyIdentityImport()) {
			this.renderLegacyIdentityImport(new Setting(containerEl)
				.setName(t("settings.legacyIdentityImport.name"))
				.setDesc(t("settings.legacyIdentityImport.desc")));
		}
	}

	hide(): void {
		this.runtimeStatusRequestId += 1;
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

	private renderMonthlyLocaleSetting(setting: Setting): void {
		const locale = this.knomoSharedConfigService.getMonthlyLocale() ?? "—";
		setting.setDesc(t("settings.monthlyLocale.desc", { locale }));
		setting.addButton((button) => {
			button.setButtonText(t("settings.monthlyLocale.useCurrent"));
			button.setDisabled(
				this.knomoSharedConfigService.getStatus() !== "ready"
				&& this.knomoSharedConfigService.getStatus() !== "missing",
			);
			button.onClick(() => {
				void (async () => {
					button.setDisabled(true);
					button.setButtonText(t("settings.monthlyLocale.applying"));
					try {
						const changed = await this.knomoSharedConfigService.useCurrentObsidianLocale();
						if (changed) {
							await this.monthlyProjectionCoordinator.handleConfigurationChanged();
							await this.refreshOpenKnomoViews();
						}
						new Notice(t(changed
							? "settings.monthlyLocale.saved"
							: "settings.monthlyLocale.unchanged"));
						this.refreshSettingTab();
					} catch {
						new Notice(t("settings.monthlyLocale.failed"));
					} finally {
						button.setButtonText(t("settings.monthlyLocale.useCurrent"));
						button.setDisabled(false);
					}
				})();
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

	private renderRuntimeStatusSetting(setting: Setting): void {
		const requestId = ++this.runtimeStatusRequestId;
		const statusEl = setting.infoEl.createDiv({ cls: "knomo-scan-result" });
		statusEl.setAttr("role", "status");
		statusEl.setAttr("aria-live", "polite");
		statusEl.setAttr("aria-atomic", "true");
		statusEl.setText(t("settings.runtime.loading"));
		const diagnosticsHostEl = setting.infoEl.createDiv();
		void this.catalogReadService.getRuntimeSnapshot().then((snapshot) => {
			if (requestId !== this.runtimeStatusRequestId) return;
			statusEl.empty();
			const initialization = this.startupBootstrapService?.getSnapshot() ?? null;
			statusEl.createDiv({
				cls: "knomo-setting-help",
				text: this.getRuntimeSummaryLabel(snapshot, initialization),
			});
			diagnosticsHostEl.empty();
			const diagnosticsEl = diagnosticsHostEl.createEl("details", { cls: "knomo-runtime-diagnostics" });
			diagnosticsEl.createEl("summary", { text: t("settings.runtime.diagnostics") });
			const diagnosticsBodyEl = diagnosticsEl.createDiv();
			diagnosticsBodyEl.createDiv({
				cls: "knomo-setting-help",
				text: t("settings.runtime.catalog", {
					coverage: snapshot.catalog.coverage.kind,
					lifecycle: snapshot.catalog.lifecycle.state,
					covered: snapshot.catalog.coverage.coveredFileCount,
					total: snapshot.catalog.coverage.totalFileCount,
					storage: snapshot.catalog.lifecycle.persistent
						? t("settings.runtime.storage.persistent")
						: t("settings.runtime.storage.memory"),
				}),
			});
			if (initialization !== null) {
				diagnosticsBodyEl.createDiv({
					cls: "knomo-setting-help",
					text: t("settings.runtime.initialization", {
						status: this.getBootstrapStatusLabel(initialization.status),
					}),
				});
				if (initialization.error !== null) {
					diagnosticsBodyEl.createDiv({
						cls: "knomo-setting-help is-error",
						text: t("settings.runtime.initializationDetail", {
							stage: this.getBootstrapStageLabel(initialization.stage),
							reason: formatSettingsText(initialization.error),
						}),
					});
				}
			}
			diagnosticsBodyEl.createDiv({ cls: "knomo-setting-help", text: t("settings.runtime.identity", { status: snapshot.identity }) });
			diagnosticsBodyEl.createDiv({ cls: "knomo-setting-help", text: t("settings.runtime.sharedConfig", { status: snapshot.sharedConfiguration }) });
			diagnosticsBodyEl.createDiv({ cls: "knomo-setting-help", text: t("settings.runtime.monthly", { status: snapshot.monthly }) });
			diagnosticsBodyEl.createDiv({
				cls: "knomo-setting-help",
				text: t("settings.runtime.legacy", { status: this.getLegacyStatusLabel(snapshot.legacyMigration) }),
			});
			if (snapshot.catalog.lifecycle.reason !== null) {
				diagnosticsBodyEl.createDiv({
					cls: "knomo-setting-help is-error",
					text: t("settings.runtime.reason", { reason: formatSettingsText(snapshot.catalog.lifecycle.reason) }),
				});
			}
		}).catch(() => {
			if (requestId === this.runtimeStatusRequestId) statusEl.setText(t("settings.runtime.unavailable"));
		});
	}

	private getRuntimeSummaryLabel(
		snapshot: KnomoRuntimeSnapshot,
		initialization: ReturnType<KnomoStartupBootstrapService["getSnapshot"]> | null,
	): string {
		if (initialization?.status === "unavailable"
			|| snapshot.catalog.lifecycle.state === "degraded"
			|| snapshot.catalog.lifecycle.state === "retrying"
			|| snapshot.catalog.lifecycle.state === "read-only"
			|| snapshot.identity === "unavailable"
			|| snapshot.sharedConfiguration === "unavailable"
			|| snapshot.monthly === "failed"
			|| snapshot.legacyMigration === "unavailable") {
			return t("settings.runtime.summary.unavailable");
		}
		if (initialization?.status === "conflicted"
			|| snapshot.identity === "conflicted"
			|| snapshot.sharedConfiguration === "conflicted"
			|| snapshot.legacyMigration === "attention"
			|| snapshot.legacyMigration === "partial") {
			return t("settings.runtime.summary.attention");
		}
		const initializationReady = initialization === null || initialization.status === "ready";
		const legacyReady = snapshot.legacyMigration === "ready" || snapshot.legacyMigration === "not_applicable";
		if (initializationReady
			&& snapshot.catalog.coverage.kind === "complete"
			&& snapshot.catalog.lifecycle.state === "ready"
			&& snapshot.identity === "ready"
			&& snapshot.sharedConfiguration === "ready"
			&& snapshot.monthly === "ready"
			&& legacyReady) {
			return t("settings.runtime.summary.ready");
		}
		return t("settings.runtime.summary.preparing");
	}

	private renderLocalHistorySetting(setting: Setting): void {
		const resultEl = setting.infoEl.createDiv({ cls: "knomo-scan-result" });
		setting.setClass("knomo-maintenance-setting").addButton((button) => {
			button.setButtonText(t("settings.rebuild.start"));
			button.onClick(() => {
				void this.runRebuildIndex(button, resultEl);
			});
		});
		void this.renderInitialRebuildResult(resultEl);
	}

	private renderLegacyIdentityImport(setting: Setting): void {
		const report = this.legacyIndexMigrationService.getReport();
		const statusEl = setting.infoEl.createDiv({ cls: "knomo-scan-result" });
		statusEl.setAttr("role", "status");
		statusEl.setAttr("aria-live", "polite");
		statusEl.setAttr("aria-atomic", "true");
		statusEl.setAttr("tabindex", "-1");
		if (report.diagnostics.length > 0) {
			setting.addButton((button) => {
				button.setButtonText(this.legacyDiagnosticsExpanded
					? t("settings.legacyIdentityImport.hideDetails")
					: t("settings.legacyIdentityImport.showDetails"));
				button.onClick(() => {
					this.legacyDiagnosticsExpanded = !this.legacyDiagnosticsExpanded;
					this.refreshSettingTab();
				});
			});
		}
		this.refreshLegacyIdentityImport(statusEl, this.legacyDiagnosticsExpanded);
	}

	private shouldShowLegacyIdentityImport(): boolean {
		const status = this.legacyIndexMigrationService.getReport().status;
		return status === "partial" || status === "attention" || status === "unavailable";
	}

	private renderMonthlyRebuildSetting(setting: Setting): void {
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
				void this.monthlyProjectionCoordinator.listPeriods().then((periods) => {
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

	private refreshLegacyIdentityImport(statusEl: HTMLElement, showDiagnostics: boolean): void {
		statusEl.empty();
		const report = this.legacyIndexMigrationService.getReport();
		const messageKey = report.status === "partial"
			? "settings.legacyIdentityImport.partial"
			: report.status === "attention"
				? "settings.legacyIdentityImport.attention"
				: "settings.legacyIdentityImport.unavailable";
		statusEl.setText(t(messageKey, {
			imported: report.importedMemoIds.length,
			skipped: report.skippedMemoIds.length,
		}));
		if (!showDiagnostics) return;
		for (const item of report.diagnostics) {
			statusEl.createDiv({
				cls: "knomo-setting-help",
				text: t("settings.legacyIdentityImport.diagnostic", {
					code: item.code,
					path: item.sourcePath ?? t("settings.legacyIdentityImport.unknownPath"),
					detail: item.detail,
				}),
			});
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
			const projection = await this.monthlyProjectionCoordinator.rebuildPeriod(period);
			if (projection.failed > 0) throw new Error(t("settings.monthlyRebuild.failed"));
			this.renderMonthlyRebuildResult(t("settings.monthlyRebuild.complete", { period }), resultEl);
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

	private shouldShowSharedConfigAttention(): boolean {
		return (this.startupBootstrapService !== null
			&& this.startupBootstrapService.getSnapshot().status !== "ready")
			|| this.knomoSharedConfigService.getStatus() !== "ready";
	}

	private renderSharedConfigSetting(setting: Setting): void {
		const status = this.knomoSharedConfigService.getStatus();
		const initializationStatus = this.startupBootstrapService?.getSnapshot().status ?? "ready";
		setting.setDesc(this.getSharedConfigDescription());
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
							await this.startupBootstrapService.useCurrentDeviceSettings();
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

	private getBootstrapStatusLabel(status: KnomoStartupBootstrapStatus): string {
		switch (status) {
			case "unconfigured": return t("settings.runtime.initializationStatus.unconfigured");
			case "initializing": return t("settings.runtime.initializationStatus.initializing");
			case "ready": return t("settings.runtime.initializationStatus.ready");
			case "conflicted": return t("settings.runtime.initializationStatus.conflicted");
			case "unavailable": return t("settings.runtime.initializationStatus.unavailable");
		}
	}

	private getBootstrapStageLabel(stage: KnomoStartupBootstrapStage | null): string {
		switch (stage) {
			case "data_root": return t("settings.runtime.initializationStage.dataRoot");
			case "identity": return t("settings.runtime.initializationStage.identity");
			case "catalog": return t("settings.runtime.initializationStage.catalog");
			case "shared_config": return t("settings.runtime.initializationStage.sharedConfig");
			case "verification": return t("settings.runtime.initializationStage.verification");
			case null: return t("settings.runtime.initializationStage.none");
		}
	}

	private getLegacyStatusLabel(status: LegacyIdentityImportStatus): string {
		switch (status) {
			case "idle": return t("settings.runtime.legacy.idle");
			case "waiting_initialization": return t("settings.runtime.legacy.waitingInitialization");
			case "waiting_catalog": return t("settings.runtime.legacy.waitingCatalog");
			case "not_applicable": return t("settings.runtime.legacy.notApplicable");
			case "ready": return t("settings.runtime.legacy.ready");
			case "partial": return t("settings.runtime.legacy.partial");
			case "attention": return t("settings.runtime.legacy.attention");
			case "unavailable": return t("settings.runtime.legacy.unavailable");
		}
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

	private refreshSettingTab(): void {
		const settingTab = this as PluginSettingTab & { update?: () => void };
		if (typeof settingTab.update === "function") {
			settingTab.update();
			return;
		}
		this.display();
	}

}

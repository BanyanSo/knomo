import { normalizeComposerToolbar } from "../settings/composerToolbar";
import { composerActionLabels } from "./KnomoComposer";
import { Notice, requireApiVersion, PluginSettingTab, Setting, SettingGroup } from "obsidian";
import type { App, ButtonComponent, Plugin, SettingDefinitionItem, ToggleComponent } from "obsidian";

import {
	DEFAULT_DAILY_HEADING,
	DEFAULT_MONTHLY_DATE_HEADING_FORMAT,
	DEFAULT_MONTHLY_MEMO_FILE_FORMAT,
	DEFAULT_MONTHLY_MEMO_FOLDER,
	KNOMO_VIEW_TYPE,
} from "../constants";
import { getKnomoLocale, t } from "../i18n";
import type { TranslationKey } from "../i18n";
import wechatQr from "../assets/Banyan-WeChat-Reward.png";
import coffeeQr from "../assets/buymeacoffe-code.png";
import { buildMonthlyFolderExcludeRule, type ObsidianExcludeService } from "../services/ObsidianExcludeService";
import type { SettingsService } from "../services/SettingsService";
import type { KnomoCurrentConfigService } from "../services/KnomoCurrentConfigService";
import type {
	KnomoStartupBootstrapService,
} from "../services/KnomoStartupBootstrapService";
import type { CatalogReadService } from "../services/CatalogReadService";
import type { MemoCommandService } from "../services/MemoCommandService";
import type { MonthlyProjectionCoordinator } from "../services/MonthlyProjectionCoordinator";
import type { LegacyTrashMigrationService } from "../services/LegacyTrashMigrationService";
import type { DailyInsertPosition, MemoTimeFormat, MonthlyDateOrder } from "../types/settings";
import { formatDatePart } from "../utils/date";
import { formatServiceError } from "../utils/serviceText";
import { showKnomoConfirmModal } from "./KnomoConfirmModal";
import { KnomoFolderSuggest } from "./KnomoFolderSuggest";
import { getKnomoSettingAttentionKinds } from "./KnomoSettingAttention";
import type { KnomoSettingAttentionKind } from "./KnomoSettingAttention";
import { KnomoView } from "./KnomoView";

const SETTING_NOTICE_DELAY_MS = 800;

type SettingTabId = "record" | "archive-data" | "about";

const ABOUT_LINKS = {
	releases: "https://github.com/BanyanSo/knomo/releases",
	guideZh: "https://github.com/BanyanSo/knomo/blob/HEAD/README.zh-CN.md",
	guideEn: "https://github.com/BanyanSo/knomo/blob/HEAD/README.md",
	issues: "https://github.com/BanyanSo/knomo/issues/new",
	coffee: "https://www.buymeacoffee.com/banyanso",
} as const;

interface DeveloperContact {
	id: string;
	labelKey: TranslationKey;
	value: string;
	href?: string;
}
export const DEVELOPER_CONTACTS: DeveloperContact[] = [
	{ id: "email", labelKey: "settings.about.email", value: "rongshuso@gmail.com", href: "mailto:rongshuso@gmail.com" },
	{ id: "x", labelKey: "settings.about.x", value: "@Banyansu", href: "https://x.com/Banyansu" },
	{ id: "github", labelKey: "settings.about.github", value: "@BanyanSo", href: "https://github.com/BanyanSo" },
	{ id: "xiaohongshu", labelKey: "settings.about.xiaohongshu", value: t("settings.about.rednoteAccount"), href: "https://xhslink.cn/o/3vSar1g1BMs" },
	{ id: "wechat", labelKey: "settings.about.wechatContact", value: "rongshuso" },
];

type SettingNoticeKey = "dailyHeading" | "monthlyMemoFileFormat" | "monthlyDateHeadingFormat";

interface DelayedSettingNotice {
	value: string;
	timeoutId: number;
}

export class KnomoSettingTab extends PluginSettingTab {
	private rebuildRunning = false;
	private runtimeRetryRunning = false;
	private monthlyRetryRunning = false;
	private legacyMigrationRunning = false;
	private currentConfigRetryRunning = false;
	private monthlyFileFormatMigrationRunning = false;
	private timeBuoyToggleRunning = false;
	private monthlyFolderEditing = false;
	private monthlyFolderDraft: string | null = null;
	private settingsVisible = false;
	private selectedTab: SettingTabId = "record";
	private toolbarExpanded = true;
	private pageEl: HTMLElement | null = null;
	private attentionEl: HTMLElement | null = null;
	private renderedAttentionKinds: KnomoSettingAttentionKind[] = [];
	private readonly latestSettingNoticeValues = new Map<SettingNoticeKey, string>();
	private readonly delayedSettingNotices = new Map<SettingNoticeKey, DelayedSettingNotice>();
	private readonly pendingSettingDrafts = new Map<SettingNoticeKey, string>();
	private readonly pluginVersion: string;

	constructor(
		app: App,
		plugin: Plugin,
		private readonly settingsService: SettingsService,
		private readonly obsidianExcludeService: ObsidianExcludeService,
		private readonly memoCommandService: MemoCommandService,
		private readonly catalogReadService: CatalogReadService,
		private readonly monthlyProjectionCoordinator: MonthlyProjectionCoordinator,
		private readonly knomoCurrentConfigService: Pick<KnomoCurrentConfigService, "getStatus" | "getLastError" | "reloadConfiguration" | "refreshLocalConfig">,
		private readonly legacyTrashMigrationService: Pick<LegacyTrashMigrationService, "getReport"> & { run(): Promise<unknown> },
		private readonly startupBootstrapService: KnomoStartupBootstrapService | null,
		private readonly retryRuntimeState: () => Promise<void>,
	) {
		super(app, plugin);
		this.pluginVersion = plugin.manifest.version;
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		return [{
			name: "Knomo",
			aliases: [
				"Knomo", t("settings.capture.heading"), t("settings.presentation.heading"),
				t("settings.monthly.heading"), t("settings.files.heading"),
				t("settings.dailyHeading.name"), t("settings.insertPosition.name"),
				t("settings.timeFormat.name"), t("settings.timeBuoy.name"),
				t("settings.toolbar.name"), t("settings.recentTimeFlow.name"),
				t("settings.dateOrder.name"), t("settings.monthlyFileFormat.name"),
				t("settings.dateHeadingFormat.name"), t("settings.excludeMonthly.name"),
				t("settings.monthlyFolder.name"), t("settings.tab.about"),
			],
			render: (setting: Setting, group: SettingGroup) => {
				group?.listEl.addClass("knomo-settings-host-list");
				setting.settingEl.addClass("knomo-settings-host-row");
				setting.settingEl.empty();
				this.mountPage(setting.settingEl);
			},
		}];
	}

	display(): void {
		this.containerEl.empty();
		this.mountPage(this.containerEl);
	}

	hide(): void {
		this.settingsVisible = false;
		void this.commitAllPendingSettingDrafts(false);
		super.hide();
		this.cancelAllDelayedSettingNotices();
		this.selectedTab = "record";
		this.toolbarExpanded = true;
		this.monthlyFolderEditing = false;
		this.monthlyFolderDraft = null;
		this.pendingSettingDrafts.clear();
		this.pageEl = null;
		this.attentionEl = null;
	}
	private mountPage(parent: HTMLElement): void {
		this.settingsVisible = true;
		const page = parent.createDiv({ cls: "knomo-settings-page" });
		this.pageEl = page;
		const navigation = new SettingGroup(page).addClass("knomo-settings-navigation");
		this.attentionEl = page.createDiv({ cls: "knomo-settings-attention" });
		this.refreshAttentionRegion();

		const tabs = [
			{ id: "record", label: t("settings.tab.record") },
			{ id: "archive-data", label: t("settings.tab.archiveData") },
			{ id: "about", label: t("settings.tab.about") },
		] as const;
		const tablist = navigation.listEl.createDiv({ cls: "knomo-settings-tabs", attr: {
			role: "tablist", "aria-label": t("settings.tabs.label"),
		} });
		const buttons = new Map<SettingTabId, HTMLButtonElement>();
		const panels = new Map<SettingTabId, HTMLElement>();
		for (const tab of tabs) {
			const button = tablist.createEl("button", { text: tab.label, cls: "knomo-settings-tab", attr: {
				type: "button", role: "tab", id: "knomo-settings-tab-" + tab.id,
				"aria-controls": "knomo-settings-panel-" + tab.id,
			} });
			buttons.set(tab.id, button);
			const panel = page.createDiv({ cls: "knomo-settings-panel", attr: {
				role: "tabpanel", id: "knomo-settings-panel-" + tab.id,
				"aria-labelledby": button.id,
			} });
			panels.set(tab.id, panel);
			button.addEventListener("click", () => {
				this.selectedTab = tab.id;
				activate();
			});
			button.addEventListener("keydown", (event) => {
				const index = tabs.findIndex(item => item.id === tab.id);
				const next = event.key === "ArrowRight" ? (index + 1) % tabs.length
					: event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length
						: event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : -1;
				if (next < 0) return;
				event.preventDefault();
				buttons.get(tabs[next].id)?.focus();
			});
		}
		const activate = () => {
			for (const tab of tabs) {
				const active = tab.id === this.selectedTab;
				const button = buttons.get(tab.id);
				const panel = panels.get(tab.id);
				if (!button || !panel) continue;
				button.setAttribute("aria-selected", String(active));
				button.tabIndex = active ? 0 : -1;
				panel.hidden = !active;
			}
		};
		this.renderRecordSettings(panels.get("record")!);
		this.renderArchiveSettings(panels.get("archive-data")!);
		this.renderAboutSettings(panels.get("about")!);
		activate();
	}

	private refreshAttentionRegion(): void {
		const parent = this.attentionEl;
		if (!parent) return;
		const focused = parent.ownerDocument.activeElement;
		const focusedButtonIndex = focused?.tagName === "BUTTON" && parent.contains(focused)
			? Array.from(parent.querySelectorAll("button")).indexOf(focused as HTMLButtonElement) : -1;
		parent.empty();
		const currentKinds = this.getAttentionKinds();
		const running = this.rebuildRunning || this.runtimeRetryRunning || this.monthlyRetryRunning
			|| this.legacyMigrationRunning || this.currentConfigRetryRunning;
		const kinds = running
			? [...new Set([...currentKinds, ...this.renderedAttentionKinds])]
			: currentKinds;
		this.renderedAttentionKinds = kinds;
		parent.hidden = kinds.length === 0;
		if (kinds.length === 0) return;
		const card = this.createSettingCard(parent, "settings.attention.heading");
		for (const kind of kinds) this.renderAttentionSetting(kind, new Setting(card));
		if (focusedButtonIndex >= 0) parent.querySelectorAll("button")[focusedButtonIndex]?.focus();
	}

	private createSettingCard(parent: HTMLElement, headingKey: TranslationKey): HTMLElement {
		return new SettingGroup(parent).setHeading(t(headingKey)).listEl;
	}
	private renderRecordSettings(parent: HTMLElement): void {
		let card = this.createSettingCard(parent, "settings.capture.heading");
		this.renderDailyHeadingSetting(new Setting(card).setName(t("settings.dailyHeading.name"))
			.setDesc(t("settings.dailyHeading.desc", { heading: DEFAULT_DAILY_HEADING })));
		this.renderInsertPositionSetting(new Setting(card).setName(t("settings.insertPosition.name"))
			.setDesc(t("settings.insertPosition.desc")));
		this.renderTimeFormatSetting(new Setting(card).setName(t("settings.timeFormat.name"))
			.setDesc(t("settings.timeFormat.desc")));
		this.renderTimeBuoySetting(new Setting(card).setName(t("settings.timeBuoy.name"))
			.setDesc(t("settings.timeBuoy.desc")));
		this.renderToolbarSetting(new Setting(card).setName(t("settings.toolbar.name"))
			.setDesc(t("settings.toolbar.desc")));
		card = this.createSettingCard(parent, "settings.presentation.heading");
		this.renderRecentTimeFlowSetting(new Setting(card).setName(t("settings.recentTimeFlow.name"))
			.setDesc(t("settings.recentTimeFlow.desc")));
	}

	private renderArchiveSettings(parent: HTMLElement): void {
		let card = this.createSettingCard(parent, "settings.monthly.heading");
		this.renderDateOrderSetting(new Setting(card).setName(t("settings.dateOrder.name"))
			.setDesc(t("settings.dateOrder.desc")));
		this.renderMonthlyFileFormatSetting(new Setting(card).setName(t("settings.monthlyFileFormat.name"))
			.setDesc(t("settings.monthlyFileFormat.desc", { format: DEFAULT_MONTHLY_MEMO_FILE_FORMAT })));
		this.renderDateHeadingFormatSetting(new Setting(card).setName(t("settings.dateHeadingFormat.name"))
			.setDesc(t("settings.dateHeadingFormat.desc", { format: DEFAULT_MONTHLY_DATE_HEADING_FORMAT })));
		this.renderMonthlyExcludeSetting(new Setting(card).setName(t("settings.excludeMonthly.name"))
			.setDesc(t("settings.excludeMonthly.desc")));
		card = this.createSettingCard(parent, "settings.files.heading");
		this.renderMonthlyFolderSetting(new Setting(card).setName(t("settings.monthlyFolder.name"))
			.setDesc(t("settings.monthlyFolder.desc")));
	}

	private renderAboutSettings(parent: HTMLElement): void {
		let card = this.createSettingCard(parent, "settings.about.versionHeading");
		new Setting(card).setClass("knomo-settings-action-row").setName(t("settings.about.currentVersion") + " " + this.pluginVersion)
			.addButton(button => button.setButtonText(t("settings.about.manageUpdates")).onClick(() => {
				// 复用宿主设置管理器，直接切换到原生第三方插件页。
				const setting = (this.app as App & { setting: { openTabById(id: string): void } }).setting;
				setting.openTabById("community-plugins");
			}));
		this.renderLinkSetting(card, "settings.about.releaseNotes", "settings.about.viewReleaseNotes", ABOUT_LINKS.releases);
		card = this.createSettingCard(parent, "settings.about.helpHeading");
		this.renderTextLink(new Setting(card).setClass("knomo-settings-value-row").setName(t("settings.about.reportIssue")).controlEl,
			t("settings.about.submitGithub"), ABOUT_LINKS.issues);
		this.renderTextLink(new Setting(card).setClass("knomo-settings-value-row").setName(t("settings.about.userGuide")).controlEl,
			t("settings.about.open"), getKnomoLocale() === "zh-CN" ? ABOUT_LINKS.guideZh : ABOUT_LINKS.guideEn);
		this.renderDeveloperContacts(card, DEVELOPER_CONTACTS);
		const support = new Setting(card).setName(t("settings.about.supportHeading")).setDesc(t("settings.about.wechatDesc"));
		support.settingEl.addClass("knomo-settings-support");
		const codes = support.settingEl.createDiv({ cls: "knomo-settings-support-codes" });
		for (const code of [
			{ src: coffeeQr, label: t("settings.about.coffee"), href: ABOUT_LINKS.coffee },
			{ src: wechatQr, label: t("settings.about.wechat"), href: null },
		]) {
			const item = codes.createDiv({ cls: "knomo-settings-support-code" });
			item.createEl("img", { cls: "knomo-settings-qr", attr: { src: code.src, alt: code.label } });
			if (code.href) this.renderTextLink(item, code.label, code.href);
			else item.createSpan({ text: code.label });
		}
		new Setting(card).setName(t("settings.about.licenseHeading")).setDesc("copyright©️BanyanSo，GPL-3.0-only");
		new Setting(card).setName(t("settings.about.privacyHeading")).setDesc(t("settings.about.privacyDesc"));
	}

	private renderDeveloperContacts(parent: HTMLElement, contacts: readonly DeveloperContact[]): void {
		for (const contact of contacts) {
			const setting = new Setting(parent).setClass("knomo-settings-value-row").setName(t(contact.labelKey));
			if (contact.href) this.renderTextLink(setting.controlEl, contact.value, contact.href);
			else setting.controlEl.createSpan({ text: contact.value });
		}
	}

	private renderTextLink(parent: HTMLElement, label: string, href: string): void {
		parent.createEl("a", { text: label, cls: "external-link", attr: { href, target: "_blank", rel: "noopener noreferrer" } });
	}

	private renderLinkSetting(
		parent: HTMLElement, nameKey: TranslationKey, actionKey: TranslationKey,
		href: string,
	): void {
		const setting = new Setting(parent).setClass("knomo-settings-action-row").setName(t(nameKey));
		setting.addButton(button => {
			button.setButtonText(t(actionKey));
			button.onClick(() => { this.openAboutLink(href); });
		});
	}

	private openAboutLink(href: string): void {
		this.containerEl.win.open(href, "_blank", "noopener,noreferrer");
	}

	private renderToolbarSetting(setting: Setting): void {
		setting.settingEl.addClass("knomo-toolbar-setting-row");
		// 复用折叠节点，行刷新与保存结果重绘均保留用户当前的展开状态。
		let details = setting.settingEl.querySelector<HTMLDetailsElement>(":scope > .knomo-toolbar-details");
		if (!details) {
			details = setting.settingEl.createEl("details");
			details.className = "knomo-toolbar-details";
			details.open = this.toolbarExpanded;
			const detailsEl = details;
			details.addEventListener("toggle", () => { this.toolbarExpanded = detailsEl.open; });
			const summary = details.createEl("summary");
			const info = setting.settingEl.querySelector(":scope > .setting-item-info");
			if (info) summary.appendChild(info);
			else summary.textContent = t("settings.toolbar.name");
		}
		details.querySelectorAll(":scope > .knomo-toolbar-settings").forEach(container => container.remove());
		const container = details.createDiv({ cls: "knomo-toolbar-settings" });
		let saving = false;
		const render = () => {
			container.empty();
			const controls: { setDisabled(disabled: boolean): unknown }[] = [];
			const preferences = this.settingsService.getSettings().composerToolbar;
			const save = async (next: typeof preferences) => {
				if (saving) return;
				saving = true;
				controls.forEach(control => control.setDisabled(true));
				try { await this.settingsService.updateSettings({ composerToolbar: next }); }
				catch (error) { new Notice(error instanceof Error ? error.message : String(error)); }
				finally { saving = false; render(); }
			};
			preferences.order.forEach((action, index) => {
				new Setting(container).setClass("knomo-toolbar-item").setName(t(composerActionLabels[action]))
					.addToggle(toggle => { controls.push(toggle); toggle.setValue(!preferences.hidden.includes(action)).onChange(visible => {
						void save({ order: [...preferences.order], hidden: visible ? preferences.hidden.filter(item => item !== action) : [...preferences.hidden, action] });
					}); })
					.addButton(button => { controls.push(button); button.setIcon("arrow-up").setTooltip(t("settings.toolbar.up")).setDisabled(index === 0).onClick(() => {
						const order = [...preferences.order]; [order[index - 1], order[index]] = [order[index], order[index - 1]];
						void save({ ...preferences, order });
					}); })
					.addButton(button => { controls.push(button); button.setIcon("arrow-down").setTooltip(t("settings.toolbar.down")).setDisabled(index === preferences.order.length - 1).onClick(() => {
						const order = [...preferences.order]; [order[index + 1], order[index]] = [order[index], order[index + 1]];
						void save({ ...preferences, order });
					}); });
			});
			new Setting(container).setClass("knomo-toolbar-reset").addButton(button => { controls.push(button); button.setButtonText(t("settings.toolbar.reset")).onClick(() => { void save(normalizeComposerToolbar(undefined)); }); });
		};
		render();
	}

	private renderDailyHeadingSetting(setting: Setting): void {
		setting.settingEl.addClass("knomo-settings-text-row");
		const settings = this.settingsService.getSettings();
		const statusEl = setting.infoEl.createDiv({ cls: "knomo-setting-help" });
		const showValidation = (value: string) => {
			const invalid = !this.settingsService.validateDailyHeading(value.trim());
			statusEl.setText(invalid ? t("settings.dailyHeading.invalid") : "");
			statusEl.toggleClass("is-error", invalid);
		};
		const initial = this.pendingSettingDrafts.get("dailyHeading") ?? settings.dailyHeading;
		if (this.pendingSettingDrafts.has("dailyHeading")) showValidation(initial);
		setting.addText((text) => {
			text.inputEl.dataset.knomoSettingInput = "dailyHeading";
			text.setPlaceholder(DEFAULT_DAILY_HEADING);
			text.setValue(initial);
			text.onChange((value) => {
				showValidation(value);
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
		setting.settingEl.addClass("knomo-settings-select-row");
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
		setting.settingEl.addClass("knomo-settings-select-row");
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

	private renderRecentTimeFlowSetting(setting: Setting): void {
		setting.settingEl.addClass("knomo-settings-toggle-row");
		setting.addToggle((toggle) => {
			toggle.setValue(this.settingsService.getSettings().recentTimeFlowEnabled);
			toggle.onChange(async (value) => {
				try {
					await this.settingsService.updateSettings({ recentTimeFlowEnabled: value });
				} catch {
					toggle.setValue(this.settingsService.getSettings().recentTimeFlowEnabled);
					new Notice(t("error.saveFailed"));
				}
			});
		});
	}

	private renderTimeBuoySetting(setting: Setting): void {
		setting.settingEl.addClass("knomo-settings-toggle-row");
		const settings = this.settingsService.getSettings();
		setting.addToggle((toggle) => {
			toggle.setValue(settings.timeBuoyEnabled);
			toggle.onChange((value) => {
				void this.toggleTimeBuoy(value, toggle);
			});
		});
	}

	private renderDateOrderSetting(setting: Setting): void {
		setting.settingEl.addClass("knomo-settings-select-row");
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
					await this.refreshCurrentConfiguration();
				})();
			});
		});
	}

	private renderMonthlyExcludeSetting(setting: Setting): void {
		setting.settingEl.addClass("knomo-settings-toggle-row");
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
				// 重试独占下一行，避免错误状态改变开关列的宽度。
				button.buttonEl.addClass("knomo-settings-row-action");
				setting.settingEl.appendChild(button.buttonEl);
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
		setting.settingEl.addClass("knomo-settings-text-row");
		const settings = this.settingsService.getSettings();
		const statusEl = setting.infoEl.createDiv({ cls: "knomo-setting-help" });
		let draft = this.pendingSettingDrafts.get("monthlyMemoFileFormat") ?? settings.monthlyMemoFileFormat;
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
				text.inputEl.dataset.knomoSettingInput = "monthlyMemoFileFormat";
				text.setPlaceholder(DEFAULT_MONTHLY_MEMO_FILE_FORMAT);
				text.setValue(draft);
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
		if (draft !== settings.monthlyMemoFileFormat) this.updateMonthlyFileFormatDraftStatus(statusEl, draft);
		else this.updateMonthlyFileFormatStatus(statusEl);
	}

	private renderDateHeadingFormatSetting(setting: Setting): void {
		setting.settingEl.addClass("knomo-settings-text-row");
		const settings = this.settingsService.getSettings();
		const statusEl = setting.infoEl.createDiv({ cls: "knomo-setting-help" });
		const showValidation = (value: string) => {
			const invalid = !this.settingsService.validateMarkdownHeading(value.trim());
			statusEl.setText(invalid ? t("settings.dateHeadingFormat.invalid") : "");
			statusEl.toggleClass("is-error", invalid);
		};
		const initial = this.pendingSettingDrafts.get("monthlyDateHeadingFormat") ?? settings.monthlyDateHeadingFormat;
		if (this.pendingSettingDrafts.has("monthlyDateHeadingFormat")) showValidation(initial);
		setting.addText((text) => {
			text.inputEl.dataset.knomoSettingInput = "monthlyDateHeadingFormat";
			text.setPlaceholder(DEFAULT_MONTHLY_DATE_HEADING_FORMAT);
			text.setValue(initial);
			text.onChange((value) => {
				showValidation(value);
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

	private renderMonthlyFolderSetting(setting: Setting): void {
		setting.settingEl.addClass("knomo-settings-text-row");
		const settings = this.settingsService.getSettings();
		if (!this.monthlyFolderEditing) {
			setting
				.addText((text) => {
					text.inputEl.dataset.knomoSettingInput = "monthlyMemoFolder";
					text.setValue(settings.monthlyMemoFolder);
					text.inputEl.readOnly = true;
				})
				.addButton((button) => {
					button.setButtonText(t("settings.monthlyFolder.change"));
					button.onClick(() => {
						this.monthlyFolderEditing = true;
						this.monthlyFolderDraft = settings.monthlyMemoFolder;
						this.refreshSettingTab();
					});
				});
			return;
		}

		this.monthlyFolderDraft ??= settings.monthlyMemoFolder;
		setting
			.addText((text) => {
				text.inputEl.dataset.knomoSettingInput = "monthlyMemoFolder";
				text.setPlaceholder(DEFAULT_MONTHLY_MEMO_FOLDER);
				text.setValue(this.monthlyFolderDraft ?? settings.monthlyMemoFolder);
				text.onChange((value) => { this.monthlyFolderDraft = value; });
				new KnomoFolderSuggest(this.app, text.inputEl, (value) => { this.monthlyFolderDraft = value; });
			})
			.addButton((button) => {
				button.setButtonText(t("settings.monthlyFolder.apply"));
				button.onClick(() => {
					void (async () => {
						const saved = await this.saveMonthlyFolder(this.monthlyFolderDraft ?? settings.monthlyMemoFolder, button);
						if (!saved) return;
						this.monthlyFolderEditing = false;
						this.monthlyFolderDraft = null;
						this.refreshSettingTab();
					})();
				});
			})
			.addButton((button) => {
				button.setButtonText(t("settings.monthlyFolder.cancel"));
				button.onClick(() => {
					this.monthlyFolderEditing = false;
					this.monthlyFolderDraft = null;
					this.refreshSettingTab();
				});
			});
	}

	private renderCatalogAttentionSetting(setting: Setting): void {
		const resultEl = setting.infoEl.createDiv({ cls: "knomo-scan-result" });
		if (this.rebuildRunning) this.renderRebuildResult(t("settings.rebuild.catalogStatus"), resultEl);
		setting
			.setName(t("settings.attention.catalog.name"))
			.setDesc(t("settings.attention.catalog.desc"))
			.addButton((button) => {
				button.setButtonText(t(this.runtimeRetryRunning
					? "settings.attention.checking" : "settings.attention.checkAgain"));
				button.setDisabled(this.runtimeRetryRunning);
				button.onClick(() => { void this.runRuntimeRetry(button); });
			})
			.addButton((button) => {
				button.setButtonText(t(this.rebuildRunning ? "settings.rebuild.running" : "settings.rebuild.start"));
				button.setDisabled(this.rebuildRunning);
				button.onClick(() => {
					void this.runRebuildIndex(button, resultEl);
				});
			});
	}

	private renderMonthlyAttentionSetting(setting: Setting): void {
		const periods = this.monthlyProjectionCoordinator.getFailedPeriods();
		setting
			.setName(t("settings.attention.monthly.name"))
			.setDesc(t("settings.attention.monthly.desc", { periods: periods.join(", ") || "—" }))
			.addButton((button) => {
				button.setButtonText(t(this.monthlyRetryRunning
					? "settings.attention.retrying" : "settings.attention.retry"));
				button.setDisabled(this.monthlyRetryRunning);
				button.onClick(() => { void this.runMonthlyRetry(button); });
			});
	}

	private renderSettingsAttentionSetting(setting: Setting): void {
		setting
			.setName(t("settings.attention.settings.name"))
			.setDesc(t("settings.attention.settings.desc"))
			.addButton((button) => {
				button.setButtonText(t(this.runtimeRetryRunning
					? "settings.attention.checking" : "settings.attention.settings.retry"));
				button.setDisabled(this.runtimeRetryRunning);
				button.onClick(() => {
					void this.runRuntimeRetry(button, t("settings.attention.settings.retry"));
				});
			});
	}

	private renderLegacyMigration(setting: Setting): void {
		setting
			.setName(t("settings.legacyMigration.name"))
			.setDesc(this.getLegacyMigrationDescription());
		setting.addButton((button) => {
			button.setButtonText(t(this.legacyMigrationRunning
				? "settings.attention.retrying"
				: this.legacyTrashMigrationService.getReport().cleanupCandidate
					? "settings.legacyMigration.retryCleanup" : "settings.legacyMigration.retry"));
			button.setDisabled(this.legacyMigrationRunning);
			button.onClick(() => {
				if (this.legacyMigrationRunning) return;
				this.legacyMigrationRunning = true;
				button.setDisabled(true);
				void this.legacyTrashMigrationService.run()
					.catch(error => { new Notice(formatServiceError(error, t("settings.attention.retryFailed"))); })
					.finally(() => {
						this.legacyMigrationRunning = false;
						button.setDisabled(false);
						this.refreshSettingTab();
					});
			});
		});
	}

	private getLegacyMigrationDescription(): string {
		const report = this.legacyTrashMigrationService.getReport();
		if (report.cleanupCandidate) {
			const diagnostic = report.diagnostics[0];
			return t("settings.legacyMigration.cleanupDescription", {
				path: diagnostic?.sourcePath ?? report.cleanupCandidate.legacySystemRoot,
				reason: diagnostic?.code === "legacy_cleanup_unknown_file"
					? t("settings.legacyMigration.unknownFile") : diagnostic?.detail ?? "",
			});
		}
		return t("settings.legacyMigration.description");
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
		try {
			if (
				await this.saveDailyHeading(value, showChangedNotice)
				&& this.pendingSettingDrafts.get("dailyHeading") === value
			) this.pendingSettingDrafts.delete("dailyHeading");
		} catch (error) {
			new Notice(formatServiceError(error, t("error.saveFailed")));
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
		try {
			if (
				await this.saveMonthlyDateHeadingFormat(value)
				&& this.pendingSettingDrafts.get("monthlyDateHeadingFormat") === value
			) this.pendingSettingDrafts.delete("monthlyDateHeadingFormat");
		} catch (error) {
			new Notice(formatServiceError(error, t("error.saveFailed")));
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
		await this.refreshCurrentConfiguration();
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
		await this.refreshCurrentConfiguration();
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
			await this.refreshCurrentConfiguration();
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

	private async saveMonthlyFolder(value: string, button: ButtonComponent): Promise<boolean> {
		button.setDisabled(true);
		button.setButtonText(t("settings.monthlyFolder.saving"));
		try {
			const plan = await this.settingsService.planMonthlyMemoFolderMigration(value);
			if (plan.status !== "unchanged" && !await showKnomoConfirmModal(this.app, {
				message: t("settings.monthlyFolder.confirm", { current: plan.oldMonthlyMemoFolder, next: plan.newMonthlyMemoFolder }),
			})) return false;
			const result = await this.settingsService.migrateMonthlyMemoFolder(value);
			new Notice(result.trashError ? t("settings.monthlyFolder.trashFailed", { error: result.trashError }) : t("settings.monthlyFolder.saved"));
			await this.refreshCurrentConfiguration();
			return true;
		} catch (error) {
			new Notice(formatServiceError(error, t("settings.monthlyFolder.saveFailed")));
			return false;
		} finally {
			button.setDisabled(false);
			button.setButtonText(t("settings.monthlyFolder.apply"));
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
	): Promise<void> {
		if (this.runtimeRetryRunning) return;
		this.runtimeRetryRunning = true;
		button.setDisabled(true);
		button.setButtonText(t("settings.attention.checking"));
		try {
			await this.retryRuntimeState();
			await this.refreshOpenKnomoViews();
		} catch {
			new Notice(t("settings.attention.retryFailed"));
		} finally {
			this.runtimeRetryRunning = false;
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
		return getKnomoSettingAttentionKinds(
			this.catalogReadService.getRuntimeAttentionSnapshot(),
			this.startupBootstrapService?.getSnapshot() ?? null,
		);
	}

	private renderAttentionSetting(kind: KnomoSettingAttentionKind, setting: Setting): void {
		setting.settingEl.addClass("knomo-settings-action-row");
		switch (kind) {
			case "settings": this.renderSettingsAttentionSetting(setting); break;
			case "current-config": this.renderCurrentConfigSetting(setting); break;
			case "catalog": this.renderCatalogAttentionSetting(setting); break;
			case "monthly": this.renderMonthlyAttentionSetting(setting); break;
			case "legacy": this.renderLegacyMigration(setting); break;
		}
	}

	private getCurrentConfigDescription(): string {
		switch (this.knomoCurrentConfigService.getStatus()) {
			case "ready":
				return t("settings.currentConfig.ready");
			case "conflicted":
				return t("settings.currentConfig.conflicted");
			case "unavailable":
				return t("settings.currentConfig.unavailable");
			case "missing":
				return t("settings.currentConfig.missing");
		}
	}

	private renderCurrentConfigSetting(setting: Setting): void {
		const status = this.knomoCurrentConfigService.getStatus();

		setting
			.setName(t("settings.currentConfig.name"))
			.setDesc(this.getCurrentConfigDescription());
		if (status === "ready") return;
		setting.addButton((button) => {
			button.setButtonText(this.currentConfigRetryRunning
				? t("settings.attention.checking")
				: status === "unavailable"
					? t("settings.currentConfig.checkAgain")
					: status === "conflicted"
						? t("settings.currentConfig.resolve")
						: t("settings.currentConfig.publish"));
			button.setDisabled(this.currentConfigRetryRunning);
			button.onClick(() => {
				if (this.currentConfigRetryRunning) return;
				this.currentConfigRetryRunning = true;
				void (async () => {
					button.setDisabled(true);
					try {
						await this.knomoCurrentConfigService.reloadConfiguration();
						if (this.knomoCurrentConfigService.getStatus() !== "ready") {
							throw new Error(this.knomoCurrentConfigService.getLastError()
								?? "Current configuration did not become ready.");
						}
						new Notice(t("settings.currentConfig.saved"));
					} catch {
						new Notice(t("settings.currentConfig.failed"));
					} finally {
						this.currentConfigRetryRunning = false;
						button.setDisabled(false);
						this.refreshSettingTab();
					}
				})();
			});
		});
	}

	private async refreshCurrentConfiguration(): Promise<void> {
		try {
			await this.knomoCurrentConfigService.refreshLocalConfig();
		} catch {
			// 当前值已保存；重新加载失败由配置状态提示，不回滚已提交设置。
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
		if (this.settingsVisible && this.attentionEl?.isConnected) this.refreshAttentionRegion();
		else if (requireApiVersion("1.13.0")) this.update();
	}

	private refreshSettingTab(): void {
		if (this.settingsVisible && this.pageEl?.parentElement) {
			const focused = this.pageEl.ownerDocument.activeElement;
			const input = focused?.tagName === "INPUT" && this.pageEl.contains(focused)
				? focused as HTMLInputElement : null;
			const inputKey = input?.dataset.knomoSettingInput;
			const selectionStart = input?.selectionStart;
			const selectionEnd = input?.selectionEnd;
			const tabId = focused?.getAttribute("role") === "tab" && this.pageEl.contains(focused)
				? focused.id : null;
			const parent = this.pageEl.parentElement;
			// 重建页面会暂时缩短滚动容器，保留各层位置以避免跳回顶部。
			const scrollPositions: { element: HTMLElement; top: number; left: number }[] = [];
			for (let element: HTMLElement | null = parent; element; element = element.parentElement) {
				scrollPositions.push({ element, top: element.scrollTop, left: element.scrollLeft });
			}
			this.pageEl.remove();
			this.mountPage(parent);
			if (inputKey) {
				const restored = this.pageEl?.querySelector<HTMLInputElement>(
					`[data-knomo-setting-input="${inputKey}"]`,
				);
				restored?.focus({ preventScroll: true });
				if (restored && selectionStart !== null && selectionStart !== undefined
					&& selectionEnd !== null && selectionEnd !== undefined) {
					restored.setSelectionRange(selectionStart, selectionEnd);
				}
			} else if (tabId) this.pageEl?.querySelector<HTMLElement>(`#${tabId}`)?.focus({ preventScroll: true });
			for (const { element, top, left } of scrollPositions) {
				element.scrollTop = top;
				element.scrollLeft = left;
			}
			return;
		}
		if (requireApiVersion("1.13.0")) this.update();
		else if (this.settingsVisible) this.display();
	}

}

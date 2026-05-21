import { Notice, PluginSettingTab, Setting } from "obsidian";
import type { App, ButtonComponent, Plugin, ToggleComponent } from "obsidian";

import { DEFAULT_MONTHLY_MEMO_FOLDER, KNOMO_VIEW_TYPE } from "../constants";
import { buildMonthlyFolderExcludeRule, type ObsidianExcludeService } from "../services/ObsidianExcludeService";
import type { SettingsService } from "../services/SettingsService";
import type { RebuildIndexMode, RebuildIndexScope, SyncOrchestrator } from "../services/SyncOrchestrator";
import type { MemoRecord } from "../types/memo";
import type { DailyInsertPosition, MemoTimeFormat, MonthlyDateOrder } from "../types/settings";
import { normalizeVaultPath } from "../utils/path";
import { KnomoView } from "./KnomoView";

export class KnomoSettingTab extends PluginSettingTab {
	private issueListEl: HTMLElement | null = null;
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

		containerEl.createEl("h2", { text: "Memos" });

		new Setting(containerEl)
			.setName("写入标题")
			.setDesc("Memos 会写入当天日记中的这个标题下，例如 ## Knomo。")
			.addText((text) => {
				text.setPlaceholder("## Knomo");
				text.setValue(settings.dailyHeading);
				text.onChange((value) => {
					void this.saveDailyHeading(value);
				});
			});
		new Setting(containerEl)
			.setName("插入位置")
			.setDesc("选择新的 Memos 插入到标题下方的位置。")
			.addDropdown((dropdown) => {
				dropdown.addOption("top", "顶部");
				dropdown.addOption("bottom", "底部");
				dropdown.setValue(settings.dailyInsertPosition);
				dropdown.onChange((value) => {
					void this.settingsService.updateSettings({
						dailyInsertPosition: value as DailyInsertPosition,
					});
				});
			});
		new Setting(containerEl)
			.setName("Memo 时间格式")
			.setDesc("设置新写入 Memo 的时间显示格式；扫描会同时兼容 HH:mm 和 HH:mm:ss。")
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
			.setName("月度 Memos 文件夹")
			.setDesc("用于保存月度 Memos 文件的文件夹。")
			.addText((text) => {
				text.setPlaceholder(DEFAULT_MONTHLY_MEMO_FOLDER);
				text.setValue(settings.monthlyMemoFolder);
				text.onChange((value) => {
					monthlyFolderDraft = value;
				});
			})
			.addButton((button) => {
				button.setButtonText("保存路径");
				button.onClick(() => {
					void this.saveMonthlyFolder(monthlyFolderDraft, button);
				});
			});
		new Setting(containerEl)
			.setName("排除月度 Memos 文件夹")
			.setDesc("开启后，Knomo 会将月度 Memos 文件夹加入 Obsidian 的排除文件规则，减少月度 Memos 文件对搜索、图谱和统计结果的影响，文件依然在 Obsidian 可读。")
			.addToggle((toggle) => {
				toggle.setValue(settings.excludeMonthlyMemosFromObsidian);
				toggle.onChange((value) => {
					void this.toggleMonthlyMemosExcludeRule(value, toggle);
				});
			});
		this.monthlyExcludeStatusEl = containerEl.createDiv({ cls: "knomo-setting-help" });
		new Setting(containerEl)
			.setName("月度 Memos 文件名格式")
			.setDesc("设置自动生成的月度 Memos 文件名格式，例如 Memos-YYYY-MM.md。")
			.addText((text) => {
				text.setPlaceholder("Memos-YYYY-MM.md");
				text.setValue(settings.monthlyMemoFileFormat);
				text.onChange((value) => {
					void this.settingsService.updateSettings({ monthlyMemoFileFormat: value.trim() });
				});
			});
		new Setting(containerEl)
			.setName("日期标题格式")
			.setDesc("设置月度 Memos 文件中每天分组标题的格式，例如 ## YYYY-MM-DD。")
			.addText((text) => {
				text.setPlaceholder("## YYYY-MM-DD");
				text.setValue(settings.monthlyDateHeadingFormat);
				text.onChange((value) => {
					void this.saveMonthlyDateHeadingFormat(value);
				});
			});
		new Setting(containerEl)
			.setName("日期排序方式")
			.setDesc("设置月度 Memos 文件中日期分组的排列顺序。")
			.addDropdown((dropdown) => {
				dropdown.addOption("asc", "升序");
				dropdown.addOption("desc", "降序");
				dropdown.setValue(settings.monthlyDateOrder);
				dropdown.onChange((value) => {
					void this.settingsService.updateSettings({
						monthlyDateOrder: value as MonthlyDateOrder,
					});
				});
			});

		new Setting(containerEl)
			.setName("高级 / 数据维护")
			.setHeading();
		let rebuildScope: RebuildIndexScope = "30d";
		let rebuildMode: RebuildIndexMode = "index-only";
		new Setting(containerEl)
			.setName("重建索引")
			.setDesc("从 Daily Notes 重建 Knomo Index；可选择是否同时重新生成月度 Memos。")
			.addDropdown((dropdown) => {
				dropdown.addOption("30d", "最近 30 天");
				dropdown.addOption("90d", "最近 90 天");
				dropdown.addOption("all", "全部日记");
				dropdown.setValue(rebuildScope);
				dropdown.onChange((value) => {
					rebuildScope = value as RebuildIndexScope;
				});
			})
			.addDropdown((dropdown) => {
				dropdown.addOption("index-only", "仅重建 Index");
				dropdown.addOption("index-and-monthly", "重建 Index 并重新生成 Monthly Memos");
				dropdown.setValue(rebuildMode);
				dropdown.onChange((value) => {
					rebuildMode = value as RebuildIndexMode;
				});
			})
			.addButton((button) => {
				button.setButtonText("开始重建");
				button.onClick(() => {
					void this.runRebuildIndex(rebuildScope, rebuildMode, button);
				});
			});
		this.rebuildResultEl = containerEl.createDiv({ cls: "knomo-scan-result" });
		this.renderRebuildResult("重建前会自动备份现有系统数据目录中的索引。");
		this.issueListEl = containerEl.createDiv({ cls: "knomo-issue-list" });
		void this.renderIssueList();
	}

	private async saveDailyHeading(value: string): Promise<void> {
		const nextHeading = value.trim();
		if (!this.settingsService.validateDailyHeading(nextHeading)) {
			new Notice("写入标题必须是 1-6 级标题。");
			return;
		}
		if (nextHeading === this.settingsService.getSettings().dailyHeading) {
			return;
		}
		await this.settingsService.updateSettings({ dailyHeading: nextHeading });
		new Notice("修改日记标题只影响之后新写入的 Memos。已有日记中的 Memos 会继续按原标题解析，不会被自动迁移");
	}

	private async saveMonthlyDateHeadingFormat(value: string): Promise<void> {
		const nextFormat = value.trim();
		if (!this.settingsService.validateMarkdownHeading(nextFormat)) {
			new Notice("日期标题格式必须是 1-6 级标题。");
			return;
		}
		await this.settingsService.updateSettings({ monthlyDateHeadingFormat: nextFormat });
	}

	private async saveMonthlyFolder(value: string, button: ButtonComponent): Promise<void> {
		const monthlyMemoFolder = normalizeVaultPath(value);
		const currentSettings = this.settingsService.getSettings();
		button.setDisabled(true);
		button.setButtonText("保存中...");
		try {
			if (monthlyMemoFolder !== currentSettings.monthlyMemoFolder) {
				const plan = await this.settingsService.planMonthlyMemoFolderMigration(monthlyMemoFolder);
				if (plan.conflicts.length > 0) {
					throw new Error(`目标路径存在冲突，已停止迁移：${plan.conflicts.join("；")}`);
				}
				const confirmed = this.containerEl.win.confirm(
					`确认迁移月度 Memos 文件夹？\n\n当前文件夹：${currentSettings.monthlyMemoFolder}\n新文件夹：${monthlyMemoFolder}\n\n` +
						`将移动 ${plan.monthlyFileMoves.length} 个月度文件；` +
						`${plan.moveSystemFolder ? "将迁移系统数据目录；" : "将创建新的系统数据目录；"}` +
						`将重写 ${plan.rewrittenMonthlyRefs} 条月度引用。`,
				);
				if (!confirmed) {
					return;
				}
			}
			await this.settingsService.migrateMonthlyMemoFolder(monthlyMemoFolder);
			new Notice("月度 Memos 文件夹已保存");
		} catch (error) {
			const message = formatSettingsText(error instanceof Error ? error.message : "月度 Memos 文件夹保存失败。");
			new Notice(message);
		} finally {
			button.setDisabled(false);
			button.setButtonText("保存路径");
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
			this.setExcludeStatus("月度 Memos 文件夹路径为空，暂未写入 Obsidian 排除规则", true);
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
				? "已将月度 Memos 文件夹加入 Obsidian 排除规则"
				: "月度 Memos 文件夹已在 Obsidian 排除规则中");
		} catch {
			await this.settingsService.updateSettings({
				excludeMonthlyMemosFromObsidian: false,
				managedObsidianExcludeRule: undefined,
				managedObsidianExcludeRuleOwned: false,
			});
			new Notice(`无法自动更新 Obsidian 排除规则，请手动添加：${rule}`);
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
				new Notice(`无法自动更新 Obsidian 排除规则，请手动移除：${rule}`);
			}
		}
		await this.settingsService.updateSettings({
			excludeMonthlyMemosFromObsidian: false,
			managedObsidianExcludeRule: undefined,
			managedObsidianExcludeRuleOwned: false,
		});
		this.setExcludeStatus(removedRule
			? "已取消排除月度 Memos 文件夹"
			: "已关闭 Knomo 自动管理，原有 Obsidian 排除规则保持不变");
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
			this.setExcludeStatus("月度 Memos 文件夹路径为空，暂未写入 Obsidian 排除规则", true);
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
			new Notice(`无法自动更新 Obsidian 排除规则，请手动添加：${nextRule}`);
		}
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
		button.setButtonText("预估中...");
		try {
			const estimate = await this.syncOrchestrator.estimateRebuildIndex(scope);
			const confirmed = this.containerEl.win.confirm(
				`确认重建索引？\n\n扫描文件数：${estimate.scannedFiles}\n预计新增：${estimate.estimatedNew}\n预计更新：${estimate.estimatedUpdated}\n预计缺失：${estimate.estimatedMissing}`,
			);
			if (!confirmed) {
				this.renderRebuildResult("已取消重建。");
				return;
			}
			button.setButtonText("重建中...");
			this.renderRebuildResult("正在重建索引...");
			const result = await this.syncOrchestrator.rebuildIndex(scope, mode, (progress) => {
				this.renderRebuildResult(
					`正在重建索引：${progress.completedFiles}/${progress.scannedFiles} 个文件\n` +
						`新增 ${progress.created} 条，更新 ${progress.updated} 条，删除 ${progress.deleted} 条，跳过 ${progress.skipped} 条，失败 ${progress.failed} 条。` +
						(progress.currentFile === null ? "" : `\n当前文件：${progress.currentFile}`),
				);
			});
			const message = `重建完成：共 ${result.scannedFiles} 个文件，新增 ${result.created} 条，更新 ${result.updated} 条，删除 ${result.deleted} 条，跳过 ${result.skipped} 条，失败 ${result.failed} 条。`;
			const backup = result.backupPath === null ? "未发现现有索引可备份。" : `备份位置：${result.backupPath}`;
			this.renderRebuildResult(`${message}\n${backup}`);
			await this.renderIssueList();
			await this.refreshOpenKnomoViews();
			new Notice("Knomo 索引重建完成");
		} catch (error) {
			const message = formatSettingsText(error instanceof Error ? error.message : "重建索引失败。");
			this.renderRebuildResult(message);
			new Notice(message);
		} finally {
			this.rebuildRunning = false;
			button.setDisabled(false);
			button.setButtonText("开始重建");
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

	private async renderIssueList(): Promise<void> {
		if (this.issueListEl === null) {
			return;
		}
		this.issueListEl.empty();
		try {
			const memos = await this.syncOrchestrator.listIssueMemos();
			if (memos.length === 0) {
				this.issueListEl.createDiv({ cls: "knomo-setting-help", text: "当前没有同步问题。" });
				return;
			}
			for (const memo of memos) {
				this.renderIssueItem(memo);
			}
		} catch (error) {
			this.issueListEl.createDiv({
				cls: "knomo-setting-help is-error",
				text: formatSettingsText(error instanceof Error ? error.message : "同步问题列表加载失败。"),
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
			text: formatSettingsText(memo.issue?.message ?? "同步状态需要处理。"),
		});
		if (memo.syncStatus === "monthly_delete_failed") {
			const button = item.createEl("button", {
				cls: "mod-cta",
				text: "重试月度删除",
				attr: { type: "button" },
			});
			button.addEventListener("click", () => {
				void this.retryMonthlyDelete(memo, button);
			});
		} else if (memo.syncStatus === "monthly_failed" || memo.issue?.type === "monthly_block_missing" || memo.issue?.type === "monthly_sync_failed") {
			const button = item.createEl("button", {
				cls: "mod-cta",
				text: "重试月度同步",
				attr: { type: "button" },
			});
			button.addEventListener("click", () => {
				void this.retryMonthlySync(memo, button);
			});
		}
	}

	private async retryMonthlyDelete(memo: MemoRecord, button: HTMLButtonElement): Promise<void> {
		button.disabled = true;
		button.setText("重试中...");
		try {
			await this.syncOrchestrator.retryMonthlyDelete(memo);
			await this.renderIssueList();
			await this.refreshOpenKnomoViews();
			new Notice("月度删除重试完成");
		} catch (error) {
			new Notice(formatSettingsText(error instanceof Error ? error.message : "月度删除重试失败。"));
		} finally {
			button.disabled = false;
			button.setText("重试月度删除");
		}
	}

	private async retryMonthlySync(memo: MemoRecord, button: HTMLButtonElement): Promise<void> {
		button.disabled = true;
		button.setText("重试中...");
		try {
			await this.syncOrchestrator.retryMonthlySync(memo);
			await this.renderIssueList();
			await this.refreshOpenKnomoViews();
			new Notice("月度同步重试完成");
		} catch (error) {
			new Notice(formatSettingsText(error instanceof Error ? error.message : "月度同步重试失败。"));
		} finally {
			button.disabled = false;
			button.setText("重试月度同步");
		}
	}
}

export function formatSettingsText(text: string): string {
	return text
		.replace(/\bmemo-index\b/gi, "Memos 索引")
		.replace(/\bmemo block\b/gi, "Memos 内容块")
		.replace(/\bmemo index\b/gi, "Memos 索引")
		.replace(/\bmemoId\b/g, "Memos ID")
		.replace(/\bmemo\b|\bMemo\b|\bMEMO\b/g, "Memos")
		.replace(/\bdaily block\b/gi, "日记内容块")
		.replace(/\bmonthly block\b/gi, "月度归档内容块")
		.replace(/\bblockId\b/g, "块 ID")
		.replace(/\bblock\b/gi, "块")
		.replace(/_knomo-system/g, "系统数据目录");
}

function getSyncStatusLabel(status: MemoRecord["syncStatus"]): string {
	if (status === "synced") {
		return "已同步";
	}
	if (status === "pending_monthly") {
		return "等待月度 Memos 同步";
	}
	if (status === "monthly_failed") {
		return "月度 Memos 同步失败";
	}
	return "月度 Memos 删除失败";
}

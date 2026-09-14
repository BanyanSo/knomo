import { moment as obsidianMoment, normalizePath, TFile } from "obsidian";
import type { App } from "obsidian";

import { KnomoError } from "../types/serviceError";
import { ensureTextFile } from "../utils/vault";

// 职责：检查日记核心插件状态，并在后续定位或创建当天日记文件。
export interface DailyNotesStatus {
	enabled: boolean;
	folder: string | null;
	format: string | null;
	message: string;
}

export interface DailyNotesConfig {
	folder: string | null;
	format: string;
	template?: string;
}

export interface DailyNotesConfigProvider {
	getConfig(): DailyNotesConfig | null;
	loadConfig(): Promise<DailyNotesConfig | null>;
}

interface MomentFormatter {
	format(format: string): string;
}

type MomentFactory = (input?: Date) => MomentFormatter;

export class DailyNoteService {
	constructor(
		private readonly app: App,
		private readonly dailyNotesConfigProvider: DailyNotesConfigProvider | null = null,
	) {}

	getStatus(): DailyNotesStatus {
		const config = this.dailyNotesConfigProvider?.getConfig() ?? null;
		return createStatus(config);
	}

	async refreshStatus(): Promise<DailyNotesStatus> {
		const config = (await this.dailyNotesConfigProvider?.loadConfig()) ?? null;
		return createStatus(config);
	}

	async getFreshStatus(): Promise<DailyNotesStatus> {
		const config = (await this.dailyNotesConfigProvider?.loadConfig()) ?? null;
		return createStatus(config);
	}

	async getOrCreateDailyNoteForDate(date: Date): Promise<TFile> {
		return this.getOrCreateDailyNoteForDateWithConfig(date, await this.getDailyNotesConfig());
	}

	async getOrCreateDailyNoteForDateWithConfig(date: Date, config: DailyNotesConfig): Promise<TFile> {
		const path = this.getDailyNotePathForDateWithConfig(date, config);
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) return existing;
		if (existing !== null) throw new Error(`Path exists and is not a file: ${path}`);
		const templatePath = config.template?.trim();
		let content = "";
		if (templatePath) {
			const template = this.app.vault.getAbstractFileByPath(normalizePath(ensureMarkdownExtension(templatePath)));
			if (!(template instanceof TFile)) throw new Error(`Daily note template is unavailable: ${templatePath}`);
			const text = await this.app.vault.read(template);
			const momentFactory = obsidianMoment as unknown as MomentFactory;
			const now = new Date();
			const templateDate = new Date(date);
			templateDate.setHours(now.getHours(), now.getMinutes(), now.getSeconds(), now.getMilliseconds());
			const title = path.slice(path.lastIndexOf("/") + 1, -3);
			// 日期使用目标日记的日期，时间使用创建时刻；只替换核心模板变量。
			content = text.replace(/{{\s*(date|time|title)\s*(?::([^}]+))?}}/gi,
				(match: string, variable: string, format: string | undefined) => {
					const kind = variable.toLowerCase();
					if (kind === "title") return format === undefined ? title : match;
					const pattern = format?.trim() || (kind === "date" ? config.format : "HH:mm");
					return momentFactory(templateDate).format(pattern);
				});
		}
		// ensureTextFile 会重新确认目标，保留读取模板期间由其他操作创建的正文。
		return ensureTextFile(this.app, path, content);
	}

	getDailyNotePathForDate(date: Date, status = this.getStatus()): string {
		if (!status.enabled || status.format === null) {
			throw new KnomoError("daily_notes_unavailable");
		}
		const momentFactory = obsidianMoment as unknown as MomentFactory;
		const fileName = ensureMarkdownExtension(momentFactory(date).format(status.format));
		if (status.folder === null || status.folder.trim().length === 0) {
			return normalizePath(fileName);
		}
		return normalizePath(`${status.folder}/${fileName}`);
	}

	getDailyNotePathForDateWithConfig(date: Date, config: DailyNotesConfig): string {
		const momentFactory = obsidianMoment as unknown as MomentFactory;
		const fileName = ensureMarkdownExtension(momentFactory(date).format(config.format));
		return config.folder === null || config.folder.trim().length === 0
			? normalizePath(fileName)
			: normalizePath(`${config.folder}/${fileName}`);
	}

	async getDailyNotesConfig(): Promise<DailyNotesConfig> {
		const config = (await this.dailyNotesConfigProvider?.loadConfig()) ?? null;
		if (config === null) throw new KnomoError("daily_notes_disabled");
		return config;
	}

	getTodayDailyNotePath(status = this.getStatus()): string {
		return this.getDailyNotePathForDate(new Date(), status);
	}

}

function createStatus(config: DailyNotesConfig | null): DailyNotesStatus {
	if (config === null) {
		return {
			enabled: false,
			folder: null,
			format: null,
			message: "Enable the Daily Notes core plugin in Obsidian settings. Knomo will read the Daily Notes settings automatically; you do not need to configure the daily note path in Knomo.",
		};
	}

	return {
		enabled: true,
		folder: config.folder,
		format: config.format,
		message: "Daily Notes core plugin is enabled.",
	};
}

function ensureMarkdownExtension(fileName: string): string {
	return fileName.endsWith(".md") ? fileName : `${fileName}.md`;
}

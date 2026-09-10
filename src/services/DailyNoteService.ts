import { createDailyNote } from "obsidian-daily-notes-interface";
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
		const status = await this.getFreshStatus();
		if (!status.enabled) {
			throw new KnomoError("daily_notes_disabled");
		}
		const path = this.getDailyNotePathForDate(date, status);
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) {
			return existing;
		}

		try {
			const momentFactory = obsidianMoment as unknown as MomentFactory;
			const createdFile = await createDailyNote(momentFactory(date) as Parameters<typeof createDailyNote>[0]);
			if (createdFile instanceof TFile) {
				return createdFile;
			}
		} catch {
			// Daily Notes 可能在移动端或异常配置下失败；继续走本地兜底创建。
		}

		return ensureTextFile(this.app, path);
	}

	async getOrCreateDailyNoteForDateWithConfig(date: Date, config: DailyNotesConfig): Promise<TFile> {
		const path = this.getDailyNotePathForDateWithConfig(date, config);
		const existing = this.app.vault.getAbstractFileByPath(path);
		return existing instanceof TFile ? existing : ensureTextFile(this.app, path);
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
		const status = await this.getFreshStatus();
		if (!status.enabled || status.format === null) {
			throw new KnomoError("daily_notes_disabled");
		}
		return {
			folder: status.folder,
			format: status.format,
		};
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

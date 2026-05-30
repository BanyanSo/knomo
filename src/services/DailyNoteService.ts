import { createDailyNote } from "obsidian-daily-notes-interface";
import { moment as obsidianMoment, normalizePath, TFile } from "obsidian";
import type { App } from "obsidian";

import type { DailyRef } from "../types/memo";
import type { KnomoSettings } from "../types/settings";
import { findLineNumber } from "../utils/markdown";
import { buildDailyRef } from "../utils/memoRefs";
import { ensureTextFile } from "../utils/vault";
import { MarkdownBlockService } from "./MarkdownBlockService";

// 职责：检查日记核心插件状态，并在后续定位或创建当天日记文件。
export interface DailyNotesStatus {
	enabled: boolean;
	folder: string | null;
	format: string | null;
	message: string;
}

export interface DailyNoteWriteResult {
	file: TFile;
	ref: DailyRef;
	content: string;
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
		private readonly markdownBlockService = new MarkdownBlockService(),
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
			throw new Error(status.message);
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
			console.warn("Knomo: Daily Notes interface did not return a file; falling back to Knomo daily note creation.");
		} catch (error) {
			console.error("Knomo: Daily Notes interface failed to create a daily note; falling back to Knomo daily note creation.", error);
		}

		return ensureTextFile(this.app, path);
	}

	getDailyNotePathForDate(date: Date, status = this.getStatus()): string {
		if (!status.enabled || status.format === null) {
			throw new Error("日记核心插件不可用，无法定位日记。");
		}
		const momentFactory = obsidianMoment as unknown as MomentFactory;
		const fileName = ensureMarkdownExtension(momentFactory(date).format(status.format));
		if (status.folder === null || status.folder.trim().length === 0) {
			return normalizePath(fileName);
		}
		return normalizePath(`${status.folder}/${fileName}`);
	}

	async getDailyNotesConfig(): Promise<DailyNotesConfig> {
		const status = await this.getFreshStatus();
		if (!status.enabled || status.format === null) {
			throw new Error(status.message);
		}
		return {
			folder: status.folder,
			format: status.format,
		};
	}

	async getOrCreateTodayDailyNote(): Promise<TFile> {
		return this.getOrCreateDailyNoteForDate(new Date());
	}

	getTodayDailyNotePath(status = this.getStatus()): string {
		return this.getDailyNotePathForDate(new Date(), status);
	}

	async insertMemoBlock(settings: KnomoSettings, block: string, trailer?: string): Promise<DailyNoteWriteResult> {
		const file = await this.getOrCreateTodayDailyNote();
		const combinedBlock = trailer ? block + "\n" + trailer : block;
		const content = await this.app.vault.process(file, (currentContent) =>
			this.markdownBlockService.insertMemoBlock(currentContent, {
				heading: settings.dailyHeading,
				block: combinedBlock,
				position: settings.dailyInsertPosition,
				createHeadingIfMissing: true,
			}),
		);
		return {
			file,
			content,
			ref: buildDailyRef(
				file.path,
				settings.dailyHeading,
				block,
				findLineNumber(content, block, settings.dailyInsertPosition === "bottom"),
			),
		};
	}

}

function createStatus(config: DailyNotesConfig | null): DailyNotesStatus {
	if (config === null) {
		return {
			enabled: false,
			folder: null,
			format: null,
			message: "请先在 Obsidian 设置的核心插件中开启“日记”。开启后 Knomo 会自动读取日记设置，不需要在 Knomo 中配置日记路径。",
		};
	}

	return {
		enabled: true,
		folder: config.folder,
		format: config.format,
		message: "日记核心插件已启用。",
	};
}

function ensureMarkdownExtension(fileName: string): string {
	return fileName.endsWith(".md") ? fileName : `${fileName}.md`;
}

import { createDailyNote } from "obsidian-daily-notes-interface";
import { moment as obsidianMoment, normalizePath, TFile } from "obsidian";
import type { App } from "obsidian";

import type { DailyRef } from "../types/memo";
import type { PreparedDailyMemoWrite } from "../types/pending";
import { PendingMemoWriteConflictError } from "../types/pending";
import type { KnomoSettings } from "../types/settings";
import { KnomoError } from "../types/serviceError";
import { findLineNumber } from "../utils/markdown";
import { hashText } from "../utils/hash";
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

export interface DailyNotePreparedWriteResult extends DailyNoteWriteResult {
	changed: boolean;
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

	async prepareMemoBlockInsert(
		settings: KnomoSettings,
		createdAt: Date,
		block: string,
		trailer?: string,
	): Promise<PreparedDailyMemoWrite> {
		const file = await this.getOrCreateDailyNoteForDate(createdAt);
		const beforeContent = await this.app.vault.cachedRead(file);
		const afterContent = this.buildInsertedMemoContent(beforeContent, settings, block, trailer);
		return {
			path: file.path,
			beforeHash: hashText(beforeContent),
			afterHash: hashText(afterContent),
			blockOccurrencesBefore: this.countMemoBlockOccurrences(beforeContent, block),
			ref: buildDailyRef(
				file.path,
				settings.dailyHeading,
				block,
				findLineNumber(afterContent, block, settings.dailyInsertPosition === "bottom"),
			),
		};
	}

	async commitPreparedMemoBlock(
		settings: KnomoSettings,
		block: string,
		prepared: PreparedDailyMemoWrite,
		trailer?: string,
	): Promise<DailyNotePreparedWriteResult> {
		const file = this.app.vault.getAbstractFileByPath(prepared.path);
		if (!(file instanceof TFile)) {
			throw new PendingMemoWriteConflictError(`Prepared daily note does not exist: ${prepared.path}`);
		}
		let changed = false;
		const content = await this.app.vault.process(file, (currentContent) => {
			const currentHash = hashText(currentContent);
			if (currentHash === prepared.afterHash) {
				return currentContent;
			}
			if (currentHash !== prepared.beforeHash) {
				const occurrenceCount = this.countMemoBlockOccurrences(currentContent, block);
				if (occurrenceCount === prepared.blockOccurrencesBefore + 1) {
					return currentContent;
				}
				throw new PendingMemoWriteConflictError(`Daily note changed during pending memo create: ${prepared.path}`);
			}
			const nextContent = this.buildInsertedMemoContent(currentContent, settings, block, trailer);
			if (hashText(nextContent) !== prepared.afterHash) {
				throw new PendingMemoWriteConflictError(`Prepared daily note content no longer matches: ${prepared.path}`);
			}
			changed = true;
			return nextContent;
		});
		return {
			file,
			content,
			ref: prepared.ref,
			changed,
		};
	}

	private buildInsertedMemoContent(
		currentContent: string,
		settings: KnomoSettings,
		block: string,
		trailer?: string,
	): string {
		const combinedBlock = trailer ? block + "\n" + trailer : block;
		return this.markdownBlockService.insertMemoBlock(currentContent, {
			heading: settings.dailyHeading,
			block: combinedBlock,
			position: settings.dailyInsertPosition,
			createHeadingIfMissing: true,
		});
	}

	private countMemoBlockOccurrences(content: string, block: string): number {
		return this.markdownBlockService.parseMemoBlocks(content)
			.filter((candidate) => candidate.rawBlock === block)
			.length;
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

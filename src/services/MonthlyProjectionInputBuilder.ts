import { TFile } from "obsidian";
import type { App } from "obsidian";

import type { MemoObservation } from "../types/catalog";
import { formatDatePart } from "../utils/date";
import { parseDailyNoteDateFromPath } from "../utils/dailyNotes";
import { canonicalJson, sha256Text } from "./CanonicalJson";
import {
	getMonthlyArchivePath,
	getMonthlyCanonicalPeriod,
} from "./MonthlyProjection";
import type { MonthlyProjectionSettings } from "./MonthlyProjection";
import type { DailyNotesConfig } from "./DailyNoteService";
import { DiaryMemoParser } from "./DiaryMemoParser";

export interface MonthlyProjectionBuildResult {
	period: string;
	observations: MemoObservation[];
	settings: MonthlyProjectionSettings;
	sourceDigest: string;
	sourcePaths: string[];
}

export interface MonthlyProjectionInputBuilderOptions {
	getDailyConfig: () => DailyNotesConfig | Promise<DailyNotesConfig>;
	getSettings: () => MonthlyProjectionSettings;
}

// 职责：从实际 Daily 文件构造完整月份输入；Catalog 和 identity state 不参与正向数据选择。
export class MonthlyProjectionInputBuilder {
	constructor(
		private readonly app: App,
		private readonly parser: DiaryMemoParser,
		private readonly options: MonthlyProjectionInputBuilderOptions,
	) {}

	async listPeriods(): Promise<string[]> {
		const dailyConfig = await this.options.getDailyConfig();
		const settings = this.getSettings();
		const periods = new Set<string>();
		for (const file of this.app.vault.getMarkdownFiles()) {
			const date = parseDailyNoteDateFromPath(file.path, dailyConfig);
			if (date !== null) periods.add(formatDatePart(date).slice(0, 7));
			const monthlyPeriod = getMonthlyCanonicalPeriod(settings, file.path);
			if (monthlyPeriod !== null) periods.add(monthlyPeriod);
		}
		return [...periods].sort();
	}

	async build(period: string): Promise<MonthlyProjectionBuildResult> {
		assertPeriod(period);
		const dailyConfig = await this.options.getDailyConfig();
		const settings = this.getSettings();
		const dailyFiles = this.app.vault.getMarkdownFiles().flatMap((file) => {
			const date = parseDailyNoteDateFromPath(file.path, dailyConfig);
			if (date === null) return [];
			const logicalDate = formatDatePart(date);
			return logicalDate.startsWith(`${period}-`) ? [{ file, logicalDate }] : [];
		}).sort((left, right) => compareText(left.file.path, right.file.path));
		const parsedFiles: Array<{
			sourcePath: string;
			logicalDate: string;
			sourceRevision: string;
			observationCount: number;
		}> = [];
		const observations: MemoObservation[] = [];
		for (const { file, logicalDate } of dailyFiles) {
			if (!(file instanceof TFile)) continue;
			const parsed = await this.parser.parse({
				sourcePath: file.path,
				logicalDate,
				bytes: new Uint8Array(await this.app.vault.readBinary(file)),
			});
			parsedFiles.push({
				sourcePath: file.path,
				logicalDate,
				sourceRevision: parsed.sourceRevision,
				observationCount: parsed.observations.length,
			});
			observations.push(...parsed.observations);
		}
		const sourceDigest = await sha256Text(canonicalJson({
			period,
			daily: { config: dailyConfig, files: parsedFiles },
			monthly: settings,
			targetPath: getMonthlyArchivePath(settings, period),
		}));
		return {
			period,
			observations,
			settings,
			sourceDigest,
			sourcePaths: parsedFiles.map((file) => file.sourcePath),
		};
	}

	getMonthlyPeriod(path: string): string | null {
		return getMonthlyCanonicalPeriod(this.getSettings(), path);
	}

	async getDailyPeriod(path: string): Promise<string | null> {
		const date = parseDailyNoteDateFromPath(path, await this.options.getDailyConfig());
		return date === null ? null : formatDatePart(date).slice(0, 7);
	}

	private getSettings(): MonthlyProjectionSettings {
		const settings = this.options.getSettings();
		return {
			monthlyMemoFolder: settings.monthlyMemoFolder,
			monthlyMemoFileFormat: settings.monthlyMemoFileFormat,
			monthlyDateHeadingFormat: settings.monthlyDateHeadingFormat,
			monthlyDateOrder: settings.monthlyDateOrder,
			locale: settings.locale,
		};
	}
}

function assertPeriod(period: string): void {
	if (!/^\d{4}-(?:0[1-9]|1[0-2])$/u.test(period)) throw new Error(`Invalid Monthly period: ${period}`);
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

import { TFile } from "obsidian";
import type { App } from "obsidian";

import type { MemoObservation } from "../types/catalog";
import type { KnomoSettings } from "../types/settings";
import { formatDatePart } from "../utils/date";
import { parseDailyNoteDateFromPath } from "../utils/dailyNotes";
import { canonicalJson, sha256Text } from "./CanonicalJson";
import {
	MONTHLY_RENDERER_VERSION,
	getMonthlyArchivePath,
	getMonthlyCanonicalPeriod,
} from "./MonthlyProjection";
import type { DailyNotesConfig } from "./DailyNoteService";
import { DiaryMemoParser } from "./DiaryMemoParser";

type MonthlyProjectionSettings = Pick<
	KnomoSettings,
	"monthlyMemoFolder" | "monthlyMemoFileFormat" | "monthlyDateHeadingFormat" | "monthlyDateOrder"
>;

export interface MonthlyProjectionBuildResult {
	period: string;
	observations: MemoObservation[];
	settings: MonthlyProjectionSettings;
	rendererVersion: number;
	sourceDigest: string;
	sourcePaths: string[];
}

export interface MonthlyProjectionInputBuilderOptions {
	getDailyConfig: () => DailyNotesConfig | Promise<DailyNotesConfig>;
	getHeadings: () => readonly string[];
	getSettings: () => MonthlyProjectionSettings;
	getRendererVersion?: () => number;
}

// 职责：从实际 Daily 文件构造完整月份输入；Catalog 和 identity state 不参与正向数据选择。
export class MonthlyProjectionInputBuilder {
	private readonly getRendererVersion: () => number;

	constructor(
		private readonly app: App,
		private readonly parser: DiaryMemoParser,
		private readonly options: MonthlyProjectionInputBuilderOptions,
	) {
		this.getRendererVersion = options.getRendererVersion ?? (() => MONTHLY_RENDERER_VERSION);
	}

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
		const headings = [...new Set(this.options.getHeadings().map((heading) => heading.trim()).filter(Boolean))].sort();
		const settings = this.getSettings();
		const rendererVersion = this.getRendererVersion();
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
				headings,
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
			rendererVersion,
			daily: { config: dailyConfig, headings, files: parsedFiles },
			monthly: settings,
			targetPath: getMonthlyArchivePath(settings, period),
		}));
		return {
			period,
			observations,
			settings,
			rendererVersion,
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
		};
	}
}

function assertPeriod(period: string): void {
	if (!/^\d{4}-(?:0[1-9]|1[0-2])$/u.test(period)) throw new Error(`Invalid Monthly period: ${period}`);
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

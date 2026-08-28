import { TFile, TFolder, normalizePath } from "obsidian";
import type { App } from "obsidian";

import type { CatalogInventoryEntry, MemoObservation } from "../types/catalog";
import { formatDatePart } from "../utils/date";
import { parseDailyNoteDateFromPath } from "../utils/dailyNotes";
import { canonicalJson, sha256Text } from "./CanonicalJson";
import {
	getMonthlyArchivePath,
	getMonthlyCanonicalPeriod,
	hasKnomoMonthlyArchiveMarker,
} from "./MonthlyProjection";
import type { MonthlyProjectionSettings } from "./MonthlyProjection";
import type { DailyNotesConfig } from "./DailyNoteService";
import { DailyInventoryIndex, buildDailyInventoryScopeKey } from "./DailyInventoryIndex";
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
	dailyInventory?: DailyInventoryIndex;
}

export interface MonthlyProjectionConfigurationSnapshot {
	dailyScopeKey: string;
	renderFingerprint: string;
	dailyPeriods: string[];
}

// 职责：从实际 Daily 文件构造完整月份输入；Catalog 和 identity state 不参与正向数据选择。
export class MonthlyProjectionInputBuilder {
	private readonly dailyInventory: DailyInventoryIndex;

	constructor(
		private readonly app: App,
		private readonly parser: DiaryMemoParser,
		private readonly options: MonthlyProjectionInputBuilderOptions,
	) {
		this.dailyInventory = options.dailyInventory ?? new DailyInventoryIndex();
	}

	async listPeriods(): Promise<string[]> {
		return [...new Set([
			...await this.listDailyPeriods(),
			...await this.listOwnedMonthlyPeriods(),
		])].sort();
	}

	async listDailyPeriods(): Promise<string[]> {
		await this.ensureDailyInventory();
		return this.dailyInventory.listPeriods();
	}

	async listOwnedMonthlyPeriods(): Promise<string[]> {
		const settings = this.getSettings();
		const periods: string[] = [];
		for (const file of this.listMonthlyFiles(settings)) {
			const monthlyPeriod = getMonthlyCanonicalPeriod(settings, file.path);
			if (monthlyPeriod === null) continue;
			const content = await this.app.vault.cachedRead(file);
			if (hasKnomoMonthlyArchiveMarker(content)) periods.push(monthlyPeriod);
		}
		return [...new Set(periods)].sort();
	}

	async build(period: string): Promise<MonthlyProjectionBuildResult> {
		assertPeriod(period);
		const dailyConfig = await this.ensureDailyInventory();
		const settings = this.getSettings();
		const parsedFiles: Array<{
			sourcePath: string;
			logicalDate: string;
			sourceRevision: string;
			observationCount: number;
		}> = [];
		const observations: MemoObservation[] = [];
		for (const { sourcePath, logicalDate } of this.dailyInventory.listPeriod(period)) {
			const file = this.app.vault.getAbstractFileByPath(sourcePath);
			if (!(file instanceof TFile)) continue;
			const parsed = await this.parser.parse({
				sourcePath,
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

	getTargetPath(period: string): string {
		assertPeriod(period);
		return getMonthlyArchivePath(this.getSettings(), period);
	}

	async initializeInventory(): Promise<void> {
		await this.ensureDailyInventory();
	}

	async getConfigurationSnapshot(): Promise<MonthlyProjectionConfigurationSnapshot> {
		const dailyConfig = await this.ensureDailyInventory();
		return {
			dailyScopeKey: buildDailyInventoryScopeKey(dailyConfig),
			renderFingerprint: JSON.stringify(this.getSettings()),
			dailyPeriods: this.dailyInventory.listPeriods(),
		};
	}

	hasDailyPeriod(period: string): boolean {
		return this.dailyInventory.hasPeriod(period);
	}

	async updateDailyFile(file: TFile): Promise<string[]> {
		const dailyConfig = await this.ensureDailyInventory();
		const previous = this.dailyInventory.get(file.path);
		const date = parseDailyNoteDateFromPath(file.path, dailyConfig);
		if (date === null) {
			this.dailyInventory.remove(file.path);
			return previous === null ? [] : [previous.logicalDate.slice(0, 7)];
		}
		const logicalDate = formatDatePart(date);
		this.dailyInventory.upsert(toInventoryEntry(file, logicalDate));
		return [...new Set([
			previous?.logicalDate.slice(0, 7),
			logicalDate.slice(0, 7),
		].filter((period): period is string => period !== undefined))];
	}

	async removeDailyPath(path: string): Promise<string[]> {
		const dailyConfig = await this.ensureDailyInventory();
		const removed = this.dailyInventory.remove(path);
		if (removed !== null) return [removed.logicalDate.slice(0, 7)];
		const date = parseDailyNoteDateFromPath(path, dailyConfig);
		return date === null ? [] : [formatDatePart(date).slice(0, 7)];
	}

	async getDailyPeriod(path: string): Promise<string | null> {
		const date = parseDailyNoteDateFromPath(path, await this.options.getDailyConfig());
		return date === null ? null : formatDatePart(date).slice(0, 7);
	}

	private async ensureDailyInventory(): Promise<DailyNotesConfig> {
		const dailyConfig = await this.options.getDailyConfig();
		const scopeKey = buildDailyInventoryScopeKey(dailyConfig);
		if (this.dailyInventory.hasScope(scopeKey)) return dailyConfig;
		const entries = this.app.vault.getMarkdownFiles().flatMap((file) => {
			const date = parseDailyNoteDateFromPath(file.path, dailyConfig);
			return date === null ? [] : [toInventoryEntry(file, formatDatePart(date))];
		});
		this.dailyInventory.replace(entries, scopeKey);
		return dailyConfig;
	}

	private listMonthlyFiles(settings: MonthlyProjectionSettings): TFile[] {
		const examplePath = getMonthlyArchivePath(settings, "2000-01");
		const separatorIndex = examplePath.lastIndexOf("/");
		const folderPath = separatorIndex === -1 ? "" : examplePath.slice(0, separatorIndex);
		const folder = this.app.vault.getAbstractFileByPath(normalizePath(folderPath));
		return folder instanceof TFolder
			? folder.children.filter((child): child is TFile => child instanceof TFile)
			: [];
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

function toInventoryEntry(file: TFile, logicalDate: string): CatalogInventoryEntry {
	return {
		sourcePath: normalizePath(file.path),
		logicalDate,
		mtime: file.stat.mtime,
		size: file.stat.size,
	};
}

function assertPeriod(period: string): void {
	if (!/^\d{4}-(?:0[1-9]|1[0-2])$/u.test(period)) throw new Error(`Invalid Monthly period: ${period}`);
}

import type { MemoRecord } from "../types/memo";
import type { KnomoSettings } from "../types/settings";
import { formatMonthPeriod } from "../utils/date";
import type { MemoIndexStore } from "./MemoIndexStore";
import type { PreparedRecordStats } from "./RecordStatsService";
import { RecordStatsBuilder } from "./RecordStatsService";

type GetSettings = () => KnomoSettings;

export interface MemoListPageOptions {
	limit?: number;
	offset?: number;
}

export interface DeletedMemoSummary {
	count: number;
	ids: string[];
}

export class MemoQueryService {
	constructor(
		private readonly getSettings: GetSettings,
		private readonly memoIndexStore: MemoIndexStore,
	) {}

	async listRecentMemos(): Promise<MemoRecord[]> {
		const settings = this.getSettings();
		const periods = getRecentMemoPeriods();
		const memos = await this.memoIndexStore.loadExistingPeriods(settings.monthlyMemoFolder, periods);
		return memos
			.filter((memo) => memo.status === "active")
			.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
	}

	listMemoIndexPeriods(): string[] {
		const settings = this.getSettings();
		return this.memoIndexStore.listExistingPeriods(settings.monthlyMemoFolder);
	}

	listStoredMemoIndexPeriods(): string[] {
		const settings = this.getSettings();
		return this.memoIndexStore.listStoredPeriods(settings.monthlyMemoFolder);
	}

	async listMemosInPeriods(periods: string[]): Promise<MemoRecord[]> {
		const settings = this.getSettings();
		const memos = await this.memoIndexStore.loadExistingPeriods(settings.monthlyMemoFolder, periods);
		return memos
			.filter((memo) => memo.status === "active")
			.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
	}

	async listMemos(): Promise<MemoRecord[]> {
		const memos = await this.collectMemos((memo) => memo.status === "active");
		return memos
			.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
	}

	async getDeletedMemoSummary(): Promise<DeletedMemoSummary> {
		let count = 0;
		const ids: string[] = [];
		await this.scanAllMemos((_period, memos) => {
			for (const memo of memos) {
				if (memo.status !== "deleted") {
					continue;
				}
				count += 1;
				ids.push(memo.id);
			}
		});
		return { count, ids };
	}

	async listDeletedMemos(options: MemoListPageOptions = {}): Promise<MemoRecord[]> {
		const memos = await this.collectMemos((memo) => memo.status === "deleted");
		return applyPage(memos.sort(compareDeletedMemos), options);
	}

	async listIssueMemos(options: MemoListPageOptions = {}): Promise<MemoRecord[]> {
		const memos = await this.collectMemos(isIssueMemo);
		return applyPage(
			memos.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
			options,
		);
	}

	async buildRecordStats(
		yieldToUi: () => Promise<void>,
		isCurrent: () => boolean,
	): Promise<PreparedRecordStats | null> {
		const builder = new RecordStatsBuilder();
		const completed = await this.scanAllMemos(async (_period, memos) => {
			if (!isCurrent()) {
				return false;
			}
			builder.addMemos(memos);
			await yieldToUi();
			return isCurrent();
		});
		return completed && isCurrent() ? builder.build() : null;
	}

	private async collectMemos(predicate: (memo: MemoRecord) => boolean): Promise<MemoRecord[]> {
		const collected: MemoRecord[] = [];
		await this.scanAllMemos((_period, memos) => {
			for (const memo of memos) {
				if (predicate(memo)) {
					collected.push(memo);
				}
			}
		});
		return collected;
	}

	private async scanAllMemos(
		visitor: (period: string, memos: readonly MemoRecord[]) => boolean | void | Promise<boolean | void>,
	): Promise<boolean> {
		const settings = this.getSettings();
		return this.memoIndexStore.scanAllExisting(settings.monthlyMemoFolder, visitor);
	}
}

export function getRecentMemoPeriods(now = new Date()): string[] {
	return [
		formatMonthPeriod(now),
		formatMonthPeriod(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
	];
}

function isIssueMemo(memo: MemoRecord): boolean {
	return memo.issue !== null || memo.syncStatus !== "synced";
}

function applyPage<T>(items: T[], options: MemoListPageOptions): T[] {
	const offset = Math.max(0, options.offset ?? 0);
	if (options.limit === undefined) {
		return offset === 0 ? items : items.slice(offset);
	}
	const limit = Math.max(0, options.limit);
	return items.slice(offset, offset + limit);
}

function compareDeletedMemos(left: MemoRecord, right: MemoRecord): number {
	if (left.deletedAt === undefined && right.deletedAt === undefined) {
		return right.createdAt.localeCompare(left.createdAt);
	}
	if (left.deletedAt === undefined) {
		return 1;
	}
	if (right.deletedAt === undefined) {
		return -1;
	}
	return right.deletedAt.localeCompare(left.deletedAt) || right.createdAt.localeCompare(left.createdAt);
}

import type { MemoRecord } from "../types/memo";
import type { KnomoSettings } from "../types/settings";
import { formatMonthPeriod } from "../utils/date";
import type { MemoIndexStore } from "./MemoIndexStore";

type GetSettings = () => KnomoSettings;

export class MemoQueryService {
	constructor(
		private readonly getSettings: GetSettings,
		private readonly memoIndexStore: MemoIndexStore,
	) {}

	async listCurrentMonthMemos(): Promise<MemoRecord[]> {
		const settings = this.getSettings();
		const period = formatMonthPeriod(new Date());
		const index = await this.memoIndexStore.loadPeriod(settings.monthlyMemoFolder, period);
		return Object.values(index.memos)
			.filter((memo) => memo.status === "active")
			.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
	}

	async listRecentMemos(): Promise<MemoRecord[]> {
		const settings = this.getSettings();
		const now = new Date();
		const periods = [
			formatMonthPeriod(now),
			formatMonthPeriod(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
		];
		const memos = await this.memoIndexStore.loadPeriods(settings.monthlyMemoFolder, periods);
		return memos
			.filter((memo) => memo.status === "active")
			.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
	}

	async listMemos(): Promise<MemoRecord[]> {
		const settings = this.getSettings();
		const memos = await this.memoIndexStore.loadAll(settings.monthlyMemoFolder);
		return memos
			.filter((memo) => memo.status === "active")
			.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
	}

	async listDeletedMemos(): Promise<MemoRecord[]> {
		const settings = this.getSettings();
		const memos = await this.memoIndexStore.loadAll(settings.monthlyMemoFolder);
		return memos
			.filter((memo) => memo.status === "deleted")
			.sort(compareDeletedMemos);
	}

	async listIssueMemos(): Promise<MemoRecord[]> {
		const settings = this.getSettings();
		const memos = await this.memoIndexStore.loadAll(settings.monthlyMemoFolder);
		return memos
			.filter((memo) => memo.issue !== null || memo.syncStatus !== "synced")
			.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
	}
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

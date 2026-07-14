import type { MemoRecord } from "../types/memo";
import type { KnomoSettings } from "../types/settings";
import type { TimeBuoyInstance } from "../types/timeBuoy";
import { formatMonthPeriod } from "../utils/date";
import { listTimeBuoyTargetPeriods, parseTimeBuoyDate } from "../utils/timeBuoyDate";
import { getTimeBuoyRevision, hasTimeBuoyDate } from "../utils/timeBuoyParser";
import type { MemoIndexStore } from "./MemoIndexStore";
import type { TimeBuoyIndexStore } from "./TimeBuoyIndexStore";

export interface TimeBuoyQueryItem {
	instance: TimeBuoyInstance;
	memo: MemoRecord;
}

export interface TimeBuoyQueryResult {
	items: TimeBuoyQueryItem[];
	stale: TimeBuoyInstance[];
	missingPeriods: string[];
}

export interface TimeBuoyAllQueryResult extends TimeBuoyQueryResult {
	complete: boolean;
}

type GetSettings = () => KnomoSettings;

export class TimeBuoyQueryService {
	constructor(
		private readonly getSettings: GetSettings,
		private readonly timeBuoyIndexStore: TimeBuoyIndexStore,
		private readonly memoIndexStore: MemoIndexStore,
	) {}

	async queryDate(targetDate: string): Promise<TimeBuoyQueryResult> {
		return this.queryRange(targetDate, targetDate);
	}

	async queryAll(targetPeriods: readonly string[]): Promise<TimeBuoyAllQueryResult> {
		const periods = [...new Set(targetPeriods)]
			.filter((period) => /^\d{4}-(?:0[1-9]|1[0-2])$/.test(period))
			.sort();
		const result = await this.queryPeriods(periods, () => true);
		return { ...result, complete: result.missingPeriods.length === 0 };
	}

	async queryRange(startDate: string, endDate: string): Promise<TimeBuoyQueryResult> {
		if (parseTimeBuoyDate(startDate) === null || parseTimeBuoyDate(endDate) === null || startDate > endDate) {
			return { items: [], stale: [], missingPeriods: [] };
		}
		return this.queryPeriods(
			listTimeBuoyTargetPeriods(startDate, endDate),
			(targetDate) => targetDate >= startDate && targetDate <= endDate,
		);
	}

	private async queryPeriods(
		targetPeriods: readonly string[],
		acceptDate: (targetDate: string) => boolean,
	): Promise<TimeBuoyQueryResult> {
		const settings = this.getSettings();
		const candidates: TimeBuoyInstance[] = [];
		const missingPeriods: string[] = [];
		for (const targetPeriod of targetPeriods) {
			const shard = await this.timeBuoyIndexStore.loadExistingPeriod(settings.monthlyMemoFolder, targetPeriod);
			if (shard === null) {
				missingPeriods.push(targetPeriod);
				continue;
			}
			for (const [targetDate, entries] of Object.entries(shard.dates)) {
				if (!acceptDate(targetDate)) {
					continue;
				}
				for (const [memoId, entry] of Object.entries(entries)) {
					candidates.push({ memoId, targetDate, ...entry });
				}
			}
		}

		const sourcePeriods = [...new Set(candidates.map((candidate) => candidate.sourcePeriod))];
		const memos = await this.memoIndexStore.loadExistingPeriods(settings.monthlyMemoFolder, sourcePeriods);
		const memosById = new Map(memos.map((memo) => [memo.id, memo]));
		const items: TimeBuoyQueryItem[] = [];
		const stale: TimeBuoyInstance[] = [];
		for (const instance of candidates) {
			const memo = memosById.get(instance.memoId);
			if (
				memo === undefined
				|| memo.status !== "active"
				|| getTimeBuoyRevision(memo.contentSnapshot) !== instance.buoyRevision
				|| formatMonthPeriod(new Date(memo.createdAt)) !== instance.sourcePeriod
				|| !hasTimeBuoyDate(memo.contentSnapshot, instance.targetDate)
			) {
				stale.push(instance);
				continue;
			}
			items.push({ instance, memo });
		}
		items.sort((left, right) => (
			left.instance.targetDate.localeCompare(right.instance.targetDate)
			|| right.memo.createdAt.localeCompare(left.memo.createdAt)
		));
		return { items, stale, missingPeriods };
	}
}

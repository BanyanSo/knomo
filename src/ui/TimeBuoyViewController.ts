import type { MemoViewItem as MemoRecord } from "../types/memoView";
import type { TimeBuoyAllQueryResult, TimeBuoyQueryItem, TimeBuoyQueryResult } from "../types/timeBuoy";
import { formatTimeBuoyDate } from "../utils/timeBuoyDate";
import { getMemoRenderKey, getMemoRenderRevision } from "./MemoRenderRevision";

export type TimeBuoyTab = "today" | "upcoming" | "past";

export interface TimeBuoyTabItem {
	memo: MemoRecord;
	targetDates: string[];
	primaryTargetDate: string;
}

export interface TimeBuoyViewSnapshot {
	loading: boolean;
	error: unknown;
	todayError: unknown;
	activeTab: TimeBuoyTab;
	today: TimeBuoyTabItem[];
	upcoming: TimeBuoyTabItem[];
	past: TimeBuoyTabItem[];
}

export function mergeTodayTimeBuoyFeed(
	memos: readonly MemoRecord[],
	todayItems: readonly TimeBuoyTabItem[],
): MemoRecord[] {
	const latestByMemoId = new Map(memos.map((memo) => [memo.id, memo]));
	const latestByRenderKey = new Map(memos.map((memo) => [getMemoRenderKey(memo), memo]));
	const promotedByMemoId = new Map(todayItems.map((item) => [
		item.memo.id,
		latestByMemoId.get(item.memo.id) ?? latestByRenderKey.get(getMemoRenderKey(item.memo)) ?? item.memo,
	]));
	const promoted = [...promotedByMemoId.values()]
		.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
	const promotedMemoIds = new Set(promoted.map((memo) => memo.id));
	const promotedRenderKeys = new Set(promoted.map(getMemoRenderKey));
	return [
		...promoted,
		...memos.filter((memo) => !promotedMemoIds.has(memo.id) && !promotedRenderKeys.has(getMemoRenderKey(memo))),
	];
}

interface TimeBuoyViewControllerOptions {
	getNow: () => Date;
	ensureReady?: () => Promise<void>;
	isTodayIndexReady?: () => Promise<boolean>;
	queryAll: () => Promise<TimeBuoyAllQueryResult>;
	queryDate: (date: string) => Promise<TimeBuoyQueryResult>;
	requestRender: () => void;
}

export class TimeBuoyViewController {
	private snapshot: TimeBuoyViewSnapshot;
	private requestId = 0;
	private hasLoadedAll = false;

	constructor(private readonly options: TimeBuoyViewControllerOptions) {
		this.snapshot = createInitialSnapshot();
	}

	getSnapshot(): TimeBuoyViewSnapshot {
		return {
			...this.snapshot,
			today: cloneTabItems(this.snapshot.today),
			upcoming: cloneTabItems(this.snapshot.upcoming),
			past: cloneTabItems(this.snapshot.past),
		};
	}

	getMemos(): MemoRecord[] {
		const memos = [...this.snapshot.today, ...this.snapshot.upcoming, ...this.snapshot.past]
			.map((item) => item.memo);
		return [...new Map(memos.map((memo) => [memo.id, memo])).values()];
	}

	setActiveTab(tab: TimeBuoyTab): boolean {
		if (this.snapshot.activeTab === tab) {
			return false;
		}
		this.snapshot = { ...this.snapshot, activeTab: tab };
		this.options.requestRender();
		return true;
	}

	replaceMemo(memo: MemoRecord): boolean {
		let changed = false;
		const renderKey = getMemoRenderKey(memo);
		const replace = (items: readonly TimeBuoyTabItem[]): TimeBuoyTabItem[] => items.map((item) => {
			if (item.memo.id !== memo.id && getMemoRenderKey(item.memo) !== renderKey) return item;
			if (getMemoRenderRevision(item.memo) === getMemoRenderRevision(memo)) return item;
			changed = true;
			return { ...item, memo };
		});
		const today = replace(this.snapshot.today);
		const upcoming = replace(this.snapshot.upcoming);
		const past = replace(this.snapshot.past);
		if (!changed) return false;
		this.snapshot = { ...this.snapshot, today, upcoming, past };
		this.options.requestRender();
		return true;
	}

	async loadInitial(): Promise<void> {
		const requestId = ++this.requestId;
		const activeTab = this.snapshot.activeTab;
		if (!this.hasLoadedAll) {
			this.snapshot = { ...createInitialSnapshot(activeTab), loading: true };
			this.options.requestRender();
		}
		const today = formatTimeBuoyDate(this.options.getNow());
		try {
			await this.options.ensureReady?.();
			if (requestId !== this.requestId) {
				return;
			}
			const result = await this.options.queryAll();
			if (requestId !== this.requestId) {
				return;
			}
			if (!result.complete || result.missingPeriods.length > 0) {
				throw new Error(`Incomplete time buoy index: ${[...new Set(result.missingPeriods)].join(", ")}`);
			}
			const partitioned = partitionItems(result.items, today);
			const nextSnapshot = {
				...createInitialSnapshot(this.snapshot.activeTab),
				...partitioned,
			};
			const changed = !areTimeBuoySnapshotsEqual(this.snapshot, nextSnapshot);
			this.snapshot = nextSnapshot;
			this.hasLoadedAll = true;
			if (changed) {
				this.options.requestRender();
			}
		} catch (error) {
			if (requestId !== this.requestId) {
				return;
			}
			const nextSnapshot = { ...createInitialSnapshot(this.snapshot.activeTab), error };
			const changed = !areTimeBuoySnapshotsEqual(this.snapshot, nextSnapshot);
			this.snapshot = nextSnapshot;
			this.hasLoadedAll = false;
			if (changed) {
				this.options.requestRender();
			}
		}
	}

	async loadTodayOnly(): Promise<void> {
		const requestId = ++this.requestId;
		const today = formatTimeBuoyDate(this.options.getNow());
		try {
			const todayIndexReady = (await this.options.isTodayIndexReady?.()) ?? true;
			if (!todayIndexReady) {
				if (requestId !== this.requestId) {
					return;
				}
				// 后台重建期间保留最后一次成功结果，避免已显示的今日浮标短暂消失。
				this.hasLoadedAll = false;
				return;
			}
			const result = await this.options.queryDate(today);
			if (requestId !== this.requestId) {
				return;
			}
			if (result.missingPeriods.length > 0) {
				const changed = this.snapshot.todayError === null;
				this.snapshot = {
					...this.snapshot,
					todayError: new Error(`Incomplete time buoy index: ${result.missingPeriods.join(", ")}`),
				};
				if (changed) {
					this.options.requestRender();
				}
				return;
			}
			const nextToday = groupTabItems(result.items, "today");
			const changed = this.snapshot.todayError !== null
				|| !areTimeBuoyTabItemsEqual(this.snapshot.today, nextToday);
			this.snapshot = {
				...this.snapshot,
				today: nextToday,
				todayError: null,
			};
			if (changed) {
				this.options.requestRender();
			}
		} catch (error) {
			if (requestId !== this.requestId) {
				return;
			}
			const changed = this.snapshot.todayError === null;
			this.snapshot = { ...this.snapshot, todayError: error };
			if (changed) {
				this.options.requestRender();
			}
		}
	}

	async retry(): Promise<void> {
		await this.loadInitial();
	}

	clear(): void {
		this.requestId += 1;
		this.hasLoadedAll = false;
		this.snapshot = createInitialSnapshot();
	}
}

function areTimeBuoySnapshotsEqual(
	left: TimeBuoyViewSnapshot,
	right: TimeBuoyViewSnapshot,
): boolean {
	return left.loading === right.loading
		&& left.error === right.error
		&& left.todayError === right.todayError
		&& left.activeTab === right.activeTab
		&& areTimeBuoyTabItemsEqual(left.today, right.today)
		&& areTimeBuoyTabItemsEqual(left.upcoming, right.upcoming)
		&& areTimeBuoyTabItemsEqual(left.past, right.past);
}

function areTimeBuoyTabItemsEqual(
	left: readonly TimeBuoyTabItem[],
	right: readonly TimeBuoyTabItem[],
): boolean {
	return left.length === right.length && left.every((item, index) => {
		const other = right[index];
		return other !== undefined
			&& item.primaryTargetDate === other.primaryTargetDate
			&& item.targetDates.length === other.targetDates.length
			&& item.targetDates.every((date, dateIndex) => date === other.targetDates[dateIndex])
			&& getMemoRenderRevision(item.memo) === getMemoRenderRevision(other.memo);
	});
}

function createInitialSnapshot(activeTab: TimeBuoyTab = "today"): TimeBuoyViewSnapshot {
	return {
		loading: false,
		error: null,
		todayError: null,
		activeTab,
		today: [],
		upcoming: [],
		past: [],
	};
}

function partitionItems(
	items: readonly TimeBuoyQueryItem[],
	today: string,
): Pick<TimeBuoyViewSnapshot, "today" | "upcoming" | "past"> {
	const todayItems: TimeBuoyQueryItem[] = [];
	const upcoming: TimeBuoyQueryItem[] = [];
	const past: TimeBuoyQueryItem[] = [];
	for (const item of items) {
		if (item.instance.targetDate === today) {
			todayItems.push(item);
		} else if (item.instance.targetDate > today) {
			upcoming.push(item);
		} else {
			past.push(item);
		}
	}
	return {
		today: groupTabItems(todayItems, "today"),
		upcoming: groupTabItems(upcoming, "upcoming"),
		past: groupTabItems(past, "past"),
	};
}

function groupTabItems(items: readonly TimeBuoyQueryItem[], tab: TimeBuoyTab): TimeBuoyTabItem[] {
	const grouped = new Map<string, { memo: MemoRecord; targetDates: Set<string> }>();
	for (const item of items) {
		const existing = grouped.get(item.memo.id);
		if (existing === undefined) {
			grouped.set(item.memo.id, { memo: item.memo, targetDates: new Set([item.instance.targetDate]) });
			continue;
		}
		existing.targetDates.add(item.instance.targetDate);
	}
	const result = [...grouped.values()].map(({ memo, targetDates }) => {
		const sortedTargetDates = [...targetDates].sort();
		return {
			memo,
			targetDates: sortedTargetDates,
			primaryTargetDate: getPrimaryTargetDate(tab, sortedTargetDates),
		};
	});
	return sortTabItems(result, tab);
}

function sortTabItems(items: TimeBuoyTabItem[], tab: TimeBuoyTab): TimeBuoyTabItem[] {
	const sortCreatedAt = (left: TimeBuoyTabItem, right: TimeBuoyTabItem): number => (
		right.memo.createdAt.localeCompare(left.memo.createdAt)
	);
	if (tab === "today") {
		return items.sort(sortCreatedAt);
	}
	return items.sort((left, right) => {
		const dateOrder = tab === "upcoming"
			? left.primaryTargetDate.localeCompare(right.primaryTargetDate)
			: right.primaryTargetDate.localeCompare(left.primaryTargetDate);
		return dateOrder || sortCreatedAt(left, right);
	});
}

function getPrimaryTargetDate(tab: TimeBuoyTab, targetDates: readonly string[]): string {
	return tab === "past" ? targetDates[targetDates.length - 1] ?? "" : targetDates[0] ?? "";
}

function cloneTabItems(items: readonly TimeBuoyTabItem[]): TimeBuoyTabItem[] {
	return items.map((item) => ({ ...item, targetDates: [...item.targetDates] }));
}

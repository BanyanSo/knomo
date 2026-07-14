import type { MemoMutation, MemoRecord } from "../types/memo";
import type { TimeBuoyAllQueryResult, TimeBuoyQueryItem, TimeBuoyQueryResult } from "../services/TimeBuoyQueryService";
import type { TimeBuoyRebuildResult } from "../services/TimeBuoyRebuildService";
import type { TimeBuoyRebuildOptions, TimeBuoyRebuildProgress } from "../services/TimeBuoyRebuildService";
import { formatTimeBuoyDate } from "../utils/timeBuoyDate";
import { hasTimeBuoyDate } from "../utils/timeBuoyParser";
import { getMemoRenderRevision } from "./MemoRenderRevision";

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
	rebuilding: boolean;
	rebuildProgress: TimeBuoyRebuildProgress | null;
}

export function mergeTodayTimeBuoyFeed(
	memos: readonly MemoRecord[],
	todayItems: readonly TimeBuoyTabItem[],
): MemoRecord[] {
	const promotedByMemoId = new Map(todayItems.map((item) => [item.memo.id, item.memo]));
	const promoted = [...promotedByMemoId.values()]
		.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
	return [
		...promoted,
		...memos.filter((memo) => !promotedByMemoId.has(memo.id)),
	];
}

interface TimeBuoyViewControllerOptions {
	getNow: () => Date;
	queryAll: () => Promise<TimeBuoyAllQueryResult>;
	queryDate: (date: string) => Promise<TimeBuoyQueryResult>;
	rebuild: (options?: TimeBuoyRebuildOptions) => Promise<TimeBuoyRebuildResult>;
	requestRender: () => void;
}

export class TimeBuoyViewController {
	private snapshot: TimeBuoyViewSnapshot;
	private requestId = 0;
	private rebuildCancelled = false;

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

	getActiveItems(): TimeBuoyTabItem[] {
		return cloneTabItems(this.snapshot[this.snapshot.activeTab]);
	}

	setActiveTab(tab: TimeBuoyTab): boolean {
		if (this.snapshot.activeTab === tab) {
			return false;
		}
		this.snapshot = { ...this.snapshot, activeTab: tab };
		this.options.requestRender();
		return true;
	}

	applyMemoMutation(mutation: MemoMutation): void {
		if (mutation.type === "create") {
			return;
		}
		const reconcile = (items: TimeBuoyTabItem[], tab: TimeBuoyTab): TimeBuoyTabItem[] => items.flatMap((item) => {
			if (item.memo.id !== mutation.memo.id) {
				return [item];
			}
			if (mutation.type === "delete") {
				return [];
			}
			const targetDates = item.targetDates.filter((targetDate) => (
				hasTimeBuoyDate(mutation.memo.contentSnapshot, targetDate)
			));
			if (targetDates.length === 0) {
				return [];
			}
			return [{
				memo: mutation.memo,
				targetDates,
				primaryTargetDate: getPrimaryTargetDate(tab, targetDates),
			}];
		});
		this.snapshot = {
			...this.snapshot,
			today: sortTabItems(reconcile(this.snapshot.today, "today"), "today"),
			upcoming: sortTabItems(reconcile(this.snapshot.upcoming, "upcoming"), "upcoming"),
			past: sortTabItems(reconcile(this.snapshot.past, "past"), "past"),
		};
	}

	async loadInitial(): Promise<void> {
		const requestId = ++this.requestId;
		const activeTab = this.snapshot.activeTab;
		this.snapshot = { ...createInitialSnapshot(activeTab), loading: true };
		this.options.requestRender();
		const today = formatTimeBuoyDate(this.options.getNow());
		try {
			const result = await this.options.queryAll();
			if (requestId !== this.requestId) {
				return;
			}
			if (!result.complete || result.missingPeriods.length > 0) {
				throw new Error(`Incomplete time buoy index: ${[...new Set(result.missingPeriods)].join(", ")}`);
			}
			const partitioned = partitionItems(result.items, today);
			this.snapshot = {
				...createInitialSnapshot(activeTab),
				...partitioned,
			};
		} catch (error) {
			if (requestId !== this.requestId) {
				return;
			}
			this.snapshot = { ...createInitialSnapshot(activeTab), error };
		}
		this.options.requestRender();
	}

	async loadTodayOnly(): Promise<void> {
		const requestId = ++this.requestId;
		const today = formatTimeBuoyDate(this.options.getNow());
		try {
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

	async rebuild(): Promise<void> {
		if (this.snapshot.rebuilding) {
			return;
		}
		this.rebuildCancelled = false;
		this.snapshot = { ...this.snapshot, rebuilding: true, rebuildProgress: null, error: null };
		this.options.requestRender();
		try {
			const result = await this.options.rebuild({
				isCancelled: () => this.rebuildCancelled,
				onProgress: (progress) => {
					this.snapshot = { ...this.snapshot, rebuildProgress: progress };
					this.options.requestRender();
				},
			});
			if (result.status === "completed") {
				await this.loadInitial();
				return;
			}
			this.snapshot = { ...this.snapshot, rebuilding: false, rebuildProgress: null };
		} catch (error) {
			this.snapshot = { ...this.snapshot, rebuilding: false, rebuildProgress: null, error };
		}
		this.options.requestRender();
	}

	cancelRebuild(): void {
		this.rebuildCancelled = true;
	}

	clear(): void {
		this.rebuildCancelled = true;
		this.requestId += 1;
		this.snapshot = createInitialSnapshot();
	}
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
		rebuilding: false,
		rebuildProgress: null,
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

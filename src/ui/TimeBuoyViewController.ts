import type { MemoViewItem as MemoRecord } from "../types/memoView";
import type { TimeBuoyCursor, TimeBuoyPageRequest, TimeBuoyPageResult, TimeBuoyQueryItem, TimeBuoyQueryResult } from "../types/timeBuoy";
import { formatTimeBuoyDate } from "../utils/timeBuoyDate";
import { getMemoRenderKey, getMemoRenderRevision } from "./MemoRenderRevision";

export type TimeBuoyTab = "today" | "upcoming" | "past";

export interface TimeBuoyTabItem {
	memo: MemoRecord;
	targetDates: string[];
	primaryTargetDate: string;
}

export interface TimeBuoyViewSnapshot {
	todayDate: string | null;
	todayRevision: number | null;
	todayValid: boolean;
	todayCursor?: TimeBuoyCursor | null;
	loading: boolean;
	loadingMore: boolean;
	nextCursor: TimeBuoyCursor | null;
	error: unknown;
	refreshError: unknown;
	todayError: unknown;
	complete: boolean;
	activeTab: TimeBuoyTab;
	today: TimeBuoyTabItem[];
	upcoming: TimeBuoyTabItem[];
	past: TimeBuoyTabItem[];
}

export type TodayTimeBuoySnapshot = Pick<TimeBuoyViewSnapshot,
	"todayDate" | "todayRevision" | "todayValid" | "today" | "todayError" | "todayCursor">;

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
	isPageActive?: () => boolean;
	ensureReady?: () => Promise<void>;
	isTodayIndexReady?: (targetDate: string) => Promise<boolean>;
	queryPage: (request: TimeBuoyPageRequest) => Promise<TimeBuoyPageResult>;
	queryDate: (date: string, cursor?: TimeBuoyCursor | null) => Promise<TimeBuoyQueryResult>;
	requestRender: () => void;
}

export class TimeBuoyViewController {
	private snapshot: TimeBuoyViewSnapshot;
	private requestId = 0;
	private hasLoadedPage = false;
	private refreshing = false;

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
		this.requestId++;
		this.hasLoadedPage = false;
		this.snapshot = createInitialSnapshot(tab);
		void this.loadInitial();
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
		if (this.options.isPageActive?.() === false) { this.clear(); return; }
		const requestId = ++this.requestId;
		this.refreshing = true;
		const activeTab = this.snapshot.activeTab;
		if (!this.hasLoadedPage) {
			this.snapshot = { ...createInitialSnapshot(activeTab), loading: true };
			this.options.requestRender();
		} else if (this.snapshot.refreshError !== null) {
			this.snapshot = { ...this.snapshot, refreshError: null };
			this.options.requestRender();
		}
		const today = formatTimeBuoyDate(this.options.getNow());
		try {
			await this.options.ensureReady?.();
			if (!this.isCurrentPageRequest(requestId)) {
				return;
			}
			const result = await this.options.queryPage({ today, tab: activeTab, limit: 30 });
			if (!this.isCurrentPageRequest(requestId) || today !== formatTimeBuoyDate(this.options.getNow())) {
				return;
			}
			if (result.invalidated) throw new Error("Time buoy query invalidated");
			const items = groupTabItems(result.items, activeTab);
			const nextSnapshot = {
				...createInitialSnapshot(this.snapshot.activeTab),
				[activeTab]: items,
				nextCursor: result.nextCursor,
				todayDate: today,
				todayRevision: result.catalogRevision ?? null,
				todayValid: activeTab === "today" && result.nextCursor === null && result.complete && result.missingPeriods.length === 0,
				complete: result.complete && result.missingPeriods.length === 0,
			};
			const changed = !areTimeBuoySnapshotsEqual(this.snapshot, nextSnapshot);
			this.snapshot = nextSnapshot;
			this.hasLoadedPage = true;
			if (changed) {
				this.options.requestRender();
			}
		} catch (error) {
			if (!this.isCurrentPageRequest(requestId)) {
				return;
			}
			if (this.hasLoadedPage) {
				this.snapshot = { ...this.snapshot, loadingMore: false, nextCursor: null, refreshError: error };
				this.options.requestRender();
				return;
			}
			const nextSnapshot = { ...createInitialSnapshot(this.snapshot.activeTab), error };
			const changed = !areTimeBuoySnapshotsEqual(this.snapshot, nextSnapshot);
			this.snapshot = nextSnapshot;
			this.hasLoadedPage = false;
			if (changed) {
				this.options.requestRender();
			}
		} finally {
			if (requestId === this.requestId) this.refreshing = false;
		}
	}

	async loadMore(): Promise<void> {
		if (this.options.isPageActive?.() === false) { this.clear(); return; }
		const cursor = this.snapshot.nextCursor;
		if (cursor === null || this.refreshing || this.snapshot.loading || this.snapshot.loadingMore || this.snapshot.refreshError !== null) return;
		const requestId = this.requestId;
		const tab = this.snapshot.activeTab;
		this.snapshot = { ...this.snapshot, loadingMore: true };
		try {
			const result = await this.options.queryPage({ today: cursor.today, tab, limit: 30, cursor });
			if (!this.isCurrentPageRequest(requestId)) return;
			if (cursor.today !== formatTimeBuoyDate(this.options.getNow()) || result.invalidated) {
				// 游标失效明确进入重载状态，不把空页当作已读完。
				this.hasLoadedPage = false;
				await this.loadInitial();
				return;
			}
			this.snapshot = { ...this.snapshot, loadingMore: false, nextCursor: result.nextCursor,
				[tab]: [...this.snapshot[tab], ...groupTabItems(result.items, tab)] };
			this.options.requestRender();
		} catch (refreshError) {
			if (!this.isCurrentPageRequest(requestId)) return;
			this.snapshot = { ...this.snapshot, loadingMore: false, refreshError };
			this.options.requestRender();
		}
	}

	private isCurrentPageRequest(requestId: number): boolean {
		if (requestId !== this.requestId) return false;
		if (this.options.isPageActive?.() === false) { this.clear(); return false; }
		return true;
	}

	// 列表先准备独立结果，校验查询仍有效后再与普通 Memo 一起提交。
	async prepareTodayOnly(cursor?: TimeBuoyCursor | null): Promise<TodayTimeBuoySnapshot> {
		const today = formatTimeBuoyDate(this.options.getNow());
		const result: TodayTimeBuoySnapshot = {
			todayDate: today, todayRevision: null, todayValid: false, today: [], todayError: null,
		};
		try {
			if (!((await this.options.isTodayIndexReady?.(today)) ?? true)) return result;
			const query = await this.options.queryDate(today, cursor);
			if (today !== formatTimeBuoyDate(this.options.getNow())) throw new Error("Time buoy date changed while loading");
			if (query.invalidated) throw new Error("Time buoy query invalidated");
			if (query.missingPeriods.length > 0) throw new Error(`Incomplete time buoy index: ${query.missingPeriods.join(", ")}`);
			return { ...result, todayRevision: query.catalogRevision ?? null, todayValid: true,
				todayCursor: query.nextCursor ?? null, today: groupTabItems(query.items, "today") };
		} catch (todayError) {
			return { ...result, todayError };
		}
	}

	async loadTodayOnly(render = true): Promise<void> {
		const requestId = ++this.requestId;
		const today = formatTimeBuoyDate(this.options.getNow());
		const prepared = await this.prepareTodayOnly();
		if (requestId !== this.requestId || today !== formatTimeBuoyDate(this.options.getNow())) return;
		if (!prepared.todayValid) {
			// 独立页保留最后结果；列表使用自己已提交的同版本快照。
			if (prepared.todayError === null) this.hasLoadedPage = false;
			const changed = this.snapshot.todayValid || (this.snapshot.todayError === null && prepared.todayError !== null);
			this.snapshot = { ...this.snapshot, todayValid: false, todayError: prepared.todayError };
			if (changed && render) this.options.requestRender();
			return;
		}
		const nextSnapshot = { ...this.snapshot, ...prepared };
		const changed = !areTimeBuoySnapshotsEqual(this.snapshot, nextSnapshot);
		this.snapshot = nextSnapshot;
		if (changed && render) this.options.requestRender();
	}

	async retry(): Promise<void> {
		await this.loadInitial();
	}

	clear(): void {
		this.requestId += 1;
		this.refreshing = false;
		this.hasLoadedPage = false;
		this.snapshot = createInitialSnapshot();
	}
}

function areTimeBuoySnapshotsEqual(
	left: TimeBuoyViewSnapshot,
	right: TimeBuoyViewSnapshot,
): boolean {
	return left.loading === right.loading
		&& left.loadingMore === right.loadingMore
		&& JSON.stringify(left.nextCursor) === JSON.stringify(right.nextCursor)
		&& left.todayDate === right.todayDate
		&& left.todayRevision === right.todayRevision
		&& left.todayValid === right.todayValid
		&& JSON.stringify(left.todayCursor) === JSON.stringify(right.todayCursor)
		&& left.error === right.error
		&& left.refreshError === right.refreshError
		&& left.todayError === right.todayError
		&& left.complete === right.complete
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
		todayDate: null,
		todayRevision: null,
		todayValid: false,
		loading: false,
		loadingMore: false,
		nextCursor: null,
		error: null,
		refreshError: null,
		todayError: null,
		complete: false,
		activeTab,
		today: [],
		upcoming: [],
		past: [],
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

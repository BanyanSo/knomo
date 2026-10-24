import type { MemoViewItem as MemoRecord } from "../types/memoView";
import type { TimeBuoyCursor, TimeBuoyPageRequest, TimeBuoyPageResult, TimeBuoyQueryItem, TimeBuoyQueryResult } from "../types/timeBuoy";
import { formatTimeBuoyDate } from "../utils/timeBuoyDate";
import { getMemoRenderKey, getMemoRenderRevision } from "./MemoRenderRevision";
import { getTimeBuoyTabDates } from "../services/TimeBuoyQuery";
import { CatalogQueryCancelledError } from "../services/MemoCatalogStore";
import { CatalogDiscoveryInvalidatedError } from "../services/CatalogReadService";

export class TimeBuoyIndexPendingError extends Error {
	constructor() { super("Time buoy index is not ready."); }
}

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
	projectSnapshot?: (snapshot: TimeBuoyViewSnapshot) => TimeBuoyViewSnapshot;
	getNow: () => Date;
	isPageActive?: () => boolean;
	ensureReady?: () => Promise<void>;
	isTodayIndexReady?: (targetDate: string) => Promise<boolean>;
	queryPage: (request: TimeBuoyPageRequest, signal?: AbortSignal) => Promise<TimeBuoyPageResult>;
	queryDate: (date: string, cursor?: TimeBuoyCursor | null, signal?: AbortSignal) => Promise<TimeBuoyQueryResult>;
	requestRender: () => void;
}

export class TimeBuoyViewController {
	private snapshot: TimeBuoyViewSnapshot;
	private requestId = 0;
	private hasLoadedPage = false;
	private refreshing = false;
	private queryController: AbortController | null = null;

	constructor(private readonly options: TimeBuoyViewControllerOptions) {
		this.snapshot = createInitialSnapshot();
	}

	getSnapshot(): TimeBuoyViewSnapshot {
		const snapshot = {
			...this.snapshot,
			today: cloneTabItems(this.snapshot.today),
			upcoming: cloneTabItems(this.snapshot.upcoming),
			past: cloneTabItems(this.snapshot.past),
		};
		return this.options.projectSnapshot?.(snapshot) ?? snapshot;
	}

	getMemos(): MemoRecord[] {
		const snapshot = this.getSnapshot();
		const memos = [...snapshot.today, ...snapshot.upcoming, ...snapshot.past]
			.map((item) => item.memo);
		return [...new Map(memos.map((memo) => [memo.id, memo])).values()];
	}

	setActiveTab(tab: TimeBuoyTab): boolean {
		if (this.snapshot.activeTab === tab) {
			return false;
		}
		this.cancelPendingQuery();
		this.requestId++;
		this.hasLoadedPage = false;
		this.snapshot = createInitialSnapshot(tab);
		void this.loadInitial();
		return true;
	}

	applyMemoChanges(changes: ReadonlyMap<string, MemoRecord | null>, inserted: readonly MemoRecord[] = []): boolean {
		if (!inserted.some(memo => memo.catalog?.timeBuoyDates.length)
			&& ![...this.snapshot.today, ...this.snapshot.upcoming, ...this.snapshot.past]
				.some(item => changes.has(item.memo.id))) return false;
		const todayDate = formatTimeBuoyDate(this.options.getNow());
		const replace = (tab: TimeBuoyTab): TimeBuoyTabItem[] => {
			const items = this.snapshot[tab].flatMap(item => {
				if (!changes.has(item.memo.id)) return [item];
				const memo = changes.get(item.memo.id);
				if (!memo) return [];
				const targetDates = getTimeBuoyTabDates(memo.catalog?.timeBuoyDates ?? item.targetDates, { tab, today: todayDate });
				return targetDates.length > 0 ? [{ memo, targetDates, primaryTargetDate: getPrimaryTargetDate(tab, targetDates) }] : [];
			});
			return sortTabItems([...new Map([...items, ...buildTimeBuoyTabItems(inserted, tab, todayDate)]
				.map(item => [item.memo.id, item])).values()], tab);
		};
		const today = replace("today"), upcoming = replace("upcoming"), past = replace("past");
		this.cancelPendingQuery();
		this.requestId++;
		this.refreshing = false;
		this.snapshot = { ...this.snapshot, today, upcoming, past, nextCursor: null, todayCursor: null, loading: false, loadingMore: false };
		return true;
	}

	async loadInitial(): Promise<void> {
		if (this.options.isPageActive?.() === false) { this.clear(); return; }
		this.cancelPendingQuery();
		const controller = new AbortController();
		this.queryController = controller;
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
			controller.signal.throwIfAborted();
			if (!this.isCurrentPageRequest(requestId)) {
				return;
			}
			const result = await this.options.queryPage({ today, tab: activeTab, limit: 30 }, controller.signal);
			controller.signal.throwIfAborted();
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
			if (controller.signal.aborted || error instanceof CatalogQueryCancelledError) {
				this.snapshot = { ...this.snapshot, loading: false, loadingMore: false };
				this.options.requestRender();
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
			if (this.queryController === controller) this.queryController = null;
			if (requestId === this.requestId) this.refreshing = false;
		}
	}

	async loadMore(): Promise<void> {
		if (this.options.isPageActive?.() === false) { this.clear(); return; }
		const cursor = this.snapshot.nextCursor;
		if (cursor === null || this.refreshing || this.snapshot.loading || this.snapshot.loadingMore || this.snapshot.refreshError !== null) return;
		const requestId = this.requestId;
		const tab = this.snapshot.activeTab;
		this.cancelPendingQuery();
		const controller = new AbortController();
		this.queryController = controller;
		this.snapshot = { ...this.snapshot, loadingMore: true };
		try {
			const result = await this.options.queryPage({ today: cursor.today, tab, limit: 30, cursor }, controller.signal);
			controller.signal.throwIfAborted();
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
			if (controller.signal.aborted || refreshError instanceof CatalogQueryCancelledError) {
				this.snapshot = { ...this.snapshot, loadingMore: false };
				this.options.requestRender();
				return;
			}
			this.snapshot = { ...this.snapshot, loadingMore: false, refreshError };
			this.options.requestRender();
		} finally {
			if (this.queryController === controller) this.queryController = null;
		}
	}

	private isCurrentPageRequest(requestId: number): boolean {
		if (requestId !== this.requestId) return false;
		if (this.options.isPageActive?.() === false) { this.clear(); return false; }
		return true;
	}

	// 列表先准备独立结果，校验查询仍有效后再与普通 Memo 一起提交。
	async prepareTodayOnly(cursor?: TimeBuoyCursor | null, signal?: AbortSignal): Promise<TodayTimeBuoySnapshot> {
		const today = formatTimeBuoyDate(this.options.getNow());
		const result: TodayTimeBuoySnapshot = {
			todayDate: today, todayRevision: null, todayValid: false, today: [], todayError: null,
		};
		try {
			signal?.throwIfAborted();
			const ready = (await this.options.isTodayIndexReady?.(today)) ?? true;
			signal?.throwIfAborted();
			if (!ready) return result;
			const query = await this.options.queryDate(today, cursor, signal);
			signal?.throwIfAborted();
			if (today !== formatTimeBuoyDate(this.options.getNow()) || query.invalidated) throw new CatalogDiscoveryInvalidatedError();
			if (query.missingPeriods.length > 0) throw new TimeBuoyIndexPendingError();
			return { ...result, todayRevision: query.catalogRevision ?? null, todayValid: true,
				todayCursor: query.nextCursor ?? null, today: groupTabItems(query.items, "today") };
		} catch (todayError) {
			signal?.throwIfAborted();
			if (todayError instanceof CatalogQueryCancelledError) throw todayError;
			return { ...result, todayError };
		}
	}

	async loadTodayOnly(render = true): Promise<void> {
		this.cancelPendingQuery();
		const controller = new AbortController();
		this.queryController = controller;
		const requestId = ++this.requestId;
		const today = formatTimeBuoyDate(this.options.getNow());
		try {
			const prepared = await this.prepareTodayOnly(undefined, controller.signal);
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
		} catch (error) {
			if (!controller.signal.aborted && !(error instanceof CatalogQueryCancelledError)) throw error;
		} finally {
			if (this.queryController === controller) this.queryController = null;
		}
	}

	async retry(): Promise<void> {
		await this.loadInitial();
	}

	clear(): void {
		this.cancelPendingQuery();
		this.requestId += 1;
		this.refreshing = false;
		this.hasLoadedPage = false;
		this.snapshot = createInitialSnapshot();
	}

	private cancelPendingQuery(): void {
		this.queryController?.abort();
		this.queryController = null;
		this.refreshing = false;
	}
}

export function buildTimeBuoyTabItems(memos: readonly MemoRecord[], tab: TimeBuoyTab, today: string): TimeBuoyTabItem[] {
	const items = [...new Map(memos.map(memo => [memo.id, memo])).values()].flatMap(memo => {
		const targetDates = getTimeBuoyTabDates(memo.catalog?.timeBuoyDates ?? [], { tab, today });
		return targetDates.length ? [{ memo, targetDates, primaryTargetDate: getPrimaryTargetDate(tab, targetDates) }] : [];
	});
	return sortTabItems(items, tab);
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

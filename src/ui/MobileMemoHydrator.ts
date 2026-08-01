import type { MemoMutation, MemoRecord } from "../types/memo";

const MOBILE_MEMO_HYDRATE_BATCH_PERIODS = 4;
const MOBILE_MEMO_HYDRATE_BATCH_MEMOS = 200;

export type MemoLoadMode = "recent" | "hydrating" | "all";

export interface MobileMemoHydrationRenderState {
	renderedCardCount: number;
	previousCardFlowKey: string;
	previousMobileSearchKey: string;
}

export interface MobileMemoHydratorSnapshot {
	allMemosLoaded: boolean;
	loadMode: MemoLoadMode;
	runId: number;
	loadedMemoPeriods: ReadonlySet<string>;
}

interface MobileMemoHydratorOptions {
	isMobile: () => boolean;
	isLoading: () => boolean;
	listMemoIndexPeriods: () => string[];
	listMemosInPeriods: (periods: string[]) => Promise<MemoRecord[]>;
	getMemos: () => MemoRecord[];
	setMemos: (memos: MemoRecord[]) => void;
	invalidateFilteredMemos: () => void;
	captureRenderState: () => MobileMemoHydrationRenderState;
	onStarted: () => void;
	onPeriodHydrated: (state: MobileMemoHydrationRenderState) => void;
	onCompleted: (state: MobileMemoHydrationRenderState) => void;
	onFailed: () => void;
}

export class MobileMemoHydrator {
	private allMemosLoaded = false;
	private loadMode: MemoLoadMode = "recent";
	private loadedMemoPeriods = new Set<string>();
	private runId = 0;
	private readonly deletedMemoIds = new Set<string>();

	constructor(private readonly options: MobileMemoHydratorOptions) {}

	getSnapshot(): MobileMemoHydratorSnapshot {
		return {
			allMemosLoaded: this.allMemosLoaded,
			loadMode: this.loadMode,
			runId: this.runId,
			loadedMemoPeriods: this.loadedMemoPeriods,
		};
	}

	isCurrentRun(runId: number): boolean {
		return runId === this.runId;
	}

	setReloadSuccess(loadAll: boolean, loadedPeriods: readonly string[]): void {
		this.allMemosLoaded = loadAll;
		this.loadMode = loadAll ? "all" : "recent";
		this.loadedMemoPeriods = new Set(loadedPeriods);
	}

	setInitialLoadSuccess(loadedPeriods: readonly string[]): void {
		this.allMemosLoaded = false;
		this.loadMode = "recent";
		this.loadedMemoPeriods = new Set(loadedPeriods);
	}

	setLoadFailure(): void {
		this.loadMode = "recent";
		this.loadedMemoPeriods.clear();
	}

	markPeriodLoaded(period: string): void {
		this.loadedMemoPeriods.add(period);
	}

	recordMutation(mutation: MemoMutation): void {
		if (mutation.type === "delete") {
			this.deletedMemoIds.add(mutation.memo.id);
			return;
		}
		this.deletedMemoIds.delete(mutation.memo.id);
	}

	mergeLoadedMemos(memos: readonly MemoRecord[]): void {
		this.mergeHydratedMemos(memos, false);
	}

	start(): Promise<boolean> {
		if (!this.options.isMobile() || this.allMemosLoaded) {
			return Promise.resolve(this.allMemosLoaded);
		}
		this.loadMode = "hydrating";
		this.options.onStarted();
		const runId = this.runId + 1;
		this.runId = runId;
		return this.hydrate(runId, this.options.listMemoIndexPeriods(), true);
	}

	loadNextPeriods(count = 2): Promise<boolean> {
		if (!this.options.isMobile() || this.options.isLoading()) {
			return Promise.resolve(false);
		}
		const pendingPeriods = this.options.listMemoIndexPeriods()
			.filter((period) => !this.loadedMemoPeriods.has(period))
			.slice(0, Math.max(0, count));
		if (pendingPeriods.length === 0) {
			this.allMemosLoaded = true;
			this.loadMode = "all";
			return Promise.resolve(true);
		}
		return this.loadSelectedPeriods(pendingPeriods);
	}

	ensurePeriods(periods: readonly string[]): Promise<boolean> {
		if (!this.options.isMobile() || this.options.isLoading()) {
			return Promise.resolve(false);
		}
		const storedPeriods = new Set(this.options.listMemoIndexPeriods());
		const pendingPeriods = [...new Set(periods)]
			.filter((period) => storedPeriods.has(period) && !this.loadedMemoPeriods.has(period));
		return pendingPeriods.length === 0
			? Promise.resolve(true)
			: this.loadSelectedPeriods(pendingPeriods);
	}

	cancel(): void {
		this.runId += 1;
	}

	private async hydrate(runId: number, periods: readonly string[], completeAll: boolean): Promise<boolean> {
		try {
			let pendingPeriods: string[] = [];
			let pendingMemos: MemoRecord[] = [];
			for (let index = 0; index < periods.length; index += 1) {
				const period = periods[index];
				if (this.loadedMemoPeriods.has(period)) {
					continue;
				}
				const periodMemos = await this.options.listMemosInPeriods([period]);
				if (!this.isCurrentRun(runId)) {
					return false;
				}
				if (periodMemos.length === 0) {
					this.loadedMemoPeriods.add(period);
					continue;
				}
				pendingPeriods.push(period);
				pendingMemos.push(...periodMemos);
				if (
					index < periods.length - 1
					&& this.shouldCommitHydratedMemos(pendingPeriods.length, pendingMemos.length)
				) {
					const committed = await this.commitHydratedMemos(runId, pendingPeriods, pendingMemos, true);
					if (!committed) {
						return false;
					}
					pendingPeriods = [];
					pendingMemos = [];
				}
			}
			if (!this.isCurrentRun(runId)) {
				return false;
			}
			if (pendingPeriods.length > 0) {
				const committed = await this.commitHydratedMemos(runId, pendingPeriods, pendingMemos, !completeAll);
				if (!committed) {
					return false;
				}
			}
			if (completeAll) {
				this.completeMobileMemoHydration();
			} else {
				const hasPendingPeriods = this.options.listMemoIndexPeriods()
					.some((period) => !this.loadedMemoPeriods.has(period));
				this.allMemosLoaded = !hasPendingPeriods;
				this.loadMode = hasPendingPeriods ? "recent" : "all";
				this.options.invalidateFilteredMemos();
			}
			return true;
		} catch {
			if (this.isCurrentRun(runId)) {
				this.loadMode = this.allMemosLoaded ? "all" : "recent";
				this.options.onFailed();
			}
			return false;
		}
	}

	private loadSelectedPeriods(periods: readonly string[]): Promise<boolean> {
		this.loadMode = "hydrating";
		this.options.onStarted();
		const runId = this.runId + 1;
		this.runId = runId;
		return this.hydrate(runId, periods, false);
	}

	private shouldCommitHydratedMemos(periodCount: number, memoCount: number): boolean {
		return periodCount >= MOBILE_MEMO_HYDRATE_BATCH_PERIODS || memoCount >= MOBILE_MEMO_HYDRATE_BATCH_MEMOS;
	}

	private async commitHydratedMemos(
		runId: number,
		periods: readonly string[],
		memos: readonly MemoRecord[],
		notifyUi: boolean,
	): Promise<boolean> {
		if (!this.isCurrentRun(runId)) {
			return false;
		}
		const renderState = notifyUi ? this.options.captureRenderState() : null;
		this.mergeHydratedMemos(memos, notifyUi);
		for (const period of periods) {
			this.loadedMemoPeriods.add(period);
		}
		if (renderState !== null) {
			this.options.onPeriodHydrated(renderState);
		}
		return true;
	}

	private mergeHydratedMemos(memos: readonly MemoRecord[], invalidateFilteredMemos: boolean): void {
		if (memos.length === 0) {
			return;
		}
		const memoById = new Map(this.options.getMemos().map((memo) => [memo.id, memo]));
		for (const memo of memos) {
			if (this.deletedMemoIds.has(memo.id)) {
				continue;
			}
			const current = memoById.get(memo.id);
			if (current === undefined || memo.updatedAt.localeCompare(current.updatedAt) > 0) {
				memoById.set(memo.id, memo);
			}
		}
		this.options.setMemos(Array.from(memoById.values())
			.filter((memo) => memo.status === "active")
			.sort((left, right) => right.createdAt.localeCompare(left.createdAt)));
		if (invalidateFilteredMemos) {
			this.options.invalidateFilteredMemos();
		}
	}

	private completeMobileMemoHydration(): void {
		const renderState = this.options.captureRenderState();
		this.allMemosLoaded = true;
		this.loadMode = "all";
		this.options.invalidateFilteredMemos();
		this.options.onCompleted(renderState);
	}
}

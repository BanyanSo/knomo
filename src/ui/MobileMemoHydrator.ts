import type { MemoRecord } from "../types/memo";

const MOBILE_MEMO_HYDRATE_INITIAL_DELAY_MS = 1200;
const MOBILE_MEMO_HYDRATE_BACKGROUND_DELAY_MS = 180;
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
	fastMode: boolean;
	renderNextBatchAfterHydration: boolean;
	loadedMemoPeriods: ReadonlySet<string>;
}

interface MobileMemoHydratorOptions {
	isMobile: () => boolean;
	isLoading: () => boolean;
	isPaused?: () => boolean;
	canHydrateCardFlow: () => boolean;
	scheduleTask: (callback: () => void, delayMs: number) => number;
	cancelTask: (taskId: number) => void;
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
	onSidebarRequested: () => void;
	beginScheduledHydration: () => void;
	ensureAllMemosLoaded: () => void;
}

export class MobileMemoHydrator {
	private allMemosLoaded = false;
	private loadMode: MemoLoadMode = "recent";
	private loadedMemoPeriods = new Set<string>();
	private allMemoPeriods: string[] = [];
	private hydrateTimerId: number | null = null;
	private sidebarHydrateTimerId: number | null = null;
	private runId = 0;
	private fastMode = false;
	private renderNextBatchAfterHydration = false;

	constructor(private readonly options: MobileMemoHydratorOptions) {}

	getSnapshot(): MobileMemoHydratorSnapshot {
		return {
			allMemosLoaded: this.allMemosLoaded,
			loadMode: this.loadMode,
			runId: this.runId,
			fastMode: this.fastMode,
			renderNextBatchAfterHydration: this.renderNextBatchAfterHydration,
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

	schedule(): void {
		if (
			!this.options.isMobile()
			|| this.allMemosLoaded
			|| this.options.isLoading()
			|| this.hydrateTimerId !== null
		) {
			return;
		}
		this.hydrateTimerId = this.options.scheduleTask(() => {
			this.hydrateTimerId = null;
			if (!this.options.isLoading()) {
				this.options.beginScheduledHydration();
			}
		}, MOBILE_MEMO_HYDRATE_INITIAL_DELAY_MS);
	}

	start(fastMode: boolean): Promise<boolean> {
		if (!this.options.isMobile() || this.allMemosLoaded) {
			return Promise.resolve(this.allMemosLoaded);
		}
		if (fastMode) {
			this.fastMode = true;
		}
		this.clearScheduled();
		this.loadMode = "hydrating";
		this.options.onStarted();
		const runId = this.runId + 1;
		this.runId = runId;
		return this.hydrate(runId);
	}

	accelerate(): void {
		if (this.options.isMobile() && !this.allMemosLoaded) {
			this.fastMode = true;
			this.clearScheduled();
		}
	}

	requestSidebarHydration(): void {
		if (!this.options.isMobile() || this.allMemosLoaded) {
			return;
		}
		this.fastMode = true;
		this.loadMode = "hydrating";
		this.options.ensureAllMemosLoaded();
		this.options.onSidebarRequested();
	}

	deferSidebarHydration(): void {
		if (!this.options.isMobile() || this.allMemosLoaded || this.sidebarHydrateTimerId !== null) {
			return;
		}
		this.sidebarHydrateTimerId = this.options.scheduleTask(() => {
			this.sidebarHydrateTimerId = null;
			this.requestSidebarHydration();
		}, 0);
	}

	requestCardFlowHydration(): void {
		if (!this.options.isMobile() || this.allMemosLoaded || !this.options.canHydrateCardFlow()) {
			return;
		}
		this.fastMode = true;
		this.loadMode = "hydrating";
		this.renderNextBatchAfterHydration = true;
		this.options.ensureAllMemosLoaded();
	}

	consumeRenderNextBatchRequest(): void {
		this.renderNextBatchAfterHydration = false;
	}

	clearScheduled(): void {
		if (this.hydrateTimerId === null) {
			return;
		}
		this.options.cancelTask(this.hydrateTimerId);
		this.hydrateTimerId = null;
	}

	cancel(): void {
		this.runId += 1;
		this.fastMode = false;
		this.renderNextBatchAfterHydration = false;
		this.clearScheduled();
		this.clearDeferredSidebarHydration();
	}

	private async hydrate(runId: number): Promise<boolean> {
		try {
			this.allMemoPeriods = this.options.listMemoIndexPeriods();
			let pendingPeriods: string[] = [];
			let pendingMemos: MemoRecord[] = [];
			for (let index = 0; index < this.allMemoPeriods.length; index += 1) {
				const period = this.allMemoPeriods[index];
				if (this.loadedMemoPeriods.has(period)) {
					continue;
				}
				const shouldContinue = await this.waitForHydrationTurn(runId);
				if (!shouldContinue) {
					return false;
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
					this.hasHydrationPeriodsAfter(index)
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
			if (pendingMemos.length > 0) {
				const committed = await this.commitHydratedMemos(runId, pendingPeriods, pendingMemos, false);
				if (!committed) {
					return false;
				}
			}
			this.completeMobileMemoHydration();
			return true;
		} catch {
			if (this.isCurrentRun(runId)) {
				this.fastMode = false;
				this.loadMode = this.allMemosLoaded ? "all" : "recent";
				this.options.onFailed();
			}
			return false;
		}
	}

	private async waitForHydrationTurn(runId: number): Promise<boolean> {
		while (true) {
			const delay = this.isPaused() || !this.fastMode ? MOBILE_MEMO_HYDRATE_BACKGROUND_DELAY_MS : 0;
			const shouldContinue = await this.waitForTurn(runId, delay);
			if (!shouldContinue || !this.isPaused()) {
				return shouldContinue;
			}
		}
	}

	private waitForTurn(runId: number, delay: number): Promise<boolean> {
		return new Promise((resolve) => {
			this.options.scheduleTask(() => {
				resolve(this.isCurrentRun(runId));
			}, delay);
		});
	}

	private shouldCommitHydratedMemos(periodCount: number, memoCount: number): boolean {
		return periodCount >= MOBILE_MEMO_HYDRATE_BATCH_PERIODS || memoCount >= MOBILE_MEMO_HYDRATE_BATCH_MEMOS;
	}

	private hasHydrationPeriodsAfter(periodIndex: number): boolean {
		for (let index = periodIndex + 1; index < this.allMemoPeriods.length; index += 1) {
			if (!this.loadedMemoPeriods.has(this.allMemoPeriods[index])) {
				return true;
			}
		}
		return false;
	}

	private async commitHydratedMemos(
		runId: number,
		periods: readonly string[],
		memos: readonly MemoRecord[],
		notifyUi: boolean,
	): Promise<boolean> {
		if (this.isPaused()) {
			const shouldContinue = await this.waitForHydrationTurn(runId);
			if (!shouldContinue) {
				return false;
			}
		}
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
			memoById.set(memo.id, memo);
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
		this.fastMode = false;
		this.renderNextBatchAfterHydration = false;
		this.options.invalidateFilteredMemos();
		this.options.onCompleted(renderState);
	}

	private isPaused(): boolean {
		return this.options.isPaused?.() ?? false;
	}

	private clearDeferredSidebarHydration(): void {
		if (this.sidebarHydrateTimerId === null) {
			return;
		}
		this.options.cancelTask(this.sidebarHydrateTimerId);
		this.sidebarHydrateTimerId = null;
	}
}

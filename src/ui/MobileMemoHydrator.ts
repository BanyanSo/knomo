import type { MemoRecord } from "../types/memo";

const MOBILE_MEMO_HYDRATE_INITIAL_DELAY_MS = 1200;
const MOBILE_MEMO_HYDRATE_BACKGROUND_DELAY_MS = 180;

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
			for (const period of this.allMemoPeriods) {
				if (this.loadedMemoPeriods.has(period)) {
					continue;
				}
				const shouldContinue = await this.waitForTurn(runId);
				if (!shouldContinue) {
					return false;
				}
				const periodMemos = await this.options.listMemosInPeriods([period]);
				if (!this.isCurrentRun(runId)) {
					return false;
				}
				const renderState = this.options.captureRenderState();
				this.loadedMemoPeriods.add(period);
				this.mergeHydratedMemos(periodMemos);
				this.options.onPeriodHydrated(renderState);
			}
			if (!this.isCurrentRun(runId)) {
				return false;
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

	private waitForTurn(runId: number): Promise<boolean> {
		const delay = this.fastMode ? 0 : MOBILE_MEMO_HYDRATE_BACKGROUND_DELAY_MS;
		return new Promise((resolve) => {
			this.options.scheduleTask(() => {
				resolve(this.isCurrentRun(runId));
			}, delay);
		});
	}

	private mergeHydratedMemos(memos: MemoRecord[]): void {
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
		this.options.invalidateFilteredMemos();
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

	private clearDeferredSidebarHydration(): void {
		if (this.sidebarHydrateTimerId === null) {
			return;
		}
		this.options.cancelTask(this.sidebarHydrateTimerId);
		this.sidebarHydrateTimerId = null;
	}
}

import type { MemoViewItem as MemoRecord } from "../types/memoView";
import {
	KnomoCardFlowBatcher,
	runCardFlowBatch,
	type CardFlowBatch,
	type CardFlowBatchItem,
	type CardFlowRenderMode,
} from "./KnomoCardFlow";
import {
	KnomoCardFlowSentinel,
	type CardFlowSentinelRenderOptions,
} from "./KnomoCardFlowSentinel";
import type { CardFlowChangeIntent } from "./KnomoViewStateKeys";

interface PendingCardFlowScrollRestore {
	generation: number;
	scrollTop: number;
	visibleCount: number;
}

interface MobileCardFlowRenderRequest {
	forceRebuild: boolean;
	changeIntent: CardFlowChangeIntent;
	preserveCardMemoId: string | null;
}

interface CardFlowSentinelLike {
	readonly isObserving: boolean;
	render(options: CardFlowSentinelRenderOptions): void;
	remove(): void;
}

interface AnimationFrameWindow {
	requestAnimationFrame(callback: FrameRequestCallback): number;
	cancelAnimationFrame(handle: number): void;
}

interface RenderCardFlowBatchOptions {
	batch: CardFlowBatch | null;
	generation: number;
	hydrateWhenExhausted?: boolean;
	isMobile: boolean;
	syncItemLimit: number;
	chunkSize: number;
	renderItem: (item: CardFlowBatchItem, generation: number) => void;
	getSentinelRoot: () => HTMLElement | null;
	getObserver: () => typeof IntersectionObserver | undefined;
	onRenderNextBatch: (generation: number) => void;
	requestHydration: () => void;
	restorePendingScrollTop: (scrollTop: number) => void;
	scheduleContinuation: (continuation: () => void) => void;
	onExhausted?: () => void;
}

interface CardFlowScrollOptions {
	cardFlow: HTMLElement | null;
	isRecordStatsActive: boolean;
	onRenderNextBatch: (generation: number) => void;
	requestHydration: () => void;
}

export class KnomoCardFlowCoordinator {
	generation = 0;
	deferredForAllMemos = false;

	private readonly batcher: KnomoCardFlowBatcher;
	private readonly sentinel: CardFlowSentinelLike;
	private mobileRenderPending = false;
	private mobileForceRebuildPending = false;
	private mobileChangeIntentPending: CardFlowChangeIntent = "content-change";
	private mobilePreserveMemoId: string | null = null;
	private mobileBatchFrameId: number | null = null;
	private mobileBatchContinuation: (() => void) | null = null;
	private pendingScrollRestore: PendingCardFlowScrollRestore | null = null;

	constructor(options: {
		batcher?: KnomoCardFlowBatcher;
		sentinel?: CardFlowSentinelLike;
	} = {}) {
		this.batcher = options.batcher ?? new KnomoCardFlowBatcher();
		this.sentinel = options.sentinel ?? new KnomoCardFlowSentinel();
	}

	get hasMoreItems(): boolean {
		return this.batcher.hasMoreItems;
	}

	get remainingCount(): number {
		return this.batcher.remainingCount;
	}

	removeSentinel(): void {
		this.sentinel.remove();
	}

	resetBatcher(): void {
		this.batcher.reset();
	}

	resetFlowRuntime(win?: AnimationFrameWindow): void {
		this.clearMobileBatchContinuation(win);
		this.sentinel.remove();
		this.batcher.reset();
	}

	startBatch(memos: MemoRecord[], mode: CardFlowRenderMode, initialBatchSize: number): CardFlowBatch | null {
		return this.batcher.start(memos, mode, initialBatchSize);
	}

	beginNextBatch(batchSize: number): CardFlowBatch | null {
		return this.batcher.beginNextBatch(batchSize);
	}

	syncBatch(memos: MemoRecord[], mode: CardFlowRenderMode, renderedCount: number): void {
		this.batcher.sync(memos, mode, renderedCount);
	}

	updateBatchItemsAfterRendered(memos: MemoRecord[], renderedMemoIds: readonly string[]): void {
		this.batcher.updateItemsAfterRendered(memos, renderedMemoIds);
	}

	setPendingScrollRestore(pending: PendingCardFlowScrollRestore | null): void {
		this.pendingScrollRestore = pending;
	}

	getPendingVisibleCount(generation: number): number | null {
		return this.pendingScrollRestore?.generation === generation
			? this.pendingScrollRestore.visibleCount
			: null;
	}

	restorePendingScrollTop(generation: number, restoreScrollTop: (scrollTop: number) => void): void {
		const pending = this.pendingScrollRestore;
		if (pending === null || pending.generation !== generation || generation !== this.generation) {
			return;
		}
		this.pendingScrollRestore = null;
		restoreScrollTop(pending.scrollTop);
	}

	deferMobileRender(options: {
		isMobile: boolean;
		composerOpen: boolean;
		preserveCardMemoId: string | null;
		forceRebuild: boolean;
		changeIntent: CardFlowChangeIntent;
	}): boolean {
		if (!options.isMobile || !options.composerOpen) {
			return false;
		}
		this.mobileRenderPending = true;
		this.mobileForceRebuildPending ||= options.forceRebuild;
		if (options.changeIntent === "view-scope-change") {
			this.mobileChangeIntentPending = options.changeIntent;
		}
		if (options.preserveCardMemoId !== null) {
			this.mobilePreserveMemoId = options.preserveCardMemoId;
		}
		return true;
	}

	consumeMobileRenderRequest(): MobileCardFlowRenderRequest | null {
		if (!this.mobileRenderPending) {
			return null;
		}
		const request: MobileCardFlowRenderRequest = {
			forceRebuild: this.mobileForceRebuildPending,
			changeIntent: this.mobileChangeIntentPending,
			preserveCardMemoId: this.mobilePreserveMemoId,
		};
		this.mobileRenderPending = false;
		this.mobileForceRebuildPending = false;
		this.mobileChangeIntentPending = "content-change";
		this.mobilePreserveMemoId = null;
		return request;
	}

	renderBatch(options: RenderCardFlowBatchOptions): void {
		const maxItems = options.isMobile && options.batch?.type === "items"
			? options.syncItemLimit
			: undefined;
		this.runBatchChunk(options, 0, maxItems);
	}

	renderSentinelIfNeeded(options: {
		root: HTMLElement | null;
		Observer: typeof IntersectionObserver | undefined;
		onIntersect: (generation: number) => void;
	}): void {
		if (options.root === null || !this.batcher.hasMoreItems) {
			return;
		}
		this.renderSentinel({
			root: options.root,
			remainingCount: this.batcher.remainingCount,
			generation: this.generation,
			Observer: options.Observer,
			onIntersect: options.onIntersect,
		});
	}

	handleScroll(options: CardFlowScrollOptions): void {
		const cardFlow = options.cardFlow;
		if (
			cardFlow === null ||
			options.isRecordStatsActive ||
			this.sentinel.isObserving ||
			cardFlow.scrollTop + cardFlow.clientHeight < cardFlow.scrollHeight - 160
		) {
			return;
		}
		if (this.batcher.hasMoreItems) {
			options.onRenderNextBatch(this.generation);
			return;
		}
		options.requestHydration();
	}

	scheduleMobileBatchContinuation(
		continuation: () => void,
		win: AnimationFrameWindow,
		paused: boolean,
	): void {
		this.mobileBatchContinuation = continuation;
		if (paused || this.mobileBatchFrameId !== null) {
			return;
		}
		this.mobileBatchFrameId = win.requestAnimationFrame(() => {
			this.mobileBatchFrameId = null;
			const next = this.mobileBatchContinuation;
			this.mobileBatchContinuation = null;
			next?.();
		});
	}

	pauseMobileBatchContinuation(win: AnimationFrameWindow): void {
		if (this.mobileBatchFrameId === null) {
			return;
		}
		win.cancelAnimationFrame(this.mobileBatchFrameId);
		this.mobileBatchFrameId = null;
	}

	resumeMobileBatchContinuation(win: AnimationFrameWindow, paused: boolean): void {
		const continuation = this.mobileBatchContinuation;
		if (continuation === null) {
			return;
		}
		this.scheduleMobileBatchContinuation(continuation, win, paused);
	}

	clearMobileBatchContinuation(win?: AnimationFrameWindow): void {
		if (win !== undefined) {
			this.pauseMobileBatchContinuation(win);
		}
		this.mobileBatchContinuation = null;
	}

	private runBatchChunk(
		options: RenderCardFlowBatchOptions,
		startIndex: number,
		maxItems: number | undefined,
	): void {
		const result = runCardFlowBatch({
			batch: options.batch,
			generation: options.generation,
			hasRenderTarget: options.getSentinelRoot() !== null,
			isCurrentGeneration: (value) => value === this.generation,
			removeSentinel: () => this.sentinel.remove(),
			renderItem: (item) => options.renderItem(item, options.generation),
			completeBatch: (completedBatch) => this.batcher.completeBatch(completedBatch),
			cancelBatch: () => this.batcher.cancelBatch(),
			startIndex,
			maxItems,
		});
		if (result.type === "pending") {
			options.scheduleContinuation(() => {
				this.runBatchChunk(options, result.nextIndex, options.chunkSize);
			});
			return;
		}
		const root = options.getSentinelRoot();
		if (result.type === "completed" && result.completion.hasMoreItems && root !== null) {
			this.renderSentinel({
				root,
				remainingCount: result.completion.remainingCount,
				generation: options.generation,
				Observer: options.getObserver(),
				onIntersect: options.onRenderNextBatch,
			});
		} else if (options.hydrateWhenExhausted === true && result.type === "completed") {
			options.requestHydration();
		}
		if (result.type === "completed" && !result.completion.hasMoreItems) {
			options.onExhausted?.();
		}
		this.restorePendingScrollTop(options.generation, options.restorePendingScrollTop);
	}

	private renderSentinel(options: {
		root: HTMLElement;
		remainingCount: number;
		generation: number;
		Observer: typeof IntersectionObserver | undefined;
		onIntersect: (generation: number) => void;
	}): void {
		this.sentinel.render({
			root: options.root,
			remainingCount: options.remainingCount,
			generation: options.generation,
			Observer: options.Observer,
			isCurrentGeneration: (value) => value === this.generation,
			onIntersect: options.onIntersect,
		});
	}
}

import type { MemoRecord } from "../types/memo";
import { getMemoListStateKey } from "./MemoRenderRevision";

export type CardFlowRenderMode = "memo" | "trash";

export interface CardFlowBatchItem {
	memo: MemoRecord;
	mode: CardFlowRenderMode;
	renderIndex: number;
}

export type CardFlowBatch =
	| { type: "empty" }
	| {
		type: "items";
		items: CardFlowBatchItem[];
		batchEnd: number;
		totalCount: number;
	};

export interface CardFlowBatchCompletion {
	hasMoreItems: boolean;
	remainingCount: number;
}

export type CardFlowBatchRunResult =
	| { type: "skipped" }
	| { type: "empty" }
	| { type: "cancelled" }
	| { type: "pending"; nextIndex: number }
	| { type: "completed"; completion: CardFlowBatchCompletion };

export interface RunCardFlowBatchOptions {
	batch: CardFlowBatch | null;
	generation: number;
	hasRenderTarget: boolean;
	isCurrentGeneration: (generation: number) => boolean;
	removeSentinel: () => void;
	renderItem: (item: CardFlowBatchItem) => void;
	completeBatch: (batch: CardFlowBatch) => CardFlowBatchCompletion;
	cancelBatch: () => void;
	startIndex?: number;
	maxItems?: number;
}

export function getVisibleCardFlowMemoStateKey(
	memos: MemoRecord[],
	renderedCount: number,
	defaultBatchSize: number,
): string {
	const visibleCount = renderedCount > 0
		? renderedCount
		: Math.min(defaultBatchSize, memos.length);
	return getMemoListStateKey(memos.slice(0, visibleCount));
}

export function runCardFlowBatch(options: RunCardFlowBatchOptions): CardFlowBatchRunResult {
	const batch = options.batch;
	if (batch === null) {
		return { type: "skipped" };
	}
	if (batch.type === "empty") {
		options.removeSentinel();
		return { type: "empty" };
	}
	if (!options.hasRenderTarget) {
		options.cancelBatch();
		return { type: "cancelled" };
	}

	const startIndex = Math.max(0, options.startIndex ?? 0);
	const maxItems = Math.max(1, options.maxItems ?? batch.items.length);
	const endIndex = Math.min(startIndex + maxItems, batch.items.length);
	if (startIndex === 0) {
		options.removeSentinel();
	}
	for (let index = startIndex; index < endIndex; index += 1) {
		if (!options.isCurrentGeneration(options.generation)) {
			options.cancelBatch();
			return { type: "cancelled" };
		}
		options.renderItem(batch.items[index]);
	}
	if (endIndex < batch.items.length) {
		return { type: "pending", nextIndex: endIndex };
	}
	if (!options.isCurrentGeneration(options.generation)) {
		options.cancelBatch();
		return { type: "cancelled" };
	}
	return {
		type: "completed",
		completion: options.completeBatch(batch),
	};
}

export class KnomoCardFlowBatcher {
	private items: MemoRecord[] = [];
	private renderOffset = 0;
	private mode: CardFlowRenderMode = "memo";
	private loading = false;
	private hasMore = false;

	get hasMoreItems(): boolean {
		return this.hasMore;
	}

	get remainingCount(): number {
		return Math.max(0, this.items.length - this.renderOffset);
	}

	reset(): void {
		this.items = [];
		this.renderOffset = 0;
		this.mode = "memo";
		this.loading = false;
		this.hasMore = false;
	}

	start(memos: MemoRecord[], mode: CardFlowRenderMode, defaultBatchSize: number): CardFlowBatch | null {
		const initialBatchSize = Math.max(this.renderOffset, defaultBatchSize);
		this.items = memos;
		this.renderOffset = 0;
		this.mode = mode;
		this.loading = false;
		this.hasMore = memos.length > 0;
		return this.beginNextBatch(initialBatchSize);
	}

	updateItemsAfterRendered(memos: MemoRecord[], renderedMemoIds: readonly string[]): void {
		const memosById = new Map(memos.map((memo) => [memo.id, memo]));
		const renderedIds = new Set(renderedMemoIds);
		const rendered = renderedMemoIds.flatMap((memoId) => {
			const memo = memosById.get(memoId);
			return memo === undefined ? [] : [memo];
		});
		const pending = memos.filter((memo) => !renderedIds.has(memo.id));
		this.items = [...rendered, ...pending];
		this.renderOffset = rendered.length;
		this.hasMore = this.renderOffset < this.items.length;
	}

	sync(memos: MemoRecord[], mode: CardFlowRenderMode, renderedCount: number): void {
		this.items = memos;
		this.renderOffset = Math.min(Math.max(0, renderedCount), memos.length);
		this.mode = mode;
		this.loading = false;
		this.hasMore = this.renderOffset < this.items.length;
	}

	beginNextBatch(batchSize: number): CardFlowBatch | null {
		if (this.loading) {
			return null;
		}
		const batchStart = this.renderOffset;
		if (batchStart >= this.items.length) {
			this.hasMore = false;
			return { type: "empty" };
		}

		this.loading = true;
		const batchEnd = Math.min(batchStart + batchSize, this.items.length);
		return {
			type: "items",
			batchEnd,
			totalCount: this.items.length,
			items: this.items.slice(batchStart, batchEnd).map((memo, index) => ({
				memo,
				mode: this.mode,
				renderIndex: batchStart + index,
			})),
		};
	}

	completeBatch(batch: CardFlowBatch): CardFlowBatchCompletion {
		if (batch.type === "empty") {
			this.loading = false;
			this.hasMore = false;
			return { hasMoreItems: false, remainingCount: 0 };
		}
		this.renderOffset = batch.batchEnd;
		this.hasMore = this.renderOffset < batch.totalCount;
		this.loading = false;
		return {
			hasMoreItems: this.hasMore,
			remainingCount: Math.max(0, batch.totalCount - this.renderOffset),
		};
	}

	cancelBatch(): void {
		this.loading = false;
	}
}

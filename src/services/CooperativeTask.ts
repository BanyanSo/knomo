export interface CooperativeTaskRuntime {
	yieldControl: () => Promise<void>;
	sliceBudgetMs?: number;
	maxOperationsPerSlice?: number;
	now?: () => number;
}

// 职责：让长循环同时受时间预算和操作数量上限约束。
export class CooperativeYieldController {
	private readonly sliceBudgetMs: number;
	private readonly maxOperationsPerSlice: number;
	private readonly now: () => number;
	private operationsInSlice = 0;
	private sliceStartedAt: number;

	constructor(
		private readonly runtime: CooperativeTaskRuntime,
		maxOperationsPerSlice = runtime.maxOperationsPerSlice ?? 256,
	) {
		this.sliceBudgetMs = runtime.sliceBudgetMs ?? 8;
		this.maxOperationsPerSlice = maxOperationsPerSlice;
		this.now = runtime.now ?? monotonicNow;
		this.sliceStartedAt = this.now();
	}

	shouldYield(operationCount = 1): boolean {
		this.operationsInSlice += operationCount;
		return this.operationsInSlice >= this.maxOperationsPerSlice
			|| this.now() - this.sliceStartedAt >= this.sliceBudgetMs;
	}

	async yieldNow(): Promise<void> {
		this.operationsInSlice = 0;
		this.sliceStartedAt = this.now();
		await this.runtime.yieldControl();
		this.sliceStartedAt = this.now();
	}
}

export async function stableSortCooperatively<T>(
	values: readonly T[],
	compare: (left: T, right: T) => number,
	runtime?: CooperativeTaskRuntime,
): Promise<T[]> {
	if (runtime === undefined || values.length < 2) return [...values].sort(compare);
	let source = [...values];
	let target = new Array<T>(values.length);
	const yieldController = new CooperativeYieldController(runtime);
	for (let width = 1; width < source.length; width *= 2) {
		for (let start = 0; start < source.length; start += width * 2) {
			const middle = Math.min(start + width, source.length);
			const end = Math.min(start + width * 2, source.length);
			let left = start;
			let right = middle;
			for (let output = start; output < end; output += 1) {
				if (right >= end || (left < middle && compare(source[left] as T, source[right] as T) <= 0)) {
					target[output] = source[left] as T;
					left += 1;
				} else {
					target[output] = source[right] as T;
					right += 1;
				}
				if (yieldController.shouldYield()) await yieldController.yieldNow();
			}
		}
		[source, target] = [target, source];
	}
	return source;
}

function monotonicNow(): number {
	return typeof performance === "undefined" ? Date.now() : performance.now();
}

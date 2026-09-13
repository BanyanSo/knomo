import type { App } from "obsidian";
import type { MemoReviewStateMap } from "../types/review";

const STORAGE_KEY = "knomo.observationReviews";
const MAX_REVIEWS = 1000;

// 设备本地弱状态：key 包含 source revision，不跨 revision 继承，也不参与候选准入。
export class LocalMemoReviewStore {
	private states: MemoReviewStateMap | null = null;

	constructor(private readonly storage?: Pick<App, "loadLocalStorage" | "saveLocalStorage">) {}

	read(): MemoReviewStateMap {
		if (this.states !== null) return this.states;
		this.states = {};
		try {
			const saved: unknown = this.storage?.loadLocalStorage(STORAGE_KEY);
			if (!Array.isArray(saved)) return this.states;
			for (const item of saved.slice(-MAX_REVIEWS)) {
				if (Array.isArray(item) && typeof item[0] === "string" && Number.isSafeInteger(item[1])
					&& typeof item[1] === "number" && item[1] > 0 && typeof item[2] === "string" && Number.isFinite(Date.parse(item[2]))) {
					this.states[item[0]] = { memoId: item[0], reviewCount: item[1], lastReviewedAt: item[2] };
				}
			}
		} catch {
			// 本地缓存不可读时重置权重，普通正文和重逢仍可使用。
		}
		return this.states;
	}

	record(key: string, reviewedAt: string): void {
		const states = this.read();
		const next = { ...states };
		delete next[key];
		next[key] = { memoId: key, reviewCount: (states[key]?.reviewCount ?? 0) + 1, lastReviewedAt: reviewedAt };
		const entries = Object.values(next).slice(-MAX_REVIEWS);
		this.storage?.saveLocalStorage(STORAGE_KEY, entries.map((item) => [item.memoId, item.reviewCount, item.lastReviewedAt]));
		this.states = Object.fromEntries(entries.map((item) => [item.memoId, item]));
	}
}

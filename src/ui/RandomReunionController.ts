import { t } from "../i18n";
import type { MemoMutation, MemoRecord } from "../types/memo";
import { formatServiceError } from "../utils/serviceText";

const RANDOM_REUNION_DEFAULT_COUNT = 5;

export interface RandomReunionSnapshot {
	memos: MemoRecord[] | null;
	loading: boolean;
}

interface RandomReunionControllerOptions {
	ensureAllMemosLoaded: () => Promise<void>;
	getMemos: () => MemoRecord[];
	getRandomReunionMemos: (count: number, memos: MemoRecord[]) => Promise<MemoRecord[]>;
	markRandomReunionReviewed: (memoId: string) => Promise<void>;
	isRandomActive: () => boolean;
	showNotice: (message: string) => void;
	requestRender: () => void;
}

export class RandomReunionController {
	private memos: MemoRecord[] | null = null;
	private loading = false;

	constructor(private readonly options: RandomReunionControllerOptions) {}

	getSnapshot(): RandomReunionSnapshot {
		return {
			memos: this.memos,
			loading: this.loading,
		};
	}

	clearMemos(): void {
		this.memos = null;
	}

	applyMemoMutation(mutation: MemoMutation): void {
		if (this.memos === null) {
			return;
		}
		if (mutation.type === "delete") {
			this.memos = this.memos.filter((memo) => memo.id !== mutation.memo.id);
			return;
		}
		this.memos = this.memos.map((memo) => memo.id === mutation.memo.id ? mutation.memo : memo);
	}

	async refresh(): Promise<void> {
		if (this.loading) {
			return;
		}
		this.loading = true;
		this.memos = null;
		if (this.options.isRandomActive()) {
			this.options.requestRender();
		}
		try {
			await this.options.ensureAllMemosLoaded();
			this.memos = await this.options.getRandomReunionMemos(
				RANDOM_REUNION_DEFAULT_COUNT,
				this.options.getMemos(),
			);
		} catch (error) {
			this.memos = [];
			this.options.showNotice(formatServiceError(error, t("error.randomLoadFailed")));
		} finally {
			this.loading = false;
			if (this.options.isRandomActive()) {
				this.options.requestRender();
			}
		}
	}

	async markReviewedAfterOpen(memoId: string): Promise<void> {
		await this.options.markRandomReunionReviewed(memoId);
	}
}

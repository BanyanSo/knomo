import { t } from "../i18n";
import type { MemoViewItem as MemoRecord } from "../types/memoView";
import { formatServiceError } from "../utils/serviceText";

const RANDOM_REUNION_DEFAULT_COUNT = 5;

export interface RandomReunionSnapshot<TMemo extends MemoRecord = MemoRecord> {
	memos: TMemo[] | null;
	loading: boolean;
}

interface RandomReunionControllerOptions<TMemo extends MemoRecord> {
	prepareCatalogData: () => Promise<void>;
	getMemos: () => TMemo[];
	getRandomReunionMemos: (count: number, memos: TMemo[]) => Promise<TMemo[]>;
	openRandomReunionMemo: (memo: TMemo) => Promise<void>;
	markRandomReunionReviewed: (memoId: string) => Promise<void>;
	isRandomActive: () => boolean;
	showNotice: (message: string) => void;
	requestRender: () => void;
}

export class RandomReunionController<TMemo extends MemoRecord = MemoRecord> {
	private memos: TMemo[] | null = null;
	private loading = false;
	private readonly openingMemoIds = new Set<string>();

	constructor(private readonly options: RandomReunionControllerOptions<TMemo>) {}

	getSnapshot(): RandomReunionSnapshot<TMemo> {
		return {
			memos: this.memos,
			loading: this.loading,
		};
	}

	clearMemos(): void {
		this.memos = null;
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
			await this.options.prepareCatalogData();
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

	async markReviewed(memoId: string): Promise<void> {
		await this.options.markRandomReunionReviewed(memoId);
	}

	async openMemo(memoId: string): Promise<void> {
		if (this.openingMemoIds.has(memoId)) return;
		const memo = this.memos?.find((item) => item.id === memoId);
		if (memo === undefined) return;
		this.openingMemoIds.add(memoId);
		try {
			try {
				await this.options.openRandomReunionMemo(memo);
			} catch (error) {
				this.options.showNotice(formatRandomReunionActionError(t("error.randomOpenFailed"), error));
				return;
			}
			try {
				await this.options.markRandomReunionReviewed(memo.id);
			} catch (error) {
				this.options.showNotice(formatRandomReunionActionError(t("error.randomReviewSaveFailed"), error));
			}
		} finally {
			this.openingMemoIds.delete(memoId);
		}
	}
}

function formatRandomReunionActionError(actionLabel: string, error: unknown): string {
	const message = formatServiceError(error, actionLabel);
	if (message === actionLabel || message.startsWith(actionLabel)) return message;
	return t("error.actionFailedWithReason", { action: actionLabel, message });
}

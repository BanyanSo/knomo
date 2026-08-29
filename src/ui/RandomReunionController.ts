import { t } from "../i18n";
import type { MemoViewItem as MemoRecord } from "../types/memoView";
import { formatServiceError } from "../utils/serviceText";

const RANDOM_REUNION_DEFAULT_COUNT = 5;

export type RandomReunionStatus =
	| "idle"
	| "loading-candidates"
	| "preparing-identity"
	| "ready"
	| "empty"
	| "failed";

export interface RandomReunionSnapshot<TMemo extends MemoRecord = MemoRecord> {
	memos: TMemo[] | null;
	status: RandomReunionStatus;
	error: string | null;
}

interface RandomReunionControllerOptions<TMemo extends MemoRecord> {
	loadRandomReunionMemos: (count: number, onPreparingIdentity: () => void) => Promise<TMemo[]>;
	openRandomReunionMemo: (memo: TMemo) => Promise<void>;
	markRandomReunionReviewed: (memoId: string) => Promise<void>;
	isRandomActive: () => boolean;
	showNotice: (message: string) => void;
	requestRender: () => void;
}

export class RandomReunionController<TMemo extends MemoRecord = MemoRecord> {
	private memos: TMemo[] | null = null;
	private status: RandomReunionStatus = "idle";
	private error: string | null = null;
	private runId = 0;
	private readonly openingMemoIds = new Set<string>();

	constructor(private readonly options: RandomReunionControllerOptions<TMemo>) {}

	getSnapshot(): RandomReunionSnapshot<TMemo> {
		return {
			memos: this.memos,
			status: this.status,
			error: this.error,
		};
	}

	clearMemos(): void {
		this.runId += 1;
		this.memos = null;
		this.status = "idle";
		this.error = null;
	}

	async refresh(): Promise<void> {
		if (this.status === "loading-candidates" || this.status === "preparing-identity") {
			return;
		}
		const runId = ++this.runId;
		const previousMemos = this.memos;
		this.status = "loading-candidates";
		this.error = null;
		if (this.options.isRandomActive()) {
			this.options.requestRender();
		}
		try {
			const memos = await this.options.loadRandomReunionMemos(
				RANDOM_REUNION_DEFAULT_COUNT,
				() => this.setPreparingIdentity(runId),
			);
			if (runId !== this.runId) return;
			this.memos = memos;
			this.status = this.memos.length === 0 ? "empty" : "ready";
		} catch (error) {
			if (runId !== this.runId) return;
			const message = formatServiceError(error, t("error.randomLoadFailed"));
			this.options.showNotice(message);
			if (previousMemos !== null && previousMemos.length > 0) {
				this.memos = previousMemos;
				this.status = "ready";
				this.error = null;
			} else {
				this.memos = null;
				this.status = "failed";
				this.error = message;
			}
		} finally {
			if (runId === this.runId && this.options.isRandomActive()) {
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

	private setPreparingIdentity(runId: number): void {
		if (runId !== this.runId || this.status !== "loading-candidates") return;
		this.status = "preparing-identity";
		if (this.options.isRandomActive()) {
			this.options.requestRender();
		}
	}
}

function formatRandomReunionActionError(actionLabel: string, error: unknown): string {
	const message = formatServiceError(error, actionLabel);
	if (message === actionLabel || message.startsWith(actionLabel)) return message;
	return t("error.actionFailedWithReason", { action: actionLabel, message });
}

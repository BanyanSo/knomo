import { t } from "../i18n";
import type { MemoViewItem as MemoRecord } from "../types/memoView";
import { formatServiceError } from "../utils/serviceText";

const RANDOM_REUNION_DEFAULT_COUNT = 10;

export interface RandomReunionRequest {
	shownBatches: readonly (readonly string[])[];
	signal: AbortSignal;
}

export type RandomReunionStatus =
	| "idle"
	| "loading-candidates"
	| "ready"
	| "empty"
	| "failed";

export interface RandomReunionSnapshot<TMemo extends MemoRecord = MemoRecord> {
	memos: TMemo[] | null;
	status: RandomReunionStatus;
	error: string | null;
}

interface RandomReunionControllerOptions<TMemo extends MemoRecord> {
	loadRandomReunionMemos: (count: number, request: RandomReunionRequest) => Promise<TMemo[]>;
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
	private request: AbortController | null = null;
	private shownBatches: string[][] = [];
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
		this.cancelPending();
		this.memos = null;
		this.status = "idle";
		this.error = null;
	}

	cancelPending(): void {
		this.runId += 1;
		this.request?.abort();
		this.request = null;
		if (this.status === "loading-candidates") this.status = this.memos === null ? "idle" : this.memos.length > 0 ? "ready" : "empty";
	}

	dispose(): void {
		this.clearMemos();
		this.shownBatches = [];
	}

	async refresh(): Promise<void> {
		if (this.status === "loading-candidates") {
			return;
		}
		const runId = ++this.runId;
		const request = new AbortController();
		this.request = request;
		const previousMemos = this.memos;
		this.status = "loading-candidates";
		this.error = null;
		if (this.options.isRandomActive()) {
			this.options.requestRender();
		}
		try {
			const memos = await this.options.loadRandomReunionMemos(
				RANDOM_REUNION_DEFAULT_COUNT,
				{ shownBatches: this.shownBatches.map(batch => [...batch]), signal: request.signal },
			);
			if (runId !== this.runId || !this.options.isRandomActive()) {
				if (runId === this.runId) this.cancelPending();
				return;
			}
			this.memos = memos;
			this.status = this.memos.length === 0 ? "empty" : "ready";
			if (memos.length > 0) this.shownBatches = [...this.shownBatches, memos.slice(0, RANDOM_REUNION_DEFAULT_COUNT).map(memo => memo.id)].slice(-3);
		} catch (error) {
			if (runId !== this.runId) return;
			if (!this.options.isRandomActive()) { this.cancelPending(); return; }
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
			if (this.request === request) this.request = null;
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

}

function formatRandomReunionActionError(actionLabel: string, error: unknown): string {
	const message = formatServiceError(error, actionLabel);
	if (message === actionLabel || message.startsWith(actionLabel)) return message;
	return t("error.actionFailedWithReason", { action: actionLabel, message });
}

import { t } from "../i18n";
import type { MemoViewItem as MemoRecord } from "../types/memoView";
import { formatServiceError } from "../utils/serviceText";
import { getMemoRenderRevision } from "./MemoRenderRevision";
import { logContinuationFailure } from "../utils/continuationDiagnostics";

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
			logContinuationFailure("random", "selection", error, runId);
			if (previousMemos !== null && previousMemos.length > 0) {
				this.memos = previousMemos;
				this.status = "ready";
				this.error = t("feedback.refreshFailed");
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

	applyMemoChanges(changes: ReadonlyMap<string, TMemo | null>, render = true): boolean {
		if (this.memos === null || !this.memos.some(memo => changes.has(memo.id))) return false;
		this.cancelPending();
		this.memos = this.memos.flatMap(memo => {
			if (!changes.has(memo.id)) return [memo];
			const current = changes.get(memo.id);
			return current ? [current] : [];
		});
		this.status = this.memos.length > 0 ? "ready" : "empty";
		this.error = null;
		if (render && this.options.isRandomActive()) this.options.requestRender();
		return true;
	}

	removeMemo(memoId: string): boolean {
		return this.applyMemoChanges(new Map([[memoId, null]]));
	}

	reconcileMemos(memos: TMemo[], expected: TMemo[]): boolean {
		if (this.memos !== expected) return false;
		const changed = memos.length !== expected.length
			|| memos.some((memo, index) => getMemoRenderRevision(memo) !== getMemoRenderRevision(expected[index]));
		if (!changed) {
			if (this.error === t("feedback.refreshFailed")) { this.error = null; this.renderIfActive(); }
			return false;
		}
		const removed = memos.length < expected.length;
		this.cancelPending();
		this.memos = memos;
		this.status = memos.length > 0 ? "ready" : "empty";
		this.error = removed ? t("random.sourceChanged") : null;
		if (this.options.isRandomActive()) {
			this.options.requestRender();
		}
		return true;
	}

	reportRefreshFailure(expected: TMemo[], error: unknown): void {
		if (this.memos !== expected) return;
		logContinuationFailure("random", "readback", error, this.runId);
		this.error = expected.length > 0 ? t("feedback.refreshFailed") : t("feedback.loadFailed");
		this.renderIfActive();
	}

	private renderIfActive(): void { if (this.options.isRandomActive()) this.options.requestRender(); }

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
				if (this.options.isRandomActive()) this.options.showNotice(formatRandomReunionActionError(t("error.randomOpenFailed"), error));
				return;
			}
			try {
				await this.options.markRandomReunionReviewed(memo.id);
			} catch (error) {
				if (this.options.isRandomActive()) this.options.showNotice(formatRandomReunionActionError(t("error.randomReviewSaveFailed"), error));
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

import { t } from "../i18n";
import type { MemoViewItem as MemoRecord } from "../types/memoView";
import { formatServiceError } from "../utils/serviceText";
import { logContinuationFailure } from "../utils/continuationDiagnostics";
import {
	buildShuffleDayStats,
	getMemoLocalDateKey,
	sortShuffleDayMemos,
	type ShuffleDayStats,
	type ShuffleDaySelectionResult,
} from "../utils/shuffleDay";

export type ShuffleDayStatus =
	| "idle"
	| "loading"
	| "ready"
	| "empty-no-memos"
	| "empty-not-enough-history"
	| "empty-day-cleared"
	| "failed";

export interface ShuffleDaySnapshot {
	status: ShuffleDayStatus;
	selectedDate: string | null;
	memos: MemoRecord[];
	stats: ShuffleDayStats | null;
	error: string | null;
	historyError?: string | null;
}

export interface ShuffleDayRequest {
	currentDate: string | null;
	signal: AbortSignal;
}

interface ShuffleDayControllerOptions {
	loadSelectedDate: (date: string, signal: AbortSignal) => Promise<MemoRecord[]>;
	selectShuffleDay: (request: ShuffleDayRequest) => Promise<ShuffleDaySelectionResult>;
	acceptSelection: (date: string) => Promise<void>;
	isShuffleDayActive: () => boolean;
	requestRender: () => void;
}

export class ShuffleDayController {
	private status: ShuffleDayStatus = "idle";
	private selectedDate: string | null = null;
	private memos: MemoRecord[] = [];
	private stats: ShuffleDayStats | null = null;
	private error: string | null = null;
	private historyError: string | null = null;
	private loading = false;
	private runId = 0;
	private request: AbortController | null = null;

	constructor(private readonly options: ShuffleDayControllerOptions) {}

	getSnapshot(): ShuffleDaySnapshot {
		return {
			status: this.status,
			selectedDate: this.selectedDate,
			memos: this.memos,
			stats: this.stats,
			error: this.error,
			historyError: this.historyError,
		};
	}

	clearSelection(): void {
		this.cancelPending();
		this.status = "idle";
		this.selectedDate = null;
		this.memos = [];
		this.stats = null;
		this.error = null;
		this.historyError = null;
	}

	cancelPending(): void {
		this.cancelInFlightLoad();
		if (this.status === "loading") this.status = this.selectedDate === null ? "idle" : this.memos.length > 0 ? "ready" : "empty-day-cleared";
	}

	dispose(): void {
		this.clearSelection();
	}

	async reloadSelectedDate(): Promise<boolean> {
		if (this.loading || this.selectedDate === null) {
			return false;
		}
		const selectedDate = this.selectedDate;
		const previousStatus = this.status;
		const runId = ++this.runId;
		const request = new AbortController();
		this.request = request;
		this.loading = true;
		this.status = "loading";
		this.error = null;
		if (this.options.isShuffleDayActive()) {
			this.options.requestRender();
		}
		try {
			const memos = await this.options.loadSelectedDate(selectedDate, request.signal);
			if (runId !== this.runId || selectedDate !== this.selectedDate || !this.options.isShuffleDayActive()) {
				if (runId === this.runId) this.cancelPending();
				return false;
			}
			this.setSelectedMemos(memos.filter((memo) => getMemoLocalDateKey(memo) === selectedDate));
			return true;
		} catch (error) {
			if (runId !== this.runId) return false;
			if (!this.options.isShuffleDayActive()) { this.cancelPending(); return false; }
			this.status = previousStatus;
			this.error = this.memos.length > 0 ? t("feedback.refreshFailed") : formatServiceError(error, t("shuffleDay.failedDesc"));
			logContinuationFailure("shuffle-day", "selected-date", error, runId);
			return false;
		} finally {
			if (this.request === request) this.request = null;
			if (runId === this.runId) {
				this.loading = false;
				if (this.options.isShuffleDayActive()) {
					this.options.requestRender();
				}
			}
		}
	}

	applyMemoUpdate(memo: MemoRecord): boolean {
		if (this.selectedDate === null) return false;
		const index = this.memos.findIndex((item) => item.id === memo.id);
		const belongsToSelectedDate = memo.status === "active"
			&& memo.deletedAt === undefined
			&& getMemoLocalDateKey(memo) === this.selectedDate;
		if (index < 0 && !belongsToSelectedDate) return false;

		this.cancelInFlightLoad();
		const nextMemos = [...this.memos];
		if (belongsToSelectedDate) {
			if (index < 0) nextMemos.push(memo);
			else nextMemos[index] = memo;
		} else {
			nextMemos.splice(index, 1);
		}
		this.error = null;
		this.setSelectedMemos(nextMemos);
		this.requestRenderIfActive();
		return true;
	}

	applyMemoChanges(changes: ReadonlyMap<string, MemoRecord | null>, inserted: readonly MemoRecord[] = []): boolean {
		if (this.selectedDate === null) return false;
		const additions = inserted.filter(memo => getMemoLocalDateKey(memo) === this.selectedDate);
		if (additions.length === 0 && !this.memos.some(memo => changes.has(memo.id))) return false;
		this.cancelInFlightLoad();
		const updated = this.memos.flatMap(memo => {
			if (!changes.has(memo.id)) return [memo];
			const current = changes.get(memo.id);
			return current && getMemoLocalDateKey(current) === this.selectedDate ? [current] : [];
		});
		const byId = new Map([...updated, ...additions].map(memo => [memo.id, memo]));
		this.error = null;
		this.setSelectedMemos([...byId.values()]);
		return true;
	}

	removeMemo(memoId: string): boolean {
		const index = this.memos.findIndex((memo) => memo.id === memoId);
		if (index < 0) return false;
		this.cancelInFlightLoad();
		this.error = null;
		this.setSelectedMemos(this.memos.filter((memo) => memo.id !== memoId));
		this.requestRenderIfActive();
		return true;
	}

	async refresh(): Promise<void> {
		if (this.loading) {
			return;
		}
		const runId = ++this.runId;
		const request = new AbortController();
		this.request = request;
		const previousStatus = this.status;
		const hasCommittedSelection = this.selectedDate !== null && this.stats !== null && this.memos.length > 0;
		this.loading = true;
		this.status = "loading";
		if (!hasCommittedSelection) {
			this.selectedDate = null;
			this.memos = [];
			this.stats = null;
		}
		this.error = null;
		if (this.options.isShuffleDayActive()) {
			this.options.requestRender();
		}
		try {
			const result = await this.options.selectShuffleDay({ currentDate: this.selectedDate, signal: request.signal });
			if (runId !== this.runId || !this.options.isShuffleDayActive()) {
				if (runId === this.runId) this.cancelPending();
				return;
			}
			if (result.status === "ready") {
				this.selectedDate = result.selectedDate;
				this.setSelectedMemos(result.memos);
				this.historyError = result.historyUnavailable ? t("shuffleDay.historyReadFailed") : null;
				void this.options.acceptSelection(result.selectedDate).catch(error => {
					if (runId !== this.runId || !this.options.isShuffleDayActive()) return;
					logContinuationFailure("shuffle-day", "history-write", error, runId);
					this.historyError = [this.historyError, t("shuffleDay.historySaveFailed")].filter(Boolean).join(" ");
					this.requestRenderIfActive();
				});
			} else {
				this.historyError = null;
				this.selectedDate = null;
				this.memos = [];
				this.stats = null;
				this.status = result.status;
			}
		} catch (error) {
			if (runId !== this.runId) return;
			if (!this.options.isShuffleDayActive()) { this.cancelPending(); return; }
			this.status = hasCommittedSelection ? previousStatus : "failed";
			this.error = hasCommittedSelection ? t("feedback.refreshFailed") : formatServiceError(error, t("shuffleDay.failedDesc"));
			logContinuationFailure("shuffle-day", "selection", error, runId);
		} finally {
			if (this.request === request) this.request = null;
			if (runId === this.runId) {
				this.loading = false;
				if (this.options.isShuffleDayActive()) {
					this.options.requestRender();
				}
			}
		}
	}

	private setSelectedMemos(memos: MemoRecord[]): void {
		const activeMemos = memos.filter((memo) => memo.status === "active" && memo.deletedAt === undefined);
		const sortedMemos = sortShuffleDayMemos(activeMemos);
		this.memos = sortedMemos;
		if (sortedMemos.length === 0) {
			this.status = "empty-day-cleared";
			this.stats = null;
			return;
		}
		this.status = "ready";
		this.stats = buildShuffleDayStats(sortedMemos);
	}

	private cancelInFlightLoad(): void {
		this.runId += 1;
		this.loading = false;
		this.request?.abort();
		this.request = null;
	}

	private requestRenderIfActive(): void {
		if (this.options.isShuffleDayActive()) {
			this.options.requestRender();
		}
	}
}

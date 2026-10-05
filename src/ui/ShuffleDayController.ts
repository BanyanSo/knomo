import { t } from "../i18n";
import type { MemoViewItem as MemoRecord } from "../types/memoView";
import { formatServiceError } from "../utils/serviceText";
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
	showNotice: (message: string) => void;
	requestRender: () => void;
}

export class ShuffleDayController {
	private status: ShuffleDayStatus = "idle";
	private selectedDate: string | null = null;
	private memos: MemoRecord[] = [];
	private stats: ShuffleDayStats | null = null;
	private error: string | null = null;
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
		};
	}

	clearSelection(): void {
		this.cancelPending();
		this.status = "idle";
		this.selectedDate = null;
		this.memos = [];
		this.stats = null;
		this.error = null;
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
			this.error = formatServiceError(error, t("shuffleDay.failedDesc"));
			this.options.showNotice(this.error);
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
				if (result.historyUnavailable) this.options.showNotice(t("shuffleDay.historyReadFailed"));
				void this.options.acceptSelection(result.selectedDate).catch(error => {
					if (runId !== this.runId || !this.options.isShuffleDayActive()) return;
					this.options.showNotice(t("error.actionFailedWithReason", {
						action: t("shuffleDay.historySaveFailed"), message: formatServiceError(error, t("shuffleDay.historySaveFailed")),
					}));
				});
			} else {
				this.selectedDate = null;
				this.memos = [];
				this.stats = null;
				this.status = result.status;
			}
		} catch (error) {
			if (runId !== this.runId) return;
			if (!this.options.isShuffleDayActive()) { this.cancelPending(); return; }
			this.status = hasCommittedSelection ? previousStatus : "failed";
			this.error = formatServiceError(error, t("shuffleDay.failedDesc"));
			this.options.showNotice(this.error);
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

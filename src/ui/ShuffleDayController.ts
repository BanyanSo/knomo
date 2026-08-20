import { t } from "../i18n";
import type { ShuffleDayService } from "../services/ShuffleDayService";
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

interface ShuffleDayControllerOptions {
	ensureAllMemosLoaded: () => Promise<void>;
	getMemos: () => MemoRecord[];
	service: ShuffleDayService;
	selectShuffleDay?: (memos: MemoRecord[]) => Promise<ShuffleDaySelectionResult>;
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
		this.status = "idle";
		this.selectedDate = null;
		this.memos = [];
		this.stats = null;
		this.error = null;
	}

	reconcileWithMemos(): void {
		if (this.selectedDate === null || (this.status !== "ready" && this.status !== "empty-day-cleared")) {
			return;
		}
		const selectedMemos = this.options.getMemos().filter((memo) => {
			return memo.status === "active" && memo.deletedAt === undefined && getMemoLocalDateKey(memo) === this.selectedDate;
		});
		this.setSelectedMemos(selectedMemos);
	}

	async refresh(): Promise<void> {
		if (this.loading) {
			return;
		}
		this.loading = true;
		this.status = "loading";
		this.selectedDate = null;
		this.memos = [];
		this.stats = null;
		this.error = null;
		if (this.options.isShuffleDayActive()) {
			this.options.requestRender();
		}
		try {
			await this.options.ensureAllMemosLoaded();
			const result = await (this.options.selectShuffleDay?.(this.options.getMemos())
				?? this.options.service.selectShuffleDay(this.options.getMemos()));
			if (result.status === "ready") {
				this.selectedDate = result.selectedDate;
				this.setSelectedMemos(result.memos);
			} else {
				this.status = result.status;
			}
		} catch (error) {
			this.status = "failed";
			this.error = formatServiceError(error, t("shuffleDay.failedDesc"));
			this.options.showNotice(this.error);
		} finally {
			this.loading = false;
			if (this.options.isShuffleDayActive()) {
				this.options.requestRender();
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
}

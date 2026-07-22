import { t } from "../i18n";
import type { MemoRecord } from "../types/memo";
import { formatServiceError } from "../utils/serviceText";
import type { TrashAction } from "./KnomoActionDispatch";

export type TrashMemoRenderTarget = "ui-state" | "trash-count" | "trash-count-and-scope" | "card-flow";

export interface TrashMemoSnapshot {
	trashMemos: MemoRecord[] | null;
	trashLoading: boolean;
	trashError: string | null;
	trashCount: number;
	deletedMemoIds: ReadonlySet<string>;
	trashBusyMemoActions: ReadonlyMap<string, TrashAction>;
}

interface TrashMemoControllerOptions {
	getDeletedMemoSummary: () => Promise<{ count: number; ids: string[] }>;
	listDeletedMemos: () => Promise<MemoRecord[]>;
	restoreMemo: (memo: MemoRecord) => Promise<MemoRecord>;
	handleRestoredMemo: (deletedMemo: MemoRecord, restoredMemo: MemoRecord) => void;
	purgeDeletedMemo: (memo: MemoRecord) => Promise<void>;
	isTrashActive: () => boolean;
	confirmPurge: () => Promise<boolean>;
	showNotice: (message: string) => void;
	forceRefreshViews: () => Promise<void>;
	requestRender: (target: TrashMemoRenderTarget) => void;
}

export class TrashMemoController {
	private trashMemos: MemoRecord[] | null = null;
	private trashLoading = false;
	private trashError: string | null = null;
	private trashCount = 0;
	private deletedMemoIds = new Set<string>();
	private trashBusyMemoActions = new Map<string, TrashAction>();
	private readonly confirmingPurgeMemoIds = new Set<string>();

	constructor(private readonly options: TrashMemoControllerOptions) {}

	getSnapshot(): TrashMemoSnapshot {
		return {
			trashMemos: this.trashMemos,
			trashLoading: this.trashLoading,
			trashError: this.trashError,
			trashCount: this.trashCount,
			deletedMemoIds: this.deletedMemoIds,
			trashBusyMemoActions: this.trashBusyMemoActions,
		};
	}

	recordDeletedMemo(memoId: string): void {
		if (this.deletedMemoIds.has(memoId)) {
			return;
		}
		this.deletedMemoIds.add(memoId);
		this.trashCount += 1;
	}

	async refreshTrashCount(render = true): Promise<void> {
		try {
			const summary = await this.options.getDeletedMemoSummary();
			this.trashCount = summary.count;
			this.deletedMemoIds = new Set(summary.ids);
			this.trashError = null;
		} catch (error) {
			this.trashError = formatServiceError(error, t("error.trashCountFailed"));
		}
		this.options.requestRender(render ? "ui-state" : "trash-count-and-scope");
	}

	async loadTrashMemos(): Promise<void> {
		if (this.trashLoading) {
			return;
		}
		this.trashLoading = true;
		this.trashError = null;
		this.trashMemos = null;
		if (this.options.isTrashActive()) {
			this.options.requestRender("ui-state");
		}
		try {
			const deletedMemos = await this.options.listDeletedMemos();
			this.trashMemos = deletedMemos;
			this.trashCount = deletedMemos.length;
			this.deletedMemoIds = new Set(deletedMemos.map((memo) => memo.id));
		} catch (error) {
			this.trashMemos = [];
			this.trashError = formatServiceError(error, t("error.trashLoadFailed"));
			this.options.showNotice(this.trashError);
		} finally {
			this.trashLoading = false;
			this.options.requestRender(this.options.isTrashActive() ? "ui-state" : "trash-count");
		}
	}

	async handleTrashAction(action: TrashAction, memo: MemoRecord): Promise<void> {
		if (this.trashBusyMemoActions.has(memo.id) || this.confirmingPurgeMemoIds.has(memo.id)) {
			return;
		}
		if (action === "purge") {
			this.confirmingPurgeMemoIds.add(memo.id);
			try {
				if (!await this.options.confirmPurge()) {
					return;
			}
			} finally {
				this.confirmingPurgeMemoIds.delete(memo.id);
			}
		}

		this.trashBusyMemoActions.set(memo.id, action);
		this.options.requestRender("card-flow");
		try {
			if (action === "restore") {
				const restoredMemo = await this.options.restoreMemo(memo);
				this.removeTrashMemo(memo.id);
				this.options.handleRestoredMemo(memo, restoredMemo);
				this.options.showNotice(t("notice.restored"));
				await this.options.forceRefreshViews();
				return;
			}

			await this.options.purgeDeletedMemo(memo);
			this.removeTrashMemo(memo.id);
			this.options.showNotice(t("notice.purged"));
			await this.options.forceRefreshViews();
		} catch (error) {
			this.options.showNotice(formatTrashActionErrorMessage(action, error));
			this.options.requestRender("ui-state");
		} finally {
			this.trashBusyMemoActions.delete(memo.id);
			this.options.requestRender("card-flow");
		}
	}

	private removeTrashMemo(memoId: string): void {
		this.trashMemos = (this.trashMemos ?? []).filter((memo) => memo.id !== memoId);
		this.trashCount = Math.max(0, this.trashCount - 1);
	}
}

export function formatTrashActionErrorMessage(action: TrashAction, error: unknown): string {
	const actionLabel = action === "restore" ? t("error.restoreFailed") : t("error.purgeFailed");
	const fallbackMessage = action === "restore" ? t("error.restoreFailedRetry") : t("error.purgeFailedRetry");
	const message = formatServiceError(error, fallbackMessage);
	if (message === fallbackMessage || message.startsWith(actionLabel)) {
		return message;
	}
	return t("error.actionFailedWithReason", { action: actionLabel, message });
}

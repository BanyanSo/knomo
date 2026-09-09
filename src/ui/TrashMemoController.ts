import type { TrashSnapshotStore } from "../services/TrashSnapshotStore";
import type { TrashSnapshot } from "../types/trash";
import { t } from "../i18n";
import type { MemoViewItem as MemoRecord } from "../types/memoView";
import { formatServiceError } from "../utils/serviceText";
import type { TrashAction } from "./KnomoActionDispatch";

export type TrashMemoRenderTarget = "ui-state" | "trash-count-and-scope" | "card-flow";

export interface TrashMemoSnapshot<TMemo extends MemoRecord = MemoRecord> {
	trashMemos: TMemo[] | null;
	trashLoading: boolean;
	trashError: string | null;
	trashCount: number | null;
	trashCountLoading: boolean;
	trashCountError: string | null;
	trashBusyMemoActions: ReadonlyMap<string, TrashAction>;
}

interface TrashMemoControllerOptions<TMemo extends MemoRecord> {
	store: TrashSnapshotStore;
	toMemo: (snapshot: TrashSnapshot) => TMemo;
	pageSize: number;
	windowLimit: number;
	onInvalidated: () => void;
	restoreMemo: (memo: TMemo) => Promise<TMemo | null>;
	purgeMemo: (memo: TMemo) => Promise<void>;
	confirmPurge: (memo: TMemo) => Promise<boolean>;
	handleRestoredMemo: (deletedMemo: TMemo, restoredMemo: TMemo) => void;
	isTrashActive: () => boolean;
	showNotice: (message: string) => void;
	forceRefreshViews: () => Promise<void>;
	requestRender: (target: TrashMemoRenderTarget) => void;
}

export class TrashMemoController<TMemo extends MemoRecord = MemoRecord> {
	private disposed = false;
	private unsubscribe: (() => void) | null = null;
	private windowEnd = 0;
	private trashBusyMemoActions = new Map<string, TrashAction>();

	constructor(private readonly options: TrashMemoControllerOptions<TMemo>) {}

	start(): void {
		this.disposed = false;
		this.unsubscribe?.();
		this.unsubscribe = this.options.store.subscribe(() => {
			if (this.disposed) return;
			const state = this.options.store.getState();
			if (state.status === "idle") { this.windowEnd = this.options.pageSize; this.options.onInvalidated(); }
			this.render(this.options.isTrashActive() ? "ui-state" : "trash-count-and-scope");
		});
	}

	getSnapshot(): TrashMemoSnapshot<TMemo> {
		const state = this.options.store.getState();
		const end = Math.max(this.options.pageSize, this.windowEnd);
		const error = state.error === null ? null : formatServiceError(new Error(state.error), t("error.trashLoadFailed"));
		const memos = state.status === "ready"
			? state.items.slice(Math.max(0, Math.min(end, state.count) - this.options.windowLimit), end).map(this.options.toMemo) : null;
		return {
			trashMemos: memos,
			trashLoading: state.status === "idle" || state.status === "loading",
			trashError: error,
			trashCount: state.count,
			trashCountLoading: state.status === "loading",
			trashCountError: error,
			trashBusyMemoActions: this.trashBusyMemoActions,
		};
	}

	private render(target: TrashMemoRenderTarget): void { if (!this.disposed) this.options.requestRender(target); }

	dispose(): void { this.disposed = true; this.unsubscribe?.(); this.unsubscribe = null; }

	async ensureLoaded(): Promise<void> {
		if (this.disposed) return;
		const status = this.options.store.getState().status;
		if (status === "idle" || status === "loading") await this.options.store.query();
	}

	async loadTrashMemos(retry = false): Promise<void> {
		if (this.disposed) return;
		this.windowEnd = this.options.pageSize;
		if (retry) this.options.store.invalidate();
		this.render("ui-state");
		await this.ensureLoaded();
	}

	hasMore(): boolean {
		const state = this.options.store.getState();
		return state.status === "ready" && Math.max(this.windowEnd, this.options.pageSize) < state.count;
	}

	async loadNextPage(): Promise<boolean> {
		if (this.disposed || !this.hasMore()) return false;
		this.windowEnd = Math.max(this.windowEnd, this.options.pageSize) + this.options.pageSize;
		this.render("card-flow");
		return true;
	}

	async handleTrashAction(action: TrashAction, memo: TMemo): Promise<void> {
		if (this.disposed || this.trashBusyMemoActions.has(memo.id)) {
			return;
		}

		this.trashBusyMemoActions.set(memo.id, action);
		const renderBusyState = action !== "purge";
		let trashChanged = false;
		if (renderBusyState) this.render("card-flow");
		try {
			if (action === "purge") {
				if (!await this.options.confirmPurge(memo) || this.disposed) return;
				await this.options.purgeMemo(memo);
				trashChanged = true;
				this.options.showNotice(t("notice.purged"));
			} else {
				const restoredMemo = await this.options.restoreMemo(memo);
				trashChanged = true;
				if (restoredMemo !== null && !this.disposed) this.options.handleRestoredMemo(memo, restoredMemo);
				this.options.showNotice(t("notice.restored"));
			}
			try {
				await this.options.forceRefreshViews();
			} catch {
				this.options.showNotice(t("catalog.savedRefreshPending"));
			}
		} catch (error) {
			this.options.showNotice(formatTrashActionErrorMessage(action, error));
			if (renderBusyState) this.render("ui-state");
		} finally {
			this.trashBusyMemoActions.delete(memo.id);
			if (renderBusyState || trashChanged) this.render("card-flow");
		}
	}

}

export function formatTrashActionErrorMessage(action: TrashAction, error: unknown): string {
	const actionLabel = action === "purge" ? t("error.purgeFailed") : t("error.restoreFailed");
	const fallbackMessage = action === "purge" ? t("error.purgeFailedRetry") : t("error.restoreFailedRetry");
	const message = formatServiceError(error, fallbackMessage);
	if (message === fallbackMessage || message.startsWith(actionLabel)) {
		return message;
	}
	return t("error.actionFailedWithReason", { action: actionLabel, message });
}

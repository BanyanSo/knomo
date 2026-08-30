import { t } from "../i18n";
import type { MemoViewItem as MemoRecord } from "../types/memoView";
import { formatServiceError } from "../utils/serviceText";
import type { TrashAction } from "./KnomoActionDispatch";

export type TrashMemoRenderTarget = "ui-state" | "trash-count" | "trash-count-and-scope" | "card-flow";

export interface TrashMemoSnapshot<TMemo extends MemoRecord = MemoRecord> {
	trashMemos: TMemo[] | null;
	trashLoading: boolean;
	trashError: string | null;
	trashCount: number;
	deletedMemoIds: ReadonlySet<string>;
	trashBusyMemoActions: ReadonlyMap<string, TrashAction>;
}

interface TrashMemoControllerOptions<TMemo extends MemoRecord> {
	getDeletedMemoSummary: () => Promise<{ count: number; ids: string[] }>;
	listDeletedMemos: () => Promise<TMemo[]>;
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
	private trashMemos: TMemo[] | null = null;
	private trashLoading = false;
	private trashError: string | null = null;
	private trashCount = 0;
	private deletedMemoIds = new Set<string>();
	private trashBusyMemoActions = new Map<string, TrashAction>();
	private trashMutationRevision = 0;

	constructor(private readonly options: TrashMemoControllerOptions<TMemo>) {}

	getSnapshot(): TrashMemoSnapshot<TMemo> {
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
		const mutationRevision = this.trashMutationRevision;
		this.trashLoading = true;
		this.trashError = null;
		if (this.options.isTrashActive()) {
			this.options.requestRender("ui-state");
		}
		try {
			const [deletedMemos, summary] = await Promise.all([
				this.options.listDeletedMemos(),
				this.options.getDeletedMemoSummary(),
			]);
			if (mutationRevision !== this.trashMutationRevision) return;
			this.trashMemos = deletedMemos;
			this.trashCount = Math.max(summary.count, deletedMemos.length);
			this.deletedMemoIds = new Set([...summary.ids, ...deletedMemos.map((memo) => memo.id)]);
		} catch (error) {
			if (mutationRevision !== this.trashMutationRevision) return;
			if (this.trashMemos === null) this.trashMemos = [];
			this.trashError = formatServiceError(error, t("error.trashLoadFailed"));
			this.options.showNotice(this.trashError);
		} finally {
			this.trashLoading = false;
			this.options.requestRender(this.options.isTrashActive() ? "ui-state" : "trash-count");
		}
	}

	appendTrashMemos(memos: readonly TMemo[], limit = Number.MAX_SAFE_INTEGER): void {
		const byId = new Map((this.trashMemos ?? []).map((memo) => [memo.id, memo]));
		for (const memo of memos) byId.set(memo.id, memo);
		this.trashMemos = [...byId.values()].slice(-Math.max(1, Math.trunc(limit)));
		this.options.requestRender("card-flow");
	}

	async handleTrashAction(action: TrashAction, memo: TMemo): Promise<void> {
		if (this.trashBusyMemoActions.has(memo.id)) {
			return;
		}

		this.trashBusyMemoActions.set(memo.id, action);
		const renderBusyState = action !== "purge";
		let trashChanged = false;
		if (renderBusyState) this.options.requestRender("card-flow");
		try {
			if (action === "purge") {
				if (!await this.options.confirmPurge(memo)) return;
				await this.options.purgeMemo(memo);
				this.removeTrashMemo(memo);
				trashChanged = true;
				this.options.showNotice(t("notice.purged"));
			} else {
				const restoredMemo = await this.options.restoreMemo(memo);
				this.removeTrashMemo(memo);
				trashChanged = true;
				if (restoredMemo !== null) this.options.handleRestoredMemo(memo, restoredMemo);
				this.options.showNotice(t("notice.restored"));
			}
			try {
				await this.options.forceRefreshViews();
			} catch {
				this.options.showNotice(t("catalog.savedRefreshPending"));
			}
		} catch (error) {
			this.options.showNotice(formatTrashActionErrorMessage(action, error));
			if (renderBusyState) this.options.requestRender("ui-state");
		} finally {
			this.trashBusyMemoActions.delete(memo.id);
			if (renderBusyState || trashChanged) this.options.requestRender("card-flow");
		}
	}

	private removeTrashMemo(removedMemo: TMemo): void {
		this.trashMutationRevision += 1;
		this.trashMemos = (this.trashMemos ?? []).filter((memo) => memo.id !== removedMemo.id);
		this.trashCount = Math.max(0, this.trashCount - 1);
		const identityMemoId = removedMemo.trashItem?.memoId;
		if (identityMemoId !== undefined
			&& !(this.trashMemos ?? []).some((memo) => memo.trashItem?.memoId === identityMemoId)) {
			this.deletedMemoIds.delete(identityMemoId);
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

import type { MemoObservation } from "./catalog";

// 恢复副本不是 Memo 身份，也不证明正文已经删除。
export interface TrashSnapshot {
	snapshotId: string;
	deletedAt: string;
	sourcePath: string;
	logicalDate: string;
	section: string | null;
	rawBlock: string;
}

export interface TrashQueryResult {
	items: TrashSnapshot[];
	errors: Array<{ snapshotId: string; message: string }>;
}

export type TrashStoreState =
	| { status: "idle" | "loading" | "error"; items: null; count: null; error: string | null }
	| { status: "ready"; items: TrashSnapshot[]; count: number; error: null };

// 摘要不携带正文；窗口中的 count 仍是同次发布的集合总数。
export type TrashStoreSummary =
	| { status: "idle" | "loading" | "error"; count: null; error: string | null }
	| { status: "ready"; count: number; error: null };

export interface TrashWriteResult {
	snapshotId: string;
	state: "deleted" | "restored" | "restored_cleanup_pending";
	observation: MemoObservation | null;
	catalogUpdatePending: boolean;
	message?: string;
}

export interface TrashMemoItem {
	rawBlock: string;
	snapshotId: string;
	key: string;
	createdAt: string;
	deletedAt: string;
	logicalDate: string;
	sourcePath: string;
	section: string | null;
	content: string;
	contentHash: string;
	purgeAllowed: boolean;
}

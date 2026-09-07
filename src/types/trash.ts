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

export interface TrashWriteResult {
	snapshotId: string;
	state: "deleted" | "restored" | "restored_cleanup_pending";
	observation: MemoObservation | null;
	catalogUpdatePending: boolean;
	message?: string;
}

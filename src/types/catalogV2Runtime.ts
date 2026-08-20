import type { StateOperation } from "./catalogV2";

type DistributedOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, Extract<keyof T, K>> : never;

export type StateOperationDraft = DistributedOmit<StateOperation, "schemaVersion" | "writerId" | "sequence">;

export type CatalogV2PendingTransactionKind = "create" | "copy" | "edit" | "task" | "delete" | "restore";

export type CatalogV2PendingMutationStatus =
	| "prepared"
	| "daily_after"
	| "committed_unbound"
	| "abandoned"
	| "attention";

export interface CatalogV2PendingMutationInspectionItem {
	mutationId: string;
	transactionId: string | null;
	memoId: string | null;
	status: CatalogV2PendingMutationStatus;
	paths: string[];
	reasons: string[];
}

export interface CatalogV2PendingMutationInspection {
	items: CatalogV2PendingMutationInspectionItem[];
	affectedPaths: string[];
	affectedMemoIds: string[];
}

export interface CatalogV2PendingTransaction {
	transactionId: string;
	kind: CatalogV2PendingTransactionKind;
	memoId: string;
	sourcePath: string;
	logicalDate: string;
	beforeRevision: string | null;
	afterRevision: string;
	operationDrafts: StateOperationDraft[];
	createdAt: string;
	rawBlock?: string;
	beforeRawBlock?: string;
	afterRawBlock?: string;
	headings?: string[];
	section?: string | null;
	createIntentOpId?: string;
	createIntentDurable?: boolean;
	time?: string;
	contentHash?: string;
	sharedPrepare?: import("./catalogV2").ArtifactRef;
}

export interface CatalogV2PendingPointer {
	transactionId: string;
	kind: CatalogV2PendingTransactionKind;
	memoId: string;
	sourcePath: string;
	logicalDate: string;
	createdAt: string;
	sharedPrepare: import("./catalogV2").ArtifactRef;
}

export interface CatalogV2StateOperationOutboxItem {
	id: string;
	kind: "state_operation";
	operation: StateOperation;
}

export interface CatalogV2MonthlyProjectionOutboxItem {
	id: string;
	kind: "monthly_projection";
	// 兼容阶段 4 已落盘的按 memo outbox；阶段 5 运行时按 period 合并执行。
	memoId: string | null;
	logicalDate: string;
	period?: string;
	sourceRevision: string;
	createdAt: string;
}

export interface CatalogV2DeletedPayloadCleanupOutboxItem {
	id: string;
	kind: "deleted_payload_cleanup";
	memoId: string;
	deleteOpId: string;
	payloadPath: string;
	dependsOnOpId: string;
	createdAt: string;
}

export type CatalogV2OutboxItem =
	| CatalogV2StateOperationOutboxItem
	| CatalogV2MonthlyProjectionOutboxItem
	| CatalogV2DeletedPayloadCleanupOutboxItem;

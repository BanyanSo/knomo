import type { IdentityHandle, MemoObservation, ObservationHandle } from "./catalog";

export type MarkdownMutationCommitStatus = "committed_identity_pending" | "committed_content_pending";

export interface MarkdownMutationResult {
	status: MarkdownMutationCommitStatus;
	observation: MemoObservation | null;
	sourcePaths: string[];
	catalogUpdatePending: boolean;
}

export interface MarkdownBlockReferenceResult extends MarkdownMutationResult {
	blockId: string;
}

export interface MarkdownCreateInput {
	content: string;
	targetLogicalDate?: string;
	createdAt?: Date;
}

export interface MarkdownEditInput {
	observation: ObservationHandle;
	content: string;
}

export interface MarkdownTaskInput {
	observation: ObservationHandle;
	taskIndex: number;
	checked: boolean;
}

export interface MarkdownCopyInput {
	observation: ObservationHandle;
	targetLogicalDate: string;
	createdAt?: Date;
}

export interface MarkdownMoveInput extends MarkdownCopyInput {}

export interface MarkdownRemoveInput {
	observation: ObservationHandle;
}

export interface MarkdownRestoreInput {
	targetLogicalDate: string;
	rawBlock: string;
	section: string | null;
}

export interface MarkdownCapturedObservation {
	observation: MemoObservation;
	rawBlock: string;
}

export interface MarkdownBlockReferenceInput {
	observation: ObservationHandle;
	sourcePath: string;
}

export interface MarkdownMutationService {
	create(input: MarkdownCreateInput): Promise<MarkdownMutationResult>;
	edit(input: MarkdownEditInput): Promise<MarkdownMutationResult>;
	toggleTask(input: MarkdownTaskInput): Promise<MarkdownMutationResult>;
	copy(input: MarkdownCopyInput): Promise<MarkdownMutationResult>;
	move(input: MarkdownMoveInput): Promise<MarkdownMutationResult>;
	remove(input: MarkdownRemoveInput): Promise<MarkdownMutationResult>;
	captureObservation?(input: MarkdownRemoveInput): Promise<MarkdownCapturedObservation>;
	restore?(input: MarkdownRestoreInput): Promise<MarkdownMutationResult>;
	createBlockReference(input: MarkdownBlockReferenceInput): Promise<MarkdownBlockReferenceResult>;
}

export interface IdentityRelationInput {
	identity: IdentityHandle;
	sourceIdentity: IdentityHandle | null;
}

export interface IdentityReviewInput {
	identity: IdentityHandle;
	reviewedAt: string;
}

export interface IdentityTrashInput {
	identity: IdentityHandle;
	observation: ObservationHandle;
}

export interface IdentityRestoreInput {
	identity: IdentityHandle;
}

export interface IdentityMergeInput {
	identity: IdentityHandle;
	duplicateIdentity: IdentityHandle;
}

export interface IdentityRepairInput {
	identity: IdentityHandle;
	targetObservation: ObservationHandle;
}

export interface IdentityMutationService {
	setRelation(input: IdentityRelationInput): Promise<void>;
	recordReview(input: IdentityReviewInput): Promise<void>;
	trash(input: IdentityTrashInput): Promise<void>;
	restore(input: IdentityRestoreInput): Promise<void>;
	merge(input: IdentityMergeInput): Promise<void>;
	repair(input: IdentityRepairInput): Promise<void>;
}

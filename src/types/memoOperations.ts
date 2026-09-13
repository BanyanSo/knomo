import type { MemoObservation, ObservationHandle } from "./catalog";

export type MarkdownMutationCommitStatus = "committed" | "committed_content_pending";

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
	onDailyCommitted?: () => void;
}

export interface MarkdownEditInput {
	observation: ObservationHandle;
	content: string;
	onDailyCommitted?: () => void;
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

export type MarkdownMoveInput = MarkdownCopyInput;

export interface MarkdownRemoveInput {
	observation: ObservationHandle;
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
	createBlockReference(input: MarkdownBlockReferenceInput): Promise<MarkdownBlockReferenceResult>;
}

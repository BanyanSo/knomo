import type { MemoObservation, ObservationHandle } from "./catalog";

export interface MarkdownMutationResult {
	status: "committed";
	observation: MemoObservation | null;
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
	validateImageSource?: (sourcePath: string) => void;
}

export interface MarkdownEditInput {
	observation: ObservationHandle;
	content: string;
	onDailyCommitted?: () => void;
	validateImageSource?: (sourcePath: string) => void;
}

export interface MarkdownTaskInput {
	observation: ObservationHandle;
	taskIndex: number;
	checked: boolean;
}

export interface MarkdownBlockReferenceInput {
	observation: ObservationHandle;
	sourcePath: string;
}

export interface MarkdownMutationService {
	create(input: MarkdownCreateInput): Promise<MarkdownMutationResult>;
	edit(input: MarkdownEditInput): Promise<MarkdownMutationResult>;
	toggleTask(input: MarkdownTaskInput): Promise<MarkdownMutationResult>;
	createBlockReference(input: MarkdownBlockReferenceInput): Promise<MarkdownBlockReferenceResult>;
}

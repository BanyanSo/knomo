import type { MemoObservation } from "./catalog";

export type IdentityLedgerEventType =
	| "create_intent"
	| "claim"
	| "rebind"
	| "relation"
	| "review"
	| "delete_payload"
	| "delete_commit"
	| "restore"
	| "purge"
	| "repair";

export interface IdentityLedgerObservationEvidence {
	sourcePath: string;
	sourceRevision: string;
	rawBlockHash: string;
	logicalDate: string;
	section: string | null;
	startLine: number;
	endLine: number;
	time: string;
	contentHash: string;
}

interface IdentityLedgerEventBase {
	eventId: string;
	writerId: string;
	memoId: string;
	baseBindingId: string | null;
	occurredAt: string;
}

export type IdentityLedgerCreateIntentEvent = IdentityLedgerEventBase & {
	type: "create_intent";
	baseBindingId: null;
	evidence: {
		targetPath: string | null;
		logicalDate: string;
		time: string;
		contentHash: string;
		sourceMemoId: string | null;
	};
};

export type IdentityLedgerClaimEvent = IdentityLedgerEventBase & {
	type: "claim";
	baseBindingId: null;
	evidence: {
		observation: IdentityLedgerObservationEvidence;
		createIntentEventId: string | null;
	};
};

export type IdentityLedgerRebindEvent = IdentityLedgerEventBase & {
	type: "rebind";
	baseBindingId: string;
	evidence: {
		observation: IdentityLedgerObservationEvidence;
		reason: "edit" | "move" | "rename" | "restore" | "manual_resolution";
	};
};

export type IdentityLedgerRelationEvent = IdentityLedgerEventBase & {
	type: "relation";
	baseBindingId: string;
	evidence: {
		sourceMemoId: string | null;
	};
};

export type IdentityLedgerReviewEvent = IdentityLedgerEventBase & {
	type: "review";
	baseBindingId: string;
	evidence: {
		reviewedAt: string;
	};
};

export type IdentityLedgerDeletePayloadEvent = IdentityLedgerEventBase & {
	type: "delete_payload";
	baseBindingId: string;
		evidence: {
			deletedAt: string;
			sourcePath: string;
			deletedSourceRevision: string | null;
			logicalDate: string;
		section: string | null;
		rawBlock: string;
		contentHash: string;
		sourceMemoId: string | null;
	};
};

export type IdentityLedgerDeleteCommitEvent = IdentityLedgerEventBase & {
	type: "delete_commit";
	baseBindingId: string;
	evidence: {
		deleteEventId: string;
	};
};

export type IdentityLedgerRestoreEvent = IdentityLedgerEventBase & {
	type: "restore";
	baseBindingId: string;
	evidence: {
		observation: IdentityLedgerObservationEvidence;
		deleteEventId: string;
	};
};

export type IdentityLedgerPurgeEvent = IdentityLedgerEventBase & {
	type: "purge";
	baseBindingId: string;
	evidence: {
		deleteEventId: string;
	};
};

export type IdentityLedgerRepairEvent = IdentityLedgerEventBase & {
	type: "repair";
	baseBindingId: string;
	evidence: {
		observation: IdentityLedgerObservationEvidence;
	};
};

export type IdentityLedgerEvent =
	| IdentityLedgerCreateIntentEvent
	| IdentityLedgerClaimEvent
	| IdentityLedgerRebindEvent
	| IdentityLedgerRelationEvent
	| IdentityLedgerReviewEvent
	| IdentityLedgerDeletePayloadEvent
	| IdentityLedgerDeleteCommitEvent
	| IdentityLedgerRestoreEvent
	| IdentityLedgerPurgeEvent
	| IdentityLedgerRepairEvent;

export interface IdentityLedgerEventEnvelope {
	event: IdentityLedgerEvent;
	digest: string;
	sourcePath: string;
}

export interface ParsedIdentityLedgerSegment {
	path: string;
	writerId: string;
	digest: string;
	byteLength: number;
	events: IdentityLedgerEventEnvelope[];
}

export interface IdentityLedgerBinding {
	memoId: string;
	bindingId: string;
	identityRevision: string;
	evidence: IdentityLedgerObservationEvidence;
}

export type IdentityLedgerRebindReason = IdentityLedgerRebindEvent["evidence"]["reason"];

export type IdentityLedgerObservationState =
	| { kind: "unbound" }
	| { kind: "identified"; binding: IdentityLedgerBinding }
	| { kind: "conflicted"; memoIds: string[]; bindings: IdentityLedgerBinding[] };

export interface IdentityLedgerReconcileResult {
	appendedEventCount: number;
	conflictedMemoIds: string[];
	deferredObservationCount: number;
}

export interface IdentityLedgerMaterializedMemo {
	memoId: string;
	createdAt: string | null;
	bindings: IdentityLedgerBinding[];
	conflicted: boolean;
	conflictBaseBindingId: string | null;
	sourceMemoIds: string[];
	reviewCount: number;
	lastReviewedAt: string | null;
	pendingDeletes?: IdentityLedgerDeleteRecord[];
	activeDeletes?: IdentityLedgerDeleteRecord[];
	purgedDeleteEventIds?: string[];
}

export interface IdentityLedgerDeleteRecord {
	memoId: string;
	deleteEventId: string;
	deleteCommitEventId: string | null;
	baseBindingId: string;
	evidence: IdentityLedgerDeletePayloadEvent["evidence"];
}

export interface IdentityLedgerSnapshot {
	revision: string;
	eventCount: number;
	memos: Record<string, IdentityLedgerMaterializedMemo>;
	pendingIntents: IdentityLedgerCreateIntentEvent[];
	quarantinedEventIds: string[];
}

export interface IdentityLedgerCreateInput {
	targetPath: string | null;
	logicalDate: string;
	time: string;
	contentHash: string;
	sourceMemoId: string | null;
}

export interface IdentityLedgerCreatePlan {
	memoId: string;
	intent: IdentityLedgerCreateIntentEvent;
	intentDurable: boolean;
}

export type IdentityLedgerStatus = "missing" | "absent" | "ready" | "conflicted" | "unavailable";
export type IdentityLedgerAttentionRoute = "settings_retry" | "quarantine" | null;

export interface IdentityLedgerReader {
	getRevision(): string;
	getStatus(): IdentityLedgerStatus;
	getAttentionRoute?(): IdentityLedgerAttentionRoute;
	getSnapshot(): IdentityLedgerSnapshot;
	resolveObservation(observation: MemoObservation): IdentityLedgerBinding | null;
	resolveObservationState(observation: MemoObservation): IdentityLedgerObservationState;
	getSourceMemoId(memoId: string): string | null;
	getCreatedAt(memoId: string): string | null;
	getReviewState(memoId: string): { reviewCount: number; lastReviewedAt: string | null };
	getPendingDeletes?(): IdentityLedgerDeleteRecord[];
	getActiveDeletes?(): IdentityLedgerDeleteRecord[];
}

export interface IdentityLedgerLegacyImportTarget extends IdentityLedgerReader {
	importVerifiedLegacyEvents(
		events: readonly IdentityLedgerEvent[],
		runtime?: {
			cancellationSignal?: AbortSignal;
			yieldControl?: () => Promise<void>;
			sliceBudgetMs?: number;
			now?: () => number;
		},
	): Promise<number>;
	verifyPersistedSnapshot(expectedRevision: string): Promise<boolean>;
}

export interface IdentityLedgerMutationService extends IdentityLedgerReader {
	beginCreate(input: IdentityLedgerCreateInput): Promise<IdentityLedgerCreatePlan>;
	finishCreate(plan: IdentityLedgerCreatePlan, observation: MemoObservation): Promise<IdentityLedgerBinding>;
	reconcilePendingCreates(observations: readonly MemoObservation[]): Promise<number>;
	reconcilePendingDeletes?(sourceRevisions: Readonly<Record<string, string>>): Promise<number>;
	reconcileRevision(
		before: readonly MemoObservation[],
		after: readonly MemoObservation[],
		insertedObservation?: MemoObservation | null,
		allowIdentityAdoption?: boolean,
	): Promise<IdentityLedgerReconcileResult>;
	rebindObservation(
		before: MemoObservation,
		after: MemoObservation,
		reason: IdentityLedgerRebindReason,
	): Promise<IdentityLedgerBinding | null>;
	adoptObservation(observation: MemoObservation): Promise<IdentityLedgerBinding>;
	repairConflict(memoId: string, observation: MemoObservation): Promise<IdentityLedgerBinding>;
	recordReview(binding: IdentityLedgerBinding, reviewedAt: string): Promise<void>;
	recordDeletePayload?(
		binding: IdentityLedgerBinding,
		payload: IdentityLedgerDeletePayloadEvent["evidence"],
	): Promise<IdentityLedgerDeleteRecord>;
	recordDeleteCommit?(deleteRecord: IdentityLedgerDeleteRecord): Promise<IdentityLedgerDeleteRecord>;
	recordRestore?(deleteRecord: IdentityLedgerDeleteRecord, observation: MemoObservation): Promise<IdentityLedgerBinding>;
	recordPurge?(deleteRecord: IdentityLedgerDeleteRecord): Promise<void>;
}

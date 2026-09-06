import { normalizePath, TFile, TFolder } from "obsidian";
import type { App, Component, TAbstractFile } from "obsidian";

import type { IdentityHandle, MemoObservation } from "../types/catalog";
import { ensureFolder as ensureVaultFolder } from "../utils/vault";
import type {
	IdentityLedgerBinding,
	IdentityLedgerClaimEvent,
	IdentityLedgerCreateInput,
	IdentityLedgerCreatePlan,
	IdentityLedgerCreateIntentEvent,
	IdentityLedgerDeleteCommitEvent,
	IdentityLedgerDeletePayloadEvent,
	IdentityLedgerDeleteRecord,
	IdentityLedgerEvent,
	IdentityLedgerEventEnvelope,
	IdentityLedgerMaterializedMemo,
	IdentityLedgerMutationService,
	IdentityLedgerObservationEvidence,
	IdentityLedgerObservationState,
	IdentityLedgerPurgeEvent,
	IdentityLedgerRebindEvent,
	IdentityLedgerRebindReason,
	IdentityLedgerReconcileResult,
	IdentityLedgerReadHealth,
	IdentityLedgerSnapshot,
	IdentityLedgerStatus,
	IdentityLedgerAttentionRoute,
} from "../types/identityLedger";
import {
	canonicalIdentityLedgerJson,
	assertIdentityLedgerEvent,
	createIdentityLedgerEventId,
	createIdentityLedgerMemoId,
	getIdentityLedgerSegmentPath,
	getIdentityLedgerWriterSegmentsPath,
	parseIdentityLedgerSegment,
	serializeIdentityLedgerSegment,
	sha256IdentityLedgerText,
} from "./IdentityLedgerProtocol";
import { CooperativeYieldController } from "./CooperativeTask";
import type { CooperativeTaskRuntime } from "./CooperativeTask";
import { identityOrderBetween, memoObservationSignature, observationIdentityEvidence as toObservationEvidence } from "./MemoObservationIdentity";
import type { SharedReplicaCache } from "./SharedReplicaCache";
import { isRecord } from "../utils/object";

const LEGACY_IMPORT_SEGMENT_EVENT_LIMIT = 256;

interface ObservationBindingReference {
	memoId: string;
	bindingId: string;
}

interface ObservationBindingIndex {
	byEvidence: Map<string, ObservationBindingReference[]>;
	evidenceKeysByMemoId: Map<string, Set<string>>;
}

export interface IdentityLedgerServiceOptions {
	getRootPath: () => string | null;
	getWriterId: () => Promise<string>;
	createMemoId?: () => string;
	createEventId?: () => string;
	now?: () => Date;
	cancellationSignal?: AbortSignal;
	yieldControl?: () => Promise<void>;
	sliceBudgetMs?: number;
	monotonicNow?: () => number;
	replicaCache?: SharedReplicaCache;
}

export interface HistoricalIdentityAdoptionResult {
	importedEventCount: number;
	identityRevision: string;
	memoIds: string[];
}

export class IdentityLedgerService implements IdentityLedgerMutationService {
	private readonly now: () => Date;
	private readonly createMemoId: () => string;
	private readonly createEventId: () => string;
	private envelopes: IdentityLedgerEventEnvelope[] = [];
	private snapshot: IdentityLedgerSnapshot = createEmptySnapshot();
	private status: IdentityLedgerStatus = "unavailable";
	private readHealth: IdentityLedgerReadHealth = "unavailable";
	private scanErrorCount = 0;
	private replicaCacheError = false;
	private activeRootPath: string | null = null;
	private onChanged: (() => void | Promise<void>) | null = null;
	private notificationRequested = false;
	private notificationRunning = false;
	private refreshOperation: Promise<void> | null = null;
	private refreshRequested = false;
	private refreshNotificationRequested = false;
	private refreshGeneration = 0;
	private stopped = false;
	private writeQueue: Promise<void> = Promise.resolve();
	private writePauseCount = 0;
	private deterministicImportWriteCount = 0;
	private automaticMaintenanceWriteCount = 0;
	private readonly selfWrittenPaths = new Map<string, number>();
	private readonly purgeOperations = new Map<string, Promise<void>>();
	private observationBindingsByEvidence = new Map<string, ObservationBindingReference[]>();
	private observationEvidenceKeysByMemoId = new Map<string, Set<string>>();

	constructor(
		private readonly app: App,
		private readonly options: IdentityLedgerServiceOptions,
	) {
		this.now = options.now ?? (() => new Date());
		this.createMemoId = options.createMemoId ?? (() => createIdentityLedgerMemoId(this.now()));
		this.createEventId = options.createEventId ?? createIdentityLedgerEventId;
	}

	start(owner: Component, onChanged: () => void | Promise<void>): void {
		this.onChanged = onChanged;
		const handle = (file: unknown, oldPath?: unknown) => {
			const rootPath = this.getRootPath();
			if (!isIdentityLedgerFile(file, rootPath) && !isIdentityLedgerPath(oldPath, rootPath)) return;
			if (file instanceof TFile && this.consumeSelfWrittenPath(file.path)) return;
			this.scheduleRefresh();
		};
		owner.registerEvent(this.app.vault.on("create", handle));
		owner.registerEvent(this.app.vault.on("modify", handle));
		owner.registerEvent(this.app.vault.on("delete", handle));
		owner.registerEvent(this.app.vault.on("rename", handle));
		owner.register(() => {
			this.stopped = true;
			this.refreshGeneration += 1;
			this.refreshRequested = false;
			this.refreshNotificationRequested = false;
			this.onChanged = null;
			this.notificationRequested = false;
		});
		// 监听建立后补扫一次，覆盖初始化扫描与事件注册之间的变更窗口。
		this.scheduleRefresh(true, false);
	}

	async initialize(): Promise<void> {
		try {
			await this.requestRefresh(false);
		} catch (error) {
			if (error instanceof IdentityLedgerRefreshCancelledError) return;
			this.readHealth = "unavailable";
			this.status = "unavailable";
		}
	}

	async reloadConfiguredRoot(notify = true): Promise<void> {
		await this.initialize();
		if (notify) await this.notifyChanged();
	}

	async runWithWritesPaused<T>(operation: () => Promise<T>): Promise<T> {
		this.writePauseCount += 1;
		await this.writeQueue;
		try {
			return await operation();
		} finally {
			this.writePauseCount -= 1;
		}
	}

	getRevision(): string {
		return this.snapshot.revision;
	}

	getStatus(): IdentityLedgerStatus {
		return this.status;
	}

	getReadHealth(): IdentityLedgerReadHealth {
		return this.readHealth;
	}

	isReplicaCacheDurable(): boolean {
		return this.options.replicaCache?.isDurable() ?? false;
	}

	getAttentionRoute(): IdentityLedgerAttentionRoute {
		if (this.status === "unavailable" || this.scanErrorCount > 0 || this.replicaCacheError) return "settings_retry";
		return this.snapshot.quarantinedEventIds.length > 0 ? "quarantine" : null;
	}

	getSnapshot(): IdentityLedgerSnapshot {
		return cloneSnapshot(this.snapshot);
	}

	resolveObservation(observation: MemoObservation): IdentityLedgerBinding | null {
		const state = this.resolveObservationState(observation);
		return state.kind === "identified" ? state.binding : null;
	}

	resolveObservationState(observation: MemoObservation): IdentityLedgerObservationState {
		const candidates = this.findObservationBindings(observation);
		if (candidates.length === 0) {
			const unresolved = this.findSignatureBindings(observation);
			return unresolved.length === 0 ? { kind: "unbound" } : {
				kind: "conflicted", memoIds: [...new Set(unresolved.map((binding) => binding.memoId))].sort(), bindings: unresolved,
			};
		}
		const memoIds = [...new Set(candidates.map((binding) => binding.memoId))].sort();
		const locallyConflicted = memoIds.some((memoId) => this.snapshot.memos[memoId]?.conflicted === true);
		if (candidates.length === 1 && memoIds.length === 1 && !locallyConflicted) {
			return { kind: "identified", binding: candidates[0] as IdentityLedgerBinding };
		}
		return {
			kind: "conflicted",
			memoIds,
			bindings: candidates.map(cloneBinding).sort((left, right) => left.bindingId.localeCompare(right.bindingId)),
		};
	}

	getSourceMemoId(memoId: string): string | null {
		const sourceMemoIds = this.snapshot.memos[memoId]?.sourceMemoIds ?? [];
		return sourceMemoIds.length === 1 ? sourceMemoIds[0] ?? null : null;
	}

	getCreatedAt(memoId: string): string | null {
		return this.snapshot.memos[memoId]?.createdAt ?? null;
	}

	getReviewState(memoId: string): { reviewCount: number; lastReviewedAt: string | null } {
		const memo = this.snapshot.memos[memoId];
		return {
			reviewCount: memo?.reviewCount ?? 0,
			lastReviewedAt: memo?.lastReviewedAt ?? null,
		};
	}

	getActiveDeletes(): IdentityLedgerDeleteRecord[] {
		return Object.values(this.snapshot.memos)
			.flatMap((memo) => (memo.activeDeletes ?? []).map(cloneDeleteRecord))
			.sort((left, right) => left.deleteEventId.localeCompare(right.deleteEventId));
	}

	getPendingDeletes(): IdentityLedgerDeleteRecord[] {
		return Object.values(this.snapshot.memos)
			.flatMap((memo) => (memo.pendingDeletes ?? []).map(cloneDeleteRecord))
			.sort((left, right) => left.deleteEventId.localeCompare(right.deleteEventId));
	}

	hasPendingCreates(): boolean {
		return this.snapshot.pendingIntents.length > 0;
	}

	hasPendingDeletes(): boolean {
		return Object.values(this.snapshot.memos).some((memo) => (memo.pendingDeletes?.length ?? 0) > 0);
	}

	async importVerifiedLegacyEvents(
		events: readonly IdentityLedgerEvent[],
		runtime: {
			cancellationSignal?: AbortSignal;
			yieldControl?: () => Promise<void>;
			sliceBudgetMs?: number;
			now?: () => number;
			isCurrent?: () => Promise<boolean>;
		} = {},
	): Promise<number> {
		if (events.length === 0) return 0;
		this.assertSharedWriteAllowed();
		this.assertWriteAllowed(runtime.cancellationSignal);
		if (this.writePauseCount > 0) throw new Error("Identity Ledger writes are paused for data root migration.");
		const existingByEventId = new Map<string, IdentityLedgerEventEnvelope[]>();
		const yieldController = runtime.yieldControl === undefined ? null : new CooperativeYieldController({
			yieldControl: runtime.yieldControl,
			sliceBudgetMs: runtime.sliceBudgetMs,
			maxOperationsPerSlice: LEGACY_IMPORT_SEGMENT_EVENT_LIMIT,
			now: runtime.now,
		});
		for (const envelope of this.envelopes) {
			const values = existingByEventId.get(envelope.event.eventId) ?? [];
			values.push(envelope);
			existingByEventId.set(envelope.event.eventId, values);
			if (yieldController?.shouldYield()) {
				await yieldController.yieldNow();
				this.assertWriteAllowed(runtime.cancellationSignal);
			}
		}
		const pendingByEventId = new Map<string, { event: IdentityLedgerEvent; digest: string }>();
		for (let index = 0; index < events.length; index += 1) {
			if (index > 0 && yieldController?.shouldYield()) {
				await yieldController.yieldNow();
				this.assertWriteAllowed(runtime.cancellationSignal);
			}
			const event = events[index];
			if (event === undefined) continue;
			const content = serializeIdentityLedgerSegment([event]);
			const digest = await sha256IdentityLedgerText(content.trimEnd());
			const existing = existingByEventId.get(event.eventId) ?? [];
			if (existing.length > 0) {
				if (existing.some((item) => item.digest !== digest)) {
					throw new Error(`Identity Ledger legacy event collision: ${event.eventId}`);
				}
				continue;
			}
			const pending = pendingByEventId.get(event.eventId);
			if (pending !== undefined) {
				if (pending.digest !== digest) {
					throw new Error(`Identity Ledger legacy event collision: ${event.eventId}`);
				}
				continue;
			}
			pendingByEventId.set(event.eventId, { event, digest });
		}
		const pendingEvents = [...pendingByEventId.values()].map((item) => item.event);
		if (pendingEvents.length === 0) return 0;

		this.deterministicImportWriteCount += 1;
		const previous = this.writeQueue;
		let releaseQueue: () => void = () => undefined;
		this.writeQueue = new Promise<void>((resolve) => { releaseQueue = resolve; });
		try {
			await previous;
			this.assertWriteAllowed(runtime.cancellationSignal);
			const rootPath = this.requireRootPath();
			const incoming: IdentityLedgerEventEnvelope[] = [];
			const byWriter = new Map<string, IdentityLedgerEvent[]>();
			for (const event of pendingEvents) {
				const writerEvents = byWriter.get(event.writerId) ?? [];
				writerEvents.push(event);
				byWriter.set(event.writerId, writerEvents);
			}
			for (const [writerId, writerEvents] of byWriter) {
				this.assertWriteAllowed(runtime.cancellationSignal);
				await this.ensureFolder(rootPath, getIdentityLedgerWriterSegmentsPath(rootPath, writerId), runtime.cancellationSignal);
				for (let index = 0; index < writerEvents.length; index += LEGACY_IMPORT_SEGMENT_EVENT_LIMIT) {
					const batch = writerEvents.slice(index, index + LEGACY_IMPORT_SEGMENT_EVENT_LIMIT);
					const first = batch[0];
					if (first === undefined) continue;
					const content = serializeIdentityLedgerSegment(batch);
					const digest = await sha256IdentityLedgerText(content);
					const path = getIdentityLedgerSegmentPath(rootPath, writerId, first.eventId, digest);
					this.assertWriteAllowed(runtime.cancellationSignal);
					if (runtime.isCurrent !== undefined && !await runtime.isCurrent()) throw new IdentityLedgerWriteCancelledError();
					await this.writeImmutable(path, content, runtime.cancellationSignal);
					incoming.push(...(await parseIdentityLedgerSegment(rootPath, path, content)).events);
					await runtime.yieldControl?.();
					this.assertWriteAllowed(runtime.cancellationSignal);
				}
			}
			this.envelopes = mergeEnvelopes(this.envelopes, incoming);
			await this.materialize();
			this.activeRootPath = rootPath;
			await this.saveKnownEnvelopesAfterWrite(rootPath);
		} catch (error) {
			if (!(error instanceof IdentityLedgerWriteCancelledError)) {
				this.status = error instanceof MissingIdentityLedgerRootError ? "missing" : "unavailable";
			}
			throw error;
		} finally {
			releaseQueue();
			this.deterministicImportWriteCount -= 1;
		}
		this.scheduleNotification();
		return pendingEvents.length;
	}

	async verifyPersistedSnapshot(expectedRevision: string): Promise<boolean> {
		await this.writeQueue;
		try {
			await this.requestRefresh(false, true);
		} catch (error) {
			if (!(error instanceof IdentityLedgerRefreshCancelledError)) this.status = "unavailable";
			return false;
		}
		return this.status === "ready" && this.snapshot.revision === expectedRevision;
	}

	async beginCreate(input: IdentityLedgerCreateInput): Promise<IdentityLedgerCreatePlan> {
		if (this.deterministicImportWriteCount > 0) {
			throw new Error("Identity Ledger is importing deterministic events.");
		}
		const memoId = this.createMemoId();
		const intent: IdentityLedgerCreateIntentEvent = {
			eventId: this.createEventId(),
			writerId: await this.getWriterId(),
			memoId,
			type: "create_intent",
			baseBindingId: null,
			occurredAt: this.now().toISOString(),
			evidence: {
				targetPath: input.targetPath === null ? null : normalizePath(input.targetPath),
				logicalDate: input.logicalDate,
				time: input.time,
				contentHash: input.contentHash,
				sourceMemoId: input.sourceMemoId,
			},
		};
		if (this.automaticMaintenanceWriteCount > 0) {
			return { memoId, intent, intentDurable: false };
		}
		try {
			await this.appendEvent(intent, false);
			return { memoId, intent, intentDurable: true };
		} catch {
			return { memoId, intent, intentDurable: false };
		}
	}

	async finishCreate(plan: IdentityLedgerCreatePlan, observation: MemoObservation, isCurrent?: () => Promise<boolean>): Promise<IdentityLedgerBinding> {
		const existing = this.resolveObservation(observation);
		if (existing?.memoId === plan.memoId) return existing;
		if (this.envelopes.some(({ event }) => event.type === "claim"
			&& event.evidence.createIntentEventId === plan.intent.eventId)) {
			throw new Error("Identity create intent is already claimed.");
		}
		let intentDurable = plan.intentDurable;
		if (!intentDurable) {
			await this.appendEvent(plan.intent, false);
			intentDurable = true;
		}
		const writerId = await this.getWriterId();
		const claim: IdentityLedgerClaimEvent = {
			eventId: this.createEventId(),
			writerId,
			memoId: plan.memoId,
			type: "claim",
			baseBindingId: null,
			occurredAt: this.now().toISOString(),
			evidence: {
				observation: this.evidenceForInsertion(observation),
				createIntentEventId: intentDurable ? plan.intent.eventId : null,
			},
		};
		const events: IdentityLedgerEvent[] = [claim];
		if (plan.intent.evidence.sourceMemoId !== null) {
			events.push({
				eventId: this.createEventId(),
				writerId,
				memoId: plan.memoId,
				type: "relation",
				baseBindingId: claim.eventId,
				occurredAt: this.now().toISOString(),
				evidence: { sourceMemoId: plan.intent.evidence.sourceMemoId },
			});
		}
		await this.appendEvents(events, true, async () => {
			if (isCurrent !== undefined && !await isCurrent()) throw new IdentityLedgerWriteCancelledError();
			if (observationEvidenceKey(this.evidenceForInsertion(observation)) !== observationEvidenceKey(claim.evidence.observation)) {
				throw new IdentityLedgerWriteCancelledError();
			}
		});
		const binding = this.resolveObservation(observation);
		if (binding === null || binding.memoId !== plan.memoId) {
			throw new Error("Identity Ledger claim did not resolve the committed observation.");
		}
		return this.resolveObservation(observation) ?? binding;
	}

	async reconcilePendingCreates(observations: readonly MemoObservation[]): Promise<number> {
		let completed = 0;
		for (const intent of [...this.snapshot.pendingIntents]) {
			const candidates = observations.filter((observation) =>
				this.resolveObservation(observation) === null
					&& matchesCreateIntentObservation(intent, observation));
			if (candidates.length !== 1) continue;
			try {
				await this.finishCreate({ memoId: intent.memoId, intent, intentDurable: true }, candidates[0] as MemoObservation);
				completed += 1;
			} catch {
				continue;
			}
		}
		return completed;
	}

	async reconcilePendingDeletes(sourceRevisions: Readonly<Record<string, string>>): Promise<number> {
		let completed = 0;
		for (const record of this.getPendingDeletes()) {
			const expectedRevision = record.evidence.deletedSourceRevision;
			if (expectedRevision === null
				|| sourceRevisions[normalizePath(record.evidence.sourcePath)] !== expectedRevision) {
				continue;
			}
			try {
				await this.recordDeleteCommit(record);
				completed += 1;
			} catch {
				continue;
			}
		}
		return completed;
	}

	async reconcileRevision(
		before: readonly MemoObservation[],
		after: readonly MemoObservation[],
		insertedObservation: MemoObservation | null = null,
		allowIdentityAdoption = false,
		isCurrent?: () => Promise<boolean>,
	): Promise<IdentityLedgerReconcileResult> {
		this.automaticMaintenanceWriteCount += 1;
		try {
			return await this.reconcileRevisionInternal(before, after, insertedObservation, allowIdentityAdoption, isCurrent);
		} finally {
			this.automaticMaintenanceWriteCount -= 1;
		}
	}

	private async reconcileRevisionInternal(
		before: readonly MemoObservation[],
		after: readonly MemoObservation[],
		insertedObservation: MemoObservation | null,
		allowIdentityAdoption: boolean,
		isCurrent?: () => Promise<boolean>,
	): Promise<IdentityLedgerReconcileResult> {
		if (isCurrent !== undefined && !await isCurrent()) throw new IdentityLedgerWriteCancelledError();
		const reconciliation = buildRevisionReconciliationPlan(before, after, insertedObservation);
		const plans = reconciliation.successors.flatMap((plan) => {
			const baseBindings = this.findObservationBindings(plan.before);
			if (baseBindings.length !== 1) return [];
			return plan.successors.filter((successor) => memoObservationSignature(plan.before) !== memoObservationSignature(successor)).map((successor) => ({
				base: baseBindings[0] as IdentityLedgerBinding,
				successor,
			}));
		});
		const adoptionCandidates = allowIdentityAdoption
			? reconciliation.safeAdditions.filter((observation) =>
				this.resolveObservationState(observation).kind === "unbound")
			: [];
		const claimObservations = this.status === "ready" || this.status === "absent"
			? adoptionCandidates.filter((observation) => !this.snapshot.pendingIntents.some((intent) =>
				matchesCreateIntentObservation(intent, observation)))
			: [];
		const writerId = plans.length === 0 && claimObservations.length === 0
			? null
			: await this.getWriterId();
		const events: IdentityLedgerRebindEvent[] = [];
		for (const plan of plans) {
			if (this.hasActiveSuccessor(plan.base.memoId, plan.base.bindingId, plan.successor)) continue;
			if (writerId !== null) events.push(this.createRebindEvent(plan.base, plan.successor, "edit", writerId));
		}
		await this.appendEvents(events, true, async () => {
			if (isCurrent !== undefined && !await isCurrent()) throw new IdentityLedgerWriteCancelledError();
			for (const plan of plans) this.requireCurrentBinding(plan.base);
		});
		const claims: IdentityLedgerClaimEvent[] = [];
		if (writerId !== null) {
			for (const observation of claimObservations) {
				if (this.resolveObservationState(observation).kind !== "unbound") continue;
				const claim = await this.buildNewObservationClaim(observation, writerId);
				claims.push(claim);
			}
		}
		const importedClaimCount = await this.importVerifiedLegacyEvents(claims, { isCurrent });
		let completedCreateCount = 0;
		if (insertedObservation !== null) {
			const intents = this.snapshot.pendingIntents.filter((intent) => matchesCreateIntentObservation(intent, insertedObservation));
			if (intents.length === 1) {
				const intent = intents[0]!;
				await this.finishCreate({ memoId: intent.memoId, intent, intentDurable: true }, insertedObservation, isCurrent);
				completedCreateCount = 1 + (intent.evidence.sourceMemoId === null ? 0 : 1);
			}
		}
		const unresolved = after.map((observation) => ({ observation, state: this.resolveObservationState(observation) }));
		return {
			appendedEventCount: events.length + importedClaimCount + completedCreateCount,
			conflictedMemoIds: [...new Set(unresolved.flatMap(({ state }) => state.kind === "conflicted" ? state.memoIds : []))].sort(),
			deferredObservationCount: new Set([
				...adoptionCandidates.filter((observation) => this.resolveObservationState(observation).kind === "unbound"),
				...unresolved.filter(({ observation, state }) => state.kind !== "identified"
					&& this.snapshot.pendingIntents.some((intent) => matchesCreateIntentObservation(intent, observation)))
					.map(({ observation }) => observation),
			]).size,
		};
	}

	async rebindObservation(
		before: MemoObservation,
		after: MemoObservation,
		reason: IdentityLedgerRebindReason,
		expectedIdentity?: IdentityHandle | null,
	): Promise<IdentityLedgerBinding | null> {
		const bases = this.findObservationBindings(before);
		if (expectedIdentity !== undefined && (expectedIdentity === null || bases[0]?.memoId !== expectedIdentity.memoId
			|| bases[0]?.bindingId !== expectedIdentity.activeBindingId)) {
			const current = this.resolveObservation(after);
			return current?.memoId === expectedIdentity?.memoId ? current : null;
		}
		if (bases.length !== 1) {
			const current = this.resolveObservationState(after);
			return current.kind === "identified" ? current.binding : null;
		}
		const base = bases[0] as IdentityLedgerBinding;
		if (memoObservationSignature(before) === memoObservationSignature(after)
			&& (reason !== "move" || before.occurrenceIndex === after.occurrenceIndex)) return base;
		if (this.hasActiveSuccessor(base.memoId, base.bindingId, after)) {
			return this.findObservationBindings(after).find((binding) => binding.memoId === base.memoId) ?? null;
		}
		return this.appendRebind(base, after, reason);
	}

	async adoptObservation(observation: MemoObservation): Promise<IdentityLedgerBinding> {
		const current = this.resolveObservationState(observation);
		if (current.kind === "identified") return current.binding;
		if (current.kind === "conflicted") {
			throw new Error("Identity Ledger observation is conflicted and cannot be adopted.");
		}
		const claim = await this.buildNewObservationClaim(observation, await this.getWriterId());
		const memoId = claim.memoId;
		await this.appendEvent(claim);
		const resolved = this.resolveObservationState(observation);
		if (resolved.kind !== "identified" || resolved.binding.memoId !== memoId) {
			throw new Error("Identity Ledger adoption did not produce a unique binding.");
		}
		return resolved.binding;
	}

	private async buildNewObservationClaim(observation: MemoObservation, writerId: string): Promise<IdentityLedgerClaimEvent> {
		let claim = await buildLocalObservationClaim(observation, writerId);
		// 当前正文即使逐字恢复，也不能复用已删除或已移走的历史身份。
		while (this.snapshot.memos[claim.memoId] !== undefined) {
			claim = await buildLocalObservationClaim(observation, writerId, claim.memoId);
		}
		return claim;
	}

	async adoptHistoricalObservations(
		observations: readonly MemoObservation[],
		runtime: {
			cancellationSignal?: AbortSignal;
			yieldControl?: () => Promise<void>;
			sliceBudgetMs?: number;
			now?: () => number;
		} = {},
	): Promise<HistoricalIdentityAdoptionResult> {
		if (this.status !== "ready" && this.status !== "absent") {
			throw new Error("Historical Identity adoption requires an available Identity Ledger.");
		}
		const ordered = [...observations].sort(compareHistoricalObservations);
		const claims: IdentityLedgerClaimEvent[] = [];
		const expectedMemoIds = new Map<string, string>();
		const resumableGroups = new Set<string>();
		let writerId: string | null = null;
		for (const observation of ordered) {
			this.assertWriteAllowed(runtime.cancellationSignal);
			const state = this.resolveObservationState(observation);
			if (state.kind === "identified") {
				expectedMemoIds.set(observationEvidenceKey(toObservationEvidence(observation)), state.binding.memoId);
				continue;
			}
			const signature = memoObservationSignature(observation);
			if (state.kind === "conflicted" && !resumableGroups.has(signature)) {
				const candidates = this.findSignatureBindings(observation);
				// 初始化分批中断时，只补齐当前完整组中可验证的确定性 claim。
				const expected = new Map(ordered.filter((item) => memoObservationSignature(item) === signature)
					.map((item) => [observationEvidenceKey(toObservationEvidence(item)), item]));
				if (candidates.length >= observation.occurrenceCount || candidates.some((binding) =>
					this.snapshot.memos[binding.memoId]?.conflicted || !expected.has(observationEvidenceKey(binding.evidence)))
					|| (await Promise.all(candidates.map(async (binding) =>
						await deterministicHistoricalMemoId(binding.evidence, expected.get(observationEvidenceKey(binding.evidence))!) === binding.memoId))).some((matches) => !matches)) {
					throw new Error("Historical Identity adoption does not resolve conflicted observations.");
				}
				resumableGroups.add(signature);
			}
			writerId ??= await this.getWriterId();
			const claim = await buildLocalObservationClaim(observation, writerId);
			const evidence = claim.evidence.observation;
			const evidenceKey = observationEvidenceKey(evidence);
			expectedMemoIds.set(evidenceKey, claim.memoId);
			claims.push(claim);
		}
		const importedEventCount = await this.importVerifiedLegacyEvents(claims, runtime);
		for (const observation of ordered) {
			const evidenceKey = observationEvidenceKey(toObservationEvidence(observation));
			const expectedMemoId = expectedMemoIds.get(evidenceKey);
			const resolved = this.resolveObservationState(observation);
			if (expectedMemoId === undefined || resolved.kind !== "identified" || resolved.binding.memoId !== expectedMemoId) {
				throw new Error("Historical Identity adoption did not produce one stable identity per observation.");
			}
		}
		const identityRevision = this.snapshot.revision;
		if (claims.length > 0 && !await this.verifyPersistedSnapshot(identityRevision)) {
			throw new Error("Historical Identity adoption could not verify persisted events.");
		}
		return {
			importedEventCount,
			identityRevision: this.snapshot.revision,
			memoIds: [...new Set(expectedMemoIds.values())].sort(),
		};
	}

	async repairConflict(memoId: string, observation: MemoObservation): Promise<IdentityLedgerBinding> {
		const memo = this.snapshot.memos[memoId];
		if (memo?.conflicted !== true || memo.conflictBaseBindingId === null) {
			throw new Error("Identity Ledger memo has no repairable binding fork.");
		}
		const target = this.findObservationBindings(observation).find((binding) => binding.memoId === memoId);
		if (target === undefined) {
			throw new Error("Identity Ledger repair target is not an active successor.");
		}
		const evidenceKey = observationEvidenceKey(target.evidence);
		const conflictBaseBindingId = memo.conflictBaseBindingId;
		const eventId = this.createEventId();
		await this.appendEvent({
			eventId,
			writerId: await this.getWriterId(),
			memoId,
			type: "repair",
			baseBindingId: conflictBaseBindingId,
			occurredAt: this.now().toISOString(),
			evidence: { observation: target.evidence },
		}, true, () => {
			const current = this.snapshot.memos[memoId];
			if (current?.conflicted !== true || current.conflictBaseBindingId !== conflictBaseBindingId
				|| !current.bindings.some((binding) => observationEvidenceKey(binding.evidence) === evidenceKey)) {
				throw new Error("Identity Ledger repair target is no longer current.");
			}
		});
		const resolved = this.resolveObservationState(observation);
		if (resolved.kind !== "identified" || resolved.binding.memoId !== memoId) {
			throw new Error("Identity Ledger repair did not produce a unique active binding.");
		}
		return resolved.binding;
	}

	async recordReview(binding: IdentityLedgerBinding, reviewedAt: string): Promise<void> {
		await this.appendEvent({
			eventId: this.createEventId(),
			writerId: await this.getWriterId(),
			memoId: binding.memoId,
			type: "review",
			baseBindingId: binding.bindingId,
			occurredAt: this.now().toISOString(),
			evidence: { reviewedAt },
		});
	}

	async recordDeletePayload(
		binding: IdentityLedgerBinding,
		payload: IdentityLedgerDeletePayloadEvent["evidence"],
	): Promise<IdentityLedgerDeleteRecord> {
		const event: IdentityLedgerDeletePayloadEvent = {
			eventId: this.createEventId(),
			writerId: await this.getWriterId(),
			memoId: binding.memoId,
			type: "delete_payload",
			baseBindingId: binding.bindingId,
			occurredAt: payload.deletedAt,
			evidence: { ...payload },
		};
		await this.appendEvent(event);
		const record = this.getPendingDeletes().find((item) => item.deleteEventId === event.eventId);
		if (record === undefined) throw new Error("Identity Ledger delete payload did not materialize.");
		return record;
	}

	async recordDeleteCommit(deleteRecord: IdentityLedgerDeleteRecord): Promise<IdentityLedgerDeleteRecord> {
		const active = this.getActiveDeletes().find((item) => item.deleteEventId === deleteRecord.deleteEventId);
		if (active !== undefined) return active;
		const pending = this.getPendingDeletes().find((item) => item.deleteEventId === deleteRecord.deleteEventId);
		if (pending === undefined || pending.memoId !== deleteRecord.memoId
			|| pending.baseBindingId !== deleteRecord.baseBindingId) {
			throw new Error("Identity Ledger delete payload is no longer pending.");
		}
		const event: IdentityLedgerDeleteCommitEvent = {
			eventId: this.createEventId(),
			writerId: await this.getWriterId(),
			memoId: pending.memoId,
			type: "delete_commit",
			baseBindingId: pending.baseBindingId,
			occurredAt: this.now().toISOString(),
			evidence: { deleteEventId: pending.deleteEventId },
		};
		await this.appendEvent(event);
		const committed = this.getActiveDeletes().find((item) => item.deleteEventId === pending.deleteEventId);
		if (committed === undefined) throw new Error("Identity Ledger delete commit did not materialize.");
		return committed;
	}

	async recordRestore(
		deleteRecord: IdentityLedgerDeleteRecord,
		observation: MemoObservation,
	): Promise<IdentityLedgerBinding> {
		this.requireActiveDelete(deleteRecord);
		const eventId = this.createEventId();
		await this.appendEvent({
			eventId,
			writerId: await this.getWriterId(),
			memoId: deleteRecord.memoId,
			type: "restore",
			baseBindingId: deleteRecord.baseBindingId,
			occurredAt: this.now().toISOString(),
				evidence: {
				observation: this.evidenceForInsertion(observation),
				deleteEventId: deleteRecord.deleteEventId,
			},
		}, true, () => { this.requireActiveDelete(deleteRecord); });
		const binding = this.findObservationBindings(observation)
			.find((item) => item.memoId === deleteRecord.memoId && item.bindingId === eventId)
			?? this.findObservationBindings(observation).find((item) => item.memoId === deleteRecord.memoId);
		if (binding === undefined) throw new Error("Identity Ledger restore did not materialize its binding.");
		return binding;
	}

	recordPurge(deleteRecord: IdentityLedgerDeleteRecord): Promise<void> {
		const existing = this.purgeOperations.get(deleteRecord.deleteEventId);
		if (existing !== undefined) return existing;
		const operation = this.commitPurge(deleteRecord);
		this.purgeOperations.set(deleteRecord.deleteEventId, operation);
		void operation.finally(() => {
			if (this.purgeOperations.get(deleteRecord.deleteEventId) === operation) {
				this.purgeOperations.delete(deleteRecord.deleteEventId);
			}
		}).catch(() => undefined);
		return operation;
	}

	private async commitPurge(deleteRecord: IdentityLedgerDeleteRecord): Promise<void> {
		const memo = this.snapshot.memos[deleteRecord.memoId];
		if (memo?.purgedDeleteEventIds?.includes(deleteRecord.deleteEventId) === true) return;
		if (memo?.conflicted === true) {
			throw new Error("Permanent delete is unavailable while memo identity is conflicted.");
		}
		const active = this.requireActiveDelete(deleteRecord);
		const event: IdentityLedgerPurgeEvent = {
			eventId: this.createEventId(),
			writerId: await this.getWriterId(),
			memoId: active.memoId,
			type: "purge",
			baseBindingId: active.baseBindingId,
			occurredAt: this.now().toISOString(),
			evidence: { deleteEventId: active.deleteEventId },
		};
		await this.appendEvent(event, true, () => {
			if (this.snapshot.memos[deleteRecord.memoId]?.conflicted === true) {
				throw new Error("Permanent delete is unavailable while memo identity is conflicted.");
			}
			this.requireActiveDelete(deleteRecord);
		});
		if (this.snapshot.memos[active.memoId]?.purgedDeleteEventIds?.includes(active.deleteEventId) !== true) {
			throw new Error("Identity Ledger permanent delete did not materialize.");
		}
	}

	private requireActiveDelete(deleteRecord: IdentityLedgerDeleteRecord): IdentityLedgerDeleteRecord {
		if (this.snapshot.memos[deleteRecord.memoId]?.purgedDeleteEventIds?.includes(deleteRecord.deleteEventId) === true) {
			throw new Error("Deleted memo was permanently deleted and cannot be restored.");
		}
		const active = this.getActiveDeletes().find((item) => item.deleteEventId === deleteRecord.deleteEventId);
		if (active === undefined || active.memoId !== deleteRecord.memoId
			|| active.baseBindingId !== deleteRecord.baseBindingId
			|| active.deleteCommitEventId === null) {
			throw new Error("Deleted memo payload is no longer active.");
		}
		return active;
	}

	private findObservationBindings(observation: MemoObservation): IdentityLedgerBinding[] {
		const candidates = this.findSignatureBindings(observation);
		if (candidates.length !== observation.occurrenceCount
			|| new Set(candidates.map((binding) => binding.evidence.order)).size !== candidates.length) return [];
		const binding = candidates[observation.occurrenceIndex];
		return binding === undefined ? [] : [binding];
	}

	private findSignatureBindings(observation: MemoObservation): IdentityLedgerBinding[] {
		const expected = memoObservationSignature(observation);
		return (this.observationBindingsByEvidence.get(expected) ?? []).flatMap((reference) => {
			const binding = this.snapshot.memos[reference.memoId]?.bindings
				.find((candidate) => candidate.bindingId === reference.bindingId
					&& memoObservationSignature(candidate.evidence) === expected);
			return binding === undefined ? [] : [cloneBinding(binding)];
		}).sort((left, right) => left.evidence.order < right.evidence.order ? -1 : left.evidence.order > right.evidence.order ? 1 : 0);
	}

	private evidenceForInsertion(observation: MemoObservation, excludeMemoId?: string): IdentityLedgerObservationEvidence {
		const candidates = this.findSignatureBindings(observation).filter((binding) => binding.memoId !== excludeMemoId);
		if (candidates.length === 0) return toObservationEvidence(observation);
		if (candidates.length !== observation.occurrenceCount - 1
			|| candidates.some((binding) => this.snapshot.memos[binding.memoId]?.conflicted)
			|| new Set(candidates.map((binding) => binding.evidence.order)).size !== candidates.length) {
			throw new Error("Identity insertion requires an unambiguous current occurrence group.");
		}
		return toObservationEvidence(observation, identityOrderBetween(
			candidates[observation.occurrenceIndex - 1]?.evidence.order ?? null,
			candidates[observation.occurrenceIndex]?.evidence.order ?? null,
		));
	}

	private commitSnapshot(snapshot: IdentityLedgerSnapshot, index: ObservationBindingIndex): void {
		this.snapshot = snapshot;
		this.observationBindingsByEvidence = index.byEvidence;
		this.observationEvidenceKeysByMemoId = index.evidenceKeysByMemoId;
	}

	private resetSnapshot(snapshot: IdentityLedgerSnapshot): void {
		this.snapshot = snapshot;
		this.observationBindingsByEvidence = new Map();
		this.observationEvidenceKeysByMemoId = new Map();
	}

	private updateObservationBindingIndex(
		snapshot: IdentityLedgerSnapshot,
		affectedMemoIds: ReadonlySet<string>,
	): void {
		for (const memoId of [...affectedMemoIds].sort()) {
			for (const evidenceKey of this.observationEvidenceKeysByMemoId.get(memoId) ?? []) {
				const remaining = (this.observationBindingsByEvidence.get(evidenceKey) ?? [])
					.filter((reference) => reference.memoId !== memoId);
				if (remaining.length === 0) {
					this.observationBindingsByEvidence.delete(evidenceKey);
				} else {
					this.observationBindingsByEvidence.set(evidenceKey, remaining);
				}
			}
			this.observationEvidenceKeysByMemoId.delete(memoId);
			const memo = snapshot.memos[memoId];
			if (memo !== undefined) addMemoBindingsToIndex(
				this.observationBindingsByEvidence,
				this.observationEvidenceKeysByMemoId,
				memoId,
				memo,
			);
		}
	}

	private hasActiveSuccessor(memoId: string, baseBindingId: string, observation: MemoObservation): boolean {
		const expected = new Set(this.findObservationBindings(observation)
			.filter((binding) => binding.memoId === memoId).map((binding) => observationEvidenceKey(binding.evidence)));
		return this.envelopes.some(({ event }) => event.memoId === memoId
			&& (event.type === "rebind" || event.type === "restore" || event.type === "repair")
			&& event.baseBindingId === baseBindingId
			&& expected.has(observationEvidenceKey(event.evidence.observation)));
	}

	private async appendRebind(
		base: IdentityLedgerBinding,
		observation: MemoObservation,
		reason: IdentityLedgerRebindReason,
	): Promise<IdentityLedgerBinding> {
		const event = this.createRebindEvent(base, observation, reason, await this.getWriterId());
		await this.appendEvent(event, true, () => this.requireCurrentBinding(base));
		const bindings = this.findObservationBindings(observation).filter((binding) => binding.memoId === base.memoId);
		const binding = bindings.find((candidate) => candidate.bindingId === event.eventId) ?? bindings[0];
		if (binding === undefined) throw new Error("Identity Ledger rebind did not materialize its successor.");
		return binding;
	}

	private createRebindEvent(
		base: IdentityLedgerBinding,
		observation: MemoObservation,
		reason: IdentityLedgerRebindReason,
		writerId: string,
	): IdentityLedgerRebindEvent {
		return {
			eventId: this.createEventId(),
			writerId,
			memoId: base.memoId,
			type: "rebind",
			baseBindingId: base.bindingId,
			occurredAt: this.now().toISOString(),
			evidence: {
				observation: this.evidenceForInsertion(observation, base.memoId),
				reason,
			},
		};
	}

	private requireCurrentBinding(binding: IdentityLedgerBinding): void {
		const memo = this.snapshot.memos[binding.memoId];
		if (memo?.conflicted || !memo?.bindings.some((candidate) => candidate.bindingId === binding.bindingId)) {
			throw new IdentityLedgerWriteCancelledError();
		}
	}

	private async appendEvent(event: IdentityLedgerEvent, notify = true, beforeWrite?: () => void | Promise<void>): Promise<void> {
		await this.appendEvents([event], notify, beforeWrite);
	}

	private async appendEvents(
		events: readonly IdentityLedgerEvent[],
		notify = true,
		beforeWrite?: () => void | Promise<void>,
	): Promise<void> {
		if (events.length === 0) return;
		this.assertSharedWriteAllowed();
		if (this.writePauseCount > 0) throw new Error("Identity Ledger writes are paused for data root migration.");
		const first = events[0];
		if (first === undefined || events.some((event) => event.writerId !== first.writerId)) {
			throw new Error("Identity Ledger segment events must share one writer.");
		}
		const previous = this.writeQueue;
		let releaseQueue: () => void = () => undefined;
		this.writeQueue = new Promise<void>((resolve) => {
			releaseQueue = resolve;
		});
		await previous;
		try {
			this.assertWriteAllowed();
			await beforeWrite?.();
			const rootPath = this.requireRootPath();
			const content = serializeIdentityLedgerSegment(events);
			const digest = await sha256IdentityLedgerText(content);
			const path = getIdentityLedgerSegmentPath(rootPath, first.writerId, first.eventId, digest);
			this.assertWriteAllowed();
			await this.ensureFolder(rootPath, getIdentityLedgerWriterSegmentsPath(rootPath, first.writerId));
			this.assertWriteAllowed();
			await beforeWrite?.();
			await this.writeImmutable(path, content);
			const parsed = await parseIdentityLedgerSegment(rootPath, path, content);
			const affectedMemoIds = collectAffectedMemoIds(this.envelopes, parsed.events);
			this.envelopes = mergeEnvelopes(this.envelopes, parsed.events);
			const nextSnapshot = await materializeIdentityLedgerIncrementally(
				this.snapshot,
				this.envelopes,
				affectedMemoIds,
				this.createCooperativeRuntime(() => this.assertWriteAllowed()),
			);
			this.updateObservationBindingIndex(nextSnapshot, affectedMemoIds);
			this.snapshot = nextSnapshot;
			this.updateStatus();
			this.activeRootPath = rootPath;
			await this.saveKnownEnvelopesAfterWrite(rootPath);
		} catch (error) {
			if (!(error instanceof IdentityLedgerWriteCancelledError)) {
				this.status = error instanceof MissingIdentityLedgerRootError ? "missing" : "unavailable";
			}
			throw error;
		} finally {
			releaseQueue();
		}
		if (notify) this.scheduleNotification();
	}

	private async refreshFromVault(generation = this.refreshGeneration): Promise<void> {
		this.assertRefreshCurrent(generation);
		const rootPath = this.getRootPath();
		if (rootPath === null) {
			this.assertRefreshCurrent(generation);
			this.setMissing(null);
			return;
		}
		const knownEnvelopes = await this.loadKnownEnvelopes(rootPath, generation);
		const root = this.app.vault.getAbstractFileByPath(rootPath);
		if (root === null) {
			this.assertRefreshCurrent(generation);
			await this.commitRefreshedEnvelopes(rootPath, knownEnvelopes, 0, "waiting", generation);
			return;
		}
		if (!(root instanceof TFolder)) throw new Error("Identity Ledger root is not a folder.");
		const files = listSegmentFiles(root).sort((left, right) => left.path.localeCompare(right.path));
		const envelopes: IdentityLedgerEventEnvelope[] = [];
		let errors = 0;
		for (const file of files) {
			try {
				const content = await this.app.vault.cachedRead(file);
				this.assertRefreshCurrent(generation);
				const parsed = await parseIdentityLedgerSegment(rootPath, file.path, content);
				envelopes.push(...parsed.events);
			} catch (error) {
				if (error instanceof IdentityLedgerRefreshCancelledError) throw error;
				errors += 1;
			}
		}
		const runtime = this.createCooperativeRuntime(() => this.assertRefreshCurrent(generation));
		const mergedEnvelopes = mergeEnvelopes(knownEnvelopes, envelopes);
		const currentPaths = new Set(envelopes.map((envelope) => envelope.sourcePath));
		const hasKnownGap = knownEnvelopes.some((envelope) => !currentPaths.has(envelope.sourcePath));
		const snapshot = await materializeIdentityLedger(mergedEnvelopes, runtime);
		const bindingIndex = await buildObservationBindingIndex(snapshot, runtime);
		this.assertRefreshCurrent(generation);
		this.activeRootPath = rootPath;
		this.envelopes = mergedEnvelopes;
		this.scanErrorCount = errors;
		this.commitSnapshot(snapshot, bindingIndex);
		this.readHealth = errors > 0 || snapshot.quarantinedEventIds.length > 0
			? "conflicted"
			: hasKnownGap ? "waiting" : "usable";
		this.updateStatus();
		await this.saveKnownEnvelopes(rootPath, mergedEnvelopes, generation);
	}

	private async materialize(): Promise<void> {
		const runtime = this.createCooperativeRuntime(() => this.assertWriteAllowed());
		const snapshot = await materializeIdentityLedger(this.envelopes, runtime);
		const bindingIndex = await buildObservationBindingIndex(snapshot, runtime);
		this.commitSnapshot(snapshot, bindingIndex);
		this.updateStatus();
	}

	private updateStatus(): void {
		this.status = this.readHealth === "conflicted" || this.snapshot.quarantinedEventIds.length > 0
			? "conflicted"
			: this.readHealth !== "usable"
				? this.snapshot.eventCount === 0 ? "missing" : "unavailable"
				: this.snapshot.eventCount === 0 ? "absent" : "ready";
	}

	private scheduleRefresh(notify = true, supersede = true): void {
		void this.requestRefresh(notify, supersede).catch(() => {
			if (!this.isRefreshStopped()) this.status = "unavailable";
		});
	}

	private requestRefresh(notify: boolean, supersede = false): Promise<void> {
		if (this.isRefreshStopped()) return Promise.reject(new IdentityLedgerRefreshCancelledError());
		this.refreshNotificationRequested ||= notify;
		if (this.refreshOperation !== null && !supersede) return this.refreshOperation;
		this.refreshRequested = true;
		this.refreshGeneration += 1;
		if (this.refreshOperation !== null) return this.refreshOperation;
		let operation: Promise<void>;
		operation = Promise.resolve().then(async () => {
			while (this.refreshRequested) {
				this.refreshRequested = false;
				const generation = this.refreshGeneration;
				try {
					await this.refreshFromVault(generation);
				} catch (error) {
					if (error instanceof IdentityLedgerRefreshCancelledError && !this.isRefreshStopped()) continue;
					throw error;
				}
				const notifyAfterRefresh = this.refreshNotificationRequested;
				this.refreshNotificationRequested = false;
				if (notifyAfterRefresh) this.scheduleNotification();
			}
		}).finally(() => {
			if (this.refreshOperation === operation) this.refreshOperation = null;
			if (this.refreshRequested && !this.isRefreshStopped()) {
				void this.requestRefresh(false).catch(() => {
					if (!this.isRefreshStopped()) this.status = "unavailable";
				});
			}
		});
		this.refreshOperation = operation;
		return operation;
	}

	private scheduleNotification(): void {
		if (this.isRefreshStopped()) return;
		this.notificationRequested = true;
		if (this.notificationRunning) return;
		this.notificationRunning = true;
		void this.flushNotifications();
	}

	private async flushNotifications(): Promise<void> {
		try {
			while (this.notificationRequested && !this.isRefreshStopped()) {
				this.notificationRequested = false;
				await this.notifyChanged();
			}
		} catch {
			// 观察者失败不能改变已持久化 Identity 事件的结果。
		} finally {
			this.notificationRunning = false;
			if (this.notificationRequested && !this.isRefreshStopped()) this.scheduleNotification();
		}
	}

	private async notifyChanged(): Promise<void> {
		if (this.isRefreshStopped()) return;
		await this.onChanged?.();
	}

	private createCooperativeRuntime(assertAllowed: () => void): CooperativeTaskRuntime {
		return {
			yieldControl: async () => {
				if (this.options.yieldControl !== undefined) {
					await this.options.yieldControl();
				} else {
					const appWindow = this.app.workspace?.containerEl?.win;
					if (appWindow !== undefined) await new Promise<void>((resolve) => appWindow.setTimeout(resolve, 0));
				}
				assertAllowed();
			},
			sliceBudgetMs: this.options.sliceBudgetMs,
			now: this.options.monotonicNow,
		};
	}

	private isRefreshStopped(): boolean {
		return this.stopped || this.options.cancellationSignal?.aborted === true;
	}

	private assertRefreshCurrent(generation: number): void {
		if (this.isRefreshStopped() || generation !== this.refreshGeneration) {
			throw new IdentityLedgerRefreshCancelledError();
		}
	}

	private async getWriterId(): Promise<string> {
		return this.options.getWriterId();
	}

	private getRootPath(): string | null {
		const rootPath = this.options.getRootPath();
		return rootPath === null ? null : normalizePath(rootPath);
	}

	private requireRootPath(): string {
		const rootPath = this.getRootPath();
		if (rootPath === null || this.app.vault.getAbstractFileByPath(rootPath) === null) {
			throw new MissingIdentityLedgerRootError();
		}
		if (!(this.app.vault.getAbstractFileByPath(rootPath) instanceof TFolder)) {
			throw new Error("Identity Ledger root is not a folder.");
		}
		return rootPath;
	}

	private setMissing(rootPath: string | null): void {
		if (rootPath !== null && this.activeRootPath !== rootPath) {
			this.envelopes = [];
			this.resetSnapshot(createEmptySnapshot());
			this.activeRootPath = rootPath;
		}
		this.scanErrorCount = 0;
		this.readHealth = "waiting";
		this.updateStatus();
	}

	private async loadKnownEnvelopes(
		rootPath: string,
		generation: number,
	): Promise<IdentityLedgerEventEnvelope[]> {
		let known = this.activeRootPath === rootPath ? this.envelopes : [];
		if (this.options.replicaCache === undefined) return [...known];
		try {
			const cached = await this.options.replicaCache.load("identity", rootPath);
			this.assertRefreshCurrent(generation);
			if (cached !== null) known = mergeEnvelopes(known, await validateCachedIdentityEnvelopes(rootPath, cached));
			this.replicaCacheError = false;
		} catch {
			this.assertRefreshCurrent(generation);
			this.replicaCacheError = true;
		}
		return [...known];
	}

	private async commitRefreshedEnvelopes(
		rootPath: string,
		envelopes: readonly IdentityLedgerEventEnvelope[],
		scanErrorCount: number,
		readHealth: IdentityLedgerReadHealth,
		generation: number,
	): Promise<void> {
		const runtime = this.createCooperativeRuntime(() => this.assertRefreshCurrent(generation));
		const snapshot = await materializeIdentityLedger(envelopes, runtime);
		const bindingIndex = await buildObservationBindingIndex(snapshot, runtime);
		this.assertRefreshCurrent(generation);
		this.activeRootPath = rootPath;
		this.envelopes = [...envelopes];
		this.scanErrorCount = scanErrorCount;
		this.commitSnapshot(snapshot, bindingIndex);
		this.readHealth = snapshot.quarantinedEventIds.length > 0 ? "conflicted" : readHealth;
		this.updateStatus();
	}

	private async saveKnownEnvelopes(
		rootPath: string,
		envelopes: readonly IdentityLedgerEventEnvelope[],
		generation: number,
	): Promise<void> {
		if (this.options.replicaCache === undefined) return;
		try {
			await this.options.replicaCache.save("identity", rootPath, envelopes);
			this.assertRefreshCurrent(generation);
			this.replicaCacheError = false;
		} catch {
			this.assertRefreshCurrent(generation);
			this.replicaCacheError = true;
		}
	}

	private async saveKnownEnvelopesAfterWrite(rootPath: string): Promise<void> {
		if (this.options.replicaCache === undefined) return;
		try {
			await this.options.replicaCache.save("identity", rootPath, this.envelopes);
			this.replicaCacheError = false;
		} catch {
			this.replicaCacheError = true;
		}
	}

	private async ensureFolder(rootPath: string, path: string, cancellationSignal?: AbortSignal): Promise<void> {
		const normalizedRoot = normalizePath(rootPath);
		const normalizedPath = normalizePath(path);
		if (!normalizedPath.startsWith(`${normalizedRoot}/`)) {
			throw new Error("Identity Ledger child path is outside the configured root.");
		}
		if (!(this.app.vault.getAbstractFileByPath(normalizedRoot) instanceof TFolder)) {
			throw new MissingIdentityLedgerRootError();
		}
		this.assertWriteAllowed(cancellationSignal);
		await ensureVaultFolder(this.app, normalizedPath);
		this.assertWriteAllowed(cancellationSignal);
	}

	private async writeImmutable(path: string, content: string, cancellationSignal?: AbortSignal): Promise<void> {
		this.assertWriteAllowed(cancellationSignal);
		const normalizedPath = normalizePath(path);
		const existing = this.app.vault.getAbstractFileByPath(normalizedPath);
		if (existing instanceof TFile) {
			if (await this.app.vault.cachedRead(existing) !== content) {
				throw new Error(`Identity Ledger immutable path collision: ${path}`);
			}
			return;
		}
		if (existing !== null) throw new Error(`Identity Ledger path is not a file: ${path}`);
		this.assertWriteAllowed(cancellationSignal);
		this.markSelfWrittenPath(normalizedPath);
		try {
			await this.app.vault.create(normalizedPath, content);
		} catch (error) {
			const raced = this.app.vault.getAbstractFileByPath(normalizedPath);
			if (!(raced instanceof TFile) || await this.app.vault.cachedRead(raced) !== content) throw error;
		}
	}

	private assertWriteAllowed(cancellationSignal?: AbortSignal): void {
		if (this.options.cancellationSignal?.aborted === true || cancellationSignal?.aborted === true) {
			throw new IdentityLedgerWriteCancelledError();
		}
	}

	private assertSharedWriteAllowed(): void {
		if (this.readHealth !== "usable") {
			throw new Error("Identity Ledger shared input is incomplete.");
		}
	}

	private markSelfWrittenPath(path: string): void {
		const now = Date.now();
		for (const [candidate, expiresAt] of this.selfWrittenPaths) {
			if (expiresAt <= now) this.selfWrittenPaths.delete(candidate);
		}
		this.selfWrittenPaths.set(normalizePath(path), now + 30_000);
	}

	private consumeSelfWrittenPath(path: string): boolean {
		const normalizedPath = normalizePath(path);
		const expiresAt = this.selfWrittenPaths.get(normalizedPath);
		if (expiresAt === undefined) return false;
		this.selfWrittenPaths.delete(normalizedPath);
		return expiresAt > Date.now();
	}
}

async function buildObservationBindingIndex(
	snapshot: IdentityLedgerSnapshot,
	runtime?: CooperativeTaskRuntime,
): Promise<ObservationBindingIndex> {
	const byEvidence = new Map<string, ObservationBindingReference[]>();
	const evidenceKeysByMemoId = new Map<string, Set<string>>();
	const yieldController = runtime === undefined ? null : new CooperativeYieldController(runtime);
	for (const [memoId, memo] of Object.entries(snapshot.memos).sort(([left], [right]) => left.localeCompare(right))) {
		addMemoBindingsToIndex(byEvidence, evidenceKeysByMemoId, memoId, memo);
		if (yieldController?.shouldYield(Math.max(1, memo.bindings.length))) await yieldController.yieldNow();
	}
	return { byEvidence, evidenceKeysByMemoId };
}

function addMemoBindingsToIndex(
	byEvidence: Map<string, ObservationBindingReference[]>,
	evidenceKeysByMemoId: Map<string, Set<string>>,
	memoId: string,
	memo: IdentityLedgerMaterializedMemo,
): void {
	const memoEvidenceKeys = new Set<string>();
	for (const binding of memo.bindings) {
		const evidenceKey = memoObservationSignature(binding.evidence);
		const references = byEvidence.get(evidenceKey) ?? [];
		references.push({ memoId, bindingId: binding.bindingId });
		byEvidence.set(evidenceKey, references);
		memoEvidenceKeys.add(evidenceKey);
	}
	if (memoEvidenceKeys.size > 0) evidenceKeysByMemoId.set(memoId, memoEvidenceKeys);
}

export async function materializeIdentityLedger(
	envelopes: readonly IdentityLedgerEventEnvelope[],
	runtime?: CooperativeTaskRuntime,
): Promise<IdentityLedgerSnapshot> {
	const yieldController = runtime === undefined ? null : new CooperativeYieldController(runtime);
	const { accepted, quarantinedEventIds } = selectIdentityLedgerEnvelopes(envelopes);
	const revision = await buildIdentityLedgerRevision(accepted);
	const acceptedEvents = accepted.map((item) => item.event);
	const eventsByMemoId = new Map<string, IdentityLedgerEvent[]>();
	for (const event of acceptedEvents) {
		const values = eventsByMemoId.get(event.memoId) ?? [];
		values.push(event);
		eventsByMemoId.set(event.memoId, values);
		if (yieldController?.shouldYield()) await yieldController.yieldNow();
	}
	const claims = accepted.filter((item): item is IdentityLedgerEventEnvelope & { event: IdentityLedgerClaimEvent } =>
		item.event.type === "claim");
	const claimedIntentIds = new Set(claims.flatMap((item) =>
		item.event.evidence.createIntentEventId === null ? [] : [item.event.evidence.createIntentEventId]));
	const intents = acceptedEvents
		.filter((event): event is IdentityLedgerCreateIntentEvent => event.type === "create_intent");
	const memoIds = [...eventsByMemoId.keys()].sort();
	const memos: Record<string, IdentityLedgerMaterializedMemo> = {};
	for (const memoId of memoIds) {
		const memoEvents = eventsByMemoId.get(memoId) ?? [];
		const bindingState = materializeMemoBindingGraph(memoId, memoEvents, revision);
		if (bindingState.bindings.length === 0) continue;
		const relationEvents = memoEvents.filter((event) =>
			event.type === "relation" && event.memoId === memoId);
		const sourceMemoIds = [...new Set(relationEvents.flatMap((event) =>
			event.type === "relation" && event.evidence.sourceMemoId !== null ? [event.evidence.sourceMemoId] : []))].sort();
		const reviews = memoEvents.filter((event) =>
			event.type === "review" && event.memoId === memoId);
		const reviewedAt = reviews.flatMap((event) => event.type === "review" ? [event.evidence.reviewedAt] : []).sort();
		const restoredDeleteIds = new Set(memoEvents.flatMap((event) =>
			event.type === "restore" ? [event.evidence.deleteEventId] : []));
		const deletePayloads = memoEvents
			.filter((event): event is IdentityLedgerDeletePayloadEvent => event.type === "delete_payload");
		const deletePayloadById = new Map(deletePayloads.map((event) => [event.eventId, event]));
		const deleteCommits = memoEvents
			.filter((event): event is IdentityLedgerDeleteCommitEvent => event.type === "delete_commit")
			.filter((event) => {
				const payload = deletePayloadById.get(event.evidence.deleteEventId);
				return payload !== undefined && payload.baseBindingId === event.baseBindingId;
			})
			.sort((left, right) => left.eventId.localeCompare(right.eventId));
		const commitByDeleteId = new Map<string, IdentityLedgerDeleteCommitEvent>();
		for (const commit of deleteCommits) {
			if (!commitByDeleteId.has(commit.evidence.deleteEventId)) {
				commitByDeleteId.set(commit.evidence.deleteEventId, commit);
			}
		}
		const purgedDeleteEventIds = [...new Set(memoEvents.flatMap((event) => {
			if (event.type !== "purge") return [];
			const payload = deletePayloadById.get(event.evidence.deleteEventId);
			const commit = commitByDeleteId.get(event.evidence.deleteEventId);
			return payload !== undefined && commit !== undefined && payload.baseBindingId === event.baseBindingId
				? [event.evidence.deleteEventId]
				: [];
		}))].sort();
		const purgedDeleteIds = new Set(purgedDeleteEventIds);
		const deleteRecords = deletePayloads
			.filter((event) => !restoredDeleteIds.has(event.eventId) && !purgedDeleteIds.has(event.eventId))
			.map((event): IdentityLedgerDeleteRecord => ({
				memoId,
				deleteEventId: event.eventId,
				deleteCommitEventId: commitByDeleteId.get(event.eventId)?.eventId ?? null,
				baseBindingId: event.baseBindingId,
				evidence: { ...event.evidence },
			}))
			.sort((left, right) => left.deleteEventId.localeCompare(right.deleteEventId));
		const pendingDeletes = deleteRecords.filter((record) => record.deleteCommitEventId === null);
		const activeDeletes = deleteRecords.filter((record) => record.deleteCommitEventId !== null);
		memos[memoId] = {
			memoId,
			createdAt: readCreatedAt(memoEvents),
			bindings: bindingState.bindings.filter((binding) => !deleteCommits.some((event) =>
				bindingState.aliases.get(event.baseBindingId) === binding.bindingId)),
			conflicted: bindingState.conflicted,
			conflictBaseBindingId: bindingState.conflictBaseBindingId,
			sourceMemoIds,
			reviewCount: reviews.length,
			lastReviewedAt: reviewedAt[reviewedAt.length - 1] ?? null,
			pendingDeletes,
			activeDeletes,
			purgedDeleteEventIds,
		};
		if (yieldController?.shouldYield(memoEvents.length)) await yieldController.yieldNow();
	}
	return {
		revision,
		eventCount: accepted.length,
		memos,
		pendingIntents: intents.filter((intent) => !claimedIntentIds.has(intent.eventId))
			.sort((left, right) => left.eventId.localeCompare(right.eventId)),
		quarantinedEventIds,
	};
}

function selectIdentityLedgerEnvelopes(
	envelopes: readonly IdentityLedgerEventEnvelope[],
): { accepted: IdentityLedgerEventEnvelope[]; quarantinedEventIds: string[] } {
	const byEventId = new Map<string, IdentityLedgerEventEnvelope[]>();
	for (const envelope of envelopes) {
		const values = byEventId.get(envelope.event.eventId) ?? [];
		values.push(envelope);
		byEventId.set(envelope.event.eventId, values);
	}
	const accepted: IdentityLedgerEventEnvelope[] = [];
	const quarantinedEventIds: string[] = [];
	for (const [eventId, values] of [...byEventId.entries()].sort(([left], [right]) => left.localeCompare(right))) {
		const digests = new Set(values.map((value) => value.digest));
		if (digests.size !== 1) {
			quarantinedEventIds.push(eventId);
			continue;
		}
		const selected = [...values].sort((left, right) => left.sourcePath.localeCompare(right.sourcePath))[0];
		if (selected !== undefined) accepted.push(selected);
	}
	accepted.sort((left, right) => left.event.eventId.localeCompare(right.event.eventId)
		|| left.event.writerId.localeCompare(right.event.writerId));
	return { accepted, quarantinedEventIds };
}

async function buildIdentityLedgerRevision(
	accepted: readonly IdentityLedgerEventEnvelope[],
): Promise<string> {
	const revisionDigest = await sha256IdentityLedgerText(canonicalIdentityLedgerJson(accepted.map((item) => ({
		eventId: item.event.eventId,
		digest: item.digest,
	}))));
	return `identity-${revisionDigest}`;
}

async function materializeIdentityLedgerIncrementally(
	previous: IdentityLedgerSnapshot,
	envelopes: readonly IdentityLedgerEventEnvelope[],
	affectedMemoIds: ReadonlySet<string>,
	runtime?: CooperativeTaskRuntime,
): Promise<IdentityLedgerSnapshot> {
	const yieldController = runtime === undefined ? null : new CooperativeYieldController(runtime);
	const { accepted, quarantinedEventIds } = selectIdentityLedgerEnvelopes(envelopes);
	if (yieldController?.shouldYield(accepted.length)) await yieldController.yieldNow();
	const revision = await buildIdentityLedgerRevision(accepted);
	const memos: Record<string, IdentityLedgerMaterializedMemo> = {};
	for (const [memoId, memo] of Object.entries(previous.memos)) {
		if (affectedMemoIds.has(memoId)) continue;
		memos[memoId] = {
			...memo,
			bindings: memo.bindings.map((binding) => ({ ...binding, identityRevision: revision })),
		};
		if (yieldController?.shouldYield(Math.max(1, memo.bindings.length))) await yieldController.yieldNow();
	}
	for (const memoId of [...affectedMemoIds].sort()) {
		const memoSnapshot = await materializeIdentityLedger(
			accepted.filter((item) => item.event.memoId === memoId),
			runtime,
		);
		const memo = memoSnapshot.memos[memoId];
		if (memo === undefined) continue;
		memos[memoId] = {
			...memo,
			bindings: memo.bindings.map((binding) => ({ ...binding, identityRevision: revision })),
		};
		if (yieldController?.shouldYield(Math.max(1, memo.bindings.length))) await yieldController.yieldNow();
	}
	const claimedIntentIds = new Set<string>();
	const pendingIntents: IdentityLedgerCreateIntentEvent[] = [];
	for (const item of accepted) {
		if (item.event.type === "claim" && item.event.evidence.createIntentEventId !== null) {
			claimedIntentIds.add(item.event.evidence.createIntentEventId);
		} else if (item.event.type === "create_intent") {
			pendingIntents.push(item.event);
		}
		if (yieldController?.shouldYield()) await yieldController.yieldNow();
	}
	return {
		revision,
		eventCount: accepted.length,
		memos,
		pendingIntents: pendingIntents
			.filter((intent) => !claimedIntentIds.has(intent.eventId))
			.sort((left, right) => left.eventId.localeCompare(right.eventId)),
		quarantinedEventIds,
	};
}

function collectAffectedMemoIds(
	existing: readonly IdentityLedgerEventEnvelope[],
	incoming: readonly IdentityLedgerEventEnvelope[],
): Set<string> {
	const incomingEventIds = new Set(incoming.map((item) => item.event.eventId));
	return new Set([
		...incoming.map((item) => item.event.memoId),
		...existing.filter((item) => incomingEventIds.has(item.event.eventId)).map((item) => item.event.memoId),
	]);
}

type IdentityLedgerBindingEvent = Extract<IdentityLedgerEvent, {
	type: "claim" | "rebind" | "restore" | "repair";
}>;

interface MaterializedBindingNode {
	bindingId: string;
	baseBindingId: string | null;
	kind: "claim" | "successor" | "repair";
	evidence: IdentityLedgerObservationEvidence;
}

function materializeMemoBindingGraph(
	memoId: string,
	events: readonly IdentityLedgerEvent[],
	identityRevision: string,
): Pick<IdentityLedgerMaterializedMemo, "bindings" | "conflicted" | "conflictBaseBindingId"> & { aliases: ReadonlyMap<string, string> } {
	const bindingEvents = events.filter((event): event is IdentityLedgerBindingEvent =>
		event.type === "claim" || event.type === "rebind" || event.type === "restore" || event.type === "repair");
	const aliases = new Map<string, string>();
	const nodes = new Map<string, MaterializedBindingNode>();
	materializeBindingGroups(
		bindingEvents.filter((event): event is Extract<IdentityLedgerBindingEvent, { type: "claim" }> =>
			event.type === "claim"),
		() => null,
		aliases,
		nodes,
	);
	let pending = bindingEvents.filter((event): event is Exclude<IdentityLedgerBindingEvent, { type: "claim" }> =>
		event.type !== "claim");
	while (pending.length > 0) {
		const ready = pending.filter((event) => aliases.has(event.baseBindingId));
		if (ready.length === 0) break;
		materializeBindingGroups(
			ready,
			(event) => event.baseBindingId === null ? null : aliases.get(event.baseBindingId) ?? null,
			aliases,
			nodes,
		);
		const readyIds = new Set(ready.map((event) => event.eventId));
		pending = pending.filter((event) => !readyIds.has(event.eventId));
	}
	const children = new Map<string, MaterializedBindingNode[]>();
	for (const node of nodes.values()) {
		if (node.baseBindingId === null) continue;
		const values = children.get(node.baseBindingId) ?? [];
		values.push(node);
		children.set(node.baseBindingId, values);
	}
	for (const values of children.values()) values.sort((left, right) => left.bindingId.localeCompare(right.bindingId));
	const roots = [...nodes.values()]
		.filter((node) => node.baseBindingId === null)
		.sort((left, right) => left.bindingId.localeCompare(right.bindingId));
	const heads = [...new Map(roots.flatMap((root) => collectActiveBindingHeads(root, children))
		.map((node) => [node.bindingId, node])).values()]
		.sort((left, right) => left.bindingId.localeCompare(right.bindingId));
	const conflicted = heads.length > 1;
	return {
		aliases,
		bindings: heads.map((node) => ({
			memoId,
			bindingId: node.bindingId,
			identityRevision,
			evidence: { ...node.evidence },
		})),
		conflicted,
		conflictBaseBindingId: conflicted ? findCommonBindingAncestor(heads, nodes) : null,
	};
}

function materializeBindingGroups(
	events: readonly IdentityLedgerBindingEvent[],
	getBaseBindingId: (event: IdentityLedgerBindingEvent) => string | null,
	aliases: Map<string, string>,
	nodes: Map<string, MaterializedBindingNode>,
): void {
	const groups = new Map<string, IdentityLedgerBindingEvent[]>();
	for (const event of events) {
		const baseBindingId = getBaseBindingId(event);
		if (event.type !== "claim" && baseBindingId === null) continue;
		const kind = getBindingNodeKind(event);
		const key = `${kind}\u0000${baseBindingId ?? "root"}\u0000${observationEvidenceKey(event.evidence.observation)}`;
		const values = groups.get(key) ?? [];
		values.push(event);
		groups.set(key, values);
	}
	for (const values of groups.values()) {
		values.sort((left, right) => left.eventId.localeCompare(right.eventId));
		const selected = values[0];
		if (selected === undefined) continue;
		const bindingId = selected.eventId;
		for (const event of values) aliases.set(event.eventId, bindingId);
		nodes.set(bindingId, {
			bindingId,
			baseBindingId: getBaseBindingId(selected),
			kind: getBindingNodeKind(selected),
			evidence: { ...selected.evidence.observation },
		});
	}
}

function getBindingNodeKind(event: IdentityLedgerBindingEvent): MaterializedBindingNode["kind"] {
	if (event.type === "claim") return "claim";
	return event.type === "repair" ? "repair" : "successor";
}

function collectActiveBindingHeads(
	node: MaterializedBindingNode,
	children: ReadonlyMap<string, readonly MaterializedBindingNode[]>,
): MaterializedBindingNode[] {
	const allChildren = children.get(node.bindingId) ?? [];
	const repairs = allChildren.filter((candidate) => candidate.kind === "repair");
	const effectiveChildren = repairs.length > 0 ? repairs : allChildren;
	return effectiveChildren.length === 0
		? [node]
		: effectiveChildren.flatMap((child) => collectActiveBindingHeads(child, children));
}

function findCommonBindingAncestor(
	heads: readonly MaterializedBindingNode[],
	nodes: ReadonlyMap<string, MaterializedBindingNode>,
): string | null {
	if (heads.length < 2) return null;
	const paths = heads.map((head) => getBindingAncestorPath(head, nodes));
	const first = paths[0] ?? [];
	const common = first.filter((bindingId) => paths.every((path) => path.includes(bindingId)));
	return common[0] ?? null;
}

function getBindingAncestorPath(
	node: MaterializedBindingNode,
	nodes: ReadonlyMap<string, MaterializedBindingNode>,
): string[] {
	const path: string[] = [];
	let current: MaterializedBindingNode | undefined = node;
	while (current !== undefined) {
		path.push(current.bindingId);
		current = current.baseBindingId === null ? undefined : nodes.get(current.baseBindingId);
	}
	return path;
}

interface RevisionSuccessorPlan {
	before: MemoObservation;
	successors: MemoObservation[];
}

interface RevisionReconciliationPlan {
	successors: RevisionSuccessorPlan[];
	safeAdditions: MemoObservation[];
}

function buildRevisionReconciliationPlan(
	before: readonly MemoObservation[],
	after: readonly MemoObservation[],
	insertedObservation: MemoObservation | null = null,
): RevisionReconciliationPlan {
	const insertedPlans = insertedObservation === null
		? null
		: buildKnownInsertionSuccessorPlans(before, after, insertedObservation);
	if (insertedPlans !== null) return { successors: insertedPlans, safeAdditions: [] };
	if (after.length === 0) return { successors: [], safeAdditions: [] };
	const afterPaths = new Set(after.map((observation) => normalizePath(observation.sourcePath)));
	const afterRevisions = new Set(after.map((observation) => observation.sourceRevision));
	if (afterPaths.size !== 1 || afterRevisions.size !== 1) {
		return { successors: [], safeAdditions: [] };
	}
	if (before.length === 0) {
		return {
			successors: [],
			safeAdditions: insertedObservation === null ? [...after] : [],
		};
	}
	const beforePaths = new Set(before.map((observation) => normalizePath(observation.sourcePath)));
	const beforeRevisions = new Set(before.map((observation) => observation.sourceRevision));
	if (beforePaths.size !== 1 || [...beforePaths][0] !== [...afterPaths][0]
		|| beforeRevisions.size !== 1 || [...beforeRevisions][0] === [...afterRevisions][0]) {
		return { successors: [], safeAdditions: [] };
	}
	const beforeBySignature = groupObservationIndexes(before);
	const afterBySignature = groupObservationIndexes(after);
	const matchedBefore = new Set<number>();
	const matchedAfter = new Set<number>();
	const anchors: Array<{ beforeIndex: number; afterIndex: number }> = [];
	const plans: RevisionSuccessorPlan[] = [];
	const safeAdditions: MemoObservation[] = [];
	for (const [signature, beforeIndexes] of beforeBySignature) {
		const afterIndexes = afterBySignature.get(signature) ?? [];
		if (beforeIndexes.length !== 1 || afterIndexes.length !== 1) continue;
		const beforeIndex = beforeIndexes[0] as number;
		const afterIndex = afterIndexes[0] as number;
		matchedBefore.add(beforeIndex);
		matchedAfter.add(afterIndex);
		anchors.push({ beforeIndex, afterIndex });
		plans.push({ before: before[beforeIndex] as MemoObservation, successors: [after[afterIndex] as MemoObservation] });
	}
	const boundaries = [
		{ beforeIndex: -1, afterIndex: -1 },
		...selectOrderedRevisionAnchors(anchors),
		{ beforeIndex: before.length, afterIndex: after.length },
	];
	for (let index = 0; index < boundaries.length - 1; index += 1) {
		const left = boundaries[index];
		const right = boundaries[index + 1];
		if (left === undefined || right === undefined) continue;
		const unmatchedBefore = before.filter((_observation, beforeIndex) =>
			beforeIndex > left.beforeIndex && beforeIndex < right.beforeIndex && !matchedBefore.has(beforeIndex));
		const unmatchedAfter = after.filter((_observation, afterIndex) =>
			afterIndex > left.afterIndex && afterIndex < right.afterIndex && !matchedAfter.has(afterIndex));
		if (unmatchedBefore.length === 0) {
			safeAdditions.push(...unmatchedAfter);
		} else if (unmatchedBefore.length === 1 && unmatchedAfter.length > 0) {
			plans.push({ before: unmatchedBefore[0] as MemoObservation, successors: [...unmatchedAfter] });
		}
	}
	return {
		successors: plans.sort((left, right) => left.before.startLine - right.before.startLine),
		safeAdditions: insertedObservation === null
			? safeAdditions.sort((left, right) => left.startLine - right.startLine)
			: [],
	};
}

function buildKnownInsertionSuccessorPlans(
	before: readonly MemoObservation[],
	after: readonly MemoObservation[],
	insertedObservation: MemoObservation,
): RevisionSuccessorPlan[] | null {
	if (after.length !== before.length + 1) return null;
	const beforePaths = new Set(before.map((observation) => normalizePath(observation.sourcePath)));
	const afterPaths = new Set(after.map((observation) => normalizePath(observation.sourcePath)));
	const beforeRevisions = new Set(before.map((observation) => observation.sourceRevision));
	const afterRevisions = new Set(after.map((observation) => observation.sourceRevision));
	const afterPath = [...afterPaths][0];
	const afterRevision = [...afterRevisions][0];
	if (afterPaths.size !== 1 || afterRevisions.size !== 1
		|| normalizePath(insertedObservation.sourcePath) !== afterPath
		|| insertedObservation.sourceRevision !== afterRevision
		|| (before.length > 0 && (beforePaths.size !== 1
			|| [...beforePaths][0] !== afterPath
			|| beforeRevisions.size !== 1
			|| [...beforeRevisions][0] === afterRevision))) return null;
	const insertedKey = observationEvidenceKey(toObservationEvidence(insertedObservation));
	const insertedIndexes = after.flatMap((observation, index) =>
		observationEvidenceKey(toObservationEvidence(observation)) === insertedKey ? [index] : []);
	if (insertedIndexes.length !== 1) return null;
	const insertedIndex = insertedIndexes[0] as number;
	const remaining = after.filter((_observation, index) => index !== insertedIndex);
	if (!before.every((observation, index) =>
		observation.logicalDate === remaining[index]?.logicalDate
		&& observationContinuationKey(observation) === observationContinuationKey(remaining[index] as MemoObservation))) {
		return null;
	}
	return before.map((observation, index) => ({
		before: observation,
		successors: [remaining[index] as MemoObservation],
	}));
}

function selectOrderedRevisionAnchors(
	anchors: readonly { beforeIndex: number; afterIndex: number }[],
): Array<{ beforeIndex: number; afterIndex: number }> {
	const ordered = [...anchors].sort((left, right) => left.beforeIndex - right.beforeIndex);
	const selected: Array<{ beforeIndex: number; afterIndex: number }> = [];
	let lastAfterIndex = -1;
	for (const anchor of ordered) {
		if (anchor.afterIndex <= lastAfterIndex) continue;
		selected.push(anchor);
		lastAfterIndex = anchor.afterIndex;
	}
	return selected;
}

function groupObservationIndexes(observations: readonly MemoObservation[]): Map<string, number[]> {
	const groups = new Map<string, number[]>();
	for (const [index, observation] of observations.entries()) {
		const signature = observationContinuationKey(observation);
		const indexes = groups.get(signature) ?? [];
		indexes.push(index);
		groups.set(signature, indexes);
	}
	return groups;
}

function observationContinuationKey(observation: MemoObservation): string {
	// 扫描锚点与稳定身份采用同一语义，原始缩进等格式变化不打断相邻编辑的续接。
	return memoObservationSignature(observation);
}

function cloneBinding(binding: IdentityLedgerBinding): IdentityLedgerBinding {
	return { ...binding, evidence: { ...binding.evidence } };
}

function observationEvidenceKey(evidence: IdentityLedgerObservationEvidence): string {
	return canonicalIdentityLedgerJson(evidence);
}

function compareHistoricalObservations(left: MemoObservation, right: MemoObservation): number {
	return normalizePath(left.sourcePath).localeCompare(normalizePath(right.sourcePath))
		|| left.startLine - right.startLine
		|| left.endLine - right.endLine
		|| left.rawBlockHash.localeCompare(right.rawBlockHash);
}

async function buildLocalObservationClaim(
	observation: MemoObservation,
	writerId: string,
	previousMemoId: string | null = null,
): Promise<IdentityLedgerClaimEvent> {
	const evidence = toObservationEvidence(observation);
	const memoId = await deterministicHistoricalMemoId(evidence, observation, previousMemoId);
	return {
		eventId: await deterministicObservationClaimEventId(writerId, memoId, evidence),
		writerId,
		memoId,
		type: "claim",
		baseBindingId: null,
		occurredAt: historicalObservationSortingTime(evidence),
		evidence: { observation: evidence, createIntentEventId: null },
	};
}

async function deterministicHistoricalMemoId(
	evidence: IdentityLedgerObservationEvidence,
	observation: MemoObservation,
	previousMemoId: string | null = null,
): Promise<string> {
	const digest = await sha256IdentityLedgerText(canonicalIdentityLedgerJson({
		domain: "historical-daily-bootstrap-memo",
		evidence,
		// 创建现场只用于一次性 ID 派生；后续扫描既不重新生成 ID，也不持久保存这些字段。
		creation: { sourceRevision: observation.sourceRevision, startLine: observation.startLine, previousMemoId },
	}));
	return createIdentityLedgerMemoId(new Date(historicalObservationSortingTime(evidence)), (target) => {
		for (let index = 0; index < target.length; index += 1) {
			target[index] = Number.parseInt(digest.slice(index * 2, index * 2 + 2), 16);
		}
	});
}

async function deterministicObservationClaimEventId(
	writerId: string,
	memoId: string,
	evidence: IdentityLedgerObservationEvidence,
): Promise<string> {
	return `e_${(await sha256IdentityLedgerText(canonicalIdentityLedgerJson({
		domain: "local-observation-claim",
		writerId,
		memoId,
		evidence,
	}))).slice(0, 32)}`;
}

// 历史 Daily 不含时区；该值仅用于跨设备一致的排序和 UUIDv7 前缀，不能表示真实发生时刻。
function historicalObservationSortingTime(evidence: IdentityLedgerObservationEvidence): string {
	const time = evidence.time.length === 5 ? `${evidence.time}:00` : evidence.time;
	return `${evidence.logicalDate}T${time}.000Z`;
}

function mergeEnvelopes(
	current: readonly IdentityLedgerEventEnvelope[],
	incoming: readonly IdentityLedgerEventEnvelope[],
): IdentityLedgerEventEnvelope[] {
	return [...new Map([...current, ...incoming].map((item) => [
		`${item.sourcePath}\u0000${item.event.eventId}\u0000${item.digest}`,
		item,
	])).values()];
}

async function validateCachedIdentityEnvelopes(
	rootPath: string,
	values: readonly unknown[],
): Promise<IdentityLedgerEventEnvelope[]> {
	const normalizedRoot = normalizePath(rootPath);
	const envelopes: IdentityLedgerEventEnvelope[] = [];
	for (const value of values) {
		if (!isRecord(value)
			|| !isRecord(value.event)
			|| typeof value.digest !== "string"
			|| typeof value.sourcePath !== "string") {
			throw new Error("Cached Identity Ledger envelope is invalid.");
		}
		assertIdentityLedgerEvent(value.event);
		const sourcePath = normalizePath(value.sourcePath);
		if (sourcePath !== value.sourcePath
			|| !sourcePath.startsWith(`${normalizedRoot}/writers/${value.event.writerId}/segments/`)) {
			throw new Error("Cached Identity Ledger source path is invalid.");
		}
		const digest = await sha256IdentityLedgerText(canonicalIdentityLedgerJson(value.event));
		if (digest !== value.digest) throw new Error("Cached Identity Ledger digest is invalid.");
		envelopes.push({ event: value.event, digest, sourcePath });
	}
	return envelopes;
}

function listSegmentFiles(root: TFolder): TFile[] {
	const files: TFile[] = [];
	const visit = (file: TAbstractFile) => {
		if (file instanceof TFile && file.extension === "jsonl") files.push(file);
		if (file instanceof TFolder) file.children.forEach(visit);
	};
	root.children.forEach(visit);
	return files;
}

function isIdentityLedgerFile(file: unknown, rootPath: string | null): file is TAbstractFile {
	return (file instanceof TFile || file instanceof TFolder) && isIdentityLedgerPath(file.path, rootPath);
}

function isIdentityLedgerPath(path: unknown, rootPath: string | null): boolean {
	if (typeof path !== "string" || rootPath === null) return false;
	const normalizedPath = normalizePath(path);
	const normalizedRoot = normalizePath(rootPath);
	return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
}

class IdentityLedgerWriteCancelledError extends Error {
	constructor() {
		super("Identity Ledger write was cancelled.");
	}
}

class IdentityLedgerRefreshCancelledError extends Error {
	constructor() {
		super("Identity Ledger refresh was cancelled.");
	}
}

class MissingIdentityLedgerRootError extends Error {
	constructor() {
		super("Configured Identity Ledger root is missing.");
	}
}

function createEmptySnapshot(): IdentityLedgerSnapshot {
	return {
		revision: "identity-empty",
		eventCount: 0,
		memos: {},
		pendingIntents: [],
		quarantinedEventIds: [],
	};
}

function cloneSnapshot(snapshot: IdentityLedgerSnapshot): IdentityLedgerSnapshot {
	return {
		revision: snapshot.revision,
		eventCount: snapshot.eventCount,
		memos: Object.fromEntries(Object.entries(snapshot.memos).map(([memoId, memo]) => [memoId, {
			memoId: memo.memoId,
			createdAt: memo.createdAt,
			bindings: memo.bindings.map((binding) => ({
				...binding,
				evidence: { ...binding.evidence },
			})),
			conflicted: memo.conflicted,
			conflictBaseBindingId: memo.conflictBaseBindingId,
			sourceMemoIds: [...memo.sourceMemoIds],
			reviewCount: memo.reviewCount,
			lastReviewedAt: memo.lastReviewedAt,
			pendingDeletes: (memo.pendingDeletes ?? []).map(cloneDeleteRecord),
			activeDeletes: (memo.activeDeletes ?? []).map(cloneDeleteRecord),
			purgedDeleteEventIds: [...(memo.purgedDeleteEventIds ?? [])],
		}])),
		pendingIntents: snapshot.pendingIntents.map((intent) => ({
			...intent,
			evidence: { ...intent.evidence },
		})),
		quarantinedEventIds: [...snapshot.quarantinedEventIds],
	};
}

function matchesCreateIntentObservation(
	intent: IdentityLedgerCreateIntentEvent,
	observation: MemoObservation,
): boolean {
	return (intent.evidence.targetPath === null
			|| normalizePath(observation.sourcePath) === normalizePath(intent.evidence.targetPath))
		&& observation.logicalDate === intent.evidence.logicalDate
		&& matchesCreateIntentTime(intent.evidence.time, observation.time)
		&& observation.contentHash === intent.evidence.contentHash;
}

function matchesCreateIntentTime(intentTime: string, observationTime: string): boolean {
	return intentTime === observationTime
		|| (intentTime.length === 8 && observationTime.length === 5 && intentTime.startsWith(`${observationTime}:`));
}

function readCreatedAt(events: readonly IdentityLedgerEvent[]): string | null {
	const intents = new Map(events.flatMap((event) => event.type === "create_intent"
		? [[event.eventId, event] as const]
		: []));
	const values = new Set(events.flatMap((event) => {
		if (event.type !== "claim" || event.evidence.createIntentEventId === null) return [];
		const intent = intents.get(event.evidence.createIntentEventId);
		if (intent === undefined || intent.memoId !== event.memoId) return [];
		const time = intent.evidence.time.length === 5 ? `${intent.evidence.time}:00` : intent.evidence.time;
		return [`${intent.evidence.logicalDate}T${time}`];
	}));
	return values.size === 1 ? values.values().next().value ?? null : null;
}

function cloneDeleteRecord(record: IdentityLedgerDeleteRecord): IdentityLedgerDeleteRecord {
	return {
		memoId: record.memoId,
		deleteEventId: record.deleteEventId,
		deleteCommitEventId: record.deleteCommitEventId,
		baseBindingId: record.baseBindingId,
		evidence: { ...record.evidence },
	};
}

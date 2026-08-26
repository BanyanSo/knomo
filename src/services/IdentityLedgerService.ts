import { normalizePath, TFile, TFolder } from "obsidian";
import type { App, Component, TAbstractFile } from "obsidian";

import type { MemoObservation } from "../types/catalog";
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
	IdentityLedgerRebindEvent,
	IdentityLedgerRebindReason,
	IdentityLedgerReconcileResult,
	IdentityLedgerSnapshot,
	IdentityLedgerStatus,
} from "../types/identityLedger";
import {
	canonicalIdentityLedgerJson,
	createIdentityLedgerEventId,
	createIdentityLedgerMemoId,
	createIdentityLedgerWriterId,
	getIdentityLedgerSegmentPath,
	getIdentityLedgerWriterSegmentsPath,
	parseIdentityLedgerSegment,
	serializeIdentityLedgerSegment,
	sha256IdentityLedgerText,
} from "./IdentityLedgerProtocol";

const LEGACY_IMPORT_SEGMENT_EVENT_LIMIT = 256;

export interface IdentityLedgerServiceOptions {
	getRootPath: () => string | null;
	getWriterId?: () => Promise<string>;
	createMemoId?: () => string;
	createEventId?: () => string;
	now?: () => Date;
}

export class IdentityLedgerService implements IdentityLedgerMutationService {
	private readonly sessionWriterId = createIdentityLedgerWriterId();
	private readonly now: () => Date;
	private readonly createMemoId: () => string;
	private readonly createEventId: () => string;
	private envelopes: IdentityLedgerEventEnvelope[] = [];
	private snapshot: IdentityLedgerSnapshot = createEmptySnapshot();
	private status: IdentityLedgerStatus = "unavailable";
	private scanErrorCount = 0;
	private onChanged: (() => void | Promise<void>) | null = null;
	private notificationRequested = false;
	private notificationRunning = false;
	private refreshQueue: Promise<void> = Promise.resolve();
	private refreshRequested = false;
	private writeQueue: Promise<void> = Promise.resolve();
	private writePauseCount = 0;
	private readonly selfWrittenPaths = new Map<string, number>();

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
			this.onChanged = null;
			this.notificationRequested = false;
		});
		// 监听建立后补扫一次，覆盖初始化扫描与事件注册之间的变更窗口。
		this.scheduleRefresh();
	}

	async initialize(): Promise<void> {
		try {
			await this.refreshFromVault();
		} catch {
			this.envelopes = [];
			this.snapshot = createEmptySnapshot();
			this.status = "unavailable";
		}
	}

	async reloadConfiguredRoot(): Promise<void> {
		await this.initialize();
		await this.notifyChanged();
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

	getSnapshot(): IdentityLedgerSnapshot {
		return cloneSnapshot(this.snapshot);
	}

	resolveObservation(observation: MemoObservation): IdentityLedgerBinding | null {
		const state = this.resolveObservationState(observation);
		return state.kind === "identified" ? state.binding : null;
	}

	resolveObservationState(observation: MemoObservation): IdentityLedgerObservationState {
		const candidates = this.findObservationBindings(observation);
		if (candidates.length === 0) return { kind: "unbound" };
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

	async importVerifiedLegacyEvents(events: readonly IdentityLedgerEvent[]): Promise<number> {
		if (events.length === 0) return 0;
		if (this.writePauseCount > 0) throw new Error("Identity Ledger writes are paused for data root migration.");
		const existingByEventId = new Map<string, IdentityLedgerEventEnvelope[]>();
		for (const envelope of this.envelopes) {
			const values = existingByEventId.get(envelope.event.eventId) ?? [];
			values.push(envelope);
			existingByEventId.set(envelope.event.eventId, values);
		}
		const pendingByEventId = new Map<string, { event: IdentityLedgerEvent; digest: string }>();
		for (const event of events) {
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

		const previous = this.writeQueue;
		let releaseQueue: () => void = () => undefined;
		this.writeQueue = new Promise<void>((resolve) => { releaseQueue = resolve; });
		await previous;
		try {
			const rootPath = this.requireRootPath();
			const incoming: IdentityLedgerEventEnvelope[] = [];
			const byWriter = new Map<string, IdentityLedgerEvent[]>();
			for (const event of pendingEvents) {
				const writerEvents = byWriter.get(event.writerId) ?? [];
				writerEvents.push(event);
				byWriter.set(event.writerId, writerEvents);
			}
			for (const [writerId, writerEvents] of byWriter) {
				await this.ensureFolder(rootPath, getIdentityLedgerWriterSegmentsPath(rootPath, writerId));
				for (let index = 0; index < writerEvents.length; index += LEGACY_IMPORT_SEGMENT_EVENT_LIMIT) {
					const batch = writerEvents.slice(index, index + LEGACY_IMPORT_SEGMENT_EVENT_LIMIT);
					const first = batch[0];
					if (first === undefined) continue;
					const content = serializeIdentityLedgerSegment(batch);
					const digest = await sha256IdentityLedgerText(content);
					const path = getIdentityLedgerSegmentPath(rootPath, writerId, first.eventId, digest);
					await this.writeImmutable(path, content);
					incoming.push(...(await parseIdentityLedgerSegment(rootPath, path, content)).events);
				}
			}
			this.envelopes = mergeEnvelopes(this.envelopes, incoming);
			await this.materialize();
		} catch (error) {
			this.status = error instanceof MissingIdentityLedgerRootError ? "missing" : "unavailable";
			throw error;
		} finally {
			releaseQueue();
		}
		this.scheduleNotification();
		return pendingEvents.length;
	}

	async beginCreate(input: IdentityLedgerCreateInput): Promise<IdentityLedgerCreatePlan> {
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
		try {
			await this.appendEvent(intent, false);
			return { memoId, intent, intentDurable: true };
		} catch {
			return { memoId, intent, intentDurable: false };
		}
	}

	async finishCreate(plan: IdentityLedgerCreatePlan, observation: MemoObservation): Promise<IdentityLedgerBinding> {
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
				observation: toObservationEvidence(observation),
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
		await this.appendEvents(events);
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
				&& (intent.evidence.targetPath === null
					|| normalizePath(observation.sourcePath) === normalizePath(intent.evidence.targetPath))
				&& observation.logicalDate === intent.evidence.logicalDate
				&& observation.time === intent.evidence.time
				&& observation.contentHash === intent.evidence.contentHash);
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
	): Promise<IdentityLedgerReconcileResult> {
		const plans = buildRevisionSuccessorPlans(before, after).flatMap((plan) => {
			const baseBindings = this.findObservationBindings(plan.before);
			if (baseBindings.length !== 1) return [];
			return plan.successors.map((successor) => ({
				base: baseBindings[0] as IdentityLedgerBinding,
				successor,
			}));
		});
		const writerId = await this.getWriterId();
		const events: IdentityLedgerRebindEvent[] = [];
		const affectedMemoIds = new Set<string>();
		for (const plan of plans) {
			if (this.hasActiveSuccessor(plan.base.memoId, plan.base.bindingId, plan.successor)) continue;
			events.push(this.createRebindEvent(plan.base, plan.successor, "edit", writerId));
			affectedMemoIds.add(plan.base.memoId);
		}
		await this.appendEvents(events);
		return {
			appendedEventCount: events.length,
			conflictedMemoIds: [...affectedMemoIds]
				.filter((memoId) => this.snapshot.memos[memoId]?.conflicted === true)
				.sort(),
		};
	}

	async rebindObservation(
		before: MemoObservation,
		after: MemoObservation,
		reason: IdentityLedgerRebindReason,
	): Promise<IdentityLedgerBinding | null> {
		const bases = this.findObservationBindings(before);
		if (bases.length !== 1) {
			const current = this.resolveObservationState(after);
			return current.kind === "identified" ? current.binding : null;
		}
		const base = bases[0] as IdentityLedgerBinding;
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
		const memoId = this.createMemoId();
		const claim: IdentityLedgerClaimEvent = {
			eventId: this.createEventId(),
			writerId: await this.getWriterId(),
			memoId,
			type: "claim",
			baseBindingId: null,
			occurredAt: this.now().toISOString(),
			evidence: {
				observation: toObservationEvidence(observation),
				createIntentEventId: null,
			},
		};
		await this.appendEvent(claim);
		const resolved = this.resolveObservationState(observation);
		if (resolved.kind !== "identified" || resolved.binding.memoId !== memoId) {
			throw new Error("Identity Ledger adoption did not produce a unique binding.");
		}
		return resolved.binding;
	}

	async repairConflict(memoId: string, observation: MemoObservation): Promise<IdentityLedgerBinding> {
		const memo = this.snapshot.memos[memoId];
		if (memo?.conflicted !== true || memo.conflictBaseBindingId === null) {
			throw new Error("Identity Ledger memo has no repairable binding fork.");
		}
		const evidenceKey = observationEvidenceKey(toObservationEvidence(observation));
		if (!memo.bindings.some((binding) => observationEvidenceKey(binding.evidence) === evidenceKey)) {
			throw new Error("Identity Ledger repair target is not an active successor.");
		}
		const eventId = this.createEventId();
		await this.appendEvent({
			eventId,
			writerId: await this.getWriterId(),
			memoId,
			type: "repair",
			baseBindingId: memo.conflictBaseBindingId,
			occurredAt: this.now().toISOString(),
			evidence: { observation: toObservationEvidence(observation) },
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
		const eventId = this.createEventId();
		await this.appendEvent({
			eventId,
			writerId: await this.getWriterId(),
			memoId: deleteRecord.memoId,
			type: "restore",
			baseBindingId: deleteRecord.baseBindingId,
			occurredAt: this.now().toISOString(),
			evidence: {
				observation: toObservationEvidence(observation),
				deleteEventId: deleteRecord.deleteEventId,
			},
		});
		const binding = this.findObservationBindings(observation)
			.find((item) => item.memoId === deleteRecord.memoId && item.bindingId === eventId)
			?? this.findObservationBindings(observation).find((item) => item.memoId === deleteRecord.memoId);
		if (binding === undefined) throw new Error("Identity Ledger restore did not materialize its binding.");
		return binding;
	}

	private findObservationBindings(observation: MemoObservation): IdentityLedgerBinding[] {
		const expected = observationEvidenceKey(toObservationEvidence(observation));
		return Object.values(this.snapshot.memos).flatMap((memo) => memo.bindings
			.filter((binding) => observationEvidenceKey(binding.evidence) === expected)
			.map(cloneBinding));
	}

	private hasActiveSuccessor(memoId: string, baseBindingId: string, observation: MemoObservation): boolean {
		const expected = observationEvidenceKey(toObservationEvidence(observation));
		return this.envelopes.some(({ event }) => event.memoId === memoId
			&& (event.type === "rebind" || event.type === "restore" || event.type === "repair")
			&& event.baseBindingId === baseBindingId
			&& observationEvidenceKey(event.evidence.observation) === expected);
	}

	private async appendRebind(
		base: IdentityLedgerBinding,
		observation: MemoObservation,
		reason: IdentityLedgerRebindReason,
	): Promise<IdentityLedgerBinding> {
		const event = this.createRebindEvent(base, observation, reason, await this.getWriterId());
		await this.appendEvent(event);
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
				observation: toObservationEvidence(observation),
				reason,
			},
		};
	}

	private async appendEvent(event: IdentityLedgerEvent, notify = true): Promise<void> {
		await this.appendEvents([event], notify);
	}

	private async appendEvents(events: readonly IdentityLedgerEvent[], notify = true): Promise<void> {
		if (events.length === 0) return;
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
			const rootPath = this.requireRootPath();
			const content = serializeIdentityLedgerSegment(events);
			const digest = await sha256IdentityLedgerText(content);
			const path = getIdentityLedgerSegmentPath(rootPath, first.writerId, first.eventId, digest);
			await this.ensureFolder(rootPath, getIdentityLedgerWriterSegmentsPath(rootPath, first.writerId));
			await this.writeImmutable(path, content);
			const parsed = await parseIdentityLedgerSegment(rootPath, path, content);
			const affectedMemoIds = collectAffectedMemoIds(this.envelopes, parsed.events);
			this.envelopes = mergeEnvelopes(this.envelopes, parsed.events);
			this.snapshot = await materializeIdentityLedgerIncrementally(
				this.snapshot,
				this.envelopes,
				affectedMemoIds,
			);
			this.updateStatus();
		} catch (error) {
			this.status = error instanceof MissingIdentityLedgerRootError ? "missing" : "unavailable";
			throw error;
		} finally {
			releaseQueue();
		}
		if (notify) this.scheduleNotification();
	}

	private async refreshFromVault(): Promise<void> {
		const rootPath = this.getRootPath();
		if (rootPath === null) {
			this.setMissing();
			return;
		}
		const root = this.app.vault.getAbstractFileByPath(rootPath);
		if (root === null) {
			this.setMissing();
			return;
		}
		if (!(root instanceof TFolder)) throw new Error("Identity Ledger root is not a folder.");
		const files = listSegmentFiles(root).sort((left, right) => left.path.localeCompare(right.path));
		const envelopes: IdentityLedgerEventEnvelope[] = [];
		let errors = 0;
		for (const file of files) {
			try {
				const parsed = await parseIdentityLedgerSegment(rootPath, file.path, await this.app.vault.cachedRead(file));
				envelopes.push(...parsed.events);
			} catch {
				errors += 1;
			}
		}
		this.envelopes = envelopes;
		this.scanErrorCount = errors;
		await this.materialize();
	}

	private async materialize(): Promise<void> {
		this.snapshot = await materializeIdentityLedger(this.envelopes);
		this.updateStatus();
	}

	private updateStatus(): void {
		this.status = this.scanErrorCount > 0 || this.snapshot.quarantinedEventIds.length > 0
			? "conflicted"
			: this.snapshot.eventCount === 0 ? "absent" : "ready";
	}

	private scheduleRefresh(): void {
		this.refreshRequested = true;
		this.refreshQueue = this.refreshQueue.then(async () => {
			if (!this.refreshRequested) return;
			this.refreshRequested = false;
			await this.refreshFromVault();
			this.scheduleNotification();
		}).catch(() => {
			this.status = "unavailable";
		});
	}

	private scheduleNotification(): void {
		this.notificationRequested = true;
		if (this.notificationRunning) return;
		this.notificationRunning = true;
		void this.flushNotifications();
	}

	private async flushNotifications(): Promise<void> {
		try {
			while (this.notificationRequested) {
				this.notificationRequested = false;
				await this.notifyChanged();
			}
		} catch {
			// 观察者失败不能改变已持久化 Identity 事件的结果。
		} finally {
			this.notificationRunning = false;
			if (this.notificationRequested) this.scheduleNotification();
		}
	}

	private async notifyChanged(): Promise<void> {
		await this.onChanged?.();
	}

	private async getWriterId(): Promise<string> {
		try {
			return await this.options.getWriterId?.() ?? this.sessionWriterId;
		} catch {
			return this.sessionWriterId;
		}
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

	private setMissing(): void {
		this.envelopes = [];
		this.snapshot = createEmptySnapshot();
		this.scanErrorCount = 0;
		this.status = "missing";
	}

	private async ensureFolder(rootPath: string, path: string): Promise<void> {
		const normalizedRoot = normalizePath(rootPath);
		const normalizedPath = normalizePath(path);
		if (!normalizedPath.startsWith(`${normalizedRoot}/`)) {
			throw new Error("Identity Ledger child path is outside the configured root.");
		}
		if (!(this.app.vault.getAbstractFileByPath(normalizedRoot) instanceof TFolder)) {
			throw new MissingIdentityLedgerRootError();
		}
		const segments = normalizedPath.slice(normalizedRoot.length + 1).split("/").filter(Boolean);
		let current = normalizedRoot;
		for (const segment of segments) {
			current = `${current}/${segment}`;
			const existing = this.app.vault.getAbstractFileByPath(current);
			if (existing instanceof TFolder) continue;
			if (existing !== null) throw new Error(`Identity Ledger path is not a folder: ${current}`);
			try {
				await this.app.vault.createFolder(current);
			} catch (error) {
				if (!(this.app.vault.getAbstractFileByPath(current) instanceof TFolder)) throw error;
			}
		}
	}

	private async writeImmutable(path: string, content: string): Promise<void> {
		const normalizedPath = normalizePath(path);
		const existing = this.app.vault.getAbstractFileByPath(normalizedPath);
		if (existing instanceof TFile) {
			if (await this.app.vault.cachedRead(existing) !== content) {
				throw new Error(`Identity Ledger immutable path collision: ${path}`);
			}
			return;
		}
		if (existing !== null) throw new Error(`Identity Ledger path is not a file: ${path}`);
		this.markSelfWrittenPath(normalizedPath);
		try {
			await this.app.vault.create(normalizedPath, content);
		} catch (error) {
			const raced = this.app.vault.getAbstractFileByPath(normalizedPath);
			if (!(raced instanceof TFile) || await this.app.vault.cachedRead(raced) !== content) throw error;
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

export async function materializeIdentityLedger(
	envelopes: readonly IdentityLedgerEventEnvelope[],
): Promise<IdentityLedgerSnapshot> {
	const { accepted, quarantinedEventIds } = selectIdentityLedgerEnvelopes(envelopes);
	const revision = await buildIdentityLedgerRevision(accepted);
	const acceptedEvents = accepted.map((item) => item.event);
	const eventsByMemoId = new Map<string, IdentityLedgerEvent[]>();
	for (const event of acceptedEvents) {
		const values = eventsByMemoId.get(event.memoId) ?? [];
		values.push(event);
		eventsByMemoId.set(event.memoId, values);
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
		const deleteRecords = deletePayloads
			.filter((event) => !restoredDeleteIds.has(event.eventId))
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
			bindings: bindingState.bindings,
			conflicted: bindingState.conflicted,
			conflictBaseBindingId: bindingState.conflictBaseBindingId,
			sourceMemoIds,
			reviewCount: reviews.length,
			lastReviewedAt: reviewedAt[reviewedAt.length - 1] ?? null,
			pendingDeletes,
			activeDeletes,
		};
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
): Promise<IdentityLedgerSnapshot> {
	const { accepted, quarantinedEventIds } = selectIdentityLedgerEnvelopes(envelopes);
	const revision = await buildIdentityLedgerRevision(accepted);
	const memos: Record<string, IdentityLedgerMaterializedMemo> = {};
	for (const [memoId, memo] of Object.entries(previous.memos)) {
		if (affectedMemoIds.has(memoId)) continue;
		memos[memoId] = {
			...memo,
			bindings: memo.bindings.map((binding) => ({ ...binding, identityRevision: revision })),
		};
	}
	for (const memoId of [...affectedMemoIds].sort()) {
		const memoSnapshot = await materializeIdentityLedger(
			accepted.filter((item) => item.event.memoId === memoId),
		);
		const memo = memoSnapshot.memos[memoId];
		if (memo === undefined) continue;
		memos[memoId] = {
			...memo,
			bindings: memo.bindings.map((binding) => ({ ...binding, identityRevision: revision })),
		};
	}
	const claimedIntentIds = new Set(accepted.flatMap((item) =>
		item.event.type === "claim" && item.event.evidence.createIntentEventId !== null
			? [item.event.evidence.createIntentEventId]
			: []));
	return {
		revision,
		eventCount: accepted.length,
		memos,
		pendingIntents: accepted.map((item) => item.event)
			.filter((event): event is IdentityLedgerCreateIntentEvent => event.type === "create_intent")
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
): Pick<IdentityLedgerMaterializedMemo, "bindings" | "conflicted" | "conflictBaseBindingId"> {
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

function buildRevisionSuccessorPlans(
	before: readonly MemoObservation[],
	after: readonly MemoObservation[],
): RevisionSuccessorPlan[] {
	if (before.length === 0 || after.length === 0) return [];
	const beforePaths = new Set(before.map((observation) => normalizePath(observation.sourcePath)));
	const afterPaths = new Set(after.map((observation) => normalizePath(observation.sourcePath)));
	const beforeRevisions = new Set(before.map((observation) => observation.sourceRevision));
	const afterRevisions = new Set(after.map((observation) => observation.sourceRevision));
	if (beforePaths.size !== 1 || afterPaths.size !== 1
		|| [...beforePaths][0] !== [...afterPaths][0]
		|| beforeRevisions.size !== 1 || afterRevisions.size !== 1
		|| [...beforeRevisions][0] === [...afterRevisions][0]) return [];
	const beforeBySignature = groupObservationIndexes(before);
	const afterBySignature = groupObservationIndexes(after);
	const matchedBefore = new Set<number>();
	const matchedAfter = new Set<number>();
	const anchors: Array<{ beforeIndex: number; afterIndex: number }> = [];
	const plans: RevisionSuccessorPlan[] = [];
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
		if (unmatchedBefore.length === 1 && unmatchedAfter.length > 0) {
			plans.push({ before: unmatchedBefore[0] as MemoObservation, successors: [...unmatchedAfter] });
		}
	}
	return plans.sort((left, right) => left.before.startLine - right.before.startLine);
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
		const signature = canonicalIdentityLedgerJson({
			rawBlockHash: observation.rawBlockHash,
			section: observation.section,
			time: observation.time,
			content: observation.content,
			contentHash: observation.contentHash,
			existingBlockId: observation.existingBlockId,
			tags: observation.tags,
			links: observation.links,
			images: observation.images,
			tasks: observation.tasks,
			timeBuoyDates: observation.timeBuoyDates,
		});
		const indexes = groups.get(signature) ?? [];
		indexes.push(index);
		groups.set(signature, indexes);
	}
	return groups;
}

function toObservationEvidence(observation: MemoObservation): IdentityLedgerObservationEvidence {
	return {
		sourcePath: normalizePath(observation.sourcePath),
		sourceRevision: observation.sourceRevision,
		rawBlockHash: observation.rawBlockHash,
		logicalDate: observation.logicalDate,
		section: observation.section,
		startLine: observation.startLine,
		endLine: observation.endLine,
		time: observation.time,
		contentHash: observation.contentHash,
	};
}

function cloneBinding(binding: IdentityLedgerBinding): IdentityLedgerBinding {
	return { ...binding, evidence: { ...binding.evidence } };
}

function observationEvidenceKey(evidence: IdentityLedgerObservationEvidence): string {
	return canonicalIdentityLedgerJson(evidence);
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
		}])),
		pendingIntents: snapshot.pendingIntents.map((intent) => ({
			...intent,
			evidence: { ...intent.evidence },
		})),
		quarantinedEventIds: [...snapshot.quarantinedEventIds],
	};
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

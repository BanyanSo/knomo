import { TFile, TFolder } from "obsidian";
import type { App, Component } from "obsidian";

import type { CatalogCoverage, CatalogFileRevisionBatch, MemoObservation } from "../types/catalog";
import type {
	IdentityLedgerBinding,
	IdentityLedgerDeletePayloadEvent,
	IdentityLedgerEvent,
	IdentityLedgerLegacyImportTarget,
	IdentityLedgerObservationEvidence,
} from "../types/identityLedger";
import type {
	LegacyIndexDiagnostic,
	LegacyIndexEvidence,
	LegacyIndexMemo,
	LegacyIndexSnapshot,
	LegacyIndexSource,
	LegacyPendingMemo,
} from "../types/legacyIndex";
import type { LegacyIdentityImportReport } from "../types/legacyMigration";
import { hashText } from "../utils/hash";
import { canonicalIdentityLedgerJson, sha256IdentityLedgerText } from "./IdentityLedgerProtocol";
import type { LowPriorityWorkRunner } from "./LowPriorityWorkQueue";
import type { MemoCatalogStore } from "./MemoCatalogStore";
import { CooperativeYieldController } from "./CooperativeTask";

const EMPTY_REPORT: LegacyIdentityImportReport = {
	status: "idle",
	sourceRevision: null,
	importedEventCount: 0,
	importedMemoIds: [],
	skippedMemoIds: [],
	diagnostics: [],
	cleanupCandidate: null,
};

const LEGACY_MIGRATION_EVENT_BATCH_SIZE = 128;
const LEGACY_MIGRATION_WORK_PRIORITY = 20;
export const LEGACY_MIGRATION_COMPLETION_META_KEY = "legacyMigrationCompletion";

interface LegacyMigrationCompletion {
	sourceId: string;
	sourceRevision: string;
	legacySystemRoot: string;
	importedMemoIds: string[];
}

export interface LegacyIndexMigrationServiceOptions {
	isTargetReady?: () => boolean;
	getCatalogCoverage: () => Promise<CatalogCoverage>;
	getObservationBatches: () => Promise<readonly CatalogFileRevisionBatch<MemoObservation>[]>;
	yieldControl?: () => Promise<void>;
	sliceBudgetMs?: number;
	now?: () => number;
	onReportChanged?: (report: LegacyIdentityImportReport) => void | Promise<void>;
	workQueue?: LowPriorityWorkRunner;
	completionStore?: Pick<MemoCatalogStore, "deleteMeta" | "getMeta" | "setMeta">;
}

export interface LegacyIndexMigrationRunOptions {
	sourceChanged?: boolean;
	verifyCompletion?: boolean;
}

export class LegacyIndexMigrationService {
	private report: LegacyIdentityImportReport = cloneReport(EMPTY_REPORT);
	private runQueue: Promise<LegacyIdentityImportReport> = Promise.resolve(cloneReport(EMPTY_REPORT));
	private onChanged: (() => void | Promise<void>) | null = null;
	private sourceChangeRevision = 0;
	private handledSourceChangeRevision = -1;
	private completedSourceId: string | null = null;
	private stopped = false;

	constructor(
		private readonly app: App,
		private readonly source: LegacyIndexSource,
		private readonly target: IdentityLedgerLegacyImportTarget,
		private readonly options: LegacyIndexMigrationServiceOptions,
	) {}

	start(owner: Component, onChanged: () => void | Promise<void>): void {
		this.onChanged = onChanged;
		const handle = (file: unknown, oldPath?: unknown) => {
			const paths = [readPath(file), typeof oldPath === "string" ? oldPath : null]
				.filter((path): path is string => path !== null);
			if (!paths.some((path) => this.source.isSourcePath(path))) return;
			void this.run({ sourceChanged: true }).then(() => this.onChanged?.()).catch(() => undefined);
		};
		owner.registerEvent(this.app.vault.on("create", handle));
		owner.registerEvent(this.app.vault.on("modify", handle));
		owner.registerEvent(this.app.vault.on("delete", handle));
		owner.registerEvent(this.app.vault.on("rename", handle));
		owner.register(() => {
			this.stopped = true;
			this.onChanged = null;
		});
	}

	getReport(): LegacyIdentityImportReport {
		return cloneReport(this.report);
	}

	run(options: LegacyIndexMigrationRunOptions = {}): Promise<LegacyIdentityImportReport> {
		if (options.sourceChanged === true) this.sourceChangeRevision += 1;
		this.runQueue = this.runQueue.then(
			() => this.runLowPriorityTask(() => this.runOnce(options.verifyCompletion === true)),
			() => this.runLowPriorityTask(() => this.runOnce(options.verifyCompletion === true)),
		);
		return this.runQueue.then(async (report) => {
			try {
				await this.options.onReportChanged?.(cloneReport(report));
			} catch {
				// 完成提示失败不能改变已经验证过的迁移结果。
			}
			return report;
		});
	}

	private runLowPriorityTask<T>(action: () => Promise<T>): Promise<T> {
		return this.options.workQueue?.run(LEGACY_MIGRATION_WORK_PRIORITY, action) ?? action();
	}

	private async runOnce(verifyCompletion: boolean): Promise<LegacyIdentityImportReport> {
		try {
			this.assertRunning();
			const runSourceChangeRevision = this.sourceChangeRevision;
			const presence = this.source.inspect();
			if (presence.kind === "missing") {
				await this.clearCompletion();
				this.completedSourceId = null;
				this.handledSourceChangeRevision = runSourceChangeRevision;
				return this.remember({ ...cloneReport(EMPTY_REPORT), status: "not_applicable" });
			}
			if (this.options.isTargetReady?.() === false) {
				return this.remember({ ...cloneReport(EMPTY_REPORT), status: "waiting_initialization" });
			}
			if (this.report.status === "ready"
				&& this.completedSourceId === presence.sourceId
				&& this.handledSourceChangeRevision === runSourceChangeRevision
				&& !verifyCompletion) {
				return this.remember({ ...cloneReport(this.report), importedEventCount: 0 });
			}
			const coverage = await this.options.getCatalogCoverage();
			this.assertRunning();
			if (coverage.kind !== "complete") {
				return this.remember({ ...cloneReport(EMPTY_REPORT), status: "waiting_catalog" });
			}
			const completion = await this.loadCompletion();
			this.assertRunning();
			if (!verifyCompletion
				&& runSourceChangeRevision === 0
				&& completion !== null
				&& completion.sourceId === presence.sourceId
				&& !hasIdentityConflict(this.target)) {
				this.completedSourceId = completion.sourceId;
				this.handledSourceChangeRevision = runSourceChangeRevision;
				return this.remember(completedReport(completion));
			}
			const source = await this.source.load();
			this.assertRunning();
			if (source.kind === "missing") {
				await this.clearCompletion();
				this.completedSourceId = null;
				this.handledSourceChangeRevision = runSourceChangeRevision;
				return this.remember({ ...cloneReport(EMPTY_REPORT), status: "not_applicable" });
			}
			if (source.kind === "attention") {
				await this.clearCompletion();
				return this.remember({
					...cloneReport(EMPTY_REPORT),
					status: "attention",
					diagnostics: source.diagnostics,
				});
			}
			if (this.report.status === "ready"
				&& this.report.sourceRevision === source.snapshot.sourceRevision
				&& this.completedSourceId === source.snapshot.sourceId
				&& source.snapshot.diagnostics.length === 0) {
				this.handledSourceChangeRevision = runSourceChangeRevision;
				const report = { ...cloneReport(this.report), importedEventCount: 0, cleanupCandidate: null };
				return verifyCompletion || this.report.cleanupCandidate === null
					? this.finalizeCleanupCandidate(source.snapshot, report, coverage)
					: this.remember({ ...report, cleanupCandidate: this.report.cleanupCandidate });
			}
			if (completion !== null
				&& completion.sourceId === source.snapshot.sourceId
				&& completion.sourceRevision === source.snapshot.sourceRevision
				&& source.snapshot.diagnostics.length === 0
				&& !hasIdentityConflict(this.target)) {
				this.completedSourceId = source.snapshot.sourceId;
				this.handledSourceChangeRevision = runSourceChangeRevision;
				return this.remember(completedReport(completion));
			}
			if (completion !== null) await this.clearCompletion();
			const observationBatches = await this.options.getObservationBatches();
			this.assertRunning();
			const lookup = await buildObservationLookup(observationBatches, this.createYieldController());
			const report = await this.importSnapshot(source.snapshot, lookup, coverage);
			this.assertRunning();
			if (report.status === "ready") {
				this.completedSourceId = source.snapshot.sourceId;
				this.handledSourceChangeRevision = runSourceChangeRevision;
			}
			return report;
		} catch (error) {
			if (this.isStopped()) throw new Error("Low-priority work queue is stopped.");
			return this.remember({
				...cloneReport(EMPTY_REPORT),
				status: "unavailable",
				diagnostics: [diagnostic("legacy_index_migration_failed", null, null, errorMessage(error))],
			});
		}
	}

	private async importSnapshot(
		source: LegacyIndexSnapshot,
		lookup: LegacyObservationLookup,
		coverage: CatalogCoverage,
	): Promise<LegacyIdentityImportReport> {
		this.assertRunning();
		const diagnostics = [...source.diagnostics];
		const writerId = await deterministicWriterId(source.sourceId);
		const initialSnapshot = this.target.getSnapshot();
		const importedMemoIds = new Set<string>();
		const skippedMemoIds = new Set<string>();
		const claims: IdentityLedgerEvent[] = [];
		const plans = new Map<string, LegacyMemoImportPlan>();
		const records: LegacyMemoRecord[] = [
			...source.memos,
			...source.pendingMemos,
		].sort((left, right) => left.memoId.localeCompare(right.memoId));
		const yieldController = this.createYieldController();

		for (let recordIndex = 0; recordIndex < records.length; recordIndex += 1) {
			if (recordIndex > 0 && yieldController.shouldYield()) await yieldController.yieldNow();
			const record = records[recordIndex];
			if (record === undefined) continue;
			const existing = initialSnapshot.memos[record.memoId];
			if (existing?.conflicted === true || (existing !== undefined && existing.bindings.length !== 1)) {
				skippedMemoIds.add(record.memoId);
				diagnostics.push(diagnostic("legacy_identity_conflict", null, record.memoId, "Identity Ledger does not contain one unique binding."));
				continue;
			}
			const expectedEvidence = await resolveLegacyObservationEvidence(record, lookup);
			if (expectedEvidence === null) {
				skippedMemoIds.add(record.memoId);
				diagnostics.push(diagnostic(
					"legacy_binding_unmatched",
					record.evidence.sourcePath,
					record.memoId,
					"Legacy identity does not uniquely match a current Daily observation.",
				));
				continue;
			}
			let binding = existing?.bindings[0] ?? null;
			if (binding !== null && !bindingMatchesEvidence(binding, expectedEvidence)) {
				skippedMemoIds.add(record.memoId);
				diagnostics.push(diagnostic(
					"legacy_binding_mismatch",
					record.evidence.sourcePath,
					record.memoId,
					"Existing Identity Ledger binding does not match the legacy Daily evidence.",
				));
				continue;
			}
			if (binding === null) {
				const eventId = await deterministicEventId("claim", source.sourceId, record.memoId, expectedEvidence);
				claims.push({
					eventId,
					writerId,
					memoId: record.memoId,
					type: "claim",
					baseBindingId: null,
					occurredAt: record.createdAt,
					evidence: { observation: expectedEvidence, createIntentEventId: null },
				});
				binding = {
					memoId: record.memoId,
					bindingId: eventId,
					identityRevision: "legacy-index-migration-pending",
					evidence: expectedEvidence,
				};
			}
			plans.set(record.memoId, { record, binding, expectedEvidence });
		}

		this.assertRunning();
		let importedEventCount = await this.target.importVerifiedLegacyEvents(claims, {
			cancellationSignal: this.options.workQueue?.signal,
			yieldControl: () => this.yieldControl(),
			sliceBudgetMs: this.options.sliceBudgetMs,
			now: this.options.now,
		});
		this.assertRunning();
		const claimedSnapshot = this.target.getSnapshot();
		const metadataEvents: IdentityLedgerEvent[] = [];
		const reviews = new Map(source.reviews.map((review) => [review.memoId, review] as const));
		for (const [memoId, plan] of plans) {
			const current = claimedSnapshot.memos[memoId];
			const binding = current?.conflicted === false && current.bindings.length === 1
				? current.bindings[0] ?? null
				: null;
			if (binding === null
				|| binding.bindingId !== plan.binding.bindingId
				|| !bindingMatchesEvidence(binding, plan.expectedEvidence)) {
				skippedMemoIds.add(memoId);
				diagnostics.push(diagnostic(
					"legacy_identity_conflict",
					plan.record.evidence.sourcePath,
					memoId,
					"Identity Ledger did not preserve the uniquely verified legacy binding.",
				));
				reviews.delete(memoId);
				if (yieldController.shouldYield()) await yieldController.yieldNow();
				continue;
			}
			metadataEvents.push(...await buildMetadataEvents(
				source,
				writerId,
				plan.record,
				binding,
				reviews.get(memoId) ?? null,
				yieldController,
			));
			importedMemoIds.add(memoId);
			reviews.delete(memoId);
			if (yieldController.shouldYield()) await yieldController.yieldNow();
		}
		for (const review of reviews.values()) {
			diagnostics.push(diagnostic("legacy_review_without_identity", null, review.memoId, "Legacy review state has no confirmed identity."));
			skippedMemoIds.add(review.memoId);
			if (yieldController.shouldYield()) await yieldController.yieldNow();
		}
		this.assertRunning();
		importedEventCount += await this.target.importVerifiedLegacyEvents(metadataEvents, {
			cancellationSignal: this.options.workQueue?.signal,
			yieldControl: () => this.yieldControl(),
			sliceBudgetMs: this.options.sliceBudgetMs,
			now: this.options.now,
		});
		this.assertRunning();
		const report = {
			status: diagnostics.length > 0 || skippedMemoIds.size > 0 ? "partial" : "ready",
			sourceRevision: source.sourceRevision,
			importedEventCount,
			importedMemoIds: [...importedMemoIds].sort(),
			skippedMemoIds: [...skippedMemoIds].sort(),
			diagnostics,
			cleanupCandidate: null,
		} satisfies LegacyIdentityImportReport;
		return this.finalizeCleanupCandidate(source, report, coverage);
	}

	private async finalizeCleanupCandidate(
		source: LegacyIndexSnapshot,
		report: LegacyIdentityImportReport,
		coverage: CatalogCoverage,
	): Promise<LegacyIdentityImportReport> {
		this.assertRunning();
		if (report.status !== "ready"
			|| source.sourceRevision.trim().length === 0
			|| !source.legacySystemRootPresent) {
			return this.remember(report);
		}
		if (coverage.kind !== "complete" || coverage.sharedConfigurationComplete === false) {
			return this.remember(report);
		}
		const expectedIdentityRevision = this.target.getSnapshot().revision;
		if (hasIdentityConflict(this.target)) {
			return this.remember(withAttention(report, diagnostic(
				"legacy_identity_verification_conflict",
				null,
				null,
				"Identity Ledger contains a conflict after the legacy import.",
			)));
		}
		const persisted = await this.target.verifyPersistedSnapshot(expectedIdentityRevision);
		this.assertRunning();
		if (!persisted || hasIdentityConflict(this.target)) {
			return this.remember(withAttention(report, diagnostic(
				"legacy_identity_persistence_unverified",
				null,
				null,
				"Identity Ledger could not be verified by reading the persisted data again.",
			)));
		}
		const confirmedSource = await this.source.load();
		this.assertRunning();
		if (confirmedSource.kind !== "ready"
			|| confirmedSource.snapshot.sourceId !== source.sourceId
			|| confirmedSource.snapshot.legacySystemRoot !== source.legacySystemRoot
			|| confirmedSource.snapshot.sourceRevision !== source.sourceRevision
			|| !confirmedSource.snapshot.legacySystemRootPresent
			|| confirmedSource.snapshot.diagnostics.length > 0) {
			return this.remember(withAttention(report, diagnostic(
				"legacy_source_changed_during_migration",
				source.legacySystemRoot,
				null,
				"Legacy source data changed while migration completion was being verified.",
			)));
		}
		const completed = {
			...report,
			cleanupCandidate: {
				legacySystemRoot: source.legacySystemRoot,
				sourceRevision: source.sourceRevision,
			},
		};
		await this.persistCompletion(source, completed);
		this.assertRunning();
		return this.remember(completed);
	}

	private async yieldControl(): Promise<void> {
		this.assertRunning();
		if (this.options.yieldControl !== undefined) {
			await this.options.yieldControl();
			this.assertRunning();
			return;
		}
		const appWindow = this.app.workspace?.containerEl?.win;
		if (appWindow !== undefined) await new Promise<void>((resolve) => appWindow.setTimeout(resolve, 0));
		this.assertRunning();
	}

	private createYieldController(): CooperativeYieldController {
		return new CooperativeYieldController({
			yieldControl: () => this.yieldControl(),
			sliceBudgetMs: this.options.sliceBudgetMs,
			maxOperationsPerSlice: LEGACY_MIGRATION_EVENT_BATCH_SIZE,
			now: this.options.now,
		});
	}

	private isStopped(): boolean {
		return this.stopped || this.options.workQueue?.signal.aborted === true;
	}

	private assertRunning(): void {
		if (this.isStopped()) throw new Error("Low-priority work queue is stopped.");
	}

	private async loadCompletion(): Promise<LegacyMigrationCompletion | null> {
		const value = await this.options.completionStore?.getMeta<unknown>(LEGACY_MIGRATION_COMPLETION_META_KEY) ?? null;
		return isLegacyMigrationCompletion(value) ? value : null;
	}

	private async persistCompletion(source: LegacyIndexSnapshot, report: LegacyIdentityImportReport): Promise<void> {
		this.assertRunning();
		await this.options.completionStore?.setMeta(LEGACY_MIGRATION_COMPLETION_META_KEY, {
			sourceId: source.sourceId,
			sourceRevision: source.sourceRevision,
			legacySystemRoot: source.legacySystemRoot,
			importedMemoIds: [...report.importedMemoIds],
		} satisfies LegacyMigrationCompletion);
	}

	private async clearCompletion(): Promise<void> {
		this.assertRunning();
		await this.options.completionStore?.deleteMeta(LEGACY_MIGRATION_COMPLETION_META_KEY);
	}

	private remember(report: LegacyIdentityImportReport): LegacyIdentityImportReport {
		this.report = cloneReport(report);
		return cloneReport(report);
	}
}

type LegacyMemoRecord = LegacyIndexMemo | LegacyPendingMemo;

interface LegacyMemoImportPlan {
	record: LegacyMemoRecord;
	binding: IdentityLedgerBinding;
	expectedEvidence: IdentityLedgerObservationEvidence;
}

interface LegacyObservationLookup {
	byRawBlock: ReadonlyMap<string, MemoObservation | null>;
	byTuple: ReadonlyMap<string, MemoObservation | null>;
}

async function buildMetadataEvents(
	source: LegacyIndexSnapshot,
	writerId: string,
	record: LegacyMemoRecord,
	binding: IdentityLedgerBinding,
	review: LegacyIndexSnapshot["reviews"][number] | null,
	yieldController: CooperativeYieldController,
): Promise<IdentityLedgerEvent[]> {
	const events: IdentityLedgerEvent[] = [];
	if (record.sourceMemoId !== null) {
		events.push({
			eventId: await deterministicEventId("relation", source.sourceId, record.memoId, binding.bindingId, record.sourceMemoId),
			writerId,
			memoId: record.memoId,
			type: "relation",
			baseBindingId: binding.bindingId,
			occurredAt: "updatedAt" in record ? record.updatedAt : record.createdAt,
			evidence: { sourceMemoId: record.sourceMemoId },
		});
	}
	if (review !== null) {
		const reviewedAt = review.lastReviewedAt ?? ("updatedAt" in record ? record.updatedAt : record.createdAt);
		for (let index = 0; index < review.reviewCount; index += 1) {
			events.push({
				eventId: await deterministicEventId("review", source.sourceId, record.memoId, binding.bindingId, index),
				writerId,
				memoId: record.memoId,
				type: "review",
				baseBindingId: binding.bindingId,
				occurredAt: reviewedAt,
				evidence: { reviewedAt },
			});
			if (yieldController.shouldYield()) await yieldController.yieldNow();
		}
	}
	if (isDeletedRecord(record)) {
		const payload = record.deletedPayload;
		const evidence: IdentityLedgerDeletePayloadEvent["evidence"] = {
			deletedAt: payload.deletedAt,
			sourcePath: payload.sourcePath,
			deletedSourceRevision: null,
			logicalDate: payload.logicalDate,
			section: payload.section,
			rawBlock: payload.rawBlock,
			contentHash: payload.contentHash,
			sourceMemoId: payload.sourceMemoId,
		};
		const deleteEventId = await deterministicEventId("delete", source.sourceId, record.memoId, binding.bindingId, evidence);
		events.push({
			eventId: deleteEventId,
			writerId,
			memoId: record.memoId,
			type: "delete_payload",
			baseBindingId: binding.bindingId,
			occurredAt: payload.deletedAt,
			evidence,
		});
		events.push({
			eventId: await deterministicEventId("delete-commit", source.sourceId, deleteEventId),
			writerId,
			memoId: record.memoId,
			type: "delete_commit",
			baseBindingId: binding.bindingId,
			occurredAt: payload.deletedAt,
			evidence: { deleteEventId },
		});
	}
	return events;
}

function resolveObservation(
	evidence: LegacyIndexEvidence,
	lookup: LegacyObservationLookup,
): MemoObservation | null {
	const rawKey = buildRawBlockLookupKey(evidence.sourcePath, evidence.lastKnownBlockHash);
	const rawMatch = lookup.byRawBlock.get(rawKey);
	if (rawMatch !== undefined && rawMatch !== null) return rawMatch;
	return lookup.byTuple.get(buildTupleLookupKey(
		evidence.sourcePath,
		evidence.logicalDate,
		evidence.section,
		evidence.time,
		evidence.contentHash,
	)) ?? null;
}

async function resolveLegacyObservationEvidence(
	record: LegacyMemoRecord,
	lookup: LegacyObservationLookup,
): Promise<IdentityLedgerObservationEvidence | null> {
	if (isDeletedRecord(record)) return deletedObservationEvidence(record);
	const observation = resolveObservation(record.evidence, lookup);
	return observation === null ? null : toObservationEvidence(observation);
}

async function buildObservationLookup(
	batches: readonly CatalogFileRevisionBatch<MemoObservation>[],
	yieldController: CooperativeYieldController,
): Promise<LegacyObservationLookup> {
	const byRawBlock = new Map<string, MemoObservation | null>();
	const byTuple = new Map<string, MemoObservation | null>();
	for (const batch of batches) {
		for (const observation of batch.observations) {
			addUniqueObservation(
				byRawBlock,
				buildRawBlockLookupKey(observation.sourcePath, observation.rawBlockHash),
				observation,
			);
			addUniqueObservation(
				byTuple,
				buildTupleLookupKey(
					observation.sourcePath,
					observation.logicalDate,
					observation.section,
					observation.time,
					observation.contentHash,
				),
				observation,
			);
			if (yieldController.shouldYield()) await yieldController.yieldNow();
		}
	}
	return { byRawBlock, byTuple };
}

function addUniqueObservation(
	lookup: Map<string, MemoObservation | null>,
	key: string,
	observation: MemoObservation,
): void {
	lookup.set(key, lookup.has(key) ? null : observation);
}

function buildRawBlockLookupKey(sourcePath: string, rawBlockHash: string): string {
	return JSON.stringify([sourcePath, rawBlockHash]);
}

function buildTupleLookupKey(
	sourcePath: string,
	logicalDate: string,
	section: string | null,
	time: string,
	contentHash: string,
): string {
	return JSON.stringify([sourcePath, logicalDate, section, time, contentHash]);
}

function bindingMatchesEvidence(
	binding: IdentityLedgerBinding,
	evidence: IdentityLedgerObservationEvidence,
): boolean {
	return binding.evidence.sourcePath === evidence.sourcePath
		&& binding.evidence.rawBlockHash === evidence.rawBlockHash
		&& binding.evidence.logicalDate === evidence.logicalDate
		&& binding.evidence.section === evidence.section
		&& binding.evidence.time === evidence.time
		&& binding.evidence.contentHash === evidence.contentHash;
}

async function deletedObservationEvidence(record: LegacyIndexMemo): Promise<IdentityLedgerObservationEvidence | null> {
	if (record.deletedPayload === null) return null;
	const rawBlock = normalizeNewlines(record.deletedPayload.rawBlock);
	const startLine = Math.max(0, (record.evidence.lineNumberHint ?? 1) - 1);
	return {
		sourcePath: record.deletedPayload.sourcePath,
		sourceRevision: await sha256IdentityLedgerText(rawBlock),
		rawBlockHash: hashText(rawBlock),
		logicalDate: record.deletedPayload.logicalDate,
		section: record.deletedPayload.section,
		startLine,
		endLine: startLine + Math.max(0, rawBlock.split("\n").length - 1),
		time: record.evidence.time,
		contentHash: record.deletedPayload.contentHash,
	};
}

function toObservationEvidence(observation: MemoObservation): IdentityLedgerObservationEvidence {
	return {
		sourcePath: observation.sourcePath,
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

function isDeletedRecord(record: LegacyMemoRecord): record is LegacyIndexMemo & { deletedPayload: NonNullable<LegacyIndexMemo["deletedPayload"]> } {
	return "status" in record && record.status === "deleted" && record.deletedPayload !== null;
}

async function deterministicWriterId(sourceId: string): Promise<string> {
	return `w_${(await sha256IdentityLedgerText(`legacy-index-writer\u0000${sourceId}`)).slice(0, 32)}`;
}

async function deterministicEventId(domain: string, ...parts: unknown[]): Promise<string> {
	return `e_${(await sha256IdentityLedgerText(canonicalIdentityLedgerJson({ domain, parts }))).slice(0, 32)}`;
}

function readPath(file: unknown): string | null {
	return file instanceof TFile || file instanceof TFolder ? file.path : null;
}

function diagnostic(code: string, sourcePath: string | null, memoId: string | null, detail: string): LegacyIndexDiagnostic {
	return { code, sourcePath, memoId, detail };
}

function cloneReport(report: LegacyIdentityImportReport): LegacyIdentityImportReport {
	return {
		...report,
		importedMemoIds: [...report.importedMemoIds],
		skippedMemoIds: [...report.skippedMemoIds],
		diagnostics: report.diagnostics.map((item) => ({ ...item })),
		cleanupCandidate: report.cleanupCandidate === null ? null : { ...report.cleanupCandidate },
	};
}

function completedReport(completion: LegacyMigrationCompletion): LegacyIdentityImportReport {
	return {
		status: "ready",
		sourceRevision: completion.sourceRevision,
		importedEventCount: 0,
		importedMemoIds: [...completion.importedMemoIds],
		skippedMemoIds: [],
		diagnostics: [],
		cleanupCandidate: {
			legacySystemRoot: completion.legacySystemRoot,
			sourceRevision: completion.sourceRevision,
		},
	};
}

function isLegacyMigrationCompletion(value: unknown): value is LegacyMigrationCompletion {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return Object.keys(record).length === 4
		&& typeof record.sourceId === "string"
		&& record.sourceId.trim().length > 0
		&& typeof record.sourceRevision === "string"
		&& /^[0-9a-f]{64}$/u.test(record.sourceRevision)
		&& typeof record.legacySystemRoot === "string"
		&& record.legacySystemRoot.trim().length > 0
		&& Array.isArray(record.importedMemoIds)
		&& record.importedMemoIds.every((memoId) => typeof memoId === "string" && memoId.length > 0);
}

function hasIdentityConflict(target: IdentityLedgerLegacyImportTarget): boolean {
	const snapshot = target.getSnapshot();
	return target.getStatus() !== "ready"
		|| snapshot.quarantinedEventIds.length > 0
		|| Object.values(snapshot.memos).some((memo) => memo.conflicted);
}

function withAttention(
	report: LegacyIdentityImportReport,
	detail: LegacyIndexDiagnostic,
): LegacyIdentityImportReport {
	return {
		...report,
		status: "attention",
		diagnostics: [...report.diagnostics, detail],
		cleanupCandidate: null,
	};
}

function normalizeNewlines(value: string): string {
	return value.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n");
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

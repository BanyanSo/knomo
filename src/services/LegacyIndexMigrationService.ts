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

const EMPTY_REPORT: LegacyIdentityImportReport = {
	status: "idle",
	sourceRevision: null,
	importedEventCount: 0,
	importedMemoIds: [],
	skippedMemoIds: [],
	diagnostics: [],
	cleanupCandidate: null,
};

export interface LegacyIndexMigrationServiceOptions {
	getCatalogCoverage: () => Promise<CatalogCoverage>;
	getObservationBatches: () => Promise<readonly CatalogFileRevisionBatch<MemoObservation>[]>;
	onReportChanged?: (report: LegacyIdentityImportReport) => void | Promise<void>;
}

export class LegacyIndexMigrationService {
	private report: LegacyIdentityImportReport = cloneReport(EMPTY_REPORT);
	private runQueue: Promise<LegacyIdentityImportReport> = Promise.resolve(cloneReport(EMPTY_REPORT));
	private onChanged: (() => void | Promise<void>) | null = null;

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
			void this.run().then(() => this.onChanged?.()).catch(() => undefined);
		};
		owner.registerEvent(this.app.vault.on("create", handle));
		owner.registerEvent(this.app.vault.on("modify", handle));
		owner.registerEvent(this.app.vault.on("delete", handle));
		owner.registerEvent(this.app.vault.on("rename", handle));
		owner.register(() => {
			this.onChanged = null;
		});
	}

	getReport(): LegacyIdentityImportReport {
		return cloneReport(this.report);
	}

	run(): Promise<LegacyIdentityImportReport> {
		this.runQueue = this.runQueue.then(() => this.runOnce(), () => this.runOnce());
		return this.runQueue.then(async (report) => {
			try {
				await this.options.onReportChanged?.(cloneReport(report));
			} catch {
				// 完成提示失败不能改变已经验证过的迁移结果。
			}
			return report;
		});
	}

	private async runOnce(): Promise<LegacyIdentityImportReport> {
		try {
			const source = await this.source.load();
			if (source.kind === "missing") return this.remember({ ...cloneReport(EMPTY_REPORT), status: "missing" });
			if (source.kind === "attention") {
				return this.remember({
					...cloneReport(EMPTY_REPORT),
					status: "attention",
					diagnostics: source.diagnostics,
				});
			}
			return this.importSnapshot(source.snapshot, await this.options.getObservationBatches());
		} catch (error) {
			return this.remember({
				...cloneReport(EMPTY_REPORT),
				status: "unavailable",
				diagnostics: [diagnostic("legacy_index_migration_failed", null, null, errorMessage(error))],
			});
		}
	}

	private async importSnapshot(
		source: LegacyIndexSnapshot,
		batches: readonly CatalogFileRevisionBatch<MemoObservation>[],
	): Promise<LegacyIdentityImportReport> {
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

		for (const record of records) {
			const existing = initialSnapshot.memos[record.memoId];
			if (existing?.conflicted === true || (existing !== undefined && existing.bindings.length !== 1)) {
				skippedMemoIds.add(record.memoId);
				diagnostics.push(diagnostic("legacy_identity_conflict", null, record.memoId, "Identity Ledger does not contain one unique binding."));
				continue;
			}
			const expectedEvidence = await resolveLegacyObservationEvidence(record, batches);
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

		let importedEventCount = await this.target.importVerifiedLegacyEvents(claims);
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
				continue;
			}
			metadataEvents.push(...await buildMetadataEvents(source, writerId, plan.record, binding, reviews.get(memoId) ?? null));
			importedMemoIds.add(memoId);
			reviews.delete(memoId);
		}
		for (const review of reviews.values()) {
			diagnostics.push(diagnostic("legacy_review_without_identity", null, review.memoId, "Legacy review state has no confirmed identity."));
			skippedMemoIds.add(review.memoId);
		}
		importedEventCount += await this.target.importVerifiedLegacyEvents(metadataEvents);
		const report = {
			status: diagnostics.length > 0 || skippedMemoIds.size > 0 ? "partial" : "ready",
			sourceRevision: source.sourceRevision,
			importedEventCount,
			importedMemoIds: [...importedMemoIds].sort(),
			skippedMemoIds: [...skippedMemoIds].sort(),
			diagnostics,
			cleanupCandidate: null,
		} satisfies LegacyIdentityImportReport;
		if (report.status !== "ready"
			|| source.sourceRevision.trim().length === 0
			|| !source.legacySystemRootPresent) {
			return this.remember(report);
		}
		const coverage = await this.options.getCatalogCoverage();
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
		if (!await this.target.verifyPersistedSnapshot(expectedIdentityRevision) || hasIdentityConflict(this.target)) {
			return this.remember(withAttention(report, diagnostic(
				"legacy_identity_persistence_unverified",
				null,
				null,
				"Identity Ledger could not be verified by reading the persisted data again.",
			)));
		}
		const confirmedSource = await this.source.load();
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
		return this.remember({
			...report,
			cleanupCandidate: {
				legacySystemRoot: source.legacySystemRoot,
				sourceRevision: source.sourceRevision,
			},
		});
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

async function buildMetadataEvents(
	source: LegacyIndexSnapshot,
	writerId: string,
	record: LegacyMemoRecord,
	binding: IdentityLedgerBinding,
	review: LegacyIndexSnapshot["reviews"][number] | null,
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
	batches: readonly CatalogFileRevisionBatch<MemoObservation>[],
): MemoObservation | null {
	const pathCandidates = batches.flatMap((batch) => batch.observations)
		.filter((observation) => observation.sourcePath === evidence.sourcePath);
	const rawBlockMatches = pathCandidates.filter((observation) => observation.rawBlockHash === evidence.lastKnownBlockHash);
	if (rawBlockMatches.length === 1) return rawBlockMatches[0] ?? null;
	if (rawBlockMatches.length > 1) return null;
	const tupleMatches = pathCandidates.filter((observation) => observation.logicalDate === evidence.logicalDate
		&& observation.section === evidence.section
		&& observation.time === evidence.time
		&& observation.contentHash === evidence.contentHash);
	return tupleMatches.length === 1 ? tupleMatches[0] ?? null : null;
}

async function resolveLegacyObservationEvidence(
	record: LegacyMemoRecord,
	batches: readonly CatalogFileRevisionBatch<MemoObservation>[],
): Promise<IdentityLedgerObservationEvidence | null> {
	if (isDeletedRecord(record)) return deletedObservationEvidence(record);
	const observation = resolveObservation(record.evidence, batches);
	return observation === null ? null : toObservationEvidence(observation);
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

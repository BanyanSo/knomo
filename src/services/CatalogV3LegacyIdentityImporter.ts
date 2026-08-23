import { normalizePath, TFile, TFolder } from "obsidian";
import type { App, Component } from "obsidian";

import type { CatalogFileRevisionBatch, MemoObservation, ResolvedMemo } from "../types/catalog";
import type { CatalogV2MaterializedMemo, DeletedMemoPayload, StateOperation } from "../types/catalogV2";
import type {
	IdentityLedgerBinding,
	IdentityLedgerDeletePayloadEvent,
	IdentityLedgerEvent,
	IdentityLedgerLegacyImportTarget,
	IdentityLedgerObservationEvidence,
} from "../types/identityLedger";
import type {
	LegacyIdentityImportDiagnostic,
	LegacyIdentityImportReport,
	LegacyIdentitySource,
	VerifiedLegacyIdentitySnapshot,
} from "../types/legacyIdentityImport";
import { hashText } from "../utils/hash";
import { canonicalIdentityLedgerJson, sha256IdentityLedgerText } from "./IdentityLedgerProtocol";
import { CatalogV2IdentityResolver } from "./CatalogV2IdentityResolver";

const EMPTY_REPORT: LegacyIdentityImportReport = {
	status: "idle",
	sourceRevision: null,
	importedEventCount: 0,
	importedMemoIds: [],
	skippedMemoIds: [],
	diagnostics: [],
};

export interface CatalogV3LegacyIdentityImporterOptions {
	getObservationBatches: () => Promise<readonly CatalogFileRevisionBatch<MemoObservation>[]>;
}

export class CatalogV3LegacyIdentityImporter {
	private report: LegacyIdentityImportReport = cloneReport(EMPTY_REPORT);
	private runQueue: Promise<LegacyIdentityImportReport> = Promise.resolve(cloneReport(EMPTY_REPORT));
	private onChanged: (() => void | Promise<void>) | null = null;

	constructor(
		private readonly app: App,
		private readonly source: LegacyIdentitySource,
		private readonly target: IdentityLedgerLegacyImportTarget,
		private readonly options: CatalogV3LegacyIdentityImporterOptions,
	) {}

	start(owner: Component, onChanged: () => void | Promise<void>): void {
		this.onChanged = onChanged;
		const handle = (file: unknown, oldPath?: unknown) => {
			const paths = [readPath(file), typeof oldPath === "string" ? oldPath : null].filter((path): path is string => path !== null);
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
		return this.runQueue;
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
				diagnostics: [diagnostic("legacy_import_failed", null, null, errorMessage(error))],
			});
		}
	}

	private async importSnapshot(
		source: VerifiedLegacyIdentitySnapshot,
		batches: readonly CatalogFileRevisionBatch<MemoObservation>[],
	): Promise<LegacyIdentityImportReport> {
		const diagnostics = [...source.diagnostics];
		if (source.state.awaitingWriterIds.length > 0 || source.state.forkedWriterIds.length > 0) {
			return this.remember({
				...cloneReport(EMPTY_REPORT),
				status: "attention",
				sourceRevision: source.sourceRevision,
				diagnostics: [
					...diagnostics,
					diagnostic("legacy_writer_state_incomplete", null, null, [
						...source.state.awaitingWriterIds,
						...source.state.forkedWriterIds,
					].join(",")),
				],
			});
		}
		const observationMatches = resolveLegacyObservations(source, batches);
		const writerId = await deterministicWriterId(source.sourceId);
		const claims: IdentityLedgerEvent[] = [];
		const importedMemoIds = new Set<string>();
		const skippedMemoIds = new Set<string>();
		const plans = new Map<string, LegacyMemoImportPlan>();
		for (const memo of Object.values(source.state.memos).sort((left, right) => left.memoId.localeCompare(right.memoId))) {
			const existing = this.target.getSnapshot().memos[memo.memoId];
			if (!isSupportedMemoId(memo.memoId)) {
				skippedMemoIds.add(memo.memoId);
				diagnostics.push(diagnostic("legacy_memo_id_unsupported", null, memo.memoId, "The legacy memoId does not match a frozen V3 format."));
				continue;
			}
			if (existing?.conflicted === true || memo.activeBindingHeads.length !== 1 || hasMemoAttention(source, memo)) {
				skippedMemoIds.add(memo.memoId);
				diagnostics.push(diagnostic("legacy_identity_conflict", null, memo.memoId, "The legacy identity binding is not uniquely confirmed."));
				continue;
			}
			const activeDelete = getActiveDelete(memo);
			const payload = activeDelete === null ? null : source.deletedPayloads[activeDelete.deleteOpId] ?? null;
			if (activeDelete !== null && payload === null) {
				diagnostics.push(diagnostic("legacy_delete_payload_missing", activeDelete.payload.path, memo.memoId, "The recoverable-delete payload is missing or failed digest verification."));
			}
			const observation = observationMatches.get(memo.memoId) ?? null;
			let binding = existing?.bindings.length === 1 ? existing.bindings[0] ?? null : null;
			let claimEvent: IdentityLedgerEvent | null = null;
			if (binding === null) {
				const evidence = observation !== null
					? toObservationEvidence(observation)
					: payload !== null ? await deletedPayloadEvidence(memo, payload) : null;
				if (evidence === null) {
					skippedMemoIds.add(memo.memoId);
					diagnostics.push(diagnostic("legacy_binding_unmatched", null, memo.memoId, "The legacy binding cannot be matched to one current Daily observation."));
					continue;
				}
				const eventId = await deterministicEventId("claim", source.sourceId, memo.memoId, evidence);
				claimEvent = {
					schemaVersion: 1,
					eventId,
					writerId,
					memoId: memo.memoId,
					type: "claim",
					baseBindingId: null,
					occurredAt: findIdentityOccurredAt(source.operations, memo.memoId) ?? payload?.deletedAt ?? "1970-01-01T00:00:00.000Z",
					evidence: { observation: evidence, createIntentEventId: null },
				};
				claims.push(claimEvent);
				binding = {
					memoId: memo.memoId,
					bindingId: eventId,
					identityRevision: "legacy-import-pending",
					evidence,
				};
			}
			plans.set(memo.memoId, { memo, binding, payload, activeDelete });
			importedMemoIds.add(memo.memoId);
		}

		let importedEventCount = await this.target.importVerifiedLegacyEvents(claims);
		const metadataEvents: IdentityLedgerEvent[] = [];
		for (const [memoId, plan] of plans) {
			const current = this.target.getSnapshot().memos[memoId];
			const binding = current?.bindings.length === 1 ? current.bindings[0] ?? plan.binding : plan.binding;
			metadataEvents.push(...await buildMetadataEvents(source, writerId, plan, binding, diagnostics));
		}
		importedEventCount += await this.target.importVerifiedLegacyEvents(metadataEvents);
		return this.remember({
			status: diagnostics.length > 0 || skippedMemoIds.size > 0 ? "partial" : "ready",
			sourceRevision: source.sourceRevision,
			importedEventCount,
			importedMemoIds: [...importedMemoIds].sort(),
			skippedMemoIds: [...skippedMemoIds].sort(),
			diagnostics,
		});
	}

	private remember(report: LegacyIdentityImportReport): LegacyIdentityImportReport {
		this.report = cloneReport(report);
		return cloneReport(report);
	}
}

interface LegacyMemoImportPlan {
	memo: CatalogV2MaterializedMemo;
	binding: IdentityLedgerBinding;
	payload: DeletedMemoPayload | null;
	activeDelete: CatalogV2MaterializedMemo["deleteVersions"][number] | null;
}

async function buildMetadataEvents(
	source: VerifiedLegacyIdentitySnapshot,
	writerId: string,
	plan: LegacyMemoImportPlan,
	binding: IdentityLedgerBinding,
	diagnostics: LegacyIdentityImportDiagnostic[],
): Promise<IdentityLedgerEvent[]> {
	const events: IdentityLedgerEvent[] = [];
	if (plan.memo.sourceMemoIds.length === 1) {
		const sourceMemoId = plan.memo.sourceMemoIds[0] as string;
		if (isSupportedMemoId(sourceMemoId)) {
			events.push({
				schemaVersion: 1,
				eventId: await deterministicEventId("relation", source.sourceId, plan.memo.memoId, binding.bindingId, sourceMemoId),
				writerId,
				memoId: plan.memo.memoId,
				type: "relation",
				baseBindingId: binding.bindingId,
				occurredAt: findRelationOccurredAt(source.operations, plan.memo.memoId) ?? "1970-01-01T00:00:00.000Z",
				evidence: { sourceMemoId },
			});
		} else {
			diagnostics.push(diagnostic("legacy_relation_target_unsupported", null, plan.memo.memoId, sourceMemoId));
		}
	}
	const reviews = legacyReviews(source.operations, plan.memo);
	for (const [index, review] of reviews.entries()) {
		events.push({
			schemaVersion: 1,
			eventId: await deterministicEventId("review", source.sourceId, plan.memo.memoId, binding.bindingId, review.key, index),
			writerId,
			memoId: plan.memo.memoId,
			type: "review",
			baseBindingId: binding.bindingId,
			occurredAt: review.reviewedAt,
			evidence: { reviewedAt: review.reviewedAt },
		});
	}
	if (plan.activeDelete !== null && plan.payload !== null) {
		const evidence: IdentityLedgerDeletePayloadEvent["evidence"] = {
			deletedAt: plan.payload.deletedAt,
			sourcePath: normalizePath(plan.payload.sourcePath),
			logicalDate: plan.payload.logicalDate,
			section: plan.payload.section,
			rawBlock: plan.payload.rawBlock,
			contentHash: plan.payload.contentHash,
			sourceMemoId: isSupportedMemoId(plan.payload.sourceMemoId) ? plan.payload.sourceMemoId : null,
		};
		events.push({
			schemaVersion: 1,
			eventId: await deterministicEventId("delete", source.sourceId, plan.memo.memoId, binding.bindingId, plan.activeDelete.deleteOpId, evidence),
			writerId,
			memoId: plan.memo.memoId,
			type: "delete_payload",
			baseBindingId: binding.bindingId,
			occurredAt: plan.payload.deletedAt,
			evidence,
		});
	}
	return events;
}

function resolveLegacyObservations(
	source: VerifiedLegacyIdentitySnapshot,
	batches: readonly CatalogFileRevisionBatch<MemoObservation>[],
): Map<string, MemoObservation> {
	const resolver = new CatalogV2IdentityResolver();
	const resolved = resolver.resolveVault({
		batches,
		state: source.state,
		stateRevision: `legacy:${source.sourceRevision}`,
		localIntents: [],
		settlement: {
			stateComplete: true,
			migrationComplete: true,
			revisionStable: true,
			historical: false,
		},
	});
	const candidates = new Map<string, MemoObservation[]>();
	for (const memo of resolved.values()) {
		const memoId = resolvedMemoId(memo);
		if (memoId === null) continue;
		const values = candidates.get(memoId) ?? [];
		values.push(memo.observation);
		candidates.set(memoId, values);
	}
	return new Map([...candidates.entries()].flatMap(([memoId, observations]) =>
		observations.length === 1 ? [[memoId, observations[0] as MemoObservation] as const] : []));
}

function resolvedMemoId(memo: ResolvedMemo): string | null {
	if (memo.kind === "identified") return memo.identityHandle.memoId;
	if (memo.kind !== "ambiguous" || memo.candidates.length !== 1) return null;
	const candidate = memo.candidates[0];
	return candidate?.source === "migration" || candidate?.source === "existing_block_id"
		? candidate.memoId
		: null;
}

function getActiveDelete(memo: CatalogV2MaterializedMemo): CatalogV2MaterializedMemo["deleteVersions"][number] | null {
	const values = memo.deleteVersions.filter((item) =>
		!memo.restoredDeleteOperationIds.includes(item.deleteOpId)
		&& !memo.purgedDeleteOperationIds.includes(item.deleteOpId));
	return values.length === 1 ? values[0] ?? null : null;
}

function hasMemoAttention(source: VerifiedLegacyIdentitySnapshot, memo: CatalogV2MaterializedMemo): boolean {
	return source.state.quarantine.some((item) => item.key === memo.memoId
		|| item.digests.some((digest) => memo.identityOperationIds.includes(digest)
			|| memo.deleteOperationIds.includes(digest)
			|| memo.reviewOperationIds.includes(digest)));
}

async function deletedPayloadEvidence(
	memo: CatalogV2MaterializedMemo,
	payload: DeletedMemoPayload,
): Promise<IdentityLedgerObservationEvidence> {
	const binding = memo.activeBindingHeads[0];
	const stateEvidence = binding !== undefined && "sourceRevision" in binding.evidence ? binding.evidence : null;
	const firstLine = payload.rawBlock.split(/\r?\n/u)[0] ?? "";
	const time = /^- ((?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?)/u.exec(firstLine)?.[1]
		?? binding?.evidence.time
		?? "00:00";
	return {
		sourcePath: normalizePath(payload.sourcePath),
		sourceRevision: stateEvidence?.sourceRevision ?? await sha256IdentityLedgerText(payload.rawBlock),
		rawBlockHash: hashText(payload.rawBlock.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n")),
		logicalDate: payload.logicalDate,
		section: payload.section,
		startLine: stateEvidence?.startLine ?? 0,
		endLine: stateEvidence?.endLine ?? Math.max(0, payload.rawBlock.split(/\r?\n/u).length - 1),
		time,
		contentHash: payload.contentHash,
	};
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

function legacyReviews(
	operations: readonly StateOperation[],
	memo: CatalogV2MaterializedMemo,
): Array<{ key: string; reviewedAt: string }> {
	const operationReviews = operations.flatMap((operation) => operation.memoId === memo.memoId && operation.type === "review.record"
		? [{ key: operation.opId, reviewedAt: operation.payload.reviewedAt }]
		: []);
	if (operationReviews.length > 0) return operationReviews.sort((left, right) => left.key.localeCompare(right.key));
	const reviewedAt = memo.lastReviewedAt ?? "1970-01-01T00:00:00.000Z";
	return memo.reviewOperationIds.map((key) => ({ key, reviewedAt }));
}

function findIdentityOccurredAt(operations: readonly StateOperation[], memoId: string): string | null {
	return operations.find((operation) => operation.memoId === memoId
		&& (operation.type === "identity.claim" || operation.type === "identity.rebind"))?.occurredAt ?? null;
}

function findRelationOccurredAt(operations: readonly StateOperation[], memoId: string): string | null {
	return operations.find((operation) => operation.memoId === memoId && operation.type === "relation.set_source")?.occurredAt ?? null;
}

async function deterministicWriterId(sourceId: string): Promise<string> {
	return `w_${(await sha256IdentityLedgerText(`legacy-writer\u0000${sourceId}`)).slice(0, 32)}`;
}

async function deterministicEventId(domain: string, ...parts: unknown[]): Promise<string> {
	return `e_${(await sha256IdentityLedgerText(canonicalIdentityLedgerJson({ domain, parts }))).slice(0, 32)}`;
}

function isSupportedMemoId(value: string | null): value is string {
	return typeof value === "string" && /^(?:[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}|m_[a-f0-9]{32})$/u.test(value);
}

function readPath(file: unknown): string | null {
	return file instanceof TFile || file instanceof TFolder ? file.path : null;
}

function diagnostic(code: string, sourcePath: string | null, memoId: string | null, detail: string): LegacyIdentityImportDiagnostic {
	return { code, sourcePath, memoId, detail };
}

function cloneReport(report: LegacyIdentityImportReport): LegacyIdentityImportReport {
	return {
		...report,
		importedMemoIds: [...report.importedMemoIds],
		skippedMemoIds: [...report.skippedMemoIds],
		diagnostics: report.diagnostics.map((item) => ({ ...item })),
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

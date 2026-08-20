import type {
	CatalogCoverage,
	CatalogObservation,
	CatalogStoreLifecycle,
	CatalogV2ResolutionSnapshot,
	ResolvedMemo,
} from "../types/catalog";
import type {
	CatalogV2InstallMode,
	CatalogV2MaterializedState,
	IdentityEvidence,
} from "../types/catalogV2";
import type {
	CatalogV2SharedMutationInspection,
	CatalogV2VerifiedVaultContext,
} from "../types/catalogV2Protocol";
import type {
	CatalogV2DeletedMemoItem,
	CatalogV2DeletedMemoPage,
	CatalogV2FeatureQuery,
	CatalogV2MemoItem,
	CatalogV2MemoPage,
	CatalogV2ReadState,
	CatalogV2CoverageCapabilities,
} from "../types/catalogV2View";
import type { MemoViewItem } from "../types/memoView";
import { toCatalogV2MemoView } from "../types/memoView";
import type { MemoReviewStateMap } from "../types/review";
import { formatDatePart } from "../utils/date";
import {
	CatalogV2IdentityResolver,
	type CatalogV2IdentitySettlement,
	type CatalogV2LocalIdentityIntent,
} from "./CatalogV2IdentityResolver";
import type { CatalogV2DeletedPayloadStore } from "./CatalogV2DeletedPayloadStore";
import { canonicalJson, sha256Text } from "./CatalogV2Protocol";
import { deriveObservationMemoId } from "./CatalogV2SharedMutationStore";
import type { CatalogV2StateShadowCoordinator } from "./CatalogV2StateShadowCoordinator";
import type { IndexedDbCatalogV2StateStore } from "./IndexedDbCatalogV2StateStore";
import type { IndexedDbCatalogV2TransactionStore } from "./IndexedDbCatalogV2TransactionStore";
import type { MemoCatalogService } from "./MemoCatalogService";
import { RecordStatsBuilder, type PreparedRecordStats } from "./RecordStatsService";
import type { TimeBuoyAllQueryResult, TimeBuoyQueryResult } from "../types/timeBuoy";
import { getRandomReunionMemos } from "../utils/randomReunion";

export interface CatalogV2ReadServiceOptions {
	catalog: MemoCatalogService;
	stateStore: IndexedDbCatalogV2StateStore | null;
	stateCoordinator: CatalogV2StateShadowCoordinator | null;
	transactionStore: IndexedDbCatalogV2TransactionStore | null;
	deletedPayloadStore: CatalogV2DeletedPayloadStore | null;
	installMode: CatalogV2InstallMode;
	getInstallMode?: () => CatalogV2InstallMode;
	getVaultContext?: () => CatalogV2VerifiedVaultContext | null | Promise<CatalogV2VerifiedVaultContext | null>;
	inspectSharedMutations?: () => Promise<CatalogV2SharedMutationInspection>;
	now?: () => Date;
	random?: () => number;
}

// 只读服务只解析 Vault 派生状态和本机快照，不持有 mutation 或 Vault 写入口。
export class CatalogV2ReadService {
	private readonly resolver = new CatalogV2IdentityResolver();
	private readonly now: () => Date;
	private readonly random: () => number;
	private lastReadState: CatalogV2ReadState | null = null;

	constructor(private readonly options: CatalogV2ReadServiceOptions) {
		this.now = options.now ?? (() => new Date());
		this.random = options.random ?? Math.random;
	}

	getLastReadState(): CatalogV2ReadState | null {
		return this.lastReadState;
	}

	async prime(): Promise<void> {
		await this.materializeResolutionSnapshot();
		await this.query({ limit: 1 });
	}

	async query(request: CatalogV2FeatureQuery): Promise<CatalogV2MemoPage> {
		const page = await this.options.catalog.query({ ...request, cursor: request.cursor?.catalog ?? null });
		if (page.invalidated) return this.rememberPage({
			items: [],
			nextCursor: null,
			coverage: page.coverage,
			lifecycle: page.lifecycle,
			capabilities: buildCoverageCapabilities(page.coverage),
			readState: this.getReadState(page.coverage, page.lifecycle, null),
			degraded: true,
			invalidated: true,
		});
		const snapshot = await this.options.catalog.loadResolutionSnapshot().catch(() => null);
		const stateInput = await this.loadStateSnapshot(false);
		const snapshotCurrent = snapshot !== null && snapshot.catalogRevision === page.catalogRevision
			&& stateInput !== null && snapshot.stateRevision === stateInput.snapshot.revision;
		if (request.cursor !== undefined && request.cursor !== null
			&& request.cursor.stateRevision !== (snapshotCurrent ? snapshot.stateRevision : "state-unavailable")) {
			return this.rememberPage({
				items: [],
				nextCursor: null,
				coverage: page.coverage,
				lifecycle: page.lifecycle,
				capabilities: buildCoverageCapabilities(page.coverage),
				readState: this.getReadState(page.coverage, page.lifecycle, stateInput?.settlement ?? null),
				degraded: true,
				invalidated: true,
			});
		}
		const state = stateInput?.snapshot.state ?? createUnavailableState();
		const resolved = page.items.map((observation) => snapshotCurrent
			? snapshot.results[observation.observationKey] ?? createUnresolvedMemo(observation)
			: createUnresolvedMemo(observation));
		const readState = this.getReadState(page.coverage, page.lifecycle, snapshotCurrent ? stateInput.settlement : null);
		return this.rememberPage({
			items: resolved.map((memo) => this.toMemoItem(memo, state)),
			nextCursor: page.nextCursor === null ? null : {
				catalog: page.nextCursor,
				stateRevision: snapshotCurrent ? snapshot.stateRevision : "state-unavailable",
			},
			coverage: page.coverage,
			lifecycle: page.lifecycle,
			capabilities: buildCoverageCapabilities(page.coverage),
			readState,
			degraded: readState !== "ready" || !snapshotCurrent,
			invalidated: false,
		});
	}

	async getDeletedSummary(): Promise<{ count: number; ids: string[] }> {
		if (this.options.stateStore === null) return { count: 0, ids: [] };
		const summary = await this.options.stateStore.getDeletedMemoSummary();
		return { count: summary.count, ids: summary.memoIds };
	}

	async listDeleted(limit: number, cursor: string | null = null): Promise<CatalogV2DeletedMemoPage> {
		if (this.options.stateStore === null || this.options.deletedPayloadStore === null) {
			return { items: [], nextCursor: null, stateRevision: "state-unavailable" };
		}
		const page = await this.options.stateStore.listDeletedMemoPage(limit, cursor);
		const items: CatalogV2DeletedMemoItem[] = [];
		for (const memo of page.items) {
			const deleteVersion = [...memo.deleteVersions].reverse().find((version) =>
				!memo.restoredDeleteOperationIds.includes(version.deleteOpId)
				&& !memo.purgedDeleteOperationIds.includes(version.deleteOpId));
			if (deleteVersion === undefined) continue;
			try {
				const payload = await this.options.deletedPayloadStore.read(deleteVersion.payload);
				items.push({
					key: `${memo.memoId}:${deleteVersion.deleteOpId}`,
					memoId: memo.memoId,
					deleteVersion,
					deletedAt: payload.deletedAt,
					logicalDate: payload.logicalDate,
					sourcePath: payload.sourcePath,
					section: payload.section,
					content: readDeletedPayloadContent(payload.rawBlock),
					sourceMemoId: payload.sourceMemoId,
					payloadAvailable: true,
				});
			} catch {
				const evidence = deleteVersion.baseEvidence;
				items.push({
					key: `${memo.memoId}:${deleteVersion.deleteOpId}`,
					memoId: memo.memoId,
					deleteVersion,
					deletedAt: "",
					logicalDate: evidence?.logicalDate ?? "",
					sourcePath: evidence?.sourcePath ?? "",
					section: evidence?.section ?? null,
					content: "",
					sourceMemoId: null,
					payloadAvailable: false,
				});
			}
		}
		return { items, nextCursor: page.nextCursor, stateRevision: page.revision };
	}

	async listAllDeleted(): Promise<CatalogV2DeletedMemoItem[]> {
		const items: CatalogV2DeletedMemoItem[] = [];
		let cursor: string | null = null;
		let revision: string | null = null;
		do {
			const page = await this.listDeleted(150, cursor);
			if (revision !== null && page.stateRevision !== revision) {
				items.length = 0;
				cursor = null;
				revision = null;
				continue;
			}
			revision = page.stateRevision;
			items.push(...page.items);
			cursor = page.nextCursor;
		} while (cursor !== null);
		return items;
	}

	async queryTimeBuoysForDate(targetDate: string): Promise<TimeBuoyQueryResult> {
		const memos = await this.queryAllItems({ timeBuoyDate: targetDate, limit: 150 });
		const coverage = await this.options.catalog.getStore().getCoverage();
		return {
			items: memos.map((memo) => ({
				memo: toCatalogV2MemoView(memo),
				instance: buildTimeBuoyInstance(memo, targetDate),
			})),
			stale: [],
			missingPeriods: isDateCovered(coverage, targetDate) ? [] : [targetDate.slice(0, 7)],
		};
	}

	async queryAllTimeBuoys(): Promise<TimeBuoyAllQueryResult> {
		const memos = await this.queryAllItems({ hasTimeBuoy: true, limit: 150 });
		return {
			items: memos.flatMap((memo) => memo.timeBuoyDates.map((targetDate) => ({
				memo: toCatalogV2MemoView(memo),
				instance: buildTimeBuoyInstance(memo, targetDate),
			}))).sort((left, right) => left.instance.targetDate.localeCompare(right.instance.targetDate)
				|| right.memo.createdAt.localeCompare(left.memo.createdAt)),
			stale: [],
			missingPeriods: [],
			complete: (await this.options.catalog.getStore().getCoverage()).kind === "complete",
		};
	}

	async buildRecordStats(
		yieldToUi: () => Promise<void>,
		isCurrent: () => boolean,
	): Promise<PreparedRecordStats | null> {
		await this.requireCompleteCoverage("Record statistics");
		let builder = new RecordStatsBuilder();
		let cursor: CatalogV2FeatureQuery["cursor"] = null;
		do {
			if (!isCurrent()) return null;
			const page = await this.query({ limit: 150, cursor });
			if (page.invalidated) {
				cursor = null;
				builder = new RecordStatsBuilder();
				continue;
			}
			if (!page.capabilities.completeStats) throw new Error("Record statistics require complete Catalog coverage.");
			for (const memo of page.items) builder.addMemo(toCatalogV2MemoView(memo));
			cursor = page.nextCursor;
			await yieldToUi();
		} while (cursor !== null);
		return builder.build();
	}

	async getRandomReunionItems(count: number): Promise<MemoViewItem[]> {
		await this.requireCompleteCoverage("Random reunion");
		const today = formatDatePart(this.now());
		const aggregates = (await this.options.catalog.listDailyAggregates())
			.filter((item) => item.logicalDate < today && item.memoCount > 0);
		await this.requireCompleteCoverage("Random reunion");
		const candidateDates = sampleDates(aggregates.map((item) => item.logicalDate), 24, this.random);
		const candidates: CatalogV2MemoItem[] = [];
		for (const date of candidateDates) {
			candidates.push(...await this.queryAllItems({ fromDate: date, toDate: date, limit: 150 }));
		}
		await this.requireCompleteCoverage("Random reunion");
		const reviews: MemoReviewStateMap = {};
		const reviewMemos = await this.options.stateStore?.listMaterializedMemosByIds(
			candidates.flatMap((candidate) => candidate.memoId === null ? [] : [candidate.memoId]),
		) ?? [];
		for (const memo of reviewMemos) {
			reviews[memo.memoId] = memo.lastReviewedAt === null
				? { memoId: memo.memoId, reviewCount: memo.reviewCount }
				: { memoId: memo.memoId, reviewCount: memo.reviewCount, lastReviewedAt: memo.lastReviewedAt };
		}
		return getRandomReunionMemos(candidates.map(toCatalogV2MemoView), reviews, count, {
			today: this.now(),
			random: this.random,
		});
	}

	async listDailyAggregates() {
		await this.requireCompleteCoverage("Shuffle Day");
		const aggregates = await this.options.catalog.listDailyAggregates();
		await this.requireCompleteCoverage("Shuffle Day");
		return aggregates;
	}

	async listMemoViewsForDate(date: string): Promise<MemoViewItem[]> {
		await this.requireCompleteCoverage("Shuffle Day");
		const items = await this.queryAllItems({ fromDate: date, toDate: date, limit: 150 });
		await this.requireCompleteCoverage("Shuffle Day");
		return items.map(toCatalogV2MemoView);
	}

	async listMonthlyProjectionPeriods(): Promise<string[]> {
		await this.requireCompleteCoverage("Monthly period discovery");
		const aggregates = await this.options.catalog.listDailyAggregates();
		await this.requireCompleteCoverage("Monthly period discovery");
		return [...new Set(aggregates
			.filter((aggregate) => aggregate.memoCount > 0)
			.map((aggregate) => aggregate.logicalDate.slice(0, 7)))].sort();
	}

	async resolveObservationInFile(sourcePath: string, startLine: number): Promise<ResolvedMemo> {
		const observationKey = `${sourcePath}\u0000${startLine.toString().padStart(10, "0")}`;
		const observation = await this.options.catalog.getObservation(observationKey);
		if (observation === null) throw new Error("Memo observation is no longer present in its Daily note.");
		const snapshot = await this.options.catalog.loadResolutionSnapshot().catch(() => null);
		return snapshot?.results[observationKey] ?? createUnresolvedMemo(observation);
	}

	async materializeResolutionSnapshot(): Promise<CatalogV2ResolutionSnapshot | null> {
		const files = await this.options.catalog.listFiles();
		const batches = (await Promise.all(files.map((file) => this.options.catalog.getFileRevisionBatch(file.sourcePath))))
			.filter((batch): batch is NonNullable<typeof batch> => batch !== null);
		const catalogRevision = batches[0]?.catalogRevision ?? 0;
		if (batches.some((batch) => batch.catalogRevision !== catalogRevision)) return null;
		const stateInput = await this.loadStateSnapshot(false);
		if (stateInput === null) return null;
		const sharedInspection = await this.loadSharedMutationInspection();
		if (this.options.inspectSharedMutations !== undefined && sharedInspection === null) {
			const snapshot: CatalogV2ResolutionSnapshot = {
				catalogRevision,
				stateRevision: stateInput.snapshot.revision,
				mutationInventoryDigest: await sha256Text("unavailable"),
				results: {},
			};
			await this.options.catalog.saveResolutionSnapshot(snapshot);
			return snapshot;
		}
		const localIntents = [
			...await this.listLocalIdentityIntents(stateInput.snapshot.state),
			...await this.listSharedIdentityIntents(stateInput.snapshot.state, sharedInspection),
		];
		const results = this.resolver.resolveVault({
			batches,
			state: stateInput.snapshot.state,
			stateRevision: stateInput.snapshot.revision,
			localIntents,
			settlement: stateInput.settlement,
		});
		const snapshot: CatalogV2ResolutionSnapshot = {
			catalogRevision,
			stateRevision: stateInput.snapshot.revision,
			mutationInventoryDigest: await this.getMutationInventoryDigest(sharedInspection),
			results: Object.fromEntries(results),
		};
		await this.options.catalog.saveResolutionSnapshot(snapshot);
		return snapshot;
	}

	private rememberPage(page: CatalogV2MemoPage): CatalogV2MemoPage {
		this.lastReadState = page.readState;
		return page;
	}

	private getReadState(
		coverage: CatalogCoverage,
		lifecycle: CatalogStoreLifecycle,
		settlement: CatalogV2IdentitySettlement | null,
	): CatalogV2ReadState {
		const installReadState = this.getStaticInstallReadState();
		if (installReadState !== null) return installReadState;
		if (lifecycle.state === "degraded" || lifecycle.state === "retrying" || lifecycle.state === "read-only"
			|| this.options.stateStore?.isAuthoritative() === false
			|| this.options.transactionStore?.isAuthoritative() === false) {
			return "storage_unavailable";
		}
		const migrationRequired = settlement?.migrationRequired
			?? (this.options.getInstallMode?.() ?? this.options.installMode) === "legacy_upgrade";
		if (migrationRequired && settlement === null) return "legacy_detected";
		if (coverage.kind !== "complete") return migrationRequired ? "upgrade_building" : "history_building";
		if (settlement === null || !settlement.stateComplete || !settlement.revisionStable) return "state_settling";
		if (migrationRequired && !settlement.migrationComplete) return "upgrade_building";
		return "ready";
	}

	private async requireCompleteCoverage(feature: string): Promise<CatalogCoverage> {
		const coverage = await this.options.catalog.getStore().getCoverage();
		if (coverage.kind !== "complete") {
			throw new Error(`${feature} requires complete Catalog coverage.`);
		}
		return coverage;
	}

	private getStaticInstallReadState(): CatalogV2ReadState | null {
		const installMode = this.options.getInstallMode?.() ?? this.options.installMode;
		if (installMode === "uninitialized") return "needs_initialization";
		if (installMode === "joining") return "waiting_for_sync";
		if (installMode === "attention") return "attention";
		return null;
	}

	private async queryAllItems(
		request: Omit<CatalogV2FeatureQuery, "cursor">,
		maximum = Number.MAX_SAFE_INTEGER,
	): Promise<CatalogV2MemoItem[]> {
		const items: CatalogV2MemoItem[] = [];
		let cursor = null;
		do {
			const page = await this.query({ ...request, cursor });
			if (page.invalidated) {
				cursor = null;
				items.length = 0;
				continue;
			}
			items.push(...page.items.slice(0, Math.max(0, maximum - items.length)));
			cursor = items.length >= maximum ? null : page.nextCursor;
		} while (cursor !== null);
		return items;
	}

	private async loadStateSnapshot(
		historical: boolean,
	): Promise<Awaited<ReturnType<CatalogV2StateShadowCoordinator["loadLocalStateSnapshot"]>>> {
		if (this.options.stateCoordinator === null) return null;
		try {
			return await this.options.stateCoordinator.loadLocalStateSnapshot(historical);
		} catch {
			try {
				return await this.options.stateCoordinator.loadLocalStateSlice([], historical);
			} catch {
				return null;
			}
		}
	}

	private async listLocalIdentityIntents(state: CatalogV2MaterializedState): Promise<CatalogV2LocalIdentityIntent[]> {
		const intents = Object.values(state.memos).flatMap((memo) => memo.pendingCreateIntents.map((intent) => ({
			memoId: memo.memoId,
			createIntentOpId: intent.entryId,
			targetPath: intent.evidence.sourcePath,
			sourceRevision: intent.evidence.sourceRevision,
			logicalDate: intent.evidence.logicalDate,
			time: intent.evidence.time,
			contentHash: intent.evidence.contentHash,
		})));
		if (this.options.transactionStore === null) return intents;
		try {
			const local = (await this.options.transactionStore.listStateOperationOutbox()).flatMap((item) => {
				const operation = item.operation;
				if (operation.type !== "lifecycle.create_intent") return [];
				return [{
					memoId: operation.memoId,
					createIntentOpId: operation.opId,
					targetPath: operation.payload.targetPath,
					sourceRevision: operation.payload.evidence.sourceRevision,
					logicalDate: operation.payload.logicalDate,
					time: operation.payload.time,
					contentHash: operation.payload.contentHash,
				}];
			});
			return [...new Map([...intents, ...local].map((intent) => [intent.createIntentOpId, intent])).values()];
		} catch {
			return intents;
		}
	}

	private async loadSharedMutationInspection(): Promise<CatalogV2SharedMutationInspection | null> {
		if (this.options.inspectSharedMutations === undefined) return null;
		try {
			return await this.options.inspectSharedMutations();
		} catch {
			return null;
		}
	}

	private async listSharedIdentityIntents(
		state: CatalogV2MaterializedState,
		inspection: CatalogV2SharedMutationInspection | null,
	): Promise<CatalogV2LocalIdentityIntent[]> {
		if (inspection === null || this.options.getVaultContext === undefined) return [];
		const context = await this.options.getVaultContext();
		if (context === null) return [];
		const intents: CatalogV2LocalIdentityIntent[] = [];
		for (const record of inspection.records) {
			const prepare = record.prepare;
			if (record.abandon !== null || prepare.vaultInstanceId !== context.bootstrap.vaultInstanceId) continue;
			for (const [index, change] of prepare.changes.entries()) {
				const evidence = change.transition.afterEvidence;
				if (evidence === null || this.isEvidenceOwnedByAnotherMemo(state, prepare.memoId, evidence)) continue;
				if ((prepare.mutationKind === "create" || prepare.mutationKind === "copy")
					&& await deriveObservationMemoId(
						context.bootstrap.vaultInstanceId,
						context.contractSha256,
						evidence,
					) !== prepare.memoId) continue;
				intents.push({
					memoId: prepare.memoId,
					createIntentOpId: `${prepare.mutationId}:${index}`,
					targetPath: evidence.sourcePath,
					sourceRevision: evidence.sourceRevision,
					logicalDate: evidence.logicalDate,
					time: evidence.time,
					contentHash: evidence.contentHash,
				});
			}
		}
		return intents;
	}

	private isEvidenceOwnedByAnotherMemo(
		state: CatalogV2MaterializedState,
		memoId: string,
		evidence: IdentityEvidence,
	): boolean {
		const expected = canonicalJson(evidence);
		return Object.values(state.memos).some((memo) => memo.memoId !== memoId
			&& memo.activeBindingHeads.some((binding) => "sourceRevision" in binding.evidence
				&& canonicalJson(binding.evidence) === expected));
	}

	private async getMutationInventoryDigest(
		sharedInspection: CatalogV2SharedMutationInspection | null,
	): Promise<string> {
		if (this.options.transactionStore === null) return sha256Text(canonicalJson({
			local: [],
			shared: summarizeSharedMutationInspection(sharedInspection),
		}));
		try {
			const pending = await this.options.transactionStore.listPending();
			return sha256Text(canonicalJson({
				local: pending.map((item) => ({
					transactionId: item.transactionId,
					memoId: item.memoId,
					sharedPrepare: item.sharedPrepare ?? null,
				})).sort((left, right) => left.transactionId.localeCompare(right.transactionId)),
				shared: summarizeSharedMutationInspection(sharedInspection),
			}));
		} catch {
			return sha256Text(canonicalJson({
				local: "unavailable",
				shared: summarizeSharedMutationInspection(sharedInspection),
			}));
		}
	}

	private toMemoItem(resolved: ResolvedMemo, state: CatalogV2MaterializedState): CatalogV2MemoItem {
		const observation = resolved.observation as CatalogObservation;
		const memoId = resolved.kind === "identified" ? resolved.memoId : null;
		const materialized = memoId === null ? undefined : state.memos[memoId];
		const activeRelations = materialized?.relationEntries.filter((entry) =>
			!materialized.supersededRelationIds.includes(entry.relationId)) ?? [];
		const sourceMemoIds = [...new Set(activeRelations.map((entry) => entry.sourceMemoId))];
		return {
			key: memoId ?? observation.observationKey,
			memoId,
			createdAt: `${observation.logicalDate}T${normalizeTime(observation.time)}`,
			content: observation.content,
			tags: [...observation.tags],
			links: [...observation.links],
			images: [...observation.images],
			tasks: [...observation.tasks],
			timeBuoyDates: [...observation.timeBuoyDates],
			sourcePath: observation.sourcePath,
			lineNumberHint: observation.startLine + 1,
			sourceMemoId: sourceMemoIds.length === 1 ? sourceMemoIds[0] ?? null : null,
			capabilities: resolved.capabilities,
			resolved,
			observation,
		};
	}
}

function summarizeSharedMutationInspection(inspection: CatalogV2SharedMutationInspection | null) {
	return inspection?.records.map((record) => ({
		mutationId: record.mutationId,
		prepare: record.prepareRef,
		commit: record.commitRef,
		abandon: record.abandonRef,
	})).sort((left, right) => left.mutationId.localeCompare(right.mutationId)) ?? [];
}

function normalizeTime(time: string): string {
	return time.length === 5 ? `${time}:00` : time;
}

function readDeletedPayloadContent(rawBlock: string): string {
	const first = /^- (?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?(?:\s(.*))?$/u.exec(rawBlock.split(/\r?\n/u)[0] ?? "")?.[1] ?? "";
	const continuation = rawBlock.split(/\r?\n/u).slice(1).map((line) => line.replace(/^ {2}/u, ""));
	return [first, ...continuation].join("\n").replace(/\s+\^[A-Za-z0-9-]+\s*$/u, "").trim();
}

function buildTimeBuoyInstance(memo: CatalogV2MemoItem, targetDate: string) {
	return {
		memoId: memo.memoId ?? memo.key,
		targetDate,
	};
}

function buildCoverageCapabilities(coverage: CatalogCoverage): CatalogV2CoverageCapabilities {
	const complete = coverage.kind === "complete";
	return {
		browseKnown: true,
		completeStats: complete,
		completeShuffleDayPool: complete,
		completeRandomPool: complete,
		completeTimeBuoyIndex: complete,
	};
}

function isDateCovered(coverage: CatalogCoverage, logicalDate: string): boolean {
	return coverage.kind === "complete"
		|| (coverage.kind === "partial" && coverage.coveredFromDate !== null && logicalDate >= coverage.coveredFromDate);
}

function sampleDates(dates: readonly string[], count: number, random: () => number): string[] {
	const remaining = [...dates];
	const result: string[] = [];
	while (result.length < count && remaining.length > 0) {
		const index = Math.min(Math.floor(random() * remaining.length), remaining.length - 1);
		result.push(remaining[index] as string);
		remaining.splice(index, 1);
	}
	return result;
}

function createUnavailableState(): CatalogV2MaterializedState {
	return {
		schemaVersion: 1,
		memos: {},
		quarantine: [],
		awaitingWriterIds: [],
		forkedWriterIds: [],
		processedOperationCount: 0,
	};
}

function createUnresolvedMemo(observation: CatalogObservation): ResolvedMemo {
	return {
		kind: "observed",
		observation,
		adoption: "settling",
		capabilities: {
			view: true,
			copy: true,
			openDaily: true,
			openLinks: true,
			openImages: true,
			copyAsNew: "blocked_settling",
			edit: "blocked_settling",
			toggleTask: "blocked_settling",
			delete: "blocked_settling",
			createReference: "blocked_settling",
			recordReview: "blocked_settling",
		},
		stateRevision: "state-unavailable",
	};
}

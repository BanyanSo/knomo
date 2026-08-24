import type {
	CatalogCoverage,
	CatalogObservation,
	CatalogCapabilities,
	CatalogQueryPage,
	CatalogStoreLifecycle,
	CatalogV2ResolutionSnapshot,
	ResolvedMemo,
} from "../types/catalog";
import type {
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
	CatalogV2ProjectionState,
	CatalogV2ReadStatus,
	CatalogV2ReadState,
} from "../types/catalogV2View";
import type { MemoViewItem } from "../types/memoView";
import { toCatalogV2MemoView } from "../types/memoView";
import type { MemoReviewStateMap } from "../types/review";
import type { IdentityLedgerBinding, IdentityLedgerReader } from "../types/identityLedger";
import type { LegacyIdentityImportStatus } from "../types/legacyIdentityImport";
import { formatDatePart } from "../utils/date";
import {
	CatalogV2IdentityResolver,
	observationToIdentityEvidence,
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
import {
	createCatalogCapabilities,
	createIdentityLedgerConflictCapabilities,
	createIdentityLedgerMemoCapabilities,
	createResolvedMemoCapabilities,
} from "./MemoCapabilityModel";

type CatalogV2StateInput = Awaited<ReturnType<CatalogV2StateShadowCoordinator["loadLocalStateSnapshot"]>>;

export interface CatalogV2ReadServiceOptions {
	catalog: MemoCatalogService;
	stateStore: IndexedDbCatalogV2StateStore | null;
	stateCoordinator: CatalogV2StateShadowCoordinator | null;
	transactionStore: IndexedDbCatalogV2TransactionStore | null;
	deletedPayloadStore: CatalogV2DeletedPayloadStore | null;
	installMode?: import("../types/catalogV2").CatalogV2InstallMode;
	getInstallMode?: () => import("../types/catalogV2").CatalogV2InstallMode;
	getVaultContext?: () => CatalogV2VerifiedVaultContext | null | Promise<CatalogV2VerifiedVaultContext | null>;
	inspectSharedMutations?: () => Promise<CatalogV2SharedMutationInspection>;
	requestObservationScan?: () => void | Promise<void>;
	getProjectionState?: () => CatalogV2ProjectionState;
	identityLedger?: IdentityLedgerReader | null;
	getLegacyImportStatus?: () => LegacyIdentityImportStatus;
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
		let page: CatalogQueryPage;
		try {
			page = await this.options.catalog.query({ ...request, cursor: request.cursor?.catalog ?? null });
		} catch {
			void Promise.resolve().then(() => this.options.requestObservationScan?.()).catch(() => undefined);
			return this.createUnavailablePage();
		}
		const stateInput = await this.loadStateSnapshot(false);
		const resolutionStateRevision = this.getResolutionStateRevision(stateInput);
		if (page.invalidated) return this.rememberPage({
			items: [],
			nextCursor: null,
			coverage: page.coverage,
			lifecycle: page.lifecycle,
			capabilities: createCatalogCapabilities(page.coverage),
			status: this.getReadStatus(page.coverage, page.lifecycle, stateInput, false, [], false),
			readState: this.getReadState(page.coverage, page.lifecycle, stateInput?.settlement ?? null),
			degraded: true,
			invalidated: true,
		});
		const snapshot = await this.options.catalog.loadResolutionSnapshot().catch(() => null);
		const snapshotCurrent = snapshot !== null && snapshot.catalogRevision === page.catalogRevision
			&& resolutionStateRevision !== null && snapshot.stateRevision === resolutionStateRevision;
		const state = stateInput?.snapshot.state ?? createUnavailableState();
		const resolved = page.items.map((observation) => snapshotCurrent
			? snapshot.results[observation.observationKey] ?? createUnresolvedMemo(observation)
			: createUnresolvedMemo(observation));
		const readState = this.getReadState(page.coverage, page.lifecycle, snapshotCurrent ? stateInput?.settlement ?? null : null);
		const status = this.getReadStatus(page.coverage, page.lifecycle, stateInput, snapshotCurrent, resolved, false);
		const catalogCapabilities = createCatalogCapabilities(page.coverage);
		return this.rememberPage({
			items: resolved.map((memo) => this.toMemoItem(memo, state, catalogCapabilities)),
			nextCursor: page.nextCursor === null ? null : {
				catalog: page.nextCursor,
			},
			coverage: page.coverage,
			lifecycle: page.lifecycle,
			capabilities: catalogCapabilities,
			status,
			readState,
			degraded: status.content === "unavailable" || status.catalog === "degraded",
			invalidated: false,
		});
	}

	async getDeletedSummary(): Promise<{ count: number; ids: string[] }> {
		if (this.options.identityLedger?.getActiveDeletes !== undefined) {
			const records = await this.listVisibleIdentityDeletes();
			return { count: records.length, ids: [...new Set(records.map((item) => item.memoId))].sort() };
		}
		if (this.options.stateStore === null) return { count: 0, ids: [] };
		const summary = await this.options.stateStore.getDeletedMemoSummary();
		return { count: summary.count, ids: summary.memoIds };
	}

	async listDeleted(limit: number, cursor: string | null = null): Promise<CatalogV2DeletedMemoPage> {
		if (this.options.identityLedger?.getActiveDeletes !== undefined) {
			const records = await this.listVisibleIdentityDeletes();
			const offset = cursor === null ? 0 : Math.max(0, Number.parseInt(cursor, 10) || 0);
			const selected = records.slice(offset, offset + Math.max(0, limit));
			const nextOffset = offset + selected.length;
			return {
				items: selected.map((record) => ({
					key: `${record.memoId}:${record.deleteEventId}`,
					memoId: record.memoId,
					deleteVersion: {
						deleteOpId: record.deleteEventId,
						entryId: record.deleteEventId,
						payload: {
							path: `identity-ledger/${record.deleteEventId}`,
							sha256: "0".repeat(64),
							byteLength: new TextEncoder().encode(record.evidence.rawBlock).byteLength,
						},
						baseEvidence: null,
						baseBindingId: record.baseBindingId,
					},
					deletedAt: record.evidence.deletedAt,
					logicalDate: record.evidence.logicalDate,
					sourcePath: record.evidence.sourcePath,
					section: record.evidence.section,
					content: readDeletedPayloadContent(record.evidence.rawBlock),
					sourceMemoId: record.evidence.sourceMemoId,
					payloadAvailable: true,
					identityDeleteEventId: record.deleteEventId,
				})),
				nextCursor: nextOffset < records.length ? String(nextOffset) : null,
				stateRevision: this.options.identityLedger.getRevision(),
			};
		}
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
			if (page.capabilities.stats !== "complete") throw new Error("Record statistics require complete Catalog coverage.");
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
		for (const candidate of candidates) {
			if (candidate.memoId === null) continue;
			const ledgerReview = this.options.identityLedger?.getReviewState(candidate.memoId);
			if (ledgerReview !== undefined) {
				reviews[candidate.memoId] = ledgerReview.lastReviewedAt === null
					? { memoId: candidate.memoId, reviewCount: ledgerReview.reviewCount }
					: {
						memoId: candidate.memoId,
						reviewCount: ledgerReview.reviewCount,
						lastReviewedAt: ledgerReview.lastReviewedAt,
					};
			}
		}
		if (this.options.identityLedger === null || this.options.identityLedger === undefined) {
			const reviewMemos = await this.options.stateStore?.listMaterializedMemosByIds(
				candidates.flatMap((candidate) => candidate.memoId === null ? [] : [candidate.memoId]),
			) ?? [];
			for (const memo of reviewMemos) {
				reviews[memo.memoId] = memo.lastReviewedAt === null
					? { memoId: memo.memoId, reviewCount: memo.reviewCount }
					: { memoId: memo.memoId, reviewCount: memo.reviewCount, lastReviewedAt: memo.lastReviewedAt };
			}
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
		const stateRevision = this.getResolutionStateRevision(stateInput);
		if (stateRevision === null) return null;
		let v2Results = new Map<string, ResolvedMemo>();
		let mutationInventoryDigest = await sha256Text("unavailable");
		if (stateInput !== null) {
			const sharedInspection = await this.loadSharedMutationInspection();
			if (this.options.inspectSharedMutations === undefined || sharedInspection !== null) {
				const localIntents = [
					...await this.listLocalIdentityIntents(stateInput.snapshot.state),
					...await this.listSharedIdentityIntents(stateInput.snapshot.state, sharedInspection),
				];
				v2Results = this.resolver.resolveVault({
					batches,
					state: stateInput.snapshot.state,
					stateRevision: stateInput.snapshot.revision,
					localIntents,
					settlement: stateInput.settlement,
				});
				mutationInventoryDigest = await this.getMutationInventoryDigest(sharedInspection);
			}
		}
		const identityLedgerSnapshot = this.options.identityLedger?.getSnapshot() ?? null;
		const results = new Map<string, ResolvedMemo>();
		for (const batch of batches) {
			for (const observation of batch.observations) {
				const ledgerState = this.options.identityLedger?.resolveObservationState(observation) ?? { kind: "unbound" as const };
				results.set(
					observation.observationKey,
					ledgerState.kind === "identified"
						? createIdentityLedgerResolvedMemo(observation, ledgerState.binding)
						: ledgerState.kind === "conflicted"
							? createIdentityLedgerConflictedMemo(
								observation,
								ledgerState.memoIds,
								this.options.identityLedger?.getRevision() ?? "identity-v3-unavailable",
								ledgerState.memoIds.some((memoId) => {
									const memo = identityLedgerSnapshot?.memos[memoId];
									return memo?.conflicted === true && memo.conflictBaseBindingId !== null;
								}),
							)
							: v2Results.get(observation.observationKey) ?? createUnresolvedMemo(observation),
				);
			}
		}
		const snapshot: CatalogV2ResolutionSnapshot = {
			catalogRevision,
			stateRevision,
			mutationInventoryDigest,
			results: Object.fromEntries(results),
		};
		await this.options.catalog.saveResolutionSnapshot(snapshot);
		return snapshot;
	}

	private rememberPage(page: CatalogV2MemoPage): CatalogV2MemoPage {
		this.lastReadState = page.readState;
		return page;
	}

	private async createUnavailablePage(): Promise<CatalogV2MemoPage> {
		const store = this.options.catalog.getStore();
		const coverage = await store.getCoverage().catch((): CatalogCoverage => ({
			kind: "partial",
			coveredFromDate: null,
			pendingFileCount: 0,
			coveredFileCount: 0,
			totalFileCount: 0,
		}));
		let lifecycle: CatalogStoreLifecycle;
		try {
			lifecycle = store.getLifecycle();
		} catch {
			lifecycle = { state: "degraded", persistent: false, writable: false, reason: "catalog_query_failed" };
		}
		const stateInput = await this.loadStateSnapshot(false);
		return this.rememberPage({
			items: [],
			nextCursor: null,
			coverage,
			lifecycle,
			capabilities: createCatalogCapabilities(coverage),
			status: this.getReadStatus(coverage, lifecycle, stateInput, false, [], true),
			readState: "storage_unavailable",
			degraded: true,
			invalidated: false,
		});
	}

	private getReadStatus(
		coverage: CatalogCoverage,
		lifecycle: CatalogStoreLifecycle,
		stateInput: CatalogV2StateInput,
		snapshotCurrent: boolean,
		resolved: readonly ResolvedMemo[],
		contentUnavailable: boolean,
	): CatalogV2ReadStatus {
		const state = stateInput?.snapshot.state ?? null;
		const settlement = stateInput?.settlement ?? null;
		const identityLedgerStatus = this.options.identityLedger?.getStatus() ?? null;
		const legacyImportStatus = this.options.getLegacyImportStatus?.() ?? "missing";
		const catalogDegraded = contentUnavailable
			|| lifecycle.state === "degraded"
			|| lifecycle.state === "retrying"
			|| lifecycle.state === "read-only";
		const identityConflicted = identityLedgerStatus === "conflicted"
			|| resolved.some((memo) => memo.kind === "ambiguous" && memo.capabilities.identity.repair !== "ready")
			|| (state?.quarantine.length ?? 0) > 0
			|| (state?.forkedWriterIds.length ?? 0) > 0
			|| (settlement?.blockedMemoIds?.length ?? 0) > 0;
		return {
			content: contentUnavailable
				? "unavailable"
				: coverage.kind === "complete" && lifecycle.state !== "opening" && lifecycle.state !== "rebuilding"
					? "ready"
					: "scanning",
			catalog: catalogDegraded
				? "degraded"
				: coverage.kind === "complete" && coverage.sharedConfigurationComplete !== false
					? "complete"
					: "partial",
			identity: identityLedgerStatus === "ready"
				? identityConflicted ? "conflicted" : "ready"
				: identityLedgerStatus === "conflicted"
					? "conflicted"
					: identityLedgerStatus === "missing" || identityLedgerStatus === "absent"
						? "absent"
						: identityLedgerStatus === "unavailable"
							? "syncing"
							: identityConflicted ? "conflicted" : "absent",
			projection: this.getProjectionState(),
			migration: legacyImportStatus === "attention" || legacyImportStatus === "partial"
				|| legacyImportStatus === "unavailable" ? "attention" : "none",
		};
	}

	private getProjectionState(): CatalogV2ProjectionState {
		try {
			return this.options.getProjectionState?.() ?? "ready";
		} catch {
			return "failed";
		}
	}

	private getReadState(
		coverage: CatalogCoverage,
		lifecycle: CatalogStoreLifecycle,
		settlement: CatalogV2IdentitySettlement | null,
	): CatalogV2ReadState {
		if (lifecycle.state === "degraded" || lifecycle.state === "retrying" || lifecycle.state === "read-only"
		) {
			return "storage_unavailable";
		}
		if (coverage.kind !== "complete") return "history_building";
		return "ready";
	}

	private async requireCompleteCoverage(feature: string): Promise<CatalogCoverage> {
		const coverage = await this.options.catalog.getStore().getCoverage();
		if (coverage.kind !== "complete") {
			throw new Error(`${feature} requires complete Catalog coverage.`);
		}
		return coverage;
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

	private async listVisibleIdentityDeletes() {
		const ledger = this.options.identityLedger;
		if (ledger?.getActiveDeletes === undefined) return [];
		const resolution = await this.options.catalog.loadResolutionSnapshot().catch(() => null);
		const visibleMemoIds = new Set(Object.values(resolution?.results ?? {}).flatMap((memo) =>
			memo.kind === "identified" ? [memo.identityHandle.memoId] : []));
		return ledger.getActiveDeletes()
			.filter((record) => !visibleMemoIds.has(record.memoId))
			.sort((left, right) => right.evidence.deletedAt.localeCompare(left.evidence.deletedAt)
				|| left.deleteEventId.localeCompare(right.deleteEventId));
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

	private getResolutionStateRevision(stateInput: CatalogV2StateInput): string | null {
		const ledger = this.options.identityLedger;
		if (ledger === null || ledger === undefined) return stateInput?.snapshot.revision ?? null;
		return `${ledger.getRevision()}|v2:${stateInput?.snapshot.revision ?? "unavailable"}`;
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

	private toMemoItem(
		resolved: ResolvedMemo,
		state: CatalogV2MaterializedState,
		catalogCapabilities: CatalogCapabilities,
	): CatalogV2MemoItem {
		const observation = resolved.observation as CatalogObservation;
		const identityHandle = resolved.identityHandle;
		const memoId = identityHandle?.memoId ?? null;
		const materialized = memoId === null ? undefined : state.memos[memoId];
		const activeRelations = materialized?.relationEntries.filter((entry) =>
			!materialized.supersededRelationIds.includes(entry.relationId)) ?? [];
		const sourceMemoIds = [...new Set(activeRelations.map((entry) => entry.sourceMemoId))];
		const ledgerSourceMemoId = memoId === null ? null : this.options.identityLedger?.getSourceMemoId(memoId) ?? null;
		return {
			key: memoId ?? observation.observationKey,
			renderKey: observation.observationKey,
			memoId,
			identityHandle,
			observationHandle: {
				sourcePath: observation.sourcePath,
				sourceRevision: observation.sourceRevision,
				startLine: observation.startLine,
				endLine: observation.endLine,
				rawBlockHash: observation.rawBlockHash,
			},
			createdAt: `${observation.logicalDate}T${normalizeTime(observation.time)}`,
			content: observation.content,
			tags: [...observation.tags],
			links: [...observation.links],
			images: [...observation.images],
			tasks: [...observation.tasks],
			timeBuoyDates: [...observation.timeBuoyDates],
			sourcePath: observation.sourcePath,
			lineNumberHint: observation.startLine + 1,
			sourceMemoId: ledgerSourceMemoId ?? (sourceMemoIds.length === 1 ? sourceMemoIds[0] ?? null : null),
			capabilities: {
				...resolved.capabilities,
				catalog: catalogCapabilities,
			},
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
		identityHandle: null,
		observation,
		adoption: "settling",
		capabilities: createResolvedMemoCapabilities("syncing"),
		stateRevision: "state-unavailable",
	};
}

function createIdentityLedgerResolvedMemo(
	observation: CatalogObservation,
	binding: IdentityLedgerBinding,
): ResolvedMemo {
	return {
		kind: "identified",
		identityHandle: {
			memoId: binding.memoId,
			activeBindingId: binding.bindingId,
			identityRevision: binding.identityRevision,
		},
		observation,
		bindingEvidence: observationToIdentityEvidence(observation),
		capabilities: createIdentityLedgerMemoCapabilities(),
		stateRevision: binding.identityRevision,
	};
}

function createIdentityLedgerConflictedMemo(
	observation: CatalogObservation,
	memoIds: readonly string[],
	identityRevision: string,
	repairable: boolean,
): ResolvedMemo {
	return {
		kind: "ambiguous",
		identityHandle: null,
		observation,
		candidates: [...new Set(memoIds)].sort().map((memoId) => ({
			memoId,
			source: "manual_successor" as const,
		})),
		reason: "manual_successor",
		capabilities: repairable
			? createIdentityLedgerConflictCapabilities()
			: createResolvedMemoCapabilities("conflicted"),
		stateRevision: identityRevision,
	};
}

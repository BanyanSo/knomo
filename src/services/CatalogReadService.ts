import type {
	CatalogCoverage,
	CatalogDailyAggregate,
	CatalogObservation,
	CatalogCapabilities,
	CatalogQueryPage,
	CatalogStoreLifecycle,
	ResolvedMemo,
	ResolvedIdentityEvidence,
} from "../types/catalog";
import type {
	CatalogFeatureCursor,
	CatalogFeatureFilter,
	CatalogFeatureQuery,
	CatalogFunctionPageRequest,
	CatalogAggregateResult,
	CatalogLibrarySummary,
	CatalogMemoItem,
	CatalogMemoCountResult,
	CatalogMemoPage,
	CatalogRecordStatsFilter,
	CatalogReadState,
	CatalogReadStatus,
	KnomoRuntimeAttentionSnapshot,
	KnomoRuntimeSnapshot,
	MonthlyProjectionState,
	CatalogTagFacet,
	TrashMemoItem,
	TrashMemoPage,
} from "../types/catalogView";
import type {
	IdentityLedgerBinding,
	IdentityLedgerDeleteRecord,
	IdentityLedgerReader,
	IdentityLedgerSnapshot,
} from "../types/identityLedger";
import type { LegacyIdentityImportStatus } from "../types/legacyMigration";
import type { KnomoSharedConfigStatus } from "../types/knomoConfig";
import type { MemoViewItem } from "../types/memoView";
import type { KnomoSettingsLoadStatus } from "../types/settings";
import { toCatalogMemoView } from "../types/memoView";
import type { MemoReviewStateMap } from "../types/review";
import type { TimeBuoyAllQueryResult, TimeBuoyQueryResult } from "../types/timeBuoy";
import { formatDatePart } from "../utils/date";
import { getRandomReunionMemos } from "../utils/randomReunion";
import {
	createCatalogCapabilities,
	createIdentityLedgerConflictCapabilities,
	createIdentityLedgerMemoCapabilities,
	createResolvedMemoCapabilities,
} from "./MemoCapabilityModel";
import type { MemoCatalogService } from "./MemoCatalogService";
import type { DailyRecordStats, PreparedRecordStats } from "./RecordStatsService";

export interface CatalogReadServiceOptions {
	catalog: MemoCatalogService;
	identityLedger: IdentityLedgerReader;
	requestObservationScan?: () => void | Promise<void>;
	getProjectionState?: () => MonthlyProjectionState;
	getLegacyImportStatus?: () => LegacyIdentityImportStatus;
	getSharedConfigurationStatus?: () => KnomoSharedConfigStatus;
	getSettingsStatus?: () => KnomoSettingsLoadStatus;
	now?: () => Date;
	random?: () => number;
}

interface RandomReunionPreparationOptions {
	prepareIdentity?: (candidate: CatalogMemoItem) => Promise<CatalogMemoItem>;
	onPreparingIdentity?: () => void;
}

interface RandomReunionCandidatePool {
	catalogRevision: number;
	observations: CatalogObservation[];
}

export class CatalogReadService {
	private readonly now: () => Date;
	private readonly random: () => number;
	private lastReadState: CatalogReadState | null = null;
	private randomReunionCandidatePool: RandomReunionCandidatePool | null = null;
	private randomReunionCandidatePoolLoad: Promise<RandomReunionCandidatePool> | null = null;

	constructor(private readonly options: CatalogReadServiceOptions) {
		this.now = options.now ?? (() => new Date());
		this.random = options.random ?? Math.random;
	}

	getLastReadState(): CatalogReadState | null {
		return this.lastReadState;
	}

	getRuntimeAttentionSnapshot(): KnomoRuntimeAttentionSnapshot {
		let catalogLifecycle: CatalogStoreLifecycle = {
			state: "degraded",
			persistent: false,
			writable: false,
			reason: "catalog_status_unavailable",
		};
		try {
			catalogLifecycle = this.options.catalog.getStore().getLifecycle();
		} catch {
			// 故障提示无法读取 Catalog 状态时，按可恢复的降级状态处理。
		}
		let identity: KnomoRuntimeAttentionSnapshot["identity"] = "unavailable";
		let sharedConfiguration: KnomoRuntimeAttentionSnapshot["sharedConfiguration"] = "unavailable";
		let legacyMigration: KnomoRuntimeAttentionSnapshot["legacyMigration"] = "unavailable";
		let settings: KnomoSettingsLoadStatus = "ready";
		try {
			identity = this.options.identityLedger.getStatus();
		} catch {
			// 保留 unavailable。
		}
		try {
			sharedConfiguration = this.options.getSharedConfigurationStatus?.() ?? "missing";
		} catch {
			// 保留 unavailable。
		}
		try {
			legacyMigration = this.options.getLegacyImportStatus?.() ?? "idle";
		} catch {
			// 保留 unavailable。
		}
		try {
			settings = this.options.getSettingsStatus?.() ?? "ready";
		} catch {
			settings = "unavailable";
		}
		return {
			settings,
			catalogLifecycle,
			identity,
			sharedConfiguration,
			monthly: this.getProjectionState(),
			legacyMigration,
		};
	}

	async getRuntimeSnapshot(): Promise<KnomoRuntimeSnapshot> {
		const attention = this.getRuntimeAttentionSnapshot();
		let coverage: CatalogCoverage = {
			kind: "partial",
			coveredFromDate: null,
			pendingFileCount: 0,
			coveredFileCount: 0,
			totalFileCount: 0,
		};
		let lifecycle = attention.catalogLifecycle;
		try {
			const store = this.options.catalog.getStore();
			coverage = await store.getCoverage();
			lifecycle = store.getLifecycle();
		} catch {
			// 运行状态本身不可用时返回只读降级快照，不触发修复或扫描。
		}
		return {
			settings: attention.settings,
			catalog: { coverage, lifecycle },
			identity: attention.identity,
			sharedConfiguration: attention.sharedConfiguration,
			monthly: attention.monthly,
			legacyMigration: attention.legacyMigration,
		};
	}

	async prime(): Promise<void> {
		await this.query({ limit: 1 });
	}

	async query(request: CatalogFeatureQuery): Promise<CatalogMemoPage> {
		let page: CatalogQueryPage;
		try {
			page = await this.options.catalog.query({ ...request, cursor: request.cursor?.catalog ?? null });
		} catch {
			void Promise.resolve().then(() => this.options.requestObservationScan?.()).catch(() => undefined);
			return this.createUnavailablePage();
		}
		if (page.invalidated) {
			return this.rememberPage({
				items: [],
				nextCursor: null,
				catalogRevision: page.catalogRevision,
				identityRevision: this.options.identityLedger.getRevision(),
				coverage: page.coverage,
				lifecycle: page.lifecycle,
				capabilities: createCatalogCapabilities(page.coverage),
				status: this.getReadStatus(page.coverage, page.lifecycle, [], false),
				readState: this.getReadState(page.coverage, page.lifecycle),
				degraded: true,
				invalidated: true,
			});
		}
		const resolved = page.items.map((observation) => this.resolveObservation(observation));
		const status = this.getReadStatus(page.coverage, page.lifecycle, resolved, false);
		const catalogCapabilities = createCatalogCapabilities(page.coverage);
		return this.rememberPage({
			items: resolved.map((memo) => this.toMemoItem(memo, catalogCapabilities)),
			nextCursor: page.nextCursor === null ? null : { catalog: page.nextCursor },
			catalogRevision: page.catalogRevision,
			identityRevision: this.options.identityLedger.getRevision(),
			coverage: page.coverage,
			lifecycle: page.lifecycle,
			capabilities: catalogCapabilities,
			status,
			readState: this.getReadState(page.coverage, page.lifecycle),
			degraded: status.content === "unavailable" || status.catalog === "degraded",
			invalidated: false,
		});
	}

	async count(request: CatalogFeatureFilter): Promise<CatalogMemoCountResult> {
		try {
			const result = await this.options.catalog.count(request);
			const complete = isQueryCovered(result.coverage, request);
			return {
				count: complete ? result.count : null,
				complete,
				catalogRevision: result.catalogRevision,
				identityRevision: this.options.identityLedger.getRevision(),
				coverage: result.coverage,
			};
		} catch {
			return this.createUnavailableCount();
		}
	}

	async getLibrarySummary(): Promise<CatalogAggregateResult<CatalogLibrarySummary>> {
		const coverage = await this.options.catalog.getStore().getCoverage();
		if (!isCompleteCoverage(coverage)) return { value: null, complete: false, coverage };
		const aggregates = await this.options.catalog.listDailyAggregates();
		const verifiedCoverage = await this.options.catalog.getStore().getCoverage();
		if (!isCompleteCoverage(verifiedCoverage)) return { value: null, complete: false, coverage: verifiedCoverage };
		const tagKeys = new Set(aggregates.flatMap((aggregate) => Object.keys(aggregate.tagMemoCounts ?? {})));
		return {
			value: {
				memoCount: sumAggregates(aggregates, (aggregate) => aggregate.memoCount),
				tagCount: tagKeys.size,
				imageCount: sumAggregates(aggregates, (aggregate) => aggregate.imageCount),
				wordCount: sumAggregates(aggregates, (aggregate) => aggregate.wordCount ?? 0),
			},
			complete: true,
			coverage: verifiedCoverage,
		};
	}

	async getTagFacets(): Promise<CatalogAggregateResult<CatalogTagFacet[]>> {
		const coverage = await this.options.catalog.getStore().getCoverage();
		if (!isCompleteCoverage(coverage)) return { value: null, complete: false, coverage };
		const aggregates = await this.options.catalog.listDailyAggregates();
		const verifiedCoverage = await this.options.catalog.getStore().getCoverage();
		if (!isCompleteCoverage(verifiedCoverage)) return { value: null, complete: false, coverage: verifiedCoverage };
		const counts = new Map<string, number>();
		const labels = new Map<string, string>();
		for (const aggregate of aggregates) {
			for (const [key, count] of Object.entries(aggregate.tagMemoCounts ?? {})) {
				counts.set(key, (counts.get(key) ?? 0) + count);
			}
			for (const [key, label] of Object.entries(aggregate.tagDisplayNames ?? {})) {
				if (!labels.has(key)) labels.set(key, label);
			}
		}
		return {
			value: [...counts.entries()]
				.map(([key, count]) => ({ key, label: labels.get(key) ?? key, count }))
				.sort((left, right) => right.count - left.count || left.key.localeCompare(right.key)),
			complete: true,
			coverage: verifiedCoverage,
		};
	}

	async getCoverageForRange(fromDate: string, toDate: string): Promise<boolean> {
		const coverage = await this.options.catalog.getStore().getCoverage();
		return isRangeCovered(coverage, fromDate, toDate);
	}

	async queryReviewItems(date: Date, page: CatalogFunctionPageRequest): Promise<CatalogMemoPage> {
		const coverage = await this.options.catalog.getStore().getCoverage();
		const query = buildReviewCatalogQuery(date, page.text);
		if (!isCompleteCoverage(coverage)) return this.createCoveragePendingPage(query);
		return this.query({ ...query, limit: page.limit, cursor: page.cursor ?? null });
	}

	async countReviewItems(date: Date, text?: string): Promise<CatalogMemoCountResult> {
		return this.count(buildReviewCatalogQuery(date, text));
	}

	async queryRecordStatsDrilldown(
		filter: CatalogRecordStatsFilter,
		page: CatalogFunctionPageRequest,
	): Promise<CatalogMemoPage> {
		const { query, fromDate, toDate } = buildRecordStatsCatalogQuery(filter);
		if (page.text?.trim()) query.text = page.text.trim();
		if (!await this.getCoverageForRange(fromDate, toDate)) return this.createCoveragePendingPage(query);
		const request = { ...query, limit: page.limit, cursor: page.cursor ?? null };
		if (filter.type !== "references") return this.query(request);
		return this.queryFiltered(request, (memo) => (
			memo.sourceMemoId !== null || memo.observation.explicitReferenceTargets.length > 0
		));
	}

	async countRecordStatsDrilldown(
		filter: CatalogRecordStatsFilter,
		text?: string,
	): Promise<CatalogMemoCountResult> {
		const { query, fromDate, toDate } = buildRecordStatsCatalogQuery(filter);
		if (text?.trim()) query.text = text.trim();
		if (!await this.getCoverageForRange(fromDate, toDate)) {
			return this.createUnavailableCount(await this.options.catalog.getStore().getCoverage());
		}
		if (filter.type !== "references") return this.count(query);
		return this.countFiltered(query, (memo) => (
			memo.sourceMemoId !== null || memo.observation.explicitReferenceTargets.length > 0
		));
	}

	async getDeletedSummary(): Promise<{ count: number; ids: string[] }> {
		const records = await this.listVisibleDeletes();
		return { count: records.length, ids: [...new Set(records.map((item) => item.memoId))].sort() };
	}

	async listDeleted(limit: number, cursor: string | null = null): Promise<TrashMemoPage> {
		const records = await this.listVisibleDeletes();
		const identitySnapshot = this.options.identityLedger.getSnapshot();
		const offset = cursor === null ? 0 : Math.max(0, Number.parseInt(cursor, 10) || 0);
		const selected = records.slice(offset, offset + Math.max(0, limit));
		const nextOffset = offset + selected.length;
		return {
			items: selected.map((record): TrashMemoItem => ({
				key: `${record.memoId}:${record.deleteEventId}`,
				memoId: record.memoId,
				deleteEventId: record.deleteEventId,
				createdAt: readTrashCreatedAt(record, identitySnapshot),
				deletedAt: record.evidence.deletedAt,
				deleteSource: record.evidence.deletedSourceRevision === null ? "unknown" : "knomo_ui",
				logicalDate: record.evidence.logicalDate,
				sourcePath: record.evidence.sourcePath,
				section: record.evidence.section,
				content: readDeletedPayloadContent(record.evidence.rawBlock),
				contentHash: record.evidence.contentHash,
				sourceMemoId: record.evidence.sourceMemoId,
				purgeAllowed: identitySnapshot.memos[record.memoId]?.conflicted === false,
			})),
			nextCursor: nextOffset < records.length ? String(nextOffset) : null,
			identityRevision: this.options.identityLedger.getRevision(),
		};
	}

	async listAllDeleted(): Promise<TrashMemoItem[]> {
		const items: TrashMemoItem[] = [];
		let cursor: string | null = null;
		let revision: string | null = null;
		do {
			const page = await this.listDeleted(150, cursor);
			if (revision !== null && page.identityRevision !== revision) {
				items.length = 0;
				cursor = null;
				revision = null;
				continue;
			}
			revision = page.identityRevision;
			items.push(...page.items);
			cursor = page.nextCursor;
		} while (cursor !== null);
		return items;
	}

	async queryTimeBuoysForDate(targetDate: string): Promise<TimeBuoyQueryResult> {
		const memos = await this.queryAllItems({ timeBuoyDate: targetDate, limit: 150 });
		const coverage = await this.options.catalog.getStore().getCoverage();
		return {
			items: memos.map((memo) => ({ memo: toCatalogMemoView(memo), instance: buildTimeBuoyInstance(memo, targetDate) })),
			stale: [],
			missingPeriods: isDateCovered(coverage, targetDate) ? [] : [targetDate.slice(0, 7)],
		};
	}

	async queryAllTimeBuoys(): Promise<TimeBuoyAllQueryResult> {
		const memos = await this.queryAllItems({ hasTimeBuoy: true, limit: 150 });
		return {
			items: memos.flatMap((memo) => memo.timeBuoyDates.map((targetDate) => ({
				memo: toCatalogMemoView(memo),
				instance: buildTimeBuoyInstance(memo, targetDate),
			}))).sort((left, right) => left.instance.targetDate.localeCompare(right.instance.targetDate)
				|| right.memo.createdAt.localeCompare(left.memo.createdAt)),
			stale: [],
			missingPeriods: [],
			complete: isCompleteCoverage(await this.options.catalog.getStore().getCoverage()),
		};
	}

	async buildRecordStats(
		yieldToUi: () => Promise<void>,
		isCurrent: () => boolean,
	): Promise<PreparedRecordStats | null> {
		while (isCurrent()) {
			await this.requireCompleteCoverage("Record statistics");
			const aggregates = await this.options.catalog.listDailyAggregates();
			await this.requireCompleteCoverage("Record statistics");
			const prepared = buildPreparedRecordStats(aggregates);
			let cursor: CatalogFeatureQuery["cursor"] = null;
			let invalidated = false;
			do {
				if (!isCurrent()) return null;
				const page = await this.query({ limit: 150, cursor });
				if (page.invalidated) {
					invalidated = true;
					break;
				}
				if (page.capabilities.stats !== "complete") throw new Error("Record statistics require complete Catalog coverage.");
				for (const memo of page.items) {
					if (memo.sourceMemoId === null || memo.observation.explicitReferenceTargets.length > 0) continue;
					const daily = prepared.daily.get(memo.observation.logicalDate);
					if (daily !== undefined) daily.referenceMemoCount += 1;
				}
				cursor = page.nextCursor;
				await yieldToUi();
			} while (cursor !== null);
			if (!invalidated) return prepared;
		}
		return null;
	}

	async getRandomReunionItems(
		count: number,
		preparation: RandomReunionPreparationOptions = {},
	): Promise<MemoViewItem[]> {
		await this.requireCompleteCoverage("Random reunion");
		while (true) {
			const pool = await this.loadRandomReunionCandidatePool();
			const coverage = await this.requireCompleteCoverage("Random reunion");
			const today = formatDatePart(this.now());
			const catalogCapabilities = createCatalogCapabilities(coverage);
			const candidates = pool.observations
				.filter((observation) => observation.logicalDate < today)
				.map((observation) => this.toMemoItem(this.resolveObservation(observation), catalogCapabilities));
			const eligibleCandidates = candidates.filter((candidate) => isRandomReunionReviewable(candidate)
				|| (preparation.prepareIdentity !== undefined && isRandomReunionAdoptable(candidate)));
			const reviews: MemoReviewStateMap = {};
			for (const candidate of eligibleCandidates) {
				if (candidate.memoId === null) continue;
				const review = this.options.identityLedger.getReviewState(candidate.memoId);
				reviews[candidate.memoId] = review.lastReviewedAt === null
					? { memoId: candidate.memoId, reviewCount: review.reviewCount }
					: { memoId: candidate.memoId, reviewCount: review.reviewCount, lastReviewedAt: review.lastReviewedAt };
			}
			const candidateItems = new Map(eligibleCandidates.map((candidate) => [candidate.key, candidate]));
			const selected = getRandomReunionMemos(eligibleCandidates.map(toCatalogMemoView), reviews, count, {
				today: this.now(),
				random: this.random,
			});
			if (!await this.isRandomReunionCandidatePoolCurrent(pool)) {
				if (this.randomReunionCandidatePool === pool) this.randomReunionCandidatePool = null;
				continue;
			}
			const needsIdentity = selected.some((memo) => {
				const candidate = candidateItems.get(memo.id);
				return candidate !== undefined && !isRandomReunionReviewable(candidate);
			});
			if (needsIdentity) preparation.onPreparingIdentity?.();
			const prepared: MemoViewItem[] = [];
			for (const memo of selected) {
				const candidate = candidateItems.get(memo.id);
				if (candidate === undefined) continue;
				const ready = isRandomReunionReviewable(candidate)
					? candidate
					: await preparation.prepareIdentity?.(candidate);
				if (ready === undefined || !isRandomReunionReviewable(ready)) {
					throw new Error("Random reunion identity preparation did not produce a reviewable memo.");
				}
				prepared.push(toCatalogMemoView(ready));
			}
			await this.requireCompleteCoverage("Random reunion");
			return prepared;
		}
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
		return items.map(toCatalogMemoView);
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
		return this.resolveObservation(observation);
	}

	async resolveMemoItemInFile(sourcePath: string, startLine: number): Promise<CatalogMemoItem> {
		const resolved = await this.resolveObservationInFile(sourcePath, startLine);
		const coverage = await this.options.catalog.getStore().getCoverage();
		return this.toMemoItem(resolved, createCatalogCapabilities(coverage));
	}

	private resolveObservation(observation: CatalogObservation): ResolvedMemo {
		const state = this.options.identityLedger.resolveObservationState(observation);
		if (state.kind === "identified") return createResolvedMemo(observation, state.binding);
		if (state.kind === "conflicted") {
			const snapshot = this.options.identityLedger.getSnapshot();
			const repairable = state.memoIds.some((memoId) => {
				const memo = snapshot.memos[memoId];
				return memo?.conflicted === true && memo.conflictBaseBindingId !== null;
			});
			return createConflictedMemo(observation, state.memoIds, this.options.identityLedger.getRevision(), repairable);
		}
		const status = this.options.identityLedger.getStatus();
		const adoption = status === "ready" || status === "absent" ? "eligible" : "settling";
		return {
			kind: "observed",
			identityHandle: null,
			observation,
			adoption,
			capabilities: createResolvedMemoCapabilities(adoption === "eligible" ? "absent" : "syncing"),
			identityRevision: this.options.identityLedger.getRevision(),
		};
	}

	private toMemoItem(resolved: ResolvedMemo, catalogCapabilities: CatalogCapabilities): CatalogMemoItem {
		const observation = resolved.observation as CatalogObservation;
		const memoId = resolved.identityHandle?.memoId ?? null;
		return {
			key: memoId ?? observation.observationKey,
			renderKey: observation.observationKey,
			memoId,
			identityHandle: resolved.identityHandle,
			observationHandle: {
				sourcePath: observation.sourcePath,
				sourceRevision: observation.sourceRevision,
				startLine: observation.startLine,
				endLine: observation.endLine,
				rawBlockHash: observation.rawBlockHash,
			},
			createdAt: memoId === null
				? `${observation.logicalDate}T${normalizeTime(observation.time)}`
				: this.options.identityLedger.getCreatedAt(memoId)
					?? `${observation.logicalDate}T${normalizeTime(observation.time)}`,
			content: observation.content,
			tags: [...observation.tags],
			links: [...observation.links],
			images: [...observation.images],
			tasks: [...observation.tasks],
			timeBuoyDates: [...observation.timeBuoyDates],
			sourcePath: observation.sourcePath,
			lineNumberHint: observation.startLine + 1,
			sourceMemoId: memoId === null ? null : this.options.identityLedger.getSourceMemoId(memoId),
			capabilities: { ...resolved.capabilities, catalog: catalogCapabilities },
			resolved,
			observation,
		};
	}

	private async createUnavailablePage(): Promise<CatalogMemoPage> {
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
		return this.rememberPage({
			items: [],
			nextCursor: null,
			catalogRevision: 0,
			identityRevision: this.options.identityLedger.getRevision(),
			coverage,
			lifecycle,
			capabilities: createCatalogCapabilities(coverage),
			status: this.getReadStatus(coverage, lifecycle, [], true),
			readState: "storage_unavailable",
			degraded: true,
			invalidated: false,
		});
	}

	private async createUnavailableCount(
		knownCoverage?: CatalogCoverage,
	): Promise<CatalogMemoCountResult> {
		const coverage = knownCoverage ?? await this.options.catalog.getStore().getCoverage().catch((): CatalogCoverage => ({
			kind: "partial",
			coveredFromDate: null,
			pendingFileCount: 0,
			coveredFileCount: 0,
			totalFileCount: 0,
		}));
		return {
			count: null,
			complete: false,
			catalogRevision: 0,
			identityRevision: this.options.identityLedger.getRevision(),
			coverage,
		};
	}

	private async createCoveragePendingPage(
		request: Omit<CatalogFeatureQuery, "limit" | "cursor">,
	): Promise<CatalogMemoPage> {
		const page = await this.query({ ...request, limit: 1, cursor: null });
		return this.rememberPage({
			...page,
			items: [],
			nextCursor: null,
			readState: page.readState === "storage_unavailable" ? page.readState : "history_building",
			status: { ...page.status, content: page.status.content === "unavailable" ? "unavailable" : "scanning" },
		});
	}

	private async queryFiltered(
		request: CatalogFeatureQuery,
		predicate: (memo: CatalogMemoItem) => boolean,
	): Promise<CatalogMemoPage> {
		const limit = Math.max(1, Math.min(150, Math.trunc(request.limit)));
		const items: CatalogMemoItem[] = [];
		let cursor = request.cursor ?? null;
		let lastPage: CatalogMemoPage | null = null;
		do {
			const page = await this.query({ ...request, limit: 150, cursor });
			lastPage = page;
			if (page.invalidated) return page;
			for (let index = 0; index < page.items.length; index += 1) {
				const memo = page.items[index];
				if (memo === undefined || !predicate(memo)) continue;
				items.push(memo);
				if (items.length === limit) {
					const hasMore = index < page.items.length - 1 || page.nextCursor !== null;
					return {
						...page,
						items,
						nextCursor: hasMore ? { catalog: {
							catalogRevision: page.catalogRevision,
							createdAtKey: memo.observation.createdAtKey,
							observationKey: memo.observation.observationKey,
						} } : null,
					};
				}
			}
			cursor = page.nextCursor;
		} while (cursor !== null);
		return lastPage === null ? this.query(request) : { ...lastPage, items, nextCursor: null };
	}

	private async countFiltered(
		request: CatalogFeatureFilter,
		predicate: (memo: CatalogMemoItem) => boolean,
	): Promise<CatalogMemoCountResult> {
		let cursor: CatalogFeatureCursor | null = null;
		let count = 0;
		let catalogRevision: number | null = null;
		let identityRevision: string | null = null;
		let coverage: CatalogCoverage | null = null;
		do {
			const page = await this.query({ ...request, limit: 150, cursor });
			if (page.invalidated
				|| (catalogRevision !== null && catalogRevision !== page.catalogRevision)
				|| (identityRevision !== null && identityRevision !== page.identityRevision)) {
				return {
					count: null,
					complete: false,
					catalogRevision: page.catalogRevision,
					identityRevision: page.identityRevision,
					coverage: page.coverage,
				};
			}
			catalogRevision = page.catalogRevision;
			identityRevision = page.identityRevision;
			coverage = page.coverage;
			count += page.items.filter(predicate).length;
			cursor = page.nextCursor;
		} while (cursor !== null);
		if (catalogRevision === null || identityRevision === null || coverage === null) {
			return this.createUnavailableCount();
		}
		const complete = isQueryCovered(coverage, request);
		return {
			count: complete ? count : null,
			complete,
			catalogRevision,
			identityRevision,
			coverage,
		};
	}

	private getReadStatus(
		coverage: CatalogCoverage,
		lifecycle: CatalogStoreLifecycle,
		resolved: readonly ResolvedMemo[],
		contentUnavailable: boolean,
	): CatalogReadStatus {
		const identityStatus = this.options.identityLedger.getStatus();
		const legacyStatus = this.options.getLegacyImportStatus?.() ?? "not_applicable";
		const catalogDegraded = contentUnavailable
			|| lifecycle.state === "degraded"
			|| lifecycle.state === "retrying"
			|| lifecycle.state === "read-only";
		const observationConflicted = resolved.some((memo) => memo.kind === "ambiguous");
		const identityConflicted = identityStatus === "conflicted" || observationConflicted;
		const identityConflict = identityStatus === "conflicted"
			? "ledger" as const
			: observationConflicted ? "observation" as const : null;
		return {
			settings: this.getSettingsStatus(),
			content: contentUnavailable
				? "unavailable"
				: coverage.kind === "complete" && lifecycle.state !== "opening" && lifecycle.state !== "rebuilding"
					? "ready"
					: "scanning",
			catalog: catalogDegraded
				? "degraded"
				: coverage.kind === "complete" && coverage.sharedConfigurationComplete !== false ? "complete" : "partial",
			identity: identityConflicted
				? "conflicted"
				: identityStatus === "ready" ? "ready"
					: identityStatus === "missing" || identityStatus === "absent" ? "absent" : "syncing",
			identityConflict,
			sharedConfiguration: this.getSharedConfigurationStatus(),
			projection: this.getProjectionState(),
			migration: legacyStatus === "attention"
				? "attention"
				: legacyStatus === "unavailable" ? "unavailable" : "none",
		};
	}

	private getSettingsStatus(): KnomoSettingsLoadStatus {
		try {
			return this.options.getSettingsStatus?.() ?? "ready";
		} catch {
			return "unavailable";
		}
	}

	private getSharedConfigurationStatus(): KnomoSharedConfigStatus {
		try {
			return this.options.getSharedConfigurationStatus?.() ?? "missing";
		} catch {
			return "unavailable";
		}
	}

	private getProjectionState(): MonthlyProjectionState {
		try {
			return this.options.getProjectionState?.() ?? "ready";
		} catch {
			return "failed";
		}
	}

	private getReadState(coverage: CatalogCoverage, lifecycle: CatalogStoreLifecycle): CatalogReadState {
		if (lifecycle.state === "degraded" || lifecycle.state === "retrying" || lifecycle.state === "read-only") {
			return "storage_unavailable";
		}
		return coverage.kind === "complete" ? "ready" : "history_building";
	}

	private async queryAllItems(
		request: Omit<CatalogFeatureQuery, "cursor">,
		maximum = Number.MAX_SAFE_INTEGER,
	): Promise<CatalogMemoItem[]> {
		const items: CatalogMemoItem[] = [];
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

	private async loadRandomReunionCandidatePool(): Promise<RandomReunionCandidatePool> {
		if (this.randomReunionCandidatePool !== null) return this.randomReunionCandidatePool;
		if (this.randomReunionCandidatePoolLoad !== null) return this.randomReunionCandidatePoolLoad;
		const load = this.buildRandomReunionCandidatePool();
		this.randomReunionCandidatePoolLoad = load;
		try {
			return await load;
		} finally {
			if (this.randomReunionCandidatePoolLoad === load) {
				this.randomReunionCandidatePoolLoad = null;
			}
		}
	}

	private async buildRandomReunionCandidatePool(): Promise<RandomReunionCandidatePool> {
		while (true) {
			let page = await this.queryRandomReunionObservations(null, 150);
			this.requireRandomReunionCoverage(page.coverage);
			const catalogRevision = page.catalogRevision;
			const observations = [...page.items];
			let invalidated = page.invalidated;
			while (!invalidated && page.nextCursor !== null) {
				page = await this.queryRandomReunionObservations(page.nextCursor, 150);
				if (page.invalidated || page.catalogRevision !== catalogRevision) {
					invalidated = true;
					break;
				}
				this.requireRandomReunionCoverage(page.coverage);
				observations.push(...page.items);
			}
			if (invalidated) continue;
			const verification = await this.queryRandomReunionObservations(null, 1);
			this.requireRandomReunionCoverage(verification.coverage);
			if (verification.catalogRevision !== catalogRevision) continue;
			const pool = { catalogRevision, observations };
			this.randomReunionCandidatePool = pool;
			return pool;
		}
	}

	private async isRandomReunionCandidatePoolCurrent(pool: RandomReunionCandidatePool): Promise<boolean> {
		const page = await this.queryRandomReunionObservations(null, 1);
		this.requireRandomReunionCoverage(page.coverage);
		return page.catalogRevision === pool.catalogRevision;
	}

	private async queryRandomReunionObservations(
		cursor: CatalogQueryPage["nextCursor"],
		limit: number,
	): Promise<CatalogQueryPage> {
		try {
			return await this.options.catalog.query({ limit, cursor });
		} catch (error) {
			void Promise.resolve().then(() => this.options.requestObservationScan?.()).catch(() => undefined);
			throw error;
		}
	}

	private requireRandomReunionCoverage(coverage: CatalogCoverage): void {
		if (!isCompleteCoverage(coverage)) throw new Error("Random reunion requires complete Catalog coverage.");
	}

	private async requireCompleteCoverage(feature: string): Promise<CatalogCoverage> {
		const coverage = await this.options.catalog.getStore().getCoverage();
		if (!isCompleteCoverage(coverage)) throw new Error(`${feature} requires complete Catalog coverage.`);
		return coverage;
	}

	private async listVisibleDeletes() {
		const activeDeletes = this.options.identityLedger.getActiveDeletes?.() ?? [];
		if (activeDeletes.length === 0) return [];
		const identitySnapshot = this.options.identityLedger.getSnapshot();
		const memoIds = [...new Set(activeDeletes.map((record) => record.memoId))];
		const visibleMemoIds = new Set((await Promise.all(memoIds.map(async (memoId) =>
			await this.hasCurrentObservation(memoId, identitySnapshot) ? memoId : null)))
			.filter((memoId): memoId is string => memoId !== null));
		return activeDeletes
			.filter((record) => !visibleMemoIds.has(record.memoId))
			.sort((left, right) => right.evidence.deletedAt.localeCompare(left.evidence.deletedAt)
				|| left.deleteEventId.localeCompare(right.deleteEventId));
	}

	private async hasCurrentObservation(memoId: string, snapshot: IdentityLedgerSnapshot): Promise<boolean> {
		const memo = snapshot.memos[memoId];
		if (memo === undefined) return false;
		for (const binding of memo.bindings) {
			const observationKey = `${binding.evidence.sourcePath}\0${binding.evidence.startLine.toString().padStart(10, "0")}`;
			const observation = await this.options.catalog.getObservation(observationKey);
			if (observation === null) continue;
			const state = this.options.identityLedger.resolveObservationState(observation);
			if (state.kind === "identified" && state.binding.memoId === memoId) return true;
		}
		return false;
	}

	private rememberPage(page: CatalogMemoPage): CatalogMemoPage {
		this.lastReadState = page.readState;
		return page;
	}
}

function createResolvedMemo(observation: CatalogObservation, binding: IdentityLedgerBinding): ResolvedMemo {
	return {
		kind: "identified",
		identityHandle: {
			memoId: binding.memoId,
			activeBindingId: binding.bindingId,
			identityRevision: binding.identityRevision,
		},
		observation,
		bindingEvidence: observationEvidence(observation),
		capabilities: createIdentityLedgerMemoCapabilities(),
		identityRevision: binding.identityRevision,
	};
}

function createConflictedMemo(
	observation: CatalogObservation,
	memoIds: readonly string[],
	identityRevision: string,
	repairable: boolean,
): ResolvedMemo {
	return {
		kind: "ambiguous",
		identityHandle: null,
		observation,
		candidates: [...new Set(memoIds)].sort().map((memoId) => ({ memoId, source: "manual_successor" as const })),
		reason: "manual_successor",
		capabilities: repairable ? createIdentityLedgerConflictCapabilities() : createResolvedMemoCapabilities("conflicted"),
		identityRevision,
	};
}

function observationEvidence(observation: CatalogObservation): ResolvedIdentityEvidence {
	return {
		sourcePath: observation.sourcePath,
		sourceRevision: observation.sourceRevision,
		logicalDate: observation.logicalDate,
		section: observation.section,
		startLine: observation.startLine,
		endLine: observation.endLine,
		time: observation.time,
		contentHash: observation.contentHash,
		existingBlockId: observation.existingBlockId,
	};
}

function normalizeTime(time: string): string {
	return time.length === 5 ? `${time}:00` : time;
}

function readTrashCreatedAt(record: IdentityLedgerDeleteRecord, snapshot: IdentityLedgerSnapshot): string {
	const memo = snapshot.memos[record.memoId];
	if (memo?.createdAt !== null && memo?.createdAt !== undefined) return memo.createdAt;
	const bindingTime = memo?.bindings.find((binding) => binding.bindingId === record.baseBindingId)?.evidence.time;
	const payloadTime = /^- ((?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?)(?:\s|$)/u
		.exec(record.evidence.rawBlock.split(/\r?\n/u, 1)[0] ?? "")?.[1];
	return `${record.evidence.logicalDate}T${normalizeTime(bindingTime ?? payloadTime ?? "00:00")}`;
}

function readDeletedPayloadContent(rawBlock: string): string {
	const lines = rawBlock.split(/\r?\n/u);
	const first = /^- (?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?(?:\s(.*))?$/u.exec(lines[0] ?? "")?.[1] ?? "";
	const continuation = lines.slice(1).map((line) => line.replace(/^ {2}/u, ""));
	return [first, ...continuation].join("\n").replace(/\s+\^[A-Za-z0-9-]+\s*$/u, "").trim();
}

function buildTimeBuoyInstance(memo: CatalogMemoItem, targetDate: string) {
	return { memoId: memo.memoId ?? memo.key, targetDate };
}

function buildReviewCatalogQuery(date: Date, text?: string): CatalogFeatureFilter {
	const logicalDate = formatDatePart(date);
	const query: CatalogFeatureFilter = {
		toDate: formatDatePart(new Date(date.getFullYear(), date.getMonth(), date.getDate() - 1)),
		...(date.getMonth() === 1 && date.getDate() === 29
			? { monthDay: "02-29" }
			: { dayOfMonth: logicalDate.slice(8) }),
	};
	if (text?.trim()) query.text = text.trim();
	return query;
}

function isDateCovered(coverage: CatalogCoverage, logicalDate: string): boolean {
	return isRangeCovered(coverage, logicalDate, logicalDate);
}

function isCompleteCoverage(coverage: CatalogCoverage): boolean {
	return coverage.kind === "complete" && coverage.sharedConfigurationComplete !== false;
}

function isQueryCovered(coverage: CatalogCoverage, request: CatalogFeatureFilter): boolean {
	if (isCompleteCoverage(coverage)) return true;
	return request.fromDate !== undefined
		&& coverage.coveredFromDate !== null
		&& request.fromDate >= coverage.coveredFromDate
		&& coverage.sharedConfigurationComplete !== false;
}

function isRangeCovered(coverage: CatalogCoverage, fromDate: string, toDate: string): boolean {
	if (fromDate > toDate || coverage.sharedConfigurationComplete === false) return false;
	return isCompleteCoverage(coverage)
		|| (coverage.coveredFromDate !== null && fromDate >= coverage.coveredFromDate);
}

function isRandomReunionReviewable(candidate: CatalogMemoItem): boolean {
	return candidate.memoId !== null
		&& candidate.identityHandle !== null
		&& candidate.capabilities.identity.review === "ready";
}

function isRandomReunionAdoptable(candidate: CatalogMemoItem): boolean {
	return candidate.resolved.kind === "observed" && candidate.resolved.adoption === "eligible";
}

function buildRecordStatsCatalogQuery(filter: CatalogRecordStatsFilter): {
	query: Omit<CatalogFeatureQuery, "limit" | "cursor">;
	fromDate: string;
	toDate: string;
} {
	if (filter.type === "day") {
		return { query: { fromDate: filter.date, toDate: filter.date }, fromDate: filter.date, toDate: filter.date };
	}
	if (filter.type === "month") {
		const fromDate = `${filter.month}-01`;
		const toDate = getMonthEndDate(filter.month);
		return { query: { fromDate, toDate }, fromDate, toDate };
	}
	if (filter.type === "max-daily-notes" || filter.type === "max-daily-words") {
		const dates = [...new Set(filter.dates)].sort();
		const fromDate = dates[0] ?? "0000-01-01";
		const toDate = dates[dates.length - 1] ?? "9999-12-31";
		return { query: { fromDate, toDate, logicalDates: dates }, fromDate, toDate };
	}
	const fromDate = filter.startDate;
	const toDate = getPreviousDate(filter.endDateExclusive);
	const query: Omit<CatalogFeatureQuery, "limit" | "cursor"> = { fromDate, toDate };
	if (filter.type === "with-tag") query.hasTag = true;
	if (filter.type === "no-tag") query.hasTag = false;
	if (filter.type === "with-image") query.hasImage = true;
	if (filter.type === "tag") query.tags = [filter.tagKey];
	if (filter.type === "hour") query.hour = filter.hour;
	return { query, fromDate, toDate };
}

function buildPreparedRecordStats(aggregates: readonly CatalogDailyAggregate[]): PreparedRecordStats {
	const daily = new Map<string, DailyRecordStats>();
	const tagDisplayNames = new Map<string, string>();
	let memoCount = 0;
	let wordCount = 0;
	let earliestYear: number | null = null;
	for (const aggregate of aggregates) {
		if (aggregate.memoCount <= 0) continue;
		memoCount += aggregate.memoCount;
		wordCount += aggregate.wordCount ?? 0;
		const year = Number.parseInt(aggregate.logicalDate.slice(0, 4), 10);
		if (Number.isInteger(year)) earliestYear = earliestYear === null ? year : Math.min(earliestYear, year);
		for (const [key, label] of Object.entries(aggregate.tagDisplayNames ?? {})) {
			if (!tagDisplayNames.has(key)) tagDisplayNames.set(key, label);
		}
		daily.set(aggregate.logicalDate, {
			memoCount: aggregate.memoCount,
			wordCount: aggregate.wordCount ?? 0,
			referenceMemoCount: aggregate.explicitReferenceMemoCount ?? 0,
			taggedMemoCount: aggregate.taggedMemoCount ?? 0,
			untaggedMemoCount: aggregate.untaggedMemoCount ?? 0,
			imageMemoCount: aggregate.imageMemoCount ?? 0,
			hourCounts: Array.from({ length: 24 }, (_, hour) => aggregate.hourCounts?.[hour] ?? 0),
			tagMemoCounts: new Map(Object.entries(aggregate.tagMemoCounts ?? {})),
		});
	}
	return {
		overview: { memoCount, wordCount, recordDayCount: daily.size },
		daily,
		earliestYear,
		tagDisplayNames,
	};
}

function getMonthEndDate(month: string): string {
	const year = Number.parseInt(month.slice(0, 4), 10);
	const monthNumber = Number.parseInt(month.slice(5, 7), 10);
	return formatDatePart(new Date(year, monthNumber, 0));
}

function getPreviousDate(logicalDate: string): string {
	const year = Number.parseInt(logicalDate.slice(0, 4), 10);
	const month = Number.parseInt(logicalDate.slice(5, 7), 10);
	const day = Number.parseInt(logicalDate.slice(8, 10), 10);
	return formatDatePart(new Date(year, month - 1, day - 1));
}

function sumAggregates(
	aggregates: readonly CatalogDailyAggregate[],
	getValue: (aggregate: CatalogDailyAggregate) => number,
): number {
	return aggregates.reduce((total, aggregate) => total + getValue(aggregate), 0);
}

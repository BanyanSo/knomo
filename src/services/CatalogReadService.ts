import type {
	CatalogCoverage,
	CatalogDailyAggregate,
	CatalogObservation,
	CatalogObservationSnapshot,
	CatalogCapabilities,
	CatalogQueryPage,
	CatalogStoreLifecycle,
	ResolvedMemo,
	ObservationHandle,
} from "../types/catalog";
import type {
	CatalogFeatureCursor,
	CatalogFeatureFilter,
	CatalogFeatureQuery,
	CatalogLibrarySummary,
	CatalogLibraryIndexesResult,
	CatalogMemoItem,
	CatalogMemoCountResult,
	CatalogMemoPage,
	CatalogRecordStatsFilter,
	CatalogReadState,
	CatalogReadStatus,
	KnomoRuntimeAttentionSnapshot,
	MonthlyProjectionState,
	CatalogTagFacet,
} from "../types/catalogView";
import type { LegacyMigrationStatus } from "../types/legacyMigration";
import type { KnomoStartupBootstrapSnapshot } from "./KnomoStartupBootstrapService";
import type { KnomoCurrentConfigStatus } from "../types/knomoConfig";
import type { MemoViewItem } from "../types/memoView";
import type { KnomoSettingsLoadStatus } from "../types/settings";
import { toCatalogMemoView } from "../types/memoView";
import type { TimeBuoyPageRequest, TimeBuoyPageResult, TimeBuoyQueryResult } from "../types/timeBuoy";
import { getTimeBuoyTabDates } from "./TimeBuoyQuery";
import { formatDatePart } from "../utils/date";
import { t } from "../i18n";
import { filterRandomReunionCandidates, sampleRandomReunionCandidates } from "../utils/randomReunion";
import type { RandomReunionCandidate } from "../utils/randomReunion";
import { CooperativeYieldController } from "./CooperativeTask";
import { LocalMemoReviewStore } from "./LocalMemoReviewStore";
import {
	createCatalogCapabilities,
	createResolvedMemoCapabilities,
} from "./MemoCapabilityModel";
import type { CatalogChangeCursor, MemoCatalogService } from "./MemoCatalogService";
import { CATALOG_OBSERVATION_READ_BATCH_LIMIT, CatalogQueryCancelledError, createCatalogCountAbortError } from "./MemoCatalogStore";
import { getCatalogQueryKey, narrowCatalogQuery } from "./SearchMatching";
import type { DailyRecordStats, PreparedRecordStats } from "./RecordStatsService";
import { observationHandleKey } from "./DailyMemoPresentationChange";

export interface CatalogReadServiceOptions {
	reviews?: LocalMemoReviewStore;
	catalog: MemoCatalogService;
	requestObservationScan?: () => void | Promise<void>;
	getProjectionState?: () => MonthlyProjectionState;
	getLegacyImportStatus?: () => LegacyMigrationStatus;
	getLegacyCleanupPending?: () => boolean;
	getCurrentConfigurationStatus?: () => KnomoCurrentConfigStatus;
	getSettingsStatus?: () => KnomoSettingsLoadStatus;
	getStartupBootstrapSnapshot?: () => KnomoStartupBootstrapSnapshot;
	now?: () => Date;
	random?: () => number;
}

export interface CatalogDiscoverySnapshot {
	catalogRevision: number;
	day: string;
	coverage: CatalogCoverage;
}

export class CatalogDiscoveryInvalidatedError extends Error {
	constructor() { super("Catalog discovery snapshot changed."); }
}

interface RandomReunionCandidatePool extends CatalogDiscoverySnapshot {
	changeCursor: CatalogChangeCursor;
	candidates: Array<RandomReunionCandidate & { observationKey: string }>;
}

interface RandomReunionPoolTask {
	controller: AbortController;
	promise: Promise<RandomReunionCandidatePool>;
	consumers: number;
}

interface CountTask {
	controller: AbortController;
	promise: Promise<CatalogMemoCountResult>;
	consumers: number;
}

function yieldToUi(): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, 0));
}

export class CatalogReadService {
	private readonly reviews: LocalMemoReviewStore;
	private readonly now: () => Date;
	private readonly random: () => number;
	private lastReadState: CatalogReadState | null = null;
	private randomReunionCandidatePool: RandomReunionCandidatePool | null = null;
	private randomReunionCandidatePoolLoad: RandomReunionPoolTask | null = null;
	private readonly countCache = new Map<string, CatalogMemoCountResult>();
	private readonly countTasks = new Map<string, CountTask>();

	constructor(private readonly options: CatalogReadServiceOptions) {
		this.reviews = options.reviews ?? new LocalMemoReviewStore();
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
		let currentConfiguration: KnomoRuntimeAttentionSnapshot["currentConfiguration"] = "unavailable";
		let legacyMigration: KnomoRuntimeAttentionSnapshot["legacyMigration"] = "pending";
		let legacyCleanupPending = false;
		let settings: KnomoSettingsLoadStatus = "ready";
		try {
			currentConfiguration = this.options.getCurrentConfigurationStatus?.() ?? "missing";
		} catch {
			// 保留 unavailable。
		}
		try {
			legacyMigration = this.options.getLegacyImportStatus?.() ?? "idle";
			legacyCleanupPending = this.options.getLegacyCleanupPending?.() ?? false;
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
			currentConfiguration,
			monthly: this.getProjectionState(),
			legacyMigration,
			legacyCleanupPending,
		};
	}

	async prime(signal?: AbortSignal): Promise<void> {
		await this.query({ limit: 1 }, signal);
		signal?.throwIfAborted();
	}

	async getFileSourceRevision(sourcePath: string): Promise<string | null> {
		return (await this.options.catalog.getStore().getFile(sourcePath))?.sourceRevision ?? null;
	}

	async query(request: CatalogFeatureQuery, signal?: AbortSignal): Promise<CatalogMemoPage> {
		signal?.throwIfAborted();
		request = { ...request, ...narrowCatalogQuery(request) };
		let page: CatalogQueryPage;
		try {
			page = await this.options.catalog.query({ ...request, cursor: request.cursor?.catalog ?? null }, signal);
		} catch (error) {
			signal?.throwIfAborted();
			if (error instanceof CatalogQueryCancelledError) throw error;
			void Promise.resolve().then(() => { if (!signal?.aborted) return this.options.requestObservationScan?.(); }).catch(() => undefined);
			return this.createUnavailablePage(signal);
		}
		signal?.throwIfAborted();
		if (page.invalidated) {
			return this.rememberPage({
				items: [],
				nextCursor: null,
				catalogRevision: page.catalogRevision,
				coverage: page.coverage,
				lifecycle: page.lifecycle,
				capabilities: createCatalogCapabilities(page.coverage),
				status: this.getReadStatus(page.coverage, page.lifecycle, false),
				readState: this.getReadState(page.coverage, page.lifecycle),
				degraded: true,
				invalidated: true,
			});
		}
		const resolved = page.items.map((observation): ResolvedMemo => ({
			kind: "observation",
			observation,
			capabilities: createResolvedMemoCapabilities(),
		}));
		const status = this.getReadStatus(page.coverage, page.lifecycle, false);
		const catalogCapabilities = createCatalogCapabilities(page.coverage);
		const items = resolved.map(memo => { signal?.throwIfAborted(); return toCatalogMemoItem(memo, catalogCapabilities); });
		signal?.throwIfAborted();
		return this.rememberPage({
			items,
			nextCursor: page.nextCursor === null ? null : { catalog: page.nextCursor },
			catalogRevision: page.catalogRevision,
			coverage: page.coverage,
			lifecycle: page.lifecycle,
			capabilities: catalogCapabilities,
			status,
			readState: this.getReadState(page.coverage, page.lifecycle),
			degraded: status.content === "unavailable" || status.catalog === "degraded",
			invalidated: false,
		});
	}

	async count(request: CatalogFeatureFilter, signal?: AbortSignal): Promise<CatalogMemoCountResult> {
		request = narrowCatalogQuery(request);
		try {
			return await this.cachedCount(request, signal, async (countSignal) => {
				const result = await this.options.catalog.count(request, countSignal);
				const complete = isQueryCovered(result.coverage, request);
				return { count: complete ? result.count : null, complete,
					catalogRevision: result.catalogRevision, coverage: result.coverage };
			});
		} catch {
			signal?.throwIfAborted();
			return this.createUnavailableCount();
		}
	}

	private async cachedCount(request: CatalogFeatureFilter, signal: AbortSignal | undefined,
		load: (signal: AbortSignal) => Promise<CatalogMemoCountResult>, kind = ""): Promise<CatalogMemoCountResult> {
		signal?.throwIfAborted();
		const store = this.options.catalog.getStore();
		const [revision, coverage] = await Promise.all([store.getCatalogRevision(), store.getCoverage()]);
		signal?.throwIfAborted();
		const key = JSON.stringify([kind, getCatalogQueryKey(request),
			revision, coverage, store.getLifecycle()]);
		const cached = this.countCache.get(key);
		if (cached) {
			this.countCache.delete(key);
			this.countCache.set(key, cached);
			return cached;
		}
		let task = this.countTasks.get(key);
		if (!task || task.controller.signal.aborted) {
			const controller = new AbortController();
			const next: CountTask = { controller, consumers: 0, promise: Promise.resolve().then(() => load(controller.signal)) };
			next.promise = next.promise.then(result => {
				if (!controller.signal.aborted && result.complete && result.catalogRevision === revision
					&& JSON.stringify(result.coverage) === JSON.stringify(coverage)) {
					this.countCache.set(key, result);
					if (this.countCache.size > 16) this.countCache.delete(this.countCache.keys().next().value!);
				}
				return result;
			}).finally(() => { if (this.countTasks.get(key) === next) this.countTasks.delete(key); });
			this.countTasks.set(key, next);
			task = next;
		}
		const activeTask = task;
		activeTask.consumers++;
		return new Promise((resolve, reject) => {
			let settled = false;
			const finish = () => {
				if (settled) return false;
				settled = true;
				signal?.removeEventListener("abort", abort);
				if (--activeTask.consumers === 0) activeTask.controller.abort();
				return true;
			};
			// 只有最后一个使用者取消时终止扫描，避免伤及共享计数的其他视图。
			const abort = () => { if (finish()) reject(createCatalogCountAbortError(signal)); };
			signal?.addEventListener("abort", abort, { once: true });
			activeTask.promise.then(result => { if (finish()) resolve(result); }, (error: unknown) => {
				if (finish()) reject(error instanceof Error ? error : new Error(String(error)));
			});
		});
	}

	async getLibraryIndexes(): Promise<CatalogLibraryIndexesResult> {
		const snapshot = await this.options.catalog.readAggregateSnapshot();
		const complete = !snapshot.invalidated && isCompleteCoverage(snapshot.coverage)
			&& snapshot.lifecycle.state === "ready";
		return {
			value: complete ? { summary: buildLibrarySummary(snapshot.aggregates), facets: buildTagFacets(snapshot.aggregates) } : null,
			complete, catalogRevision: snapshot.catalogRevision, coverage: snapshot.coverage,
			lifecycle: snapshot.lifecycle, invalidated: snapshot.invalidated,
		};
	}

	async getCoverageForRange(fromDate: string, toDate: string): Promise<boolean> {
		const coverage = await this.options.catalog.getStore().getCoverage();
		return isRangeCovered(coverage, fromDate, toDate);
	}

	async queryTimeBuoysForDate(targetDate: string, cursor?: TimeBuoyPageRequest["cursor"], signal?: AbortSignal): Promise<TimeBuoyQueryResult> {
		const page = await this.queryTimeBuoyPage({ today: targetDate, tab: "today", limit: 30, cursor }, signal);
		signal?.throwIfAborted();
		// 任意历史 Daily 都可能含有指向今天的浮标；分页完成和索引覆盖分开判断。
		return { ...page, missingPeriods: page.complete ? [] : [targetDate.slice(0, 7)] };
	}

	async queryTimeBuoyPage(request: TimeBuoyPageRequest, signal?: AbortSignal): Promise<TimeBuoyPageResult> {
		signal?.throwIfAborted();
		const page = await this.options.catalog.getStore().queryTimeBuoys(request, signal);
		signal?.throwIfAborted();
		const { coverage, catalogRevision } = page;
		let invalidated = page.invalidated || this.getReadState(coverage, page.lifecycle) === "storage_unavailable";
		const capabilities = createCatalogCapabilities(coverage);
		const memos = invalidated ? [] : page.items.map(observation => {
			signal?.throwIfAborted();
			return toCatalogMemoItem({ kind: "observation", observation, capabilities: createResolvedMemoCapabilities() }, capabilities);
		});
		const store = this.options.catalog.getStore();
		const [currentRevision, currentCoverage] = await Promise.all([store.getCatalogRevision(), store.getCoverage()]);
		signal?.throwIfAborted();
		invalidated ||= currentRevision !== catalogRevision || JSON.stringify(currentCoverage) !== JSON.stringify(coverage)
			|| this.getReadState(currentCoverage, store.getLifecycle()) === "storage_unavailable";
		return {
			catalogRevision, coverage, invalidated,
			nextCursor: invalidated ? null : page.nextCursor,
			metrics: page.metrics,
			items: invalidated ? [] : memos.flatMap((memo) => getTimeBuoyTabDates(memo.timeBuoyDates, request).map((targetDate) => ({
				memo: toCatalogMemoView(memo),
				instance: buildTimeBuoyInstance(memo, targetDate),
			}))),
			stale: [],
			missingPeriods: [],
			complete: !invalidated && isCompleteCoverage(coverage),
		};
	}

	async buildRecordStats(
		yieldToUi: () => Promise<void>,
		isCurrent: () => boolean,
	): Promise<PreparedRecordStats | null> {
		if (!isCurrent()) return null;
		await this.requireCompleteCoverage("Record statistics");
		const aggregates = await this.options.catalog.listDailyAggregates();
		await this.requireCompleteCoverage("Record statistics");
		await yieldToUi();
		return isCurrent() ? buildPreparedRecordStats(aggregates) : null;
	}

	async getRandomReunionItems(count: number, options: {
		shownBatches?: readonly (readonly string[])[]; signal?: AbortSignal;
	} = {}): Promise<MemoViewItem[]> {
		for (let attempt = 0; attempt < 3; attempt++) {
			options.signal?.throwIfAborted();
			const now = this.now();
			try {
				const coverage = await this.requireCompleteCoverage("Random reunion");
				options.signal?.throwIfAborted();
				const pool = await this.loadRandomReunionCandidatePool(now, coverage, options.signal);
				const selected = await sampleRandomReunionCandidates(pool.candidates, this.reviews.read(), count, {
					today: now, random: this.random, ...options,
				}, { yieldControl: yieldToUi, maxOperationsPerSlice: 4096 });
				const capabilities = createCatalogCapabilities(pool.coverage);
				const snapshot = await this.readObservationSnapshots(selected.map(candidate => candidate.observationKey), options.signal);
				if (snapshot.catalogRevision !== pool.catalogRevision || JSON.stringify(snapshot.coverage) !== JSON.stringify(pool.coverage)
					|| snapshot.storeGeneration !== pool.changeCursor.storeGeneration) throw new CatalogDiscoveryInvalidatedError();
				const items = selected.map((candidate, index) => {
					const observation = snapshot.observations[index];
					if (observation === null || observationLocalKey(observation) !== candidate.id) throw new CatalogDiscoveryInvalidatedError();
					return toCatalogMemoView(toCatalogMemoItem(this.resolveObservation(observation), capabilities));
				});
				if (!await this.isRandomReunionPoolCurrent(pool, options.signal)) throw new CatalogDiscoveryInvalidatedError();
				return items;
			} catch (error) {
				options.signal?.throwIfAborted();
				if (!(error instanceof CatalogDiscoveryInvalidatedError)) throw error;
				this.randomReunionCandidatePool = null;
			}
		}
		throw new Error(t("error.revisitChanged"));
	}

	// 只读取页面已经选中的句柄，不以旧行号、正文 hash 或当前查询结果重定位 occurrence。
	async readMemoItems(handles: readonly ObservationHandle[], signal?: AbortSignal): Promise<CatalogMemoItem[]> {
		const items = await this.readMemoHandles(handles, signal);
		if (items.some(item => item === null)) throw new CatalogDiscoveryInvalidatedError();
		return items as CatalogMemoItem[];
	}

	async refreshMemoViews(memos: readonly MemoViewItem[], signal?: AbortSignal): Promise<MemoViewItem[]> {
		const catalogMemos = memos.filter(memo => memo.catalog !== undefined);
		const items = await this.readMemoHandles(catalogMemos.map(memo => memo.catalog!.observationHandle), signal);
		const current = new Map(catalogMemos.map((memo, index) => [memo.id, items[index]]));
		return memos.flatMap(memo => {
			if (!current.has(memo.id)) return [memo];
			const item = current.get(memo.id);
			return item ? [toCatalogMemoView(item)] : [];
		});
	}

	private async readMemoHandles(handles: readonly ObservationHandle[], signal?: AbortSignal): Promise<Array<CatalogMemoItem | null>> {
		signal?.throwIfAborted();
		if (handles.length === 0) return [];
		const snapshot = await this.readObservationSnapshots(handles.map(handle => handle.sourcePath + "\0" + String(handle.startLine).padStart(10, "0")), signal);
		const capabilities = createCatalogCapabilities(snapshot.coverage);
		return handles.map((handle, index) => {
			const observation = snapshot.observations[index];
			if (observation === null || observation.sourcePath !== handle.sourcePath
				|| observation.sourceRevision !== handle.sourceRevision || observation.startLine !== handle.startLine
				|| observation.endLine !== handle.endLine || observation.rawBlockHash !== handle.rawBlockHash) return null;
			return toCatalogMemoItem(this.resolveObservation(observation), capabilities);
		});
	}

	private async readObservationSnapshots(observationKeys: readonly string[], signal?: AbortSignal): Promise<CatalogObservationSnapshot> {
		const store = this.options.catalog.getStore();
		const storeGeneration = store.getRuntimeGeneration();
		let first: CatalogObservationSnapshot | null = null;
		const observations: Array<CatalogObservation | null> = [];
		for (let offset = 0; offset < Math.max(1, observationKeys.length); offset += CATALOG_OBSERVATION_READ_BATCH_LIMIT) {
			signal?.throwIfAborted();
			if (store.getRuntimeGeneration() !== storeGeneration) throw new CatalogDiscoveryInvalidatedError();
			const snapshot = await this.options.catalog.readObservationSnapshot(observationKeys.slice(offset, offset + CATALOG_OBSERVATION_READ_BATCH_LIMIT), signal);
			signal?.throwIfAborted();
			if (snapshot.invalidated || snapshot.storeGeneration !== storeGeneration || (first !== null
				&& (snapshot.catalogRevision !== first.catalogRevision || JSON.stringify(snapshot.coverage) !== JSON.stringify(first.coverage)
					|| JSON.stringify(snapshot.lifecycle) !== JSON.stringify(first.lifecycle)))) throw new CatalogDiscoveryInvalidatedError();
			first ??= snapshot;
			observations.push(...snapshot.observations);
			// 每批事务有限；批间让出 UI，并在下一批拒绝混合 revision、coverage 或 store。
			if (offset + CATALOG_OBSERVATION_READ_BATCH_LIMIT < observationKeys.length) await yieldToUi();
		}
		const [revision, coverage] = await Promise.all([store.getCatalogRevision(), store.getCoverage()]);
		signal?.throwIfAborted();
		if (store.getRuntimeGeneration() !== storeGeneration || revision !== first!.catalogRevision
			|| JSON.stringify(coverage) !== JSON.stringify(first!.coverage)
			|| JSON.stringify(store.getLifecycle()) !== JSON.stringify(first!.lifecycle)) throw new CatalogDiscoveryInvalidatedError();
		return { ...first!, observations };
	}

	async recordReview(item: CatalogMemoItem): Promise<void> {
		const current = await this.options.catalog.getObservation(item.observation.observationKey);
		if (current === null || current.sourcePath !== item.observationHandle.sourcePath
			|| current.sourceRevision !== item.observationHandle.sourceRevision || current.startLine !== item.observationHandle.startLine
			|| current.endLine !== item.observationHandle.endLine || current.rawBlockHash !== item.observationHandle.rawBlockHash) {
			throw new Error("Review observation is stale; refresh and retry.");
		}
		this.reviews.record(observationLocalKey(current), this.now().toISOString());
	}
	async readDailyAggregateSnapshot(signal?: AbortSignal): Promise<CatalogDiscoverySnapshot & { aggregates: CatalogDailyAggregate[] }> {
		signal?.throwIfAborted();
		const store = this.options.catalog.getStore();
		const catalogRevision = await store.getCatalogRevision();
		const coverage = await this.requireCompleteCoverage("Shuffle Day");
		const day = formatDatePart(this.now());
		signal?.throwIfAborted();
		const aggregates = await this.options.catalog.listDailyAggregates();
		signal?.throwIfAborted();
		const snapshot = { catalogRevision, coverage, day, aggregates };
		if (!await this.isDiscoverySnapshotCurrent(snapshot, signal)) throw new CatalogDiscoveryInvalidatedError();
		return snapshot;
	}

	async isDiscoverySnapshotCurrent(snapshot: CatalogDiscoverySnapshot, signal?: AbortSignal): Promise<boolean> {
		signal?.throwIfAborted();
		const store = this.options.catalog.getStore();
		const [catalogRevision, coverage] = await Promise.all([store.getCatalogRevision(), store.getCoverage()]);
		signal?.throwIfAborted();
		return catalogRevision === snapshot.catalogRevision && JSON.stringify(coverage) === JSON.stringify(snapshot.coverage)
			&& isCompleteCoverage(coverage) && snapshot.day === formatDatePart(this.now())
			&& this.getReadState(coverage, store.getLifecycle()) === "ready";
	}

	async listMemoViewsForDate(date: string, options: { signal?: AbortSignal; snapshot?: CatalogDiscoverySnapshot } = {}): Promise<MemoViewItem[]> {
		for (let attempt = 0; attempt < (options.snapshot === undefined ? 3 : 1); attempt++) {
			options.signal?.throwIfAborted();
			const snapshot = options.snapshot ?? {
				catalogRevision: await this.options.catalog.getStore().getCatalogRevision(),
				coverage: await this.requireCompleteCoverage("Shuffle Day"), day: formatDatePart(this.now()),
			};
			const items: MemoViewItem[] = [];
			let cursor: CatalogFeatureCursor | null = null;
			let invalidated = false;
			do {
				options.signal?.throwIfAborted();
				const page = await this.query({ fromDate: date, toDate: date, limit: 150, cursor }, options.signal);
				options.signal?.throwIfAborted();
				if (page.invalidated || page.catalogRevision !== snapshot.catalogRevision
					|| JSON.stringify(page.coverage) !== JSON.stringify(snapshot.coverage)) { invalidated = true; break; }
				items.push(...page.items.map(toCatalogMemoView));
				cursor = page.nextCursor;
				if (cursor !== null) {
					await yieldToUi();
					options.signal?.throwIfAborted();
				}
			} while (cursor !== null);
			if (!invalidated && await this.isDiscoverySnapshotCurrent(snapshot, options.signal)) return items;
		}
		throw new CatalogDiscoveryInvalidatedError();
	}

	async listMonthlyProjectionPeriods(): Promise<string[]> {
		await this.requireCompleteCoverage("Monthly period discovery");
		const aggregates = await this.options.catalog.listDailyAggregates();
		await this.requireCompleteCoverage("Monthly period discovery");
		return [...new Set(aggregates
			.filter((aggregate) => aggregate.memoCount > 0)
			.map((aggregate) => aggregate.logicalDate.slice(0, 7)))].sort();
	}

	private resolveObservation(observation: CatalogObservation): ResolvedMemo {
		return { kind: "observation", observation, capabilities: createResolvedMemoCapabilities() };
	}

	private async createUnavailablePage(signal?: AbortSignal): Promise<CatalogMemoPage> {
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
		signal?.throwIfAborted();
		return this.rememberPage({
			items: [],
			nextCursor: null,
			catalogRevision: 0,
			coverage,
			lifecycle,
			capabilities: createCatalogCapabilities(coverage),
			status: this.getReadStatus(coverage, lifecycle, true),
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
			coverage,
		};
	}

	private getReadStatus(
		coverage: CatalogCoverage,
		lifecycle: CatalogStoreLifecycle,
		contentUnavailable: boolean,
	): CatalogReadStatus {
		const catalogDegraded = contentUnavailable
			|| lifecycle.state === "degraded"
			|| lifecycle.state === "retrying"
			|| lifecycle.state === "read-only";
		return {
			settings: this.getSettingsStatus(),
			content: contentUnavailable
				? "unavailable"
				: coverage.kind === "complete" && lifecycle.state !== "opening" && lifecycle.state !== "rebuilding"
					? "ready"
					: "scanning",
			catalog: catalogDegraded
				? "degraded"
				: coverage.kind === "complete" && coverage.configurationComplete !== false ? "complete" : "partial",
			// 内容状态与辅助服务诊断分别提供。
			currentConfiguration: this.getCurrentConfigurationStatus(),
			projection: this.getProjectionState(),
		};
	}

	private getSettingsStatus(): KnomoSettingsLoadStatus {
		try {
			return this.options.getSettingsStatus?.() ?? "ready";
		} catch {
			return "unavailable";
		}
	}

	private getCurrentConfigurationStatus(): KnomoCurrentConfigStatus {
		try {
			return this.options.getCurrentConfigurationStatus?.() ?? "missing";
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

	private async loadRandomReunionCandidatePool(now: Date, coverage: CatalogCoverage, signal?: AbortSignal): Promise<RandomReunionCandidatePool> {
		signal?.throwIfAborted();
		const day = formatDatePart(now);
		if (this.randomReunionCandidatePool?.day !== day) this.randomReunionCandidatePool = null;
		const previous = this.randomReunionCandidatePool;
		const changes = await this.options.catalog.readFileChangesSince(previous?.changeCursor);
		signal?.throwIfAborted();
		if (changes.invalidated) throw new CatalogDiscoveryInvalidatedError();
		const sameCoverage = previous !== null && JSON.stringify(previous.coverage) === JSON.stringify(coverage);
		const incremental = previous !== null && changes.sourcePaths !== null
			&& (sameCoverage || previous.catalogRevision !== changes.cursor.catalogRevision);
		if (incremental && changes.sourcePaths!.length === 0 && await this.isRandomReunionPoolCurrent(previous, signal)) return previous;
		const snapshot = { catalogRevision: changes.cursor.catalogRevision, day, coverage, changeCursor: changes.cursor };
		let task = this.randomReunionCandidatePoolLoad;
		if (task === null || task.controller.signal.aborted) {
			const controller = new AbortController();
			const next: RandomReunionPoolTask = { controller, consumers: 0,
				promise: Promise.resolve().then(() => this.buildRandomReunionCandidatePool(now, controller.signal,
					snapshot, incremental ? previous : null, incremental ? changes.sourcePaths : null)) };
			next.promise = next.promise.finally(() => { if (this.randomReunionCandidatePoolLoad === next) this.randomReunionCandidatePoolLoad = null; });
			this.randomReunionCandidatePoolLoad = next;
			task = next;
		}
		const activeTask = task;
		activeTask.consumers++;
		return new Promise((resolve, reject) => {
			let settled = false;
			const finish = () => {
				if (settled) return false;
				settled = true;
				signal?.removeEventListener("abort", abort);
				if (--activeTask.consumers === 0) activeTask.controller.abort();
				return true;
			};
			const abort = () => { if (finish()) reject(createCatalogCountAbortError(signal)); };
			signal?.addEventListener("abort", abort, { once: true });
			activeTask.promise.then(pool => { if (finish()) resolve(pool); }, (error: unknown) => {
				if (finish()) reject(error instanceof Error ? error : new Error(String(error)));
			});
		});
	}

	private async buildRandomReunionCandidatePool(
		today: Date, signal: AbortSignal, snapshot: CatalogDiscoverySnapshot & { changeCursor: CatalogChangeCursor },
		previous: RandomReunionCandidatePool | null, sourcePaths: readonly string[] | null,
	): Promise<RandomReunionCandidatePool> {
		const control = new CooperativeYieldController({ yieldControl: yieldToUi, maxOperationsPerSlice: 4096 });
		signal.throwIfAborted();
		const changed = new Set(sourcePaths ?? []);
		const candidates = previous === null ? [] : previous.candidates.filter(candidate => !changed.has(candidate.dailyRef.path));
		const capabilities = createCatalogCapabilities(snapshot.coverage);
		for (const sourcePath of sourcePaths ?? [null]) {
			if (control.shouldYield()) await control.yieldNow();
			signal.throwIfAborted();
			const file = sourcePath === null ? null : await this.options.catalog.getStore().getFile(sourcePath);
			signal.throwIfAborted();
			if (sourcePath !== null && (file === null || file.logicalDate >= snapshot.day)) continue;
			// sourcePaths 本身是后置过滤；同时限定实际 Daily 日期才能利用现有时间索引。
			let cursor: CatalogQueryPage["nextCursor"] = null;
			do {
				signal.throwIfAborted();
				const page = await this.queryRandomReunionObservations(cursor, 150, sourcePath === null ? undefined : [sourcePath], file?.logicalDate, signal);
				signal.throwIfAborted();
				this.requireRandomReunionCoverage(page.coverage);
				if (page.invalidated || page.catalogRevision !== snapshot.catalogRevision
					|| JSON.stringify(page.coverage) !== JSON.stringify(snapshot.coverage)) throw new CatalogDiscoveryInvalidatedError();
				for (const observation of page.items) {
					if (observation.logicalDate >= snapshot.day) continue;
					const view = toCatalogMemoView(toCatalogMemoItem(this.resolveObservation(observation), capabilities));
					if (filterRandomReunionCandidates([view], { today }).length === 0) continue;
					// 缓存只留候选元数据；所有正文变更均以已提交的文件分区为边界失效。
					candidates.push({ id: view.id, createdAt: view.createdAt, logicalDate: observation.logicalDate, tags: view.tags,
						dailyRef: view.dailyRef, observationKey: observation.observationKey });
				}
				cursor = page.nextCursor;
				if (cursor !== null && control.shouldYield(page.items.length)) await control.yieldNow();
			} while (cursor !== null);
		}
		const pool = { ...snapshot, candidates };
		if (!await this.isRandomReunionPoolCurrent(pool, signal)) throw new CatalogDiscoveryInvalidatedError();
		signal.throwIfAborted();
		this.randomReunionCandidatePool = pool;
		return pool;
	}

	private async isRandomReunionPoolCurrent(pool: RandomReunionCandidatePool, signal?: AbortSignal): Promise<boolean> {
		const store = this.options.catalog.getStore();
		return store.getRuntimeGeneration() === pool.changeCursor.storeGeneration
			&& await this.isDiscoverySnapshotCurrent(pool, signal)
			&& store.getRuntimeGeneration() === pool.changeCursor.storeGeneration;
	}

	private async queryRandomReunionObservations(
		cursor: CatalogQueryPage["nextCursor"], limit: number, sourcePaths?: readonly string[], logicalDate?: string, signal?: AbortSignal,
	): Promise<CatalogQueryPage> {
		try {
			return await this.options.catalog.query({ limit, cursor, ...(sourcePaths === undefined ? {} : { sourcePaths }),
				...(logicalDate === undefined ? {} : { fromDate: logicalDate, toDate: logicalDate }) }, signal);
		} catch (error) {
			signal?.throwIfAborted();
			if (error instanceof CatalogQueryCancelledError) throw error;
			void Promise.resolve().then(() => { if (!signal?.aborted) return this.options.requestObservationScan?.(); }).catch(() => undefined);
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

	private rememberPage(page: CatalogMemoPage): CatalogMemoPage {
		this.lastReadState = page.readState;
		return page;
	}
}

export function toCatalogMemoItem(resolved: ResolvedMemo, catalogCapabilities: CatalogCapabilities): CatalogMemoItem {
	const observation = resolved.observation as CatalogObservation;
	return {
		key: observationLocalKey(observation), renderKey: observationLocalKey(observation),
		observationHandle: { sourcePath: observation.sourcePath, sourceRevision: observation.sourceRevision,
			startLine: observation.startLine, endLine: observation.endLine, rawBlockHash: observation.rawBlockHash },
		createdAt: `${observation.logicalDate}T${observation.time}`, content: observation.content,
		tags: [...observation.tags], links: [...observation.links], images: [...observation.images], tasks: [...observation.tasks],
		timeBuoyDates: [...observation.timeBuoyDates], sourcePath: observation.sourcePath, lineNumberHint: observation.startLine + 1,
		capabilities: { ...resolved.capabilities, catalog: catalogCapabilities }, resolved, observation,
	};
}

function observationLocalKey(observation: CatalogObservation): string {
	// 文件 revision 变化即失效，避免同一行的新 occurrence 继承旧卡片状态。
	return observationHandleKey(observation);
}

function buildTimeBuoyInstance(memo: CatalogMemoItem, targetDate: string) {
	return { memoId: memo.key, targetDate };
}

export function buildReviewCatalogQuery(date: Date, text?: string): CatalogFeatureFilter {
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

function isCompleteCoverage(coverage: CatalogCoverage): boolean {
	return coverage.kind === "complete" && coverage.configurationComplete !== false;
}

export function isQueryCovered(coverage: CatalogCoverage, request: CatalogFeatureFilter): boolean {
	request = narrowCatalogQuery(request);
	if (request.matchNone || isCompleteCoverage(coverage)) return true;
	return request.fromDate !== undefined
		&& coverage.coveredFromDate !== null
		&& request.fromDate >= coverage.coveredFromDate
		&& coverage.configurationComplete !== false;
}

function isRangeCovered(coverage: CatalogCoverage, fromDate: string, toDate: string): boolean {
	if (fromDate > toDate || coverage.configurationComplete === false) return false;
	return isCompleteCoverage(coverage)
		|| (coverage.coveredFromDate !== null && fromDate >= coverage.coveredFromDate);
}

export function buildRecordStatsCatalogQuery(filter: CatalogRecordStatsFilter): {
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
	if (filter.type === "references") query.hasReference = true;
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

function buildLibrarySummary(aggregates: CatalogDailyAggregate[]): CatalogLibrarySummary {
	const tagKeys = new Set(aggregates.flatMap(aggregate => Object.keys(aggregate.tagMemoCounts ?? {})));
	return {
		memoCount: sumAggregates(aggregates, (aggregate) => aggregate.memoCount),
		tagCount: tagKeys.size,
		imageCount: sumAggregates(aggregates, (aggregate) => aggregate.imageCount),
		wordCount: sumAggregates(aggregates, (aggregate) => aggregate.wordCount ?? 0),
	};
}

function buildTagFacets(aggregates: CatalogDailyAggregate[]): CatalogTagFacet[] {
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
	return [...counts.entries()]
		.map(([key, count]) => ({ key, label: labels.get(key) ?? key, count }))
		.sort((left, right) => right.count - left.count || left.key.localeCompare(right.key));
}

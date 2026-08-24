import type {
	CatalogCoverage,
	CatalogObservation,
	CatalogCapabilities,
	CatalogQueryPage,
	CatalogResolutionSnapshot,
	CatalogStoreLifecycle,
	ResolvedMemo,
	ResolvedIdentityEvidence,
} from "../types/catalog";
import type {
	CatalogFeatureQuery,
	CatalogMemoItem,
	CatalogMemoPage,
	CatalogReadState,
	CatalogReadStatus,
	MonthlyProjectionState,
	TrashMemoItem,
	TrashMemoPage,
} from "../types/catalogView";
import type { IdentityLedgerBinding, IdentityLedgerReader } from "../types/identityLedger";
import type { LegacyIdentityImportStatus } from "../types/legacyMigration";
import type { MemoViewItem } from "../types/memoView";
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
import { RecordStatsBuilder, type PreparedRecordStats } from "./RecordStatsService";

export interface CatalogReadServiceOptions {
	catalog: MemoCatalogService;
	identityLedger: IdentityLedgerReader;
	requestObservationScan?: () => void | Promise<void>;
	getProjectionState?: () => MonthlyProjectionState;
	getLegacyImportStatus?: () => LegacyIdentityImportStatus;
	now?: () => Date;
	random?: () => number;
}

export class CatalogReadService {
	private readonly now: () => Date;
	private readonly random: () => number;
	private lastReadState: CatalogReadState | null = null;

	constructor(private readonly options: CatalogReadServiceOptions) {
		this.now = options.now ?? (() => new Date());
		this.random = options.random ?? Math.random;
	}

	getLastReadState(): CatalogReadState | null {
		return this.lastReadState;
	}

	async prime(): Promise<void> {
		await this.materializeResolutionSnapshot();
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
				coverage: page.coverage,
				lifecycle: page.lifecycle,
				capabilities: createCatalogCapabilities(page.coverage),
				status: this.getReadStatus(page.coverage, page.lifecycle, [], false),
				readState: this.getReadState(page.coverage, page.lifecycle),
				degraded: true,
				invalidated: true,
			});
		}
		const snapshot = await this.options.catalog.loadResolutionSnapshot().catch(() => null);
		const snapshotCurrent = snapshot !== null
			&& snapshot.catalogRevision === page.catalogRevision
			&& snapshot.identityRevision === this.options.identityLedger.getRevision();
		const resolved = page.items.map((observation) => snapshotCurrent
			? snapshot.results[observation.observationKey] ?? this.resolveObservation(observation)
			: this.resolveObservation(observation));
		const status = this.getReadStatus(page.coverage, page.lifecycle, resolved, false);
		const catalogCapabilities = createCatalogCapabilities(page.coverage);
		return this.rememberPage({
			items: resolved.map((memo) => this.toMemoItem(memo, catalogCapabilities)),
			nextCursor: page.nextCursor === null ? null : { catalog: page.nextCursor },
			coverage: page.coverage,
			lifecycle: page.lifecycle,
			capabilities: catalogCapabilities,
			status,
			readState: this.getReadState(page.coverage, page.lifecycle),
			degraded: status.content === "unavailable" || status.catalog === "degraded",
			invalidated: false,
		});
	}

	async getDeletedSummary(): Promise<{ count: number; ids: string[] }> {
		const records = await this.listVisibleDeletes();
		return { count: records.length, ids: [...new Set(records.map((item) => item.memoId))].sort() };
	}

	async listDeleted(limit: number, cursor: string | null = null): Promise<TrashMemoPage> {
		const records = await this.listVisibleDeletes();
		const offset = cursor === null ? 0 : Math.max(0, Number.parseInt(cursor, 10) || 0);
		const selected = records.slice(offset, offset + Math.max(0, limit));
		const nextOffset = offset + selected.length;
		return {
			items: selected.map((record): TrashMemoItem => ({
				key: `${record.memoId}:${record.deleteEventId}`,
				memoId: record.memoId,
				deleteEventId: record.deleteEventId,
				deletedAt: record.evidence.deletedAt,
				logicalDate: record.evidence.logicalDate,
				sourcePath: record.evidence.sourcePath,
				section: record.evidence.section,
				content: readDeletedPayloadContent(record.evidence.rawBlock),
				contentHash: record.evidence.contentHash,
				sourceMemoId: record.evidence.sourceMemoId,
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
			complete: (await this.options.catalog.getStore().getCoverage()).kind === "complete",
		};
	}

	async buildRecordStats(
		yieldToUi: () => Promise<void>,
		isCurrent: () => boolean,
	): Promise<PreparedRecordStats | null> {
		await this.requireCompleteCoverage("Record statistics");
		let builder = new RecordStatsBuilder();
		let cursor: CatalogFeatureQuery["cursor"] = null;
		do {
			if (!isCurrent()) return null;
			const page = await this.query({ limit: 150, cursor });
			if (page.invalidated) {
				cursor = null;
				builder = new RecordStatsBuilder();
				continue;
			}
			if (page.capabilities.stats !== "complete") throw new Error("Record statistics require complete Catalog coverage.");
			for (const memo of page.items) builder.addMemo(toCatalogMemoView(memo));
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
		const candidates: CatalogMemoItem[] = [];
		for (const date of sampleDates(aggregates.map((item) => item.logicalDate), 24, this.random)) {
			candidates.push(...await this.queryAllItems({ fromDate: date, toDate: date, limit: 150 }));
		}
		await this.requireCompleteCoverage("Random reunion");
		const reviews: MemoReviewStateMap = {};
		for (const candidate of candidates) {
			if (candidate.memoId === null) continue;
			const review = this.options.identityLedger.getReviewState(candidate.memoId);
			reviews[candidate.memoId] = review.lastReviewedAt === null
				? { memoId: candidate.memoId, reviewCount: review.reviewCount }
				: { memoId: candidate.memoId, reviewCount: review.reviewCount, lastReviewedAt: review.lastReviewedAt };
		}
		return getRandomReunionMemos(candidates.map(toCatalogMemoView), reviews, count, {
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

	async materializeResolutionSnapshot(): Promise<CatalogResolutionSnapshot | null> {
		const files = await this.options.catalog.listFiles();
		const batches = (await Promise.all(files.map((file) => this.options.catalog.getFileRevisionBatch(file.sourcePath))))
			.filter((batch): batch is NonNullable<typeof batch> => batch !== null);
		const catalogRevision = batches[0]?.catalogRevision ?? 0;
		if (batches.some((batch) => batch.catalogRevision !== catalogRevision)) return null;
		const results = Object.fromEntries(batches.flatMap((batch) => batch.observations.map((observation) => [
			observation.observationKey,
			this.resolveObservation(observation),
		] as const)));
		const snapshot: CatalogResolutionSnapshot = {
			catalogRevision,
			identityRevision: this.options.identityLedger.getRevision(),
			results,
		};
		await this.options.catalog.saveResolutionSnapshot(snapshot);
		return snapshot;
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
			createdAt: `${observation.logicalDate}T${normalizeTime(observation.time)}`,
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
			coverage,
			lifecycle,
			capabilities: createCatalogCapabilities(coverage),
			status: this.getReadStatus(coverage, lifecycle, [], true),
			readState: "storage_unavailable",
			degraded: true,
			invalidated: false,
		});
	}

	private getReadStatus(
		coverage: CatalogCoverage,
		lifecycle: CatalogStoreLifecycle,
		resolved: readonly ResolvedMemo[],
		contentUnavailable: boolean,
	): CatalogReadStatus {
		const identityStatus = this.options.identityLedger.getStatus();
		const legacyStatus = this.options.getLegacyImportStatus?.() ?? "missing";
		const catalogDegraded = contentUnavailable
			|| lifecycle.state === "degraded"
			|| lifecycle.state === "retrying"
			|| lifecycle.state === "read-only";
		const identityConflicted = identityStatus === "conflicted"
			|| resolved.some((memo) => memo.kind === "ambiguous");
		return {
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
			projection: this.getProjectionState(),
			migration: legacyStatus === "attention"
				? "attention"
				: legacyStatus === "unavailable" ? "unavailable" : "none",
		};
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

	private async requireCompleteCoverage(feature: string): Promise<CatalogCoverage> {
		const coverage = await this.options.catalog.getStore().getCoverage();
		if (coverage.kind !== "complete") throw new Error(`${feature} requires complete Catalog coverage.`);
		return coverage;
	}

	private async listVisibleDeletes() {
		const resolution = await this.loadCurrentResolutionSnapshot();
		const visibleMemoIds = new Set(Object.values(resolution.results).flatMap((memo) =>
			memo.kind === "identified" ? [memo.identityHandle.memoId] : []));
		return (this.options.identityLedger.getActiveDeletes?.() ?? [])
			.filter((record) => !visibleMemoIds.has(record.memoId))
			.sort((left, right) => right.evidence.deletedAt.localeCompare(left.evidence.deletedAt)
				|| left.deleteEventId.localeCompare(right.deleteEventId));
	}

	private async loadCurrentResolutionSnapshot(): Promise<CatalogResolutionSnapshot> {
		const existing = await this.options.catalog.loadResolutionSnapshot().catch(() => null);
		if (existing !== null
			&& existing.identityRevision === this.options.identityLedger.getRevision()
			&& await this.isResolutionSnapshotCatalogCurrent(existing)) {
			return existing;
		}
		const refreshed = await this.materializeResolutionSnapshot();
		if (refreshed === null
			|| refreshed.identityRevision !== this.options.identityLedger.getRevision()
			|| !await this.isResolutionSnapshotCatalogCurrent(refreshed)) {
			throw new Error("Trash requires a current Catalog and Identity resolution snapshot.");
		}
		return refreshed;
	}

	private async isResolutionSnapshotCatalogCurrent(snapshot: CatalogResolutionSnapshot): Promise<boolean> {
		const files = await this.options.catalog.listFiles();
		const firstFile = files[0];
		if (firstFile === undefined) return Object.keys(snapshot.results).length === 0;
		const batch = await this.options.catalog.getFileRevisionBatch(firstFile.sourcePath);
		return batch !== null && batch.catalogRevision === snapshot.catalogRevision;
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

function readDeletedPayloadContent(rawBlock: string): string {
	const lines = rawBlock.split(/\r?\n/u);
	const first = /^- (?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?(?:\s(.*))?$/u.exec(lines[0] ?? "")?.[1] ?? "";
	const continuation = lines.slice(1).map((line) => line.replace(/^ {2}/u, ""));
	return [first, ...continuation].join("\n").replace(/\s+\^[A-Za-z0-9-]+\s*$/u, "").trim();
}

function buildTimeBuoyInstance(memo: CatalogMemoItem, targetDate: string) {
	return { memoId: memo.memoId ?? memo.key, targetDate };
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
